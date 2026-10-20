from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from functools import partial
from typing import Any, Callable, NoReturn, cast

from ._wire import INT_MAX, INT_MIN, HyperflyError

LEAF_KINDS = frozenset({"bool", "int", "float64", "string", "bytes", "enum", "literal"})
_PLAN_VERSION = {"row": 1, "columnar": 5}
MAX_NESTING = 512


def _fail(path: str, message: str) -> NoReturn:
    raise HyperflyError("ir", f"{path}: {message}")


def _is_safe_int(v: Any) -> bool:
    # an integral JSON number is that integer whether it parsed as int or float
    if type(v) is float:
        return v.is_integer() and INT_MIN <= v <= INT_MAX
    return type(v) is int and INT_MIN <= v <= INT_MAX


def normalize_integers(value: Any) -> None:
    """In place on validated IR: integral floats become the ints they denote, -0.0 becomes 0."""
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            for key, inner in item.items():
                if type(inner) is float:
                    item[key] = int(inner)
                else:
                    stack.append(inner)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)


def json_copy(value: Any) -> Any:
    """Copy JSON-shaped data without recursion: dicts become plain dicts, lists and
    tuples keep their type, and a container shared in the input stays shared."""
    order: list[Any] = []
    seen: set[int] = set()
    finished: set[int] = set()
    stack: list[tuple[Any, bool]] = [(value, False)]
    while stack:
        item, done = stack.pop()
        if done:
            order.append(item)
            finished.add(id(item))
        elif isinstance(item, (dict, list, tuple)):
            if id(item) in seen:
                # met again before it finished: it contains itself
                if id(item) not in finished:
                    raise ValueError("cannot copy cyclic data")
                continue
            seen.add(id(item))
            stack.append((item, True))
            stack.extend(
                (inner, False)
                for inner in (item.values() if isinstance(item, dict) else item)
                if isinstance(inner, (dict, list, tuple))
            )
    # keyed by the ids of live input containers, which no other live object shares, so a
    # lookup misses exactly for the values that are not copied
    copies: dict[int, Any] = {}
    get = copies.get
    for item in order:
        if isinstance(item, dict):
            copies[id(item)] = {key: get(id(inner), inner) for key, inner in item.items()}
        elif isinstance(item, tuple):
            copies[id(item)] = tuple([get(id(inner), inner) for inner in item])
        else:
            copies[id(item)] = [get(id(inner), inner) for inner in item]
    return get(id(value), value)


def check_artifact_nesting(ir: Any) -> None:
    """Reject IR whose canonical artifact would nest JSON containers deeper than
    MAX_NESTING (wire-v0 section 4), without recursion. The artifact object is depth 1
    and the IR depth 2; only the containers canonical JSON keeps are counted."""
    stack = [(ir, 2)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, dict):
            continue
        kind = node.get("kind")
        reached = depth
        if kind == "nullable":
            stack.append((node.get("inner"), depth + 1))
        elif kind == "array":
            stack.append((node.get("element"), depth + 1))
        elif kind == "enum":
            reached = depth + 1
        elif kind == "struct":
            fields = node.get("fields")
            if isinstance(fields, (list, tuple)):
                reached = depth + 2 if fields else depth + 1
                stack.extend((f.get("type"), depth + 3) for f in fields if isinstance(f, dict))
        if reached > MAX_NESTING:
            _too_deep()


_SCALAR_KEYS = frozenset({"kind"})
_INT_KEYS = frozenset({"kind", "min", "max"})
_LITERAL_KEYS = frozenset({"kind", "value"})
_ENUM_KEYS = frozenset({"kind", "members"})
_NULLABLE_KEYS = frozenset({"kind", "inner"})
_ARRAY_KEYS = frozenset({"kind", "element", "length"})
_STRUCT_KEYS = frozenset({"kind", "fields"})
_FIELD_KEYS = frozenset({"name", "type", "optional", "nullable"})


def _check_keys(value: dict[Any, Any], allowed: frozenset[str], path: str) -> None:
    for key in value:
        if key not in allowed:
            _fail(path, f"unknown key {key}" if type(key) is str else "unknown non-string key")


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


def validate_ir(node: Any, path: str = "$") -> None:
    """Validate a v0 schema; raise code ``ir`` prefixed with the failing path."""
    check_artifact_nesting(node)
    # depth-first in declared order: a field and then its whole type are checked
    # before the next field, so the first failure is the one recursion would report
    stack: list[_Check] = [(_check_node, node, path)]
    while stack:
        check, current, current_path = stack.pop()
        stack.extend(reversed(check(current, current_path)))


_Check = tuple[Callable[[Any, str], list[Any]], Any, str]


def _check_node(node: Any, path: str) -> list[_Check]:
    """Check one node; return the checks of its children, in order."""
    if not isinstance(node, dict):
        _fail(path, "IR node must be an object")
    kind = node.get("kind")
    if not isinstance(kind, str):
        _fail(path, "IR kind must be a string")
    if kind in ("bool", "float64", "string", "bytes"):
        _check_keys(node, _SCALAR_KEYS, path)
        return []
    if kind == "int":
        _check_keys(node, _INT_KEYS, path)
        lo, hi = node.get("min"), node.get("max")
        if "min" in node and not _is_safe_int(lo):
            _fail(path, "int min must be a safe integer in the v0 domain")
        if "max" in node and not _is_safe_int(hi):
            _fail(path, "int max must be a safe integer in the v0 domain")
        if lo is not None and hi is not None and lo > hi:
            _fail(path, "int min exceeds max")
        return []
    if kind == "literal":
        _check_keys(node, _LITERAL_KEYS, path)
        if "value" not in node:
            _fail(path, "literal needs a value")
        v = node["value"]
        if not (v is None or type(v) is str or type(v) is bool or _is_safe_int(v)):
            _fail(path, "literal must be string, boolean, null, or a safe integer")
        if type(v) is str:
            _check_string(v, path, "literal string")
        return []
    if kind == "enum":
        _check_keys(node, _ENUM_KEYS, path)
        members = node.get("members")
        if not isinstance(members, (list, tuple)):
            _fail(path, "enum members must be an array")
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
        return []
    if kind == "nullable":
        _check_keys(node, _NULLABLE_KEYS, path)
        inner = node.get("inner")
        if not isinstance(inner, dict):
            _fail(path, "nullable inner must be an IR object")
        if inner.get("kind") == "nullable":
            _fail(path, "nullable(nullable) is invalid")
        if inner.get("kind") == "literal" and inner.get("value") is None:
            _fail(path, "nullable(literal null) has two encodings for null")
        return [(_check_node, inner, path + "?")]
    if kind == "array":
        _check_keys(node, _ARRAY_KEYS, path)
        length: Any = node.get("length")
        if "length" in node and (not _is_safe_int(length) or length < 0):
            _fail(path, "fixed array length must be a non-negative safe integer")
        return [(_check_node, node.get("element"), path + "[]")]
    if kind == "struct":
        _check_keys(node, _STRUCT_KEYS, path)
        fields = node.get("fields")
        if not isinstance(fields, (list, tuple)):
            _fail(path, "struct fields must be an array")
        return _check_fields(set(), fields, 0, None, path)
    _fail(path, f"unknown IR kind {kind}")


def _check_fields(seen: set[str], fields: Any, start: int, _node: Any, path: str) -> list[_Check]:
    """Check fields from `start` on; at a type with IR children, check that whole type
    before the remaining fields."""
    for index in range(start, len(fields)):
        f = fields[index]
        if not isinstance(f, dict):
            _fail(path, "struct fields must be objects")
        _check_keys(f, _FIELD_KEYS, path)
        name = f.get("name")
        if type(name) is not str or not name:
            _fail(path, "field names must be non-empty strings")
        _check_string(name, path, "field name")
        _check_field_name(name, path)
        if name in seen:
            _fail(path, f'duplicate field "{name}"')
        seen.add(name)
        field_path = f"{path}.{name}"
        for flag in ("optional", "nullable"):
            if flag in f and type(f[flag]) is not bool:
                _fail(field_path, f"{flag} flag must be a boolean")
        field_type = f.get("type")
        if not isinstance(field_type, dict):
            _fail(field_path, "field type must be an IR object")
        if f.get("nullable") and field_type.get("kind") == "nullable":
            _fail(f"{path}.{name}", "nullable flag on a nullable type is ambiguous")
        if f.get("nullable") and field_type.get("kind") == "literal" and field_type.get("value") is None:
            _fail(f"{path}.{name}", "nullable flag on a null literal has two encodings for null")
        kind = field_type.get("kind")
        if isinstance(kind, str) and kind in _PARENT_KINDS:
            rest = partial(_check_fields, seen, fields, index + 1)
            return [(_check_node, field_type, field_path), (rest, None, path)]
        _check_node(field_type, field_path)
    return []


_PARENT_KINDS = frozenset({"nullable", "array", "struct"})


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


def _int(v: Any) -> str:
    return str(int(v))


def _literal(v: Any) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if type(v) is int or type(v) is float:
        return _int(v)
    return _esc(v)


def serialize_node(node: dict[str, Any]) -> str:
    """Return canonical JSON for a validated IR node (wire-v0 section 2)."""
    return _node_json(node)


def _leaf_json(node: dict[str, Any]) -> str | None:
    """Canonical JSON of a node without IR children, or None for one with them."""
    kind = node["kind"]
    if kind in ("bool", "float64", "string", "bytes"):
        return '{"kind":"' + cast(str, kind) + '"}'
    if kind == "int":
        out = '{"kind":"int"'
        if node.get("min") is not None:
            out += f',"min":{_int(node["min"])}'
        if node.get("max") is not None:
            out += f',"max":{_int(node["max"])}'
        return out + "}"
    if kind == "literal":
        return f'{{"kind":"literal","value":{_literal(node["value"])}}}'
    if kind == "enum":
        return '{"kind":"enum","members":[' + ",".join(_esc(m) for m in node["members"]) + "]}"
    return None


def _node_json(node: dict[str, Any]) -> str:
    """Canonical JSON for IR, refusing any whose artifact would nest deeper than
    MAX_NESTING (the artifact object is depth 1, the IR depth 2)."""
    out: list[str] = []
    # text to emit, and (node, depth) for IR nodes still to render
    stack: list[Any] = [(node, 2)]
    while stack:
        item = stack.pop()
        if type(item) is str:
            out.append(item)
            continue
        current, depth = item
        kind = current["kind"]
        leaf = _leaf_json(current)
        if leaf is not None:
            if depth + (kind == "enum") > MAX_NESTING:
                _too_deep()
            out.append(leaf)
            continue
        if depth > MAX_NESTING:
            _too_deep()
        if kind == "nullable":
            out.append('{"kind":"nullable","inner":')
            stack += ("}", (current["inner"], depth + 1))
        elif kind == "array":
            out.append('{"kind":"array","element":')
            length = current.get("length")
            stack += ("}" if length is None else f',"length":{_int(length)}}}', (current["element"], depth + 1))
        else:
            fields = current["fields"]
            # fields array, field objects, then their type objects
            if depth + (3 if fields else 1) > MAX_NESTING:
                _too_deep()
            enum_too_deep = depth + 4 > MAX_NESTING
            parts: list[Any] = []
            run = ['{"kind":"struct","fields":[']
            sep = ""
            for f in fields:
                field_type = f["type"]
                flags = (',"optional":true' if f.get("optional") else "") + (',"nullable":true' if f.get("nullable") else "")
                leaf = _leaf_json(field_type)
                if leaf is None:
                    run.append(f'{sep}{{"name":{_esc(f["name"])},"type":')
                    parts += ("".join(run), (field_type, depth + 3))
                    run = [flags + "}"]
                else:
                    if enum_too_deep and field_type["kind"] == "enum":
                        _too_deep()
                    run.append(f'{sep}{{"name":{_esc(f["name"])},"type":{leaf}{flags}}}')
                sep = ","
            run.append("]}")
            parts.append("".join(run))
            stack.extend(reversed(parts))
    return "".join(out)


def _too_deep() -> NoReturn:
    raise HyperflyError("ir", f"artifact nests deeper than {MAX_NESTING}")


MAX_DICT_ENTRIES = 16383


def serialize_shared(shared: dict[str, Any]) -> str:
    columns = []
    for column in shared["columns"]:
        out = '{"leaf":' + _int(column["leaf"])
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
                        + _int(num["base"])
                        + ',"len":'
                        + _int(num["len"])
                        + ',"case":'
                        + _esc(num["case"])
                        + "}}"
                    )
            out += ',"grammar":[' + ",".join(tokens) + "]"
        if "derived" in column:
            derived = column["derived"]
            out += (
                ',"derived":{"source":'
                + _int(derived["source"])
                + ',"values":['
                + ",".join(_esc(value) for value in derived["values"])
                + "]}"
            )
        columns.append(out + "}")
    return '{"columns":[' + ",".join(columns) + "]}"


def serialize_artifact(ir: dict[str, Any], layout: str = "row", profile: dict[str, Any] | None = None) -> str:
    """Serialize validated IR, layout and optional profile as canonical artifact JSON."""
    version = _PLAN_VERSION[layout]
    head = f'{{"wire":1,"plan":{{"layout":"{layout}","version":{version}}},"ir":{_node_json(ir)}'
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
    from ._codec import _columnar_eligible, _flatten_leaves

    out: list[tuple[str, int]] = []
    next_array = 0
    stack = [ir]
    while stack:
        node = stack.pop()
        kind = node["kind"]
        if kind == "array":
            if _columnar_eligible(node):
                leaves = _flatten_leaves(node["element"])
                if leaves is not None:
                    out.extend((field["type"]["kind"], next_array) for _segs, field in leaves)
                    next_array += 1
                    continue
            stack.append(node["element"])
        elif kind == "nullable":
            stack.append(node["inner"])
        elif kind == "struct":
            stack.extend(reversed([f["type"] for f in node["fields"]]))
    return out


def column_count(node: dict[str, Any]) -> int:
    """Columnar leaves under this node. A pure function of the subtree, so two schema
    positions sharing one node object still count the same — which is why column bases
    are threaded positionally rather than looked up by node identity."""
    from ._codec import _columnar_eligible, _flatten_leaves

    count = 0
    stack = [node]
    while stack:
        current = stack.pop()
        kind = current["kind"]
        if kind == "array":
            if _columnar_eligible(current):
                leaves = _flatten_leaves(current["element"])
                if leaves is not None:
                    count += len(leaves)
                    continue
            stack.append(current["element"])
        elif kind == "nullable":
            stack.append(current["inner"])
        elif kind == "struct":
            stack.extend(f["type"] for f in current["fields"])
    return count


def validate_profile(ir: dict[str, Any], profile: Any) -> None:
    """Validate the IR, the profile as JSON data, then the profile against the IR;
    raise code ``ir`` on invalid data.

    Profile errors have the same ``profile:`` prefix as compilation errors.
    """
    try:
        validate_ir(ir)
        _validate_profile(ir, snapshot_profile(profile))
    except RecursionError:
        _fail("$", "IR or profile nesting exceeds Python's recursion limit")


_PROFILE_CONTAINERS = (list, tuple, set, frozenset, Mapping)


def snapshot_profile(profile: Any) -> Any:
    """A copy of the profile document, which must be acyclic JSON data: plain dicts with
    string keys, lists, strings, booleans, None, ints and finite floats. Advisory hints
    may nest to any depth; they are not part of the artifact."""

    def fail(message: str) -> NoReturn:
        _fail("profile", message)

    holder: list[Any] = [None]
    active: set[int] = set()
    # (value, parent, key); a None parent marks leaving the container `value`
    stack: list[tuple[Any, Any, Any]] = [(profile, holder, 0)]
    while stack:
        item, parent, key = stack.pop()
        if parent is None:
            active.discard(item)
            continue
        if type(parent) is dict and type(key) is not str:
            fail("JSON keys must be strings")
        kind = type(item)
        if item is None or kind is str or kind is bool or kind is int or (kind is float and math.isfinite(item)):
            parent[key] = item
            continue
        if not (kind is dict or kind is list or isinstance(item, _PROFILE_CONTAINERS)):
            fail("must contain only JSON data")
        if id(item) in active:
            fail("must not contain cycles")
        if kind is not dict and kind is not list:
            fail("must contain only plain objects and arrays")
        active.add(id(item))
        stack.append((id(item), None, None))
        copy: Any
        if kind is list:
            copy = [None] * len(item)
            stack.extend((item[i], copy, i) for i in range(len(item) - 1, -1, -1))
        else:
            copy = {}
            stack.extend((inner, copy, k) for k, inner in reversed(item.items()))
        parent[key] = copy
    return holder[0]


def _validate_profile(ir: dict[str, Any], profile: Any) -> None:
    def fail(message: str) -> NoReturn:
        _fail("profile", message)

    def record(value: Any, path: str) -> dict[str, Any]:
        if type(value) is not dict:
            fail(f"{path} must be an object")
        return cast("dict[str, Any]", value)

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
    if not _is_safe_int(version) or version not in (1, 2):
        # Do not stringify unchecked JSON: huge integers can exceed Python's
        # decimal conversion limit, and nested containers can exceed recursion.
        fail("unsupported profile version (expected 1 or 2)")
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
        if not _is_safe_int(leaf):
            fail(f"{path}.leaf must be an integer")
        leaf = int(leaf)
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
            grammar: list[dict[str, Any]] = []
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
                if not _is_safe_int(base) or base not in (10, 16, 36):
                    fail(f"{num_path}.base must be 10, 16, or 36")
                base = int(base)
                length = num["len"]
                if not _is_safe_int(length):
                    fail(f"{num_path}.len must be an integer")
                length = int(length)
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
            if not _is_safe_int(source):
                fail(f"{derived_path}.source must be an integer")
            source = int(source)
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
        checked_derived = column.get("derived")
        if checked_derived is None:
            continue
        derived = checked_derived
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
    """Return the first 16 SHA-256 bytes of canonical UTF-8 artifact JSON."""
    return hashlib.sha256(artifact.encode("utf-8")).digest()[:16]


def has_payload(node: dict[str, Any]) -> bool:
    """Whether one element of this type always consumes at least one bit on the wire."""
    stack = [node]
    while stack:
        current = stack.pop()
        kind = current["kind"]
        if kind == "literal":
            continue
        if kind == "struct":
            for f in current["fields"]:
                if f.get("optional") or f.get("nullable"):
                    return True
                stack.append(f["type"])
            continue
        if kind == "array":
            length = current.get("length")
            if length is None:
                return True
            if length > 0:
                stack.append(current["element"])
            continue
        return True
    return False
