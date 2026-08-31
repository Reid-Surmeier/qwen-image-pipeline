export type VideoVerificationErrorCode =
  | "VIDEO_EVIDENCE_INVALID"
  | "VIDEO_MEDIA_INVALID"
  | "VIDEO_CHECK_FAILED"
  | "OUTPUT_COUNT_MISMATCH"

export class VideoVerificationError extends Error {
  readonly code: VideoVerificationErrorCode

  constructor(code: VideoVerificationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "VideoVerificationError"
    this.code = code
  }
}
