import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  advance,
  ApplicationFiles,
  MediaInspector,
  PROJECT_CONTRACT_PATH,
  PlanningIdentity,
  TOOL_LOCK_PATH,
  byteMediaInspector,
  plan,
  type PlanDecision,
} from "./index.js"
import {
  GenerationAdapter,
  invoke,
  prepare,
  type GenerationAdapterService,
  type GenerationResult,
} from "../generation/index.js"
import { MediaInspectionError, type MediaInspectorService } from "../run-contract/index.js"
import {
  RunRecordClock,
  makeMemoryRunRecordHarness,
  readEvidence,
  record,
  reserve,
  type RunRecordClockService,
} from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import { createHash } from "node:crypto"

const execute = async (
  mode: "qwen-image" | "seedance-video",
  mutation: Parameters<typeof makeFixture>[1] = {},
): Promise<Readonly<{ result: PlanDecision; reads: ReadonlyArray<string> }>> => {
  const fixture = makeFixture(mode, mutation)
  const result = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  return { result, reads: fixture.reads }
}

test("plans neutral Qwen and Seedance objectives through the same interface", async () => {
  for (const mode of ["qwen-image", "seedance-video"] as const) {
    const { result, reads } = await execute(mode)
    assert.equal(result._tag, "Planned")
    if (result._tag !== "Planned") continue
    assert.equal(result.run.request.mode, mode)
    assert.equal(Object.isFrozen(result.run), true)
    assert.deepEqual(reads.slice(0, 3), [PROJECT_CONTRACT_PATH, TOOL_LOCK_PATH, `objectives/${mode === "qwen-image" ? "qwen-neutral" : "seedance-neutral"}.json`])
    const reference = result.run.request.references[0]
    assert.ok(reference)
    assert.match(reference.applicationPath, /^references\//)
    assert.match(reference.sha256, /^[a-f0-9]{64}$/)
    assert.ok(reference.authorityReason.length > 0)
    assert.match(reference.payloadDestination, /^\/input_references\/0\/(image_url|video_url)\/url$/)
    assert.match(result.normalView.objective, /neutral square/i)
    assert.match(result.normalView.evidence, /authoritative/i)
    assert.match(result.normalView.nextAction, /advance/i)
    assert.match(result.normalView.spendRisk, /no provider request.*no attempt.*\$0/i)
    assert.match(result.normalView.humanDecision, /no human decision/i)
  }
})

const refusalCases: ReadonlyArray<
  readonly [string, "qwen-image" | "seedance-video", Parameters<typeof makeFixture>[1], string]
> = [
  ["missing", "qwen-image", { files: (files) => files.delete("references/neutral.png") }, "REFERENCE_MISSING"],
  ["changed", "qwen-image", { files: (files) => files.set("references/neutral.png", Buffer.from("changed")) }, "REFERENCE_HASH_MISMATCH"],
  ["wrong kind", "qwen-image", { objective: (o) => ((o.references as Array<Record<string, unknown>>)[0]!.kind = "video") }, "REFERENCE_KIND_MISMATCH"],
  ["unsafe path", "qwen-image", { objective: (o) => ((o.references as Array<Record<string, unknown>>)[0]!.path = "../secret.png") }, "REFERENCE_PATH_UNSAFE"],
  ["secret bearing", "qwen-image", { objective: (o) => (o.apiKey = "sk-secret-value") }, "SECRET_MATERIAL_DETECTED"],
  ["unknown credential field", "qwen-image", { objective: (o) => (o.credential = "actual-private-value") }, "SECRET_MATERIAL_DETECTED"],
  ["generic secret field", "qwen-image", { objective: (o) => (o.secret = "actual-private-value") }, "SECRET_MATERIAL_DETECTED"],
  ["over count", "qwen-image", { objective: (o) => (o.requestedCount = 5) }, "COUNT_OUT_OF_RANGE"],
  ["over budget", "qwen-image", { objective: (o) => (o.budgetCeilingUsd = "0.01") }, "BUDGET_EXCEEDED"],
  ["mismatched exact Tool Lock", "qwen-image", { toolLock: (lock) => (lock.commit = "3".repeat(40)) }, "TOOL_LOCK_MISMATCH"],
  ["missing fixed Project Contract", "qwen-image", { files: (files) => files.delete(PROJECT_CONTRACT_PATH) }, "PROJECT_CONTRACT_MISSING"],
  ["missing fixed Tool Lock", "qwen-image", { files: (files) => files.delete(TOOL_LOCK_PATH) }, "TOOL_LOCK_MISSING"],
  ["matching but invalid payload destination", "seedance-video", {
    contract: (contract) => {
      const procedures = contract.procedures as Array<Record<string, unknown>>
      const seedance = procedures.find((procedure) => procedure.id === "seedance-neutral")!
      ;(seedance.referenceRequirements as Array<Record<string, unknown>>)[0]!.payloadDestination = "not-a-json-pointer"
    },
    objective: (objective) => {
      ;(objective.references as Array<Record<string, unknown>>)[0]!.payloadDestination = "not-a-json-pointer"
    },
  }, "PAYLOAD_DESTINATION_INVALID"],
  ["image-only Seedance video", "seedance-video", { objective: (o) => ((o.references as Array<Record<string, unknown>>)[0]!.kind = "image") }, "SEEDANCE_VIDEO_REFERENCE_REQUIRED"],
]

for (const [name, mode, mutation, expectedCode] of refusalCases) {
  test(`refuses ${name} before Generation or attempt reservation`, async () => {
    const { result } = await execute(mode, mutation)
    assert.equal(result._tag, "Refused")
    if (result._tag !== "Refused") return
    assert.equal(result.refusal.code, expectedCode)
    assert.match(result.normalView.spendRisk, /no provider request.*no attempt.*\$0/i)
    assert.ok(result.normalView.nextAction.length > 0)
    assert.ok(result.normalView.evidence.length > 0)
  })
}

test("a refusal view names the real objective and missing evidence", async () => {
  const { result } = await execute("qwen-image", {
    files: (files) => files.delete("references/neutral.png"),
  })
  assert.equal(result._tag, "Refused")
  if (result._tag !== "Refused") return
  assert.match(result.normalView.objective, /edit a neutral square/i)
  assert.match(result.normalView.evidence, /references\/neutral\.png/i)
  assert.match(result.normalView.evidence, /does not exist/i)
})

test("a secret-bearing objective is refused without echoing secret material", async () => {
  for (const secret of [
    "-----BEGIN PRIVATE KEY----- actual-private-material",
    "https://operator:actual-password@example.test/reference.png",
  ]) {
    const { result } = await execute("qwen-image", {
      objective: (objective) => (objective.summary = secret),
    })
    assert.equal(result._tag, "Refused")
    if (result._tag !== "Refused") continue
    assert.equal(result.refusal.code, "SECRET_MATERIAL_DETECTED")
    assert.doesNotMatch(JSON.stringify(result.normalView), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.match(result.normalView.objective, /could not be read safely/i)
  }
})

const hash = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const rgba = (pixels: ReadonlyArray<number>): Uint8Array =>
  Buffer.from(JSON.stringify({ height: 2, pixels, width: 2 }), "utf8")

test("advances one Qwen Assembly Run through a genuine donor choice to verified evidence", async () => {
  const baseline = rgba([
    10, 10, 10, 255, 20, 20, 20, 255,
    30, 30, 30, 255, 40, 40, 40, 255,
  ])
  const donor = rgba([
    90, 90, 90, 255, 80, 80, 80, 255,
    70, 70, 70, 255, 60, 60, 60, 255,
  ])
  const exactCopyCore = { x: 1, y: 0, rgba: [5, 6, 7, 255] as const }
  const referencePath = "references/neutral.rgba.json"
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      const reference = (objective.references as Array<Record<string, unknown>>)[0]!
      reference.path = referencePath
      reference.sha256 = hash(baseline)
      reference.declaredMedia = { width: 2, height: 2 }
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 1, y: 0, width: 1, height: 2 },
        exactCopy: [{
          ...exactCopyCore,
          sha256: hash(JSON.stringify(exactCopyCore)),
        }],
      }
    },
    files: (files) => {
      files.delete("references/neutral.png")
      files.set(referencePath, baseline)
    },
  })
  const normalizedRgbaInspector: MediaInspectorService = {
    inspect: (snapshot) => Effect.try({
      try: () => {
        const parsed = JSON.parse(Buffer.from(snapshot.bytes).toString("utf8")) as Record<string, unknown>
        if (
          !Number.isSafeInteger(parsed.width) || Number(parsed.width) < 1 ||
          !Number.isSafeInteger(parsed.height) || Number(parsed.height) < 1 ||
          !Array.isArray(parsed.pixels) ||
          parsed.pixels.length !== Number(parsed.width) * Number(parsed.height) * 4 ||
          parsed.pixels.some((channel) =>
            typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)
        ) throw new Error("invalid normalized RGBA")
        return {
          kind: "image" as const,
          mediaType: "application/vnd.qwen.rgba+json" as const,
          width: Number(parsed.width),
          height: Number(parsed.height),
        }
      },
      catch: () => new MediaInspectionError("MALFORMED_MEDIA"),
    }),
  }
  const plannedDecision = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, normalizedRgbaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  assert.equal(plannedDecision._tag, "Planned")
  if (plannedDecision._tag !== "Planned") return
  const plannedRun = plannedDecision.run
  const request = plannedRun.request
  const canonicalRequest = plannedRun.canonicalRequest
  assert.strictEqual(plannedRun, plannedDecision.run)
  assert.equal(plannedRun.request.references[0]?.applicationPath, referencePath)
  assert.equal(plannedRun.request.references[0]?.sha256, hash(baseline))

  const providerBody = Buffer.from('{"request_id":"fake-qwen-1","status":"succeeded"}', "utf8")
  let adapterCalls = 0
  const adapter: GenerationAdapterService = {
    invoke: (prepared) => Effect.sync(() => {
      adapterCalls += 1
      assert.strictEqual(prepared.request, plannedRun.request)
      const destination = (
        prepared.payload.input_references as ReadonlyArray<{
          image_url: { url: { applicationPath: string; bytesBase64: string; mediaType: string; sha256: string } }
        }>
      )[0]!.image_url.url
      assert.equal(destination.applicationPath, referencePath)
      assert.equal(destination.sha256, hash(baseline))
      assert.equal(destination.mediaType, "application/vnd.qwen.rgba+json")
      assert.deepEqual(Buffer.from(destination.bytesBase64, "base64"), Buffer.from(baseline))
      return {
        provider: "openrouter" as const,
        model: prepared.request.model,
        providerEvidence: {
          mediaType: "application/json" as const,
          body: providerBody,
          sha256: hash(providerBody),
        },
        outputs: [{
          applicationPath: "outputs/fake-donor.rgba.json" as const,
          mediaType: "application/vnd.qwen.rgba+json" as const,
          body: donor,
          sha256: hash(donor),
        }],
      }
    }),
    recover: () => Effect.die("normal path must not recover"),
  }
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock: RunRecordClockService = {
    now: () => Effect.succeed("2026-08-30T15:00:00.000Z"),
  }
  const executeAdvance = (selectedDonorSha256?: string) => Effect.runPromise(
    advance({ run: plannedRun, ...(selectedDonorSha256 === undefined ? {} : { selectedDonorSha256 }) }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(GenerationAdapter, adapter),
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )

  const checkpoint = await executeAdvance(hash(donor))
  assert.equal(checkpoint._tag, "HumanDecisionRequired")
  if (checkpoint._tag !== "HumanDecisionRequired") return
  assert.equal(adapterCalls, 1)
  assert.equal(checkpoint.diagnostics.view.phase, "awaiting_donor_choice")
  assert.equal(checkpoint.diagnostics.view.classification, undefined)
  assert.equal(Buffer.from(checkpoint.diagnostics.request).toString("utf8"), canonicalRequest)
  assert.match(Buffer.from(checkpoint.diagnostics.events).toString("utf8"), /donor_choice_opened/)
  assert.deepEqual(checkpoint.decision.candidateSha256s, [hash(donor)])
  assert.equal(checkpoint.normalView.objective, request.objective)
  assert.match(checkpoint.normalView.humanDecision, /choose.*donor/i)

  const completed = await executeAdvance(hash(donor))
  assert.equal(completed._tag, "VerifiedCandidate")
  if (completed._tag !== "VerifiedCandidate") return
  assert.equal(adapterCalls, 1)
  assert.equal(completed.runId, checkpoint.runId)
  assert.equal(completed.diagnostics.view.runId, checkpoint.diagnostics.view.runId)
  assert.equal(completed.diagnostics.view.selectedDonorSha256, hash(donor))
  assert.equal(completed.diagnostics.view.phase, "verified_candidate")
  assert.equal(completed.diagnostics.view.classification, "verified_candidate")
  assert.equal(completed.normalView.objective, request.objective)
  assert.notEqual(completed.candidate.sha256, hash(donor))
  assert.deepEqual(
    completed.diagnostics.view.evidence.map((item) => item.applicationPath),
    [
      "provider-response.json",
      "outputs/fake-donor.rgba.json",
      "outputs/assembled.rgba.json",
      "assembly-report.json",
      "inputs/baseline-reference",
      "checks.json",
    ],
  )
  const assembledBytes = await Effect.runPromise(
    readEvidence(completed.runId, "outputs/assembled.rgba.json").pipe(Effect.provide(memory.layer)),
  )
  assert.deepEqual(JSON.parse(Buffer.from(assembledBytes).toString("utf8")), {
    height: 2,
    pixels: [
      10, 10, 10, 255, 5, 6, 7, 255,
      30, 30, 30, 255, 60, 60, 60, 255,
    ],
    width: 2,
  })
  const checksBytes = await Effect.runPromise(
    readEvidence(completed.runId, "checks.json").pipe(Effect.provide(memory.layer)),
  )
  assert.deepEqual(JSON.parse(Buffer.from(checksBytes).toString("utf8")), {
    algorithm: "rgba-fidelity-v1",
    candidateSha256: completed.candidate.sha256,
    checks: [
      { measured: 0, name: "integrity", passed: true },
      { measured: 0, name: "media", passed: true },
      { measured: 0, name: "outside-region-preservation", passed: true },
      { measured: 0, name: "donor-equality-inside-region", passed: true },
    ],
    classification: "verified-candidate",
    inputs: {
      baselineSha256: hash(baseline),
      candidateSha256: completed.candidate.sha256,
      donorSha256: hash(donor),
      exactCopySha256: hash(JSON.stringify([hash(JSON.stringify(exactCopyCore))])),
      regionSha256: hash(JSON.stringify({ x: 1, y: 0, width: 1, height: 2 })),
    },
  })
  assert.match(completed.normalView.evidence, /Assembly.*checks/i)
  assert.match(completed.normalView.humanDecision, /visual approval/i)

  const locked = request.references[0]!
  const prepared = await Effect.runPromise(prepare(request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: locked.mediaType,
    bytes: baseline,
  }]))
  for (const persistOutput of [false, true]) {
    const recoveryMemory = await Effect.runPromise(makeMemoryRunRecordHarness())
    const reserved = await Effect.runPromise(reserve({ plannedRun, payloadSha256: prepared.payloadSha256 }).pipe(
      Effect.provide(recoveryMemory.layer),
      Effect.provideService(RunRecordClock, clock),
    ))
    const marked = await Effect.runPromise(record({
      _tag: "SubmissionMayHaveStarted",
      runId: reserved.runId,
      operationId: "recovery-submit",
    }).pipe(Effect.provide(recoveryMemory.layer), Effect.provideService(RunRecordClock, clock)))
    assert.equal(marked._tag, "SubmissionPermitIssued")
    if (marked._tag !== "SubmissionPermitIssued") continue
    const generated = await Effect.runPromise(invoke(prepared, marked.permit).pipe(
      Effect.provideService(GenerationAdapter, adapter),
    ))
    await Effect.runPromise(record({
      _tag: "CommitProviderEvidence",
      runId: reserved.runId,
      operationId: "conductor-provider-evidence",
      evidence: generated.providerEvidence,
    }).pipe(Effect.provide(recoveryMemory.layer), Effect.provideService(RunRecordClock, clock)))
    if (persistOutput) {
      await Effect.runPromise(record({
        _tag: "CommitGeneratedOutput",
        runId: reserved.runId,
        operationId: "conductor-generated-output-1",
        output: {
          ...generated.outputs[0]!,
          applicationPath: generated.outputs[0]!.applicationPath as `outputs/${string}`,
        },
      }).pipe(Effect.provide(recoveryMemory.layer), Effect.provideService(RunRecordClock, clock)))
    }
    let recoveryCalls = 0
    const recoveryAdapter: GenerationAdapterService = {
      invoke: () => Effect.die("recovery must not resubmit"),
      recover: (_prepared, evidence) => Effect.sync(() => {
        recoveryCalls += 1
        assert.equal(evidence.sha256, generated.providerEvidence.sha256)
        return generated as GenerationResult
      }),
    }
    const resumed = await Effect.runPromise(advance({ run: plannedRun }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(GenerationAdapter, recoveryAdapter),
      Effect.provide(recoveryMemory.layer),
      Effect.provideService(RunRecordClock, clock),
    ))
    assert.equal(resumed._tag, "HumanDecisionRequired")
    assert.equal(recoveryCalls, 1)
  }
})

test("advances one Seedance Run by submitting once and polling the same job to verified video", async () => {
  const fixture = makeFixture("seedance-video")
  const plannedDecision = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  assert.equal(plannedDecision._tag, "Planned")
  if (plannedDecision._tag !== "Planned") return
  const videoBody = (await Effect.runPromise(fixture.files.read("references/neutral.mp4"))).bytes
  const submissionBody = Buffer.from('{"job_id":"seedance-job-1","status":"submitted"}')
  const pendingBody = Buffer.from('{"job_id":"seedance-job-1","status":"pending"}')
  const completedBody = Buffer.from(JSON.stringify({
    job_id: "seedance-job-1",
    status: "completed",
    outputs: [{
      application_path: "outputs/seedance-result.mp4",
      media_type: "video/mp4",
      sha256: hash(videoBody),
    }],
    completed_count: 1,
    cost: { state: "estimated-only" },
  }))
  let submitCalls = 0
  let pollCalls = 0
  const adapter: GenerationAdapterService = {
    invoke: () => Effect.die("Qwen Generation must not run for Seedance"),
    submitSeedance: (prepared) => Effect.sync(() => {
      submitCalls += 1
      const destination = (
        prepared.payload.input_references as ReadonlyArray<{
          video_url: { url: { applicationPath: string; bytesBase64: string; mediaType: string; sha256: string } }
        }>
      )[0]!.video_url.url
      assert.equal(destination.applicationPath, "references/neutral.mp4")
      assert.equal(destination.sha256, hash(videoBody))
      assert.equal(destination.mediaType, "video/mp4")
      assert.deepEqual(Buffer.from(destination.bytesBase64, "base64"), Buffer.from(videoBody))
      return {
        provider: "openrouter" as const,
        model: prepared.request.model,
        jobId: "seedance-job-1",
        providerEvidence: {
          mediaType: "application/json" as const,
          body: submissionBody,
          sha256: hash(submissionBody),
        },
      }
    }),
    pollSeedance: (prepared, jobId, evidence) => Effect.sync(() => {
      pollCalls += 1
      assert.equal(jobId, "seedance-job-1")
      assert.equal(evidence.sha256, hash(submissionBody))
      if (pollCalls === 1) {
        return {
          status: "pending" as const,
          provider: "openrouter" as const,
          model: prepared.request.model,
          jobId,
          providerEvidence: {
            mediaType: "application/json" as const,
            body: pendingBody,
            sha256: hash(pendingBody),
          },
        }
      }
      return {
        status: "completed" as const,
        provider: "openrouter" as const,
        model: prepared.request.model,
        jobId,
        providerEvidence: {
          mediaType: "application/json" as const,
          body: completedBody,
          sha256: hash(completedBody),
        },
        outputs: [{
          applicationPath: "outputs/seedance-result.mp4" as const,
          mediaType: "video/mp4" as const,
          body: videoBody,
          sha256: hash(videoBody),
        }],
        completedCount: 1,
        cost: { state: "estimated-only" as const },
      }
    }),
  }
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock: RunRecordClockService = {
    now: () => Effect.succeed("2026-08-30T16:00:00.000Z"),
  }
  const executeAdvance = () => Effect.runPromise(
    advance({ run: plannedDecision.run }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(GenerationAdapter, adapter),
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )

  const submitted = await executeAdvance()
  assert.equal(submitted._tag, "ProviderPending")
  if (submitted._tag !== "ProviderPending") return
  assert.equal(submitted.jobId, "seedance-job-1")
  assert.equal(submitted.pollCount, 0)
  assert.equal(submitCalls, 1)
  assert.equal(pollCalls, 0)

  const pending = await executeAdvance()
  assert.equal(pending._tag, "ProviderPending")
  if (pending._tag !== "ProviderPending") return
  assert.equal(pending.runId, submitted.runId)
  assert.equal(pending.jobId, submitted.jobId)
  assert.equal(pending.pollCount, 1)
  assert.equal(submitCalls, 1)
  assert.equal(pollCalls, 1)

  const completed = await executeAdvance()
  assert.equal(completed._tag, "VerifiedCandidate")
  if (completed._tag !== "VerifiedCandidate") return
  assert.equal(completed.runId, submitted.runId)
  assert.equal(completed.candidate.applicationPath, "outputs/seedance-result.mp4")
  assert.equal(completed.candidate.mediaType, "video/mp4")
  assert.equal(completed.candidate.sha256, hash(videoBody))
  assert.equal(completed.diagnostics.view.providerJobId, "seedance-job-1")
  assert.equal(completed.diagnostics.view.pollCount, 2)
  assert.equal(completed.diagnostics.view.completedCount, 1)
  assert.equal(completed.diagnostics.view.costState, "estimated-only")
  assert.equal(plannedDecision.run.request.videoPlan?.assembly.pixelOwnership, "none-authoritative")
  assert.equal("assemblyPlan" in plannedDecision.run.request, false)
  assert.equal(submitCalls, 1)
  assert.equal(pollCalls, 2)
  assert.match(completed.normalView.evidence, /video.*checks/i)
})
