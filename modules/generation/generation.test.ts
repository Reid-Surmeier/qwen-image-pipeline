import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  GenerationError,
  createFakeGenerationAdapter,
  type GenerationRequest,
} from "./index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  plan,
} from "../conductor/index.js"
import type { AttemptReservation } from "../run-record/index.js"

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

test("executes fake generation for Qwen image and returns outputs", async () => {
  const planned = await getPlannedRun("qwen-image")
  const adapter = createFakeGenerationAdapter()

  const attempt: AttemptReservation = {
    attemptId: "att-001",
    runId: "run-001",
    requestSha256: planned.requestSha256,
    payloadDigest: "payload-digest",
    estimateUsd: "0.04",
    maximumCount: 1,
    maximumSpendUsd: "0.05",
    retryAllowed: false,
    billingStatus: "reserved",
  }

  const genReq: GenerationRequest = {
    request: planned.request,
    attempt,
  }

  const result = await Effect.runPromise(adapter.execute(genReq))
  assert.equal(result.status, 200)
  assert.equal(result.outputs.length, 1)
  assert.equal(result.outputs[0]!.name, "output-01.png")
  assert.equal(result.outputs[0]!.mediaType, "image/png")
  assert.ok(result.outputs[0]!.bytes.length > 0)
  assert.equal(adapter.getInvocationCount(), 1)
})

test("executes fake generation for Seedance video and returns video output and jobId", async () => {
  const planned = await getPlannedRun("seedance-video")
  const adapter = createFakeGenerationAdapter()

  const attempt: AttemptReservation = {
    attemptId: "att-002",
    runId: "run-002",
    requestSha256: planned.requestSha256,
    payloadDigest: "payload-digest",
    estimateUsd: "0.20",
    maximumCount: 1,
    maximumSpendUsd: "0.25",
    retryAllowed: false,
    billingStatus: "reserved",
  }

  const genReq: GenerationRequest = {
    request: planned.request,
    attempt,
  }

  const result = await Effect.runPromise(adapter.execute(genReq))
  assert.equal(result.status, 200)
  assert.equal(result.outputs.length, 1)
  assert.equal(result.outputs[0]!.name, "output-01.mp4")
  assert.equal(result.outputs[0]!.mediaType, "video/mp4")
  assert.ok(result.jobId)

  // Polling returns completed result
  const pollResult = await Effect.runPromise(adapter.poll(result.jobId!, genReq))
  assert.equal(pollResult.status, 200)
  assert.equal(adapter.getPollCount(), 1)
})

test("refuses provider substitution", async () => {
  const planned = await getPlannedRun("qwen-image")
  const adapter = createFakeGenerationAdapter()

  const badRequest = {
    ...planned.request,
    provider: "alibaba" as unknown as "openrouter",
  }

  const attempt: AttemptReservation = {
    attemptId: "att-003",
    runId: "run-003",
    requestSha256: planned.requestSha256,
    payloadDigest: "payload-digest",
    estimateUsd: "0.04",
    maximumCount: 1,
    maximumSpendUsd: "0.05",
    retryAllowed: false,
    billingStatus: "reserved",
  }

  await assert.rejects(
    Effect.runPromise(adapter.execute({ request: badRequest, attempt })),
    (err: unknown) => err instanceof GenerationError && err.code === "PROVIDER_SUBSTITUTION_FORBIDDEN",
  )
})
