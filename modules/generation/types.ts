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

export interface GenerationAdapterService {
  readonly invoke: (
    prepared: PreparedGeneration,
  ) => Effect.Effect<GenerationResult, GenerationError>
  readonly recover?: (
    prepared: PreparedGeneration,
    providerEvidence: GenerationProviderEvidence,
  ) => Effect.Effect<GenerationResult, GenerationError>
}

export const GenerationAdapter = Context.Service<GenerationAdapterService>(
  "qwen-pipeline/GenerationAdapter",
)
