import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { ApplicationFiles, type ApplicationFilesService } from "../reference-planning/index.js"
import { isIssuedReviewInvalidation } from "../review/index.js"
import { LearningPromotionError } from "./errors.js"
import type { CompletedLearningEvidence, EvidenceIdentity, LearningDecisionDraft, LearningProposal } from "./types.js"

const sha256Pattern = /^[a-f0-9]{64}$/
const commitPattern = /^[a-f0-9]{40}$/
const issuedProposals = new WeakSet<object>()

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex")
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
const validIdentity = (identity: EvidenceIdentity): boolean =>
  identity.applicationPath.length > 0 && !isAbsolute(identity.applicationPath) &&
  !identity.applicationPath.startsWith("~") && !identity.applicationPath.includes("\\") &&
  !identity.applicationPath.includes("\0") && !/^[A-Za-z]:/.test(identity.applicationPath) &&
  identity.applicationPath.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  sha256Pattern.test(identity.sha256)
const nonempty = (value: string): boolean => value.trim().length > 0

const verifyIdentity = (
  files: ApplicationFilesService,
  identity: EvidenceIdentity,
): Effect.Effect<void, LearningPromotionError> => files.read(identity.applicationPath).pipe(
  Effect.flatMap((snapshot) => sha256(snapshot.bytes) === identity.sha256
    ? Effect.void
    : Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", `Evidence changed at ${identity.applicationPath}.`))),
  Effect.mapError((error) => error instanceof LearningPromotionError
    ? error
    : new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", `Evidence could not be read at ${identity.applicationPath}.`)),
)

const validProposalShape = (proposal: LearningProposal): boolean => {
  const { proposalSha256, ...body } = proposal
  return proposal.schemaVersion === "1" && proposal.state === "proposed" &&
    nonempty(proposal.sourceRunId) && validIdentity(proposal.sourceRequest) && validIdentity(proposal.candidate) &&
    proposal.provenance.provider === "openrouter" && nonempty(proposal.provenance.model) &&
    validIdentity(proposal.provenance.providerReceipt) && proposal.supportingEvidence.length > 0 &&
    proposal.supportingEvidence.every(validIdentity) && proposal.counterevidence.length > 0 &&
    proposal.counterevidence.every(isIssuedReviewInvalidation) &&
    [proposal.proposedRule, proposal.scope, proposal.affectedSeam, proposal.compatibilityRisk, proposal.excludedApplicationDetail].every(nonempty) &&
    sha256(canonical(body)) === proposalSha256
}

export const promoteLearning = (
  evidence: CompletedLearningEvidence,
): Effect.Effect<LearningProposal, LearningPromotionError, ApplicationFilesService> => Effect.gen(function*() {
  if (
    evidence.provenance.provider !== "openrouter" || !nonempty(evidence.provenance.model) ||
    !validIdentity(evidence.provenance.providerReceipt)
  ) return yield* Effect.fail(new LearningPromotionError("LEARNING_PROVENANCE_MISSING", "Complete OpenRouter provenance is required."))
  if (
    !nonempty(evidence.runId) || !validIdentity(evidence.request) || !validIdentity(evidence.candidate) ||
    evidence.supportingEvidence.length === 0 || !evidence.supportingEvidence.every(validIdentity) ||
    ![evidence.proposedRule, evidence.scope, evidence.affectedSeam, evidence.compatibilityRisk, evidence.excludedApplicationDetail].every(nonempty)
  ) return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Positive evidence and generalized proposal fields are required."))
  if (evidence.knownBadCases.length === 0 || !evidence.knownBadCases.every(isIssuedReviewInvalidation)) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_KNOWN_BAD_NOT_CAUGHT", "An independently issued Review invalidation is required."))
  }
  const files = yield* ApplicationFiles
  yield* Effect.forEach([
    evidence.request,
    evidence.candidate,
    evidence.provenance.providerReceipt,
    ...evidence.supportingEvidence,
  ], (identity) => verifyIdentity(files, identity), { concurrency: 1 })
  const body = {
    schemaVersion: "1" as const,
    state: "proposed" as const,
    sourceRunId: evidence.runId,
    sourceRequest: { ...evidence.request },
    candidate: { ...evidence.candidate },
    proposedRule: evidence.proposedRule,
    scope: evidence.scope,
    affectedSeam: evidence.affectedSeam,
    compatibilityRisk: evidence.compatibilityRisk,
    excludedApplicationDetail: evidence.excludedApplicationDetail,
    supportingEvidence: evidence.supportingEvidence.map((item) => ({ ...item })),
    counterevidence: [...evidence.knownBadCases],
    provenance: { ...evidence.provenance, providerReceipt: { ...evidence.provenance.providerReceipt } },
  }
  const proposal = freeze({ ...body, proposalSha256: sha256(canonical(body)) })
  issuedProposals.add(proposal)
  return proposal
})

export const openLearningDecision = (
  proposal: LearningProposal,
  exactToolCommit: string,
): Effect.Effect<LearningDecisionDraft, LearningPromotionError> => Effect.try({
  try: () => {
    if (!issuedProposals.has(proposal) || !validProposalShape(proposal) || !commitPattern.test(exactToolCommit)) {
      throw new LearningPromotionError("LEARNING_PROPOSAL_INVALID", "Only the exact issued complete proposal can open review.")
    }
    return freeze({
      state: "review_required" as const,
      proposalSha256: proposal.proposalSha256,
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
export type { CompletedLearningEvidence, EvidenceIdentity, LearningDecisionDraft, LearningProposal } from "./types.js"
