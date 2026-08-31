import { Effect } from "effect"

import { assemble } from "../assembly/index.js"
import { invoke, prepare } from "../generation/index.js"
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
  type RunRecordDiagnostics,
} from "../run-record/index.js"
import { verify } from "../verification/index.js"
import type {
  AdvanceCommand,
  AdvanceDecision,
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

const isNormalizedRgba = (bytes: Uint8Array): boolean => {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>
    const { width, height, pixels } = value
    return (
      typeof width === "number" && Number.isSafeInteger(width) && width > 0 &&
      typeof height === "number" && Number.isSafeInteger(height) && height > 0 &&
      Array.isArray(pixels) && pixels.length === width * height * 4 &&
      pixels.every((channel) => typeof channel === "number" && Number.isInteger(channel) && channel >= 0 && channel <= 255)
    )
  } catch {
    return false
  }
}

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

const humanDecision = (diagnostics: RunRecordDiagnostics, objective: string): AdvanceDecision => ({
  _tag: "HumanDecisionRequired",
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
    runId: diagnostics.view.runId,
    candidate: {
      applicationPath: "outputs/assembled.rgba.json",
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

export const advanceRun = (
  command: AdvanceCommand,
): Effect.Effect<AdvanceDecision, ConductorError, ApplicationFilesService | import("../generation/index.js").GenerationAdapterService | import("../run-record/index.js").RunRecordStoreService | import("../run-record/index.js").RunRecordClockService> =>
  Effect.gen(function*() {
    const request = command.run.request
    if (request.mode !== "qwen-image" || request.assemblyPlan?.required !== true) {
      return yield* Effect.fail(new ConductorError(
        "ADVANCE_REQUIRES_QWEN_ASSEMBLY",
        "This advance path requires a Qwen Image Planned Run with mandatory Assembly.",
      ))
    }

    const files = yield* ApplicationFiles
    const references = yield* Effect.forEach(request.references, (reference) =>
      files.read(reference.applicationPath).pipe(
        Effect.map((snapshot) => ({
          slot: reference.slot,
          applicationPath: reference.applicationPath,
          sha256: reference.sha256,
          payloadDestination: reference.payloadDestination,
          mediaType: reference.kind === "video"
            ? "video/mp4" as const
            : isNormalizedRgba(snapshot.bytes)
              ? "application/vnd.qwen.rgba+json" as const
              : "image/png" as const,
          bytes: snapshot.bytes,
        })),
        Effect.mapError(asConductorError(
          "REFERENCE_EVIDENCE_UNAVAILABLE",
          `The locked reference ${reference.applicationPath} could not be read.`,
        )),
      ),
    )
    const prepared = yield* prepare(request, references).pipe(
      Effect.mapError(asConductorError(
        "REFERENCE_EVIDENCE_UNAVAILABLE",
        "The exact Generation reference payload could not be prepared.",
      )),
    )
    let current = yield* reserve({
      plannedRun: command.run,
      payloadSha256: prepared.payloadSha256,
    }).pipe(Effect.mapError(asConductorError(
      "RUN_RECORD_FAILURE",
      "The immutable Planned Run could not be reserved or reloaded.",
    )))

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
      const generated = yield* invoke(prepared, marked.permit).pipe(
        Effect.mapError(asConductorError(
          "GENERATION_FAILURE",
          "The one permitted Generation invocation did not return trustworthy normalized evidence.",
        )),
      )
      const provider = yield* record({
        _tag: "CommitProviderEvidence",
        runId: current.runId,
        operationId: "conductor-provider-evidence",
        evidence: generated.providerEvidence,
      }).pipe(Effect.mapError(asConductorError(
        "RUN_RECORD_FAILURE",
        "Normalized provider evidence could not be persisted.",
      )))
      current = provider.view
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
      const assembled = yield* assemble({
        baseline: { body: baseline.bytes, sha256: baseline.sha256 },
        donor: { body: donorBytes, sha256: selectedDonorSha256 },
        ownedRegion: request.assemblyPlan.ownedRegion,
        exactCopy: request.assemblyPlan.exactCopy,
      }).pipe(Effect.mapError(asConductorError(
        "ASSEMBLY_FAILURE",
        "Hash-locked deterministic Assembly failed.",
      )))
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
    const checked = yield* verify({
      baseline: { body: baseline.bytes, sha256: baseline.sha256 },
      donor: { body: donorBytes, sha256: selectedDonorSha256 },
      candidate: { body: candidateBytes, sha256: current.assemblyOutputSha256! },
      ownedRegion: request.assemblyPlan.ownedRegion,
      exactCopy: request.assemblyPlan.exactCopy,
      assemblyRequired: true,
    }).pipe(Effect.mapError(asConductorError(
      "VERIFICATION_FAILURE",
      "The assembled candidate did not pass the ordered Fidelity Checks.",
    )))
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
