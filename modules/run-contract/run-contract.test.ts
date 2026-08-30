import assert from "node:assert/strict"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  compilePlannedRun,
} from "./index.js"
import { makeFixture } from "../../tests/control-plane-fixture.js"

test("compiles canonical, recursively immutable run evidence", async () => {
  const fixture = makeFixture("qwen-image")
  const [contract, lock, objective] = await Promise.all([
    Effect.runPromise(fixture.files.read(".qwen-pipeline/project-contract.json")),
    Effect.runPromise(fixture.files.read(".qwen-pipeline/tool-lock.json")),
    Effect.runPromise(fixture.files.read(fixture.objectivePath)),
  ])
  const run = await Effect.runPromise(
    compilePlannedRun({
      projectContract: Buffer.from(contract.bytes).toString("utf8"),
      toolLock: Buffer.from(lock.bytes).toString("utf8"),
      objective: Buffer.from(objective.bytes).toString("utf8"),
    }).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )
  assert.equal(run.state, "planned")
  assert.match(run.requestSha256, /^[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(run), true)
  assert.equal(Object.isFrozen(run.request), true)
  assert.equal(Object.isFrozen(run.request.references), true)
  assert.equal(Object.isFrozen(run.request.references[0]), true)
})
