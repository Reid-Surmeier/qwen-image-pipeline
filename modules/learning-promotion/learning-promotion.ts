import { createHash } from "node:crypto"
import { Effect } from "effect"

import { LearningPromotionError } from "./errors.js"
import type {
  LearningProposal,
  LearningProposalInput,
  LearningPromotionService,
} from "./types.js"

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export const standardLearningPromotion: LearningPromotionService = {
  createProposal: (input: LearningProposalInput) => Effect.gen(function*() {
    if (!input.supportingEvidence || input.supportingEvidence.runState.status !== "verified") {
      return yield* Effect.fail(
        new LearningPromotionError(
          "MISSING_SUPPORTING_EVIDENCE",
          "Learning promotion requires positive evidence from a machine-verified run.",
        ),
      )
    }

    if (!input.counterexampleEvidence || input.counterexampleEvidence.runState.status !== "failed") {
      return yield* Effect.fail(
        new LearningPromotionError(
          "MISSING_KNOWN_BAD_COUNTEREXAMPLE",
          "Learning promotion requires caught known-bad counterexample evidence.",
        ),
      )
    }

    if (!input.affectedSeam || input.affectedSeam.trim().length === 0) {
      return yield* Effect.fail(
        new LearningPromotionError(
          "INVALID_PROPOSAL_SEAM",
          "Proposal must name the exact affected module seam.",
        ),
      )
    }

    const proposalId = `proposal-${sha256(input.title + input.affectedSeam).slice(0, 16)}`
    const proposal: LearningProposal = {
      proposalId,
      title: input.title,
      supportingEvidence: input.supportingEvidence,
      counterexampleEvidence: input.counterexampleEvidence,
      affectedSeam: input.affectedSeam,
      compatibilityRisk: input.compatibilityRisk,
      sanitizedSummary: input.sanitizedSummary,
      status: "open_for_review",
      canModifyLiveProcedure: false,
    }

    return proposal
  }),
}
