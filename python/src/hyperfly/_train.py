from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence
from typing import Any

from ._codec import (
    _columnar_eligible,
    _default_deflate,
    _encode_int_column,
    _flatten_leaves,
    _match_grammar,
    _packed_bytes,
)
from ._ir import MAX_DICT_ENTRIES, _enumerate_column_refs, _has_lone_surrogate, column_count
from ._wire import uleb_len


def _leaf_value(row: Any, segs: tuple[str, ...]) -> Any:
    value = row
    for seg in segs:
        if not isinstance(value, dict):
            return None
        value = value.get(seg)
    return value


def _collect(
    node: dict[str, Any],
    value: Any,
    base: int,
    refs: list[tuple[str, int]],
    batches: dict[int, list[list[str]]],
    arrays: list[tuple[int, dict[int, list[str | None]]]],
) -> None:
    if value is None:
        return
    kind = node["kind"]
    if kind == "array":
        if not isinstance(value, list):
            return
        if _columnar_eligible(node):
            leaves = _flatten_leaves(node["element"])
            if leaves is None:
                return
            columns: dict[int, list[str | None]] = {}
            for i, (segs, field) in enumerate(leaves):
                if field["type"]["kind"] != "string":
                    continue
                aligned = []
                for row in value:
                    candidate = _leaf_value(row, segs)
                    aligned.append(
                        candidate if isinstance(candidate, str) and not _has_lone_surrogate(candidate) else None
                    )
                columns[base + i] = aligned
                batches.setdefault(base + i, []).append([entry for entry in aligned if entry is not None])
            arrays.append((refs[base][1] if base < len(refs) else -1, columns))
            return
        for item in value:
            _collect(node["element"], item, base, refs, batches, arrays)
    elif kind == "nullable":
        _collect(node["inner"], value, base, refs, batches, arrays)
    elif kind == "struct" and isinstance(value, dict):
        field_column = base
        for field in node["fields"]:
            field_base = field_column
            field_column += column_count(field["type"])
            _collect(field["type"], value.get(field["name"]), field_base, refs, batches, arrays)


def _string_wire_length(value: str) -> int:
    size = len(value.encode("utf-8"))
    return uleb_len(size) + size


def _plain_mode_cost(batches: list[list[str]]) -> int:
    return sum(_string_wire_length(value) for batch in batches for value in batch)


def _deflate_mode_cost(batches: list[list[str]]) -> int:
    cost = 0
    for batch in batches:
        if not batch:
            continue
        encoded = [value.encode("utf-8") for value in batch]
        packed = _default_deflate(b"".join(encoded))
        cost += sum(uleb_len(len(value)) for value in encoded) + uleb_len(len(packed)) + len(packed)
    return cost


def _dictionary_mode_cost(dictionary: list[str], batches: list[list[str]]) -> int:
    codes = {value: i + 1 for i, value in enumerate(dictionary)}
    cost = 0
    for batch in batches:
        if not batch:
            continue
        highest = max(codes.get(value, 0) for value in batch)
        escaped = sum(_string_wire_length(value) for value in batch if value not in codes)
        cost += 1 + _packed_bytes(len(batch), highest.bit_length()) + escaped
    return cost


def _induce_dictionary(
    batches: list[list[str]], min_occurrences: int | float, max_entries: int
) -> list[str] | None:
    counts: Counter[str] = Counter()
    batches_by_value: dict[str, list[int]] = {}
    for batch_index, batch in enumerate(batches):
        counts.update(batch)
        for value in set(batch):
            batches_by_value.setdefault(value, []).append(batch_index)
    ranked = sorted(
        (value for value, count in counts.items() if count >= min_occurrences),
        key=lambda value: (-counts[value], value),
    )[:max_entries]
    if not ranked:
        return None

    widths = [0] * len(batches)
    active = sum(bool(batch) for batch in batches)
    escaped_cost = _plain_mode_cost(batches)
    packed_cost = 0
    best_cost = escaped_cost
    best_length = 0
    for code, value in enumerate(ranked, 1):
        escaped_cost -= counts[value] * _string_wire_length(value)
        for batch_index in batches_by_value[value]:
            count = len(batches[batch_index])
            old_bytes = _packed_bytes(count, widths[batch_index])
            widths[batch_index] = code.bit_length()
            packed_cost += _packed_bytes(count, widths[batch_index]) - old_bytes
        cost = active + packed_cost + escaped_cost
        if cost < best_cost:
            best_cost = cost
            best_length = code
    return ranked[:best_length] if best_length else None


def _grammar_mode_cost(grammar: list[dict[str, Any]], batches: list[list[str]]) -> int | float:
    numeric = [token["num"] for token in grammar if "num" in token]
    cost = 0
    for batch in batches:
        if not batch:
            continue
        cost += 1
        lanes: list[list[int]] = [[] for _ in numeric]
        for value in batch:
            parsed = _match_grammar(value, grammar)
            if parsed is None:
                return math.inf
            for lane, entry in zip(lanes, parsed):
                lane.append(entry)
        for num, lane in zip(numeric, lanes):
            encoded = bytearray()
            _encode_int_column(encoded, {"min": 0, "max": num["base"] ** num["len"] - 1}, lane)
            cost += len(encoded)
    return cost


def _induce_grammar(batches: list[list[str]], dictionary: list[str] | None) -> list[dict[str, Any]] | None:
    tokenized = [re.findall(r"[A-Za-z0-9]+|[^A-Za-z0-9]+", value) for batch in batches for value in batch]
    if not tokenized or not tokenized[0]:
        return None
    shape = tokenized[0]
    for tokens in tokenized[1:]:
        if len(tokens) != len(shape):
            return None
        for token, first in zip(tokens, shape):
            alnum = first.isascii() and first.isalnum()
            if alnum != (token.isascii() and token.isalnum()):
                return None
            if (alnum and len(token) != len(first)) or (not alnum and token != first):
                return None

    grammar: list[dict[str, Any]] = []
    for index, first in enumerate(shape):
        observed = [tokens[index] for tokens in tokenized]
        if all(value == first for value in observed):
            if grammar and "lit" in grammar[-1]:
                grammar[-1]["lit"] += first
            else:
                grammar.append({"lit": first})
            continue
        lower = any("a" <= char <= "z" for value in observed for char in value)
        upper = any("A" <= char <= "Z" for value in observed for char in value)
        if lower and upper:
            return None
        digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" if upper else "0123456789abcdefghijklmnopqrstuvwxyz"
        max_digit = max(digits.index(char) for value in observed for char in value)
        base = next((base for base, cap in ((10, 15), (16, 13), (36, 10)) if max_digit < base and len(first) <= cap), None)
        if base is None:
            return None
        grammar.append({"num": {"base": base, "len": len(first), "case": "upper" if upper and base != 10 else "lower"}})
    if len(grammar) > 8 or not any("num" in token for token in grammar):
        return None
    alternatives = [
        _plain_mode_cost(batches),
        _dictionary_mode_cost(dictionary, batches) if dictionary is not None else math.inf,
        _deflate_mode_cost(batches),
    ]
    return grammar if _grammar_mode_cost(grammar, batches) < min(alternatives) else None


def _detect_derivation(
    source: int,
    target: int,
    dictionary: list[str],
    array: int,
    samples: list[tuple[int, dict[int, list[str | None]]]],
) -> dict[str, Any] | None:
    indices = {value: i for i, value in enumerate(dictionary)}
    values: list[str | None] = [None] * len(dictionary)
    for sample_array, columns in samples:
        if sample_array != array:
            continue
        sources = columns.get(source, [])
        targets = columns.get(target, [])
        for row, source_value in enumerate(sources):
            if source_value is None:
                continue
            index = indices.get(source_value)
            if index is None:
                return None
            target_value = targets[row] if row < len(targets) else None
            if target_value is None:
                continue
            if values[index] is not None and values[index] != target_value:
                return None
            values[index] = target_value
    if any(value is None for value in values):
        return None
    return {"source": source, "values": values}


def train(
    ir: dict[str, Any],
    samples: Sequence[Any],
    *,
    min_occurrences: int | float = 2,
    max_entries: int | float = MAX_DICT_ENTRIES,
) -> dict[str, Any] | None:
    """Train a deterministic columnar profile from plain response values.

    Values must recur at least ``min_occurrences`` times to enter a dictionary,
    which holds at most ``max_entries`` entries. Return None when no profile helps.
    """
    if math.isfinite(min_occurrences):
        min_occurrences = max(1, math.floor(min_occurrences))
    elif min_occurrences == -math.inf:
        min_occurrences = 1
    if math.isnan(max_entries):
        entry_limit = 0
    else:
        entry_limit = math.floor(max(0, min(max_entries, MAX_DICT_ENTRIES)))
    refs = _enumerate_column_refs(ir)
    batches: dict[int, list[list[str]]] = {}
    arrays: list[tuple[int, dict[int, list[str | None]]]] = []
    for sample in samples:
        _collect(ir, sample, 0, refs, batches, arrays)

    by_leaf: dict[int, dict[str, Any]] = {}
    for ordinal, (kind, _array) in enumerate(refs):
        if kind != "string":
            continue
        leaf_batches = batches.get(ordinal, [])
        dictionary = _induce_dictionary(leaf_batches, min_occurrences, entry_limit)
        grammar = _induce_grammar(leaf_batches, dictionary)
        if dictionary is not None or grammar is not None:
            column: dict[str, Any] = {"leaf": ordinal}
            if dictionary is not None:
                column["dict"] = dictionary
            if grammar is not None:
                column["grammar"] = grammar
            by_leaf[ordinal] = column

    for target, (kind, array) in enumerate(refs):
        if kind != "string":
            continue
        for source, (source_kind, source_array) in enumerate(refs[:target]):
            if source_kind != "string" or source_array != array:
                continue
            dictionary = by_leaf.get(source, {}).get("dict")
            if dictionary is None:
                continue
            derived = _detect_derivation(source, target, dictionary, array, arrays)
            if derived is not None:
                by_leaf.setdefault(target, {"leaf": target})["derived"] = derived
                break

    columns = [by_leaf[ordinal] for ordinal in sorted(by_leaf)]
    if not columns:
        return None
    version = 2 if any("grammar" in column or "derived" in column for column in columns) else 1
    return {"version": version, "shared": {"columns": columns}}
