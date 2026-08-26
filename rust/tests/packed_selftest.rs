use hyperfly_core::{Codec, Field, Limits, Node, Plan, Value};

#[test]
fn packed_column_roundtrips_through_own_encoder() {
    let ir = Node::Struct(vec![Field {
        name: "rows".into(),
        ty: Node::Array {
            element: Box::new(Node::Struct(vec![Field {
                name: "body".into(),
                ty: Node::Str,
                optional: false,
                nullable: false,
            }])),
            length: None,
        },
        optional: false,
        nullable: false,
    }]);
    let codec = Codec::compile(ir, Plan::Columnar, Limits::default(), true).unwrap();
    let rows: Vec<Value> = (0..40)
        .map(|i| {
            Value::Object(vec![(
                "body".into(),
                Value::Str(format!(
                    "the quick brown fox files report {i} about the same fox again"
                )),
            )])
        })
        .collect();
    let value = Value::Object(vec![("rows".into(), Value::Array(rows))]);
    let encoded = codec.encode_body(&value).expect("encode");
    let decoded = codec.decode_body(&encoded).expect("decode own output");
    assert_eq!(decoded, value);
}

#[test]
fn codec_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Codec>();
}

#[test]
fn amplification_limit_bounds_zero_byte_columns() {
    use hyperfly_core::Literal;

    let ir = Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "tag".into(),
            ty: Node::Literal(Literal::Str("fixed".into())),
            optional: false,
            nullable: false,
        }])),
        length: None,
    };
    let limits = Limits {
        max_amplification: 4,
        ..Limits::default()
    };
    let codec = Codec::compile(ir, Plan::Columnar, limits, false).unwrap();
    let row = || Value::Object(vec![("tag".into(), Value::Str("fixed".into()))]);

    let accepted = Value::Array((0..4).map(|_| row()).collect());
    assert_eq!(codec.encode_body(&accepted).unwrap(), vec![4]);
    assert_eq!(codec.decode_body(&[4]).unwrap(), accepted);

    let rejected = Value::Array((0..5).map(|_| row()).collect());
    assert_eq!(
        codec.encode_body(&rejected).unwrap_err().code.as_str(),
        "limit"
    );
    assert_eq!(codec.decode_body(&[5]).unwrap_err().code.as_str(), "limit");
}

#[test]
fn reconstructed_profile_strings_obey_byte_limit() {
    use hyperfly_core::ir::{
        Derivation, GrammarCase, GrammarNum, GrammarToken, Profile, ProfileColumn,
    };

    let string_array = |fields: Vec<Field>| Node::Array {
        element: Box::new(Node::Struct(fields)),
        length: None,
    };
    let string_field = |name: &str| Field {
        name: name.into(),
        ty: Node::Str,
        optional: false,
        nullable: false,
    };
    let limits = Limits {
        max_byte_length: 3,
        ..Limits::default()
    };

    let dict = Profile {
        version: 1,
        columns: vec![ProfileColumn {
            leaf: 0,
            dict: Some(vec!["long".into()]),
            grammar: None,
            derived: None,
        }],
    };
    let codec = Codec::compile_with_profile(
        string_array(vec![string_field("s")]),
        Plan::Columnar,
        limits,
        false,
        Some(dict),
    )
    .unwrap();
    assert_eq!(
        codec.decode_body(&[1, 1, 1, 1]).unwrap_err().code.as_str(),
        "limit"
    );

    let grammar = Profile {
        version: 2,
        columns: vec![ProfileColumn {
            leaf: 0,
            dict: None,
            grammar: Some(vec![
                GrammarToken::Lit("xxxx".into()),
                GrammarToken::Num(GrammarNum {
                    base: 10,
                    len: 1,
                    case: GrammarCase::Lower,
                }),
            ]),
            derived: None,
        }],
    };
    let codec = Codec::compile_with_profile(
        string_array(vec![string_field("s")]),
        Plan::Columnar,
        limits,
        false,
        Some(grammar),
    )
    .unwrap();
    assert_eq!(
        codec
            .decode_body(&[1, 3, 0, 0, 0])
            .unwrap_err()
            .code
            .as_str(),
        "limit"
    );

    let derived = Profile {
        version: 2,
        columns: vec![
            ProfileColumn {
                leaf: 0,
                dict: Some(vec!["u".into()]),
                grammar: None,
                derived: None,
            },
            ProfileColumn {
                leaf: 1,
                dict: None,
                grammar: None,
                derived: Some(Derivation {
                    source: 0,
                    values: vec!["long".into()],
                }),
            },
        ],
    };
    let codec = Codec::compile_with_profile(
        string_array(vec![string_field("source"), string_field("target")]),
        Plan::Columnar,
        limits,
        false,
        Some(derived),
    )
    .unwrap();
    assert_eq!(
        codec
            .decode_body(&[1, 0, 1, b'u', 4, 0])
            .unwrap_err()
            .code
            .as_str(),
        "limit"
    );
}

/// Two schema positions sharing one array node must still get distinct column ordinals.
#[test]
fn aliased_array_nodes_get_distinct_ordinals() {
    use hyperfly_core::ir::{Profile, ProfileColumn};

    let arr = Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "s".into(),
            ty: Node::Str,
            optional: false,
            nullable: false,
        }])),
        length: None,
    };
    let ir = Node::Struct(vec![
        Field {
            name: "a".into(),
            ty: arr.clone(),
            optional: false,
            nullable: false,
        },
        Field {
            name: "b".into(),
            ty: arr,
            optional: false,
            nullable: false,
        },
    ]);
    let profile = Profile {
        version: 1,
        columns: vec![
            ProfileColumn {
                leaf: 0,
                dict: Some(vec!["red".into(), "green".into()]),
                grammar: None,
                derived: None,
            },
            ProfileColumn {
                leaf: 1,
                dict: Some(vec!["green".into(), "red".into()]),
                grammar: None,
                derived: None,
            },
        ],
    };
    let codec =
        Codec::compile_with_profile(ir, Plan::Columnar, Limits::default(), false, Some(profile))
            .unwrap();
    let row = |s: &str| {
        Value::Array(vec![Value::Object(vec![(
            "s".into(),
            Value::Str(s.into()),
        )])])
    };
    let value = Value::Object(vec![("a".into(), row("red")), ("b".into(), row("red"))]);
    let encoded = codec.encode_body(&value).unwrap();
    // "red" is code 1 in leaf 0 and code 2 in leaf 1
    assert_eq!(to_hex(&encoded), "0101010101010202");
    assert_eq!(codec.decode_body(&encoded).unwrap(), value);
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
