use crate::wire::{err, ErrorCode, Result, INT_MAX, INT_MIN};
use sha2::{Digest, Sha256};

/// A schema constant that occupies no body bytes.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Literal {
    /// The null value.
    Null,
    /// A fixed boolean.
    Bool(bool),
    /// A fixed integer in the [`INT_MIN`] to [`INT_MAX`] domain.
    Int(i64),
    /// A fixed UTF-8 string.
    Str(String),
}

/// A schema node; struct fields and enum members retain their declared order.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A boolean.
    Bool,
    /// A JSON-safe integer with optional inclusive bounds.
    Int {
        /// Inclusive lower bound; `None` permits values down to [`INT_MIN`].
        min: Option<i64>,
        /// Inclusive upper bound; `None` permits values up to [`INT_MAX`].
        max: Option<i64>,
    },
    /// A finite IEEE 754 binary64 number; encoding normalizes negative zero.
    Float64,
    /// A length-prefixed UTF-8 string.
    Str,
    /// Length-prefixed raw bytes.
    Bytes,
    /// A constant value with no body payload.
    Literal(Literal),
    /// Unique, nonempty string members indexed in declared order.
    Enum(Vec<String>),
    /// Null or an inner value; nested nullable nodes and nullable null literals are invalid.
    Nullable(Box<Node>),
    /// An ordered sequence of values of one type.
    Array {
        /// The schema of each element.
        element: Box<Node>,
        /// Exact element count, or `None` for a count carried in the body.
        length: Option<u64>,
    },
    /// An object whose fields are encoded in declared order.
    Struct(Vec<Field>),
}

/// A named struct field with independent absence and null permissions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// Unique, nonempty name; `__proto__` and decimal array indices below `2^32 - 1` are invalid.
    pub name: String,
    /// The schema used for a present, non-null value.
    pub ty: Node,
    /// Whether the field may be absent; false makes it required.
    pub optional: bool,
    /// Whether a present field may be null via the struct's null bitmap.
    /// Cannot wrap a nullable node or a null literal.
    pub nullable: bool,
}

fn portable_field_name(name: &str) -> bool {
    if name == "__proto__" {
        return false;
    }
    let is_index = !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_digit())
        && (name == "0" || name.as_bytes()[0] != b'0')
        && name
            .parse::<u64>()
            .map(|n| n < 0xffff_ffff)
            .unwrap_or(false);
    !is_index
}

pub fn validate(node: &Node, path: &str) -> Result<()> {
    match node {
        Node::Bool | Node::Float64 | Node::Str | Node::Bytes => Ok(()),
        Node::Int { min, max } => {
            if let Some(lo) = min {
                if *lo < INT_MIN || *lo > INT_MAX {
                    return err(
                        ErrorCode::Ir,
                        format!("{path}: int min outside the v0 domain"),
                    );
                }
            }
            if let Some(hi) = max {
                if *hi < INT_MIN || *hi > INT_MAX {
                    return err(
                        ErrorCode::Ir,
                        format!("{path}: int max outside the v0 domain"),
                    );
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
                return err(
                    ErrorCode::Ir,
                    format!("{path}: literal outside the v0 domain"),
                );
            }
            Ok(())
        }
        Node::Literal(_) => Ok(()),
        Node::Enum(members) => {
            if members.is_empty() {
                return err(
                    ErrorCode::Ir,
                    format!("{path}: enum needs at least one member"),
                );
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
                return err(
                    ErrorCode::Ir,
                    format!("{path}: nullable(nullable) is invalid"),
                );
            }
            if matches!(**inner, Node::Literal(Literal::Null)) {
                return err(
                    ErrorCode::Ir,
                    format!("{path}: nullable(literal null) has two encodings for null"),
                );
            }
            validate(inner, &format!("{path}?"))
        }
        Node::Array { element, length } => {
            if let Some(n) = length {
                if *n > INT_MAX as u64 {
                    return err(
                        ErrorCode::Ir,
                        format!("{path}: fixed array length outside the v0 domain"),
                    );
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
                    return err(
                        ErrorCode::Ir,
                        format!("{path}.{}: field name is not portable", f.name),
                    );
                }
                if f.nullable && matches!(f.ty, Node::Nullable(_)) {
                    return err(
                        ErrorCode::Ir,
                        format!("{path}.{}: nullable flag on a nullable type", f.name),
                    );
                }
                if f.nullable && matches!(f.ty, Node::Literal(Literal::Null)) {
                    return err(
                        ErrorCode::Ir,
                        format!(
                            "{path}.{}: nullable flag on a null literal has two encodings for null",
                            f.name
                        ),
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

/// Appends canonical schema JSON to `out`, preserving declared field and member order.
/// Does not validate `node`; use [`crate::Codec::compile`] to validate a schema.
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

/// The body layout included in the canonical artifact and fingerprint.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Plan {
    /// Row layout version 1.
    Row,
    /// Columnar layout version 5 for eligible arrays of structs, with row fallback elsewhere.
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
            Plan::Columnar => 5,
        }
    }
}

/// Maximum entries per profile string dictionary: 16383 (14-bit nonzero codes).
pub const MAX_DICT_ENTRIES: usize = 16383;

/// Exact ASCII letter case used to match and render grammar digits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GrammarCase {
    /// Lowercase letters; required for base 10.
    Lower,
    /// Uppercase letters for base 16 or 36.
    Upper,
}

impl GrammarCase {
    /// Returns the canonical profile spelling, `"lower"` or `"upper"`.
    pub fn as_str(self) -> &'static str {
        match self {
            GrammarCase::Lower => "lower",
            GrammarCase::Upper => "upper",
        }
    }
}

/// An unsigned grammar number rendered with an exact, zero-padded digit width.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrammarNum {
    /// Radix: 10, 16, or 36.
    pub base: u32,
    /// Digit count, at least 1; maximum 15 for base 10, 13 for base 16, or 10 for base 36.
    pub len: u32,
    /// Exact digit case; base 10 requires [`GrammarCase::Lower`].
    pub case: GrammarCase,
}

/// One token in a string grammar, matched in sequence without case folding.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrammarToken {
    /// A nonempty verbatim string; adjacent literal tokens are invalid.
    Lit(String),
    /// A fixed-width numeric lane.
    Num(GrammarNum),
}

/// A string mapping indexed by another column's dictionary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derivation {
    /// Earlier string column ordinal in the same eligible array; must have a profile dictionary.
    pub source: usize,
    /// Derived strings at the source dictionary's indices; lengths must match, duplicates are allowed.
    pub values: Vec<String>,
}

/// Decode-critical knowledge for one string column; at least one coding option is required.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileColumn {
    /// Zero-based leaf ordinal from a depth-first schema walk in declared order.
    /// Each eligible array contributes its flattened leaves without further descent.
    pub leaf: usize,
    /// Optional dictionary of 1 to [`MAX_DICT_ENTRIES`] unique strings, in code order.
    pub dict: Option<Vec<String>>,
    /// Optional sequence of 1 to 8 tokens, including at least one numeric token.
    pub grammar: Option<Vec<GrammarToken>>,
    /// Optional mapping from an earlier column's dictionary to this column's values.
    pub derived: Option<Derivation>,
}

impl ProfileColumn {
    /// Returns an entry for string leaf ordinal `leaf` with no coding options set.
    pub fn new(leaf: usize) -> ProfileColumn {
        ProfileColumn {
            leaf,
            dict: None,
            grammar: None,
            derived: None,
        }
    }

    /// Sets the dictionary.
    pub fn with_dict(mut self, dict: Vec<String>) -> Self {
        self.dict = Some(dict);
        self
    }

    /// Sets the grammar.
    pub fn with_grammar(mut self, grammar: Vec<GrammarToken>) -> Self {
        self.grammar = Some(grammar);
        self
    }

    /// Sets the derivation.
    pub fn with_derived(mut self, derived: Derivation) -> Self {
        self.derived = Some(derived);
        self
    }
}

/// A columnar profile whose column content is embedded in the canonical artifact.
///
/// ```
/// use hyperfly_core::{Codec, CompileOptions, Field, Node, Plan, Profile, ProfileColumn, Value};
///
/// let ir = Node::Array {
///     element: Box::new(Node::Struct(vec![Field {
///         name: "status".into(),
///         ty: Node::Str,
///         optional: false,
///         nullable: false,
///     }])),
///     length: None,
/// };
/// let profile = Profile::new(
///     1,
///     vec![ProfileColumn::new(0).with_dict(vec!["active".into(), "paused".into()])],
/// );
/// let options = CompileOptions::new().with_plan(Plan::Columnar);
/// let plain = Codec::compile(ir.clone(), options.clone())?;
/// let codec = Codec::compile(ir, options.with_profile(profile))?;
///
/// let value = Value::Array(vec![
///     Value::Object(vec![("status".into(), Value::Str("active".into()))]),
///     Value::Object(vec![("status".into(), Value::Str("paused".into()))]),
/// ]);
/// assert_eq!(codec.decode(&codec.encode(&value)?)?, value);
/// assert_ne!(codec.fingerprint(), plain.fingerprint());
/// # Ok::<(), hyperfly_core::Error>(())
/// ```
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// Profile version: 1 permits dictionaries only; 2 also permits grammars and derivations.
    pub version: u32,
    /// Nonempty column entries sorted by unique, ascending string leaf ordinal.
    pub columns: Vec<ProfileColumn>,
}

impl Profile {
    /// Returns a profile with `version` and `columns`; [`crate::Codec::compile`] validates it.
    pub fn new(version: u32, columns: Vec<ProfileColumn>) -> Profile {
        Profile { version, columns }
    }
}

pub fn serialize_shared(profile: &Profile, out: &mut String) {
    out.push_str(r#"{"columns":["#);
    for (i, c) in profile.columns.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(r#"{{"leaf":{}"#, c.leaf));
        if let Some(dict) = &c.dict {
            out.push_str(r#","dict":["#);
            for (j, entry) in dict.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                esc(entry, out);
            }
            out.push(']');
        }
        if let Some(grammar) = &c.grammar {
            out.push_str(r#","grammar":["#);
            for (j, token) in grammar.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                match token {
                    GrammarToken::Lit(lit) => {
                        out.push_str(r#"{"lit":"#);
                        esc(lit, out);
                        out.push('}');
                    }
                    GrammarToken::Num(num) => {
                        out.push_str(&format!(
                            r#"{{"num":{{"base":{},"len":{},"case":"#,
                            num.base, num.len
                        ));
                        esc(num.case.as_str(), out);
                        out.push_str("}}");
                    }
                }
            }
            out.push(']');
        }
        if let Some(derived) = &c.derived {
            out.push_str(&format!(
                r#","derived":{{"source":{},"values":["#,
                derived.source
            ));
            for (j, value) in derived.values.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                esc(value, out);
            }
            out.push_str("]}");
        }
        out.push('}');
    }
    out.push_str("]}");
}

/// Returns canonical JSON for wire major 1, `plan`, `ir`, and optional shared profile content.
/// Profile version is not serialized. Does not validate inputs; use
/// [`crate::Codec::compile`] to validate them.
pub fn serialize_artifact(ir: &Node, plan: Plan, profile: Option<&Profile>) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        r#"{{"wire":1,"plan":{{"layout":"{}","version":{}}},"ir":"#,
        plan.layout(),
        plan.version()
    ));
    serialize_node(ir, &mut out);
    if let Some(p) = profile {
        out.push_str(r#","profile":"#);
        serialize_shared(p, &mut out);
    }
    out.push('}');
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ColumnRef {
    pub kind: &'static str,
    pub array: usize,
}

/// Spec 6.1: every columnar leaf in ordinal order, including its owning array.
pub fn enumerate_columns(ir: &Node) -> Vec<ColumnRef> {
    let mut out = Vec::new();
    let mut next_array = 0;
    walk_columns(ir, &mut out, &mut next_array);
    out
}

/// Columnar leaves under this node. A pure function of the subtree, so two schema
/// positions sharing one node still count the same — which is why column bases are
/// threaded positionally rather than looked up by node identity.
pub fn column_count(node: &Node) -> usize {
    let mut out = Vec::new();
    let mut next_array = 0;
    walk_columns(node, &mut out, &mut next_array);
    out.len()
}

fn walk_columns(node: &Node, out: &mut Vec<ColumnRef>, next_array: &mut usize) {
    match node {
        Node::Array { element, .. } => {
            if let Node::Struct(fields) = &**element {
                let mut leaves = Vec::new();
                let mut segs = Vec::new();
                if crate::codec::flatten_for_profile(fields, &mut segs, &mut leaves) {
                    let array = *next_array;
                    *next_array = next_array.saturating_add(1);
                    for kind in leaves {
                        out.push(ColumnRef { kind, array });
                    }
                    return;
                }
            }
            walk_columns(element, out, next_array);
        }
        Node::Nullable(inner) => walk_columns(inner, out, next_array),
        Node::Struct(fields) => {
            for f in fields {
                walk_columns(&f.ty, out, next_array);
            }
        }
        _ => {}
    }
}

pub fn validate_profile(ir: &Node, profile: &Profile) -> Result<()> {
    if profile.version != 1 && profile.version != 2 {
        return err(
            ErrorCode::Ir,
            format!("profile: unsupported profile version {}", profile.version),
        );
    }
    if profile.columns.is_empty() {
        return err(ErrorCode::Ir, "profile: shared.columns must be non-empty");
    }

    let schema_columns = enumerate_columns(ir);
    let mut previous = None;
    for column in &profile.columns {
        if column.leaf >= schema_columns.len() {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {} is not a column in this schema",
                    column.leaf
                ),
            );
        }
        if previous.is_some_and(|leaf| column.leaf <= leaf) {
            return err(
                ErrorCode::Ir,
                "profile: columns must be sorted by ascending leaf and unique",
            );
        }
        previous = Some(column.leaf);
        if schema_columns[column.leaf].kind != "string" {
            return err(
                ErrorCode::Ir,
                format!("profile: leaf {} is not a string column", column.leaf),
            );
        }

        if profile.version == 1 {
            if column.dict.is_none() || column.grammar.is_some() || column.derived.is_some() {
                return err(
                    ErrorCode::Ir,
                    "profile: version 1 columns must contain leaf and dict only",
                );
            }
        } else if column.dict.is_none() && column.grammar.is_none() && column.derived.is_none() {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {} must carry at least one of dict, grammar, or derived",
                    column.leaf
                ),
            );
        }

        if let Some(dict) = &column.dict {
            if dict.is_empty() || dict.len() > MAX_DICT_ENTRIES {
                return err(
                    ErrorCode::Ir,
                    format!(
                        "profile: leaf {}: a dictionary holds 1 to {MAX_DICT_ENTRIES} entries",
                        column.leaf
                    ),
                );
            }
            let mut seen = std::collections::HashSet::new();
            for entry in dict {
                if !seen.insert(entry) {
                    return err(
                        ErrorCode::Ir,
                        format!(
                            "profile: leaf {}: duplicate entry gives one value two codes",
                            column.leaf
                        ),
                    );
                }
            }
        }

        if let Some(grammar) = &column.grammar {
            if grammar.is_empty() || grammar.len() > 8 {
                return err(
                    ErrorCode::Ir,
                    format!(
                        "profile: leaf {}: grammar must hold 1 to 8 tokens",
                        column.leaf
                    ),
                );
            }
            let mut numeric = 0;
            let mut previous_literal = false;
            for token in grammar {
                match token {
                    GrammarToken::Lit(lit) => {
                        if lit.is_empty() {
                            return err(
                                ErrorCode::Ir,
                                format!("profile: leaf {}: literal token is empty", column.leaf),
                            );
                        }
                        if previous_literal {
                            return err(
                                ErrorCode::Ir,
                                format!("profile: leaf {}: grammar cannot contain adjacent literal tokens", column.leaf),
                            );
                        }
                        previous_literal = true;
                    }
                    GrammarToken::Num(num) => {
                        let cap = match num.base {
                            10 => 15,
                            16 => 13,
                            36 => 10,
                            _ => {
                                return err(
                                    ErrorCode::Ir,
                                    format!(
                                        "profile: leaf {}: grammar base must be 10, 16, or 36",
                                        column.leaf
                                    ),
                                )
                            }
                        };
                        if num.len == 0 || num.len > cap {
                            return err(
                                ErrorCode::Ir,
                                format!(
                                    "profile: leaf {}: grammar length must be between 1 and {cap} for base {}",
                                    column.leaf, num.base
                                ),
                            );
                        }
                        if num.base == 10 && num.case != GrammarCase::Lower {
                            return err(
                                ErrorCode::Ir,
                                format!(
                                    "profile: leaf {}: base 10 grammar case must be lower",
                                    column.leaf
                                ),
                            );
                        }
                        numeric += 1;
                        previous_literal = false;
                    }
                }
            }
            if numeric == 0 {
                return err(
                    ErrorCode::Ir,
                    format!(
                        "profile: leaf {}: grammar needs at least one numeric token",
                        column.leaf
                    ),
                );
            }
        }
    }

    let by_leaf: std::collections::HashMap<usize, &ProfileColumn> = profile
        .columns
        .iter()
        .map(|column| (column.leaf, column))
        .collect();
    for column in &profile.columns {
        let Some(derived) = &column.derived else {
            continue;
        };
        let Some(source_schema) = schema_columns.get(derived.source) else {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived source {} is not a string column",
                    column.leaf, derived.source
                ),
            );
        };
        if source_schema.kind != "string" {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived source {} is not a string column",
                    column.leaf, derived.source
                ),
            );
        }
        if derived.source >= column.leaf {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived source must be earlier than the target",
                    column.leaf
                ),
            );
        }
        if source_schema.array != schema_columns[column.leaf].array {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived source must belong to the same eligible array",
                    column.leaf
                ),
            );
        }
        let source_dict = by_leaf
            .get(&derived.source)
            .and_then(|source| source.dict.as_ref());
        let Some(source_dict) = source_dict else {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived source {} must have a dictionary in the profile",
                    column.leaf, derived.source
                ),
            );
        };
        if derived.values.len() != source_dict.len() {
            return err(
                ErrorCode::Ir,
                format!(
                    "profile: leaf {}: derived values length must equal source dictionary length {}",
                    column.leaf,
                    source_dict.len()
                ),
            );
        }
    }
    Ok(())
}

/// Returns the first 16 bytes of SHA-256 over `artifact`'s UTF-8 bytes.
/// Does not parse or validate the text; derive it locally with [`serialize_artifact`].
pub fn fingerprint_of(artifact: &str) -> [u8; 16] {
    let digest = Sha256::digest(artifact.as_bytes());
    let mut fp = [0u8; 16];
    fp.copy_from_slice(&digest[..16]);
    fp
}

/// Whether one element of this type always consumes at least one bit on the wire.
pub fn has_payload(node: &Node) -> bool {
    match node {
        Node::Literal(_) => false,
        Node::Struct(fields) => fields
            .iter()
            .any(|f| f.optional || f.nullable || has_payload(&f.ty)),
        Node::Array { length: None, .. } => true,
        Node::Array {
            element,
            length: Some(n),
        } => *n > 0 && has_payload(element),
        _ => true,
    }
}
