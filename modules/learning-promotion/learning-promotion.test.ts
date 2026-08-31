import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import type { ReviewInvalidationEvidence } from "../review/index.js"
import { issueReferenceInvalidation } from "../../tests/review-evidence-fixture.js"
import { openLearningDecision, promoteLearning, type CompletedLearningEvidence } from "./index.js"

const setup = async () => {
  const issued = await issueReferenceInvalidation()
  const diagnostics = issued.fixture.completed.diagnostics
  const providerReceipt = [...diagnostics.view.evidence].reverse().find((item) => item.applicationPath.startsWith("polls/"))!
  const checks = diagnostics.view.evidence.find((item) => item.sha256 === diagnostics.view.checksSha256)!
  const complete = (proof: ReviewInvalidationEvidence = issued.evidence): CompletedLearningEvidence => ({
    runId: issued.fixture.completed.runId,
    candidate: {
      applicationPath: issued.fixture.completed.candidate.applicationPath,
      sha256: issued.fixture.completed.candidate.sha256,
    },
    provenance: { providerReceipt: { applicationPath: providerReceipt.applicationPath, sha256: providerReceipt.sha256 } },
    supportingEvidence: [{ applicationPath: checks.applicationPath, sha256: checks.sha256 }],
    knownBadCases: [proof],
    proposedRule: issued.evidence.supportedRule,
    scope: "hash-locked application review packets",
    affectedSeam: issued.evidence.affectedSeam,
    compatibilityRisk: "Review packets with changed reference bytes will be invalidated.",
    excludedApplicationDetail: "No application names, prompts, art, or paths are generalized.",
  })
  return { ...issued, complete }
}

test("refuses evidence that is not one replay-authenticated Run or whose known-bad misses the proposed rule", async (t) => {
  const fixture = await setup()
  t.after(fixture.fixture.cleanup)
  const fakeProof = { ...fixture.evidence }
  for (const evidence of [
    { ...fixture.complete(), provenance: { providerReceipt: { applicationPath: "provider/unrelated.json", sha256: "1".repeat(64) } } },
    { ...fixture.complete(), supportingEvidence: [] },
    { ...fixture.complete(), knownBadCases: [fakeProof] },
    { ...fixture.complete(), proposedRule: "An unrelated proposed rule." },
  ]) {
    await assert.rejects(Effect.runPromise(fixture.fixture.provide(promoteLearning(evidence))),
      (error: unknown) => error instanceof Error && "code" in error)
  }
})

test("creates one complete Run-authenticated proposal and only that issued proposal can open review", async (t) => {
  const fixture = await setup()
  t.after(fixture.fixture.cleanup)
  const proposal = await Effect.runPromise(fixture.fixture.provide(promoteLearning(fixture.complete())))
  assert.equal(proposal.counterevidence[0]!.caughtBy, "Review")
  assert.equal(proposal.counterevidence[0]!.sourceRunId, proposal.sourceRunId)
  assert.equal(proposal.scope, fixture.complete().scope)
  assert.equal(proposal.provenance.provider, "openrouter")
  assert.equal(proposal.provenance.model, fixture.fixture.planned.run.request.model)
  assert.equal(proposal.sourceRequest.sha256, fixture.fixture.planned.run.requestSha256)
  assert.equal(proposal.exactToolCommit, fixture.fixture.planned.run.request.tool.commit)
  assert.match(proposal.proposalSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(proposal), true)
  const decision = await Effect.runPromise(openLearningDecision(proposal))
  assert.equal(decision.exactToolCommit, fixture.fixture.planned.run.request.tool.commit)
  assert.deepEqual(decision.prohibitedMutations, ["Procedure", "interface", "errors", "tests", "application-lock"])
  assert.equal(decision.permittedAction, "review-proposal")
  await assert.rejects(Effect.runPromise(openLearningDecision({ ...proposal })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "LEARNING_PROPOSAL_INVALID")
})
