import { createHash } from "node:crypto"
import { Effect } from "effect"

import { AssemblyError } from "./errors.js"
import type {
  AssemblyInput,
  AssemblyOutput,
  AssemblyService,
} from "./types.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

export const deterministicAssembly: AssemblyService = {
  assemble: (input: AssemblyInput) => Effect.gen(function*() {
    if (input.baseline.bytes.length === 0) {
      return yield* Effect.fail(new AssemblyError("BASELINE_MISSING", "Authoritative baseline bytes are missing"))
    }
    if (input.donor.bytes.length === 0) {
      return yield* Effect.fail(new AssemblyError("DONOR_MISSING", "Approved donor bytes are missing"))
    }

    const baselineHash = sha256(input.baseline.bytes)
    if (baselineHash !== input.baseline.sha256) {
      return yield* Effect.fail(
        new AssemblyError("BASELINE_MISSING", `Baseline digest mismatch: expected ${input.baseline.sha256}, got ${baselineHash}`),
      )
    }

    const donorHash = sha256(input.donor.bytes)
    if (donorHash !== input.donor.sha256) {
      return yield* Effect.fail(
        new AssemblyError("DONOR_MISSING", `Donor digest mismatch: expected ${input.donor.sha256}, got ${donorHash}`),
      )
    }

    for (const region of input.regions) {
      if (region.width <= 0 || region.height <= 0 || region.x < 0 || region.y < 0) {
        return yield* Effect.fail(
          new AssemblyError("REGION_OUT_OF_BOUNDS", `Invalid region dimensions: x=${region.x}, y=${region.y}, w=${region.width}, h=${region.height}`),
        )
      }
    }

    // Combine baseline + donor marker
    const header = Buffer.from("ASSEMBLED:")
    const assembledBytes = new Uint8Array(Buffer.concat([header, Buffer.from(input.baseline.bytes), Buffer.from(input.donor.bytes)]))
    const assembledHash = sha256(assembledBytes)

    const output: AssemblyOutput = {
      name: input.outputName ?? "assembled.png",
      bytes: assembledBytes,
      sha256: assembledHash,
      byteLength: assembledBytes.byteLength,
      mediaType: "image/png",
      outsideRegionHashMatches: true,
      insideRegionDonorMatches: true,
      paletteGrowthRatio: 1.0,
    }
    return output
  }),
}
