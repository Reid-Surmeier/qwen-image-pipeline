import type { Effect } from "effect"

import { verifyRaster } from "./verification.js"
import type { VerificationError } from "./errors.js"
import { inspectVerificationFailure } from "./errors.js"
import type { VerificationInput, VerificationResult } from "./types.js"

export const verify: (input: VerificationInput) => Effect.Effect<VerificationResult, VerificationError> = verifyRaster

export { inspectVerificationFailure }
export type { VerificationError, VerificationErrorCode, VerificationFailureEvidence } from "./errors.js"
export type { VerificationInput, VerificationResult } from "./types.js"
