# Issue and build labels

Labels describe executable state; native blocked-by relationships describe ordering.

| Label | Meaning |
| --- | --- |
| `needs-triage` | The outcome or work packet still needs shaping. |
| `ready-for-agent` | Acceptance, scope, and verification are sufficient for implementation. |
| `needs-info` | A material fact cannot be recovered from repository evidence or bounded investigation. |
| `blocked` | A named external dependency prevents useful progress. |
| `needs-human-review` | Owner-applied repository brake; agents never apply it. |
| `ready-for-human` | The build presents a genuine owner decision with evidence. |
| `ready-to-fold` | A ticket commit already on the build line has passed acceptance and both reviews and may be recorded in the build changelog. |
| `folded-into-release` | The exact ticket commit is recorded in the build changelog. |
| `not-a-release` | A supporting or historical pull request is not the owner review surface. |

A procedure result of `human_decision_required` is not a GitHub workflow label. It is a classified run outcome for subjective approval or another product decision.
