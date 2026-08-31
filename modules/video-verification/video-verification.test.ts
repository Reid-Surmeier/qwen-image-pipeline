import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { makeFixture } from "../../tests/control-plane-fixture.js"
import { verifyVideo } from "./index.js"

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

const fixtureVideo = async (): Promise<Uint8Array> => {
  const fixture = makeFixture("seedance-video")
  return (await Effect.runPromise(fixture.files.read("references/neutral.mp4"))).bytes
}

test("verifies exact Seedance MP4 properties, counts, audio expectation, hash, and cost state", async () => {
  const body = await fixtureVideo()
  const verified = await Effect.runPromise(verifyVideo({
    outputs: [{
      applicationPath: "outputs/seedance-result.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: {
      width: 64,
      height: 48,
      durationSeconds: 0.2,
      audioExpected: false,
    },
    requestedCount: 1,
    completedCount: 1,
    cost: {
      state: "estimated-only",
      estimatedMaximumCostUsd: "0.20",
    },
  }))

  assert.equal(verified.classification, "verified-candidate")
  assert.equal(verified.outputs[0]?.sha256, hash(body))
  assert.deepEqual(verified.outputs[0]?.actual, {
    width: 64,
    height: 48,
    durationSeconds: 0.2,
    hasAudio: false,
  })
  assert.equal(verified.requestedCount, 1)
  assert.equal(verified.completedCount, 1)
  assert.equal(verified.cost.state, "estimated-only")
  assert.deepEqual(verified.checks.map((check) => check.name), [
    "integrity",
    "media",
    "dimensions",
    "duration",
    "audio-expectation",
  ])
})

test("catches an independently mutated bad-media fixture", async () => {
  const body = Uint8Array.from(await fixtureVideo())
  body[4] = 0
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/seedance-result.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: {
      width: 64,
      height: 48,
      durationSeconds: 0.2,
      audioExpected: false,
    },
    requestedCount: 1,
    completedCount: 1,
    cost: {
      state: "unknown",
      estimatedMaximumCostUsd: "0.20",
    },
  })))

  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})
