/// A codec value, with absent object fields distinct from explicit nulls.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// An explicit null.
    Null,
    /// A boolean.
    Bool(bool),
    /// An integer; encoding requires the [`crate::INT_MIN`] to [`crate::INT_MAX`] domain.
    Int(i64),
    /// A binary64 number; encoding rejects non-finite values and normalizes negative zero.
    Float(f64),
    /// A UTF-8 string.
    Str(String),
    /// An uninterpreted byte sequence.
    Bytes(Vec<u8>),
    /// An ordered sequence of values.
    Array(Vec<Value>),
    /// Named fields; decoding emits present fields in schema order.
    Object(Vec<(String, Value)>),
}

impl Value {
    /// Returns the first object field named `key`, or `None` if absent or not an object.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}
