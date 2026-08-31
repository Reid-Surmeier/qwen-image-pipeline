import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector, plan } from "../conductor/index.js"
import { makeMemoryRunRecordHarness, record, reserve, RunRecordClock } from "../run-record/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import { GenerationAdapter, invoke, prepare, type GenerationResult } from "./index.js"

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")

test("puts exact reference bytes and hash at the locked destination and invokes one adapter once", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const prepared = await Effect.runPromise(prepare(decision.run.request, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: locked.payloadDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }]))
  const payloadReference = ((prepared.payload.input_references as ReadonlyArray<Record<string, unknown>>)[0]!
    .image_url as Record<string, unknown>).url as Record<string, unknown>
  assert.equal(payloadReference.sha256, locked.sha256)
  assert.deepEqual(Buffer.from(payloadReference.bytesBase64 as string, "base64"), Buffer.from(snapshot.bytes))

  const memory = await Effect.runPromise(makeMemoryRunRecordHarness())
  const clock = { now: () => Effect.succeed("2026-08-30T12:00:00.000Z") }
  const reserved = await Effect.runPromise(reserve({
    plannedRun: decision.run,
    payloadSha256: prepared.payloadSha256,
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  const marker = await Effect.runPromise(record({
    _tag: "SubmissionMayHaveStarted",
    runId: reserved.runId,
    operationId: "generation-submit",
  }).pipe(Effect.provide(memory.layer), Effect.provideService(RunRecordClock, clock)))
  assert.equal(marker._tag, "SubmissionPermitIssued")
  if (marker._tag !== "SubmissionPermitIssued") return

  const donorBody = Buffer.from(JSON.stringify({ height: 1, pixels: [90, 90, 90, 255], width: 1 }))
  const providerBody = Buffer.from(JSON.stringify({ id: "fake-qwen-1", status: "completed" }))
  const normalized: GenerationResult = {
    provider: "openrouter",
    model: decision.run.request.model,
    providerEvidence: { mediaType: "application/json", body: providerBody, sha256: sha256(providerBody) },
    outputs: [{
      applicationPath: "outputs/donor-01.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      body: donorBody,
      sha256: sha256(donorBody),
    }],
  }
  let calls = 0
  const adapter = { invoke: () => { calls += 1; return Effect.succeed(normalized) } }
  const result = await Effect.runPromise(invoke(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  ))
  assert.equal(calls, 1)
  assert.deepEqual(result, normalized)
  const duplicate = await Effect.runPromise(Effect.flip(invoke(prepared, marker.permit).pipe(
    Effect.provideService(GenerationAdapter, adapter),
  )))
  assert.equal(duplicate.code, "DUPLICATE_SUBMISSION_BLOCKED")
  assert.equal(calls, 1)
})

test("rejects a sparse provider-reference destination before reservation", async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") return
  const locked = decision.run.request.references[0]!
  const snapshot = await Effect.runPromise(fixture.files.read(locked.applicationPath))
  const sparseDestination = "/input_references/1/image_url/url"
  const error = await Effect.runPromise(Effect.flip(prepare({
    ...decision.run.request,
    references: [{ ...locked, payloadDestination: sparseDestination }],
  }, [{
    slot: locked.slot,
    applicationPath: locked.applicationPath,
    sha256: locked.sha256,
    payloadDestination: sparseDestination,
    mediaType: "image/png",
    bytes: snapshot.bytes,
  }])))
  assert.equal(error.code, "PAYLOAD_DESTINATION_INVALID")
})
