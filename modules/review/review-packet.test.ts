import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { prepareReviewPacket, validateReviewPacket, type ReviewPacketInput } from "./index.js"

const sha = (digit: string): string => digit.repeat(64)
const input = (): ReviewPacketInput => ({
  acceptanceContract: { applicationPath: "contracts/acceptance.md", sha256: sha("1") },
  run: {
    runId: "run-a",
    requestSha256: sha("2"),
    recordPath: "runs/run-a",
    eventHeadSha256: sha("8"),
  },
  references: [{ applicationPath: "references/source.png", sha256: sha("3") }],
  candidate: { applicationPath: "outputs/candidate.png", sha256: sha("4") },
  instructions: "Judge the exact candidate against the exact reference and acceptance contract.",
  verificationEvidence: [{ applicationPath: "checks/verification.json", sha256: sha("5") }],
  deterministicGate: "passed",
  unresolvedHumanDecisions: ["Does the candidate subjectively match the intended style?"],
})

test("deterministic failure prevents independent or paid semantic review", async () => {
  await assert.rejects(
    Effect.runPromise(prepareReviewPacket({ ...input(), deterministicGate: "failed" })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewBlocked",
  )
})

test("prepares a complete hash-locked packet with machine verification separate from Approval", async () => {
  const packet = await Effect.runPromise(prepareReviewPacket(input()))
  assert.equal(packet.machineVerification, "passed")
  assert.equal(packet.ownerApproval, "unresolved")
  assert.deepEqual(packet.normalView, {
    machineVerification: "passed",
    ownerApproval: "unresolved",
    nextAction: "independent-review",
  })
  assert.match(packet.packetSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(packet), true)
  await Effect.runPromise(validateReviewPacket(packet, {
    requestSha256: input().run.requestSha256,
    references: input().references,
    candidate: input().candidate,
  }))
})

test("a changed candidate or reference invalidates the exact review packet", async () => {
  const packet = await Effect.runPromise(prepareReviewPacket(input()))
  for (const [bindings, expectedCode] of [
    [{ requestSha256: input().run.requestSha256, references: input().references, candidate: { ...input().candidate, sha256: sha("6") } }, "CandidateIdentityChanged"],
    [{ requestSha256: input().run.requestSha256, references: [{ ...input().references[0]!, sha256: sha("7") }], candidate: input().candidate }, "ReferenceIdentityChanged"],
  ]) {
    await assert.rejects(
      Effect.runPromise(validateReviewPacket(packet, bindings as Parameters<typeof validateReviewPacket>[1])),
      (error: unknown) => error instanceof Error && "code" in error && error.code === expectedCode,
    )
  }
})

test("changed packet contents fail their own hash before review", async () => {
  const packet = await Effect.runPromise(prepareReviewPacket(input()))
  const tampered = { ...packet, instructions: "Trust the implementer instead." }
  await assert.rejects(
    Effect.runPromise(validateReviewPacket(tampered, {
      requestSha256: input().run.requestSha256,
      references: input().references,
      candidate: input().candidate,
    })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid",
  )
})
