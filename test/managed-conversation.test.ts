import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedConversationRunner, runConversationProcess,
  type ManagedAgentProvider, type RunProcess,
} from "../src/index.js";
import { ManagedConversationQuotaError } from "../src/managed-conversation.js";

const id = "01a097e9-8423-76f2-9e3d-b3c7918b9380";
const cwd = "/factory/work dir/USRR";
const agy = (response = "ready", conversationId = id) => JSON.stringify({ status: "SUCCESS", conversation_id: conversationId, response });
const claude = (response = "ready", conversationId = id) => JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: conversationId, result: response });
const events = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n");
const codex = (response = "ready", conversationId = id) => events(
  { type: "thread.started", thread_id: conversationId },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "item_0", type: "agent_message", text: response } },
  { type: "turn.completed", usage: { input_tokens: 15289, cached_input_tokens: 12160, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } },
);
const output = { agy, codex, claude };
const providers: ManagedAgentProvider[] = ["agy", "codex", "claude"];

function fixture(provider: ManagedAgentProvider, permissionMode?: string) {
  const calls: { argv: readonly string[]; cwd: string }[] = [];
  const run: RunProcess = async (argv, cwd) => {
    calls.push({ argv, cwd });
    return { exitCode: 0, stdout: output[provider](), stderr: "diagnostic details never enter the result" };
  };
  const runner = new ManagedConversationRunner({ provider, cwd, run, ...(permissionMode === undefined ? {} : { permissionMode }) });
  return { runner, calls };
}

describe("direct managed conversations", () => {
  test.each(providers)("%s returns native IDs and response, resumes explicitly, and passes cwd to the adapter", async provider => {
    const { runner, calls } = fixture(provider);
    expect(runner.provider).toBe(provider);
    expect(await runner.message("hello")).toEqual({ conversationId: id, response: "ready" });
    expect(await runner.message("continue", id)).toEqual({ conversationId: id, response: "ready" });
    expect(calls.map(call => call.cwd)).toEqual([cwd, cwd]);
    expect(calls.map(call => call.argv[0])).toEqual([provider, provider]);
    expect(calls[0]!.argv).not.toContain(id);
    expect(calls[1]!.argv).toContain(id);
    expect(runner.attachArgv(id)).toContain(id);
    expect(calls).toHaveLength(2);
  });

  test.each([undefined, "accept-edits", "unrecognized", "plan", "yolo"])("AGY retains USRR argv behavior for permission mode %s", async permissionMode => {
    const { runner, calls } = fixture("agy", permissionMode);
    const permission = permissionMode === "yolo" ? ["--dangerously-skip-permissions"]
      : ["--mode", permissionMode === "plan" ? "plan" : "accept-edits"];
    await runner.message("hello");
    await runner.message("again", id);
    expect(calls[0]!.argv).toEqual(["agy", ...permission, "--output-format", "json", "--print", "hello"]);
    expect(calls[1]!.argv).toEqual(["agy", ...permission, "--output-format", "json", "--conversation", id, "--print", "again"]);
    expect(runner.attachArgv(id)).toEqual(["agy", ...permission, "--conversation", id]);
  });

  test.each(["accept-edits", "plan", "yolo"])("Codex uses exec JSONL, native resume, and interactive attach for %s", async permissionMode => {
    const { runner, calls } = fixture("codex", permissionMode);
    const sandbox = permissionMode === "plan" ? "read-only" : "workspace-write";
    const permission = permissionMode === "yolo" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", sandbox, "--ask-for-approval", "never"];
    const interactive = permissionMode === "yolo" ? permission : ["--sandbox", sandbox, "--ask-for-approval", "on-request"];
    await runner.message("hello");
    await runner.message("again", id);
    expect(calls[0]!.argv).toEqual(["codex", ...permission, "exec", "--json", "--skip-git-repo-check", "--", "hello"]);
    expect(calls[1]!.argv).toEqual(["codex", ...permission, "exec", "--json", "--skip-git-repo-check", "resume", "--", id, "again"]);
    expect(runner.attachArgv(id)).toEqual(["codex", ...interactive, "--cd", cwd, "resume", "--", id]);
  });

  test.each(["accept-edits", "plan", "yolo"])("Claude uses JSON print, native resume, and interactive attach for %s", async permissionMode => {
    const { runner, calls } = fixture("claude", permissionMode);
    const permission = permissionMode === "yolo" ? ["--dangerously-skip-permissions"] : ["--permission-mode", permissionMode === "plan" ? "plan" : "acceptEdits"];
    await runner.message("hello");
    await runner.message("again", id);
    expect(calls[0]!.argv).toEqual(["claude", ...permission, "--output-format", "json", "--print", "--", "hello"]);
    expect(calls[1]!.argv).toEqual(["claude", ...permission, "--output-format", "json", "--resume", id, "--print", "--", "again"]);
    expect(runner.attachArgv(id)).toEqual(["claude", ...permission, "--resume", id]);
  });

  test.each(providers)("%s preserves prompt text as one argument, including option-looking input", async provider => {
    const { runner, calls } = fixture(provider);
    const text = "--dangerously-skip-permissions\n$(do-not-execute) \"quoted\"";
    await runner.message(text);
    expect(calls[0]!.argv.at(-1)).toBe(text);
    if (provider !== "agy") expect(calls[0]!.argv.at(-2)).toBe("--");
  });

  test.each(providers)("%s refuses a changed resume ID instead of silently replacing the session", async provider => {
    const { runner } = fixture(provider);
    await expect(runner.message("again", "other-native-id")).rejects.toThrow("different conversation ID");
  });

  test.each(providers)("%s does not expose process errors or mislabel failures as quota", async provider => {
    for (const run of [
      async () => ({ exitCode: 1, stdout: "stdout-secret quota", stderr: "stderr-secret quota" }),
      async () => { throw new Error("spawn-secret quota"); },
    ]) {
      const runner = new ManagedConversationRunner({ provider, cwd, run });
      try { await runner.message("hello", id); throw new Error("unexpected success"); }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain("conversation process");
        expect(String(error)).not.toContain("secret");
        expect(String(error)).not.toContain("quota");
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  test.each(providers)("%s rejects malformed output without leaking its text", async provider => {
    const runner = new ManagedConversationRunner({ provider, cwd, run: async () => ({ exitCode: 0, stdout: "private-output-not-json", stderr: "private-stderr" }) });
    await expect(runner.message("hello")).rejects.toThrow("invalid JSON");
  });

  test.each(providers)("%s rejects incomplete or unsuccessful results even with exit zero", async provider => {
    const invalid: Record<ManagedAgentProvider, string[]> = {
      agy: ["null", "[]", "{}", JSON.stringify({ status: "FAILURE", conversation_id: id, response: "secret" }), JSON.stringify({ status: "SUCCESS", conversation_id: "", response: "secret" })],
      claude: ["null", "{}", claude().replace('"is_error":false', '"is_error":true'), claude().replace('"subtype":"success"', '"subtype":"error_max_turns"'), claude().replace('"result":"ready"', '"result":null')],
      codex: ["", events({ type: "thread.started", thread_id: id }), events({ type: "turn.completed" }), codex() + "\n" + events({ type: "error", message: "secret" }), codex() + "\n" + events({ type: "turn.failed", error: { message: "secret" } })],
    };
    for (const stdout of invalid[provider]) {
      const runner = new ManagedConversationRunner({ provider, cwd, run: async () => ({ exitCode: 0, stdout, stderr: "" }) });
      await expect(runner.message("hello")).rejects.toThrow();
    }
  });

  test("Codex ignores reasoning and tool output and returns the final completed agent message", async () => {
    const stdout = events(
      { type: "thread.started", thread_id: id }, { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "working" } },
      { type: "item.completed", item: { type: "reasoning", text: "private reasoning" } },
      { type: "item.completed", item: { type: "command_execution", aggregated_output: "tool output" } },
      { type: "item.started", item: { type: "agent_message", text: "partial" } },
      { type: "item.completed", item: { type: "agent_message", text: "final\nresponse" } },
      { type: "turn.completed" },
    );
    const runner = new ManagedConversationRunner({ provider: "codex", cwd, run: async () => ({ exitCode: 0, stdout, stderr: "warning" }) });
    expect(await runner.message("hello")).toEqual({ conversationId: id, response: "final\nresponse" });
  });

  test("measured Claude initial/resume refusal is never successful even with subtype success", async () => {
    const stdout = JSON.stringify({
      type: "result", subtype: "success", is_error: true,
      session_id: "b0d9be65-a076-4e12-8e05-b1b261740278", terminal_reason: "api_error",
      api_error_status: 429, result: "You've hit your weekly limit \u00b7 resets Sep 17, 8am (America/Los_Angeles)", num_turns: 1,
    });
    for (const exitCode of [0, 1]) {
      const runner = new ManagedConversationRunner({ provider: "claude", cwd, run: async () => ({ exitCode, stdout, stderr: "" }) });
      for (const resume of [undefined, "b0d9be65-a076-4e12-8e05-b1b261740278"]) {
        const error = await runner.message("hello", resume).catch(error => error);
        expect(error).toBeInstanceOf(ManagedConversationQuotaError);
        expect(error.provider).toBe("claude");
        expect(error.refusal.raw).toBe(JSON.parse(stdout).result);
        expect(error.refusal.resetsAt).not.toBeNull();
        expect(new Date(error.refusal.resetsAt).toISOString()).toMatch(/-09-17T15:00:00.000Z$/);
      }
    }
  });

  test("a Codex exec turn failed on Codex's usage limit is typed Codex quota, initial and resumed", async () => {
    const message = "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 29th, 2026 4:03 PM.";
    const stdout = events(
      { type: "thread.started", thread_id: id }, { type: "turn.started" },
      { type: "error", message }, { type: "turn.failed", error: { message } },
    );
    for (const exitCode of [0, 1]) {
      const runner = new ManagedConversationRunner({ provider: "codex", cwd, run: async () => ({ exitCode, stdout, stderr: "" }) });
      for (const resume of [undefined, id]) {
        const error = await runner.message("hello", resume).catch(error => error);
        expect(error).toBeInstanceOf(ManagedConversationQuotaError);
        expect(error.provider).toBe("codex");
        expect(error.message).toBe("Codex native conversation quota blocked");
        expect(error.refusal).toEqual({ raw: message, resetsAt: new Date(2026, 8, 29, 16, 3).getTime() });
      }
    }
  });

  test("other Codex failures, and a completed turn, never produce typed quota", async () => {
    const quoted = "You’ve hit your usage limit.";
    const cases = [
      events({ type: "thread.started", thread_id: id }, { type: "turn.failed", error: { message: "stream disconnected before completion" } }),
      events({ type: "thread.started", thread_id: id }, { type: "turn.failed", error: { message: `Tool said: ${quoted}` } }),
      events({ type: "thread.started", thread_id: id }, { type: "error", message: "unexpected status 429 Too Many Requests" }),
      events({ type: "thread.started", thread_id: id }, { type: "item.completed", item: { type: "agent_message", text: quoted } }, { type: "turn.completed" }),
      events({ type: "thread.started", thread_id: id }, { type: "error", message: quoted }, { type: "turn.completed" }),
      `not json\n${JSON.stringify({ type: "turn.failed", error: { message: quoted } })}`,
    ];
    for (const stdout of cases) {
      for (const exitCode of [0, 1]) {
        const runner = new ManagedConversationRunner({ provider: "codex", cwd, run: async () => ({ exitCode, stdout, stderr: quoted }) });
        expect(await runner.message("hello").catch(error => error)).not.toBeInstanceOf(ManagedConversationQuotaError);
      }
    }
  });

  test("only the measured Claude API refusal envelope produces typed quota", async () => {
    const refusal = { type: "result", subtype: "success", is_error: true, session_id: id,
      terminal_reason: "api_error", api_error_status: 429, result: "You've hit your weekly limit" };
    const cases = [
      { ...refusal, is_error: false }, { ...refusal, terminal_reason: "tool_error" },
      { ...refusal, api_error_status: 500 }, { ...refusal, api_error_status: "429" },
      { ...refusal, type: "assistant" }, { ...refusal, subtype: "error_max_turns" },
      { ...refusal, session_id: "" }, { ...refusal, result: "Rate limit exceeded" },
      { ...refusal, result: "Quoted: You've hit your weekly limit" },
      { ...refusal, result: "tool output\nYou've hit your weekly limit" },
      { ...refusal, result: JSON.stringify(refusal) },
      { type: "tool_result", content: refusal },
    ];
    for (const value of cases) {
      const runner = new ManagedConversationRunner({ provider: "claude", cwd,
        run: async () => ({ exitCode: 1, stdout: JSON.stringify(value), stderr: JSON.stringify(refusal) }) });
      const error = await runner.message("hello").catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ManagedConversationQuotaError);
    }
    for (const provider of providers) {
      const runner = new ManagedConversationRunner({ provider, cwd,
        run: async () => ({ exitCode: provider === "claude" ? 137 : 1, stdout: JSON.stringify(refusal), stderr: "" }) });
      expect(await runner.message("hello").catch(error => error)).not.toBeInstanceOf(ManagedConversationQuotaError);
    }
    const successful = new ManagedConversationRunner({ provider: "claude", cwd,
      run: async () => ({ exitCode: 0, stdout: claude(refusal.result), stderr: "" }) });
    expect((await successful.message("hello")).response).toBe(refusal.result);
  });

  test("invalid IDs never reach a process or interactive picker", async () => {
    for (const provider of providers) {
      const { runner, calls } = fixture(provider);
      for (const invalid of ["", " ", "--last", "bad\0id", "bad\nid"]) {
        await expect(runner.message("hello", invalid)).rejects.toThrow("Invalid conversation ID");
        expect(() => runner.attachArgv(invalid)).toThrow("Invalid conversation ID");
      }
      expect(calls).toEqual([]);
    }
  });
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("conversation process adapter", () => {
  test("uses argv directly, preserves cwd, and closes stdin", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "drovr-conversation-process-"));
    directories.push(cwd);
    const literal = "$(not-a-command); \"literal\"";
    const result = await runConversationProcess([process.execPath, "--eval", "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv.at(-1),stdin:await new Response(Bun.stdin).text()}))", "--", literal], cwd);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ cwd, arg: literal, stdin: "" });
    expect(result.stderr).toBe("");
  });

  test("drains stdout and stderr concurrently and preserves the exit code", async () => {
    const result = await runConversationProcess([process.execPath, "--eval", "await Promise.all([Bun.write(Bun.stdout, 'o'.repeat(262144)), Bun.write(Bun.stderr, 'e'.repeat(262144))]); process.exit(7)"], tmpdir());
    expect(result).toEqual({ exitCode: 7, stdout: "o".repeat(262144), stderr: "e".repeat(262144) });
  });

  test("spawn failures are sanitized", async () => {
    await expect(runConversationProcess(["/not-present/private-executable-secret"], tmpdir())).rejects.toThrow("Conversation process execution failed");
  });
});
