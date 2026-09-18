import { constants } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface NativeTranscriptOptions {
  provider: "claude" | "codex" | "agy";
  session: { kind: "id" | "path"; value: string };
  cwd: string;
  home?: string;
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_CANDIDATES = 16;
const MAX_DEPTH = 4;

export class NativeTranscriptUnavailableError extends Error {
  constructor() { super("Native transcript: saved history is unavailable"); this.name = "NativeTranscriptUnavailableError"; }
}

/** Extract model output only: a user prompt containing an ACK token is not an ACK. */
export function nativeTranscriptReply(provider: NativeTranscriptOptions["provider"], text: string): string | undefined {
  let reply: string | undefined;
  // AGY writes in completion order, so its latest reply is the highest step, not the last line.
  let replyStep = -1;
  for (const line of text.split("\n").filter(Boolean)) {
    let record: any;
    try { record = JSON.parse(line); } catch { fail("invalid transcript JSON record"); }
    if (provider === "agy") {
      // A record without an index keeps the last-line order it always had.
      const step = typeof record?.step_index === "number" ? record.step_index : replyStep;
      if (record?.type === "PLANNER_RESPONSE" && record.source === "MODEL" && record.status === "DONE" && typeof record.content === "string"
        && step >= replyStep) {
        reply = record.content;
        replyStep = step;
      }
      continue;
    }
    const message = provider === "claude"
      ? record?.type === "assistant" ? record.message : undefined
      : record?.type === "response_item" && record.payload?.type === "message" && record.payload.role === "assistant" ? record.payload : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content.filter((block: any) => block && (block.type === "text" || block.type === "output_text") && typeof block.text === "string");
    if (blocks.length) reply = blocks.map((block: {text:string}) => block.text).join("\n");
  }
  return reply;
}

function fail(message: string): never {
  throw new Error(`Native transcript: ${message}`);
}

// Pin every directory before opening its child. O_NOFOLLOW on just the final
// filename would still follow symlinked parents or race a parent replacement.
async function openSafe(path: string, directory = false): Promise<FileHandle> {
  if (process.platform !== "linux") fail("safe disk reads require Linux /proc/self/fd");
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) {
    fail("an absolute path without parent traversal is required");
  }
  let handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (i < parts.length - 1 || directory ? constants.O_DIRECTORY : 0);
      const next = await open(`/proc/self/fd/${handle.fd}/${parts[i]}`, flags);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NativeTranscriptUnavailableError();
    fail("path unavailable or unsafe (symlinks are not allowed)");
  }
}

async function readFile(path: string): Promise<string> {
  const file = await openSafe(path);
  try {
    const before = await file.stat();
    if (!before.isFile()) fail("expected a regular file");
    if (before.size > MAX_BYTES) fail("file exceeds 4 MiB; refusing truncation");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) fail("file exceeds 4 MiB; refusing truncation");
    const after = await file.stat();
    if (before.size !== after.size || size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("file changed during read; retry after the session is stable");
    }
    if (!size) fail("file is empty");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
    } catch {
      fail("file is not valid UTF-8");
    }
  } finally {
    await file.close();
  }
}

function matchesCodexHeader(text: string, id: string, cwd: string): boolean {
  try {
    const header = JSON.parse(text.split("\n", 1)[0]!);
    const payload = header?.payload;
    return header?.type === "session_meta" && payload?.id === id && payload?.cwd === cwd
      && (payload.session_id === undefined || payload.session_id === id);
  } catch {
    return false;
  }
}

async function findCodex(root: string, id: string, cwd: string): Promise<string> {
  let entries = 0;
  let candidates = 0;
  let found: string | undefined;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) fail("Codex search depth limit exceeded");
    const handle = await openSafe(path, true);
    try {
      const dir = await opendir(`/proc/self/fd/${handle.fd}`);
      for await (const entry of dir) {
        if (++entries > MAX_ENTRIES) fail("Codex search entry limit exceeded");
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          await visit(child, depth + 1);
        } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) {
          if (++candidates > MAX_CANDIDATES) fail("Codex search candidate limit exceeded");
          const text = await readFile(child);
          if (!matchesCodexHeader(text, id, cwd)) continue;
          if (found !== undefined) fail("multiple Codex transcripts match session ID and cwd");
          found = text;
        }
      }
    } finally {
      await handle.close();
    }
  }
  await visit(root, 0);
  if (found === undefined) throw new NativeTranscriptUnavailableError();
  return found;
}

/**
 * AGY 1.2.5 writes its full transcript in completion order, not step order,
 * measured across this host's own transcripts: a tool result is written
 * before the planner step that called it (steps 0, 2, 1, 3), an interrupted
 * turn's index is reused by the next user input (52, 52), some steps are
 * never written at all (94 and 106 absent before a user input, in a
 * conversation that carried on normally; another begins at step 1), and a
 * planner step that only calls tools carries `tool_calls` and no `content`.
 * So step indices prove nothing about completeness. What does is AGY's own
 * signal: a partial final record, or `truncated_fields` on any record.
 */
function validateAgy(text: string): string {
  if (!text.endsWith("\n")) fail("AGY transcript has a partial final record");
  let records = 0;
  for (const line of text.split("\n").filter(Boolean)) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { fail("invalid AGY transcript JSON"); }
    const step = record?.step_index;
    if (!record || typeof record !== "object" || typeof step !== "number" || !Number.isSafeInteger(step) || step < 0
      || typeof record.type !== "string" || typeof record.source !== "string"
      || (record.content !== undefined && typeof record.content !== "string")) fail("AGY transcript has an unsupported record");
    if (Array.isArray(record.truncated_fields) && record.truncated_fields.length) fail("AGY transcript has truncated fields; full history is required");
    records++;
  }
  if (!records) fail("AGY transcript is empty");
  return text;
}

export interface ClaudeTranscriptTail {
  /** Byte offset just past the last complete record returned; pass it back to continue. */
  offset: number;
  /** Complete JSONL records from the requested offset; a partial final record is left for the next read. */
  text: string;
}

/** Incremental read of a live Claude transcript, which may exceed the whole-file limit. */
export async function readClaudeTranscriptTail(
  options: { sessionId: string; cwd: string; home?: string }, offset: number,
): Promise<ClaudeTranscriptTail> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId)) fail("invalid native session ID");
  if (!isAbsolute(options.cwd) || options.cwd.includes("\0")) fail("cwd must be absolute");
  if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid transcript offset");
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || home.includes("\0") || home.split("/").includes("..")) fail("home must be absolute without parent traversal");
  const project = resolve(options.cwd).replace(/[^a-zA-Z0-9]/g, "-");
  let file: FileHandle;
  try {
    file = await openSafe(join(home, ".claude", "projects", project, `${options.sessionId}.jsonl`));
  } catch (error) {
    // A running session that has never been prompted has not written its transcript yet.
    if (offset === 0 && error instanceof NativeTranscriptUnavailableError) return { offset: 0, text: "" };
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail("expected a regular file");
    if (stat.size < offset) fail("transcript shrank below the read offset");
    const buffer = Buffer.alloc(Math.min(stat.size - offset, MAX_BYTES));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, offset + size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const complete = buffer.subarray(0, size).lastIndexOf(0x0a) + 1;
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, complete));
      return { offset: offset + complete, text };
    } catch {
      fail("file is not valid UTF-8");
    }
  } finally {
    await file.close();
  }
}

/** Read native text unchanged; compaction and handoff remain separate operations. */
export async function readNativeTranscript(options: NativeTranscriptOptions): Promise<string> {
  const { provider, session, cwd } = options;
  if (provider !== "claude" && provider !== "codex" && provider !== "agy") fail("unsupported provider");
  if (!isAbsolute(cwd) || cwd.includes("\0")) fail("cwd must be absolute");
  if (session.kind === "path") {
    const text = await readFile(session.value);
    return provider === "agy" ? validateAgy(text) : text;
  }
  if (session.kind !== "id" || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.value)) {
    fail("invalid native session ID");
  }
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || home.includes("\0") || home.split("/").includes("..")) fail("home must be absolute without parent traversal");
  if (provider === "agy") {
    return validateAgy(await readFile(join(home, ".gemini", "antigravity-cli", "brain", session.value, ".system_generated", "logs", "transcript_full.jsonl")));
  }
  if (provider === "claude") {
    const project = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    return readFile(join(home, ".claude", "projects", project, `${session.value}.jsonl`));
  }
  return findCodex(join(home, ".codex", "sessions"), session.value, resolve(cwd));
}
