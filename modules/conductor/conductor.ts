import { Effect } from "effect"

import {
  ApplicationFiles,
  compilePlannedRun,
  type ApplicationFilesService,
  type MediaInspectorService,
  type PlanningIdentityService,
} from "../run-contract/index.js"
import type {
  NormalView,
  PlanCommand,
  PlanDecision,
} from "./types.js"
import type {
  PlanningRefusal,
  PlanningRefusalCode,
} from "./errors.js"

const PROJECT_CONTRACT = ".qwen-pipeline/project-contract.json"
const TOOL_LOCK = ".qwen-pipeline/tool-lock.json"

const spendRisk = "Planning made no provider request, created no attempt, and spent $0. A later advance may spend up to the locked ceiling."

const isSafeObjectivePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !/^[A-Za-z]:/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const refusedView = (refusal: PlanningRefusal): NormalView => ({
  objective: "The requested objective was not planned because its safety contract was not satisfied.",
  evidence: `Available evidence was checked and planning stopped with ${refusal.code}.`,
  nextAction: refusal.code === "TOOL_LOCK_MISMATCH"
    ? "Install the exact locked tool build or update the application Tool Lock through review."
    : refusal.code.includes("REFERENCE") || refusal.code.includes("MEDIA")
      ? "Correct or supply the authoritative reference evidence, then plan again."
      : "Correct the named Project Contract, Tool Lock, or objective condition, then plan again.",
  spendRisk,
  humanDecision: refusal.code === "REFERENCE_AUTHORITY_MISSING"
    ? "A human must identify which evidence is authoritative and record why."
    : "No subjective visual approval is being requested at planning time.",
})

const asRefusal = (error: unknown): PlanningRefusal => {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      code: error.code as PlanningRefusalCode,
      message: error instanceof Error ? error.message : error.code,
    }
  }
  return {
    code: "DOCUMENT_INVALID",
    message: "Planning failed with an unclassified local validation error.",
  }
}

const readRequired = (
  files: ApplicationFilesService,
  path: string,
  missingCode: PlanningRefusalCode,
) => files.read(path).pipe(
  Effect.mapError((error) => ({
    code: error.code === "APPLICATION_PATH_MISSING" ? missingCode : "APPLICATION_READ_FAILED",
    message: error.code === "APPLICATION_PATH_MISSING"
      ? `${path} is required by the normal planning procedure.`
      : `${path} could not be read.`,
  } satisfies PlanningRefusal)),
)

export const planObjective = (
  command: PlanCommand,
): Effect.Effect<
  PlanDecision,
  never,
  ApplicationFilesService | MediaInspectorService | PlanningIdentityService
> => {
  if (!isSafeObjectivePath(command.objectivePath)) {
    const refusal: PlanningRefusal = {
      code: "UNSAFE_APPLICATION_PATH",
      message: "The objective path must remain inside the application repository.",
    }
    return Effect.succeed({ _tag: "Refused", refusal, normalView: refusedView(refusal) })
  }

  return Effect.gen(function*() {
    const files = yield* ApplicationFiles
    const contract = yield* readRequired(files, PROJECT_CONTRACT, "PROJECT_CONTRACT_MISSING")
    const lock = yield* readRequired(files, TOOL_LOCK, "TOOL_LOCK_MISSING")
    const objective = yield* readRequired(files, command.objectivePath, "OBJECTIVE_MISSING")
    const run = yield* compilePlannedRun({
      projectContract: Buffer.from(contract.bytes).toString("utf8"),
      toolLock: Buffer.from(lock.bytes).toString("utf8"),
      objective: Buffer.from(objective.bytes).toString("utf8"),
    })
    const references = run.request.references
    const normalView: NormalView = {
      objective: run.request.objective,
      evidence: `${references.length} authoritative reference${references.length === 1 ? "" : "s"} matched the recorded path, kind, hash, media properties, and provider payload destination.`,
      nextAction: "Advance this exact immutable Planned Run to reservation only when execution is requested.",
      spendRisk,
      humanDecision: "No human decision remains before reservation; subjective final visual approval remains after execution.",
    }
    return { _tag: "Planned" as const, run, normalView }
  }).pipe(
    Effect.catchEager((error) => {
      const refusal = asRefusal(error)
      return Effect.succeed({
        _tag: "Refused" as const,
        refusal,
        normalView: refusedView(refusal),
      })
    }),
  )
}
