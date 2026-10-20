#![doc = include_str!("../README.md")]
#![warn(missing_docs)]

mod codec;
mod ir;
mod value;
mod wire;

pub use codec::{Codec, HEADER_SIZE, MAGIC, WIRE_VERSION};
pub use ir::{
    fingerprint_of, serialize_artifact, serialize_node, Derivation, Field, GrammarCase, GrammarNum,
    GrammarToken, Literal, Node, Plan, Profile, ProfileColumn, MAX_DICT_ENTRIES,
};
pub use value::Value;
pub use wire::{Error, ErrorCode, Limits, Result, INT_MAX, INT_MIN};
