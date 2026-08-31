import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PROJECT_CONTRACT_PATH,
  PlanningIdentity,
  TOOL_LOCK_PATH,
  advance,
  byteMediaInspector,
  plan,
  type AdvanceDecision,
  type PlanDecision,
} from "./index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  RunRecordStore,
  createMemoryRunRecordStore,
} from "../run-record/index.js"
import {
  GenerationAdapter,
  GenerationError,
  createFakeGenerationAdapter,
} from "../generation/index.js"
import { Assembly, deterministicAssembly } from "../assembly/index.js"
import { Verification, orderedVerification } from "../verification/index.js"

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

test("advances fake Qwen edit through attempt reservation, generation, assembly, and verification", async () => {
  const { result } = await execute("qwen-image")
  assert.equal(result._tag, "Planned")
  if (result._tag !== "Planned") return

  const fixture = makeFixture("qwen-image")
  const store = createMemoryRunRecordStore()
  const genAdapter = createFakeGenerationAdapter()

  const advanceResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-001",
      plannedRun: result.run,
      runId: "qwen-001",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(advanceResult._tag, "VerifiedCandidate")
  assert.equal(genAdapter.getInvocationCount(), 1)
  assert.ok(advanceResult.state.attempt)
  assert.ok(advanceResult.state.submissionMarker)
  assert.ok(advanceResult.state.providerEvidence)
  assert.equal(advanceResult.state.status, "verified")
  assert.ok(advanceResult.assemblyOutput)
  assert.match(advanceResult.normalView.evidence, /verified 1 output/i)
  assert.match(advanceResult.normalView.spendRisk, /money spent: \$0\.04/i)
  assert.match(advanceResult.normalView.humanDecision, /subjective final visual approval/i)
})

test("advances fake Seedance video run through attempt reservation, video generation, and verification", async () => {
  const { result } = await execute("seedance-video")
  assert.equal(result._tag, "Planned")
  if (result._tag !== "Planned") return

  const fixture = makeFixture("seedance-video")
  const store = createMemoryRunRecordStore()
  const genAdapter = createFakeGenerationAdapter()

  const advanceResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/seedance-001",
      plannedRun: result.run,
      runId: "seedance-001",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(advanceResult._tag, "VerifiedCandidate")
  assert.equal(genAdapter.getInvocationCount(), 1)
  assert.equal(advanceResult.state.request.mode, "seedance-video")
  assert.equal(advanceResult.state.providerEvidence?.outputs[0]?.mediaType, "video/mp4")
  assert.match(advanceResult.normalView.spendRisk, /money spent: \$0\.20/i)
})

test("stops at donor choice checkpoint when multiple candidates exist and resumes with selection", async () => {
  const { result } = await execute("qwen-image", {
    objective: (o) => {
      o.requestedCount = 2
      o.budgetCeilingUsd = "0.10"
    },
  })
  assert.equal(result._tag, "Planned")
  if (result._tag !== "Planned") return

  const fixture = makeFixture("qwen-image", {
    objective: (o) => {
      o.requestedCount = 2
      o.budgetCeilingUsd = "0.10"
    },
  })
  const store = createMemoryRunRecordStore()
  const genAdapter = createFakeGenerationAdapter()

  // First advance creates outputs and checkpoints at donor selection
  const checkpointResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-multi",
      plannedRun: result.run,
      runId: "qwen-multi",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(checkpointResult._tag, "HumanDecisionRequired")
  assert.equal(genAdapter.getInvocationCount(), 1)
  assert.equal(checkpointResult.state.status, "donor_checkpoint")

  // Resuming with selected donor completes run without resubmitting to provider
  const resumeResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-multi",
      donorChoice: "output-01.png",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(resumeResult._tag, "VerifiedCandidate")
  // Invocations count did not increase (no duplicate billing)
  assert.equal(genAdapter.getInvocationCount(), 1)
})

test("replaying an already verified run does not create another provider attempt", async () => {
  const { result } = await execute("qwen-image")
  if (result._tag !== "Planned") return

  const fixture = makeFixture("qwen-image")
  const store = createMemoryRunRecordStore()
  const genAdapter = createFakeGenerationAdapter()

  await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-replay",
      plannedRun: result.run,
      runId: "qwen-replay",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )
  assert.equal(genAdapter.getInvocationCount(), 1)

  // Replay
  const replayResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-replay",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(replayResult._tag, "VerifiedCandidate")
  assert.equal(genAdapter.getInvocationCount(), 1)
})

test("records provider failure properly and produces Failed decision without retry", async () => {
  const { result } = await execute("qwen-image")
  if (result._tag !== "Planned") return

  const fixture = makeFixture("qwen-image")
  const store = createMemoryRunRecordStore()
  const genAdapter = createFakeGenerationAdapter({
    simulateError: new GenerationError("PROVIDER_HTTP_ERROR", "HTTP 400 Bad Request", 400),
  })

  const failResult = await Effect.runPromise(
    advance({
      runDirectory: "generated/runs/qwen-fail",
      plannedRun: result.run,
      runId: "qwen-fail",
    }).pipe(
      Effect.provideService(RunRecordStore, store),
      Effect.provideService(GenerationAdapter, genAdapter),
      Effect.provideService(Assembly, deterministicAssembly),
      Effect.provideService(Verification, orderedVerification),
      Effect.provideService(ApplicationFiles, fixture.files),
    ),
  )

  assert.equal(failResult._tag, "Failed")
  assert.match(failResult.failureReason, /HTTP 400/i)
  assert.match(failResult.normalView.spendRisk, /provider attempt was made/i)
  assert.equal(failResult.state.status, "failed")
})
