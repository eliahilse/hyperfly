import json
import pathlib
import re
import sys
import warnings
from contextlib import contextmanager


VECTOR_DIR = pathlib.Path(__file__).resolve().parents[2] / "spec" / "vectors"


def pydantic_version() -> tuple[int, int, int]:
    """Compare prereleases using their numeric release version."""
    from pydantic import VERSION

    major, minor, patch = (
        int(re.split(r"\D", part, maxsplit=1)[0])
        for part in VERSION.split(".")[:3]
    )
    return major, minor, patch


def load(name: str):
    return json.loads((VECTOR_DIR / name).read_text())


def calls(run) -> int:
    """Python and builtin calls made by run(). Wall-clock bounds vary between runners;
    a step taken per row instead of per body shows up here exactly."""
    count = 0

    def hook(frame, event, arg):
        nonlocal count
        if event in ("call", "c_call"):
            count += 1

    previous = sys.getprofile()
    sys.setprofile(hook)
    try:
        run()
    finally:
        sys.setprofile(previous)
    return count


@contextmanager
def serializer_warnings(expected=True, *, match):
    """Validate every serializer warning; None allows version-dependent presence."""
    # Recording also catches warnings inside tests that expect broad exceptions.
    with warnings.catch_warnings(record=True) as found:
        warnings.simplefilter("always")
        try:
            yield found
        finally:
            for item in found:
                assert item.category is UserWarning
                message = str(item.message)
                assert message.startswith("Pydantic serializer warnings:")
                fragments = (match,) if isinstance(match, str) else match
                assert any(fragment in message for fragment in fragments), message
            if expected is not None:
                assert bool(found) is expected


def warning_details(found):
    """Compare categories and complete messages, including field and type details."""
    return [(item.category, str(item.message)) for item in found]
