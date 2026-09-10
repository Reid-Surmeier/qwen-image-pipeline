import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { Effect } from "effect"
import { advance, plan, ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector, filePlanningIdentity } from "./index.js"
import { GenerationAdapter, GenerationError } from "../generation/index.js"
import { RunRecordClock, makeMemoryRunRecordHarness, materializeMuseImage } from "../run-record/index.js"
import { makeFixture, sha256 } from "../../tests/control-plane-fixture.js"

for (const scenario of ["normal", "interrupted", "ambiguous", "mismatched-native"] as const) test(`Muse text generation: ${scenario}`, async () => {
  const identity = await Effect.runPromise(filePlanningIdentity(join(process.cwd(), "tests/fixtures/tool-artifacts/muse-v3")))
  const fixture = makeFixture("qwen-image", {
    toolLock: lock => Object.assign(lock, identity.installedTool),
    contract: contract => {
      const procedure = (contract.procedures as Array<Record<string, unknown>>)[0]!
      Object.assign(procedure, { mode: "muse-image", model: "meta/muse-image", parameters: { size: "1760x1440" }, referenceRequirements: [], maximumCount: 1, unitCostUsd: "0.01" })
    },
    objective: objective => { delete objective.assemblyPlan; objective.references = []; objective.summary = "A brass listening device.\n" },
  })
  const planned = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files), Effect.provideService(MediaInspector, byteMediaInspector), Effect.provideService(PlanningIdentity, identity),
  ))
  assert.equal(planned._tag, "Planned", JSON.stringify(planned))
  if (planned._tag !== "Planned") return
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  let calls = 0
  const body = Buffer.from(JSON.stringify({height:1,pixels:scenario === "mismatched-native" ? [99,99,99,255] : [12,34,56,255],width:1}))
  const native = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQkTIUp/+BiOh/AAA=", "base64")
  const receipt = Buffer.from(JSON.stringify({id: null, status: "completed", completed_count: 1, cost: { state: "actual", actual_cost_usd: "0.010000" }, source_images: [{media_type:"image/webp",sha256:sha256(native),body_base64:native.toString("base64"),normalized_sha256:sha256(body)}]}))
  if (scenario === "interrupted") await Effect.runPromise(memory.failAfter("write-evidence", 1, 2))
  let recoveryCalls = 0
  const result = { provider: "openrouter" as const, model: "meta/muse-image", providerEvidence: {mediaType:"application/json" as const, body:receipt,sha256:sha256(receipt)}, outputs:[{applicationPath:"outputs/donor-01.rgba.json",mediaType:"application/vnd.qwen.rgba+json" as const,body,sha256:sha256(body)}] }
  const execute = () => Effect.runPromise(advance({ run: planned.run }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files), Effect.provideService(PlanningIdentity, identity),
    Effect.provideService(GenerationAdapter, {
      recover: (_prepared, evidence) => Effect.sync(() => { recoveryCalls++; assert.equal(evidence.sha256,sha256(receipt)); return result }),
      invoke: prepared => Effect.gen(function*() {
        calls++
        assert.equal(prepared.request.objective, "A brass listening device.\n")
        if (scenario === "ambiguous") return yield* Effect.fail(new GenerationError("PROVIDER_AMBIGUOUS", "captured timeout"))
        return result
      }),
    }), Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, { now: () => Effect.succeed("2026-09-09T19:00:00.000Z") }),
  ))
  let first = await execute()
  if (scenario === "ambiguous") {
    assert.notEqual(first._tag, "HumanDecisionRequired")
    await execute(); assert.equal(calls,1); return
  }
  if (scenario === "interrupted") {
    assert.equal(first._tag,"PersistenceInterrupted",JSON.stringify(first))
    first = await execute(); assert.equal(recoveryCalls,1)
  }
  assert.equal(first._tag, "HumanDecisionRequired", JSON.stringify(first))
  if (first._tag !== "HumanDecisionRequired") return
  // The baseline forbids Python descendants; the same unpaid native decoder check runs in the focused suite.
  if (process.env.QWEN_BASELINE_OFFLINE !== "1") {
  if (scenario === "mismatched-native") {
    const error = await Effect.runPromise(Effect.flip(materializeMuseImage(first.runId).pipe(Effect.provide(memory.layer))))
    assert.equal(error.code,"EVIDENCE_HASH_MISMATCH"); return
  }
  const materialized = await Effect.runPromise(materializeMuseImage(first.runId).pipe(Effect.provide(memory.layer)))
  assert.equal(materialized.applicationPath, "materialized/image-01.webp")
  assert.equal(materialized.sha256, sha256(native))
  assert.deepEqual(await Effect.runPromise(materializeMuseImage(first.runId).pipe(Effect.provide(memory.layer))), materialized)
  }
  const second = await execute()
  assert.equal(second._tag, "HumanDecisionRequired")
  assert.equal(calls, 1)
  if (first._tag !== "HumanDecisionRequired") return
  assert.equal(first.diagnostics.view.actualCostUsd, "0.010000")
  assert.match(first.normalView.nextAction, /inspect/i)
})
