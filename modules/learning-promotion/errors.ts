export type LearningPromotionErrorCode =
  | "MISSING_SUPPORTING_EVIDENCE"
  | "MISSING_KNOWN_BAD_COUNTEREXAMPLE"
  | "SELF_MODIFICATION_FORBIDDEN"
  | "INVALID_PROPOSAL_SEAM"
  | "APPLICATION_DETAIL_UNSANITIZED"

export class LearningPromotionError extends Error {
  readonly _tag = "LearningPromotionError"

  constructor(
    readonly code: LearningPromotionErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}
