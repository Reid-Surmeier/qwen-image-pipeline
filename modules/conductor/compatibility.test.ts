import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  compatibilityAdvance,
  compatibilityPlan,
  plan,
} from "./index.js"
import { GenerationAdapter, type GenerationAdapterService } from "../generation/index.js"
import { RunRecordClock, makeMemoryRunRecordHarness } from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"

test("additive compatibility planning emits immutable deprecation metadata and delegates to Conductor.plan", async () => {
  const fixture = makeFixture("qwen-image")
  const command = { objectivePath: fixture.objectivePath }

  const compatibility = await Effect.runPromise(
    compatibilityPlan("python-cli.generate", command).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  const direct = await Effect.runPromise(
    plan(command).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )

  assert.deepEqual(compatibility.decision, direct)
  assert.deepEqual(compatibility.compatibility, {
    schemaVersion: "1",
    adapterProtocolVersion: "1",
    status: "deprecated",
    surface: "python-cli.generate",
    replacement: "Conductor.plan",
    retirementCondition: "Issue #30 may remove the deprecated command after saved-input callers adopt Conductor plan and advance.",
  })
  assert.equal(Object.isFrozen(compatibility), true)
  assert.equal(Object.isFrozen(compatibility.compatibility), true)
})

test("additive compatibility execution delegates to Conductor.advance without another writer or state machine", async () => {
  let files: Map<string, Uint8Array> | undefined
  const fixture = makeFixture("seedance-video", { files: (values) => { files = values } })
  const planned = await Effect.runPromise(
    plan({ objectivePath: fixture.objectivePath }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  assert.equal(planned._tag, "Planned")
  if (planned._tag !== "Planned") return
  files!.delete("references/neutral.mp4")

  let adapterCalls = 0
  const adapter = {
    invoke: () => Effect.sync(() => { adapterCalls += 1; throw new Error("tripwire") }),
    submitSeedance: () => Effect.sync(() => { adapterCalls += 1; throw new Error("tripwire") }),
    recover: () => Effect.die("reference refusal must not recover"),
  } as GenerationAdapterService
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const compatibility = await Effect.runPromise(
    compatibilityAdvance("comfyui.QwenImage3Render", { run: planned.run }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(PlanningIdentity, fixture.identity),
      Effect.provideService(GenerationAdapter, adapter),
      Effect.provide(memory.layer),
      Effect.provideService(RunRecordClock, { now: () => Effect.succeed("2026-08-31T12:00:00.000Z") }),
    ),
  )

  assert.equal(compatibility.decision._tag, "AdvanceRefused")
  assert.equal(compatibility.compatibility.replacement, "Conductor.advance")
  assert.equal(compatibility.compatibility.status, "deprecated")
  assert.equal(adapterCalls, 0)
})
