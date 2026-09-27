import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  createLoginExpiredWatcher, deriveLoginExpiredCondition,
  type LoginExpiredEscalationHook, type LoginExpiredWatcherDeps,
} from "../src/login-expired-escalation.js";

// Primary fixture: FACTORY-360/FACTORY-357's own genuine capture, copied
// field-for-field from the incident session's transcript jsonl (see the
// ticket's description). Extended with `uuid`/`timestamp` — fields the
// ticket's illustrative snippet omitted, but which every real Claude Code
// transcript assistant record carries (verified against a real local
// `~/.claude/projects/.../*.jsonl` session on this host: `uuid`,
// `timestamp`, `sessionId`, `requestId` are all present on a live record).
// This detector's episode identity needs a stable anchor field
// (FACTORY-357 comment 26612), and the reduced ticket snippet has none, so
// this extension is required, not decorative — stated here rather than
// silently presenting an embellished record as verbatim.
const AUTH_FAILURE = readFileSync(new URL("./fixtures/login-expired/auth-failure-record.jsonl", import.meta.url), "utf8");
const SUCCESS = readFileSync(new URL("./fixtures/login-expired/success-record.jsonl", import.meta.url), "utf8");
const AUTH_FAILURE_RECORD = JSON.parse(AUTH_FAILURE.trim());
const SUCCESS_RECORD = JSON.parse(SUCCESS.trim());

/** A record that quotes the string, structurally never tagged as the auth-failure record. */
const NARRATED_QUOTE = {
  type: "assistant", uuid: "aaaaaaaa-1111-2222-3333-444444444444", timestamp: "2026-09-27T18:00:00.000Z",
  message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "This ticket says 'Login expired · Please run /login' — I'm just quoting it, not affected." }], stop_reason: "end_turn" },
};
const USER_PASTED_TICKET = {
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "See FACTORY-360: Login expired · Please run /login" }] },
};

describe("deriveLoginExpiredCondition", () => {
  test("true positive: the failure with nothing after it is live", () => {
    const result = deriveLoginExpiredCondition([AUTH_FAILURE_RECORD]);
    expect(result?.live).toBe(true);
    expect(result?.detail).toBe("Login expired · Please run /login");
    expect(result?.episodeId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("stale scrollback: failure followed by a later successful turn is NOT live — the real ~41-minute shape", () => {
    // FACTORY-357 comment 26492: failure at 16:40:35Z, healthy activity at
    // 17:22:01Z — ~41 minutes later, the measured false-positive window.
    const result = deriveLoginExpiredCondition([AUTH_FAILURE_RECORD, SUCCESS_RECORD]);
    expect(result?.live).toBe(false);
  });

  test("quoted text in narration never counts as a failure — structural tag only, text content is never inspected", () => {
    const result = deriveLoginExpiredCondition([NARRATED_QUOTE]);
    expect(result?.live).toBe(false);
  });

  test("a user record pasting the ticket text is never inspected at all (not type: assistant)", () => {
    const result = deriveLoginExpiredCondition([USER_PASTED_TICKET]);
    expect(result).toBeUndefined(); // no assistant record present: no evidence either way
  });

  test("an unrelated API error (not auth) proves nothing and is skipped", () => {
    const rateLimited = { ...AUTH_FAILURE_RECORD, error: "rate_limit" };
    const result = deriveLoginExpiredCondition([rateLimited]);
    expect(result).toBeUndefined();
  });

  test("a failure record missing both uuid and timestamp is not usable evidence (unstable identity is worse than none)", () => {
    const { uuid, timestamp, ...rest } = AUTH_FAILURE_RECORD;
    const result = deriveLoginExpiredCondition([rest]);
    expect(result).toBeUndefined();
  });

  test("episode identity is stable across 0/3/9/20 prepended synthetic chatter records, and detail does not degrade (FACTORY-357 comment 26612)", () => {
    const chatterLine = (i: number) => ({
      type: "user", message: { role: "user", content: [{ type: "text", text: `unrelated chatter line ${i}` }] },
    });
    const ids: string[] = [];
    for (const n of [0, 3, 9, 20]) {
      const chatter = Array.from({ length: n }, (_, i) => chatterLine(i));
      const result = deriveLoginExpiredCondition([...chatter, AUTH_FAILURE_RECORD]);
      expect(result?.live).toBe(true);
      expect(result?.detail).toBe("Login expired · Please run /login"); // unchanged regardless of N
      ids.push(result!.episodeId!);
    }
    expect(new Set(ids).size).toBe(1); // identical across every N
  });
});

interface Agent { pane_id: string; agent_status: string; cwd?: string; agent_session?: { kind: string; value: string }; name?: string }

/** No `read` or `sendKeys` property at all — proves this watcher never calls either. */
function client(agents: Agent[]) {
  return { agent: { list: async () => ({ agents: agents.map((a) => ({ ...a, agent: "claude" })) }) as never } };
}

function transcriptDeps(byPane: Record<string, unknown[][]>): LoginExpiredWatcherDeps {
  // Each pane's transcript is delivered as successive batches, one per poll,
  // exactly like readClaudeTranscriptTail's real incremental contract.
  const cursors = new Map<string, number>();
  return {
    async readTranscriptTail(session) {
      const batches = byPane[session.sessionId] ?? [];
      const at = cursors.get(session.sessionId) ?? 0;
      cursors.set(session.sessionId, Math.min(at + 1, batches.length));
      const batch = batches[at] ?? [];
      return { offset: at + 1, text: batch.map((r) => JSON.stringify(r)).join("\n") + (batch.length ? "\n" : "") };
    },
  };
}

function recordingHook(): LoginExpiredEscalationHook & { escalations: unknown[]; resolutions: unknown[] } {
  const escalations: unknown[] = [];
  const resolutions: unknown[] = [];
  return {
    escalations, resolutions,
    onLoginExpired: async (e) => { escalations.push(e); },
    onLoginExpiredResolved: async (r) => { resolutions.push(r); },
  };
}

const AGENT: Agent = { pane_id: "w1:p1", agent_status: "done", cwd: "/work/FACTORY-146", agent_session: { kind: "id", value: "sess-1" }, name: "FACTORY-146" };

describe("createLoginExpiredWatcher", () => {
  test("fires on the very first poll that sees the (non-stale) condition — no debounce", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD]] });
    const outcomes = await createLoginExpiredWatcher(hook, deps).poll(client([AGENT]));
    expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "escalated", episodeId: expect.any(String) }]);
    expect(hook.escalations).toEqual([{
      paneId: "w1:p1", label: "FACTORY-146", sessionId: "sess-1", cwd: "/work/FACTORY-146",
      herdrStatus: "done", kind: "login-expired", detail: "Login expired · Please run /login",
      episodeId: expect.any(String),
    }]);
  });

  test("stale scrollback shape: failure then later success in one poll's batch never escalates", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD, SUCCESS_RECORD]] });
    const outcomes = await createLoginExpiredWatcher(hook, deps).poll(client([AGENT]));
    expect(outcomes).toEqual([]);
    expect(hook.escalations).toEqual([]);
  });

  test("quoted text (this ticket's own literal string, narrated) never escalates", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[NARRATED_QUOTE, USER_PASTED_TICKET]] });
    const outcomes = await createLoginExpiredWatcher(hook, deps).poll(client([AGENT]));
    expect(outcomes).toEqual([]);
    expect(hook.escalations).toEqual([]);
  });

  test("emits the resolved event once a later poll's transcript carries a real successful turn", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD], [SUCCESS_RECORD]] });
    const watcher = createLoginExpiredWatcher(hook, deps);
    const first = await watcher.poll(client([AGENT]));
    expect(first[0]?.outcome).toBe("escalated");
    const second = await watcher.poll(client([AGENT]));
    const escalatedId = (hook.escalations[0] as { episodeId: string }).episodeId;
    expect(second).toEqual([{ paneId: "w1:p1", outcome: "resolved", episodeId: escalatedId }]);
    expect(hook.resolutions).toEqual([{ paneId: "w1:p1", episodeId: escalatedId }]);
  });

  test("a superseding distinct episode resolves the prior one before escalating the new one (no permanently-open leak)", async () => {
    // A dead credential being retried produces exactly this shape:
    // consecutive authentication_failed records with no successful
    // completion between them — the ordinary behavior of a session
    // hammering a dead token, not a rarity.
    const secondFailure = { ...AUTH_FAILURE_RECORD, uuid: "bbbbbbbb-2222-3333-4444-555555555555", timestamp: "2026-09-27T16:41:10.000Z" };
    const thirdFailure = { ...AUTH_FAILURE_RECORD, uuid: "cccccccc-3333-4444-5555-666666666666", timestamp: "2026-09-27T16:41:45.000Z" };
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD], [secondFailure], [thirdFailure]] });
    const watcher = createLoginExpiredWatcher(hook, deps);
    await watcher.poll(client([AGENT]));
    await watcher.poll(client([AGENT]));
    await watcher.poll(client([AGENT]));
    expect(hook.escalations.length).toBe(3); // one per distinct episode
    expect(hook.resolutions.length).toBe(2); // the two superseded episodes, never left permanently open
    const escalatedIds = (hook.escalations as { episodeId: string }[]).map((e) => e.episodeId);
    const resolvedIds = (hook.resolutions as { episodeId: string }[]).map((r) => r.episodeId);
    expect(new Set(escalatedIds).size).toBe(3); // three genuinely distinct episode ids
    expect(resolvedIds).toEqual([escalatedIds[0]!, escalatedIds[1]!]); // resolved in supersession order, the final one left open
  });

  test("the same open episode is not re-escalated on a later poll with no new evidence", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD], []] });
    const watcher = createLoginExpiredWatcher(hook, deps);
    await watcher.poll(client([AGENT]));
    const second = await watcher.poll(client([AGENT]));
    expect(second).toEqual([]);
    expect(hook.escalations.length).toBe(1);
  });

  test("a pane with no native session identity is unreadable and leaves an open episode untouched, never resolved on a guess", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD]] });
    const watcher = createLoginExpiredWatcher(hook, deps);
    await watcher.poll(client([AGENT]));
    expect(hook.escalations.length).toBe(1);

    const noIdentity: Agent = { pane_id: "w1:p1", agent_status: "done", name: "FACTORY-146" }; // no cwd, no agent_session
    const outcomes = await watcher.poll(client([noIdentity]));
    expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "unreadable", reason: "no native session identity" }]);
    expect(hook.resolutions).toEqual([]); // NOT resolved on a guess
  });

  test("a transcript read failure is unreadable and leaves an open episode untouched", async () => {
    const hook = recordingHook();
    let calls = 0;
    const deps: LoginExpiredWatcherDeps = {
      readTranscriptTail: async () => {
        calls++;
        if (calls === 1) return { offset: 1, text: JSON.stringify(AUTH_FAILURE_RECORD) + "\n" };
        throw new Error("transcript shrank below the read offset");
      },
    };
    const watcher = createLoginExpiredWatcher(hook, deps);
    await watcher.poll(client([AGENT]));
    expect(hook.escalations.length).toBe(1);
    const outcomes = await watcher.poll(client([AGENT]));
    expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "unreadable", reason: "transcript shrank below the read offset" }]);
    expect(hook.resolutions).toEqual([]);
  });

  test("resolves an open episode when the pane disappears from agent.list() entirely (closed)", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD]] });
    const watcher = createLoginExpiredWatcher(hook, deps);
    await watcher.poll(client([AGENT]));
    const outcomes = await watcher.poll(client([])); // pane gone
    expect(outcomes).toEqual([{ paneId: "w1:p1", outcome: "resolved", episodeId: expect.any(String) }]);
  });

  test("never calls agent.sendKeys for a login-expired pane — the client mock has no sendKeys at all", async () => {
    const hook = recordingHook();
    const deps = transcriptDeps({ "sess-1": [[AUTH_FAILURE_RECORD]] });
    // client() above deliberately omits `sendKeys` and `read`; if the watcher
    // ever called either, this would throw "is not a function".
    await expect(createLoginExpiredWatcher(hook, deps).poll(client([AGENT]))).resolves.toBeDefined();
  });
});
