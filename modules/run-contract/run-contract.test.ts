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

const compileFixture = (fixture: ReturnType<typeof makeFixture>) =>
  Effect.runPromise(
    compilePlannedRun(fixture.documents).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, fixture.identity),
    ),
  )

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
  assert.equal("assemblyPlan" in run.request, false)
})

test("seals a hash-locked Assembly plan into an immutable Qwen Run Request", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
        exactCopy: [
          {
            x: 0,
            y: 0,
            rgba: [255, 0, 0, 255],
            sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
          },
        ],
      }
    },
  })

  const run = await compileFixture(fixture)

  assert.deepEqual(run.request.assemblyPlan, {
    required: true,
    baselineReferenceSlot: "source",
    ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
    exactCopy: [
      {
        x: 0,
        y: 0,
        rgba: [255, 0, 0, 255],
        sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
      },
    ],
  })
  assert.equal(Object.isFrozen(run.request.assemblyPlan), true)
  assert.equal(Object.isFrozen(run.request.assemblyPlan?.ownedRegion), true)
  assert.equal(Object.isFrozen(run.request.assemblyPlan?.exactCopy), true)
  assert.equal(Object.isFrozen(run.request.assemblyPlan?.exactCopy[0]?.rgba), true)
})

test("rejects malformed Assembly geometry with a named Run Contract error", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 0, height: 1 },
        exactCopy: [
          {
            x: 0,
            y: 0,
            rgba: [255, 0, 0, 255],
            sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
          },
        ],
      }
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ASSEMBLY_PLAN_INVALID",
  )
})

test("rejects an Assembly region outside the inspected locked baseline", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 2, height: 1 },
        exactCopy: [
          {
            x: 0,
            y: 0,
            rgba: [255, 0, 0, 255],
            sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
          },
        ],
      }
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ASSEMBLY_PLAN_INVALID",
  )
})

test("requires at least one Exact Copy pixel in an Assembly plan", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
        exactCopy: [],
      }
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ASSEMBLY_PLAN_INVALID",
  )
})

test("rejects Exact Copy hash drift with a named Run Contract error", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
        exactCopy: [
          {
            x: 0,
            y: 0,
            rgba: [255, 0, 0, 255],
            sha256: "0".repeat(64),
          },
        ],
      }
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ASSEMBLY_PLAN_INVALID",
  )
})

test("rejects an Exact Copy pixel outside the owned Assembly region", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.assemblyPlan = {
        required: true,
        baselineReferenceSlot: "source",
        ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
        exactCopy: [
          {
            x: 1,
            y: 0,
            rgba: [255, 0, 0, 255],
            sha256: "6a9708f894b9842d8f200edec69e21f0d68104dae09362bb98a4ef288180fd70",
          },
        ],
      }
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ASSEMBLY_PLAN_INVALID",
  )
})

test("requires Assembly and a locked image baseline when a Qwen plan is declared", async (context) => {
  const invalidPlans: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["not required", {
      required: false,
      baselineReferenceSlot: "source",
      ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
      exactCopy: [{
        x: 0,
        y: 0,
        rgba: [255, 0, 0, 255],
        sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
      }],
    }],
    ["unknown baseline", {
      required: true,
      baselineReferenceSlot: "unlocked",
      ownedRegion: { x: 0, y: 0, width: 1, height: 1 },
      exactCopy: [{
        x: 0,
        y: 0,
        rgba: [255, 0, 0, 255],
        sha256: "64902316f3732c57c3d15689b2cb61ea9bc5cbbb3c01b910b4a496b85f313d2a",
      }],
    }],
  ]

  for (const [name, assemblyPlan] of invalidPlans) {
    await context.test(name, async () => {
      const fixture = makeFixture("qwen-image", {
        objective: (objective) => {
          objective.assemblyPlan = assemblyPlan
        },
      })
      await assert.rejects(
        compileFixture(fixture),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "ASSEMBLY_PLAN_INVALID",
      )
    })
  }
})

test("locks an explicit no-Assembly proof and expected media into a Seedance Run Request", async () => {
  const run = await compileFixture(makeFixture("seedance-video"))

  assert.equal(run.request.mode, "seedance-video")
  assert.equal("assemblyPlan" in run.request, false)
  assert.deepEqual(run.request.videoPlan, {
    assembly: {
      required: false,
      pixelOwnership: "none-authoritative",
    },
    expectedMedia: {
      width: 64,
      height: 48,
      durationSeconds: 0.2,
      audioExpected: false,
    },
  })
})

test("refuses Seedance when no validated no-Assembly proof reaches the Run Request", async (context) => {
  for (const [name, videoPlan] of [
    ["missing", undefined],
    ["caller assertion", {
      assembly: { required: false, pixelOwnership: "unknown" },
      expectedMedia: { width: 64, height: 48, durationSeconds: 0.2, audioExpected: false },
    }],
    ["invalid expected media", {
      assembly: { required: false, pixelOwnership: "none-authoritative" },
      expectedMedia: { width: 0, height: 48, durationSeconds: 0.2, audioExpected: false },
    }],
  ] as const) {
    await context.test(name, async () => {
      const fixture = makeFixture("seedance-video", {
        objective: (objective) => {
          if (videoPlan === undefined) delete objective.videoPlan
          else objective.videoPlan = videoPlan
        },
      })
      await assert.rejects(
        compileFixture(fixture),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "VIDEO_PLAN_INVALID",
      )
    })
  }
})
