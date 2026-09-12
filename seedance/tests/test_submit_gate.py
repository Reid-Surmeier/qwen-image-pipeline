import json
from argparse import Namespace
from pathlib import Path

import pytest

from seedance_icons.cli import cmd_submit, cmd_wait


def test_legacy_submit_is_retired_before_files_or_provider_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "seedance_icons.cli.OpenRouterVideoClient",
        lambda: pytest.fail("legacy submission reached provider access"),
    )

    with pytest.raises(SystemExit, match="Legacy Seedance submission is retired"):
        cmd_submit(Namespace(run=str(tmp_path), acknowledge_cost="0.0454"))


def test_legacy_wait_refuses_a_substituted_provider_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "job.json").write_text(json.dumps({"id": "job-1"}))

    class SubstitutingClient:
        def wait(self, *_args, **_kwargs) -> dict:
            return {"id": "job-2", "status": "completed"}

        def download(self, *_args, **_kwargs) -> str:
            pytest.fail("substituted jobs must not be downloaded")

        def close(self) -> None:
            pass

    monkeypatch.setattr("seedance_icons.cli.OpenRouterVideoClient", SubstitutingClient)
    with pytest.raises(SystemExit, match="substituted the saved exact job identity"):
        cmd_wait(Namespace(run=str(tmp_path), interval=0, timeout=1))
    assert not (tmp_path / "completed-job.json").exists()
