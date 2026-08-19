import json
import pathlib

VECTOR_DIR = pathlib.Path(__file__).resolve().parents[2] / "spec" / "vectors"


def load(name: str):
    return json.loads((VECTOR_DIR / name).read_text())
