import { Context, type Effect } from "effect"

import type { AssemblyError } from "./errors.js"

export type EditRegion = Readonly<{
  x: number
  y: number
  width: number
  height: number
}>

export type ExactCopyElement = Readonly<{
  text: string
  x: number
  y: number
  font?: string | undefined
}>

export type AssemblyInput = Readonly<{
  baseline: Readonly<{
    path: string
    bytes: Uint8Array
    sha256: string
  }>
  donor: Readonly<{
    name: string
    bytes: Uint8Array
    sha256: string
  }>
  regions: ReadonlyArray<EditRegion>
  exactCopy?: ReadonlyArray<ExactCopyElement> | undefined
  outputName?: string | undefined
}>

export type AssemblyOutput = Readonly<{
  name: string
  bytes: Uint8Array
  sha256: string
  byteLength: number
  mediaType: string
  outsideRegionHashMatches: boolean
  insideRegionDonorMatches: boolean
  paletteGrowthRatio?: number | undefined
}>

export interface AssemblyService {
  readonly assemble: (
    input: AssemblyInput,
  ) => Effect.Effect<AssemblyOutput, AssemblyError>
}

export const Assembly = Context.Service<
  AssemblyService
>("qwen-pipeline/Assembly")
