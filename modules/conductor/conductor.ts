import { Effect } from "effect"

import { assemble } from "../assembly/index.js"
import { invoke, pollSeedance, prepare, recover, submitSeedance, type GenerationResult } from "../generation/index.js"
import {
  ApplicationFiles,
  compilePlannedRun,
  type ApplicationFilesService,
  type MediaInspectorService,
  type PlanningIdentityService,
} from "../run-contract/index.js"
import {
  readEvidence,
  readDiagnostics,
  record,
  reserve,
  type ClassifiedFailureInput,
  type ClassifiedFailureClass,
  type RunRecordDiagnostics,
  type SubmissionPermit,
} from "../run-record/index.js"
import { verify } from "../verification/index.js"
import { verifyVideo } from "../video-verification/index.js"
import type {
  AdvanceCommand,
  AdvanceDecision,
  CorrectionOwner,
  NormalView,
  PlanCommand,
  PlanDecision,
} from "./types.js"
import { PROJECT_CONTRACT_PATH, TOOL_LOCK_PATH } from "./types.js"
import { ConductorError, type ConductorErrorCode } from "./errors.js"
import type {
  PlanningRefusal,
  PlanningRefusalCode,
} from "./errors.js"

const namedCause = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

const asConductorError = (
  code: ConductorErrorCode,
  message: string,
) => (error: unknown): ConductorError => new ConductorError(code, message, namedCause(error))

const spendRisk = "Planning made no provider request, created no attempt, and spent $0. A later advance may spend up to the locked ceiling."

const advanceReferenceRefused = (
  objective: string,
  error: unknown,
): Extract<AdvanceDecision, { _tag: "AdvanceRefused" }> => ({
  _tag: "AdvanceRefused",
  outcome: "blocked",
  finding: {
    code: namedCause(error) ?? "REFERENCE_EVIDENCE_UNAVAILABLE",
    message: "The planned authoritative reference was unavailable or changed before the Run could be reserved.",
    correctionOwner: "Reference Planning",
  },
  normalView: {
    objective,
    evidence: "The planned reference could not be re-read and hash-locked into the exact provider payload.",
    nextAction: "Restore or correct the authoritative reference, then plan again.",
    spendRisk: "No provider request was made, no attempt was reserved, and spend is $0.",
    humanDecision: "A human is needed only if the application has no unambiguous authoritative reference.",
  },
})

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
  VIDEO_PLAN_INVALID: fixDocument,
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

const planningCorrectionOwner = (code: PlanningRefusalCode): CorrectionOwner => {
  if (
    code === "REFERENCE_MISSING" || code === "REFERENCE_HASH_MISMATCH" ||
    code === "REFERENCE_KIND_MISMATCH" || code === "REFERENCE_AUTHORITY_MISSING" ||
    code === "REFERENCE_PATH_UNSAFE" || code === "PAYLOAD_DESTINATION_INVALID" ||
    code === "MEDIA_INSPECTION_FAILED" || code === "DECLARED_MEDIA_MISMATCH" ||
    code === "SEEDANCE_VIDEO_REFERENCE_REQUIRED"
  ) return "Reference Planning"
  return "application decision owner"
}

const refusedDecision = (
  refusal: PlanningRefusal,
  objective?: string,
): Extract<PlanDecision, { _tag: "Refused" }> => ({
  _tag: "Refused",
  outcome: refusal.code === "DOCUMENT_INVALID" || refusal.code === "SECRET_MATERIAL_DETECTED"
    ? "failed"
    : "blocked",
  finding: {
    code: refusal.code,
    message: refusal.message,
    correctionOwner: planningCorrectionOwner(refusal.code),
  },
  refusal,
  normalView: refusedView(refusal, objective),
})

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
    return Effect.succeed(refusedDecision(refusal))
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
      return Effect.succeed(refusedDecision(
        refusal,
        refusal.code === "SECRET_MATERIAL_DETECTED" ? undefined : describedObjective,
      ))
    }),
  )
}

const humanDecision = (diagnostics: RunRecordDiagnostics, objective: string): AdvanceDecision => ({
  _tag: "HumanDecisionRequired",
  outcome: "human_decision_required",
  finding: {
    code: "DONOR_CHOICE_REQUIRED",
    message: "A persisted donor must be selected before deterministic Assembly can continue.",
    correctionOwner: "application decision owner",
  },
  runId: diagnostics.view.runId,
  decision: {
    kind: "donor-choice",
    candidateSha256s: diagnostics.view.donorCandidateSha256s ?? [],
  },
  normalView: {
    objective,
    evidence: "Generation evidence is durable, but the raw output is only a donor and cannot be the final candidate.",
    nextAction: "Inspect the persisted donor candidates and advance this same Run with one selected SHA-256.",
    spendRisk: "The one planned provider request may already be spent; this Run will never submit it again.",
    humanDecision: "A human must choose one persisted donor before deterministic Assembly can continue.",
  },
  diagnostics,
})

const verifiedDecision = (diagnostics: RunRecordDiagnostics, objective: string): AdvanceDecision => {
  return {
    _tag: "VerifiedCandidate",
    outcome: "verified_candidate",
    runId: diagnostics.view.runId,
    candidate: {
      applicationPath: "outputs/assembled.rgba.json",
      mediaType: "application/vnd.qwen.rgba+json",
      sha256: diagnostics.view.assemblyOutputSha256!,
    },
    normalView: {
      objective,
      evidence: "Assembly and all ordered Fidelity Checks passed against the hash-locked baseline and selected donor.",
      nextAction: "Review the assembled candidate visually; do not substitute the raw generated donor.",
      spendRisk: "No further provider request is allowed on this Run.",
      humanDecision: "Subjective final visual approval remains with the human owner.",
    },
    diagnostics,
  }
}

const providerPendingDecision = (
  diagnostics: RunRecordDiagnostics,
  objective: string,
): AdvanceDecision => ({
  _tag: "ProviderPending",
  runId: diagnostics.view.runId,
  jobId: diagnostics.view.providerJobId!,
  pollCount: diagnostics.view.pollCount ?? 0,
  normalView: {
    objective,
    evidence: `Seedance job ${diagnostics.view.providerJobId} is persisted with ${diagnostics.view.pollCount ?? 0} completed status poll${diagnostics.view.pollCount === 1 ? "" : "s"}.`,
    nextAction: "Advance this same Run again to poll the existing job identity; do not submit a new job.",
    spendRisk: "The one planned provider submission may already be spent; polling cannot authorize another submission.",
    humanDecision: "No human decision is needed while the existing provider job is still running.",
  },
  diagnostics,
})

const verifiedVideoDecision = (
  diagnostics: RunRecordDiagnostics,
  objective: string,
): AdvanceDecision => {
  const output = diagnostics.view.evidence.find((item) =>
    item.applicationPath.startsWith("outputs/") && item.mediaType === "video/mp4")!
  return {
    _tag: "VerifiedCandidate",
    outcome: "verified_candidate",
    runId: diagnostics.view.runId,
    candidate: {
      applicationPath: output.applicationPath as `outputs/${string}`,
      mediaType: "video/mp4",
      sha256: output.sha256,
    },
    normalView: {
      objective,
      evidence: "The completed video passed exact hash, media, dimensions, duration, audio-expectation, count, and cost-state checks.",
      nextAction: "Review the verified video candidate visually; do not submit another provider job for this Run.",
      spendRisk: "No further provider submission is allowed on this Run.",
      humanDecision: "Subjective final visual approval remains with the human owner.",
    },
    diagnostics,
  }
}

const terminalFailureDecision = (
  diagnostics: RunRecordDiagnostics,
  objective: string,
  finding: Extract<AdvanceDecision, { _tag: "Blocked" | "Failed" }>["finding"],
  outcome: "blocked" | "failed",
): Extract<AdvanceDecision, { _tag: "Blocked" | "Failed" }> => {
  const normalView: NormalView = {
    objective,
    evidence: `${finding.code}: ${finding.message}`,
    nextAction: outcome === "blocked"
      ? "Reconcile only the existing Run and provider identity; do not submit again or start autonomous correction."
      : diagnostics.view.retryState === "new-linked-run-only"
        ? `Correct the material owned by ${finding.correctionOwner}, then plan a distinct linked Run.`
        : "Stop autonomous correction and preserve this failed Run unchanged.",
    spendRisk: diagnostics.view.spendState === "not_spent"
      ? "The evidence proves no provider spend occurred on this Run."
      : diagnostics.view.spendState === "possibly_spent"
        ? "This Run may have spent its locked provider budget and must not submit again."
        : "Provider spend is unknown; this Run must not submit again.",
    humanDecision: finding.correctionOwner === "application decision owner"
      ? "The application owner must decide the named correction; machine classification is not Approval."
      : "No subjective Approval is being recorded; the named module owns any technical correction.",
  }
  return outcome === "blocked"
    ? { _tag: "Blocked", outcome, runId: diagnostics.view.runId, finding, normalView, diagnostics }
    : { _tag: "Failed", outcome, runId: diagnostics.view.runId, finding, normalView, diagnostics }
}

const replayedTerminalDecision = (
  diagnostics: RunRecordDiagnostics,
  objective: string,
): Extract<AdvanceDecision, { _tag: "Blocked" | "Failed" }> => {
  const finding = diagnostics.view.finding
  if (
    (diagnostics.view.classification !== "blocked" && diagnostics.view.classification !== "failed") ||
    finding === undefined
  ) {
    throw new ConductorError("RUN_STATE_UNSUPPORTED", "The terminal Run has no replay-verified failure classification.")
  }
  return terminalFailureDecision(diagnostics, objective, {
    code: finding.class,
    message: finding.message,
    correctionOwner: finding.correctionOwner,
  }, diagnostics.view.classification)
}

const classifyRunFailure = (
  runId: string,
  objective: string,
  failure: ClassifiedFailureInput,
): Effect.Effect<AdvanceDecision, ConductorError, import("../run-record/index.js").RunRecordStoreService | import("../run-record/index.js").RunRecordClockService> =>
  Effect.gen(function*() {
    const result = yield* record({
      _tag: "ClassifyFailure",
      runId,
      operationId: `conductor-${failure.class}`,
      failure,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The terminal module failure could not be persisted.",
    )))
    const diagnostics = yield* readDiagnostics(result.view.runId).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The terminal module failure could not be replayed.",
    )))
    return replayedTerminalDecision(diagnostics, objective)
  })

const classifyGenerationFailure = (
  runId: string,
  objective: string,
  error: unknown,
  permit?: SubmissionPermit,
): Effect.Effect<AdvanceDecision, ConductorError, import("../run-record/index.js").RunRecordStoreService | import("../run-record/index.js").RunRecordClockService> => {
  const code = namedCause(error)
  if (code === "ADAPTER_NOT_STARTED") {
    if (permit === undefined) {
      return Effect.fail(new ConductorError(
        "GENERATION_FAILURE",
        "A submission-not-started refusal has no live Submission Permit proof.",
        code,
      ))
    }
    return Effect.gen(function*() {
      const result = yield* record({
        _tag: "DefinitivePreSubmitFailure",
        runId,
        operationId: "conductor-adapter-not-started",
        permit,
        failure: {
          class: "submission_not_started",
          message: "The unused submission capability proves that no provider submission began.",
        },
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The definitive pre-submit adapter refusal could not be persisted.",
      )))
      const diagnostics = yield* readDiagnostics(result.view.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The definitive pre-submit adapter refusal could not be replayed.",
      )))
      return replayedTerminalDecision(diagnostics, objective)
    })
  }
  const failureClass = code === "PROVIDER_AMBIGUOUS"
    ? "ambiguous_provider_timeout" as const
    : code === "OUTPUT_COUNT_MISMATCH"
      ? "output_count_mismatch" as const
      : code === "ADAPTER_RESULT_INVALID" || code === "PROVIDER_SUBSTITUTION"
        ? "malformed_provider_response" as const
        : undefined
  if (failureClass === undefined) {
    return Effect.fail(asConductorError(
      "GENERATION_FAILURE",
      "Generation failed without a safe terminal classification.",
    )(error))
  }
  const message = failureClass === "ambiguous_provider_timeout"
    ? "The provider result is ambiguous and this Run cannot submit again."
    : failureClass === "output_count_mismatch"
      ? "The provider returned a completed output count that contradicts the immutable request."
      : "The provider response or normalized adapter evidence is malformed."
  return classifyRunFailure(runId, objective, { class: failureClass, message })
}

const persistWithReconciliation = <Success, Error, Requirements>(
  operation: Effect.Effect<Success, Error, Requirements>,
  message: string,
): Effect.Effect<Success, ConductorError, Requirements> =>
  operation.pipe(
    Effect.catchEager(() => operation),
    Effect.mapError(asConductorError("RUN_RECORD_FAILURE", message)),
  )

const advanceSeedanceRun = (
  command: AdvanceCommand,
): Effect.Effect<AdvanceDecision, ConductorError, ApplicationFilesService | import("../generation/index.js").GenerationAdapterService | import("../run-record/index.js").RunRecordStoreService | import("../run-record/index.js").RunRecordClockService> =>
  Effect.gen(function*() {
    const request = command.run.request
    if (
      request.mode !== "seedance-video" || request.videoPlan === undefined ||
      request.videoPlan.assembly.required !== false ||
      request.videoPlan.assembly.pixelOwnership !== "none-authoritative" ||
      request.assemblyPlan !== undefined
    ) {
      return yield* Effect.fail(new ConductorError(
        "ADVANCE_REQUIRES_VALIDATED_VIDEO_PLAN",
        "Seedance advance requires the immutable Video Plan and its explicit no-authoritative-pixel-ownership proof.",
      ))
    }
    const files = yield* ApplicationFiles
    const referenceAttempt = yield* Effect.forEach(request.references, (reference) =>
      files.read(reference.applicationPath).pipe(
        Effect.map((snapshot) => ({
          slot: reference.slot,
          applicationPath: reference.applicationPath,
          sha256: reference.sha256,
          payloadDestination: reference.payloadDestination,
          mediaType: reference.mediaType,
          bytes: snapshot.bytes,
        })),
        Effect.mapError(asConductorError(
          "REFERENCE_EVIDENCE_UNAVAILABLE",
          `The locked reference ${reference.applicationPath} could not be read.`,
        )),
      ),
    ).pipe(Effect.match({
      onFailure: (error) => ({ _tag: "Failure" as const, error }),
      onSuccess: (value) => ({ _tag: "Success" as const, value }),
    }))
    if (referenceAttempt._tag === "Failure") return advanceReferenceRefused(request.objective, referenceAttempt.error)
    const references = referenceAttempt.value
    const preparedAttempt = yield* prepare(request, references).pipe(
      Effect.mapError(asConductorError(
        "REFERENCE_EVIDENCE_UNAVAILABLE",
        "The exact Seedance reference payload could not be prepared.",
      )),
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }),
    )
    if (preparedAttempt._tag === "Failure") return advanceReferenceRefused(request.objective, preparedAttempt.error)
    const prepared = preparedAttempt.value
    let current = yield* reserve({
      plannedRun: command.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The immutable Seedance Run could not be reserved or reloaded.",
    )))

    if (current.phase === "definitive_pre_submit_failure" || current.phase === "blocked" || current.phase === "failed") {
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The terminal Seedance outcome could not be replayed.",
      )))
      return replayedTerminalDecision(diagnostics, request.objective)
    }

    if (current.phase === "reserved") {
      const marked = yield* record({
        _tag: "SubmissionMayHaveStarted",
        runId: current.runId,
        operationId: "conductor-seedance-submit-once",
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The durable Seedance submission marker could not be recorded.",
      )))
      if (marked._tag !== "SubmissionPermitIssued") {
        return yield* Effect.fail(new ConductorError(
          "RUN_STATE_UNSUPPORTED",
          "The Seedance Run did not issue its one in-process Submission Permit.",
        ))
      }
      const submissionAttempt = yield* submitSeedance(prepared, marked.permit).pipe(Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }))
      if (submissionAttempt._tag === "Failure") {
        return yield* classifyGenerationFailure(current.runId, request.objective, submissionAttempt.error, marked.permit)
      }
      const submitted = submissionAttempt.value
      const persisted = yield* persistWithReconciliation(record({
        _tag: "CommitProviderEvidence",
        runId: current.runId,
        operationId: "conductor-seedance-submission-evidence",
        evidence: submitted.providerEvidence,
      }), "The submitted Seedance job receipt could not be reconciled after a local persistence interruption.")
      const diagnostics = yield* readDiagnostics(persisted.view.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The submitted Seedance job diagnostics could not be replayed.",
      )))
      return providerPendingDecision(diagnostics, request.objective)
    }

    if (current.phase === "provider_evidence_received") {
      if (current.providerJobId === undefined) {
        return yield* Effect.fail(new ConductorError(
          "RUN_RECORD_FAILURE",
          "The persisted Seedance submission has no replay-verified job identity.",
        ))
      }
      const submissionReceipt = current.evidence.find((item) => item.applicationPath === "provider-response.json")
      if (submissionReceipt === undefined) {
        return yield* Effect.fail(new ConductorError(
          "RUN_RECORD_FAILURE",
          "The persisted Seedance submission response is missing.",
        ))
      }
      const submissionBody = yield* readEvidence(current.runId, submissionReceipt.applicationPath).pipe(
        Effect.mapError(asConductorError(
          "RUN_RECORD_FAILURE",
          "The persisted Seedance submission response could not be verified and read.",
        )),
      )
      const pollAttempt = yield* pollSeedance(prepared, current.providerJobId, {
        mediaType: "application/json",
        body: submissionBody,
        sha256: submissionReceipt.sha256,
      }).pipe(Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }))
      if (pollAttempt._tag === "Failure") {
        return yield* classifyGenerationFailure(current.runId, request.objective, pollAttempt.error)
      }
      const polled = pollAttempt.value
      const persisted = yield* persistWithReconciliation(record(polled.status === "pending"
        ? {
            _tag: "CommitSeedancePoll" as const,
            runId: current.runId,
            operationId: `conductor-seedance-poll-${(current.pollCount ?? 0) + 1}`,
            jobId: current.providerJobId,
            status: "pending" as const,
            evidence: polled.providerEvidence,
          }
        : {
            _tag: "CommitSeedancePoll" as const,
            runId: current.runId,
            operationId: `conductor-seedance-poll-${(current.pollCount ?? 0) + 1}`,
            jobId: current.providerJobId,
            status: "completed" as const,
            evidence: polled.providerEvidence,
            outputs: polled.outputs,
            completedCount: polled.completedCount,
            cost: polled.cost,
          }), "The Seedance poll receipt could not be reconciled after a local persistence interruption.")
      current = persisted.view
      if (polled.status === "pending" || current.phase === "provider_evidence_received") {
        const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
          "RUN_RECORD_FAILURE",
          "The pending Seedance diagnostics could not be replayed.",
        )))
        return providerPendingDecision(diagnostics, request.objective)
      }
    }

    if (current.phase === "verified_candidate") {
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The verified Seedance diagnostics could not be replayed.",
      )))
      return verifiedVideoDecision(diagnostics, request.objective)
    }
    if (current.phase !== "generated_outputs_received" || current.providerJobId === undefined) {
      return yield* Effect.fail(new ConductorError(
        "RUN_STATE_UNSUPPORTED",
        `The Seedance Run is in ${current.phase}; it cannot submit again and has no completed output to verify.`,
      ))
    }
    const outputReceipts = current.evidence.filter((item) =>
      item.applicationPath.startsWith("outputs/") && item.mediaType === "video/mp4")
    const outputs = yield* Effect.forEach(outputReceipts, (receipt) =>
      readEvidence(current.runId, receipt.applicationPath).pipe(
        Effect.map((body) => ({
          applicationPath: receipt.applicationPath as `outputs/${string}.mp4`,
          mediaType: "video/mp4" as const,
          body,
          sha256: receipt.sha256,
        })),
        Effect.mapError(asConductorError(
          "RUN_RECORD_FAILURE",
          "The completed Seedance output could not be verified and read.",
        )),
      ),
    )
    const verificationAttempt = yield* verifyVideo({
      outputs,
      expected: request.videoPlan.expectedMedia,
      requestedCount: request.requestedCount,
      completedCount: current.completedCount ?? -1,
      cost: {
        state: current.costState ?? "unknown",
        estimatedMaximumCostUsd: request.estimatedMaximumCostUsd,
        ...(current.actualCostUsd === undefined ? {} : { actualCostUsd: current.actualCostUsd }),
      },
    }).pipe(Effect.match({
      onFailure: (error) => ({ _tag: "Failure" as const, error }),
      onSuccess: (value) => ({ _tag: "Success" as const, value }),
    }))
    if (verificationAttempt._tag === "Failure") {
      return yield* classifyRunFailure(
        current.runId,
        request.objective,
        {
          class: "verification_failure",
          message: "The completed Seedance output did not pass independent media verification.",
          cause: verificationAttempt.error,
        },
      )
    }
    const checked = verificationAttempt.value
    const committed = yield* record({
      _tag: "CommitVideoChecks",
      runId: current.runId,
      operationId: "conductor-seedance-video-checks",
      jobId: current.providerJobId,
      report: checked,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The independent Seedance video checks could not be persisted.",
    )))
    const diagnostics = yield* readDiagnostics(committed.view.runId).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The verified Seedance diagnostics could not be replayed.",
    )))
    return verifiedVideoDecision(diagnostics, request.objective)
  })

export const advanceRun = (
  command: AdvanceCommand,
): Effect.Effect<AdvanceDecision, ConductorError, ApplicationFilesService | import("../generation/index.js").GenerationAdapterService | import("../run-record/index.js").RunRecordStoreService | import("../run-record/index.js").RunRecordClockService> =>
  Effect.gen(function*() {
    const request = command.run.request
    if (request.mode === "seedance-video") {
      return yield* advanceSeedanceRun(command)
    }
    if (request.mode !== "qwen-image" || request.assemblyPlan?.required !== true) {
      return yield* Effect.fail(new ConductorError(
        "ADVANCE_REQUIRES_QWEN_ASSEMBLY",
        "This advance path requires a Qwen Image Planned Run with mandatory Assembly.",
      ))
    }

    const files = yield* ApplicationFiles
    const referenceAttempt = yield* Effect.forEach(request.references, (reference) =>
      files.read(reference.applicationPath).pipe(
        Effect.map((snapshot) => ({
          slot: reference.slot,
          applicationPath: reference.applicationPath,
          sha256: reference.sha256,
          payloadDestination: reference.payloadDestination,
          mediaType: reference.mediaType,
          bytes: snapshot.bytes,
        })),
        Effect.mapError(asConductorError(
          "REFERENCE_EVIDENCE_UNAVAILABLE",
          `The locked reference ${reference.applicationPath} could not be read.`,
        )),
      ),
    ).pipe(Effect.match({
      onFailure: (error) => ({ _tag: "Failure" as const, error }),
      onSuccess: (value) => ({ _tag: "Success" as const, value }),
    }))
    if (referenceAttempt._tag === "Failure") return advanceReferenceRefused(request.objective, referenceAttempt.error)
    const references = referenceAttempt.value
    const preparedAttempt = yield* prepare(request, references).pipe(
      Effect.mapError(asConductorError(
        "REFERENCE_EVIDENCE_UNAVAILABLE",
        "The exact Generation reference payload could not be prepared.",
      )),
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }),
    )
    if (preparedAttempt._tag === "Failure") return advanceReferenceRefused(request.objective, preparedAttempt.error)
    const prepared = preparedAttempt.value
    let current = yield* reserve({
      plannedRun: command.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The immutable Planned Run could not be reserved or reloaded.",
    )))
    let generated: GenerationResult | undefined

    if (current.phase === "definitive_pre_submit_failure" || current.phase === "blocked" || current.phase === "failed") {
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The terminal Qwen outcome could not be replayed.",
      )))
      return replayedTerminalDecision(diagnostics, request.objective)
    }

    if (current.phase === "reserved") {
      const marked = yield* record({
        _tag: "SubmissionMayHaveStarted",
        runId: current.runId,
        operationId: "conductor-submit-once",
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The durable submission marker could not be recorded.",
      )))
      if (marked._tag !== "SubmissionPermitIssued") {
        return yield* Effect.fail(new ConductorError(
          "RUN_STATE_UNSUPPORTED",
          "The Run did not issue its one in-process Submission Permit.",
        ))
      }
      const generationAttempt = yield* invoke(prepared, marked.permit).pipe(Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }))
      if (generationAttempt._tag === "Failure") {
        return yield* classifyGenerationFailure(current.runId, request.objective, generationAttempt.error, marked.permit)
      }
      generated = generationAttempt.value
      const provider = yield* persistWithReconciliation(record({
        _tag: "CommitProviderEvidence",
        runId: current.runId,
        operationId: "conductor-provider-evidence",
        evidence: generated.providerEvidence,
      }), "The Qwen provider receipt could not be reconciled after a local persistence interruption.")
      current = provider.view
    }

    if (current.phase === "provider_evidence_received" || current.phase === "generated_outputs_received") {
      if (generated === undefined) {
        const providerReceipt = current.evidence.find((item) => item.applicationPath === "provider-response.json")
        if (providerReceipt === undefined || providerReceipt.mediaType !== "application/json") {
          return yield* Effect.fail(new ConductorError(
            "RUN_RECORD_FAILURE",
            "The persisted provider response receipt is missing or has the wrong media type.",
          ))
        }
        const providerBody = yield* readEvidence(current.runId, providerReceipt.applicationPath).pipe(
          Effect.mapError(asConductorError(
            "RUN_RECORD_FAILURE",
            "The persisted provider response could not be verified and read for recovery.",
          )),
        )
        generated = yield* recover(prepared, {
          mediaType: "application/json",
          body: providerBody,
          sha256: providerReceipt.sha256,
        }).pipe(Effect.mapError(asConductorError(
          "GENERATION_FAILURE",
          "Persisted provider evidence could not recover the normalized outputs without resubmission.",
        )))
      }
      for (const [index, output] of generated.outputs.entries()) {
        const persisted = yield* record({
          _tag: "CommitGeneratedOutput",
          runId: current.runId,
          operationId: `conductor-generated-output-${index + 1}`,
          output: {
            ...output,
            applicationPath: output.applicationPath as `outputs/${string}`,
          },
        }).pipe(Effect.mapError(asConductorError(
          "RUN_RECORD_FAILURE",
          "Normalized generated output evidence could not be persisted.",
        )))
        current = persisted.view
      }
      const opened = yield* record({
        _tag: "OpenDonorChoice",
        runId: current.runId,
        operationId: "conductor-open-donor-choice",
        candidateSha256s: generated.outputs.map((output) => output.sha256),
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The donor-choice checkpoint could not be persisted.",
      )))
      current = opened.view
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The donor-choice diagnostics could not be replayed.",
      )))
      return humanDecision(diagnostics, request.objective)
    }

    if (current.phase === "verified_candidate") {
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The Verified Candidate diagnostics could not be replayed.",
      )))
      return verifiedDecision(diagnostics, request.objective)
    }
    if (current.phase === "awaiting_donor_choice" && command.selectedDonorSha256 === undefined) {
      const diagnostics = yield* readDiagnostics(current.runId).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The donor-choice diagnostics could not be replayed.",
      )))
      return humanDecision(diagnostics, request.objective)
    }
    if (current.phase === "awaiting_donor_choice") {
      if (!current.donorCandidateSha256s?.includes(command.selectedDonorSha256!)) {
        return yield* Effect.fail(new ConductorError(
          "DONOR_DECISION_INVALID",
          "The selected SHA-256 must name one persisted candidate in this Run's donor checkpoint.",
        ))
      }
      const selected = yield* record({
        _tag: "SelectDonor",
        runId: current.runId,
        operationId: "conductor-select-donor",
        selectedSha256: command.selectedDonorSha256!,
      }).pipe(Effect.mapError(asConductorError(
        "DONOR_DECISION_INVALID",
        "The donor decision could not be recorded on this Run.",
      )))
      current = selected.view
    }

    if (current.phase !== "donor_selected" && current.phase !== "assembly_completed") {
      return yield* Effect.fail(new ConductorError(
        "RUN_STATE_UNSUPPORTED",
        `The Run is in ${current.phase}; it cannot be submitted again or advanced without reconciliation.`,
      ))
    }
    if (
      command.selectedDonorSha256 !== undefined &&
      current.selectedDonorSha256 !== command.selectedDonorSha256
    ) {
      return yield* Effect.fail(new ConductorError(
        "DONOR_DECISION_INVALID",
        "The supplied donor SHA-256 disagrees with the immutable selection already recorded on this Run.",
      ))
    }

    const baselineReference = request.references.find(
      (reference) => reference.slot === request.assemblyPlan!.baselineReferenceSlot,
    )!
    const baseline = references.find((reference) => reference.slot === baselineReference.slot)!
    const donorEvidence = current.evidence.find((evidence) =>
      evidence.applicationPath.startsWith("outputs/") && evidence.sha256 === current.selectedDonorSha256)
    if (donorEvidence === undefined || current.selectedDonorSha256 === undefined) {
      return yield* Effect.fail(new ConductorError(
        "DONOR_DECISION_INVALID",
        "The selected donor has no verified persisted evidence on this Run.",
      ))
    }
    const selectedDonorSha256 = current.selectedDonorSha256
    const donorBytes = yield* readEvidence(current.runId, donorEvidence.applicationPath).pipe(
      Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The selected donor evidence could not be verified and read.",
      )),
    )

    if (current.phase === "donor_selected") {
      const assemblyAttempt = yield* assemble({
        baseline: { body: baseline.bytes, sha256: baseline.sha256 },
        donor: { body: donorBytes, sha256: selectedDonorSha256 },
        ownedRegion: request.assemblyPlan.ownedRegion,
        exactCopy: request.assemblyPlan.exactCopy,
      }).pipe(Effect.match({
        onFailure: (error) => ({ _tag: "Failure" as const, error }),
        onSuccess: (value) => ({ _tag: "Success" as const, value }),
      }))
      if (assemblyAttempt._tag === "Failure") {
        return yield* classifyRunFailure(
          current.runId,
          request.objective,
          {
            class: "assembly_failure",
            message: "Hash-locked deterministic Assembly failed.",
            cause: assemblyAttempt.error,
          },
        )
      }
      const assembled = assemblyAttempt.value
      const persisted = yield* record({
        _tag: "CommitAssembly",
        runId: current.runId,
        operationId: "conductor-commit-assembly",
        output: assembled.output,
        report: assembled.report,
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The Assembly output and report could not be persisted.",
      )))
      current = persisted.view
    }

    const candidateBytes = yield* readEvidence(current.runId, "outputs/assembled.rgba.json").pipe(
      Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "The assembled candidate evidence could not be verified and read.",
      )),
    )
    const verificationAttempt = yield* verify({
      baseline: { body: baseline.bytes, sha256: baseline.sha256 },
      donor: { body: donorBytes, sha256: selectedDonorSha256 },
      candidate: { body: candidateBytes, sha256: current.assemblyOutputSha256! },
      ownedRegion: request.assemblyPlan.ownedRegion,
      exactCopy: request.assemblyPlan.exactCopy,
    }).pipe(Effect.match({
      onFailure: (error) => ({ _tag: "Failure" as const, error }),
      onSuccess: (value) => ({ _tag: "Success" as const, value }),
    }))
    if (verificationAttempt._tag === "Failure") {
      return yield* classifyRunFailure(
        current.runId,
        request.objective,
        {
          class: "verification_failure",
          message: "The assembled candidate did not pass the ordered Fidelity Checks.",
          cause: verificationAttempt.error,
        },
      )
    }
    const checked = verificationAttempt.value
    const committed = yield* record({
      _tag: "CommitChecks",
      runId: current.runId,
      operationId: "conductor-commit-checks",
      candidateSha256: checked.candidateSha256,
      classification: checked.classification,
      baseline: { body: baseline.bytes, sha256: baseline.sha256 },
      checks: checked.checks,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The ordered Fidelity Check evidence could not be persisted.",
    )))
    const diagnostics = yield* readDiagnostics(committed.view.runId).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The Verified Candidate diagnostics could not be replayed.",
    )))
    return verifiedDecision(diagnostics, request.objective)
  })
