export type LearningPromotionErrorCode =
  | "LEARNING_EVIDENCE_INCOMPLETE"
  | "LEARNING_PROVENANCE_MISSING"
  | "LEARNING_KNOWN_BAD_NOT_CAUGHT"
  | "LEARNING_PROPOSAL_INVALID"

export class LearningPromotionError extends Error {
  readonly _tag = "LearningPromotionError"

  constructor(readonly code: LearningPromotionErrorCode, message: string) {
    super(`${code}: ${message}`)
  }
}
