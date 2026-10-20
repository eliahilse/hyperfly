use std::sync::OnceLock;

use hyperfly_core::{
    Codec, Derivation, Field, GrammarCase, GrammarNum, GrammarToken, Limits, Literal, Node, Plan,
    Profile, ProfileColumn, Value, HEADER_SIZE,
};
use proptest::prelude::*;
use proptest::test_runner::Config;

struct Case {
    codec: Codec,
    header: Vec<u8>,
    seeds: Vec<Vec<u8>>,
}

fn field(name: &str, ty: Node) -> Field {
    Field {
        name: name.into(),
        ty,
        optional: false,
        nullable: false,
    }
}

fn optional(mut f: Field) -> Field {
    f.optional = true;
    f
}

fn nullable(mut f: Field) -> Field {
    f.nullable = true;
    f
}

fn int() -> Node {
    Node::Int {
        min: None,
        max: None,
    }
}

fn array(element: Node) -> Node {
    Node::Array {
        element: Box::new(element),
        length: None,
    }
}

fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

fn s(v: &str) -> Value {
    Value::Str(v.into())
}

fn row_ir() -> Node {
    Node::Struct(vec![
        field("i", int()),
        field(
            "m",
            Node::Int {
                min: Some(0),
                max: Some(1000),
            },
        ),
        field("f", Node::Float64),
        field("b", Node::Bool),
        field("s", Node::Str),
        field("y", Node::Bytes),
        field("e", Node::Enum(vec!["a".into(), "b".into(), "c".into()])),
        field("l", Node::Literal(Literal::Str("x".into()))),
        field("n", Node::Nullable(Box::new(int()))),
        optional(field("o", Node::Str)),
        field("arr", array(Node::Nullable(Box::new(Node::Str)))),
        field(
            "fixed",
            Node::Array {
                element: Box::new(int()),
                length: Some(3),
            },
        ),
        field("nested", array(array(Node::Bool))),
    ])
}

fn row_value(i: i64) -> Value {
    obj(vec![
        ("i", Value::Int(-i * 1000)),
        ("m", Value::Int(i % 1000)),
        ("f", Value::Float(i as f64 * 0.25)),
        ("b", Value::Bool(i % 2 == 0)),
        ("s", s("hello")),
        ("y", Value::Bytes(vec![0, 1, 2, 255])),
        ("e", s("b")),
        ("l", s("x")),
        (
            "n",
            if i % 2 == 0 {
                Value::Null
            } else {
                Value::Int(i)
            },
        ),
        ("o", s("present")),
        ("arr", Value::Array(vec![s("a"), Value::Null, s("bc")])),
        (
            "fixed",
            Value::Array(vec![Value::Int(1), Value::Int(2), Value::Int(i)]),
        ),
        (
            "nested",
            Value::Array(vec![
                Value::Array(vec![Value::Bool(true), Value::Bool(false)]),
                Value::Array(vec![]),
            ]),
        ),
    ])
}

fn columnar_ir() -> Node {
    array(Node::Struct(vec![
        field("id", int()),
        nullable(field("price", Node::Float64)),
        optional(field("flag", Node::Bool)),
        field("name", Node::Str),
        optional(nullable(field("note", Node::Str))),
        field("kind", Node::Enum(vec!["buy".into(), "sell".into()])),
        field(
            "meta",
            Node::Struct(vec![
                field("region", Node::Str),
                field(
                    "weight",
                    Node::Int {
                        min: Some(0),
                        max: None,
                    },
                ),
            ]),
        ),
        field("tags", array(Node::Str)),
    ]))
}

fn columnar_value(rows: i64) -> Value {
    Value::Array(
        (0..rows)
            .map(|i| {
                let mut entries = vec![
                    ("id", Value::Int(1000 + i * 3)),
                    (
                        "price",
                        if i % 3 == 0 {
                            Value::Null
                        } else {
                            Value::Float(i as f64 * 1.5)
                        },
                    ),
                ];
                if i % 2 == 0 {
                    entries.push(("flag", Value::Bool(i % 4 == 0)));
                }
                entries.push(("name", s(&format!("user-{}", i % 4))));
                if i % 3 == 1 {
                    entries.push(("note", Value::Null));
                } else if i % 3 == 2 {
                    entries.push(("note", s("a note that repeats a note that repeats")));
                }
                entries.push(("kind", s(if i % 2 == 0 { "buy" } else { "sell" })));
                entries.push((
                    "meta",
                    obj(vec![("region", s("eu")), ("weight", Value::Int(i * 7))]),
                ));
                entries.push(("tags", Value::Array(vec![s("t"); (i % 3) as usize])));
                obj(entries)
            })
            .collect(),
    )
}

fn profiled_ir() -> Node {
    array(Node::Struct(vec![
        field("actor", Node::Str),
        field("email", Node::Str),
        field("order", Node::Str),
        field("plain", Node::Str),
    ]))
}

fn profile() -> Profile {
    Profile {
        version: 2,
        columns: vec![
            ProfileColumn {
                leaf: 0,
                dict: Some(vec!["alice".into(), "bob".into()]),
                grammar: None,
                derived: None,
            },
            ProfileColumn {
                leaf: 1,
                dict: None,
                grammar: None,
                derived: Some(Derivation {
                    source: 0,
                    values: vec!["alice@example.com".into(), "bob@example.com".into()],
                }),
            },
            ProfileColumn {
                leaf: 2,
                dict: None,
                grammar: Some(vec![
                    GrammarToken::Lit("ord_".into()),
                    GrammarToken::Num(GrammarNum {
                        base: 16,
                        len: 4,
                        case: GrammarCase::Lower,
                    }),
                ]),
                derived: None,
            },
        ],
    }
}

fn profiled_value(rows: usize) -> Value {
    Value::Array(
        (0..rows)
            .map(|i| {
                let (actor, email) = match i % 3 {
                    0 => ("alice", "alice@example.com"),
                    1 => ("bob", "bob@example.com"),
                    _ => ("carol", "carol@example.com"),
                };
                obj(vec![
                    ("actor", s(actor)),
                    ("email", s(email)),
                    (
                        "order",
                        s(&if i == 2 {
                            "free-form".to_string()
                        } else {
                            format!("ord_{:04x}", i * 37)
                        }),
                    ),
                    ("plain", s("text")),
                ])
            })
            .collect(),
    )
}

fn case(codec: Codec, values: Vec<Value>) -> Case {
    let header = codec.encode(&values[0]).unwrap()[..HEADER_SIZE].to_vec();
    let seeds = values
        .iter()
        .map(|v| codec.encode_body(v).unwrap())
        .collect();
    Case {
        codec,
        header,
        seeds,
    }
}

fn cases() -> &'static [Case] {
    static CASES: OnceLock<Vec<Case>> = OnceLock::new();
    CASES.get_or_init(|| {
        let tight = Limits {
            max_depth: 3,
            max_items: 4,
            max_byte_length: 4,
            max_amplification: 2,
            ..Limits::default()
        };
        vec![
            case(
                Codec::compile(row_ir(), Plan::Row, Limits::default(), true).unwrap(),
                vec![row_value(1), row_value(2)],
            ),
            case(
                Codec::compile(
                    array(Node::Nullable(Box::new(array(int())))),
                    Plan::Row,
                    tight,
                    true,
                )
                .unwrap(),
                vec![Value::Array(vec![
                    Value::Null,
                    Value::Array(vec![Value::Int(1), Value::Int(-2)]),
                ])],
            ),
            case(
                Codec::compile(columnar_ir(), Plan::Columnar, Limits::default(), true).unwrap(),
                vec![columnar_value(1), columnar_value(9), columnar_value(40)],
            ),
            case(
                Codec::compile(columnar_ir(), Plan::Columnar, Limits::default(), false).unwrap(),
                vec![columnar_value(12)],
            ),
            case(
                Codec::compile_with_profile(
                    profiled_ir(),
                    Plan::Columnar,
                    Limits::default(),
                    true,
                    Some(profile()),
                )
                .unwrap(),
                vec![profiled_value(1), profiled_value(8)],
            ),
        ]
    })
}

fn config() -> Config {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|cases| cases.parse().ok())
        .unwrap_or(2048);
    Config {
        cases,
        failure_persistence: None,
        ..Config::default()
    }
}

#[derive(Debug, Clone)]
enum Mutation {
    Set(usize, u8),
    Insert(usize, u8),
    Remove(usize),
    Truncate(usize),
}

fn mutation() -> impl Strategy<Value = Mutation> {
    prop_oneof![
        4 => (any::<usize>(), any::<u8>()).prop_map(|(i, b)| Mutation::Set(i, b)),
        1 => (any::<usize>(), any::<u8>()).prop_map(|(i, b)| Mutation::Insert(i, b)),
        1 => any::<usize>().prop_map(Mutation::Remove),
        1 => any::<usize>().prop_map(Mutation::Truncate),
    ]
}

fn apply(body: &mut Vec<u8>, m: &Mutation) {
    let len = body.len();
    match *m {
        Mutation::Set(i, b) if len > 0 => body[i % len] = b,
        Mutation::Insert(i, b) => body.insert(i % (len + 1), b),
        Mutation::Remove(i) if len > 0 => {
            body.remove(i % len);
        }
        Mutation::Truncate(i) => body.truncate(i % (len + 1)),
        _ => {}
    }
}

fn exercise(c: &Case, body: &[u8]) {
    if let Ok(value) = c.codec.decode_body(body) {
        let _ = c.codec.encode_body(&value);
    }
    let mut wire = c.header.clone();
    wire.extend_from_slice(body);
    let _ = c.codec.decode(&wire);
}

proptest! {
    #![proptest_config(config())]

    #[test]
    fn arbitrary_bytes_never_panic(index in any::<usize>(), body in proptest::collection::vec(any::<u8>(), 0..256)) {
        let all = cases();
        exercise(&all[index % all.len()], &body);
    }

    #[test]
    fn mutated_bodies_never_panic(
        index in any::<usize>(),
        seed in any::<usize>(),
        mutations in proptest::collection::vec(mutation(), 1..8),
    ) {
        let all = cases();
        let c = &all[index % all.len()];
        let mut body = c.seeds[seed % c.seeds.len()].clone();
        for m in &mutations {
            apply(&mut body, m);
        }
        exercise(c, &body);
    }
}

#[test]
fn seeds_round_trip() {
    for c in cases() {
        for seed in &c.seeds {
            let value = c.codec.decode_body(seed).unwrap();
            assert_eq!(&c.codec.encode_body(&value).unwrap(), seed);
        }
    }
}
