import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { assemble, type ExactCopyPixel } from "./index.js"

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const raster = (pixels: ReadonlyArray<number>): Readonly<{ body: Uint8Array; sha256: string }> => {
  const body = Buffer.from(JSON.stringify({ height: 2, pixels, width: 2 }), "utf8")
  return { body, sha256: sha256(body) }
}

test("assembles a donor and hash-locked Exact Copy only inside the owned region", async () => {
  const baseline = raster([
    10, 10, 10, 255, 20, 20, 20, 255,
    30, 30, 30, 255, 40, 40, 40, 255,
  ])
  const donor = raster([
    90, 90, 90, 255, 80, 80, 80, 255,
    70, 70, 70, 255, 60, 60, 60, 255,
  ])
  const copyCore = { x: 1, y: 0, rgba: [5, 6, 7, 255] as const }
  const exactCopy: ExactCopyPixel = {
    ...copyCore,
    sha256: sha256(JSON.stringify(copyCore)),
  }
  const result = await Effect.runPromise(assemble({
    baseline,
    donor,
    ownedRegion: { x: 1, y: 0, width: 1, height: 2 },
    exactCopy: [exactCopy],
  }))

  assert.deepEqual(JSON.parse(Buffer.from(result.output.body).toString("utf8")), {
    height: 2,
    pixels: [
      10, 10, 10, 255, 5, 6, 7, 255,
      30, 30, 30, 255, 60, 60, 60, 255,
    ],
    width: 2,
  })
  assert.equal(result.output.sha256, sha256(result.output.body))
  assert.equal(result.report.baselineSha256, baseline.sha256)
  assert.equal(result.report.donorSha256, donor.sha256)
  assert.equal(result.report.outputSha256, result.output.sha256)
  assert.match(result.report.regionSha256, /^[a-f0-9]{64}$/)
  assert.match(result.report.exactCopySha256, /^[a-f0-9]{64}$/)
})

test("refuses a changed baseline or Exact Copy before composition", async () => {
  const valid = raster(new Array(16).fill(0))
  const wrongHash = { ...valid, sha256: "0".repeat(64) }
  const error = await Effect.runPromise(Effect.flip(assemble({
    baseline: wrongHash,
    donor: valid,
    ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
    exactCopy: [],
  })))
  assert.equal(error.code, "ASSEMBLY_INPUT_HASH_MISMATCH")
})
