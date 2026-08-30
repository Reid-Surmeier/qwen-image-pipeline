import { createHash } from "node:crypto"

import { Effect } from "effect"

import {
  PlanningIdentity,
  type CanonicalRunRequest,
  type LinkedRunRelationship,
  type PlannedRun,
  type PlanningIdentityService,
  type RawPlanningDocuments,
  type ToolIdentity,
} from "./types.js"
import { RunContractError } from "./errors.js"
import {
  planReferences,
  type ApplicationFilesService,
  type MediaInspectorService,
  type MediaKind,
  type MediaProperties,
  type ReferenceCandidate,
  type ReferenceRequirement,
} from "../reference-planning/index.js"

type JsonRecord = Record<string, unknown>

const deepFreeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const record = value as JsonRecord
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`
}

const parseDocument = (raw: string, label: string): JsonRecord => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new RunContractError("DOCUMENT_INVALID", `${label} is not valid JSON.`)
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunContractError("DOCUMENT_INVALID", `${label} must be a JSON object.`)
  }
  return value as JsonRecord
}

const stringField = (record: JsonRecord, field: string): string => {
  const value = record[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new RunContractError("DOCUMENT_INVALID", `${field} must be a non-empty string.`)
  }
  return value
}

const numberField = (record: JsonRecord, field: string): number => {
  const value = record[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RunContractError("DOCUMENT_INVALID", `${field} must be an integer.`)
  }
  return value
}

const recordField = (record: JsonRecord, field: string): JsonRecord => {
  const value = record[field]
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunContractError("DOCUMENT_INVALID", `${field} must be an object.`)
  }
  return value as JsonRecord
}

const recordsField = (record: JsonRecord, field: string): ReadonlyArray<JsonRecord> => {
  const value = record[field]
  if (!Array.isArray(value) || value.some((item) =>
    item === null || typeof item !== "object" || Array.isArray(item))) {
    throw new RunContractError("DOCUMENT_INVALID", `${field} must be an array of objects.`)
  }
  return value as ReadonlyArray<JsonRecord>
}

const stringsField = (record: JsonRecord, field: string): ReadonlyArray<string> => {
  const value = record[field]
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RunContractError("DOCUMENT_INVALID", `${field} must be an array of strings.`)
  }
  return value as ReadonlyArray<string>
}

const moneyCents = (value: string, field: string): number => {
  const match = /^(0|[1-9]\d*)\.(\d{2})$/.exec(value)
  if (match === null) {
    throw new RunContractError("BUDGET_UNPROVABLE", `${field} must be an exact USD decimal with two places.`)
  }
  const whole = Number(match[1])
  const cents = Number(match[2])
  const total = whole * 100 + cents
  if (!Number.isSafeInteger(total)) {
    throw new RunContractError("BUDGET_UNPROVABLE", `${field} is outside the safe accounting range.`)
  }
  return total
}

const formatCents = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`

const secretFieldName = /(?:credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|password|secret|token|authorization)/i

const parsedValueHasSecret = (value: unknown, fieldName?: string): boolean => {
  if (fieldName !== undefined && secretFieldName.test(fieldName)) {
    if (fieldName === "credentialLogicalName" && value === "OPENROUTER_API_KEY") {
      return false
    }
    return true
  }
  if (typeof value === "string") {
    return /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(value) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)
  }
  if (Array.isArray(value)) return value.some((item) => parsedValueHasSecret(item))
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => parsedValueHasSecret(child, key))
  }
  return false
}

const hasSecretMaterial = (raw: string): boolean => {
  const withoutLogicalCredential = raw.replaceAll("OPENROUTER_API_KEY", "")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  return parsedValueHasSecret(parsed) ||
    /"(?:credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token|authorization|password|secret)"\s*:/i.test(withoutLogicalCredential) ||
    /(?:sk-|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(withoutLogicalCredential) ||
    /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(withoutLogicalCredential)
}

const isSafePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !/^[A-Za-z]:/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const decodeToolIdentity = (record: JsonRecord): ToolIdentity => ({
  release: stringField(record, "release"),
  commit: stringField(record, "commit"),
  artifactSha256: stringField(record, "artifactSha256"),
  procedureVersion: stringField(record, "procedureVersion"),
  runSchemaVersion: stringField(record, "runSchemaVersion"),
  adapterProtocolVersion: stringField(record, "adapterProtocolVersion"),
})

const sameTool = (left: ToolIdentity, right: ToolIdentity): boolean =>
  left.release === right.release &&
  left.commit === right.commit &&
  left.artifactSha256 === right.artifactSha256 &&
  left.procedureVersion === right.procedureVersion &&
  left.runSchemaVersion === right.runSchemaVersion &&
  left.adapterProtocolVersion === right.adapterProtocolVersion

const decodeMedia = (record: JsonRecord): MediaProperties => {
  const width = record.width
  const height = record.height
  const duration = record.durationSeconds
  if (typeof width !== "number" || typeof height !== "number") {
    throw new RunContractError("DOCUMENT_INVALID", "declaredMedia dimensions must be numeric.")
  }
  if (duration !== undefined && typeof duration !== "number") {
    throw new RunContractError("DOCUMENT_INVALID", "declaredMedia duration must be numeric.")
  }
  return duration === undefined
    ? { width, height }
    : { width, height, durationSeconds: duration }
}

const decodeRequirements = (procedure: JsonRecord): ReadonlyArray<ReferenceRequirement> =>
  recordsField(procedure, "referenceRequirements").map((requirement) => {
    const kind = stringField(requirement, "kind")
    if (kind !== "image" && kind !== "video") {
      throw new RunContractError("DOCUMENT_INVALID", "reference kind must be image or video.")
    }
    return {
      slot: stringField(requirement, "slot"),
      kind,
      payloadDestination: stringField(requirement, "payloadDestination"),
    }
  })

const decodeCandidates = (objective: JsonRecord): ReadonlyArray<ReferenceCandidate> =>
  recordsField(objective, "references").map((reference) => {
    const kind = stringField(reference, "kind")
    if (kind !== "image" && kind !== "video") {
      throw new RunContractError("DOCUMENT_INVALID", "reference kind must be image or video.")
    }
    const declared = reference.declaredMedia
    return {
      slot: stringField(reference, "slot"),
      path: stringField(reference, "path"),
      sha256: stringField(reference, "sha256"),
      kind: kind as MediaKind,
      authorityReason: stringField(reference, "authorityReason"),
      payloadDestination: stringField(reference, "payloadDestination"),
      ...(declared === undefined
        ? {}
        : { declaredMedia: decodeMedia(recordField(reference, "declaredMedia")) }),
    }
  })

const decodeLinkedRun = (objective: JsonRecord): LinkedRunRelationship | undefined => {
  if (objective.linkedRun === undefined) return undefined
  const linkedRun = recordField(objective, "linkedRun")
  const parentRunId = stringField(linkedRun, "parentRunId")
  const parentFailureEventSha256 = stringField(linkedRun, "parentFailureEventSha256")
  const relation = stringField(linkedRun, "relation")
  if (!/^run-[a-f0-9]{24}$/.test(parentRunId) || !/^[a-f0-9]{64}$/.test(parentFailureEventSha256)) {
    throw new RunContractError("DOCUMENT_INVALID", "linkedRun must name a valid parent Run and failure event SHA-256.")
  }
  if (relation !== "retry-after-definitive-pre-submit-failure") {
    throw new RunContractError("DOCUMENT_INVALID", "linkedRun relation is unsupported.")
  }
  return { parentRunId, parentFailureEventSha256, relation }
}

export const compileDocuments = (
  input: RawPlanningDocuments,
): Effect.Effect<
  PlannedRun,
  RunContractError | import("../reference-planning/index.js").ReferencePlanningError | import("../reference-planning/index.js").ApplicationReadError | import("../reference-planning/index.js").MediaInspectionError,
  PlanningIdentityService | ApplicationFilesService | MediaInspectorService
> => Effect.gen(function*() {
  if ([input.projectContract, input.toolLock, input.objective].some(hasSecretMaterial)) {
    return yield* Effect.fail(new RunContractError(
      "SECRET_MATERIAL_DETECTED",
      "Planning documents contain credential material; use only the logical credential name.",
    ))
  }

  const parsed = yield* Effect.try({
    try: () => ({
      contract: parseDocument(input.projectContract, "Project Contract"),
      lock: parseDocument(input.toolLock, "Tool Lock"),
      objective: parseDocument(input.objective, "Objective"),
    }),
    catch: (error) => error instanceof RunContractError
      ? error
      : new RunContractError("DOCUMENT_INVALID", "Planning documents are invalid."),
  })

  const identity = yield* PlanningIdentity
  const lock = yield* Effect.try({
    try: () => decodeToolIdentity(parsed.lock),
    catch: (error) => error instanceof RunContractError
      ? error
      : new RunContractError("DOCUMENT_INVALID", "Tool Lock is invalid."),
  })
  if (!sameTool(lock, identity.installedTool)) {
    return yield* Effect.fail(new RunContractError(
      "TOOL_LOCK_MISMATCH",
      "The application Tool Lock does not name this exact installed tool build.",
    ))
  }

  const decoded = yield* Effect.try({
    try: () => {
      const contract = parsed.contract
      const objective = parsed.objective
      const procedureId = stringField(objective, "procedureId")
      const procedure = recordsField(contract, "procedures").find(
        (candidate) => candidate.id === procedureId,
      )
      if (procedure === undefined) {
        throw new RunContractError("PROCEDURE_NOT_LOCKED", "The objective Procedure is not allowed by the Project Contract.")
      }
      const modeValue = stringField(procedure, "mode")
      if (modeValue !== "qwen-image" && modeValue !== "seedance-video") {
        throw new RunContractError("PROCEDURE_NOT_LOCKED", "The locked Procedure mode is unsupported.")
      }
      const mode: "qwen-image" | "seedance-video" = modeValue
      if (stringField(procedure, "provider") !== "openrouter") {
        throw new RunContractError("PROCEDURE_NOT_LOCKED", "The locked Procedure must use OpenRouter.")
      }
      const referenceRoots = stringsField(contract, "referenceRoots")
      const outputRoot = stringField(contract, "outputRoot")
      if (!referenceRoots.every(isSafePath) || !isSafePath(outputRoot)) {
        throw new RunContractError("UNSAFE_APPLICATION_PATH", "Project Contract paths must be safe application-relative paths.")
      }
      const requestedCount = numberField(objective, "requestedCount")
      const maximumCount = Math.min(
        numberField(contract, "maximumCount"),
        numberField(procedure, "maximumCount"),
      )
      if (requestedCount < 1 || requestedCount > maximumCount) {
        throw new RunContractError("COUNT_OUT_OF_RANGE", "Requested output count exceeds the locked ceiling.")
      }
      const unitCostCents = moneyCents(stringField(procedure, "unitCostUsd"), "unitCostUsd")
      const objectiveBudget = moneyCents(stringField(objective, "budgetCeilingUsd"), "budgetCeilingUsd")
      const projectBudget = moneyCents(stringField(contract, "maximumBudgetUsd"), "maximumBudgetUsd")
      const estimatedCost = requestedCount * unitCostCents
      if (estimatedCost > objectiveBudget || estimatedCost > projectBudget) {
        throw new RunContractError("BUDGET_EXCEEDED", "Worst-case planned spend exceeds an approved budget ceiling.")
      }
      return {
        applicationId: stringField(contract, "applicationId"),
        objectiveId: stringField(objective, "id"),
        objectiveSummary: stringField(objective, "summary"),
        procedureId,
        mode,
        model: stringField(procedure, "model"),
        referenceRoots,
        outputRoot,
        requestedCount,
        estimatedCost,
        objectiveBudget,
        linkedRun: decodeLinkedRun(objective),
        requirements: decodeRequirements(procedure),
        candidates: decodeCandidates(objective),
      }
    },
    catch: (error) => error instanceof RunContractError
      ? error
      : new RunContractError("DOCUMENT_INVALID", "Project Contract or Objective fields are invalid."),
  })

  const referencePlan = yield* planReferences({
    mode: decoded.mode,
    referenceRoots: decoded.referenceRoots,
    requirements: decoded.requirements,
    candidates: decoded.candidates,
  })
  if (
    decoded.mode === "seedance-video" &&
    !referencePlan.references.some((reference) => reference.kind === "video")
  ) {
    return yield* Effect.fail(new RunContractError(
      "SEEDANCE_VIDEO_REFERENCE_REQUIRED",
      "Seedance video mode requires a real video reference in the locked payload destination.",
    ))
  }

  const request: CanonicalRunRequest = deepFreeze({
    schemaVersion: lock.runSchemaVersion,
    applicationId: decoded.applicationId,
    objectiveId: decoded.objectiveId,
    objective: decoded.objectiveSummary,
    procedureId: decoded.procedureId,
    mode: decoded.mode,
    provider: "openrouter",
    model: decoded.model,
    adapterProtocolVersion: lock.adapterProtocolVersion,
    requestedCount: decoded.requestedCount,
    estimatedMaximumCostUsd: formatCents(decoded.estimatedCost),
    budgetCeilingUsd: formatCents(decoded.objectiveBudget),
    outputRoot: decoded.outputRoot,
    ...(decoded.linkedRun === undefined ? {} : { linkedRun: decoded.linkedRun }),
    references: referencePlan.references,
    tool: lock,
  })
  const canonicalRequest = canonicalize(request)
  return deepFreeze({
    state: "planned" as const,
    request,
    canonicalRequest,
    requestSha256: createHash("sha256").update(canonicalRequest).digest("hex"),
  })
})
