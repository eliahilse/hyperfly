"""Pydantic schema conversion and optional validation for Hyperfly codecs."""

from __future__ import annotations

import enum as _enum
import types
import typing
from typing import Any, Literal, NoReturn, cast

from ._codec import Codec, PackHooks, checked_options
from ._wire import INT_MAX, INT_MIN, DecodeError, EncodeError, HyperflyError, Limits, UnsupportedSchemaError

try:
    import annotated_types

    _at: Any = annotated_types
except ImportError:  # pragma: no cover
    _at = None

try:
    from pydantic import BaseModel, ValidationError
except ImportError as _err:  # pragma: no cover
    raise ImportError("hyperfly.pydantic requires pydantic >= 2.5") from _err


def _unsupported(path: str, message: str) -> NoReturn:
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

    def apply(m: Any) -> None:
        if isinstance(m, _at.Ge):
            tighten_lo(_ceil_int(m.ge, path))
        elif isinstance(m, _at.Gt):
            tighten_lo(_floor_int(m.gt, path) + 1)
        elif isinstance(m, _at.Le):
            tighten_hi(_floor_int(m.le, path))
        elif isinstance(m, _at.Lt):
            tighten_hi(_ceil_int(m.lt, path) - 1)

    for m in metadata:
        if isinstance(m, _at.Interval):
            for part in (
                _at.Ge(m.ge) if m.ge is not None else None,
                _at.Gt(m.gt) if m.gt is not None else None,
                _at.Le(m.le) if m.le is not None else None,
                _at.Lt(m.lt) if m.lt is not None else None,
            ):
                if part is not None:
                    apply(part)
        else:
            apply(m)
    return lo, hi


def _is_integral(v: Any) -> bool:
    return type(v) is int or (isinstance(v, float) and v.is_integer())


def _ceil_int(v: Any, path: str) -> int:
    import math

    bound = math.ceil(v)
    if bound < INT_MIN or bound > INT_MAX:
        _unsupported(path, f"bound {v} outside the v0 integer domain")
    return cast(int, bound)


def _floor_int(v: Any, path: str) -> int:
    import math

    bound = math.floor(v)
    if bound < INT_MIN or bound > INT_MAX:
        _unsupported(path, f"bound {v} outside the v0 integer domain")
    return cast(int, bound)


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
        # the wire name must be what model_dump(by_alias=True) emits AND what
        # model_validate accepts; anything that splits those has no single wire name
        ser_name = info.serialization_alias or info.alias or name
        if info.validation_alias is not None and not isinstance(info.validation_alias, str):
            _unsupported(
                field_path,
                "AliasChoices/AliasPath validation aliases have no single wire name; use alias=...",
            )
        val_name = info.validation_alias or info.alias or name
        if ser_name != val_name:
            _unsupported(
                field_path,
                f"serialization name {ser_name!r} and validation name {val_name!r} differ; "
                "use a single alias=... so the wire has one portable field name",
            )
        wire_name = ser_name
        field: dict[str, Any] = {"name": wire_name, "type": node}
        if node["kind"] == "nullable":
            field["type"] = node["inner"]
            field["nullable"] = True
        fields.append(field)
    return {"kind": "struct", "fields": fields}


def to_ir(model: type[BaseModel]) -> dict[str, Any]:
    """Return the model's v0 struct schema; raise code ``unsupported`` with a field path."""
    if not (isinstance(model, type) and issubclass(model, BaseModel)):
        _unsupported("$", "expected a pydantic BaseModel subclass")
    if "root" in getattr(model, "model_fields", {}) and type(model).__name__ == "ModelMetaclass" and _is_root_model(model):
        _unsupported("$", "RootModel has no v0 struct encoding — wrap the value in a field")
    try:
        return _struct_of(model, "$")
    except RecursionError:
        _unsupported("$", "recursive or too deeply nested models have no v0 encoding")


def _is_root_model(model: type) -> bool:
    try:
        from pydantic import RootModel

        return issubclass(model, RootModel)
    except ImportError:  # pragma: no cover
        return False


class ModelCodec(Codec[Any]):
    """A model codec returning BaseModel instances only when validate is True.

    Construct directly or with ``compile``; both check options before the model.
    With validation disabled, decoding returns plain dictionaries, so the value
    type is Any. Invalid inputs raise ``options``, ``unsupported``, or ``ir``;
    value validation failures raise code ``validation``.
    """

    def __init__(
        self, model: type[BaseModel], *, plan: str = "row", validate: bool = False,
        limits: Limits | None = None, pack: PackHooks | Literal[False] | None = None,
        profile: dict[str, Any] | None = None,
    ) -> None:
        """Check options and compile the model schema with optional value validation."""
        plan, limits, pack = checked_options(plan, limits, pack)
        if validate is not True and validate is not False:
            raise HyperflyError("options", "validate: must be a boolean")
        super().__init__(to_ir(model), plan=plan, limits=limits, pack=pack, profile=profile)
        self._model = model
        self._validate = validate

    @property
    def model(self) -> type[BaseModel]:
        """The Pydantic model class used for conversion and validation."""
        return self._model

    @property
    def validate(self) -> bool:
        """Whether encoding and decoding validate values with the model."""
        return self._validate

    def _to_value(self, value: Any) -> Any:
        if not self._validate:
            return value.model_dump(mode="python", by_alias=True) if isinstance(value, BaseModel) else value
        try:
            model = self._model.model_validate(value)
        except ValidationError as error:
            raise EncodeError("validation", f"$: {error}") from error
        return model.model_dump(mode="python", by_alias=True)

    def _from_value(self, value: Any) -> Any:
        if not self._validate:
            return value
        try:
            return self._model.model_validate(value)
        except ValidationError as error:
            raise DecodeError("validation", f"$: {error}") from error

    def encode_body(self, value: Any) -> bytes:
        """Encode a model or mapping without an envelope.

        Raise ``validation`` or base body encoding errors.
        """
        return super().encode_body(self._to_value(value))

    def decode_body(self, data: bytes | bytearray | memoryview) -> Any:
        """Decode a body to a model when validating, or a plain value otherwise.

        Raise ``validation`` or base body decoding errors.
        """
        return self._from_value(super().decode_body(data))


def compile(  # noqa: A001 - mirrors the documented API
    model: type[BaseModel],
    *,
    plan: str = "row",
    validate: bool = False,
    limits: Limits | None = None,
    pack: PackHooks | Literal[False] | None = None,
    profile: dict[str, Any] | None = None,
) -> ModelCodec:
    """Compile a model schema; validate=True also validates each encoded or decoded value.

    Raise codes ``options``, ``unsupported``, or ``ir`` for invalid inputs.
    """
    return ModelCodec(model, plan=plan, validate=validate, limits=limits, pack=pack, profile=profile)


__all__ = ["ModelCodec", "compile", "to_ir"]
