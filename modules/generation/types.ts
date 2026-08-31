import { Context, type Effect } from "effect"

import type { CanonicalRunRequest } from "../run-contract/index.js"
import type { GenerationError } from "./errors.js"

export type GenerationReference = Readonly<{
  slot: string
  applicationPath: string
  sha256: string
  payloadDestination: string
  mediaType: "image/png" | "video/mp4" | "application/vnd.qwen.rgba+json"
  bytes: Uint8Array
}>

export type PreparedGeneration = Readonly<{
  request: CanonicalRunRequest
  requestSha256: string
  payload: Readonly<Record<string, unknown>>
  payloadBytes: Uint8Array
  payloadSha256: string
}>

export type GeneratedArtifact = Readonly<{
  applicationPath: string
  mediaType: "application/vnd.qwen.rgba+json"
  body: Uint8Array
  sha256: string
}>

export type GenerationProviderEvidence = Readonly<{
  mediaType: "application/json"
  body: Uint8Array
  sha256: string
}>

export type GenerationResult = Readonly<{
  provider: "openrouter"
  model: string
  providerEvidence: GenerationProviderEvidence
  outputs: ReadonlyArray<GeneratedArtifact>
}>

export type SeedanceSubmission = Readonly<{
  provider: "openrouter"
  model: string
  jobId: string
  providerEvidence: GenerationProviderEvidence
}>

export type SeedanceVideoArtifact = Readonly<{
  applicationPath: `outputs/${string}.mp4`
  mediaType: "video/mp4"
  body: Uint8Array
  sha256: string
}>

export type SeedanceCostEvidence = Readonly<{
  state: "actual" | "estimated-only" | "unknown"
  actualCostUsd?: string
}>

export type SeedancePollResult =
  | Readonly<{
      status: "pending"
      provider: "openrouter"
      model: string
      jobId: string
      providerEvidence: GenerationProviderEvidence
    }>
  | Readonly<{
      status: "completed"
      provider: "openrouter"
      model: string
      jobId: string
      providerEvidence: GenerationProviderEvidence
      outputs: ReadonlyArray<SeedanceVideoArtifact>
      completedCount: number
      cost: SeedanceCostEvidence
    }>

export interface GenerationAdapterService {
  readonly invoke: (
    prepared: PreparedGeneration,
  ) => Effect.Effect<GenerationResult, GenerationError>
  readonly recover?: (
    prepared: PreparedGeneration,
    providerEvidence: GenerationProviderEvidence,
  ) => Effect.Effect<GenerationResult, GenerationError>
  readonly submitSeedance?: (
    prepared: PreparedGeneration,
  ) => Effect.Effect<SeedanceSubmission, GenerationError>
  readonly pollSeedance?: (
    prepared: PreparedGeneration,
    jobId: string,
    submissionEvidence: GenerationProviderEvidence,
  ) => Effect.Effect<SeedancePollResult, GenerationError>
}

export const GenerationAdapter = Context.Service<GenerationAdapterService>(
  "qwen-pipeline/GenerationAdapter",
)
