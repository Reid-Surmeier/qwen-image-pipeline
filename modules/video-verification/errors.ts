export type VideoVerificationErrorCode =
  | "VIDEO_EVIDENCE_INVALID"
  | "VIDEO_MEDIA_INVALID"
  | "VIDEO_CHECK_FAILED"
  | "OUTPUT_COUNT_MISMATCH"

export type VideoVerificationFailureEvidence = Readonly<{
  module: "Video Verification"
  errorCode: VideoVerificationErrorCode
  outputs: ReadonlyArray<Readonly<{
    applicationPath: string
    mediaType: string
    sha256: string
  }>>
  requestedCount: number
  completedCount: number
  expected: Readonly<{
    width: number
    height: number
    durationSeconds: number
    audioExpected: boolean
  }>
  cost: Readonly<{
    state: string
    estimatedMaximumCostUsd: string
    actualCostUsd?: string
  }>
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
    outputs: Object.freeze(evidence.outputs.map((output) => Object.freeze({ ...output }))),
    requestedCount: evidence.requestedCount,
    completedCount: evidence.completedCount,
    expected: Object.freeze({ ...evidence.expected }),
    cost: Object.freeze({ ...evidence.cost }),
  }))
  return error
}

export const inspectVideoVerificationFailureSync = (error: unknown): VideoVerificationFailureEvidence | undefined =>
  error instanceof VideoVerificationError ? issuedFailures.get(error) : undefined
