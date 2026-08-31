import { Effect } from "effect"

import { verifyRaster } from "./verification.js"
import type { VerificationError, VerificationFailureEvidence } from "./errors.js"
import { inspectVerificationFailureSync } from "./errors.js"
import type { VerificationInput, VerificationResult } from "./types.js"

export const verify: (input: VerificationInput) => Effect.Effect<VerificationResult, VerificationError> = verifyRaster

export const inspectVerificationFailure = (
  error: unknown,
): Effect.Effect<VerificationFailureEvidence | undefined> => Effect.sync(() => inspectVerificationFailureSync(error))
export { VerificationError } from "./errors.js"
export type { VerificationErrorCode, VerificationFailureEvidence } from "./errors.js"
export type { VerificationInput, VerificationResult } from "./types.js"
