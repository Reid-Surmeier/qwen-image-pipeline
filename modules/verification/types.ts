import type { OwnedRegion, RasterEvidence } from "../assembly/index.js"

export type VerificationInput = Readonly<{
  baseline: RasterEvidence
  donor: RasterEvidence
  candidate: RasterEvidence
  ownedRegion: OwnedRegion
  assemblyRequired: boolean
  candidateKind: "raw-generation" | "assembled"
}>

export type VerificationResult = Readonly<{
  classification: "verified-candidate"
  candidateSha256: string
  checks: ReadonlyArray<Readonly<{
    name: "integrity" | "media" | "outside-region-preservation" | "donor-equality-inside-region"
    passed: true
    measured: number
  }>>
}>
