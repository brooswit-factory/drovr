import { describe, expect, test } from "bun:test";
import type { DrovrClient } from "../src/drovr-client.js";
import { ManagedHerdrLifecycle, type ManagedHerdrStartRequest } from "../src/managed-herdr-lifecycle.js";
import { ProviderAvailabilityRegistry } from "../src/provider-fallback.js";
import type { ManagedAgentProvider } from "../src/agent-runtime.js";

function fixture(options: { source?: string; transcriptLimits?: import("../src/transcript-limits.js").TranscriptLimits; ackAt?: number; readFail?: boolean; startFail?: boolean; ack?: "missing" | "empty" | "prompt"; closeFail?: boolean; kickoffFail?: boolean; provider?: ManagedAgentProvider; large?: boolean; fastDone?: boolean; disappear?: boolean; slowRead?: boolean; oldProvider?: ManagedAgentProvider; priority?: ManagedAgentProvider[]; availability?: ProviderAvailabilityRegistry; kickoffScreen?: (provider: ManagedAgentProvider) => string | undefined; launchPending?: boolean; launchPendingClearsAfterPolls?: number; launchPendingTimeoutMs?: number } = {}) {
  const events: string[] = [];
  const kickedOff = new Set<string>();
  const screens = new Map<string, string>();
  const kicked = (pane: string, provider: ManagedAgentProvider) => {
    kickedOff.add(pane);
    const screen = options.kickoffScreen?.(provider);
    if (screen !== undefined) screens.set(pane, screen);
  };
  const source = options.source ?? (options.large ? "history".repeat(15_000) : "saved history with pending work");
  const histories = new Map<string, string>([["old", source]]);
  const row = (pane: string, provider: ManagedAgentProvider, launchPending?: boolean) => ({ pane_id: pane, cwd: "/work", agent: provider, agent_status: "idle", agent_session: { agent: provider, kind: "id", value: pane, source: "test" }, ...(launchPending ? { launch_pending: true } : {}) });
  let rows = [row("old", options.oldProvider ?? "claude")];
  let count = 0;
  let launchPendingPolls = 0;
  const prompts: string[] = [];
  const launches: any[] = [];
  let gate: Promise<void> = Promise.resolve();
  function respond(pane: string, prompt: string, provider: ManagedAgentProvider) {
    prompts.push(prompt);
    const token = prompt.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)?.[0];
    if (!token) return;
    const response = options.ackAt === prompts.filter(p => p.includes("DROVR_HANDOFF_READY_")).length ? "unacknowledged summary" : options.ack === "empty" ? token : options.ack === "missing" ? "unacknowledged summary" : `${token}\nObjectives, decisions, remaining work.`;
    const text = options.ack === "prompt" ? prompt : response;
    const record = provider === "claude"
      ? { type: options.ack === "prompt" ? "user" : "assistant", message: { role: options.ack === "prompt" ? "user" : "assistant", content: [{ type: "text", text }] } }
      : provider === "codex"
        ? { type: "response_item", payload: { type: "message", role: options.ack === "prompt" ? "user" : "assistant", content: [{ type: "output_text", text }] } }
      : { type: options.ack === "prompt" ? "USER_INPUT" : "PLANNER_RESPONSE", source: "MODEL", status: "DONE", content: text };
    histories.set(pane, (histories.get(pane) ?? "") + JSON.stringify(record) + "\n");
  }
  const client = {
    agent: {
      list: async () => {
        if (options.launchPending && options.launchPendingClearsAfterPolls !== undefined) {
          launchPendingPolls++;
          if (launchPendingPolls > options.launchPendingClearsAfterPolls) {
            for (const r of rows) (r as { launch_pending?: boolean }).launch_pending = false;
          }
        }
        return { agents: rows };
      },
      get: async (pane: string) => { events.push(`get:${pane}`); return { agent: rows.find(a => a.pane_id === pane)! }; },
      start: async (params: any) => {
        events.push(`start:${params.pane_id}`);
        launches.push(params);
        if (params.args.some((arg: string) => arg.includes("\n"))) throw new Error("Herdr cannot encode multiline launch arguments");
        if (options.startFail) throw new Error("start failed");
        rows.push(row(params.pane_id, params.kind, options.launchPending));
        await gate;
        respond(params.pane_id, params.args[params.kind === "agy" ? 1 : 0], params.kind);
      },
      prompt: async ({ target, text }: any) => {
        events.push(`prompt:${target}:${text === "kickoff" ? "kickoff" : "other"}`);
        if (text === "kickoff" && options.kickoffFail) throw new Error("kickoff failed");
        const agent = rows.find(a => a.pane_id === target)!;
        respond(target, text, agent.agent);
        if (text === "kickoff") { agent.agent_status = options.fastDone ? "done" : "working"; kicked(target, agent.agent); }
        if (text === "kickoff" && options.disappear) rows = rows.filter(a => a.pane_id !== target);
        return { agent };
      },
    },
    workspace: { create: async () => { events.push("create"); return { root_pane: `new-${++count}` }; } },
    pane: {
      close: async (pane: string) => {
        events.push(`close:${pane}`);
        if (options.closeFail && pane === "old") throw new Error("close failed");
        rows = rows.filter(a => a.pane_id !== pane);
      },
      // Only kickoff verification may look at a screen; history and
      // acknowledgement always come from native transcripts.
      read: async ({ pane_id }: { pane_id: string }) => {
        if (!kickedOff.has(pane_id)) throw new Error("Screen must never be read for history or ack");
        events.push(`screen:${pane_id}`);
        return { read: { text: screens.get(pane_id) ?? "" } };
      },
    },
  };
  const availability = options.availability ?? new ProviderAvailabilityRegistry();
  const lifecycle = new ManagedHerdrLifecycle({ client: client as unknown as DrovrClient, cwd: "/work", availability, ...(options.transcriptLimits ? { transcriptLimits: options.transcriptLimits } : {}), ...(options.launchPendingTimeoutMs !== undefined ? { launchPendingTimeoutMs: options.launchPendingTimeoutMs } : {}), wait: async () => {}, pollIntervalMs: 1, acknowledgementTimeoutMs: options.slowRead ? 2 : 100,
    readTranscript: async ({ session }) => {
      events.push(`read:${session.value}`);
      if (options.readFail && session.value === "old") throw new Error("missing transcript");
      if (options.slowRead && session.value !== "old") return new Promise<string>(() => {});
      return histories.get(session.value) ?? "";
    },
  });
  const provider = options.provider ?? "codex";
  const request: ManagedHerdrStartRequest = { priority: (options.priority ?? [provider]).map(p => ({ provider: p, accountId: "default" })), label: "role", replacePaneId: "old", kickoff: () => "kickoff", prepare: async provider => {
    events.push("prepare");
    return { launch: provider === "claude"
      ? { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch", effort: "high", mcpConfigPath: "/work/mcp.json" }
      : provider === "codex" ? { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch", mcpServers: [] }
      : { provider, cwd: "/work", name: "role", paneId: "ignored", prompt: "must not launch" } };
  } };
  return { lifecycle, availability, launches, client: client as unknown as DrovrClient, request, events, prompts, histories, rows: () => rows, gate: (value: Promise<void>) => { gate = value; } };
}

const lunaReserve = "• Automatically switched to Luna Reserve medium due to usage limits.\n\n› Ask Codex to do anything\n";
const account = (provider: ManagedAgentProvider) => ({ provider, accountId: "default" });

describe("ManagedHerdrLifecycle quota replacement re-walks priority from the top", () => {
  test("a quota-blocked Codex worker is replaced by Claude when Claude comes first", async () => {
    const f = fixture({ oldProvider: "codex", priority: ["claude", "codex"] });
    f.availability.observePane(account("codex"), "idle", lunaReserve);
    const result = await f.lifecycle.start(f.request);
    expect(result).toMatchObject({ status: "success", account: account("claude"), value: "new-1", attempted: [account("claude")] });
    expect(f.lifecycle.current).toMatchObject({ paneId: "new-1", provider: "claude" });
    expect(f.events).toContain("close:old");
  });

  test("a quota-blocked Claude worker is replaced by the next provider, Codex", async () => {
    const f = fixture({ oldProvider: "claude", priority: ["claude", "codex"] });
    f.availability.markQuotaBlocked(account("claude"), { resetsAt: null, raw: "You've hit your session limit" });
    const result = await f.lifecycle.start(f.request);
    expect(result).toMatchObject({ status: "success", account: account("codex"), attempted: [account("codex")] });
    expect(f.lifecycle.current).toMatchObject({ paneId: "new-1", provider: "codex" });
  });

  test("a Codex kickoff that lands on the usage-limit notice falls through to the next provider", async () => {
    const f = fixture({ oldProvider: "claude", priority: ["codex", "claude"], fastDone: true,
      kickoffScreen: provider => provider === "codex" ? lunaReserve : "" });
    const result = await f.lifecycle.start(f.request);
    expect(result).toMatchObject({ status: "success", account: account("claude"), attempted: [account("codex"), account("claude")] });
    expect(f.availability.get(account("codex"))).toMatchObject({ status: "quota-blocked", resetsAt: null });
    expect(f.lifecycle.current).toMatchObject({ provider: "claude" });
    expect(f.events).toContain("screen:new-1");
  });

  test("a blocked provider is eligible again at its own position once its reset passes", async () => {
    let now = 100;
    const availability = new ProviderAvailabilityRegistry(() => now);
    availability.markQuotaBlocked(account("claude"), { resetsAt: 200, raw: "You've hit your session limit" });
    const blocked = fixture({ oldProvider: "codex", priority: ["claude", "codex"], availability });
    expect(await blocked.lifecycle.start(blocked.request)).toMatchObject({ status: "success", account: account("codex") });
    now = 200;
    const reset = fixture({ oldProvider: "codex", priority: ["claude", "codex"], availability });
    expect(await reset.lifecycle.start(reset.request)).toMatchObject({ status: "success", account: account("claude") });
  });

  test("every provider blocked keeps the current worker and reports exhaustion", async () => {
    const f = fixture({ oldProvider: "codex", priority: ["claude", "codex"] });
    f.availability.observePane(account("codex"), "done", lunaReserve);
    f.availability.markQuotaBlocked(account("claude"), { resetsAt: null, raw: "You've hit your weekly limit" });
    expect(await f.lifecycle.start(f.request)).toEqual({ status: "exhausted", reason: "no-available-provider", attempted: [] });
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect(f.events).not.toContain("create");
  });
});

describe("ManagedHerdrLifecycle", () => {
  test("explicit kickoff runs exactly once even when it finishes before verification", async () => {
    const f = fixture({ fastDone: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("success");
    expect(f.events.filter(e => e.endsWith(":kickoff"))).toEqual(["prompt:new-1:kickoff"]);
  });
  test("disappearance during final verification is blocked, never success", async () => {
    const f = fixture({ disappear: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("new-1");
  });
  test("a hung native acknowledgement read is bounded by wall time", async () => {
    const f = fixture({ slowRead: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect(f.events).not.toContain("close:old");
  });
  test("instances sharing client and workspace serialize replacement operations", async () => {
    const f = fixture();
    const second = new ManagedHerdrLifecycle({ client: f.client, cwd: "/work", wait: async () => {} });
    const [first, stale] = await Promise.all([f.lifecycle.start(f.request), second.start(f.request)]);
    expect(first.status).toBe("success");
    expect(stale.status).toBe("blocked");
    expect(f.events.filter(e => e === "create")).toHaveLength(1);
  });
  for (const failure of ["readFail", "startFail"] as const) test(`${failure} preserves old current without kickoff`, async () => {
    const f = fixture({ [failure]: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect(f.rows().map(a => a.pane_id)).toEqual(["old"]);
    expect(f.events).not.toContain("close:old");
    expect(f.events.some(e => e.includes(":kickoff"))).toBe(false);
    if (failure === "readFail") expect(f.events).not.toContain("create");
  });
  for (const provider of ["claude", "codex", "agy"] as const) {
    test(`${provider} reads before creation, compacts, acknowledges then retires and kicks off`, async () => {
      const f = fixture({ provider });
      expect((await f.lifecycle.start(f.request)).status).toBe("success");
      expect(f.events.indexOf("read:old")).toBeLessThan(f.events.indexOf("create"));
      expect(f.events.indexOf("read:new-1")).toBeLessThan(f.events.indexOf("close:old"));
      expect(f.events.indexOf("close:old")).toBeLessThan(f.events.indexOf("prompt:new-1:kickoff"));
      expect(f.prompts[0]).toContain("context handoff bootstrap");
      expect(f.prompts[1]).toContain("ONLY for importing and compacting historical context");
      expect(f.prompts[0]).not.toContain("must not launch");
      expect(f.lifecycle.current?.paneId).toBe("new-1");
    });
    for (const ack of ["missing", "empty", "prompt"] as const) test(`${provider} ${ack} acknowledgement cannot retire source`, async () => {
      const f = fixture({ provider, ack });
      expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("old");
      expect(f.events).not.toContain("close:old");
      expect(f.events).toContain("close:new-1");
      expect(f.events.some(e => e.includes(":kickoff"))).toBe(false);
    });
  }
  test("chunks require distinct acknowledgements in the same exact pane", async () => {
    const f = fixture({ large: true });
    expect((await f.lifecycle.start(f.request)).status).toBe("success");
    const imports = f.prompts.filter(p => p.includes("ONLY for importing"));
    expect(imports).toHaveLength(3);
    expect(new Set(imports.map(p => p.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)![0])).size).toBe(3);
    expect(f.events.filter(e => e.startsWith("start:"))).toEqual(["start:new-1"]);
  });
  test("overlap keeps old identity and serializes prompt, stale switch and stop", async () => {
    const f = fixture();
    let release!: () => void;
    f.gate(new Promise(resolve => { release = resolve; }));
    const start = f.lifecycle.start(f.request);
    while (!f.events.includes("start:new-1")) await Promise.resolve();
    expect(f.lifecycle.current?.paneId).toBe("old");
    expect((await f.lifecycle.resolveCurrent())?.pane_id).toBe("old");
    const prompt = f.lifecycle.prompt("followup");
    const repeated = f.lifecycle.start(f.request);
    const stop = f.lifecycle.stop();
    expect(f.events.some(e => e.startsWith("prompt:"))).toBe(false);
    release();
    await start;
    await prompt;
    expect((await repeated).status).toBe("blocked");
    await stop;
    expect(f.events).toContain("prompt:new-1:other");
    expect(f.events.at(-1)).toBe("close:new-1");
  });
  test("changed native source or working source cannot commit", async () => {
    for (const change of ["history", "status", "session"]) {
      const f = fixture();
      let release!: () => void;
      f.gate(new Promise(resolve => { release = resolve; }));
      const start = f.lifecycle.start(f.request);
      while (!f.events.includes("start:new-1")) await Promise.resolve();
      if (change === "history") f.histories.set("old", "new history");
      else if (change === "status") f.rows()[0]!.agent_status = "working";
      else f.rows()[0]!.agent_session.value = "other-session";
      release();
      expect((await start).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("old");
      expect(f.events).not.toContain("close:old");
    }
  });
  test("retirement and kickoff failures retain acknowledged current", async () => {
    for (const failure of ["closeFail", "kickoffFail"] as const) {
      const f = fixture({ [failure]: true });
      expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
      expect(f.lifecycle.current?.paneId).toBe("new-1");
      expect(f.events).not.toContain("close:new-1");
      if (failure === "closeFail") expect(f.events).not.toContain("prompt:new-1:kickoff");
    }
  });
  test("restart with duplicate cwd fails closed, missing pinned pane never routes to its neighbor", async () => {
    const f = fixture();
    f.rows().push({ ...f.rows()[0]!, pane_id: "other" });
    expect((await f.lifecycle.start(f.request)).status).toBe("blocked");
    expect(f.events).not.toContain("create");
    f.rows().pop();
    await f.lifecycle.resolveCurrent();
    f.rows()[0]!.pane_id = "other";
    expect(await f.lifecycle.prompt("work")).toBeUndefined();
    expect(f.events.some(e => e.startsWith("prompt:"))).toBe(false);
  });
});

const MiB = 1024 * 1024;
test.each(['ascii','unicode'] as const)('configured full %s history above four MiB imports with every chunk ACK',async kind=>{
 const source = kind==='ascii' ? JSON.stringify({history:'a'.repeat(5*MiB)})+'\n' : 'x'+'😃'.repeat(2*MiB+1);
 const f=fixture({source,oldProvider:'codex',provider:'claude',transcriptLimits:{maxBytes:16*MiB,maxChars:8*MiB}});
 const r=await f.lifecycle.start(f.request);expect(r.status).toBe('success');
 const imported=f.prompts.filter(p=>p.includes('Transcript chunk ')).map(p=>JSON.parse(p.match(/"(?:[^"\\]|\\.)*"$/s)![0]) as string);
 expect(imported.length).toBeGreaterThan(80);expect(imported.join('')).toBe(source);
 expect(imported.every(p=>!/[\uD800-\uDBFF]$/.test(p)&&!/[\uDC00-\uDFFF]/.test(p[0]??''))).toBe(true);
 expect(f.events.filter(e=>e==='close:old')).toHaveLength(1);expect(f.lifecycle.current?.provider).toBe('claude');
});
test.each(['bytes','chars','default'] as const)('%s overflow refuses before prepare or target creation',async which=>{
 const source=which==='bytes'?'界'.repeat(40):'x'.repeat(4*MiB+1);
 const f=fixture({source,...(which==='default'?{}:{transcriptLimits:which==='bytes'?{maxBytes:119,maxChars:100}:{maxBytes:8*MiB,maxChars:4*MiB}})});
 const r=await f.lifecycle.start(f.request);expect(r.status).toBe('blocked');expect(f.events).not.toContain('prepare');expect(f.events).not.toContain('create');expect(f.events).not.toContain('close:old');expect(f.lifecycle.current?.paneId).toBe('old');
});
test('configured exact byte and UTF-16 boundaries are inclusive',async()=>{const f=fixture({source:'界'.repeat(4096),transcriptLimits:{maxBytes:12288,maxChars:4096}});expect((await f.lifecycle.start(f.request)).status).toBe('success');});
test.each([3,111])('missing chunk %s ACK in a large import preserves original identity',async ackAt=>{
 const f=fixture({source:'a'.repeat(5*MiB),transcriptLimits:{maxBytes:8*MiB,maxChars:8*MiB},ackAt});
 const r=await f.lifecycle.start(f.request);expect(r.status).toBe('blocked');expect(f.lifecycle.current?.paneId).toBe('old');expect(f.events).not.toContain('close:old');expect(f.events).toContain('close:new-1');expect(f.events.some(e=>e.endsWith(':kickoff'))).toBe(false);
});
test('limits are captured at construction and injected readers cannot exceed the byte bound',async()=>{const limits={maxBytes:119,maxChars:100};const f=fixture({source:'界'.repeat(40),transcriptLimits:limits});limits.maxBytes=1024;expect((await f.lifecycle.start(f.request)).status).toBe('blocked');expect(f.events).not.toContain('create');});

for(const limits of [null,[],{maxBytes:0},{maxChars:Infinity},{maxBytes:64*1024*1024+1},{maxChars:null}] as any[])test('invalid lifecycle limits refuse before any client call: '+JSON.stringify(limits),()=>{const client=new Proxy({},{get(){throw Error('must not access client')}});expect(()=>new ManagedHerdrLifecycle({client:client as any,cwd:'/work',transcriptLimits:limits})).toThrow();});

for (const provider of ['claude', 'codex', 'agy'] as const) test(`${provider} launches with a bounded history-free bootstrap and imports every byte through prompts`, async () => {
  const source = "historical ' \" \\ \n 😃 ".repeat(8000);
  const f = fixture({ source, provider, oldProvider: provider === 'claude' ? 'codex' : 'claude' });
  expect((await f.lifecycle.start(f.request)).status).toBe('success');
  expect(f.launches).toHaveLength(1);
  const bootstrap = f.launches[0].args[provider === 'agy' ? 1 : 0] as string;
  expect(bootstrap.length).toBeLessThan(512);
  expect(bootstrap).not.toContain('historical \'');
  expect(bootstrap).not.toContain('Transcript chunk');
  expect(bootstrap).not.toContain('\n');
  const imports = f.prompts.filter(p => p.includes('Transcript chunk '));
  expect(imports.length).toBeGreaterThan(2);
  expect(imports.map(p => JSON.parse(p.match(/"(?:[^"\\]|\\.)*"$/s)![0])).join('')).toBe(source);
  const bootstrapToken = bootstrap.match(/DROVR_HANDOFF_READY_[a-f0-9-]+/)![0];
  expect(imports.every(p => !p.includes(bootstrapToken))).toBe(true);
  expect(f.events.filter(e => e === 'start:new-1')).toHaveLength(1);
  expect(f.events.filter(e => e === 'prompt:new-1:other')).toHaveLength(imports.length);
  expect(f.events.indexOf('read:new-1')).toBeLessThan(f.events.indexOf('prompt:new-1:other'));
  expect(f.events.filter(e => e === 'close:old')).toHaveLength(1);
});

test('missing bootstrap ACK sends no historical prompt, preserves source, and cleans its target', async () => {
  const f = fixture({ source: 'SECRET-SYNTHETIC-HISTORY'.repeat(3000), ackAt: 1 });
  expect((await f.lifecycle.start(f.request)).status).toBe('blocked');
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toContain('context handoff bootstrap');
  expect(f.events.filter(e => e.startsWith('prompt:'))).toEqual([]);
  expect(f.events).not.toContain('close:old');
  expect(f.events).toContain('close:new-1');
  expect(f.lifecycle.current?.paneId).toBe('old');
});

test('a bootstrap ACK cannot acknowledge the first history chunk', async () => {
  const f = fixture();
  const originalPrompt = f.client.agent.prompt.bind(f.client.agent);
  f.client.agent.prompt = async params => {
    const result = await originalPrompt(params);
    // Keep the exact previously acknowledged bootstrap record as the latest
    // native reply, rather than inventing a fresh import acknowledgement.
    const history = f.histories.get('new-1')!.trim().split('\n');
    f.histories.set('new-1', history[0] + '\n');
    return result;
  };
  expect((await f.lifecycle.start(f.request)).status).toBe('blocked');
  expect(f.prompts.filter(p => p.includes('Transcript chunk '))).toHaveLength(1);
  expect(f.events).not.toContain('close:old');
  expect(f.events.some(e => e.endsWith(':kickoff'))).toBe(false);
  expect(f.lifecycle.current?.paneId).toBe('old');
});

test('a changed native target after bootstrap cannot commit the import', async () => {
  const f = fixture();
  const originalPrompt = f.client.agent.prompt.bind(f.client.agent);
  f.client.agent.prompt = async params => {
    const result = await originalPrompt(params);
    f.rows().find(a => a.pane_id === 'new-1')!.agent_session.value = 'different-session';
    return result;
  };
  expect((await f.lifecycle.start(f.request)).status).toBe('blocked');
  expect(f.events).not.toContain('close:old');
  expect(f.events.some(e => e.endsWith(':kickoff'))).toBe(false);
  expect(f.lifecycle.current?.paneId).toBe('old');
});


test('ACK-looking historical data remains exact even across chunk boundaries', async () => {
  const marker = 'DROVR_HANDOFF_READY';
  const fakeToken = marker + '_00000000-0000-0000-0000-000000000000';
  const fakeInstruction = `\nBegin your response with ${marker} on its own line, followed by the working summary.\n`;
  const source = 'x'.repeat(47990) + marker + ' ' + fakeToken + fakeInstruction
    + JSON.stringify({ quoted: marker, instruction: fakeInstruction })
    + 'y'.repeat(48000) + fakeToken;
  const f = fixture({ source, provider: 'claude', oldProvider: 'codex' });
  expect((await f.lifecycle.start(f.request)).status).toBe('success');
  const imports = f.prompts.filter(p => p.includes('Transcript chunk '));
  const decoded = imports.map(p => JSON.parse(p.match(/"(?:[^"\\]|\\.)*"$/s)![0]) as string);
  expect(decoded).toHaveLength(3);
  expect(decoded.join('')).toBe(source);
  expect(decoded[0]).toEndWith(marker.slice(0, 10));
  expect(decoded[1]).toStartWith(marker.slice(10));
  expect(f.events.filter(e => e === 'close:old')).toHaveLength(1);
});

describe("ManagedHerdrLifecycle launch_pending verification (FACTORY-1037)", () => {
  // Incident: herdr can accept a launch (no thrown error) and still leave
  // the pane `launch_pending: true` indefinitely — e.g. the shell was not
  // actually ready for the injected command when herdr wrote it. Before
  // this guard, `resolveCurrent()` finding ANY matching entry was enough
  // to report success, so a stuck, truncated launch was reported as a
  // launched agent. These pin the fix: a launch stuck past the ceiling is
  // "blocked", never "success"; a launch that clears within the ceiling
  // (an ordinary slow start) is unaffected.
  test("a launch still launch_pending past the ceiling is reported blocked, never success", async () => {
    const f = fixture({ launchPending: true, launchPendingTimeoutMs: 5 });
    const result = await f.lifecycle.start(f.request);
    expect(result.status).toBe("blocked");
    expect((result as { reason?: string }).reason).toContain("launch_pending");
    // Already committed and the old pane already closed — a verification
    // failure after that point cannot and must not resurrect "old".
    expect(f.lifecycle.current?.paneId).toBe("new-1");
    expect(f.events).toContain("close:old");
  });

  test("review fix: the stuck pane itself is closed, not left holding truncated input forever", async () => {
    const f = fixture({ launchPending: true, launchPendingTimeoutMs: 5 });
    const result = await f.lifecycle.start(f.request);
    expect(result.status).toBe("blocked");
    // Actually torn down, not merely reported -- a close:new-1 event AND
    // the row genuinely gone from the fake herdr's own pane table, the same
    // proof the "disappearance" test above uses for a pane herdr itself
    // dropped. Here WE must be the one to drop it: nothing else will.
    expect(f.events).toContain("close:new-1");
    expect(f.rows().some((row) => row.pane_id === "new-1")).toBe(false);
  });

  test("a launch_pending pane that clears within the ceiling still reports success", async () => {
    const f = fixture({ launchPending: true, launchPendingClearsAfterPolls: 2, launchPendingTimeoutMs: 500 });
    const result = await f.lifecycle.start(f.request);
    expect(result.status).toBe("success");
    expect(f.lifecycle.current?.paneId).toBe("new-1");
  });

  test("a launch that is never launch_pending is unaffected (no new polling, unchanged timing)", async () => {
    const f = fixture();
    const result = await f.lifecycle.start(f.request);
    expect(result.status).toBe("success");
  });
});
