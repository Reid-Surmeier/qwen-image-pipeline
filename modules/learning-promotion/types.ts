export type EvidenceIdentity = Readonly<{
  applicationPath: string
  sha256: string
}>

export type CompletedLearningEvidence = Readonly<{
  runId: string
  requestSha256: string
  candidate: EvidenceIdentity
  provenance: Readonly<{
    provider: "openrouter"
    model: string
    providerReceiptSha256: string
  }>
  supportingEvidence: ReadonlyArray<EvidenceIdentity>
  knownBadCases: ReadonlyArray<Readonly<{
    name: string
    mutationSha256: string
    caught: boolean
    caughtBy: "Verification" | "Testing" | "Review"
    evidenceSha256: string
    findingCode: string
  }>>
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
  sourceRequestSha256: string
  candidateSha256: string
  proposedRule: string
  scope: string
  affectedSeam: string
  compatibilityRisk: string
  excludedApplicationDetail: string
  supportingEvidence: ReadonlyArray<EvidenceIdentity>
  counterevidence: ReadonlyArray<Readonly<{
    name: string
    mutationSha256: string
    caughtBy: "Verification" | "Testing" | "Review"
    evidenceSha256: string
    findingCode: string
  }>>
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
