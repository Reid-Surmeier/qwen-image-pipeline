import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PROJECT_CONTRACT_PATH,
  PlanningIdentity,
  TOOL_LOCK_PATH,
  byteMediaInspector,
  plan,
  type PlanDecision,
} from "./index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"

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
