export type VerificationErrorCode =
  | "INTEGRITY_CHECK_FAILED"
  | "MEDIA_CHECK_FAILED"
  | "ASSEMBLY_REQUIRED"
  | "FIDELITY_CHECK_FAILED"

export type VerificationFailureEvidence = Readonly<{
  module: "Verification"
  errorCode: VerificationErrorCode
  completedChecks: ReadonlyArray<string>
  baselineSha256: string
  donorSha256: string
  candidateSha256: string
  regionSha256: string
  exactCopySha256: string
}>

const issuedFailures = new WeakMap<VerificationError, VerificationFailureEvidence>()

export class VerificationError extends Error {
  readonly code: VerificationErrorCode
  readonly checks: ReadonlyArray<string>

  constructor(code: VerificationErrorCode, message: string, checks: ReadonlyArray<string>) {
    super(`${code}: ${message}`)
    this.name = "VerificationError"
    this.code = code
    this.checks = checks
  }
}

export const issueVerificationFailure = (
  error: VerificationError,
  evidence: Omit<VerificationFailureEvidence, "module" | "errorCode" | "completedChecks">,
): VerificationError => {
  issuedFailures.set(error, Object.freeze({
    module: "Verification",
    errorCode: error.code,
    completedChecks: Object.freeze([...error.checks]),
    ...evidence,
  }))
  return error
}

export const inspectVerificationFailure = (error: unknown): VerificationFailureEvidence | undefined =>
  error instanceof VerificationError ? issuedFailures.get(error) : undefined
