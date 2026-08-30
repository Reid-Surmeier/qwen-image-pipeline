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
import { PROJECT_CONTRACT_PATH, TOOL_LOCK_PATH } from "./types.js"
import type {
  PlanningRefusal,
  PlanningRefusalCode,
} from "./errors.js"

const spendRisk = "Planning made no provider request, created no attempt, and spent $0. A later advance may spend up to the locked ceiling."

type RefusalGuidance = Readonly<{
  nextAction: string
  humanDecision: string
}>

const fixDocument: RefusalGuidance = {
  nextAction: "Correct the named Project Contract, Tool Lock, or Objective condition, then plan again.",
  humanDecision: "No subjective visual approval is being requested at planning time.",
}
const fixReference: RefusalGuidance = {
  nextAction: "Correct or supply the named authoritative reference evidence, then plan again.",
  humanDecision: "No subjective visual approval is being requested at planning time.",
}
const identifyAuthority: RefusalGuidance = {
  nextAction: "Record which application evidence is authoritative and why, then plan again.",
  humanDecision: "A human must identify which evidence is authoritative and record why.",
}

const refusalGuidance = {
  PROJECT_CONTRACT_MISSING: fixDocument,
  TOOL_LOCK_MISSING: fixDocument,
  OBJECTIVE_MISSING: fixDocument,
  APPLICATION_READ_FAILED: fixDocument,
  DOCUMENT_INVALID: fixDocument,
  TOOL_LOCK_MISMATCH: {
    nextAction: "Install the exact locked tool build or update the application Tool Lock through review.",
    humanDecision: "No subjective visual approval is being requested at planning time.",
  },
  SECRET_MATERIAL_DETECTED: fixDocument,
  UNSAFE_APPLICATION_PATH: fixDocument,
  PROCEDURE_NOT_LOCKED: fixDocument,
  COUNT_OUT_OF_RANGE: fixDocument,
  BUDGET_UNPROVABLE: fixDocument,
  BUDGET_EXCEEDED: fixDocument,
  REFERENCE_MISSING: fixReference,
  REFERENCE_HASH_MISMATCH: fixReference,
  REFERENCE_KIND_MISMATCH: fixReference,
  REFERENCE_AUTHORITY_MISSING: identifyAuthority,
  REFERENCE_PATH_UNSAFE: fixReference,
  PAYLOAD_DESTINATION_INVALID: fixReference,
  MEDIA_INSPECTION_FAILED: fixReference,
  DECLARED_MEDIA_MISMATCH: fixReference,
  SEEDANCE_VIDEO_REFERENCE_REQUIRED: fixReference,
} satisfies Record<PlanningRefusalCode, RefusalGuidance>

const isPlanningRefusalCode = (value: unknown): value is PlanningRefusalCode =>
  typeof value === "string" && Object.hasOwn(refusalGuidance, value)

const isSafeObjectivePath = (path: string): boolean =>
  path.length > 0 &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !/^[A-Za-z]:/.test(path) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const refusedView = (
  refusal: PlanningRefusal,
  objective?: string,
): NormalView => ({
  objective: objective ?? "The requested objective could not be read safely enough to describe it.",
  evidence: `Planning stopped before any attempt: ${refusal.message}`,
  nextAction: refusalGuidance[refusal.code].nextAction,
  spendRisk,
  humanDecision: refusalGuidance[refusal.code].humanDecision,
})

const objectiveSummary = (bytes: Uint8Array): string | undefined => {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    const summary = (value as Record<string, unknown>).summary
    if (
      typeof summary !== "string" ||
      summary.trim().length === 0 ||
      summary.length > 500 ||
      /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(summary)
    ) return undefined
    return summary
  } catch {
    return undefined
  }
}

const asRefusal = (error: unknown): PlanningRefusal => {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    isPlanningRefusalCode(error.code)
  ) {
    return {
      code: error.code,
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

  let describedObjective: string | undefined
  return Effect.gen(function*() {
    const files = yield* ApplicationFiles
    const contract = yield* readRequired(files, PROJECT_CONTRACT_PATH, "PROJECT_CONTRACT_MISSING")
    const lock = yield* readRequired(files, TOOL_LOCK_PATH, "TOOL_LOCK_MISSING")
    const objective = yield* readRequired(files, command.objectivePath, "OBJECTIVE_MISSING")
    describedObjective = objectiveSummary(objective.bytes)
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
        normalView: refusedView(refusal, describedObjective),
      })
    }),
  )
}
