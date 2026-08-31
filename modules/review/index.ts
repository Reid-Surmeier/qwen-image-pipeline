import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { readDiagnostics, readEvidence, type RunRecordStoreService } from "../run-record/index.js"
import { readVerifiedReviewApplication } from "./application.js"
import { ReviewPacketError } from "./errors.js"
import {
  ReviewApplication,
  type ReviewApplicationService,
  type ReviewCounterexample,
  type ReviewEvidenceIdentity,
  type ReviewInvalidationEvidence,
  type ReviewPacket,
  type ReviewPacketInput,
} from "./types.js"

const projectContractPath = ".qwen-pipeline/project-contract.json"
const sha256Pattern = /^[a-f0-9]{64}$/
const commitPattern = /^[a-f0-9]{40}$/
const issuedInvalidations = new WeakSet<object>()
const referenceIdentityDrift = Object.freeze({
  kind: "reference-identity-drift" as const,
  supportedRule: "Invalidate review when a hash-locked reference changes." as const,
  affectedSeam: "Review.validateReviewPacket" as const,
  mutationDescription: "Replace the exact reference bytes after packet creation." as const,
  findingCode: "ReferenceIdentityChanged" as const,
})

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
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const validIdentity = (identity: ReviewEvidenceIdentity): boolean =>
  identity !== null && typeof identity === "object" &&
  nonempty(identity.applicationPath) && !isAbsolute(identity.applicationPath) &&
  !identity.applicationPath.startsWith("~") && !identity.applicationPath.includes("\\") &&
  !identity.applicationPath.includes("\0") && !/^[A-Za-z]:/.test(identity.applicationPath) &&
  identity.applicationPath.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  sha256Pattern.test(identity.sha256)
const sameIdentity = (left: ReviewEvidenceIdentity, right: ReviewEvidenceIdentity): boolean =>
  left.applicationPath === right.applicationPath && left.sha256 === right.sha256

type ReferenceMismatch = Readonly<{
  code: "ReferenceIdentityChanged"
  expectedSha256: string
  actualSha256: string
}>

type Authority = Readonly<{
  applicationCommit: string
  canonicalRequest: string
  requestSha256: string
  eventHeadSha256: string
  toolCommit: string
  instructions: string
  unresolvedHumanDecisions: ReadonlyArray<string>
  verificationEvidence: ReviewEvidenceIdentity
  referenceMismatch?: ReferenceMismatch
}>

const expectedCandidate = (
  request: Readonly<Record<string, unknown>>,
  evidence: ReadonlyArray<Readonly<{ applicationPath: string; sha256: string; mediaType: string }>>,
  assemblyOutputSha256: string | undefined,
  candidate: ReviewEvidenceIdentity,
): ReviewEvidenceIdentity | undefined => {
  if (request.mode === "qwen-image" && assemblyOutputSha256 !== undefined) {
    return evidence.find((entry) =>
      entry.applicationPath === "outputs/assembled.rgba.json" && entry.sha256 === assemblyOutputSha256)
  }
  if (request.mode === "seedance-video") {
    return evidence.find((entry) =>
      entry.applicationPath === candidate.applicationPath && entry.sha256 === candidate.sha256 &&
      entry.applicationPath.startsWith("outputs/") && entry.mediaType === "video/mp4")
  }
  return undefined
}

const parseReviewBrief = (
  bytes: Uint8Array,
): Effect.Effect<Readonly<{ instructions: string; unresolvedHumanDecisions: ReadonlyArray<string> }>, ReviewPacketError> =>
  Effect.try({
    try: () => {
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Readonly<Record<string, unknown>>
      if (
        parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(",") !== "instructions,unresolvedHumanDecisions" ||
        !nonempty(parsed.instructions) || !Array.isArray(parsed.unresolvedHumanDecisions) ||
        parsed.unresolvedHumanDecisions.length === 0 || !parsed.unresolvedHumanDecisions.every(nonempty)
      ) throw new Error("invalid review brief")
      return {
        instructions: parsed.instructions,
        unresolvedHumanDecisions: [...parsed.unresolvedHumanDecisions] as ReadonlyArray<string>,
      }
    },
    catch: () => new ReviewPacketError("ReviewPacketInvalid", "The application review brief is invalid."),
  })

const authenticate = (
  input: Pick<ReviewPacketInput, "acceptanceContract" | "reviewBrief" | "runId" | "references" | "candidate">,
): Effect.Effect<Authority, ReviewPacketError, ReviewApplicationService | RunRecordStoreService> => Effect.gen(function*() {
  const diagnostics = yield* readDiagnostics(input.runId).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewPacketInvalid", "The Run Record could not be replay-authenticated.")))
  if (
    diagnostics.view.phase !== "verified_candidate" ||
    diagnostics.view.classification !== "verified_candidate" ||
    diagnostics.view.checksSha256 === undefined
  ) return yield* Effect.fail(new ReviewPacketError("ReviewBlocked", "Only a replay-authenticated deterministic Verified Candidate may enter review."))
  const canonicalRequest = Buffer.from(diagnostics.request).toString("utf8")
  let request: Readonly<Record<string, unknown>>
  try { request = JSON.parse(canonicalRequest) as Readonly<Record<string, unknown>> }
  catch { return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The exact Run Request is not readable JSON.")) }
  const tool = request.tool as Readonly<Record<string, unknown>> | undefined
  const requestReferences = Array.isArray(request.references) ? request.references as Array<Readonly<Record<string, unknown>>> : []
  const expectedReferences = requestReferences.map((reference) => ({
    applicationPath: String(reference.applicationPath ?? ""),
    sha256: String(reference.sha256 ?? ""),
  }))
  if (!commitPattern.test(String(tool?.commit ?? "")) || canonical(expectedReferences) !== canonical(input.references)) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The packet references or tool commit do not match the exact Run Request."))
  }
  const candidateEntry = expectedCandidate(request, diagnostics.view.evidence, diagnostics.view.assemblyOutputSha256, input.candidate)
  if (candidateEntry === undefined || !sameIdentity(candidateEntry, input.candidate)) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The candidate is not the replay-authenticated verified candidate for this Run."))
  }
  const candidateBytes = yield* readEvidence(input.runId, input.candidate.applicationPath).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewPacketInvalid", "The verified candidate could not be replay-authenticated.")))
  if (sha256(candidateBytes) !== input.candidate.sha256) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The verified candidate bytes changed inside the Run Record."))
  }
  const checkEntry = diagnostics.view.evidence.find((entry) => entry.sha256 === diagnostics.view.checksSha256)
  if (checkEntry === undefined) return yield* Effect.fail(new ReviewPacketError("ReviewBlocked", "The deterministic check evidence is missing."))
  yield* readEvidence(input.runId, checkEntry.applicationPath).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewBlocked", "The deterministic check evidence could not be replay-authenticated.")))

  const application = yield* ReviewApplication
  const snapshot = yield* readVerifiedReviewApplication(application, [
    projectContractPath,
    input.acceptanceContract.applicationPath,
    input.reviewBrief.applicationPath,
    ...input.references.map((reference) => reference.applicationPath),
  ])
  let projectContract: Readonly<Record<string, unknown>>
  try { projectContract = JSON.parse(Buffer.from(snapshot.files.get(projectContractPath)!).toString("utf8")) as Readonly<Record<string, unknown>> }
  catch { return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The current Project Contract is invalid.")) }
  if (
    projectContract === null || typeof projectContract !== "object" || Array.isArray(projectContract) ||
    !nonempty(projectContract.applicationId) || projectContract.applicationId !== request.applicationId
  ) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The application repository does not own this Run."))
  }
  const acceptanceBytes = snapshot.files.get(input.acceptanceContract.applicationPath)!
  const briefBytes = snapshot.files.get(input.reviewBrief.applicationPath)!
  if (sha256(acceptanceBytes) !== input.acceptanceContract.sha256 || sha256(briefBytes) !== input.reviewBrief.sha256) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The acceptance contract or review brief changed."))
  }
  const brief = yield* parseReviewBrief(briefBytes)
  let referenceMismatch: ReferenceMismatch | undefined
  for (const reference of input.references) {
    const actual = sha256(snapshot.files.get(reference.applicationPath)!)
    if (actual !== reference.sha256 && referenceMismatch === undefined) {
      referenceMismatch = { code: "ReferenceIdentityChanged", expectedSha256: reference.sha256, actualSha256: actual }
    }
  }
  return {
    applicationCommit: snapshot.applicationCommit,
    canonicalRequest,
    requestSha256: diagnostics.view.requestSha256,
    eventHeadSha256: diagnostics.view.chainHeadSha256,
    toolCommit: String(tool!.commit),
    instructions: brief.instructions,
    unresolvedHumanDecisions: brief.unresolvedHumanDecisions,
    verificationEvidence: { applicationPath: checkEntry.applicationPath, sha256: checkEntry.sha256 },
    ...(referenceMismatch === undefined ? {} : { referenceMismatch }),
  }
})

const validPacketShape = (packet: ReviewPacket): boolean => {
  if (packet === null || typeof packet !== "object") return false
  const { packetSha256, ...body } = packet
  return Object.keys(packet).sort().join(",") === [
    "acceptanceContract", "applicationCommit", "candidate", "instructions", "machineVerification", "normalView",
    "ownerApproval", "packetSha256", "references", "reviewBrief", "run", "schemaVersion", "state", "toolCommit",
    "unresolvedHumanDecisions", "verificationEvidence",
  ].sort().join(",") &&
    packet.schemaVersion === "1" && packet.state === "ready_for_independent_review" &&
    commitPattern.test(packet.applicationCommit) && commitPattern.test(packet.toolCommit) &&
    validIdentity(packet.acceptanceContract) && validIdentity(packet.reviewBrief) &&
    packet.run !== null && typeof packet.run === "object" && !Array.isArray(packet.run) &&
    Object.keys(packet.run).sort().join(",") === "canonicalRequest,eventHeadSha256,requestSha256,runId" &&
    nonempty(packet.run.runId) && nonempty(packet.run.canonicalRequest) &&
    sha256Pattern.test(packet.run.requestSha256) && sha256Pattern.test(packet.run.eventHeadSha256) &&
    Array.isArray(packet.references) && packet.references.length > 0 && packet.references.every(validIdentity) &&
    validIdentity(packet.candidate) && nonempty(packet.instructions) && Array.isArray(packet.unresolvedHumanDecisions) &&
    packet.unresolvedHumanDecisions.length > 0 &&
    packet.unresolvedHumanDecisions.every(nonempty) && validIdentity(packet.verificationEvidence) &&
    packet.machineVerification === "passed" && packet.ownerApproval === "unresolved" &&
    packet.normalView !== null && typeof packet.normalView === "object" && !Array.isArray(packet.normalView) &&
    Object.keys(packet.normalView).sort().join(",") === "machineVerification,nextAction,ownerApproval" &&
    packet.normalView.machineVerification === "passed" && packet.normalView.ownerApproval === "unresolved" &&
    packet.normalView.nextAction === "independent-review" && sha256Pattern.test(packetSha256) &&
    sha256(canonical(body)) === packetSha256
}

const authenticatePacket = (
  packet: ReviewPacket,
): Effect.Effect<Authority, ReviewPacketError, ReviewApplicationService | RunRecordStoreService> => Effect.gen(function*() {
  if (!validPacketShape(packet)) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The review packet is malformed or its hash no longer matches."))
  }
  const authority = yield* authenticate({
    acceptanceContract: packet.acceptanceContract,
    reviewBrief: packet.reviewBrief,
    runId: packet.run.runId,
    references: packet.references,
    candidate: packet.candidate,
  })
  if (
    authority.applicationCommit !== packet.applicationCommit || authority.canonicalRequest !== packet.run.canonicalRequest ||
    authority.requestSha256 !== packet.run.requestSha256 || authority.eventHeadSha256 !== packet.run.eventHeadSha256 ||
    authority.toolCommit !== packet.toolCommit || authority.instructions !== packet.instructions ||
    canonical(authority.unresolvedHumanDecisions) !== canonical(packet.unresolvedHumanDecisions) ||
    canonical(authority.verificationEvidence) !== canonical(packet.verificationEvidence)
  ) return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The Run, application, brief, commit, or deterministic evidence changed."))
  return authority
})

export const prepareReviewPacket = (
  input: ReviewPacketInput,
): Effect.Effect<ReviewPacket, ReviewPacketError, ReviewApplicationService | RunRecordStoreService> => Effect.gen(function*() {
  if (
    !validIdentity(input.acceptanceContract) || !validIdentity(input.reviewBrief) || !nonempty(input.runId) ||
    input.references.length === 0 || !input.references.every(validIdentity) || !validIdentity(input.candidate)
  ) return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The packet request is missing exact evidence identities."))
  const authority = yield* authenticate(input)
  if (authority.referenceMismatch !== undefined) {
    return yield* Effect.fail(new ReviewPacketError("ReferenceIdentityChanged", "A reference changed before packet creation."))
  }
  const body = {
    schemaVersion: "1" as const,
    state: "ready_for_independent_review" as const,
    applicationCommit: authority.applicationCommit,
    toolCommit: authority.toolCommit,
    acceptanceContract: { ...input.acceptanceContract },
    reviewBrief: { ...input.reviewBrief },
    run: {
      runId: input.runId,
      canonicalRequest: authority.canonicalRequest,
      requestSha256: authority.requestSha256,
      eventHeadSha256: authority.eventHeadSha256,
    },
    references: input.references.map((reference) => ({ ...reference })),
    candidate: { ...input.candidate },
    instructions: authority.instructions,
    verificationEvidence: authority.verificationEvidence,
    unresolvedHumanDecisions: [...authority.unresolvedHumanDecisions],
    machineVerification: "passed" as const,
    ownerApproval: "unresolved" as const,
    normalView: { machineVerification: "passed" as const, ownerApproval: "unresolved" as const, nextAction: "independent-review" as const },
  }
  return freeze({ ...body, packetSha256: sha256(canonical(body)) })
})

export const validateReviewPacket = (
  packet: ReviewPacket,
): Effect.Effect<void, ReviewPacketError, ReviewApplicationService | RunRecordStoreService> => Effect.gen(function*() {
  const authority = yield* authenticatePacket(packet)
  if (authority.referenceMismatch !== undefined) {
    return yield* Effect.fail(new ReviewPacketError("ReferenceIdentityChanged", "A reference changed after packet creation."))
  }
})

export const catchReviewCounterexample = (
  packet: ReviewPacket,
  counterexample: ReviewCounterexample,
): Effect.Effect<ReviewInvalidationEvidence, ReviewPacketError, ReviewApplicationService | RunRecordStoreService> => Effect.gen(function*() {
  if (
    counterexample === null || typeof counterexample !== "object" ||
    Object.keys(counterexample).join(",") !== "kind" ||
    counterexample.kind !== referenceIdentityDrift.kind
  ) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The deliberate counterexample kind is not owned by Review."))
  }
  const authority = yield* authenticatePacket(packet)
  const mismatch = authority.referenceMismatch
  if (mismatch === undefined) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The deliberate counterexample did not trigger Review."))
  }
  const body = {
    name: "reference-changed" as const,
    counterexampleKind: referenceIdentityDrift.kind,
    sourceRunId: packet.run.runId,
    sourcePacketSha256: packet.packetSha256,
    supportedRule: referenceIdentityDrift.supportedRule,
    proposedRuleSha256: sha256(referenceIdentityDrift.supportedRule),
    affectedSeam: referenceIdentityDrift.affectedSeam,
    mutationDescription: referenceIdentityDrift.mutationDescription,
    expectedSha256: mismatch.expectedSha256,
    mutationSha256: mismatch.actualSha256,
    caughtBy: "Review" as const,
    findingCode: referenceIdentityDrift.findingCode,
  }
  const evidence = freeze({ ...body, evidenceSha256: sha256(canonical(body)) })
  issuedInvalidations.add(evidence)
  return evidence
})

export const isIssuedReviewInvalidation = (evidence: ReviewInvalidationEvidence): boolean =>
  issuedInvalidations.has(evidence)

export { fileReviewApplication } from "./application.js"
export { ReviewPacketError } from "./errors.js"
export { ReviewApplication } from "./types.js"
export type {
  ReviewApplicationService,
  ReviewCounterexample,
  ReviewEvidenceIdentity,
  ReviewInvalidationEvidence,
  ReviewPacket,
  ReviewPacketInput,
} from "./types.js"
