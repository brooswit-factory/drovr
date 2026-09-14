import { expect, test } from "bun:test";
import { ManagedConversationSession, HANDOFF_ACK, HANDOFF_CHUNK_CHARS } from "../src/conversation-session";

const old = { provider: "claude" as const, conversationId: "old-session" };
test("an existing session without saved history cannot silently lose its context", async () => {
  const session = new ManagedConversationSession({current: old,cwd:"/work",readTranscript:async()=>"[]",
    createRunner:()=>{throw Error("must not launch");},commit:async()=>{throw Error("must not commit");}});
  await expect(session.switchProvider("codex","explicit")).rejects.toThrow("No saved transcript");
  expect(session.current).toEqual(old);
});
test("reads disk snapshot first, compacts in a new session, then commits without resuming old vendor ID", async () => {
  const events: string[] = [];
  const session = new ManagedConversationSession({ current: old, cwd: "/work", readTranscript: async () => { events.push("read"); return "user: finish the tests"; },
    createRunner: provider => ({ message: async (text, id) => {
      events.push(provider); expect(id).toBeUndefined(); expect(text).toContain("finish the tests");
      expect(text).toContain("Do not use tools"); expect(session.current).toEqual(old);
      return { conversationId: "new-session", response: HANDOFF_ACK + "\nTests remain to finish." };
    } }), commit: async next => { events.push("commit"); expect(next.provider).toBe("codex"); expect(session.current).toEqual(old); },
  });
  expect(await session.switchProvider("codex", "quota-blocked")).toEqual({ provider: "codex", conversationId: "new-session" });
  expect(events).toEqual(["read", "codex", "commit"]);
  await session.switchProvider("codex", "config"); expect(events.length).toBe(3);
});

test.each(["read", "launch", "ack", "commit"])("%s failure keeps the previous provider", async failure => {
  let committed = false;
  const session = new ManagedConversationSession({ current: old, cwd: "/work",
    readTranscript: async () => { if (failure === "read") throw Error("disk"); return "history"; },
    createRunner: () => ({ message: async () => { if (failure === "launch") throw Error("offline"); return { conversationId: "new", response: failure === "ack" ? "ok" : HANDOFF_ACK + "\nsummary" }; } }),
    commit: async () => { if (failure === "commit") throw Error("disk full"); committed = true; },
  });
  await expect(session.switchProvider("agy", "explicit request")).rejects.toThrow();
  expect(session.current).toEqual(old); expect(committed).toBe(false);
});

test("long history is delivered completely in ordered chunks to the same new conversation", async () => {
  const history = "a".repeat(HANDOFF_CHUNK_CHARS) + "last important decision";
  const pieces: string[] = [];
  const session = new ManagedConversationSession({ current: old, cwd: "/work", readTranscript: async () => history,
    createRunner: () => ({ message: async (text, id) => {
      expect(id).toBe(pieces.length ? "new" : undefined);
      pieces.push(JSON.parse(text.split("\n").at(-1)!));
      return { conversationId: "new", response: HANDOFF_ACK + "\nrolling summary" };
    } }), commit: async () => {},
  });
  await session.switchProvider("codex", "quota"); expect(pieces.join("")).toBe(history);
});

test("concurrent signals serialize using the last committed provider", async () => {
  const previous: string[] = [];
  const session = new ManagedConversationSession({ current: old, cwd: "/work", readTranscript: async () => "history",
    createRunner: provider => ({ message: async text => { previous.push(text); return { conversationId: provider + "-id", response: HANDOFF_ACK + "\nsummary" }; } }), commit: async () => {},
  });
  await Promise.all([session.switchProvider("codex", "first"), session.switchProvider("agy", "second")]);
  expect(previous[1]).toContain("Previous provider: codex"); expect(session.current?.provider).toBe("agy");
});
