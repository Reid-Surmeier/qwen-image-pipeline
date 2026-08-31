import { createHash } from "node:crypto"

import { Effect } from "effect"

import { AssemblyError } from "./errors.js"
import type { AssemblyInput, AssemblyResult } from "./types.js"

type Raster = Readonly<{ width: number; height: number; pixels: ReadonlyArray<number> }>

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const parseRaster = (body: Uint8Array): Raster => {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"))
  } catch {
    throw new AssemblyError("RASTER_INVALID", "Raster evidence must be valid JSON.")
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AssemblyError("RASTER_INVALID", "Raster evidence must be an object.")
  }
  const { width, height, pixels } = value as Record<string, unknown>
  if (
    typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
    typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
    !Array.isArray(pixels) || pixels.length !== width * height * 4 ||
    pixels.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    throw new AssemblyError("RASTER_INVALID", "Raster dimensions and RGBA channels are invalid.")
  }
  return { width, height, pixels: pixels as ReadonlyArray<number> }
}

const verifiedRaster = (evidence: AssemblyInput["baseline"]): Raster => {
  if (!/^[a-f0-9]{64}$/.test(evidence.sha256) || sha256(evidence.body) !== evidence.sha256) {
    throw new AssemblyError("ASSEMBLY_INPUT_HASH_MISMATCH", "A raster input changed after it was selected.")
  }
  return parseRaster(evidence.body)
}

export const assembleRaster = (input: AssemblyInput): Effect.Effect<AssemblyResult, AssemblyError> =>
  Effect.try({
    try: () => {
      const baseline = verifiedRaster(input.baseline)
      const donor = verifiedRaster(input.donor)
      if (baseline.width !== donor.width || baseline.height !== donor.height) {
        throw new AssemblyError("RASTER_INVALID", "Baseline and donor dimensions must match.")
      }
      const region = input.ownedRegion
      if (
        ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
        region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
        region.x + region.width > baseline.width || region.y + region.height > baseline.height
      ) {
        throw new AssemblyError("OWNED_REGION_INVALID", "The owned region must remain inside the baseline.")
      }
      const pixels = [...baseline.pixels]
      for (let y = region.y; y < region.y + region.height; y += 1) {
        for (let x = region.x; x < region.x + region.width; x += 1) {
          const offset = (y * baseline.width + x) * 4
          pixels.splice(offset, 4, ...donor.pixels.slice(offset, offset + 4))
        }
      }
      for (const copy of input.exactCopy) {
        const core = { x: copy.x, y: copy.y, rgba: copy.rgba }
        if (
          sha256(JSON.stringify(core)) !== copy.sha256 ||
          !Number.isSafeInteger(copy.x) || !Number.isSafeInteger(copy.y) ||
          copy.x < region.x || copy.y < region.y ||
          copy.x >= region.x + region.width || copy.y >= region.y + region.height ||
          !Array.isArray(copy.rgba) || copy.rgba.length !== 4 ||
          copy.rgba.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
        ) {
          throw new AssemblyError("EXACT_COPY_HASH_MISMATCH", "Exact Copy must be hash-locked inside the owned region.")
        }
        pixels.splice((copy.y * baseline.width + copy.x) * 4, 4, ...copy.rgba)
      }
      const body = Buffer.from(JSON.stringify({ height: baseline.height, pixels, width: baseline.width }), "utf8")
      const outputSha256 = sha256(body)
      return {
        output: {
          applicationPath: "outputs/assembled.rgba.json" as const,
          mediaType: "application/vnd.qwen.rgba+json" as const,
          body,
          sha256: outputSha256,
        },
        report: {
          baselineSha256: input.baseline.sha256,
          donorSha256: input.donor.sha256,
          regionSha256: sha256(JSON.stringify(region)),
          exactCopySha256: sha256(JSON.stringify(input.exactCopy.map((copy) => copy.sha256))),
          outputSha256,
        },
      }
    },
    catch: (error) => error instanceof AssemblyError
      ? error
      : new AssemblyError("RASTER_INVALID", "Assembly inputs could not be decoded."),
  })
