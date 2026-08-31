export type VerificationErrorCode =
  | "INTEGRITY_CHECK_FAILED"
  | "MEDIA_CHECK_FAILED"
  | "ASSEMBLY_REQUIRED"
  | "FIDELITY_CHECK_FAILED"

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
