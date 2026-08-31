import assert from "node:assert/strict"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Effect } from "effect"

import {
  ApplicationFiles,
  MediaInspector,
  PlanningIdentity,
  byteMediaInspector,
  compilePlannedRun,
  filePlanningIdentity,
  verifyPlannedRunIdentity,
} from "./index.js"
import { FIXTURE_TOOL, UNSUPPORTED_FIXTURE_IDENTITY, UPGRADED_FIXTURE_IDENTITY, makeFixture } from "../../tests/control-plane-fixture.js"

const compileFixture = (
  fixture: ReturnType<typeof makeFixture>,
  installedTool = fixture.identity,
) =>
  Effect.runPromise(
    compilePlannedRun(fixture.documents).pipe(
      Effect.provideService(ApplicationFiles, fixture.files),
      Effect.provideService(MediaInspector, byteMediaInspector),
      Effect.provideService(PlanningIdentity, installedTool),
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
  assert.equal(run.request.maximumCorrectionRuns, 2)
  assert.deepEqual(run.request.imageParameters, { aspectRatio: "1:1", resolution: "1K", seed: 42 })
  assert.equal(run.request.artifactRoot, "artifacts/qwen-pipeline")
  assert.equal("assemblyPlan" in run.request, false)
})

test("locks Qwen capability parameters and rejects later Procedure drift", async () => {
  const fixture = makeFixture("qwen-image")
  const planned = await compileFixture(fixture)
  assert.deepEqual(planned.request.imageParameters, { aspectRatio: "1:1", resolution: "1K", seed: 42 })
  const changedContract = JSON.parse(fixture.documents.projectContract) as Record<string, unknown>
  const procedures = changedContract.procedures as Array<Record<string, unknown>>
  const parameters = procedures.find((procedure) => procedure.id === "qwen-neutral")!.parameters as Record<string, unknown>
  parameters.seed = 43
  await assert.rejects(
    Effect.runPromise(verifyPlannedRunIdentity(planned, JSON.stringify(changedContract), fixture.documents.toolLock).pipe(
      Effect.provideService(PlanningIdentity, fixture.identity),
    )),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PROCEDURE_NOT_LOCKED",
  )
})

test("planning refuses a caller-asserted identity that did not verify installed artifact bytes", async () => {
  const fixture = makeFixture("qwen-image")
  await assert.rejects(
    compileFixture(fixture, { installedTool: { ...FIXTURE_TOOL } }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOL_ARTIFACT_INVALID",
  )
})

test("the installed-tool adapter detects artifact integrity drift before planning", async (context) => {
  const source = join(process.cwd(), "tests/fixtures/tool-artifacts/v0.3.0")
  const temporaryRoot = await mkdtemp(join(tmpdir(), "qwen-tool-artifact-"))
  context.after(async () => rm(temporaryRoot, { recursive: true, force: true }))
  await cp(source, temporaryRoot, { recursive: true })
  const verified = await Effect.runPromise(filePlanningIdentity(temporaryRoot))
  assert.deepEqual(verified.installedTool, FIXTURE_TOOL)
  await writeFile(join(temporaryRoot, "artifact.txt"), "changed installed bytes\n", "utf8")
  await assert.rejects(
    Effect.runPromise(filePlanningIdentity(temporaryRoot)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOL_ARTIFACT_INVALID",
  )
})

for (const field of [
  "release",
  "commit",
  "artifactSha256",
  "procedureVersion",
  "runSchemaVersion",
  "adapterProtocolVersion",
] as const) {
  test(`refuses an exact Tool Lock mismatch in ${field}`, async () => {
    const fixture = makeFixture("qwen-image", {
      toolLock: (lock) => {
        lock[field] = field === "release" ? "v9.9.9" : field === "commit" ? "3".repeat(40) : "9".repeat(64)
      },
    })
    await assert.rejects(
      compileFixture(fixture),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOL_LOCK_MISMATCH",
    )
  })
}

test("refuses a Procedure version that disagrees with the exact Tool Lock", async () => {
  const fixture = makeFixture("qwen-image", {
    contract: (contract) => {
      const procedures = contract.procedures as Array<Record<string, unknown>>
      procedures.find((procedure) => procedure.id === "qwen-neutral")!.version = "2"
    },
  })
  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PROCEDURE_NOT_LOCKED",
  )
})

test("refuses an exact but unsupported Tool Lock version profile", async () => {
  const unsupportedTool = UNSUPPORTED_FIXTURE_IDENTITY.installedTool
  const fixture = makeFixture("qwen-image", {
    contract: (contract) => {
      const procedures = contract.procedures as Array<Record<string, unknown>>
      procedures.find((procedure) => procedure.id === "qwen-neutral")!.version = "9"
    },
    toolLock: (lock) => Object.assign(lock, unsupportedTool),
  })
  await assert.rejects(
    compileFixture(fixture, UNSUPPORTED_FIXTURE_IDENTITY),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TOOL_VERSION_UNSUPPORTED",
  )
})

for (const artifactRoot of [
  "/tmp/escape",
  "../escape",
  "~/escape",
  "C:/escape",
  "artifacts\\escape",
]) {
  test(`refuses unsafe declared artifact root ${JSON.stringify(artifactRoot)}`, async () => {
    const fixture = makeFixture("qwen-image", {
      contract: (contract) => { contract.artifactRoot = artifactRoot },
    })
    await assert.rejects(
      compileFixture(fixture),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "UNSAFE_APPLICATION_PATH",
    )
  })
}

test("one application can adopt a checked exact tool upgrade while another keeps its prior pin", async () => {
  const upgradedTool = UPGRADED_FIXTURE_IDENTITY.installedTool
  const upgradedApplication = makeFixture("qwen-image", {
    contract: (contract) => { contract.applicationId = "upgraded-application" },
    toolLock: (lock) => Object.assign(lock, upgradedTool),
  })
  const pinnedApplication = makeFixture("qwen-image", {
    contract: (contract) => { contract.applicationId = "pinned-application" },
  })

  const [upgraded, pinned] = await Promise.all([
    compileFixture(upgradedApplication, UPGRADED_FIXTURE_IDENTITY),
    compileFixture(pinnedApplication),
  ])

  assert.equal(upgraded.request.applicationId, "upgraded-application")
  assert.equal(upgraded.request.tool.release, "v0.3.1")
  assert.equal(pinned.request.applicationId, "pinned-application")
  assert.equal(pinned.request.tool.release, "v0.3.0")
  assert.equal(upgraded.request.tool.runSchemaVersion, pinned.request.tool.runSchemaVersion)
  assert.equal(upgraded.request.tool.adapterProtocolVersion, pinned.request.tool.adapterProtocolVersion)
})

test("prices the maximum possible paid effect before a Run can be reserved", async () => {
  const fixture = makeFixture("qwen-image", {
    objective: (objective) => {
      objective.requestedCount = 2
      objective.budgetCeilingUsd = "0.07"
    },
  })

  await assert.rejects(
    compileFixture(fixture),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "BUDGET_EXCEEDED",
  )
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
    paletteMaxGrowth: 4,
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
