export type GenerationErrorCode =
  | "REFERENCE_BYTES_MISMATCH"
  | "PAYLOAD_DESTINATION_INVALID"
  | "ADAPTER_RESULT_INVALID"
  | "PROVIDER_SUBSTITUTION"
  | "OUTPUT_COUNT_MISMATCH"

export class GenerationError extends Error {
  readonly code: GenerationErrorCode

  constructor(code: GenerationErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "GenerationError"
    this.code = code
  }
}
