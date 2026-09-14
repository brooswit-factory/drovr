import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readNativeTranscript } from "../src/native-transcript.js";

const id = "01a097e9-8423-76f2-9e3d-b3c7918b9380";
const cwd = "/factory/work dir/project_name";
let home: string;
const header = (sessionId = id, directory = cwd) => JSON.stringify({
  type: "session_meta", payload: { id: sessionId, cwd: directory },
}) + "\n";
async function put(relative: string, text: string | Buffer): Promise<string> {
  const path = join(home, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}
const byId = (provider: "claude" | "codex") => readNativeTranscript({ provider, session: { kind: "id", value: id }, cwd, home });
const byPath = (value: string) => readNativeTranscript({ provider: "claude", session: { kind: "path", value }, cwd, home });
const rollout = (day = "13") => `.codex/sessions/2026/09/${day}/rollout-2026-09-${day}T12-00-00-${id}.jsonl`;

describe("native transcript disk reader", () => {
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "drovr-native-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  test("explicit path wins over layout discovery and preserves all UTF-8 text", async () => {
    const text = '{"message":"hello 🌍"}\n\n';
    const path = await put("export.jsonl", text);
    expect(await byPath(path)).toBe(text);
    expect(await readNativeTranscript({ provider: "codex", session: { kind: "path", value: path }, cwd, home })).toBe(text);
  });

  test("Claude ID uses the exact encoded project and session filename", async () => {
    const text = '{"type":"mode"}\n{"message":"complete history"}\n';
    await put(`.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/${id}.jsonl`, text);
    await put(`.claude/projects/other/${id}.jsonl`, "wrong project");
    expect(await byId("claude")).toBe(text);
  });

  test("Codex requires exact filename ID and matching header ID/cwd", async () => {
    await put(rollout("11"), header("wrong"));
    await put(rollout("12"), header(id, "/other"));
    await put(rollout().replace(`${id}.jsonl`, `prefix${id}.jsonl`), header());
    await expect(byId("codex")).rejects.toThrow("unavailable");
    const text = header() + '{"type":"response_item","payload":{"text":"all history"}}\n';
    await put(rollout(), text);
    expect(await byId("codex")).toBe(text);
  });

  test("Codex rejects conflicting headers and duplicate exact matches", async () => {
    await put(rollout(), JSON.stringify({ type: "session_meta", payload: { id, session_id: "other", cwd } }) + "\n");
    await expect(byId("codex")).rejects.toThrow("unavailable");
    await put(rollout(), header());
    await put(rollout("12"), header());
    await expect(byId("codex")).rejects.toThrow("multiple Codex transcripts");
  });

  test("accepts exactly 4 MiB and rejects larger files without truncating", async () => {
    const text = "x".repeat(4 * 1024 * 1024);
    const path = await put("limit.jsonl", text);
    expect(await byPath(path)).toBe(text);
    await writeFile(path, text + "x");
    await expect(byPath(path)).rejects.toThrow("exceeds 4 MiB");
  });

  test("rejects final and parent symlinks, directories, empty and invalid UTF-8 files", async () => {
    const path = await put("real/transcript.jsonl", "history");
    await symlink(path, join(home, "link.jsonl"));
    await symlink(join(home, "real"), join(home, "linked-dir"));
    await expect(byPath(join(home, "link.jsonl"))).rejects.toThrow("unsafe");
    await expect(byPath(join(home, "linked-dir/transcript.jsonl"))).rejects.toThrow("unsafe");
    await expect(byPath(join(home, "real"))).rejects.toThrow("regular file");
    await expect(byPath(await put("empty", ""))).rejects.toThrow("empty");
    await expect(byPath(await put("invalid", Buffer.from([0xff])))).rejects.toThrow("UTF-8");
  });

  test("Codex bounds depth and candidates even after finding a match", async () => {
    await put(rollout(), header());
    await mkdir(join(home, ".codex/sessions/a/b/c/d/e"), { recursive: true });
    await expect(byId("codex")).rejects.toThrow("depth limit");
    await rm(join(home, ".codex/sessions/a"), { recursive: true });
    for (let i = 0; i < 17; i++) await put(`.codex/sessions/rollout-${i}-${id}.jsonl`, header("wrong"));
    await expect(byId("codex")).rejects.toThrow("candidate limit");
  });

  test("Codex bounds total directory entries", async () => {
    const root = join(home, ".codex/sessions");
    await mkdir(root, { recursive: true });
    for (let batch = 0; batch <= 100; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, `unrelated-${batch}-${i}`), "")));
    }
    await expect(byId("codex")).rejects.toThrow("entry limit");
  }, 15_000);

  test("Codex never follows symlinked search directories or candidate files", async () => {
    const path = await put("outside/transcript.jsonl", header());
    const root = join(home, ".codex/sessions");
    await mkdir(root, { recursive: true });
    await symlink(join(home, "outside"), join(root, "linked"));
    await expect(byId("codex")).rejects.toThrow("unavailable");
    await symlink(path, join(root, `rollout-test-${id}.jsonl`));
    await expect(byId("codex")).rejects.toThrow("unsafe");
  });

  test("rejects unsafe IDs/paths and reports missing files without leaking values", async () => {
    await expect(readNativeTranscript({ provider: "claude", session: { kind: "id", value: "../secret" }, cwd, home })).rejects.toThrow("invalid native session ID");
    await expect(byPath("relative.jsonl")).rejects.toThrow("absolute path");
    await expect(byPath(`${home}/../secret`)).rejects.toThrow("parent traversal");
    try { await byPath(join(home, "sensitive-name")); } catch (error) {
      expect(String(error)).not.toContain("sensitive-name");
      expect(String(error)).toContain("unavailable");
    }
  });

  test("AGY reads the complete ordered native transcript, never the truncated display transcript", async () => {
    const text = [0, 1].map(step_index => JSON.stringify({step_index,type:step_index ? "PLANNER_RESPONSE":"USER_INPUT",source:step_index ? "MODEL":"USER_EXPLICIT",content:step_index ? "remembered":"remember this"})).join("\n") + "\n";
    const path = await put(`.gemini/antigravity-cli/brain/${id}/.system_generated/logs/transcript_full.jsonl`, text);
    expect(await readNativeTranscript({provider:"agy",session:{kind:"id",value:id},cwd,home})).toBe(text);
    expect(await readNativeTranscript({provider:"agy",session:{kind:"path",value:path},cwd,home})).toBe(text);
    for (const invalid of [text.trimEnd(), text.split("\n")[1]+"\n", JSON.stringify({step_index:0,type:"USER_INPUT",source:"USER_EXPLICIT",content:"partial",truncated_fields:["content"]})+"\n"]) {
      await writeFile(path, invalid);
      await expect(readNativeTranscript({provider:"agy",session:{kind:"id",value:id},cwd,home})).rejects.toThrow();
    }
  });
});
