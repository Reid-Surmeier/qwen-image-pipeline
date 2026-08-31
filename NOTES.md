# Working notes

Reid is building one reusable generation tool that can add explicitly reviewed
OpenRouter image models without creating new direct-provider paths. The current
model queue is Nano Banana 2, then Grok Imagine Image 2.0, then Krea 2 Medium
Turbo. Only one model may be active; the next stays blocked until the previous
model is implemented, deterministically verified, paid-qualified, reviewed,
and released.

The owner wants model changes to feel easy at the application surface: select a
reviewed Procedure and Model Profile before planning. “Easy switching” never
means mutating an existing Run, typing an arbitrary model ID, automatic
fallback, or retrying uncertain paid work.

OpenRouter is the only paid route. The first Nano profile uses
`google/gemini-3.1-flash-image` through exact endpoint
`google-vertex/global`, with fallback disabled. Qwen remains the default until
a later comparison decision. Provider credentials are accessed only at the
single submission seam and never enter workflow files, issues, logs, or
artifacts.

The reusable repository owns contracts, adapters, neutral fixtures, and
verification. Application repositories own references, paid outputs, Run
Records, Assembly results, and Approval. Machine verification and owner visual
approval are separate.

The final owner checkpoint is a brief, not raw output. It shows exact release
identity, the paid images beside their references, verification findings,
requested and completed counts, cost and elapsed time, unresolved risk, and
whether the next queued model is unblocked.
