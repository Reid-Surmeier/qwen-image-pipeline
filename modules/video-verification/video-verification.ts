import { createHash } from "node:crypto"

import { Effect } from "effect"

import { VideoVerificationError } from "./errors.js"
import type { VerifyVideoInput, VideoVerification } from "./types.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

const readUint32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box is truncated.")
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

const locateBoxes = (
  bytes: Uint8Array,
  kind: string,
): ReadonlyArray<Readonly<{ start: number; size: number }>> => {
  const wanted = Buffer.from(kind, "ascii")
  const found: Array<Readonly<{ start: number; size: number }>> = []
  for (let index = 4; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === wanted[0] &&
      bytes[index + 1] === wanted[1] &&
      bytes[index + 2] === wanted[2] &&
      bytes[index + 3] === wanted[3]
    ) {
      const start = index - 4
      const size = readUint32(bytes, start)
      if (size >= 8 && start + size <= bytes.length) found.push({ start, size })
    }
  }
  return found
}

const inspectMp4 = (
  bytes: Uint8Array,
): Readonly<{ width: number; height: number; durationSeconds: number; hasAudio: boolean }> => {
  if (
    bytes.length < 12 ||
    Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp"
  ) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The output is not a recognized MP4 container.")
  }
  const mvhd = locateBoxes(bytes, "mvhd")[0]
  const tkhd = locateBoxes(bytes, "tkhd")[0]
  if (mvhd === undefined || tkhd === undefined || bytes[mvhd.start + 8] !== 0) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 timing or video track is malformed.")
  }
  const timescale = readUint32(bytes, mvhd.start + 20)
  const duration = readUint32(bytes, mvhd.start + 24)
  const width = readUint32(bytes, tkhd.start + tkhd.size - 8) / 65536
  const height = readUint32(bytes, tkhd.start + tkhd.size - 4) / 65536
  if (
    timescale === 0 || duration === 0 ||
    !Number.isSafeInteger(width) || width < 1 ||
    !Number.isSafeInteger(height) || height < 1
  ) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 dimensions or duration are invalid.")
  }
  const hasAudio = locateBoxes(bytes, "hdlr").some((box) =>
    box.size >= 20 && Buffer.from(bytes.subarray(box.start + 16, box.start + 20)).toString("ascii") === "soun")
  return { width, height, durationSeconds: duration / timescale, hasAudio }
}

const validMoney = (value: string): boolean => /^(?:0|[1-9]\d*)\.\d{2,6}$/.test(value)

export const verifyVideoArtifact = (
  input: VerifyVideoInput,
): Effect.Effect<VideoVerification, VideoVerificationError> => Effect.try({
  try: () => {
    if (
      !Number.isSafeInteger(input.requestedCount) || input.requestedCount < 1 ||
      !Number.isSafeInteger(input.completedCount) ||
      input.completedCount !== input.requestedCount ||
      input.outputs.length !== input.completedCount
    ) {
      throw new VideoVerificationError("OUTPUT_COUNT_MISMATCH", "Completed video evidence must match the requested count.")
    }
    if (
      !Number.isSafeInteger(input.expected.width) || input.expected.width < 1 ||
      !Number.isSafeInteger(input.expected.height) || input.expected.height < 1 ||
      !Number.isFinite(input.expected.durationSeconds) || input.expected.durationSeconds <= 0 ||
      typeof input.expected.audioExpected !== "boolean" ||
      !validMoney(input.cost.estimatedMaximumCostUsd) ||
      (input.cost.state === "actual" &&
        (input.cost.actualCostUsd === undefined || !validMoney(input.cost.actualCostUsd))) ||
      (input.cost.state !== "actual" && input.cost.actualCostUsd !== undefined)
    ) {
      throw new VideoVerificationError("VIDEO_EVIDENCE_INVALID", "Expected media or cost evidence is malformed.")
    }
    const paths = new Set<string>()
    const outputs = input.outputs.map((output) => {
      if (
        !/^outputs\/[a-z0-9][a-z0-9._-]*\.mp4$/.test(output.applicationPath) ||
        paths.has(output.applicationPath) ||
        output.mediaType !== "video/mp4" ||
        !/^[a-f0-9]{64}$/.test(output.sha256) ||
        sha256(output.body) !== output.sha256
      ) {
        throw new VideoVerificationError("VIDEO_EVIDENCE_INVALID", "Video output path, type, or SHA-256 is invalid.")
      }
      paths.add(output.applicationPath)
      const actual = inspectMp4(output.body)
      if (
        actual.width !== input.expected.width ||
        actual.height !== input.expected.height ||
        Math.abs(actual.durationSeconds - input.expected.durationSeconds) > 0.001 ||
        actual.hasAudio !== input.expected.audioExpected
      ) {
        throw new VideoVerificationError("VIDEO_CHECK_FAILED", "The actual video does not match its immutable Video Plan.")
      }
      return {
        applicationPath: output.applicationPath,
        mediaType: output.mediaType,
        sha256: output.sha256,
        actual,
      }
    })
    return {
      algorithm: "seedance-media-v1",
      classification: "verified-candidate",
      outputs,
      requestedCount: input.requestedCount,
      completedCount: input.completedCount,
      expected: input.expected,
      cost: input.cost,
      checks: [
        { name: "integrity", passed: true, measured: 0 },
        { name: "media", passed: true, measured: 0 },
        { name: "dimensions", passed: true, measured: 0 },
        { name: "duration", passed: true, measured: 0 },
        { name: "audio-expectation", passed: true, measured: 0 },
      ],
    }
  },
  catch: (error) => error instanceof VideoVerificationError
    ? error
    : new VideoVerificationError("VIDEO_MEDIA_INVALID", "Video verification could not inspect the output."),
})
