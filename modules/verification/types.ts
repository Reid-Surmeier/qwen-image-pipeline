import type { AssemblyResult, ExactCopyPixel, OwnedRegion, RasterEvidence } from "../assembly/index.js"

export type VerificationInput = Readonly<{
  baseline: RasterEvidence
  donor: RasterEvidence
  candidate: RasterEvidence
  ownedRegion: OwnedRegion
  exactCopy: ReadonlyArray<ExactCopyPixel>
  paletteMaxGrowth?: number
}>

export type VerificationResult = Readonly<{
  classification: "verified-candidate"
  candidateSha256: string
  assemblyReport: AssemblyResult["report"]
  checks: ReadonlyArray<Readonly<{
    name: "integrity" | "media" | "outside-region-preservation" | "donor-equality-inside-region" | "palette-growth"
    passed: true
    measured: number
  }>>
}>
