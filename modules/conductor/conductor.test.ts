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
  type GenerationAdapterService,
} from "../generation/index.js"
import type { PlannedRun } from "../run-contract/index.js"
import {
  RunRecordClock,
  makeMemoryRunRecordHarness,
  readEvidence,
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

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

test("advances one Qwen Assembly Run through a genuine donor choice to verified evidence", async () => {
  const baseline = rgba([
    10, 10, 10, 255, 20, 20, 20, 255,
    30, 30, 30, 255, 40, 40, 40, 255,
  ])
  const donor = rgba([
    90, 90, 90, 255, 80, 80, 80, 255,
    70, 70, 70, 255, 60, 60, 60, 255,
  ])
  const exactCopyCore = { x: 1, y: 0, rgba: [80, 80, 80, 255] as const }
  const fixture = makeFixture("qwen-image")
  const plannedDecision = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  assert.equal(plannedDecision._tag, "Planned")
  if (plannedDecision._tag !== "Planned") return
  const request = {
    ...plannedDecision.run.request,
    assemblyPlan: {
      required: true as const,
      baselineReferenceSlot: "source",
      ownedRegion: { x: 1, y: 0, width: 1, height: 2 },
      exactCopy: [{
        ...exactCopyCore,
        sha256: hash(JSON.stringify(exactCopyCore)),
      }],
    },
    references: plannedDecision.run.request.references.map((reference) => ({
      ...reference,
      sha256: hash(baseline),
      byteLength: baseline.byteLength,
      inspectedMedia: { width: 2, height: 2 },
    })),
  }
  const canonicalRequest = canonical(request)
  const plannedRun: PlannedRun = {
    state: "planned",
    request,
    canonicalRequest,
    requestSha256: hash(canonicalRequest),
  }
  const applicationFiles = {
    read: (applicationPath: string) => applicationPath === "references/neutral.png"
      ? Effect.succeed({ applicationPath, bytes: baseline })
      : fixture.files.read(applicationPath),
  }

  const providerBody = Buffer.from('{"request_id":"fake-qwen-1","status":"succeeded"}', "utf8")
  let adapterCalls = 0
  const adapter: GenerationAdapterService = {
    invoke: (prepared) => Effect.sync(() => {
      adapterCalls += 1
      const destination = (
        prepared.payload.input_references as ReadonlyArray<{
          image_url: { url: { applicationPath: string; bytesBase64: string; sha256: string } }
        }>
      )[0]!.image_url.url
      assert.equal(destination.applicationPath, "references/neutral.png")
      assert.equal(destination.sha256, hash(baseline))
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
  }
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock: RunRecordClockService = {
    now: () => Effect.succeed("2026-08-30T15:00:00.000Z"),
  }
  const executeAdvance = (selectedDonorSha256?: string) => Effect.runPromise(
    advance({ run: plannedRun, ...(selectedDonorSha256 === undefined ? {} : { selectedDonorSha256 }) }).pipe(
      Effect.provideService(ApplicationFiles, applicationFiles),
      Effect.provideService(GenerationAdapter, adapter),
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, clock),
    ),
  )

  const checkpoint = await executeAdvance()
  assert.equal(checkpoint._tag, "HumanDecisionRequired")
  if (checkpoint._tag !== "HumanDecisionRequired") return
  assert.equal(adapterCalls, 1)
  assert.equal(checkpoint.diagnostics.phase, "awaiting_donor_choice")
  assert.equal(checkpoint.diagnostics.classification, undefined)
  assert.deepEqual(checkpoint.decision.candidateSha256s, [hash(donor)])
  assert.match(checkpoint.normalView.humanDecision, /choose.*donor/i)

  const completed = await executeAdvance(hash(donor))
  assert.equal(completed._tag, "VerifiedCandidate")
  if (completed._tag !== "VerifiedCandidate") return
  assert.equal(adapterCalls, 1)
  assert.equal(completed.runId, checkpoint.runId)
  assert.equal(completed.diagnostics.runId, checkpoint.diagnostics.runId)
  assert.equal(completed.diagnostics.selectedDonorSha256, hash(donor))
  assert.equal(completed.diagnostics.phase, "verified_candidate")
  assert.equal(completed.diagnostics.classification, "verified_candidate")
  assert.notEqual(completed.candidate.sha256, hash(donor))
  assert.deepEqual(
    completed.diagnostics.evidence.map((item) => item.applicationPath),
    [
      "provider-response.json",
      "outputs/fake-donor.rgba.json",
      "outputs/assembled.rgba.json",
      "assembly-report.json",
      "checks.json",
    ],
  )
  const assembledBytes = await Effect.runPromise(
    readEvidence(completed.runId, "outputs/assembled.rgba.json").pipe(Effect.provide(memory.layer)),
  )
  assert.deepEqual(JSON.parse(Buffer.from(assembledBytes).toString("utf8")), {
    height: 2,
    pixels: [
      10, 10, 10, 255, 80, 80, 80, 255,
      30, 30, 30, 255, 60, 60, 60, 255,
    ],
    width: 2,
  })
  const checksBytes = await Effect.runPromise(
    readEvidence(completed.runId, "checks.json").pipe(Effect.provide(memory.layer)),
  )
  assert.deepEqual(JSON.parse(Buffer.from(checksBytes).toString("utf8")), {
    candidateSha256: completed.candidate.sha256,
    checks: [
      { measured: 0, name: "integrity", passed: true },
      { measured: 0, name: "media", passed: true },
      { measured: 0, name: "outside-region-preservation", passed: true },
      { measured: 0, name: "donor-equality-inside-region", passed: true },
    ],
    classification: "verified-candidate",
  })
  assert.match(completed.normalView.evidence, /Assembly.*checks/i)
  assert.match(completed.normalView.humanDecision, /visual approval/i)
})
