export type GenerationErrorCode =
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_HTTP_ERROR"
  | "PROVIDER_TIMEOUT"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "OUTPUT_COUNT_MISMATCH"
  | "PROVIDER_CAPABILITY_UNSUPPORTED"
  | "REFERENCE_PAYLOAD_MISMATCH"
  | "PROVIDER_SUBSTITUTION_FORBIDDEN"
  | "CREDENTIAL_MISSING"

export class GenerationError extends Error {
  readonly _tag = "GenerationError"

  constructor(
    readonly code: GenerationErrorCode,
    message: string,
    readonly status?: number,
    readonly safeDetails?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`)
  }
}
