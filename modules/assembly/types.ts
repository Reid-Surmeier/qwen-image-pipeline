export type OwnedRegion = Readonly<{ x: number; y: number; width: number; height: number }>

export type ExactCopyPixel = Readonly<{
  x: number
  y: number
  rgba: readonly [number, number, number, number]
  sha256: string
}>

export type RasterEvidence = Readonly<{
  body: Uint8Array
  sha256: string
}>

export type AssemblyInput = Readonly<{
  baseline: RasterEvidence
  donor: RasterEvidence
  ownedRegion: OwnedRegion
  exactCopy: ReadonlyArray<ExactCopyPixel>
}>

export type AssemblyResult = Readonly<{
  output: Readonly<{
    applicationPath: "outputs/assembled.rgba.json"
    mediaType: "application/vnd.qwen.rgba+json"
    body: Uint8Array
    sha256: string
  }>
  report: Readonly<{
    baselineSha256: string
    donorSha256: string
    regionSha256: string
    exactCopySha256: string
    outputSha256: string
  }>
}>
