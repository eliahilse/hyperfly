"""Schema-compiled binary codecs and training, with stable error codes.

DEFAULT_LIMITS sets the default decode and encode resource bounds. INT_MIN and
INT_MAX delimit safe integers; MAGIC, WIRE_VERSION and HEADER_SIZE describe the envelope.
"""

from .registry import CodecRegistry
from ._codec import HEADER_SIZE, MAGIC, WIRE_VERSION, Codec, PackHooks, compile_ir
from ._ir import fingerprint_of, serialize_artifact, serialize_node, validate_ir, validate_profile
from ._train import train
from ._wire import (
    DEFAULT_LIMITS,
    INT_MAX,
    INT_MIN,
    DecodeError,
    EncodeError,
    FingerprintMismatchError,
    HyperflyError,
    Limits,
    UnsupportedSchemaError,
)

__all__ = [
    "Codec",
    "CodecRegistry",
    "DEFAULT_LIMITS",
    "DecodeError",
    "EncodeError",
    "FingerprintMismatchError",
    "HEADER_SIZE",
    "HyperflyError",
    "INT_MAX",
    "INT_MIN",
    "Limits",
    "MAGIC",
    "PackHooks",
    "UnsupportedSchemaError",
    "WIRE_VERSION",
    "compile_ir",
    "fingerprint_of",
    "serialize_artifact",
    "serialize_node",
    "train",
    "validate_ir",
    "validate_profile",
]
