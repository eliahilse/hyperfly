# hyperfly-core

Rust codec for the [hyperfly](https://hyperfly.dev) wire format.

The crate compiles a canonical IR into a `Codec` that encodes and decodes
hyperfly bodies, row or columnar, with or without a trained profile. It is
verified against the same golden vectors as the TypeScript and Python
implementations, so all three agree byte-for-byte.

For 1.0 the crate is codec-only. HTTP negotiation, schema adapters and profile
training live in the TypeScript and Python packages; a Rust peer builds the IR
and profile itself and can check them against a peer's served artifact by
comparing fingerprints.

```toml
[dependencies]
hyperfly-core = "0.1"
```

## Quick start

```rust
use hyperfly_core::{Codec, CompileOptions, Field, Node, Value};

fn main() -> Result<(), hyperfly_core::Error> {
    let ir = Node::Struct(vec![Field {
        name: "id".into(),
        ty: Node::Str,
        optional: false,
        nullable: false,
    }]);
    let codec = Codec::compile(ir, CompileOptions::default())?;

    let value = Value::Object(vec![("id".into(), Value::Str("abc".into()))]);
    let bytes = codec.encode(&value)?;
    assert_eq!(codec.decode(&bytes)?, value);
    Ok(())
}
```

`codec.fingerprint()` is the hex fingerprint peers negotiate on.

## Columnar plan and profiles

`Plan::Columnar` lays arrays of structs out column by column. A `Profile`
adds decode-critical knowledge for string columns: dictionaries, grammars and
derived columns. Each `ProfileColumn` names its column by leaf ordinal. Ordinals
come from a depth-first walk of the schema in declared order that continues
through struct fields, nullable inner nodes and the elements of ineligible
arrays. Each eligible array contributes all of its flattened leaves, of every
kind, as consecutive ordinals and is not descended into further. The
fingerprint covers the profile, so peers only agree when they compiled the
same one.

```rust
use hyperfly_core::{Codec, CompileOptions, Field, Node, Plan, Profile, ProfileColumn, Value};

fn main() -> Result<(), hyperfly_core::Error> {
    let ir = Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "status".into(),
            ty: Node::Str,
            optional: false,
            nullable: false,
        }])),
        length: None,
    };
    let profile = Profile::new(
        1,
        vec![ProfileColumn::new(0).with_dict(vec!["active".into(), "paused".into()])],
    );
    let codec = Codec::compile(
        ir,
        CompileOptions::new()
            .with_plan(Plan::Columnar)
            .with_profile(profile),
    )?;

    let value = Value::Array(vec![
        Value::Object(vec![("status".into(), Value::Str("active".into()))]),
        Value::Object(vec![("status".into(), Value::Str("paused".into()))]),
    ]);
    assert_eq!(codec.decode(&codec.encode(&value)?)?, value);
    Ok(())
}
```

## Decoding untrusted input

Decoding is bounded by `Limits`: nesting depth, item counts and byte lengths are
capped, a declared count must be payable by the bytes still on the wire, and
every failure is a typed `Error` with an `ErrorCode`, never a panic or a partial
value. Start from the defaults and tighten individual fields:

```rust
use hyperfly_core::{Codec, CompileOptions, Limits, Node};

fn main() -> Result<(), hyperfly_core::Error> {
    let mut limits = Limits::default();
    limits.max_depth = 16;
    limits.max_total_bytes = 1 << 20;
    let codec = Codec::compile(Node::Str, CompileOptions::new().with_limits(limits))?;
    assert_eq!(codec.limits().max_depth, 16);
    Ok(())
}
```

- `max_depth` bounds nesting of structs, arrays and nullable values.
- `max_items` bounds the element count of each array, and `max_total_items`
  the sum of all array counts in one body.
- `max_byte_length` bounds each string or bytes value, packed blob and
  inflated column. Literal and enum values are schema constants and are exempt,
  though they still count toward the byte budget.
- `max_total_bytes` bounds the decoded string and bytes total in one body,
  including reconstructed values: literals, enum members and dictionary,
  grammar and derived strings.
- `max_amplification` and `max_byte_amplification` scale item and byte budgets
  with the body length, so a short body cannot declare a large result.

## Errors

Every failure carries an `ErrorCode` and a message. The codes are the same
codec error codes the TypeScript and Python packages report. A fingerprint
mismatch from `decode` also reports both fingerprints through
`err.fingerprint_mismatch()`.

```rust
use hyperfly_core::{Codec, CompileOptions, ErrorCode, Limits, Node};

fn main() -> Result<(), hyperfly_core::Error> {
    let mut limits = Limits::default();
    limits.max_items = 2;
    let ir = Node::Array {
        element: Box::new(Node::Bool),
        length: None,
    };
    let codec = Codec::compile(ir, CompileOptions::new().with_limits(limits))?;

    let err = codec.decode_body(&[3, 0b111]).unwrap_err();
    match err.code() {
        ErrorCode::Limit => assert_eq!(err.code().as_str(), "limit"),
        other => panic!("unexpected {other}: {}", err.message()),
    }
    Ok(())
}
```

## Stability

hyperfly-core follows semantic versioning from 1.0. Within 1.x the wire format
and the public API are stable; the minimum supported Rust version is covered by
its own policy below. Enums and option structs marked
`#[non_exhaustive]` may gain variants or fields in minor releases, so match
them with a wildcard arm and build options from `Default` or `new()`. The crate
has no `unsafe` code and no cargo features.

## Minimum supported Rust version

Rust 1.82 for the library. The MSRV is not part of the API stability
guarantee: it may be raised in a minor release, noted in the changelog, and
never in a patch release.

## Specification

The normative documents are
[wire v0](https://github.com/eliahilse/hyperfly/blob/main/spec/wire-v0.md),
[plan columnar v5](https://github.com/eliahilse/hyperfly/blob/main/spec/plan-columnar-v5.md)
and [negotiation v1](https://github.com/eliahilse/hyperfly/blob/main/spec/negotiation-v1.md),
with golden vectors in
[`spec/vectors`](https://github.com/eliahilse/hyperfly/tree/main/spec/vectors).
The vector tests run from a checkout of the repository:

```bash
cargo test --manifest-path rust/Cargo.toml
```

## License

[Apache License 2.0](https://github.com/eliahilse/hyperfly/blob/main/LICENSE)
