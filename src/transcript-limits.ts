/** Limits count complete input, never a tail or a truncated prefix. */
export const DEFAULT_TRANSCRIPT_LIMIT = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_LIMIT = 64 * 1024 * 1024;
export interface TranscriptLimits {
  /** Whole native-file UTF-8 bytes. Default4MiB; maximum64MiB. */
  maxBytes?: number;
  /** Conversation JavaScript UTF-16 code units. Default4Mi; maximum64Mi. */
  maxChars?: number;
}
export function transcriptLimit(value: number | undefined, name: string): number {
  const limit = value === undefined ? DEFAULT_TRANSCRIPT_LIMIT : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TRANSCRIPT_LIMIT) throw new Error(`${name} must be an integer from 1 to ${MAX_TRANSCRIPT_LIMIT}`);
  return limit;
}
export function assertTranscriptCharacters(text: unknown, limit: number): asserts text is string {
  if (typeof text !== 'string' || text.length > limit) throw new Error('Transcript exceeds the handoff limit; refusing to silently truncate history');
}
