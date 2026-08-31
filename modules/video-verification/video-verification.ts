import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

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

const readUint64 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 8 > bytes.byteLength) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box is truncated.")
  }
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box is too large to inspect safely.")
  }
  return Number(value)
}

type Mp4Box = Readonly<{
  type: string
  start: number
  contentStart: number
  end: number
}>

const parseBoxes = (
  bytes: Uint8Array,
  start = 0,
  end = bytes.byteLength,
): ReadonlyArray<Mp4Box> => {
  const boxes: Array<Mp4Box> = []
  let cursor = start
  while (cursor < end) {
    if (end - cursor < 8) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box hierarchy is truncated.")
    }
    const declaredSize = readUint32(bytes, cursor)
    const type = Buffer.from(bytes.subarray(cursor + 4, cursor + 8)).toString("ascii")
    let headerSize = 8
    let size = declaredSize
    if (declaredSize === 1) {
      headerSize = 16
      size = readUint64(bytes, cursor + 8)
    } else if (declaredSize === 0) {
      size = end - cursor
    }
    if (!/^[\x20-\x7e]{4}$/.test(type) || size < headerSize || cursor + size > end) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box hierarchy is malformed.")
    }
    boxes.push({ type, start: cursor, contentStart: cursor + headerSize, end: cursor + size })
    cursor += size
  }
  if (cursor !== end) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 box hierarchy is malformed.")
  }
  return boxes
}

const requireBox = (boxes: ReadonlyArray<Mp4Box>, type: string): Mp4Box => {
  const box = boxes.find((candidate) => candidate.type === type)
  if (box === undefined) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", `The MP4 is missing its ${type} box.`)
  }
  return box
}

const fullBoxEntryCount = (bytes: Uint8Array, box: Mp4Box, relativeOffset = 4): number =>
  readUint32(bytes, box.contentStart + relativeOffset)

type Mp4MediaKind = "video" | "audio"

const sampleDescriptionKinds = (
  bytes: Uint8Array,
  stsd: Mp4Box,
): ReadonlyArray<Mp4MediaKind | "unknown"> | undefined => {
  if (stsd.contentStart + 8 > stsd.end) return undefined
  const count = readUint32(bytes, stsd.contentStart + 4)
  if (count < 1) return undefined
  const kinds: Array<Mp4MediaKind | "unknown"> = []
  let cursor = stsd.contentStart + 8
  for (let index = 0; index < count; index += 1) {
    if (cursor + 8 > stsd.end) return undefined
    const size = readUint32(bytes, cursor)
    if (size < 8 || cursor + size > stsd.end) return undefined
    const codec = Buffer.from(bytes.subarray(cursor + 4, cursor + 8)).toString("ascii")
    kinds.push(/^(?:avc1|avc3|hvc1|hev1|av01|vp09|mp4v)$/.test(codec)
      ? "video"
      : /^(?:mp4a|ac-3|ec-3|Opus)$/.test(codec) ? "audio" : "unknown")
    cursor += size
  }
  return cursor === stsd.end ? kinds : undefined
}

const sampleTableMediaKind = (bytes: Uint8Array, stbl: Mp4Box): Mp4MediaKind | "invalid" | undefined => {
  const stsd = parseBoxes(bytes, stbl.contentStart, stbl.end).find((box) => box.type === "stsd")
  if (stsd === undefined) return undefined
  const kinds = sampleDescriptionKinds(bytes, stsd)
  if (kinds === undefined) return "invalid"
  const recognized = new Set(kinds.filter((kind): kind is Mp4MediaKind => kind !== "unknown"))
  return recognized.size > 1 ? "invalid" : recognized.values().next().value
}

const validSampleTable = (
  bytes: Uint8Array,
  stbl: Mp4Box,
  mediaData: ReadonlyArray<Mp4Box>,
  mediaKind: Mp4MediaKind,
): boolean => {
  const children = parseBoxes(bytes, stbl.contentStart, stbl.end)
  const stsd = children.find((box) => box.type === "stsd")
  const stts = children.find((box) => box.type === "stts")
  const stsc = children.find((box) => box.type === "stsc")
  const stsz = children.find((box) => box.type === "stsz")
  const offsets = children.find((box) => box.type === "stco" || box.type === "co64")
  if (
    stsd === undefined || stts === undefined || stsc === undefined || stsz === undefined || offsets === undefined ||
    stsd.contentStart + 16 > stsd.end || stts.contentStart + 8 > stts.end ||
    stsc.contentStart + 8 > stsc.end || stsz.contentStart + 12 > stsz.end ||
    offsets.contentStart + 12 > offsets.end
  ) return false
  const descriptionCount = fullBoxEntryCount(bytes, stsd)
  const timingCount = fullBoxEntryCount(bytes, stts)
  const chunkMapCount = fullBoxEntryCount(bytes, stsc)
  const offsetCount = fullBoxEntryCount(bytes, offsets)
  const offsetWidth = offsets.type === "co64" ? 8 : 4
  if (
    descriptionCount < 1 || timingCount < 1 || chunkMapCount < 1 || offsetCount < 1 ||
    stts.contentStart + 8 + timingCount * 8 > stts.end ||
    stsc.contentStart + 8 + chunkMapCount * 12 > stsc.end ||
    offsets.contentStart + 8 + offsetCount * offsetWidth > offsets.end
  ) return false
  const descriptionKinds = sampleDescriptionKinds(bytes, stsd)
  if (descriptionKinds === undefined || descriptionKinds.length !== descriptionCount) return false
  for (let index = 0; index < chunkMapCount; index += 1) {
    const entryOffset = stsc.contentStart + 8 + index * 12
    const firstChunk = readUint32(bytes, entryOffset)
    const samplesPerChunk = readUint32(bytes, entryOffset + 4)
    const descriptionIndex = readUint32(bytes, entryOffset + 8)
    if (
      firstChunk < 1 || samplesPerChunk < 1 || descriptionIndex < 1 ||
      descriptionIndex > descriptionKinds.length || descriptionKinds[descriptionIndex - 1] !== mediaKind
    ) return false
  }
  const sampleSize = readUint32(bytes, stsz.contentStart + 4)
  const sampleCount = readUint32(bytes, stsz.contentStart + 8)
  if (sampleCount < 1) return false
  let timingSampleCount = 0
  for (let index = 0; index < timingCount; index += 1) {
    const entryOffset = stts.contentStart + 8 + index * 8
    const entrySamples = readUint32(bytes, entryOffset)
    const sampleDelta = readUint32(bytes, entryOffset + 4)
    if (entrySamples < 1 || sampleDelta < 1) return false
    timingSampleCount += entrySamples
  }
  if (!Number.isSafeInteger(timingSampleCount) || timingSampleCount !== sampleCount) return false
  let sampleBytes = sampleSize * sampleCount
  if (sampleSize === 0) {
    if (stsz.contentStart + 12 + sampleCount * 4 > stsz.end) return false
    sampleBytes = 0
    for (let index = 0; index < sampleCount; index += 1) {
      sampleBytes += readUint32(bytes, stsz.contentStart + 12 + index * 4)
    }
  }
  const chunkOffsets = Array.from({ length: offsetCount }, (_, index) => offsetWidth === 8
    ? readUint64(bytes, offsets.contentStart + 8 + index * offsetWidth)
    : readUint32(bytes, offsets.contentStart + 8 + index * offsetWidth))
  const everyChunkIsInMedia = chunkOffsets.every((offset) =>
    mediaData.some((box) => offset >= box.contentStart && offset < box.end))
  const totalMediaBytes = mediaData.reduce((total, box) => total + box.end - box.contentStart, 0)
  return Number.isSafeInteger(sampleBytes) && everyChunkIsInMedia && sampleBytes > 0 && sampleBytes <= totalMediaBytes
}

const requireDecodableVideo = (bytes: Uint8Array): void => {
  const result = spawnSync(
    "/usr/bin/ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
      "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
      "-f", "null", "-",
    ],
    {
      input: bytes,
      timeout: 15_000,
      maxBuffer: 1_048_576,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
    },
  )
  if (result.error !== undefined || result.status !== 0) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 video stream could not be decoded safely.")
  }
}

const inspectMp4 = (
  bytes: Uint8Array,
): Readonly<{ width: number; height: number; durationSeconds: number; hasAudio: boolean }> => {
  const topLevel = parseBoxes(bytes)
  requireBox(topLevel, "ftyp")
  const moov = requireBox(topLevel, "moov")
  const mediaData = topLevel.filter((box) => box.type === "mdat" && box.end > box.contentStart)
  if (mediaData.length === 0) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 has no media data.")
  }
  const movie = parseBoxes(bytes, moov.contentStart, moov.end)
  const mvhd = requireBox(movie, "mvhd")
  const version = bytes[mvhd.contentStart]
  if (
    (version === 0 && mvhd.contentStart + 20 > mvhd.end) ||
    (version === 1 && mvhd.contentStart + 32 > mvhd.end)
  ) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 movie timing is truncated.")
  }
  const timescale = version === 0
    ? readUint32(bytes, mvhd.contentStart + 12)
    : version === 1
      ? readUint32(bytes, mvhd.contentStart + 20)
      : 0
  const duration = version === 0
    ? readUint32(bytes, mvhd.contentStart + 16)
    : version === 1
      ? readUint64(bytes, mvhd.contentStart + 24)
      : 0
  let videoTrack: Readonly<{ width: number; height: number }> | undefined
  let hasAudio = false
  for (const track of movie.filter((box) => box.type === "trak")) {
    const trackChildren = parseBoxes(bytes, track.contentStart, track.end)
    const tkhd = requireBox(trackChildren, "tkhd")
    const mdia = requireBox(trackChildren, "mdia")
    const mediaChildren = parseBoxes(bytes, mdia.contentStart, mdia.end)
    const hdlr = requireBox(mediaChildren, "hdlr")
    const minf = requireBox(mediaChildren, "minf")
    if (hdlr.contentStart + 12 > hdlr.end || tkhd.end - tkhd.contentStart < 8) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 track metadata is truncated.")
    }
    const handler = Buffer.from(bytes.subarray(hdlr.contentStart + 8, hdlr.contentStart + 12)).toString("ascii")
    const mediaInformation = parseBoxes(bytes, minf.contentStart, minf.end)
    const stbl = requireBox(mediaInformation, "stbl")
    const declaredKind: Mp4MediaKind | undefined = handler === "vide"
      ? "video"
      : handler === "soun" ? "audio" : undefined
    const codecKind = sampleTableMediaKind(bytes, stbl)
    if (codecKind === "invalid" || codecKind === undefined) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 sample descriptions are unsupported or malformed.")
    }
    if (declaredKind !== codecKind) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 track handler contradicts its media codec.")
    }
    const sampleTableValid = validSampleTable(bytes, stbl, mediaData, codecKind)
    if (!sampleTableValid) {
      throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 video or audio sample table is malformed.")
    }
    if (codecKind === "video") {
      videoTrack = {
        width: readUint32(bytes, tkhd.end - 8) / 65_536,
        height: readUint32(bytes, tkhd.end - 4) / 65_536,
      }
    } else if (codecKind === "audio") {
      hasAudio = true
    }
  }
  if (videoTrack === undefined) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 has no structurally valid video sample track.")
  }
  const { width, height } = videoTrack
  if (
    timescale === 0 || duration === 0 ||
    !Number.isSafeInteger(width) || width < 1 ||
    !Number.isSafeInteger(height) || height < 1
  ) {
    throw new VideoVerificationError("VIDEO_MEDIA_INVALID", "The MP4 dimensions or duration are invalid.")
  }
  requireDecodableVideo(bytes)
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
      (input.cost.state !== "actual" && input.cost.state !== "estimated-only" && input.cost.state !== "unknown") ||
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
