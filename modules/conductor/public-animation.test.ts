import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

import { makeFixture } from "../../tests/control-plane-fixture.js"

const repository = process.cwd()

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")

const rehashTool = (root: string): void => {
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) return walk(absolute)
    return entry.isFile() && absolute !== join(root, "tool-artifact.json") ? [absolute] : []
  })
  const files = walk(root).map((path) => ({ path: path.slice(root.length + 1), sha256: hash(readFileSync(path)) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  writeFileSync(join(root, "tool-artifact.json"), JSON.stringify({ schemaVersion: "1", files, artifactSha256: hash(JSON.stringify({ files })) }) + "\n")
}

for (const interrupted of [false, true]) test(`the public animation command submits once and replays the same Run (interrupted=${interrupted})`, {
  skip: process.env.QWEN_BASELINE_OFFLINE === "1"
    ? "ordinary CI forbids descendant processes; run this local fake-provider command replay separately"
    : false,
}, () => {
  const scratch = mkdtempSync(join(tmpdir(), "public-animation-"))
  const distribution = join(scratch, "tool")
  const application = join(scratch, "application")
  const pointer = join(repository, ".tool-current")
  const priorPointer = existsSync(pointer) ? readlinkSync(pointer) : undefined
  try {
    execFileSync(process.execPath, [join(repository, "scripts/package-tool.mjs"), distribution], {
      cwd: repository,
      stdio: "pipe",
    })
    const executable = join(distribution, "scripts/image-pipeline.js")
    let seedanceFiles = new Map<string, Uint8Array>()
    makeFixture("seedance-video", { files: (values) => { seedanceFiles = values } })
    const video = seedanceFiles.get("references/neutral.mp4")!
    let imageFiles = new Map<string, Uint8Array>()
    makeFixture("qwen-image", { files: (values) => { imageFiles = values } })
    const image = imageFiles.get("references/neutral.png")!
    const providerCalls = join(scratch, "provider-calls")
    writeFileSync(join(distribution, "seedance/src/httpx.py"), [
      "import base64",
      "import os, signal",
      `CALLS = ${JSON.stringify(providerCalls)}`,
      `VIDEO = base64.b64decode(${JSON.stringify(Buffer.from(video).toString("base64"))})`,
      "class Response:",
      "    def __init__(self, document=None, content=b''): self._document, self.content, self.is_success = document, content, True",
      "    def json(self): return self._document",
      "    def raise_for_status(self): return None",
      "class Client:",
      "    def __init__(self, **_kwargs): pass",
      "    def post(self, _path, json=None):",
      "        with open(CALLS, 'a') as handle: handle.write('submit\\n')",
      ...(interrupted ? ["        os.kill(os.getppid(), signal.SIGKILL)", "        os._exit(0)"] : []),
      "        return Response({'id':'fixture-job-1','status':'pending'})",
      "    def get(self, path):",
      "        return Response(content=VIDEO) if path.endswith('/content') else Response({'id':'fixture-job-1','status':'completed'})",
      "    def close(self): pass",
      "",
    ].join("\n"))
    rehashTool(distribution)
    const identity = JSON.parse(execFileSync(process.execPath, [executable, "identity"], { encoding: "utf8" }))
    let files = new Map<string, Uint8Array>()
    const waiver = "inferred-motion/v1:" + JSON.stringify({
      provenance: "No motion capture exists; movement is inferred from the interaction contract.",
      behavior: "Translate the intact control upward and return without deformation.",
      timing: "Hold, move, return, and hold through the declared duration.",
      spatialPermissions: "Only vertical position may change by at most 14 pixels.",
      cancelRestart: "Cancellation restores the first anchor; restart begins there.",
      historicalFidelity: false,
    })
    const fixture = makeFixture("seedance-video", {
      toolLock: (lock) => Object.assign(lock, identity),
      contract: (contract) => {
        const procedure = (contract.procedures as Array<Record<string, unknown>>).find((item) => item.id === "seedance-neutral")!
        procedure.referenceRequirements = [
          { slot: "first-frame", kind: "image", payloadDestination: "/input_references/0/image_url/url" },
          { slot: "last-frame", kind: "image", payloadDestination: "/input_references/1/image_url/url" },
        ]
      },
      objective: (objective) => {
        objective.references = ["first-frame", "last-frame"].map((slot, index) => ({
          slot, path: `references/${slot}.png`, sha256: hash(image), kind: "image", authorityReason: waiver,
          payloadDestination: `/input_references/${index}/image_url/url`, declaredMedia: { width: 1, height: 1 },
        }))
      },
      files: (values) => {
        values.delete("references/neutral.mp4")
        values.set("references/first-frame.png", image)
        values.set("references/last-frame.png", image)
        files = values
      },
    })
    for (const [path, bytes] of files) {
      const destination = join(application, path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, bytes)
    }
    mkdirSync(join(application, ".qwen-pipeline"), { recursive: true })
    writeFileSync(join(application, ".qwen-pipeline/project-contract.json"), fixture.documents.projectContract)
    writeFileSync(join(application, ".qwen-pipeline/tool-lock.json"), JSON.stringify(identity))
    mkdirSync(join(application, "objectives"), { recursive: true })
    const objectivePath = join(application, fixture.objectivePath)
    writeFileSync(objectivePath, fixture.documents.objective)

    const environment: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_API_KEY: "fixture-not-a-real-key" }
    const invoke = (acknowledged: boolean, env = environment) => spawnSync(process.execPath, [executable, "animation", "--application", application, "--objective", fixture.objectivePath, "--execute", ...(acknowledged ? ["--acknowledge-cost", "0.20"] : [])], {
      cwd: repository,
      env,
      encoding: "utf8",
    })
    const multiple = JSON.parse(fixture.documents.objective)
    multiple.requestedCount = 2
    multiple.budgetCeilingUsd = "0.40"
    writeFileSync(objectivePath, JSON.stringify(multiple))
    const multipleResult = spawnSync(process.execPath, [executable, "animation", "--application", application, "--objective", fixture.objectivePath], { cwd: repository, env: environment, encoding: "utf8" })
    assert.equal(multipleResult.status, 2)
    assert.equal(existsSync(join(application, "artifacts/qwen-pipeline/runs")), false)
    writeFileSync(objectivePath, fixture.documents.objective)
    const unapproved = invoke(false)
    assert.equal(unapproved.status, 2)
    assert.equal(existsSync(join(application, "artifacts/qwen-pipeline/runs")), false)
    const withoutCredential = { ...environment }
    delete withoutCredential.OPENROUTER_API_KEY
    assert.equal(invoke(true, withoutCredential).status, 2)
    assert.equal(existsSync(join(application, "artifacts/qwen-pipeline/runs")), false)
    const run = () => invoke(true)
    const first = run()
    assert.equal(first.status, interrupted ? null : 2, first.stderr)
    if (interrupted) assert.equal(first.signal, "SIGKILL")
    assert.equal(existsSync(join(application, "artifacts/qwen-pipeline/runs")), true, first.stdout + first.stderr)
    const replay = run()
    assert.equal(replay.status, interrupted ? 2 : 0, replay.stdout + replay.stderr)
    const again = run()
    assert.equal(again.status, interrupted ? 2 : 0)

    const runs = readdirSync(join(application, "artifacts/qwen-pipeline/runs"))
    assert.equal(runs.length, 1)
    if (interrupted) {
      const runRoot = join(application, "artifacts/qwen-pipeline/runs", runs[0]!)
      for (const result of [replay, again]) {
        const response = JSON.parse(result.stdout)
        assert.equal(response.checks.outcome, "blocked")
        assert.match(response.checks.evidence, /submission_unreconciled/)
        assert.match(response.nextAction, /reconcile.*do not submit again/i)
        assert.equal(response.cost, "unknown")
        assert.equal(response.fullRecord, runRoot)
        assert.deepEqual(response.result, [])
      }
      assert.equal(existsSync(join(runRoot, "failure.json")), false)
    }
    const events = readFileSync(join(application, "artifacts/qwen-pipeline/runs", runs[0]!, "events.jsonl"), "utf8")
      .trimEnd().split("\n").map((line) => JSON.parse(line) as { kind: string })
    assert.equal(events.filter((event) => event.kind === "submission_may_have_started").length, 1, JSON.stringify(events))
    assert.equal(readFileSync(providerCalls, "utf8"), "submit\n")
  } finally {
    if (existsSync(pointer)) unlinkSync(pointer)
    if (priorPointer !== undefined) symlinkSync(priorPointer, pointer, "dir")
    rmSync(scratch, { recursive: true, force: true })
  }
})
