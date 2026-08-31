import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  RunRecordError,
  computeEventHash,
  createMemoryRunRecordStore,
  validateEventChain,
  type AttemptReservation,
  type ProviderEvidence,
  type SubmissionMarker,
} from "./index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  plan,
} from "../conductor/index.js"

const getPlannedRun = async (mode: "qwen-image" | "seedance-video" = "qwen-image") => {
  const fixture = makeFixture(mode)
  const decision = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  if (decision._tag !== "Planned") {
    throw new Error(`Expected planned run, got ${decision._tag}`)
  }
  return decision.run
}

test("initializes run with canonical request and hashed initial event", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  const state = await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  assert.equal(state.runId, "run-001")
  assert.equal(state.status, "planned")
  assert.equal(state.requestSha256, planned.requestSha256)
  assert.equal(state.events.length, 1)
  assert.equal(state.events[0]!.sequence, 1)
  assert.equal(state.events[0]!.eventType, "RUN_PLANNED")
  assert.equal(state.events[0]!.prevHash, planned.requestSha256)
  assert.equal(state.events[0]!.hash, computeEventHash(state.events[0]!))
})

test("refuses to initialize run at an existing directory", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  await assert.rejects(
    Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001")),
    (err: unknown) => err instanceof RunRecordError && err.code === "ILLEGAL_REWRITE",
  )
})

test("records durable attempt reservation before invocation", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const attempt: AttemptReservation = {
    attemptId: "attempt-123",
    runId: "run-001",
    requestSha256: planned.requestSha256,
    payloadDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    estimateUsd: "0.04",
    maximumCount: 1,
    maximumSpendUsd: "0.05",
    retryAllowed: false,
    billingStatus: "reserved",
  }

  const reservedState = await Effect.runPromise(
    store.recordAttemptReservation("generated/runs/run-001", attempt),
  )

  assert.equal(reservedState.status, "reserved")
  assert.deepEqual(reservedState.attempt, attempt)
  assert.equal(reservedState.events.length, 2)
  assert.equal(reservedState.events[1]!.eventType, "ATTEMPT_RESERVED")
  assert.equal(reservedState.events[1]!.prevHash, reservedState.events[0]!.hash)

  // Re-reserving with the same attempt is idempotent
  const reReserved = await Effect.runPromise(
    store.recordAttemptReservation("generated/runs/run-001", attempt),
  )
  assert.equal(reReserved.events.length, 2)

  // Re-reserving with a different attempt is refused
  await assert.rejects(
    Effect.runPromise(
      store.recordAttemptReservation("generated/runs/run-001", { ...attempt, attemptId: "different" }),
    ),
    (err: unknown) => err instanceof RunRecordError && err.code === "ATTEMPT_ALREADY_RESERVED",
  )
})

test("records durable submission-may-have-started marker immediately before adapter call", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const marker: SubmissionMarker = {
    attemptId: "attempt-123",
    markedAt: new Date().toISOString(),
    submissionMayHaveStarted: true,
    billingStatus: "possibly_spent",
  }

  const state = await Effect.runPromise(
    store.recordSubmissionMayHaveStarted("generated/runs/run-001", marker),
  )

  assert.equal(state.status, "submission_started")
  assert.deepEqual(state.submissionMarker, marker)
  assert.equal(state.events.length, 2)
  assert.equal(state.events[1]!.eventType, "SUBMISSION_STARTED")

  // Re-submitting with different attempt is forbidden
  await assert.rejects(
    Effect.runPromise(
      store.recordSubmissionMayHaveStarted("generated/runs/run-001", {
        ...marker,
        attemptId: "another-attempt",
      }),
    ),
    (err: unknown) => err instanceof RunRecordError && err.code === "DUPLICATE_SUBMISSION_FORBIDDEN",
  )
})

test("records write-once provider evidence and refuses overwrites", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const evidence: ProviderEvidence = {
    status: 200,
    bodyDigest: "body-sha256",
    safeIdentifiers: ["gen-123"],
    outputs: [
      {
        name: "output-01.png",
        sha256: "output-sha256",
        byteLength: 1234,
        mediaType: "image/png",
      },
    ],
    costUsd: "0.04",
  }

  const state = await Effect.runPromise(
    store.recordProviderEvidence("generated/runs/run-001", evidence, [
      { name: "output-01.png", bytes: new Uint8Array([1, 2, 3]) },
    ]),
  )

  assert.equal(state.status, "provider_evidence_received")
  assert.deepEqual(state.providerEvidence, evidence)

  // Attempting to overwrite provider evidence is refused
  await assert.rejects(
    Effect.runPromise(store.recordProviderEvidence("generated/runs/run-001", evidence)),
    (err: unknown) => err instanceof RunRecordError && err.code === "ILLEGAL_REWRITE",
  )
})

test("detects tampered request hash and broken event chains on load", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  // Verify normal load succeeds
  const loaded = await Effect.runPromise(store.loadRun("generated/runs/run-001"))
  assert.equal(loaded.runId, "run-001")

  // Tamper request
  store.tamperRequest("generated/runs/run-001", {
    ...planned.request,
    objective: "tampered objective",
  })
  await assert.rejects(
    Effect.runPromise(store.loadRun("generated/runs/run-001")),
    (err: unknown) => err instanceof RunRecordError && err.code === "TAMPERED_RUN_RECORD",
  )

  // Fix request, tamper event payload
  const store2 = createMemoryRunRecordStore()
  await Effect.runPromise(store2.initRun("run-002", planned, "generated/runs/run-002"))
  store2.tamperEvent("generated/runs/run-002", 0, { tampered: true })

  await assert.rejects(
    Effect.runPromise(store2.loadRun("generated/runs/run-002")),
    (err: unknown) => err instanceof RunRecordError && err.code === "TAMPERED_RUN_RECORD",
  )
})

test("pre-submit failure can be linked to a new run while original remains immutable", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()
  await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const linked = await Effect.runPromise(
    store.linkPreSubmitFailure("generated/runs/run-001", "run-002", "Invalid credential configuration before submission"),
  )
  assert.equal(linked, "run-002")

  const loaded = await Effect.runPromise(store.loadRun("generated/runs/run-001"))
  assert.equal(loaded.status, "failed")
  assert.equal(loaded.linkedRunId, "run-002")
})
