export type ReviewEvidenceIdentity = Readonly<{
  applicationPath: string
  sha256: string
}>

export type ReviewPacketInput = Readonly<{
  applicationCommit: string
  acceptanceContract: ReviewEvidenceIdentity
  runId: string
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
  instructions: string
  unresolvedHumanDecisions: ReadonlyArray<string>
}>

export type ReviewPacket = Readonly<{
  schemaVersion: "1"
  state: "ready_for_independent_review"
  applicationCommit: string
  toolCommit: string
  acceptanceContract: ReviewEvidenceIdentity
  run: Readonly<{
    runId: string
    canonicalRequest: string
    requestSha256: string
    eventHeadSha256: string
  }>
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
  instructions: string
  verificationEvidence: ReviewEvidenceIdentity
  unresolvedHumanDecisions: ReadonlyArray<string>
  machineVerification: "passed"
  ownerApproval: "unresolved"
  normalView: Readonly<{
    machineVerification: "passed"
    ownerApproval: "unresolved"
    nextAction: "independent-review"
  }>
  packetSha256: string
}>

export type ReviewPacketBindings = Readonly<{
  applicationCommit: string
}>

export type ReviewInvalidationEvidence = Readonly<{
  name: "candidate-changed" | "reference-changed"
  mutationSha256: string
  caughtBy: "Review"
  evidenceSha256: string
  findingCode: "CandidateIdentityChanged" | "ReferenceIdentityChanged"
}>
