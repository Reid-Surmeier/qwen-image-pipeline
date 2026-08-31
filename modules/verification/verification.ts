import { createHash } from "node:crypto"

import { Effect } from "effect"

import { VerificationError } from "./errors.js"
import type { VerificationInput, VerificationResult } from "./types.js"

type Raster = Readonly<{ width: number; height: number; pixels: ReadonlyArray<number> }>

const decode = (body: Uint8Array): Raster | undefined => {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>
    const { width, height, pixels } = value
    if (
      typeof width !== "number" || !Number.isSafeInteger(width) || width < 1 ||
      typeof height !== "number" || !Number.isSafeInteger(height) || height < 1 ||
      !Array.isArray(pixels) || pixels.length !== width * height * 4 ||
      pixels.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)
    ) return undefined
    return { width, height, pixels: pixels as ReadonlyArray<number> }
  } catch {
    return undefined
  }
}

export const verifyRaster = (input: VerificationInput): Effect.Effect<VerificationResult, VerificationError> =>
  Effect.try({
    try: () => {
      const evidence = [input.baseline, input.donor, input.candidate]
      if (evidence.some((item) => createHash("sha256").update(item.body).digest("hex") !== item.sha256)) {
        throw new VerificationError("INTEGRITY_CHECK_FAILED", "A verification input changed after selection.", [])
      }
      const completed = ["integrity"]
      const baseline = decode(input.baseline.body)
      const donor = decode(input.donor.body)
      const candidate = decode(input.candidate.body)
      if (
        baseline === undefined || donor === undefined || candidate === undefined ||
        baseline.width !== donor.width || baseline.width !== candidate.width ||
        baseline.height !== donor.height || baseline.height !== candidate.height
      ) {
        throw new VerificationError("MEDIA_CHECK_FAILED", "Raster media is invalid or dimensionally inconsistent.", completed)
      }
      completed.push("media")
      if (input.assemblyRequired && input.candidateKind !== "assembled") {
        throw new VerificationError("ASSEMBLY_REQUIRED", "A raw Generation donor cannot bypass required Assembly.", completed)
      }
      const region = input.ownedRegion
      if (
        region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
        region.x + region.width > baseline.width || region.y + region.height > baseline.height
      ) {
        throw new VerificationError("MEDIA_CHECK_FAILED", "The owned region is outside the raster.", completed)
      }
      let outsideChanged = 0
      let donorMismatch = 0
      for (let y = 0; y < baseline.height; y += 1) {
        for (let x = 0; x < baseline.width; x += 1) {
          const offset = (y * baseline.width + x) * 4
          const inside = x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height
          const expected = inside ? donor.pixels : baseline.pixels
          if (candidate.pixels.slice(offset, offset + 4).some((channel, index) => channel !== expected[offset + index])) {
            if (inside) donorMismatch += 1
            else outsideChanged += 1
          }
        }
      }
      if (outsideChanged !== 0 || donorMismatch !== 0) {
        throw new VerificationError(
          "FIDELITY_CHECK_FAILED",
          `Fidelity failed: ${outsideChanged} outside-region changes and ${donorMismatch} donor mismatches.`,
          completed,
        )
      }
      return {
        classification: "verified-candidate" as const,
        candidateSha256: input.candidate.sha256,
        checks: [
          { name: "integrity" as const, passed: true as const, measured: 0 },
          { name: "media" as const, passed: true as const, measured: 0 },
          { name: "outside-region-preservation" as const, passed: true as const, measured: outsideChanged },
          { name: "donor-equality-inside-region" as const, passed: true as const, measured: donorMismatch },
        ],
      }
    },
    catch: (error) => error instanceof VerificationError
      ? error
      : new VerificationError("INTEGRITY_CHECK_FAILED", "Verification inputs could not be checked.", []),
  })
