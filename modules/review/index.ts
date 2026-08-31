import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { Effect } from "effect"

import { ReviewPacketError } from "./errors.js"
import type { ReviewEvidenceIdentity, ReviewPacket, ReviewPacketBindings, ReviewPacketInput } from "./types.js"

const sha256Pattern = /^[a-f0-9]{64}$/

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

const identitiesEqual = (
  left: ReadonlyArray<ReviewEvidenceIdentity>,
  right: ReadonlyArray<ReviewEvidenceIdentity>,
): boolean => canonical(left) === canonical(right)

export const prepareReviewPacket = (
  input: ReviewPacketInput,
): Effect.Effect<ReviewPacket, ReviewPacketError> => Effect.try({
  try: () => {
    if (input.deterministicGate !== "passed") {
      throw new ReviewPacketError("ReviewBlocked", "Deterministic failures block independent and paid semantic review.")
    }
    if (
      !validIdentity(input.acceptanceContract) || !input.run.runId.trim() ||
      !validIdentity({ applicationPath: input.run.recordPath, sha256: input.run.eventHeadSha256 }) ||
      !sha256Pattern.test(input.run.requestSha256) || input.references.length === 0 ||
      !input.references.every(validIdentity) || !validIdentity(input.candidate) ||
      !input.instructions.trim() || input.verificationEvidence.length === 0 ||
      !input.verificationEvidence.every(validIdentity) || input.unresolvedHumanDecisions.length === 0 ||
      input.unresolvedHumanDecisions.some((decision) => !decision.trim())
    ) throw new ReviewPacketError("ReviewPacketInvalid", "The review packet is missing required exact evidence or instructions.")
    const body = {
      schemaVersion: "1" as const,
      state: "ready_for_independent_review" as const,
      acceptanceContract: { ...input.acceptanceContract },
      run: { ...input.run },
      references: input.references.map((reference) => ({ ...reference })),
      candidate: { ...input.candidate },
      instructions: input.instructions,
      verificationEvidence: input.verificationEvidence.map((evidence) => ({ ...evidence })),
      unresolvedHumanDecisions: [...input.unresolvedHumanDecisions],
      machineVerification: "passed" as const,
      ownerApproval: "unresolved" as const,
      normalView: {
        machineVerification: "passed" as const,
        ownerApproval: "unresolved" as const,
        nextAction: "independent-review" as const,
      },
    }
    return freeze({
      ...body,
      packetSha256: createHash("sha256").update(canonical(body)).digest("hex"),
    })
  },
  catch: (error) => error instanceof ReviewPacketError
    ? error
    : new ReviewPacketError("ReviewPacketInvalid", "The review packet could not be validated."),
})

export const validateReviewPacket = (
  packet: ReviewPacket,
  bindings: ReviewPacketBindings,
): Effect.Effect<void, ReviewPacketError> => Effect.try({
  try: () => {
    const { packetSha256, ...body } = packet
    if (createHash("sha256").update(canonical(body)).digest("hex") !== packetSha256) {
      throw new ReviewPacketError("ReviewPacketInvalid", "The review packet hash no longer matches its contents.")
    }
    if (
      packet.run.requestSha256 !== bindings.requestSha256
    ) throw new ReviewPacketError("ReviewPacketInvalid", "The exact Run changed after packet creation.")
    if (!identitiesEqual(packet.references, bindings.references)) {
      throw new ReviewPacketError("ReferenceIdentityChanged", "A reference changed after packet creation.")
    }
    if (canonical(packet.candidate) !== canonical(bindings.candidate)) {
      throw new ReviewPacketError("CandidateIdentityChanged", "The candidate changed after packet creation.")
    }
  },
  catch: (error) => error instanceof ReviewPacketError
    ? error
    : new ReviewPacketError("ReviewPacketInvalid", "Current evidence could not validate the review packet."),
})

export { ReviewPacketError } from "./errors.js"
export type { ReviewEvidenceIdentity, ReviewPacket, ReviewPacketBindings, ReviewPacketInput } from "./types.js"
