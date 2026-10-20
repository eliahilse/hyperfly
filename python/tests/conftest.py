import json
import pathlib
import sys
import warnings
from contextlib import contextmanager

import pytest

VECTOR_DIR = pathlib.Path(__file__).resolve().parents[2] / "spec" / "vectors"


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
def serializer_warnings(expected=True):
    """Assert serializer warnings, including their absence in version-specific cases."""
    if expected:
        with pytest.warns(UserWarning, match="Pydantic serializer warnings") as found:
            yield found
        assert all(item.category is UserWarning for item in found)
    else:
        # Recording also catches warnings inside tests that expect broad exceptions.
        with warnings.catch_warnings(record=True) as found:
            warnings.simplefilter("always")
            yield found
        assert not found
