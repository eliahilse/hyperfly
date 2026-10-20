import pydantic
import pytest

from conftest import pydantic_version


@pytest.mark.parametrize("version,expected", [
    ("2.5.3", (2, 5, 3)),
    ("2.10.6", (2, 10, 6)),
    ("2.11.0b1", (2, 11, 0)),
    ("2.12.0rc1", (2, 12, 0)),
    ("2.13.0.dev0", (2, 13, 0)),
])
def test_pydantic_version(monkeypatch, version, expected):
    monkeypatch.setattr(pydantic, "VERSION", version)
    assert pydantic_version() == expected
