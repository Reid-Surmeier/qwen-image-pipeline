import type { ReviewInvalidationEvidence } from "../review/index.js"

export type EvidenceIdentity = Readonly<{ applicationPath: string; sha256: string }>

export type CompletedLearningEvidence = Readonly<{
  runId: string
  request: EvidenceIdentity
  candidate: EvidenceIdentity
  provenance: Readonly<{
    provider: "openrouter"
    model: string
    providerReceipt: EvidenceIdentity
  }>
  supportingEvidence: ReadonlyArray<EvidenceIdentity>
  knownBadCases: ReadonlyArray<ReviewInvalidationEvidence>
  proposedRule: string
  scope: string
  affectedSeam: string
  compatibilityRisk: string
  excludedApplicationDetail: string
}>

export type LearningProposal = Readonly<{
  schemaVersion: "1"
  state: "proposed"
  sourceRunId: string
  sourceRequest: EvidenceIdentity
  candidate: EvidenceIdentity
  proposedRule: string
  scope: string
  affectedSeam: string
  compatibilityRisk: string
  excludedApplicationDetail: string
  supportingEvidence: ReadonlyArray<EvidenceIdentity>
  counterevidence: ReadonlyArray<ReviewInvalidationEvidence>
  provenance: CompletedLearningEvidence["provenance"]
  proposalSha256: string
}>

export type LearningDecisionDraft = Readonly<{
  state: "review_required"
  proposalSha256: string
  affectedSeam: string
  exactToolCommit: string
  permittedAction: "review-proposal"
  prohibitedMutations: readonly ["Procedure", "interface", "errors", "tests", "application-lock"]
}>
