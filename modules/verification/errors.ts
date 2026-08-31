export type VerificationErrorCode =
  | "INTEGRITY_CHECK_FAILED"
  | "MEDIA_COUNT_CHECK_FAILED"
  | "ASSEMBLY_FIDELITY_FAILED"
  | "DETERMINISTIC_GATE_FAILED"
  | "SEMANTIC_REVIEW_FAILED"
  | "UNKNOWN_VERIFICATION_FAILURE"

export class VerificationError extends Error {
  readonly _tag = "VerificationError"

  constructor(
    readonly code: VerificationErrorCode,
    message: string,
    readonly stage: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code} at stage ${stage}: ${message}`)
  }
}
