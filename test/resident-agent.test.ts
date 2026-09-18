import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTranscriptUnavailableError, readClaudeTranscriptTail } from "../src/native-transcript.js";
import {
  ClaudeResidentMessenger, createResidentAgentMessenger, ResidentMessageRefusal,
  type ClaudeBackgroundListing, type ClaudeResidentDeps, type ResidentAgentTarget,
} from "../src/resident-agent.js";

const sessionId = "6954cbf3-c620-4523-812e-0d901252c756";
const target: ResidentAgentTarget = { provider: "claude", sessionId, cwd: "/work/repo" };
const idle: ClaudeBackgroundListing = { id: "6954cbf3", sessionId, cwd: "/work/repo", status: "idle" };
const line = (record: object) => JSON.stringify({ sessionId, ...record }) + "\n";
const user = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (text: string, extra: object = {}) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text }] }, ...extra });
const turnEnd = line({ type: "system", subtype: "turn_duration" });

function harness(options: { listing?: ClaudeBackgroundListing[]; onEnter?: (typed: string) => string[]; attachExits?: boolean } = {}) {
  let clock = 0;
  let transcript = user("earlier") + assistant("earlier reply") + turnEnd;
  const pendingWrites: string[] = [];
  const events: string[] = [];
  const typed: string[] = [];
  const deps: Partial<ClaudeResidentDeps> = {
    listBackground: async () => options.listing ?? [idle],
    readTail: async (_target, offset) => {
      if (pendingWrites.length) transcript += pendingWrites.shift();
      const text = transcript.slice(offset);
      const complete = text.lastIndexOf("\n") + 1;
      return { offset: offset + complete, text: text.slice(0, complete) };
    },
    openAttach: shortId => {
      events.push(`attach ${shortId}`);
      return {
        write: data => {
          typed.push(data);
          if (data === "\r") pendingWrites.push(...(options.onEnter?.(typed[typed.length - 2]!) ?? []));
        },
        lastOutputAt: () => 0,
        exited: options.attachExits ? Promise.resolve(1) : new Promise<number>(() => {}),
        close: async () => { events.push("detach"); },
      };
    },
    now: () => clock,
    sleep: async ms => { clock += ms; },
    attachReadyTimeoutMs: 5_000,
    deliveryTimeoutMs: 2_000,
    pollMs: 250,
  };
  return { messenger: new ClaudeResidentMessenger(deps), events, typed };
}

const pasted = (message: string) => `\x1b[200~${message}\x1b[201~`;

describe("resident agent messaging", () => {
  test("types into the same running session's attach terminal and reads only that turn's reply", async () => {
    const message = "Line A\nLine B: what is 2+3?";
    const { messenger, events, typed } = harness({
      onEnter: paste => paste === pasted(message) ? [
        user(message),
        user([{ type: "tool_result", content: "ignored" }]),
        assistant("sidechain", { isSidechain: true }),
        assistant("working"),
        assistant("5") + turnEnd + assistant("later turn"),
      ] : [],
    });
    expect(await messenger.message(target, `  ${message}\n`)).toEqual({ status: "replied", reply: "working\n5" });
    expect(typed).toEqual([pasted(message), "\r"]);
    expect(events).toEqual(["attach 6954cbf3", "detach"]);
  });

  test("returns partial reply text when the turn outlives the reply timeout", async () => {
    const { messenger } = harness({ onEnter: () => [user("hello") + assistant("started")] });
    expect(await messenger.message(target, "hello", { replyTimeoutMs: 1_000 })).toEqual({ status: "reply-pending", reply: "started" });
  });

  test("refuses unconfirmed delivery instead of claiming it", async () => {
    const { messenger, events } = harness({ onEnter: () => [user("someone else's text")] });
    const error = await messenger.message(target, "hello").catch(e => e);
    expect(error).toBeInstanceOf(ResidentMessageRefusal);
    expect(error.reason).toBe("delivery-unconfirmed");
    expect(events).toEqual(["attach 6954cbf3", "detach"]);
  });

  test.each([
    ["absent session", [], "not-running"],
    ["same session listed elsewhere", [{ ...idle, cwd: "/elsewhere" }], "not-running"],
    ["busy session", [{ ...idle, status: "busy" }], "busy"],
  ] as const)("never attaches to an %s", async (_label, listing, reason) => {
    const { messenger, events } = harness({ listing: [...listing] });
    await expect(messenger.message(target, "hello")).rejects.toMatchObject({ reason });
    expect(events).toEqual([]);
  });

  test("an attach client that exits early types nothing", async () => {
    const { messenger, typed, events } = harness({ attachExits: true });
    await Promise.resolve();
    await expect(messenger.message(target, "hello")).rejects.toMatchObject({ reason: "not-running" });
    expect(typed).toEqual([]);
    expect(events).toEqual(["attach 6954cbf3", "detach"]);
  });

  test.each(["", "   ", "paste end \x1b[201~ escape", "carriage\rreturn", "x".repeat(16_001)])("rejects unsafe message %#", async text => {
    const { messenger, events } = harness();
    await expect(messenger.message(target, text)).rejects.toMatchObject({ reason: "invalid-message" });
    expect(events).toEqual([]);
  });

  test("providers without a proven same-session transport refuse without fallback", async () => {
    let listed = false;
    const messenger = createResidentAgentMessenger({ listBackground: async () => { listed = true; return [idle]; } });
    for (const provider of ["codex", "agy"] as const) {
      await expect(messenger.message({ ...target, provider }, "hello")).rejects.toMatchObject({ reason: "unsupported-provider" });
    }
    expect(listed).toBe(false);
  });
});

describe("Claude transcript tail reader", () => {
  let home: string;
  const cwd = "/factory/work dir";
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "drovr-tail-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("returns complete records from an offset and leaves a partial record for later", async () => {
    const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(path, '{"a":1}\n{"b":"🌍"}\n{"c":');
    const first = await readClaudeTranscriptTail({ sessionId, cwd, home }, 0);
    expect(first.text).toBe('{"a":1}\n{"b":"🌍"}\n');
    await appendFile(path, "3}\n");
    expect(await readClaudeTranscriptTail({ sessionId, cwd, home }, first.offset)).toEqual({ offset: first.offset + 8, text: '{"c":3}\n' });
    await expect(readClaudeTranscriptTail({ sessionId, cwd, home }, 1_000)).rejects.toThrow("shrank");
  });

  test("an unprompted session's absent transcript reads as empty only from the start", async () => {
    const home = await mkdtemp(join(tmpdir(), "drovr-tail-absent-"));
    const target = { sessionId: "never-prompted", cwd: "/work/fresh", home };
    expect(await readClaudeTranscriptTail(target, 0)).toEqual({ offset: 0, text: "" });
    await expect(readClaudeTranscriptTail(target, 5)).rejects.toThrow("saved history is unavailable");
    await rm(home, { recursive: true, force: true });
  });
});

describe("a resident that changes directory mid-turn", () => {
  const worktree = "/work/repo/.claude/worktrees/feature";

  // The session enters a worktree while answering: Claude Code carries its
  // transcript to the new directory's project folder, so the old path is gone.
  function movingHarness(options: { vanishes?: boolean } = {}) {
    let clock = 0;
    let transcript = user("earlier") + assistant("earlier reply") + turnEnd;
    let cwd = target.cwd;
    let afterEnter = 0;
    const reads: string[] = [];
    const deps: Partial<ClaudeResidentDeps> = {
      listBackground: async () => options.vanishes && cwd !== target.cwd ? [] : [{ ...idle, cwd }],
      readTail: async (at, offset) => {
        reads.push(at.cwd);
        if (afterEnter > 0 && ++afterEnter === 3) {
          // Mid-reply: the session moves, then keeps writing where it now lives.
          cwd = worktree;
          transcript += assistant("the answer is 5") + turnEnd;
        }
        if (at.cwd !== cwd) throw new NativeTranscriptUnavailableError();
        const text = transcript.slice(offset);
        const complete = text.lastIndexOf("\n") + 1;
        return { offset: offset + complete, text: text.slice(0, complete) };
      },
      openAttach: () => ({
        write: data => {
          if (data === "\r") { transcript += user("what is 2+3?"); afterEnter = 1; }
        },
        lastOutputAt: () => 0,
        exited: new Promise<number>(() => {}),
        close: async () => {},
      }),
      now: () => clock,
      sleep: async ms => { clock += ms; },
      attachReadyTimeoutMs: 5_000,
      deliveryTimeoutMs: 2_000,
      pollMs: 250,
    };
    return { messenger: new ClaudeResidentMessenger(deps), reads };
  }

  test("the reply is read from where the session's transcript moved", async () => {
    const { messenger, reads } = movingHarness();
    expect(await messenger.message(target, "what is 2+3?")).toEqual({ status: "replied", reply: "the answer is 5" });
    expect(reads.at(-1)).toBe(worktree);
  });

  test("a transcript gone because the session itself is gone is still a failure", async () => {
    const { messenger } = movingHarness({ vanishes: true });
    await expect(messenger.message(target, "what is 2+3?")).rejects.toBeInstanceOf(NativeTranscriptUnavailableError);
  });
});
