import { Context, type Effect } from "effect"

import type { RunRecordState } from "../run-record/index.js"
import type { LearningPromotionError } from "./errors.js"

export type LearningEvidence = Readonly<{
  runId: string
  runDirectory: string
  runState: RunRecordState
  description: string
}>

export type LearningProposalInput = Readonly<{
  title: string
  supportingEvidence: LearningEvidence
  counterexampleEvidence: LearningEvidence
  affectedSeam: string
  compatibilityRisk: string
  sanitizedSummary: string
}>

export type LearningProposal = Readonly<{
  proposalId: string
  title: string
  supportingEvidence: LearningEvidence
  counterexampleEvidence: LearningEvidence
  affectedSeam: string
  compatibilityRisk: string
  sanitizedSummary: string
  status: "open_for_review"
  canModifyLiveProcedure: false
}>

export interface LearningPromotionService {
  readonly createProposal: (
    input: LearningProposalInput,
  ) => Effect.Effect<LearningProposal, LearningPromotionError>
}

export const LearningPromotion = Context.Service<
  LearningPromotionService
>("qwen-pipeline/LearningPromotion")
