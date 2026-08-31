import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { plan, ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector } from "../conductor/index.js"
import { RunRecordClock, makeMemoryRunRecordHarness, reserve, type RunRecordClockService } from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import { learningCounterexample, makeVerifiedReviewFixture } from "../../tests/review-evidence-fixture.js"
import {
  catchReviewCounterexample,
  fileReviewApplication,
  prepareReviewPacket,
  ReviewApplication,
  validateReviewPacket,
  type ReviewPacket,
} from "./index.js"

const clock: RunRecordClockService = { now: () => Effect.succeed("2026-08-31T21:00:00.000Z") }
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}
const rehash = (packet: Omit<ReviewPacket, "packetSha256">): ReviewPacket => ({
  ...packet,
  packetSha256: createHash("sha256").update(canonical(packet)).digest("hex"),
}) as ReviewPacket

test("derives the current commit from either a linked worktree or ordinary checkout without a child process", async () => {
  const application = await Effect.runPromise(fileReviewApplication(process.cwd()))
  assert.equal(application._tag, "VerifiedReviewApplication")
})

test("a non-verified Run prevents independent or paid semantic review", async (t) => {
  const reviewFixture = await makeVerifiedReviewFixture()
  t.after(reviewFixture.cleanup)
  const fixture = makeFixture("seedance-video")
  const planned = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(planned._tag, "Planned")
  if (planned._tag !== "Planned") return
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const reserved = await Effect.runPromise(reserve({ plannedRun: planned.run, payloadSha256: planned.run.requestSha256 }).pipe(
    Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  await assert.rejects(Effect.runPromise(prepareReviewPacket({
    ...reviewFixture.input,
    runId: reserved.runId,
    candidate: { applicationPath: "outputs/missing.mp4", sha256: "1".repeat(64) },
  }).pipe(
    Effect.provideService(ReviewApplication, reviewFixture.reviewApplication),
    Effect.provide(memory.layer),
  )), (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewBlocked")
})

test("derives a complete exact packet from the Run and application repository with Approval separate", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  assert.equal(packet.machineVerification, "passed")
  assert.equal(packet.ownerApproval, "unresolved")
  assert.equal(packet.applicationCommit, fixture.currentApplicationCommit())
  assert.match(packet.toolCommit, /^[a-f0-9]{40}$/)
  assert.equal(JSON.parse(packet.run.canonicalRequest).objectiveId, "seedance-neutral-objective")
  assert.match(packet.packetSha256, /^[a-f0-9]{64}$/)
  await Effect.runPromise(fixture.provide(validateReviewPacket(packet)))
})

test("refuses a structurally similar application-revision service that did not inspect a repository", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const forged = Object.freeze({ _tag: "VerifiedReviewApplication" as const })
  await assert.rejects(Effect.runPromise(prepareReviewPacket(fixture.input).pipe(
    Effect.provideService(ReviewApplication, forged),
    Effect.provide(fixture.memory.layer),
  )), (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid")
})

test("a changed application commit invalidates without a caller-supplied revision binding", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  fixture.commitApplicationChange()
  await assert.rejects(Effect.runPromise(fixture.provide(validateReviewPacket(packet))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid")
})

test("a 40-hex ref without an existing commit object cannot brand an application revision", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  fixture.pointToMissingCommit()
  await assert.rejects(Effect.runPromise(fileReviewApplication(fixture.applicationRoot)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid")
})

test("a deliberate reference mutation issues counterevidence bound to the Run, rule, seam, and packet", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  fixture.mutateReference()
  await assert.rejects(Effect.runPromise(fixture.provide(validateReviewPacket(packet))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReferenceIdentityChanged")
  const evidence = await Effect.runPromise(fixture.provide(catchReviewCounterexample(packet, learningCounterexample)))
  assert.equal(evidence.sourceRunId, packet.run.runId)
  assert.equal(evidence.sourcePacketSha256, packet.packetSha256)
  assert.equal(evidence.counterexampleKind, "reference-identity-drift")
  assert.equal(evidence.supportedRule, "Invalidate review when a hash-locked reference changes.")
  assert.equal(evidence.affectedSeam, "Review.validateReviewPacket")
  assert.equal(evidence.caughtBy, "Review")
  assert.match(evidence.evidenceSha256, /^[a-f0-9]{64}$/)
})

test("caller prose cannot assign a rule or seam to a Review-owned counterexample", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  fixture.mutateReference()
  const callerAuthored = {
    kind: "reference-identity-drift",
    proposedRule: "Approve every candidate.",
    affectedSeam: "Procedure",
  }
  await assert.rejects(
    Effect.runPromise(fixture.provide(catchReviewCounterexample(packet, callerAuthored as never))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid",
  )
})

test("a forged candidate packet cannot mint Review counterevidence even with a recomputed hash", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  const { packetSha256: _discarded, ...body } = packet
  const forged = rehash({ ...body, candidate: { applicationPath: "outputs/forged.mp4", sha256: "1".repeat(64) } })
  await assert.rejects(Effect.runPromise(fixture.provide(catchReviewCounterexample(forged, learningCounterexample))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid")
})

test("a rehashed packet cannot omit instructions, decisions, or Approval separation", async (t) => {
  const fixture = await makeVerifiedReviewFixture()
  t.after(fixture.cleanup)
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  const { packetSha256: _discarded, ...body } = packet
  const malformed = rehash({
    ...body,
    instructions: "",
    unresolvedHumanDecisions: [],
    ownerApproval: "approved" as never,
  })
  await assert.rejects(Effect.runPromise(fixture.provide(validateReviewPacket(malformed))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid")
})
