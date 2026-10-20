"""Pydantic schema conversion and optional validation for Hyperfly codecs.

Field-level after/wrap/plain validators, decorated or Annotated at any container
level, drop integer bounds beneath them. Values that bypass field validation through
unvalidated defaults, model validators, assignment or model_construct keep declared
bounds and may raise ``range``.
"""

from __future__ import annotations

import enum as _enum
import types
import typing
from typing import Any, Literal, NoReturn, cast

from ._codec import Codec, PackHooks, checked_options
from ._ir import _check_field_name, _check_string
from ._wire import INT_MAX, INT_MIN, DecodeError, EncodeError, HyperflyError, Limits, UnsupportedSchemaError

try:
    from annotated_types import Ge, GroupedMetadata, Gt, Le, Lt
    from pydantic import (
        AfterValidator, BaseModel, BeforeValidator, PlainSerializer, PlainValidator,
        ValidationError, WrapSerializer, WrapValidator,
    )
    from pydantic.fields import FieldInfo
except ImportError as _err:  # pragma: no cover
    raise ImportError("hyperfly.pydantic requires pydantic >= 2.5") from _err


def _unsupported(path: str, message: str) -> NoReturn:
    raise UnsupportedSchemaError(path, message)


class _SchemaMismatch(Exception):
    """The installed validation schema cannot be matched to the wire structure."""


class _BoundSchemas:
    def __init__(self) -> None:
        self.schemas: dict[type[BaseModel], Any] = {}
        self.models: dict[int, type[BaseModel]] = {}
        self.pending: set[int] = set()
        self.paths: dict[int, str] = {}
        self.active_models: set[type[BaseModel]] = set()

    def mark(self, node: dict[str, Any], *children: dict[str, Any]) -> dict[str, Any]:
        if any(id(child) in self.pending for child in children):
            self.pending.add(id(node))
        return node


def _resolve_schema(schema: Any, definitions: dict[str, Any]) -> dict[str, Any]:
    seen: set[int] = set()
    while isinstance(schema, dict):
        if id(schema) in seen:
            raise _SchemaMismatch
        seen.add(id(schema))
        kind = schema.get("type")
        if kind == "definitions":
            definitions.update((item["ref"], item) for item in schema["definitions"])
            schema = schema["schema"]
        elif kind == "definition-ref":
            schema = definitions[schema["schema_ref"]]
        else:
            return schema
    raise _SchemaMismatch


def _int_bounds(schema: dict[str, Any], path: str) -> tuple[int | None, int | None]:
    lower: list[int] = []
    upper: list[int] = []
    if "ge" in schema:
        lower.append(_ceil_int(schema["ge"], path))
    if "gt" in schema:
        lower.append(_floor_int(schema["gt"], path) + 1)
    if "le" in schema:
        upper.append(_floor_int(schema["le"], path))
    if "lt" in schema:
        upper.append(_ceil_int(schema["lt"], path) - 1)
    return max(lower, default=None), min(upper, default=None)


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


def _clear_bounds(node: dict[str, Any]) -> None:
    kind = node["kind"]
    if kind == "int":
        node.pop("min", None)
        node.pop("max", None)
    elif kind == "nullable":
        _clear_bounds(node["inner"])
    elif kind == "array":
        _clear_bounds(node["element"])
    elif kind == "struct":
        for field in node["fields"]:
            _clear_bounds(field["type"])


def _model_validator(schema: dict[str, Any], model: type[BaseModel]) -> bool:
    function = schema["function"]["function"]
    function = getattr(function, "__func__", function)
    return any(
        schema["type"] == f"function-{validator.info.mode}"
        and function is getattr(validator.func, "__func__", validator.func)
        for validator in model.__pydantic_decorators__.model_validators.values()
    )


def _unwrap_model_validators(
    schema: dict[str, Any], own_schema: Any, model: type[BaseModel], definitions: dict[str, Any],
) -> dict[str, Any]:
    # Match the complete installed stack so an extra field wrapper using the
    # same callable as a model validator still forms a field-level barrier.
    seen: set[int] = set()
    while True:
        own_schema = _resolve_schema(own_schema, definitions)
        schema = _resolve_schema(schema, definitions)
        if id(schema) in seen or schema["type"] != own_schema["type"]:
            raise _SchemaMismatch
        seen.add(id(schema))
        if schema["type"] == "model":
            if (schema.get("cls") is not model or own_schema.get("cls") is not model
                    or schema["schema"] != own_schema["schema"]):
                raise _SchemaMismatch
            return schema
        if not schema["type"].startswith("function-") or not _model_validator(schema, model):
            raise _SchemaMismatch
        function = schema["function"]
        own_function = own_schema["function"]
        if (function["type"] != own_function["type"]
                or getattr(function["function"], "__func__", function["function"]) is not
                getattr(own_function["function"], "__func__", own_function["function"])):
            raise _SchemaMismatch
        schema = schema["schema"]
        own_schema = own_schema["schema"]


def _apply_bounds(
    node: dict[str, Any], schema: Any, definitions: dict[str, Any],
    bounds: _BoundSchemas, path: str,
) -> None:
    if id(node) not in bounds.pending:
        return
    schema = _resolve_schema(schema, definitions)
    # Only wrappers belonging to the model itself may change values outside
    # field validation. Field validators wrapping that model remain barriers.
    model = bounds.models.get(id(node))
    seen: set[int] = set()
    while True:
        schema = _resolve_schema(schema, definitions)
        if id(schema) in seen:
            raise _SchemaMismatch
        seen.add(id(schema))
        kind = schema["type"]
        if kind in ("function-after", "function-wrap", "function-plain") and model is not None:
            schema = _unwrap_model_validators(schema, bounds.schemas[model], model, definitions)
        elif kind in ("default", "function-before"):
            schema = schema["schema"]
        elif kind == "chain":
            schema = schema["steps"][-1]
        else:
            break
    kind = node["kind"]
    if kind == "nullable" and schema["type"] == "nullable":
        _apply_bounds(node["inner"], schema["schema"], definitions, bounds, path)
    elif kind == "array" and schema["type"] == "list":
        _apply_bounds(node["element"], schema["items_schema"], definitions, bounds, f"{path}[]")
    elif kind == "struct":
        if schema["type"] == "model":
            schema = _resolve_schema(schema["schema"], definitions)
            while schema["type"] == "function-before":
                if model is None or not _model_validator(schema, model):
                    raise _SchemaMismatch
                schema = _resolve_schema(schema["schema"], definitions)
        if schema["type"] != "model-fields" or model is None:
            raise _SchemaMismatch
        for (name, _), field in zip(model.model_fields.items(), node["fields"], strict=True):
            field_node = field["type"]
            if field.get("nullable"):
                field_node = bounds.mark({"kind": "nullable", "inner": field_node}, field_node)
            try:
                field_schema = schema["fields"][name]
                if field_schema["type"] != "model-field":
                    raise _SchemaMismatch
                _apply_bounds(field_node, field_schema["schema"], definitions, bounds,
                              f"{path}.{name}")
            except UnsupportedSchemaError:
                raise
            except Exception:
                _clear_bounds(field_node)
    elif kind == "int" and schema["type"] == "int":
        lo, hi = _int_bounds(schema, path)
        if lo is not None and lo != INT_MIN:
            node["min"] = lo
        if hi is not None and hi != INT_MAX:
            node["max"] = hi
    else:
        raise _SchemaMismatch


def _has_bounds_metadata(metadata: list[Any]) -> bool:
    for item in metadata:
        if isinstance(item, (Ge, Gt, Le, Lt, GroupedMetadata)):
            return True
        if isinstance(item, FieldInfo) and _has_bounds_metadata(item.metadata):
            return True
        if isinstance(item, (AfterValidator, BeforeValidator, PlainValidator, WrapValidator,
                             PlainSerializer, WrapSerializer)):
            continue
        # Custom schema hooks can introduce bounds without standard metadata.
        if hasattr(item, "__get_pydantic_core_schema__"):
            return True
    return False


def _node_of(annotation: Any, metadata: list[Any], path: str, bounds: _BoundSchemas) -> dict[str, Any]:
    origin = typing.get_origin(annotation)

    if origin is typing.Annotated:
        base, *inner_metadata = typing.get_args(annotation)
        # Outer metadata applies after metadata on the wrapped type.
        return _node_of(base, [*inner_metadata, *metadata], path, bounds)

    if origin in (typing.Union, types.UnionType):
        args = [a for a in typing.get_args(annotation) if a is not type(None)]
        if len(args) != 1 or len(typing.get_args(annotation)) != 2:
            _unsupported(path, "only Optional[T] unions have a v0 encoding")
        inner = _node_of(args[0], metadata, path, bounds)
        if inner["kind"] == "nullable":
            _unsupported(path, "nested Optional has no v0 encoding")
        return bounds.mark({"kind": "nullable", "inner": inner}, inner)

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
        inner = _node_of(element, [], f"{path}[]", bounds)
        return bounds.mark({"kind": "array", "element": inner}, inner)

    if origin is not None:
        _unsupported(path, f"type {annotation!r} has no v0 encoding")

    if annotation is bool:
        return {"kind": "bool"}
    if annotation is int:
        node: dict[str, Any] = {"kind": "int"}
        if metadata and _has_bounds_metadata(metadata):
            bounds.pending.add(id(node))
            bounds.paths[id(node)] = path
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
        return _struct_of(annotation, path, bounds)

    _unsupported(path, f"type {annotation!r} has no v0 encoding")
    raise AssertionError


def _struct_of(model: type[BaseModel], path: str, bounds: _BoundSchemas) -> dict[str, Any]:
    if model in bounds.active_models:
        _unsupported(path, "recursive model")
    bounds.active_models.add(model)
    try:
        return _fields_of(model, path, bounds)
    finally:
        bounds.active_models.remove(model)


def _fields_of(model: type[BaseModel], path: str, bounds: _BoundSchemas) -> dict[str, Any]:
    if model.model_config.get("extra") == "allow":
        _unsupported(path, "models with extra='allow' cannot be represented — the wire has no room for undeclared fields")
    fields = []
    seen: set[str] = set()
    for name, info in model.model_fields.items():
        field_path = f"{path}.{name}"
        # the wire name must be what model_dump(by_alias=True) emits AND what
        # model_validate accepts; anything that splits those has no single wire name
        alias = info.alias if info.alias is not None else name
        ser_name = info.serialization_alias if info.serialization_alias is not None else alias
        if info.validation_alias is not None and not isinstance(info.validation_alias, str):
            _unsupported(
                field_path,
                "AliasChoices/AliasPath validation aliases have no single wire name; use alias=...",
            )
        val_name = info.validation_alias if info.validation_alias is not None else alias
        if ser_name != val_name:
            _unsupported(
                field_path,
                f"serialization name {ser_name!r} and validation name {val_name!r} differ; "
                "use a single alias=... so the wire has one portable field name",
            )
        wire_name = ser_name
        if type(wire_name) is not str:
            _unsupported(field_path, "field names must be strings")
        if not wire_name:
            _unsupported(field_path, "field names must be non-empty")
        try:
            _check_string(wire_name, field_path, "field name")
            _check_field_name(wire_name, field_path)
        except HyperflyError as error:
            _unsupported(field_path, str(error).removeprefix(f"{field_path}: "))
        if wire_name in seen:
            _unsupported(field_path, f'duplicate field "{wire_name}"')
        seen.add(wire_name)
        node = _node_of(info.annotation, list(info.metadata), field_path, bounds)
        field: dict[str, Any] = {"name": wire_name, "type": node}
        if node["kind"] == "nullable":
            field["type"] = node["inner"]
            field["nullable"] = True
        fields.append(field)
    node = bounds.mark({"kind": "struct", "fields": fields}, *(field["type"] for field in fields))
    bounds.models[id(node)] = model
    if model not in bounds.schemas:
        bounds.schemas[model] = model.__dict__.get("__pydantic_core_schema__")
    return node


def to_ir(model: type[BaseModel]) -> dict[str, Any]:
    """Return the model's v0 struct schema; raise code ``unsupported`` with a field path.

    Field-level after/wrap/plain validators, decorated or Annotated at any container
    level, drop integer bounds beneath them. Values that bypass field validation through
    unvalidated defaults, model validators, assignment or model_construct keep declared
    bounds and may raise ``range``.
    """
    if not (isinstance(model, type) and issubclass(model, BaseModel)):
        _unsupported("$", "expected a pydantic BaseModel subclass")
    if "root" in getattr(model, "model_fields", {}) and type(model).__name__ == "ModelMetaclass" and _is_root_model(model):
        _unsupported("$", "RootModel has no v0 struct encoding — wrap the value in a field")
    bounds = _BoundSchemas()
    node = _struct_of(model, "$", bounds)
    if id(node) in bounds.pending:
        for bounded_model in bounds.schemas:
            if not bounded_model.__pydantic_complete__:
                try:
                    bounded_model.model_rebuild(_types_namespace={})
                except Exception as error:
                    path = next(iter(bounds.paths.values()))
                    raise UnsupportedSchemaError(path, f"cannot build model validation schema: {error}") from error
                bounds.schemas[bounded_model] = bounded_model.__pydantic_core_schema__
        schema = bounds.schemas[model]
        try:
            _apply_bounds(node, schema, {}, bounds, "$")
        except UnsupportedSchemaError:
            raise
        except Exception:
            _clear_bounds(node)
    return node


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

    Field-level after/wrap/plain validators, decorated or Annotated at any container
    level, drop integer bounds beneath them. Values that bypass field validation through
    unvalidated defaults, model validators, assignment or model_construct keep declared
    bounds and may raise ``range``.
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
