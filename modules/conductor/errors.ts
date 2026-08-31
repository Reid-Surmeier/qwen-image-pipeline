export type PlanningRefusalCode =
  | "PROJECT_CONTRACT_MISSING"
  | "TOOL_LOCK_MISSING"
  | "OBJECTIVE_MISSING"
  | "APPLICATION_READ_FAILED"
  | "DOCUMENT_INVALID"
  | "TOOL_LOCK_MISMATCH"
  | "SECRET_MATERIAL_DETECTED"
  | "UNSAFE_APPLICATION_PATH"
  | "PROCEDURE_NOT_LOCKED"
  | "COUNT_OUT_OF_RANGE"
  | "BUDGET_UNPROVABLE"
  | "BUDGET_EXCEEDED"
  | "REFERENCE_MISSING"
  | "REFERENCE_HASH_MISMATCH"
  | "REFERENCE_KIND_MISMATCH"
  | "REFERENCE_AUTHORITY_MISSING"
  | "REFERENCE_PATH_UNSAFE"
  | "PAYLOAD_DESTINATION_INVALID"
  | "MEDIA_INSPECTION_FAILED"
  | "DECLARED_MEDIA_MISMATCH"
  | "SEEDANCE_VIDEO_REFERENCE_REQUIRED"

export type PlanningRefusal = Readonly<{
  code: PlanningRefusalCode
  message: string
}>

export type ConductorErrorCode =
  | "ADVANCE_REQUIRES_QWEN_ASSEMBLY"
  | "REFERENCE_EVIDENCE_UNAVAILABLE"
  | "RUN_RECORD_FAILURE"
  | "GENERATION_FAILURE"
  | "DONOR_DECISION_INVALID"
  | "ASSEMBLY_FAILURE"
  | "VERIFICATION_FAILURE"
  | "RUN_STATE_UNSUPPORTED"

export class ConductorError extends Error {
  readonly code: ConductorErrorCode
  readonly causeCode: string | undefined

  constructor(code: ConductorErrorCode, message: string, causeCode?: string) {
    super(message)
    this.name = "ConductorError"
    this.code = code
    this.causeCode = causeCode
  }
}
