"""The same logical schema declared in pydantic must fingerprint identically to
the zod adapter's output for the equivalent zod schema. The expected artifact
here is pinned to the string the TS zod adapter emits (see the matching test on
the TS side), so the two adapters are pinned to each other, not just themselves.

Only required + nullable fields are used: pydantic fills defaults on construction
and so cannot express a truly wire-absent (optional) field, unlike zod's
`.optional()`. That asymmetry is intentional and documented."""

from typing import Annotated, Literal, Optional

from annotated_types import Ge, Le
from pydantic import BaseModel

from hyperfly import serialize_artifact
from hyperfly.pydantic import to_ir


class Row(BaseModel):
    id: str
    kind: Literal["a"]
    score: Annotated[int, Ge(0), Le(100)]
    ratio: float
    note: Optional[str]
    tag: Optional[str]


EXPECTED_ARTIFACT = (
    '{"wire":1,"plan":{"layout":"columnar","version":3},"ir":'
    '{"kind":"struct","fields":['
    '{"name":"id","type":{"kind":"string"}},'
    '{"name":"kind","type":{"kind":"literal","value":"a"}},'
    '{"name":"score","type":{"kind":"int","min":0,"max":100}},'
    '{"name":"ratio","type":{"kind":"float64"}},'
    '{"name":"note","type":{"kind":"string"},"nullable":true},'
    '{"name":"tag","type":{"kind":"string"},"nullable":true}]}}'
)


def test_pydantic_matches_pinned_zod_artifact():
    assert serialize_artifact(to_ir(Row), "columnar") == EXPECTED_ARTIFACT
