import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { isIssuedReviewInvalidation } from "../review/index.js"
import { readDiagnostics, readEvidence, type RunRecordStoreService } from "../run-record/index.js"
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
  identity !== null && typeof identity === "object" && identity.applicationPath.length > 0 &&
  !isAbsolute(identity.applicationPath) && !identity.applicationPath.startsWith("~") &&
  !identity.applicationPath.includes("\\") && !identity.applicationPath.includes("\0") &&
  !/^[A-Za-z]:/.test(identity.applicationPath) &&
  identity.applicationPath.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  sha256Pattern.test(identity.sha256)
const sameIdentity = (left: EvidenceIdentity, right: EvidenceIdentity): boolean =>
  left.applicationPath === right.applicationPath && left.sha256 === right.sha256
const nonempty = (value: string): boolean => value.trim().length > 0

const validProposalShape = (proposal: LearningProposal): boolean => {
  const { proposalSha256, ...body } = proposal
  return proposal.schemaVersion === "1" && proposal.state === "proposed" &&
    nonempty(proposal.sourceRunId) && validIdentity(proposal.sourceRequest) && commitPattern.test(proposal.exactToolCommit) &&
    validIdentity(proposal.candidate) &&
    proposal.provenance.provider === "openrouter" && nonempty(proposal.provenance.model) &&
    validIdentity(proposal.provenance.providerReceipt) && proposal.supportingEvidence.length > 0 &&
    proposal.supportingEvidence.every(validIdentity) && proposal.counterevidence.length > 0 &&
    proposal.counterevidence.every((item) => isIssuedReviewInvalidation(item) &&
      item.counterexampleKind === "reference-identity-drift" && item.sourceRunId === proposal.sourceRunId &&
      item.supportedRule === proposal.proposedRule && item.proposedRuleSha256 === sha256(proposal.proposedRule) &&
      item.affectedSeam === proposal.affectedSeam && nonempty(item.mutationDescription)) &&
    [proposal.proposedRule, proposal.scope, proposal.affectedSeam, proposal.compatibilityRisk, proposal.excludedApplicationDetail].every(nonempty) &&
    sha256(canonical(body)) === proposalSha256
}

export const promoteLearning = (
  evidence: CompletedLearningEvidence,
): Effect.Effect<LearningProposal, LearningPromotionError, RunRecordStoreService> => Effect.gen(function*() {
  if (!nonempty(evidence.runId) || !validIdentity(evidence.candidate) || !validIdentity(evidence.provenance.providerReceipt)) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_PROVENANCE_MISSING", "Complete replay-authenticated OpenRouter provenance is required."))
  }
  if (
    evidence.supportingEvidence.length === 0 || !evidence.supportingEvidence.every(validIdentity) ||
    ![evidence.proposedRule, evidence.scope, evidence.affectedSeam, evidence.compatibilityRisk, evidence.excludedApplicationDetail].every(nonempty)
  ) return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Positive evidence and generalized proposal fields are required."))
  if (
    evidence.knownBadCases.length === 0 || !evidence.knownBadCases.every((item) =>
      isIssuedReviewInvalidation(item) && item.counterexampleKind === "reference-identity-drift" &&
      item.sourceRunId === evidence.runId && item.supportedRule === evidence.proposedRule &&
      item.proposedRuleSha256 === sha256(evidence.proposedRule) && item.affectedSeam === evidence.affectedSeam &&
      nonempty(item.mutationDescription))
  ) return yield* Effect.fail(new LearningPromotionError(
    "LEARNING_KNOWN_BAD_NOT_CAUGHT",
    "Review must independently catch a deliberate mutation bound to this Run, proposed rule, and seam.",
  ))

  const diagnostics = yield* readDiagnostics(evidence.runId).pipe(Effect.mapError(() =>
    new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "The source Run could not be replay-authenticated.")))
  if (
    diagnostics.view.phase !== "verified_candidate" || diagnostics.view.classification !== "verified_candidate" ||
    diagnostics.view.checksSha256 === undefined
  ) return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Only a replay-authenticated Verified Candidate can become a learning."))
  let request: Readonly<Record<string, unknown>>
  try { request = JSON.parse(Buffer.from(diagnostics.request).toString("utf8")) as Readonly<Record<string, unknown>> }
  catch { return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "The source Run request is invalid.")) }
  if (
    request === null || typeof request !== "object" || Array.isArray(request) ||
    request.provider !== "openrouter" || typeof request.model !== "string" || !nonempty(request.model) ||
    request.tool === null || typeof request.tool !== "object" || Array.isArray(request.tool) ||
    !commitPattern.test(String((request.tool as Readonly<Record<string, unknown>>).commit ?? ""))
  ) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_PROVENANCE_MISSING", "The source Run is not exact OpenRouter and installed-tool provenance."))
  }
  const exactToolCommit = String((request.tool as Readonly<Record<string, unknown>>).commit)
  const candidateEntry = request.mode === "qwen-image" && diagnostics.view.assemblyOutputSha256 !== undefined
    ? diagnostics.view.evidence.find((item) => item.applicationPath === "outputs/assembled.rgba.json" && item.sha256 === diagnostics.view.assemblyOutputSha256)
    : request.mode === "seedance-video"
      ? diagnostics.view.evidence.find((item) => sameIdentity(item, evidence.candidate) && item.applicationPath.startsWith("outputs/") && item.mediaType === "video/mp4")
      : undefined
  if (candidateEntry === undefined || !sameIdentity(candidateEntry, evidence.candidate)) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "The candidate does not belong to the verified source Run."))
  }
  const providerReceipt = request.mode === "qwen-image"
    ? diagnostics.view.evidence.find((item) => item.applicationPath === "provider-response.json" && item.mediaType === "application/json")
    : [...diagnostics.view.evidence].reverse().find((item) => item.applicationPath.startsWith("polls/") && item.mediaType === "application/json")
  if (providerReceipt === undefined || !sameIdentity(providerReceipt, evidence.provenance.providerReceipt)) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_PROVENANCE_MISSING", "The provider receipt does not belong to the verified source Run."))
  }
  const checkEntry = diagnostics.view.evidence.find((item) => item.sha256 === diagnostics.view.checksSha256)
  if (checkEntry === undefined || !evidence.supportingEvidence.some((item) => sameIdentity(item, checkEntry))) {
    return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "The source Run's deterministic checks are required as supporting evidence."))
  }
  for (const item of [evidence.candidate, evidence.provenance.providerReceipt, ...evidence.supportingEvidence]) {
    const runEntry = diagnostics.view.evidence.find((entry) => sameIdentity(entry, item))
    if (runEntry === undefined) {
      return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "Every learning artifact must belong to the same source Run."))
    }
    const bytes = yield* readEvidence(evidence.runId, item.applicationPath).pipe(Effect.mapError(() =>
      new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "A source Run artifact could not be replay-authenticated.")))
    if (sha256(bytes) !== item.sha256) {
      return yield* Effect.fail(new LearningPromotionError("LEARNING_EVIDENCE_INCOMPLETE", "A source Run artifact changed after verification."))
    }
  }
  const sourceRequest = {
    applicationPath: `runs/${evidence.runId}/request.json`,
    sha256: diagnostics.view.requestSha256,
  }
  const body = {
    schemaVersion: "1" as const,
    state: "proposed" as const,
    sourceRunId: evidence.runId,
    sourceRequest,
    exactToolCommit,
    candidate: { ...evidence.candidate },
    proposedRule: evidence.proposedRule,
    scope: evidence.scope,
    affectedSeam: evidence.affectedSeam,
    compatibilityRisk: evidence.compatibilityRisk,
    excludedApplicationDetail: evidence.excludedApplicationDetail,
    supportingEvidence: evidence.supportingEvidence.map((item) => ({ ...item })),
    counterevidence: [...evidence.knownBadCases],
    provenance: {
      provider: "openrouter" as const,
      model: request.model,
      providerReceipt: { ...evidence.provenance.providerReceipt },
    },
  }
  const proposal = freeze({ ...body, proposalSha256: sha256(canonical(body)) })
  issuedProposals.add(proposal)
  return proposal
})

export const openLearningDecision = (
  proposal: LearningProposal,
): Effect.Effect<LearningDecisionDraft, LearningPromotionError> => Effect.try({
  try: () => {
    if (!issuedProposals.has(proposal) || !validProposalShape(proposal)) {
      throw new LearningPromotionError("LEARNING_PROPOSAL_INVALID", "Only the exact issued complete proposal can open review.")
    }
    return freeze({
      state: "review_required" as const,
      proposalSha256: proposal.proposalSha256,
      affectedSeam: proposal.affectedSeam,
      exactToolCommit: proposal.exactToolCommit,
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
