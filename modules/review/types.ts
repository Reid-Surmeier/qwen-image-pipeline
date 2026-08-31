export type ReviewEvidenceIdentity = Readonly<{
  applicationPath: string
  sha256: string
}>

export type ReviewPacketInput = Readonly<{
  acceptanceContract: ReviewEvidenceIdentity
  run: Readonly<{
    runId: string
    requestSha256: string
    recordPath: string
    eventHeadSha256: string
  }>
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
  instructions: string
  verificationEvidence: ReadonlyArray<ReviewEvidenceIdentity>
  deterministicGate: "passed" | "failed"
  unresolvedHumanDecisions: ReadonlyArray<string>
}>

export type ReviewPacket = Readonly<{
  schemaVersion: "1"
  state: "ready_for_independent_review"
  acceptanceContract: ReviewEvidenceIdentity
  run: ReviewPacketInput["run"]
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
  instructions: string
  verificationEvidence: ReadonlyArray<ReviewEvidenceIdentity>
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
  requestSha256: string
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
}>
