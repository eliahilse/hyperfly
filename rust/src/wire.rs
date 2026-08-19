use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Varint,
    Range,
    Type,
    Required,
    Utf8,
    Float,
    Marker,
    Bitmap,
    Trailing,
    Truncated,
    Depth,
    Limit,
    Header,
    Fingerprint,
    Ir,
    Packed,
    Unsupported,
}

impl ErrorCode {
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

#[derive(Debug)]
pub struct Error {
    pub code: ErrorCode,
    pub message: String,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for Error {}

pub type Result<T> = std::result::Result<T, Error>;

pub fn err<T>(code: ErrorCode, message: impl Into<String>) -> Result<T> {
    Err(Error { code, message: message.into() })
}

pub const INT_MIN: i64 = -((1i64 << 53) - 1);
pub const INT_MAX: i64 = (1i64 << 53) - 1;
const ULEB_DOMAIN_MAX: u64 = (1u64 << 56) - 1;
const MAX_ULEB_BYTES: usize = 8;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_depth: u32,
    pub max_items: u64,
    pub max_byte_length: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_depth: 64, max_items: 1 << 24, max_byte_length: 1 << 28 }
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
    pub limits: Limits,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], limits: Limits) -> Self {
        Reader { buf, pos: 0, limits }
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
        if self.pos + n > self.buf.len() {
            return err(ErrorCode::Truncated, "unexpected end of input");
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    pub fn expect_end(&self) -> Result<()> {
        if self.pos != self.buf.len() {
            return err(ErrorCode::Trailing, format!("{} trailing byte(s) after body", self.buf.len() - self.pos));
        }
        Ok(())
    }
}

pub fn write_uleb(out: &mut Vec<u8>, value: u64) -> Result<()> {
    if value > ULEB_DOMAIN_MAX {
        return err(ErrorCode::Range, format!("uvarint out of v0 domain: {value}"));
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
    err(ErrorCode::Varint, format!("uvarint longer than {MAX_ULEB_BYTES} bytes"))
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
