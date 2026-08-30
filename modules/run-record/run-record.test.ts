import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  compilePlannedRun,
  type PlannedRun,
} from "../run-contract/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  RunRecordClock,
  RunRecordStore,
  load,
  makeFileRunRecordStore,
  record,
  reserve,
  type RunRecordClockService,
  type RunRecordStoreService,
} from "./index.js"
import { makeMemoryRunRecordStore } from "./memory-store.js"

const clock: RunRecordClockService = {
  now: () => Effect.succeed("2026-08-30T12:00:00.000Z"),
}

const reservationFor = (planned: PlannedRun) => ({
  plannedRun: planned,
  payloadSha256: planned.requestSha256,
  estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
  maximumCount: planned.request.requestedCount,
  maximumSpendUsd: planned.request.budgetCeilingUsd,
})

const plannedRun = async (): Promise<PlannedRun> => {
  const fixture = makeFixture("qwen-image")
  return Effect.runPromise(
    compilePlannedRun(fixture.documents).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
}

test("reserves and reloads the immutable request before any submission", async () => {
  const planned = await plannedRun()
  const memory = makeMemoryRunRecordStore()
  const input = {
    plannedRun: planned,
    payloadSha256: planned.requestSha256,
    estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    maximumCount: planned.request.requestedCount,
    maximumSpendUsd: planned.request.budgetCeilingUsd,
  }

  const reserved = await Effect.runPromise(
    reserve(input).pipe(
      Effect.provideService(RunRecordStore, memory.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  const reloaded = await Effect.runPromise(
    load(reserved.runId).pipe(Effect.provideService(RunRecordStore, memory.service)),
  )

  assert.equal(reloaded.phase, "reserved")
  assert.equal(reloaded.requestSha256, planned.requestSha256)
  assert.equal(reloaded.payloadSha256, planned.requestSha256)
  assert.equal(reloaded.maximumCount, 1)
  assert.equal(reloaded.spendState, "not_spent")
  assert.equal(reloaded.retryState, "same-run-submission-available")
  assert.match(reloaded.attemptId, /^attempt-[a-f0-9]+-1$/)
  assert.match(reloaded.chainHeadSha256, /^[a-f0-9]{64}$/)
  assert.equal(memory.submissionCalls, 0)
})

test("persists submission uncertainty before issuing one non-replayable permit", async () => {
  const planned = await plannedRun()
  const memory = makeMemoryRunRecordStore()
  const reserved = await Effect.runPromise(
    reserve({
      plannedRun: planned,
      payloadSha256: planned.requestSha256,
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
      maximumCount: planned.request.requestedCount,
      maximumSpendUsd: planned.request.budgetCeilingUsd,
    }).pipe(
      Effect.provideService(RunRecordStore, memory.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  )

  const marked = await Effect.runPromise(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-once",
    }).pipe(
      Effect.provideService(RunRecordStore, memory.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(marked._tag, "SubmissionPermitIssued")
  if (marked._tag !== "SubmissionPermitIssued") return

  let adapterCalls = 0
  const fakeAdapter = async () => {
    const visibleBeforeCall = await Effect.runPromise(
      load(reserved.runId).pipe(Effect.provideService(RunRecordStore, memory.service)),
    )
    assert.equal(visibleBeforeCall.phase, "submission_may_have_started")
    assert.equal(visibleBeforeCall.spendState, "possibly_spent")
    assert.equal(visibleBeforeCall.retryState, "reconcile-only")
    adapterCalls += 1
  }
  await fakeAdapter()

  const replay = await Effect.runPromise(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-once",
    }).pipe(
      Effect.provideService(RunRecordStore, memory.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(replay._tag, "ReplayObserved")
  assert.equal(adapterCalls, 1)

  const duplicate = await Effect.runPromise(
    Effect.flip(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-twice",
    })).pipe(
      Effect.provideService(RunRecordStore, memory.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")
})

test("commits provider evidence write-once and replays its verified hash", async () => {
  const planned = await plannedRun()
  const memory = makeMemoryRunRecordStore()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provideService(RunRecordStore, memory.service),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve({
    plannedRun: planned,
    payloadSha256: planned.requestSha256,
    estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    maximumCount: planned.request.requestedCount,
    maximumSpendUsd: planned.request.budgetCeilingUsd,
  })))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "submit-provider-evidence",
  })))

  const body = Buffer.from('{"request_id":"fake-001","status":"accepted"}', "utf8")
  const digest = createHash("sha256").update(body).digest("hex")
  const committed = await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "record-provider-evidence",
    evidence: { mediaType: "application/json", body, sha256: digest },
  })))
  assert.equal(committed._tag, "Recorded")
  assert.equal(committed.view.phase, "provider_evidence_received")
  assert.equal(committed.view.spendState, "unknown")
  assert.equal(committed.view.retryState, "never-resubmit")
  assert.deepEqual(committed.view.evidence, [{
    applicationPath: "provider-response.json",
    sha256: digest,
    byteLength: body.length,
    mediaType: "application/json",
  }])

  const reloaded = await Effect.runPromise(
    load(reserved.runId).pipe(Effect.provideService(RunRecordStore, memory.service)),
  )
  assert.deepEqual(reloaded, committed.view)

  const changed = Buffer.from('{"request_id":"fake-001","status":"changed"}', "utf8")
  const changedError = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "record-provider-evidence",
    evidence: {
      mediaType: "application/json",
      body: changed,
      sha256: createHash("sha256").update(changed).digest("hex"),
    },
  }))))
  assert.equal(changedError.code, "IDEMPOTENCY_CONFLICT")
})

test("a definitive pre-submit failure remains immutable and only supports a proved linked Run", async () => {
  const planned = await plannedRun()
  const memory = makeMemoryRunRecordStore()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provideService(RunRecordStore, memory.service),
    Effect.provideService(RunRecordClock, clock),
  )
  const reservation = {
    plannedRun: planned,
    payloadSha256: planned.requestSha256,
    estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    maximumCount: planned.request.requestedCount,
    maximumSpendUsd: planned.request.budgetCeilingUsd,
  }
  const original = await Effect.runPromise(provide(reserve(reservation)))
  const failed = await Effect.runPromise(provide(record({
    _tag: "DefinitivePreSubmitFailure",
    runId: original.runId,
    operationId: "client-initialization-failed",
    failure: { class: "client_initialization", message: "Fake client could not initialize." },
  })))
  assert.equal(failed._tag, "Recorded")
  assert.equal(failed.view.phase, "definitive_pre_submit_failure")
  assert.equal(failed.view.spendState, "not_spent")
  assert.equal(failed.view.retryState, "new-linked-run-only")

  const linkedFrom = {
    parentRunId: original.runId,
    parentFailureEventSha256: failed.view.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure" as const,
  }
  const successor = await Effect.runPromise(provide(reserve({ ...reservation, linkedFrom })))
  assert.notEqual(successor.runId, original.runId)
  assert.deepEqual(successor.linkedFrom, linkedFrom)
  assert.equal(successor.phase, "reserved")

  const falseLink = await Effect.runPromise(Effect.flip(provide(reserve({
    ...reservation,
    linkedFrom: { ...linkedFrom, parentFailureEventSha256: "0".repeat(64) },
  }))))
  assert.equal(falseLink.code, "LINK_FAILURE_MISMATCH")

  const originalAfter = await Effect.runPromise(
    load(original.runId).pipe(Effect.provideService(RunRecordStore, memory.service)),
  )
  assert.deepEqual(originalAfter, failed.view)
})

test("interruption at every persistence and network seam never creates a second submission", async () => {
  const planned = await plannedRun()
  const execute = <Success, Error>(
    memory: ReturnType<typeof makeMemoryRunRecordStore>,
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provideService(RunRecordStore, memory.service),
    Effect.provideService(RunRecordClock, clock),
  ))

  const beforeReservation = makeMemoryRunRecordStore()
  beforeReservation.failNext("create")
  const createError = await Effect.runPromise(Effect.flip(
    reserve(reservationFor(planned)).pipe(
      Effect.provideService(RunRecordStore, beforeReservation.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(createError.code, "DURABILITY_FAILURE")

  const beforeMarker = makeMemoryRunRecordStore()
  const reservedBeforeMarker = await execute(beforeMarker, reserve(reservationFor(planned)))
  beforeMarker.failNext("append-event")
  const markerError = await Effect.runPromise(Effect.flip(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reservedBeforeMarker.runId,
      operationId: "interrupted-marker",
    }).pipe(
      Effect.provideService(RunRecordStore, beforeMarker.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(markerError.code, "DURABILITY_FAILURE")
  assert.equal((await execute(beforeMarker, load(reservedBeforeMarker.runId))).phase, "reserved")
  const firstPermit = await execute(beforeMarker, record({
    _tag: "SubmissionMayHaveStarted",
    runId: reservedBeforeMarker.runId,
    operationId: "interrupted-marker",
  }))
  assert.equal(firstPermit._tag, "SubmissionPermitIssued")

  const afterNetwork = makeMemoryRunRecordStore()
  const reservedAfterNetwork = await execute(afterNetwork, reserve(reservationFor(planned)))
  const networkPermit = await execute(afterNetwork, record({
    _tag: "SubmissionMayHaveStarted",
    runId: reservedAfterNetwork.runId,
    operationId: "network-started",
  }))
  assert.equal(networkPermit._tag, "SubmissionPermitIssued")
  let submissionCalls = 0
  const ambiguousFakeAdapter = async () => {
    submissionCalls += 1
    throw new Error("simulated lost response")
  }
  await assert.rejects(ambiguousFakeAdapter, /lost response/)
  assert.equal((await execute(afterNetwork, load(reservedAfterNetwork.runId))).phase, "submission_may_have_started")
  const secondPermitError = await Effect.runPromise(Effect.flip(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reservedAfterNetwork.runId,
      operationId: "network-retry",
    }).pipe(
      Effect.provideService(RunRecordStore, afterNetwork.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(secondPermitError.code, "DUPLICATE_SUBMISSION_BLOCKED")
  assert.equal(submissionCalls, 1)

  const evidenceBody = Buffer.from('{"request_id":"fake-interruption","status":"accepted"}', "utf8")
  const evidenceSha256 = createHash("sha256").update(evidenceBody).digest("hex")
  for (const failedWrite of ["write-evidence", "append-event", "write-state"] as const) {
    const memory = makeMemoryRunRecordStore()
    const reserved = await execute(memory, reserve(reservationFor(planned)))
    await execute(memory, record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `submit-before-${failedWrite}`,
    }))
    submissionCalls += 1
    memory.failNext(failedWrite)
    const persistenceError = await Effect.runPromise(Effect.flip(
      record({
        _tag: "CommitProviderEvidence",
        runId: reserved.runId,
        operationId: `evidence-after-${failedWrite}`,
        evidence: { mediaType: "application/json", body: evidenceBody, sha256: evidenceSha256 },
      }).pipe(
        Effect.provideService(RunRecordStore, memory.service),
        Effect.provideService(RunRecordClock, clock),
      ),
    ))
    assert.equal(persistenceError.code, "DURABILITY_FAILURE")
    const afterFailure = await execute(memory, load(reserved.runId))
    assert.equal(
      afterFailure.phase,
      failedWrite === "write-state" ? "provider_evidence_received" : "submission_may_have_started",
    )
    if (failedWrite !== "write-state") {
      const recovered = await execute(memory, record({
        _tag: "CommitProviderEvidence",
        runId: reserved.runId,
        operationId: `evidence-after-${failedWrite}`,
        evidence: { mediaType: "application/json", body: evidenceBody, sha256: evidenceSha256 },
      }))
      assert.equal(recovered.view.phase, "provider_evidence_received")
    }
  }
  assert.equal(submissionCalls, 4)
})

test("a fresh process reloads the same hash-chained Run from an application filesystem", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const artifactRoot = "artifacts/qwen-pipeline"
  const planned = await plannedRun()
  const firstStore = makeFileRunRecordStore(applicationRoot, artifactRoot)
  const execute = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provideService(RunRecordStore, firstStore),
    Effect.provideService(RunRecordClock, clock),
  ))

  const reserved = await execute(reserve(reservationFor(planned)))
  await execute(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "filesystem-submit",
  }))
  const body = Buffer.from('{"request_id":"filesystem-fake","status":"accepted"}', "utf8")
  const digest = createHash("sha256").update(body).digest("hex")
  const committed = await execute(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "filesystem-evidence",
    evidence: { mediaType: "application/json", body, sha256: digest },
  }))

  const runDirectory = join(applicationRoot, artifactRoot, "runs", reserved.runId)
  assert.equal((await readFile(join(runDirectory, "request.json"), "utf8")), planned.canonicalRequest)
  assert.equal((await readFile(join(runDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n").length, 3)
  assert.deepEqual(await readFile(join(runDirectory, "provider-response.json")), body)

  const freshStore = makeFileRunRecordStore(applicationRoot, artifactRoot)
  const reloaded = await Effect.runPromise(
    load(reserved.runId).pipe(Effect.provideService(RunRecordStore, freshStore)),
  )
  assert.deepEqual(reloaded, committed.view)

  const falseView = { ...reloaded, phase: "reserved" }
  await writeFile(join(runDirectory, "state.json"), JSON.stringify(falseView), "utf8")
  const contradiction = await Effect.runPromise(Effect.flip(
    load(reserved.runId).pipe(Effect.provideService(RunRecordStore, freshStore)),
  ))
  assert.equal(contradiction.code, "DERIVED_VIEW_CONTRADICTION")
})

test("tampered requests, event chains, evidence, and illegal rewrites fail by name", async () => {
  const planned = await plannedRun()
  const execute = <Success, Error>(
    memory: ReturnType<typeof makeMemoryRunRecordStore>,
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provideService(RunRecordStore, memory.service),
    Effect.provideService(RunRecordClock, clock),
  ))

  const changedRequest = makeMemoryRunRecordStore()
  const requestRun = await execute(changedRequest, reserve(reservationFor(planned)))
  changedRequest.mutate(requestRun.runId, (stored) => {
    stored.request[0] = stored.request[0]! ^ 1
  })
  const requestError = await Effect.runPromise(Effect.flip(
    load(requestRun.runId).pipe(Effect.provideService(RunRecordStore, changedRequest.service)),
  ))
  assert.equal(requestError.code, "REQUEST_TAMPERED")

  const brokenEvents = makeMemoryRunRecordStore()
  const eventRun = await execute(brokenEvents, reserve(reservationFor(planned)))
  brokenEvents.mutate(eventRun.runId, (stored) => {
    const event = JSON.parse(Buffer.from(stored.events).toString("utf8")) as Record<string, unknown>
    event.payload = { ...(event.payload as object), maximumCount: 99 }
    stored.events = Buffer.from(`${JSON.stringify(event)}\n`, "utf8")
  })
  const chainError = await Effect.runPromise(Effect.flip(
    load(eventRun.runId).pipe(Effect.provideService(RunRecordStore, brokenEvents.service)),
  ))
  assert.equal(chainError.code, "EVENT_CHAIN_BROKEN")

  const changedEvidence = makeMemoryRunRecordStore()
  const evidenceRun = await execute(changedEvidence, reserve(reservationFor(planned)))
  await execute(changedEvidence, record({
    _tag: "SubmissionMayHaveStarted",
    runId: evidenceRun.runId,
    operationId: "tamper-submit",
  }))
  const body = Buffer.from('{"request_id":"tamper-fake","status":"accepted"}', "utf8")
  await execute(changedEvidence, record({
    _tag: "CommitProviderEvidence",
    runId: evidenceRun.runId,
    operationId: "tamper-evidence",
    evidence: {
      mediaType: "application/json",
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  }))
  changedEvidence.mutate(evidenceRun.runId, (stored) => {
    const providerResponse = stored.evidence["provider-response.json"]
    if (providerResponse === undefined || providerResponse[0] === undefined) throw new Error("fixture evidence missing")
    providerResponse[0] ^= 1
  })
  const evidenceError = await Effect.runPromise(Effect.flip(
    load(evidenceRun.runId).pipe(Effect.provideService(RunRecordStore, changedEvidence.service)),
  ))
  assert.equal(evidenceError.code, "EVIDENCE_HASH_MISMATCH")

  const illegalRewrite = await Effect.runPromise(Effect.flip(
    record({
      _tag: "CommitProviderEvidence",
      runId: evidenceRun.runId,
      operationId: "replace-evidence",
      evidence: {
        mediaType: "application/json",
        body,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    }).pipe(
      Effect.provideService(RunRecordStore, changedEvidence.service),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(illegalRewrite.code, "EVIDENCE_HASH_MISMATCH")
})
