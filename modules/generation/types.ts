import { Context, type Effect } from "effect"

import type { CanonicalRunRequest } from "../run-contract/index.js"
import type { AttemptReservation, OutputFile, PersistedOutput } from "../run-record/index.js"
import type { GenerationError } from "./errors.js"

export type GenerationRequest = Readonly<{
  request: CanonicalRunRequest
  attempt: AttemptReservation
  referencesData?: ReadonlyArray<{
    slot: string
    payloadDestination: string
    bytes: Uint8Array
    sha256: string
    mediaType: string
  }> | undefined
}>

export type GeneratedOutput = Readonly<
  PersistedOutput & {
    bytes: Uint8Array
  }
>

export type GenerationResult = Readonly<{
  status: number
  bodyDigest: string
  sanitizedBody?: Readonly<Record<string, unknown>> | undefined
  safeIdentifiers: ReadonlyArray<string>
  outputs: ReadonlyArray<GeneratedOutput>
  usage?: Readonly<Record<string, unknown>> | undefined
  costUsd?: string | undefined
  jobId?: string | undefined
}>

export interface GenerationAdapterService {
  readonly execute: (
    generationRequest: GenerationRequest,
  ) => Effect.Effect<GenerationResult, GenerationError>

  readonly poll: (
    jobId: string,
    generationRequest: GenerationRequest,
  ) => Effect.Effect<GenerationResult, GenerationError>
}

export const GenerationAdapter = Context.Service<
  GenerationAdapterService
>("qwen-pipeline/GenerationAdapter")
