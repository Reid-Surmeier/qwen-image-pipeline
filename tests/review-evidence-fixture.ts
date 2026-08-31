import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

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
  catchReviewCounterexample,
  fileReviewApplication,
  prepareReviewPacket,
  ReviewApplication,
  type ReviewCounterexample,
  type ReviewPacketInput,
} from "../modules/review/index.js"
import { makeFixture } from "./control-plane-fixture.js"

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
const clock: RunRecordClockService = { now: () => Effect.succeed("2026-08-31T21:00:00.000Z") }

export const learningCounterexample: ReviewCounterexample = Object.freeze({
  proposedRule: "Invalidate review when a hash-locked reference changes.",
  affectedSeam: "Review.validateReviewPacket",
  mutationDescription: "Replace the exact reference bytes after packet creation.",
})

const writeApplicationFile = (applicationRoot: string, applicationPath: string, bytes: Uint8Array): void => {
  const destination = join(applicationRoot, applicationPath)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, bytes)
}

export const makeVerifiedReviewFixture = async () => {
  let applicationFiles: Map<string, Uint8Array> | undefined
  const contractBody = Buffer.from("acceptance contract\n")
  const briefBody = Buffer.from(JSON.stringify({
    instructions: "Judge the exact candidate against the exact reference and contract.",
    unresolvedHumanDecisions: ["Does the style match?"],
  }))
  const fixture = makeFixture("seedance-video", { files: (files) => {
    applicationFiles = files
    files.set("contracts/acceptance.md", contractBody)
    files.set("contracts/review-brief.json", briefBody)
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

  const applicationRoot = mkdtempSync(join(tmpdir(), "qwen-review-application-"))
  for (const [applicationPath, bytes] of applicationFiles!) {
    writeApplicationFile(applicationRoot, applicationPath, bytes)
  }
  const headPath = join(applicationRoot, ".git/refs/heads/main")
  writeApplicationFile(applicationRoot, ".git/HEAD", Buffer.from("ref: refs/heads/main\n"))
  writeApplicationFile(applicationRoot, ".git/refs/heads/main", Buffer.from(`${"a".repeat(40)}\n`))
  const reviewApplication = await Effect.runPromise(fileReviewApplication(applicationRoot))
  const reference = planned.run.request.references[0]!
  const input: ReviewPacketInput = {
    acceptanceContract: { applicationPath: "contracts/acceptance.md", sha256: hash(contractBody) },
    reviewBrief: { applicationPath: "contracts/review-brief.json", sha256: hash(briefBody) },
    runId: completed.runId,
    references: [{ applicationPath: reference.applicationPath, sha256: reference.sha256 }],
    candidate: { applicationPath: completed.candidate.applicationPath, sha256: completed.candidate.sha256 },
  }
  const provide = <Success, Error, Requirements>(effect: Effect.Effect<Success, Error, Requirements>) => effect.pipe(
    Effect.provideService(ReviewApplication, reviewApplication),
    Effect.provide(memory.layer),
  ) as Effect.Effect<Success, Error>
  let revision = 0
  return {
    applicationRoot,
    completed,
    fixture,
    input,
    memory,
    planned,
    provide,
    reviewApplication,
    currentApplicationCommit: () => readFileSync(headPath, "utf8").trim(),
    mutateReference: (bytes = Buffer.from("changed reference")) =>
      writeApplicationFile(applicationRoot, reference.applicationPath, bytes),
    commitApplicationChange: () => {
      revision += 1
      writeApplicationFile(applicationRoot, "revision-marker.txt", Buffer.from(String(revision)))
      writeFileSync(headPath, `${hash(`revision ${revision}`).slice(0, 40)}\n`)
    },
    cleanup: () => rmSync(applicationRoot, { recursive: true, force: true }),
  }
}

export const issueReferenceInvalidation = async () => {
  const fixture = await makeVerifiedReviewFixture()
  const packet = await Effect.runPromise(fixture.provide(prepareReviewPacket(fixture.input)))
  fixture.mutateReference()
  const evidence = await Effect.runPromise(fixture.provide(catchReviewCounterexample(packet, learningCounterexample)))
  return { evidence, fixture, packet }
}
