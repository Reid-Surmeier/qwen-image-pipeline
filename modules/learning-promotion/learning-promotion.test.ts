import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { openLearningDecision, promoteLearning, type CompletedLearningEvidence } from "./index.js"

const sha = (digit: string): string => digit.repeat(64)

const completeEvidence = (): CompletedLearningEvidence => ({
  runId: "run-a",
  requestSha256: sha("1"),
  candidate: { applicationPath: "outputs/candidate.rgba.json", sha256: sha("2") },
  provenance: {
    provider: "openrouter",
    model: "qwen/qwen-image-edit",
    providerReceiptSha256: sha("3"),
  },
  supportingEvidence: [{ applicationPath: "checks/verification.json", sha256: sha("4") }],
  knownBadCases: [{
    name: "outside-region drift",
    mutationSha256: sha("5"),
    caught: true,
    caughtBy: "Verification",
    evidenceSha256: sha("6"),
    findingCode: "OUTSIDE_REGION_CHANGED",
  }],
  proposedRule: "Reject any candidate that changes pixels outside the owned region.",
  scope: "normalized RGBA assembly candidates",
  affectedSeam: "Verification.verify",
  compatibilityRisk: "Previously accepted candidates with unowned drift will fail.",
  excludedApplicationDetail: "No application names, prompts, art, or paths are generalized.",
})

test("refuses a pretty candidate without provenance, positive evidence, or an independently caught known-bad case", async () => {
  for (const evidence of [
    { ...completeEvidence(), provenance: { ...completeEvidence().provenance, model: "" } },
    { ...completeEvidence(), supportingEvidence: [] },
    { ...completeEvidence(), knownBadCases: [{ ...completeEvidence().knownBadCases[0]!, caught: false }] },
  ]) {
    await assert.rejects(
      Effect.runPromise(promoteLearning(evidence)),
      (error: unknown) => error instanceof Error && "code" in error,
    )
  }
})

test("creates a complete immutable proposal and only a review decision draft", async () => {
  const proposal = await Effect.runPromise(promoteLearning(completeEvidence()))
  assert.equal(proposal.state, "proposed")
  assert.equal(proposal.supportingEvidence.length, 1)
  assert.equal(proposal.counterevidence.length, 1)
  assert.equal(proposal.counterevidence[0]!.caughtBy, "Verification")
  assert.equal(proposal.scope, completeEvidence().scope)
  assert.equal(proposal.affectedSeam, completeEvidence().affectedSeam)
  assert.equal(proposal.compatibilityRisk, completeEvidence().compatibilityRisk)
  assert.equal(proposal.excludedApplicationDetail, completeEvidence().excludedApplicationDetail)
  assert.match(proposal.proposalSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(proposal), true)

  const decision = await Effect.runPromise(openLearningDecision(proposal, "a".repeat(40)))
  assert.deepEqual(decision.prohibitedMutations, ["Procedure", "interface", "errors", "tests", "application-lock"])
  assert.equal(decision.permittedAction, "review-proposal")
  assert.equal("write" in decision, false)
  assert.equal("approval" in decision, false)
})
