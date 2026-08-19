from __future__ import annotations

import enum as _enum
import types
import typing
from typing import Any

from ._codec import Codec, compile_ir
from ._wire import INT_MAX, INT_MIN, Limits, UnsupportedSchemaError

try:
    import annotated_types as _at
except ImportError:  # pragma: no cover
    _at = None

try:
    from pydantic import BaseModel
except ImportError as _err:  # pragma: no cover
    raise ImportError("hyperfly.pydantic requires pydantic >= 2.5") from _err


def _unsupported(path: str, message: str) -> None:
    raise UnsupportedSchemaError(path, message)


def _int_bounds(metadata: list[Any], path: str) -> tuple[int | None, int | None]:
    lo: int | None = None
    hi: int | None = None
    if _at is None:
        return None, None

    def tighten_lo(candidate: int) -> None:
        nonlocal lo
        lo = candidate if lo is None else max(lo, candidate)

    def tighten_hi(candidate: int) -> None:
        nonlocal hi
        hi = candidate if hi is None else min(hi, candidate)

    for m in metadata:
        if isinstance(m, _at.Ge):
            tighten_lo(_ceil_int(m.ge, path))
        elif isinstance(m, _at.Gt):
            tighten_lo(_floor_int(m.gt, path) + 1)
        elif isinstance(m, _at.Le):
            tighten_hi(_floor_int(m.le, path))
        elif isinstance(m, _at.Lt):
            tighten_hi(_ceil_int(m.lt, path) - 1)
    return lo, hi


def _is_integral(v: Any) -> bool:
    return type(v) is int or (isinstance(v, float) and v.is_integer())


def _ceil_int(v: Any, path: str) -> int:
    import math

    bound = math.ceil(v)
    if bound < INT_MIN or bound > INT_MAX:
        _unsupported(path, f"bound {v} outside the v0 integer domain")
    return bound


def _floor_int(v: Any, path: str) -> int:
    import math

    bound = math.floor(v)
    if bound < INT_MIN or bound > INT_MAX:
        _unsupported(path, f"bound {v} outside the v0 integer domain")
    return bound


def _node_of(annotation: Any, metadata: list[Any], path: str) -> dict[str, Any]:
    origin = typing.get_origin(annotation)

    if origin in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        if len(args) != 1 or len(typing.get_args(annotation)) != 2:
            _unsupported(path, "only Optional[T] unions have a v0 encoding")
        inner = _node_of(args[0], metadata, path)
        if inner["kind"] == "nullable":
            _unsupported(path, "nested Optional has no v0 encoding")
        return {"kind": "nullable", "inner": inner}

    if origin is typing.Literal:
        values = list(typing.get_args(annotation))
        if len(values) == 1:
            v = values[0]
            if v is None or type(v) is str or type(v) is bool or (type(v) is int and INT_MIN <= v <= INT_MAX):
                return {"kind": "literal", "value": v}
            _unsupported(path, "literal must be string, boolean, None, or a safe integer")
        if all(type(v) is str for v in values):
            return {"kind": "enum", "members": values}
        _unsupported(path, "multi-value non-string literals have no v0 encoding")

    if origin is list:
        (element,) = typing.get_args(annotation) or (Any,)
        return {"kind": "array", "element": _node_of(element, [], f"{path}[]")}

    if origin is not None:
        _unsupported(path, f"type {annotation!r} has no v0 encoding")

    if annotation is bool:
        return {"kind": "bool"}
    if annotation is int:
        lo, hi = _int_bounds(metadata, path)
        node: dict[str, Any] = {"kind": "int"}
        if lo is not None and lo != INT_MIN:
            node["min"] = lo
        if hi is not None and hi != INT_MAX:
            node["max"] = hi
        return node
    if annotation is float:
        return {"kind": "float64"}
    if annotation is str:
        return {"kind": "string"}
    if annotation is bytes:
        return {"kind": "bytes"}
    if isinstance(annotation, type) and issubclass(annotation, _enum.Enum):
        members = [m.value for m in annotation]
        if not members or not all(type(v) is str for v in members):
            _unsupported(path, "only string-valued enums are supported in v0")
        return {"kind": "enum", "members": members}
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _struct_of(annotation, path)

    _unsupported(path, f"type {annotation!r} has no v0 encoding")
    raise AssertionError


def _struct_of(model: type[BaseModel], path: str) -> dict[str, Any]:
    if model.model_config.get("extra") == "allow":
        _unsupported(path, "models with extra='allow' cannot be represented — the wire has no room for undeclared fields")
    fields = []
    for name, info in model.model_fields.items():
        field_path = f"{path}.{name}"
        node = _node_of(info.annotation, list(info.metadata), field_path)
        field: dict[str, Any] = {"name": name, "type": node}
        if node["kind"] == "nullable":
            field["type"] = node["inner"]
            field["nullable"] = True
        if not info.is_required():
            field["optional"] = True
        fields.append(field)
    return {"kind": "struct", "fields": fields}


def to_ir(model: type[BaseModel]) -> dict[str, Any]:
    if not (isinstance(model, type) and issubclass(model, BaseModel)):
        _unsupported("$", "expected a pydantic BaseModel subclass")
    if "root" in getattr(model, "model_fields", {}) and type(model).__name__ == "ModelMetaclass" and _is_root_model(model):
        _unsupported("$", "RootModel has no v0 struct encoding — wrap the value in a field")
    return _struct_of(model, "$")


def _is_root_model(model: type) -> bool:
    try:
        from pydantic import RootModel

        return issubclass(model, RootModel)
    except ImportError:  # pragma: no cover
        return False


class _ModelCodec:
    def __init__(self, codec: Codec, model: type[BaseModel], validate: bool) -> None:
        self._codec = codec
        self._model = model
        self._validate = validate
        self.ir = codec.ir
        self.plan = codec.plan
        self.artifact = codec.artifact
        self.fingerprint = codec.fingerprint

    def _to_value(self, value: Any) -> Any:
        if isinstance(value, BaseModel):
            if self._validate:
                value = self._model.model_validate(value)
            value = value.model_dump(mode="python", exclude_unset=True)
        elif self._validate:
            value = self._model.model_validate(value).model_dump(mode="python", exclude_unset=True)
        return value

    def encode(self, value: Any) -> bytes:
        return self._codec.encode(self._to_value(value))

    def decode(self, data: bytes) -> Any:
        value = self._codec.decode(data)
        return self._model.model_validate(value) if self._validate else value

    def encode_body(self, value: Any) -> bytes:
        return self._codec.encode_body(self._to_value(value))

    def decode_body(self, data: bytes) -> Any:
        value = self._codec.decode_body(data)
        return self._model.model_validate(value) if self._validate else value


def compile(  # noqa: A001 - mirrors the documented API
    model: type[BaseModel],
    *,
    plan: str = "row",
    validate: bool = False,
    limits: Limits | None = None,
    pack=None,
) -> _ModelCodec:
    codec = compile_ir(to_ir(model), plan=plan, limits=limits, pack=pack)
    return _ModelCodec(codec, model, validate)
