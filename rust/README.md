# hyperfly-core

Rust implementation of the [hyperfly](https://hyperfly.dev) wire format.

The authorities are `spec/wire-v0.md`, `spec/plan-columnar-v3.md` and the golden
vectors in `spec/vectors/`. This crate is verified against those vectors, the same
ones the TypeScript and Python implementations run, so all three agree byte-for-byte.

```rust
use hyperfly_core::{Codec, Field, Limits, Node, Plan, Value};

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
```

`Codec::compile_with_profile` takes a trained dictionary. There is no schema adapter
here yet — the crate takes a canonical IR directly, so a Rust caller builds `Node`
itself or loads an artifact served over `.well-known` by a peer.

Decoding is bounded: nesting depth, item counts and byte lengths are all limited, a
declared count must be payable by the bytes still on the wire, and every failure is
a typed `Error` rather than a panic.

```bash
cargo test --manifest-path rust/Cargo.toml
```

Pre-release; not yet published to crates.io.

## License

[Apache License 2.0](../LICENSE)
