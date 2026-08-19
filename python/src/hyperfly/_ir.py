from __future__ import annotations

import hashlib
from typing import Any

from ._wire import INT_MAX, INT_MIN, HyperflyError

LEAF_KINDS = frozenset({"bool", "int", "float64", "string", "bytes", "enum", "literal"})
_PLAN_VERSION = {"row": 1, "columnar": 2}


def _fail(path: str, message: str) -> None:
    raise HyperflyError("ir", f"{path}: {message}")


def _is_safe_int(v: Any) -> bool:
    return type(v) is int and INT_MIN <= v <= INT_MAX


def _has_lone_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def _check_string(v: str, path: str, what: str) -> None:
    if _has_lone_surrogate(v):
        _fail(path, f"{what} contains a lone surrogate and has no portable encoding")


def validate_ir(node: dict[str, Any], path: str = "$") -> None:
    kind = node.get("kind")
    if kind in ("bool", "float64", "string", "bytes"):
        return
    if kind == "int":
        lo, hi = node.get("min"), node.get("max")
        if lo is not None and not _is_safe_int(lo):
            _fail(path, "int min must be a safe integer in the v0 domain")
        if hi is not None and not _is_safe_int(hi):
            _fail(path, "int max must be a safe integer in the v0 domain")
        if lo is not None and hi is not None and lo > hi:
            _fail(path, "int min exceeds max")
        return
    if kind == "literal":
        v = node.get("value")
        if not (v is None or type(v) is str or type(v) is bool or _is_safe_int(v)):
            _fail(path, "literal must be string, boolean, null, or a safe integer")
        if type(v) is str:
            _check_string(v, path, "literal string")
        return
    if kind == "enum":
        members = node.get("members") or []
        if not members:
            _fail(path, "enum needs at least one member")
        seen: set[str] = set()
        for m in members:
            if type(m) is not str or not m:
                _fail(path, "enum members must be non-empty strings")
            _check_string(m, path, "enum member")
            if m in seen:
                _fail(path, f'duplicate enum member "{m}"')
            seen.add(m)
        return
    if kind == "nullable":
        inner = node["inner"]
        if inner.get("kind") == "nullable":
            _fail(path, "nullable(nullable) is invalid")
        validate_ir(inner, path + "?")
        return
    if kind == "array":
        length = node.get("length")
        if length is not None and (type(length) is not int or length < 0 or length > INT_MAX):
            _fail(path, "fixed array length must be a non-negative safe integer")
        validate_ir(node["element"], path + "[]")
        return
    if kind == "struct":
        seen = set()
        for f in node.get("fields", []):
            name = f.get("name")
            if type(name) is not str or not name:
                _fail(path, "field names must be non-empty strings")
            _check_string(name, path, "field name")
            if name in seen:
                _fail(path, f'duplicate field "{name}"')
            seen.add(name)
            if f.get("nullable") and f["type"].get("kind") == "nullable":
                _fail(f"{path}.{name}", "nullable flag on a nullable type is ambiguous")
            validate_ir(f["type"], f"{path}.{name}")
        return
    _fail(path, f"unknown IR kind {kind}")


def _esc(s: str) -> str:
    out = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ord(ch) < 0x20:
            out.append(f"\\u00{ord(ch):02x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _literal(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if type(v) is int:
        return str(v)
    return _esc(v)


def serialize_node(node: dict[str, Any]) -> str:
    kind = node["kind"]
    if kind in ("bool", "float64", "string", "bytes"):
        return f'{{"kind":"{kind}"}}'
    if kind == "int":
        out = '{"kind":"int"'
        if node.get("min") is not None:
            out += f',"min":{node["min"]}'
        if node.get("max") is not None:
            out += f',"max":{node["max"]}'
        return out + "}"
    if kind == "literal":
        return f'{{"kind":"literal","value":{_literal(node["value"])}}}'
    if kind == "enum":
        return '{"kind":"enum","members":[' + ",".join(_esc(m) for m in node["members"]) + "]}"
    if kind == "nullable":
        return f'{{"kind":"nullable","inner":{serialize_node(node["inner"])}}}'
    if kind == "array":
        out = f'{{"kind":"array","element":{serialize_node(node["element"])}'
        if node.get("length") is not None:
            out += f',"length":{node["length"]}'
        return out + "}"
    fields = []
    for f in node["fields"]:
        text = f'{{"name":{_esc(f["name"])},"type":{serialize_node(f["type"])}'
        if f.get("optional"):
            text += ',"optional":true'
        if f.get("nullable"):
            text += ',"nullable":true'
        fields.append(text + "}")
    return '{"kind":"struct","fields":[' + ",".join(fields) + "]}"


def serialize_artifact(ir: dict[str, Any], layout: str = "row") -> str:
    version = _PLAN_VERSION[layout]
    return f'{{"wire":1,"plan":{{"layout":"{layout}","version":{version}}},"ir":{serialize_node(ir)}}}'


def fingerprint_of(artifact: str) -> bytes:
    return hashlib.sha256(artifact.encode("utf-8")).digest()[:16]
