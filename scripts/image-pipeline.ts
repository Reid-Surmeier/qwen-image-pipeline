#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, renameSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { dirname, join, resolve, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { Effect } from "effect"
import { advance, plan, ApplicationFiles, MediaInspector, PlanningIdentity, byteMediaInspector, fileApplicationFiles, filePlanningIdentity } from "../modules/conductor/index.js"
import { GenerationAdapter, inheritedQwenPythonAdapter } from "../modules/generation/index.js"
import { fileRunRecordLayer, RunRecordClock, materializeMuseImage, readDiagnostics } from "../modules/run-record/index.js"

import { assembleProductRecipe } from "../modules/assembly/index.js"
import { pythonImageInspector } from "../modules/reference-planning/index.js"

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const [command = "help", ...arguments_] = process.argv.slice(2)
if (command === "help") {
  console.log("image-pipeline identity | prepare --application PATH --recipe PATH --unit-cost USD --budget USD | image --application PATH --objective PATH [--execute] [--select-donor SHA] | export-donor --application PATH --run ID --recipe PATH --output PATH | product <packet options> | assemble --application PATH --recipe PATH | animation <seedance-icons arguments>")
} else if (command === "product") {
  await Effect.runPromise(filePlanningIdentity(toolRoot))
  const child = spawnSync(process.execPath, [join(toolRoot, "procedures/muse/product-plan.mjs"), ...arguments_], { stdio: "inherit" })
  process.exitCode = child.status ?? 1
} else if (command === "animation") {
  // Preserve the existing Seedance CLI, including its explicit cost and strategy gates.
  await Effect.runPromise(filePlanningIdentity(toolRoot))
  const child = spawnSync("/usr/bin/python3", ["-m", "seedance_icons.cli", ...arguments_], {
    env: { ...process.env, PYTHONPATH: join(toolRoot, "seedance/src"), PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit",
  })
  process.exitCode = child.status ?? 1
} else {
  const program = Effect.gen(function*() {
    const identity = yield* filePlanningIdentity(toolRoot)
    if (command === "identity") { console.log(JSON.stringify(identity.installedTool, null, 2)); return }
    if (command !== "image" && command !== "prepare" && command !== "assemble" && command !== "export-donor") throw new Error("Unknown command; use help.")
    const { values } = parseArgs({ args: arguments_, options: {
      run: { type: "string" }, output: { type: "string" }, recipe: { type: "string" }, "unit-cost": { type: "string" }, budget: { type: "string" }, application: { type: "string" }, objective: { type: "string" }, execute: { type: "boolean" }, "select-donor": { type: "string" },
    } })
    if (!values.application) throw new Error("An application root is required.")
    const applicationRoot = resolve(values.application)
    if (command === "export-donor") {
      if (!values.run || !values.recipe || !values.output) throw new Error("Export requires a recorded run, its product recipe and a new application output directory.")
      const root = realpathSync(applicationRoot)
      const owned = (path: string) => {
        const absolute = realpathSync(resolve(root, path))
        if (!absolute.startsWith(root + sep)) throw new Error("Export inputs must remain inside the application.")
        return absolute
      }
      const store = yield* fileRunRecordLayer(root)
      const diagnostics = yield* readDiagnostics(values.run).pipe(Effect.provide(store))
      const request = JSON.parse(Buffer.from(diagnostics.request).toString("utf8"))
      const inputs = request.sourceInputs as Array<{applicationPath:string;sha256:string}> | undefined
      if (request.mode !== "muse-image" || !inputs?.length) throw new Error("A hash-locked Muse product run is required.")
      const hash = (path: string) => createHash("sha256").update(readFileSync(owned(path))).digest("hex")
      for (const input of inputs) if (hash(input.applicationPath) !== input.sha256) throw new Error("A saved product input changed.")
      const recipePath = relative(root, owned(values.recipe))
      const recipe = JSON.parse(readFileSync(owned(recipePath), "utf8"))
      if (recipe.procedure !== "product-ad" || !inputs.some(input => input.applicationPath === recipePath) || !inputs.some(input => input.applicationPath === recipe.packet)) throw new Error("The product recipe and packet must belong to this run.")
      const packet = JSON.parse(readFileSync(owned(recipe.packet), "utf8"))
      if (!packet.validation?.valid || typeof packet.signature !== "string" || typeof recipe.strategy !== "string") throw new Error("Invalid saved product packet.")
      const native = yield* materializeMuseImage(values.run).pipe(Effect.provide(store))
      const donorPath = join(request.artifactRoot, "runs", values.run, native.applicationPath)
      const output = resolve(root, values.output)
      if (!output.startsWith(root + sep) || (realpathSync(dirname(output)) !== root && !realpathSync(dirname(output)).startsWith(root + sep))) throw new Error("Export output must remain inside the application.")
      mkdirSync(output)
      const attempt = {id:"001",packetSignature:packet.signature,strategy:recipe.strategy}
      mkdirSync(join(output,"attempts",attempt.id),{recursive:true})
      const write = (path: string, value: unknown) => writeFileSync(join(output,path),JSON.stringify(value,null,2)+"\n",{flag:"wx"})
      write("packets.json",[packet])
      write("generation-plan.json",{attempts:[attempt]})
      write("attempts/001/run.json",{provider:"openrouter",model:"meta/muse-image",completedOutputs:1,costUsd:diagnostics.view.actualCostUsd ?? null,sourceRun:values.run,approval:"unverified",images:[{file:donorPath,sha256:native.sha256,mediaType:native.mediaType}]})
      const paths = ["packets.json","generation-plan.json","attempts/001/run.json"].map(path => relative(root,join(output,path)))
      paths.push(donorPath)
      console.log(JSON.stringify({donorHome:relative(root,output),inputHashes:Object.fromEntries(paths.map(path => [path,hash(path)])),sourceRun:values.run,paidCalls:0,approval:"unverified"},null,2))
      return
    }
    if (command === "assemble") {
      if (!values.recipe) throw new Error("Assembly requires the application recipe.")
      const result = yield* assembleProductRecipe({ toolRoot, applicationRoot, recipePath: values.recipe })
      console.log(JSON.stringify({
        source: result.report.records.map(record => ({ donor: join(applicationRoot, String(record.donor)), sourceSha256: record.sourceSha256 })),
        result: result.report.records.map(record => ({ path: join(applicationRoot, String(record.output)), sha256: record.outputSha256, mediaType: "image/webp" })),
        changesRequested: "Assemble the saved product ad using its declared layout, copy and donor.",
        checks: result.report.checks,
        cost: { thisAssemblyUsd: "0.000000", donorCosts: result.report.records.map(record => ({ donorAttempt: record.donorAttempt, costUsd: record.costUsd ?? "unknown" })) },
        fullRecord: join(applicationRoot, result.reportPath), approval: "unverified",
      }, null, 2))
      if (Object.values(result.report.checks).includes("failed")) process.exitCode = 2
      return
    }
    if (command === "prepare") {
      if (!values.recipe || !values["unit-cost"] || !values.budget ||
          !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(values["unit-cost"]) || !/^(?:0|[1-9][0-9]*)\.[0-9]{2}$/.test(values.budget) ||
          Number(values["unit-cost"]) > Number(values.budget)) throw new Error("Prepare requires recipe, unit-cost and budget in USD (two decimal places).")
      const child = spawnSync("/usr/bin/python3", ["-m", "qwen_ui_pipeline.muse_recipe", "--application", applicationRoot, "--recipe", values.recipe], {
        cwd: toolRoot, env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", maxBuffer: 1024 * 1024,
      })
      if (child.status !== 0) throw new Error("Recipe inputs failed validation.")
      const recipe = JSON.parse(child.stdout) as { procedure: string; prompt: string; size: string; references: Array<{path:string;sha256:string}>; recipeSha256:string; sourceInputs: Array<{applicationPath:string;sha256:string}> }
      const configuration = join(applicationRoot, ".qwen-pipeline")
      if (existsSync(configuration) && lstatSync(configuration).isSymbolicLink()) throw new Error("Configuration must be an application directory.")
      mkdirSync(configuration, { recursive: true })
      const lockPath = join(configuration, "tool-lock.json")
      const encodedLock = JSON.stringify(identity.installedTool, null, 2) + "\n"
      if (!existsSync(lockPath)) writeFileSync(lockPath, encodedLock, { flag: "wx" })
      else if (lstatSync(lockPath).isSymbolicLink() || JSON.stringify(JSON.parse(readFileSync(lockPath, "utf8"))) !== JSON.stringify(identity.installedTool)) throw new Error("Application Tool Lock requires an explicit upgrade before preparing with this artifact.")
      const contractPath = join(configuration, "project-contract.json")
      if (existsSync(contractPath) && lstatSync(contractPath).isSymbolicLink()) throw new Error("Contract must be a regular application file.")
      const contract = existsSync(contractPath) ? JSON.parse(readFileSync(contractPath, "utf8")) : {
        schemaVersion: "1", applicationId: "app-" + createHash("sha256").update(applicationRoot).digest("hex").slice(0, 12),
        artifactRoot: "artifacts/image-generation", referenceRoots: [], outputRoot: "generated", maximumCount: 1,
        maximumBudgetUsd: values.budget, maximumCorrectionRuns: 0, procedures: [],
      }
      if (Number(values.budget) > Number(contract.maximumBudgetUsd)) throw new Error("Requested budget exceeds the existing application contract.")
      const id = "muse-" + recipe.recipeSha256.slice(0, 20)
      const references = recipe.references.map((reference, index) => ({ ...reference, slot: `reference-${String(index).padStart(3, "0")}`, kind: "image", authorityReason: "Ordered input from the hash-locked saved Muse recipe", payloadDestination: `/input_references/${index}/image_url/url` }))
      const procedure = { id, version: "1", mode: "muse-image", provider: "openrouter", model: "meta/muse-image", parameters: { size: recipe.size }, maximumCount: 1, unitCostUsd: values["unit-cost"], referenceRequirements: references.map(({slot,kind,payloadDestination}) => ({slot,kind,payloadDestination})) }
      const prior = contract.procedures.find((item: {id:string}) => item.id === id)
      if (prior && JSON.stringify(prior) !== JSON.stringify(procedure)) throw new Error("An existing recipe procedure cannot be overwritten.")
      if (!prior) contract.procedures.push(procedure)
      contract.referenceRoots = [...new Set([...contract.referenceRoots, ...references.map(reference => reference.path)])]
      // Exclusive temporary file, then atomic replacement; no existing objective is overwritten.
      const temporary = contractPath + "." + process.pid + ".tmp"
      writeFileSync(temporary, JSON.stringify(contract, null, 2) + "\n", { flag: "wx" })
      renameSync(temporary, contractPath)
      const objective = { schemaVersion: "1", id, summary: recipe.prompt, procedureId: id, requestedCount: 1, budgetCeilingUsd: values.budget, references, sourceInputs: recipe.sourceInputs }
      const objectivePath = `.qwen-pipeline/${id}.json`
      const encoded = JSON.stringify(objective, null, 2) + "\n"
      const absolute = join(applicationRoot, objectivePath)
      if (!existsSync(absolute)) writeFileSync(absolute, encoded, { flag: "wx" })
      else if (lstatSync(absolute).isSymbolicLink() || readFileSync(absolute, "utf8") !== encoded) throw new Error("A prior objective differs; it cannot be replaced.")
      console.log(JSON.stringify({ procedure: recipe.procedure, model: "meta/muse-image", objective: objectivePath, paidRequests: 0, nextAction: "Run image with this objective to inspect the plan; add --execute only for authorized spending." }, null, 2))
      return
    }
    if (!values.objective) throw new Error("Image requires an application-relative Objective path.")
    const files = yield* fileApplicationFiles(applicationRoot)
    const planned = yield* plan({ objectivePath: values.objective }).pipe(
      Effect.provideService(ApplicationFiles, files), Effect.provideService(MediaInspector, pythonImageInspector(toolRoot)), Effect.provideService(PlanningIdentity, identity),
    )
    if (planned._tag !== "Planned") { console.log(JSON.stringify(planned, null, 2)); process.exitCode = 2; return }
    if (planned.run.request.mode !== "muse-image") throw new Error("The image command requires the saved Muse procedure. Use animation for Seedance.")
    if (!values.execute) { console.log(JSON.stringify(planned, null, 2)); return }
    if (values.run === "") throw new Error("A non-empty recorded Run identity is required.")
    // Python runs from the verified distribution, while all file services retain the application root.
    process.chdir(toolRoot)
    const store = yield* fileRunRecordLayer(applicationRoot)
    if (values.run !== undefined) {
      const saved = yield* readDiagnostics(values.run).pipe(Effect.provide(store))
      if (saved.view.requestSha256 !== planned.run.requestSha256 || !saved.view.evidence.some(item => item.applicationPath === "provider-response.json")) throw new Error("Unpaid resume requires this objective's authenticated provider receipt.")
    }
    const adapter = yield* inheritedQwenPythonAdapter(values.run !== undefined)
    const decision = yield* advance({ run: planned.run, ...(values["select-donor"] ? { selectedDonorSha256: values["select-donor"] } : {}) }).pipe(
      Effect.provideService(ApplicationFiles, files), Effect.provideService(PlanningIdentity, identity),
      Effect.provideService(GenerationAdapter, adapter), Effect.provide(store),
      Effect.provideService(RunRecordClock, { now: () => Effect.sync(() => new Date().toISOString()) }),
    )
    const diagnostics = "diagnostics" in decision ? decision.diagnostics : undefined
    const runRoot = "runId" in decision ? join(applicationRoot, planned.run.request.artifactRoot, "runs", decision.runId) : undefined
    const native = diagnostics !== undefined && runRoot !== undefined && (decision._tag === "HumanDecisionRequired" || decision._tag === "VerifiedCandidate")
      ? yield* materializeMuseImage(diagnostics.view.runId).pipe(Effect.provide(store)) : undefined
    console.log(JSON.stringify({
      source: planned.run.request.references.map(reference => join(applicationRoot, reference.applicationPath)),
      result: decision._tag === "VerifiedCandidate" ? [{ path: join(runRoot!, decision.candidate.applicationPath), mediaType: decision.candidate.mediaType, sha256: decision.candidate.sha256 }] : native === undefined ? [] : [{ path: join(runRoot!, native.applicationPath), mediaType: native.mediaType, sha256: native.sha256 }],
      changesRequested: planned.run.request.objective,
      checks: { outcome: "outcome" in decision ? decision.outcome : "pending", evidence: decision.normalView.evidence, visualReview: "unverified" },
      cost: diagnostics?.view.actualCostUsd ?? "unknown",
      nextAction: decision.normalView.nextAction,
      fullRecord: runRoot,
    }, null, 2))
    if (decision._tag !== "HumanDecisionRequired" && decision._tag !== "VerifiedCandidate") process.exitCode = 2
  })
  await Effect.runPromise(program).catch(() => { console.error("The image procedure stopped. Check the application contract, tool lock and saved run; never blindly resubmit a possibly spent run."); process.exitCode = 2 })
}
