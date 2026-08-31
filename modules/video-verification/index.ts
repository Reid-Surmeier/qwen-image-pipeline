import { Effect } from "effect"

import type { VideoVerificationError, VideoVerificationFailureEvidence } from "./errors.js"
import { inspectVideoVerificationFailureSync } from "./errors.js"
import { verifyVideoArtifact } from "./video-verification.js"
import type { VerifyVideoInput, VideoVerification } from "./types.js"

export const verifyVideo: (
  input: VerifyVideoInput,
) => Effect.Effect<VideoVerification, VideoVerificationError> = verifyVideoArtifact

export const inspectVideoVerificationFailure = (
  error: unknown,
): Effect.Effect<VideoVerificationFailureEvidence | undefined> => Effect.sync(() => inspectVideoVerificationFailureSync(error))
export type { VideoVerificationError, VideoVerificationErrorCode, VideoVerificationFailureEvidence } from "./errors.js"
export type {
  VerifyVideoInput,
  VideoArtifact,
  VideoCheck,
  VideoCostEvidence,
  VideoExpectation,
  VideoVerification,
} from "./types.js"
