use hyperfly_core::{Codec, CompileOptions, Error, ErrorCode, Field, Literal, Node, Plan, Value};

fn field(name: &str, ty: Node) -> Field {
    Field {
        name: name.into(),
        ty,
        optional: false,
        nullable: false,
    }
}

fn int(min: Option<i64>, max: Option<i64>) -> Node {
    Node::Int { min, max }
}

fn compile(ir: Node, plan: Plan) -> Codec {
    Codec::compile(ir, CompileOptions::new().with_plan(plan).with_pack(false)).unwrap()
}

fn code(error: Error) -> ErrorCode {
    error.code()
}

fn row(ty: Node) -> Codec {
    compile(Node::Struct(vec![field("v", ty)]), Plan::Row)
}

fn columnar(ty: Node) -> Codec {
    compile(
        Node::Array {
            element: Box::new(Node::Struct(vec![field("v", ty)])),
            length: None,
        },
        Plan::Columnar,
    )
}

fn object(value: Value) -> Value {
    Value::Object(vec![("v".into(), value)])
}

fn rows(values: &[Value]) -> Value {
    Value::Array(values.iter().cloned().map(object).collect())
}

type Wrap = fn(&[Value]) -> Value;

fn codecs(ty: Node) -> Vec<(Codec, Wrap)> {
    fn single(values: &[Value]) -> Value {
        object(values[0].clone())
    }
    vec![(row(ty.clone()), single), (columnar(ty), rows)]
}

const REJECTED: [f64; 6] = [
    1.5,
    f64::NAN,
    f64::INFINITY,
    f64::NEG_INFINITY,
    9007199254740992.0,
    -9007199254740992.0,
];

#[test]
fn integral_floats_encode_like_ints() {
    for ty in [int(None, None), int(Some(-5), Some(9007199254740991))] {
        for (codec, wrap) in codecs(ty) {
            for (float, int) in [
                (3.0, 3),
                (-0.0, 0),
                (0.0, 0),
                (9007199254740991.0, 9007199254740991),
            ] {
                let bytes = codec.encode(&wrap(&[Value::Float(float)])).unwrap();
                let expected = wrap(&[Value::Int(int)]);
                assert_eq!(bytes, codec.encode(&expected).unwrap());
                assert_eq!(codec.decode(&bytes).unwrap(), expected);
            }
        }
    }
}

#[test]
fn non_integral_or_unsafe_floats_are_type_errors() {
    for ty in [int(None, None), int(Some(-5), Some(5))] {
        for (codec, wrap) in codecs(ty) {
            for float in REJECTED {
                let error = codec.encode(&wrap(&[Value::Float(float)])).unwrap_err();
                assert_eq!(code(error), ErrorCode::Type, "{float}");
            }
        }
    }
}

#[test]
fn floats_outside_declared_bounds_are_range_errors() {
    for (codec, wrap) in codecs(int(Some(0), Some(10))) {
        for float in [-1.0, 11.0] {
            let error = codec.encode(&wrap(&[Value::Float(float)])).unwrap_err();
            assert_eq!(code(error), ErrorCode::Range, "{float}");
        }
    }
}

#[test]
fn mixed_int_and_float_columns_encode_like_int_columns() {
    for ty in [int(None, None), int(Some(100), Some(200))] {
        let codec = columnar(ty);
        let ints: Vec<Value> = (0..40).map(|i| Value::Int(100 + i * 3 % 17)).collect();
        let mixed: Vec<Value> = ints
            .iter()
            .enumerate()
            .map(|(i, value)| match value {
                Value::Int(n) if i % 2 == 0 => Value::Float(*n as f64),
                other => other.clone(),
            })
            .collect();
        let bytes = codec.encode(&rows(&mixed)).unwrap();
        assert_eq!(bytes, codec.encode(&rows(&ints)).unwrap());
        assert_eq!(codec.decode(&bytes).unwrap(), rows(&ints));
    }
}

#[test]
fn nullable_int_columns_accept_integral_floats() {
    let codec = compile(
        Node::Array {
            element: Box::new(Node::Struct(vec![Field {
                nullable: true,
                ..field("v", int(None, None))
            }])),
            length: None,
        },
        Plan::Columnar,
    );
    let mixed = rows(&[Value::Float(4.0), Value::Null, Value::Float(-0.0)]);
    let ints = rows(&[Value::Int(4), Value::Null, Value::Int(0)]);
    assert_eq!(codec.encode(&mixed).unwrap(), codec.encode(&ints).unwrap());
    assert_eq!(
        code(
            codec
                .encode(&rows(&[Value::Null, Value::Float(0.5)]))
                .unwrap_err()
        ),
        ErrorCode::Type
    );
}

#[test]
fn int_literals_match_equal_integral_floats() {
    for (codec, wrap) in codecs(Node::Literal(Literal::Int(7))) {
        let bytes = codec.encode(&wrap(&[Value::Float(7.0)])).unwrap();
        assert_eq!(bytes, codec.encode(&wrap(&[Value::Int(7)])).unwrap());
        assert_eq!(codec.decode(&bytes).unwrap(), wrap(&[Value::Int(7)]));
        for float in [8.0, 7.5] {
            let error = codec.encode(&wrap(&[Value::Float(float)])).unwrap_err();
            assert_eq!(code(error), ErrorCode::Type, "{float}");
        }
    }
    for (codec, wrap) in codecs(Node::Literal(Literal::Int(0))) {
        for float in [0.0, -0.0] {
            let bytes = codec.encode(&wrap(&[Value::Float(float)])).unwrap();
            assert_eq!(bytes, codec.encode(&wrap(&[Value::Int(0)])).unwrap());
        }
        for float in REJECTED {
            let error = codec.encode(&wrap(&[Value::Float(float)])).unwrap_err();
            assert_eq!(code(error), ErrorCode::Type, "{float}");
        }
    }
    for (codec, wrap) in codecs(Node::Literal(Literal::Int(9007199254740991))) {
        assert!(codec
            .encode(&wrap(&[Value::Float(9007199254740991.0)]))
            .is_ok());
        let error = codec
            .encode(&wrap(&[Value::Float(9007199254740992.0)]))
            .unwrap_err();
        assert_eq!(code(error), ErrorCode::Type);
    }
}
