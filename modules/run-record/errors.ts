export type RunRecordErrorCode =
  | "ATTEMPT_ALREADY_RESERVED"
  | "DUPLICATE_SUBMISSION_FORBIDDEN"
  | "SUBMISSION_IN_FLIGHT"
  | "BROKEN_EVENT_CHAIN"
  | "TAMPERED_RUN_RECORD"
  | "ILLEGAL_REWRITE"
  | "RUN_RECORD_READ_FAILED"
  | "RUN_RECORD_WRITE_FAILED"
  | "PRE_SUBMIT_FAILURE_LINK_REQUIRED"

export class RunRecordError extends Error {
  readonly _tag = "RunRecordError"

  constructor(
    readonly code: RunRecordErrorCode,
    message: string,
    readonly runId?: string,
  ) {
    super(`${code}: ${message}`)
  }
}
