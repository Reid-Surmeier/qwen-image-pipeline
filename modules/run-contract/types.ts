import { Context } from "effect"

export type ToolIdentity = Readonly<{
  release: string
  commit: string
  artifactSha256: string
  procedureVersion: string
  runSchemaVersion: string
  adapterProtocolVersion: string
}>

export interface PlanningIdentityService {
  readonly installedTool: ToolIdentity
}

export const PlanningIdentity = Context.Service<
  PlanningIdentityService
>("qwen-pipeline/PlanningIdentity")

export type RawPlanningDocuments = Readonly<{
  projectContract: string
  toolLock: string
  objective: string
}>

export type LinkedRunRelationship = Readonly<{
  parentRunId: string
  parentFailureEventSha256: string
  relation: "retry-after-definitive-pre-submit-failure"
}>

export type AssemblyPlan = Readonly<{
  required: true
  baselineReferenceSlot: string
  paletteMaxGrowth?: number
  ownedRegion: Readonly<{
    x: number
    y: number
    width: number
    height: number
  }>
  exactCopy: ReadonlyArray<Readonly<{
    x: number
    y: number
    rgba: readonly [number, number, number, number]
    sha256: string
  }>>
}>

export type QwenImageParameters = Readonly<{
  resolution: "1K" | "2K"
  aspectRatio: "1:1" | "1:2" | "1:4" | "2:1" | "2:3" | "3:2" | "3:4" | "4:1" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9"
  seed: number
}>

export type VideoPlan = Readonly<{
  assembly: Readonly<{
    required: false
    pixelOwnership: "none-authoritative"
  }>
  expectedMedia: Readonly<{
    width: number
    height: number
    durationSeconds: number
    audioExpected: boolean
  }>
}>

export type CanonicalRunRequest = Readonly<{
  schemaVersion: string
  applicationId: string
  objectiveId: string
  objective: string
  procedureId: string
  mode: "qwen-image" | "seedance-video"
  provider: "openrouter"
  model: string
  imageParameters?: QwenImageParameters
  adapterProtocolVersion: string
  requestedCount: number
  estimatedMaximumCostUsd: string
  budgetCeilingUsd: string
  maximumCorrectionRuns: number
  artifactRoot: string
  outputRoot: string
  linkedRun?: LinkedRunRelationship
  assemblyPlan?: AssemblyPlan
  videoPlan?: VideoPlan
  references: ReadonlyArray<{
    slot: string
    applicationPath: string
    sha256: string
    byteLength: number
    kind: "image" | "video"
    mediaType: "image/png" | "video/mp4" | "application/vnd.qwen.rgba+json"
    authorityReason: string
    payloadDestination: string
    inspectedMedia: Readonly<{
      kind: "image" | "video"
      mediaType: "image/png" | "video/mp4" | "application/vnd.qwen.rgba+json"
      width: number
      height: number
      durationSeconds?: number
    }>
  }>
  tool: ToolIdentity
}>

export type PlannedRun = Readonly<{
  state: "planned"
  request: CanonicalRunRequest
  canonicalRequest: string
  requestSha256: string
}>
