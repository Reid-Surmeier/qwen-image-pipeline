"""The reference must move the way the brief says the icon moves.

Reid, 2026-08-30: "the reference video you gave has nothing to do with the animation
shown ... the coin animation's movement is affecting the way the magnifying glass moves
in a strange way." A reference teaches the kind of movement as well as its cadence, and
the wrong kind pulls against every word of the brief."""

from __future__ import annotations

from pathlib import Path

from seedance_icons.strategy import check_reference_matches_motion

BRIEF_PATH = Path(__file__).resolve().parents[1] / "briefs/x.json"
COIN_VIDEO = ["https://example.test/references/ref-coin-spin.mp4"]
ARROW_VIDEO = ["https://example.test/references/ref-textbox-arrow-bob.mp4"]


def test_a_rotate_reference_is_refused_for_a_translate_brief() -> None:
    brief = {
        "motion_kind": "translate",
        "real_reference": "docs/evidence/board-icons-test/references/ref-coin-spin.mp4",
    }
    problems = check_reference_matches_motion(brief, BRIEF_PATH, COIN_VIDEO)
    assert problems, "a spinning coin must not be the reference for a travelling glass"
    assert "rotate" in problems[0] and "translate" in problems[0]


def test_a_translate_reference_passes_a_translate_brief() -> None:
    brief = {
        "motion_kind": "translate",
        "real_reference": "docs/evidence/board-icons-test/references/ref-textbox-arrow-bob.mp4",
    }
    assert check_reference_matches_motion(brief, BRIEF_PATH, ARROW_VIDEO) == []


def test_a_missing_motion_kind_is_refused_when_a_known_reference_is_used() -> None:
    brief = {"real_reference": "docs/evidence/board-icons-test/references/ref-coin-spin.mp4"}
    problems = check_reference_matches_motion(brief, BRIEF_PATH, COIN_VIDEO)
    assert problems and "motion_kind is missing" in problems[0]


def test_an_unknown_kind_is_refused() -> None:
    brief = {
        "motion_kind": "vibes",
        "real_reference": "docs/evidence/board-icons-test/references/ref-coin-spin.mp4",
    }
    problems = check_reference_matches_motion(brief, BRIEF_PATH, COIN_VIDEO)
    assert problems and "not one of" in problems[0]


def test_a_corpus_citation_can_pair_with_an_actual_registered_clip() -> None:
    brief = {
        "real_reference": "docs/research/era-ui-animation-reference-corpus.md",
        "motion_kind": "translate",
    }
    assert check_reference_matches_motion(brief, BRIEF_PATH, ARROW_VIDEO) == []
