import { Context } from "effect"

export type ReviewEvidenceIdentity = Readonly<{
  applicationPath: string
  sha256: string
}>

export type ReviewPacketInput = Readonly<{
  acceptanceContract: ReviewEvidenceIdentity
  reviewBrief: ReviewEvidenceIdentity
  runId: string
  references: ReadonlyArray<ReviewEvidenceIdentity>
  candidate: ReviewEvidenceIdentity
}>

export type ReviewPacket = Readonly<{
  schemaVersion: "1"
  state: "ready_for_independent_review"
  applicationCommit: string
  toolCommit: string
  acceptanceContract: ReviewEvidenceIdentity
  reviewBrief: ReviewEvidenceIdentity
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

export interface ReviewApplicationService {
  readonly _tag: "VerifiedReviewApplication"
}

export const ReviewApplication = Context.Service<ReviewApplicationService>(
  "qwen-pipeline/ReviewApplication",
)

export type ReviewApplicationSnapshot = Readonly<{
  applicationCommit: string
  files: ReadonlyMap<string, Uint8Array>
}>

export type ReviewCounterexample = Readonly<{
  kind: "reference-identity-drift"
}>

export type ReviewInvalidationEvidence = Readonly<{
  name: "candidate-changed" | "reference-changed"
  counterexampleKind: "reference-identity-drift"
  sourceRunId: string
  sourcePacketSha256: string
  supportedRule: "Invalidate review when a hash-locked reference changes."
  proposedRuleSha256: string
  affectedSeam: "Review.validateReviewPacket"
  mutationDescription: "Replace the exact reference bytes after packet creation."
  expectedSha256: string
  mutationSha256: string
  caughtBy: "Review"
  evidenceSha256: string
  findingCode: "CandidateIdentityChanged" | "ReferenceIdentityChanged"
}>
