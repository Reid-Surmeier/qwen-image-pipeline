import assert from "node:assert/strict"
import test from "node:test"

import { createHash } from "node:crypto"
import { Effect } from "effect"

import {
  orderedVerification,
  type VerificationInput,
} from "./index.js"
import { createMemoryRunRecordStore } from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  plan,
} from "../conductor/index.js"
import type { AssemblyOutput } from "../assembly/index.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

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

test("verifies valid run and produces verified_candidate outcome", async () => {
  const planned = await getPlannedRun("qwen-image")
  const store = createMemoryRunRecordStore()
  const state = await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const outputBytes = Buffer.from("OUTPUT_BYTES")
  const outputFiles = [
    {
      name: "output-01.png",
      bytes: new Uint8Array(outputBytes),
      sha256: sha256(outputBytes),
      mediaType: "image/png",
    },
  ]

  const input: VerificationInput = {
    state,
    outputFiles,
  }

  const report = await Effect.runPromise(orderedVerification.verify(input))
  assert.equal(report.outcome, "verified_candidate")
  assert.equal(report.passed, true)
  assert.equal(report.stages.length >= 4, true)
  assert.equal(report.stages.every((s) => s.passed), true)
})

test("verifies assembled run and catches outside-region drift", async () => {
  const planned = await getPlannedRun("qwen-image")
  const store = createMemoryRunRecordStore()
  const state = await Effect.runPromise(store.initRun("run-001", planned, "generated/runs/run-001"))

  const outputBytes = Buffer.from("OUTPUT_BYTES")
  const outputFiles = [
    {
      name: "output-01.png",
      bytes: new Uint8Array(outputBytes),
      sha256: sha256(outputBytes),
      mediaType: "image/png",
    },
  ]

  const goodAssembly: AssemblyOutput = {
    name: "assembled.png",
    bytes: new Uint8Array(outputBytes),
    sha256: sha256(outputBytes),
    byteLength: outputBytes.byteLength,
    mediaType: "image/png",
    outsideRegionHashMatches: true,
    insideRegionDonorMatches: true,
  }

  const goodReport = await Effect.runPromise(
    orderedVerification.verify({ state, outputFiles, assemblyOutput: goodAssembly }),
  )
  assert.equal(goodReport.outcome, "verified_candidate")

  // Bad assembly with outside drift
  const badAssembly: AssemblyOutput = {
    ...goodAssembly,
    outsideRegionHashMatches: false,
  }

  const badReport = await Effect.runPromise(
    orderedVerification.verify({ state, outputFiles, assemblyOutput: badAssembly }),
  )
  assert.equal(badReport.outcome, "failed")
  assert.equal(badReport.passed, false)
  assert.match(badReport.failureReason!, /unlicensed changed pixels/i)
})

test("returns human_decision_required when approval checkpoint is requested", async () => {
  const planned = await getPlannedRun("seedance-video")
  const store = createMemoryRunRecordStore()
  const state = await Effect.runPromise(store.initRun("run-002", planned, "generated/runs/run-002"))

  const outputBytes = Buffer.from("OUTPUT_VIDEO_BYTES")
  const outputFiles = [
    {
      name: "output-01.mp4",
      bytes: new Uint8Array(outputBytes),
      sha256: sha256(outputBytes),
      mediaType: "video/mp4",
    },
  ]

  const report = await Effect.runPromise(
    orderedVerification.verify({ state, outputFiles, requiresHumanApproval: true }),
  )
  assert.equal(report.outcome, "human_decision_required")
  assert.equal(report.passed, true)
  assert.ok(report.humanDecisionPrompt)
})
