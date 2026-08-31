import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector, plan } from "../conductor/index.js"
import {
  makeMemoryRunRecordHarness,
  record,
  reserve,
  RunRecordClock,
  type RecordResult,
  type RunRecordView,
  type SubmissionPermit,
} from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import { EMBEDDED_PROVIDER_SECRET_CASES } from "../../tests/provider-evidence-attacks.js"
import {
  GenerationAdapter,
  GenerationError,
  invoke,
  pollSeedance,
  prepare,
  recover,
  submitSeedance,
  type GenerationAdapterService,
  type GenerationResult,
  type SeedancePollResult,
} from "./index.js"

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")

const completedPollBody = (
  jobId: string,
  outputs: ReadonlyArray<Readonly<{ applicationPath: string; mediaType: string; sha256: string }>>,
  completedCount: number,
  cost: Readonly<{ state: string; actualCostUsd?: string }>,
): Buffer => Buffer.from(JSON.stringify({
  job_id: jobId,
  status: "completed",
  outputs: outputs.map((output) => ({
    application_path: output.applicationPath,
    media_type: output.mediaType,
    sha256: output.sha256,
  })),
  completed_count: completedCount,
  cost: {
    state: cost.state,
    ...(cost.actualCostUsd === undefined ? {} : { actual_cost_usd: cost.actualCostUsd }),
  },
}))

test("puts exact reference bytes and hash at the locked destination and invokes one adapter once", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }]))
  const payloadReference = ((prepared.payload.input_references as ReadonlyArray<Record<string, unknown>>)[0]!
    .image_url as Record<string, unknown>).url as Record<string, unknown>
  assert.equal(payloadReference.sha256, locked.sha256)
  assert.deepEqual(Buffer.from(payloadReference.bytesBase64 as string, "base64"), Buffer.from(snapshot.bytes))

  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
  const reserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: prepared.payloadSha256,
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  const marker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "generation-submit",
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(marker._tag, "SubmissionPermitIssued")
  if (marker._tag !== "SubmissionPermitIssued") return

  const donorBody = Buffer.from(JSON.stringify({ height: 1, pixels: [90, 90, 90, 255], width: 1 }))
  const providerBody = Buffer.from(JSON.stringify({ id: "fake-qwen-1", status: "completed" }))
  const normalized: GenerationResult = {
    provider: "openrouter",
    model: decision.run.request.model,
    providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
    outputs: [{
      applicationPath: "outputs/donor-01.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: donorBody,
      sha256: sha256(donorBody),
    }],
  }
  let calls = 0
  const adapter = { invoke: () => { calls += 1; return Effect.succeed(normalized) } }
  const result = await Effect.runPromise(invoke(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  ))
  assert.equal(calls, 1)
  assert.deepEqual(result, normalized)
  const duplicate = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")
  assert.equal(calls, 1)
})

test("guards the exact Qwen recovery receipt before and after calling the adapter", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const reference = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: reference.bytes,
  }]))
  const body = Buffer.from(JSON.stringify({ id: "fake-qwen-1", status: "completed", debug: "unknown" }))
  const unsafeEvidence = { mediaType: "application/json" as const, body, sha256: sha256(body) }
  let calls = 0
  const adapter: GenerationAdapterService = {
    invoke: () => Effect.die("unused"),
    recover: () => {
      calls += 1
      return Effect.die("invalid evidence must not reach recovery")
    },
  }
  const failure = await Effect.runPromise(Effect.flip(recover(prepared, unsafeEvidence).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(failure.code, "ADAPTER_RESULT_INVALID")
  assert.equal(calls, 0)

  const originalBody = Buffer.from('{"id":"receipt-original","status":"completed"}')
  const attackerBody = Buffer.from('{"id":"receipt-attacker","status":"completed"}')
  const originalEvidence = {
    mediaType: "application/json" as const,
    body: originalBody,
    sha256: sha256(originalBody),
  }
  const donorBody = Buffer.from(JSON.stringify({ height: 1, pixels: [90, 90, 90, 255], width: 1 }))
  const mutatingAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("unused"),
    recover: (_prepared, exposedEvidence) => Effect.sync(() => {
      const mutable = exposedEvidence as { mediaType: "application/json"; body: Uint8Array; sha256: string }
      mutable.body = attackerBody
      mutable.sha256 = sha256(attackerBody)
      return {
        provider: "openrouter" as const,
        model: decision.run.request.model,
        providerEvidence: mutable,
        outputs: [{
          applicationPath: "outputs/recovered.rgba.json" as const,
          mediaType: "application/vnd.qwen.rgba+json" as const,
          body: donorBody,
          sha256: sha256(donorBody),
        }],
      }
    }),
  }
  const mutationFailure = await Effect.runPromise(Effect.flip(recover(prepared, originalEvidence).pipe(
    Effect.provideService(GenerationAdapter, mutatingAdapter),
  )))
  assert.equal(mutationFailure.code, "ADAPTER_RESULT_INVALID")
  assert.deepEqual(originalEvidence.body, originalBody)
  assert.equal(originalEvidence.sha256, sha256(originalBody))

  const hostileRecoveryAdapters: ReadonlyArray<readonly [string, GenerationAdapterService]> = [
    ["false pre-submit failure", {
      invoke: () => Effect.die("unused"),
      recover: () => Effect.fail(new GenerationError(
        "ADAPTER_NOT_STARTED",
        "Recovery cannot make a pre-submit claim.",
      )),
    }],
    ["throwing accessor", Object.defineProperty({ invoke: () => Effect.die("unused") }, "recover", {
      get: () => { throw new Error("recovery accessor may have external effects") },
    }) as GenerationAdapterService],
    ["proxy trap", new Proxy({ invoke: () => Effect.die("unused") } as GenerationAdapterService, {
      get: (target, property, receiver) => property === "recover"
        ? (() => { throw new Error("recovery proxy may have external effects") })()
        : Reflect.get(target, property, receiver),
    })],
  ]
  for (const [name, hostileAdapter] of hostileRecoveryAdapters) {
    const hostileFailure = await Effect.runPromise(Effect.flip(recover(prepared, originalEvidence).pipe(
      Effect.provideService(GenerationAdapter, hostileAdapter),
    )))
    assert.equal(hostileFailure.code, "ADAPTER_RESULT_INVALID", name)
  }
})

test("submits exact Seedance video once and polls only the same sanitized job identity", async () => {
  const fixture = makeFixture("seedance-video")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: snapshot.bytes,
  }]))
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
  const reserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: prepared.payloadSha256,
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  const marker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-submit",
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(marker._tag, "SubmissionPermitIssued")
  if (marker._tag !== "SubmissionPermitIssued") return

  const submissionBody = Buffer.from('{"job_id":"seedance-job-1","status":"submitted"}')
  const pendingBody = Buffer.from('{"job_id":"seedance-job-1","status":"pending"}')
  const completedBody = completedPollBody("seedance-job-1", [{
    applicationPath: "outputs/seedance-result.mp4",
    mediaType: "video/mp4",
    sha256: sha256(snapshot.bytes),
  }], 1, { state: "estimated-only" })
  let submitCalls = 0
  let pollCalls = 0
  const pollResults: SeedancePollResult[] = [
    {
      status: "pending",
      provider: "openrouter",
      model: decision.run.request.model,
      jobId: "seedance-job-1",
      providerEvidence: { mediaType: "application/json", body: pendingBody, sha256: sha256(pendingBody) },
    },
    {
      status: "completed",
      provider: "openrouter",
      model: decision.run.request.model,
      jobId: "seedance-job-1",
      providerEvidence: { mediaType: "application/json", body: completedBody, sha256: sha256(completedBody) },
      outputs: [{
        applicationPath: "outputs/seedance-result.mp4",
        mediaType: "video/mp4",
        body: snapshot.bytes,
        sha256: sha256(snapshot.bytes),
      }],
      completedCount: 1,
      cost: { state: "estimated-only" },
    },
  ]
  const adapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    submitSeedance: (candidate) => Effect.sync(() => {
      submitCalls += 1
      const destination = (
        candidate.payload.input_references as ReadonlyArray<{
          video_url: { url: { applicationPath: string; bytesBase64: string; mediaType: string; sha256: string } }
        }>
      )[0]!.video_url.url
      assert.equal(destination.applicationPath, locked.applicationPath)
      assert.equal(destination.sha256, locked.sha256)
      assert.equal(destination.mediaType, "video/mp4")
      assert.deepEqual(Buffer.from(destination.bytesBase64, "base64"), Buffer.from(snapshot.bytes))
      return {
        provider: "openrouter" as const,
        model: candidate.request.model,
        jobId: "seedance-job-1",
        providerEvidence: {
          mediaType: "application/json" as const,
          body: submissionBody,
          sha256: sha256(submissionBody),
        },
      }
    }),
    pollSeedance: (_candidate, jobId, evidence) => Effect.sync(() => {
      pollCalls += 1
      assert.equal(jobId, "seedance-job-1")
      assert.equal(evidence.sha256, sha256(submissionBody))
      return pollResults[pollCalls - 1]!
    }),
  }
  const submission = await Effect.runPromise(submitSeedance(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  ))
  assert.equal(submitCalls, 1)
  assert.equal(submission.jobId, "seedance-job-1")
  const pending = await Effect.runPromise(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, adapter)))
  assert.equal(pending.status, "pending")
  const completed = await Effect.runPromise(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, adapter)))
  assert.equal(completed.status, "completed")
  assert.equal(submitCalls, 1)
  assert.equal(pollCalls, 2)

  let pollPropertyReads = 0
  const singleReadPollAdapter = Object.defineProperty({
    invoke: () => Effect.die("Qwen invocation must not run"),
  }, "pollSeedance", {
    get: () => {
      pollPropertyReads += 1
      if (pollPropertyReads > 1) throw new Error("Seedance poll method was observed twice")
      return () => Effect.succeed({
        status: "pending" as const,
        provider: "openrouter" as const,
        model: decision.run.request.model,
        jobId: "seedance-job-1",
        providerEvidence: {
          mediaType: "application/json" as const,
          body: pendingBody,
          sha256: sha256(pendingBody),
        },
      })
    },
  }) as GenerationAdapterService
  const singleReadPoll = await Effect.runPromise(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, singleReadPollAdapter)))
  assert.equal(singleReadPoll.status, "pending")
  assert.equal(pollPropertyReads, 1)

  const contradictoryBody = completedPollBody("seedance-job-1", [{
    applicationPath: "outputs/substituted.mp4",
    mediaType: "video/mp4",
    sha256: sha256(snapshot.bytes),
  }], 1, { state: "estimated-only" })
  const contradictoryAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    pollSeedance: () => Effect.succeed({
      status: "completed" as const,
      provider: "openrouter" as const,
      model: decision.run.request.model,
      jobId: "seedance-job-1",
      providerEvidence: {
        mediaType: "application/json" as const,
        body: contradictoryBody,
        sha256: sha256(contradictoryBody),
      },
      outputs: [{
        applicationPath: "outputs/seedance-result.mp4" as const,
        mediaType: "video/mp4" as const,
        body: snapshot.bytes,
        sha256: sha256(snapshot.bytes),
      }],
      completedCount: 1,
      cost: { state: "estimated-only" as const },
    }),
  }
  const contradiction = await Effect.runPromise(Effect.flip(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, contradictoryAdapter))))
  assert.equal(contradiction.code, "ADAPTER_RESULT_INVALID")

  const throwingResult = new Proxy({}, {
    get: () => { throw new Error("throwing Seedance result getter") },
  })
  const throwingAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    pollSeedance: () => Effect.succeed(throwingResult as never),
  }
  const throwingFailure = await Effect.runPromise(Effect.flip(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, throwingAdapter))))
  assert.equal(throwingFailure.code, "ADAPTER_RESULT_INVALID")

  const duplicateSecretBody = Buffer.from(
    '{"job_id":"seedance-job-1","note":"sk-private-value-123456","note":"redacted","status":"pending"}',
  )
  const duplicateSecretAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    pollSeedance: () => Effect.succeed({
      status: "pending" as const,
      provider: "openrouter" as const,
      model: decision.run.request.model,
      jobId: "seedance-job-1",
      providerEvidence: {
        mediaType: "application/json" as const,
        body: duplicateSecretBody,
        sha256: sha256(duplicateSecretBody),
      },
    }),
  }
  const duplicateSecret = await Effect.runPromise(Effect.flip(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, duplicateSecretAdapter))))
  assert.equal(duplicateSecret.code, "ADAPTER_RESULT_INVALID")

  for (const [, raw] of EMBEDDED_PROVIDER_SECRET_CASES) {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const nestedJsonSecretBody = Buffer.from(JSON.stringify({
      job_id: "seedance-job-1",
      ...parsed,
      status: "pending",
    }))
    const nestedJsonSecretAdapter: GenerationAdapterService = {
      invoke: () => Effect.die("Qwen invocation must not run"),
      pollSeedance: () => Effect.succeed({
        status: "pending" as const,
        provider: "openrouter" as const,
        model: decision.run.request.model,
        jobId: "seedance-job-1",
        providerEvidence: {
          mediaType: "application/json" as const,
          body: nestedJsonSecretBody,
          sha256: sha256(nestedJsonSecretBody),
        },
      }),
    }
    assert.equal((await Effect.runPromise(Effect.flip(pollSeedance(
      prepared,
      submission.jobId,
      submission.providerEvidence,
    ).pipe(Effect.provideService(GenerationAdapter, nestedJsonSecretAdapter))))).code, "ADAPTER_RESULT_INVALID")
  }

  let costStateReads = 0
  const statefulCostBody = completedPollBody("seedance-job-1", [{
    applicationPath: "outputs/seedance-result.mp4",
    mediaType: "video/mp4",
    sha256: sha256(snapshot.bytes),
  }], 1, { state: "estimated-only" })
  const statefulCostAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    pollSeedance: () => Effect.succeed({
      status: "completed" as const,
      provider: "openrouter" as const,
      model: decision.run.request.model,
      jobId: "seedance-job-1",
      providerEvidence: {
        mediaType: "application/json" as const,
        body: statefulCostBody,
        sha256: sha256(statefulCostBody),
      },
      outputs: [{
        applicationPath: "outputs/seedance-result.mp4" as const,
        mediaType: "video/mp4" as const,
        body: snapshot.bytes,
        sha256: sha256(snapshot.bytes),
      }],
      completedCount: 1,
      cost: {
        get state() {
          costStateReads += 1
          return costStateReads === 1 ? "estimated-only" as const : "unknown" as const
        },
      },
    }),
  }
  const stableCost = await Effect.runPromise(pollSeedance(
    prepared,
    submission.jobId,
    submission.providerEvidence,
  ).pipe(Effect.provideService(GenerationAdapter, statefulCostAdapter)))
  assert.equal(stableCost.status, "completed")
  if (stableCost.status === "completed") assert.equal(stableCost.cost.state, "estimated-only")
  assert.equal(costStateReads, 1)

  const secondMemory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const secondReserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: prepared.payloadSha256,
  }).pipe(Effect.provide(secondMemory.layer), Effect.provideService(RunRecordClock, clock)))
  const secondMarker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: secondReserved.runId,
    operationId: "seedance-stateful-submit",
  }).pipe(Effect.provide(secondMemory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(secondMarker._tag, "SubmissionPermitIssued")
  if (secondMarker._tag !== "SubmissionPermitIssued") return
  let jobIdReads = 0
  const statefulSubmissionAdapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen invocation must not run"),
    submitSeedance: () => Effect.succeed({
      provider: "openrouter" as const,
      model: decision.run.request.model,
      get jobId() {
        jobIdReads += 1
        return jobIdReads === 1 ? "seedance-job-1" : "seedance-job-substituted"
      },
      providerEvidence: {
        mediaType: "application/json" as const,
        body: submissionBody,
        sha256: sha256(submissionBody),
      },
    }),
  }
  const stableSubmission = await Effect.runPromise(submitSeedance(prepared, secondMarker.permit).pipe(
    Effect.provideService(GenerationAdapter, statefulSubmissionAdapter),
  ))
  assert.equal(stableSubmission.jobId, "seedance-job-1")
  assert.equal(jobIdReads, 1)

  const duplicate = await Effect.runPromise(Effect.flip(submitSeedance(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")
  assert.equal(submitCalls, 1)
})

test("refuses a Seedance payload omission before consuming authority or calling the adapter", async () => {
  const fixture = makeFixture("seedance-video")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: snapshot.bytes,
  }]))
  const omittedPayload = {
    input_references: [],
    model: prepared.request.model,
    provider: prepared.request.provider,
    requested_count: prepared.request.requestedCount,
  }
  const omittedBytes = Buffer.from(JSON.stringify(omittedPayload))
  const forged = {
    ...prepared,
    payload: omittedPayload,
    payloadBytes: omittedBytes,
    payloadSha256: sha256(omittedBytes),
  }
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
  const reserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: forged.payloadSha256,
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  const marker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-omitted-payload",
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(marker._tag, "SubmissionPermitIssued")
  if (marker._tag !== "SubmissionPermitIssued") return
  let adapterCalls = 0
  const adapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen must not run"),
    submitSeedance: () => {
      adapterCalls += 1
      return Effect.die("Seedance must not run")
    },
  }
  const failure = await Effect.runPromise(Effect.flip(submitSeedance(forged, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(failure.code, "ADAPTER_RESULT_INVALID")
  assert.equal(adapterCalls, 0)
})

test("rejects a sparse provider-reference destination before reservation", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const sparseDestination = "/input_references/1/image_url/url"
  const error = await Effect.runPromise(Effect.flip(prepare({
    ...decision.run.request,
    references: [{ ...locked, payloadDestination: sparseDestination }],
  }, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: sparseDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }])))
  assert.equal(error.code, "PAYLOAD_DESTINATION_INVALID")
})

test("requires reference media type to match its exact payload destination", async () => {
  for (const [mode, wrongMediaType] of [
    ["qwen-image", "video/mp4"],
    ["qwen-image", "application/vnd.qwen.rgba+json"],
    ["seedance-video", "image/png"],
  ] as const) {
    const fixture = makeFixture(mode)
    const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ))
    assert.equal(decision._tag, "Planned")
    if (decision._tag !== "Planned") continue
    const locked = decision.run.request.references[0]!
    const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
    const error = await Effect.runPromise(Effect.flip(prepare(decision.run.request, [{
      slot: locked.slot,
      applicationPath: locked.applicationPath,
      sha256: locked.sha256,
      payloadDestination: locked.payloadDestination,
      mediaType: wrongMediaType,
      bytes: snapshot.bytes,
    }])))
    assert.equal(error.code, "REFERENCE_BYTES_MISMATCH", mode)
  }
})

test("a Submission Permit refuses a different Run and a changed payload before adapter invocation", async () => {
  const firstFixture = makeFixture("qwen-image")
  const secondFixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.summary = "A distinct immutable Run objective."
      objective.requestedCount = 2
      objective.budgetCeilingUsd = "0.10"
    },
  })
  const planFixture = (fixture: ReturnType<typeof makeFixture>) => Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  const firstDecision = await planFixture(firstFixture)
  const secondDecision = await planFixture(secondFixture)
  assert.equal(firstDecision._tag, "Planned")
  assert.equal(secondDecision._tag, "Planned")
  if (firstDecision._tag !== "Planned" || secondDecision._tag !== "Planned") return
  const prepareFixture = async (
    decision: typeof firstDecision,
    fixture: ReturnType<typeof makeFixture>,
  ) => {
    const locked = decision.run.request.references[0]!
    const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
    return Effect.runPromise(prepare(decision.run.request, [{
      slot: locked.slot,
      applicationPath: locked.applicationPath,
      sha256: locked.sha256,
      payloadDestination: locked.payloadDestination,
      mediaType: locked.mediaType,
      bytes: snapshot.bytes,
    }]))
  }
  const firstPrepared = await prepareFixture(firstDecision, firstFixture)
  const secondPrepared = await prepareFixture(secondDecision, secondFixture)
  const donorBody = Buffer.from(JSON.stringify({ height: 1, pixels: [90, 90, 90, 255], width: 1 }))
  const providerBody = Buffer.from(JSON.stringify({ id: "should-not-submit", status: "completed" }))
  let adapterCalls = 0
  const adapter: GenerationAdapterService = {
    invoke: (prepared) => Effect.sync(() => {
      adapterCalls += 1
      return {
        provider: "openrouter",
        model: prepared.request.model,
        providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
        outputs: [{
          applicationPath: "outputs/donor-01.rgba.json",
          mediaType: "application/vnd.qwen.rgba+json",
          body: donorBody,
          sha256: sha256(donorBody),
        }],
      }
    }),
  }
  const issuePermit = async (payloadSha256 = firstPrepared.payloadSha256) => {
    const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
    const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
    const reserved: RunRecordView = await Effect.runPromise(reserve({
      plannedRun: firstDecision.run,
      payloadSha256,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    const marked = await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "bound-permit",
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    assert.equal(marked._tag, "SubmissionPermitIssued")
    if (marked._tag !== "SubmissionPermitIssued") throw new Error("permit missing")
    return marked.permit
  }

  const crossRunError = await Effect.runPromise(Effect.flip(
    invoke(secondPrepared, await issuePermit()).pipe(Effect.provideService(GenerationAdapter, adapter)),
  ))
  assert.equal(crossRunError.code, "SUBMISSION_BINDING_MISMATCH")

  const changedPayloadBytes = Buffer.from("changed-provider-payload", "utf8")
  const changedPayload = {
    ...firstPrepared,
    payloadBytes: changedPayloadBytes,
    payloadSha256: sha256(changedPayloadBytes),
  }
  const payloadError = await Effect.runPromise(Effect.flip(
    invoke(changedPayload, await issuePermit()).pipe(Effect.provideService(GenerationAdapter, adapter)),
  ))
  assert.equal(payloadError.code, "ADAPTER_RESULT_INVALID")

  const forgedPreparedDigest = {
    ...firstPrepared,
    payloadBytes: changedPayloadBytes,
  }
  const integrityError = await Effect.runPromise(Effect.flip(
    invoke(forgedPreparedDigest, await issuePermit()).pipe(Effect.provideService(GenerationAdapter, adapter)),
  ))
  assert.equal(integrityError.code, "ADAPTER_RESULT_INVALID")

  const structurallyForgedPermit = {
    runId: "run-000000000000000000000000",
    attemptId: "attempt-000000000000000000000000-1",
    requestSha256: firstPrepared.requestSha256,
    payloadSha256: firstPrepared.payloadSha256,
  } as SubmissionPermit
  const forgedPermitError = await Effect.runPromise(Effect.flip(
    invoke(firstPrepared, structurallyForgedPermit).pipe(Effect.provideService(GenerationAdapter, adapter)),
  ))
  assert.equal(forgedPermitError.code, "SUBMISSION_PERMIT_INVALID")

  const missingReferencePayload = {
    input_references: [],
    model: firstPrepared.request.model,
    provider: firstPrepared.request.provider,
    requested_count: firstPrepared.request.requestedCount,
  }
  const missingReferenceBytes = Buffer.from(JSON.stringify(missingReferencePayload), "utf8")
  const forgedPreparedPayload = {
    ...firstPrepared,
    payload: missingReferencePayload,
    payloadBytes: missingReferenceBytes,
    payloadSha256: sha256(missingReferenceBytes),
  }
  const forgedPayloadError = await Effect.runPromise(Effect.flip(
    invoke(forgedPreparedPayload, await issuePermit(forgedPreparedPayload.payloadSha256)).pipe(
      Effect.provideService(GenerationAdapter, adapter),
    ),
  ))
  assert.equal(forgedPayloadError.code, "ADAPTER_RESULT_INVALID")
  assert.equal(adapterCalls, 0)
})

test("rejects unknown, null, malformed, and sparse adapter results as typed failures", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }]))
  const providerBody = Buffer.from('{"request_id":"malformed-output","status":"succeeded"}')
  const malformedRasterBody = Buffer.from("not normalized raster evidence")
  const malformedResults: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["primitive", 42],
    ["missing fields", {}],
    ["null outputs", { provider: "openrouter", model: decision.run.request.model, providerEvidence: {}, outputs: null }],
    ["missing provider evidence", { provider: "openrouter", model: decision.run.request.model, outputs: [{}] }],
    ["null output", { provider: "openrouter", model: decision.run.request.model, providerEvidence: {}, outputs: [null] }],
    ["sparse outputs", { provider: "openrouter", model: decision.run.request.model, providerEvidence: {}, outputs: Array(1) }],
    ["malformed normalized raster", {
      provider: "openrouter",
      model: decision.run.request.model,
      providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
      outputs: [{
        applicationPath: "outputs/malformed.rgba.json",
        mediaType: "application/vnd.qwen.rgba+json",
        body: malformedRasterBody,
        sha256: sha256(malformedRasterBody),
      }],
    }],
  ]

  for (const [index, [name, malformed]] of malformedResults.entries()) {
    const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
    const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
    const reserved: RunRecordView = await Effect.runPromise(reserve({
      plannedRun: decision.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    const marker: RecordResult = await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `malformed-adapter-${index}`,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    assert.equal(marker._tag, "SubmissionPermitIssued")
    if (marker._tag !== "SubmissionPermitIssued") continue
    const adapter = { invoke: () => Effect.succeed(malformed as GenerationResult) }
    const error = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
      Effect.provideService(GenerationAdapter, adapter),
    )))
    assert.equal(error.code, "ADAPTER_RESULT_INVALID", name)
  }
})

test("rejects duplicate Qwen output paths and content identities before persistence", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.requestedCount = 2
      objective.budgetCeilingUsd = "0.10"
    },
  })
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: snapshot.bytes,
  }]))
  const providerBody = Buffer.from('{"id":"duplicate-qwen","status":"completed"}')
  const firstBody = Buffer.from(JSON.stringify({ height: 1, pixels: [90, 90, 90, 255], width: 1 }))
  const secondBody = Buffer.from(JSON.stringify({ height: 1, pixels: [91, 91, 91, 255], width: 1 }))
  const output = (applicationPath: string, body: Uint8Array) => ({
    applicationPath,
    mediaType: "application/vnd.qwen.rgba+json" as const,
    body,
    sha256: sha256(body),
  })
  const duplicateResults: ReadonlyArray<readonly [string, GenerationResult]> = [
    ["path", {
      provider: "openrouter",
      model: decision.run.request.model,
      providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
      outputs: [output("outputs/donor-01.rgba.json", firstBody), output("outputs/donor-01.rgba.json", secondBody)],
    }],
    ["content", {
      provider: "openrouter",
      model: decision.run.request.model,
      providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
      outputs: [output("outputs/donor-01.rgba.json", firstBody), output("outputs/donor-02.rgba.json", firstBody)],
    }],
  ]
  for (const [index, [name, result]] of duplicateResults.entries()) {
    const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
    const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
    const reserved: RunRecordView = await Effect.runPromise(reserve({
      plannedRun: decision.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    const marker: RecordResult = await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `duplicate-output-${index}`,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    assert.equal(marker._tag, "SubmissionPermitIssued")
    if (marker._tag !== "SubmissionPermitIssued") continue
    const error = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
      Effect.provideService(GenerationAdapter, { invoke: () => Effect.succeed(result) }),
    )))
    assert.equal(error.code, "ADAPTER_RESULT_INVALID", name)
  }
})

test("treats a synchronous submission-adapter throw as post-call uncertainty", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }]))
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
  const reserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: prepared.payloadSha256,
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  const marker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "synchronous-adapter-throw",
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(marker._tag, "SubmissionPermitIssued")
  if (marker._tag !== "SubmissionPermitIssued") return
  const adapter: GenerationAdapterService = {
    invoke: () => {
      throw new Error("synchronous adapter defect")
    },
  }
  const error = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(error.code, "ADAPTER_RESULT_INVALID")
  const falseUnspent = await Effect.runPromise(Effect.flip(record({
    _tag: "DefinitivePreSubmitFailure",
    runId: reserved.runId,
    operationId: "false-unspent-after-adapter-call",
    permit: marker.permit,
    failure: {
      class: "submission_not_started",
      message: "Adapter code ran, so this must be refused.",
    },
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock))))
  assert.equal(falseUnspent.code, "DUPLICATE_SUBMISSION_BLOCKED")
})

test("normalizes every failure after adapter code is called as post-call uncertainty", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: snapshot.bytes,
  }]))

  const invalidAdapters: ReadonlyArray<readonly [string, GenerationAdapterService]> = [
    ["missing method", {} as GenerationAdapterService],
    ["non-effect", { invoke: () => undefined } as unknown as GenerationAdapterService],
    ["defect", { invoke: () => Effect.die("adapter defect") } as unknown as GenerationAdapterService],
    ["untyped failure", { invoke: () => Effect.fail("adapter string failure") } as unknown as GenerationAdapterService],
    ["false pre-submit failure", { invoke: () => Effect.fail(new GenerationError(
      "ADAPTER_NOT_STARTED",
      "An adapter cannot make this claim after its Effect begins.",
    )) } as unknown as GenerationAdapterService],
    ["throwing accessor", Object.defineProperty({}, "invoke", {
      get: () => { throw new Error("accessor may already have dispatched externally") },
    }) as GenerationAdapterService],
    ["proxy trap", new Proxy({} as GenerationAdapterService, {
      get: () => { throw new Error("proxy trap may already have dispatched externally") },
    })],
  ]
  for (const [index, [name, adapter]] of invalidAdapters.entries()) {
    const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
    const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
    const reserved: RunRecordView = await Effect.runPromise(reserve({
      plannedRun: decision.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    const marker: RecordResult = await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `malformed-effect-${index}`,
    }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
    assert.equal(marker._tag, "SubmissionPermitIssued")
    if (marker._tag !== "SubmissionPermitIssued") continue
    const error = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
      Effect.provideService(GenerationAdapter, adapter),
    )))
    assert.equal(error.code, "ADAPTER_RESULT_INVALID", name)
  }
})
