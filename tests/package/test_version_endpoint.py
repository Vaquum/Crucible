from __future__ import annotations

import pathlib

import pytest

import crucible.serve as serve

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_version_info_reads_build_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_SHA", "abc1234")
    monkeypatch.setenv("BUILD_DATE", "2026-06-06T00:00:00Z")
    monkeypatch.setenv("GIT_SUBJECT", "feat: add /version build-provenance endpoint")
    assert serve.version_info() == {
        "sha": "abc1234",
        "date": "2026-06-06T00:00:00Z",
        "subject": "feat: add /version build-provenance endpoint",
    }


def test_version_info_defaults_blank(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("GIT_SHA", "BUILD_DATE", "GIT_SUBJECT"):
        monkeypatch.delenv(key, raising=False)
    assert serve.version_info() == {"sha": "", "date": "", "subject": ""}


def test_version_route_is_wired() -> None:
    source = (REPO_ROOT / "src" / "crucible" / "serve.py").read_text(encoding="utf-8")
    assert "'/version'" in source
    assert "version_info()" in source
