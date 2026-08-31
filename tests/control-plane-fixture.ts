import { createHash } from "node:crypto"
import { createRequire, syncBuiltinESMExports } from "node:module"
import { gunzipSync } from "node:zlib"

import { Effect } from "effect"

import {
  ApplicationReadError,
  type ApplicationFilesService,
  type PlanningIdentityService,
  type RawPlanningDocuments,
} from "../modules/run-contract/index.js"

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=",
  "base64",
)

const MP4_BYTES = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMybW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlx0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAAAwAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAHUbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABf21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAT9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAMABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGliYjI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UR7ARAAAAMAEAAAAwFA8SJZYAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABzKAAAcygAAAAYc3R0cwAAAAAAAAABAAAAAgAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAAtMAAAAOAAAAFHN0Y28AAAAAAAAAAQAAA2IAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYwLjE2LjEwMAAAAAhmcmVlAAAC6W1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MTAgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAdZYiEADv//vdOvwKbVMIqA5JXCuqDugrYp08qbd0AAAAKQZohbEN//qfuQA==",
  "base64",
)

const AUDIO_VIDEO_MP4_BYTES = gunzipSync(Buffer.from(
  "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",
  "base64",
))

const ALAC_VIDEO_MP4_BYTES = gunzipSync(Buffer.from(
  "H4sICNL5lGoCA3RtcC5yekhPbDVYUUdQLm1wNACVVNFrHEUYn02aEI5Q8xAxD5FMY4VQepfdvfRMIgspsZgHtYJaUQrb2Z3Z7HK7O5OZuctdfVCIDz77IKJ/QFFEHwVBKuJDwBfBlwT0QQRpFWoLgn2x5zd7SW+TpjUuNzPf983v++b75vvNIYRwpLsiUTxDaAiZFYZL2qGTiQUHoZGZjPM2QijN2jFFB77hGzBtIwuZ3+CzDqIO6yvokd8w5HFFS9IE+bJuFmcOHxFt+wHP45xrJrtQTzOqFazTLFW65LE98LV2MpoQEHBGD9c+B2MMvfZdoVRjmsr9nXZCWRl5CXS+RnKaMoOxtrIkj0CYbGdF0HKap2l/b5pKFpWSGm/JFPdla1XpIAX5utKKljBfmKY95CpM4TZag3VtH/H4C4Bv2LW6U3NsF6dJ0HEbCyWPqV4P5nOAWrUoqvR+QVPrsH62+9xb1oTpiZmslTuzb1yx0Gj8x6/fz37zz927xnVCECX20jBjMtBy747VXH+gKaWL+99PdwihE0aehLLKdjOmwRYespX3rpbShjhDP8J6sn9GyAf2kYvQsyVwu/kIfg0dwS/L+v+8Pg6/yMP5NQPhRleO4pfirbyMfAV0WuLX+B6/JlR2IOgxuIV+2ONWeohbl0lKwgfKtgwF+qma+AMMmCfmKicLJD6BrL/2UQMiFLbhD48ggmUK/4+mT5aa/sTAdr/ZoI/Nwhq0qDYX/GbGitV8p8qXCQ2QRIi0fKHVpN+xpz/R3AR8kpLCuSgHXk0Er8ZpwKsxfyRjkWTMMCgDFLDn89GRXu/Tny7c/Pq33bUvPzi7g3efuvWneVq4ikMuGXZAlHXHXsR1hzlL0RJsrNUAMP/iyxeery7g85dWAUlZCBurXHRTFmns2na96tpuHYyx1mJ5fn5zc7Nm/mx4SvIal+vz5pRarLMUMFzohOdqGYckIKHnYGi6V8eUBSkPm56zbC/bmOQk7Srm2Z36st1xnDrOmBezDlatAKRnsFBdcIXZl9RzajY4wYSzpMOobyI64OFLkq8zz2ngMJY8Iz64OlhLlqaJAmmxs0hDDUK4kXk2pEDoVZ4zz3XOOg6OiNK+UM1EGEQ/wIbweRQppr2qi3UswcMESjlvkhgUf2BTaRKygcHGuSzOCJOMaJNHkmsmgZmMgj1IW5J0/ZBngmjQQ7gi+C9IcggBQEkMJpIkYwouK/BFF+SEei7IhBJhqgj8ICHmJKAOK+raZMl6rAOQuGC5v84F7PaNAlybrAuxPfecvSf68EI9x8YqZDkLW9pbsHFxurlSyVQM7jL075dr9mXohTLCGTwgZsoCxXPrNRtvmGI8u9YAUZjAxUo6XmMJBKWZ8BZwIqBJQAjoIcQiG9B/0030jqE3e+9d9Gzv3t8vXR/6+NVvzwy//3rl962vKjvXLp7Jfi4e8zjgHhvbf/i9rZnbsFTOf3QqXX373rVbK/8CaRbOYUcIAAA=",
  "base64",
))

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

export const withReportedFfmpegMajor = async <Result>(
  major: number,
  action: () => Promise<Result>,
): Promise<Result> => {
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process")
  const original = childProcess.spawnSync
  childProcess.spawnSync = ((file: string, arguments_?: ReadonlyArray<string>, options?: unknown) => {
    if (file === "/usr/bin/ffmpeg" && arguments_?.length === 1 && arguments_[0] === "-version") {
      const stdout = `ffmpeg version ${major}.0 test fixture\n`
      return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null }
    }
    return original(file, arguments_, options as never)
  }) as typeof original
  syncBuiltinESMExports()
  try {
    return await action()
  } finally {
    childProcess.spawnSync = original
    syncBuiltinESMExports()
  }
}

const mp4Uint32 = (value: number): Buffer => {
  const result = Buffer.alloc(4)
  result.writeUInt32BE(value)
  return result
}

const mp4Box = (type: string, payload: Uint8Array): Buffer => Buffer.concat([
  mp4Uint32(payload.byteLength + 8),
  Buffer.from(type, "ascii"),
  payload,
])

export const forgedNonDecodableMp4 = (): Uint8Array => {
  const build = (chunkOffset: number) => {
    const stsd = mp4Box("stsd", Buffer.concat([
      Buffer.alloc(4), mp4Uint32(1), mp4Uint32(8), Buffer.from("avc1"),
    ]))
    const stts = mp4Box("stts", Buffer.concat([
      Buffer.alloc(4), mp4Uint32(1), mp4Uint32(1), mp4Uint32(200),
    ]))
    const stsc = mp4Box("stsc", Buffer.concat([
      Buffer.alloc(4), mp4Uint32(1), mp4Uint32(1), mp4Uint32(1), mp4Uint32(1),
    ]))
    const stsz = mp4Box("stsz", Buffer.concat([
      Buffer.alloc(4), mp4Uint32(1), mp4Uint32(1),
    ]))
    const stco = mp4Box("stco", Buffer.concat([
      Buffer.alloc(4), mp4Uint32(1), mp4Uint32(chunkOffset),
    ]))
    const stbl = mp4Box("stbl", Buffer.concat([stsd, stts, stsc, stsz, stco]))
    const handler = Buffer.alloc(12)
    Buffer.from("vide").copy(handler, 8)
    const mdia = mp4Box("mdia", Buffer.concat([
      mp4Box("hdlr", handler),
      mp4Box("minf", stbl),
    ]))
    const tkhd = Buffer.alloc(8)
    tkhd.writeUInt32BE(64 * 65_536, 0)
    tkhd.writeUInt32BE(48 * 65_536, 4)
    const movieHeader = Buffer.alloc(20)
    movieHeader.writeUInt32BE(1_000, 12)
    movieHeader.writeUInt32BE(200, 16)
    return Buffer.concat([
      mp4Box("ftyp", Buffer.alloc(0)),
      mp4Box("moov", Buffer.concat([
        mp4Box("mvhd", movieHeader),
        mp4Box("trak", Buffer.concat([mp4Box("tkhd", tkhd), mdia])),
      ])),
      mp4Box("mdat", Buffer.from([0])),
    ])
  }
  const first = build(0)
  return build(first.byteLength - 1)
}

export const zeroVideoTimingSampleCount = (bytes: Uint8Array): Uint8Array => {
  const result = Buffer.from(bytes)
  const typeOffset = result.indexOf(Buffer.from("stts", "ascii"))
  if (typeOffset < 0) throw new Error("fixture stts box missing")
  result.writeUInt32BE(0, typeOffset + 12)
  return result
}

export const falsifiedVideoMetadataMp4 = (
  bytes: Uint8Array,
  mutation: Readonly<{ width?: number; height?: number; durationUnits?: number }>,
): Uint8Array => {
  const result = Buffer.from(bytes)
  const mvhdTypeOffset = result.indexOf(Buffer.from("mvhd", "ascii"))
  const tkhdTypeOffset = result.indexOf(Buffer.from("tkhd", "ascii"))
  if (mvhdTypeOffset < 4 || tkhdTypeOffset < 4) throw new Error("neutral MP4 metadata layout changed")
  const tkhdBoxStart = tkhdTypeOffset - 4
  const tkhdBoxEnd = tkhdBoxStart + result.readUInt32BE(tkhdBoxStart)
  if (tkhdBoxEnd > result.byteLength || tkhdBoxEnd - tkhdTypeOffset < 12) {
    throw new Error("neutral MP4 track header layout changed")
  }
  if (mutation.width !== undefined) result.writeUInt32BE(mutation.width * 65_536, tkhdBoxEnd - 8)
  if (mutation.height !== undefined) result.writeUInt32BE(mutation.height * 65_536, tkhdBoxEnd - 4)
  if (mutation.durationUnits !== undefined) result.writeUInt32BE(mutation.durationUnits, mvhdTypeOffset + 20)
  return result
}

export const multipleVideoTracksMp4 = (bytes: Uint8Array): Uint8Array => {
  const source = Buffer.from(bytes)
  const moovStart = 32
  const trackStart = 148
  const trackEnd = 752
  const moovEnd = 850
  const videoChunkOffsetField = 748
  const oldMdatContentOffset = 866
  if (
    source.toString("ascii", moovStart + 4, moovStart + 8) !== "moov" ||
    source.toString("ascii", trackStart + 4, trackStart + 8) !== "trak" ||
    source.readUInt32BE(videoChunkOffsetField) !== oldMdatContentOffset
  ) throw new Error("neutral MP4 fixture layout changed")
  const copiedTrack = source.subarray(trackStart, trackEnd)
  const result = Buffer.concat([
    source.subarray(0, moovEnd),
    copiedTrack,
    source.subarray(moovEnd),
  ])
  const shiftedMdatContentOffset = oldMdatContentOffset + copiedTrack.length
  result.writeUInt32BE(source.readUInt32BE(moovStart) + copiedTrack.length, moovStart)
  result.writeUInt32BE(shiftedMdatContentOffset, videoChunkOffsetField)
  result.writeUInt32BE(
    shiftedMdatContentOffset,
    moovEnd + (videoChunkOffsetField - trackStart),
  )
  return result
}

export const hiddenAudioTrackMp4 = (): Uint8Array => {
  const result = Buffer.from(AUDIO_VIDEO_MP4_BYTES)
  const handler = result.indexOf(Buffer.from("soun", "ascii"))
  if (handler < 0 || result.indexOf(Buffer.from("soun", "ascii"), handler + 4) >= 0) {
    throw new Error("audio-video MP4 fixture layout changed")
  }
  result.write("meta", handler, "ascii")
  return result
}

export const hiddenSecondSampleDescriptionMp4 = (): Uint8Array => {
  const source = Buffer.from(hiddenAudioTrackMp4())
  const firstAudioSampleEntry = 3_911
  if (
    source.readUInt32BE(3_907) !== 1 ||
    source.toString("ascii", firstAudioSampleEntry + 4, firstAudioSampleEntry + 8) !== "mp4a"
  ) throw new Error("AAC audio-video MP4 sample-description layout changed")
  const unknownEntry = Buffer.alloc(8)
  unknownEntry.writeUInt32BE(8, 0)
  unknownEntry.write("zzzz", 4, "ascii")
  const result = Buffer.concat([
    source.subarray(0, firstAudioSampleEntry),
    unknownEntry,
    source.subarray(firstAudioSampleEntry),
  ])
  for (const boxStart of [2_882, 3_606, 3_742, 3_827, 3_887, 3_895]) {
    result.writeUInt32BE(result.readUInt32BE(boxStart) + 8, boxStart)
  }
  result.writeUInt32BE(2, 3_907)
  const shiftedAudioStsc = 4_061
  const chunkMapCount = result.readUInt32BE(shiftedAudioStsc + 12)
  for (let index = 0; index < chunkMapCount; index += 1) {
    result.writeUInt32BE(2, shiftedAudioStsc + 24 + index * 12)
  }
  return result
}

export const hiddenUnrecognizedAudioTrackMp4 = (): Uint8Array => {
  const result = Buffer.from(ALAC_VIDEO_MP4_BYTES)
  const handler = result.indexOf(Buffer.from("soun", "ascii"))
  if (handler < 0 || result.indexOf(Buffer.from("soun", "ascii"), handler + 4) >= 0) {
    throw new Error("ALAC audio-video MP4 fixture layout changed")
  }
  result.write("meta", handler, "ascii")
  return result
}

export const malformedAudioTrack = (bytes: Uint8Array): Uint8Array => {
  const source = Buffer.from(bytes)
  const moovStart = 32
  const trackStart = 148
  const trackEnd = 752
  const moovEnd = 850
  const videoHandlerOffset = 340
  const videoCodecOffset = 461
  const videoChunkOffsetField = 748
  const oldMdatContentOffset = 866
  if (
    source.toString("ascii", moovStart + 4, moovStart + 8) !== "moov" ||
    source.toString("ascii", trackStart + 4, trackStart + 8) !== "trak" ||
    source.toString("ascii", videoHandlerOffset, videoHandlerOffset + 4) !== "vide" ||
    source.toString("ascii", videoCodecOffset, videoCodecOffset + 4) !== "avc1" ||
    source.readUInt32BE(videoChunkOffsetField) !== oldMdatContentOffset
  ) {
    throw new Error("neutral MP4 fixture layout changed")
  }
  const copiedTrack = source.subarray(trackStart, trackEnd)
  const result = Buffer.concat([
    source.subarray(0, moovEnd),
    copiedTrack,
    source.subarray(moovEnd),
  ])
  result.writeUInt32BE(source.readUInt32BE(moovStart) + copiedTrack.length, moovStart)
  result.writeUInt32BE(oldMdatContentOffset + copiedTrack.length, videoChunkOffsetField)
  const duplicateTrackStart = moovEnd
  result.write("soun", duplicateTrackStart + (videoHandlerOffset - trackStart), "ascii")
  result.write("zzzz", duplicateTrackStart + (videoCodecOffset - trackStart), "ascii")
  return result
}

export const FIXTURE_TOOL = {
  release: "v0.3.0",
  commit: "1111111111111111111111111111111111111111",
  artifactSha256: "2".repeat(64),
  procedureVersion: "1",
  runSchemaVersion: "1",
  adapterProtocolVersion: "1",
} as const

export type FixtureMutation = Readonly<{
  objective?: (objective: Record<string, unknown>) => void
  contract?: (contract: Record<string, unknown>) => void
  toolLock?: (lock: Record<string, unknown>) => void
  files?: (files: Map<string, Uint8Array>) => void
}>

export const makeFixture = (
  mode: "qwen-image" | "seedance-video",
  mutation: FixtureMutation = {},
): Readonly<{
  files: ApplicationFilesService
  identity: PlanningIdentityService
  objectivePath: string
  documents: RawPlanningDocuments
  reads: ReadonlyArray<string>
}> => {
  const isVideo = mode === "seedance-video"
  const referencePath = isVideo ? "references/neutral.mp4" : "references/neutral.png"
  const referenceBytes = isVideo ? MP4_BYTES : PNG_BYTES
  const procedureId = isVideo ? "seedance-neutral" : "qwen-neutral"
  const payloadDestination = isVideo
    ? "/input_references/0/video_url/url"
    : "/input_references/0/image_url/url"
  const kind = isVideo ? "video" : "image"

  const projectContract: Record<string, unknown> = {
    schemaVersion: "1",
    applicationId: "neutral-fixture",
    referenceRoots: ["references"],
    outputRoot: "generated",
    maximumCount: 4,
    maximumBudgetUsd: "1.00",
    maximumCorrectionRuns: 2,
    procedures: [
      {
        id: "qwen-neutral",
        mode: "qwen-image",
        provider: "openrouter",
        model: "qwen/qwen-image-edit",
        maximumCount: 4,
        unitCostUsd: "0.04",
        referenceRequirements: [
          {
            slot: "source",
            kind: "image",
            payloadDestination: "/input_references/0/image_url/url",
          },
        ],
      },
      {
        id: "seedance-neutral",
        mode: "seedance-video",
        provider: "openrouter",
        model: "bytedance/seedance-1.0-pro",
        maximumCount: 2,
        unitCostUsd: "0.20",
        referenceRequirements: [
          {
            slot: "motion",
            kind: "video",
            payloadDestination: "/input_references/0/video_url/url",
          },
        ],
      },
    ],
  }
  const toolLock: Record<string, unknown> = { ...FIXTURE_TOOL }
  const objective: Record<string, unknown> = {
    schemaVersion: "1",
    id: `${procedureId}-objective`,
    summary: isVideo
      ? "Animate a neutral square using the authoritative motion reference."
      : "Edit a neutral square while preserving the authoritative source.",
    procedureId,
    requestedCount: 1,
    budgetCeilingUsd: isVideo ? "0.25" : "0.05",
    ...(isVideo
      ? {
          videoPlan: {
            assembly: {
              required: false,
              pixelOwnership: "none-authoritative",
            },
            expectedMedia: {
              width: 64,
              height: 48,
              durationSeconds: 0.2,
              audioExpected: false,
            },
          },
        }
      : {}),
    references: [
      {
        slot: isVideo ? "motion" : "source",
        path: referencePath,
        sha256: sha256(referenceBytes),
        kind,
        authorityReason: "Approved neutral fixture evidence.",
        payloadDestination,
        declaredMedia: isVideo
          ? { width: 64, height: 48, durationSeconds: 0.2 }
          : { width: 1, height: 1 },
      },
    ],
  }

  mutation.contract?.(projectContract)
  mutation.toolLock?.(toolLock)
  mutation.objective?.(objective)

  const objectivePath = `objectives/${procedureId}.json`
  const documents = {
    projectContract: JSON.stringify(projectContract),
    toolLock: JSON.stringify(toolLock),
    objective: JSON.stringify(objective),
  }
  const fileMap = new Map<string, Uint8Array>([
    [".qwen-pipeline/project-contract.json", Buffer.from(documents.projectContract)],
    [".qwen-pipeline/tool-lock.json", Buffer.from(documents.toolLock)],
    [objectivePath, Buffer.from(documents.objective)],
    [referencePath, referenceBytes],
  ])
  mutation.files?.(fileMap)
  const reads: Array<string> = []
  const files: ApplicationFilesService = {
    read: (applicationPath) => {
      reads.push(applicationPath)
      const bytes = fileMap.get(applicationPath)
      return bytes === undefined
        ? Effect.fail(new ApplicationReadError("APPLICATION_PATH_MISSING", applicationPath))
        : Effect.succeed({ applicationPath, bytes: Uint8Array.from(bytes) })
    },
  }
  return {
    files,
    identity: { installedTool: FIXTURE_TOOL },
    objectivePath,
    documents,
    reads,
  }
}
