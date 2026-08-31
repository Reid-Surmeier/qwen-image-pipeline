import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import {
  forgedNonDecodableMp4,
  falsifiedVideoMetadataMp4,
  hiddenAudioTrackMp4,
  hiddenSecondSampleDescriptionMp4,
  hiddenUnrecognizedAudioTrackMp4,
  malformedAudioTrack,
  makeFixture,
  multipleVideoTracksMp4,
  zeroVideoTimingSampleCount,
} from "../../tests/control-plane-fixture.js"
import { verifyVideo, type VerifyVideoInput } from "./index.js"

const hash = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

const fixtureVideo = async (): Promise<Uint8Array> => {
  const fixture = makeFixture("seedance-video")
  return (await Effect.runPromise(fixture.files.read("references/neutral.mp4"))).bytes
}

const markerOnlyMp4 = (): Uint8Array => {
  const body = Buffer.alloc(76)
  body.writeUInt32BE(12, 0)
  body.write("ftyp", 4, "ascii")
  body.writeUInt32BE(28, 12)
  body.write("mvhd", 16, "ascii")
  body.writeUInt32BE(1_000, 32)
  body.writeUInt32BE(200, 36)
  body.writeUInt32BE(36, 40)
  body.write("tkhd", 44, "ascii")
  body.writeUInt32BE(64 * 65_536, 68)
  body.writeUInt32BE(48 * 65_536, 72)
  return body
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

test("rejects marker-shaped bytes without a structural playable MP4 track", async () => {
  const body = markerOnlyMp4()
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/marker-only.mp4",
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

test("rejects an invalid runtime cost state as typed evidence failure", async () => {
  const body = await fixtureVideo()
  const forged = {
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
      state: "forged-runtime-state",
      estimatedMaximumCostUsd: "0.20",
    },
  } as unknown as VerifyVideoInput
  const failure = await Effect.runPromise(Effect.flip(verifyVideo(forged)))

  assert.equal(failure.code, "VIDEO_EVIDENCE_INVALID")
})

test("rejects a box-consistent MP4 whose declared video stream cannot decode", async () => {
  const body = forgedNonDecodableMp4()
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/non-decodable.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects MP4 timing tables with zero declared video samples", async () => {
  const body = zeroVideoTimingSampleCount(await fixtureVideo())
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/zero-timing-samples.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects MP4 dimensions and duration that contradict decoded frames", async () => {
  const source = await fixtureVideo()
  for (const body of [
    falsifiedVideoMetadataMp4(source, { width: 32, height: 24 }),
    falsifiedVideoMetadataMp4(source, { durationUnits: 100 }),
  ]) {
    const failure = await Effect.runPromise(Effect.flip(verifyVideo({
      outputs: [{
        applicationPath: "outputs/forged-metadata.mp4",
        mediaType: "video/mp4",
        body,
        sha256: hash(body),
      }],
      expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
      requestedCount: 1,
      completedCount: 1,
      cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
    })))
    assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
  }
})

test("rejects ambiguous MP4 evidence with multiple video tracks", async () => {
  const body = multipleVideoTracksMp4(await fixtureVideo())
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/multiple-video.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects a malformed declared audio track instead of treating it as no audio", async () => {
  const body = malformedAudioTrack(await fixtureVideo())
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/malformed-audio.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects an AAC track whose handler was relabeled to hide its audio", async () => {
  const body = hiddenAudioTrackMp4()
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/hidden-audio.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects a decodable unrecognized audio codec relabeled under a non-audio handler", async () => {
  const body = hiddenUnrecognizedAudioTrackMp4()
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/hidden-unrecognized-audio.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})

test("rejects hidden audio selected from a later sample description", async () => {
  const body = hiddenSecondSampleDescriptionMp4()
  const failure = await Effect.runPromise(Effect.flip(verifyVideo({
    outputs: [{
      applicationPath: "outputs/hidden-second-description.mp4",
      mediaType: "video/mp4",
      body,
      sha256: hash(body),
    }],
    expected: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    requestedCount: 1,
    completedCount: 1,
    cost: { state: "unknown", estimatedMaximumCostUsd: "0.20" },
  })))
  assert.equal(failure.code, "VIDEO_MEDIA_INVALID")
})
