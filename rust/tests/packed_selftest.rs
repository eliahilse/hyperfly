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
