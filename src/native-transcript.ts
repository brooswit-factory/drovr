import { DEFAULT_TRANSCRIPT_LIMIT, transcriptLimit } from './transcript-limits.js';
import { constants } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface NativeTranscriptOptions {
  provider: "claude" | "codex" | "agy";
  session: { kind: "id" | "path"; value: string };
  cwd: string;
  home?: string;
  /** Whole-file byte limit; default4MiB, finite maximum64MiB. Never truncates. */
  maxBytes?: number;
}

const MAX_BYTES = DEFAULT_TRANSCRIPT_LIMIT;
const MAX_ENTRIES = 10_000;
const MAX_CANDIDATES = 16;
const MAX_DEPTH = 4;
// macOS 11+: the kernel refuses a symlink in ANY component of the path, in one
// atomic open. Node does not export the constant.
const O_NOFOLLOW_ANY = 0x20000000;

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
// Linux walks the path one component at a time through /proc/self/fd. macOS has
// no equivalent of that, so it opens the whole path once with O_NOFOLLOW_ANY.
async function openSafe(path: string, directory = false): Promise<FileHandle> {
  if (process.platform !== "linux" && process.platform !== "darwin") fail("safe disk reads require Linux or macOS");
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) {
    fail("an absolute path without parent traversal is required");
  }
  if (process.platform === "darwin") {
    try {
      return await open(path, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NativeTranscriptUnavailableError();
      fail("path unavailable or unsafe (symlinks are not allowed)");
    }
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

// Where to list a directory that `handle` pins. Linux lists the descriptor
// itself. macOS cannot (/dev/fd/N is not a directory there), so it lists the
// path just opened: that yields names only, and every name is then opened again
// by full path through openSafe, so a swap in between cannot make a read leave
// the tree.
function listingPath(path: string, handle: FileHandle): string {
  return process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
}

async function readFile(path: string, maxBytes: number): Promise<string> {
  const file = await openSafe(path);
  try {
    const before = await file.stat();
    if (!before.isFile()) fail("expected a regular file");
    if (before.size > maxBytes) fail(`file exceeds ${maxBytes === MAX_BYTES ? "4 MiB" : `${maxBytes} bytes`}; refusing truncation`);
    const buffer = Buffer.alloc(Math.min(before.size, maxBytes) + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) fail(`file exceeds ${maxBytes === MAX_BYTES ? "4 MiB" : `${maxBytes} bytes`}; refusing truncation`);
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

async function findCodex(root: string, id: string, cwd: string, maxBytes: number): Promise<string> {
  let entries = 0;
  let candidates = 0;
  let found: string | undefined;
  async function visit(path: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) fail("Codex search depth limit exceeded");
    const handle = await openSafe(path, true);
    try {
      const dir = await opendir(listingPath(path, handle));
      for await (const entry of dir) {
        if (++entries > MAX_ENTRIES) fail("Codex search entry limit exceeded");
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          await visit(child, depth + 1);
        } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(`-${id}.jsonl`)) {
          if (++candidates > MAX_CANDIDATES) fail("Codex search candidate limit exceeded");
          const text = await readFile(child, maxBytes);
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

/** Where each moved session's transcript was last found: a hint, re-proven on every read. */
const movedTranscripts = new Map<string, string>();

/**
 * Find a session's transcript in whichever project folder holds it. A session
 * that enters a git worktree has its whole transcript carried to the
 * worktree's project folder, measured live: nothing is left under the launch
 * directory's. The file name is the session's UUID, so a match is that
 * session and no other; two matches are refused, never chosen between.
 */
async function findClaudeTranscript(projects: string, name: string): Promise<FileHandle | undefined> {
  const hinted = movedTranscripts.get(name);
  if (hinted) {
    try { return await openSafe(join(projects, hinted, name)); }
    catch (error) { if (!(error instanceof NativeTranscriptUnavailableError)) throw error; movedTranscripts.delete(name); }
  }
  let root: FileHandle;
  try { root = await openSafe(projects, true); }
  catch (error) { if (error instanceof NativeTranscriptUnavailableError) return undefined; throw error; }
  const found: string[] = [];
  let entries = 0;
  try {
    for await (const entry of await opendir(listingPath(projects, root))) {
      if (++entries > MAX_ENTRIES) fail("Claude project search entry limit exceeded");
      if (!entry.isDirectory()) continue;
      try {
        await (await openSafe(join(projects, entry.name, name))).close();
        found.push(entry.name);
      } catch {
        // Absent here, or a folder this user cannot read: either way not this session's.
      }
    }
  } finally {
    await root.close();
  }
  if (found.length > 1) fail("multiple Claude project folders hold this session's transcript");
  if (!found[0]) return undefined;
  movedTranscripts.set(name, found[0]);
  return openSafe(join(projects, found[0], name));
}

/**
 * Incremental read of a live Claude transcript, which may exceed the
 * whole-file limit. `cwd` is where to look first; a session that has since
 * moved is found by its session ID wherever its transcript now lives.
 */
export async function readClaudeTranscriptTail(
  options: { sessionId: string; cwd: string; home?: string }, offset: number,
): Promise<ClaudeTranscriptTail> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId)) fail("invalid native session ID");
  if (!isAbsolute(options.cwd) || options.cwd.includes("\0")) fail("cwd must be absolute");
  if (!Number.isSafeInteger(offset) || offset < 0) fail("invalid transcript offset");
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || home.includes("\0") || home.split("/").includes("..")) fail("home must be absolute without parent traversal");
  const projects = join(home, ".claude", "projects");
  const name = `${options.sessionId}.jsonl`;
  const project = resolve(options.cwd).replace(/[^a-zA-Z0-9]/g, "-");
  let file: FileHandle;
  try {
    file = await openSafe(join(projects, project, name));
  } catch (error) {
    if (!(error instanceof NativeTranscriptUnavailableError)) throw error;
    const moved = await findClaudeTranscript(projects, name);
    // A running session that has never been prompted has not written its transcript yet.
    if (!moved) {
      if (offset === 0) return { offset: 0, text: "" };
      throw error;
    }
    file = moved;
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
  const maxBytes = transcriptLimit(options.maxBytes, "maxBytes");
  const { provider, session, cwd } = options;
  if (provider !== "claude" && provider !== "codex" && provider !== "agy") fail("unsupported provider");
  if (!isAbsolute(cwd) || cwd.includes("\0")) fail("cwd must be absolute");
  if (session.kind === "path") {
    const text = await readFile(session.value, maxBytes);
    return provider === "agy" ? validateAgy(text) : text;
  }
  if (session.kind !== "id" || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.value)) {
    fail("invalid native session ID");
  }
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || home.includes("\0") || home.split("/").includes("..")) fail("home must be absolute without parent traversal");
  if (provider === "agy") {
    return validateAgy(await readFile(join(home, ".gemini", "antigravity-cli", "brain", session.value, ".system_generated", "logs", "transcript_full.jsonl"), maxBytes));
  }
  if (provider === "claude") {
    const project = resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
    return readFile(join(home, ".claude", "projects", project, `${session.value}.jsonl`), maxBytes);
  }
  return findCodex(join(home, ".codex", "sessions"), session.value, resolve(cwd), maxBytes);
}

export const CLAUDE_ACK_LIMITS = Object.freeze({ recordBytes: 4 * 1024 * 1024, turnBytes: 8 * 1024 * 1024, fileBytes: 512 * 1024 * 1024, blockBytes: 64 * 1024 });
export interface ClaudeAckCursor {
  beginPrompt(prompt: string, token: string): Promise<boolean>;
  poll(): Promise<{ reply?: string; atEnd: boolean; offset: number }>;
  close(): Promise<void>;
}
/** Continuation-only native ACK cursor. Never returns old records or user text.
 * Pinned file identity, bounded records/backlog, complete-record cursor, and
 * exact submitted-user-message evidence precede an assistant candidate.
 */
export async function createClaudeAckCursor(options: { sessionId: string; cwd: string; home?: string }): Promise<ClaudeAckCursor> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId) || !isAbsolute(options.cwd) || options.cwd.includes('\0')) fail('invalid exact Claude ACK identity');
  const home=options.home??homedir();
  if (!isAbsolute(home)||home.includes('\0')||home.split('/').includes('..')) fail('unsafe Claude ACK home');
  const path=join(home,'.claude','projects',resolve(options.cwd).replace(/[^a-zA-Z0-9]/g,'-'),options.sessionId+'.jsonl');
  const file=await openSafe(path);let closed=false;
  const initial=await file.stat();
  const identity=(s:typeof initial)=>[s.dev,s.ino,s.uid];
  const checked=async()=>{
    const current=await openSafe(path);
    try { const s=await current.stat();if(!s.isFile()||JSON.stringify(identity(s))!==JSON.stringify(identity(initial))||s.size>CLAUDE_ACK_LIMITS.fileBytes)fail('Claude ACK file replaced or over total bound');return s; }
    finally {await current.close();}
  };
  let observedSize=initial.size,position=initial.size,pending=Buffer.alloc(0),turnBytes=0,expectedPrompt:string|undefined,token:string|undefined,seenUser=false,candidate:string|undefined;
  try {
    if(!initial.isFile()||initial.size>CLAUDE_ACK_LIMITS.fileBytes)fail('invalid bounded Claude ACK file');
    if(initial.size){
      const tail=Buffer.alloc(Math.min(initial.size,CLAUDE_ACK_LIMITS.recordBytes+1));
      const start=initial.size-tail.length;let n=0;
      while(n<tail.length){const r=await file.read(tail,n,tail.length-n,start+n);if(!r.bytesRead)fail('Claude ACK file shrank during initial boundary');n+=r.bytesRead;}
      const newline=tail.lastIndexOf(10);
      if(newline<0 && start>0)fail('oversized incomplete Claude ACK record');
      position=start+newline+1;
    }
    const parse=(line:Buffer)=>{
      if(!line.length)return;
      let record:any;try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}catch{fail('invalid complete Claude ACK JSON/UTF-8 record');}
      if(record.sessionId!==undefined&&record.sessionId!==options.sessionId || record.cwd!==undefined&&record.cwd!==options.cwd)fail('Claude ACK record identity drift');
      if(!expectedPrompt)return; // drain prior complete records without adopting an ACK
      const message=record.message;
      const text=typeof message?.content==='string'?message.content:Array.isArray(message?.content)?message.content.filter((b:any)=>b?.type==='text'&&typeof b.text==='string').map((b:any)=>b.text).join('\n'):undefined;
      if(record.type==='user'&&message?.role==='user'){
        candidate=undefined;
        if(seenUser || text!==expectedPrompt)fail('Unexpected or duplicate Claude input during continuation');
        seenUser=true;
      }
      if(record.type==='assistant'&&message?.role==='assistant'){
        candidate=undefined;
        if(!seenUser)fail('Claude assistant output preceded exact submitted prompt');
        if(record.isApiErrorMessage || Array.isArray(message.content)&&message.content.some((b:any)=>b?.type==='tool_use') || message.stop_reason!=null&&!['end_turn','stop_sequence'].includes(message.stop_reason))return;
        if(typeof text==='string'&&text.trim().startsWith(token+'\n')&&text.trim().slice(token!.length).trim())candidate=text.trim();
      }
    };
    const read=async()=>{
      if(closed)fail('Claude ACK cursor closed');
      const before=await checked();
      if(before.size<observedSize||before.size<position)fail('Claude ACK file truncated');
      observedSize=before.size;
      while(position<before.size){
        const size=Math.min(CLAUDE_ACK_LIMITS.blockBytes,before.size-position);
        if(turnBytes+size>CLAUDE_ACK_LIMITS.turnBytes)fail('Claude ACK per-turn backlog bound exceeded');
        const chunk=Buffer.alloc(size);const r=await file.read(chunk,0,size,position);
        if(!r.bytesRead)fail('Claude ACK file changed while reading');
        position+=r.bytesRead;turnBytes+=r.bytesRead;
        pending=Buffer.concat([pending,chunk.subarray(0,r.bytesRead)]);
        let newline:number;
        while((newline=pending.indexOf(10))>=0){
          if(newline>CLAUDE_ACK_LIMITS.recordBytes)fail('oversized complete Claude ACK record');
          parse(pending.subarray(0,newline));pending=pending.subarray(newline+1);
        }
        if(pending.length>CLAUDE_ACK_LIMITS.recordBytes)fail('oversized incomplete Claude ACK record');
      }
      const after=await checked();
      if(after.size<observedSize||after.size<position)fail('Claude ACK file truncated after read');
      observedSize=after.size;
      return {atEnd:after.size===position&&pending.length===0,offset:position-pending.length,...(candidate?{reply:candidate}:{})};
    };
    return {
      beginPrompt:async(prompt,nextToken)=>{
        if(typeof prompt!=='string'||!prompt||prompt.length>512_000||!/^DROVR_HANDOFF_READY_[a-f0-9-]{36}$/.test(nextToken))fail('invalid bounded continuation prompt/token');
        expectedPrompt=undefined;candidate=undefined;seenUser=false;token=undefined;
        const state=await read();if(!state.atEnd)return false;
        expectedPrompt=prompt;token=nextToken;turnBytes=0;return true;
      },
      poll:async()=>{if(!expectedPrompt||!token)fail('Claude ACK prompt boundary not armed');return read();},
      close:async()=>{if(!closed){closed=true;await file.close();}},
    };
  }catch(error){await file.close();closed=true;throw error;}
}
