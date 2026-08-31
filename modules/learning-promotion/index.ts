import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { LearningPromotionError } from "./errors.js"
import type {
  CompletedLearningEvidence,
  EvidenceIdentity,
  LearningDecisionDraft,
  LearningProposal,
} from "./types.js"

const sha256Pattern = /^[a-f0-9]{64}$/
const commitPattern = /^[a-f0-9]{40}$/

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

const safePath = (value: string): boolean =>
  value.length > 0 && !isAbsolute(value) && !value.startsWith("~") &&
  !value.includes("\\") && !value.includes("\0") && !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")

const validIdentity = (identity: EvidenceIdentity): boolean =>
  safePath(identity.applicationPath) && sha256Pattern.test(identity.sha256)

const nonempty = (value: string): boolean => value.trim().length > 0

export const promoteLearning = (
  evidence: CompletedLearningEvidence,
): Effect.Effect<LearningProposal, LearningPromotionError> => Effect.try({
  try: () => {
    if (
      evidence.provenance.provider !== "openrouter" ||
      !nonempty(evidence.provenance.model) ||
      !sha256Pattern.test(evidence.provenance.providerReceiptSha256)
    ) throw new LearningPromotionError("LEARNING_PROVENANCE_MISSING", "Complete OpenRouter provenance is required.")
    if (
      !nonempty(evidence.runId) || !sha256Pattern.test(evidence.requestSha256) ||
      !validIdentity(evidence.candidate) || evidence.supportingEvidence.length === 0 ||
      !evidence.supportingEvidence.every(validIdentity) ||
      ![evidence.proposedRule, evidence.scope, evidence.affectedSeam, evidence.compatibilityRisk, evidence.excludedApplicationDetail].every(nonempty)
    ) throw new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Positive evidence and generalized proposal fields are required.")
    const caught = evidence.knownBadCases.filter((knownBad) =>
      knownBad.caught && ["Verification", "Testing", "Review"].includes(knownBad.caughtBy) &&
      nonempty(knownBad.name) && nonempty(knownBad.findingCode) &&
      sha256Pattern.test(knownBad.mutationSha256) && sha256Pattern.test(knownBad.evidenceSha256))
    if (caught.length === 0) {
      throw new LearningPromotionError("LEARNING_KNOWN_BAD_NOT_CAUGHT", "At least one independently caught known-bad mutation is required.")
    }
    const body = {
      schemaVersion: "1" as const,
      state: "proposed" as const,
      sourceRunId: evidence.runId,
      sourceRequestSha256: evidence.requestSha256,
      candidateSha256: evidence.candidate.sha256,
      proposedRule: evidence.proposedRule,
      scope: evidence.scope,
      affectedSeam: evidence.affectedSeam,
      compatibilityRisk: evidence.compatibilityRisk,
      excludedApplicationDetail: evidence.excludedApplicationDetail,
      supportingEvidence: evidence.supportingEvidence.map((item) => ({ ...item })),
      counterevidence: caught.map(({ name, mutationSha256, caughtBy, evidenceSha256, findingCode }) => ({
        name, mutationSha256, caughtBy, evidenceSha256, findingCode,
      })),
      provenance: { ...evidence.provenance },
    }
    return freeze({
      ...body,
      proposalSha256: createHash("sha256").update(canonical(body)).digest("hex"),
    })
  },
  catch: (error) => error instanceof LearningPromotionError
    ? error
    : new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Learning evidence could not be validated."),
})

export const openLearningDecision = (
  proposal: LearningProposal,
  exactToolCommit: string,
): Effect.Effect<LearningDecisionDraft, LearningPromotionError> => Effect.try({
  try: () => {
    const { proposalSha256, ...body } = proposal
    if (!commitPattern.test(exactToolCommit) || createHash("sha256").update(canonical(body)).digest("hex") !== proposalSha256) {
      throw new LearningPromotionError("LEARNING_PROPOSAL_INVALID", "The proposal or exact tool commit is invalid.")
    }
    return freeze({
      state: "review_required" as const,
      proposalSha256,
      affectedSeam: proposal.affectedSeam,
      exactToolCommit,
      permittedAction: "review-proposal" as const,
      prohibitedMutations: ["Procedure", "interface", "errors", "tests", "application-lock"] as const,
    })
  },
  catch: (error) => error instanceof LearningPromotionError
    ? error
    : new LearningPromotionError("LEARNING_PROPOSAL_INVALID", "The learning decision could not be opened."),
})

export { LearningPromotionError } from "./errors.js"
export type {
  CompletedLearningEvidence,
  EvidenceIdentity,
  LearningDecisionDraft,
  LearningProposal,
} from "./types.js"
