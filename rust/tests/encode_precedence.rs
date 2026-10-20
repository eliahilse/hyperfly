use hyperfly_core::{Codec, CompileOptions, ErrorCode, Field, Limits, Node, Plan, Value};

fn column(ty: Node) -> Node {
    Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "s".into(),
            ty,
            optional: false,
            nullable: false,
        }])),
        length: None,
    }
}

fn rows(values: Vec<Value>) -> Value {
    Value::Array(
        values
            .into_iter()
            .map(|v| Value::Object(vec![("s".into(), v)]))
            .collect(),
    )
}

fn encode_err(ty: Node, plan: Plan, limits: Limits, value: &Value) -> (ErrorCode, String) {
    let codec = Codec::compile(
        column(ty),
        CompileOptions::new().with_plan(plan).with_limits(limits),
    )
    .unwrap();
    let e = codec.encode_body(value).unwrap_err();
    (e.code(), e.message().to_string())
}

fn byte_length(max: u64) -> Limits {
    let mut limits = Limits::default();
    limits.max_byte_length = max;
    limits
}

fn total_bytes(max: u64) -> Limits {
    let mut limits = Limits::default();
    limits.max_total_bytes = max;
    limits
}

#[test]
fn string_column_reports_an_earlier_length_failure_before_a_later_type_failure() {
    let value = rows(vec![Value::Str("abcdefgh".into()), Value::Int(1)]);
    let (code, message) = encode_err(Node::Str, Plan::Columnar, byte_length(5), &value);
    assert_eq!(code, ErrorCode::Limit);
    assert_eq!(message, "$[].s[0]: string length exceeds limit");
}

#[test]
fn string_column_reports_an_earlier_budget_failure_before_a_later_type_failure() {
    let value = rows(vec![Value::Str("abcdefgh".into()), Value::Int(1)]);
    let (code, message) = encode_err(Node::Str, Plan::Columnar, total_bytes(4), &value);
    assert_eq!(code, ErrorCode::Limit);
    assert_eq!(message, "$[].s[0]: byte budget exceeded");
}

#[test]
fn string_column_reports_an_earlier_type_failure_before_a_later_length_failure() {
    let value = rows(vec![Value::Int(1), Value::Str("abcdefgh".into())]);
    let (code, message) = encode_err(Node::Str, Plan::Columnar, byte_length(5), &value);
    assert_eq!(code, ErrorCode::Type);
    assert_eq!(message, "$[].s[0]: expected string");
    let (code, _) = encode_err(Node::Str, Plan::Columnar, total_bytes(4), &value);
    assert_eq!(code, ErrorCode::Type);
}

#[test]
fn row_plan_reports_the_earlier_length_failure() {
    let value = rows(vec![Value::Str("abcdefgh".into()), Value::Int(1)]);
    let (code, _) = encode_err(Node::Str, Plan::Row, byte_length(5), &value);
    assert_eq!(code, ErrorCode::Limit);
}

#[test]
fn enum_column_reports_an_earlier_budget_failure_before_a_later_non_member() {
    let ty = Node::Enum(vec!["abcdefgh".into(), "b".into()]);
    let value = rows(vec![Value::Str("abcdefgh".into()), Value::Str("zz".into())]);
    let (code, message) = encode_err(ty.clone(), Plan::Columnar, total_bytes(4), &value);
    assert_eq!(code, ErrorCode::Limit);
    assert_eq!(message, "$[].s[0]: byte budget exceeded");
    let value = rows(vec![Value::Str("zz".into()), Value::Str("abcdefgh".into())]);
    let (code, message) = encode_err(ty, Plan::Columnar, total_bytes(4), &value);
    assert_eq!(code, ErrorCode::Type);
    assert_eq!(message, "$[].s[0]: not an enum member");
}

#[test]
fn array_reports_amplification_before_the_one_bit_floor() {
    let ir = Node::Array {
        element: Box::new(Node::Array {
            element: Box::new(Node::Struct(vec![Field {
                name: "e".into(),
                ty: Node::Enum(vec!["a".into()]),
                optional: false,
                nullable: false,
            }])),
            length: Some(1),
        }),
        length: None,
    };
    let mut limits = Limits::default();
    limits.max_amplification = 1;
    let codec = Codec::compile(
        ir,
        CompileOptions::new()
            .with_plan(Plan::Columnar)
            .with_limits(limits),
    )
    .unwrap();
    let row = Value::Array(vec![Value::Object(vec![(
        "e".into(),
        Value::Str("a".into()),
    )])]);
    let e = codec
        .encode_body(&Value::Array(vec![row.clone(), row]))
        .unwrap_err();
    assert_eq!(e.code(), ErrorCode::Limit);
    assert_eq!(
        e.message(),
        "$: 2 rows in 0 payload byte(s) exceeds the amplification limit"
    );
}
