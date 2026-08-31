export type ReferencePlanningErrorCode =
  | "REFERENCE_MISSING"
  | "REFERENCE_HASH_MISMATCH"
  | "REFERENCE_KIND_MISMATCH"
  | "REFERENCE_AUTHORITY_MISSING"
  | "REFERENCE_PATH_UNSAFE"
  | "PAYLOAD_DESTINATION_INVALID"
  | "MEDIA_INSPECTION_FAILED"
  | "DECLARED_MEDIA_MISMATCH"
  | "SEEDANCE_VIDEO_REFERENCE_REQUIRED"

export class ReferencePlanningError extends Error {
  readonly _tag = "ReferencePlanningError"

  constructor(
    readonly code: ReferencePlanningErrorCode,
    message: string,
    readonly applicationPath?: string,
  ) {
    super(`${code}: ${message}`)
  }
}

export class ApplicationReadError extends Error {
  readonly _tag = "ApplicationReadError"

  constructor(
    readonly code: "APPLICATION_PATH_MISSING" | "APPLICATION_PATH_UNSAFE" | "APPLICATION_READ_FAILED",
    readonly applicationPath: string,
  ) {
    super(`${code}: ${applicationPath}`)
  }
}

export class MediaInspectionError extends Error {
  readonly _tag = "MediaInspectionError"

  constructor(readonly code: "UNSUPPORTED_MEDIA" | "MALFORMED_MEDIA") {
    super(code)
  }
}
