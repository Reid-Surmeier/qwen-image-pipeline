import type { Effect } from "effect"

import type { VideoVerificationError } from "./errors.js"
import { inspectVideoVerificationFailure } from "./errors.js"
import { verifyVideoArtifact } from "./video-verification.js"
import type { VerifyVideoInput, VideoVerification } from "./types.js"

export const verifyVideo: (
  input: VerifyVideoInput,
) => Effect.Effect<VideoVerification, VideoVerificationError> = verifyVideoArtifact

export { inspectVideoVerificationFailure }
export type { VideoVerificationError, VideoVerificationErrorCode, VideoVerificationFailureEvidence } from "./errors.js"
export type {
  VerifyVideoInput,
  VideoArtifact,
  VideoCheck,
  VideoCostEvidence,
  VideoExpectation,
  VideoVerification,
} from "./types.js"
