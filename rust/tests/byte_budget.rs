use hyperfly_core::{
    Codec, ErrorCode, Field, GrammarCase, GrammarNum, GrammarToken, Limits, Literal, Node, Plan,
    Profile, ProfileColumn, Value,
};

fn field(name: &str, ty: Node) -> Field {
    Field {
        name: name.into(),
        ty,
        optional: false,
        nullable: false,
    }
}

fn column(ty: Node) -> Node {
    Node::Array {
        element: Box::new(Node::Struct(vec![field("v", ty)])),
        length: None,
    }
}

#[test]
fn byte_budget_checks_length_prefixes_before_payloads() {
    let limits = Limits {
        max_total_bytes: 1,
        ..Limits::default()
    };
    for ty in [Node::Str, Node::Bytes] {
        let codec = Codec::compile(ty.clone(), Plan::Row, limits, true).unwrap();
        assert_eq!(codec.decode_body(&[2]).unwrap_err().code, ErrorCode::Limit);
        assert_eq!(
            codec.decode_body(&[1]).unwrap_err().code,
            ErrorCode::Truncated
        );
        let body = if matches!(ty, Node::Str) {
            vec![1, 0, 2]
        } else {
            vec![1, 2]
        };
        let codec = Codec::compile(column(ty), Plan::Columnar, limits, true).unwrap();
        assert_eq!(codec.decode_body(&body).unwrap_err().code, ErrorCode::Limit);
    }
}

#[test]
fn enum_column_charges_members_in_row_order() {
    let limits = Limits {
        max_total_bytes: 15,
        ..Limits::default()
    };
    let ty = Node::Enum(vec!["abcdefghijklmnop".into(), "q".into(), "r".into()]);
    let codec = Codec::compile(column(ty), Plan::Columnar, limits, false).unwrap();
    assert_eq!(
        codec.decode_body(&[2, 0x0c]).unwrap_err().code,
        ErrorCode::Limit
    );
    assert_eq!(
        codec.decode_body(&[2, 0x03]).unwrap_err().code,
        ErrorCode::Range
    );
}

#[test]
fn grammar_column_checks_values_after_structure_in_row_order() {
    let profile = Profile {
        version: 2,
        columns: vec![ProfileColumn {
            leaf: 0,
            dict: None,
            grammar: Some(vec![
                GrammarToken::Lit("ord_".into()),
                GrammarToken::Num(GrammarNum {
                    base: 16,
                    len: 1,
                    case: GrammarCase::Lower,
                }),
            ]),
            derived: None,
        }],
    };
    let limits = Limits {
        max_total_bytes: 4,
        ..Limits::default()
    };
    let codec = Codec::compile_with_profile(
        column(Node::Str),
        Plan::Columnar,
        limits,
        false,
        Some(profile),
    )
    .unwrap();
    for lane in [
        vec![0, 0, 16],
        vec![1, 0, 32],
        vec![2, 0, 5, 0, 2],
        vec![3, 0, 32, 0],
        vec![4, 0, 0, 5, 2, 16],
    ] {
        let mut body = vec![2, 3, 0];
        body.extend(lane);
        assert_eq!(codec.decode_body(&body).unwrap_err().code, ErrorCode::Limit);
    }
    for (body, code) in [
        (&[2, 3, 0, 0, 16, 0][..], ErrorCode::Range),
        (&[2, 3, 0, 0, 16][..], ErrorCode::Truncated),
        (&[2, 3, 0, 2, 0, 5, 0, 0x80][..], ErrorCode::Bitmap),
        (&[2, 3, 1, 1, 0, 16, 1, 0xff][..], ErrorCode::Utf8),
    ] {
        assert_eq!(codec.decode_body(body).unwrap_err().code, code);
    }
}

#[test]
fn zero_byte_budget_accepts_empty_values_and_non_string_nodes() {
    let ir = Node::Struct(vec![
        field("a", Node::Literal(Literal::Null)),
        field("b", Node::Literal(Literal::Bool(true))),
        field("c", Node::Literal(Literal::Int(7))),
        field(
            "d",
            Node::Int {
                min: None,
                max: None,
            },
        ),
        field("e", Node::Bool),
        field("f", Node::Float64),
        field("g", Node::Str),
        field("h", Node::Bytes),
        field("i", Node::Literal(Literal::Str(String::new()))),
    ]);
    let value = Value::Object(vec![
        ("a".into(), Value::Null),
        ("b".into(), Value::Bool(true)),
        ("c".into(), Value::Int(7)),
        ("d".into(), Value::Int(42)),
        ("e".into(), Value::Bool(false)),
        ("f".into(), Value::Float(1.5)),
        ("g".into(), Value::Str(String::new())),
        ("h".into(), Value::Bytes(Vec::new())),
        ("i".into(), Value::Str(String::new())),
    ]);
    let limits = Limits {
        max_total_bytes: 0,
        max_byte_amplification: 0,
        ..Limits::default()
    };
    for plan in [Plan::Row, Plan::Columnar] {
        let codec = Codec::compile(ir.clone(), plan, limits, true).unwrap();
        let body = codec.encode_body(&value).unwrap();
        assert_eq!(codec.decode_body(&body).unwrap(), value);
        assert_eq!(codec.decode(&codec.encode(&value).unwrap()).unwrap(), value);
    }
}

#[test]
fn byte_amplification_arithmetic_saturates() {
    let limits = Limits {
        max_total_bytes: u64::MAX,
        max_byte_amplification: u64::MAX,
        ..Limits::default()
    };
    let codec = Codec::compile(Node::Str, Plan::Row, limits, false).unwrap();
    let value = Value::Str("a".into());
    assert_eq!(codec.encode_body(&value).unwrap(), [1, b'a']);
    assert_eq!(codec.decode_body(&[1, b'a']).unwrap(), value);
}
