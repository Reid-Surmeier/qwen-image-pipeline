export type RunRecordErrorCode =
  | "INVALID_PLANNED_RUN"
  | "REQUEST_HASH_MISMATCH"
  | "RESERVATION_OUTSIDE_PLAN"
  | "RUN_ID_CONFLICT"
  | "RUN_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "DUPLICATE_SUBMISSION_BLOCKED"
  | "SUBMISSION_BINDING_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "EVENT_CHAIN_BROKEN"
  | "REQUEST_TAMPERED"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_REWRITE"
  | "DONOR_NOT_PERSISTED"
  | "CHECKS_NOT_PASSED"
  | "DERIVED_VIEW_CONTRADICTION"
  | "LINK_NOT_ALLOWED"
  | "LINK_FAILURE_MISMATCH"
  | "DURABILITY_FAILURE"
  | "SECRET_MATERIAL_DETECTED"

export class RunRecordError extends Error {
  readonly code: RunRecordErrorCode
  readonly recovery: "reload" | "reconcile" | "new-linked-run" | "repair-evidence"

  constructor(
    code: RunRecordErrorCode,
    message: string,
    recovery: RunRecordError["recovery"] = "reload",
  ) {
    super(`${code}: ${message}`)
    this.name = "RunRecordError"
    this.code = code
    this.recovery = recovery
  }
}
