// Read-only: classify listed Claude sessions from their listing and transcript.
import { claudeResidentActivity, listClaudeBackgroundSessions } from "../src/resident-agent.js";
import { readClaudeTranscriptTail } from "../src/native-transcript.js";

const ids = process.argv.slice(2);
for (const live of await listClaudeBackgroundSessions()) {
  if (ids.length && !ids.some((id) => live.sessionId.startsWith(id))) continue;
  let text = "", offset = 0;
  for (;;) {
    const tail = await readClaudeTranscriptTail({ sessionId: live.sessionId, cwd: live.cwd }, offset).catch(() => ({ offset, text: "" }));
    if (tail.offset === offset) break;
    text += tail.text;
    offset = tail.offset;
  }
  console.log(live.sessionId.slice(0, 8), live.status, "->", claudeResidentActivity(live.status, text));
}
