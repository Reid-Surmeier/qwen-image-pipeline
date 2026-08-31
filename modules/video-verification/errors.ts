export type VideoVerificationErrorCode =
  | "VIDEO_EVIDENCE_INVALID"
  | "VIDEO_MEDIA_INVALID"
  | "VIDEO_CHECK_FAILED"
  | "OUTPUT_COUNT_MISMATCH"

export type VideoVerificationFailureEvidence = Readonly<{
  module: "Video Verification"
  errorCode: VideoVerificationErrorCode
  outputSha256s: ReadonlyArray<string>
  requestedCount: number
  completedCount: number
}>

const issuedFailures = new WeakMap<VideoVerificationError, VideoVerificationFailureEvidence>()

export class VideoVerificationError extends Error {
  readonly code: VideoVerificationErrorCode

  constructor(code: VideoVerificationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "VideoVerificationError"
    this.code = code
  }
}

export const issueVideoVerificationFailure = (
  error: VideoVerificationError,
  evidence: Omit<VideoVerificationFailureEvidence, "module" | "errorCode">,
): VideoVerificationError => {
  issuedFailures.set(error, Object.freeze({
    module: "Video Verification",
    errorCode: error.code,
    outputSha256s: Object.freeze([...evidence.outputSha256s]),
    requestedCount: evidence.requestedCount,
    completedCount: evidence.completedCount,
  }))
  return error
}

export const inspectVideoVerificationFailure = (error: unknown): VideoVerificationFailureEvidence | undefined =>
  error instanceof VideoVerificationError ? issuedFailures.get(error) : undefined
