# Learning Promotion

- Purpose: Convert complete, generalized Run evidence into a review-only learning decision without self-modifying the tool.
- Interface: `modules/learning-promotion/index.ts`
- Errors: `modules/learning-promotion/errors.ts`
- Acceptance: `modules/learning-promotion/learning-promotion.test.ts`

Learning Promotion replays one complete `verified_candidate` Run Record and derives its canonical request, OpenRouter provider/model, candidate, provider receipt, and deterministic checks from that same Run. Every supplied artifact must be replay-authenticated evidence on the Run. It also requires at least one opaque known-bad mutation issued by Review for the same Run and bound to the exact proposed rule, affected seam, source packet, and deliberate mutation. The proposal names scope, compatibility risk, and excluded application detail. Only the exact privately issued complete proposal can open a decision draft; a cloned or caller-authored proposal is refused. Its only permitted continuation is review, and it has no writer, Procedure, interface, test, application-lock, provider, credential, network, or Approval capability.
