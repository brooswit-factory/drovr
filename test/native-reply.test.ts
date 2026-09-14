import { test, expect } from "bun:test";
import { nativeTranscriptReply } from "../src/native-transcript";
test("ACKs must come from a model reply, never an echoed user instruction", () => {
  expect(nativeTranscriptReply("agy", JSON.stringify({type:"USER_INPUT",source:"USER_EXPLICIT",status:"DONE",content:"DROVR_HANDOFF_READY"}))).toBeUndefined();
  expect(nativeTranscriptReply("claude", JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text:"DROVR_HANDOFF_READY"}]}}))).toBeUndefined();
  expect(nativeTranscriptReply("codex", JSON.stringify({type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"DROVR_HANDOFF_READY"}]}}))).toBeUndefined();
});
test("extracts last assistant text without reasoning or tool output", () => {
  expect(nativeTranscriptReply("agy", JSON.stringify({type:"PLANNER_RESPONSE",source:"MODEL",status:"DONE",content:"summary",thinking:"not output"}))).toBe("summary");
  expect(nativeTranscriptReply("claude", JSON.stringify({type:"assistant",message:{role:"assistant",content:[{type:"thinking",thinking:"private"},{type:"text",text:"summary"}]}}))).toBe("summary");
  expect(nativeTranscriptReply("codex", JSON.stringify({type:"response_item",payload:{type:"message",role:"assistant",content:[{type:"output_text",text:"summary"}]}}))).toBe("summary");
});
