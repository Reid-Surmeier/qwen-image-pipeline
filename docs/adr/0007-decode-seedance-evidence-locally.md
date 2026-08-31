# ADR 0007: Decode Seedance evidence locally

- Status: Accepted
- Date: 2026-08-30
- Governing specification: GitHub Issue #23

## Context

A structurally consistent MP4 can still declare media samples that no decoder can read. A crafted 237-byte file passed the first hierarchy and sample-table checks even though both FFmpeg and FFprobe rejected it. Treating container markers as playable evidence would let Reference Planning admit a false video or let Video Verification and Run Record classify an unusable output.

## Decision

Keep the three structural inspectors independent, parse every dense sample description and every chunk-map selection, reject unknown sampled tracks and containers with more than one video track, require every video or audio sample-entry codec to agree with its track's declared handler kind, reconcile timing sample counts with sample-size counts, and require each inspector to decode the exact MP4 bytes through FFmpeg 6 at `/usr/bin/ffmpeg` before accepting them. FFmpeg's framehash stream is the independent source for decoded dimensions, duration, and audio presence. Container metadata must agree with that decoded truth; metadata is never accepted merely because it is internally well formed.

The decoder receives bytes only through standard input. Its fixed argument vector disables standard input interaction, allows only the `pipe` protocol, maps the required video stream and any declared audio stream, turns decode errors into failure, uses one thread, emits bounded framehash evidence to standard output, and has bounded time and buffers. No shell is involved and the child environment contains only `LANG`, `LC_ALL`, and `PATH`. Absence, timeout, malformed framehash evidence, metadata disagreement, or any decoder error fails closed through the owning module's typed error.

The deterministic baseline pins the supported FFmpeg major and permits only this exact decoder invocation. A changed executable, arguments, or environment remains blocked, and the inherited native seccomp filter continues to deny network syscalls in the decoder process.

## Consequences

- Reference intake, output verification, and replay all reject box-consistent but undecodable video.
- A malformed declared audio track is an error rather than evidence that audio is absent.
- An audio codec relabeled under a non-audio handler is an error rather than evidence that audio is absent.
- A later or unknown sample description is not allowed to hide audio from the declared handler.
- Multiple video tracks are refused rather than reduced to an arbitrary first or last track.
- Falsified container dimensions or duration cannot substitute for decoded media properties.
- The baseline now requires FFmpeg 6 at the fixed system path; another host must satisfy that prerequisite before the procedure can verify Seedance evidence.
- The three modules retain separate container parsers so one planning assertion cannot grade its own output, while all use the same host decoder requirement.
