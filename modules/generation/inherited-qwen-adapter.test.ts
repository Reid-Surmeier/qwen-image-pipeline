import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector, plan } from "../conductor/index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"
import {
  GenerationError,
  inheritedQwenAdapter,
  prepare,
  QWEN_ADAPTER_PROTOCOL_VERSION,
} from "./index.js"

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex")

const preparedFixture = async () => {
  const fixture = makeFixture("qwen-image")
  const decision = await Effect.runPromise(plan({ objectivePath: fixture.objectivePath }).pipe(
    Effect.provideService(ApplicationFiles, fixture.files),
    Effect.provideService(MediaInspector, byteMediaInspector),
    Effect.provideService(PlanningIdentity, fixture.identity),
  ))
  assert.equal(decision._tag, "Planned")
  if (decision._tag !== "Planned") throw new Error("fixture did not plan")
  const references = await Promise.all(decision.run.request.references.map(async (locked) => {
    const file = await Effect.runPromise(fixture.files.read(locked.applicationPath))
    return {
      slot: locked.slot,
      applicationPath: locked.applicationPath,
      sha256: locked.sha256,
      payloadDestination: locked.payloadDestination,
      mediaType: locked.mediaType,
      bytes: file.bytes,
    }
  }))
  return prepare(decision.run.request, references)
}

test("the inherited Qwen adapter sends one closed versioned request with exact reference roles and hashes", async () => {
  const prepared = await Effect.runPromise(await preparedFixture())
  const raster = Buffer.from(JSON.stringify({ height: 1, pixels: [12, 34, 56, 255], width: 1 }))
  const receipt = Buffer.from('{"id":"captured-qwen-1","status":"completed"}')
  let calls = 0
  const adapter = inheritedQwenAdapter({
    exchange: (requestBytes) => Effect.sync(() => {
      calls += 1
      const request = JSON.parse(Buffer.from(requestBytes).toString("utf8")) as Record<string, unknown>
      assert.deepEqual(Object.keys(request).sort(), [
        "adapter_protocol_version",
        "model",
        "objective",
        "operation",
        "provider",
        "references",
        "requested_count",
      ])
      assert.equal(request.adapter_protocol_version, QWEN_ADAPTER_PROTOCOL_VERSION)
      assert.equal(request.operation, "invoke")
      assert.equal(request.provider, "openrouter")
      assert.equal(request.model, prepared.request.model)
      assert.equal(request.requested_count, 1)
      assert.equal(request.objective, prepared.request.objective)
      assert.deepEqual((request.references as Array<Record<string, unknown>>).map((reference) => ({
        application_path: reference.application_path,
        media_type: reference.media_type,
        slot: reference.slot,
        sha256: reference.sha256,
        payload_destination: reference.payload_destination,
        body_sha256: sha256(Buffer.from(reference.bytes_base64 as string, "base64")),
      })), prepared.request.references.map((reference) => ({
        application_path: reference.applicationPath,
        media_type: reference.mediaType,
        slot: reference.slot,
        sha256: reference.sha256,
        payload_destination: reference.payloadDestination,
        body_sha256: reference.sha256,
      })))
      return Buffer.from(JSON.stringify({
        adapter_protocol_version: QWEN_ADAPTER_PROTOCOL_VERSION,
        provider: "openrouter",
        model: prepared.request.model,
        provider_evidence: {
          media_type: "application/json",
          body_base64: receipt.toString("base64"),
          sha256: sha256(receipt),
        },
        outputs: [{
          application_path: "outputs/donor-01.rgba.json",
          media_type: "application/vnd.qwen.rgba+json",
          body_base64: raster.toString("base64"),
          sha256: sha256(raster),
        }],
      }))
    }),
  })

  const result = await Effect.runPromise(adapter.invoke(prepared))
  assert.equal(calls, 1)
  assert.equal(result.provider, "openrouter")
  assert.equal(result.model, prepared.request.model)
  assert.deepEqual(Buffer.from(result.outputs[0]!.body), raster)
  assert.deepEqual(Buffer.from(result.providerEvidence.body), receipt)
})

test("the inherited Qwen adapter preserves typed ambiguity and rejects malformed protocol responses", async () => {
  const prepared = await Effect.runPromise(await preparedFixture())
  const ambiguous = inheritedQwenAdapter({
    exchange: () => Effect.fail(new GenerationError("PROVIDER_AMBIGUOUS", "captured timeout")),
  })
  const ambiguity = await Effect.runPromise(Effect.flip(ambiguous.invoke(prepared)))
  assert.equal(ambiguity.code, "PROVIDER_AMBIGUOUS")

  const malformed = inheritedQwenAdapter({
    exchange: () => Effect.succeed(Buffer.from('{"adapter_protocol_version":"999"}')),
  })
  const failure = await Effect.runPromise(Effect.flip(malformed.invoke(prepared)))
  assert.equal(failure.code, "ADAPTER_RESULT_INVALID")
})
