export type AssemblyErrorCode =
  | "ASSEMBLY_INPUT_HASH_MISMATCH"
  | "RASTER_INVALID"
  | "OWNED_REGION_INVALID"
  | "EXACT_COPY_HASH_MISMATCH"

export class AssemblyError extends Error {
  readonly code: AssemblyErrorCode

  constructor(code: AssemblyErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "AssemblyError"
    this.code = code
  }
}
