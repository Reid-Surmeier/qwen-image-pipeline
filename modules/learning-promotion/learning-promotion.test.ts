import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { ApplicationFiles, ApplicationReadError, type ApplicationFilesService } from "../reference-planning/index.js"
import type { ReviewInvalidationEvidence } from "../review/index.js"
import { openLearningDecision, promoteLearning, type CompletedLearningEvidence } from "./index.js"
import { issueReferenceInvalidation } from "../../tests/review-evidence-fixture.js"

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")

const setup = async () => {
  const bodies = new Map<string, Uint8Array>([
    ["runs/run-a/request.json", Buffer.from("request")],
    ["outputs/candidate.png", Buffer.from("candidate")],
    ["provider/receipt.json", Buffer.from("receipt")],
    ["checks/verification.json", Buffer.from("checks")],
  ])
  const files: ApplicationFilesService = { read: (applicationPath) => {
    const bytes = bodies.get(applicationPath)
    return bytes === undefined
      ? Effect.fail(new ApplicationReadError("APPLICATION_PATH_MISSING", applicationPath))
      : Effect.succeed({ applicationPath, bytes: Uint8Array.from(bytes) })
  } }
  const provide = <Success, Error, Requirements>(effect: Effect.Effect<Success, Error, Requirements>) =>
    effect.pipe(Effect.provideService(ApplicationFiles, files)) as Effect.Effect<Success, Error>
  const knownBad = await issueReferenceInvalidation()
  const identity = (applicationPath: string) => ({ applicationPath, sha256: hash(bodies.get(applicationPath)!) })
  const complete = (proof: ReviewInvalidationEvidence = knownBad): CompletedLearningEvidence => ({
    runId: "run-a",
    request: identity("runs/run-a/request.json"),
    candidate: identity("outputs/candidate.png"),
    provenance: { provider: "openrouter", model: "qwen/qwen-image-edit", providerReceipt: identity("provider/receipt.json") },
    supportingEvidence: [identity("checks/verification.json")],
    knownBadCases: [proof],
    proposedRule: "Reject any candidate that changes pixels outside the owned region.",
    scope: "normalized RGBA assembly candidates",
    affectedSeam: "Verification.verify",
    compatibilityRisk: "Previously accepted candidates with unowned drift will fail.",
    excludedApplicationDetail: "No application names, prompts, art, or paths are generalized.",
  })
  return { complete, knownBad, provide }
}

test("refuses a pretty candidate without provenance, positive evidence, or independently issued counterevidence", async () => {
  const fixture = await setup()
  const fakeProof = { ...fixture.knownBad }
  for (const evidence of [
    { ...fixture.complete(), provenance: { ...fixture.complete().provenance, model: "" } },
    { ...fixture.complete(), supportingEvidence: [] },
    { ...fixture.complete(), knownBadCases: [fakeProof] },
  ]) {
    await assert.rejects(Effect.runPromise(fixture.provide(promoteLearning(evidence))),
      (error: unknown) => error instanceof Error && "code" in error)
  }
})

test("creates one complete immutable proposal and only that issued proposal can open review", async () => {
  const fixture = await setup()
  const proposal = await Effect.runPromise(fixture.provide(promoteLearning(fixture.complete())))
  assert.equal(proposal.counterevidence[0]!.caughtBy, "Review")
  assert.equal(proposal.scope, fixture.complete().scope)
  assert.match(proposal.proposalSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(proposal), true)
  const decision = await Effect.runPromise(openLearningDecision(proposal, "a".repeat(40)))
  assert.deepEqual(decision.prohibitedMutations, ["Procedure", "interface", "errors", "tests", "application-lock"])
  assert.equal(decision.permittedAction, "review-proposal")
  await assert.rejects(Effect.runPromise(openLearningDecision({ ...proposal }, "a".repeat(40))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "LEARNING_PROPOSAL_INVALID")
})
