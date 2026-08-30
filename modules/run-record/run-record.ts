import { createHash } from "node:crypto"

import { Effect } from "effect"

import { RunRecordError } from "./errors.js"
import type {
  RecordOperation,
  RecordResult,
  ReserveRun,
  RunRecordClockService,
  RunLink,
  RunRecordStoreService,
  RunRecordView,
} from "./types.js"
import {
  RunRecordClock,
  RunRecordStore,
  submissionPermitBrand,
} from "./types.js"

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | {
  readonly [key: string]: JsonValue
}

type RunEvent = Readonly<{
  schemaVersion: "1"
  sequence: number
  operationId: string
  runId: string
  timestamp: string
  kind: "attempt_reserved" | "submission_may_have_started" | "provider_evidence_received" | "definitive_pre_submit_failure"
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

const isSha256 = (value: string): boolean => /^[a-f0-9]{64}$/.test(value)
const isIdentifier = (value: string): boolean => /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)

const validateReservation = (input: ReserveRun): void => {
  const { plannedRun } = input
  if (plannedRun.state !== "planned") {
    throw new RunRecordError("INVALID_PLANNED_RUN", "Only a Planned Run may be reserved.")
  }
  if (sha256(plannedRun.canonicalRequest) !== plannedRun.requestSha256) {
    throw new RunRecordError("REQUEST_HASH_MISMATCH", "The canonical request no longer matches its planned digest.")
  }
  if (!isSha256(input.payloadSha256)) {
    throw new RunRecordError("RESERVATION_OUTSIDE_PLAN", "The payload digest must be a lowercase SHA-256.")
  }
  if (
    input.estimatedMaximumCostUsd !== plannedRun.request.estimatedMaximumCostUsd ||
    input.maximumCount !== plannedRun.request.requestedCount ||
    input.maximumSpendUsd !== plannedRun.request.budgetCeilingUsd
  ) {
    throw new RunRecordError(
      "RESERVATION_OUTSIDE_PLAN",
      "Attempt count and spend evidence must exactly match the immutable request.",
    )
  }
}

const runIdentity = (requestSha256: string, linkedFrom?: RunLink): string =>
  `run-${sha256(canonicalJson({
    requestSha256,
    linkedFrom: linkedFrom === undefined ? null : linkedFrom,
  } as unknown as JsonValue)).slice(0, 24)}`

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
  if (stringPayload(genesis.payload, "requestSha256") !== requestSha256) {
    throw new RunRecordError("REQUEST_TAMPERED", "The immutable request bytes changed.", "repair-evidence")
  }
  const linkedFrom = linkPayload(genesis.payload)
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
      if (storedEvidence === undefined) {
        throw new RunRecordError("EVIDENCE_MISSING", `${applicationPath} is named by the journal but missing.`, "repair-evidence")
      }
      if (storedEvidence.byteLength !== byteLength || sha256(storedEvidence) !== evidenceSha256) {
        throw new RunRecordError("EVIDENCE_HASH_MISMATCH", `${applicationPath} no longer matches its event receipt.`, "repair-evidence")
      }
      evidence.push({ applicationPath, sha256: evidenceSha256, byteLength, mediaType })
      phase = "provider_evidence_received"
      spendState = "unknown"
      retryState = "never-resubmit"
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
  })
}

const decodeStoredView = (value: Uint8Array): RunRecordView => {
  try {
    return JSON.parse(Buffer.from(value).toString("utf8")) as RunRecordView
  } catch {
    throw new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view is invalid JSON.", "repair-evidence")
  }
}

export const reserveRun = (
  input: ReserveRun,
): Effect.Effect<RunRecordView, RunRecordError, RunRecordStoreService | RunRecordClockService> => Effect.gen(function*() {
  yield* Effect.try({
    try: () => validateReservation(input),
    catch: (error) => error instanceof RunRecordError
      ? error
      : new RunRecordError("INVALID_PLANNED_RUN", "The Planned Run could not be validated."),
  })
  const store = yield* RunRecordStore
  if (input.linkedFrom !== undefined) {
    const parentStored = yield* store.read(input.linkedFrom.parentRunId)
    const parentEvents = yield* Effect.try({
      try: () => parseEvents(parentStored.events),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("LINK_NOT_ALLOWED", "The parent Run journal could not be read."),
    })
    const parent = yield* Effect.try({
      try: () => replay(input.linkedFrom!.parentRunId, parentStored.request, parentEvents, parentStored.evidence),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("LINK_NOT_ALLOWED", "The parent Run could not be verified."),
    })
    if (
      parent.phase !== "definitive_pre_submit_failure" ||
      parent.chainHeadSha256 !== input.linkedFrom.parentFailureEventSha256
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
  const runId = runIdentity(input.plannedRun.requestSha256, input.linkedFrom)
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
      estimatedMaximumCostUsd: input.estimatedMaximumCostUsd,
      maximumCount: input.maximumCount,
      maximumSpendUsd: input.maximumSpendUsd,
      linkedFrom: input.linkedFrom === undefined ? null : input.linkedFrom,
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
          existing.estimatedMaximumCostUsd !== input.estimatedMaximumCostUsd ||
          existing.maximumCount !== input.maximumCount ||
          existing.maximumSpendUsd !== input.maximumSpendUsd ||
          canonicalJson((existing.linkedFrom ?? null) as unknown as JsonValue) !==
            canonicalJson((input.linkedFrom ?? null) as unknown as JsonValue)
        ) {
          return Effect.fail(new RunRecordError("RUN_ID_CONFLICT", "The existing Run identity belongs to different immutable evidence."))
        }
        return Effect.succeed(existing)
      }))
    }),
  )
})

const valueHasSecret = (value: unknown, key?: string): boolean => {
  if (key !== undefined && /(?:credential|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|password|secret|token|authorization)/i.test(key)) {
    return true
  }
  if (typeof value === "string") {
    return /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(value) ||
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
  if (!isSha256(operation.evidence.sha256) || sha256(operation.evidence.body) !== operation.evidence.sha256) {
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
  const expectedKind = operation._tag === "SubmissionMayHaveStarted"
    ? "submission_may_have_started"
    : operation._tag === "CommitProviderEvidence"
      ? "provider_evidence_received"
      : "definitive_pre_submit_failure"
  const replayed = events.find((event) => event.operationId === operation.operationId)
  if (replayed !== undefined) {
    if (replayed.kind !== expectedKind) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was reused for different evidence."))
    }
    if (
      operation._tag === "CommitProviderEvidence" &&
      stringPayload(replayed.payload, "sha256") !== operation.evidence.sha256
    ) {
      return yield* Effect.fail(new RunRecordError("IDEMPOTENCY_CONFLICT", "The operation identity was replayed with different provider evidence."))
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
  yield* store.writeState(operation.runId, encodeView(next))
  return {
    _tag: "SubmissionPermitIssued" as const,
    permit: immutable({
      runId: operation.runId,
      attemptId: next.attemptId,
      [submissionPermitBrand]: true as const,
    }),
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
  if (stored.state !== undefined) {
    const derived = yield* Effect.try({
      try: () => decodeStoredView(stored.state!),
      catch: (error) => error instanceof RunRecordError
        ? error
        : new RunRecordError("DERIVED_VIEW_CONTRADICTION", "The derived state view could not be read.", "repair-evidence"),
    })
    if (
      derived.chainHeadSha256 === view.chainHeadSha256 &&
      canonicalJson(derived as unknown as JsonValue) !== canonicalJson(view as unknown as JsonValue)
    ) {
      return yield* Effect.fail(new RunRecordError(
        "DERIVED_VIEW_CONTRADICTION",
        "The derived state claims the current event head but disagrees with replay.",
        "repair-evidence",
      ))
    }
    if (derived.chainHeadSha256 !== view.chainHeadSha256) {
      yield* store.writeState(runId, encodeView(view))
    }
  } else {
    yield* store.writeState(runId, encodeView(view))
  }
  return view
})
