import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  type ApplicationFilesService,
  type FileSnapshot,
  type LockedReference,
  type MediaInspectorService,
  type MediaInspection,
  type MediaKind,
  type MediaProperties,
  type ReferencePlan,
  type ReferencePlanningInput,
} from "./types.js"
import {
  ApplicationReadError,
  MediaInspectionError,
  ReferencePlanningError,
} from "./errors.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

const deepFreeze = <A>(value: A): A => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const isSafeApplicationPath = (
  path: string,
  roots: ReadonlyArray<string>,
): boolean => {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path)
  ) return false
  const parts = path.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false
  return roots.some((root) => path === root || path.startsWith(`${root}/`))
}

const detectKind = (bytes: Uint8Array): MediaKind | undefined => {
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    readUint32(bytes, 8) === 13 &&
    String.fromCharCode(...bytes.slice(12, 16)) === "IHDR"
  ) return "image"
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) return "video"
  return undefined
}

const readUint32 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new MediaInspectionError("MALFORMED_MEDIA")
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
}

const readUint64 = (bytes: Uint8Array, offset: number): number => {
  if (offset < 0 || offset + 8 > bytes.byteLength) throw new MediaInspectionError("MALFORMED_MEDIA")
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaInspectionError("MALFORMED_MEDIA")
  return Number(value)
}

type Mp4Box = Readonly<{
  type: string
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
    if (end - cursor < 8) throw new MediaInspectionError("MALFORMED_MEDIA")
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
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    boxes.push({ type, contentStart: cursor + headerSize, end: cursor + size })
    cursor += size
  }
  if (cursor !== end) throw new MediaInspectionError("MALFORMED_MEDIA")
  return boxes
}

const requireBox = (boxes: ReadonlyArray<Mp4Box>, type: string): Mp4Box => {
  const box = boxes.find((candidate) => candidate.type === type)
  if (box === undefined) throw new MediaInspectionError("MALFORMED_MEDIA")
  return box
}

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

const validMediaSampleTable = (
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
  const descriptionCount = readUint32(bytes, stsd.contentStart + 4)
  const timingCount = readUint32(bytes, stts.contentStart + 4)
  const chunkMapCount = readUint32(bytes, stsc.contentStart + 4)
  const offsetCount = readUint32(bytes, offsets.contentStart + 4)
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
  const totalMediaBytes = mediaData.reduce((total, box) => total + box.end - box.contentStart, 0)
  return chunkOffsets.every((offset) => mediaData.some((box) => offset >= box.contentStart && offset < box.end)) &&
    Number.isSafeInteger(sampleBytes) && sampleBytes > 0 && sampleBytes <= totalMediaBytes
}

type DecodedVideo = Readonly<{
  width: number
  height: number
  durationSeconds: number
  hasAudio: boolean
}>

const parseFramehash = (value: string): DecodedVideo | undefined => {
  const timebases = new Map<number, Readonly<{ numerator: number; denominator: number }>>()
  const mediaTypes = new Map<number, string>()
  const dimensions = new Map<number, Readonly<{ width: number; height: number }>>()
  const frameEnds = new Map<number, number>()
  for (const line of value.split(/\r?\n/)) {
    let match = /^#tb (\d+): (\d+)\/(\d+)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1])
      const numerator = Number(match[2])
      const denominator = Number(match[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(numerator) || numerator < 1 ||
          !Number.isSafeInteger(denominator) || denominator < 1 || timebases.has(stream)) return undefined
      timebases.set(stream, { numerator, denominator })
      continue
    }
    match = /^#media_type (\d+): (video|audio)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1])
      if (!Number.isSafeInteger(stream) || mediaTypes.has(stream)) return undefined
      mediaTypes.set(stream, match[2]!)
      continue
    }
    match = /^#dimensions (\d+): (\d+)x(\d+)$/.exec(line)
    if (match !== null) {
      const stream = Number(match[1])
      const width = Number(match[2])
      const height = Number(match[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(width) || width < 1 ||
          !Number.isSafeInteger(height) || height < 1 || dimensions.has(stream)) return undefined
      dimensions.set(stream, { width, height })
      continue
    }
    if (/^\s*\d+\s*,/.test(line)) {
      const fields = line.split(",").map((field) => field.trim())
      if (fields.length < 5) return undefined
      const stream = Number(fields[0])
      const pts = Number(fields[1])
      const duration = Number(fields[3])
      if (!Number.isSafeInteger(stream) || !Number.isSafeInteger(pts) ||
          !Number.isSafeInteger(duration) || duration < 1) return undefined
      const end = pts + duration
      if (!Number.isSafeInteger(end)) return undefined
      frameEnds.set(stream, Math.max(frameEnds.get(stream) ?? Number.NEGATIVE_INFINITY, end))
    }
  }
  const videoStreams = [...mediaTypes].filter(([, kind]) => kind === "video").map(([stream]) => stream)
  if (videoStreams.length !== 1) return undefined
  const stream = videoStreams[0]!
  const timebase = timebases.get(stream)
  const size = dimensions.get(stream)
  const frameEnd = frameEnds.get(stream)
  if (timebase === undefined || size === undefined || frameEnd === undefined || frameEnd < 1) return undefined
  const durationSeconds = frameEnd * timebase.numerator / timebase.denominator
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined
  return { ...size, durationSeconds, hasAudio: [...mediaTypes.values()].includes("audio") }
}

const requireDecodableVideo = (bytes: Uint8Array): DecodedVideo => {
  const version = spawnSync(
    "/usr/bin/ffmpeg",
    ["-version"],
    {
      timeout: 5_000,
      maxBuffer: 65_536,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
      encoding: "utf8",
    },
  )
  const firstLine = version.stdout?.split("\n", 1)[0] ?? ""
  if (version.error !== undefined || version.status !== 0 || !/^ffmpeg version 6(?:\.|\s)/.test(firstLine)) {
    throw new MediaInspectionError("MALFORMED_MEDIA")
  }
  const result = spawnSync(
    "/usr/bin/ffmpeg",
    [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
      "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a?",
      "-f", "framehash", "-",
    ],
    {
      input: bytes,
      timeout: 15_000,
      maxBuffer: 1_048_576,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      windowsHide: true,
      encoding: "utf8",
    },
  )
  const decoded = result.error === undefined && result.status === 0 ? parseFramehash(result.stdout) : undefined
  if (decoded === undefined) throw new MediaInspectionError("MALFORMED_MEDIA")
  return decoded
}

const inspectVideoBytes = (
  bytes: Uint8Array,
): Readonly<{ width: number; height: number; durationSeconds: number }> => {
  const topLevel = parseBoxes(bytes)
  requireBox(topLevel, "ftyp")
  const moov = requireBox(topLevel, "moov")
  const mediaData = topLevel.filter((box) => box.type === "mdat" && box.end > box.contentStart)
  if (mediaData.length === 0) throw new MediaInspectionError("MALFORMED_MEDIA")
  const movie = parseBoxes(bytes, moov.contentStart, moov.end)
  const mvhd = requireBox(movie, "mvhd")
  const version = bytes[mvhd.contentStart]
  if (
    (version === 0 && mvhd.contentStart + 20 > mvhd.end) ||
    (version === 1 && mvhd.contentStart + 32 > mvhd.end)
  ) throw new MediaInspectionError("MALFORMED_MEDIA")
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
  let dimensions: Readonly<{ width: number; height: number }> | undefined
  for (const track of movie.filter((box) => box.type === "trak")) {
    const trackChildren = parseBoxes(bytes, track.contentStart, track.end)
    const tkhd = requireBox(trackChildren, "tkhd")
    const mdia = requireBox(trackChildren, "mdia")
    const mediaChildren = parseBoxes(bytes, mdia.contentStart, mdia.end)
    const hdlr = requireBox(mediaChildren, "hdlr")
    if (hdlr.contentStart + 12 > hdlr.end || tkhd.end - tkhd.contentStart < 8) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    const handler = Buffer.from(bytes.subarray(hdlr.contentStart + 8, hdlr.contentStart + 12)).toString("ascii")
    const declaredKind: Mp4MediaKind | undefined = handler === "vide"
      ? "video"
      : handler === "soun" ? "audio" : undefined
    const minf = mediaChildren.find((box) => box.type === "minf")
    if (minf === undefined) {
      if (declaredKind !== undefined) throw new MediaInspectionError("MALFORMED_MEDIA")
      continue
    }
    const stbl = parseBoxes(bytes, minf.contentStart, minf.end).find((box) => box.type === "stbl")
    if (stbl === undefined) {
      if (declaredKind !== undefined) throw new MediaInspectionError("MALFORMED_MEDIA")
      continue
    }
    const codecKind = sampleTableMediaKind(bytes, stbl)
    if (codecKind === "invalid" || codecKind === undefined) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    if (declaredKind !== codecKind) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    if (!validMediaSampleTable(bytes, stbl, mediaData, codecKind)) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    if (codecKind !== "video") continue
    if (dimensions !== undefined) throw new MediaInspectionError("MALFORMED_MEDIA")
    dimensions = {
      width: readUint32(bytes, tkhd.end - 8) / 65_536,
      height: readUint32(bytes, tkhd.end - 4) / 65_536,
    }
  }
  if (
    dimensions === undefined || timescale === 0 || duration === 0 ||
    !Number.isSafeInteger(dimensions.width) || dimensions.width < 1 ||
    !Number.isSafeInteger(dimensions.height) || dimensions.height < 1
  ) throw new MediaInspectionError("MALFORMED_MEDIA")
  const metadataDuration = duration / timescale
  const decoded = requireDecodableVideo(bytes)
  if (
    decoded.width !== dimensions.width || decoded.height !== dimensions.height ||
    Math.abs(decoded.durationSeconds - metadataDuration) > 0.001
  ) throw new MediaInspectionError("MALFORMED_MEDIA")
  return { width: decoded.width, height: decoded.height, durationSeconds: decoded.durationSeconds }
}

const inspectBytes = (snapshot: FileSnapshot): MediaInspection => {
  const kind = detectKind(snapshot.bytes)
  if (kind === "image") {
    return {
      kind: "image",
      mediaType: "image/png",
      width: readUint32(snapshot.bytes, 16),
      height: readUint32(snapshot.bytes, 20),
    }
  }
  if (kind === "video") {
    const inspected = inspectVideoBytes(snapshot.bytes)
    return {
      kind: "video",
      mediaType: "video/mp4",
      ...inspected,
    }
  }
  throw new MediaInspectionError("UNSUPPORTED_MEDIA")
}

const sameMedia = (actual: MediaProperties, declared: MediaProperties): boolean =>
  actual.width === declared.width &&
  actual.height === declared.height &&
  (declared.durationSeconds === undefined ||
    (actual.durationSeconds !== undefined &&
      Math.abs(actual.durationSeconds - declared.durationSeconds) <= 0.001))

const isValidInspection = (value: unknown): value is MediaInspection => {
  if (value === null || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const kind = record.kind
  const mediaType = record.mediaType
  const width = record.width
  const height = record.height
  const duration = record.durationSeconds
  return (
    (kind === "image" || kind === "video") &&
    ((kind === "image" &&
        (mediaType === "image/png" || mediaType === "application/vnd.qwen.rgba+json")) ||
      (kind === "video" && mediaType === "video/mp4")) &&
    typeof width === "number" && Number.isSafeInteger(width) && width > 0 &&
    typeof height === "number" && Number.isSafeInteger(height) && height > 0 &&
    (kind === "image"
      ? duration === undefined
      : typeof duration === "number" && Number.isFinite(duration) && duration > 0)
  )
}

const isProviderPayloadDestination = (
  mode: ReferencePlanningInput["mode"],
  kind: MediaKind,
  destination: string,
): boolean => {
  const match = /^\/input_references\/(0|[1-9]\d*)\/(image_url|video_url)\/url$/.exec(destination)
  if (match === null) return false
  if (mode === "qwen-image") return kind === "image" && match[2] === "image_url"
  return kind === "video" && match[2] === "video_url"
}

export const planReferenceInputs = (
  input: ReferencePlanningInput,
): Effect.Effect<
  ReferencePlan,
  ReferencePlanningError | ApplicationReadError | MediaInspectionError,
  ApplicationFilesService | MediaInspectorService
> => Effect.gen(function*() {
  const files = yield* ApplicationFiles
  const inspector = yield* MediaInspector
  const references: Array<LockedReference> = []
  const occupiedPayloadDestinations = new Set<string>()

  for (const requirement of [...input.requirements].sort((a, b) => a.slot.localeCompare(b.slot))) {
    const candidate = input.candidates.find((item) => item.slot === requirement.slot)
    if (candidate === undefined) {
      return yield* Effect.fail(new ReferencePlanningError(
        "REFERENCE_MISSING",
        `Required reference slot ${requirement.slot} is missing.`,
      ))
    }
    if (!isSafeApplicationPath(candidate.path, input.referenceRoots)) {
      return yield* Effect.fail(new ReferencePlanningError(
        "REFERENCE_PATH_UNSAFE",
        `Reference ${requirement.slot} is outside the allowed application reference roots.`,
        candidate.path,
      ))
    }
    if (candidate.authorityReason.trim().length === 0) {
      return yield* Effect.fail(new ReferencePlanningError(
        "REFERENCE_AUTHORITY_MISSING",
        `Reference ${requirement.slot} has no authority reason.`,
        candidate.path,
      ))
    }
    if (
      !isProviderPayloadDestination(input.mode, requirement.kind, requirement.payloadDestination) ||
      occupiedPayloadDestinations.has(requirement.payloadDestination) ||
      candidate.payloadDestination !== requirement.payloadDestination
    ) {
      return yield* Effect.fail(new ReferencePlanningError(
        "PAYLOAD_DESTINATION_INVALID",
        `Reference ${requirement.slot} does not target the locked provider payload location.`,
        candidate.path,
      ))
    }
    occupiedPayloadDestinations.add(requirement.payloadDestination)
    if (candidate.kind !== requirement.kind) {
      const code = input.mode === "seedance-video" && requirement.kind === "video"
        ? "SEEDANCE_VIDEO_REFERENCE_REQUIRED"
        : "REFERENCE_KIND_MISMATCH"
      return yield* Effect.fail(new ReferencePlanningError(
        code,
        `Reference ${requirement.slot} has the wrong declared media kind.`,
        candidate.path,
      ))
    }

    const snapshot = yield* files.read(candidate.path).pipe(
      Effect.mapError((error) => error.code === "APPLICATION_PATH_MISSING"
          ? new ReferencePlanningError(
            "REFERENCE_MISSING",
            `Reference ${requirement.slot} at ${candidate.path} does not exist.`,
            candidate.path,
          )
        : error),
    )
    const actualSha256 = sha256(snapshot.bytes)
    if (actualSha256 !== candidate.sha256) {
      return yield* Effect.fail(new ReferencePlanningError(
        "REFERENCE_HASH_MISMATCH",
        `Reference ${requirement.slot} changed after it was authorized.`,
        candidate.path,
      ))
    }
    const detectedKind = detectKind(snapshot.bytes)
    if (detectedKind !== undefined && detectedKind !== requirement.kind) {
      return yield* Effect.fail(new ReferencePlanningError(
        input.mode === "seedance-video"
          ? "SEEDANCE_VIDEO_REFERENCE_REQUIRED"
          : "REFERENCE_KIND_MISMATCH",
        `Reference ${requirement.slot} bytes have the wrong media kind.`,
        candidate.path,
      ))
    }
    const inspectedResult: unknown = yield* inspector.inspect({ ...snapshot, sha256: actualSha256 }).pipe(
      Effect.mapError(() => new ReferencePlanningError(
        "MEDIA_INSPECTION_FAILED",
        `Reference ${requirement.slot} could not be inspected.`,
        candidate.path,
      )),
    )
    if (!isValidInspection(inspectedResult)) {
      return yield* Effect.fail(new ReferencePlanningError(
        "MEDIA_INSPECTION_FAILED",
        `Reference ${requirement.slot} inspection did not prove a supported media kind and type.`,
        candidate.path,
      ))
    }
    const inspectedMedia = inspectedResult
    const detectedMediaType = detectedKind === "image"
      ? "image/png"
      : detectedKind === "video"
        ? "video/mp4"
        : undefined
    if (
      inspectedMedia.kind !== requirement.kind ||
      (detectedKind !== undefined && inspectedMedia.kind !== detectedKind) ||
      (detectedMediaType !== undefined && inspectedMedia.mediaType !== detectedMediaType)
    ) {
      return yield* Effect.fail(new ReferencePlanningError(
        input.mode === "seedance-video"
          ? "SEEDANCE_VIDEO_REFERENCE_REQUIRED"
          : "REFERENCE_KIND_MISMATCH",
        `Reference ${requirement.slot} inspected media kind does not match the required kind.`,
        candidate.path,
      ))
    }
    if (candidate.declaredMedia !== undefined && !sameMedia(inspectedMedia, candidate.declaredMedia)) {
      return yield* Effect.fail(new ReferencePlanningError(
        "DECLARED_MEDIA_MISMATCH",
        `Reference ${requirement.slot} declared media properties do not match its hash-locked bytes.`,
        candidate.path,
      ))
    }
    references.push(deepFreeze({
      slot: requirement.slot,
      applicationPath: candidate.path,
      sha256: actualSha256,
      byteLength: snapshot.bytes.byteLength,
      kind: inspectedMedia.kind,
      mediaType: inspectedMedia.mediaType,
      authorityReason: candidate.authorityReason,
      payloadDestination: candidate.payloadDestination,
      inspectedMedia,
    }))
  }
  return deepFreeze({ references })
})

export const inspectSnapshot = (
  snapshot: Readonly<FileSnapshot & { sha256: string }>,
): Effect.Effect<MediaInspection, MediaInspectionError> =>
  Effect.try({
    try: () => deepFreeze(inspectBytes(snapshot)),
    catch: (error) => error instanceof MediaInspectionError
      ? error
      : new MediaInspectionError("MALFORMED_MEDIA"),
  })
