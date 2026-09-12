from argparse import Namespace
from pathlib import Path

import pytest

from seedance_icons.cli import cmd_submit


def test_legacy_submit_is_retired_before_files_or_provider_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "seedance_icons.cli.OpenRouterVideoClient",
        lambda: pytest.fail("legacy submission reached provider access"),
    )

    with pytest.raises(SystemExit, match="Legacy Seedance submission is retired"):
        cmd_submit(Namespace(run=str(tmp_path), acknowledge_cost="0.0454"))
