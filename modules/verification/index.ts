import type { Effect } from "effect"

import { verifyRaster } from "./verification.js"
import type { VerificationError } from "./errors.js"
import type { VerificationInput, VerificationResult } from "./types.js"

export const verify: (input: VerificationInput) => Effect.Effect<VerificationResult, VerificationError> = verifyRaster

export { VerificationError } from "./errors.js"
export type { VerificationErrorCode } from "./errors.js"
export type { VerificationInput, VerificationResult } from "./types.js"
