pub mod codec;
pub mod ir;
pub mod value;
pub mod wire;

pub use codec::{Codec, HEADER_SIZE, MAGIC, WIRE_VERSION};
pub use ir::{fingerprint_of, serialize_artifact, serialize_node, Field, Literal, Node, Plan};
pub use value::Value;
pub use wire::{Error, ErrorCode, Limits, INT_MAX, INT_MIN};
