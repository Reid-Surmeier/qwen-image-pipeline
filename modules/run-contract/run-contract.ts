import { createHash } from "node:crypto"

import { Effect } from "effect"

import {
  PlanningIdentity,
  type AssemblyPlan,
  type CanonicalRunRequest,
  type LinkedRunRelationship,
  type PlannedRun,
  type PlanningIdentityService,
  type RawPlanningDocuments,
  type ToolIdentity,
  type VideoPlan,
} from "./types.js"
import { RunContractError } from "./errors.js"
import { isVerifiedPlanningIdentity } from "./file-planning-identity.js"
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
  !path.startsWith("~") &&
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

const assemblyPlanError = (message: string): RunContractError =>
  new RunContractError("ASSEMBLY_PLAN_INVALID", message)

const decodeAssemblyPlan = (
  value: unknown,
  mode: "qwen-image" | "seedance-video",
  references: CanonicalRunRequest["references"],
): AssemblyPlan | undefined => {
  if (value === undefined) return undefined
  if (mode !== "qwen-image" || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw assemblyPlanError("Assembly plans are supported only for Qwen Image objectives.")
  }
  const plan = value as JsonRecord
  if (plan.required !== true) {
    throw assemblyPlanError("Assembly plan required must be true.")
  }
  const baselineReferenceSlot = plan.baselineReferenceSlot
  if (typeof baselineReferenceSlot !== "string" || baselineReferenceSlot.length === 0) {
    throw assemblyPlanError("Assembly plan baselineReferenceSlot must be a non-empty string.")
  }
  const baseline = references.find((reference) =>
    reference.slot === baselineReferenceSlot && reference.kind === "image")
  if (baseline === undefined) {
    throw assemblyPlanError("Assembly plan baselineReferenceSlot must name a locked image reference.")
  }
  if (plan.ownedRegion === null || typeof plan.ownedRegion !== "object" || Array.isArray(plan.ownedRegion)) {
    throw assemblyPlanError("Assembly plan ownedRegion must be an object.")
  }
  const region = plan.ownedRegion as JsonRecord
  const { x, y, width, height } = region
  if (
    ![x, y, width, height].every((coordinate) =>
      typeof coordinate === "number" && Number.isSafeInteger(coordinate)) ||
    (x as number) < 0 || (y as number) < 0 ||
    (width as number) < 1 || (height as number) < 1
  ) {
    throw assemblyPlanError("Assembly plan ownedRegion must contain non-negative integer coordinates and positive integer dimensions.")
  }
  const ownedRegion: AssemblyPlan["ownedRegion"] = {
    x: x as number,
    y: y as number,
    width: width as number,
    height: height as number,
  }
  if (
    ownedRegion.x + ownedRegion.width > baseline.inspectedMedia.width ||
    ownedRegion.y + ownedRegion.height > baseline.inspectedMedia.height
  ) {
    throw assemblyPlanError("Assembly plan ownedRegion must remain inside the inspected baseline dimensions.")
  }
  if (!Array.isArray(plan.exactCopy) || plan.exactCopy.length === 0) {
    throw assemblyPlanError("Assembly plan exactCopy must contain at least one pixel.")
  }
  const exactCopy: AssemblyPlan["exactCopy"] = plan.exactCopy.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw assemblyPlanError("Every Exact Copy pixel must be an object.")
    }
    const pixel = value as JsonRecord
    const x = pixel.x
    const y = pixel.y
    const rgba = pixel.rgba
    const pixelSha256 = pixel.sha256
    if (
      typeof x !== "number" || !Number.isSafeInteger(x) || x < 0 ||
      typeof y !== "number" || !Number.isSafeInteger(y) || y < 0 ||
      !Array.isArray(rgba) || rgba.length !== 4 ||
      rgba.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255) ||
      typeof pixelSha256 !== "string" || !/^[a-f0-9]{64}$/.test(pixelSha256)
    ) {
      throw assemblyPlanError("Exact Copy coordinates, RGBA channels, and SHA-256 must be well formed.")
    }
    const normalizedRgba = rgba as unknown as readonly [number, number, number, number]
    const canonicalPixel = { x, y, rgba: normalizedRgba }
    if (createHash("sha256").update(JSON.stringify(canonicalPixel)).digest("hex") !== pixelSha256) {
      throw assemblyPlanError("Exact Copy SHA-256 must bind its canonical coordinates and RGBA channels.")
    }
    if (
      x < ownedRegion.x || y < ownedRegion.y ||
      x >= ownedRegion.x + ownedRegion.width ||
      y >= ownedRegion.y + ownedRegion.height
    ) {
      throw assemblyPlanError("Every Exact Copy pixel must remain inside the owned Assembly region.")
    }
    return { ...canonicalPixel, sha256: pixelSha256 }
  })
  return { required: true, baselineReferenceSlot, ownedRegion, exactCopy }
}

const videoPlanError = (message: string): RunContractError =>
  new RunContractError("VIDEO_PLAN_INVALID", message)

const decodeVideoPlan = (
  value: unknown,
  mode: "qwen-image" | "seedance-video",
): VideoPlan | undefined => {
  if (mode === "qwen-image") {
    if (value !== undefined) {
      throw videoPlanError("Video plans are supported only for Seedance objectives.")
    }
    return undefined
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw videoPlanError("Seedance requires an explicit Video Plan.")
  }
  const plan = value as JsonRecord
  if (plan.assembly === null || typeof plan.assembly !== "object" || Array.isArray(plan.assembly)) {
    throw videoPlanError("The Video Plan must contain an Assembly decision.")
  }
  const assembly = plan.assembly as JsonRecord
  if (assembly.required !== false || assembly.pixelOwnership !== "none-authoritative") {
    throw videoPlanError("Assembly may be absent only when the plan proves no authoritative pixel ownership.")
  }
  if (plan.expectedMedia === null || typeof plan.expectedMedia !== "object" || Array.isArray(plan.expectedMedia)) {
    throw videoPlanError("The Video Plan must contain expected media properties.")
  }
  const media = plan.expectedMedia as JsonRecord
  const { width, height, durationSeconds, audioExpected } = media
  if (
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
    typeof audioExpected !== "boolean"
  ) {
    throw videoPlanError("Expected video dimensions, duration, and audio expectation must be valid.")
  }
  return {
    assembly: {
      required: false,
      pixelOwnership: "none-authoritative",
    },
    expectedMedia: { width, height, durationSeconds, audioExpected },
  }
}

export const verifyPlannedRunIdentity = (
  plannedRun: PlannedRun,
  rawToolLock: string,
): Effect.Effect<void, RunContractError, PlanningIdentityService> => Effect.gen(function*() {
  if (hasSecretMaterial(rawToolLock)) {
    return yield* Effect.fail(new RunContractError(
      "SECRET_MATERIAL_DETECTED",
      "The application Tool Lock contains credential material.",
    ))
  }
  const identity = yield* PlanningIdentity
  if (!isVerifiedPlanningIdentity(identity)) {
    return yield* Effect.fail(new RunContractError(
      "TOOL_ARTIFACT_INVALID",
      "Advancement requires identity derived from a verified installed tool artifact.",
    ))
  }
  const lock = yield* Effect.try({
    try: () => decodeToolIdentity(parseDocument(rawToolLock, "Tool Lock")),
    catch: (error) => error instanceof RunContractError
      ? error
      : new RunContractError("DOCUMENT_INVALID", "Tool Lock is invalid."),
  })
  if (
    !sameTool(lock, identity.installedTool) ||
    !sameTool(plannedRun.request.tool, identity.installedTool)
  ) {
    return yield* Effect.fail(new RunContractError(
      "TOOL_LOCK_MISMATCH",
      "The Planned Run, application Tool Lock, and installed tool identity do not match exactly.",
    ))
  }
})

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
  if (!isVerifiedPlanningIdentity(identity)) {
    return yield* Effect.fail(new RunContractError(
      "TOOL_ARTIFACT_INVALID",
      "Planning requires identity derived from a verified installed tool artifact.",
    ))
  }
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
  if (
    lock.procedureVersion !== "1" ||
    lock.runSchemaVersion !== "2" ||
    lock.adapterProtocolVersion !== "1"
  ) {
    return yield* Effect.fail(new RunContractError(
      "TOOL_VERSION_UNSUPPORTED",
      "The locked Procedure, Run schema, and adapter protocol versions are not supported by this tool.",
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
      if (stringField(procedure, "version") !== lock.procedureVersion) {
        throw new RunContractError(
          "PROCEDURE_NOT_LOCKED",
          "The selected Procedure version does not match the exact Tool Lock.",
        )
      }
      if (stringField(procedure, "provider") !== "openrouter") {
        throw new RunContractError("PROCEDURE_NOT_LOCKED", "The locked Procedure must use OpenRouter.")
      }
      const referenceRoots = stringsField(contract, "referenceRoots")
      const artifactRoot = stringField(contract, "artifactRoot")
      const outputRoot = stringField(contract, "outputRoot")
      if (!referenceRoots.every(isSafePath) || !isSafePath(artifactRoot) || !isSafePath(outputRoot)) {
        throw new RunContractError("UNSAFE_APPLICATION_PATH", "Project Contract paths must be safe application-relative paths.")
      }
      const requestedCount = numberField(objective, "requestedCount")
      const maximumCorrectionRuns = numberField(contract, "maximumCorrectionRuns")
      if (maximumCorrectionRuns < 0 || maximumCorrectionRuns > 10) {
        throw new RunContractError(
          "DOCUMENT_INVALID",
          "maximumCorrectionRuns must be an integer from 0 through 10.",
        )
      }
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
        artifactRoot,
        outputRoot,
        requestedCount,
        maximumCorrectionRuns,
        estimatedCost,
        objectiveBudget,
        linkedRun: decodeLinkedRun(objective),
        assemblyPlan: objective.assemblyPlan,
        videoPlan: objective.videoPlan,
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

  const assemblyPlan = yield* Effect.try({
    try: () => decodeAssemblyPlan(decoded.assemblyPlan, decoded.mode, referencePlan.references),
    catch: (error) => error instanceof RunContractError
      ? error
      : assemblyPlanError("Assembly plan could not be decoded."),
  })
  const videoPlan = yield* Effect.try({
    try: () => decodeVideoPlan(decoded.videoPlan, decoded.mode),
    catch: (error) => error instanceof RunContractError
      ? error
      : videoPlanError("Video plan could not be decoded."),
  })

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
    maximumCorrectionRuns: decoded.maximumCorrectionRuns,
    artifactRoot: decoded.artifactRoot,
    outputRoot: decoded.outputRoot,
    ...(decoded.linkedRun === undefined ? {} : { linkedRun: decoded.linkedRun }),
    ...(assemblyPlan === undefined ? {} : { assemblyPlan }),
    ...(videoPlan === undefined ? {} : { videoPlan }),
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
