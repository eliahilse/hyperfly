use crate::ir::{
    column_count, fingerprint_of, has_payload, serialize_artifact, validate, validate_profile,
    Derivation, Field, GrammarCase, GrammarToken, Literal, Node, Plan, Profile,
};
use crate::value::Value;
use crate::wire::*;
use std::collections::HashMap;

pub const MAGIC: [u8; 2] = [0x68, 0x66];
pub const WIRE_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 19;

const NEG_ZERO_BITS: u64 = 0x8000_0000_0000_0000;
const POW10: [f64; 9] = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
const MAX_SCALE: u8 = 8;

const LEAF_OK: fn(&Node) -> bool = |n| {
    matches!(
        n,
        Node::Bool
            | Node::Int { .. }
            | Node::Float64
            | Node::Str
            | Node::Bytes
            | Node::Literal(_)
            | Node::Enum(_)
    )
};

struct LeafCol<'a> {
    segs: Vec<&'a str>,
    field: &'a Field,
}

struct ColumnInput<'a> {
    values: Vec<Option<&'a Value>>,
    present: Vec<bool>,
    is_null: Vec<bool>,
    slots: Vec<usize>,
    participating: Vec<&'a Value>,
}

struct DecodedLeaf {
    slots: Vec<usize>,
    values: Vec<Value>,
    null_rows: Vec<usize>,
}

fn input_source_value<'a>(
    inputs: &[ColumnInput<'a>],
    ordinal_base: usize,
    ordinal: usize,
    row: usize,
) -> Option<&'a Value> {
    let local = ordinal.checked_sub(ordinal_base)?;
    let input = inputs.get(local)?;
    input.slots.binary_search(&row).ok()?;
    input.values.get(row).copied().flatten()
}

fn decoded_source_value(
    decoded: &[DecodedLeaf],
    ordinal_base: usize,
    ordinal: usize,
    row: usize,
) -> Option<&Value> {
    let local = ordinal.checked_sub(ordinal_base)?;
    let entry = decoded.get(local)?;
    let participant = entry.slots.binary_search(&row).ok()?;
    entry.values.get(participant)
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
                out.push(LeafCol {
                    segs: path,
                    field: f,
                });
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
    let Node::Struct(fields) = element else {
        return None;
    };
    let mut out = Vec::new();
    let mut segs = Vec::new();
    if flatten(fields, &mut segs, &mut out) {
        Some(out)
    } else {
        None
    }
}

fn enum_width(member_count: usize) -> Result<u8> {
    let max_index = member_count.checked_sub(1).ok_or_else(|| Error {
        code: ErrorCode::Ir,
        message: "enum needs at least one member".into(),
    })?;
    let width = usize::BITS - max_index.leading_zeros();
    let width = u8::try_from(width).map_err(|_| Error {
        code: ErrorCode::Ir,
        message: "enum bit width does not fit the host width type".into(),
    })?;
    if width > MAX_WIDTH {
        return err(
            ErrorCode::Ir,
            format!("columnar enum bit width {width} exceeds {MAX_WIDTH}"),
        );
    }
    Ok(width)
}

fn validate_columnar_layout(node: &Node) -> Result<()> {
    match node {
        Node::Array { element, .. } => {
            if let Some(leaves) = columnar_leaves(element) {
                for leaf in leaves {
                    if let Node::Enum(members) = &leaf.field.ty {
                        enum_width(members.len())?;
                    }
                }
                return Ok(());
            }
            validate_columnar_layout(element)
        }
        Node::Nullable(inner) => validate_columnar_layout(inner),
        Node::Struct(fields) => {
            for field in fields {
                validate_columnar_layout(&field.ty)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn type_accepts_null(node: &Node) -> bool {
    matches!(node, Node::Nullable(_)) || matches!(node, Node::Literal(Literal::Null))
}

fn int_form(min: Option<i64>, value: i64) -> Result<u64> {
    match min {
        Some(lo) => u64::try_from(value as i128 - lo as i128).map_err(|_| Error {
            code: ErrorCode::Range,
            message: "integer offset is negative".into(),
        }),
        None => Ok(zigzag(value)),
    }
}

fn check_int(min: Option<i64>, max: Option<i64>, value: &Value, path: &str) -> Result<i64> {
    let Value::Int(v) = value else {
        return err(ErrorCode::Type, format!("{path}: expected a safe integer"));
    };
    let v = *v;
    if !(INT_MIN..=INT_MAX).contains(&v) {
        return err(
            ErrorCode::Type,
            format!("{path}: outside the v0 integer domain"),
        );
    }
    if let Some(lo) = min {
        if v < lo {
            return err(
                ErrorCode::Range,
                format!("{path}: {v} below declared min {lo}"),
            );
        }
    }
    if let Some(hi) = max {
        if v > hi {
            return err(
                ErrorCode::Range,
                format!("{path}: {v} above declared max {hi}"),
            );
        }
    }
    Ok(v)
}

fn decoded_int(min: Option<i64>, max: Option<i64>, value: i128, path: &str) -> Result<i64> {
    if value < INT_MIN as i128 || value > INT_MAX as i128 {
        return err(
            ErrorCode::Range,
            format!("{path}: decoded integer outside the v0 domain"),
        );
    }
    if let Some(lo) = min {
        if value < lo as i128 {
            return err(ErrorCode::Range, format!("{path}: below declared min"));
        }
    }
    if let Some(hi) = max {
        if value > hi as i128 {
            return err(ErrorCode::Range, format!("{path}: above declared max"));
        }
    }
    i64::try_from(value).map_err(|_| Error {
        code: ErrorCode::Range,
        message: format!("{path}: decoded integer outside the host integer domain"),
    })
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
    (64 - x.leading_zeros() as usize).div_ceil(8)
}

pub struct Codec {
    ir: Node,
    plan: Plan,
    limits: Limits,
    pack: bool,
    profile: Option<Profile>,
    dicts: HashMap<usize, Vec<String>>,
    codes: HashMap<usize, HashMap<String, u64>>,
    grammars: HashMap<usize, Vec<GrammarToken>>,
    derivations: HashMap<usize, Derivation>,
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
        if plan == Plan::Columnar {
            validate_columnar_layout(&ir)?;
        }
        if let Some(p) = &profile {
            if plan != Plan::Columnar {
                return err(ErrorCode::Ir, "profiles apply to the columnar plan only");
            }
            validate_profile(&ir, p)?;
        }
        let artifact = serialize_artifact(&ir, plan, profile.as_ref());
        let fp = fingerprint_of(&artifact);
        let fingerprint = fp.iter().map(|b| format!("{b:02x}")).collect();
        let mut dicts = HashMap::new();
        let mut codes = HashMap::new();
        let mut grammars = HashMap::new();
        let mut derivations = HashMap::new();
        if let Some(p) = &profile {
            for column in &p.columns {
                if let Some(dict) = &column.dict {
                    dicts.insert(column.leaf, dict.clone());
                    let mut lookup = HashMap::with_capacity(dict.len());
                    for (index, entry) in dict.iter().enumerate() {
                        let code = u64::try_from(index)
                            .ok()
                            .and_then(|value| value.checked_add(1))
                            .ok_or_else(|| Error {
                                code: ErrorCode::Ir,
                                message: format!(
                                    "profile: leaf {} dictionary index exceeds the wire code domain",
                                    column.leaf
                                ),
                            })?;
                        lookup.insert(entry.clone(), code);
                    }
                    codes.insert(column.leaf, lookup);
                }
                if let Some(grammar) = &column.grammar {
                    grammars.insert(column.leaf, grammar.clone());
                }
                if let Some(derived) = &column.derived {
                    derivations.insert(column.leaf, derived.clone());
                }
            }
        }
        Ok(Codec {
            ir,
            plan,
            limits,
            pack,
            profile,
            dicts,
            codes,
            grammars,
            derivations,
            artifact,
            fp,
            fingerprint,
        })
    }

    pub fn profile(&self) -> Option<&Profile> {
        self.profile.as_ref()
    }

    fn dict_of(&self, ordinal: usize) -> Option<&[String]> {
        self.dicts.get(&ordinal).map(|d| d.as_slice())
    }

    fn codes_of(&self, ordinal: usize) -> Option<&HashMap<String, u64>> {
        self.codes.get(&ordinal)
    }

    fn grammar_of(&self, ordinal: usize) -> Option<&[GrammarToken]> {
        self.grammars.get(&ordinal).map(Vec::as_slice)
    }

    fn derivation_of(&self, ordinal: usize) -> Option<&Derivation> {
        self.derivations.get(&ordinal)
    }

    pub fn encode_body(&self, value: &Value) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.enc(&mut out, &self.ir, value, "$", 0, 0)?;
        Ok(out)
    }

    pub fn decode_body(&self, data: &[u8]) -> Result<Value> {
        let mut r = Reader::new(data, self.limits);
        let value = self.dec(&mut r, &self.ir, "$", 0, 0)?;
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
            return err(
                ErrorCode::Header,
                format!("unsupported wire major {}", data[2]),
            );
        }
        if data[3..HEADER_SIZE] != self.fp {
            return err(
                ErrorCode::Fingerprint,
                "codec fingerprint does not match payload",
            );
        }
        self.decode_body(&data[HEADER_SIZE..])
    }

    fn enc(
        &self,
        out: &mut Vec<u8>,
        node: &Node,
        value: &Value,
        path: &str,
        depth: u32,
        column: usize,
    ) -> Result<()> {
        if depth > self.limits.max_depth {
            return err(
                ErrorCode::Depth,
                format!("{path}: nesting deeper than {}", self.limits.max_depth),
            );
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
                write_uleb(out, int_form(*min, v)?)
            }
            Node::Float64 => {
                let f = canon_float(value, path)?;
                out.extend_from_slice(&f.to_bits().to_le_bytes());
                Ok(())
            }
            Node::Str => match value {
                Value::Str(s) => {
                    let len = u64::try_from(s.len()).map_err(|_| Error {
                        code: ErrorCode::Limit,
                        message: format!("{path}: string length exceeds the wire size domain"),
                    })?;
                    if len > self.limits.max_byte_length {
                        return err(
                            ErrorCode::Limit,
                            format!("{path}: string exceeds the codec limit"),
                        );
                    }
                    write_uleb(out, len)?;
                    out.extend_from_slice(s.as_bytes());
                    Ok(())
                }
                _ => err(ErrorCode::Type, format!("{path}: expected string")),
            },
            Node::Bytes => match value {
                Value::Bytes(b) => {
                    let len = u64::try_from(b.len()).map_err(|_| Error {
                        code: ErrorCode::Limit,
                        message: format!("{path}: bytes length exceeds the wire size domain"),
                    })?;
                    if len > self.limits.max_byte_length {
                        return err(
                            ErrorCode::Limit,
                            format!("{path}: bytes exceed the codec limit"),
                        );
                    }
                    write_uleb(out, len)?;
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
                    Some(i) => write_uleb(
                        out,
                        u64::try_from(i).map_err(|_| Error {
                            code: ErrorCode::Range,
                            message: format!("{path}: enum index exceeds the wire integer domain"),
                        })?,
                    ),
                    None => err(ErrorCode::Type, format!("{path}: not an enum member")),
                },
                _ => err(
                    ErrorCode::Type,
                    format!("{path}: expected enum member string"),
                ),
            },
            Node::Nullable(inner) => {
                if matches!(value, Value::Null) {
                    out.push(0);
                    Ok(())
                } else {
                    out.push(1);
                    self.enc(out, inner, value, path, depth.saturating_add(1), column)
                }
            }
            Node::Array { element, length } => {
                if self.plan == Plan::Columnar {
                    if let Some(leaves) = columnar_leaves(element) {
                        return self
                            .enc_columnar(out, column, &leaves, *length, value, path, depth);
                    }
                }
                let Value::Array(items) = value else {
                    return err(ErrorCode::Type, format!("{path}: expected array"));
                };
                let item_count = u64::try_from(items.len()).map_err(|_| Error {
                    code: ErrorCode::Limit,
                    message: format!("{path}: array length does not fit the wire count domain"),
                })?;
                if item_count > self.limits.max_items {
                    return err(
                        ErrorCode::Limit,
                        format!("{path}: array exceeds the codec limit"),
                    );
                }
                match length {
                    Some(n) => {
                        if item_count != *n {
                            return err(
                                ErrorCode::Type,
                                format!("{path}: fixed array expects {n} items"),
                            );
                        }
                    }
                    None => write_uleb(out, item_count)?,
                }
                let payload_start = out.len();
                for (i, item) in items.iter().enumerate() {
                    self.enc(
                        out,
                        element,
                        item,
                        &format!("{path}[{i}]"),
                        depth.saturating_add(1),
                        column,
                    )?;
                }
                let payload_bytes = out.len().checked_sub(payload_start).ok_or_else(|| Error {
                    code: ErrorCode::Limit,
                    message: format!("{path}: array payload size underflow"),
                })?;
                self.check_amplification(items.len(), payload_bytes, path)
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
                        return err(
                            ErrorCode::Required,
                            format!("{path}.{}: required field missing", f.name),
                        );
                    }
                    if is_null && !f.nullable && !type_accepts_null(&f.ty) {
                        return err(
                            ErrorCode::Type,
                            format!("{path}.{}: null for non-nullable field", f.name),
                        );
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
                let mut field_column = column;
                for f in fields {
                    let base = field_column;
                    field_column += column_count(&f.ty);
                    match value.get(&f.name) {
                        None => {}
                        Some(Value::Null) if f.nullable => {}
                        Some(v) => self.enc(
                            out,
                            &f.ty,
                            v,
                            &format!("{path}.{}", f.name),
                            depth.saturating_add(1),
                            base,
                        )?,
                    }
                }
                Ok(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn enc_columnar(
        &self,
        out: &mut Vec<u8>,
        ordinal_base: usize,
        leaves: &[LeafCol],
        length: Option<u64>,
        value: &Value,
        path: &str,
        depth: u32,
    ) -> Result<()> {
        let Value::Array(rows) = value else {
            return err(ErrorCode::Type, format!("{path}: expected array"));
        };
        let row_count = u64::try_from(rows.len()).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: array length does not fit the wire count domain"),
        })?;
        if row_count > self.limits.max_items {
            return err(
                ErrorCode::Limit,
                format!("{path}: array exceeds the codec limit"),
            );
        }
        match length {
            Some(n) => {
                if row_count != n {
                    return err(
                        ErrorCode::Type,
                        format!("{path}: fixed array expects {n} items"),
                    );
                }
            }
            None => write_uleb(out, row_count)?,
        }
        let payload_start = out.len();
        for (i, row) in rows.iter().enumerate() {
            if !matches!(row, Value::Object(_)) {
                return err(ErrorCode::Type, format!("{path}[{i}]: expected object"));
            }
        }

        let mut inputs = Vec::with_capacity(leaves.len());
        for leaf in leaves {
            let f = leaf.field;
            let dotted = leaf.segs.join(".");
            let mut values: Vec<Option<&Value>> = Vec::with_capacity(rows.len());
            for (i, row) in rows.iter().enumerate() {
                let mut holder = row;
                for (segment_index, seg) in leaf.segs[..leaf.segs.len() - 1].iter().enumerate() {
                    holder = match holder.get(seg) {
                        Some(v @ Value::Object(_)) => v,
                        Some(_) => {
                            return err(
                                ErrorCode::Type,
                                format!(
                                    "{path}[{i}].{}: expected object",
                                    leaf.segs[..=segment_index].join(".")
                                ),
                            )
                        }
                        None => {
                            return err(
                                ErrorCode::Required,
                                format!(
                                    "{path}[{i}].{}: expected object",
                                    leaf.segs[..=segment_index].join(".")
                                ),
                            )
                        }
                    };
                }
                values.push(holder.get(leaf.segs[leaf.segs.len() - 1]));
            }

            let mut present = Vec::with_capacity(rows.len());
            let mut is_null = Vec::with_capacity(rows.len());
            let mut slots = Vec::new();
            let mut participating = Vec::new();
            for (i, v) in values.iter().enumerate() {
                let absent = v.is_none();
                let null = matches!(v, Some(Value::Null));
                if absent && !f.optional {
                    return err(
                        ErrorCode::Required,
                        format!("{path}[{i}].{dotted}: required field missing"),
                    );
                }
                if null && !f.nullable && !type_accepts_null(&f.ty) {
                    return err(
                        ErrorCode::Type,
                        format!("{path}[{i}].{dotted}: null for non-nullable field"),
                    );
                }
                present.push(!absent);
                is_null.push(!absent && null);
                if absent || (null && f.nullable) {
                    continue;
                }
                if let Some(value) = *v {
                    slots.push(i);
                    participating.push(value);
                }
            }
            inputs.push(ColumnInput {
                values,
                present,
                is_null,
                slots,
                participating,
            });
        }

        for (leaf_index, leaf) in leaves.iter().enumerate() {
            let f = leaf.field;
            let dotted = leaf.segs.join(".");
            let field_path = format!("{path}[].{dotted}");
            let input = inputs.get(leaf_index).ok_or_else(|| Error {
                code: ErrorCode::Ir,
                message: format!("{field_path}: missing compiled column input"),
            })?;
            if f.optional {
                write_bitmap(out, &input.present);
            }
            if f.nullable {
                write_bitmap(out, &input.is_null);
            }

            let segment_depth = u32::try_from(leaf.segs.len()).map_err(|_| Error {
                code: ErrorCode::Depth,
                message: format!("{field_path}: field path exceeds the depth arithmetic domain"),
            })?;
            if !rows.is_empty() && depth.saturating_add(segment_depth) > self.limits.max_depth {
                return err(
                    ErrorCode::Depth,
                    format!(
                        "{path}[].{dotted}: nesting deeper than {}",
                        self.limits.max_depth
                    ),
                );
            }
            if !input.participating.is_empty()
                && depth.saturating_add(1).saturating_add(segment_depth) > self.limits.max_depth
            {
                return err(
                    ErrorCode::Depth,
                    format!(
                        "{path}[].{dotted}: nesting deeper than {}",
                        self.limits.max_depth
                    ),
                );
            }

            match &f.ty {
                Node::Int { min, max } => {
                    let mut ints = Vec::with_capacity(input.participating.len());
                    for (i, v) in input.participating.iter().enumerate() {
                        ints.push(check_int(*min, *max, v, &format!("{field_path}[{i}]"))?);
                    }
                    enc_int_column(out, *min, &ints)?;
                }
                Node::Float64 => {
                    let mut floats = Vec::with_capacity(input.participating.len());
                    for (i, v) in input.participating.iter().enumerate() {
                        floats.push(canon_float(v, &format!("{field_path}[{i}]"))?);
                    }
                    enc_float_column(out, &floats)?;
                }
                Node::Bool => {
                    let mut bits = Vec::with_capacity(input.participating.len());
                    for (i, v) in input.participating.iter().enumerate() {
                        match v {
                            Value::Bool(b) => bits.push(*b),
                            _ => {
                                return err(
                                    ErrorCode::Type,
                                    format!("{field_path}[{i}]: expected boolean"),
                                )
                            }
                        }
                    }
                    write_bitmap(out, &bits);
                }
                Node::Str => {
                    let mut strings = Vec::with_capacity(input.participating.len());
                    for (i, v) in input.participating.iter().enumerate() {
                        match v {
                            Value::Str(s) => strings.push(s.as_str()),
                            _ => {
                                return err(
                                    ErrorCode::Type,
                                    format!("{field_path}[{i}]: expected string"),
                                )
                            }
                        }
                    }
                    enc_string_column(
                        out,
                        &strings,
                        &input.slots,
                        &inputs,
                        ordinal_base,
                        &field_path,
                        &self.limits,
                        self.pack,
                        self.codes_of(ordinal_base + leaf_index),
                        self.grammar_of(ordinal_base + leaf_index),
                        self.derivation_of(ordinal_base + leaf_index),
                        &self.codes,
                    )?;
                }
                Node::Enum(members) => {
                    enc_enum_column(out, members, &input.participating, &field_path)?;
                }
                t => {
                    for (i, v) in input.participating.iter().enumerate() {
                        self.enc(
                            out,
                            t,
                            v,
                            &format!("{field_path}[{i}]"),
                            depth.saturating_add(2),
                            ordinal_base + leaf_index,
                        )?;
                    }
                }
            }
        }
        let payload_bytes = out.len().checked_sub(payload_start).ok_or_else(|| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: columnar payload size underflow"),
        })?;
        self.check_amplification(rows.len(), payload_bytes, path)
    }

    fn dec(
        &self,
        r: &mut Reader,
        node: &Node,
        path: &str,
        depth: u32,
        column: usize,
    ) -> Result<Value> {
        if depth > self.limits.max_depth {
            return err(
                ErrorCode::Depth,
                format!("{path}: nesting deeper than {}", self.limits.max_depth),
            );
        }
        match node {
            Node::Bool => {
                let b = r.u8()?;
                if b > 1 {
                    return err(
                        ErrorCode::Marker,
                        format!("{path}: invalid bool byte {b:#x}"),
                    );
                }
                Ok(Value::Bool(b == 1))
            }
            Node::Int { min, max } => {
                let raw = read_uleb(r)?;
                let value = match min {
                    Some(lo) => raw as i128 + *lo as i128,
                    None => unzigzag(raw) as i128,
                };
                Ok(Value::Int(decoded_int(*min, *max, value, path)?))
            }
            Node::Float64 => {
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(r.take(8)?);
                let bits = u64::from_le_bytes(bytes);
                dec_float_bits(bits, path).map(Value::Float)
            }
            Node::Str => {
                let n = read_uleb(r)?;
                if n > self.limits.max_byte_length {
                    return err(
                        ErrorCode::Limit,
                        format!("{path}: string length exceeds limit"),
                    );
                }
                let len = usize::try_from(n).map_err(|_| Error {
                    code: ErrorCode::Limit,
                    message: format!("{path}: string length exceeds the host size domain"),
                })?;
                let data = r.take(len)?;
                match std::str::from_utf8(data) {
                    Ok(s) => Ok(Value::Str(s.to_owned())),
                    Err(_) => err(ErrorCode::Utf8, format!("{path}: invalid UTF-8")),
                }
            }
            Node::Bytes => {
                let n = read_uleb(r)?;
                if n > self.limits.max_byte_length {
                    return err(
                        ErrorCode::Limit,
                        format!("{path}: bytes length exceeds limit"),
                    );
                }
                let len = usize::try_from(n).map_err(|_| Error {
                    code: ErrorCode::Limit,
                    message: format!("{path}: bytes length exceeds the host size domain"),
                })?;
                Ok(Value::Bytes(r.take(len)?.to_vec()))
            }
            Node::Literal(lit) => Ok(match lit {
                Literal::Null => Value::Null,
                Literal::Bool(b) => Value::Bool(*b),
                Literal::Int(i) => Value::Int(*i),
                Literal::Str(s) => Value::Str(s.clone()),
            }),
            Node::Enum(members) => {
                let index = read_uleb(r)?;
                let index = usize::try_from(index).map_err(|_| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}: enum index is outside the host size domain"),
                })?;
                let member = members.get(index).ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}: enum index {index} out of range"),
                })?;
                Ok(Value::Str(member.clone()))
            }
            Node::Nullable(inner) => match r.u8()? {
                0 => Ok(Value::Null),
                1 => self.dec(r, inner, path, depth.saturating_add(1), column),
                m => err(
                    ErrorCode::Marker,
                    format!("{path}: invalid nullable marker {m:#x}"),
                ),
            },
            Node::Array { element, length } => {
                if self.plan == Plan::Columnar {
                    if let Some(leaves) = columnar_leaves(element) {
                        return self.dec_columnar(r, column, &leaves, *length, path, depth);
                    }
                }
                let count = self.read_count(r, *length, path)?;
                self.bound_by_input(r, count, element, path)?;
                let mut out = Vec::with_capacity(count.min(4096));
                for i in 0..count {
                    out.push(self.dec(
                        r,
                        element,
                        &format!("{path}[{i}]"),
                        depth.saturating_add(1),
                        column,
                    )?);
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
                let mut field_column = column;
                for f in fields {
                    let base = field_column;
                    field_column += column_count(&f.ty);
                    let present = if f.optional {
                        let value = *presence.get(pi).ok_or_else(|| Error {
                            code: ErrorCode::Truncated,
                            message: format!(
                                "{path}: presence bitmap is shorter than the field table"
                            ),
                        })?;
                        pi += 1;
                        value
                    } else {
                        true
                    };
                    let is_null = if f.nullable {
                        let value = *nulls.get(ni).ok_or_else(|| Error {
                            code: ErrorCode::Truncated,
                            message: format!("{path}: null bitmap is shorter than the field table"),
                        })?;
                        ni += 1;
                        value
                    } else {
                        false
                    };
                    if !present {
                        if is_null {
                            return err(
                                ErrorCode::Bitmap,
                                format!("{path}.{}: null bit set for absent field", f.name),
                            );
                        }
                        continue;
                    }
                    if is_null {
                        out.push((f.name.clone(), Value::Null));
                        continue;
                    }
                    out.push((
                        f.name.clone(),
                        self.dec(
                            r,
                            &f.ty,
                            &format!("{path}.{}", f.name),
                            depth.saturating_add(1),
                            base,
                        )?,
                    ));
                }
                Ok(Value::Object(out))
            }
        }
    }

    fn check_amplification(&self, count: usize, payload_bytes: usize, path: &str) -> Result<()> {
        let payload = u128::try_from(payload_bytes).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: payload size exceeds the amplification arithmetic domain"),
        })?;
        let ceiling = payload
            .checked_add(1)
            .and_then(|value| value.checked_mul(u128::from(self.limits.max_amplification)))
            .ok_or_else(|| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: amplification limit arithmetic overflow"),
            })?;
        let count = u128::try_from(count).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: item count exceeds the amplification arithmetic domain"),
        })?;
        if count > ceiling {
            return err(
                ErrorCode::Limit,
                format!("{path}: {count} rows in {payload_bytes} payload byte(s) exceeds the amplification limit"),
            );
        }
        Ok(())
    }

    fn bound_amplification(&self, r: &Reader, count: usize, path: &str) -> Result<()> {
        let remaining = u128::try_from(r.remaining()).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: remaining input exceeds the amplification arithmetic domain"),
        })?;
        let ceiling = remaining
            .checked_add(1)
            .and_then(|value| value.checked_mul(u128::from(self.limits.max_amplification)))
            .ok_or_else(|| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: amplification limit arithmetic overflow"),
            })?;
        let count = u128::try_from(count).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: item count exceeds the amplification arithmetic domain"),
        })?;
        if count > ceiling {
            return err(
                ErrorCode::Limit,
                format!(
                    "{path}: {count} rows from {} remaining byte(s) exceeds the amplification limit",
                    r.remaining()
                ),
            );
        }
        Ok(())
    }

    /// A row-encoded count must be payable by the bytes still on the wire: any
    /// payload-carrying element costs at least one bit. Payload-free rows use the
    /// general amplification policy instead.
    fn bound_by_input(&self, r: &Reader, count: usize, element: &Node, path: &str) -> Result<()> {
        if count == 0 {
            return Ok(());
        }
        if !has_payload(element) {
            return self.bound_amplification(r, count, path);
        }
        let affordable = u128::try_from(r.remaining())
            .ok()
            .and_then(|remaining| remaining.checked_mul(8))
            .ok_or_else(|| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: row affordability arithmetic overflow"),
            })?;
        let count_exact = u128::try_from(count).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: row count exceeds the affordability arithmetic domain"),
        })?;
        if count_exact > affordable {
            return err(
                ErrorCode::Limit,
                format!(
                    "{path}: declared {count} items but only {} byte(s) remain",
                    r.remaining()
                ),
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
            return err(
                ErrorCode::Limit,
                format!("{path}: array count {n} exceeds limit"),
            );
        }
        usize::try_from(n).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: array count {n} exceeds the host size domain"),
        })
    }

    fn dec_columnar(
        &self,
        r: &mut Reader,
        ordinal_base: usize,
        leaves: &[LeafCol],
        length: Option<u64>,
        path: &str,
        depth: u32,
    ) -> Result<Value> {
        let count = self.read_count(r, length, path)?;
        self.bound_amplification(r, count, path)?;

        fn ensure_path(entries: &mut Vec<(String, Value)>, segs: &[&str]) -> Result<()> {
            if segs.is_empty() {
                return Ok(());
            }
            let key = segs[0];
            let pos = match entries.iter().position(|(k, _)| k == key) {
                Some(i) => i,
                None => {
                    entries.push((key.to_owned(), Value::Object(Vec::new())));
                    entries.len() - 1
                }
            };
            let Some((_, Value::Object(inner))) = entries.get_mut(pos) else {
                return err(ErrorCode::Ir, "flattened column container is not an object");
            };
            ensure_path(inner, &segs[1..])
        }

        fn set_path(row: &mut Vec<(String, Value)>, segs: &[&str], value: Value) -> Result<()> {
            if segs.is_empty() {
                return err(ErrorCode::Ir, "flattened column has an empty field path");
            }
            if segs.len() == 1 {
                row.push((segs[0].to_owned(), value));
                return Ok(());
            }
            let key = segs[0];
            let pos = match row.iter().position(|(k, _)| k == key) {
                Some(i) => i,
                None => {
                    row.push((key.to_owned(), Value::Object(Vec::new())));
                    row.len() - 1
                }
            };
            let Some((_, Value::Object(inner))) = row.get_mut(pos) else {
                return err(ErrorCode::Ir, "flattened column container is not an object");
            };
            set_path(inner, &segs[1..], value)
        }

        let mut decoded = Vec::with_capacity(leaves.len());
        for (leaf_index, leaf) in leaves.iter().enumerate() {
            let f = leaf.field;
            let field_path = format!("{path}[].{}", leaf.segs.join("."));
            let presence = if f.optional {
                Some(read_bitmap(r, count, &field_path)?)
            } else {
                None
            };
            let nulls = if f.nullable {
                Some(read_bitmap(r, count, &field_path)?)
            } else {
                None
            };

            let mut slots = Vec::new();
            let mut null_rows = Vec::new();
            for i in 0..count {
                let present = match &presence {
                    Some(bits) => *bits.get(i).ok_or_else(|| Error {
                        code: ErrorCode::Truncated,
                        message: format!(
                            "{field_path}: presence bitmap is shorter than the row count"
                        ),
                    })?,
                    None => true,
                };
                let is_null = match &nulls {
                    Some(bits) => *bits.get(i).ok_or_else(|| Error {
                        code: ErrorCode::Truncated,
                        message: format!("{field_path}: null bitmap is shorter than the row count"),
                    })?,
                    None => false,
                };
                if !present {
                    if is_null {
                        return err(
                            ErrorCode::Bitmap,
                            format!("{path}[{i}]: null bit set for absent field"),
                        );
                    }
                    continue;
                }
                if is_null {
                    null_rows.push(i);
                    continue;
                }
                slots.push(i);
            }

            let segment_depth = u32::try_from(leaf.segs.len()).map_err(|_| Error {
                code: ErrorCode::Depth,
                message: format!("{field_path}: field path exceeds the depth arithmetic domain"),
            })?;
            if count > 0 && depth.saturating_add(segment_depth) > self.limits.max_depth {
                return err(
                    ErrorCode::Depth,
                    format!(
                        "{field_path}: nesting deeper than {}",
                        self.limits.max_depth
                    ),
                );
            }
            if !slots.is_empty()
                && depth.saturating_add(1).saturating_add(segment_depth) > self.limits.max_depth
            {
                return err(
                    ErrorCode::Depth,
                    format!(
                        "{field_path}: nesting deeper than {}",
                        self.limits.max_depth
                    ),
                );
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
                Node::Bool => read_bitmap(r, slots.len(), &field_path)?
                    .into_iter()
                    .map(Value::Bool)
                    .collect(),
                Node::Str => dec_string_column(
                    r,
                    &slots,
                    &decoded,
                    ordinal_base,
                    &field_path,
                    &self.limits,
                    self.pack,
                    self.dict_of(ordinal_base + leaf_index),
                    self.grammar_of(ordinal_base + leaf_index),
                    self.derivation_of(ordinal_base + leaf_index),
                    &self.codes,
                )?
                .into_iter()
                .map(Value::Str)
                .collect(),
                Node::Enum(members) => dec_enum_column(r, members, slots.len(), &field_path)?
                    .into_iter()
                    .map(Value::Str)
                    .collect(),
                t => {
                    let mut out = Vec::with_capacity(slots.len());
                    for row in &slots {
                        out.push(self.dec(
                            r,
                            t,
                            &format!("{path}[{row}]"),
                            depth.saturating_add(2),
                            ordinal_base + leaf_index,
                        )?);
                    }
                    out
                }
            };
            decoded.push(DecodedLeaf {
                slots,
                values,
                null_rows,
            });
        }

        // Materialize rows only after every column has decoded successfully. This
        // keeps a truncated hostile body from allocating one object per declared row.
        let mut rows: Vec<Vec<(String, Value)>> = (0..count).map(|_| Vec::new()).collect();
        for (leaf_index, leaf) in leaves.iter().enumerate() {
            if leaf.segs.len() > 1 {
                for row in &mut rows {
                    ensure_path(row, &leaf.segs[..leaf.segs.len() - 1])?;
                }
            }
            let entry = decoded.get(leaf_index).ok_or_else(|| Error {
                code: ErrorCode::Truncated,
                message: format!("{path}: decoded leaf table is incomplete"),
            })?;
            for row_index in &entry.null_rows {
                let row = rows.get_mut(*row_index).ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}: null row index exceeds the declared row count"),
                })?;
                set_path(row, &leaf.segs, Value::Null)?;
            }
            for (participant, row_index) in entry.slots.iter().enumerate() {
                let row = rows.get_mut(*row_index).ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!(
                        "{path}: participant row index exceeds the declared row count"
                    ),
                })?;
                let value = entry.values.get(participant).ok_or_else(|| Error {
                    code: ErrorCode::Truncated,
                    message: format!("{path}: decoded leaf value table is incomplete"),
                })?;
                set_path(row, &leaf.segs, value.clone())?;
            }
        }
        Ok(Value::Array(rows.into_iter().map(Value::Object).collect()))
    }
}

const MAX_WIDTH: u8 = 56;

/// Bits needed for an unsigned value; zero for zero, so a constant column packs to nothing.
fn bit_width(max: u64) -> u8 {
    (64 - max.leading_zeros()) as u8
}

fn packed_bytes(count: usize, width: u8) -> Option<usize> {
    if width == 0 {
        return Some(0);
    }
    let bits = count.checked_mul(usize::from(width))?;
    Some(bits / 8 + usize::from(bits % 8 != 0))
}

/// Spec 3.1: little-endian bit stream, value i at bits [i*w, (i+1)*w).
fn pack_bits(out: &mut Vec<u8>, values: &[u64], width: u8) {
    if width == 0 {
        return;
    }
    let mut acc: u128 = 0;
    let mut bits: u32 = 0;
    for value in values {
        acc |= (*value as u128) << bits;
        bits += width as u32;
        while bits >= 8 {
            out.push((acc & 0xff) as u8);
            acc >>= 8;
            bits -= 8;
        }
    }
    if bits > 0 {
        out.push((acc & 0xff) as u8);
    }
}

fn unpack_bits(r: &mut Reader, count: usize, width: u8, path: &str) -> Result<Vec<u64>> {
    if width > MAX_WIDTH {
        return err(
            ErrorCode::Marker,
            format!("{path}: bit width {width} exceeds {MAX_WIDTH}"),
        );
    }
    if width == 0 {
        return Ok(vec![0; count]);
    }
    let byte_count = packed_bytes(count, width).ok_or_else(|| Error {
        code: ErrorCode::Limit,
        message: format!("{path}: packed payload length overflows the host size domain"),
    })?;
    let data = r.take(byte_count)?.to_vec();
    let mask: u128 = (1u128 << width) - 1;
    let mut out = Vec::with_capacity(count);
    let mut acc: u128 = 0;
    let mut bits: u32 = 0;
    let mut index = 0usize;
    for _ in 0..count {
        while bits < width as u32 {
            let byte = data.get(index).copied().ok_or_else(|| Error {
                code: ErrorCode::Truncated,
                message: format!("{path}: packed payload ended inside a value"),
            })?;
            index += 1;
            acc |= (byte as u128) << bits;
            bits += 8;
        }
        out.push((acc & mask) as u64);
        acc >>= width;
        bits -= width as u32;
    }
    // leftover bits are padding and must be zero, or one value would have two encodings
    if acc != 0 {
        return err(
            ErrorCode::Bitmap,
            format!("{path}: nonzero bit-packing padding"),
        );
    }
    Ok(out)
}

fn enc_enum_column(
    out: &mut Vec<u8>,
    members: &[String],
    values: &[&Value],
    path: &str,
) -> Result<()> {
    let width = enum_width(members.len())?;
    let mut indices = Vec::with_capacity(values.len());
    for (i, value) in values.iter().enumerate() {
        let Value::Str(member) = value else {
            return err(
                ErrorCode::Type,
                format!("{path}[{i}]: expected enum member string"),
            );
        };
        let Some(index) = members.iter().position(|candidate| candidate == member) else {
            return err(ErrorCode::Type, format!("{path}[{i}]: not an enum member"));
        };
        indices.push(u64::try_from(index).map_err(|_| Error {
            code: ErrorCode::Range,
            message: format!("{path}[{i}]: enum index exceeds the wire integer domain"),
        })?);
    }
    pack_bits(out, &indices, width);
    Ok(())
}

fn dec_enum_column(
    r: &mut Reader,
    members: &[String],
    count: usize,
    path: &str,
) -> Result<Vec<String>> {
    let width = enum_width(members.len())?;
    let indices = unpack_bits(r, count, width, path)?;
    let mut out = Vec::with_capacity(count);
    for (i, index) in indices.into_iter().enumerate() {
        let index = usize::try_from(index).map_err(|_| Error {
            code: ErrorCode::Range,
            message: format!("{path}[{i}]: enum index is outside the host size domain"),
        })?;
        let Some(member) = members.get(index) else {
            return err(
                ErrorCode::Range,
                format!("{path}[{i}]: enum index {index} out of range"),
            );
        };
        out.push(member.clone());
    }
    Ok(out)
}

fn zigzag_i128(value: i128) -> Result<u64> {
    let narrowed = i64::try_from(value).map_err(|_| Error {
        code: ErrorCode::Range,
        message: "integer delta exceeds the signed wire arithmetic domain".into(),
    })?;
    Ok(zigzag(narrowed))
}

struct PforCandidate {
    cost: usize,
    low_width: u8,
    high_width: u8,
    exceptions: Vec<bool>,
    lows: Vec<u64>,
    highs: Vec<u64>,
}

fn add_cost(total: usize, part: usize) -> Result<usize> {
    total.checked_add(part).ok_or_else(|| Error {
        code: ErrorCode::Limit,
        message: "column encoded-size arithmetic overflow".into(),
    })
}

fn packed_cost(count: usize, width: u8) -> Result<usize> {
    packed_bytes(count, width).ok_or_else(|| Error {
        code: ErrorCode::Limit,
        message: "column packed-size arithmetic overflow".into(),
    })
}

fn enc_int_column(out: &mut Vec<u8>, min: Option<i64>, values: &[i64]) -> Result<()> {
    if values.is_empty() {
        out.push(0);
        return Ok(());
    }

    let forms: Vec<u64> = values
        .iter()
        .map(|value| int_form(min, *value))
        .collect::<Result<Vec<_>>>()?;
    let diffs: Vec<i128> = values
        .windows(2)
        .map(|pair| pair[1] as i128 - pair[0] as i128)
        .collect();
    let mut raw_cost = 0usize;
    for form in &forms {
        raw_cost = add_cost(raw_cost, uleb_len(*form))?;
    }
    let mut delta_cost = uleb_len(forms[0]);
    for diff in &diffs {
        delta_cost = add_cost(delta_cost, uleb_len(zigzag_i128(*diff)?))?;
    }

    let for_base = values.iter().copied().min().ok_or_else(|| Error {
        code: ErrorCode::Ir,
        message: "non-empty integer column has no minimum".into(),
    })?;
    let offsets: Vec<u64> = values
        .iter()
        .map(|value| {
            u64::try_from(*value as i128 - for_base as i128).map_err(|_| Error {
                code: ErrorCode::Range,
                message: "frame-of-reference offset is negative".into(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let for_span = offsets.iter().copied().max().unwrap_or(0);
    let for_width = bit_width(for_span);
    let for_cost = if for_width <= MAX_WIDTH {
        add_cost(
            add_cost(uleb_len(zigzag(for_base)), 1)?,
            packed_cost(values.len(), for_width)?,
        )?
    } else {
        usize::MAX
    };

    let mut delta_for_cost = usize::MAX;
    let mut delta_base = 0i128;
    let mut delta_width = 0u8;
    let mut delta_offsets = Vec::new();
    if let Some(base) = diffs.iter().copied().min() {
        delta_base = base;
        delta_offsets = diffs
            .iter()
            .map(|diff| {
                u64::try_from(*diff - delta_base).map_err(|_| Error {
                    code: ErrorCode::Range,
                    message: "delta frame offset is negative".into(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        delta_width = bit_width(delta_offsets.iter().copied().max().unwrap_or(0));
        if delta_width <= MAX_WIDTH {
            delta_for_cost = add_cost(
                add_cost(
                    add_cost(uleb_len(forms[0]), uleb_len(zigzag_i128(delta_base)?))?,
                    1,
                )?,
                packed_cost(diffs.len(), delta_width)?,
            )?;
        }
    }

    let mut pfor = None;
    if for_width > 0 && for_width <= MAX_WIDTH {
        for low_width in 0..for_width {
            let low_mask = if low_width == 0 {
                0
            } else {
                (1u64 << low_width) - 1
            };
            let lows: Vec<u64> = offsets.iter().map(|offset| offset & low_mask).collect();
            let high_parts: Vec<u64> = offsets.iter().map(|offset| offset >> low_width).collect();
            let exceptions: Vec<bool> = high_parts.iter().map(|high| *high != 0).collect();
            let highs: Vec<u64> = high_parts.into_iter().filter(|high| *high != 0).collect();
            let high_width = bit_width(highs.iter().copied().max().unwrap_or(0));
            let cost = add_cost(
                add_cost(
                    add_cost(
                        add_cost(uleb_len(zigzag(for_base)), 2)?,
                        packed_cost(values.len(), 1)?,
                    )?,
                    packed_cost(values.len(), low_width)?,
                )?,
                packed_cost(highs.len(), high_width)?,
            )?;
            if pfor
                .as_ref()
                .is_none_or(|candidate: &PforCandidate| cost < candidate.cost)
            {
                pfor = Some(PforCandidate {
                    cost,
                    low_width,
                    high_width,
                    exceptions,
                    lows,
                    highs,
                });
            }
        }
    }

    let pfor_cost = pfor.as_ref().map_or(usize::MAX, |candidate| candidate.cost);
    let costs = [raw_cost, delta_cost, for_cost, delta_for_cost, pfor_cost];
    let best = costs.iter().copied().min().unwrap_or(raw_cost);
    let mode = costs.iter().position(|cost| *cost == best).unwrap_or(0);
    match mode {
        0 => {
            out.push(0x00);
            for form in forms {
                write_uleb(out, form)?;
            }
        }
        1 => {
            out.push(0x01);
            write_uleb(out, forms[0])?;
            for diff in diffs {
                write_uleb(out, zigzag_i128(diff)?)?;
            }
        }
        2 => {
            out.push(0x02);
            write_uleb(out, zigzag(for_base))?;
            out.push(for_width);
            pack_bits(out, &offsets, for_width);
        }
        3 => {
            out.push(0x03);
            write_uleb(out, forms[0])?;
            write_uleb(out, zigzag_i128(delta_base)?)?;
            out.push(delta_width);
            pack_bits(out, &delta_offsets, delta_width);
        }
        _ => {
            let candidate = pfor.ok_or_else(|| Error {
                code: ErrorCode::Ir,
                message: "patched frame selected without a candidate".into(),
            })?;
            out.push(0x04);
            write_uleb(out, zigzag(for_base))?;
            out.push(candidate.low_width);
            out.push(candidate.high_width);
            write_bitmap(out, &candidate.exceptions);
            pack_bits(out, &candidate.lows, candidate.low_width);
            pack_bits(out, &candidate.highs, candidate.high_width);
        }
    }
    Ok(())
}

fn checked_add_i128(left: i128, right: i128, path: &str) -> Result<i128> {
    left.checked_add(right).ok_or_else(|| Error {
        code: ErrorCode::Range,
        message: format!("{path}: integer reconstruction overflow"),
    })
}

fn dec_int_column(
    r: &mut Reader,
    min: Option<i64>,
    max: Option<i64>,
    count: usize,
    path: &str,
) -> Result<Vec<i64>> {
    let mode = r.u8()?;
    if mode > 4 {
        return err(
            ErrorCode::Marker,
            format!("{path}: invalid int column mode {mode:#x}"),
        );
    }
    if count == 0 {
        if mode != 0 {
            return err(
                ErrorCode::Marker,
                format!("{path}: empty column must use mode 0x00"),
            );
        }
        return Ok(Vec::new());
    }
    if mode == 0x03 && count < 2 {
        return err(
            ErrorCode::Marker,
            format!("{path}: delta frame requires at least two values"),
        );
    }

    let from_form = |raw: u64| -> i128 {
        match min {
            Some(lo) => raw as i128 + lo as i128,
            None => unzigzag(raw) as i128,
        }
    };
    let mut out = Vec::with_capacity(count);
    if mode == 0x00 {
        for i in 0..count {
            out.push(decoded_int(
                min,
                max,
                from_form(read_uleb(r)?),
                &format!("{path}[{i}]"),
            )?);
        }
        return Ok(out);
    }
    if mode == 0x02 {
        let base = unzigzag(read_uleb(r)?) as i128;
        let width = r.u8()?;
        let packed = unpack_bits(r, count, width, path)?;
        for (i, offset) in packed.iter().enumerate() {
            let value = checked_add_i128(base, *offset as i128, &format!("{path}[{i}]"))?;
            out.push(decoded_int(min, max, value, &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }
    if mode == 0x03 {
        let first = from_form(read_uleb(r)?);
        let base = unzigzag(read_uleb(r)?) as i128;
        let width = r.u8()?;
        let packed = unpack_bits(r, count - 1, width, path)?;
        let mut running = first;
        out.push(decoded_int(min, max, running, &format!("{path}[0]"))?);
        for (offset_index, offset) in packed.into_iter().enumerate() {
            let i = offset_index.checked_add(1).ok_or_else(|| Error {
                code: ErrorCode::Range,
                message: format!("{path}: delta-frame row index overflow"),
            })?;
            let delta = checked_add_i128(base, offset as i128, &format!("{path}[{i}]"))?;
            running = checked_add_i128(running, delta, &format!("{path}[{i}]"))?;
            out.push(decoded_int(min, max, running, &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }
    if mode == 0x04 {
        let base = unzigzag(read_uleb(r)?) as i128;
        let low_width = r.u8()?;
        let high_width = r.u8()?;
        if low_width > 55 {
            return err(
                ErrorCode::Marker,
                format!("{path}: patched frame low width {low_width} exceeds 55"),
            );
        }
        if high_width < 1 || u16::from(low_width) + u16::from(high_width) > u16::from(MAX_WIDTH) {
            return err(
                ErrorCode::Marker,
                format!("{path}: invalid patched frame widths L={low_width}, H={high_width}"),
            );
        }
        let exceptions = read_bitmap(r, count, path)?;
        let lows = unpack_bits(r, count, low_width, path)?;
        let exception_count = exceptions.iter().filter(|exception| **exception).count();
        let highs = unpack_bits(r, exception_count, high_width, path)?;
        let mut high_index = 0usize;
        for (i, (exception, low)) in exceptions.iter().zip(&lows).enumerate() {
            let high = if *exception {
                let value = *highs.get(high_index).ok_or_else(|| Error {
                    code: ErrorCode::Truncated,
                    message: format!("{path}[{i}]: missing patched-frame high part"),
                })?;
                high_index += 1;
                if value == 0 {
                    return err(
                        ErrorCode::Bitmap,
                        format!("{path}[{i}]: patched frame exception has a zero high part"),
                    );
                }
                value
            } else {
                0
            };
            let shifted = (high as i128)
                .checked_shl(u32::from(low_width))
                .ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}[{i}]: patched-frame shift overflow"),
                })?;
            let offset = checked_add_i128(*low as i128, shifted, &format!("{path}[{i}]"))?;
            let value = checked_add_i128(base, offset, &format!("{path}[{i}]"))?;
            out.push(decoded_int(min, max, value, &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }

    let mut previous = from_form(read_uleb(r)?);
    out.push(decoded_int(min, max, previous, &format!("{path}[0]"))?);
    for i in 1..count {
        previous = checked_add_i128(
            previous,
            unzigzag(read_uleb(r)?) as i128,
            &format!("{path}[{i}]"),
        )?;
        out.push(decoded_int(min, max, previous, &format!("{path}[{i}]"))?);
    }
    Ok(out)
}

fn dec_float_bits(bits: u64, path: &str) -> Result<f64> {
    if bits == NEG_ZERO_BITS {
        return err(
            ErrorCode::Float,
            format!("{path}: negative-zero bit pattern"),
        );
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
        mantissas = values
            .iter()
            .map(|v| decimal_mantissa(*v, pow) as i64)
            .collect();
        sr_cost = 1 + mantissas
            .iter()
            .map(|m| uleb_len(zigzag(*m)))
            .sum::<usize>();
        sd_cost = 1
            + uleb_len(zigzag(mantissas[0]))
            + mantissas
                .windows(2)
                .map(|w| uleb_len(zigzag(w[1] - w[0])))
                .sum::<usize>();
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
        out.push(scale.ok_or_else(|| Error {
            code: ErrorCode::Ir,
            message: "scaled-delta float mode selected without a scale".into(),
        })?);
        write_uleb(out, zigzag(mantissas[0]))?;
        for w in mantissas.windows(2) {
            write_uleb(out, zigzag(w[1] - w[0]))?;
        }
    } else {
        out.push(3);
        out.push(scale.ok_or_else(|| Error {
            code: ErrorCode::Ir,
            message: "scaled-raw float mode selected without a scale".into(),
        })?);
        for m in &mantissas {
            write_uleb(out, zigzag(*m))?;
        }
    }
    Ok(())
}

fn dec_float_column(r: &mut Reader, count: usize, path: &str) -> Result<Vec<f64>> {
    let mode = r.u8()?;
    if mode > 3 {
        return err(
            ErrorCode::Marker,
            format!("{path}: invalid float column mode {mode:#x}"),
        );
    }
    if count == 0 {
        if mode != 0 {
            return err(
                ErrorCode::Marker,
                format!("{path}: empty column must use mode 0x00"),
            );
        }
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(count);

    if mode >= 2 {
        let scale = r.u8()?;
        if scale > MAX_SCALE {
            return err(
                ErrorCode::Marker,
                format!("{path}: decimal scale {scale} exceeds {MAX_SCALE}"),
            );
        }
        let pow = POW10[scale as usize];
        let mantissa = |m: i128, i: usize| -> Result<f64> {
            if m < INT_MIN as i128 || m > INT_MAX as i128 {
                return err(
                    ErrorCode::Range,
                    format!("{path}[{i}]: decimal mantissa outside the v0 domain"),
                );
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
            prev = checked_add_i128(
                prev,
                unzigzag(read_uleb(r)?) as i128,
                &format!("{path}[{i}]"),
            )?;
            out.push(mantissa(prev, i)?);
        }
        return Ok(out);
    }

    if mode == 0 {
        for i in 0..count {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(r.take(8)?);
            let bits = u64::from_le_bytes(bytes);
            out.push(dec_float_bits(bits, &format!("{path}[{i}]"))?);
        }
        return Ok(out);
    }
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(r.take(8)?);
    let mut prev = u64::from_le_bytes(bytes);
    out.push(dec_float_bits(prev, &format!("{path}[0]"))?);
    for i in 1..count {
        let n = r.u8()? as usize;
        if n > 8 {
            return err(
                ErrorCode::Marker,
                format!("{path}[{i}]: xor length {n} exceeds 8"),
            );
        }
        let mut le = [0u8; 8];
        le[..n].copy_from_slice(r.take(n)?);
        let x = u64::from_le_bytes(le);
        if n > 0 && x >> (8 * (n - 1)) == 0 {
            return err(
                ErrorCode::Float,
                format!("{path}[{i}]: non-minimal xor encoding"),
            );
        }
        prev ^= x;
        out.push(dec_float_bits(prev, &format!("{path}[{i}]"))?);
    }
    Ok(out)
}

fn grammar_limit(base: u32, len: u32) -> Result<u64> {
    let mut limit = 1u128;
    for _ in 0..len {
        limit = limit.checked_mul(u128::from(base)).ok_or_else(|| Error {
            code: ErrorCode::Ir,
            message: "profile grammar lane limit overflows exact arithmetic".into(),
        })?;
    }
    u64::try_from(limit).map_err(|_| Error {
        code: ErrorCode::Ir,
        message: "profile grammar lane limit exceeds the wire integer domain".into(),
    })
}

fn grammar_digit(byte: u8, base: u32, case: GrammarCase) -> Option<u64> {
    let digit = if byte.is_ascii_digit() {
        u32::from(byte - b'0')
    } else if case == GrammarCase::Lower && byte.is_ascii_lowercase() {
        u32::from(byte - b'a') + 10
    } else if case == GrammarCase::Upper && byte.is_ascii_uppercase() {
        u32::from(byte - b'A') + 10
    } else {
        return None;
    };
    (digit < base).then_some(u64::from(digit))
}

fn match_grammar(value: &str, grammar: &[GrammarToken]) -> Result<Option<Vec<u64>>> {
    let bytes = value.as_bytes();
    let mut offset = 0usize;
    let mut lanes = Vec::new();
    for token in grammar {
        match token {
            GrammarToken::Lit(literal) => {
                let end = offset.checked_add(literal.len()).ok_or_else(|| Error {
                    code: ErrorCode::Limit,
                    message: "grammar literal offset overflows the host size domain".into(),
                })?;
                if bytes.get(offset..end) != Some(literal.as_bytes()) {
                    return Ok(None);
                }
                offset = end;
            }
            GrammarToken::Num(num) => {
                let len = usize::try_from(num.len).map_err(|_| Error {
                    code: ErrorCode::Ir,
                    message: "grammar token length exceeds the host size domain".into(),
                })?;
                let end = offset.checked_add(len).ok_or_else(|| Error {
                    code: ErrorCode::Limit,
                    message: "grammar numeric offset overflows the host size domain".into(),
                })?;
                let Some(digits) = bytes.get(offset..end) else {
                    return Ok(None);
                };
                let mut lane = 0u128;
                for byte in digits {
                    let Some(digit) = grammar_digit(*byte, num.base, num.case) else {
                        return Ok(None);
                    };
                    lane = lane
                        .checked_mul(u128::from(num.base))
                        .and_then(|value| value.checked_add(u128::from(digit)))
                        .ok_or_else(|| Error {
                            code: ErrorCode::Ir,
                            message: "grammar lane parse overflows exact arithmetic".into(),
                        })?;
                }
                lanes.push(u64::try_from(lane).map_err(|_| Error {
                    code: ErrorCode::Ir,
                    message: "grammar lane exceeds the wire integer domain".into(),
                })?);
                offset = end;
            }
        }
    }
    Ok((offset == bytes.len()).then_some(lanes))
}

fn render_grammar(grammar: &[GrammarToken], lanes: &[u64]) -> Result<String> {
    const LOWER: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    const UPPER: &[u8; 36] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    let mut out = Vec::new();
    let mut lane_index = 0usize;
    for token in grammar {
        match token {
            GrammarToken::Lit(literal) => out.extend_from_slice(literal.as_bytes()),
            GrammarToken::Num(num) => {
                let mut value = *lanes.get(lane_index).ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: "grammar lane is missing during reconstruction".into(),
                })?;
                lane_index += 1;
                let len = usize::try_from(num.len).map_err(|_| Error {
                    code: ErrorCode::Ir,
                    message: "grammar token length exceeds the host size domain".into(),
                })?;
                let alphabet = if num.case == GrammarCase::Lower {
                    LOWER
                } else {
                    UPPER
                };
                let start = out.len();
                let end = start.checked_add(len).ok_or_else(|| Error {
                    code: ErrorCode::Limit,
                    message: "rendered grammar length exceeds the host size domain".into(),
                })?;
                out.resize(end, b'0');
                for position in (start..end).rev() {
                    let digit =
                        usize::try_from(value % u64::from(num.base)).map_err(|_| Error {
                            code: ErrorCode::Range,
                            message: "grammar digit exceeds the host size domain".into(),
                        })?;
                    out[position] = *alphabet.get(digit).ok_or_else(|| Error {
                        code: ErrorCode::Range,
                        message: "grammar digit exceeds its alphabet".into(),
                    })?;
                    value /= u64::from(num.base);
                }
                if value != 0 {
                    return err(
                        ErrorCode::Range,
                        "grammar lane exceeds its declared token width",
                    );
                }
            }
        }
    }
    if lane_index != lanes.len() {
        return err(
            ErrorCode::Range,
            "too many grammar lanes during reconstruction",
        );
    }
    String::from_utf8(out).map_err(|_| Error {
        code: ErrorCode::Utf8,
        message: "profile grammar reconstructed invalid UTF-8".into(),
    })
}

fn escaped_payload(values: &[&str], escaped: &[bool]) -> Result<Vec<u8>> {
    let mut payload = Vec::new();
    for (value, is_escaped) in values.iter().zip(escaped) {
        if !is_escaped {
            continue;
        }
        let len = u64::try_from(value.len()).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: "string length exceeds the wire size domain".into(),
        })?;
        write_uleb(&mut payload, len)?;
        payload.extend_from_slice(value.as_bytes());
    }
    Ok(payload)
}

fn write_escape_header(payload: &mut Vec<u8>, escaped: &[bool]) -> Result<()> {
    let count = escaped.iter().filter(|value| **value).count();
    write_uleb(
        payload,
        u64::try_from(count).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: "escape count exceeds the wire size domain".into(),
        })?,
    )?;
    if count > 0 && count < escaped.len() {
        write_bitmap(payload, escaped);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn enc_string_column(
    out: &mut Vec<u8>,
    values: &[&str],
    slots: &[usize],
    inputs: &[ColumnInput<'_>],
    ordinal_base: usize,
    path: &str,
    limits: &Limits,
    pack: bool,
    codes_index: Option<&HashMap<String, u64>>,
    grammar: Option<&[GrammarToken]>,
    derivation: Option<&Derivation>,
    all_codes: &HashMap<usize, HashMap<String, u64>>,
) -> Result<()> {
    if values.is_empty() {
        out.push(0);
        return Ok(());
    }
    for (i, value) in values.iter().enumerate() {
        let len = u64::try_from(value.len()).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}[{i}]: string length exceeds the wire size domain"),
        })?;
        if len > limits.max_byte_length {
            return err(
                ErrorCode::Limit,
                format!("{path}[{i}]: string length exceeds limit"),
            );
        }
    }

    let mut candidates: Vec<(u8, Vec<u8>)> = Vec::new();
    candidates.push((0x00, escaped_payload(values, &vec![true; values.len()])?));

    if let Some(index) = codes_index {
        let codes: Vec<u64> = values
            .iter()
            .map(|value| index.get(*value).copied().unwrap_or(0))
            .collect();
        let width = bit_width(codes.iter().copied().max().unwrap_or(0));
        let mut payload = vec![width];
        pack_bits(&mut payload, &codes, width);
        let escaped: Vec<bool> = codes.iter().map(|code| *code == 0).collect();
        payload.extend_from_slice(&escaped_payload(values, &escaped)?);
        candidates.push((0x01, payload));
    }

    if pack {
        let total = values.iter().try_fold(0u64, |sum, value| {
            let len = u64::try_from(value.len()).map_err(|_| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: packed string total exceeds the wire size domain"),
            })?;
            sum.checked_add(len).ok_or_else(|| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: packed string total overflows exact arithmetic"),
            })
        })?;
        if total <= limits.max_byte_length {
            let total_usize = usize::try_from(total).map_err(|_| Error {
                code: ErrorCode::Limit,
                message: format!("{path}: packed string total exceeds the host size domain"),
            })?;
            let mut concat = Vec::with_capacity(total_usize);
            for value in values {
                concat.extend_from_slice(value.as_bytes());
            }
            let packed = miniz_oxide::deflate::compress_to_vec(&concat, 6);
            let mut payload = Vec::new();
            for value in values {
                write_uleb(
                    &mut payload,
                    u64::try_from(value.len()).map_err(|_| Error {
                        code: ErrorCode::Limit,
                        message: format!("{path}: string length exceeds the wire size domain"),
                    })?,
                )?;
            }
            write_uleb(
                &mut payload,
                u64::try_from(packed.len()).map_err(|_| Error {
                    code: ErrorCode::Limit,
                    message: format!("{path}: packed blob exceeds the wire size domain"),
                })?,
            )?;
            payload.extend_from_slice(&packed);
            candidates.push((0x02, payload));
        }
    }

    if let Some(grammar) = grammar {
        let parsed: Vec<Option<Vec<u64>>> = values
            .iter()
            .map(|value| match_grammar(value, grammar))
            .collect::<Result<Vec<_>>>()?;
        let escaped: Vec<bool> = parsed.iter().map(Option::is_none).collect();
        let numeric_count = grammar
            .iter()
            .filter(|token| matches!(token, GrammarToken::Num(_)))
            .count();
        let mut lanes: Vec<Vec<i64>> = (0..numeric_count).map(|_| Vec::new()).collect();
        for row in parsed.iter().flatten() {
            for (lane, value) in row.iter().enumerate() {
                let narrowed = i64::try_from(*value).map_err(|_| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}: grammar lane exceeds the v0 integer domain"),
                })?;
                if let Some(values) = lanes.get_mut(lane) {
                    values.push(narrowed);
                }
            }
        }
        let mut payload = Vec::new();
        write_escape_header(&mut payload, &escaped)?;
        for lane in lanes {
            enc_int_column(&mut payload, Some(0), &lane)?;
        }
        payload.extend_from_slice(&escaped_payload(values, &escaped)?);
        candidates.push((0x03, payload));
    }

    if let Some(derivation) = derivation {
        let source_codes = all_codes.get(&derivation.source);
        let mut escaped = Vec::with_capacity(values.len());
        for (i, value) in values.iter().enumerate() {
            let conforms = slots
                .get(i)
                .and_then(|row| input_source_value(inputs, ordinal_base, derivation.source, *row))
                .and_then(|source| match source {
                    Value::Str(source) => source_codes.and_then(|codes| codes.get(source)).copied(),
                    _ => None,
                })
                .and_then(|code| code.checked_sub(1))
                .and_then(|index| usize::try_from(index).ok())
                .and_then(|index| derivation.values.get(index))
                .is_some_and(|derived| derived == value);
            escaped.push(!conforms);
        }
        let mut payload = Vec::new();
        write_escape_header(&mut payload, &escaped)?;
        payload.extend_from_slice(&escaped_payload(values, &escaped)?);
        candidates.push((0x04, payload));
    }

    let (mode, payload) = candidates
        .into_iter()
        .min_by_key(|(mode, payload)| (payload.len(), *mode))
        .ok_or_else(|| Error {
            code: ErrorCode::Ir,
            message: "string column has no encoding candidate".into(),
        })?;
    out.push(mode);
    out.extend_from_slice(&payload);
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

fn decode_utf8(data: &[u8], path: &str, index: usize) -> Result<String> {
    std::str::from_utf8(data)
        .map(str::to_owned)
        .map_err(|_| Error {
            code: ErrorCode::Utf8,
            message: format!("{path}[{index}]: invalid UTF-8"),
        })
}

fn read_string_literal(
    r: &mut Reader,
    limits: &Limits,
    path: &str,
    index: usize,
) -> Result<String> {
    let len = read_uleb(r)?;
    if len > limits.max_byte_length {
        return err(
            ErrorCode::Limit,
            format!("{path}[{index}]: string length exceeds limit"),
        );
    }
    let len = usize::try_from(len).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!("{path}[{index}]: string length exceeds the host size domain"),
    })?;
    decode_utf8(r.take(len)?, path, index)
}

fn check_reconstructed_string(
    value: String,
    limits: &Limits,
    path: &str,
    index: usize,
) -> Result<String> {
    let len = u64::try_from(value.len()).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!(
            "{path}[{index}]: reconstructed string length exceeds the wire size domain"
        ),
    })?;
    if len > limits.max_byte_length {
        return err(
            ErrorCode::Limit,
            format!("{path}[{index}]: reconstructed string length exceeds limit"),
        );
    }
    Ok(value)
}

fn read_escapes(r: &mut Reader, count: usize, path: &str) -> Result<(Vec<bool>, usize)> {
    let raw = read_uleb(r)?;
    let count_u64 = u64::try_from(count).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!("{path}: participating row count exceeds the wire size domain"),
    })?;
    if raw > count_u64 {
        return err(
            ErrorCode::Range,
            format!("{path}: escape count {raw} exceeds participating row count {count}"),
        );
    }
    let escape_count = usize::try_from(raw).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!("{path}: escape count exceeds the host size domain"),
    })?;
    if escape_count == 0 {
        return Ok((vec![false; count], 0));
    }
    if escape_count == count {
        return Ok((vec![true; count], count));
    }
    let escaped = read_bitmap(r, count, path)?;
    let popcount = escaped.iter().filter(|value| **value).count();
    if popcount != escape_count {
        return err(
            ErrorCode::Bitmap,
            format!("{path}: escape bitmap popcount {popcount} does not equal {escape_count}"),
        );
    }
    Ok((escaped, escape_count))
}

#[allow(clippy::too_many_arguments)]
fn dec_string_column(
    r: &mut Reader,
    slots: &[usize],
    decoded: &[DecodedLeaf],
    ordinal_base: usize,
    path: &str,
    limits: &Limits,
    pack: bool,
    dict: Option<&[String]>,
    grammar: Option<&[GrammarToken]>,
    derivation: Option<&Derivation>,
    all_codes: &HashMap<usize, HashMap<String, u64>>,
) -> Result<Vec<String>> {
    let count = slots.len();
    let mode = r.u8()?;
    if mode > 4 {
        return err(
            ErrorCode::Marker,
            format!("{path}: invalid string column flags {mode:#x}"),
        );
    }
    if count == 0 {
        if mode != 0 {
            return err(
                ErrorCode::Marker,
                format!("{path}: empty column must use mode 0x00"),
            );
        }
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(count);
    if mode == 0x00 {
        for i in 0..count {
            out.push(read_string_literal(r, limits, path, i)?);
        }
        return Ok(out);
    }

    if mode == 0x01 {
        let entries = dict.ok_or_else(|| Error {
            code: ErrorCode::Unsupported,
            message: format!("{path}: dictionary column requires a profile for this leaf"),
        })?;
        let width = r.u8()?;
        if width > 14 {
            return err(
                ErrorCode::Marker,
                format!("{path}: dictionary width {width} exceeds 14"),
            );
        }
        let codes = unpack_bits(r, count, width, path)?;
        for (i, code) in codes.into_iter().enumerate() {
            if code == 0 {
                out.push(read_string_literal(r, limits, path, i)?);
                continue;
            }
            let index = code
                .checked_sub(1)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}[{i}]: dictionary code {code} out of range"),
                })?;
            let entry = entries.get(index).ok_or_else(|| Error {
                code: ErrorCode::Range,
                message: format!("{path}[{i}]: dictionary code {code} out of range"),
            })?;
            out.push(check_reconstructed_string(entry.clone(), limits, path, i)?);
        }
        return Ok(out);
    }

    if mode == 0x03 {
        let grammar = grammar.ok_or_else(|| Error {
            code: ErrorCode::Unsupported,
            message: format!("{path}: grammar column requires a profile for this leaf"),
        })?;
        let (escaped, escape_count) = read_escapes(r, count, path)?;
        let matched_count = count.checked_sub(escape_count).ok_or_else(|| Error {
            code: ErrorCode::Range,
            message: format!("{path}: escape count exceeds participating row count"),
        })?;
        let mut lanes = Vec::new();
        for (lane_index, token) in grammar
            .iter()
            .filter_map(|token| match token {
                GrammarToken::Num(num) => Some(num),
                GrammarToken::Lit(_) => None,
            })
            .enumerate()
        {
            let limit = grammar_limit(token.base, token.len)?;
            let maximum = limit.checked_sub(1).ok_or_else(|| Error {
                code: ErrorCode::Ir,
                message: format!("{path}.lane[{lane_index}]: grammar bound is empty"),
            })?;
            let maximum = i64::try_from(maximum).map_err(|_| Error {
                code: ErrorCode::Ir,
                message: format!(
                    "{path}.lane[{lane_index}]: grammar bound exceeds the v0 integer domain"
                ),
            })?;
            lanes.push(dec_int_column(
                r,
                Some(0),
                Some(maximum),
                matched_count,
                &format!("{path}.lane[{lane_index}]"),
            )?);
        }
        let mut matched = 0usize;
        for (i, is_escaped) in escaped.iter().copied().enumerate() {
            if is_escaped {
                out.push(read_string_literal(r, limits, path, i)?);
                continue;
            }
            let mut values = Vec::with_capacity(lanes.len());
            for lane in &lanes {
                let value = *lane.get(matched).ok_or_else(|| Error {
                    code: ErrorCode::Truncated,
                    message: format!(
                        "{path}[{i}]: grammar lane is shorter than the matched row count"
                    ),
                })?;
                values.push(u64::try_from(value).map_err(|_| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}[{i}]: grammar lane value is negative"),
                })?);
            }
            out.push(check_reconstructed_string(
                render_grammar(grammar, &values)?,
                limits,
                path,
                i,
            )?);
            matched += 1;
        }
        return Ok(out);
    }

    if mode == 0x04 {
        let derivation = derivation.ok_or_else(|| Error {
            code: ErrorCode::Unsupported,
            message: format!("{path}: derived column requires a profile for this leaf"),
        })?;
        let (escaped, _) = read_escapes(r, count, path)?;
        let source_codes = all_codes.get(&derivation.source);
        for (i, is_escaped) in escaped.iter().copied().enumerate() {
            if is_escaped {
                out.push(read_string_literal(r, limits, path, i)?);
                continue;
            }
            let row = *slots.get(i).ok_or_else(|| Error {
                code: ErrorCode::Range,
                message: format!("{path}[{i}]: missing array row for derived value"),
            })?;
            let source = decoded_source_value(decoded, ordinal_base, derivation.source, row)
                .ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!(
                        "{path}[{i}]: derived source does not participate in this array row"
                    ),
                })?;
            let Value::Str(source) = source else {
                return err(
                    ErrorCode::Range,
                    format!("{path}[{i}]: derived source does not participate in this array row"),
                );
            };
            let code = source_codes
                .and_then(|codes| codes.get(source))
                .copied()
                .ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!("{path}[{i}]: derived source value is outside its dictionary"),
                })?;
            let index = code
                .checked_sub(1)
                .and_then(|value| usize::try_from(value).ok())
                .ok_or_else(|| Error {
                    code: ErrorCode::Range,
                    message: format!(
                        "{path}[{i}]: derived dictionary code is outside the host size domain"
                    ),
                })?;
            let value = derivation.values.get(index).ok_or_else(|| Error {
                code: ErrorCode::Range,
                message: format!("{path}[{i}]: derived dictionary code is outside the mapping"),
            })?;
            out.push(check_reconstructed_string(value.clone(), limits, path, i)?);
        }
        return Ok(out);
    }

    let mut lengths = Vec::with_capacity(count);
    let mut total = 0u64;
    for i in 0..count {
        let len = read_uleb(r)?;
        if len > limits.max_byte_length {
            return err(
                ErrorCode::Limit,
                format!("{path}[{i}]: string length exceeds limit"),
            );
        }
        total = total.checked_add(len).ok_or_else(|| Error {
            code: ErrorCode::Limit,
            message: format!("{path}: packed column total overflows exact arithmetic"),
        })?;
        if total > limits.max_byte_length {
            return err(
                ErrorCode::Limit,
                format!("{path}: packed column total exceeds limit"),
            );
        }
        lengths.push(usize::try_from(len).map_err(|_| Error {
            code: ErrorCode::Limit,
            message: format!("{path}[{i}]: string length exceeds the host size domain"),
        })?);
    }
    let blob_len = read_uleb(r)?;
    if blob_len > limits.max_byte_length {
        return err(
            ErrorCode::Limit,
            format!("{path}: packed blob exceeds limit"),
        );
    }
    let blob_len = usize::try_from(blob_len).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!("{path}: packed blob exceeds the host size domain"),
    })?;
    let blob = r.take(blob_len)?;
    if !pack {
        return err(
            ErrorCode::Unsupported,
            format!("{path}: packed string column requires an inflate hook"),
        );
    }
    let expected = usize::try_from(total).map_err(|_| Error {
        code: ErrorCode::Limit,
        message: format!("{path}: packed output exceeds the host size domain"),
    })?;
    let inflated = inflate_exact(blob, expected).map_err(|_| Error {
        code: ErrorCode::Packed,
        message: format!("{path}: packed blob failed to inflate or has trailing bytes"),
    })?;
    let mut offset = 0usize;
    for (i, len) in lengths.into_iter().enumerate() {
        let end = offset.checked_add(len).ok_or_else(|| Error {
            code: ErrorCode::Packed,
            message: format!("{path}[{i}]: packed slice offset overflow"),
        })?;
        let slice = inflated.get(offset..end).ok_or_else(|| Error {
            code: ErrorCode::Packed,
            message: format!("{path}[{i}]: packed slice exceeds inflated output"),
        })?;
        out.push(decode_utf8(slice, path, i)?);
        offset = end;
    }
    Ok(out)
}
