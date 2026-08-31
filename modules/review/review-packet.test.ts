import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import { plan, ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector } from "../conductor/index.js"
import { RunRecordClock, makeMemoryRunRecordHarness, reserve, type RunRecordClockService } from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import { makeVerifiedReviewFixture } from "../../tests/review-evidence-fixture.js"
import {
  inspectReviewInvalidation,
  prepareReviewPacket,
  validateReviewPacket,
} from "./index.js"

const clock: RunRecordClockService = { now: () => Effect.succeed("2026-08-31T21:00:00.000Z") }

test("a non-verified Run prevents independent or paid semantic review", async () => {
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
  const reference = planned.run.request.references[0]!
  await assert.rejects(Effect.runPromise(prepareReviewPacket({
    applicationCommit: "b".repeat(40),
    acceptanceContract: { applicationPath: reference.applicationPath, sha256: reference.sha256 },
    runId: reserved.runId,
    references: [{ applicationPath: reference.applicationPath, sha256: reference.sha256 }],
    candidate: { applicationPath: "outputs/missing.mp4", sha256: "1".repeat(64) },
    instructions: "review",
    unresolvedHumanDecisions: ["approve?"],
  }).pipe(Effect.provideService(ApplicationFiles, fixture.files), Effect.provide(memory.layer))),
  (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewBlocked")
})

test("prepares and revalidates a complete exact packet with Approval separate", async () => {
  const fixture = await makeVerifiedReviewFixture()
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  assert.equal(packet.machineVerification, "passed")
  assert.equal(packet.ownerApproval, "unresolved")
  assert.equal(packet.applicationCommit, "b".repeat(40))
  assert.match(packet.toolCommit, /^[a-f0-9]{40}$/)
  assert.equal(JSON.parse(packet.run.canonicalRequest).objectiveId, "seedance-neutral-objective")
  assert.match(packet.packetSha256, /^[a-f0-9]{64}$/)
  await Effect.runPromise(fixture.provide(validateReviewPacket(packet, { applicationCommit: packet.applicationCommit })))
})

test("changed reference bytes or application commit invalidate the packet and issue counterevidence", async () => {
  const fixture = await makeVerifiedReviewFixture()
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  await assert.rejects(
    Effect.runPromise(fixture.provide(validateReviewPacket(packet, { applicationCommit: "c".repeat(40) }))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid",
  )
  fixture.applicationFiles.set(packet.references[0]!.applicationPath, Buffer.from("changed reference"))
  let caught: unknown
  try { await Effect.runPromise(fixture.provide(validateReviewPacket(packet, { applicationCommit: packet.applicationCommit }))) }
  catch (error) { caught = error }
  assert.equal(caught instanceof Error && "code" in caught && caught.code, "ReferenceIdentityChanged")
  const evidence = inspectReviewInvalidation(caught)
  assert.equal(evidence?.caughtBy, "Review")
  assert.match(evidence!.evidenceSha256, /^[a-f0-9]{64}$/)
})

test("changed packet contents fail their own hash before review", async () => {
  const fixture = await makeVerifiedReviewFixture()
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  await assert.rejects(
    Effect.runPromise(fixture.provide(validateReviewPacket({ ...packet, instructions: "trust me" }, { applicationCommit: packet.applicationCommit }))),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ReviewPacketInvalid",
  )
})
