export type AssemblyErrorCode =
  | "ASSEMBLY_INPUT_HASH_MISMATCH"
  | "RASTER_INVALID"
  | "OWNED_REGION_INVALID"
  | "EXACT_COPY_HASH_MISMATCH"

export type AssemblyFailureEvidence = Readonly<{
  module: "Assembly"
  errorCode: AssemblyErrorCode
  baselineSha256: string
  donorSha256: string
  regionSha256: string
  exactCopySha256: string
}>

const issuedFailures = new WeakMap<AssemblyError, AssemblyFailureEvidence>()

export class AssemblyError extends Error {
  readonly code: AssemblyErrorCode

  constructor(code: AssemblyErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "AssemblyError"
    this.code = code
  }
}

export const issueAssemblyFailure = (
  error: AssemblyError,
  evidence: Omit<AssemblyFailureEvidence, "module" | "errorCode">,
): AssemblyError => {
  issuedFailures.set(error, Object.freeze({ module: "Assembly", errorCode: error.code, ...evidence }))
  return error
}

export const inspectAssemblyFailure = (error: unknown): AssemblyFailureEvidence | undefined =>
  error instanceof AssemblyError ? issuedFailures.get(error) : undefined
