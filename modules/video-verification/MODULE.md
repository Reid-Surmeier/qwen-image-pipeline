# Video Verification

- Purpose: Independently inspect completed Seedance bytes and prove their hash, media shape, duration, audio expectation, counts, and cost state before classification.
- Interface: `modules/video-verification/index.ts`
- Errors: `modules/video-verification/errors.ts`
- Acceptance: `modules/video-verification/video-verification.test.ts`

Video Verification consumes persisted output bytes rather than provider claims. It independently parses the MP4 hierarchy, every dense `stsd` sample description and `stsc` selection, recognized video and audio codecs whose kind agrees with each track's declared handler, mutually consistent timing/chunk/sample tables, chunk offsets, and non-empty media data before measuring dimensions, duration, and audio presence against the immutable Video Plan. It then requires a complete FFmpeg 6 decode of those exact bytes from standard input. Marker-shaped bytes, malformed or undecodable streams, unknown sampled tracks, later-description audio, audio codecs relabeled under a non-audio handler, incomplete output sets, duplicate paths, changed hashes, and runtime-invalid cost states fail as typed evidence errors; a bad or hidden audio track is never silently reclassified as no audio. This parser is deliberately separate from Reference Planning's intake inspection so a planning assertion cannot grade the generated output. A result is classified only when every deterministic check passes. It does not submit or poll a provider, write the Run Record, perform Assembly, or grant subjective visual approval.
