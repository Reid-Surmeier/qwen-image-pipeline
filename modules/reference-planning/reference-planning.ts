import { createHash } from "node:crypto"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  type ApplicationFilesService,
  type FileSnapshot,
  type LockedReference,
  type MediaInspectorService,
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
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) return "image"
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) return "video"
  return undefined
}

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)

const locateBox = (
  bytes: Uint8Array,
  kind: string,
): Readonly<{ start: number; size: number }> | undefined => {
  const wanted = Buffer.from(kind, "ascii")
  for (let index = 4; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === wanted[0] &&
      bytes[index + 1] === wanted[1] &&
      bytes[index + 2] === wanted[2] &&
      bytes[index + 3] === wanted[3]
    ) {
      const start = index - 4
      const size = readUint32(bytes, start)
      if (size >= 8 && start + size <= bytes.length) return { start, size }
    }
  }
  return undefined
}

const inspectBytes = (snapshot: FileSnapshot): MediaProperties => {
  const kind = detectKind(snapshot.bytes)
  if (kind === "image") {
    return {
      width: readUint32(snapshot.bytes, 16),
      height: readUint32(snapshot.bytes, 20),
    }
  }
  if (kind === "video") {
    const mvhd = locateBox(snapshot.bytes, "mvhd")
    const tkhd = locateBox(snapshot.bytes, "tkhd")
    if (mvhd === undefined || tkhd === undefined) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    if (snapshot.bytes[mvhd.start + 8] !== 0) {
      throw new MediaInspectionError("MALFORMED_MEDIA")
    }
    const timescale = readUint32(snapshot.bytes, mvhd.start + 20)
    const duration = readUint32(snapshot.bytes, mvhd.start + 24)
    const widthFixed = readUint32(snapshot.bytes, tkhd.start + tkhd.size - 8)
    const heightFixed = readUint32(snapshot.bytes, tkhd.start + tkhd.size - 4)
    if (timescale === 0) throw new MediaInspectionError("MALFORMED_MEDIA")
    return {
      width: widthFixed / 65536,
      height: heightFixed / 65536,
      durationSeconds: duration / timescale,
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
      candidate.payloadDestination !== requirement.payloadDestination
    ) {
      return yield* Effect.fail(new ReferencePlanningError(
        "PAYLOAD_DESTINATION_INVALID",
        `Reference ${requirement.slot} does not target the locked provider payload location.`,
        candidate.path,
      ))
    }
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
    const actualKind = detectKind(snapshot.bytes)
    if (actualKind !== requirement.kind) {
      return yield* Effect.fail(new ReferencePlanningError(
        input.mode === "seedance-video"
          ? "SEEDANCE_VIDEO_REFERENCE_REQUIRED"
          : "REFERENCE_KIND_MISMATCH",
        `Reference ${requirement.slot} bytes have the wrong media kind.`,
        candidate.path,
      ))
    }
    const inspectedMedia = yield* inspector.inspect({ ...snapshot, sha256: actualSha256 }).pipe(
      Effect.mapError(() => new ReferencePlanningError(
        "MEDIA_INSPECTION_FAILED",
        `Reference ${requirement.slot} could not be inspected.`,
        candidate.path,
      )),
    )
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
      kind: actualKind,
      authorityReason: candidate.authorityReason,
      payloadDestination: candidate.payloadDestination,
      inspectedMedia,
    }))
  }
  return deepFreeze({ references })
})

export const inspectSnapshot = (
  snapshot: Readonly<FileSnapshot & { sha256: string }>,
): Effect.Effect<MediaProperties, MediaInspectionError> =>
  Effect.try({
    try: () => deepFreeze(inspectBytes(snapshot)),
    catch: (error) => error instanceof MediaInspectionError
      ? error
      : new MediaInspectionError("MALFORMED_MEDIA"),
  })
