import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  LearningPromotionError,
  standardLearningPromotion,
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

const getPlannedRun = async () => {
  const fixture = makeFixture("qwen-image")
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

test("creates learning proposal when supporting evidence and counterexample exist", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()

  // Verified state
  const verifiedState = await Effect.runPromise(
    store.initRun("run-pos", planned, "generated/runs/run-pos").pipe(
      Effect.flatMap((s) => store.recordEvent("generated/runs/run-pos", "RUN_COMPLETED", { outcome: "verified_candidate" })),
    ),
  )

  // Failed state (counterexample)
  const failedState = await Effect.runPromise(
    store.initRun("run-neg", planned, "generated/runs/run-neg").pipe(
      Effect.flatMap((s) => store.recordEvent("generated/runs/run-neg", "RUN_FAILED", { reason: "Caught regression" })),
    ),
  )

  const proposal = await Effect.runPromise(
    standardLearningPromotion.createProposal({
      title: "Require 5:4 aspect ratio preservation",
      supportingEvidence: {
        runId: "run-pos",
        runDirectory: "generated/runs/run-pos",
        runState: verifiedState,
        description: "Verified run demonstrating clean alignment",
      },
      counterexampleEvidence: {
        runId: "run-neg",
        runDirectory: "generated/runs/run-neg",
        runState: failedState,
        description: "Caught known-bad run showing aspect drift",
      },
      affectedSeam: "modules/reference-planning/index.ts",
      compatibilityRisk: "None; adds validation only",
      sanitizedSummary: "Aspect ratio mismatch is caught deterministically",
    }),
  )

  assert.equal(proposal.status, "open_for_review")
  assert.equal(proposal.canModifyLiveProcedure, false)
  assert.match(proposal.proposalId, /^proposal-[a-f0-9]+$/)
})

test("refuses learning proposal when supporting evidence is not verified", async () => {
  const planned = await getPlannedRun()
  const store = createMemoryRunRecordStore()

  // Incomplete state
  const unverifiedState = await Effect.runPromise(
    store.initRun("run-pos", planned, "generated/runs/run-pos"),
  )
  const failedState = await Effect.runPromise(
    store.initRun("run-neg", planned, "generated/runs/run-neg").pipe(
      Effect.flatMap((s) => store.recordEvent("generated/runs/run-neg", "RUN_FAILED", { reason: "Caught regression" })),
    ),
  )

  await assert.rejects(
    Effect.runPromise(
      standardLearningPromotion.createProposal({
        title: "Test proposal",
        supportingEvidence: {
          runId: "run-pos",
          runDirectory: "generated/runs/run-pos",
          runState: unverifiedState,
          description: "Unverified run",
        },
        counterexampleEvidence: {
          runId: "run-neg",
          runDirectory: "generated/runs/run-neg",
          runState: failedState,
          description: "Caught known-bad",
        },
        affectedSeam: "modules/reference-planning/index.ts",
        compatibilityRisk: "None",
        sanitizedSummary: "Summary",
      }),
    ),
    (err: unknown) => err instanceof LearningPromotionError && err.code === "MISSING_SUPPORTING_EVIDENCE",
  )
})
