export type AssemblyErrorCode =
  | "BASELINE_MISSING"
  | "DONOR_MISSING"
  | "REGION_OUT_OF_BOUNDS"
  | "ASSEMBLY_FAILED"
  | "FIDELITY_OUTSIDE_REGION_DRIFT"
  | "EXACT_COPY_MISMATCH"

export class AssemblyError extends Error {
  readonly _tag = "AssemblyError"

  constructor(
    readonly code: AssemblyErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}
