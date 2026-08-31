import assert from "node:assert/strict"
import test from "node:test"

import { createHash } from "node:crypto"
import { Effect } from "effect"

import {
  AssemblyError,
  deterministicAssembly,
  type AssemblyInput,
} from "./index.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

test("assembles donor onto baseline with preservation verification", async () => {
  const baselineBytes = Buffer.from("BASELINE_PIXELS")
  const donorBytes = Buffer.from("DONOR_PIXELS")

  const input: AssemblyInput = {
    baseline: {
      path: "references/source.png",
      bytes: new Uint8Array(baselineBytes),
      sha256: sha256(baselineBytes),
    },
    donor: {
      name: "output-01.png",
      bytes: new Uint8Array(donorBytes),
      sha256: sha256(donorBytes),
    },
    regions: [{ x: 10, y: 10, width: 20, height: 20 }],
  }

  const result = await Effect.runPromise(deterministicAssembly.assemble(input))
  assert.equal(result.name, "assembled.png")
  assert.equal(result.outsideRegionHashMatches, true)
  assert.equal(result.insideRegionDonorMatches, true)
  assert.equal(result.paletteGrowthRatio, 1.0)
})

test("refuses assembly when baseline or donor digest does not match", async () => {
  const baselineBytes = Buffer.from("BASELINE_PIXELS")
  const donorBytes = Buffer.from("DONOR_PIXELS")

  const badInput: AssemblyInput = {
    baseline: {
      path: "references/source.png",
      bytes: new Uint8Array(baselineBytes),
      sha256: "wrong-sha256",
    },
    donor: {
      name: "output-01.png",
      bytes: new Uint8Array(donorBytes),
      sha256: sha256(donorBytes),
    },
    regions: [{ x: 10, y: 10, width: 20, height: 20 }],
  }

  await assert.rejects(
    Effect.runPromise(deterministicAssembly.assemble(badInput)),
    (err: unknown) => err instanceof AssemblyError && err.code === "BASELINE_MISSING",
  )
})
