from __future__ import annotations

import hashlib
from typing import Any

from ._wire import INT_MAX, INT_MIN, HyperflyError

LEAF_KINDS = frozenset({"bool", "int", "float64", "string", "bytes", "enum", "literal"})
_PLAN_VERSION = {"row": 1, "columnar": 5}


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
        if (len(members) - 1).bit_length() > 56:
            _fail(path, "enum member index width exceeds 56 bits")
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
    columns = []
    for column in shared["columns"]:
        out = '{"leaf":' + str(column["leaf"])
        if "dict" in column:
            out += ',"dict":[' + ",".join(_esc(entry) for entry in column["dict"]) + "]"
        if "grammar" in column:
            tokens = []
            for token in column["grammar"]:
                if "lit" in token:
                    tokens.append('{"lit":' + _esc(token["lit"]) + "}")
                else:
                    num = token["num"]
                    tokens.append(
                        '{"num":{"base":'
                        + str(num["base"])
                        + ',"len":'
                        + str(num["len"])
                        + ',"case":'
                        + _esc(num["case"])
                        + "}}"
                    )
            out += ',"grammar":[' + ",".join(tokens) + "]"
        if "derived" in column:
            derived = column["derived"]
            out += (
                ',"derived":{"source":'
                + str(derived["source"])
                + ',"values":['
                + ",".join(_esc(value) for value in derived["values"])
                + "]}"
            )
        columns.append(out + "}")
    return '{"columns":[' + ",".join(columns) + "]}"


def serialize_artifact(ir: dict[str, Any], layout: str = "row", profile: dict[str, Any] | None = None) -> str:
    version = _PLAN_VERSION[layout]
    head = f'{{"wire":1,"plan":{{"layout":"{layout}","version":{version}}},"ir":{serialize_node(ir)}'
    if profile is None:
        return head + "}"
    return head + ',"profile":' + serialize_shared(profile["shared"]) + "}"


def enumerate_columns(ir: dict[str, Any]) -> list[str]:
    """Spec 6.1: the kind of every columnar leaf in the schema, in ordinal order."""
    return [kind for kind, _array in _enumerate_column_refs(ir)]


def _enumerate_column_refs(ir: dict[str, Any]) -> list[tuple[str, int]]:
    """Column kind plus identity of its owning eligible array.

    Array identities are positional rather than based on object identity: one aliased
    schema node used at two positions still denotes two distinct arrays.
    """
    out: list[tuple[str, int]] = []
    next_array = [0]
    _walk_column_refs(ir, out, next_array)
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


def _walk_column_refs(
    node: dict[str, Any], out: list[tuple[str, int]], next_array: list[int]
) -> None:
    from ._codec import _columnar_eligible, _flatten_leaves

    kind = node["kind"]
    if kind == "array":
        if _columnar_eligible(node):
            leaves = _flatten_leaves(node["element"])
            if leaves is not None:
                array = next_array[0]
                next_array[0] += 1
                for _segs, field in leaves:
                    out.append((field["type"]["kind"], array))
                return
        _walk_column_refs(node["element"], out, next_array)
        return
    if kind == "nullable":
        _walk_column_refs(node["inner"], out, next_array)
        return
    if kind == "struct":
        for f in node["fields"]:
            _walk_column_refs(f["type"], out, next_array)
        return


def validate_profile(ir: dict[str, Any], profile: dict[str, Any]) -> None:
    def fail(message: str) -> None:
        raise HyperflyError("ir", f"profile: {message}")

    def record(value: Any, path: str) -> dict[str, Any]:
        if type(value) is not dict:
            fail(f"{path} must be an object")
        return value

    def check_keys(
        value: dict[str, Any], path: str, allowed: set[str], required: set[str]
    ) -> None:
        for key in value:
            if key not in allowed:
                fail(f"{path}: unknown key {key}")
        for key in required:
            if key not in value:
                fail(f"{path}: missing key {key}")

    def portable_string(value: Any, path: str) -> str:
        if type(value) is not str:
            fail(f"{path} must be a string")
        if _has_lone_surrogate(value):
            fail(f"{path} contains a lone surrogate and has no portable encoding")
        return value

    root = record(profile, "document")
    check_keys(root, "document", {"version", "shared", "hints"}, {"version", "shared"})
    version = root["version"]
    if type(version) is not int or version not in (1, 2):
        fail(f"unsupported profile version {version}")
    if "hints" in root and type(root["hints"]) is not dict:
        fail("hints must be an object when present")

    shared = record(root["shared"], "shared")
    check_keys(shared, "shared", {"columns"}, {"columns"})
    raw_columns = shared["columns"]
    if type(raw_columns) is not list:
        fail("shared.columns must be an array")
    if not raw_columns:
        fail("shared.columns must be non-empty")

    refs = _enumerate_column_refs(ir)
    parsed: list[dict[str, Any]] = []
    previous = -1

    for column_index, raw_column in enumerate(raw_columns):
        path = f"shared.columns[{column_index}]"
        raw = record(raw_column, path)
        if version == 1:
            check_keys(raw, path, {"leaf", "dict"}, {"leaf", "dict"})
        else:
            check_keys(raw, path, {"leaf", "dict", "grammar", "derived"}, {"leaf"})
            if not any(key in raw for key in ("dict", "grammar", "derived")):
                fail(f"{path} must carry at least one of dict, grammar, or derived")

        leaf = raw["leaf"]
        if type(leaf) is not int:
            fail(f"{path}.leaf must be an integer")
        if leaf < 0 or leaf >= len(refs):
            fail(f"leaf {leaf} is not a column in this schema")
        if leaf <= previous:
            fail("columns must be sorted by ascending leaf and unique")
        previous = leaf
        if refs[leaf][0] != "string":
            fail(f"leaf {leaf} is not a string column")

        column: dict[str, Any] = {"leaf": leaf}
        if "dict" in raw:
            entries = raw["dict"]
            if type(entries) is not list:
                fail(f"leaf {leaf}: dict must be an array")
            if not entries or len(entries) > MAX_DICT_ENTRIES:
                fail(f"leaf {leaf}: a dictionary holds 1 to {MAX_DICT_ENTRIES} entries")
            seen: set[str] = set()
            parsed_entries = []
            for entry_index, entry in enumerate(entries):
                parsed_entry = portable_string(entry, f"{path}.dict[{entry_index}]")
                if parsed_entry in seen:
                    fail(f"leaf {leaf}: duplicate entry gives one value two codes")
                seen.add(parsed_entry)
                parsed_entries.append(parsed_entry)
            column["dict"] = parsed_entries

        if "grammar" in raw:
            raw_grammar = raw["grammar"]
            if type(raw_grammar) is not list:
                fail(f"leaf {leaf}: grammar must be an array")
            if not 1 <= len(raw_grammar) <= 8:
                fail(f"leaf {leaf}: grammar must hold 1 to 8 tokens")
            grammar = []
            numeric = 0
            previous_literal = False
            for token_index, raw_token in enumerate(raw_grammar):
                token_path = f"{path}.grammar[{token_index}]"
                token = record(raw_token, token_path)
                if len(token) != 1 or next(iter(token), None) not in ("lit", "num"):
                    fail(f"{token_path} must hold exactly one of lit or num")
                if "lit" in token:
                    literal = portable_string(token["lit"], f"{token_path}.lit")
                    if not literal:
                        fail(f"{token_path}.lit must be non-empty")
                    if previous_literal:
                        fail(f"leaf {leaf}: grammar cannot contain adjacent literal tokens")
                    grammar.append({"lit": literal})
                    previous_literal = True
                    continue

                num_path = f"{token_path}.num"
                num = record(token["num"], num_path)
                check_keys(num, num_path, {"base", "len", "case"}, {"base", "len", "case"})
                base = num["base"]
                if type(base) is not int or base not in (10, 16, 36):
                    fail(f"{num_path}.base must be 10, 16, or 36")
                length = num["len"]
                if type(length) is not int:
                    fail(f"{num_path}.len must be an integer")
                cap = 15 if base == 10 else 13 if base == 16 else 10
                if length < 1 or length > cap:
                    fail(f"{num_path}.len must be between 1 and {cap} for base {base}")
                case = num["case"]
                if type(case) is not str or case not in ("lower", "upper"):
                    fail(f"{num_path}.case must be lower or upper")
                if base == 10 and case != "lower":
                    fail(f"{num_path}.case must be lower for base 10")
                grammar.append({"num": {"base": base, "len": length, "case": case}})
                numeric += 1
                previous_literal = False
            if numeric == 0:
                fail(f"leaf {leaf}: grammar needs at least one numeric token")
            column["grammar"] = grammar

        if "derived" in raw:
            derived_path = f"{path}.derived"
            derived = record(raw["derived"], derived_path)
            check_keys(derived, derived_path, {"source", "values"}, {"source", "values"})
            source = derived["source"]
            if type(source) is not int:
                fail(f"{derived_path}.source must be an integer")
            raw_values = derived["values"]
            if type(raw_values) is not list:
                fail(f"{derived_path}.values must be an array")
            column["derived"] = {
                "source": source,
                "values": [
                    portable_string(value, f"{derived_path}.values[{value_index}]")
                    for value_index, value in enumerate(raw_values)
                ],
            }

        parsed.append(column)

    by_leaf = {column["leaf"]: column for column in parsed}
    for column in parsed:
        derived = column.get("derived")
        if derived is None:
            continue
        leaf = column["leaf"]
        source = derived["source"]
        if source < 0 or source >= len(refs) or refs[source][0] != "string":
            fail(f"leaf {leaf}: derived source {source} is not a string column")
        if source >= leaf:
            fail(f"leaf {leaf}: derived source must be earlier than the target")
        if refs[source][1] != refs[leaf][1]:
            fail(f"leaf {leaf}: derived source must belong to the same eligible array")
        source_dict = by_leaf.get(source, {}).get("dict")
        if source_dict is None:
            fail(f"leaf {leaf}: derived source {source} must have a dictionary in the profile")
        if len(derived["values"]) != len(source_dict):
            fail(
                f"leaf {leaf}: derived values length must equal source dictionary length {len(source_dict)}"
            )


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
