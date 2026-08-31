# Video Verification

- Purpose: Independently inspect completed Seedance bytes and prove their hash, media shape, duration, audio expectation, counts, and cost state before classification.
- Interface: `modules/video-verification/index.ts`
- Errors: `modules/video-verification/errors.ts`
- Acceptance: `modules/video-verification/video-verification.test.ts`

Video Verification consumes persisted output bytes rather than provider claims. It independently parses the MP4 hierarchy, recognized video and audio sample descriptions, timing/chunk/sample tables, chunk offsets, and non-empty media data before measuring dimensions, duration, and audio presence against the immutable Video Plan. Marker-shaped bytes, malformed tables, incomplete output sets, duplicate paths, changed hashes, and runtime-invalid cost states fail as typed evidence errors. This parser is deliberately separate from Reference Planning's intake inspection so a planning assertion cannot grade the generated output. A result is classified only when every deterministic check passes. It does not submit or poll a provider, write the Run Record, perform Assembly, or grant subjective visual approval.
