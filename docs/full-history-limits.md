# Complete-history limits

`NativeTranscriptOptions.maxBytes` bounds the complete UTF-8 native file. `ConversationSessionOptions.maxTranscriptChars` bounds the complete JavaScript UTF-16 string. Each defaults to4×1024×1024 and accepts an integer from1 through64×1024×1024. Increasing one never bypasses the other. Nothing is truncated.

`ManagedHerdrLifecycleOptions.transcriptLimits` accepts `{maxBytes,maxChars}` and snapshots the limits at construction. It forwards the byte limit to the native reader, enforces that limit even for injected readers, and validates both full source limits before preparation or workspace creation. It passes the character budget to the existing conversation transaction. Existing callers keep their defaults.

The existing filesystem identity/consistency checks, ordered48,000-character chunks, every-chunk acknowledgement, stable source reread and exactly-once identity commit remain unchanged. Buffers allocate at most the observed file size plus one byte, bounded by the configured limit plus one; string copies, chunks and rereads add bounded multiples of the input limit.64MiB is a safety ceiling, not a suggested global setting. A large import also needs enough time for every chunk acknowledgement.

The recovery caller must enable larger limits only for its explicitly named canary. It must preserve the old consumed permit, use a reviewed new-budget transition, and obtain approval before another live attempt. These source/test changes do not authorize native-history inspection, deployment or migration.
