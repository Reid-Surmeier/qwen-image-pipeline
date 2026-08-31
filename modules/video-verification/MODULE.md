# Video Verification

- Purpose: Independently inspect completed Seedance bytes and prove their hash, media shape, duration, audio expectation, counts, and cost state before classification.
- Interface: `modules/video-verification/index.ts`
- Errors: `modules/video-verification/errors.ts`
- Acceptance: `modules/video-verification/video-verification.test.ts`

Video Verification consumes persisted output bytes rather than provider claims. It recognizes the MP4 container and independently measures dimensions, duration, and audio presence, then compares those values with the immutable Video Plan. A result is classified only when every deterministic check passes. It does not submit or poll a provider, write the Run Record, perform Assembly, or grant subjective visual approval.
