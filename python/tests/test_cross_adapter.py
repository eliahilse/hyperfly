"""The same logical schema declared in pydantic must fingerprint identically to
the zod adapter's output for the equivalent zod schema. The expected artifacts
here are pasted from the TS zod adapter (see the matching test on the TS side),
so the two adapters are pinned to each other, not just to themselves."""

from typing import Annotated, Literal, Optional

from annotated_types import Ge, Le
from pydantic import BaseModel, Field

from hyperfly import serialize_artifact
from hyperfly.pydantic import to_ir


class Row(BaseModel):
    id: str
    kind: Literal["a"]
    score: Annotated[int, Ge(0), Le(100)]
    ratio: float
    note: Optional[str]
    tag: str | None = None


EXPECTED_ARTIFACT = (
    '{"wire":1,"plan":{"layout":"columnar","version":2},"ir":'
    '{"kind":"struct","fields":['
    '{"name":"id","type":{"kind":"string"}},'
    '{"name":"kind","type":{"kind":"literal","value":"a"}},'
    '{"name":"score","type":{"kind":"int","min":0,"max":100}},'
    '{"name":"ratio","type":{"kind":"float64"}},'
    '{"name":"note","type":{"kind":"string"},"nullable":true},'
    '{"name":"tag","type":{"kind":"string"},"optional":true,"nullable":true}]}}'
)


def test_pydantic_matches_pinned_zod_artifact():
    assert serialize_artifact(to_ir(Row), "columnar") == EXPECTED_ARTIFACT
