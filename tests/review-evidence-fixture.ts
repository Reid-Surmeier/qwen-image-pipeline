import { createHash } from "node:crypto"

import { Effect } from "effect"

import {
  advance,
  plan,
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
} from "../modules/conductor/index.js"
import { GenerationAdapter, type GenerationAdapterService } from "../modules/generation/index.js"
import { RunRecordClock, makeMemoryRunRecordHarness, type RunRecordClockService } from "../modules/run-record/index.js"
import {
  inspectReviewInvalidation,
  prepareReviewPacket,
  validateReviewPacket,
  type ReviewInvalidationEvidence,
  type ReviewPacketInput,
} from "../modules/review/index.js"
import { makeFixture } from "./control-plane-fixture.js"

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const clock: RunRecordClockService = { now: () => Effect.succeed("2026-08-31T21:00:00.000Z") }

export const makeVerifiedReviewFixture = async () => {
  let applicationFiles: Map<string, Uint8Array> | undefined
  const contractBody = Buffer.from("acceptance contract\n")
  const fixture = makeFixture("seedance-video", { files: (files) => {
    applicationFiles = files
    files.set("contracts/acceptance.md", contractBody)
  } })
  const planned = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  if (planned._tag !== "Planned") throw new Error("review fixture planning failed")
  const videoBody = (await Effect.runPromise(fixture.files.read("references/neutral.mp4"))).bytes
  const submissionBody = Buffer.from('{"job_id":"review-job","status":"submitted"}')
  const completedBody = Buffer.from(JSON.stringify({
    job_id: "review-job",
    status: "completed",
    outputs: [{ application_path: "outputs/review.mp4", media_type: "video/mp4", sha256: hash(videoBody) }],
    completed_count: 1,
    cost: { state: "estimated-only" },
  }))
  const adapter: GenerationAdapterService = {
    invoke: () => Effect.die("review fixture is Seedance"),
    submitSeedance: (prepared) => Effect.succeed({
      provider: "openrouter",
      model: prepared.request.model,
      jobId: "review-job",
      providerEvidence: { mediaType: "application/json", body: submissionBody, sha256: hash(submissionBody) },
    }),
    pollSeedance: (prepared) => Effect.succeed({
      status: "completed",
      provider: "openrouter",
      model: prepared.request.model,
      jobId: "review-job",
      providerEvidence: { mediaType: "application/json", body: completedBody, sha256: hash(completedBody) },
      outputs: [{ applicationPath: "outputs/review.mp4", mediaType: "video/mp4", body: videoBody, sha256: hash(videoBody) }],
      completedCount: 1,
      cost: { state: "estimated-only" },
    }),
  }
  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const advanceOnce = () => Effect.runPromise(advance({ run: planned.run }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(PlanningIdentity, fixture.identity),
    Effect.provideService(GenerationAdapter, adapter),
    Effect.provide(memory.layer),
    Effect.provideService(RunRecordClock, clock),
  ))
  if ((await advanceOnce())._tag !== "ProviderPending") throw new Error("review fixture submission failed")
  const completed = await advanceOnce()
  if (completed._tag !== "VerifiedCandidate") throw new Error("review fixture verification failed")
  const reference = planned.run.request.references[0]!
  const input: ReviewPacketInput = {
    applicationCommit: "b".repeat(40),
    acceptanceContract: { applicationPath: "contracts/acceptance.md", sha256: hash(contractBody) },
    runId: completed.runId,
    references: [{ applicationPath: reference.applicationPath, sha256: reference.sha256 }],
    candidate: { applicationPath: completed.candidate.applicationPath, sha256: completed.candidate.sha256 },
    instructions: "Judge the exact candidate against the exact reference and contract.",
    unresolvedHumanDecisions: ["Does the style match?"],
  }
  const provide = <Success, Error, Requirements>(effect: Effect.Effect<Success, Error, Requirements>) => effect.pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provide(memory.layer),
  ) as Effect.Effect<Success, Error>
  return { applicationFiles: applicationFiles!, fixture, input, memory, planned, provide }
}

export const issueReferenceInvalidation = async (): Promise<ReviewInvalidationEvidence> => {
  const fixture = await makeVerifiedReviewFixture()
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  fixture.applicationFiles.set(packet.references[0]!.applicationPath, Buffer.from("changed reference"))
  let caught: unknown
  try {
    await Effect.runPromise(fixture.provide(validateReviewPacket(packet, { applicationCommit: packet.applicationCommit })))
  } catch (error) {
    caught = error
  }
  const evidence = inspectReviewInvalidation(caught)
  if (evidence === undefined) throw new Error("review fixture did not issue invalidation evidence")
  return evidence
}
