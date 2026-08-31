import { createHash } from "node:crypto"

import { Effect } from "effect"

import { RunRecordError } from "./errors.js"
import type { CanonicalRunRequest } from "../run-contract/index.js"
import type {
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunRecordClockService,
  RunRecordDiagnostics,
  RunLink,
  RunRecordStoreService,
  RunRecordView,
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
  readonly consume: (
    binding: SubmissionBinding,
  ) => Effect.Effect<void, RunRecordError>
}

const submissionPermitConsumers = new WeakMap<SubmissionPermit, SubmissionPermitConsumer>()

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
  kind: "attempt_reserved" | "submission_may_have_started" | "provider_evidence_received" | "generated_output_persisted" | "seedance_poll_persisted" | "donor_choice_opened" | "donor_selected" | "assembly_persisted" | "checks_persisted" | "video_checks_persisted" | "definitive_pre_submit_failure"
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
  const request = canonicalRequest as CanonicalRunRequest
  if (!isSha256(input.payloadSha256)) {
    throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "The payload digest must be a lowercase SHA-256.")
  }
  return request
}

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
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check input is not valid raster JSON.", "repair-evidence")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check input is not a raster object.", "repair-evidence")
  }
  const { width, height, pixels } = value as Record<string, unknown>
  if (
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    !Array.isArray(pixels) || pixels.length !== width * height * 4 ||
    pixels.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new RunRecordError("CHECKS_NOT_PASSED", "A Fidelity Check raster has invalid dimensions or RGBA channels.", "repair-evidence")
  }
  return { width, height, pixels: pixels as ReadonlyArray<number> }
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

const validReplaySampleTable = (
  value: Uint8Array,
  stbl: ReplayMp4Box,
  mediaData: ReadonlyArray<ReplayMp4Box>,
  handler: string,
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
  const sampleEntrySize = readReplayUint32(value, stsd.contentStart + 8)
  if (sampleEntrySize < 8 || stsd.contentStart + 8 + sampleEntrySize > stsd.end) return false
  const codec = Buffer.from(value.subarray(stsd.contentStart + 12, stsd.contentStart + 16)).toString("ascii")
  if (
    (handler === "vide" && !/^(?:avc1|avc3|hvc1|hev1|av01|vp09|mp4v)$/.test(codec)) ||
    (handler === "soun" && !/^(?:mp4a|ac-3|ec-3|Opus)$/.test(codec)) ||
    (handler !== "vide" && handler !== "soun")
  ) return false
  const sampleSize = readReplayUint32(value, stsz.contentStart + 4)
  const sampleCount = readReplayUint32(value, stsz.contentStart + 8)
  if (sampleCount < 1) return false
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
    if (!validReplaySampleTable(value, stbl, mediaData, handler)) continue
    if (handler === "vide") {
      videoTrack = {
        width: readReplayUint32(value, tkhd.end - 8) / 65_536,
        height: readReplayUint32(value, tkhd.end - 4) / 65_536,
      }
    } else if (handler === "soun") {
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
  return { width, height, durationSeconds: duration / timescale, hasAudio }
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
  const runRequest = canonicalRequest as unknown as CanonicalRunRequest
  if (stringPayload(genesis.payload, "requestSha256") !== requestSha256) {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request bytes changed.", "repair-evidence")
  }
  const linkedFrom = linkPayload(genesis.payload)
  if (
    stringPayload(genesis.payload, "estimatedMaximumCostUsd") !== requestDocument.estimatedMaximumCostUsd ||
    numberPayload(genesis.payload, "maximumCount") !== requestDocument.requestedCount ||
    stringPayload(genesis.payload, "maximumSpendUsd") !== requestDocument.budgetCeilingUsd ||
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
  let classification: "verified_candidate" | undefined
  let providerJobId: string | undefined
  let pollCount = 0
  let completedCount: number | undefined
  let costState: "actual" | "estimated-only" | "unknown" | undefined
  let actualCostUsd: string | undefined
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
    if (event.kind === "provider_evidence_received") {
      if (phase !== "submission_may_have_started") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence was recorded before submission uncertainty.")
      }
      const applicationPath = stringPayload(event.payload, "applicationPath")
      const evidenceSha256 = stringPayload(event.payload, "sha256")
      const byteLength = numberPayload(event.payload, "byteLength")
      const mediaType = stringPayload(event.payload, "mediaType")
      const storedEvidence = evidenceBytes[applicationPath]
      if (mediaType !== "application/json" || storedEvidence === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is named by the journal but missing.`, "repair-evidence")
      }
      if (storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", `${applicationPath} no longer matches its event receipt.`, "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType })
      if (runRequest.mode === "seedance-video") {
        let providerDocument: unknown
        try {
          providerDocument = JSON.parse(Buffer.from(storedEvidence).toString("utf8"))
        } catch {
          throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance provider evidence is not valid JSON.", "repair-evidence")
        }
        const provider = providerDocument as Readonly<Record<string, unknown>>
        if (
          providerDocument === null || typeof providerDocument !== "object" || Array.isArray(providerDocument) ||
          valueHasSecret(providerDocument) ||
          typeof provider.job_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider.job_id) ||
          (provider.status !== "submitted" && provider.status !== "queued")
        ) {
          throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance provider evidence must bind one sanitized submitted job.", "repair-evidence")
        }
        providerJobId = provider.job_id
      }
      phase = "provider_evidence_received"
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
      try {
        pollDocument = JSON.parse(Buffer.from(pollEvidence).toString("utf8"))
      } catch {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence is not valid JSON.", "repair-evidence")
      }
      const poll = pollDocument as Readonly<Record<string, unknown>>
      if (
        pollDocument === null || typeof pollDocument !== "object" || Array.isArray(pollDocument) ||
        valueHasSecret(pollDocument) ||
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
        !/^outputs\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(applicationPath) ||
        applicationPath.includes("..") ||
        mediaType.trim().length === 0 ||
        !isSha256(evidenceSha256) ||
        evidence.some((item) => item.applicationPath === applicationPath)
      ) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output journal metadata is unsafe or malformed.", "repair-evidence")
      }
      if (evidence.filter((item) => item.applicationPath.startsWith("outputs/")).length >= base.maximumCount) {
        throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Generated output evidence exceeds the reserved maximum count.", "repair-evidence")
      }
      if (storedEvidence === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is named by the journal but missing.`, "repair-evidence")
      }
      if (storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256) {
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
    if (event.kind === "definitive_pre_submit_failure") {
      if (phase !== "reserved") {
        throw new RunRecordError("ILLEGAL_TRANSITION", "A definitive pre-submit failure was recorded after submission uncertainty.")
      }
      stringPayload(event.payload, "class")
      stringPayload(event.payload, "message")
      phase = "definitive_pre_submit_failure"
      spendState = "not_spent"
      retryState = "new-linked-run-only"
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
  if (request.linkedRun !== undefined) {
    const parent = yield* loadRun(request.linkedRun.parentRunId)
    if (
      parent.phase !== "definitive_pre_submit_failure" ||
      parent.chainHeadSha256 !== request.linkedRun.parentFailureEventSha256
    ) {
      return yield* Effect.fail(new RunRecordError(
        "LINK_FAILURE_MISMATCH",
        "The successor does not name the verified definitive failure event.",
        "new-linked-run",
      ))
    }
  }
  const clock = yield* RunRecordClock
  const timestamp = yield* clock.now()
  const runId = runIdentity(input.plannedRun.requestSha256)
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
        return Effect.succeed(existing)
      }))
    }),
  )
})

const credentialFieldName = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^x/, "")
  if (["prompttokens", "completiontokens", "totaltokens", "cachedtokens", "reasoningtokens"].includes(normalized)) {
    return false
  }
  return /(?:api|access|private)key$/.test(normalized) ||
    /(?:secret|password|credential)(?:key|value)?$/.test(normalized) ||
    /authorization$/.test(normalized) ||
    /(?:sig|signature)$/.test(normalized) ||
    /credentials?$/.test(normalized) ||
    /^(?:auth|authentication|authorization)(?:data|header|info|token|value)?$/.test(normalized) ||
    /token$/.test(normalized) ||
    /cookie$/.test(normalized) ||
    /^(?:request|response)?headers$/.test(normalized) ||
    normalized === "credential"
}

const valueHasSecret = (value: unknown, key?: string): boolean => {
  if (key !== undefined && credentialFieldName(key)) {
    return true
  }
  if (typeof value === "string") {
    let credentialQuery = false
    try {
      const parsed = new URL(value, "https://run-record.invalid")
      credentialQuery = [...parsed.searchParams.keys()].some(credentialFieldName)
    } catch {
      credentialQuery = /[?&](?:api[_-]?key|access[_-]?key|password|secret|authorization|(?:access|refresh|id)?[_-]?token)=/i.test(value)
    }
    return credentialQuery ||
      /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(value) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value)
  }
  if (Array.isArray(value)) return value.some((child) => valueHasSecret(child))
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) => valueHasSecret(child, childKey))
  }
  return false
}

const validateProviderEvidence = (operation: Extract<RecordOperation, { _tag: "CommitProviderEvidence" }>): void => {
  if (
    operation.evidence.mediaType !== "application/json" ||
    !isSha256(operation.evidence.sha256) || sha256(operation.evidence.body) !== operation.evidence.sha256
  ) {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence does not match its declared SHA-256.", "repair-evidence")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(operation.evidence.body).toString("utf8"))
  } catch {
    throw new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence must be valid sanitized JSON.", "repair-evidence")
  }
  if (valueHasSecret(parsed)) {
    throw new RunRecordError("SECRET_MATERIAL_DETECTED", "Provider evidence contains credential material.", "repair-evidence")
  }
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
  const runRequest = JSON.parse(Buffer.from(stored.request).toString("utf8")) as CanonicalRunRequest
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
                : "definitive_pre_submit_failure"
  const replayed = events.find((event) => event.operationId === operation.operationId)
  if (replayed !== undefined) {
    if (replayed.kind !== expectedKind) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was reused for different evidence."))
    }
    if (
      operation._tag === "CommitProviderEvidence" &&
      (
        stringPayload(replayed.payload, "sha256") !== operation.evidence.sha256 ||
        sha256(operation.evidence.body) !== operation.evidence.sha256
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different provider evidence."))
    }
    if (
      operation._tag === "CommitGeneratedOutput" &&
      (
        stringPayload(replayed.payload, "applicationPath") !== operation.output.applicationPath ||
        stringPayload(replayed.payload, "sha256") !== operation.output.sha256 ||
        stringPayload(replayed.payload, "mediaType") !== operation.output.mediaType ||
        sha256(operation.output.body) !== operation.output.sha256
      )
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different generated output evidence."))
    }
    if (operation._tag === "CommitSeedancePoll") {
      const replayedOutputs = replayed.payload.outputs
      const operationOutputs = operation.status === "completed"
        ? operation.outputs.map((output) => ({
            applicationPath: output.applicationPath,
            sha256: output.sha256,
            byteLength: output.body.byteLength,
            mediaType: output.mediaType,
          }))
        : undefined
      if (
        stringPayload(replayed.payload, "jobId") !== operation.jobId ||
        stringPayload(replayed.payload, "status") !== operation.status ||
        stringPayload(replayed.payload, "sha256") !== operation.evidence.sha256 ||
        sha256(operation.evidence.body) !== operation.evidence.sha256 ||
        canonicalJson((replayedOutputs ?? null) as JsonValue) !== canonicalJson((operationOutputs ?? null) as JsonValue) ||
        (operation.status === "completed" && (
          operation.outputs.some((output) => sha256(output.body) !== output.sha256) ||
          numberPayload(replayed.payload, "completedCount") !== operation.completedCount ||
          stringPayload(replayed.payload, "costState") !== operation.cost.state ||
          (replayed.payload.actualCostUsd ?? null) !== (operation.cost.actualCostUsd ?? null)
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
    return { _tag: "ReplayObserved" as const, view: current }
  }
  if (operation._tag === "CommitProviderEvidence") {
    if (current.phase !== "submission_may_have_started") {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Provider evidence requires the durable submission marker."))
    }
    yield* Effect.try({
      try: () => validateProviderEvidence(operation),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Provider evidence validation failed.", "repair-evidence"),
    })
    const applicationPath = "provider-response.json"
    yield* store.writeEvidence(operation.runId, applicationPath, operation.evidence.body)
    const clock = yield* RunRecordClock
    const timestamp = yield* clock.now()
    const event = makeEvent({
      schemaVersion: "1",
      sequence: events.length + 1,
      operationId: operation.operationId,
      runId: operation.runId,
      timestamp,
      kind: "provider_evidence_received",
      previousEventSha256: current.chainHeadSha256,
      payload: {
        applicationPath,
        sha256: operation.evidence.sha256,
        byteLength: operation.evidence.body.byteLength,
        mediaType: operation.evidence.mediaType,
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [applicationPath]: operation.evidence.body,
    })
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
      !/^outputs\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(operation.output.applicationPath) ||
      operation.output.applicationPath.includes("..") ||
      operation.output.mediaType.trim().length === 0 ||
      current.evidence.some((item) => item.applicationPath === operation.output.applicationPath) ||
      !isSha256(operation.output.sha256) ||
      sha256(operation.output.body) !== operation.output.sha256
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Generated output evidence is unsafe or does not match its declared SHA-256.", "repair-evidence"))
    }
    yield* store.writeEvidence(operation.runId, operation.output.applicationPath, operation.output.body)
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
        applicationPath: operation.output.applicationPath,
        sha256: operation.output.sha256,
        byteLength: operation.output.body.byteLength,
        mediaType: operation.output.mediaType,
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const next = replay(operation.runId, stored.request, [...events, event], {
      ...stored.evidence,
      [operation.output.applicationPath]: operation.output.body,
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
    yield* Effect.try({
      try: () => validateProviderEvidence({
        _tag: "CommitProviderEvidence",
        runId: operation.runId,
        operationId: operation.operationId,
        evidence: operation.evidence,
      }),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence validation failed.", "repair-evidence"),
    })
    let pollDocument: unknown
    try {
      pollDocument = JSON.parse(Buffer.from(operation.evidence.body).toString("utf8"))
    } catch {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence is not valid JSON.", "repair-evidence"))
    }
    const poll = pollDocument as Readonly<Record<string, unknown>>
    if (
      pollDocument === null || typeof pollDocument !== "object" || Array.isArray(pollDocument) ||
      poll.job_id !== operation.jobId || poll.status !== operation.status
    ) {
      return yield* Effect.fail(new RunRecordError("EVIDENCE_HASH_MISMATCH", "Seedance poll evidence substituted its job identity or status.", "repair-evidence"))
    }
    let outputReceipts: ReadonlyArray<Readonly<Record<string, JsonValue>>> | undefined
    if (operation.status === "completed") {
      if (
        !Number.isSafeInteger(operation.completedCount) ||
        operation.completedCount !== current.maximumCount ||
        operation.outputs.length !== operation.completedCount ||
        (operation.cost.state !== "actual" && operation.cost.state !== "estimated-only" && operation.cost.state !== "unknown") ||
        (operation.cost.state !== "actual" && operation.cost.actualCostUsd !== undefined) ||
        (operation.cost.state === "actual" &&
          (operation.cost.actualCostUsd === undefined || !/^(?:0|[1-9]\d*)\.\d{2,6}$/.test(operation.cost.actualCostUsd)))
      ) {
        return yield* Effect.fail(new RunRecordError("RESERVATION_OUTSIDE_PLAN", "Seedance completion contradicts the reserved count or cost contract."))
      }
      const paths = new Set<string>()
      for (const output of operation.outputs) {
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
      outputReceipts = operation.outputs.map((output) => ({
        applicationPath: output.applicationPath,
        sha256: output.sha256,
        byteLength: output.body.byteLength,
        mediaType: output.mediaType,
      }))
    }
    const applicationPath = `polls/poll-${String((current.pollCount ?? 0) + 1).padStart(4, "0")}.json`
    yield* store.writeEvidence(operation.runId, applicationPath, operation.evidence.body)
    if (operation.status === "completed") {
      for (const output of operation.outputs) {
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
        sha256: operation.evidence.sha256,
        byteLength: operation.evidence.body.byteLength,
        mediaType: operation.evidence.mediaType,
        jobId: operation.jobId,
        status: operation.status,
        ...(operation.status === "pending"
          ? {}
          : {
              outputs: outputReceipts!,
              completedCount: operation.completedCount,
              costState: operation.cost.state,
              ...(operation.cost.actualCostUsd === undefined ? {} : { actualCostUsd: operation.cost.actualCostUsd }),
            }),
      },
    })
    yield* store.appendEvent(operation.runId, current.chainHeadSha256, encodeEvent(event))
    const nextEvidence = {
      ...stored.evidence,
      [applicationPath]: operation.evidence.body,
      ...(operation.status === "pending"
        ? {}
        : Object.fromEntries(operation.outputs.map((output) => [output.applicationPath, output.body]))),
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
  if (operation._tag === "DefinitivePreSubmitFailure") {
    if (current.phase !== "reserved") {
      return yield* Effect.fail(new RunRecordError("ILLEGAL_TRANSITION", "Only a reserved Run can end before submission."))
    }
    if (
      !isIdentifier(operation.failure.class) ||
      operation.failure.message.trim().length === 0 ||
      operation.failure.message.length > 500 ||
      valueHasSecret(operation.failure)
    ) {
      return yield* Effect.fail(new RunRecordError(
        valueHasSecret(operation.failure) ? "SECRET_MATERIAL_DETECTED" : "ILLEGAL_TRANSITION",
        "The definitive failure must be safe, named, and non-empty.",
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
  let consumed = false
  const consumePermit = (
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
    if (consumed) {
      return Effect.fail(new RunRecordError(
        "DUPLICATE_SUBMISSION_BLOCKED",
        "The in-process Submission Permit was already consumed.",
        "reconcile",
      ))
    }
    consumed = true
    return Effect.void
  })
  const permit = immutable({
    runId: operation.runId,
    attemptId: next.attemptId,
    requestSha256: next.requestSha256,
    payloadSha256: next.payloadSha256,
  })
  submissionPermitConsumers.set(permit, { consume: consumePermit })
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
  if (!view.evidence.some((item) => item.applicationPath === applicationPath)) {
    return yield* Effect.fail(new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is not named by the verified Run journal.`, "repair-evidence"))
  }
  const value = stored.evidence[applicationPath]
  if (value === undefined) {
    return yield* Effect.fail(new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is missing.`, "repair-evidence"))
  }
  return Uint8Array.from(value)
})
