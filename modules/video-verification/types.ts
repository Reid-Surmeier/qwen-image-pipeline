export type VideoArtifact = Readonly<{
  applicationPath: `outputs/${string}.mp4`
  mediaType: "video/mp4"
  body: Uint8Array
  sha256: string
}>

export type VideoExpectation = Readonly<{
  width: number
  height: number
  durationSeconds: number
  audioExpected: boolean
}>

export type VideoCostEvidence = Readonly<{
  state: "actual" | "estimated-only" | "unknown"
  estimatedMaximumCostUsd: string
  actualCostUsd?: string
}>

export type VerifyVideoInput = Readonly<{
  outputs: ReadonlyArray<VideoArtifact>
  expected: VideoExpectation
  requestedCount: number
  completedCount: number
  cost: VideoCostEvidence
}>

export type VideoCheck = Readonly<{
  name: "integrity" | "media" | "dimensions" | "duration" | "audio-expectation"
  passed: true
  measured: number
}>

export type VideoVerification = Readonly<{
  algorithm: "seedance-media-v1"
  classification: "verified-candidate"
  outputs: ReadonlyArray<Readonly<{
    applicationPath: `outputs/${string}.mp4`
    mediaType: "video/mp4"
    sha256: string
    actual: Readonly<{
      width: number
      height: number
      durationSeconds: number
      hasAudio: boolean
    }>
  }>>
  requestedCount: number
  completedCount: number
  expected: VideoExpectation
  cost: VideoCostEvidence
  checks: ReadonlyArray<VideoCheck>
}>
