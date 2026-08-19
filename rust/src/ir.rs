use crate::wire::{err, ErrorCode, Result, INT_MAX, INT_MIN};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Bool,
    Int { min: Option<i64>, max: Option<i64> },
    Float64,
    Str,
    Bytes,
    Literal(Literal),
    Enum(Vec<String>),
    Nullable(Box<Node>),
    Array { element: Box<Node>, length: Option<u64> },
    Struct(Vec<Field>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    pub ty: Node,
    pub optional: bool,
    pub nullable: bool,
}

fn portable_field_name(name: &str) -> bool {
    if name == "__proto__" {
        return false;
    }
    let is_index = !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_digit())
        && (name == "0" || name.as_bytes()[0] != b'0')
        && name.parse::<u64>().map(|n| n < 0xffff_ffff).unwrap_or(false);
    !is_index
}

pub fn validate(node: &Node, path: &str) -> Result<()> {
    match node {
        Node::Bool | Node::Float64 | Node::Str | Node::Bytes => Ok(()),
        Node::Int { min, max } => {
            if let Some(lo) = min {
                if *lo < INT_MIN || *lo > INT_MAX {
                    return err(ErrorCode::Ir, format!("{path}: int min outside the v0 domain"));
                }
            }
            if let Some(hi) = max {
                if *hi < INT_MIN || *hi > INT_MAX {
                    return err(ErrorCode::Ir, format!("{path}: int max outside the v0 domain"));
                }
            }
            if let (Some(lo), Some(hi)) = (min, max) {
                if lo > hi {
                    return err(ErrorCode::Ir, format!("{path}: int min exceeds max"));
                }
            }
            Ok(())
        }
        Node::Literal(Literal::Int(v)) => {
            if *v < INT_MIN || *v > INT_MAX {
                return err(ErrorCode::Ir, format!("{path}: literal outside the v0 domain"));
            }
            Ok(())
        }
        Node::Literal(_) => Ok(()),
        Node::Enum(members) => {
            if members.is_empty() {
                return err(ErrorCode::Ir, format!("{path}: enum needs at least one member"));
            }
            let mut seen = std::collections::HashSet::new();
            for m in members {
                if m.is_empty() || !seen.insert(m) {
                    return err(ErrorCode::Ir, format!("{path}: invalid enum members"));
                }
            }
            Ok(())
        }
        Node::Nullable(inner) => {
            if matches!(**inner, Node::Nullable(_)) {
                return err(ErrorCode::Ir, format!("{path}: nullable(nullable) is invalid"));
            }
            if matches!(**inner, Node::Literal(Literal::Null)) {
                return err(ErrorCode::Ir, format!("{path}: nullable(literal null) has two encodings for null"));
            }
            validate(inner, &format!("{path}?"))
        }
        Node::Array { element, length } => {
            if let Some(n) = length {
                if *n > INT_MAX as u64 {
                    return err(ErrorCode::Ir, format!("{path}: fixed array length outside the v0 domain"));
                }
            }
            validate(element, &format!("{path}[]"))
        }
        Node::Struct(fields) => {
            let mut seen = std::collections::HashSet::new();
            for f in fields {
                if f.name.is_empty() || !seen.insert(&f.name) {
                    return err(ErrorCode::Ir, format!("{path}: invalid field names"));
                }
                if !portable_field_name(&f.name) {
                    return err(ErrorCode::Ir, format!("{path}.{}: field name is not portable", f.name));
                }
                if f.nullable && matches!(f.ty, Node::Nullable(_)) {
                    return err(ErrorCode::Ir, format!("{path}.{}: nullable flag on a nullable type", f.name));
                }
                if f.nullable && matches!(f.ty, Node::Literal(Literal::Null)) {
                    return err(
                        ErrorCode::Ir,
                        format!("{path}.{}: nullable flag on a null literal has two encodings for null", f.name),
                    );
                }
                validate(&f.ty, &format!("{path}.{}", f.name))?;
            }
            Ok(())
        }
    }
}

fn esc(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u00{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn serialize_node(node: &Node, out: &mut String) {
    match node {
        Node::Bool => out.push_str(r#"{"kind":"bool"}"#),
        Node::Float64 => out.push_str(r#"{"kind":"float64"}"#),
        Node::Str => out.push_str(r#"{"kind":"string"}"#),
        Node::Bytes => out.push_str(r#"{"kind":"bytes"}"#),
        Node::Int { min, max } => {
            out.push_str(r#"{"kind":"int""#);
            if let Some(lo) = min {
                out.push_str(&format!(r#","min":{lo}"#));
            }
            if let Some(hi) = max {
                out.push_str(&format!(r#","max":{hi}"#));
            }
            out.push('}');
        }
        Node::Literal(v) => {
            out.push_str(r#"{"kind":"literal","value":"#);
            match v {
                Literal::Null => out.push_str("null"),
                Literal::Bool(true) => out.push_str("true"),
                Literal::Bool(false) => out.push_str("false"),
                Literal::Int(n) => out.push_str(&n.to_string()),
                Literal::Str(s) => esc(s, out),
            }
            out.push('}');
        }
        Node::Enum(members) => {
            out.push_str(r#"{"kind":"enum","members":["#);
            for (i, m) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                esc(m, out);
            }
            out.push_str("]}");
        }
        Node::Nullable(inner) => {
            out.push_str(r#"{"kind":"nullable","inner":"#);
            serialize_node(inner, out);
            out.push('}');
        }
        Node::Array { element, length } => {
            out.push_str(r#"{"kind":"array","element":"#);
            serialize_node(element, out);
            if let Some(n) = length {
                out.push_str(&format!(r#","length":{n}"#));
            }
            out.push('}');
        }
        Node::Struct(fields) => {
            out.push_str(r#"{"kind":"struct","fields":["#);
            for (i, f) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(r#"{"name":"#);
                esc(&f.name, out);
                out.push_str(r#","type":"#);
                serialize_node(&f.ty, out);
                if f.optional {
                    out.push_str(r#","optional":true"#);
                }
                if f.nullable {
                    out.push_str(r#","nullable":true"#);
                }
                out.push('}');
            }
            out.push_str("]}");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plan {
    Row,
    Columnar,
}

impl Plan {
    fn layout(self) -> &'static str {
        match self {
            Plan::Row => "row",
            Plan::Columnar => "columnar",
        }
    }

    fn version(self) -> u32 {
        match self {
            Plan::Row => 1,
            Plan::Columnar => 2,
        }
    }
}

pub fn serialize_artifact(ir: &Node, plan: Plan) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        r#"{{"wire":1,"plan":{{"layout":"{}","version":{}}},"ir":"#,
        plan.layout(),
        plan.version()
    ));
    serialize_node(ir, &mut out);
    out.push('}');
    out
}

pub fn fingerprint_of(artifact: &str) -> [u8; 16] {
    let digest = Sha256::digest(artifact.as_bytes());
    let mut fp = [0u8; 16];
    fp.copy_from_slice(&digest[..16]);
    fp
}
