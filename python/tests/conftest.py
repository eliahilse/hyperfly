import json
import pathlib
import sys

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
