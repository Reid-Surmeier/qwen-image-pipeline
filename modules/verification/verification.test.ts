import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { Effect } from "effect"

import { assemble } from "../assembly/index.js"
import { verify } from "./index.js"

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex")

const raster = (pixels: ReadonlyArray<number>) => {
  const body = Buffer.from(JSON.stringify({ height: 2, pixels, width: 2 }), "utf8")
  return { body, sha256: sha256(body) }
}

const baseline = raster([
  10, 10, 10, 255, 20, 20, 20, 255,
  30, 30, 30, 255, 40, 40, 40, 255,
])
const donor = raster([
  90, 90, 90, 255, 80, 80, 80, 255,
  70, 70, 70, 255, 60, 60, 60, 255,
])
const assembled = raster([
  10, 10, 10, 255, 5, 6, 7, 255,
  30, 30, 30, 255, 60, 60, 60, 255,
])
const ownedRegion = { x: 1, y: 0, width: 1, height: 2 }
const exactCopyCore = { x: 1, y: 0, rgba: [5, 6, 7, 255] as const }
const exactCopy = [{ ...exactCopyCore, sha256: sha256(JSON.stringify(exactCopyCore)) }]

test("rejects a raw generated donor when Assembly is required", async () => {
  const error = await Effect.runPromise(Effect.flip(verify({
    baseline,
    donor,
    candidate: donor,
    ownedRegion,
    exactCopy,
  })))
  assert.equal(error.code, "ASSEMBLY_REQUIRED")
  assert.deepEqual(error.checks, ["integrity", "media"])
})

test("does not accept a caller-controlled flag that claims Assembly is optional", async () => {
  const input = {
    baseline,
    donor,
    candidate: donor,
    ownedRegion,
    exactCopy,
    assemblyRequired: false,
  }
  const error = await Effect.runPromise(Effect.flip(verify(input)))
  assert.equal(error.code, "ASSEMBLY_REQUIRED")
})

test("rejects a raw donor by its hash-locked identity", async () => {
  const error = await Effect.runPromise(Effect.flip(verify({
    baseline,
    donor,
    candidate: donor,
    ownedRegion,
    exactCopy,
  })))
  assert.equal(error.code, "ASSEMBLY_REQUIRED")
  assert.deepEqual(error.checks, ["integrity", "media"])
})

test("proves independent zero-drift and donor-equality truths in mandatory order", async () => {
  const result = await Effect.runPromise(verify({
    baseline,
    donor,
    candidate: assembled,
    ownedRegion,
    exactCopy,
  }))
  assert.equal(result.classification, "verified-candidate")
  assert.deepEqual(result.checks.map((check) => [check.name, check.measured]), [
    ["integrity", 0],
    ["media", 0],
    ["outside-region-preservation", 0],
    ["donor-equality-inside-region", 0],
    ["palette-growth", 1],
  ])
})

test("rejects flat-band palette growth beyond the immutable tolerance", async () => {
  const wideRaster = (pixels: ReadonlyArray<number>) => {
    const body = Buffer.from(JSON.stringify({ height: 1, pixels, width: 6 }), "utf8")
    return { body, sha256: sha256(body) }
  }
  const flatBaseline = wideRaster([
    0, 0, 0, 255,
    10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255,
    20, 20, 20, 255,
  ])
  const continuousDonor = wideRaster([
    90, 90, 90, 255,
    1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255,
    80, 80, 80, 255,
  ])
  const candidate = wideRaster([
    0, 0, 0, 255,
    1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255,
    20, 20, 20, 255,
  ])
  const error = await Effect.runPromise(Effect.flip(verify({
    baseline: flatBaseline,
    donor: continuousDonor,
    candidate,
    ownedRegion: { x: 1, y: 0, width: 4, height: 1 },
    exactCopy: [],
    paletteMaxGrowth: 2,
  })))
  assert.equal(error.code, "FIDELITY_CHECK_FAILED")
  assert.match(error.message, /1 to 4 colours/)
})

test("binds a verified candidate to the canonical Assembly report", async () => {
  const assembly = await Effect.runPromise(assemble({ baseline, donor, ownedRegion, exactCopy }))
  const result = await Effect.runPromise(verify({
    baseline,
    donor,
    candidate: assembly.output,
    ownedRegion,
    exactCopy,
  }))
  assert.equal(result.candidateSha256, assembly.output.sha256)
  assert.deepEqual(result.assemblyReport, assembly.report)
})

test("rejects a candidate that restores donor pixels over Exact Copy", async () => {
  const error = await Effect.runPromise(Effect.flip(verify({
    baseline,
    donor,
    candidate: raster([
      10, 10, 10, 255, 80, 80, 80, 255,
      30, 30, 30, 255, 60, 60, 60, 255,
    ]),
    ownedRegion,
    exactCopy,
  })))
  assert.equal(error.code, "FIDELITY_CHECK_FAILED")
})

test("rejects non-finite and non-safe-integer owned regions before fidelity checks", async () => {
  for (const [name, invalid] of [
    ["NaN", { x: Number.NaN, y: 0, width: 1, height: 2 }],
    ["fractional", { x: 0.5, y: 0, width: 1, height: 2 }],
    ["unsafe integer", { x: Number.MAX_SAFE_INTEGER + 1, y: 0, width: 1, height: 2 }],
  ] as const) {
    const error = await Effect.runPromise(Effect.flip(verify({
      baseline,
      donor,
      candidate: assembled,
      ownedRegion: invalid,
      exactCopy,
    })))
    assert.equal(error.code, "MEDIA_CHECK_FAILED", name)
  }
})

test("rejects malformed Exact Copy coordinates and channel counts", async () => {
  const malformedCores: ReadonlyArray<Readonly<{ x: number; y: number; rgba: ReadonlyArray<number> }>> = [
    { x: 1.5, y: 0, rgba: [5, 6, 7, 255] },
    { x: 1, y: Number.MAX_SAFE_INTEGER + 1, rgba: [5, 6, 7, 255] },
    { x: 1, y: 0, rgba: [5, 6, 7] },
    { x: 1, y: 0, rgba: [5, 6, 7, 255, 0] },
  ]
  for (const core of malformedCores) {
    const error = await Effect.runPromise(Effect.flip(verify({
      baseline,
      donor,
      candidate: assembled,
      ownedRegion,
      exactCopy: [{ ...core, sha256: sha256(JSON.stringify(core)) }] as never,
    })))
    assert.equal(error.code, "MEDIA_CHECK_FAILED")
  }
})
