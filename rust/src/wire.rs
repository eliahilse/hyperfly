use std::fmt;

/// A machine-readable reason for a compilation, encoding, or decoding failure.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// `varint`: an overlong ULEB128 encoding or one exceeding eight bytes.
    Varint,
    /// `range`: a numeric value, index, or derived source is outside its allowed domain.
    Range,
    /// `type`: an input value does not match its schema type, literal, enum, or fixed length.
    Type,
    /// `required`: an input object lacks a required field.
    Required,
    /// `utf8`: decoded string bytes are not valid UTF-8.
    Utf8,
    /// `float`: a non-finite float, or on decode a negative-zero bit pattern or a non-minimal XOR
    /// float column encoding.
    Float,
    /// `marker`: an invalid boolean, nullable marker, column mode, or mode parameter.
    Marker,
    /// `bitmap`: nonzero bitmap or bit-packing padding, an absent field marked null, inconsistent
    /// escape bits, or a patched-frame exception with a zero high part.
    Bitmap,
    /// `trailing`: bytes remain after a complete body.
    Trailing,
    /// `truncated`: input ends before the declared value is complete.
    Truncated,
    /// `depth`: value traversal exceeds the configured nesting depth.
    Depth,
    /// `limit`: an item, byte, amplification, or remaining-input bound is exceeded.
    Limit,
    /// `header`: the envelope is too short or has invalid magic or wire major version.
    Header,
    /// `fingerprint`: the envelope fingerprint differs from the codec's fingerprint.
    Fingerprint,
    /// `ir`: the schema, layout, or profile is invalid.
    Ir,
    /// `packed`: a DEFLATE blob is invalid, has trailing bytes, or has the wrong output length.
    Packed,
    /// `unsupported`: packed input is disabled or a column requires a missing profile entry.
    Unsupported,
}

impl ErrorCode {
    /// Returns the lowercase wire error code name.
    ///
    /// These are the same codec error codes the TypeScript and Python packages report.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Varint => "varint",
            ErrorCode::Range => "range",
            ErrorCode::Type => "type",
            ErrorCode::Required => "required",
            ErrorCode::Utf8 => "utf8",
            ErrorCode::Float => "float",
            ErrorCode::Marker => "marker",
            ErrorCode::Bitmap => "bitmap",
            ErrorCode::Trailing => "trailing",
            ErrorCode::Truncated => "truncated",
            ErrorCode::Depth => "depth",
            ErrorCode::Limit => "limit",
            ErrorCode::Header => "header",
            ErrorCode::Fingerprint => "fingerprint",
            ErrorCode::Ir => "ir",
            ErrorCode::Packed => "packed",
            ErrorCode::Unsupported => "unsupported",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A codec failure with a stable code and a human-readable explanation.
#[derive(Debug, Clone)]
pub struct Error {
    pub(crate) code: ErrorCode,
    pub(crate) message: String,
    pub(crate) mismatch: Option<Box<(String, String)>>,
}

impl Error {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Error {
        Error {
            code,
            message: message.into(),
            mismatch: None,
        }
    }

    pub(crate) fn fingerprint(expected: &str, actual: String) -> Error {
        Error {
            code: ErrorCode::Fingerprint,
            message: format!("codec fingerprint {expected} does not match payload {actual}"),
            mismatch: Some(Box::new((expected.to_owned(), actual))),
        }
    }

    /// Returns the machine-readable failure category.
    ///
    /// ```
    /// use hyperfly_core::{Codec, CompileOptions, ErrorCode, Node};
    ///
    /// let codec = Codec::compile(Node::Str, CompileOptions::default()).unwrap();
    /// let err = codec.decode(&[0x68, 0x66]).unwrap_err();
    /// assert_eq!(err.code(), ErrorCode::Header);
    /// assert_eq!(err.code().as_str(), "header");
    /// ```
    pub fn code(&self) -> ErrorCode {
        self.code
    }

    /// Returns the explanation, including a value path when available.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Returns the codec's and the payload's fingerprints, as lowercase hex, for an
    /// [`ErrorCode::Fingerprint`] error from [`crate::Codec::decode`]; `None` otherwise.
    ///
    /// ```
    /// use hyperfly_core::{Codec, CompileOptions, Node, Value};
    ///
    /// let strings = Codec::compile(Node::Str, CompileOptions::new()).unwrap();
    /// let bools = Codec::compile(Node::Bool, CompileOptions::new()).unwrap();
    /// let bytes = strings.encode(&Value::Str("hi".into())).unwrap();
    ///
    /// let err = bools.decode(&bytes).unwrap_err();
    /// assert_eq!(
    ///     err.fingerprint_mismatch(),
    ///     Some((bools.fingerprint(), strings.fingerprint()))
    /// );
    /// ```
    pub fn fingerprint_mismatch(&self) -> Option<(&str, &str)> {
        self.mismatch
            .as_deref()
            .map(|(expected, actual)| (expected.as_str(), actual.as_str()))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for Error {}

/// A codec operation's value or typed failure.
pub type Result<T> = std::result::Result<T, Error>;

pub fn err<T>(code: ErrorCode, message: impl Into<String>) -> Result<T> {
    Err(Error::new(code, message))
}

/// The smallest wire integer, `-(2^53 - 1)`.
pub const INT_MIN: i64 = -((1i64 << 53) - 1);
/// The largest wire integer, `2^53 - 1`.
pub const INT_MAX: i64 = (1i64 << 53) - 1;
const ULEB_DOMAIN_MAX: u64 = (1u64 << 56) - 1;
const MAX_ULEB_BYTES: usize = 8;

/// Resource bounds enforced during encoding and decoding.
///
/// Start from [`Limits::default`] and adjust individual fields:
///
/// ```
/// use hyperfly_core::{Codec, CompileOptions, Limits, Node};
///
/// let mut limits = Limits::default();
/// limits.max_depth = 16;
/// let codec = Codec::compile(Node::Str, CompileOptions::new().with_limits(limits)).unwrap();
/// assert_eq!(codec.limits().max_depth, 16);
/// ```
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    /// Maximum nesting depth from root depth zero; default 64. Structs, arrays, and nullable nodes count.
    /// Encoding and decoding recurse once per level, so a much higher value needs a thread stack
    /// to match: roughly 8 KiB per level unoptimized, while optimized builds fit every depth a
    /// compiled schema allows on a 2 MiB stack.
    pub max_depth: u32,
    /// Maximum number of elements per array; default `2^24`.
    pub max_items: u64,
    /// Maximum bytes per string or byte value, and per packed blob and inflated column; default `2^28`.
    pub max_byte_length: u64,
    /// Array count multiplier for the bound `count <= max_amplification * (remaining_bytes + 1)`;
    /// default 32. On decode it bounds columnar arrays and row arrays of zero-bit elements;
    /// other row arrays are held to the stricter one-bit floor, `count <= remaining_bytes * 8`.
    /// Encoding applies it to every array, with the array's own bytes after its count in place
    /// of remaining bytes.
    pub max_amplification: u64,
    /// Maximum sum of the element counts of every array in one body; default `2^24`. The
    /// effective item budget is `min(max_total_items, max_amplification * (body_length + 1))`,
    /// charged as each array's count is read and checked against the final body on encode.
    pub max_total_items: u64,
    /// Maximum decoded bytes of every string and bytes value in one body, including
    /// reconstructed values; default `2^26`. The effective byte budget is
    /// `min(max_total_bytes, max_byte_amplification * (body_length + 1))`.
    pub max_total_bytes: u64,
    /// Body length multiplier bounding decoded bytes of every string and bytes value,
    /// including reconstructed values; default 64. The effective byte budget is
    /// `min(max_total_bytes, max_byte_amplification * (body_length + 1))`.
    pub max_byte_amplification: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_depth: 64,
            max_items: 1 << 24,
            max_byte_length: 1 << 28,
            max_amplification: 32,
            max_total_items: 1 << 24,
            max_total_bytes: 1 << 26,
            max_byte_amplification: 64,
        }
    }
}

impl Limits {
    pub(crate) fn byte_budget(&self, body_length: usize) -> u64 {
        let amplified =
            (body_length as u128 + 1).saturating_mul(u128::from(self.max_byte_amplification));
        u128::from(self.max_total_bytes).min(amplified) as u64
    }

    pub(crate) fn item_budget(&self, body_length: usize) -> u64 {
        let amplified =
            (body_length as u128 + 1).saturating_mul(u128::from(self.max_amplification));
        u128::from(self.max_total_items).min(amplified) as u64
    }
}

pub(crate) struct Budget {
    pub total: u64,
    cap: u64,
    pub total_bytes: u64,
    byte_cap: u64,
}

impl Budget {
    pub fn new(cap: u64, byte_cap: u64) -> Self {
        Budget {
            total: 0,
            cap,
            total_bytes: 0,
            byte_cap,
        }
    }

    pub fn charge_bytes(&mut self, len: u64, path: &str) -> Result<()> {
        if len > self.byte_cap - self.total_bytes {
            return err(ErrorCode::Limit, format!("{path}: byte budget exceeded"));
        }
        self.total_bytes += len;
        Ok(())
    }

    pub fn charge(&mut self, count: u64, path: &str) -> Result<()> {
        if count > self.cap - self.total {
            return err(ErrorCode::Limit, format!("{path}: item budget exceeded"));
        }
        self.total += count;
        Ok(())
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    budget: Budget,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], limits: &Limits) -> Self {
        Reader {
            buf,
            pos: 0,
            budget: Budget::new(limits.item_budget(buf.len()), limits.byte_budget(buf.len())),
        }
    }

    pub fn charge_bytes(&mut self, len: u64, path: &str) -> Result<()> {
        self.budget.charge_bytes(len, path)
    }

    pub fn charge_items(&mut self, count: usize, path: &str) -> Result<()> {
        self.budget.charge(count as u64, path)
    }

    pub fn u8(&mut self) -> Result<u8> {
        if self.pos >= self.buf.len() {
            return err(ErrorCode::Truncated, "unexpected end of input");
        }
        let b = self.buf[self.pos];
        self.pos += 1;
        Ok(b)
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let Some(end) = self.pos.checked_add(n) else {
            return err(
                ErrorCode::Truncated,
                "requested byte length overflows the host size domain",
            );
        };
        if end > self.buf.len() {
            return err(ErrorCode::Truncated, "unexpected end of input");
        }
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn expect_end(&self) -> Result<()> {
        if self.pos != self.buf.len() {
            return err(
                ErrorCode::Trailing,
                format!("{} trailing byte(s) after body", self.buf.len() - self.pos),
            );
        }
        Ok(())
    }
}

pub fn write_uleb(out: &mut Vec<u8>, value: u64) -> Result<()> {
    if value > ULEB_DOMAIN_MAX {
        return err(
            ErrorCode::Range,
            format!("uvarint out of v0 domain: {value}"),
        );
    }
    let mut v = value;
    loop {
        let group = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(group);
            return Ok(());
        }
        out.push(group | 0x80);
    }
}

pub fn read_uleb(r: &mut Reader) -> Result<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for i in 0..MAX_ULEB_BYTES {
        let byte = r.u8()?;
        let group = (byte & 0x7f) as u64;
        result |= group << shift;
        if byte & 0x80 == 0 {
            if i > 0 && group == 0 {
                return err(ErrorCode::Varint, "overlong uvarint encoding");
            }
            return Ok(result);
        }
        shift += 7;
    }
    err(
        ErrorCode::Varint,
        format!("uvarint longer than {MAX_ULEB_BYTES} bytes"),
    )
}

pub fn uleb_len(value: u64) -> usize {
    let mut v = value;
    let mut len = 1;
    while v > 0x7f {
        v >>= 7;
        len += 1;
    }
    len
}

pub fn zigzag(v: i64) -> u64 {
    if v >= 0 {
        (v as u64) << 1
    } else {
        (((-v) as u64) << 1) - 1
    }
}

pub fn unzigzag(u: u64) -> i64 {
    if u & 1 == 1 {
        -(((u + 1) >> 1) as i64)
    } else {
        (u >> 1) as i64
    }
}

pub fn write_bitmap(out: &mut Vec<u8>, bits: &[bool]) {
    for chunk in bits.chunks(8) {
        let mut byte = 0u8;
        for (i, bit) in chunk.iter().enumerate() {
            if *bit {
                byte |= 1 << i;
            }
        }
        out.push(byte);
    }
}

pub fn read_bitmap(r: &mut Reader, count: usize, path: &str) -> Result<Vec<bool>> {
    let mut bits = Vec::with_capacity(count);
    let mut base = 0;
    while base < count {
        let byte = r.u8()?;
        let used = (count - base).min(8);
        if used < 8 && byte >> used != 0 {
            return err(ErrorCode::Bitmap, format!("{path}: nonzero bitmap padding"));
        }
        for i in 0..used {
            bits.push(byte & (1 << i) != 0);
        }
        base += used;
    }
    Ok(bits)
}
