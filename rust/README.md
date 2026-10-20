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

```rust
use hyperfly_core::{Codec, Field, Limits, Node, Plan, Value};

fn main() -> Result<(), hyperfly_core::Error> {
    let ir = Node::Struct(vec![Field {
        name: "id".into(),
        ty: Node::Str,
        optional: false,
        nullable: false,
    }]);
    let codec = Codec::compile(ir, Plan::Row, Limits::default(), true)?;

    let value = Value::Object(vec![("id".into(), Value::Str("abc".into()))]);
    let bytes = codec.encode(&value)?;
    assert_eq!(codec.decode(&bytes)?, value);
    Ok(())
}
```

`Plan::Columnar` lays arrays of structs out column by column, and
`Codec::compile_with_profile` takes a trained profile (dictionaries, grammars,
derived columns). `codec.fingerprint()` is the hex fingerprint peers negotiate on.

## Decoding untrusted input

Decoding is bounded by `Limits`: nesting depth, item counts and byte lengths are
capped, a declared count must be payable by the bytes still on the wire, and
every failure is a typed `Error` with an `ErrorCode`, never a panic or a partial
value.

## Minimum supported Rust version

Rust 1.82.

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
