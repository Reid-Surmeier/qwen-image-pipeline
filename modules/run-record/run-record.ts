import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

import { Effect } from "effect"

import { inspectAssemblyFailure } from "../assembly/index.js"

import {
  hasDuplicateJsonKeys,
  hasProviderCredentialMaterial,
  isSanitizedProviderDocument,
  snapshotProviderEvidence,
} from "../provider-evidence-sanitizer/index.js"
import { RunRecordError } from "./errors.js"
import { inspectVerificationFailure } from "../verification/index.js"
import { inspectVideoVerificationFailure } from "../video-verification/index.js"
import type { CanonicalRunRequest } from "../run-contract/index.js"
import type {
  ClassifiedFailureClass,
  CorrectionOwner,
  GeneratedOutputEvidenceInput,
  ProviderEvidenceInput,
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunRecordClockService,
  RunRecordDiagnostics,
  RunLink,
  RunRecordStoreService,
  RunRecordView,
  SeedanceCostInput,
  SubmissionBinding,
  SubmissionPermit,
  StoredRunRecord,
} from "./types.js"
import {
  RunRecordClock,
  RunRecordStore,
} from "./types.js"

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | {
  readonly [key: string]: JsonValue
}

interface SubmissionPermitConsumer {
  readonly validate: (binding: SubmissionBinding) => Effect.Effect<void, RunRecordError>
  readonly consume: (
    binding: SubmissionBinding,
  ) => Effect.Effect<void, RunRecordError>
  readonly refuse: (runId: string, operationId: string) => Effect.Effect<void, RunRecordError>
}

const submissionPermitConsumers = new WeakMap<SubmissionPermit, SubmissionPermitConsumer>()

export const validateSubmissionPermit = (
  permit: SubmissionPermit,
  binding: SubmissionBinding,
): Effect.Effect<void, RunRecordError> => Effect.suspend(() => {
  if (permit === null || typeof permit !== "object") {
    return Effect.fail(new RunRecordError("SUBMISSION_PERMIT_INVALID", "The Submission Permit was not issued by this process.", "reconcile"))
  }
  const consumer = submissionPermitConsumers.get(permit)
  return consumer === undefined
    ? Effect.fail(new RunRecordError("SUBMISSION_PERMIT_INVALID", "The Submission Permit was not issued by this process.", "reconcile"))
    : consumer.validate(binding)
})

export const consumeSubmissionPermit = (
  permit: SubmissionPermit,
  binding: SubmissionBinding,
): Effect.Effect<void, RunRecordError> => Effect.suspend(() => {
  if (permit === null || typeof permit !== "object") {
    return Effect.fail(new RunRecordError(
      "SUBMISSION_PERMIT_INVALID",
      "The Submission Permit was not issued by this Run Record process.",
      "reconcile",
    ))
  }
  const consumer = submissionPermitConsumers.get(permit)
  return consumer === undefined
    ? Effect.fail(new RunRecordError(
      "SUBMISSION_PERMIT_INVALID",
      "The Submission Permit was not issued by this Run Record process.",
      "reconcile",
    ))
    : consumer.consume(binding)
})

type RunEvent = Readonly<{
  schemaVersion: "1"
  sequence: number
  operationId: string
  runId: string
  timestamp: string
  kind: "attempt_reserved" | "submission_may_have_started" | "provider_evidence_intent" | "provider_evidence_received" | "generated_output_persisted" | "seedance_poll_persisted" | "donor_choice_opened" | "donor_selected" | "assembly_persisted" | "checks_persisted" | "video_checks_persisted" | "definitive_pre_submit_failure" | "correction_run_linked" | "classified_outcome_intent" | "classified_outcome"
  previousEventSha256: string | null
  payload: Readonly<Record<string, JsonValue>>
  eventSha256: string
}>

const canonicalValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    )
  }
  return value
}

const canonicalJson = (value: JsonValue): string => JSON.stringify(canonicalValue(value))
const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")
const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8")

type ClassifiedFailurePolicy = Readonly<{
  outcome: "blocked" | "failed"
  spendState: "not_spent" | "possibly_spent" | "unknown"
  retryState: "new-linked-run-only" | "reconcile-only" | "never-resubmit"
  correctionOwner: CorrectionOwner
}>

const classifiedFailurePolicies = {
  submission_unreconciled: {
    outcome: "blocked",
    spendState: "possibly_spent",
    retryState: "reconcile-only",
    correctionOwner: "Generation",
  },
  assembly_failure: {
    outcome: "failed",
    spendState: "unknown",
    retryState: "reconcile-only",
    correctionOwner: "Assembly",
  },
  verification_failure: {
    outcome: "failed",
    spendState: "unknown",
    retryState: "reconcile-only",
    correctionOwner: "Verification",
  },
} as const satisfies Record<ClassifiedFailureClass, ClassifiedFailurePolicy>

const isClassifiedFailureClass = (value: unknown): value is ClassifiedFailureClass =>
  typeof value === "string" && Object.hasOwn(classifiedFailurePolicies, value)

const classifiedFailurePolicy = (value: ClassifiedFailureClass): ClassifiedFailurePolicy =>
  classifiedFailurePolicies[value]

const immutable = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

const eventWithoutDigest = (event: Omit<RunEvent, "eventSha256">): JsonValue => ({
  schemaVersion: event.schemaVersion,
  sequence: event.sequence,
  operationId: event.operationId,
  runId: event.runId,
  timestamp: event.timestamp,
  kind: event.kind,
  previousEventSha256: event.previousEventSha256,
  payload: event.payload,
})

const makeEvent = (event: Omit<RunEvent, "eventSha256">): RunEvent => immutable({
  ...event,
  eventSha256: sha256(canonicalJson(eventWithoutDigest(event))),
})

const encodeEvent = (event: RunEvent): Uint8Array => bytes(`${canonicalJson(event as unknown as JsonValue)}\n`)
const encodeView = (view: RunRecordView): Uint8Array => bytes(canonicalJson(view as unknown as JsonValue))

const checksOperationSha256 = (operation: Extract<RecordOperation, { _tag: "CommitChecks" }>): string =>
  sha256(canonicalJson({
    baselineSha256: operation.baseline.sha256,
    candidateSha256: operation.candidateSha256,
    checks: operation.checks,
    classification: operation.classification,
  } as unknown as JsonValue))

const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value)
const isIdentifier = (value: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)

const safeRecordedPath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.startsWith("/") &&
  !value.startsWith("~") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const recordedRequest = (
  value: unknown,
  recovery: RunRecordError["recovery"] = "reload",
  allowHistorical = true,
): CanonicalRunRequest => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunRecordError("UNSUPPORTED_RECORDED_VERSION", "The recorded Run Request has no supported version profile.", recovery)
  }
  const request = value as Readonly<Record<string, unknown>>
  const tool = request.tool
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
    throw new RunRecordError("UNSUPPORTED_RECORDED_VERSION", "The recorded Run Request has no tool version identity.", recovery)
  }
  const toolIdentity = tool as Readonly<Record<string, unknown>>
  const allowedKeys = new Set([
    "adapterProtocolVersion",
    "applicationId",
    "artifactRoot",
    "assemblyPlan",
    "budgetCeilingUsd",
    "estimatedMaximumCostUsd",
    "linkedRun",
    "maximumCorrectionRuns",
    "mode",
    "model",
    "objective",
    "objectiveId",
    "outputRoot",
    "procedureId",
    "provider",
    "references",
    "requestedCount",
    "schemaVersion",
    "tool",
    "videoPlan",
  ])
  if (
    Object.keys(request).some((key) => !allowedKeys.has(key)) ||
    Object.keys(toolIdentity).sort().join(",") !==
      "adapterProtocolVersion,artifactSha256,commit,procedureVersion,release,runSchemaVersion" ||
    typeof request.applicationId !== "string" || !isIdentifier(request.applicationId) ||
    typeof request.objectiveId !== "string" || !isIdentifier(request.objectiveId) ||
    typeof request.objective !== "string" || request.objective.length === 0 ||
    typeof request.procedureId !== "string" || !isIdentifier(request.procedureId) ||
    (request.mode !== "qwen-image" && request.mode !== "seedance-video") ||
    request.provider !== "openrouter" || typeof request.model !== "string" || request.model.length === 0 ||
    !Number.isSafeInteger(request.requestedCount) || Number(request.requestedCount) < 1 ||
    typeof request.estimatedMaximumCostUsd !== "string" || typeof request.budgetCeilingUsd !== "string" ||
    !Number.isSafeInteger(request.maximumCorrectionRuns) || Number(request.maximumCorrectionRuns) < 0 ||
    !safeRecordedPath(request.outputRoot) || !Array.isArray(request.references) || request.references.length === 0 ||
    typeof toolIdentity.release !== "string" || typeof toolIdentity.commit !== "string" ||
    typeof toolIdentity.artifactSha256 !== "string" || typeof toolIdentity.procedureVersion !== "string" ||
    typeof toolIdentity.runSchemaVersion !== "string" || typeof toolIdentity.adapterProtocolVersion !== "string" ||
    request.schemaVersion !== toolIdentity.runSchemaVersion ||
    request.adapterProtocolVersion !== toolIdentity.adapterProtocolVersion ||
    toolIdentity.procedureVersion !== "1" ||
    toolIdentity.adapterProtocolVersion !== "1" ||
    (
      toolIdentity.runSchemaVersion === "1"
        ? (!allowHistorical || "artifactRoot" in request)
        : toolIdentity.runSchemaVersion === "2"
          ? !safeRecordedPath(request.artifactRoot)
          : true
    )
  ) {
    throw new RunRecordError(
      "UNSUPPORTED_RECORDED_VERSION",
      "No explicit replay implementation exists for the recorded Procedure, Run schema, and adapter protocol versions.",
      recovery,
    )
  }
  return value as CanonicalRunRequest
}

const validateReservation = (input: ReserveRun): CanonicalRunRequest => {
  const { plannedRun } = input
  if (plannedRun.state !== "planned") {
    throw new RunRecordError("INVALID_PLANNED_RUN", "Only a Planned Run may be reserved.")
  }
  if (sha256(plannedRun.canonicalRequest) !== plannedRun.requestSha256) {
    throw new RunRecordError("REQUEST_HASH_MISMATCH", "The canonical request no longer matches its planned digest.")
  }
  let canonicalRequest: unknown
  try {
    canonicalRequest = JSON.parse(plannedRun.canonicalRequest)
  } catch {
    throw new RunRecordError("REQUEST_HASH_MISMATCH", "The canonical request is not valid JSON.")
  }
  if (
    canonicalRequest === null ||
    typeof canonicalRequest !== "object" ||
    Array.isArray(canonicalRequest) ||
    canonicalJson(canonicalRequest as JsonValue) !== plannedRun.canonicalRequest ||
    canonicalJson(canonicalRequest as JsonValue) !== canonicalJson(plannedRun.request as unknown as JsonValue)
  ) {
    throw new RunRecordError("REQUEST_HASH_MISMATCH", "The Planned Run object disagrees with its authoritative canonical bytes.")
  }
  const request = recordedRequest(canonicalRequest, "reload", false)
  if (!isSha256(input.payloadSha256)) {
    throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "The payload digest must be a lowercase SHA-256.")
  }
  return request
}

const correctionMaterial = (request: CanonicalRunRequest): JsonValue => ({
  adapterProtocolVersion: request.adapterProtocolVersion,
  assemblyPlan: request.assemblyPlan ?? null,
  budgetCeilingUsd: request.budgetCeilingUsd,
  estimatedMaximumCostUsd: request.estimatedMaximumCostUsd,
  mode: request.mode,
  model: request.model,
  objective: request.objective,
  procedureId: request.procedureId,
  provider: request.provider,
  references: request.references,
  requestedCount: request.requestedCount,
  toolProcedureVersion: request.tool.procedureVersion,
  videoPlan: request.videoPlan ?? null,
} as unknown as JsonValue)

const runIdentity = (requestSha256: string): string => `run-${requestSha256.slice(0, 24)}`

const parseEvents = (value: Uint8Array): ReadonlyArray<RunEvent> => {
  const raw = Buffer.from(value).toString("utf8")
  if (!raw.endsWith("\n")) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal ends with an incomplete frame.", "repair-evidence")
  }
  const lines = raw.slice(0, -1).split("\n")
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal contains an empty frame.", "repair-evidence")
  }
  try {
    return lines.map((line) => JSON.parse(line) as RunEvent)
  } catch {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal contains invalid JSON.", "repair-evidence")
  }
}

const verifyEvents = (runId: string, events: ReadonlyArray<RunEvent>): void => {
  let previous: string | null = null
  for (const [index, event] of events.entries()) {
    if (
      event.schemaVersion !== "1" ||
      event.runId !== runId ||
      event.sequence !== index + 1 ||
      event.previousEventSha256 !== previous ||
      !isIdentifier(event.operationId) ||
      !isSha256(event.eventSha256) ||
      sha256(canonicalJson(eventWithoutDigest(event))) !== event.eventSha256
    ) {
      throw new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal hash chain is invalid.", "repair-evidence")
    }
    previous = event.eventSha256
  }
}

const stringPayload = (payload: Readonly<Record<string, JsonValue>>, key: string): string => {
  const value = payload[key]
  if (typeof value !== "string") {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", `The ${key} event field is invalid.`, "repair-evidence")
  }
  return value
}

const numberPayload = (payload: Readonly<Record<string, JsonValue>>, key: string): number => {
  const value = payload[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", `The ${key} event field is invalid.`, "repair-evidence")
  }
  return value
}

const stringArrayPayload = (payload: Readonly<Record<string, JsonValue>>, key: string): ReadonlyArray<string> => {
  const value = payload[key]
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", `The ${key} event field is invalid.`, "repair-evidence")
  }
  return value as ReadonlyArray<string>
}

const linkPayload = (payload: Readonly<Record<string, JsonValue>>): RunLink | undefined => {
  const value = payload.linkedFrom
  if (value === null || value === undefined) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The linked Run evidence is invalid.", "repair-evidence")
  }
  const record = value as Readonly<Record<string, JsonValue>>
  const parentRunId = record.parentRunId
  const parentFailureEventSha256 = record.parentFailureEventSha256
  const relation = record.relation
  if (
    typeof parentRunId !== "string" ||
    typeof parentFailureEventSha256 !== "string" ||
    relation !== "retry-after-definitive-pre-submit-failure"
  ) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The linked Run evidence is incomplete.", "repair-evidence")
  }
  return { parentRunId, parentFailureEventSha256, relation }
}

const expectedCheckNames = [
  "integrity",
  "media",
  "outside-region-preservation",
  "donor-equality-inside-region",
] as const

const verificationAlgorithm = "rgba-fidelity-v1" as const

type AssemblyBindings = Readonly<{
  baselineSha256: string
  donorSha256: string
  regionSha256: string
  exactCopySha256: string
  outputSha256: string
}>

type Raster = Readonly<{ width: number; height: number; pixels: ReadonlyArray<number> }>

const requestAssemblyPlan = (request: CanonicalRunRequest): NonNullable<CanonicalRunRequest["assemblyPlan"]> => {
  if (request.mode !== "qwen-image" || request.assemblyPlan?.required !== true) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Assembly evidence requires an immutable Qwen Assembly plan.", "repair-evidence")
  }
  return request.assemblyPlan
}

const expectedPlanBindings = (
  request: CanonicalRunRequest,
  donorSha256: string,
  outputSha256: string,
): AssemblyBindings => {
  const plan = requestAssemblyPlan(request)
  const baseline = request.references.find((reference) =>
    reference.slot === plan.baselineReferenceSlot && reference.kind === "image")
  if (baseline === undefined) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The Assembly baseline is not a hash-locked image reference.", "repair-evidence")
  }
  const region = {
    x: plan.ownedRegion.x,
    y: plan.ownedRegion.y,
    width: plan.ownedRegion.width,
    height: plan.ownedRegion.height,
  }
  return {
    baselineSha256: baseline.sha256,
    donorSha256,
    regionSha256: sha256(JSON.stringify(region)),
    exactCopySha256: sha256(JSON.stringify(plan.exactCopy.map((copy) => copy.sha256))),
    outputSha256,
  }
}

const decodeRaster = (body: Uint8Array): Raster => {
  let value: unknown
  const source = Buffer.from(body).toString("utf8")
  try {
    if (hasDuplicateJsonKeys(source)) throw new Error("duplicate JSON key")
    value = JSON.parse(source)
  } catch {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check input is not valid raster JSON.", "repair-evidence")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check input is not a raster object.", "repair-evidence")
  }
  const { width, height, pixels } = value as Record<string, unknown>
  if (
    Object.keys(value).sort().join(",") !== "height,pixels,width" ||
    source !== canonicalJson(value as JsonValue) ||
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    !Array.isArray(pixels) || pixels.length !== width * height * 4 ||
    pixels.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check raster has invalid dimensions or RGBA channels.", "repair-evidence")
  }
  return { width, height, pixels: pixels as ReadonlyArray<number> }
}

const isNormalizedRgbaEvidence = (body: Uint8Array): boolean => {
  try {
    decodeRaster(body)
    return true
  } catch {
    return false
  }
}

type ClassifiedFailureProofContext = Readonly<{
  phase: RunRecordView["phase"]
  runRequest: CanonicalRunRequest
  evidence: RunRecordView["evidence"]
  selectedDonorSha256?: string
  assemblyOutputSha256?: string
  completedCount?: number
  costState?: "actual" | "estimated-only" | "unknown"
  actualCostUsd?: string
}>

const jsonRecord = (value: unknown): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined

const exactJsonKeys = (value: Readonly<Record<string, JsonValue>>, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",")

const classifiedFailureProofMatches = (
  failureClass: ClassifiedFailureClass,
  proofValue: unknown,
  context: ClassifiedFailureProofContext,
): boolean => {
  const proof = jsonRecord(proofValue)
  if (proof === undefined) return false
  if (failureClass === "submission_unreconciled") {
    return exactJsonKeys(proof, ["module", "observation"]) &&
      proof.module === "Run Record" && proof.observation === "submission result remains unreconciled" &&
      (
        context.phase === "submission_may_have_started" ||
        context.phase === "provider_evidence_received" ||
        (
          context.runRequest.mode === "qwen-image" && context.phase === "generated_outputs_received" &&
          context.evidence.filter((item) => item.applicationPath.startsWith("outputs/")).length < context.runRequest.requestedCount
        )
      )
  }
  const assemblyPlan = context.runRequest.assemblyPlan
  const baselineSha256 = assemblyPlan === undefined
    ? undefined
    : context.runRequest.references.find((reference) => reference.slot === assemblyPlan.baselineReferenceSlot)?.sha256
  const regionSha256 = assemblyPlan === undefined ? undefined : sha256(JSON.stringify(assemblyPlan.ownedRegion))
  const exactCopySha256 = assemblyPlan === undefined
    ? undefined
    : sha256(JSON.stringify(assemblyPlan.exactCopy.map((copy) => copy.sha256)))
  if (failureClass === "assembly_failure") {
    return context.phase === "donor_selected" &&
      exactJsonKeys(proof, ["module", "errorCode", "baselineSha256", "donorSha256", "regionSha256", "exactCopySha256"]) &&
      proof.module === "Assembly" &&
      ["ASSEMBLY_INPUT_HASH_MISMATCH", "RASTER_INVALID", "OWNED_REGION_INVALID", "EXACT_COPY_HASH_MISMATCH"].includes(String(proof.errorCode)) &&
      proof.baselineSha256 === baselineSha256 && proof.donorSha256 === context.selectedDonorSha256 &&
      proof.regionSha256 === regionSha256 && proof.exactCopySha256 === exactCopySha256
  }
  if (proof.module === "Verification") {
    const completedChecks = proof.completedChecks
    const completed = Array.isArray(completedChecks) ? completedChecks : undefined
    const expectedCompleted = proof.errorCode === "INTEGRITY_CHECK_FAILED"
      ? [[]]
      : proof.errorCode === "MEDIA_CHECK_FAILED"
        ? [["integrity"], ["integrity", "media"]]
        : [["integrity", "media"]]
    return context.phase === "assembly_completed" &&
      exactJsonKeys(proof, ["module", "errorCode", "completedChecks", "baselineSha256", "donorSha256", "candidateSha256", "regionSha256", "exactCopySha256"]) &&
      ["INTEGRITY_CHECK_FAILED", "MEDIA_CHECK_FAILED", "ASSEMBLY_REQUIRED", "FIDELITY_CHECK_FAILED"].includes(String(proof.errorCode)) &&
      completed !== undefined && expectedCompleted.some((candidate) => canonicalJson(candidate) === canonicalJson(completed as JsonValue)) &&
      proof.baselineSha256 === baselineSha256 && proof.donorSha256 === context.selectedDonorSha256 &&
      proof.candidateSha256 === context.assemblyOutputSha256 && proof.regionSha256 === regionSha256 &&
      proof.exactCopySha256 === exactCopySha256
  }
  if (proof.module !== "Video Verification") return false
  const videoOutputs = context.evidence
    .filter((item) => item.applicationPath.startsWith("outputs/") && item.mediaType === "video/mp4")
    .map((item) => ({
      applicationPath: item.applicationPath,
      mediaType: item.mediaType,
      sha256: item.sha256,
    }))
  const videoCost = {
    state: context.costState ?? "unknown",
    estimatedMaximumCostUsd: context.runRequest.estimatedMaximumCostUsd,
    ...(context.actualCostUsd === undefined ? {} : { actualCostUsd: context.actualCostUsd }),
  }
  return context.phase === "generated_outputs_received" && context.runRequest.mode === "seedance-video" &&
    exactJsonKeys(proof, ["module", "errorCode", "outputs", "requestedCount", "completedCount", "expected", "cost"]) &&
    ["VIDEO_EVIDENCE_INVALID", "VIDEO_MEDIA_INVALID", "VIDEO_CHECK_FAILED", "OUTPUT_COUNT_MISMATCH"].includes(String(proof.errorCode)) &&
    proof.requestedCount === context.runRequest.requestedCount && proof.completedCount === context.completedCount &&
    canonicalJson(proof.outputs!) === canonicalJson(videoOutputs) &&
    canonicalJson(proof.expected!) === canonicalJson(context.runRequest.videoPlan!.expectedMedia as unknown as JsonValue) &&
    canonicalJson(proof.cost!) === canonicalJson(videoCost)
}

const recomputeChecks = (
  request: CanonicalRunRequest,
  baselineBytes: Uint8Array,
  donorBytes: Uint8Array,
  candidateBytes: Uint8Array,
): ReadonlyArray<Readonly<{ name: typeof expectedCheckNames[number]; passed: true; measured: number }>> => {
  const plan = requestAssemblyPlan(request)
  const baseline = decodeRaster(baselineBytes)
  const donor = decodeRaster(donorBytes)
  const candidate = decodeRaster(candidateBytes)
  if (
    baseline.width !== donor.width || baseline.width !== candidate.width ||
    baseline.height !== donor.height || baseline.height !== candidate.height
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Fidelity Check rasters are dimensionally inconsistent.", "repair-evidence")
  }
  const region = plan.ownedRegion
  if (
    region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
    region.x + region.width > baseline.width || region.y + region.height > baseline.height
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The immutable Assembly region is outside the baseline raster.", "repair-evidence")
  }
  const exactCopy = new Map(plan.exactCopy.map((copy) => [`${copy.x}:${copy.y}`, copy.rgba] as const))
  let outsideChanged = 0
  let donorMismatch = 0
  for (let y = 0; y < baseline.height; y += 1) {
    for (let x = 0; x < baseline.width; x += 1) {
      const offset = (y * baseline.width + x) * 4
      const inside = x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height
      const expected = exactCopy.get(`${x}:${y}`) ?? (inside
        ? donor.pixels.slice(offset, offset + 4)
        : baseline.pixels.slice(offset, offset + 4))
      if (candidate.pixels.slice(offset, offset + 4).some((channel, index) => channel !== expected[index])) {
        if (inside) donorMismatch += 1
        else outsideChanged += 1
      }
    }
  }
  if (outsideChanged !== 0 || donorMismatch !== 0) {
    throw new RunRecordError(
      "CHECKS_NOT_PASSED",
      `Fidelity failed with ${outsideChanged} outside-region changes and ${donorMismatch} owned-region mismatches.`,
      "repair-evidence",
    )
  }
  return [
    { name: "integrity", passed: true, measured: 0 },
    { name: "media", passed: true, measured: 0 },
    { name: "outside-region-preservation", passed: true, measured: outsideChanged },
    { name: "donor-equality-inside-region", passed: true, measured: donorMismatch },
  ]
}

const validateChecksDocument = (
  document: unknown,
  expectedBindings: AssemblyBindings,
  recomputed: ReadonlyArray<Readonly<{ name: typeof expectedCheckNames[number]; passed: true; measured: number }>>,
): void => {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence must be a JSON object.", "repair-evidence")
  }
  const record = document as Readonly<Record<string, unknown>>
  const checks = record.checks
  const inputs = record.inputs
  if (
    Object.keys(record).sort().join(",") !== "algorithm,candidateSha256,checks,classification,inputs" ||
    record.algorithm !== verificationAlgorithm ||
    record.candidateSha256 !== expectedBindings.outputSha256 ||
    record.classification !== "verified-candidate" ||
    inputs === null || typeof inputs !== "object" || Array.isArray(inputs) ||
    Object.keys(inputs).sort().join(",") !== "baselineSha256,candidateSha256,donorSha256,exactCopySha256,regionSha256" ||
    canonicalJson(inputs as JsonValue) !== canonicalJson({
      baselineSha256: expectedBindings.baselineSha256,
      candidateSha256: expectedBindings.outputSha256,
      donorSha256: expectedBindings.donorSha256,
      exactCopySha256: expectedBindings.exactCopySha256,
      regionSha256: expectedBindings.regionSha256,
    }) ||
    !Array.isArray(checks) ||
    canonicalJson(checks as JsonValue) !== canonicalJson(recomputed as unknown as JsonValue)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence does not bind the immutable plan, verified inputs, and recomputed result.", "repair-evidence")
  }
  for (const [index, expectedName] of expectedCheckNames.entries()) {
    const check = checks[index]
    if (
      check === null || typeof check !== "object" || Array.isArray(check) ||
      Object.keys(check).sort().join(",") !== "measured,name,passed"
    ) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence is malformed.", "repair-evidence")
    }
    const item = check as Readonly<Record<string, unknown>>
    if (
      item.name !== expectedName || item.passed !== true ||
      typeof item.measured !== "number" || !Number.isSafeInteger(item.measured) || item.measured < 0
    ) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "Every Fidelity Check must pass in the mandatory order.", "repair-evidence")
    }
  }
}

const validateVideoReport = (
  runRequest: CanonicalRunRequest,
  document: unknown,
  evidence: ReadonlyArray<RunRecordView["evidence"][number]>,
  completedCount: number | undefined,
  costState: "actual" | "estimated-only" | "unknown" | undefined,
  actualCostUsd: string | undefined,
  evidenceBytes: Readonly<Record<string, Uint8Array>>,
): void => {
  if (
    runRequest.mode !== "seedance-video" || runRequest.videoPlan === undefined ||
    document === null || typeof document !== "object" || Array.isArray(document)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks require the immutable Seedance Video Plan.", "repair-evidence")
  }
  const report = document as Readonly<Record<string, unknown>>
  const outputs = report.outputs
  const checks = report.checks
  const expectedOutputEvidence = evidence.filter((item) =>
    item.applicationPath.startsWith("outputs/") && item.mediaType === "video/mp4")
  if (
    Object.keys(report).sort().join(",") !== "algorithm,checks,classification,completedCount,cost,expected,outputs,requestedCount" ||
    report.algorithm !== "seedance-media-v1" || report.classification !== "verified-candidate" ||
    report.requestedCount !== runRequest.requestedCount || report.completedCount !== completedCount ||
    canonicalJson(report.expected as JsonValue) !== canonicalJson(runRequest.videoPlan.expectedMedia as unknown as JsonValue) ||
    !Array.isArray(outputs) || outputs.length !== runRequest.requestedCount ||
    expectedOutputEvidence.length !== runRequest.requestedCount ||
    !Array.isArray(checks) ||
    canonicalJson(checks as JsonValue) !== canonicalJson([
      { name: "integrity", passed: true, measured: 0 },
      { name: "media", passed: true, measured: 0 },
      { name: "dimensions", passed: true, measured: 0 },
      { name: "duration", passed: true, measured: 0 },
      { name: "audio-expectation", passed: true, measured: 0 },
    ])
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks do not bind the immutable plan, counts, and mandatory checks.", "repair-evidence")
  }
  const cost = report.cost
  if (
    cost === null || typeof cost !== "object" || Array.isArray(cost) ||
    canonicalJson(cost as JsonValue) !== canonicalJson({
      state: costState,
      estimatedMaximumCostUsd: runRequest.estimatedMaximumCostUsd,
      ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
    } as JsonValue)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks cost evidence contradicts the recorded Run cost state.", "repair-evidence")
  }
  const coveredOutputs = new Set<string>()
  for (const outputValue of outputs) {
    if (outputValue === null || typeof outputValue !== "object" || Array.isArray(outputValue)) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "Video output checks are malformed.", "repair-evidence")
    }
    const output = outputValue as Readonly<Record<string, unknown>>
    const outputIdentity = `${String(output.applicationPath)}\0${String(output.sha256)}`
    const matchingEvidence = expectedOutputEvidence.find((item) =>
      item.applicationPath === output.applicationPath && item.sha256 === output.sha256)
    const actual = output.actual
    const outputBytes = matchingEvidence === undefined ? undefined : evidenceBytes[matchingEvidence.applicationPath]
    const recomputed = outputBytes === undefined ? undefined : inspectVideoForReplay(outputBytes)
    if (
      matchingEvidence === undefined || coveredOutputs.has(outputIdentity) || output.mediaType !== "video/mp4" ||
      outputBytes === undefined || sha256(outputBytes) !== matchingEvidence.sha256 || recomputed === undefined ||
      actual === null || typeof actual !== "object" || Array.isArray(actual) ||
      canonicalJson(actual as JsonValue) !== canonicalJson(recomputed as unknown as JsonValue) ||
      recomputed.width !== runRequest.videoPlan.expectedMedia.width ||
      recomputed.height !== runRequest.videoPlan.expectedMedia.height ||
      Math.abs(recomputed.durationSeconds - runRequest.videoPlan.expectedMedia.durationSeconds) > 0.001 ||
      recomputed.hasAudio !== runRequest.videoPlan.expectedMedia.audioExpected
    ) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "Video output checks do not match persisted output evidence.", "repair-evidence")
    }
    coveredOutputs.add(outputIdentity)
  }
  if (expectedOutputEvidence.some((item) => !coveredOutputs.has(`${item.applicationPath}\0${item.sha256}`))) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks must cover every persisted output exactly once.", "repair-evidence")
  }
}

const readReplayUint32 = (value: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > value.byteLength) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 box is truncated.", "repair-evidence")
  }
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset)
}

const readReplayUint64 = (value: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 8 > value.byteLength) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 box is truncated.", "repair-evidence")
  }
  const parsed = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(offset)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 box is too large to inspect safely.", "repair-evidence")
  }
  return Number(parsed)
}

type ReplayMp4Box = Readonly<{
  type: string
  contentStart: number
  end: number
}>

const replayBoxes = (
  value: Uint8Array,
  start = 0,
  end = value.byteLength,
): ReadonlyArray<ReplayMp4Box> => {
  const found: Array<ReplayMp4Box> = []
  let cursor = start
  while (cursor < end) {
    if (end - cursor < 8) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 hierarchy is truncated.", "repair-evidence")
    }
    const declaredSize = readReplayUint32(value, cursor)
    const type = Buffer.from(value.subarray(cursor + 4, cursor + 8)).toString("ascii")
    let headerSize = 8
    let size = declaredSize
    if (declaredSize === 1) {
      headerSize = 16
      size = readReplayUint64(value, cursor + 8)
    } else if (declaredSize === 0) {
      size = end - cursor
    }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerSize || cursor + size > end) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 hierarchy is malformed.", "repair-evidence")
    }
    found.push({ type, contentStart: cursor + headerSize, end: cursor + size })
    cursor += size
  }
  if (cursor !== end) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 hierarchy is malformed.", "repair-evidence")
  }
  return found
}

const requireReplayBox = (boxes: ReadonlyArray<ReplayMp4Box>, type: string): ReplayMp4Box => {
  const box = boxes.find((candidate) => candidate.type === type)
  if (box === undefined) {
    throw new RunRecordError("CHECKS_NOT_PASSED", `The replayed MP4 is missing its ${type} box.`, "repair-evidence")
  }
  return box
}

type ReplayMp4MediaKind = "video" | "audio"

const replaySampleDescriptionKinds = (
  value: Uint8Array,
  stsd: ReplayMp4Box,
): ReadonlyArray<ReplayMp4MediaKind | "unknown"> | undefined => {
  if (stsd.contentStart + 8 > stsd.end) return undefined
  const count = readReplayUint32(value, stsd.contentStart + 4)
  if (count < 1) return undefined
  const kinds: Array<ReplayMp4MediaKind | "unknown"> = []
  let cursor = stsd.contentStart + 8
  for (let index = 0; index < count; index += 1) {
    if (cursor + 8 > stsd.end) return undefined
    const size = readReplayUint32(value, cursor)
    if (size < 8 || cursor + size > stsd.end) return undefined
    const codec = Buffer.from(value.subarray(cursor + 4, cursor + 8)).toString("ascii")
    kinds.push(/^(?:avc1|avc3|hvc1|hev1|av01|vp09|mp4v)$/.test(codec)
      ? "video"
      : /^(?:mp4a|ac-3|ec-3|Opus)$/.test(codec) ? "audio" : "unknown")
    cursor += size
  }
  return cursor === stsd.end ? kinds : undefined
}

const replaySampleTableMediaKind = (
  value: Uint8Array,
  stbl: ReplayMp4Box,
): ReplayMp4MediaKind | "invalid" | undefined => {
  const stsd = replayBoxes(value, stbl.contentStart, stbl.end).find((box) => box.type === "stsd")
  if (stsd === undefined) return undefined
  const kinds = replaySampleDescriptionKinds(value, stsd)
  if (kinds === undefined) return "invalid"
  const recognized = new Set(kinds.filter((kind): kind is ReplayMp4MediaKind => kind !== "unknown"))
  return recognized.size > 1 ? "invalid" : recognized.values().next().value
}

const validReplaySampleTable = (
  value: Uint8Array,
  stbl: ReplayMp4Box,
  mediaData: ReadonlyArray<ReplayMp4Box>,
  mediaKind: ReplayMp4MediaKind,
): boolean => {
  const children = replayBoxes(value, stbl.contentStart, stbl.end)
  const stsd = children.find((box) => box.type === "stsd")
  const stts = children.find((box) => box.type === "stts")
  const stsc = children.find((box) => box.type === "stsc")
  const stsz = children.find((box) => box.type === "stsz")
  const offsets = children.find((box) => box.type === "stco" || box.type === "co64")
  if (
    stsd === undefined || stts === undefined || stsc === undefined || stsz === undefined || offsets === undefined ||
    stsd.contentStart + 16 > stsd.end || stts.contentStart + 8 > stts.end ||
    stsc.contentStart + 8 > stsc.end || stsz.contentStart + 12 > stsz.end ||
    offsets.contentStart + 12 > offsets.end
  ) return false
  const descriptionCount = readReplayUint32(value, stsd.contentStart + 4)
  const timingCount = readReplayUint32(value, stts.contentStart + 4)
  const chunkMapCount = readReplayUint32(value, stsc.contentStart + 4)
  const offsetCount = readReplayUint32(value, offsets.contentStart + 4)
  const offsetWidth = offsets.type === "co64" ? 8 : 4
  if (
    descriptionCount < 1 || timingCount < 1 || chunkMapCount < 1 || offsetCount < 1 ||
    stts.contentStart + 8 + timingCount * 8 > stts.end ||
    stsc.contentStart + 8 + chunkMapCount * 12 > stsc.end ||
    offsets.contentStart + 8 + offsetCount * offsetWidth > offsets.end
  ) return false
  const descriptionKinds = replaySampleDescriptionKinds(value, stsd)
  if (descriptionKinds === undefined || descriptionKinds.length !== descriptionCount) return false
  for (let index = 0; index < chunkMapCount; index += 1) {
    const entryOffset = stsc.contentStart + 8 + index * 12
    const firstChunk = readReplayUint32(value, entryOffset)
    const samplesPerChunk = readReplayUint32(value, entryOffset + 4)
    const descriptionIndex = readReplayUint32(value, entryOffset + 8)
    if (
      firstChunk < 1 || samplesPerChunk < 1 || descriptionIndex < 1 ||
      descriptionIndex > descriptionKinds.length || descriptionKinds[descriptionIndex - 1] !== mediaKind
    ) return false
  }
  const sampleSize = readReplayUint32(value, stsz.contentStart + 4)
  const sampleCount = readReplayUint32(value, stsz.contentStart + 8)
  if (sampleCount < 1) return false
  let timingSampleCount = 0
  for (let index = 0; index < timingCount; index += 1) {
    const entryOffset = stts.contentStart + 8 + index * 8
    const entrySamples = readReplayUint32(value, entryOffset)
    const sampleDelta = readReplayUint32(value, entryOffset + 4)
    if (entrySamples < 1 || sampleDelta < 1) return false
    timingSampleCount += entrySamples
  }
  if (!Number.isSafeInteger(timingSampleCount) || timingSampleCount !== sampleCount) return false
  let sampleBytes = sampleSize * sampleCount
  if (sampleSize === 0) {
    if (stsz.contentStart + 12 + sampleCount * 4 > stsz.end) return false
    sampleBytes = 0
    for (let index = 0; index < sampleCount; index += 1) {
      sampleBytes += readReplayUint32(value, stsz.contentStart + 12 + index * 4)
    }
  }
  const chunkOffsets = Array.from({ length: offsetCount }, (_, index) => offsetWidth === 8
    ? readReplayUint64(value, offsets.contentStart + 8 + index * offsetWidth)
    : readReplayUint32(value, offsets.contentStart + 8 + index * offsetWidth))
  const totalMediaBytes = mediaData.reduce((total, box) => total + box.end - box.contentStart, 0)
  return chunkOffsets.every((offset) => mediaData.some((box) => offset >= box.contentStart && offset < box.end)) &&
    Number.isSafeInteger(sampleBytes) && sampleBytes > 0 && sampleBytes <= totalMediaBytes
}

type ReplayDecodedVideo = Readonly<{
  width: number
  height: number
  durationSeconds: number
  hasAudio: boolean
}>

const parseReplayFramehash = (value: string): ReplayDecodedVideo | undefined => {
  const timebases = new Map<number, Readonly<{ numerator: number; denominator: number }>>()
  const mediaTypes = new Map<number, string>()
  const dimensions = new Map<number, Readonly<{ width: number; height: number }>>()
  const frameEnds = new Map<number, number>()
  for (const line of value.split(/\r?\n/)) {
    let match = /^#tb (\d+): (\d+)\/(\d+)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1]); const numerator = Number(match[2]); const denominator = Number(match[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(numerator) || numerator < 1 ||
          !Number.isSafeInteger(denominator) || denominator < 1 || timebases.has(stream)) return undefined
      timebases.set(stream, { numerator, denominator }); continue
    }
    match = /^#media_type (\d+): (video|audio)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1])
      if (!Number.isSafeInteger(stream) || mediaTypes.has(stream)) return undefined
      mediaTypes.set(stream, match[2]!); continue
    }
    match = /^#dimensions (\d+): (\d+)x(\d+)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1]); const width = Number(match[2]); const height = Number(match[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(width) || width < 1 ||
          !Number.isSafeInteger(height) || height < 1 || dimensions.has(stream)) return undefined
      dimensions.set(stream, { width, height }); continue
    }
    if (/^\s*\d+\s*,/.test(line)) {
      const fields = line.split(",").map((field) => field.trim())
      if (fields.length < 5) return undefined
      const stream = Number(fields[0]); const pts = Number(fields[1]); const frameDuration = Number(fields[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(pts) ||
          !Number.isSafeInteger(frameDuration) || frameDuration < 1) return undefined
      const end = pts + frameDuration
      if (!Number.isSafeInteger(end)) return undefined
      frameEnds.set(stream, Math.max(frameEnds.get(stream) ?? Number.NEGATIVE_INFINITY, end))
    }
  }
  const videos = [...mediaTypes].filter(([, kind]) => kind === "video").map(([stream]) => stream)
  if (videos.length !== 1) return undefined
  const stream = videos[0]!
  const timebase = timebases.get(stream); const size = dimensions.get(stream); const frameEnd = frameEnds.get(stream)
  if (timebase === undefined || size === undefined || frameEnd === undefined || frameEnd < 1) return undefined
  const durationSeconds = frameEnd * timebase.numerator / timebase.denominator
  return Number.isFinite(durationSeconds) && durationSeconds > 0
    ? { ...size, durationSeconds, hasAudio: [...mediaTypes.values()].includes("audio") }
    : undefined
}

const requireReplayDecodableVideo = (value: Uint8Array): ReplayDecodedVideo => {
  const version = spawnSync(
    "/usr/bin/ffmpeg",
    ["-version"],
    {
      timeout: 5_000,
      maxBuffer: 65_536,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
      encoding: "utf8",
    },
  )
  const firstLine = version.stdout?.split("\n", 1)[0] ?? ""
  if (version.error !== undefined || version.status !== 0 || !/^ffmpeg version 6(?:\.|\s)/.test(firstLine)) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "FFmpeg 6 is required to replay video evidence.", "repair-evidence")
  }
  const result = spawnSync(
    "/usr/bin/ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
      "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
      "-f", "framehash", "-",
    ],
    {
      input: value,
      timeout: 15_000,
      maxBuffer: 1_048_576,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
      encoding: "utf8",
    },
  )
  const decoded = result.error === undefined && result.status === 0 ? parseReplayFramehash(result.stdout) : undefined
  if (decoded === undefined) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 video stream could not be decoded safely.", "repair-evidence")
  }
  return decoded
}

const inspectVideoForReplay = (
  value: Uint8Array,
): Readonly<{ width: number; height: number; durationSeconds: number; hasAudio: boolean }> => {
  const topLevel = replayBoxes(value)
  requireReplayBox(topLevel, "ftyp")
  const moov = requireReplayBox(topLevel, "moov")
  const mediaData = topLevel.filter((box) => box.type === "mdat" && box.end > box.contentStart)
  if (mediaData.length === 0) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 has no media data.", "repair-evidence")
  }
  const movie = replayBoxes(value, moov.contentStart, moov.end)
  const mvhd = requireReplayBox(movie, "mvhd")
  const version = value[mvhd.contentStart]
  if (
    (version === 0 && mvhd.contentStart + 20 > mvhd.end) ||
    (version === 1 && mvhd.contentStart + 32 > mvhd.end)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 movie timing is truncated.", "repair-evidence")
  }
  const timescale = version === 0
    ? readReplayUint32(value, mvhd.contentStart + 12)
    : version === 1
      ? readReplayUint32(value, mvhd.contentStart + 20)
      : 0
  const duration = version === 0
    ? readReplayUint32(value, mvhd.contentStart + 16)
    : version === 1
      ? readReplayUint64(value, mvhd.contentStart + 24)
      : 0
  let videoTrack: Readonly<{ width: number; height: number }> | undefined
  let hasAudio = false
  for (const track of movie.filter((box) => box.type === "trak")) {
    const trackChildren = replayBoxes(value, track.contentStart, track.end)
    const tkhd = requireReplayBox(trackChildren, "tkhd")
    const mdia = requireReplayBox(trackChildren, "mdia")
    const mediaChildren = replayBoxes(value, mdia.contentStart, mdia.end)
    const hdlr = requireReplayBox(mediaChildren, "hdlr")
    const minf = requireReplayBox(mediaChildren, "minf")
    if (hdlr.contentStart + 12 > hdlr.end || tkhd.end - tkhd.contentStart < 8) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 track metadata is truncated.", "repair-evidence")
    }
    const handler = Buffer.from(value.subarray(hdlr.contentStart + 8, hdlr.contentStart + 12)).toString("ascii")
    const stbl = requireReplayBox(replayBoxes(value, minf.contentStart, minf.end), "stbl")
    const declaredKind: ReplayMp4MediaKind | undefined = handler === "vide"
      ? "video"
      : handler === "soun" ? "audio" : undefined
    const codecKind = replaySampleTableMediaKind(value, stbl)
    if (codecKind === "invalid" || codecKind === undefined) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 sample descriptions are unsupported or malformed.", "repair-evidence")
    }
    if (declaredKind !== codecKind) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 track handler contradicts its media codec.", "repair-evidence")
    }
    const sampleTableValid = validReplaySampleTable(value, stbl, mediaData, codecKind)
    if (!sampleTableValid) {
      throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 video or audio sample table is malformed.", "repair-evidence")
    }
    if (codecKind === "video") {
      if (videoTrack !== undefined) {
        throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 contains multiple ambiguous video tracks.", "repair-evidence")
      }
      videoTrack = {
        width: readReplayUint32(value, tkhd.end - 8) / 65_536,
        height: readReplayUint32(value, tkhd.end - 4) / 65_536,
      }
    } else if (codecKind === "audio") {
      hasAudio = true
    }
  }
  if (videoTrack === undefined) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 has no structurally valid video sample track.", "repair-evidence")
  }
  const { width, height } = videoTrack
  if (
    timescale === 0 || duration === 0 ||
    !Number.isSafeInteger(width) || width < 1 ||
    !Number.isSafeInteger(height) || height < 1
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "The replayed MP4 dimensions or duration are invalid.", "repair-evidence")
  }
  const metadataDuration = duration / timescale
  const decoded = requireReplayDecodableVideo(value)
  if (
    decoded.width !== width || decoded.height !== height ||
    Math.abs(decoded.durationSeconds - metadataDuration) > 0.001 || decoded.hasAudio !== hasAudio
  ) throw new RunRecordError("CHECKS_NOT_PASSED", "Decoded media contradicts the replayed MP4 metadata.", "repair-evidence")
  return decoded
}

const replay = (
  runId: string,
  request: Uint8Array,
  events: ReadonlyArray<RunEvent>,
  evidenceBytes: Readonly<Record<string, Uint8Array>> = {},
): RunRecordView => {
  verifyEvents(runId, events)
  const genesis = events[0]
  if (genesis === undefined || genesis.kind !== "attempt_reserved" || genesis.previousEventSha256 !== null) {
    throw new RunRecordError("EVENT_CHAIN_BROKEN", "The journal must begin with one attempt reservation.", "repair-evidence")
  }
  const requestSha256 = sha256(request)
  if (runIdentity(requestSha256) !== runId) {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request no longer matches the Run identity.", "repair-evidence")
  }
  let canonicalRequest: JsonValue
  try {
    canonicalRequest = JSON.parse(Buffer.from(request).toString("utf8")) as JsonValue
  } catch {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request is not valid JSON.", "repair-evidence")
  }
  if (
    canonicalRequest === null ||
    typeof canonicalRequest !== "object" ||
    Array.isArray(canonicalRequest) ||
    canonicalJson(canonicalRequest) !== Buffer.from(request).toString("utf8")
  ) {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request is not canonical JSON.", "repair-evidence")
  }
  const requestDocument = canonicalRequest as Readonly<Record<string, JsonValue>>
  const runRequest = recordedRequest(canonicalRequest, "repair-evidence")
  if (stringPayload(genesis.payload, "requestSha256") !== requestSha256) {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request bytes changed.", "repair-evidence")
  }
  const linkedFrom = linkPayload(genesis.payload)
  if (
    stringPayload(genesis.payload, "estimatedMaximumCostUsd") !== requestDocument.estimatedMaximumCostUsd ||
    numberPayload(genesis.payload, "maximumCount") !== requestDocument.requestedCount ||
    stringPayload(genesis.payload, "maximumSpendUsd") !== requestDocument.budgetCeilingUsd ||
    numberPayload(genesis.payload, "maximumCorrectionRuns") !== requestDocument.maximumCorrectionRuns ||
    numberPayload(genesis.payload, "correctionDepth") < 0 ||
    numberPayload(genesis.payload, "correctionDepth") > numberPayload(genesis.payload, "maximumCorrectionRuns") ||
    canonicalJson((linkedFrom ?? null) as unknown as JsonValue) !==
      canonicalJson((requestDocument.linkedRun ?? null) as JsonValue)
  ) {
    throw new RunRecordError("REQUEST_TAMPERED", "The attempt reservation contradicts its immutable Run Request.", "repair-evidence")
  }
  const base = {
    runId,
    requestSha256,
    attemptId: stringPayload(genesis.payload, "attemptId"),
    payloadSha256: stringPayload(genesis.payload, "payloadSha256"),
    estimatedMaximumCostUsd: stringPayload(genesis.payload, "estimatedMaximumCostUsd"),
    maximumCount: numberPayload(genesis.payload, "maximumCount"),
    maximumSpendUsd: stringPayload(genesis.payload, "maximumSpendUsd"),
    maximumCorrectionRuns: numberPayload(genesis.payload, "maximumCorrectionRuns"),
    correctionDepth: numberPayload(genesis.payload, "correctionDepth"),
    chainHeadSha256: events.at(-1)!.eventSha256,
    evidence: [] as RunRecordView["evidence"],
    ...(linkedFrom === undefined ? {} : { linkedFrom }),
  }
  let phase: RunRecordView["phase"] = "reserved"
  let spendState: RunRecordView["spendState"] = "not_spent"
  let retryState: RunRecordView["retryState"] = "same-run-submission-available"
  const evidence: Array<RunRecordView["evidence"][number]> = []
  let donorCandidateSha256s: ReadonlyArray<string> | undefined
  let selectedDonorSha256: string | undefined
  let assemblyOutputPath: string | undefined
  let assemblyOutputSha256: string | undefined
  let assemblyReportSha256: string | undefined
  let checksSha256: string | undefined
  let classification: RunRecordView["classification"]
  let providerJobId: string | undefined
  let pollCount = 0
  let completedCount: number | undefined
  let costState: "actual" | "estimated-only" | "unknown" | undefined
  let actualCostUsd: string | undefined
  let providerEvidenceIntent: Readonly<{
    completionOperationId: string
    sha256: string
    byteLength: number
    mediaType: string
  }> | undefined
  let classifiedOutcomeIntent: Readonly<{
    completionOperationId: string
    sha256: string
    byteLength: number
    failureClass: ClassifiedFailureClass
    previousEventSha256: string
  }> | undefined
  let finding: RunRecordView["finding"]
  let linkedCorrectionRunId: string | undefined
  let linkedCorrectionRequestSha256: string | undefined
  for (const event of events.slice(1)) {
    if (event.kind === "submission_may_have_started") {
      if (phase !== "reserved" || stringPayload(event.payload, "attemptId") !== base.attemptId) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Submission uncertainty was recorded out of order.")
      }
      phase = "submission_may_have_started"
      spendState = "possibly_spent"
      retryState = "reconcile-only"
      continue
    }
    if (event.kind === "provider_evidence_intent") {
      if (phase !== "submission_may_have_started" || providerEvidenceIntent !== undefined) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence intent was recorded out of order.")
      }
      const completionOperationId = stringPayload(event.payload, "completionOperationId")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const mediaType = stringPayload(event.payload, "mediaType")
      if (!isIdentifier(completionOperationId) || !isSha256(evidenceSha256) || byteLength < 1 || mediaType !== "application/json") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence intent is malformed.")
      }
      providerEvidenceIntent = { completionOperationId, sha256: evidenceSha256, byteLength, mediaType }
      continue
    }
    if (event.kind === "provider_evidence_received") {
      if (phase !== "submission_may_have_started") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence was recorded before submission uncertainty.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const mediaType = stringPayload(event.payload, "mediaType")
      if (providerEvidenceIntent !== undefined && (
        providerEvidenceIntent.completionOperationId !== event.operationId ||
        providerEvidenceIntent.sha256 !== evidenceSha256 ||
        providerEvidenceIntent.byteLength !== byteLength ||
        providerEvidenceIntent.mediaType !== mediaType
      )) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence receipt contradicts its durable intent.", "repair-evidence")
      }
      const storedEvidence = evidenceBytes[applicationPath]
      if (mediaType !== "application/json" || storedEvidence === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is named by the journal but missing.`, "repair-evidence")
      }
      if (storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", `${applicationPath} no longer matches its event receipt.`, "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType })
      const providerSource = Buffer.from(storedEvidence).toString("utf8")
      if (hasDuplicateJsonKeys(providerSource)) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence contains duplicate JSON keys.", "repair-evidence")
      }
      let providerDocument: unknown
      try {
        providerDocument = JSON.parse(providerSource)
      } catch {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence is not valid JSON.", "repair-evidence")
      }
      if (runRequest.mode === "seedance-video") {
        const provider = providerDocument as Readonly<Record<string, unknown>>
        if (
          providerDocument === null || typeof providerDocument !== "object" || Array.isArray(providerDocument) ||
          hasProviderCredentialMaterial(providerDocument) ||
          !isSanitizedProviderDocument("seedance-submission", providerDocument) ||
          typeof provider.job_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider.job_id) ||
          (provider.status !== "submitted" && provider.status !== "queued")
        ) {
          throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance provider evidence must bind one sanitized submitted job.", "repair-evidence")
        }
        providerJobId = provider.job_id
      } else if (!isSanitizedProviderDocument("qwen", providerDocument)) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Qwen provider evidence must match its sanitized receipt schema.", "repair-evidence")
      }
      phase = "provider_evidence_received"
      providerEvidenceIntent = undefined
      spendState = "unknown"
      retryState = "never-resubmit"
      continue
    }
    if (event.kind === "seedance_poll_persisted") {
      if (
        runRequest.mode !== "seedance-video" || phase !== "provider_evidence_received" ||
        providerJobId === undefined || stringPayload(event.payload, "jobId") !== providerJobId
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Seedance polling must continue the persisted submitted job.")
      }
      const status = stringPayload(event.payload, "status")
      if (status !== "pending" && status !== "completed") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Seedance poll status is invalid.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const mediaType = stringPayload(event.payload, "mediaType")
      const pollEvidence = evidenceBytes[applicationPath]
      const expectedPollPath = `polls/poll-${String(pollCount + 1).padStart(4, "0")}.json`
      if (
        applicationPath !== expectedPollPath || mediaType !== "application/json" || pollEvidence === undefined ||
        pollEvidence.byteLength !== byteLength || sha256(pollEvidence) !== evidenceSha256 ||
        evidence.some((item) => item.applicationPath === applicationPath)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence is missing, out of order, or changed.", "repair-evidence")
      }
      let pollDocument: unknown
      const pollSource = Buffer.from(pollEvidence).toString("utf8")
      if (hasDuplicateJsonKeys(pollSource)) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence contains duplicate JSON keys.", "repair-evidence")
      }
      try {
        pollDocument = JSON.parse(pollSource)
      } catch {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence is not valid JSON.", "repair-evidence")
      }
      const poll = pollDocument as Readonly<Record<string, unknown>>
      if (
        pollDocument === null || typeof pollDocument !== "object" || Array.isArray(pollDocument) ||
        hasProviderCredentialMaterial(pollDocument) ||
        !isSanitizedProviderDocument("seedance-poll", pollDocument) ||
        poll.job_id !== providerJobId || poll.status !== status
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence substituted its job identity or status.", "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType: "application/json" })
      pollCount += 1
      if (status === "completed") {
        const outputs = event.payload.outputs
        const eventCompletedCount = numberPayload(event.payload, "completedCount")
        const eventCostState = stringPayload(event.payload, "costState")
        if (
          !Array.isArray(outputs) || eventCompletedCount !== base.maximumCount ||
          outputs.length !== eventCompletedCount ||
          (eventCostState !== "actual" && eventCostState !== "estimated-only" && eventCostState !== "unknown")
        ) {
          throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Seedance completion contradicts the reserved count or cost state.", "repair-evidence")
        }
        const outputPaths = new Set<string>()
        for (const outputValue of outputs) {
          if (outputValue === null || typeof outputValue !== "object" || Array.isArray(outputValue)) {
            throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance output receipt is malformed.", "repair-evidence")
          }
          const output = outputValue as Readonly<Record<string, JsonValue>>
          const outputPath = stringPayload(output, "applicationPath")
          const outputSha256 = stringPayload(output, "sha256")
          const outputByteLength = numberPayload(output, "byteLength")
          const outputMediaType = stringPayload(output, "mediaType")
          const outputBytes = evidenceBytes[outputPath]
          if (
            !/^outputs\/[a-z0-9][a-z0-9._-]*\.mp4$/.test(outputPath) || outputPaths.has(outputPath) ||
            outputMediaType !== "video/mp4" || !isSha256(outputSha256) || outputBytes === undefined ||
            outputBytes.byteLength !== outputByteLength || sha256(outputBytes) !== outputSha256 ||
            evidence.some((item) => item.applicationPath === outputPath)
          ) {
            throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance output evidence is unsafe, missing, or changed.", "repair-evidence")
          }
          outputPaths.add(outputPath)
          evidence.push({
            applicationPath: outputPath,
            sha256: outputSha256,
            byteLength: outputByteLength,
            mediaType: outputMediaType,
          })
        }
        const eventActualCost = event.payload.actualCostUsd
        if (
          (eventCostState === "actual" &&
            (typeof eventActualCost !== "string" || !/^(?:0|[1-9]\d*)\.\d{2,6}$/.test(eventActualCost))) ||
          (eventCostState !== "actual" && eventActualCost !== undefined)
        ) {
          throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance actual-cost evidence is malformed.", "repair-evidence")
        }
        completedCount = eventCompletedCount
        costState = eventCostState
        actualCostUsd = typeof eventActualCost === "string" ? eventActualCost : undefined
        phase = "generated_outputs_received"
      }
      continue
    }
    if (event.kind === "generated_output_persisted") {
      if (
        runRequest.mode !== "qwen-image" ||
        (phase !== "provider_evidence_received" && phase !== "generated_outputs_received")
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Generated output evidence was recorded before provider evidence.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const mediaType = stringPayload(event.payload, "mediaType")
      const storedEvidence = evidenceBytes[applicationPath]
      if (
        !/^outputs\/[a-z0-9][a-z0-9._-]*\.rgba\.json$/.test(applicationPath) ||
        mediaType !== "application/vnd.qwen.rgba+json" ||
        !isSha256(evidenceSha256) ||
        evidence.some((item) =>
          item.applicationPath === applicationPath ||
          (item.applicationPath.startsWith("outputs/") && item.sha256 === evidenceSha256))
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output journal metadata is unsafe or malformed.", "repair-evidence")
      }
      if (evidence.filter((item) => item.applicationPath.startsWith("outputs/")).length >= base.maximumCount) {
        throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Generated output evidence exceeds the reserved maximum count.", "repair-evidence")
      }
      if (storedEvidence === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is named by the journal but missing.`, "repair-evidence")
      }
      if (
        storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256 ||
        !isNormalizedRgbaEvidence(storedEvidence)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", `${applicationPath} no longer matches its event receipt.`, "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType })
      phase = "generated_outputs_received"
      continue
    }
    if (event.kind === "donor_choice_opened") {
      if (runRequest.mode !== "qwen-image" || phase !== "generated_outputs_received") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A donor choice was opened before generated outputs were persisted.")
      }
      const candidates = stringArrayPayload(event.payload, "candidateSha256s")
      const generatedOutputSha256s = evidence
        .filter((item) => item.applicationPath.startsWith("outputs/"))
        .map((item) => item.sha256)
      if (
        candidates.length !== base.maximumCount ||
        generatedOutputSha256s.length !== base.maximumCount ||
        new Set(candidates).size !== candidates.length ||
        generatedOutputSha256s.some((sha256) => !candidates.includes(sha256)) ||
        candidates.some((candidate) => !evidence.some((item) =>
          item.applicationPath.startsWith("outputs/") && item.sha256 === candidate))
      ) {
        throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "The donor checkpoint does not name the complete reserved output set.", "repair-evidence")
      }
      donorCandidateSha256s = [...candidates]
      phase = "awaiting_donor_choice"
      classification = "human_decision_required"
      continue
    }
    if (event.kind === "donor_selected") {
      if (phase !== "awaiting_donor_choice" || donorCandidateSha256s === undefined) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A donor was selected without an open donor-choice checkpoint.")
      }
      const selected = stringPayload(event.payload, "selectedSha256")
      if (!donorCandidateSha256s.includes(selected) || !evidence.some((item) =>
        item.applicationPath.startsWith("outputs/") && item.sha256 === selected)) {
        throw new RunRecordError("DONOR_NOT_PERSISTED", "The selected donor is not persisted checkpoint evidence on this Run.", "repair-evidence")
      }
      selectedDonorSha256 = selected
      phase = "donor_selected"
      classification = undefined
      continue
    }
    if (event.kind === "assembly_persisted") {
      if (phase !== "donor_selected" || selectedDonorSha256 === undefined) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Assembly evidence was recorded before donor selection.")
      }
      const outputPath = stringPayload(event.payload, "outputPath")
      const outputSha256 = stringPayload(event.payload, "outputSha256")
      const outputByteLength = numberPayload(event.payload, "outputByteLength")
      const outputMediaType = stringPayload(event.payload, "outputMediaType")
      const reportPath = stringPayload(event.payload, "reportPath")
      const reportSha256 = stringPayload(event.payload, "reportSha256")
      const reportByteLength = numberPayload(event.payload, "reportByteLength")
      const outputBytes = evidenceBytes[outputPath]
      const reportBytes = evidenceBytes[reportPath]
      if (evidence.some((item) => item.applicationPath === outputPath || item.applicationPath === reportPath)) {
        throw new RunRecordError("EVIDENCE_REWRITE", "Assembly must create new evidence destinations.", "repair-evidence")
      }
      if (outputBytes === undefined || reportBytes === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", "Assembly output or report evidence is missing.", "repair-evidence")
      }
      if (
        outputBytes.byteLength !== outputByteLength || sha256(outputBytes) !== outputSha256 ||
        reportBytes.byteLength !== reportByteLength || sha256(reportBytes) !== reportSha256
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Assembly output or report no longer matches its event receipt.", "repair-evidence")
      }
      let report: unknown
      try {
        report = JSON.parse(Buffer.from(reportBytes).toString("utf8"))
      } catch {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The Assembly report is not valid JSON.", "repair-evidence")
      }
      if (
        report === null || typeof report !== "object" || Array.isArray(report) ||
        canonicalJson(report as JsonValue) !== Buffer.from(reportBytes).toString("utf8")
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The Assembly report is not canonical JSON.", "repair-evidence")
      }
      const reportDocument = report as Readonly<Record<string, JsonValue>>
      const reportKeys = Object.keys(reportDocument).sort().join(",")
      const expectedBindings = expectedPlanBindings(runRequest, selectedDonorSha256, outputSha256)
      if (
        reportKeys !== "baselineSha256,donorSha256,exactCopySha256,outputSha256,regionSha256" ||
        !["baselineSha256", "donorSha256", "regionSha256", "exactCopySha256", "outputSha256"]
          .every((key) => typeof reportDocument[key] === "string" && isSha256(reportDocument[key] as string)) ||
        evidence.some((item) => item.applicationPath.startsWith("outputs/") && item.sha256 === outputSha256) ||
        canonicalJson(reportDocument) !== canonicalJson(expectedBindings as unknown as JsonValue)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The Assembly report does not bind the immutable plan, selected donor, and distinct assembled output.", "repair-evidence")
      }
      evidence.push(
        { applicationPath: outputPath, sha256: outputSha256, byteLength: outputByteLength, mediaType: outputMediaType },
        { applicationPath: reportPath, sha256: reportSha256, byteLength: reportByteLength, mediaType: "application/json" },
      )
      assemblyOutputSha256 = outputSha256
      assemblyOutputPath = outputPath
      assemblyReportSha256 = reportSha256
      phase = "assembly_completed"
      continue
    }
    if (event.kind === "checks_persisted") {
      if (
        phase !== "assembly_completed" || assemblyOutputSha256 === undefined ||
        assemblyOutputPath === undefined || selectedDonorSha256 === undefined
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Checks were recorded before Assembly completed.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const candidateSha256 = stringPayload(event.payload, "candidateSha256")
      const baselinePath = stringPayload(event.payload, "baselinePath")
      const baselineSha256 = stringPayload(event.payload, "baselineSha256")
      const baselineByteLength = numberPayload(event.payload, "baselineByteLength")
      const storedEvidence = evidenceBytes[applicationPath]
      const baselineBytes = evidenceBytes[baselinePath]
      const donorEvidence = evidence.find((item) =>
        item.applicationPath.startsWith("outputs/") && item.sha256 === selectedDonorSha256)
      const donorBytes = donorEvidence === undefined ? undefined : evidenceBytes[donorEvidence.applicationPath]
      const candidateBytes = evidenceBytes[assemblyOutputPath]
      if (storedEvidence === undefined || baselineBytes === undefined || donorBytes === undefined || candidateBytes === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", "Checks or one of its verified input receipts is missing.", "repair-evidence")
      }
      const expectedBindings = expectedPlanBindings(runRequest, selectedDonorSha256, assemblyOutputSha256)
      if (
        storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256 ||
        baselineBytes.byteLength !== baselineByteLength || sha256(baselineBytes) !== baselineSha256 ||
        baselineSha256 !== expectedBindings.baselineSha256 ||
        candidateSha256 !== assemblyOutputSha256
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Checks evidence no longer matches its immutable baseline and assembled candidate receipts.", "repair-evidence")
      }
      let document: unknown
      try {
        document = JSON.parse(Buffer.from(storedEvidence).toString("utf8"))
      } catch {
        throw new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence is not valid JSON.", "repair-evidence")
      }
      if (canonicalJson(document as JsonValue) !== Buffer.from(storedEvidence).toString("utf8")) {
        throw new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence is not canonical JSON.", "repair-evidence")
      }
      const receipt = document as Readonly<Record<string, JsonValue>>
      if (stringPayload(event.payload, "operationSha256") !== sha256(canonicalJson({
        baselineSha256,
        candidateSha256,
        checks: receipt.checks,
        classification: receipt.classification,
      } as JsonValue))) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The checks operation receipt contradicts its persisted evidence.", "repair-evidence")
      }
      const recomputed = recomputeChecks(runRequest, baselineBytes, donorBytes, candidateBytes)
      validateChecksDocument(document, expectedBindings, recomputed)
      evidence.push(
        {
          applicationPath: baselinePath,
          sha256: baselineSha256,
          byteLength: baselineByteLength,
          mediaType: "application/octet-stream",
        },
        {
          applicationPath,
          sha256: evidenceSha256,
          byteLength,
          mediaType: "application/json",
        },
      )
      checksSha256 = evidenceSha256
      classification = "verified_candidate"
      phase = "verified_candidate"
      continue
    }
    if (event.kind === "video_checks_persisted") {
      if (
        runRequest.mode !== "seedance-video" || phase !== "generated_outputs_received" ||
        providerJobId === undefined || stringPayload(event.payload, "jobId") !== providerJobId
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Video checks require completed output evidence for the same Seedance job.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const storedEvidence = evidenceBytes[applicationPath]
      if (
        applicationPath !== "checks.json" || storedEvidence === undefined ||
        storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256 ||
        evidence.some((item) => item.applicationPath === applicationPath)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Video checks evidence is missing or changed.", "repair-evidence")
      }
      let report: unknown
      try {
        report = JSON.parse(Buffer.from(storedEvidence).toString("utf8"))
      } catch {
        throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks evidence is not valid JSON.", "repair-evidence")
      }
      if (
        canonicalJson(report as JsonValue) !== Buffer.from(storedEvidence).toString("utf8") ||
        stringPayload(event.payload, "reportSha256") !== evidenceSha256
      ) {
        throw new RunRecordError("CHECKS_NOT_PASSED", "Video checks evidence is not canonical or bound to its receipt.", "repair-evidence")
      }
      validateVideoReport(runRequest, report, evidence, completedCount, costState, actualCostUsd, evidenceBytes)
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType: "application/json" })
      checksSha256 = evidenceSha256
      classification = "verified_candidate"
      phase = "verified_candidate"
      continue
    }
    if (event.kind === "classified_outcome_intent") {
      if (classifiedOutcomeIntent !== undefined || classification !== undefined) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A classified outcome intent was recorded after an outcome.")
      }
      const completionOperationId = stringPayload(event.payload, "completionOperationId")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const failureClass = stringPayload(event.payload, "class")
      if (
        !isIdentifier(completionOperationId) || !isSha256(evidenceSha256) || byteLength < 1 ||
        !isClassifiedFailureClass(failureClass)
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "The classified outcome intent is malformed.")
      }
      classifiedOutcomeIntent = {
        completionOperationId,
        sha256: evidenceSha256,
        byteLength,
        failureClass,
        previousEventSha256: event.previousEventSha256!,
      }
      continue
    }
    if (event.kind === "classified_outcome") {
      if (classifiedOutcomeIntent === undefined) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A classified outcome has no durable evidence intent.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const failureClass = stringPayload(event.payload, "class")
      const policy = isClassifiedFailureClass(failureClass)
        ? classifiedFailurePolicy(failureClass)
        : undefined
      if (
        applicationPath !== "failure.json" || policy === undefined ||
        classifiedOutcomeIntent.completionOperationId !== event.operationId ||
        classifiedOutcomeIntent.sha256 !== evidenceSha256 ||
        classifiedOutcomeIntent.byteLength !== byteLength ||
        classifiedOutcomeIntent.failureClass !== failureClass
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified outcome contradicts its durable intent.", "repair-evidence")
      }
      const storedFailure = evidenceBytes[applicationPath]
      if (
        storedFailure === undefined || storedFailure.byteLength !== byteLength ||
        sha256(storedFailure) !== evidenceSha256
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified failure evidence is missing or changed.", "repair-evidence")
      }
      let document: unknown
      try {
        document = JSON.parse(Buffer.from(storedFailure).toString("utf8"))
      } catch {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified failure evidence is not valid JSON.", "repair-evidence")
      }
      if (
        document === null || typeof document !== "object" || Array.isArray(document) ||
        canonicalJson(document as JsonValue) !== Buffer.from(storedFailure).toString("utf8")
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified failure evidence is not canonical JSON.", "repair-evidence")
      }
      const failure = document as Readonly<Record<string, JsonValue>>
      const message = stringPayload(failure, "message")
      const failureEvidence = failure.evidence
      const failureEvidenceRecord = failureEvidence as Readonly<Record<string, JsonValue>>
      const expectedArtifactSha256s = evidence.map((item) => item.sha256)
      if (
        Object.keys(failure).sort().join(",") !== "class,correctionOwner,evidence,message,outcome,retryState,spendState" ||
        failureEvidence === null || typeof failureEvidence !== "object" || Array.isArray(failureEvidence) ||
        Object.keys(failureEvidence).sort().join(",") !== "artifactSha256s,failureProof,requestSha256,stateEventSha256" ||
        failureEvidenceRecord.failureProof === null || typeof failureEvidenceRecord.failureProof !== "object" ||
        Array.isArray(failureEvidenceRecord.failureProof) ||
        !classifiedFailureProofMatches(failureClass as ClassifiedFailureClass, failureEvidenceRecord.failureProof, {
          phase,
          runRequest,
          evidence,
          ...(selectedDonorSha256 === undefined ? {} : { selectedDonorSha256 }),
          ...(assemblyOutputSha256 === undefined ? {} : { assemblyOutputSha256 }),
          ...(completedCount === undefined ? {} : { completedCount }),
          ...(costState === undefined ? {} : { costState }),
          ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
        }) ||
        canonicalJson(failureEvidenceRecord.artifactSha256s!) !== canonicalJson(expectedArtifactSha256s) ||
        failureEvidenceRecord.requestSha256 !== base.requestSha256 ||
        failureEvidenceRecord.stateEventSha256 !== classifiedOutcomeIntent.previousEventSha256 ||
        stringPayload(failure, "class") !== failureClass ||
        stringPayload(event.payload, "message") !== message ||
        stringPayload(failure, "correctionOwner") !== policy.correctionOwner ||
        stringPayload(failure, "outcome") !== policy.outcome ||
        stringPayload(failure, "spendState") !== policy.spendState ||
        stringPayload(failure, "retryState") !== policy.retryState ||
        message.trim().length === 0 || message.length > 500 || hasProviderCredentialMaterial(failure)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified failure evidence contradicts its fixed policy.", "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType: "application/json" })
      phase = policy.outcome
      classification = policy.outcome
      spendState = policy.spendState
      retryState = policy.retryState
      finding = { class: failureClass, message, correctionOwner: policy.correctionOwner }
      classifiedOutcomeIntent = undefined
      continue
    }
    if (event.kind === "correction_run_linked") {
      const correctionRunId = stringPayload(event.payload, "correctionRunId")
      const correctionRequestSha256 = stringPayload(event.payload, "correctionRequestSha256")
      if (
        phase !== "definitive_pre_submit_failure" || linkedCorrectionRunId !== undefined ||
        !/^run-[a-f0-9]{24}$/.test(correctionRunId) || !isSha256(correctionRequestSha256) ||
        runIdentity(correctionRequestSha256) !== correctionRunId
      ) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A definitive failure can reserve only one exact correction Run.")
      }
      linkedCorrectionRunId = correctionRunId
      linkedCorrectionRequestSha256 = correctionRequestSha256
      continue
    }
    if (event.kind === "definitive_pre_submit_failure") {
      const failureClass = stringPayload(event.payload, "class")
      const adapterRefusalAfterMarker = phase === "submission_may_have_started" && failureClass === "submission_not_started"
      if (phase !== "reserved" && !adapterRefusalAfterMarker) {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A definitive pre-submit failure was recorded after submission uncertainty.")
      }
      stringPayload(event.payload, "message")
      phase = "definitive_pre_submit_failure"
      spendState = "not_spent"
      retryState = "new-linked-run-only"
      classification = "failed"
      finding = {
        class: failureClass,
        message: stringPayload(event.payload, "message"),
        correctionOwner: "Generation",
      }
      continue
    }
    throw new RunRecordError("ILLEGAL_TRANSITION", `${event.kind} is not valid in the current Run phase.`)
  }
  return immutable({
    ...base,
    evidence,
    phase,
    spendState,
    retryState,
    ...(donorCandidateSha256s === undefined ? {} : { donorCandidateSha256s }),
    ...(selectedDonorSha256 === undefined ? {} : { selectedDonorSha256 }),
    ...(assemblyOutputSha256 === undefined ? {} : { assemblyOutputSha256 }),
    ...(assemblyReportSha256 === undefined ? {} : { assemblyReportSha256 }),
    ...(checksSha256 === undefined ? {} : { checksSha256 }),
    ...(classification === undefined ? {} : { classification }),
    ...(finding === undefined ? {} : { finding }),
    ...(linkedCorrectionRunId === undefined ? {} : { linkedCorrectionRunId }),
    ...(linkedCorrectionRequestSha256 === undefined ? {} : { linkedCorrectionRequestSha256 }),
    ...(providerJobId === undefined ? {} : { providerJobId }),
    ...(pollCount === 0 ? {} : { pollCount }),
    ...(completedCount === undefined ? {} : { completedCount }),
    ...(costState === undefined ? {} : { costState }),
    ...(actualCostUsd === undefined ? {} : { actualCostUsd }),
  })
}

const decodeStoredView = (value: Uint8Array): RunRecordView => {
  try {
    return JSON.parse(Buffer.from(value).toString("utf8")) as RunRecordView
  } catch {
    throw new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view is invalid JSON.", "repair-evidence")
  }
}

const assertDerivedViewConsistent = (
  stored: StoredRunRecord,
  events: ReadonlyArray<RunEvent>,
  view: RunRecordView,
): RunRecordView | undefined => {
  if (stored.state === undefined) return undefined
  const derived = decodeStoredView(stored.state)
  const derivedHeadIndex = events.findIndex((event) => event.eventSha256 === derived.chainHeadSha256)
  if (derivedHeadIndex < 0) {
    throw new RunRecordError(
      "DERIVED_VIEW_CONTRADICTION",
      "The derived state names an event head that is not in the verified journal.",
      "repair-evidence",
    )
  }
  const historical = replay(view.runId, stored.request, events.slice(0, derivedHeadIndex + 1), stored.evidence)
  if (canonicalJson(derived as unknown as JsonValue) !== canonicalJson(historical as unknown as JsonValue)) {
    throw new RunRecordError(
      "DERIVED_VIEW_CONTRADICTION",
      "The derived state disagrees with replay at its claimed event head.",
      "repair-evidence",
    )
  }
  return derived
}

const validateCorrectionAncestry = (
  store: RunRecordStoreService,
  view: RunRecordView,
  seen: ReadonlySet<string> = new Set(),
): Effect.Effect<void, RunRecordError> => Effect.gen(function*() {
  if (seen.has(view.runId)) {
    return yield* Effect.fail(new RunRecordError(
      "REQUEST_TAMPERED",
      "The correction ancestry contains a cycle.",
      "repair-evidence",
    ))
  }
  if (view.linkedFrom === undefined) {
    if (view.correctionDepth !== 0) {
      return yield* Effect.fail(new RunRecordError(
        "REQUEST_TAMPERED",
        "An unlinked Run must have correction depth zero.",
        "repair-evidence",
      ))
    }
    return
  }
  const parentStored = yield* store.read(view.linkedFrom.parentRunId)
  const parentEvents = yield* Effect.try({
    try: () => parseEvents(parentStored.events),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The correction parent journal could not be decoded.", "repair-evidence"),
  })
  const parent = yield* Effect.try({
    try: () => replay(view.linkedFrom!.parentRunId, parentStored.request, parentEvents, parentStored.evidence),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The correction parent journal could not be replayed.", "repair-evidence"),
  })
  yield* Effect.try({
    try: () => assertDerivedViewConsistent(parentStored, parentEvents, parent),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The correction parent view could not be verified.", "repair-evidence"),
  })
  const parentFailure = parentEvents.find((event) =>
    event.eventSha256 === view.linkedFrom!.parentFailureEventSha256)
  if (
    parentFailure?.kind !== "definitive_pre_submit_failure" ||
    parent.phase !== "definitive_pre_submit_failure" ||
    parent.linkedCorrectionRunId !== view.runId ||
    parent.linkedCorrectionRequestSha256 !== view.requestSha256 ||
    view.correctionDepth !== parent.correctionDepth + 1 ||
    view.maximumCorrectionRuns !== parent.maximumCorrectionRuns
  ) {
    return yield* Effect.fail(new RunRecordError(
      "REQUEST_TAMPERED",
      "The correction depth is not proven by the immutable parent lineage.",
      "repair-evidence",
    ))
  }
  yield* validateCorrectionAncestry(store, parent, new Set([...seen, view.runId]))
})

export const reserveRun = (
  input: ReserveRun,
): Effect.Effect<RunRecordView, RunRecordError, RunRecordStoreService | RunRecordClockService> => Effect.gen(function*() {
  const request = yield* Effect.try({
    try: () => validateReservation(input),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("INVALID_PLANNED_RUN", "The Planned Run could not be validated."),
  })
  const store = yield* RunRecordStore
  const clock = yield* RunRecordClock
  const timestamp = yield* clock.now()
  const runId = runIdentity(input.plannedRun.requestSha256)
  let correctionDepth = 0
  if (request.linkedRun !== undefined) {
    const parent = yield* loadRun(request.linkedRun.parentRunId)
    if (parent.phase !== "definitive_pre_submit_failure") {
      return yield* Effect.fail(new RunRecordError(
        "LINK_NOT_ALLOWED",
        "Only a definitive, unspent pre-submit refusal can create a correction Run.",
        "reconcile",
      ))
    }
    const isReservedSuccessor =
      parent.linkedCorrectionRunId === runId &&
      parent.linkedCorrectionRequestSha256 === input.plannedRun.requestSha256
    if (parent.linkedCorrectionRunId !== undefined && !isReservedSuccessor) {
      return yield* Effect.fail(new RunRecordError(
        "LINK_NOT_ALLOWED",
        "The definitive failure already reserved its one correction Run.",
        "new-linked-run",
      ))
    }
    if (!isReservedSuccessor && parent.chainHeadSha256 !== request.linkedRun.parentFailureEventSha256) {
      return yield* Effect.fail(new RunRecordError(
        "LINK_FAILURE_MISMATCH",
        "The successor does not name the verified definitive failure event.",
        "new-linked-run",
      ))
    }
    const parentStored = yield* store.read(parent.runId)
    const parentRequest = yield* Effect.try({
      try: () => JSON.parse(Buffer.from(parentStored.request).toString("utf8")) as CanonicalRunRequest,
      catch: () => new RunRecordError(
        "REQUEST_TAMPERED",
        "The linked parent Run Request could not be decoded.",
        "repair-evidence",
      ),
    })
    if (
      request.applicationId !== parentRequest.applicationId ||
      request.maximumCorrectionRuns !== parent.maximumCorrectionRuns ||
      parent.maximumCorrectionRuns !== parentRequest.maximumCorrectionRuns
    ) {
      return yield* Effect.fail(new RunRecordError(
        "LINK_NOT_ALLOWED",
        "A correction Run cannot change its application or correction ceiling.",
        "new-linked-run",
      ))
    }
    correctionDepth = parent.correctionDepth + 1
    if (correctionDepth > request.maximumCorrectionRuns) {
      return yield* Effect.fail(new RunRecordError(
        "CORRECTION_LIMIT_EXHAUSTED",
        "The approved correction Run limit is exhausted.",
        "new-linked-run",
      ))
    }
    if (canonicalJson(correctionMaterial(request)) === canonicalJson(correctionMaterial(parentRequest))) {
      return yield* Effect.fail(new RunRecordError(
        "CORRECTION_NOT_MATERIAL",
        "A linked correction Run must materially change the objective, references, model, procedure, or parameters.",
        "new-linked-run",
      ))
    }
    if (!isReservedSuccessor) {
      const parentEvents = yield* Effect.try({
        try: () => parseEvents(parentStored.events),
        catch: (error) => error instanceof RunRecordError
          ? error
          : new RunRecordError("EVENT_CHAIN_BROKEN", "The correction parent journal could not be decoded.", "repair-evidence"),
      })
      const linkEvent = makeEvent({
        schemaVersion: "1",
        sequence: parentEvents.length + 1,
        operationId: `link-${runId}`,
        runId: parent.runId,
        timestamp,
        kind: "correction_run_linked",
        previousEventSha256: parent.chainHeadSha256,
        payload: {
          correctionRunId: runId,
          correctionRequestSha256: input.plannedRun.requestSha256,
        },
      })
      const nextParent = replay(parent.runId, parentStored.request, [...parentEvents, linkEvent], parentStored.evidence)
      yield* store.appendEvent(parent.runId, parent.chainHeadSha256, encodeEvent(linkEvent))
      yield* store.writeState(parent.runId, encodeView(nextParent))
    }
  }
  const attemptId = `attempt-${runId.slice(4)}-1`
  const firstEvent = makeEvent({
    schemaVersion: "1",
    sequence: 1,
    operationId: `reserve-${runId}`,
    runId,
    timestamp,
    kind: "attempt_reserved",
    previousEventSha256: null,
    payload: {
      requestSha256: input.plannedRun.requestSha256,
      attemptId,
      payloadSha256: input.payloadSha256,
      estimatedMaximumCostUsd: request.estimatedMaximumCostUsd,
      maximumCount: request.requestedCount,
      maximumSpendUsd: request.budgetCeilingUsd,
      maximumCorrectionRuns: request.maximumCorrectionRuns,
      correctionDepth,
      linkedFrom: request.linkedRun === undefined ? null : request.linkedRun,
    },
  })
  const view = replay(runId, bytes(input.plannedRun.canonicalRequest), [firstEvent])
  return yield* store.create(
    runId,
    bytes(input.plannedRun.canonicalRequest),
    encodeEvent(firstEvent),
    encodeView(view),
  ).pipe(
    Effect.as(view),
    Effect.catchEager((error) => {
      if (error.code !== "RUN_ID_CONFLICT") return Effect.fail(error)
      return loadRun(runId).pipe(Effect.flatMap((existing) => {
        if (
          existing.requestSha256 !== input.plannedRun.requestSha256 ||
          existing.payloadSha256 !== input.payloadSha256 ||
          canonicalJson((existing.linkedFrom ?? null) as unknown as JsonValue) !==
            canonicalJson((request.linkedRun ?? null) as unknown as JsonValue)
        ) {
          return Effect.fail(new RunRecordError("RUN_ID_CONFLICT", "The existing Run identity belongs to different immutable evidence."))
        }
        if (existing.phase !== "submission_may_have_started") return Effect.succeed(existing)
        return store.read(runId).pipe(Effect.flatMap((stored) => {
          const orphanedProviderBody = stored.evidence["provider-response.json"]
          if (orphanedProviderBody === undefined) return Effect.succeed(existing)
          return Effect.try({
            try: () => parseEvents(stored.events),
            catch: (error) => error instanceof RunRecordError
              ? error
              : new RunRecordError("EVENT_CHAIN_BROKEN", "Provider recovery intent could not be decoded.", "repair-evidence"),
          }).pipe(Effect.flatMap((journal) => {
            const intent = journal.find((event) => event.kind === "provider_evidence_intent")
            if (intent === undefined) {
              return Effect.fail(new RunRecordError(
                "EVIDENCE_HASH_MISMATCH",
                "Unjournaled provider evidence has no durable pre-write intent.",
                "repair-evidence",
              ))
            }
            const expectedSha256 = stringPayload(intent.payload, "sha256")
            const expectedByteLength = numberPayload(intent.payload, "byteLength")
            const expectedMediaType = stringPayload(intent.payload, "mediaType")
            const completionOperationId = stringPayload(intent.payload, "completionOperationId")
            if (
              intent.eventSha256 !== journal.at(-1)?.eventSha256 ||
              expectedMediaType !== "application/json" ||
              orphanedProviderBody.byteLength !== expectedByteLength ||
              sha256(orphanedProviderBody) !== expectedSha256
            ) {
              return Effect.fail(new RunRecordError(
                "EVIDENCE_HASH_MISMATCH",
                "Orphaned provider evidence does not match its durable pre-write intent.",
                "repair-evidence",
              ))
            }
            return recordOperation({
              _tag: "CommitProviderEvidence",
              runId,
              operationId: completionOperationId,
              evidence: {
                mediaType: "application/json",
                body: orphanedProviderBody,
                sha256: expectedSha256,
              },
            }).pipe(Effect.map((result) => result.view))
          }))
        }))
      }))
    }),
  )
})

const validateProviderEvidence = (operation: Extract<RecordOperation, { _tag: "CommitProviderEvidence" }>): unknown => {
  if (
    operation.evidence.mediaType !== "application/json" ||
    !isSha256(operation.evidence.sha256) || sha256(operation.evidence.body) !== operation.evidence.sha256
  ) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence does not match its declared SHA-256.", "repair-evidence")
  }
  const source = Buffer.from(operation.evidence.body).toString("utf8")
  if (hasDuplicateJsonKeys(source)) {
    throw new RunRecordError("SECRET_MATERIAL_DETECTED", "Provider evidence contains duplicate JSON keys.", "repair-evidence")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence must be valid sanitized JSON.", "repair-evidence")
  }
  if (hasProviderCredentialMaterial(parsed)) {
    throw new RunRecordError("SECRET_MATERIAL_DETECTED", "Provider evidence contains credential material.", "repair-evidence")
  }
  return parsed
}

const exactOwnKeys = (value: object, keys: ReadonlyArray<string>): boolean => {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

type FailureProof = Readonly<Record<string, JsonValue>>

const snapshotClassifiedFailure = (
  value: unknown,
): Readonly<{ class: ClassifiedFailureClass; message: string; proof?: FailureProof }> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const failure = value as Readonly<Record<string, unknown>>
  const failureRecord = value as Readonly<Record<string, unknown>>
  const classDescriptor = Object.getOwnPropertyDescriptor(failureRecord, "class")
  if (classDescriptor === undefined || !Object.hasOwn(classDescriptor, "value")) return undefined
  const failureClass = classDescriptor.value
  if (!isClassifiedFailureClass(failureClass)) return undefined
  const requiresCause = failureClass === "assembly_failure" || failureClass === "verification_failure"
  if (!requiresCause) return undefined
  const keys = ["class", "message", "cause"]
  if (
    Reflect.ownKeys(failure).length !== keys.length ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(failure, key)
      return descriptor === undefined || !Object.hasOwn(descriptor, "value")
    })
  ) return undefined
  const message = failure.message
  if (
    !isClassifiedFailureClass(failureClass) || typeof message !== "string" ||
    message.trim().length === 0 || message.length > 500 ||
    hasProviderCredentialMaterial(failure)
  ) return undefined
  const causeDescriptor = Object.getOwnPropertyDescriptor(failureRecord, "cause")
  if (causeDescriptor === undefined || !Object.hasOwn(causeDescriptor, "value")) return undefined
  const cause = causeDescriptor.value
  if (failureClass === "assembly_failure") {
    const evidence = Effect.runSync(inspectAssemblyFailure(cause))
    return evidence === undefined ? undefined : { class: failureClass, message, proof: evidence }
  }
  const rasterEvidence = Effect.runSync(inspectVerificationFailure(cause))
  if (rasterEvidence !== undefined) return { class: failureClass, message, proof: rasterEvidence }
  const videoEvidence = Effect.runSync(inspectVideoVerificationFailure(cause))
  return videoEvidence === undefined ? undefined : { class: failureClass, message, proof: videoEvidence }
}

const snapshotGeneratedOutput = (value: unknown): GeneratedOutputEvidenceInput | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const output = value as Readonly<Record<string, unknown>>
  const prototype = Object.getPrototypeOf(output)
  const keys = ["applicationPath", "mediaType", "body", "sha256"]
  if ((prototype !== Object.prototype && prototype !== null) || !exactOwnKeys(output, keys)) return undefined
  const applicationPath = output.applicationPath
  const mediaType = output.mediaType
  const body = output.body
  const digest = output.sha256
  if (
    !exactOwnKeys(output, keys) ||
    typeof applicationPath !== "string" || !applicationPath.startsWith("outputs/") ||
    typeof mediaType !== "string" || !(body instanceof Uint8Array) || typeof digest !== "string"
  ) return undefined
  return {
    applicationPath: applicationPath as `outputs/${string}`,
    mediaType,
    body: Buffer.isBuffer(body) ? Buffer.from(body) : Uint8Array.from(body),
    sha256: digest,
  }
}

const snapshotGeneratedOutputs = (
  value: unknown,
): ReadonlyArray<GeneratedOutputEvidenceInput> | undefined => {
  if (!Array.isArray(value)) return undefined
  const keys = ["length", ...Array.from({ length: value.length }, (_, index) => String(index))]
  if (!exactOwnKeys(value, keys)) return undefined
  const outputs: GeneratedOutputEvidenceInput[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined
    const output = snapshotGeneratedOutput(value[index])
    if (output === undefined) return undefined
    outputs.push(output)
  }
  return exactOwnKeys(value, keys) ? outputs : undefined
}

const snapshotSeedanceCost = (value: unknown): SeedanceCostInput | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const cost = value as Readonly<Record<string, unknown>>
  const prototype = Object.getPrototypeOf(cost)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const initialKeys = Reflect.ownKeys(cost)
  if (
    initialKeys.length < 1 || initialKeys.length > 2 ||
    !Object.hasOwn(cost, "state") ||
    (initialKeys.length === 2 && !Object.hasOwn(cost, "actualCostUsd"))
  ) return undefined
  const state = cost.state
  const actualCostUsd = cost.actualCostUsd
  const expectedKeys = actualCostUsd === undefined ? ["state"] : ["state", "actualCostUsd"]
  if (
    !exactOwnKeys(cost, expectedKeys) ||
    typeof state !== "string" ||
    (actualCostUsd !== undefined && typeof actualCostUsd !== "string")
  ) return undefined
  return (actualCostUsd === undefined ? { state } : { state, actualCostUsd }) as SeedanceCostInput
}

const validateProviderEvidenceForRequest = (
  operation: Extract<RecordOperation, { _tag: "CommitProviderEvidence" }>,
  runRequest: CanonicalRunRequest,
): void => {
  const parsed = validateProviderEvidence(operation)
  if (runRequest.mode !== "seedance-video") {
    if (!isSanitizedProviderDocument("qwen", parsed)) {
      throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Qwen provider evidence must match its sanitized receipt schema.", "repair-evidence")
    }
    return
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance provider evidence must be one submitted job object.", "repair-evidence")
  }
  const provider = parsed as Readonly<Record<string, unknown>>
  if (
    !isSanitizedProviderDocument("seedance-submission", provider) ||
    typeof provider.job_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider.job_id) ||
    (provider.status !== "submitted" && provider.status !== "queued")
  ) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance provider evidence must bind one sanitized submitted job.", "repair-evidence")
  }
}

const completedPollMatchesOperation = (
  poll: Readonly<Record<string, unknown>>,
  operation: Extract<RecordOperation, { _tag: "CommitSeedancePoll"; status: "completed" }>,
): boolean => {
  if (
    poll.completed_count !== operation.completedCount ||
    !Array.isArray(poll.outputs) || poll.outputs.length !== operation.outputs.length
  ) return false
  const seen = new Set<string>()
  for (let index = 0; index < poll.outputs.length; index += 1) {
    if (!Object.hasOwn(poll.outputs, index)) return false
    const receipt = poll.outputs[index]
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) return false
    const output = operation.outputs[index]
    const record = receipt as Readonly<Record<string, unknown>>
    if (
      output === undefined || record.application_path !== output.applicationPath ||
      record.media_type !== output.mediaType || record.sha256 !== output.sha256 ||
      seen.has(output.applicationPath)
    ) return false
    seen.add(output.applicationPath)
  }
  const cost = poll.cost
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return false
  const costRecord = cost as Readonly<Record<string, unknown>>
  return costRecord.state === operation.cost.state && (
    operation.cost.state === "actual"
      ? costRecord.actual_cost_usd === operation.cost.actualCostUsd
      : costRecord.actual_cost_usd === undefined
  )
}

export const recordOperation = (
  operation: RecordOperation,
): Effect.Effect<RecordResult, RunRecordError, RunRecordStoreService | RunRecordClockService> => Effect.gen(function*() {
  if (!/^run-[a-f0-9]{24}$/.test(operation.runId) || !isIdentifier(operation.operationId)) {
    return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Run and operation identities must be canonical."))
  }
  const store = yield* RunRecordStore
  const stored = yield* store.read(operation.runId)
  const events = yield* Effect.try({
    try: () => parseEvents(stored.events),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be decoded.", "repair-evidence"),
  })
  const current = yield* Effect.try({
    try: () => replay(operation.runId, stored.request, events, stored.evidence),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be replayed.", "repair-evidence"),
  })
  yield* Effect.try({
    try: () => assertDerivedViewConsistent(stored, events, current),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view could not be read.", "repair-evidence"),
  })
  yield* validateCorrectionAncestry(store, current)
  const runRequest = JSON.parse(Buffer.from(stored.request).toString("utf8")) as CanonicalRunRequest
  let stableProviderEvidence: ProviderEvidenceInput | undefined
  if (operation._tag === "CommitProviderEvidence" || operation._tag === "CommitSeedancePoll") {
    const evidence = operation.evidence
    stableProviderEvidence = yield* Effect.try({
      try: () => snapshotProviderEvidence(evidence),
      catch: () => new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence could not be snapshotted safely.", "repair-evidence"),
    })
    if (stableProviderEvidence === undefined) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence must match its closed wrapper schema.", "repair-evidence"))
    }
  }
  let stableGeneratedOutput: GeneratedOutputEvidenceInput | undefined
  if (operation._tag === "CommitGeneratedOutput") {
    const output = operation.output
    stableGeneratedOutput = yield* Effect.try({
      try: () => snapshotGeneratedOutput(output),
      catch: () => new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output could not be snapshotted safely.", "repair-evidence"),
    })
    if (stableGeneratedOutput === undefined) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output must match its closed evidence schema.", "repair-evidence"))
    }
  }
  let stableSeedanceOutputs: ReadonlyArray<GeneratedOutputEvidenceInput> | undefined
  let stableSeedanceCost: SeedanceCostInput | undefined
  if (operation._tag === "CommitSeedancePoll" && operation.status === "completed") {
    const outputs = operation.outputs
    const cost = operation.cost
    const snapshot = yield* Effect.try({
      try: () => ({
        outputs: snapshotGeneratedOutputs(outputs),
        cost: snapshotSeedanceCost(cost),
      }),
      catch: () => new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance completion could not be snapshotted safely.", "repair-evidence"),
    })
    if (snapshot.outputs === undefined || snapshot.cost === undefined) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance completion must match its closed output and cost schemas.", "repair-evidence"))
    }
    stableSeedanceOutputs = snapshot.outputs
    stableSeedanceCost = snapshot.cost
  }
  let stableClassifiedFailure: Readonly<{ class: ClassifiedFailureClass; message: string; proof?: FailureProof }> | undefined
  if (operation._tag === "ClassifyFailure") {
    stableClassifiedFailure = yield* Effect.try({
      try: () => snapshotClassifiedFailure(operation.failure),
      catch: () => new RunRecordError("ILLEGAL_TRANSITION", "The classified failure could not be snapshotted safely."),
    })
    if (stableClassifiedFailure === undefined) {
      return yield* Effect.fail(new RunRecordError(
        hasProviderCredentialMaterial(operation.failure) ? "SECRET_MATERIAL_DETECTED" : "ILLEGAL_TRANSITION",
        "The classified failure must match its closed safe schema.",
      ))
    }
  } else if (operation._tag === "SubmissionUnreconciled") {
    stableClassifiedFailure = {
      class: "submission_unreconciled",
      message: "Provider submission may have started, but no trustworthy result has been reconciled.",
      proof: {
        module: "Run Record",
        observation: "submission result remains unreconciled",
      },
    }
  }
  const expectedKind = operation._tag === "SubmissionMayHaveStarted"
    ? "submission_may_have_started"
    : operation._tag === "CommitProviderEvidence"
      ? "provider_evidence_received"
      : operation._tag === "CommitGeneratedOutput"
        ? "generated_output_persisted"
        : operation._tag === "CommitSeedancePoll"
          ? "seedance_poll_persisted"
        : operation._tag === "OpenDonorChoice"
          ? "donor_choice_opened"
          : operation._tag === "SelectDonor"
            ? "donor_selected"
            : operation._tag === "CommitAssembly"
              ? "assembly_persisted"
              : operation._tag === "CommitChecks"
                ? "checks_persisted"
                : operation._tag === "CommitVideoChecks"
                  ? "video_checks_persisted"
                  : operation._tag === "ClassifyFailure" || operation._tag === "SubmissionUnreconciled"
                    ? "classified_outcome"
                    : "definitive_pre_submit_failure"
  const replayed = events.find((event) => event.operationId === operation.operationId)
  if (replayed !== undefined) {
    if (replayed.kind !== expectedKind) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was reused for different evidence."))
    }
    if (
      operation._tag === "CommitProviderEvidence" &&
      (
        stringPayload(replayed.payload, "sha256") !== stableProviderEvidence!.sha256 ||
        sha256(stableProviderEvidence!.body) !== stableProviderEvidence!.sha256
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different provider evidence."))
    }
    if (
      operation._tag === "CommitGeneratedOutput" &&
      (
        stringPayload(replayed.payload, "applicationPath") !== stableGeneratedOutput!.applicationPath ||
        stringPayload(replayed.payload, "sha256") !== stableGeneratedOutput!.sha256 ||
        stringPayload(replayed.payload, "mediaType") !== stableGeneratedOutput!.mediaType ||
        sha256(stableGeneratedOutput!.body) !== stableGeneratedOutput!.sha256
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different generated output evidence."))
    }
    if (operation._tag === "CommitSeedancePoll") {
      const replayedOutputs = replayed.payload.outputs
      const operationOutputs = operation.status === "completed"
        ? stableSeedanceOutputs!.map((output) => ({
            applicationPath: output.applicationPath,
            sha256: output.sha256,
            byteLength: output.body.byteLength,
            mediaType: output.mediaType,
          }))
        : undefined
      if (
        stringPayload(replayed.payload, "jobId") !== operation.jobId ||
        stringPayload(replayed.payload, "status") !== operation.status ||
        stringPayload(replayed.payload, "sha256") !== stableProviderEvidence!.sha256 ||
        sha256(stableProviderEvidence!.body) !== stableProviderEvidence!.sha256 ||
        canonicalJson((replayedOutputs ?? null) as JsonValue) !== canonicalJson((operationOutputs ?? null) as JsonValue) ||
        (operation.status === "completed" && (
          stableSeedanceOutputs!.some((output) => sha256(output.body) !== output.sha256) ||
          numberPayload(replayed.payload, "completedCount") !== operation.completedCount ||
          stringPayload(replayed.payload, "costState") !== stableSeedanceCost!.state ||
          (replayed.payload.actualCostUsd ?? null) !== (stableSeedanceCost!.actualCostUsd ?? null)
        ))
      ) {
        return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different Seedance poll evidence."))
      }
    }
    if (
      operation._tag === "OpenDonorChoice" &&
      canonicalJson(stringArrayPayload(replayed.payload, "candidateSha256s")) !==
        canonicalJson(operation.candidateSha256s as ReadonlyArray<JsonValue>)
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different donor candidates."))
    }
    if (
      operation._tag === "SelectDonor" &&
      stringPayload(replayed.payload, "selectedSha256") !== operation.selectedSha256
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with a different selected donor."))
    }
    if (operation._tag === "CommitAssembly") {
      const reportSha256 = sha256(canonicalJson(operation.report as unknown as JsonValue))
      if (
        stringPayload(replayed.payload, "outputPath") !== operation.output.applicationPath ||
        stringPayload(replayed.payload, "outputSha256") !== operation.output.sha256 ||
        stringPayload(replayed.payload, "outputMediaType") !== operation.output.mediaType ||
        stringPayload(replayed.payload, "reportSha256") !== reportSha256 ||
        sha256(operation.output.body) !== operation.output.sha256
      ) {
        return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different Assembly evidence."))
      }
    }
    if (operation._tag === "CommitChecks") {
      if (
        stringPayload(replayed.payload, "candidateSha256") !== operation.candidateSha256 ||
        sha256(operation.baseline.body) !== operation.baseline.sha256 ||
        stringPayload(replayed.payload, "operationSha256") !== checksOperationSha256(operation)
      ) {
        return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different checks evidence."))
      }
    }
    if (operation._tag === "CommitVideoChecks") {
      const reportBytes = bytes(canonicalJson(operation.report as unknown as JsonValue))
      if (
        stringPayload(replayed.payload, "jobId") !== operation.jobId ||
        stringPayload(replayed.payload, "reportSha256") !== sha256(reportBytes)
      ) {
        return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different video checks evidence."))
      }
    }
    if (
      operation._tag === "DefinitivePreSubmitFailure" &&
      (
        stringPayload(replayed.payload, "class") !== operation.failure.class ||
        stringPayload(replayed.payload, "message") !== operation.failure.message
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with a different failure."))
    }
    if (
      (operation._tag === "ClassifyFailure" || operation._tag === "SubmissionUnreconciled") &&
      (
        stringPayload(replayed.payload, "class") !== stableClassifiedFailure!.class ||
        stringPayload(replayed.payload, "message") !== stableClassifiedFailure!.message
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with a different classified failure."))
    }
    return { _tag: "ReplayObserved" as const, view: current }
  }
  if (operation._tag === "CommitProviderEvidence") {
    if (current.phase !== "submission_may_have_started") {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence requires the durable submission marker."))
    }
    yield* Effect.try({
      try: () => validateProviderEvidenceForRequest({ ...operation, evidence: stableProviderEvidence! }, runRequest),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence validation failed.", "repair-evidence"),
    })
    const applicationPath = "provider-response.json"
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const intentOperationId = `provider-intent-${sha256(operation.operationId).slice(0, 24)}`
    const existingIntent = events.find((event) => event.operationId === intentOperationId)
    if (existingIntent !== undefined && (
      existingIntent.kind !== "provider_evidence_intent" ||
      existingIntent.eventSha256 !== events.at(-1)?.eventSha256 ||
      stringPayload(existingIntent.payload, "completionOperationId") !== operation.operationId ||
      stringPayload(existingIntent.payload, "sha256") !== stableProviderEvidence!.sha256 ||
      numberPayload(existingIntent.payload, "byteLength") !== stableProviderEvidence!.body.byteLength ||
      stringPayload(existingIntent.payload, "mediaType") !== stableProviderEvidence!.mediaType
    )) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "Provider evidence contradicts its durable write intent."))
    }
    const intent = existingIntent ?? makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: intentOperationId,
      runId: operation.runId,
      timestamp,
      kind: "provider_evidence_intent",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        completionOperationId: operation.operationId,
        sha256: stableProviderEvidence!.sha256,
        byteLength: stableProviderEvidence!.body.byteLength,
        mediaType: stableProviderEvidence!.mediaType,
      },
    })
    const eventsWithIntent = existingIntent === undefined ? [...events, intent] : events
    const receipt = makeEvent({
      schemaVersion: "1",
      sequence: eventsWithIntent.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "provider_evidence_received",
      previousEventSha256: intent.eventSha256,
      payload: {
        applicationPath,
        sha256: stableProviderEvidence!.sha256,
        byteLength: stableProviderEvidence!.body.byteLength,
        mediaType: stableProviderEvidence!.mediaType,
      },
    })
    const evidenceWithProvider = {
      ...stored.evidence,
      [applicationPath]: stableProviderEvidence!.body,
    }
    const next = yield* Effect.try({
      try: () => replay(operation.runId, stored.request, [...eventsWithIntent, receipt], evidenceWithProvider),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence trial replay failed.", "repair-evidence"),
    })
    if (existingIntent === undefined) {
      yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(intent))
    }
    yield* store.writeEvidence(operation.runId, applicationPath, stableProviderEvidence!.body)
    yield* store.appendEvent(operation.runId, intent.eventSha256, encodeEvent(receipt))
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "CommitGeneratedOutput") {
    if (
      runRequest.mode !== "qwen-image" ||
      (current.phase !== "provider_evidence_received" && current.phase !== "generated_outputs_received")
    ) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Generated output evidence requires provider evidence."))
    }
    if (
      current.evidence.filter((item) => item.applicationPath.startsWith("outputs/")).length >= current.maximumCount
    ) {
      return yield* Effect.fail(new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Generated output evidence exceeds the reserved maximum count."))
    }
    if (
      !/^outputs\/[a-z0-9][a-z0-9._-]*\.rgba\.json$/.test(stableGeneratedOutput!.applicationPath) ||
      stableGeneratedOutput!.mediaType !== "application/vnd.qwen.rgba+json" ||
      current.evidence.some((item) =>
        item.applicationPath === stableGeneratedOutput!.applicationPath ||
        (item.applicationPath.startsWith("outputs/") && item.sha256 === stableGeneratedOutput!.sha256)) ||
      !isSha256(stableGeneratedOutput!.sha256) ||
      sha256(stableGeneratedOutput!.body) !== stableGeneratedOutput!.sha256 ||
      !isNormalizedRgbaEvidence(stableGeneratedOutput!.body)
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output evidence is unsafe or does not match its declared SHA-256.", "repair-evidence"))
    }
    yield* store.writeEvidence(operation.runId, stableGeneratedOutput!.applicationPath, stableGeneratedOutput!.body)
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "generated_output_persisted",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        applicationPath: stableGeneratedOutput!.applicationPath,
        sha256: stableGeneratedOutput!.sha256,
        byteLength: stableGeneratedOutput!.body.byteLength,
        mediaType: stableGeneratedOutput!.mediaType,
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [stableGeneratedOutput!.applicationPath]: stableGeneratedOutput!.body,
    })
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "CommitSeedancePoll") {
    if (
      runRequest.mode !== "seedance-video" || current.phase !== "provider_evidence_received" ||
      current.providerJobId === undefined || operation.jobId !== current.providerJobId
    ) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Seedance polling must continue the one persisted submitted job."))
    }
    if (operation.status === "completed" && (
      !Number.isSafeInteger(operation.completedCount) ||
      operation.completedCount !== current.maximumCount ||
      stableSeedanceOutputs!.length !== operation.completedCount ||
      (stableSeedanceCost!.state !== "actual" && stableSeedanceCost!.state !== "estimated-only" && stableSeedanceCost!.state !== "unknown") ||
      (stableSeedanceCost!.state !== "actual" && stableSeedanceCost!.actualCostUsd !== undefined) ||
      (stableSeedanceCost!.state === "actual" &&
        (stableSeedanceCost!.actualCostUsd === undefined || !/^(?:0|[1-9]\d*)\.\d{2,6}$/.test(stableSeedanceCost!.actualCostUsd)))
    )) {
      return yield* Effect.fail(new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Seedance completion contradicts the reserved count or cost contract."))
    }
    yield* Effect.try({
      try: () => validateProviderEvidence({
        _tag: "CommitProviderEvidence",
        runId: operation.runId,
        operationId: operation.operationId,
        evidence: stableProviderEvidence!,
      }),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence validation failed.", "repair-evidence"),
    })
    let pollDocument: unknown
    try {
      pollDocument = JSON.parse(Buffer.from(stableProviderEvidence!.body).toString("utf8"))
    } catch {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence is not valid JSON.", "repair-evidence"))
    }
    const poll = pollDocument as Readonly<Record<string, unknown>>
    if (
      pollDocument === null || typeof pollDocument !== "object" || Array.isArray(pollDocument) ||
      !isSanitizedProviderDocument("seedance-poll", pollDocument) ||
      poll.job_id !== operation.jobId || poll.status !== operation.status
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence substituted its job identity or status.", "repair-evidence"))
    }
    if (operation.status === "completed" && !completedPollMatchesOperation(poll, {
      ...operation,
      outputs: stableSeedanceOutputs!,
      cost: stableSeedanceCost!,
    })) {
      return yield* Effect.fail(new RunRecordError(
        "EVIDENCE_HASH_MISMATCH",
        "Completed Seedance poll evidence does not bind its exact output, count, and cost receipts.",
        "repair-evidence",
      ))
    }
    const applicationPath = `polls/poll-${String((current.pollCount ?? 0) + 1).padStart(4, "0")}.json`
    const orphanedPollBody = stored.evidence[applicationPath]
    const durablePollEvidence = orphanedPollBody === undefined
      ? stableProviderEvidence!
      : {
          mediaType: "application/json" as const,
          body: orphanedPollBody,
          sha256: sha256(orphanedPollBody),
        }
    if (orphanedPollBody !== undefined) {
      yield* Effect.try({
        try: () => validateProviderEvidence({
          _tag: "CommitProviderEvidence",
          runId: operation.runId,
          operationId: operation.operationId,
          evidence: durablePollEvidence,
        }),
        catch: (error) => error instanceof RunRecordError
          ? error
          : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Orphaned Seedance poll evidence could not be reconciled.", "repair-evidence"),
      })
      let orphanedDocument: unknown
      try {
        orphanedDocument = JSON.parse(Buffer.from(orphanedPollBody).toString("utf8"))
      } catch {
        return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Orphaned Seedance poll evidence is not valid JSON.", "repair-evidence"))
      }
      const orphanedPoll = orphanedDocument as Readonly<Record<string, unknown>>
      if (
        orphanedDocument === null || typeof orphanedDocument !== "object" || Array.isArray(orphanedDocument) ||
        !isSanitizedProviderDocument("seedance-poll", orphanedDocument) ||
        orphanedPoll.job_id !== operation.jobId
      ) {
        return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Orphaned Seedance evidence belongs to a different job.", "repair-evidence"))
      }
      if (orphanedPoll.status !== operation.status) {
        if (orphanedPoll.status !== "pending" || operation.status !== "completed") {
          return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Orphaned Seedance evidence has an impossible poll-status progression.", "repair-evidence"))
        }
        const clock = yield* RunRecordClock
        const timestamp = yield* clock.now()
        const recoveredEvent = makeEvent({
          schemaVersion: "1",
          sequence: events.length + 1,
          operationId: operation.operationId,
          runId: operation.runId,
          timestamp,
          kind: "seedance_poll_persisted",
          previousEventSha256: current.chainHeadSha256,
          payload: {
            applicationPath,
            sha256: durablePollEvidence.sha256,
            byteLength: durablePollEvidence.body.byteLength,
            mediaType: durablePollEvidence.mediaType,
            jobId: operation.jobId,
            status: "pending",
          },
        })
        yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(recoveredEvent))
        const recovered = replay(operation.runId, stored.request, [...events, recoveredEvent], stored.evidence)
        yield* store.writeState(operation.runId, encodeView(recovered))
        return { _tag: "Recorded" as const, view: recovered }
      }
      if (operation.status === "completed" && !completedPollMatchesOperation(orphanedPoll, {
        ...operation,
        outputs: stableSeedanceOutputs!,
        cost: stableSeedanceCost!,
      })) {
        return yield* Effect.fail(new RunRecordError(
          "EVIDENCE_HASH_MISMATCH",
          "Orphaned Seedance poll evidence contradicts the retried output, count, or cost receipts.",
          "repair-evidence",
        ))
      }
    }
    const orphanedOutputPaths = Object.keys(stored.evidence).filter((path) =>
      path.startsWith("outputs/") && !current.evidence.some((item) => item.applicationPath === path))
    if (
      operation.status === "completed" && stableSeedanceOutputs!.some((output) => {
        const orphanedBody = stored.evidence[output.applicationPath]
        return orphanedBody !== undefined && (
          sha256(output.body) !== output.sha256 || sha256(orphanedBody) !== output.sha256
        )
      })
    ) {
      return yield* Effect.fail(new RunRecordError(
        "EVIDENCE_HASH_MISMATCH",
        "Retried Seedance output evidence contradicts the first durable output bytes.",
        "repair-evidence",
      ))
    }
    const durableOutputs = operation.status === "completed"
      ? stableSeedanceOutputs!.map((output) => {
          const orphanedBody = stored.evidence[output.applicationPath]
          return orphanedBody === undefined
            ? output
            : { ...output, body: orphanedBody, sha256: sha256(orphanedBody) }
        })
      : []
    if (
      orphanedOutputPaths.some((path) => !durableOutputs.some((output) => output.applicationPath === path))
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Orphaned Seedance outputs do not match the retried completion set.", "repair-evidence"))
    }
    let outputReceipts: ReadonlyArray<Readonly<Record<string, JsonValue>>> | undefined
    if (operation.status === "completed") {
      const paths = new Set<string>()
      for (const output of durableOutputs) {
        if (
          !/^outputs\/[a-z0-9][a-z0-9._-]*\.mp4$/.test(output.applicationPath) ||
          paths.has(output.applicationPath) || output.mediaType !== "video/mp4" ||
          !isSha256(output.sha256) || sha256(output.body) !== output.sha256 ||
          current.evidence.some((item) => item.applicationPath === output.applicationPath)
        ) {
          return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance output evidence is unsafe or malformed.", "repair-evidence"))
        }
        paths.add(output.applicationPath)
      }
      outputReceipts = durableOutputs.map((output) => ({
        applicationPath: output.applicationPath,
        sha256: output.sha256,
        byteLength: output.body.byteLength,
        mediaType: output.mediaType,
      }))
    }
    yield* store.writeEvidence(operation.runId, applicationPath, durablePollEvidence.body)
    if (operation.status === "completed") {
      for (const output of durableOutputs) {
        yield* store.writeEvidence(operation.runId, output.applicationPath, output.body)
      }
    }
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "seedance_poll_persisted",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        applicationPath,
        sha256: durablePollEvidence.sha256,
        byteLength: durablePollEvidence.body.byteLength,
        mediaType: durablePollEvidence.mediaType,
        jobId: operation.jobId,
        status: operation.status,
        ...(operation.status === "pending"
          ? {}
          : {
              outputs: outputReceipts!,
              completedCount: operation.completedCount,
              costState: stableSeedanceCost!.state,
              ...(stableSeedanceCost!.actualCostUsd === undefined ? {} : { actualCostUsd: stableSeedanceCost!.actualCostUsd }),
            }),
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const nextEvidence = {
      ...stored.evidence,
      [applicationPath]: durablePollEvidence.body,
      ...(operation.status === "pending"
        ? {}
        : Object.fromEntries(durableOutputs.map((output) => [output.applicationPath, output.body]))),
    }
    const next = replay(operation.runId, stored.request, [...events, event], nextEvidence)
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "OpenDonorChoice") {
    if (runRequest.mode !== "qwen-image" || current.phase !== "generated_outputs_received") {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "A donor choice requires persisted generated output evidence."))
    }
    const generatedOutputSha256s = current.evidence
      .filter((item) => item.applicationPath.startsWith("outputs/"))
      .map((item) => item.sha256)
    if (
      !Array.isArray(operation.candidateSha256s) ||
      operation.candidateSha256s.length !== current.maximumCount ||
      generatedOutputSha256s.length !== current.maximumCount ||
      Array.from({ length: operation.candidateSha256s.length }, (_, index) => operation.candidateSha256s[index])
        .some((candidate) => candidate === undefined) ||
      new Set(operation.candidateSha256s).size !== operation.candidateSha256s.length ||
      generatedOutputSha256s.some((sha256) => !operation.candidateSha256s.includes(sha256)) ||
      operation.candidateSha256s.some((candidate) =>
        !isSha256(candidate) || !current.evidence.some((item) =>
          item.applicationPath.startsWith("outputs/") && item.sha256 === candidate))
    ) {
      return yield* Effect.fail(new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Donor choice requires the complete reserved set of persisted generated outputs."))
    }
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "donor_choice_opened",
      previousEventSha256: current.chainHeadSha256,
      payload: { candidateSha256s: operation.candidateSha256s },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], stored.evidence)
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "SelectDonor") {
    if (current.phase !== "awaiting_donor_choice") {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "A donor selection requires an open donor-choice checkpoint."))
    }
    if (
      !isSha256(operation.selectedSha256) ||
      !current.donorCandidateSha256s?.includes(operation.selectedSha256) ||
      !current.evidence.some((item) => item.applicationPath.startsWith("outputs/") && item.sha256 === operation.selectedSha256)
    ) {
      return yield* Effect.fail(new RunRecordError("DONOR_NOT_PERSISTED", "The selected donor must name persisted checkpoint evidence on this Run."))
    }
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "donor_selected",
      previousEventSha256: current.chainHeadSha256,
      payload: { selectedSha256: operation.selectedSha256 },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], stored.evidence)
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "CommitAssembly") {
    if (current.phase !== "donor_selected" || current.selectedDonorSha256 === undefined) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Assembly evidence requires a selected donor."))
    }
    const reportDocument = operation.report as unknown as Readonly<Record<string, unknown>>
    const expectedBindings = expectedPlanBindings(runRequest, current.selectedDonorSha256, operation.output.sha256)
    if (
      !/^outputs\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(operation.output.applicationPath) ||
      operation.output.applicationPath.includes("..") ||
      operation.output.mediaType.trim().length === 0 ||
      !isSha256(operation.output.sha256) ||
      sha256(operation.output.body) !== operation.output.sha256 ||
      Object.keys(reportDocument).sort().join(",") !== "baselineSha256,donorSha256,exactCopySha256,outputSha256,regionSha256" ||
      !Object.values(reportDocument).every((value) => typeof value === "string" && isSha256(value)) ||
      current.evidence.some((item) =>
        item.applicationPath.startsWith("outputs/") && item.sha256 === operation.output.sha256) ||
      canonicalJson(operation.report as unknown as JsonValue) !== canonicalJson(expectedBindings as unknown as JsonValue)
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Assembly evidence must bind the immutable plan, selected donor, and distinct assembled output.", "repair-evidence"))
    }
    const reportBytes = bytes(canonicalJson(operation.report as unknown as JsonValue))
    const reportSha256 = sha256(reportBytes)
    const reportPath = "assembly-report.json"
    yield* store.writeEvidence(operation.runId, operation.output.applicationPath, operation.output.body)
    yield* store.writeEvidence(operation.runId, reportPath, reportBytes)
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "assembly_persisted",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        outputPath: operation.output.applicationPath,
        outputSha256: operation.output.sha256,
        outputByteLength: operation.output.body.byteLength,
        outputMediaType: operation.output.mediaType,
        reportPath,
        reportSha256,
        reportByteLength: reportBytes.byteLength,
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [operation.output.applicationPath]: operation.output.body,
      [reportPath]: reportBytes,
    })
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "CommitChecks") {
    if (
      current.phase !== "assembly_completed" || current.assemblyOutputSha256 === undefined ||
      current.selectedDonorSha256 === undefined
    ) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Checks require persisted Assembly evidence."))
    }
    const expectedBindings = expectedPlanBindings(runRequest, current.selectedDonorSha256, current.assemblyOutputSha256)
    const donorEvidence = current.evidence.find((item) =>
      item.applicationPath.startsWith("outputs/") && item.sha256 === current.selectedDonorSha256)
    const candidateEvidence = current.evidence.find((item) => item.sha256 === current.assemblyOutputSha256)
    const donorBytes = donorEvidence === undefined ? undefined : stored.evidence[donorEvidence.applicationPath]
    const candidateBytes = candidateEvidence === undefined ? undefined : stored.evidence[candidateEvidence.applicationPath]
    if (
      donorBytes === undefined || candidateBytes === undefined ||
      !isSha256(operation.baseline.sha256) ||
      sha256(operation.baseline.body) !== operation.baseline.sha256 ||
      operation.baseline.sha256 !== expectedBindings.baselineSha256
    ) {
      return yield* Effect.fail(new RunRecordError(
        "EVIDENCE_HASH_MISMATCH",
        "Checks require the exact immutable baseline and persisted donor and assembled candidate bytes.",
        "repair-evidence",
      ))
    }
    const recomputed = yield* Effect.try({
      try: () => recomputeChecks(runRequest, operation.baseline.body, donorBytes, candidateBytes),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("CHECKS_NOT_PASSED", "Fidelity Checks could not be recomputed.", "repair-evidence"),
    })
    const document = {
      algorithm: verificationAlgorithm,
      candidateSha256: operation.candidateSha256,
      checks: operation.checks,
      classification: operation.classification,
      inputs: {
        baselineSha256: expectedBindings.baselineSha256,
        candidateSha256: expectedBindings.outputSha256,
        donorSha256: expectedBindings.donorSha256,
        exactCopySha256: expectedBindings.exactCopySha256,
        regionSha256: expectedBindings.regionSha256,
      },
    }
    yield* Effect.try({
      try: () => validateChecksDocument(document, expectedBindings, recomputed),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("CHECKS_NOT_PASSED", "Checks evidence could not be validated.", "repair-evidence"),
    })
    const checksBytes = bytes(canonicalJson(document as unknown as JsonValue))
    const evidenceSha256 = sha256(checksBytes)
    const applicationPath = "checks.json"
    const baselinePath = "inputs/baseline-reference"
    yield* store.writeEvidence(operation.runId, baselinePath, operation.baseline.body)
    yield* store.writeEvidence(operation.runId, applicationPath, checksBytes)
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "checks_persisted",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        applicationPath,
        sha256: evidenceSha256,
        byteLength: checksBytes.byteLength,
        candidateSha256: operation.candidateSha256,
        baselinePath,
        baselineSha256: operation.baseline.sha256,
        baselineByteLength: operation.baseline.body.byteLength,
        operationSha256: checksOperationSha256(operation),
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [baselinePath]: operation.baseline.body,
      [applicationPath]: checksBytes,
    })
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "CommitVideoChecks") {
    if (
      runRequest.mode !== "seedance-video" || current.phase !== "generated_outputs_received" ||
      current.providerJobId === undefined || operation.jobId !== current.providerJobId
    ) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Video checks require completed output evidence for the persisted Seedance job."))
    }
    yield* Effect.try({
      try: () => validateVideoReport(
        runRequest,
        operation.report,
        current.evidence,
        current.completedCount,
        current.costState,
        current.actualCostUsd,
        stored.evidence,
      ),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("CHECKS_NOT_PASSED", "Video checks evidence could not be validated.", "repair-evidence"),
    })
    const reportBytes = bytes(canonicalJson(operation.report as unknown as JsonValue))
    const reportSha256 = sha256(reportBytes)
    const applicationPath = "checks.json"
    yield* store.writeEvidence(operation.runId, applicationPath, reportBytes)
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "video_checks_persisted",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        applicationPath,
        sha256: reportSha256,
        reportSha256,
        byteLength: reportBytes.byteLength,
        mediaType: "application/json",
        jobId: operation.jobId,
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [applicationPath]: reportBytes,
    })
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "ClassifyFailure" || operation._tag === "SubmissionUnreconciled") {
    const failure = stableClassifiedFailure!
    const policy = classifiedFailurePolicy(failure.class)
    const proof = failure.proof
    if (!classifiedFailureProofMatches(failure.class, proof, {
      phase: current.phase,
      runRequest,
      evidence: current.evidence,
      ...(current.selectedDonorSha256 === undefined ? {} : { selectedDonorSha256: current.selectedDonorSha256 }),
      ...(current.assemblyOutputSha256 === undefined ? {} : { assemblyOutputSha256: current.assemblyOutputSha256 }),
      ...(current.completedCount === undefined ? {} : { completedCount: current.completedCount }),
      ...(current.costState === undefined ? {} : { costState: current.costState }),
      ...(current.actualCostUsd === undefined ? {} : { actualCostUsd: current.actualCostUsd }),
    })) {
      return yield* Effect.fail(new RunRecordError(
        "ILLEGAL_TRANSITION",
        `The ${failure.class} classification is not backed by the exact module failure for ${current.phase}.`,
      ))
    }
    const intentOperationId = `failure-intent-${sha256(operation.operationId).slice(0, 24)}`
    const existingIntent = events.find((event) => event.operationId === intentOperationId)
    const document = {
      class: failure.class,
      correctionOwner: policy.correctionOwner,
      evidence: {
        artifactSha256s: current.evidence.map((item) => item.sha256),
        failureProof: failure.proof!,
        requestSha256: current.requestSha256,
        stateEventSha256: existingIntent?.previousEventSha256 ?? current.chainHeadSha256,
      },
      message: failure.message,
      outcome: policy.outcome,
      retryState: policy.retryState,
      spendState: policy.spendState,
    }
    const failureBytes = bytes(canonicalJson(document))
    const failureSha256 = sha256(failureBytes)
    const applicationPath = "failure.json"
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    if (existingIntent !== undefined && (
      existingIntent.kind !== "classified_outcome_intent" ||
      existingIntent.eventSha256 !== events.at(-1)?.eventSha256 ||
      stringPayload(existingIntent.payload, "completionOperationId") !== operation.operationId ||
      stringPayload(existingIntent.payload, "sha256") !== failureSha256 ||
      numberPayload(existingIntent.payload, "byteLength") !== failureBytes.byteLength ||
      stringPayload(existingIntent.payload, "class") !== failure.class
    )) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The classified failure contradicts its durable write intent."))
    }
    const intent = existingIntent ?? makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: intentOperationId,
      runId: operation.runId,
      timestamp,
      kind: "classified_outcome_intent",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        completionOperationId: operation.operationId,
        sha256: failureSha256,
        byteLength: failureBytes.byteLength,
        class: failure.class,
      },
    })
    const eventsWithIntent = existingIntent === undefined ? [...events, intent] : events
    const receipt = makeEvent({
      schemaVersion: "1",
      sequence: eventsWithIntent.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "classified_outcome",
      previousEventSha256: intent.eventSha256,
      payload: {
        applicationPath,
        sha256: failureSha256,
        byteLength: failureBytes.byteLength,
        class: failure.class,
        message: failure.message,
      },
    })
    const evidenceWithFailure = { ...stored.evidence, [applicationPath]: failureBytes }
    const next = yield* Effect.try({
      try: () => replay(operation.runId, stored.request, [...eventsWithIntent, receipt], evidenceWithFailure),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "The classified failure trial replay failed.", "repair-evidence"),
    })
    if (existingIntent === undefined) {
      yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(intent))
    }
    yield* store.writeEvidence(operation.runId, applicationPath, failureBytes)
    yield* store.appendEvent(operation.runId, intent.eventSha256, encodeEvent(receipt))
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (operation._tag === "DefinitivePreSubmitFailure") {
    const adapterRefusalAfterMarker = current.phase === "submission_may_have_started" &&
      operation.failure.class === "submission_not_started"
    if (current.phase !== "reserved" && !adapterRefusalAfterMarker) {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Only a reserved Run or a proved adapter refusal can end before submission."))
    }
    if (
      !isIdentifier(operation.failure.class) ||
      operation.failure.message.trim().length === 0 ||
      operation.failure.message.length > 500 ||
      hasProviderCredentialMaterial(operation.failure)
    ) {
      return yield* Effect.fail(new RunRecordError(
        hasProviderCredentialMaterial(operation.failure) ? "SECRET_MATERIAL_DETECTED" : "ILLEGAL_TRANSITION",
        "The definitive failure must be safe, named, and non-empty.",
      ))
    }
    if (adapterRefusalAfterMarker) {
      const permit = operation.permit
      const consumer = permit === undefined || permit === null || typeof permit !== "object"
        ? undefined
        : submissionPermitConsumers.get(permit)
      if (consumer === undefined) {
        return yield* Effect.fail(new RunRecordError(
          "SUBMISSION_PERMIT_INVALID",
          "A submission-not-started Finding requires the genuine unused Submission Permit.",
          "reconcile",
        ))
      }
      yield* consumer.refuse(operation.runId, operation.operationId)
    }
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "definitive_pre_submit_failure",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        class: operation.failure.class,
        message: operation.failure.message,
        spendState: "not_spent",
        retryState: "new-linked-run-only",
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], stored.evidence)
    yield* store.writeState(operation.runId, encodeView(next))
    return { _tag: "Recorded" as const, view: next }
  }
  if (current.phase !== "reserved") {
    return yield* Effect.fail(new RunRecordError(
      "DUPLICATE_SUBMISSION_BLOCKED",
      "The durable submission marker already exists; reconcile this attempt instead.",
      "reconcile",
    ))
  }
  const clock = yield* RunRecordClock
  const timestamp = yield* clock.now()
  const event = makeEvent({
    schemaVersion: "1",
    sequence: events.length + 1,
    operationId: operation.operationId,
    runId: operation.runId,
    timestamp,
    kind: "submission_may_have_started",
    previousEventSha256: current.chainHeadSha256,
    payload: {
      attemptId: current.attemptId,
      spendState: "possibly_spent",
      retryState: "reconcile-only",
    },
  })
  yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
  const next = replay(operation.runId, stored.request, [...events, event])
  let permitState: "available" | "consumed" | Readonly<{ refusedOperationId: string }> = "available"
  const validatePermit = (
    binding: SubmissionBinding,
  ): Effect.Effect<void, RunRecordError> => Effect.suspend(() => {
    if (
      binding.requestSha256 !== next.requestSha256 ||
      binding.payloadSha256 !== next.payloadSha256
    ) {
      return Effect.fail(new RunRecordError(
        "SUBMISSION_BINDING_MISMATCH",
        "The Submission Permit does not authorize this immutable Run and provider payload.",
        "reconcile",
      ))
    }
    if (permitState !== "available") {
      return Effect.fail(new RunRecordError(
        "DUPLICATE_SUBMISSION_BLOCKED",
        "The in-process Submission Permit was already consumed or refused.",
        "reconcile",
      ))
    }
    return Effect.void
  })
  const consumePermit = (
    binding: SubmissionBinding,
  ): Effect.Effect<void, RunRecordError> => validatePermit(binding).pipe(Effect.tap(() => Effect.sync(() => {
    permitState = "consumed"
  })))
  const refusePermit = (runId: string, operationId: string): Effect.Effect<void, RunRecordError> => Effect.suspend(() => {
    if (runId !== operation.runId) {
      return Effect.fail(new RunRecordError("SUBMISSION_PERMIT_INVALID", "The refusal names a different Run.", "reconcile"))
    }
    if (typeof permitState === "object") {
      return permitState.refusedOperationId === operationId
        ? Effect.void
        : Effect.fail(new RunRecordError("DUPLICATE_SUBMISSION_BLOCKED", "The permit already proved a different refusal.", "reconcile"))
    }
    if (permitState === "consumed") {
      return Effect.fail(new RunRecordError("DUPLICATE_SUBMISSION_BLOCKED", "Submission authority was already consumed.", "reconcile"))
    }
    permitState = Object.freeze({ refusedOperationId: operationId })
    return Effect.void
  })
  const permit = immutable({
    runId: operation.runId,
    attemptId: next.attemptId,
    requestSha256: next.requestSha256,
    payloadSha256: next.payloadSha256,
  })
  submissionPermitConsumers.set(permit, { validate: validatePermit, consume: consumePermit, refuse: refusePermit })
  return {
    _tag: "SubmissionPermitIssued" as const,
    permit,
    view: next,
  }
})

export const loadRun = (
  runId: string,
): Effect.Effect<RunRecordView, RunRecordError, RunRecordStoreService> => Effect.gen(function*() {
  if (!/^run-[a-f0-9]{24}$/.test(runId)) {
    return yield* Effect.fail(new RunRecordError("RUN_NOT_FOUND", "The Run identity is invalid."))
  }
  const store = yield* RunRecordStore
  const stored = yield* store.read(runId)
  const events = yield* Effect.try({
    try: () => parseEvents(stored.events),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be decoded.", "repair-evidence"),
  })
  const view = yield* Effect.try({
    try: () => replay(runId, stored.request, events, stored.evidence),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be replayed.", "repair-evidence"),
  })
  const derived = yield* Effect.try({
    try: () => assertDerivedViewConsistent(stored, events, view),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view could not be read.", "repair-evidence"),
  })
  yield* validateCorrectionAncestry(store, view)
  if (derived !== undefined) {
    if (derived.chainHeadSha256 !== view.chainHeadSha256) {
      yield* store.writeState(runId, encodeView(view))
    }
  } else {
    yield* store.writeState(runId, encodeView(view))
  }
  return view
})

export const readRunDiagnostics = (
  runId: string,
): Effect.Effect<RunRecordDiagnostics, RunRecordError, RunRecordStoreService> => Effect.gen(function*() {
  if (!/^run-[a-f0-9]{24}$/.test(runId)) {
    return yield* Effect.fail(new RunRecordError("RUN_NOT_FOUND", "The Run identity is invalid."))
  }
  const store = yield* RunRecordStore
  const stored = yield* store.read(runId)
  const events = yield* Effect.try({
    try: () => parseEvents(stored.events),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be decoded.", "repair-evidence"),
  })
  const view = yield* Effect.try({
    try: () => replay(runId, stored.request, events, stored.evidence),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be replayed.", "repair-evidence"),
  })
  yield* Effect.try({
    try: () => assertDerivedViewConsistent(stored, events, view),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view could not be read.", "repair-evidence"),
  })
  yield* validateCorrectionAncestry(store, view)
  return Object.freeze({
    request: Uint8Array.from(stored.request),
    events: Uint8Array.from(stored.events),
    view,
  })
})

export const readRunEvidence = (
  runId: string,
  applicationPath: string,
): Effect.Effect<Uint8Array, RunRecordError, RunRecordStoreService> => Effect.gen(function*() {
  const store = yield* RunRecordStore
  const stored = yield* store.read(runId)
  const events = yield* Effect.try({
    try: () => parseEvents(stored.events),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be decoded.", "repair-evidence"),
  })
  const view = yield* Effect.try({
    try: () => replay(runId, stored.request, events, stored.evidence),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("EVENT_CHAIN_BROKEN", "The event journal could not be replayed.", "repair-evidence"),
  })
  yield* Effect.try({
    try: () => assertDerivedViewConsistent(stored, events, view),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view could not be read.", "repair-evidence"),
  })
  yield* validateCorrectionAncestry(store, view)
  if (!view.evidence.some((item) => item.applicationPath === applicationPath)) {
    return yield* Effect.fail(new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is not named by the verified Run journal.`, "repair-evidence"))
  }
  const value = stored.evidence[applicationPath]
  if (value === undefined) {
    return yield* Effect.fail(new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is missing.`, "repair-evidence"))
  }
  return Uint8Array.from(value)
})
