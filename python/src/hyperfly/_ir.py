from __future__ import annotations

import hashlib
from typing import Any

from ._wire import INT_MAX, INT_MIN, HyperflyError

LEAF_KINDS = frozenset({"bool", "int", "float64", "string", "bytes", "enum", "literal"})
_PLAN_VERSION = {"row": 1, "columnar": 4}


def _fail(path: str, message: str) -> None:
    raise HyperflyError("ir", f"{path}: {message}")


def _is_safe_int(v: Any) -> bool:
    return type(v) is int and INT_MIN <= v <= INT_MAX


def _has_lone_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def _check_string(v: str, path: str, what: str) -> None:
    if _has_lone_surrogate(v):
        _fail(path, f"{what} contains a lone surrogate and has no portable encoding")


_MAX_INDEX_DIGITS = len(str(0xFFFFFFFF))


def _check_field_name(name: str, path: str) -> None:
    if name == "__proto__":
        _fail(path, 'field name "__proto__" is not portable')
    # length-bounded before int(): Python 3.11+ caps int() digits, and only short
    # digit strings can be array indices anyway
    if name.isascii() and name.isdigit() and len(name) <= _MAX_INDEX_DIGITS:
        if name == "0" or (name[0] != "0" and int(name) < 0xFFFFFFFF):
            _fail(path, f'field name "{name}" is an array index and would reorder as an object key')


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
        if inner.get("kind") == "literal" and inner.get("value") is None:
            _fail(path, "nullable(literal null) has two encodings for null")
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
            _check_field_name(name, path)
            if name in seen:
                _fail(path, f'duplicate field "{name}"')
            seen.add(name)
            if f.get("nullable") and f["type"].get("kind") == "nullable":
                _fail(f"{path}.{name}", "nullable flag on a nullable type is ambiguous")
            if f.get("nullable") and f["type"].get("kind") == "literal" and f["type"].get("value") is None:
                _fail(f"{path}.{name}", "nullable flag on a null literal has two encodings for null")
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


MAX_DICT_ENTRIES = 16383


def serialize_shared(shared: dict[str, Any]) -> str:
    columns = [
        '{"leaf":' + str(c["leaf"]) + ',"dict":[' + ",".join(_esc(e) for e in c["dict"]) + "]}"
        for c in shared["columns"]
    ]
    return '{"columns":[' + ",".join(columns) + "]}"


def serialize_artifact(ir: dict[str, Any], layout: str = "row", profile: dict[str, Any] | None = None) -> str:
    version = _PLAN_VERSION[layout]
    head = f'{{"wire":1,"plan":{{"layout":"{layout}","version":{version}}},"ir":{serialize_node(ir)}'
    if profile is None:
        return head + "}"
    return head + ',"profile":' + serialize_shared(profile["shared"]) + "}"


def enumerate_columns(ir: dict[str, Any]) -> list[str]:
    """Spec 6.1: the kind of every columnar leaf in the schema, in ordinal order."""
    out: list[str] = []
    _walk_columns(ir, out, None)
    return out


def column_count(node: dict[str, Any]) -> int:
    """Columnar leaves under this node. A pure function of the subtree, so two schema
    positions sharing one node object still count the same — which is why column bases
    are threaded positionally rather than looked up by node identity."""
    from ._codec import _columnar_eligible, _flatten_leaves

    kind = node["kind"]
    if kind == "array":
        if _columnar_eligible(node):
            leaves = _flatten_leaves(node["element"])
            if leaves is not None:
                return len(leaves)
        return column_count(node["element"])
    if kind == "nullable":
        return column_count(node["inner"])
    if kind == "struct":
        return sum(column_count(f["type"]) for f in node["fields"])
    return 0


def _walk_columns(node: dict[str, Any], out: list[str], bases: None = None) -> None:
    from ._codec import _columnar_eligible, _flatten_leaves

    kind = node["kind"]
    if kind == "array":
        if _columnar_eligible(node):
            leaves = _flatten_leaves(node["element"])
            if leaves is not None:
                for _segs, field in leaves:
                    out.append(field["type"]["kind"])
                return
        _walk_columns(node["element"], out, bases)
        return
    if kind == "nullable":
        _walk_columns(node["inner"], out, bases)
        return
    if kind == "struct":
        for f in node["fields"]:
            _walk_columns(f["type"], out, bases)
        return


def validate_profile(ir: dict[str, Any], profile: dict[str, Any]) -> None:
    def fail(message: str) -> None:
        raise HyperflyError("ir", f"profile: {message}")

    if profile.get("version") != 1:
        fail(f"unsupported profile version {profile.get('version')}")
    kinds = enumerate_columns(ir)
    previous = -1
    for column in profile["shared"]["columns"]:
        leaf = column["leaf"]
        if type(leaf) is not int or leaf < 0 or leaf >= len(kinds):
            fail(f"leaf {leaf} is not a column in this schema")
        if leaf <= previous:
            fail("columns must be sorted by ascending leaf and unique")
        previous = leaf
        if kinds[leaf] != "string":
            fail(f"leaf {leaf} is not a string column")
        entries = column["dict"]
        if not entries or len(entries) > MAX_DICT_ENTRIES:
            fail(f"leaf {leaf}: a dictionary holds 1 to {MAX_DICT_ENTRIES} entries")
        seen: set[str] = set()
        for entry in entries:
            if type(entry) is not str:
                fail(f"leaf {leaf}: entries must be strings")
            _check_string(entry, f"leaf {leaf}", "dictionary entry")
            if entry in seen:
                fail(f"leaf {leaf}: duplicate entry gives one value two codes")
            seen.add(entry)


def fingerprint_of(artifact: str) -> bytes:
    return hashlib.sha256(artifact.encode("utf-8")).digest()[:16]


def has_payload(node: dict[str, Any]) -> bool:
    """Whether one element of this type always consumes at least one bit on the wire."""
    kind = node["kind"]
    if kind == "literal":
        return False
    if kind == "struct":
        return any(f.get("optional") or f.get("nullable") or has_payload(f["type"]) for f in node["fields"])
    if kind == "array":
        length = node.get("length")
        return length is None or (length > 0 and has_payload(node["element"]))
    return True
