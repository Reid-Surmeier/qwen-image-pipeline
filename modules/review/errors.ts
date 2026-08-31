export type ReviewPacketErrorCode =
  | "ReviewPacketInvalid"
  | "CandidateIdentityChanged"
  | "ReferenceIdentityChanged"
  | "ReviewBlocked"

export class ReviewPacketError extends Error {
  readonly _tag = "ReviewPacketError"

  constructor(readonly code: ReviewPacketErrorCode, message: string) {
    super(`${code}: ${message}`)
  }
}
