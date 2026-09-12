"""State-set segmentation: the cut rule, its failure modes, and per-state certification."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from seedance_icons.retro import (
    DEFAULT_STATE_MAP,
    RetroError,
    _segment,
    parse_state_map,
)


def test_default_state_map_is_four_equal_quarters() -> None:
    assert list(DEFAULT_STATE_MAP) == ["idle", "hover", "pressed", "settled"]
    for lo, hi in DEFAULT_STATE_MAP.values():
        assert round(hi - lo, 6) == 0.25


def test_parses_a_brief_style_span_string() -> None:
    parsed = parse_state_map(
        {"idle": "0.00-0.25", "hover": "0.25-0.50", "pressed": "0.50-0.75", "settled": "0.75-1.00"}
    )
    assert parsed["pressed"] == (0.50, 0.75)


def test_parses_a_pair() -> None:
    assert parse_state_map({"a": (0.0, 0.5), "b": [0.5, 1.0]})["b"] == (0.5, 1.0)


def test_missing_state_map_falls_back_to_quarters() -> None:
    assert parse_state_map(None) == DEFAULT_STATE_MAP


@pytest.mark.parametrize(
    "bad",
    [
        {"a": "0.0-0.4", "b": "0.5-1.0"},   # gap: which state owns 0.4-0.5?
        {"a": "0.0-0.6", "b": "0.5-1.0"},   # overlap: two states own 0.5-0.6
        {"a": "0.1-1.0"},                    # does not start at zero
        {"a": "0.0-0.9"},                    # does not reach the end
        {"a": "0.5-0.2"},                    # inverted
        {"a": "0.0-1.5"},                    # outside the take
        {"a": "nonsense"},                   # unparseable
    ],
)
def test_ambiguous_cuts_are_rejected(bad: dict) -> None:
    with pytest.raises(RetroError):
        parse_state_map(bad)


def test_segment_slices_by_fraction() -> None:
    frames = list(range(20))
    assert _segment(frames, (0.0, 0.25)) == [0, 1, 2, 3, 4]
    assert _segment(frames, (0.75, 1.0)) == [15, 16, 17, 18, 19]


def test_segment_never_returns_empty() -> None:
    """A span narrower than one frame still owns a frame; a state with no pixels is
    a worse failure than a state with one."""
    assert len(_segment(list(range(3)), (0.4, 0.45))) >= 1


def test_mask_fill_ratio_separates_a_panel_from_a_silhouette() -> None:
    """A guard born of a real failure: an Anchor on an opaque panel makes every
    silhouette metric meaningless, because the mask becomes the panel. The overall
    matte fraction cannot see this — a small panel in a large matte field still
    leaves most of the frame as background — so the test is shape, not area."""
    from PIL import Image

    from seedance_icons.retro import MAX_ANCHOR_MASK_FILL, mask_fill_ratio

    matte = (0, 255, 0)

    panel = Image.new("RGB", (40, 40), matte)
    panel.paste(Image.new("RGB", (16, 16), (254, 254, 253)), (12, 12))
    assert mask_fill_ratio(panel, matte) == 1.0
    assert mask_fill_ratio(panel, matte) > MAX_ANCHOR_MASK_FILL

    # a diagonal, the crudest possible real silhouette
    icon = Image.new("RGB", (40, 40), matte)
    for i in range(16):
        icon.putpixel((12 + i, 12 + i), (0, 0, 0))
    assert mask_fill_ratio(icon, matte) < 0.2

    empty = Image.new("RGB", (10, 10), matte)
    assert mask_fill_ratio(empty, matte) == 0.0


def test_anchor_iou_gates_only_state_set_runs() -> None:
    """The Anchor check must not touch the single-loop path: its thresholds are
    calibrated against Issue #87 and that calibration has to stay valid."""
    from seedance_icons.retro import certify

    single_loop = {
        "unique_frames": 4,
        "effective_fps": 6.0,
        "out_of_palette_pixels": 0,
        "min_silhouette_iou": 0.998,
        "frame0_identity": 0.72,
    }
    result = certify(single_loop)
    assert "matches_anchor" not in result["checks"]
    assert result["certified"]

    faithful_state = dict(single_loop, anchor_silhouette_iou=0.979)
    assert certify(faithful_state)["certified"]

    redrawn_state = dict(single_loop, anchor_silhouette_iou=0.466)
    verdict = certify(redrawn_state)
    assert verdict["checks"]["matches_anchor"] is False
    assert not verdict["certified"]


def test_filled_mode_asserts_no_automatic_fidelity_check() -> None:
    """Filled framing has no calibrated fidelity metric, and the gate must not pretend
    otherwise. Four were tried on the 2026-08-30 run and none separated a good state
    from a bad one, so a person judges these runs and the report says so."""
    from seedance_icons.retro import certify

    base = {
        "unique_frames": 4,
        "effective_fps": 6.0,
        "out_of_palette_pixels": 0,
        "min_silhouette_iou": 0.998,
        "frame0_identity": 0.72,
    }

    filled = certify(
        dict(base, frame_mode="filled", anchor_pixel_identity=0.41, max_border_leak=0.0)
    )
    assert "matches_anchor" not in filled["checks"]
    assert filled["human_gate_required"] is True
    # containment is not a fidelity judgement, it is a fact the framing can answer
    assert filled["checks"]["stayed_in_the_tile"] is True
    assert filled["certified"]

    escaped = certify(
        dict(base, frame_mode="filled", anchor_pixel_identity=0.41, max_border_leak=0.09)
    )
    assert escaped["checks"]["stayed_in_the_tile"] is False
    assert not escaped["certified"]

    # matte keeps the calibrated silhouette decision
    drifted = certify(dict(base, frame_mode="matte", anchor_silhouette_iou=0.466))
    assert drifted["checks"]["matches_anchor"] is False
    assert not drifted["certified"]

    faithful = certify(dict(base, frame_mode="matte", anchor_silhouette_iou=0.979))
    assert faithful["certified"]


def test_border_leak_sees_the_icon_leaving_its_tile() -> None:
    """Reid, on the sweep: 'the icon moves outside the green window box.' In filled
    framing the key colour is the tile edge, so it is also the containment test, and
    unlike every fidelity metric tried here this one asks a question the framing
    actually answers."""
    from PIL import Image

    from seedance_icons.retro import MAX_BORDER_LEAK, border_leak

    matte = (0, 255, 0)
    anchor = Image.new("RGB", (20, 20), matte)
    anchor.paste(Image.new("RGB", (12, 12), (255, 255, 255)), (4, 4))  # tile, 4px border

    contained = anchor.copy()
    contained.paste(Image.new("RGB", (4, 4), (0, 0, 255)), (6, 6))
    assert border_leak(contained, anchor, matte) == 0.0

    escaped = anchor.copy()
    escaped.paste(Image.new("RGB", (6, 6), (0, 0, 255)), (0, 0))  # over the border
    assert border_leak(escaped, anchor, matte) > MAX_BORDER_LEAK


def test_inner_margin_catches_an_anchor_with_nowhere_to_move() -> None:
    """The bug behind 'the icon moves outside the green window box': the Anchor was
    built by cropping the icon to its own content and scaling it to fill the square,
    which threw away the margin it was drawn with. The drawing then touched the tile
    edge on all four sides, so the only free space left was outside the tile."""
    from PIL import Image

    from seedance_icons.retro import MIN_INNER_MARGIN, inner_margin

    matte = (0, 255, 0)

    # green border, white tile, blue drawing — the real structure
    no_margin = Image.new("RGB", (40, 40), matte)
    no_margin.paste(Image.new("RGB", (24, 24), (255, 255, 255)), (8, 8))  # tile
    no_margin.paste(Image.new("RGB", (24, 4), (0, 0, 255)), (8, 8))       # ink on the tile edge
    assert inner_margin(no_margin, matte) == 0.0
    assert inner_margin(no_margin, matte) < MIN_INNER_MARGIN

    with_margin = Image.new("RGB", (40, 40), matte)
    with_margin.paste(Image.new("RGB", (24, 24), (255, 255, 255)), (8, 8))  # tile
    with_margin.paste(Image.new("RGB", (12, 12), (0, 0, 255)), (14, 14))    # ink inside it
    assert inner_margin(with_margin, matte) >= MIN_INNER_MARGIN


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or os.environ.get("QWEN_BASELINE_OFFLINE") == "1",
    reason="the fixture encoder is unavailable in the deterministic offline baseline",
)
def test_conform_states_emits_four_certified_state_directories(tmp_path: Path) -> None:
    """Exercise the public artifact path, including ffmpeg extraction and reports."""
    from PIL import Image

    from seedance_icons.retro import conform_states

    matte = (0, 255, 0)
    frames = tmp_path / "frames"
    frames.mkdir()
    reference = Image.new("RGB", (40, 40), matte)
    reference.paste(Image.new("RGB", (32, 32), (255, 255, 255)), (4, 4))
    for index in range(8):
        frame = reference.copy()
        frame.paste(Image.new("RGB", (8, 8), (0, 0, 255)), (14 + index % 2, 14))
        frame.save(frames / f"frame{index:02d}.png")
        if index == 0:
            frame.save(tmp_path / "anchor.png")

    video = tmp_path / "take.mkv"
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-y",
            "-framerate",
            "8",
            "-i",
            str(frames / "frame%02d.png"),
            "-c:v",
            "ffv1",
            "-pix_fmt",
            "rgb24",
            str(video),
        ],
        check=True,
    )

    output = tmp_path / "states"
    summary = conform_states(
        video,
        tmp_path / "anchor.png",
        output,
        fps=8,
        grid=40,
        delivery=40,
        colors=4,
        settle_trim=0,
        frame_mode="filled",
        cycle_poses=4,
    )

    assert summary["certified"] is True
    assert summary["human_gate_required"] is True
    assert list(summary["states"]) == ["idle", "hover", "pressed", "settled"]
    for state in summary["states"]:
        report_path = output / state / "retro-report.json"
        assert report_path.is_file()
        assert json.loads(report_path.read_text())["certified"] is True
    assert (output / "state-set.gif").is_file()
    assert (output / "full-cycle.gif").is_file()
