import { Context, type Effect } from "effect"

import type { ApplicationReadError, MediaInspectionError } from "./errors.js"

export type MediaKind = "image" | "video"

export type MediaProperties = Readonly<{
  width: number
  height: number
  durationSeconds?: number
}>

export type FileSnapshot = Readonly<{
  applicationPath: string
  bytes: Uint8Array
}>

export interface ApplicationFilesService {
  readonly read: (
    applicationPath: string,
  ) => Effect.Effect<FileSnapshot, ApplicationReadError>
}

export const ApplicationFiles = Context.Service<
  ApplicationFilesService
>("qwen-pipeline/ApplicationFiles")

export interface MediaInspectorService {
  readonly inspect: (
    snapshot: Readonly<FileSnapshot & { sha256: string }>,
  ) => Effect.Effect<MediaProperties, MediaInspectionError>
}

export const MediaInspector = Context.Service<
  MediaInspectorService
>("qwen-pipeline/MediaInspector")

export type ReferenceRequirement = Readonly<{
  slot: string
  kind: MediaKind
  payloadDestination: string
}>

export type ReferenceCandidate = Readonly<{
  slot: string
  path: string
  sha256: string
  kind: MediaKind
  authorityReason: string
  payloadDestination: string
  declaredMedia?: MediaProperties
}>

export type ReferencePlanningInput = Readonly<{
  mode: "qwen-image" | "seedance-video"
  referenceRoots: ReadonlyArray<string>
  requirements: ReadonlyArray<ReferenceRequirement>
  candidates: ReadonlyArray<ReferenceCandidate>
}>

export type LockedReference = Readonly<{
  slot: string
  applicationPath: string
  sha256: string
  byteLength: number
  kind: MediaKind
  authorityReason: string
  payloadDestination: string
  inspectedMedia: MediaProperties
}>

export type ReferencePlan = Readonly<{
  references: ReadonlyArray<LockedReference>
}>
