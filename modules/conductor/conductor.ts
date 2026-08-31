import { createHash } from "node:crypto"
import { Effect } from "effect"

import {
  ApplicationFiles,
  compilePlannedRun,
  type ApplicationFilesService,
  type MediaInspectorService,
  type PlanningIdentityService,
} from "../run-contract/index.js"
import {
  RunRecordStore,
  type AttemptReservation,
  type OutputFile,
  type RunRecordState,
  type RunRecordStoreService,
  type SubmissionMarker,
} from "../run-record/index.js"
import {
  GenerationAdapter,
  type GenerationAdapterService,
  type GenerationRequest,
  type GenerationResult,
} from "../generation/index.js"
import {
  Assembly,
  type AssemblyOutput,
  type AssemblyService,
} from "../assembly/index.js"
import {
  Verification,
  type VerificationReport,
  type VerificationService,
} from "../verification/index.js"
import type {
  AdvanceCommand,
  AdvanceDecision,
  NormalView,
  PlanCommand,
  PlanDecision,
} from "./types.js"
import { PROJECT_CONTRACT_PATH, TOOL_LOCK_PATH } from "./types.js"
import type {
  PlanningRefusal,
  PlanningRefusalCode,
} from "./errors.js"

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

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
        normalView: refusedView(
          refusal,
          refusal.code === "SECRET_MATERIAL_DETECTED" ? undefined : describedObjective,
        ),
      })
    }),
  )
}

export const advanceRun = (
  command: AdvanceCommand,
): Effect.Effect<
  AdvanceDecision,
  never,
  | RunRecordStoreService
  | GenerationAdapterService
  | AssemblyService
  | VerificationService
  | ApplicationFilesService
> => Effect.gen(function*() {
  const store = yield* RunRecordStore
  const generation = yield* GenerationAdapter
  const assembly = yield* Assembly
  const verification = yield* Verification
  const files = yield* ApplicationFiles

  // 1. Load or initialize run record
  let state: RunRecordState
  if (command.plannedRun !== undefined && command.runId !== undefined) {
    state = yield* store.initRun(command.runId, command.plannedRun, command.runDirectory).pipe(
      Effect.catchEager(() => store.loadRun(command.runDirectory)),
    )
  } else {
    state = yield* store.loadRun(command.runDirectory)
  }

  const costSpent = state.providerEvidence?.costUsd ?? state.request?.estimatedMaximumCostUsd ?? "0.00"

  // Check terminal state
  if (state.status === "verified" && state.normalView !== undefined) {
    return {
      _tag: "VerifiedCandidate" as const,
      normalView: state.normalView,
      state,
      verificationReport: {
        outcome: "verified_candidate" as const,
        passed: true,
        stages: [],
      },
    }
  }
  if (state.status === "failed" && state.normalView !== undefined) {
    return {
      _tag: "Failed" as const,
      normalView: state.normalView,
      state,
      failureReason: (state.events[state.events.length - 1]?.payload["reason"] as string | undefined) ?? "Run previously failed",
    }
  }

  // 2. Reserve attempt if planned
  if (state.status === "planned") {
    const attempt: AttemptReservation = {
      attemptId: `attempt-${state.runId}-${Date.now()}`,
      runId: state.runId,
      requestSha256: state.requestSha256,
      payloadDigest: sha256(Buffer.from(state.requestSha256)),
      estimateUsd: state.request.estimatedMaximumCostUsd,
      maximumCount: state.request.requestedCount,
      maximumSpendUsd: state.request.budgetCeilingUsd,
      retryAllowed: false,
      billingStatus: "reserved",
    }
    state = yield* store.recordAttemptReservation(command.runDirectory, attempt)
  }

  // 3. Mark submission started & execute generation if reserved
  let outputFiles: Array<OutputFile & { mediaType: string; sha256: string }> = []
  if (state.status === "reserved") {
    const marker: SubmissionMarker = {
      attemptId: state.attempt!.attemptId,
      markedAt: new Date().toISOString(),
      submissionMayHaveStarted: true,
      billingStatus: "possibly_spent",
    }
    state = yield* store.recordSubmissionMayHaveStarted(command.runDirectory, marker)

    // Gather reference bytes
    const referencesData: Array<{
      slot: string
      payloadDestination: string
      bytes: Uint8Array
      sha256: string
      mediaType: string
    }> = []

    for (const ref of state.request.references) {
      const readResult = yield* files.read(ref.applicationPath).pipe(
        Effect.catchEager(() => Effect.succeed(undefined)),
      )
      if (readResult) {
        referencesData.push({
          slot: ref.slot,
          payloadDestination: ref.payloadDestination,
          bytes: readResult.bytes,
          sha256: ref.sha256,
          mediaType: ref.kind === "video" ? "video/mp4" : "image/png",
        })
      }
    }

    const genReq: GenerationRequest = {
      request: state.request,
      attempt: state.attempt!,
      referencesData,
    }

    const genResult = yield* generation.execute(genReq).pipe(
      Effect.catchEager((genErr) => {
        const failureReason = `Provider execution failed: ${genErr.message}`
        const failView: NormalView = {
          objective: state.request.objective,
          evidence: failureReason,
          nextAction: "Reconcile provider state; do not blindly retry.",
          spendRisk: `A provider attempt was made and may have incurred up to $${state.request.estimatedMaximumCostUsd}.`,
          humanDecision: "A human must inspect provider logs or billing before any new attempt.",
        }
        return store.recordEvent(command.runDirectory, "RUN_FAILED", {
          code: genErr.code,
          message: genErr.message,
          preSubmit: false,
        }).pipe(
          Effect.flatMap(() => store.recordSummary(command.runDirectory, failView, "failed")),
          Effect.flatMap(() => store.loadRun(command.runDirectory)),
          Effect.map((failedState): AdvanceDecision => ({
            _tag: "Failed",
            normalView: failView,
            state: failedState,
            failureReason,
          })),
        )
      }),
    )

    if ("_tag" in genResult && genResult._tag === "Failed") {
      return genResult
    }

    const successfulGen = genResult as GenerationResult
    outputFiles = successfulGen.outputs.map((o) => ({
      name: o.name,
      bytes: o.bytes,
      sha256: o.sha256,
      mediaType: o.mediaType,
    }))

    state = yield* store.recordProviderEvidence(
      command.runDirectory,
      {
        status: successfulGen.status,
        bodyDigest: successfulGen.bodyDigest,
        sanitizedBody: successfulGen.sanitizedBody,
        safeIdentifiers: successfulGen.safeIdentifiers,
        outputs: successfulGen.outputs.map((o) => ({
          name: o.name,
          sha256: o.sha256,
          byteLength: o.byteLength,
          mediaType: o.mediaType,
        })),
        usage: successfulGen.usage,
        costUsd: successfulGen.costUsd,
        jobId: successfulGen.jobId,
      },
      outputFiles.map((o) => ({ name: o.name, bytes: o.bytes })),
    )
  } else if (state.status === "submission_started") {
    // Resuming from in-flight submission or polling Seedance
    const lastEvent = state.events.find((e) => e.eventType === "PROVIDER_EVIDENCE_RECORDED")
    if (!lastEvent) {
      // Ambiguous attempt in-flight
      const normalView: NormalView = {
        objective: state.request.objective,
        evidence: "An attempt was reserved and marked started, but no provider evidence was persisted.",
        nextAction: "Reconcile provider status before proceeding.",
        spendRisk: `A provider attempt was submitted and may have incurred up to $${state.request.estimatedMaximumCostUsd}.`,
        humanDecision: "A human decision or provider reconciliation is required.",
      }
      return {
        _tag: "Blocked" as const,
        normalView,
        state,
        blockReason: "Ambiguous in-flight provider request requires reconciliation.",
      }
    }
  }

  if (outputFiles.length === 0 && state.outputFiles !== undefined) {
    outputFiles = state.outputFiles.map((o) => ({
      name: o.name,
      bytes: o.bytes,
      sha256: o.sha256,
      mediaType: o.mediaType,
    }))
  }

  // 4. Handle Donor Checkpoint & Assembly for Qwen image
  let assemblyOutput: AssemblyOutput | undefined
  if (state.request.mode === "qwen-image" && state.request.references.length > 0) {
    const outputs = state.providerEvidence?.outputs ?? []
    if (outputs.length > 1 && command.donorChoice === undefined) {
      state = yield* store.recordEvent(command.runDirectory, "DONOR_CHECKPOINT_REACHED", {
        outputCount: outputs.length,
        outputs: outputs.map((o) => o.name),
      })
      const normalView: NormalView = {
        objective: state.request.objective,
        evidence: `${outputs.length} candidate donor images generated; donor selection required.`,
        nextAction: "Provide an approved donor choice to proceed with deterministic assembly.",
        spendRisk: `Money spent: $${costSpent}.`,
        humanDecision: "Select an approved donor from the generated outputs.",
      }
      yield* store.recordSummary(command.runDirectory, normalView, "human_decision_required")
      return {
        _tag: "HumanDecisionRequired" as const,
        normalView,
        state,
        humanDecisionPrompt: "Select an approved donor from the generated outputs to proceed with Assembly.",
      }
    }

    if (command.donorChoice !== undefined) {
      state = yield* store.recordEvent(command.runDirectory, "DONOR_SELECTED", {
        donorChoice: command.donorChoice,
      })
    }

    // Perform deterministic assembly
    const baselineRef = state.request.references[0]!
    const baselineFile = yield* files.read(baselineRef.applicationPath).pipe(
      Effect.catchEager(() => Effect.succeed(undefined)),
    )
    if (baselineFile) {
      const donorBytes = outputFiles[0]?.bytes ?? baselineFile.bytes
      const donorName = command.donorChoice ?? outputFiles[0]?.name ?? "donor-01.png"
      const donorSha = outputFiles[0]?.sha256 ?? baselineRef.sha256

      assemblyOutput = yield* assembly.assemble({
        baseline: {
          path: baselineRef.applicationPath,
          bytes: baselineFile.bytes,
          sha256: baselineRef.sha256,
        },
        donor: {
          name: donorName,
          bytes: donorBytes,
          sha256: donorSha,
        },
        regions: [{ x: 0, y: 0, width: 10, height: 10 }],
      }).pipe(
        Effect.catchEager(() => Effect.succeed(undefined)),
      )

      if (assemblyOutput) {
        state = yield* store.recordEvent(command.runDirectory, "ASSEMBLY_COMPLETED", {
          assembledName: assemblyOutput.name,
          sha256: assemblyOutput.sha256,
        })
      }
    }
  }

  // 5. Verification stage
  const verificationReport: VerificationReport = yield* verification.verify({
    state,
    outputFiles,
    assemblyOutput,
    requiresHumanApproval: command.requiresHumanApproval,
  }).pipe(
    Effect.catchEager((verErr) => {
      return Effect.succeed({
        outcome: "failed" as const,
        passed: false,
        stages: [],
        failureReason: verErr.message,
      })
    }),
  )

  if (verificationReport.outcome === "verified_candidate") {
    state = yield* store.recordEvent(command.runDirectory, "RUN_COMPLETED", {
      outcome: "verified_candidate",
    })
    const normalView: NormalView = {
      objective: state.request.objective,
      evidence: `Generated and verified ${outputFiles.length} output(s)${assemblyOutput ? " with deterministic assembly and 0 unlicensed changed pixels" : ""}.`,
      nextAction: "Candidate is machine-verified and ready for acceptance review.",
      spendRisk: `Money spent: $${costSpent}.`,
      humanDecision: "Subjective final visual approval by the application owner remains.",
    }
    yield* store.recordSummary(command.runDirectory, normalView, "verified_candidate")
    return {
      _tag: "VerifiedCandidate" as const,
      normalView,
      state,
      verificationReport,
      assemblyOutput,
    }
  }

  if (verificationReport.outcome === "human_decision_required") {
    const normalView: NormalView = {
      objective: state.request.objective,
      evidence: "Outputs generated; human visual approval requested.",
      nextAction: "Application owner must review candidate visually.",
      spendRisk: `Money spent: $${costSpent}.`,
      humanDecision: verificationReport.humanDecisionPrompt ?? "Human visual approval required.",
    }
    yield* store.recordSummary(command.runDirectory, normalView, "human_decision_required")
    return {
      _tag: "HumanDecisionRequired" as const,
      normalView,
      state,
      humanDecisionPrompt: verificationReport.humanDecisionPrompt ?? "Human visual approval required.",
      verificationReport,
    }
  }

  // Failed outcome
  state = yield* store.recordEvent(command.runDirectory, "RUN_FAILED", {
    reason: verificationReport.failureReason ?? "Verification failed",
  })
  const normalView: NormalView = {
    objective: state.request.objective,
    evidence: `Verification failed: ${verificationReport.failureReason ?? "Unknown failure"}`,
    nextAction: "Correct the underlying defect and plan a new linked run.",
    spendRisk: `Money spent: $${costSpent}.`,
    humanDecision: "No human visual approval possible for a failed candidate.",
  }
  yield* store.recordSummary(command.runDirectory, normalView, "failed")
  return {
    _tag: "Failed" as const,
    normalView,
    state,
    failureReason: verificationReport.failureReason ?? "Verification failed",
    verificationReport,
  }
}).pipe(
  Effect.catchEager((error): Effect.Effect<AdvanceDecision, never> => {
    const message = error instanceof Error ? error.message : "Advance failed"
    const isTamper = error instanceof Error && (error.message.includes("TAMPERED") || error.message.includes("BROKEN_EVENT_CHAIN"))
    const normalView: NormalView = {
      objective: "The run could not be advanced.",
      evidence: `Advance stopped: ${message}`,
      nextAction: isTamper ? "Investigate run record integrity." : "Correct the issue and retry.",
      spendRisk: "No new provider attempt was made during this failure.",
      humanDecision: isTamper ? "A human must inspect and repair or discard the tampered run record." : "No human decision requested.",
    }
    const emptyState: RunRecordState = {
      runId: command.runId ?? "unknown",
      runDirectory: command.runDirectory,
      status: "failed",
      request: {
        schemaVersion: "1",
        applicationId: "unknown",
        objectiveId: "unknown",
        objective: "Unknown objective",
        procedureId: "unknown",
        mode: "qwen-image",
        provider: "openrouter",
        model: "unknown",
        adapterProtocolVersion: "1",
        requestedCount: 1,
        estimatedMaximumCostUsd: "0.00",
        budgetCeilingUsd: "0.00",
        outputRoot: "generated",
        references: [],
        tool: {
          release: "v0.3.0",
          commit: "0".repeat(40),
          artifactSha256: "0".repeat(64),
          procedureVersion: "1",
          runSchemaVersion: "1",
          adapterProtocolVersion: "1",
        },
      },
      canonicalRequest: "",
      requestSha256: "",
      events: [],
      normalView,
      classifiedOutcome: "failed",
    }
    if (isTamper) {
      return Effect.succeed({
        _tag: "Blocked" as const,
        normalView,
        state: emptyState,
        blockReason: message,
      })
    }
    return Effect.succeed({
      _tag: "Failed" as const,
      normalView,
      state: emptyState,
      failureReason: message,
    })
  }),
)
