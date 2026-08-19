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
                Value::Str(format!("the quick brown fox files report {i} about the same fox again")),
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
        Field { name: "a".into(), ty: arr.clone(), optional: false, nullable: false },
        Field { name: "b".into(), ty: arr, optional: false, nullable: false },
    ]);
    let profile = Profile {
        columns: vec![
            ProfileColumn { leaf: 0, dict: vec!["red".into(), "green".into()] },
            ProfileColumn { leaf: 1, dict: vec!["green".into(), "red".into()] },
        ],
    };
    let codec =
        Codec::compile_with_profile(ir, Plan::Columnar, Limits::default(), false, Some(profile)).unwrap();
    let row = |s: &str| Value::Array(vec![Value::Object(vec![("s".into(), Value::Str(s.into()))])]);
    let value = Value::Object(vec![("a".into(), row("red")), ("b".into(), row("red"))]);
    let encoded = codec.encode_body(&value).unwrap();
    // "red" is code 1 in leaf 0 and code 2 in leaf 1
    assert_eq!(to_hex(&encoded), "010101010102");
    assert_eq!(codec.decode_body(&encoded).unwrap(), value);
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
