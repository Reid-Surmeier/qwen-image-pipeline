export type RunContractErrorCode =
  | "DOCUMENT_INVALID"
  | "TOOL_LOCK_MISMATCH"
  | "SECRET_MATERIAL_DETECTED"
  | "UNSAFE_APPLICATION_PATH"
  | "PROCEDURE_NOT_LOCKED"
  | "COUNT_OUT_OF_RANGE"
  | "BUDGET_UNPROVABLE"
  | "BUDGET_EXCEEDED"
  | "SEEDANCE_VIDEO_REFERENCE_REQUIRED"

export class RunContractError extends Error {
  readonly _tag = "RunContractError"

  constructor(
    readonly code: RunContractErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}
