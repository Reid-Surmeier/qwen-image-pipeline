import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Effect, Layer } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  compilePlannedRun,
  type PlannedRun,
} from "../run-contract/index.js"
import {
  falsifiedVideoMetadataMp4,
  forgedNonDecodableMp4,
  hiddenAudioTrackMp4,
  hiddenUnrecognizedAudioTrackMp4,
  malformedAudioTrack,
  makeFixture,
  multipleVideoTracksMp4,
  withReportedFfmpegMajor,
} from "../../tests/control-plane-fixture.js"
import { verifyVideo } from "../video-verification/index.js"
import { EMBEDDED_PROVIDER_SECRET_CASES } from "../../tests/provider-evidence-attacks.js"
import {
  RunRecordClock,
  RunRecordError,
  consumeSubmission,
  fileRunRecordLayer,
  load,
  makeFileRunRecordHarness,
  makeMemoryRunRecordHarness,
  readDiagnostics,
  readEvidence,
  record,
  reserve,
  type MemoryRunRecordHarness,
  type RecordOperation,
  type RunRecordClockService,
  type RunLink,
  type RunRecordStoreService,
} from "./index.js"
import { RunRecordStore } from "./types.js"

const clock: RunRecordClockService = {
  now: () => Effect.succeed("2026-08-30T12:00:00.000Z"),
}

const memoryHarness = (): Promise<MemoryRunRecordHarness> =>
  Effect.runPromise(makeMemoryRunRecordHarness())

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
}

const reservationFor = (planned: PlannedRun) => ({
  plannedRun: planned,
  payloadSha256: planned.requestSha256,
})

const completedPollBody = (
  jobId: string,
  outputs: ReadonlyArray<Readonly<{
    applicationPath: string
    mediaType: string
    sha256: string
  }>>,
  completedCount: number,
  cost: Readonly<{ state: string; actualCostUsd?: string }>,
  extra: Readonly<Record<string, unknown>> = {},
): Buffer => Buffer.from(JSON.stringify({
  job_id: jobId,
  status: "completed",
  ...extra,
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

const plannedRun = async (
  linkedRun?: RunLink,
  requestedCount = 1,
  summary?: string,
): Promise<PlannedRun> => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      if (linkedRun !== undefined) objective.linkedRun = linkedRun
      objective.requestedCount = requestedCount
      if (summary !== undefined) objective.summary = summary
      if (requestedCount > 1) objective.budgetCeilingUsd = "0.20"
    },
  })
  return Effect.runPromise(
    compilePlannedRun(fixture.documents).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
}

const plannedSeedanceRun = async (requestedCount = 1): Promise<Readonly<{
  planned: PlannedRun
  body: Uint8Array
}>> => {
  const fixture = makeFixture("seedance-video", {
    objective: (objective) => {
      objective.requestedCount = requestedCount
      if (requestedCount > 1) objective.budgetCeilingUsd = "0.50"
    },
  })
  const planned = await Effect.runPromise(
    compilePlannedRun(fixture.documents).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  const body = (await Effect.runPromise(fixture.files.read("references/neutral.mp4"))).bytes
  return { planned, body }
}

const assertRunRecordRejectsMedia = async (
  body: Uint8Array,
  suffix: string,
  plannedOverride?: PlannedRun,
): Promise<void> => {
  const planned = plannedOverride ?? (await plannedSeedanceRun()).planned
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: `${suffix}-marker`,
  })))
  const jobId = `job-${suffix}`
  const submissionBody = Buffer.from(JSON.stringify({ job_id: jobId, status: "submitted" }))
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: `${suffix}-submission`,
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(body).digest("hex")
  const applicationPath = `outputs/${suffix}.mp4` as const
  const completionBody = completedPollBody(jobId, [{
    applicationPath,
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: `${suffix}-complete`,
    jobId,
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completionBody,
      sha256: createHash("sha256").update(completionBody).digest("hex"),
    },
    outputs: [{ applicationPath, mediaType: "video/mp4", body, sha256: outputSha256 }],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: `${suffix}-checks`,
    jobId,
    report: {
      algorithm: "seedance-media-v1",
      classification: "verified-candidate",
      outputs: [{
        applicationPath,
        mediaType: "video/mp4",
        sha256: outputSha256,
        actual: { width: 64, height: 48, durationSeconds: 0.2, hasAudio: false },
      }],
      requestedCount: 1,
      completedCount: 1,
      expected: planned.request.videoPlan!.expectedMedia,
      cost: { state: "unknown", estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd },
      checks: [
        { name: "integrity", passed: true, measured: 0 },
        { name: "media", passed: true, measured: 0 },
        { name: "dimensions", passed: true, measured: 0 },
        { name: "duration", passed: true, measured: 0 },
        { name: "audio-expectation", passed: true, measured: 0 },
      ],
    },
  }))))
  assert.equal(failure.code, "CHECKS_NOT_PASSED")
}

const markerOnlyMp4 = (): Uint8Array => {
  const body = Buffer.alloc(76)
  body.writeUInt32BE(12, 0)
  body.write("ftyp", 4, "ascii")
  body.writeUInt32BE(28, 12)
  body.write("mvhd", 16, "ascii")
  body.writeUInt32BE(1_000, 32)
  body.writeUInt32BE(200, 36)
  body.writeUInt32BE(36, 40)
  body.write("tkhd", 44, "ascii")
  body.writeUInt32BE(64 * 65_536, 68)
  body.writeUInt32BE(48 * 65_536, 72)
  return body
}

const raster = (pixels: ReadonlyArray<number>): Uint8Array =>
  Buffer.from(JSON.stringify({ height: 1, pixels, width: 2 }), "utf8")

const plannedAssemblyRun = async (baseline: Uint8Array): Promise<PlannedRun> => {
  const planned = await plannedRun()
  const exactCopyCore = { x: 1, y: 0, rgba: [80, 80, 80, 255] as const }
  const request = {
    ...planned.request,
    assemblyPlan: {
      required: true as const,
      baselineReferenceSlot: "source",
      ownedRegion: { x: 1, y: 0, width: 1, height: 1 },
      exactCopy: [{
        ...exactCopyCore,
        sha256: createHash("sha256").update(JSON.stringify(exactCopyCore)).digest("hex"),
      }],
    },
    references: planned.request.references.map((reference) => reference.slot === "source"
      ? { ...reference, byteLength: baseline.byteLength, sha256: createHash("sha256").update(baseline).digest("hex") }
      : reference),
  }
  const canonicalRequest = canonicalJson(request)
  return {
    state: "planned",
    request,
    canonicalRequest,
    requestSha256: createHash("sha256").update(canonicalRequest).digest("hex"),
  }
}

test("reserves and reloads the immutable request before any submission", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const input = reservationFor(planned)

  const reserved = await Effect.runPromise(
    reserve(input).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  const reloaded = await Effect.runPromise(
    load(reserved.runId).pipe(Effect.provide(memory.layer)),
  )

  assert.equal(reloaded.phase, "reserved")
  assert.equal(reloaded.requestSha256, planned.requestSha256)
  assert.equal(reloaded.payloadSha256, planned.requestSha256)
  assert.equal(reloaded.maximumCount, 1)
  assert.equal(reloaded.spendState, "not_spent")
  assert.equal(reloaded.retryState, "same-run-submission-available")
  assert.match(reloaded.attemptId, /^attempt-[a-f0-9]+-1$/)
  assert.match(reloaded.chainHeadSha256, /^[a-f0-9]{64}$/)
})

test("returns replay-verified immutable request and journal diagnostics through the public Effect seam", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))

  const diagnostics = await Effect.runPromise(readDiagnostics(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(Buffer.from(diagnostics.request).toString("utf8"), planned.canonicalRequest)
  assert.equal(JSON.parse(Buffer.from(diagnostics.events).toString("utf8").trim()).kind, "attempt_reserved")
  assert.deepEqual(diagnostics.view, reserved)

  diagnostics.request[0] = 0
  diagnostics.events[0] = 0
  const reread = await Effect.runPromise(readDiagnostics(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(Buffer.from(reread.request).toString("utf8"), planned.canonicalRequest)
  assert.equal(JSON.parse(Buffer.from(reread.events).toString("utf8").trim()).kind, "attempt_reserved")
})

test("persists submission uncertainty before issuing one non-replayable permit", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const reserved = await Effect.runPromise(
    reserve(reservationFor(planned)).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )

  const marked = await Effect.runPromise(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-once",
    }).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(marked._tag, "SubmissionPermitIssued")
  if (marked._tag !== "SubmissionPermitIssued") return

  const consume = (permit: typeof marked.permit) => consumeSubmission(permit, {
    requestSha256: permit.requestSha256,
    payloadSha256: permit.payloadSha256,
  }).pipe(Effect.provide(memory.layer))
  await Effect.runPromise(consume(marked.permit))
  const visibleAfterConsumption = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(visibleAfterConsumption.phase, "submission_may_have_started")
  assert.equal(visibleAfterConsumption.spendState, "possibly_spent")
  assert.equal(visibleAfterConsumption.retryState, "reconcile-only")
  const reusedPermit = await Effect.runPromise(Effect.flip(consume(marked.permit)))
  assert.equal(reusedPermit.code, "DUPLICATE_SUBMISSION_BLOCKED")

  const replay = await Effect.runPromise(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-once",
    }).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(replay._tag, "ReplayObserved")
  const duplicate = await Effect.runPromise(
    Effect.flip(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "submit-twice",
    })).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")
})

test("rejects reservation fields forged outside the canonical request bytes", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const forged = {
    ...planned,
    request: { ...planned.request, requestedCount: 4, budgetCeilingUsd: "9.99" },
  }
  const error = await Effect.runPromise(Effect.flip(
    reserve({
      plannedRun: forged,
      payloadSha256: planned.requestSha256,
    }).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(error.code, "REQUEST_HASH_MISMATCH")
})

test("the durable marker is the final Run Record write before its permit is returned", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  await Effect.runPromise(memory.failNext("write-state"))
  const marked = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "marker-has-no-trailing-write",
  }).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  assert.equal(marked._tag, "SubmissionPermitIssued")
})

test("a contradictory current-head view blocks record operations, not only load", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    if (stored.state === undefined) throw new Error("fixture state missing")
    const state = JSON.parse(Buffer.from(stored.state).toString("utf8")) as Record<string, unknown>
    stored.state = Buffer.from(JSON.stringify({ ...state, phase: "provider_evidence_received" }), "utf8")
  }))
  const result = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "blocked-by-false-view",
  }).pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected-success" }),
  ))
  assert.equal(result, "DERIVED_VIEW_CONTRADICTION")

  const fabricatedHead = await memoryHarness()
  const fabricatedRun = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(fabricatedHead.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  await Effect.runPromise(fabricatedHead.mutate(fabricatedRun.runId, (stored) => {
    if (stored.state === undefined) throw new Error("fixture state missing")
    const state = JSON.parse(Buffer.from(stored.state).toString("utf8")) as Record<string, unknown>
    stored.state = Buffer.from(JSON.stringify({
      ...state,
      chainHeadSha256: "0".repeat(64),
      phase: "provider_evidence_received",
    }), "utf8")
  }))
  const fabricated = await Effect.runPromise(Effect.flip(
    load(fabricatedRun.runId).pipe(Effect.provide(fabricatedHead.layer)),
  ))
  assert.equal(fabricated.code, "DERIVED_VIEW_CONTRADICTION")
})

test("an exact usage receipt passes while credential query strings are refused", async () => {
  const planned = await plannedRun()
  const prepare = async (memory: MemoryRunRecordHarness, suffix: string) => {
    const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ))
    await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `secret-filter-submit-${suffix}`,
    }).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ))
    return reserved
  }

  const safeMemory = await memoryHarness()
  const safeRun = await prepare(safeMemory, "safe")
  const safeBody = Buffer.from('{"usage":{"prompt_tokens":42,"completion_tokens":7}}', "utf8")
  const safe = await Effect.runPromise(record({
    _tag: "CommitProviderEvidence",
    runId: safeRun.runId,
    operationId: "safe-token-counts",
    evidence: {
      mediaType: "application/json",
      body: safeBody,
      sha256: createHash("sha256").update(safeBody).digest("hex"),
    },
  }).pipe(
    Effect.provide(safeMemory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  assert.equal(safe.view.phase, "provider_evidence_received")

  const unsafeMemory = await memoryHarness()
  const unsafeRun = await prepare(unsafeMemory, "unsafe")
  const unsafeBody = Buffer.from('{"url":"https://provider.test/status?api_key=actual-private-value"}', "utf8")
  const unsafe = await Effect.runPromise(record({
    _tag: "CommitProviderEvidence",
    runId: unsafeRun.runId,
    operationId: "unsafe-query-credential",
    evidence: {
      mediaType: "application/json",
      body: unsafeBody,
      sha256: createHash("sha256").update(unsafeBody).digest("hex"),
    },
  }).pipe(
    Effect.provide(unsafeMemory.layer),
    Effect.provideService(RunRecordClock, clock),
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected-success" }),
  ))
  assert.equal(unsafe, "SECRET_MATERIAL_DETECTED")

  for (const [suffix, unsafeJson] of [
    ["header", '{"headers":{"x-api-key":"actual-private-value"}}'],
    ["relative-url", '{"status_url":"/jobs/1?api_key=actual-private-value"}'],
    ["generic-token", '{"token":"opaque-private-value"}'],
    ["api-token", '{"api_token":"opaque-private-value"}'],
    ["cookie", '{"request_headers":{"cookie":"session=opaque-private-value"}}'],
    ["credentials", '{"credentials":"opaque-private-value"}'],
    ["auth", '{"auth":"opaque-private-value"}'],
    ["authentication", '{"authentication":{"value":"opaque-private-value"}}'],
    ["authentication-data", '{"authentication_data":"opaque-private-value"}'],
    ["auth-header", '{"auth_header":"Bearer opaque-private-value"}'],
    ["secret-key", '{"secret_key":"opaque-private-value"}'],
    ["client-secret-key", '{"client_secret_key":"opaque-private-value"}'],
    ["password-value", '{"password_value":"opaque-private-value"}'],
    ["credential-value", '{"credential_value":"opaque-private-value"}'],
    ["signed-url-sig", '{"url":"https://provider.test/result?sig=opaque-private-value"}'],
    ["signed-url-signature", '{"url":"https://provider.test/result?signature=opaque-private-value"}'],
    ["duplicate-secret-key", '{"note":"sk-private-value-123456","note":"redacted","status":"accepted"}'],
    ...EMBEDDED_PROVIDER_SECRET_CASES,
  ] as const) {
    const memory = await memoryHarness()
    const run = await prepare(memory, suffix)
    const body = Buffer.from(unsafeJson, "utf8")
    const result = await Effect.runPromise(record({
      _tag: "CommitProviderEvidence",
      runId: run.runId,
      operationId: `unsafe-${suffix}`,
      evidence: {
        mediaType: "application/json",
        body,
        sha256: createHash("sha256").update(body).digest("hex"),
      },
    }).pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
      Effect.match({ onFailure: (error) => error.code, onSuccess: () => "unexpected-success" }),
    ))
    assert.equal(result, "SECRET_MATERIAL_DETECTED")
  }
})

test("commits provider evidence write-once and replays its verified hash", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
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
    load(reserved.runId).pipe(Effect.provide(memory.layer)),
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

test("refuses accessor-backed Qwen provider bytes before durable persistence", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "stateful-qwen-marker",
  })))
  const safeBody = Buffer.from('{"id":"stateful-qwen","status":"completed"}')
  const unsafeBody = Buffer.from('{"id":"stateful-qwen","status":"completed","debug":"unknown"}')
  let reads = 0
  const evidence = {
    mediaType: "application/json" as const,
    sha256: createHash("sha256").update(safeBody).digest("hex"),
  } as { mediaType: "application/json"; body: Uint8Array; sha256: string }
  Object.defineProperty(evidence, "body", {
    enumerable: true,
    get: () => (++reads <= 5 ? safeBody : unsafeBody),
  })
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "stateful-qwen-provider",
    evidence,
  }))))
  assert.equal(failure.code, "EVIDENCE_HASH_MISMATCH")
  let durable: Uint8Array | undefined
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    durable = stored.evidence["provider-response.json"]
  }))
  assert.equal(durable, undefined)
  assert.equal(reads, 0)
})

test("refuses accessor-backed Seedance poll bytes before durable persistence", async () => {
  const { planned } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "stateful-seedance-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"stateful-seedance","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "stateful-seedance-provider",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const safeBody = Buffer.from('{"job_id":"stateful-seedance","status":"pending"}')
  const unsafeBody = Buffer.from('{"job_id":"stateful-seedance","status":"pending","debug":"unknown"}')
  let reads = 0
  const evidence = {
    mediaType: "application/json" as const,
    sha256: createHash("sha256").update(safeBody).digest("hex"),
  } as { mediaType: "application/json"; body: Uint8Array; sha256: string }
  Object.defineProperty(evidence, "body", {
    enumerable: true,
    get: () => (++reads <= 3 ? safeBody : unsafeBody),
  })
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "stateful-seedance-poll",
    jobId: "stateful-seedance",
    status: "pending",
    evidence,
  }))))
  assert.equal(failure.code, "EVIDENCE_HASH_MISMATCH")
  let durable: Uint8Array | undefined
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    durable = stored.evidence["polls/poll-0001.json"]
  }))
  assert.equal(durable, undefined)
  assert.equal(reads, 0)
})

test("freezes Qwen generated output bytes before validation and durable persistence", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "stateful-qwen-output-marker",
  })))
  const providerBody = Buffer.from('{"id":"stateful-output","status":"completed"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "stateful-qwen-output-provider",
    evidence: {
      mediaType: "application/json",
      body: providerBody,
      sha256: createHash("sha256").update(providerBody).digest("hex"),
    },
  })))
  const safeBody = Buffer.from("safe")
  const unsafeBody = Buffer.from("evil")
  let reads = 0
  const output = {
    applicationPath: "outputs/stateful.rgba.json" as const,
    mediaType: "application/vnd.qwen.rgba+json",
    sha256: createHash("sha256").update(safeBody).digest("hex"),
  } as unknown as { applicationPath: `outputs/${string}`; mediaType: string; body: Uint8Array; sha256: string }
  Object.defineProperty(output, "body", {
    enumerable: true,
    get: () => (++reads === 1 ? safeBody : unsafeBody),
  })
  await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "stateful-qwen-output",
    output,
  })))
  assert.deepEqual(Buffer.from(await Effect.runPromise(
    readEvidence(reserved.runId, output.applicationPath).pipe(Effect.provide(memory.layer)),
  )), safeBody)
  assert.equal((await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))).phase, "generated_outputs_received")
})

test("freezes Seedance completed output bytes before validation and durable persistence", async () => {
  const { planned, body: safeBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "stateful-seedance-output-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"stateful-output","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "stateful-seedance-output-provider",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(safeBody).digest("hex")
  const pollBody = completedPollBody("stateful-output", [{
    applicationPath: "outputs/stateful.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  const unsafeBody = Uint8Array.from(safeBody)
  unsafeBody[unsafeBody.length - 1] = (unsafeBody[unsafeBody.length - 1] ?? 0) ^ 1
  let reads = 0
  const output = {
    applicationPath: "outputs/stateful.mp4" as const,
    mediaType: "video/mp4" as const,
    sha256: outputSha256,
  } as unknown as { applicationPath: `outputs/${string}`; mediaType: string; body: Uint8Array; sha256: string }
  Object.defineProperty(output, "body", {
    enumerable: true,
    get: () => (++reads === 1 ? safeBody : unsafeBody),
  })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "stateful-seedance-output",
    jobId: "stateful-output",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: pollBody,
      sha256: createHash("sha256").update(pollBody).digest("hex"),
    },
    outputs: [output],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  assert.deepEqual(Buffer.from(await Effect.runPromise(
    readEvidence(reserved.runId, output.applicationPath).pipe(Effect.provide(memory.layer)),
  )), Buffer.from(safeBody))
  assert.equal((await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))).phase, "generated_outputs_received")
})

test("replay rejects duplicate JSON keys in persisted Seedance poll evidence", async () => {
  const { planned } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "duplicate-poll-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"duplicate-poll","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "duplicate-poll-provider",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const pendingBody = Buffer.from('{"job_id":"duplicate-poll","status":"pending"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "duplicate-poll-record",
    jobId: "duplicate-poll",
    status: "pending",
    evidence: {
      mediaType: "application/json",
      body: pendingBody,
      sha256: createHash("sha256").update(pendingBody).digest("hex"),
    },
  })))
  const duplicateBody = Buffer.from('{"job_id":"attacker","job_id":"duplicate-poll","status":"pending"}')
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    const events = Buffer.from(stored.events).toString("utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const poll = events.find((event) => event.kind === "seedance_poll_persisted")!
    const payload = poll.payload as Record<string, unknown>
    payload.sha256 = createHash("sha256").update(duplicateBody).digest("hex")
    payload.byteLength = duplicateBody.byteLength
    const { eventSha256: _old, ...withoutDigest } = poll
    poll.eventSha256 = createHash("sha256").update(Buffer.from(canonicalJson(withoutDigest))).digest("hex")
    stored.events = Buffer.from(`${events.map(canonicalJson).join("\n")}\n`)
    stored.evidence["polls/poll-0001.json"] = duplicateBody
    const state = JSON.parse(Buffer.from(stored.state!).toString("utf8")) as Record<string, unknown>
    state.chainHeadSha256 = poll.eventSha256
    const receipt = (state.evidence as Array<Record<string, unknown>>)
      .find((item) => item.applicationPath === "polls/poll-0001.json")!
    receipt.sha256 = payload.sha256
    receipt.byteLength = duplicateBody.byteLength
    stored.state = Buffer.from(canonicalJson(state))
  }))
  const failure = await Effect.runPromise(Effect.flip(load(reserved.runId).pipe(Effect.provide(memory.layer))))
  assert.equal(failure.code, "EVIDENCE_HASH_MISMATCH")
})

test("persists one Seedance job, polls only that identity, and records verified video evidence", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-job-1","status":"submitted"}')
  const submitted = await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-submission-evidence",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  assert.equal(submitted.view.providerJobId, "seedance-job-1")

  const pendingBody = Buffer.from('{"job_id":"seedance-job-1","status":"pending"}')
  const pending = await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-poll-1",
    jobId: "seedance-job-1",
    status: "pending",
    evidence: {
      mediaType: "application/json",
      body: pendingBody,
      sha256: createHash("sha256").update(pendingBody).digest("hex"),
    },
  })))
  assert.equal(pending.view.phase, "provider_evidence_received")
  assert.equal(pending.view.pollCount, 1)
  assert.equal(pending.view.providerJobId, "seedance-job-1")

  const outputSha256 = createHash("sha256").update(videoBody).digest("hex")
  const completedBody = completedPollBody("seedance-job-1", [{
    applicationPath: "outputs/seedance-result.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "estimated-only" })
  const completed = await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-poll-2",
    jobId: "seedance-job-1",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/seedance-result.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "estimated-only" },
  })))
  assert.equal(completed.view.phase, "generated_outputs_received")
  assert.equal(completed.view.pollCount, 2)
  assert.equal(completed.view.completedCount, 1)
  assert.equal(completed.view.costState, "estimated-only")

  const report = await Effect.runPromise(verifyVideo({
    outputs: [{
      applicationPath: "outputs/seedance-result.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: outputSha256,
    }],
    expected: planned.request.videoPlan!.expectedMedia,
    requestedCount: planned.request.requestedCount,
    completedCount: 1,
    cost: {
      state: "estimated-only",
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
  }))
  const verified = await Effect.runPromise(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-video-checks",
    jobId: "seedance-job-1",
    report,
  })))
  assert.equal(verified.view.phase, "verified_candidate")
  assert.equal(verified.view.classification, "verified_candidate")
  assert.equal(verified.view.checksSha256?.length, 64)
  assert.deepEqual(
    verified.view.evidence.map((item) => item.applicationPath),
    [
      "provider-response.json",
      "polls/poll-0001.json",
      "polls/poll-0002.json",
      "outputs/seedance-result.mp4",
      "checks.json",
    ],
  )
  const checks = JSON.parse(Buffer.from(await Effect.runPromise(
    readEvidence(reserved.runId, "checks.json").pipe(Effect.provide(memory.layer)),
  )).toString("utf8")) as Record<string, unknown>
  assert.deepEqual(checks.expected, planned.request.videoPlan!.expectedMedia)
  assert.equal(checks.requestedCount, 1)
  assert.equal(checks.completedCount, 1)
  assert.deepEqual(checks.cost, {
    state: "estimated-only",
    estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
  })
  assert.deepEqual((checks.outputs as Array<Record<string, unknown>>)[0]?.actual, {
    width: 64,
    height: 48,
    durationSeconds: 0.2,
    hasAudio: false,
  })
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.deepEqual(reloaded, verified.view)

  const wrongJob = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "wrong-seedance-job",
    jobId: "seedance-job-2",
    status: "pending",
    evidence: {
      mediaType: "application/json",
      body: pendingBody,
      sha256: createHash("sha256").update(pendingBody).digest("hex"),
    },
  }))))
  assert.equal(wrongJob.code, "ILLEGAL_TRANSITION")
})

test("rejects an invalid Seedance submission before evidence or intent becomes durable", async () => {
  const { planned } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "invalid-seedance-marker",
  })))
  const invalidBody = Buffer.from('{"job_id":"seedance-invalid","status":"accepted"}')
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "invalid-seedance-provider",
    evidence: {
      mediaType: "application/json",
      body: invalidBody,
      sha256: createHash("sha256").update(invalidBody).digest("hex"),
    },
  }))))
  assert.equal(failure.code, "EVIDENCE_HASH_MISMATCH")
  const diagnostics = await Effect.runPromise(readDiagnostics(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(diagnostics.view.phase, "submission_may_have_started")
  assert.equal(Buffer.from(diagnostics.events).toString("utf8").trimEnd().split("\n").length, 2)
  assert.deepEqual(diagnostics.view.evidence, [])
})

test("video checks must cover every persisted Seedance output exactly once", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun(2)
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-two-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-job-two","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-two-submission-evidence",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const badBody = markerOnlyMp4()
  const goodSha256 = createHash("sha256").update(videoBody).digest("hex")
  const badSha256 = createHash("sha256").update(badBody).digest("hex")
  const completedBody = completedPollBody("seedance-job-two", [
    { applicationPath: "outputs/good.mp4", mediaType: "video/mp4", sha256: goodSha256 },
    { applicationPath: "outputs/bad.mp4", mediaType: "video/mp4", sha256: badSha256 },
  ], 2, { state: "estimated-only" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-two-complete",
    jobId: "seedance-job-two",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [
      {
        applicationPath: "outputs/good.mp4",
        mediaType: "video/mp4",
        body: videoBody,
        sha256: goodSha256,
      },
      {
        applicationPath: "outputs/bad.mp4",
        mediaType: "video/mp4",
        body: badBody,
        sha256: badSha256,
      },
    ],
    completedCount: 2,
    cost: { state: "estimated-only" },
  })))
  const oneOutputReport = await Effect.runPromise(verifyVideo({
    outputs: [{
      applicationPath: "outputs/good.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: goodSha256,
    }],
    expected: planned.request.videoPlan!.expectedMedia,
    requestedCount: 1,
    completedCount: 1,
    cost: {
      state: "estimated-only",
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
  }))
  const duplicatedReport = {
    ...oneOutputReport,
    outputs: [oneOutputReport.outputs[0]!, oneOutputReport.outputs[0]!],
    requestedCount: 2,
    completedCount: 2,
  }
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-two-video-checks",
    jobId: "seedance-job-two",
    report: duplicatedReport,
  }))))

  assert.equal(failure.code, "CHECKS_NOT_PASSED")
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(reloaded.phase, "generated_outputs_received")
  assert.equal(reloaded.classification, undefined)
})

test("invalid runtime Seedance cost state is rejected before any poll evidence is written", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-invalid-cost-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-invalid-cost","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-invalid-cost-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(videoBody).digest("hex")
  const completedBody = completedPollBody("seedance-invalid-cost", [{
    applicationPath: "outputs/seedance-result.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "forged-runtime-state" })
  const forgedOperation = {
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-invalid-cost-complete",
    jobId: "seedance-invalid-cost",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/seedance-result.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "forged-runtime-state" },
  } as unknown as RecordOperation
  const failure = await Effect.runPromise(Effect.flip(provide(record(forgedOperation))))

  assert.equal(failure.code, "RESERVATION_OUTSIDE_PLAN")
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(reloaded.phase, "provider_evidence_received")
  assert.equal(reloaded.pollCount, undefined)
  assert.deepEqual(reloaded.evidence.map((item) => item.applicationPath), ["provider-response.json"])
})

test("Run Record replay refuses box-consistent but non-decodable Seedance output", async () => {
  const { planned } = await plannedSeedanceRun()
  const videoBody = forgedNonDecodableMp4()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-forged-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-forged","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-forged-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(videoBody).digest("hex")
  const completedBody = completedPollBody("seedance-forged", [{
    applicationPath: "outputs/non-decodable.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-forged-complete",
    jobId: "seedance-forged",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/non-decodable.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  const forgedReport = {
    algorithm: "seedance-media-v1" as const,
    classification: "verified-candidate" as const,
    outputs: [{
      applicationPath: "outputs/non-decodable.mp4" as const,
      mediaType: "video/mp4" as const,
      sha256: outputSha256,
      actual: { width: 64, height: 48, durationSeconds: 0.2, hasAudio: false },
    }],
    requestedCount: 1,
    completedCount: 1,
    expected: planned.request.videoPlan!.expectedMedia,
    cost: {
      state: "unknown" as const,
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
    checks: [
      { name: "integrity" as const, passed: true as const, measured: 0 },
      { name: "media" as const, passed: true as const, measured: 0 },
      { name: "dimensions" as const, passed: true as const, measured: 0 },
      { name: "duration" as const, passed: true as const, measured: 0 },
      { name: "audio-expectation" as const, passed: true as const, measured: 0 },
    ],
  }
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-forged-checks",
    jobId: "seedance-forged",
    report: forgedReport,
  }))))

  assert.equal(failure.code, "CHECKS_NOT_PASSED")
})

test("Run Record replay refuses MP4 metadata that contradicts decoded frames", async () => {
  const { body } = await plannedSeedanceRun()
  await assertRunRecordRejectsMedia(
    falsifiedVideoMetadataMp4(body, { width: 32, height: 24 }),
    "forged-metadata",
  )
})

test("Run Record replay refuses a non-FFmpeg-6 runtime", async () => {
  const { planned, body } = await plannedSeedanceRun()
  await withReportedFfmpegMajor(7, () => assertRunRecordRejectsMedia(body, "ffmpeg-7", planned))
})

test("Run Record replay refuses ambiguous MP4 evidence with multiple video tracks", async () => {
  const { body } = await plannedSeedanceRun()
  await assertRunRecordRejectsMedia(multipleVideoTracksMp4(body), "multiple-video")
})

test("Run Record replay refuses a malformed declared audio track", async () => {
  const { planned, body } = await plannedSeedanceRun()
  const malformed = malformedAudioTrack(body)
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-malformed-audio-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-malformed-audio","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-malformed-audio-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(malformed).digest("hex")
  const completedBody = completedPollBody("seedance-malformed-audio", [{
    applicationPath: "outputs/malformed-audio.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-malformed-audio-complete",
    jobId: "seedance-malformed-audio",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/malformed-audio.mp4",
      mediaType: "video/mp4",
      body: malformed,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  const forgedReport = {
    algorithm: "seedance-media-v1" as const,
    classification: "verified-candidate" as const,
    outputs: [{
      applicationPath: "outputs/malformed-audio.mp4" as const,
      mediaType: "video/mp4" as const,
      sha256: outputSha256,
      actual: { width: 64, height: 48, durationSeconds: 0.2, hasAudio: false },
    }],
    requestedCount: 1,
    completedCount: 1,
    expected: planned.request.videoPlan!.expectedMedia,
    cost: {
      state: "unknown" as const,
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
    checks: [
      { name: "integrity" as const, passed: true as const, measured: 0 },
      { name: "media" as const, passed: true as const, measured: 0 },
      { name: "dimensions" as const, passed: true as const, measured: 0 },
      { name: "duration" as const, passed: true as const, measured: 0 },
      { name: "audio-expectation" as const, passed: true as const, measured: 0 },
    ],
  }
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-malformed-audio-checks",
    jobId: "seedance-malformed-audio",
    report: forgedReport,
  }))))
  assert.equal(failure.code, "CHECKS_NOT_PASSED")
})

test("Run Record replay refuses an AAC track relabeled to hide its audio", async () => {
  const { planned } = await plannedSeedanceRun()
  const hiddenAudio = hiddenAudioTrackMp4()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-hidden-audio-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-hidden-audio","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-hidden-audio-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(hiddenAudio).digest("hex")
  const completedBody = completedPollBody("seedance-hidden-audio", [{
    applicationPath: "outputs/hidden-audio.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-hidden-audio-complete",
    jobId: "seedance-hidden-audio",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/hidden-audio.mp4",
      mediaType: "video/mp4",
      body: hiddenAudio,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  const forgedReport = {
    algorithm: "seedance-media-v1" as const,
    classification: "verified-candidate" as const,
    outputs: [{
      applicationPath: "outputs/hidden-audio.mp4" as const,
      mediaType: "video/mp4" as const,
      sha256: outputSha256,
      actual: { width: 64, height: 48, durationSeconds: 0.2, hasAudio: false },
    }],
    requestedCount: 1,
    completedCount: 1,
    expected: planned.request.videoPlan!.expectedMedia,
    cost: {
      state: "unknown" as const,
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
    checks: [
      { name: "integrity" as const, passed: true as const, measured: 0 },
      { name: "media" as const, passed: true as const, measured: 0 },
      { name: "dimensions" as const, passed: true as const, measured: 0 },
      { name: "duration" as const, passed: true as const, measured: 0 },
      { name: "audio-expectation" as const, passed: true as const, measured: 0 },
    ],
  }
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-hidden-audio-checks",
    jobId: "seedance-hidden-audio",
    report: forgedReport,
  }))))
  assert.equal(failure.code, "CHECKS_NOT_PASSED")
})

test("Run Record replay refuses an unrecognized audio codec relabeled under a non-audio handler", async () => {
  const { planned } = await plannedSeedanceRun()
  const hiddenAudio = hiddenUnrecognizedAudioTrackMp4()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-unknown-audio-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-unknown-audio","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-unknown-audio-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(hiddenAudio).digest("hex")
  const completedBody = completedPollBody("seedance-unknown-audio", [{
    applicationPath: "outputs/unknown-audio.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  await Effect.runPromise(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-unknown-audio-complete",
    jobId: "seedance-unknown-audio",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/unknown-audio.mp4",
      mediaType: "video/mp4",
      body: hiddenAudio,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "unknown" },
  })))
  const forgedReport = {
    algorithm: "seedance-media-v1" as const,
    classification: "verified-candidate" as const,
    outputs: [{
      applicationPath: "outputs/unknown-audio.mp4" as const,
      mediaType: "video/mp4" as const,
      sha256: outputSha256,
      actual: { width: 64, height: 48, durationSeconds: 0.2, hasAudio: false },
    }],
    requestedCount: 1,
    completedCount: 1,
    expected: planned.request.videoPlan!.expectedMedia,
    cost: {
      state: "unknown" as const,
      estimatedMaximumCostUsd: planned.request.estimatedMaximumCostUsd,
    },
    checks: [
      { name: "integrity" as const, passed: true as const, measured: 0 },
      { name: "media" as const, passed: true as const, measured: 0 },
      { name: "dimensions" as const, passed: true as const, measured: 0 },
      { name: "duration" as const, passed: true as const, measured: 0 },
      { name: "audio-expectation" as const, passed: true as const, measured: 0 },
    ],
  }
  const failure = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitVideoChecks",
    runId: reserved.runId,
    operationId: "seedance-unknown-audio-checks",
    jobId: "seedance-unknown-audio",
    report: forgedReport,
  }))))
  assert.equal(failure.code, "CHECKS_NOT_PASSED")
})

test("a completed poll recovers when interrupted after poll evidence but before output evidence", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const underlying = await Effect.runPromise(
    Effect.gen(function*() { return yield* RunRecordStore }).pipe(Effect.provide(memory.layer)),
  )
  let failFirstOutputWrite = true
  const faultingStore: RunRecordStoreService = {
    ...underlying,
    writeEvidence: (runId, applicationPath, body) => {
      if (failFirstOutputWrite && applicationPath.startsWith("outputs/")) {
        failFirstOutputWrite = false
        return Effect.fail(new RunRecordError("DURABILITY_FAILURE", "output evidence was interrupted"))
      }
      return underlying.writeEvidence(runId, applicationPath, body)
    },
  }
  const faultingLayer = Layer.succeed(RunRecordStore, faultingStore)
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
    layer = faultingLayer,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-poll-only-orphan-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-poll-only-orphan","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-poll-only-orphan-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const outputSha256 = createHash("sha256").update(videoBody).digest("hex")
  const completedPoll = (
    polledAt: `${string}Z`,
    applicationPath: `outputs/${string}` = "outputs/seedance-poll-only-orphan.mp4",
  ): RecordOperation => {
    const pollBody = Buffer.from(JSON.stringify({
      job_id: "seedance-poll-only-orphan",
      status: "completed",
      polled_at: polledAt,
      outputs: [{ application_path: applicationPath, media_type: "video/mp4", sha256: outputSha256 }],
      completed_count: 1,
      cost: { state: "unknown" },
    }))
    return {
      _tag: "CommitSeedancePoll",
      runId: reserved.runId,
      operationId: "seedance-poll-only-orphan-poll-1",
      jobId: "seedance-poll-only-orphan",
      status: "completed",
      evidence: {
        mediaType: "application/json",
        body: pollBody,
        sha256: createHash("sha256").update(pollBody).digest("hex"),
      },
      outputs: [{
        applicationPath,
        mediaType: "video/mp4",
        body: videoBody,
        sha256: outputSha256,
      }],
      completedCount: 1,
      cost: { state: "unknown" },
    }
  }
  const firstPollAt = "2026-08-30T12:00:00.000Z" as const
  const secondPollAt = "2026-08-30T12:00:01.000Z" as const
  const interrupted = await Effect.runPromise(Effect.flip(provide(record(completedPoll(firstPollAt)))))
  assert.equal(interrupted.code, "DURABILITY_FAILURE")
  await assert.rejects(
    Effect.runPromise(readEvidence(
      reserved.runId,
      "outputs/seedance-poll-only-orphan.mp4",
    ).pipe(Effect.provide(memory.layer))),
  )

  const replacement = await Effect.runPromise(Effect.flip(provide(record(completedPoll(
    secondPollAt,
    "outputs/replacement.mp4",
  )), memory.layer)))
  assert.equal(replacement.code, "EVIDENCE_HASH_MISMATCH")

  const recovered = await Effect.runPromise(provide(record(completedPoll(secondPollAt)), memory.layer))
  assert.equal(recovered.view.phase, "generated_outputs_received")
  assert.equal(recovered.view.pollCount, 1)
  assert.equal(recovered.view.completedCount, 1)
  assert.equal(Buffer.from(await Effect.runPromise(readEvidence(
    reserved.runId,
    "outputs/seedance-poll-only-orphan.mp4",
  ).pipe(Effect.provide(memory.layer)))).equals(Buffer.from(videoBody)), true)
  const durablePoll = JSON.parse(Buffer.from(await Effect.runPromise(
    readEvidence(reserved.runId, "polls/poll-0001.json").pipe(Effect.provide(memory.layer)),
  )).toString("utf8")) as Record<string, unknown>
  assert.equal(durablePoll.polled_at, firstPollAt)
})

test("a completed poll recovers orphaned write-once evidence without stranding the Run", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-orphan-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-orphan","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-orphan-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  const completedPoll = (polledAt: `${string}Z`, outputBody = videoBody): RecordOperation => {
    const outputSha256 = createHash("sha256").update(outputBody).digest("hex")
    const pollBody = completedPollBody("seedance-orphan", [{
      applicationPath: "outputs/seedance-orphan.mp4",
      mediaType: "video/mp4",
      sha256: outputSha256,
    }], 1, { state: "unknown" }, { polled_at: polledAt })
    return {
      _tag: "CommitSeedancePoll",
      runId: reserved.runId,
      operationId: "seedance-orphan-poll-1",
      jobId: "seedance-orphan",
      status: "completed",
      evidence: {
        mediaType: "application/json",
        body: pollBody,
        sha256: createHash("sha256").update(pollBody).digest("hex"),
      },
      outputs: [{
        applicationPath: "outputs/seedance-orphan.mp4",
        mediaType: "video/mp4",
        body: outputBody,
        sha256: outputSha256,
      }],
      completedCount: 1,
      cost: { state: "unknown" },
    }
  }
  await Effect.runPromise(memory.failNext("append-event"))
  const firstPollAt = "2026-08-30T12:00:00.000Z" as const
  const secondPollAt = "2026-08-30T12:00:01.000Z" as const
  const interrupted = await Effect.runPromise(Effect.flip(provide(record(completedPoll(firstPollAt)))))
  assert.equal(interrupted.code, "DURABILITY_FAILURE")
  assert.equal((await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer)))).phase, "provider_evidence_received")

  const changedOutput = Uint8Array.from(videoBody)
  changedOutput[changedOutput.length - 1] = (changedOutput[changedOutput.length - 1] ?? 0) ^ 1
  const contradiction = await Effect.runPromise(Effect.flip(provide(record(completedPoll(secondPollAt, changedOutput)))))
  assert.equal(contradiction.code, "EVIDENCE_HASH_MISMATCH")

  const recovered = await Effect.runPromise(provide(record(completedPoll(secondPollAt))))
  assert.equal(recovered.view.phase, "generated_outputs_received")
  assert.equal(recovered.view.pollCount, 1)
  assert.equal(recovered.view.completedCount, 1)
  const durablePoll = JSON.parse(Buffer.from(await Effect.runPromise(
    readEvidence(reserved.runId, "polls/poll-0001.json").pipe(Effect.provide(memory.layer)),
  )).toString("utf8")) as Record<string, unknown>
  assert.equal(durablePoll.polled_at, firstPollAt)
})

test("a durable pending poll is journaled before a later completed response", async () => {
  const { planned, body: videoBody } = await plannedSeedanceRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "seedance-pending-submit-marker",
  })))
  const submissionBody = Buffer.from('{"job_id":"seedance-pending","status":"submitted"}')
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "seedance-pending-submission",
    evidence: {
      mediaType: "application/json",
      body: submissionBody,
      sha256: createHash("sha256").update(submissionBody).digest("hex"),
    },
  })))
  await Effect.runPromise(memory.failNext("append-event"))
  const pendingBody = Buffer.from('{"job_id":"seedance-pending","status":"pending"}')
  const interrupted = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId: "seedance-pending-poll-1",
    jobId: "seedance-pending",
    status: "pending",
    evidence: {
      mediaType: "application/json",
      body: pendingBody,
      sha256: createHash("sha256").update(pendingBody).digest("hex"),
    },
  }))))
  assert.equal(interrupted.code, "DURABILITY_FAILURE")

  const outputSha256 = createHash("sha256").update(videoBody).digest("hex")
  const completedBody = completedPollBody("seedance-pending", [{
    applicationPath: "outputs/seedance-pending.mp4",
    mediaType: "video/mp4",
    sha256: outputSha256,
  }], 1, { state: "unknown" })
  const completedOperation = (operationId: string): RecordOperation => ({
    _tag: "CommitSeedancePoll",
    runId: reserved.runId,
    operationId,
    jobId: "seedance-pending",
    status: "completed",
    evidence: {
      mediaType: "application/json",
      body: completedBody,
      sha256: createHash("sha256").update(completedBody).digest("hex"),
    },
    outputs: [{
      applicationPath: "outputs/seedance-pending.mp4",
      mediaType: "video/mp4",
      body: videoBody,
      sha256: outputSha256,
    }],
    completedCount: 1,
    cost: { state: "unknown" },
  })
  const recoveredPending = await Effect.runPromise(provide(record(completedOperation("seedance-pending-poll-1"))))
  assert.equal(recoveredPending.view.pollCount, 1)
  assert.equal(recoveredPending.view.phase, "provider_evidence_received")
  const completed = await Effect.runPromise(provide(record(completedOperation("seedance-pending-poll-2"))))
  assert.equal(completed.view.pollCount, 2)
  assert.equal(completed.view.phase, "generated_outputs_received")
})

test("a definitive pre-submit failure remains immutable and only supports a proved linked Run", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reservation = reservationFor(planned)
  const original = await Effect.runPromise(provide(reserve(reservation)))
  const failed = await Effect.runPromise(provide(record({
    _tag: "DefinitivePreSubmitFailure",
    runId: original.runId,
    operationId: "client-initialization-failed",
    failure: { class: "client_initialization", message: "Fake client could not initialize." },
  })))
  assert.equal(failed._tag, "Recorded")
  assert.equal(failed.view.phase, "definitive_pre_submit_failure")
  assert.equal(failed.view.classification, "failed")
  assert.equal(failed.view.finding?.correctionOwner, "Generation")
  assert.equal(failed.view.spendState, "not_spent")
  assert.equal(failed.view.retryState, "new-linked-run-only")

  const linkedFrom = {
    parentRunId: original.runId,
    parentFailureEventSha256: failed.view.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure" as const,
  }
  const successorPlan = await plannedRun(linkedFrom)
  const unchanged = await Effect.runPromise(Effect.flip(
    provide(reserve(reservationFor(successorPlan))),
  ))
  assert.equal(unchanged.code, "CORRECTION_NOT_MATERIAL")

  const correctedPlan = await plannedRun(
    linkedFrom,
    1,
    "Corrected objective after a definitive client initialization refusal.",
  )
  const successor = await Effect.runPromise(provide(reserve(reservationFor(correctedPlan))))
  assert.notEqual(successor.runId, original.runId)
  assert.deepEqual(successor.linkedFrom, linkedFrom)
  assert.equal(successor.phase, "reserved")
  assert.equal(successor.correctionDepth, 1)
  assert.equal(successor.maximumCorrectionRuns, 2)

  const falseLinkPlan = await plannedRun(
    { ...linkedFrom, parentFailureEventSha256: "0".repeat(64) },
    1,
    "Different objective with a false parent event.",
  )
  const falseLink = await Effect.runPromise(Effect.flip(
    provide(reserve(reservationFor(falseLinkPlan))),
  ))
  assert.equal(falseLink.code, "LINK_FAILURE_MISMATCH")

  const originalAfter = await Effect.runPromise(
    load(original.runId).pipe(Effect.provide(memory.layer)),
  )
  assert.deepEqual(originalAfter, failed.view)
})

test("definitive unspent failures permit only bounded, material correction Runs", async () => {
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const failBeforeSubmission = async (planned: PlannedRun, suffix: string) => {
    const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
    const failed = await Effect.runPromise(provide(record({
      _tag: "DefinitivePreSubmitFailure",
      runId: reserved.runId,
      operationId: `${suffix}-failure`,
      failure: {
        class: "client_initialization",
        message: `Definitive unspent refusal ${suffix}.`,
      },
    })))
    return failed.view
  }

  const parent = await failBeforeSubmission(await plannedRun(), "parent")
  assert.equal(parent.correctionDepth, 0)
  assert.equal(parent.maximumCorrectionRuns, 2)
  const linkOne: RunLink = {
    parentRunId: parent.runId,
    parentFailureEventSha256: parent.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure",
  }

  const unchanged = await plannedRun(linkOne)
  const unchangedError = await Effect.runPromise(Effect.flip(
    provide(reserve(reservationFor(unchanged))),
  ))
  assert.equal(unchangedError.code, "CORRECTION_NOT_MATERIAL")

  const correctedOne = await plannedRun(linkOne, 1, "Corrected objective after malformed provider response.")
  const firstCorrection = await Effect.runPromise(provide(reserve(reservationFor(correctedOne))))
  assert.equal(firstCorrection.correctionDepth, 1)
  const failedCorrection = await failBeforeSubmission(correctedOne, "correction-one")
  const linkTwo: RunLink = {
    parentRunId: failedCorrection.runId,
    parentFailureEventSha256: failedCorrection.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure",
  }
  const correctedTwo = await plannedRun(linkTwo, 1, "Second material correction.")
  const secondCorrection = await Effect.runPromise(provide(reserve(reservationFor(correctedTwo))))
  assert.equal(secondCorrection.correctionDepth, 2)
  const failedSecond = await failBeforeSubmission(correctedTwo, "correction-two")
  const linkThree: RunLink = {
    parentRunId: failedSecond.runId,
    parentFailureEventSha256: failedSecond.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure",
  }
  const exhausted = await plannedRun(linkThree, 1, "Third correction exceeds the approved limit.")
  const exhaustedError = await Effect.runPromise(Effect.flip(
    provide(reserve(reservationFor(exhausted))),
  ))
  assert.equal(exhaustedError.code, "CORRECTION_LIMIT_EXHAUSTED")
})

test("possibly-spent blocked Runs can reconcile only and never create a correction Run", async () => {
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const planned = await plannedRun()
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "ambiguous-submission",
  })))
  const blocked = await Effect.runPromise(provide(record({
    _tag: "ClassifyFailure",
    runId: reserved.runId,
    operationId: "ambiguous-outcome",
    failure: {
      class: "ambiguous_provider_timeout",
      message: "Provider identity must be reconciled.",
    },
  })))
  const linked: RunLink = {
    parentRunId: blocked.view.runId,
    parentFailureEventSha256: blocked.view.chainHeadSha256,
    relation: "retry-after-definitive-pre-submit-failure",
  }
  const successor = await plannedRun(linked, 1, "A changed objective must not permit another submission.")
  const error = await Effect.runPromise(Effect.flip(
    provide(reserve(reservationFor(successor))),
  ))
  assert.equal(error.code, "LINK_NOT_ALLOWED")
})

test("persists a closed failure record with fixed spend, retry, outcome, and correction ownership", async () => {
  const cases = [
    ["ambiguous_provider_timeout", "blocked", "possibly_spent", "reconcile-only", "Generation", true],
    ["malformed_provider_response", "failed", "possibly_spent", "reconcile-only", "Generation", true],
    ["output_count_mismatch", "failed", "possibly_spent", "reconcile-only", "Generation", true],
    ["post_submit_persistence_failure", "blocked", "possibly_spent", "reconcile-only", "Generation", true],
    ["budget_exhausted", "blocked", "not_spent", "never-resubmit", "application decision owner", false],
    ["repeated_bad_output", "failed", "unknown", "reconcile-only", "Verification", true],
  ] as const

  for (const [failureClass, outcome, spend, retry, owner, afterSubmission] of cases) {
    const planned = await plannedRun()
    const memory = await memoryHarness()
    const provide = <Success, Error>(
      effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
    ): Effect.Effect<Success, Error> => effect.pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    )
    const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
    if (afterSubmission) {
      await Effect.runPromise(provide(record({
        _tag: "SubmissionMayHaveStarted",
        runId: reserved.runId,
        operationId: `${failureClass}-submission`,
      })))
      if (failureClass === "repeated_bad_output") {
        const providerBody = Buffer.from('{"request_id":"repeated-output","status":"accepted"}', "utf8")
        await Effect.runPromise(provide(record({
          _tag: "CommitProviderEvidence",
          runId: reserved.runId,
          operationId: `${failureClass}-provider`,
          evidence: {
            mediaType: "application/json",
            body: providerBody,
            sha256: createHash("sha256").update(providerBody).digest("hex"),
          },
        })))
        const outputBody = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        await Effect.runPromise(provide(record({
          _tag: "CommitGeneratedOutput",
          runId: reserved.runId,
          operationId: `${failureClass}-output`,
          output: {
            applicationPath: "outputs/repeated-bad.png",
            mediaType: "image/png",
            body: outputBody,
            sha256: createHash("sha256").update(outputBody).digest("hex"),
          },
        })))
      }
    }
    const classified = await Effect.runPromise(provide(record({
      _tag: "ClassifyFailure",
      runId: reserved.runId,
      operationId: `${failureClass}-outcome`,
      failure: {
        class: failureClass,
        message: `Safe fixture failure for ${failureClass}.`,
      },
    } as unknown as RecordOperation)))
    assert.equal(classified.view.classification, outcome)
    assert.equal(classified.view.phase, outcome)
    assert.equal(classified.view.spendState, spend)
    assert.equal(classified.view.retryState, retry)
    assert.equal(classified.view.finding?.class, failureClass)
    assert.equal(classified.view.finding?.correctionOwner, owner)
    assert.equal("approval" in classified.view, false)

    const failureBytes = await Effect.runPromise(
      readEvidence(reserved.runId, "failure.json").pipe(Effect.provide(memory.layer)),
    )
    assert.deepEqual(JSON.parse(Buffer.from(failureBytes).toString("utf8")), {
      class: failureClass,
      correctionOwner: owner,
      message: `Safe fixture failure for ${failureClass}.`,
      outcome,
      retryState: retry,
      spendState: spend,
    })
  }
})

test("replays an interrupted classified failure to one durable evidence-backed outcome", async () => {
  for (const failedWrite of ["append-event", "write-evidence", "write-state"] as const) {
    const planned = await plannedRun()
    const memory = await memoryHarness()
    const provide = <Success, Error>(
      effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
    ): Effect.Effect<Success, Error> => effect.pipe(
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    )
    const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
    await Effect.runPromise(provide(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `classified-interruption-${failedWrite}-submission`,
    })))
    const operation = {
      _tag: "ClassifyFailure" as const,
      runId: reserved.runId,
      operationId: `classified-interruption-${failedWrite}`,
      failure: {
        class: "post_submit_persistence_failure" as const,
        message: `Interrupted ${failedWrite} while preserving a terminal classification.`,
      },
    }
    await Effect.runPromise(memory.failNext(failedWrite))
    const interruption = await Effect.runPromise(Effect.flip(provide(record(operation))))
    assert.equal(interruption.code, "DURABILITY_FAILURE")

    const recovered = await Effect.runPromise(provide(record(operation)))
    assert.equal(recovered.view.phase, "blocked")
    assert.equal(recovered.view.classification, "blocked")
    assert.equal(recovered.view.spendState, "possibly_spent")
    assert.equal(recovered.view.retryState, "reconcile-only")
    assert.equal(recovered.view.finding?.correctionOwner, "Generation")
    assert.deepEqual(await Effect.runPromise(provide(load(reserved.runId))), recovered.view)
    const failureBytes = await Effect.runPromise(
      readEvidence(reserved.runId, "failure.json").pipe(Effect.provide(memory.layer)),
    )
    assert.equal(JSON.parse(Buffer.from(failureBytes).toString("utf8")).class, "post_submit_persistence_failure")
  }
})

test("interruption at every persistence and network seam never creates a second submission", async () => {
  const planned = await plannedRun()
  const execute = <Success, Error>(
    memory: MemoryRunRecordHarness,
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))

  const beforeReservation = await memoryHarness()
  await Effect.runPromise(beforeReservation.failNext("create"))
  const createError = await Effect.runPromise(Effect.flip(
    reserve(reservationFor(planned)).pipe(
      Effect.provide(beforeReservation.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(createError.code, "DURABILITY_FAILURE")

  const beforeMarker = await memoryHarness()
  const reservedBeforeMarker = await execute(beforeMarker, reserve(reservationFor(planned)))
  await Effect.runPromise(beforeMarker.failNext("append-event"))
  const markerError = await Effect.runPromise(Effect.flip(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reservedBeforeMarker.runId,
      operationId: "interrupted-marker",
    }).pipe(
      Effect.provide(beforeMarker.layer),
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

  const afterNetwork = await memoryHarness()
  const reservedAfterNetwork = await execute(afterNetwork, reserve(reservationFor(planned)))
  const networkPermit = await execute(afterNetwork, record({
    _tag: "SubmissionMayHaveStarted",
    runId: reservedAfterNetwork.runId,
    operationId: "network-started",
  }))
  assert.equal(networkPermit._tag, "SubmissionPermitIssued")
  const consumeNetworkPermit = () => {
    if (networkPermit._tag !== "SubmissionPermitIssued") throw new Error("fixture permit missing")
    return consumeSubmission(networkPermit.permit, {
      requestSha256: networkPermit.permit.requestSha256,
      payloadSha256: networkPermit.permit.payloadSha256,
    })
  }
  await Effect.runPromise(consumeNetworkPermit())
  assert.equal((await execute(afterNetwork, load(reservedAfterNetwork.runId))).phase, "submission_may_have_started")
  const secondPermitError = await Effect.runPromise(Effect.flip(
    record({
      _tag: "SubmissionMayHaveStarted",
      runId: reservedAfterNetwork.runId,
      operationId: "network-retry",
    }).pipe(
      Effect.provide(afterNetwork.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(secondPermitError.code, "DUPLICATE_SUBMISSION_BLOCKED")

  const evidenceBody = Buffer.from('{"request_id":"fake-interruption","status":"accepted"}', "utf8")
  const evidenceSha256 = createHash("sha256").update(evidenceBody).digest("hex")
  for (const failedWrite of ["write-evidence", "append-event", "write-state"] as const) {
    const memory = await memoryHarness()
    const reserved = await execute(memory, reserve(reservationFor(planned)))
    await execute(memory, record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: `submit-before-${failedWrite}`,
    }))
    await Effect.runPromise(memory.failNext(failedWrite))
    const persistenceError = await Effect.runPromise(Effect.flip(
      record({
        _tag: "CommitProviderEvidence",
        runId: reserved.runId,
        operationId: `evidence-after-${failedWrite}`,
        evidence: { mediaType: "application/json", body: evidenceBody, sha256: evidenceSha256 },
      }).pipe(
        Effect.provide(memory.layer),
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
})

test("a fresh process reloads the same hash-chained Run from an application filesystem", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const artifactRoot = "artifacts/qwen-pipeline"
  const planned = await plannedRun()
  const firstLayer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, artifactRoot))
  const execute = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provide(firstLayer),
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
  assert.equal((await readFile(join(runDirectory, "events.jsonl"), "utf8")).trimEnd().split("\n").length, 4)
  assert.deepEqual(await readFile(join(runDirectory, "provider-response.json")), body)

  const freshLayer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, artifactRoot))
  const reloaded = await Effect.runPromise(
    load(reserved.runId).pipe(Effect.provide(freshLayer)),
  )
  assert.deepEqual(reloaded, committed.view)

  const falseView = { ...reloaded, phase: "reserved" }
  await writeFile(join(runDirectory, "state.json"), JSON.stringify(falseView), "utf8")
  const contradiction = await Effect.runPromise(Effect.flip(
    load(reserved.runId).pipe(Effect.provide(freshLayer)),
  ))
  assert.equal(contradiction.code, "DERIVED_VIEW_CONTRADICTION")
})

test("the filesystem adapter refuses symlink escapes before writing outside the application", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-app-"))
  const outsideRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-outside-"))
  context.after(async () => Promise.all([
    rm(applicationRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]))
  await mkdir(join(applicationRoot, "artifacts"))
  await symlink(outsideRoot, join(applicationRoot, "artifacts", "qwen-pipeline"), "dir")
  const planned = await plannedRun()
  const layer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, "artifacts/qwen-pipeline"))
  const error = await Effect.runPromise(Effect.flip(
    reserve(reservationFor(planned)).pipe(
      Effect.provide(layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(error.code, "DURABILITY_FAILURE")
  assert.deepEqual(await readdir(outsideRoot), [])
})

test("the filesystem adapter refuses symlinked authoritative control files", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-controls-"))
  const outsideRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-controls-outside-"))
  context.after(async () => Promise.all([
    rm(applicationRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]))
  const layer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, "artifacts/qwen-pipeline"))
  const planned = await plannedRun()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  const directory = join(applicationRoot, "artifacts/qwen-pipeline/runs", reserved.runId)
  const outsideRequest = join(outsideRoot, "request.json")
  await writeFile(outsideRequest, planned.canonicalRequest, "utf8")
  await unlink(join(directory, "request.json"))
  await symlink(outsideRequest, join(directory, "request.json"), "file")
  const result = await Effect.runPromise(Effect.flip(
    load(reserved.runId).pipe(Effect.provide(layer)),
  ))
  assert.equal(result.code, "DURABILITY_FAILURE")
})

test("filesystem interruption after an immutable event frame reloads without another submission", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-lock-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const harness = await Effect.runPromise(makeFileRunRecordHarness(applicationRoot, "artifacts/qwen-pipeline"))
  const planned = await plannedRun()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  await Effect.runPromise(harness.failNext("after-event-frame"))
  const interrupted = await Effect.runPromise(Effect.flip(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "filesystem-interrupted-marker",
  }).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(RunRecordClock, clock),
  )))
  assert.equal(interrupted.code, "DURABILITY_FAILURE")

  const freshLayer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, "artifacts/qwen-pipeline"))
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(freshLayer)))
  assert.equal(reloaded.phase, "submission_may_have_started")
  assert.equal(reloaded.retryState, "reconcile-only")
  const duplicate = await Effect.runPromise(Effect.flip(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "filesystem-second-marker",
  }).pipe(
    Effect.provide(freshLayer),
    Effect.provideService(RunRecordClock, clock),
  )))
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")

  const journalPath = join(applicationRoot, "artifacts/qwen-pipeline/runs", reserved.runId, "events.jsonl")
  const frames = (await readFile(journalPath, "utf8")).trimEnd().split("\n")
  assert.equal(frames.length, 2)
  for (const frame of frames) assert.doesNotThrow(() => JSON.parse(frame))
})

test("temporary-filesystem faults recover reservation, evidence, and derived state without a new Run", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-faults-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const harness = await Effect.runPromise(makeFileRunRecordHarness(applicationRoot, "artifacts/qwen-pipeline"))
  const planned = await plannedRun()
  const execute = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provide(harness.layer),
    Effect.provideService(RunRecordClock, clock),
  ))

  await Effect.runPromise(harness.failNext("after-create"))
  const interruptedCreate = await Effect.runPromise(Effect.flip(
    reserve(reservationFor(planned)).pipe(
      Effect.provide(harness.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(interruptedCreate.code, "DURABILITY_FAILURE")
  const reserved = await execute(reserve(reservationFor(planned)))
  assert.equal(reserved.phase, "reserved")

  await execute(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "filesystem-fault-submit",
  }))
  const body = Buffer.from('{"request_id":"filesystem-fault","status":"accepted"}', "utf8")
  const evidence = {
    mediaType: "application/json" as const,
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
  }
  await Effect.runPromise(harness.failNext("after-evidence"))
  const interruptedEvidence = await Effect.runPromise(Effect.flip(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "filesystem-fault-evidence",
    evidence,
  }).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(RunRecordClock, clock),
  )))
  assert.equal(interruptedEvidence.code, "DURABILITY_FAILURE")

  await Effect.runPromise(harness.failNext("after-state"))
  const interruptedState = await Effect.runPromise(Effect.flip(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "filesystem-fault-evidence",
    evidence,
  }).pipe(
    Effect.provide(harness.layer),
    Effect.provideService(RunRecordClock, clock),
  )))
  assert.equal(interruptedState.code, "DURABILITY_FAILURE")

  const freshLayer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, "artifacts/qwen-pipeline"))
  const recovered = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(freshLayer)))
  assert.equal(recovered.phase, "provider_evidence_received")
  assert.equal(recovered.runId, reserved.runId)
})

test("concurrent filesystem writers preserve one complete append without erasing the winner", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-concurrent-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const layer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, "artifacts/qwen-pipeline"))
  const planned = await plannedRun()
  const reserved = await Effect.runPromise(reserve(reservationFor(planned)).pipe(
    Effect.provide(layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  const outcomes = await Promise.all(["one", "two"].map((suffix) => Effect.runPromise(record({
    _tag: "DefinitivePreSubmitFailure",
    runId: reserved.runId,
    operationId: `concurrent-${suffix}`,
    failure: { class: `concurrent_${suffix}`, message: `Concurrent writer ${suffix}.` },
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(RunRecordClock, clock),
    Effect.match({ onFailure: (error) => error.code, onSuccess: (result) => result._tag }),
  ))))
  assert.equal(outcomes.filter((outcome) => outcome === "Recorded").length, 1)
  assert.equal(outcomes.filter((outcome) => outcome !== "Recorded").length, 1)
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(layer)))
  assert.equal(reloaded.phase, "definitive_pre_submit_failure")
  const journalPath = join(applicationRoot, "artifacts/qwen-pipeline/runs", reserved.runId, "events.jsonl")
  assert.equal((await readFile(journalPath, "utf8")).trimEnd().split("\n").length, 2)
})

test("tampered requests, event chains, evidence, and illegal rewrites fail by name", async () => {
  const planned = await plannedRun()
  const execute = <Success, Error>(
    memory: MemoryRunRecordHarness,
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))

  const changedRequest = await memoryHarness()
  const requestRun = await execute(changedRequest, reserve(reservationFor(planned)))
  await Effect.runPromise(changedRequest.mutate(requestRun.runId, (stored) => {
    stored.request[0] = stored.request[0]! ^ 1
  }))
  const requestError = await Effect.runPromise(Effect.flip(
    load(requestRun.runId).pipe(Effect.provide(changedRequest.layer)),
  ))
  assert.equal(requestError.code, "REQUEST_TAMPERED")

  const reboundRequest = await memoryHarness()
  const reboundRun = await execute(reboundRequest, reserve(reservationFor(planned)))
  const alternativeFixture = makeFixture("qwen-image", {
    objective: (objective) => { objective.summary = "A distinct canonical request for identity tampering." },
  })
  const alternative = await Effect.runPromise(compilePlannedRun(alternativeFixture.documents).pipe(
    Effect.provideService(ApplicationFiles, alternativeFixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, alternativeFixture.identity),
  ))
  await Effect.runPromise(reboundRequest.mutate(reboundRun.runId, (stored) => {
    const event = JSON.parse(Buffer.from(stored.events).toString("utf8")) as Record<string, unknown>
    const payload = event.payload as Record<string, unknown>
    event.payload = { ...payload, requestSha256: alternative.requestSha256 }
    const { eventSha256: _discarded, ...withoutDigest } = event
    event.eventSha256 = createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")
    stored.request = Buffer.from(alternative.canonicalRequest, "utf8")
    stored.events = Buffer.from(`${canonicalJson(event)}\n`, "utf8")
    delete stored.state
  }))
  const reboundError = await Effect.runPromise(Effect.flip(
    load(reboundRun.runId).pipe(Effect.provide(reboundRequest.layer)),
  ))
  assert.equal(reboundError.code, "REQUEST_TAMPERED")

  const brokenEvents = await memoryHarness()
  const eventRun = await execute(brokenEvents, reserve(reservationFor(planned)))
  await Effect.runPromise(brokenEvents.mutate(eventRun.runId, (stored) => {
    const event = JSON.parse(Buffer.from(stored.events).toString("utf8")) as Record<string, unknown>
    event.payload = { ...(event.payload as object), maximumCount: 99 }
    stored.events = Buffer.from(`${JSON.stringify(event)}\n`, "utf8")
  }))
  const chainError = await Effect.runPromise(Effect.flip(
    load(eventRun.runId).pipe(Effect.provide(brokenEvents.layer)),
  ))
  assert.equal(chainError.code, "EVENT_CHAIN_BROKEN")

  const contradictoryReservation = await memoryHarness()
  const contradictoryRun = await execute(contradictoryReservation, reserve(reservationFor(planned)))
  await Effect.runPromise(contradictoryReservation.mutate(contradictoryRun.runId, (stored) => {
    const event = JSON.parse(Buffer.from(stored.events).toString("utf8")) as Record<string, unknown>
    event.payload = { ...(event.payload as object), maximumCount: 99 }
    const { eventSha256: _discarded, ...withoutDigest } = event
    event.eventSha256 = createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")
    stored.events = Buffer.from(`${canonicalJson(event)}\n`, "utf8")
    delete stored.state
  }))
  const reservationError = await Effect.runPromise(Effect.flip(
    load(contradictoryRun.runId).pipe(Effect.provide(contradictoryReservation.layer)),
  ))
  assert.equal(reservationError.code, "REQUEST_TAMPERED")

  const changedEvidence = await memoryHarness()
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
  await Effect.runPromise(changedEvidence.mutate(evidenceRun.runId, (stored) => {
    const providerResponse = stored.evidence["provider-response.json"]
    if (providerResponse === undefined || providerResponse[0] === undefined) throw new Error("fixture evidence missing")
    providerResponse[0] ^= 1
  }))
  const evidenceError = await Effect.runPromise(Effect.flip(
    load(evidenceRun.runId).pipe(Effect.provide(changedEvidence.layer)),
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
      Effect.provide(changedEvidence.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  ))
  assert.equal(illegalRewrite.code, "EVIDENCE_HASH_MISMATCH")
})

test("persists generated output evidence and reads only its verified bytes", async () => {
  const planned = await plannedRun()
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "output-submit",
  })))
  const providerBody = Buffer.from('{"request_id":"output-fixture","status":"succeeded"}', "utf8")
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "output-provider-evidence",
    evidence: {
      mediaType: "application/json",
      body: providerBody,
      sha256: createHash("sha256").update(providerBody).digest("hex"),
    },
  })))
  const output = Buffer.from("fake-png-output", "utf8")
  const outputSha256 = createHash("sha256").update(output).digest("hex")
  const committed = await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "output-one",
    output: {
      applicationPath: "outputs/candidate-001.png",
      mediaType: "image/png",
      body: output,
      sha256: outputSha256,
    },
  })))
  assert.equal(committed.view.phase, "generated_outputs_received")
  assert.deepEqual(
    Buffer.from(await Effect.runPromise(readEvidence(reserved.runId, "outputs/candidate-001.png").pipe(
      Effect.provide(memory.layer),
    ))),
    output,
  )
  const forgedReplay = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "output-one",
    output: {
      applicationPath: "outputs/candidate-001.png",
      mediaType: "image/png",
      body: Buffer.from("changed replay body"),
      sha256: outputSha256,
    },
  }))))
  assert.equal(forgedReplay.code, "IDEMPOTENCY_CONFLICT")

  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    const events = Buffer.from(stored.events).toString("utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const outputEvent = events.at(-1)!
    outputEvent.payload = {
      ...(outputEvent.payload as Record<string, unknown>),
      applicationPath: "outputs/../escape.png",
    }
    const { eventSha256: _discarded, ...withoutDigest } = outputEvent
    outputEvent.eventSha256 = createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")
    stored.evidence["outputs/../escape.png"] = stored.evidence["outputs/candidate-001.png"]!
    delete stored.evidence["outputs/candidate-001.png"]
    stored.events = Buffer.from(`${events.map(canonicalJson).join("\n")}\n`, "utf8")
    delete stored.state
  }))
  const unsafeReplay = await Effect.runPromise(Effect.flip(load(reserved.runId).pipe(Effect.provide(memory.layer))))
  assert.equal(unsafeReplay.code, "EVIDENCE_HASH_MISMATCH")
})

test("records a donor-choice checkpoint and selects only a persisted output on the same Run", async () => {
  const planned = await plannedRun(undefined, 2)
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({ _tag: "SubmissionMayHaveStarted", runId: reserved.runId, operationId: "donor-submit" })))
  const providerBody = Buffer.from('{"request_id":"donor-fixture","status":"succeeded"}', "utf8")
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "donor-provider-evidence",
    evidence: {
      mediaType: "application/json",
      body: providerBody,
      sha256: createHash("sha256").update(providerBody).digest("hex"),
    },
  })))
  const output = Buffer.from("candidate-for-donor", "utf8")
  const outputSha256 = createHash("sha256").update(output).digest("hex")
  await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "donor-output",
    output: {
      applicationPath: "outputs/donor.png",
      mediaType: "image/png",
      body: output,
      sha256: outputSha256,
    },
  })))
  const incompleteCheckpoint = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "donor-choice-before-all-outputs",
    candidateSha256s: [outputSha256],
  }))))
  assert.equal(incompleteCheckpoint.code, "RESERVATION_OUTSIDE_PLAN")
  const alternativeOutput = Buffer.from("alternative-donor-candidate", "utf8")
  const alternativeSha256 = createHash("sha256").update(alternativeOutput).digest("hex")
  await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "donor-output-alternative",
    output: {
      applicationPath: "outputs/donor-alternative.png",
      mediaType: "image/png",
      body: alternativeOutput,
      sha256: alternativeSha256,
    },
  })))
  const overCount = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "donor-output-over-count",
    output: {
      applicationPath: "outputs/donor-over-count.png",
      mediaType: "image/png",
      body: Buffer.from("third-donor", "utf8"),
      sha256: createHash("sha256").update("third-donor").digest("hex"),
    },
  }))))
  assert.equal(overCount.code, "RESERVATION_OUTSIDE_PLAN")

  const prematureSelection = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "SelectDonor",
    runId: reserved.runId,
    operationId: "selection-before-checkpoint",
    selectedSha256: outputSha256,
  }))))
  assert.equal(prematureSelection.code, "ILLEGAL_TRANSITION")

  const sparseCandidates = new Array<string>(1)
  const sparseCheckpoint = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "sparse-donor-choice",
    candidateSha256s: sparseCandidates,
  }))))
  assert.equal(sparseCheckpoint.code, "RESERVATION_OUTSIDE_PLAN")
  assert.equal((await Effect.runPromise(provide(load(reserved.runId)))).phase, "generated_outputs_received")

  const checkpoint = await Effect.runPromise(provide(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "donor-choice-required",
    candidateSha256s: [outputSha256, alternativeSha256],
  })))
  assert.equal(checkpoint.view.phase, "awaiting_donor_choice")
  const unknown = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "SelectDonor",
    runId: reserved.runId,
    operationId: "unknown-donor",
    selectedSha256: "0".repeat(64),
  }))))
  assert.equal(unknown.code, "DONOR_NOT_PERSISTED")

  const selected = await Effect.runPromise(provide(record({
    _tag: "SelectDonor",
    runId: reserved.runId,
    operationId: "selected-donor",
    selectedSha256: alternativeSha256,
  })))
  assert.equal(selected.view.phase, "donor_selected")
  assert.equal(selected.view.selectedDonorSha256, alternativeSha256)
  assert.equal(selected.view.runId, reserved.runId)
})

test("replay rejects a donor checkpoint that omits part of the reserved output set", async () => {
  const planned = await plannedRun(undefined, 2)
  const memory = await memoryHarness()
  const execute = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Promise<Success> => Effect.runPromise(effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  const reserved = await execute(reserve(reservationFor(planned)))
  await execute(record({ _tag: "SubmissionMayHaveStarted", runId: reserved.runId, operationId: "replay-submit" }))
  const providerBody = Buffer.from('{"request_id":"replay-donor","status":"succeeded"}', "utf8")
  await execute(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "replay-provider",
    evidence: { mediaType: "application/json", body: providerBody, sha256: createHash("sha256").update(providerBody).digest("hex") },
  }))
  const outputBodies = [Buffer.from("replay-output-one"), Buffer.from("replay-output-two")]
  const outputSha256s: string[] = []
  for (const [index, body] of outputBodies.entries()) {
    const outputSha256 = createHash("sha256").update(body).digest("hex")
    outputSha256s.push(outputSha256)
    await execute(record({
      _tag: "CommitGeneratedOutput",
      runId: reserved.runId,
      operationId: `replay-output-${index + 1}`,
      output: {
        applicationPath: `outputs/replay-${index + 1}.png`,
        mediaType: "image/png",
        body,
        sha256: outputSha256,
      },
    }))
  }
  await execute(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "replay-donor-choice",
    candidateSha256s: outputSha256s,
  }))
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    const events = Buffer.from(stored.events).toString("utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const checkpoint = events.at(-1)!
    checkpoint.payload = {
      ...(checkpoint.payload as Record<string, unknown>),
      candidateSha256s: [outputSha256s[0]],
    }
    const { eventSha256: _discarded, ...withoutDigest } = checkpoint
    checkpoint.eventSha256 = createHash("sha256").update(canonicalJson(withoutDigest)).digest("hex")
    stored.events = Buffer.from(`${events.map(canonicalJson).join("\n")}\n`, "utf8")
    delete stored.state
  }))
  const error = await Effect.runPromise(Effect.flip(load(reserved.runId).pipe(Effect.provide(memory.layer))))
  assert.equal(error.code, "RESERVATION_OUTSIDE_PLAN")
})

test("persists separately hashed assembled output and canonical Assembly report", async () => {
  const baseline = raster([
    10, 10, 10, 255,
    20, 20, 20, 255,
  ])
  const planned = await plannedAssemblyRun(baseline)
  const memory = await memoryHarness()
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ): Effect.Effect<Success, Error> => effect.pipe(
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({ _tag: "SubmissionMayHaveStarted", runId: reserved.runId, operationId: "assembly-submit" })))
  const providerBody = Buffer.from('{"request_id":"assembly-fixture","status":"succeeded"}', "utf8")
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "assembly-provider",
    evidence: { mediaType: "application/json", body: providerBody, sha256: createHash("sha256").update(providerBody).digest("hex") },
  })))
  const donor = raster([
    90, 90, 90, 255,
    80, 80, 80, 255,
  ])
  const donorSha256 = createHash("sha256").update(donor).digest("hex")
  await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "assembly-donor-output",
    output: { applicationPath: "outputs/donor.png", mediaType: "image/png", body: donor, sha256: donorSha256 },
  })))
  await Effect.runPromise(provide(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "assembly-choice",
    candidateSha256s: [donorSha256],
  })))
  await Effect.runPromise(provide(record({
    _tag: "SelectDonor",
    runId: reserved.runId,
    operationId: "assembly-select",
    selectedSha256: donorSha256,
  })))

  const assembled = raster([
    10, 10, 10, 255,
    80, 80, 80, 255,
  ])
  const assembledSha256 = createHash("sha256").update(assembled).digest("hex")
  const assemblyPlan = planned.request.assemblyPlan!
  const report = {
    baselineSha256: createHash("sha256").update(baseline).digest("hex"),
    donorSha256,
    regionSha256: createHash("sha256").update(JSON.stringify(assemblyPlan.ownedRegion)).digest("hex"),
    exactCopySha256: createHash("sha256").update(JSON.stringify(assemblyPlan.exactCopy.map((copy) => copy.sha256))).digest("hex"),
    outputSha256: assembledSha256,
  }
  const forgedReport = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitAssembly",
    runId: reserved.runId,
    operationId: "assembly-forged-plan-binding",
    output: {
      applicationPath: "outputs/assembled.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: assembled,
      sha256: assembledSha256,
    },
    report: { ...report, baselineSha256: "1".repeat(64) },
  }))))
  assert.equal(forgedReport.code, "EVIDENCE_HASH_MISMATCH")

  const rawDonorRelabel = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitAssembly",
    runId: reserved.runId,
    operationId: "assembly-raw-donor-relabel",
    output: {
      applicationPath: "outputs/assembled.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: donor,
      sha256: donorSha256,
    },
    report: { ...report, outputSha256: donorSha256 },
  }))))
  assert.equal(rawDonorRelabel.code, "EVIDENCE_HASH_MISMATCH")
  const committed = await Effect.runPromise(provide(record({
    _tag: "CommitAssembly",
    runId: reserved.runId,
    operationId: "assembly-persist",
    output: {
      applicationPath: "outputs/assembled.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: assembled,
      sha256: assembledSha256,
    },
    report,
  })))

  assert.equal(committed.view.phase, "assembly_completed")
  assert.equal(committed.view.assemblyOutputSha256, assembledSha256)
  assert.match(committed.view.assemblyReportSha256 ?? "", /^[a-f0-9]{64}$/)
  const reportBytes = await Effect.runPromise(readEvidence(reserved.runId, "assembly-report.json").pipe(
    Effect.provide(memory.layer),
  ))
  assert.deepEqual(JSON.parse(Buffer.from(reportBytes).toString("utf8")), report)
  assert.notEqual(committed.view.assemblyOutputSha256, committed.view.assemblyReportSha256)

  const checks = [
    { name: "integrity", passed: true, measured: 0 },
    { name: "media", passed: true, measured: 0 },
    { name: "outside-region-preservation", passed: true, measured: 0 },
    { name: "donor-equality-inside-region", passed: true, measured: 0 },
  ] as const
  const arbitraryBaseline = raster([
    0, 0, 0, 0,
    0, 0, 0, 0,
  ])
  const arbitraryBaselineResult = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-arbitrary-baseline",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: {
      body: arbitraryBaseline,
      sha256: createHash("sha256").update(arbitraryBaseline).digest("hex"),
    },
    checks,
  }))))
  assert.equal(arbitraryBaselineResult.code, "EVIDENCE_HASH_MISMATCH")

  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    const persisted = stored.evidence["outputs/assembled.rgba.json"]
    if (persisted === undefined || persisted[0] === undefined) throw new Error("assembled fixture missing")
    persisted[0] ^= 1
  }))
  const fabricatedZeros = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-fabricated-zeros",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks,
  }))))
  assert.equal(fabricatedZeros.code, "EVIDENCE_HASH_MISMATCH")
  await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
    const persisted = stored.evidence["outputs/assembled.rgba.json"]
    if (persisted === undefined || persisted[0] === undefined) throw new Error("assembled fixture missing")
    persisted[0] ^= 1
  }))

  const failedChecks = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-failed",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks: checks.map((check, index) => index === 2 ? { ...check, passed: false } : check),
  }))))
  assert.equal(failedChecks.code, "CHECKS_NOT_PASSED")

  const verified = await Effect.runPromise(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-passed",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks,
  })))
  assert.equal(verified.view.phase, "verified_candidate")
  assert.equal(verified.view.classification, "verified_candidate")
  assert.match(verified.view.checksSha256 ?? "", /^[a-f0-9]{64}$/)
  const checksBytes = await Effect.runPromise(readEvidence(reserved.runId, "checks.json").pipe(
    Effect.provide(memory.layer),
  ))
  assert.deepEqual(JSON.parse(Buffer.from(checksBytes).toString("utf8")), {
    algorithm: "rgba-fidelity-v1",
    candidateSha256: assembledSha256,
    checks,
    classification: "verified-candidate",
    inputs: {
      baselineSha256: report.baselineSha256,
      candidateSha256: assembledSha256,
      donorSha256,
      exactCopySha256: report.exactCopySha256,
      regionSha256: report.regionSha256,
    },
  })
  const replayedChecks = await Effect.runPromise(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-passed",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks,
  })))
  assert.equal(replayedChecks._tag, "ReplayObserved")
  assert.deepEqual(await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(memory.layer))), verified.view)

  const changedReplay = await Effect.runPromise(Effect.flip(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "checks-passed",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks: checks.map((check, index) => index === 3 ? { ...check, measured: 1 } : check),
  }))))
  assert.equal(changedReplay.code, "IDEMPOTENCY_CONFLICT")

  for (const path of [
    "outputs/donor.png",
    "outputs/assembled.rgba.json",
    "assembly-report.json",
    "checks.json",
  ]) {
    await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
      const persisted = stored.evidence[path]
      if (persisted === undefined || persisted[0] === undefined) throw new Error(`${path} fixture missing`)
      persisted[0] ^= 1
    }))
    const tampered = await Effect.runPromise(Effect.flip(
      load(reserved.runId).pipe(Effect.provide(memory.layer)),
    ))
    assert.equal(tampered.code, "EVIDENCE_HASH_MISMATCH")
    await Effect.runPromise(memory.mutate(reserved.runId, (stored) => {
      const persisted = stored.evidence[path]
      if (persisted === undefined || persisted[0] === undefined) throw new Error(`${path} fixture missing`)
      persisted[0] ^= 1
    }))
  }
})

test("a fresh filesystem adapter replays the completed Assembly Run and reads verified evidence", async (context) => {
  const applicationRoot = await mkdtemp(join(tmpdir(), "qwen-run-record-assembly-"))
  context.after(async () => rm(applicationRoot, { recursive: true, force: true }))
  const artifactRoot = "artifacts/qwen-pipeline"
  const layer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, artifactRoot))
  const provide = <Success, Error>(
    effect: Effect.Effect<Success, Error, RunRecordStoreService | RunRecordClockService>,
  ) => effect.pipe(
    Effect.provide(layer),
    Effect.provideService(RunRecordClock, clock),
  )
  const baseline = raster([
    10, 10, 10, 255,
    20, 20, 20, 255,
  ])
  const planned = await plannedAssemblyRun(baseline)
  const reserved = await Effect.runPromise(provide(reserve(reservationFor(planned))))
  await Effect.runPromise(provide(record({ _tag: "SubmissionMayHaveStarted", runId: reserved.runId, operationId: "fs-assembly-submit" })))
  const providerBody = Buffer.from('{"request_id":"fs-assembly","status":"succeeded"}', "utf8")
  await Effect.runPromise(provide(record({
    _tag: "CommitProviderEvidence",
    runId: reserved.runId,
    operationId: "fs-assembly-provider",
    evidence: { mediaType: "application/json", body: providerBody, sha256: createHash("sha256").update(providerBody).digest("hex") },
  })))
  const donor = raster([
    90, 90, 90, 255,
    80, 80, 80, 255,
  ])
  const donorSha256 = createHash("sha256").update(donor).digest("hex")
  await Effect.runPromise(provide(record({
    _tag: "CommitGeneratedOutput",
    runId: reserved.runId,
    operationId: "fs-donor-output",
    output: { applicationPath: "outputs/donor.png", mediaType: "image/png", body: donor, sha256: donorSha256 },
  })))
  await Effect.runPromise(provide(record({
    _tag: "OpenDonorChoice",
    runId: reserved.runId,
    operationId: "fs-donor-choice",
    candidateSha256s: [donorSha256],
  })))
  await Effect.runPromise(provide(record({
    _tag: "SelectDonor",
    runId: reserved.runId,
    operationId: "fs-donor-selected",
    selectedSha256: donorSha256,
  })))
  const assembled = raster([
    10, 10, 10, 255,
    80, 80, 80, 255,
  ])
  const assembledSha256 = createHash("sha256").update(assembled).digest("hex")
  const assemblyPlan = planned.request.assemblyPlan!
  const report = {
    baselineSha256: createHash("sha256").update(baseline).digest("hex"),
    donorSha256,
    regionSha256: createHash("sha256").update(JSON.stringify(assemblyPlan.ownedRegion)).digest("hex"),
    exactCopySha256: createHash("sha256").update(JSON.stringify(assemblyPlan.exactCopy.map((copy) => copy.sha256))).digest("hex"),
    outputSha256: assembledSha256,
  }
  await Effect.runPromise(provide(record({
    _tag: "CommitAssembly",
    runId: reserved.runId,
    operationId: "fs-assembly-persisted",
    output: {
      applicationPath: "outputs/assembled.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: assembled,
      sha256: assembledSha256,
    },
    report,
  })))
  await Effect.runPromise(provide(record({
    _tag: "CommitChecks",
    runId: reserved.runId,
    operationId: "fs-checks-persisted",
    candidateSha256: assembledSha256,
    classification: "verified-candidate",
    baseline: { body: baseline, sha256: report.baselineSha256 },
    checks: [
      { name: "integrity", passed: true, measured: 0 },
      { name: "media", passed: true, measured: 0 },
      { name: "outside-region-preservation", passed: true, measured: 0 },
      { name: "donor-equality-inside-region", passed: true, measured: 0 },
    ],
  })))

  const freshLayer = await Effect.runPromise(fileRunRecordLayer(applicationRoot, artifactRoot))
  const reloaded = await Effect.runPromise(load(reserved.runId).pipe(Effect.provide(freshLayer)))
  assert.equal(reloaded.phase, "verified_candidate")
  assert.equal(reloaded.selectedDonorSha256, donorSha256)
  assert.deepEqual(
    Buffer.from(await Effect.runPromise(readEvidence(reserved.runId, "outputs/assembled.rgba.json").pipe(
      Effect.provide(freshLayer),
    ))),
    assembled,
  )
  const runDirectory = join(applicationRoot, artifactRoot, "runs", reserved.runId)
  assert.deepEqual(await readdir(runDirectory), [
    ".event-frames",
    "assembly-report.json",
    "checks.json",
    "events.jsonl",
    "inputs",
    "outputs",
    "provider-response.json",
    "request.json",
    "state.json",
  ])
})
