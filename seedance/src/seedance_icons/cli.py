from __future__ import annotations

import argparse
import json
from decimal import Decimal
from pathlib import Path

from .brief import compile_prompt, load_brief
from .capabilities import (
    ModelProfile,
    dimensions,
    estimate_cost,
    fetch_profiles,
    save_profiles,
    select_model,
    validate_request,
)
from .openrouter import (
    OpenRouterHTTPError,
    OpenRouterVideoClient,
    asset_reference,
    request_digest,
    sanitized_request,
)
from .runs import create_run, read_job_id, write_json
from .strategy import DEFAULT_GRAMMAR, check_strategy, gate_record, submit_allowed
from .verify import verify_video


def _profiles(path: str | None = None) -> dict[str, ModelProfile]:
    if path:
        from .capabilities import load_profiles

        return load_profiles(Path(path))
    return fetch_profiles()


def cmd_capabilities(args: argparse.Namespace) -> None:
    profiles = fetch_profiles()
    save_profiles(profiles, Path(args.output))
    print(f"Saved {len(profiles)} live profiles to {args.output}")


def _plan(args: argparse.Namespace) -> tuple[dict, ModelProfile, Decimal]:
    brief = load_brief(Path(args.brief))
    profiles = _profiles(args.capabilities)
    profile = select_model(args.model, args.duration, profiles)
    request = {
        "model": profile.id,
        "prompt": compile_prompt(brief),
        "duration": args.duration,
        "size": args.size,
        "generate_audio": args.audio,
        "seed": args.seed,
    }
    frames = []
    if args.first_frame:
        frames.append(asset_reference(args.first_frame, "image", "first_frame"))
    if args.last_frame:
        frames.append(asset_reference(args.last_frame, "image", "last_frame"))
    if frames:
        request["frame_images"] = frames
    references = []
    for kind, values in (
        ("image", args.image_reference),
        ("video", args.video_reference),
        ("audio", args.audio_reference),
    ):
        references.extend(asset_reference(value, kind) for value in values)
    if references:
        request["input_references"] = references
    if args.experimental_mixed_inputs:
        request["_experimental_mixed_inputs"] = True
    validate_request(request, profile)
    return request, profile, estimate_cost(request, profile)


def cmd_plan(args: argparse.Namespace) -> None:
    request, profile, cost = _plan(args)
    brief_path = Path(args.brief)
    brief = load_brief(brief_path)
    grammar = str(brief.get("grammar") or DEFAULT_GRAMMAR)
    violations = check_strategy(
        brief,
        brief_path,
        request["prompt"],
        args.first_frame,
        args.last_frame,
        video_references=args.video_reference,
    )
    waiver = args.waive_strategy_gate
    if violations and waiver is None:
        listing = "\n".join(f"  - {item}" for item in violations)
        raise SystemExit(
            "Strategy gate failed — this run does not follow the batch-3 method "
            f"(Issue #87):\n{listing}\n"
            "Fix the brief/anchors, or record a deliberate experiment with "
            '--waive-strategy-gate "reason".'
        )
    if violations:
        listing = "\n".join(f"  - {item}" for item in violations)
        print(f"STRATEGY GATE WAIVED ({waiver}); violations on record:\n{listing}")
    run = create_run(Path(args.runs), args.slug)
    write_json(run / "brief.json", brief)
    write_json(run / "request.json", sanitized_request(request))
    write_json(run / "request.payload.json", request)
    write_json(run / "capabilities.json", {"models": [profile.to_dict()]})
    write_json(
        run / "plan.json",
        {
            "model": profile.id,
            "canonical_slug": profile.canonical_slug,
            "request_sha256": request_digest(request),
            "estimated_cost_usd": str(cost),
            "estimate_only_not_invoice": True,
            "paid_submission_performed": False,
            "strategy_gate": gate_record(violations, waiver, grammar),
        },
    )
    print(
        json.dumps(
            {"run": str(run), "model": profile.id, "estimated_cost_usd": str(cost)}, indent=2
        )
    )


def cmd_submit(args: argparse.Namespace) -> None:
    run = Path(args.run)
    payload_path = run / "request.payload.json"
    if not payload_path.exists():
        raise SystemExit(
            "Missing request.payload.json; recreate the run plan from its source assets"
        )
    request = json.loads(payload_path.read_text())
    plan = json.loads((run / "plan.json").read_text())
    planned_digest = plan.get("request_sha256")
    actual_digest = request_digest(request)
    if not isinstance(planned_digest, str) or actual_digest != planned_digest:
        raise SystemExit(
            "Request payload changed since planning; recreate the plan and obtain a "
            "new exact cost acknowledgement"
        )
    allowed, reason = submit_allowed(plan)
    if not allowed:
        raise SystemExit(f"Strategy gate refuses submission: {reason}")
    required = Decimal(plan["estimated_cost_usd"])
    acknowledged = Decimal(args.acknowledge_cost)
    if acknowledged != required:
        raise SystemExit(
            f"Cost acknowledgement mismatch: pass --acknowledge-cost {required} after explicit approval"
        )
    profiles = fetch_profiles()
    profile = profiles[request["model"]]
    if profile.canonical_slug != plan["canonical_slug"]:
        raise SystemExit(
            "Live canonical model changed since planning; create and approve a new plan"
        )
    validate_request(request, profile)
    plan.update(
        {
            "paid_submission_performed": True,
            "submission_status": "submitting",
            "billing_status": "possibly_spent",
            "safe_to_retry": False,
        }
    )
    write_json(run / "plan.json", plan)
    client = OpenRouterVideoClient()
    try:
        job = client.submit(request)
    except OpenRouterHTTPError as error:
        plan["submission_status"] = "failed"
        write_json(run / "plan.json", plan)
        write_json(run / "provider-error.json", error.to_record())
        raise
    finally:
        client.close()
    write_json(run / "job.json", job)
    plan["submission_status"] = "accepted"
    write_json(run / "plan.json", plan)
    print(json.dumps(job, indent=2))


def cmd_wait(args: argparse.Namespace) -> None:
    run = Path(args.run)
    job_id = read_job_id(run)
    client = OpenRouterVideoClient()
    try:
        job = client.wait(job_id, interval=args.interval, timeout=args.timeout)
        digest = client.download(job_id, run / "outputs" / "output.mp4")
    finally:
        client.close()
    write_json(run / "completed-job.json", job)
    write_json(run / "outputs" / "sha256.json", {"output.mp4": digest})
    print(f"Downloaded output.mp4 (sha256 {digest})")


def cmd_retro_conform(args: argparse.Namespace) -> None:
    from .retro import conform

    run = Path(args.run)
    report = conform(
        run / "outputs" / "output.mp4",
        Path(args.reference),
        run / "retro",
        fps=args.fps,
        max_frames=args.max_frames,
        grid=args.grid,
        colors=args.colors,
    )
    print(json.dumps(report, indent=2))


def cmd_retro_conform_states(args: argparse.Namespace) -> None:
    """Cut one multi-state take into a State Set and certify each state separately."""
    from .retro import conform_states

    run = Path(args.run)
    candidates = sorted((run / "outputs").glob("*.mp4"))
    if not candidates:
        raise SystemExit(f"No mp4 in {run / 'outputs'}")
    video = candidates[0]
    state_map = None
    brief_path = run / "brief.json"
    if args.state_map:
        state_map = json.loads(Path(args.state_map).read_text())
        state_map = state_map.get("state_map", state_map)
    elif brief_path.exists():
        state_map = json.loads(brief_path.read_text()).get("state_map")
    summary = conform_states(
        video,
        Path(args.reference),
        run / "states",
        state_map=state_map,
        fps=args.fps,
        max_frames=args.max_frames,
        grid=args.grid,
        colors=args.colors,
        settle_trim=args.settle_trim,
        frame_mode=args.frame_mode,
        state_hold_ms=args.state_hold_ms,
        cycle_poses=args.cycle_poses,
        pose_hold_ms=args.pose_hold_ms,
    )
    print(json.dumps(summary, indent=2))
    if not summary["certified"]:
        raise SystemExit(
            "uncertified states: " + ", ".join(summary["uncertified_states"])
        )


def cmd_verify(args: argparse.Namespace) -> None:
    run = Path(args.run)
    request = json.loads((run / "request.json").read_text())
    profile = _profiles(args.capabilities)[request["model"]]
    result = verify_video(
        run / "outputs" / "output.mp4",
        request["duration"],
        dimensions(request, profile),
        bool(request.get("generate_audio")),
        Path(args.first_anchor) if args.first_anchor else None,
        Path(args.last_anchor) if args.last_anchor else None,
        args.loop,
    )
    write_json(run / "verification" / "report.json", result)
    print(json.dumps(result["checks"], indent=2))


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="seedance-icons")
    sub = root.add_subparsers(dest="command", required=True)
    caps = sub.add_parser("capabilities", help="Fetch free live model metadata")
    caps.add_argument("--output", default="capabilities.json")
    caps.set_defaults(func=cmd_capabilities)
    plan = sub.add_parser("plan", help="Create an additive, non-paid run plan")
    plan.add_argument("brief")
    plan.add_argument("--model", default="study", help="study, final, or exact model ID")
    plan.add_argument("--duration", type=int, default=6)
    plan.add_argument("--size", default="720x720")
    plan.add_argument("--seed", type=int, default=1)
    plan.add_argument("--audio", action="store_true")
    plan.add_argument("--first-frame")
    plan.add_argument("--last-frame")
    plan.add_argument("--image-reference", action="append", default=[])
    plan.add_argument("--video-reference", action="append", default=[])
    plan.add_argument("--audio-reference", action="append", default=[])
    plan.add_argument(
        "--experimental-mixed-inputs",
        action="store_true",
        help="Allow frame anchors plus references despite precedence uncertainty",
    )
    plan.add_argument("--slug", default="icon-motion")
    plan.add_argument("--runs", default="runs")
    plan.add_argument("--capabilities")
    plan.add_argument(
        "--waive-strategy-gate",
        metavar="REASON",
        help=(
            "Record a deliberate deviation from the enforced batch-3 strategy; the reason "
            "is stored in plan.json and printed, never silent"
        ),
    )
    plan.set_defaults(func=cmd_plan)
    submit = sub.add_parser("submit", help="Submit exactly one approved paid request")
    submit.add_argument("run")
    submit.add_argument("--acknowledge-cost", required=True)
    submit.set_defaults(func=cmd_submit)
    wait = sub.add_parser("wait", help="Resume, poll, and download an existing job")
    wait.add_argument("run")
    wait.add_argument("--interval", type=float, default=5)
    wait.add_argument("--timeout", type=float, default=1800)
    wait.set_defaults(func=cmd_wait)
    retro = sub.add_parser(
        "retro-conform",
        help="Deterministically conform a run's output to retro sprite grammar and gate it",
    )
    retro.add_argument("run")
    retro.add_argument("--reference", required=True, help="Exact first-frame anchor image")
    retro.add_argument("--fps", type=int, default=6)
    retro.add_argument("--max-frames", type=int, default=8)
    retro.add_argument("--grid", type=int, default=160)
    retro.add_argument("--colors", type=int, default=16)
    retro.set_defaults(func=cmd_retro_conform)
    retro_states = sub.add_parser(
        "retro-conform-states",
        help="Cut a multi-state take into a State Set and certify each state",
    )
    retro_states.add_argument("run")
    retro_states.add_argument("--reference", required=True, help="Exact Anchor image")
    retro_states.add_argument("--state-map", help="JSON file carrying a state_map; defaults to the run's brief")
    retro_states.add_argument("--fps", type=int, default=6)
    retro_states.add_argument("--max-frames", type=int, default=8)
    retro_states.add_argument("--grid", type=int, default=160)
    retro_states.add_argument("--colors", type=int, default=16)
    retro_states.add_argument("--settle-trim", type=float, default=0.25)
    retro_states.add_argument(
        "--state-hold-ms",
        type=int,
        default=134,
        help="Hold per state in the state-set GIF; 134 ms is the era binary-swap cadence",
    )
    retro_states.add_argument(
        "--cycle-poses", type=int, default=12,
        help="Poses in the whole-gesture cycle; set it to the number the brief enumerates",
    )
    retro_states.add_argument(
        "--pose-hold-ms", type=int, default=100,
        help="Even hold per pose in the full-cycle GIF; the era beat is 67-134 ms",
    )
    retro_states.add_argument(
        "--frame-mode",
        choices=("matte", "filled"),
        default="matte",
        help=(
            "matte: the icon floats in the key colour, fidelity is silhouette IoU. "
            "filled: the icon fills its tile and the key colour is only a border, "
            "containment is checked automatically and fidelity requires human review "
            "because every frame's silhouette is the same square."
        ),
    )
    retro_states.set_defaults(func=cmd_retro_conform_states)
    verify = sub.add_parser("verify", help="Run independent media and anchor checks")
    verify.add_argument("run")
    verify.add_argument("--capabilities")
    verify.add_argument("--first-anchor")
    verify.add_argument("--last-anchor")
    verify.add_argument("--loop", action="store_true")
    verify.set_defaults(func=cmd_verify)
    return root


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
