import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { ApplicationFiles, type ApplicationFilesService } from "../reference-planning/index.js"
import { readDiagnostics, readEvidence, type RunRecordStoreService } from "../run-record/index.js"
import { ReviewPacketError } from "./errors.js"
import type {
  ReviewEvidenceIdentity,
  ReviewInvalidationEvidence,
  ReviewPacket,
  ReviewPacketBindings,
  ReviewPacketInput,
} from "./types.js"

const sha256Pattern = /^[a-f0-9]{64}$/
const commitPattern = /^[a-f0-9]{40}$/
const issuedInvalidations = new WeakSet<object>()
const invalidationByError = new WeakMap<ReviewPacketError, ReviewInvalidationEvidence>()

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
const validIdentity = (identity: ReviewEvidenceIdentity): boolean =>
  identity.applicationPath.length > 0 && !isAbsolute(identity.applicationPath) &&
  !identity.applicationPath.startsWith("~") && !identity.applicationPath.includes("\\") &&
  !identity.applicationPath.includes("\0") && !/^[A-Za-z]:/.test(identity.applicationPath) &&
  identity.applicationPath.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  sha256Pattern.test(identity.sha256)

const makeInvalidation = (
  code: "CandidateIdentityChanged" | "ReferenceIdentityChanged",
  actualSha256: string,
  expectedSha256: string,
): ReviewPacketError => {
  const error = new ReviewPacketError(code, code === "CandidateIdentityChanged"
    ? "The candidate changed after packet creation."
    : "A reference changed after packet creation.")
  const body = {
    name: code === "CandidateIdentityChanged" ? "candidate-changed" as const : "reference-changed" as const,
    mutationSha256: actualSha256,
    caughtBy: "Review" as const,
    findingCode: code,
  }
  const evidence = freeze({ ...body, evidenceSha256: sha256(canonical({ ...body, expectedSha256 })) })
  issuedInvalidations.add(evidence)
  invalidationByError.set(error, evidence)
  return error
}

type Authority = Readonly<{
  canonicalRequest: string
  requestSha256: string
  eventHeadSha256: string
  toolCommit: string
  verificationEvidence: ReviewEvidenceIdentity
}>

const authenticate = (
  input: Pick<ReviewPacketInput, "acceptanceContract" | "runId" | "references" | "candidate">,
): Effect.Effect<Authority, ReviewPacketError, ApplicationFilesService | RunRecordStoreService> => Effect.gen(function*() {
  const files = yield* ApplicationFiles
  const diagnostics = yield* readDiagnostics(input.runId).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewPacketInvalid", "The Run Record could not be replay-authenticated.")))
  if (
    diagnostics.view.phase !== "verified_candidate" ||
    diagnostics.view.classification !== "verified_candidate" ||
    diagnostics.view.checksSha256 === undefined
  ) return yield* Effect.fail(new ReviewPacketError("ReviewBlocked", "Only a replay-authenticated deterministic Verified Candidate may enter review."))
  const canonicalRequest = Buffer.from(diagnostics.request).toString("utf8")
  let request: Record<string, unknown>
  try { request = JSON.parse(canonicalRequest) as Record<string, unknown> }
  catch { return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The exact Run Request is not readable JSON.")) }
  const tool = request.tool as Record<string, unknown> | undefined
  const requestReferences = Array.isArray(request.references) ? request.references as Array<Record<string, unknown>> : []
  const expectedReferences = requestReferences.map((reference) => ({
    applicationPath: String(reference.applicationPath ?? ""),
    sha256: String(reference.sha256 ?? ""),
  }))
  if (!commitPattern.test(String(tool?.commit ?? "")) || canonical(expectedReferences) !== canonical(input.references)) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The packet references or tool commit do not match the exact Run Request."))
  }
  const acceptance = yield* files.read(input.acceptanceContract.applicationPath).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewPacketInvalid", "The acceptance contract could not be read.")))
  if (sha256(acceptance.bytes) !== input.acceptanceContract.sha256) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The acceptance contract changed."))
  }
  for (const reference of input.references) {
    const current = yield* files.read(reference.applicationPath).pipe(Effect.mapError(() =>
      new ReviewPacketError("ReferenceIdentityChanged", "A reference could not be reread.")))
    const actual = sha256(current.bytes)
    if (actual !== reference.sha256) return yield* Effect.fail(makeInvalidation("ReferenceIdentityChanged", actual, reference.sha256))
  }
  const candidateEntry = diagnostics.view.evidence.find((entry) =>
    entry.applicationPath === input.candidate.applicationPath && entry.sha256 === input.candidate.sha256)
  if (candidateEntry === undefined) {
    return yield* Effect.fail(makeInvalidation("CandidateIdentityChanged", "0".repeat(64), input.candidate.sha256))
  }
  const candidateBytes = yield* readEvidence(input.runId, input.candidate.applicationPath).pipe(Effect.mapError(() =>
    new ReviewPacketError("CandidateIdentityChanged", "The candidate could not be replay-authenticated.")))
  const actualCandidate = sha256(candidateBytes)
  if (actualCandidate !== input.candidate.sha256) {
    return yield* Effect.fail(makeInvalidation("CandidateIdentityChanged", actualCandidate, input.candidate.sha256))
  }
  const checkEntry = diagnostics.view.evidence.find((entry) => entry.sha256 === diagnostics.view.checksSha256)
  if (checkEntry === undefined) return yield* Effect.fail(new ReviewPacketError("ReviewBlocked", "The deterministic check evidence is missing."))
  yield* readEvidence(input.runId, checkEntry.applicationPath).pipe(Effect.mapError(() =>
    new ReviewPacketError("ReviewBlocked", "The deterministic check evidence could not be replay-authenticated.")))
  return {
    canonicalRequest,
    requestSha256: diagnostics.view.requestSha256,
    eventHeadSha256: diagnostics.view.chainHeadSha256,
    toolCommit: String(tool!.commit),
    verificationEvidence: { applicationPath: checkEntry.applicationPath, sha256: checkEntry.sha256 },
  }
})

export const prepareReviewPacket = (
  input: ReviewPacketInput,
): Effect.Effect<ReviewPacket, ReviewPacketError, ApplicationFilesService | RunRecordStoreService> => Effect.gen(function*() {
  if (
    !commitPattern.test(input.applicationCommit) || !validIdentity(input.acceptanceContract) ||
    !input.runId.trim() || input.references.length === 0 || !input.references.every(validIdentity) ||
    !validIdentity(input.candidate) || !input.instructions.trim() || input.unresolvedHumanDecisions.length === 0 ||
    input.unresolvedHumanDecisions.some((decision) => !decision.trim())
  ) return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The packet request is missing exact identities or instructions."))
  const authority = yield* authenticate(input)
  const body = {
    schemaVersion: "1" as const,
    state: "ready_for_independent_review" as const,
    applicationCommit: input.applicationCommit,
    toolCommit: authority.toolCommit,
    acceptanceContract: { ...input.acceptanceContract },
    run: {
      runId: input.runId,
      canonicalRequest: authority.canonicalRequest,
      requestSha256: authority.requestSha256,
      eventHeadSha256: authority.eventHeadSha256,
    },
    references: input.references.map((reference) => ({ ...reference })),
    candidate: { ...input.candidate },
    instructions: input.instructions,
    verificationEvidence: authority.verificationEvidence,
    unresolvedHumanDecisions: [...input.unresolvedHumanDecisions],
    machineVerification: "passed" as const,
    ownerApproval: "unresolved" as const,
    normalView: { machineVerification: "passed" as const, ownerApproval: "unresolved" as const, nextAction: "independent-review" as const },
  }
  return freeze({ ...body, packetSha256: sha256(canonical(body)) })
})

export const validateReviewPacket = (
  packet: ReviewPacket,
  bindings: ReviewPacketBindings,
): Effect.Effect<void, ReviewPacketError, ApplicationFilesService | RunRecordStoreService> => Effect.gen(function*() {
  const { packetSha256, ...body } = packet
  if (sha256(canonical(body)) !== packetSha256) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The review packet hash no longer matches its contents."))
  }
  if (bindings.applicationCommit !== packet.applicationCommit) {
    return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The application commit changed after packet creation."))
  }
  const authority = yield* authenticate({
    acceptanceContract: packet.acceptanceContract,
    runId: packet.run.runId,
    references: packet.references,
    candidate: packet.candidate,
  })
  if (
    authority.canonicalRequest !== packet.run.canonicalRequest || authority.requestSha256 !== packet.run.requestSha256 ||
    authority.eventHeadSha256 !== packet.run.eventHeadSha256 || authority.toolCommit !== packet.toolCommit ||
    canonical(authority.verificationEvidence) !== canonical(packet.verificationEvidence)
  ) return yield* Effect.fail(new ReviewPacketError("ReviewPacketInvalid", "The Run, contract, commit, or deterministic evidence changed."))
})

export const inspectReviewInvalidation = (error: unknown): ReviewInvalidationEvidence | undefined =>
  error instanceof ReviewPacketError ? invalidationByError.get(error) : undefined

export const isIssuedReviewInvalidation = (evidence: ReviewInvalidationEvidence): boolean =>
  issuedInvalidations.has(evidence)

export { ReviewPacketError } from "./errors.js"
export type { ReviewEvidenceIdentity, ReviewInvalidationEvidence, ReviewPacket, ReviewPacketBindings, ReviewPacketInput } from "./types.js"
