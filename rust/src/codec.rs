use crate::ir::{
    array_ordinal_bases, fingerprint_of, has_payload, serialize_artifact, validate, validate_profile,
    Field, Literal, Node, Plan, Profile,
};
use crate::value::Value;
use crate::wire::*;

pub const MAGIC: [u8; 2] = [0x68, 0x66];
pub const WIRE_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 19;

const NEG_ZERO_BITS: u64 = 0x8000_0000_0000_0000;
const POW10: [f64; 9] = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const MAX_SCALE: u8 = 8;

const LEAF_OK: fn(&Node) -> bool = |n| {
    matches!(
        n,
        Node::Bool | Node::Int { .. } | Node::Float64 | Node::Str | Node::Bytes | Node::Literal(_) | Node::Enum(_)
    )
};

struct LeafCol<'a> {
    segs: Vec<&'a str>,
    field: &'a Field,
}

fn flatten<'a>(fields: &'a [Field], segs: &mut Vec<&'a str>, out: &mut Vec<LeafCol<'a>>) -> bool {
    if fields.is_empty() {
        return false;
    }
    for f in fields {
        match &f.ty {
            Node::Struct(inner) => {
                if f.optional || f.nullable {
                    return false;
                }
                segs.push(&f.name);
                if !flatten(inner, segs, out) {
                    return false;
                }
                segs.pop();
            }
            t if LEAF_OK(t) => {
                let mut path = segs.clone();
                path.push(&f.name);
                out.push(LeafCol { segs: path, field: f });
            }
            _ => return false,
        }
    }
    true
}

/// Leaf kinds of an eligible element, for the profile ordinal walk (ir.rs).
pub(crate) fn flatten_for_profile<'a>(
    fields: &'a [Field],
    segs: &mut Vec<&'a str>,
    out: &mut Vec<&'static str>,
) -> bool {
    if fields.is_empty() {
        return false;
    }
    for f in fields {
        match &f.ty {
            Node::Struct(inner) => {
                if f.optional || f.nullable {
                    return false;
                }
                segs.push(&f.name);
                if !flatten_for_profile(inner, segs, out) {
                    return false;
                }
                segs.pop();
            }
            t if LEAF_OK(t) => out.push(match t {
                Node::Bool => "bool",
                Node::Int { .. } => "int",
                Node::Float64 => "float64",
                Node::Str => "string",
                Node::Bytes => "bytes",
                Node::Enum(_) => "enum",
                _ => "literal",
            }),
            _ => return false,
        }
    }
    true
}

fn columnar_leaves(element: &Node) -> Option<Vec<LeafCol<'_>>> {
    let Node::Struct(fields) = element else { return None };
    let mut out = Vec::new();
    let mut segs = Vec::new();
    if flatten(fields, &mut segs, &mut out) {
        Some(out)
    } else {
        None
    }
}

fn type_accepts_null(node: &Node) -> bool {
    matches!(node, Node::Nullable(_)) || matches!(node, Node::Literal(Literal::Null))
}

fn int_form(min: Option<i64>, v: i64) -> u64 {
    match min {
        Some(lo) => (v - lo) as u64,
        None => zigzag(v),
    }
}

fn check_int(min: Option<i64>, max: Option<i64>, value: &Value, path: &str) -> Result<i64> {
    let Value::Int(v) = value else {
        return err(ErrorCode::Type, format!("{path}: expected a safe integer"));
    };
    let v = *v;
    if !(INT_MIN..=INT_MAX).contains(&v) {
        return err(ErrorCode::Type, format!("{path}: outside the v0 integer domain"));
    }
    if let Some(lo) = min {
        if v < lo {
            return err(ErrorCode::Range, format!("{path}: {v} below declared min {lo}"));
        }
    }
    if let Some(hi) = max {
        if v > hi {
            return err(ErrorCode::Range, format!("{path}: {v} above declared max {hi}"));
        }
    }
    Ok(v)
}

fn decoded_int(min: Option<i64>, max: Option<i64>, value: i64, path: &str) -> Result<i64> {
    if !(INT_MIN..=INT_MAX).contains(&value) {
        return err(ErrorCode::Range, format!("{path}: decoded integer outside the v0 domain"));
    }
    if let Some(lo) = min {
        if value < lo {
            return err(ErrorCode::Range, format!("{path}: below declared min"));
        }
    }
    if let Some(hi) = max {
        if value > hi {
            return err(ErrorCode::Range, format!("{path}: above declared max"));
        }
    }
    Ok(value)
}

fn canon_float(value: &Value, path: &str) -> Result<f64> {
    let f = match value {
        Value::Float(f) => *f,
        Value::Int(i) => *i as f64,
        _ => return err(ErrorCode::Type, format!("{path}: expected number")),
    };
    if !f.is_finite() {
        return err(ErrorCode::Float, format!("{path}: float64 must be finite"));
    }
    Ok(if f == 0.0 { 0.0 } else { f })
}

fn decimal_mantissa(v: f64, pow: f64) -> f64 {
    if v > 0.0 {
        (v * pow + 0.5).floor()
    } else if v < 0.0 {
        -((-v * pow + 0.5).floor())
    } else {
        0.0
    }
}

fn decimal_scale(values: &[f64]) -> Option<u8> {
    'scale: for s in 0..=MAX_SCALE {
        let pow = POW10[s as usize];
        for v in values {
            let m = decimal_mantissa(*v, pow);
            if !(INT_MIN as f64..=INT_MAX as f64).contains(&m) || m / pow != *v {
                continue 'scale;
            }
        }
        return Some(s);
    }
    None
}

fn sig_bytes(x: u64) -> usize {
    ((64 - x.leading_zeros() as usize) + 7) / 8
}

pub struct Codec {
    ir: Node,
    plan: Plan,
    limits: Limits,
    pack: bool,
    profile: Option<Profile>,
    bases: Vec<(*const Node, usize)>,
    pub artifact: String,
    fp: [u8; 16],
    pub fingerprint: String,
}

impl Codec {
    pub fn compile(ir: Node, plan: Plan, limits: Limits, pack: bool) -> Result<Codec> {
        Codec::compile_with_profile(ir, plan, limits, pack, None)
    }

    pub fn compile_with_profile(
        ir: Node,
        plan: Plan,
        limits: Limits,
        pack: bool,
        profile: Option<Profile>,
    ) -> Result<Codec> {
        validate(&ir, "$")?;
        if let Some(p) = &profile {
            if plan != Plan::Columnar {
                return err(ErrorCode::Ir, "profiles apply to the columnar plan only");
            }
            validate_profile(&ir, p)?;
        }
        let artifact = serialize_artifact(&ir, plan, profile.as_ref());
        let fp = fingerprint_of(&artifact);
        let fingerprint = fp.iter().map(|b| format!("{b:02x}")).collect();
        let bases = array_ordinal_bases(&ir);
        Ok(Codec { ir, plan, limits, pack, profile, bases, artifact, fp, fingerprint })
    }

    fn ordinal_base(&self, node: &Node) -> usize {
        let key = node as *const Node;
        self.bases.iter().find(|(p, _)| *p == key).map(|(_, n)| *n).unwrap_or(0)
    }

    fn dict_of(&self, ordinal: usize) -> Option<&[String]> {
        self.profile
            .as_ref()
            .and_then(|p| p.columns.iter().find(|c| c.leaf == ordinal))
            .map(|c| c.dict.as_slice())
    }

    pub fn encode_body(&self, value: &Value) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.enc(&mut out, &self.ir, value, "$", 0)?;
        Ok(out)
    }

    pub fn decode_body(&self, data: &[u8]) -> Result<Value> {
        let mut r = Reader::new(data, self.limits);
        let value = self.dec(&mut r, &self.ir, "$", 0)?;
        r.expect_end()?;
        Ok(value)
    }

    pub fn encode(&self, value: &Value) -> Result<Vec<u8>> {
        let body = self.encode_body(value)?;
        let mut out = Vec::with_capacity(HEADER_SIZE + body.len());
        out.extend_from_slice(&MAGIC);
        out.push(WIRE_VERSION);
        out.extend_from_slice(&self.fp);
        out.extend_from_slice(&body);
        Ok(out)
    }

    pub fn decode(&self, data: &[u8]) -> Result<Value> {
        if data.len() < HEADER_SIZE {
            return err(ErrorCode::Header, "shorter than envelope header");
        }
        if data[0..2] != MAGIC {
            return err(ErrorCode::Header, "bad magic");
        }
        if data[2] != WIRE_VERSION {
            return err(ErrorCode::Header, format!("unsupported wire major {}", data[2]));
        }
        if data[3..HEADER_SIZE] != self.fp {
            return err(ErrorCode::Fingerprint, "codec fingerprint does not match payload");
        }
        self.decode_body(&data[HEADER_SIZE..])
    }

    fn enc(&self, out: &mut Vec<u8>, node: &Node, value: &Value, path: &str, depth: u32) -> Result<()> {
        if depth > self.limits.max_depth {
            return err(ErrorCode::Depth, format!("{path}: nesting deeper than {}", self.limits.max_depth));
        }
        match node {
            Node::Bool => match value {
                Value::Bool(b) => {
                    out.push(*b as u8);
                    Ok(())
                }
                _ => err(ErrorCode::Type, format!("{path}: expected boolean")),
            },
            Node::Int { min, max } => {
                let v = check_int(*min, *max, value, path)?;
                write_uleb(out, int_form(*min, v))
            }
            Node::Float64 => {
                let f = canon_float(value, path)?;
                out.extend_from_slice(&f.to_bits().to_le_bytes());
                Ok(())
            }
            Node::Str => match value {
                Value::Str(s) => {
                    if s.len() as u64 > self.limits.max_byte_length {
                        return err(ErrorCode::Limit, format!("{path}: string exceeds the codec limit"));
                    }
                    write_uleb(out, s.len() as u64)?;
                    out.extend_from_slice(s.as_bytes());
                    Ok(())
                }
                _ => err(ErrorCode::Type, format!("{path}: expected string")),
            },
            Node::Bytes => match value {
                Value::Bytes(b) => {
                    if b.len() as u64 > self.limits.max_byte_length {
                        return err(ErrorCode::Limit, format!("{path}: bytes exceed the codec limit"));
                    }
                    write_uleb(out, b.len() as u64)?;
                    out.extend_from_slice(b);
                    Ok(())
                }
                _ => err(ErrorCode::Type, format!("{path}: expected bytes")),
            },
            Node::Literal(lit) => {
                let matches = match (lit, value) {
                    (Literal::Null, Value::Null) => true,
                    (Literal::Bool(a), Value::Bool(b)) => a == b,
                    (Literal::Int(a), Value::Int(b)) => a == b,
                    (Literal::Str(a), Value::Str(b)) => a == b,
                    _ => false,
                };
                if matches {
                    Ok(())
                } else {
                    err(ErrorCode::Type, format!("{path}: literal mismatch"))
                }
            }
            Node::Enum(members) => match value {
                Value::Str(s) => match members.iter().position(|m| m == s) {
                    Some(i) => write_uleb(out, i as u64),
                    None => err(ErrorCode::Type, format!("{path}: not an enum member")),
                },
                _ => err(ErrorCode::Type, format!("{path}: expected enum member string")),
            },
            Node::Nullable(inner) => {
                if matches!(value, Value::Null) {
                    out.push(0);
                    Ok(())
                } else {
                    out.push(1);
                    self.enc(out, inner, value, path, depth + 1)
                }
            }
            Node::Array { element, length } => {
                if self.plan == Plan::Columnar {
                    if let Some(leaves) = columnar_leaves(element) {
                        return self.enc_columnar(out, node, &leaves, *length, value, path, depth);
                    }
                }
                let Value::Array(items) = value else {
                    return err(ErrorCode::Type, format!("{path}: expected array"));
                };
                if items.len() as u64 > self.limits.max_items {
                    return err(ErrorCode::Limit, format!("{path}: array exceeds the codec limit"));
                }
                match length {
                    Some(n) => {
                        if items.len() as u64 != *n {
                            return err(ErrorCode::Type, format!("{path}: fixed array expects {n} items"));
                        }
                    }
                    None => write_uleb(out, items.len() as u64)?,
                }
                for (i, item) in items.iter().enumerate() {
                    self.enc(out, element, item, &format!("{path}[{i}]"), depth + 1)?;
                }
                Ok(())
            }
            Node::Struct(fields) => {
                let Value::Object(_) = value else {
                    return err(ErrorCode::Type, format!("{path}: expected object"));
                };
                let mut presence = Vec::new();
                let mut nulls = Vec::new();
                for f in fields {
                    let v = value.get(&f.name);
                    let absent = v.is_none();
                    let is_null = matches!(v, Some(Value::Null));
                    if absent && !f.optional {
                        return err(ErrorCode::Required, format!("{path}.{}: required field missing", f.name));
                    }
                    if is_null && !f.nullable && !type_accepts_null(&f.ty) {
                        return err(ErrorCode::Type, format!("{path}.{}: null for non-nullable field", f.name));
                    }
                    if f.optional {
                        presence.push(!absent);
                    }
                    if f.nullable {
                        nulls.push(!absent && is_null);
                    }
                }
                write_bitmap(out, &presence);
                write_bitmap(out, &nulls);
                for f in fields {
                    match value.get(&f.name) {
                        None => {}
                        Some(Value::Null) if f.nullable => {}
                        Some(v) => self.enc(out, &f.ty, v, &format!("{path}.{}", f.name), depth + 1)?,
                    }
                }
                Ok(())
            }
        }
    }

    fn enc_columnar(
        &self,
        out: &mut Vec<u8>,
        node_for_ordinal: &Node,
        leaves: &[LeafCol],
        length: Option<u64>,
        value: &Value,
        path: &str,
        depth: u32,
    ) -> Result<()> {
        let Value::Array(rows) = value else {
            return err(ErrorCode::Type, format!("{path}: expected array"));
        };
        match length {
            Some(n) => {
                if rows.len() as u64 != n {
                    return err(ErrorCode::Type, format!("{path}: fixed array expects {n} items"));
                }
            }
            None => write_uleb(out, rows.len() as u64)?,
        }
        for (i, row) in rows.iter().enumerate() {
            if !matches!(row, Value::Object(_)) {
                return err(ErrorCode::Type, format!("{path}[{i}]: expected object"));
            }
        }

        let ordinal_base = self.ordinal_base(node_for_ordinal);
        for (leaf_index, leaf) in leaves.iter().enumerate() {
            let f = leaf.field;
            let dotted = leaf.segs.join(".");
            let field_path = format!("{path}[].{dotted}");
            let mut values: Vec<Option<&Value>> = Vec::with_capacity(rows.len());
            for (i, row) in rows.iter().enumerate() {
                let mut holder = row;
                for seg in &leaf.segs[..leaf.segs.len() - 1] {
                    holder = match holder.get(seg) {
                        Some(v @ Value::Object(_)) => v,
                        Some(_) => return err(ErrorCode::Type, format!("{path}[{i}].{seg}: expected object")),
                        None => return err(ErrorCode::Required, format!("{path}[{i}].{seg}: expected object")),
                    };
                }
                values.push(holder.get(leaf.segs[leaf.segs.len() - 1]));
            }

            let mut presence = Vec::new();
            let mut nulls = Vec::new();
            for (i, v) in values.iter().enumerate() {
                let absent = v.is_none();
                let is_null = matches!(v, Some(Value::Null));
                if absent && !f.optional {
                    return err(ErrorCode::Required, format!("{path}[{i}].{dotted}: required field missing"));
                }
                if is_null && !f.nullable && !type_accepts_null(&f.ty) {
                    return err(ErrorCode::Type, format!("{path}[{i}].{dotted}: null for non-nullable field"));
                }
                if f.optional {
                    presence.push(!absent);
                }
                if f.nullable {
                    nulls.push(!absent && is_null);
                }
            }
            write_bitmap(out, &presence);
            write_bitmap(out, &nulls);

            let participating: Vec<&Value> = values
                .iter()
                .filter(|v| match v {
                    None => false,
                    Some(Value::Null) if f.nullable => false,
                    Some(_) => true,
                })
                .map(|v| v.unwrap())
                .collect();

            if !rows.is_empty() && depth + leaf.segs.len() as u32 > self.limits.max_depth {
                return err(ErrorCode::Depth, format!("{path}[].{dotted}: nesting deeper than {}", self.limits.max_depth));
            }
            if !participating.is_empty() && depth + 1 + leaf.segs.len() as u32 > self.limits.max_depth {
                return err(ErrorCode::Depth, format!("{path}[].{dotted}: nesting deeper than {}", self.limits.max_depth));
            }

            match &f.ty {
                Node::Int { min, max } => {
                    let mut ints = Vec::with_capacity(participating.len());
                    for (i, v) in participating.iter().enumerate() {
                        ints.push(check_int(*min, *max, v, &format!("{field_path}[{i}]"))?);
                    }
                    enc_int_column(out, *min, &ints)?;
                }
                Node::Float64 => {
                    let mut floats = Vec::with_capacity(participating.len());
                    for (i, v) in participating.iter().enumerate() {
                        floats.push(canon_float(v, &format!("{field_path}[{i}]"))?);
                    }
                    enc_float_column(out, &floats)?;
                }
                Node::Bool => {
                    let mut bits = Vec::with_capacity(participating.len());
                    for (i, v) in participating.iter().enumerate() {
                        match v {
                            Value::Bool(b) => bits.push(*b),
                            _ => return err(ErrorCode::Type, format!("{field_path}[{i}]: expected boolean")),
                        }
                    }
                    write_bitmap(out, &bits);
                }
                Node::Str => {
                    let mut strings = Vec::with_capacity(participating.len());
                    for (i, v) in participating.iter().enumerate() {
                        match v {
                            Value::Str(s) => strings.push(s.as_str()),
                            _ => return err(ErrorCode::Type, format!("{field_path}[{i}]: expected string")),
                        }
                    }
                    enc_string_column(out, &strings, self.pack, self.dict_of(ordinal_base + leaf_index))?;
                }
                t => {
                    for (i, v) in participating.iter().enumerate() {
                        self.enc(out, t, v, &format!("{field_path}[{i}]"), depth + 2)?;
                    }
                }
            }
        }
        Ok(())
    }

    fn dec(&self, r: &mut Reader, node: &Node, path: &str, depth: u32) -> Result<Value> {
        if depth > self.limits.max_depth {
            return err(ErrorCode::Depth, format!("{path}: nesting deeper than {}", self.limits.max_depth));
        }
        match node {
            Node::Bool => {
                let b = r.u8()?;
                if b > 1 {
                    return err(ErrorCode::Marker, format!("{path}: invalid bool byte {b:#x}"));
                }
                Ok(Value::Bool(b == 1))
            }
            Node::Int { min, max } => {
                let raw = read_uleb(r)?;
                let value = match min {
                    Some(lo) => match (raw as i128 + *lo as i128).try_into() {
                        Ok(v) => v,
                        Err(_) => i64::MAX,
                    },
                    None => unzigzag(raw),
                };
                Ok(Value::Int(decoded_int(*min, *max, value, path)?))
            }
            Node::Float64 => {
                let bits = u64::from_le_bytes(r.take(8)?.try_into().unwrap());
                dec_float_bits(bits, path).map(Value::Float)
            }
            Node::Str => {
                let n = read_uleb(r)?;
                if n > self.limits.max_byte_length {
                    return err(ErrorCode::Limit, format!("{path}: string length exceeds limit"));
                }
                let data = r.take(n as usize)?;
                match std::str::from_utf8(data) {
                    Ok(s) => Ok(Value::Str(s.to_owned())),
                    Err(_) => err(ErrorCode::Utf8, format!("{path}: invalid UTF-8")),
                }
            }
            Node::Bytes => {
                let n = read_uleb(r)?;
                if n > self.limits.max_byte_length {
                    return err(ErrorCode::Limit, format!("{path}: bytes length exceeds limit"));
                }
                Ok(Value::Bytes(r.take(n as usize)?.to_vec()))
            }
            Node::Literal(lit) => Ok(match lit {
                Literal::Null => Value::Null,
                Literal::Bool(b) => Value::Bool(*b),
                Literal::Int(i) => Value::Int(*i),
                Literal::Str(s) => Value::Str(s.clone()),
            }),
            Node::Enum(members) => {
                let index = read_uleb(r)?;
                if index >= members.len() as u64 {
                    return err(ErrorCode::Range, format!("{path}: enum index {index} out of range"));
                }
                Ok(Value::Str(members[index as usize].clone()))
            }
            Node::Nullable(inner) => match r.u8()? {
                0 => Ok(Value::Null),
                1 => self.dec(r, inner, path, depth + 1),
                m => err(ErrorCode::Marker, format!("{path}: invalid nullable marker {m:#x}")),
            },
            Node::Array { element, length } => {
                if self.plan == Plan::Columnar {
                    if let Some(leaves) = columnar_leaves(element) {
                        return self.dec_columnar(r, node, &leaves, *length, path, depth);
                    }
                }
                let count = self.read_count(r, *length, path)?;
                self.bound_by_input(r, count, element, path)?;
                let mut out = Vec::with_capacity(count.min(4096));
                for i in 0..count {
                    out.push(self.dec(r, element, &format!("{path}[{i}]"), depth + 1)?);
                }
                Ok(Value::Array(out))
            }
            Node::Struct(fields) => {
                let optional = fields.iter().filter(|f| f.optional).count();
                let nullable = fields.iter().filter(|f| f.nullable).count();
                let presence = read_bitmap(r, optional, path)?;
                let nulls = read_bitmap(r, nullable, path)?;
                let mut pi = 0;
                let mut ni = 0;
                let mut out = Vec::new();
                for f in fields {
                    let present = if f.optional {
                        pi += 1;
                        presence[pi - 1]
                    } else {
                        true
                    };
                    let is_null = if f.nullable {
                        ni += 1;
                        nulls[ni - 1]
                    } else {
                        false
                    };
                    if !present {
                        if is_null {
                            return err(ErrorCode::Bitmap, format!("{path}.{}: null bit set for absent field", f.name));
                        }
                        continue;
                    }
                    if is_null {
                        out.push((f.name.clone(), Value::Null));
                        continue;
                    }
                    out.push((f.name.clone(), self.dec(r, &f.ty, &format!("{path}.{}", f.name), depth + 1)?));
                }
                Ok(Value::Object(out))
            }
        }
    }

    /// A declared count must be payable by the bytes still on the wire: any element that
    /// carries payload costs at least one bit, so truncation cannot force a huge allocation.
    fn bound_by_input(&self, r: &Reader, count: usize, element: &Node, path: &str) -> Result<()> {
        if count == 0 || !has_payload(element) {
            return Ok(());
        }
        let affordable = r.remaining().saturating_mul(8);
        if count > affordable {
            return err(
                ErrorCode::Limit,
                format!("{path}: declared {count} items but only {} byte(s) remain", r.remaining()),
            );
        }
        Ok(())
    }

    fn read_count(&self, r: &mut Reader, length: Option<u64>, path: &str) -> Result<usize> {
        let n = match length {
            Some(n) => n,
            None => read_uleb(r)?,
        };
        if n > self.limits.max_items {
            return err(ErrorCode::Limit, format!("{path}: array count {n} exceeds limit"));
        }
        Ok(n as usize)
    }

    fn dec_columnar(
        &self,
        r: &mut Reader,
        node_for_ordinal: &Node,
        leaves: &[LeafCol],
        length: Option<u64>,
        path: &str,
        depth: u32,
    ) -> Result<Value> {
        let count = self.read_count(r, length, path)?;
        // the flattened leaves are the element's payload: any flag or non-literal leaf costs bits
        let element_has_payload = leaves
            .iter()
            .any(|l| l.field.optional || l.field.nullable || !matches!(l.field.ty, Node::Literal(_)));
        if count > 0 && element_has_payload && count > r.remaining().saturating_mul(8) {
            return err(
                ErrorCode::Limit,
                format!("{path}: declared {count} items but only {} byte(s) remain", r.remaining()),
            );
        }
        let mut rows: Vec<Vec<(String, Value)>> = (0..count).map(|_| Vec::new()).collect();

        fn ensure_path(entries: &mut Vec<(String, Value)>, segs: &[&str]) {
            if segs.is_empty() {
                return;
            }
            let key = segs[0];
            let pos = match entries.iter().position(|(k, _)| k == key) {
                Some(i) => i,
                None => {
                    entries.push((key.to_owned(), Value::Object(Vec::new())));
                    entries.len() - 1
                }
            };
            if let Value::Object(inner) = &mut entries[pos].1 {
                ensure_path(inner, &segs[1..]);
            }
        }

        fn set_path(row: &mut Vec<(String, Value)>, segs: &[&str], value: Value) {
            if segs.len() == 1 {
                row.push((segs[0].to_owned(), value));
                return;
            }
            let key = segs[0];
            let holder = match row.iter().position(|(k, _)| k == key) {
                Some(i) => &mut row[i].1,
                None => {
                    row.push((key.to_owned(), Value::Object(Vec::new())));
                    let last = row.len() - 1;
                    &mut row[last].1
                }
            };
            if let Value::Object(entries) = holder {
                let mut inner = std::mem::take(entries);
                set_path_entries(&mut inner, &segs[1..], value);
                *entries = inner;
            }
        }

        fn set_path_entries(entries: &mut Vec<(String, Value)>, segs: &[&str], value: Value) {
            if segs.len() == 1 {
                entries.push((segs[0].to_owned(), value));
                return;
            }
            let key = segs[0];
            let pos = match entries.iter().position(|(k, _)| k == key) {
                Some(i) => i,
                None => {
                    entries.push((key.to_owned(), Value::Object(Vec::new())));
                    entries.len() - 1
                }
            };
            if let Value::Object(inner) = &mut entries[pos].1 {
                let mut taken = std::mem::take(inner);
                set_path_entries(&mut taken, &segs[1..], value);
                *inner = taken;
            }
        }

        let ordinal_base = self.ordinal_base(node_for_ordinal);
        for (leaf_index, leaf) in leaves.iter().enumerate() {
            let f = leaf.field;
            let field_path = format!("{path}[].{}", leaf.segs.join("."));
            // nested structs are required and non-nullable: materialize the container chain at
            // this leaf's declared position for every row (order-preserving, empty-safe)
            if leaf.segs.len() > 1 {
                for row in rows.iter_mut() {
                    ensure_path(row, &leaf.segs[..leaf.segs.len() - 1]);
                }
            }
            let presence = if f.optional { Some(read_bitmap(r, count, &field_path)?) } else { None };
            let nulls = if f.nullable { Some(read_bitmap(r, count, &field_path)?) } else { None };

            let mut slots = Vec::new();
            for i in 0..count {
                let present = presence.as_ref().map_or(true, |p| p[i]);
                let is_null = nulls.as_ref().map_or(false, |n| n[i]);
                if !present {
                    if is_null {
                        return err(ErrorCode::Bitmap, format!("{path}[{i}]: null bit set for absent field"));
                    }
                    continue;
                }
                if is_null {
                    set_path(&mut rows[i], &leaf.segs, Value::Null);
                    continue;
                }
                slots.push(i);
            }

            if count > 0 && depth + leaf.segs.len() as u32 > self.limits.max_depth {
                return err(ErrorCode::Depth, format!("{field_path}: nesting deeper than {}", self.limits.max_depth));
            }
            if !slots.is_empty() && depth + 1 + leaf.segs.len() as u32 > self.limits.max_depth {
                return err(ErrorCode::Depth, format!("{field_path}: nesting deeper than {}", self.limits.max_depth));
            }

            let values: Vec<Value> = match &f.ty {
                Node::Int { min, max } => dec_int_column(r, *min, *max, slots.len(), &field_path)?
                    .into_iter()
                    .map(Value::Int)
                    .collect(),
                Node::Float64 => dec_float_column(r, slots.len(), &field_path)?
                    .into_iter()
                    .map(Value::Float)
                    .collect(),
                Node::Bool => read_bitmap(r, slots.len(), &field_path)?.into_iter().map(Value::Bool).collect(),
                Node::Str => dec_string_column(
                    r,
                    slots.len(),
                    &field_path,
                    &self.limits,
                    self.pack,
                    self.dict_of(ordinal_base + leaf_index),
                )?
                    .into_iter()
                    .map(Value::Str)
                    .collect(),
                t => {
                    let mut out = Vec::with_capacity(slots.len());
                    for row in &slots {
                        out.push(self.dec(r, t, &format!("{path}[{row}]"), depth + 2)?);
                    }
                    out
                }
            };
            for (j, row_index) in slots.iter().enumerate() {
                set_path(&mut rows[*row_index], &leaf.segs, values[j].clone());
            }
        }

        Ok(Value::Array(rows.into_iter().map(Value::Object).collect()))
    }
}

fn enc_int_column(out: &mut Vec<u8>, min: Option<i64>, values: &[i64]) -> Result<()> {
    if values.is_empty() {
        out.push(0);
        return Ok(());
    }
    let forms: Vec<u64> = values.iter().map(|v| int_form(min, *v)).collect();
    let diffs: Vec<u64> = values.windows(2).map(|w| zigzag(w[1] - w[0])).collect();
    let raw_cost: usize = forms.iter().map(|f| uleb_len(*f)).sum();
    let delta_cost: usize = uleb_len(forms[0]) + diffs.iter().map(|d| uleb_len(*d)).sum::<usize>();
    if delta_cost < raw_cost {
        out.push(1);
        write_uleb(out, forms[0])?;
        for d in diffs {
            write_uleb(out, d)?;
        }
    } else {
        out.push(0);
        for f in forms {
            write_uleb(out, f)?;
        }
    }
    Ok(())
}

fn dec_int_column(r: &mut Reader, min: Option<i64>, max: Option<i64>, count: usize, path: &str) -> Result<Vec<i64>> {
    let mode = r.u8()?;
    if mode > 1 {
        return err(ErrorCode::Marker, format!("{path}: invalid int column mode {mode:#x}"));
    }
    if count == 0 {
        if mode != 0 {
            return err(ErrorCode::Marker, format!("{path}: empty column must use mode 0x00"));
        }
        return Ok(Vec::new());
    }
    let from_form = |raw: u64| -> i64 {
        match min {
            Some(lo) => (raw as i128 + lo as i128).clamp(i64::MIN as i128, i64::MAX as i128) as i64,
            None => unzigzag(raw),
        }
    };
    let mut out = Vec::with_capacity(count);
    if mode == 0 {
        for i in 0..count {
            out.push(decoded_int(min, max, from_form(read_uleb(r)?), &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }
    let mut prev = from_form(read_uleb(r)?) as i128;
    out.push(decoded_int(min, max, prev.clamp(i64::MIN as i128, i64::MAX as i128) as i64, &format!("{path}[0]"))?);
    for i in 1..count {
        prev += unzigzag(read_uleb(r)?) as i128;
        let clamped = prev.clamp(i64::MIN as i128, i64::MAX as i128) as i64;
        out.push(decoded_int(min, max, clamped, &format!("{path}[{i}]"))?);
    }
    Ok(out)
}

fn dec_float_bits(bits: u64, path: &str) -> Result<f64> {
    if bits == NEG_ZERO_BITS {
        return err(ErrorCode::Float, format!("{path}: negative-zero bit pattern"));
    }
    let value = f64::from_bits(bits);
    if !value.is_finite() {
        return err(ErrorCode::Float, format!("{path}: non-finite float64"));
    }
    Ok(value)
}

fn enc_float_column(out: &mut Vec<u8>, values: &[f64]) -> Result<()> {
    if values.is_empty() {
        out.push(0);
        return Ok(());
    }
    let bits: Vec<u64> = values.iter().map(|v| v.to_bits()).collect();
    let xors: Vec<u64> = bits.windows(2).map(|w| w[0] ^ w[1]).collect();
    let xor_cost: usize = 8 + xors.iter().map(|x| 1 + sig_bytes(*x)).sum::<usize>();
    let raw_cost = 8 * bits.len();

    let scale = decimal_scale(values);
    let (mut sd_cost, mut sr_cost) = (usize::MAX, usize::MAX);
    let mut mantissas: Vec<i64> = Vec::new();
    if let Some(s) = scale {
        let pow = POW10[s as usize];
        mantissas = values.iter().map(|v| decimal_mantissa(*v, pow) as i64).collect();
        sr_cost = 1 + mantissas.iter().map(|m| uleb_len(zigzag(*m))).sum::<usize>();
        sd_cost = 1
            + uleb_len(zigzag(mantissas[0]))
            + mantissas.windows(2).map(|w| uleb_len(zigzag(w[1] - w[0]))).sum::<usize>();
    }

    let best = raw_cost.min(xor_cost).min(sd_cost).min(sr_cost);
    if best == raw_cost {
        out.push(0);
        for b in bits {
            out.extend_from_slice(&b.to_le_bytes());
        }
    } else if best == xor_cost {
        out.push(1);
        out.extend_from_slice(&bits[0].to_le_bytes());
        for x in xors {
            let n = sig_bytes(x);
            out.push(n as u8);
            out.extend_from_slice(&x.to_le_bytes()[..n]);
        }
    } else if best == sd_cost {
        out.push(2);
        out.push(scale.unwrap());
        write_uleb(out, zigzag(mantissas[0]))?;
        for w in mantissas.windows(2) {
            write_uleb(out, zigzag(w[1] - w[0]))?;
        }
    } else {
        out.push(3);
        out.push(scale.unwrap());
        for m in &mantissas {
            write_uleb(out, zigzag(*m))?;
        }
    }
    Ok(())
}

fn dec_float_column(r: &mut Reader, count: usize, path: &str) -> Result<Vec<f64>> {
    let mode = r.u8()?;
    if mode > 3 {
        return err(ErrorCode::Marker, format!("{path}: invalid float column mode {mode:#x}"));
    }
    if count == 0 {
        if mode != 0 {
            return err(ErrorCode::Marker, format!("{path}: empty column must use mode 0x00"));
        }
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(count);

    if mode >= 2 {
        let scale = r.u8()?;
        if scale > MAX_SCALE {
            return err(ErrorCode::Marker, format!("{path}: decimal scale {scale} exceeds {MAX_SCALE}"));
        }
        let pow = POW10[scale as usize];
        let mantissa = |m: i128, i: usize| -> Result<f64> {
            if m < INT_MIN as i128 || m > INT_MAX as i128 {
                return err(ErrorCode::Range, format!("{path}[{i}]: decimal mantissa outside the v0 domain"));
            }
            Ok(m as f64 / pow)
        };
        if mode == 3 {
            for i in 0..count {
                out.push(mantissa(unzigzag(read_uleb(r)?) as i128, i)?);
            }
            return Ok(out);
        }
        let mut prev = unzigzag(read_uleb(r)?) as i128;
        out.push(mantissa(prev, 0)?);
        for i in 1..count {
            prev += unzigzag(read_uleb(r)?) as i128;
            out.push(mantissa(prev, i)?);
        }
        return Ok(out);
    }

    if mode == 0 {
        for i in 0..count {
            let bits = u64::from_le_bytes(r.take(8)?.try_into().unwrap());
            out.push(dec_float_bits(bits, &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }
    let mut prev = u64::from_le_bytes(r.take(8)?.try_into().unwrap());
    out.push(dec_float_bits(prev, &format!("{path}[0]"))?);
    for i in 1..count {
        let n = r.u8()? as usize;
        if n > 8 {
            return err(ErrorCode::Marker, format!("{path}[{i}]: xor length {n} exceeds 8"));
        }
        let mut le = [0u8; 8];
        le[..n].copy_from_slice(r.take(n)?);
        let x = u64::from_le_bytes(le);
        if n > 0 && x >> (8 * (n - 1)) == 0 {
            return err(ErrorCode::Float, format!("{path}[{i}]: non-minimal xor encoding"));
        }
        prev ^= x;
        out.push(dec_float_bits(prev, &format!("{path}[{i}]"))?);
    }
    Ok(out)
}

fn enc_string_column(out: &mut Vec<u8>, values: &[&str], pack: bool, dict: Option<&[String]>) -> Result<()> {
    if values.is_empty() {
        out.push(0);
        return Ok(());
    }
    let plain_cost: usize = values.iter().map(|s| uleb_len(s.len() as u64) + s.len()).sum();

    let mut codes: Option<Vec<u64>> = None;
    let mut dict_cost = usize::MAX;
    if let Some(entries) = dict {
        let assigned: Vec<u64> = values
            .iter()
            .map(|v| entries.iter().position(|e| e == v).map(|i| i as u64 + 1).unwrap_or(0))
            .collect();
        dict_cost = assigned
            .iter()
            .zip(values.iter())
            .map(|(c, v)| uleb_len(*c) + if *c == 0 { uleb_len(v.len() as u64) + v.len() } else { 0 })
            .sum();
        codes = Some(assigned);
    }

    let mut packed_cost = usize::MAX;
    let mut packed_blob: Option<Vec<u8>> = None;
    if pack {
        let concat: Vec<u8> = values.iter().flat_map(|s| s.as_bytes().iter().copied()).collect();
        let packed = miniz_oxide::deflate::compress_to_vec(&concat, 6);
        packed_cost = values.iter().map(|s| uleb_len(s.len() as u64)).sum::<usize>()
            + uleb_len(packed.len() as u64)
            + packed.len();
        packed_blob = Some(packed);
    }

    let best = plain_cost.min(dict_cost).min(packed_cost);
    if best == plain_cost {
        out.push(0x00);
        for s in values {
            write_uleb(out, s.len() as u64)?;
            out.extend_from_slice(s.as_bytes());
        }
        return Ok(());
    }
    if best == dict_cost {
        let assigned = codes.expect("dict cost implies codes");
        out.push(0x01);
        for (c, v) in assigned.iter().zip(values.iter()) {
            write_uleb(out, *c)?;
            if *c == 0 {
                write_uleb(out, v.len() as u64)?;
                out.extend_from_slice(v.as_bytes());
            }
        }
        return Ok(());
    }
    let packed = packed_blob.expect("packed cost implies a blob");
    out.push(0x02);
    for s in values {
        write_uleb(out, s.len() as u64)?;
    }
    write_uleb(out, packed.len() as u64)?;
    out.extend_from_slice(&packed);
    Ok(())
}

/// Inflate a raw-DEFLATE blob, requiring it to consume the entire input and produce
/// exactly `expected` bytes — rejects truncation, over-long output, and trailing bytes.
fn inflate_exact(blob: &[u8], expected: usize) -> std::result::Result<Vec<u8>, ()> {
    use miniz_oxide::inflate::core::{decompress, inflate_flags, DecompressorOxide};
    use miniz_oxide::inflate::TINFLStatus;

    let mut out = vec![0u8; expected];
    let mut dec = DecompressorOxide::new();
    // raw deflate (no zlib header) into a single flat buffer, with the whole input present
    let flags = inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    let (status, in_consumed, out_written) = decompress(&mut dec, blob, &mut out, 0, flags);
    if status != TINFLStatus::Done || out_written != expected || in_consumed != blob.len() {
        return Err(());
    }
    Ok(out)
}

fn dec_string_column(
    r: &mut Reader,
    count: usize,
    path: &str,
    limits: &Limits,
    pack: bool,
    dict: Option<&[String]>,
) -> Result<Vec<String>> {
    let mode = r.u8()?;
    if mode > 2 {
        return err(ErrorCode::Marker, format!("{path}: invalid string column flags {mode:#x}"));
    }
    if count == 0 {
        if mode != 0 {
            return err(ErrorCode::Marker, format!("{path}: empty column must use mode 0x00"));
        }
        return Ok(Vec::new());
    }
    let decode_slice = |data: &[u8], i: usize| -> Result<String> {
        match std::str::from_utf8(data) {
            Ok(s) => Ok(s.to_owned()),
            Err(_) => err(ErrorCode::Utf8, format!("{path}[{i}]: invalid UTF-8")),
        }
    };
    let mut out = Vec::with_capacity(count);
    if mode == 0 {
        for i in 0..count {
            let n = read_uleb(r)?;
            if n > limits.max_byte_length {
                return err(ErrorCode::Limit, format!("{path}[{i}]: string length exceeds limit"));
            }
            out.push(decode_slice(r.take(n as usize)?, i)?);
        }
        return Ok(out);
    }
    if mode == 0x01 {
        let entries = match dict {
            Some(d) => d,
            None => {
                return err(ErrorCode::Unsupported, format!("{path}: dictionary column requires a profile for this leaf"))
            }
        };
        for i in 0..count {
            let code = read_uleb(r)?;
            if code == 0 {
                let n = read_uleb(r)?;
                if n > limits.max_byte_length {
                    return err(ErrorCode::Limit, format!("{path}[{i}]: string length exceeds limit"));
                }
                out.push(decode_slice(r.take(n as usize)?, i)?);
            } else {
                if code > entries.len() as u64 {
                    return err(ErrorCode::Range, format!("{path}[{i}]: dictionary code {code} out of range"));
                }
                out.push(entries[code as usize - 1].clone());
            }
        }
        return Ok(out);
    }

    let mut lengths = Vec::with_capacity(count);
    let mut total: u64 = 0;
    for i in 0..count {
        let n = read_uleb(r)?;
        if n > limits.max_byte_length {
            return err(ErrorCode::Limit, format!("{path}[{i}]: string length exceeds limit"));
        }
        lengths.push(n as usize);
        total += n;
        if total > limits.max_byte_length {
            return err(ErrorCode::Limit, format!("{path}: packed column total exceeds limit"));
        }
    }
    let blob_len = read_uleb(r)?;
    if blob_len > limits.max_byte_length {
        return err(ErrorCode::Limit, format!("{path}: packed blob exceeds limit"));
    }
    let blob = r.take(blob_len as usize)?;
    if !pack {
        return err(ErrorCode::Unsupported, format!("{path}: packed string column requires an inflate hook"));
    }
    let inflated = inflate_exact(blob, total as usize)
        .map_err(|_| Error { code: ErrorCode::Packed, message: format!("{path}: packed blob failed to inflate or has trailing bytes") })?;
    let mut offset = 0;
    for (i, n) in lengths.iter().enumerate() {
        out.push(decode_slice(&inflated[offset..offset + n], i)?);
        offset += n;
    }
    Ok(out)
}
