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
    assemblyRequired: true,
    candidateKind: "raw-generation",
  })))
  assert.equal(error.code, "ASSEMBLY_REQUIRED")
  assert.deepEqual(error.checks, ["integrity", "media"])
})

test("rejects a raw donor even when the caller labels it assembled", async () => {
  const error = await Effect.runPromise(Effect.flip(verify({
    baseline,
    donor,
    candidate: donor,
    ownedRegion,
    exactCopy,
    assemblyRequired: true,
    candidateKind: "assembled",
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
    assemblyRequired: true,
    candidateKind: "assembled",
  }))
  assert.equal(result.classification, "verified-candidate")
  assert.deepEqual(result.checks.map((check) => [check.name, check.measured]), [
    ["integrity", 0],
    ["media", 0],
    ["outside-region-preservation", 0],
    ["donor-equality-inside-region", 0],
  ])
})

test("binds a verified candidate to the canonical Assembly report instead of its caller label", async () => {
  const assembly = await Effect.runPromise(assemble({ baseline, donor, ownedRegion, exactCopy }))
  const result = await Effect.runPromise(verify({
    baseline,
    donor,
    candidate: assembly.output,
    ownedRegion,
    exactCopy,
    assemblyRequired: true,
    candidateKind: "raw-generation",
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
    assemblyRequired: true,
    candidateKind: "assembled",
  })))
  assert.equal(error.code, "FIDELITY_CHECK_FAILED")
})
