import { createHash } from "node:crypto"

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

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

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
