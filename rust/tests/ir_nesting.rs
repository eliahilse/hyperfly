use hyperfly_core::{Codec, CompileOptions, ErrorCode, Field, Limits, Node, Plan, Value};

fn array(element: Node) -> Node {
    Node::Array {
        element: Box::new(element),
        length: None,
    }
}

fn nullable(inner: Node) -> Node {
    Node::Nullable(Box::new(inner))
}

fn single(ty: Node) -> Node {
    Node::Struct(vec![Field {
        name: "f".into(),
        ty,
        optional: false,
        nullable: false,
    }])
}

fn arrays(levels: usize, leaf: Node) -> Node {
    (0..levels).fold(leaf, |node, _| array(node))
}

fn nullables(levels: usize) -> Node {
    (0..levels).fold(Node::Bool, |node, level| {
        if level % 2 == 0 {
            nullable(node)
        } else {
            array(node)
        }
    })
}

fn structs(levels: usize, leaf: Node) -> Node {
    (0..levels).fold(leaf, |node, _| single(node))
}

fn compile(ir: Node) -> Result<Codec, hyperfly_core::Error> {
    Codec::compile(ir, CompileOptions::new())
}

fn assert_rejected(ir: Node) {
    let err = compile(ir).unwrap_err();
    assert_eq!(err.code(), ErrorCode::Ir);
    assert_eq!(err.message(), "$: artifact nests deeper than 512");
    assert_eq!(err.to_string(), "ir: $: artifact nests deeper than 512");
}

fn artifact_nesting(artifact: &str) -> usize {
    let (mut depth, mut deepest, mut in_string, mut escaped) = (0usize, 0usize, false, false);
    for ch in artifact.chars() {
        if in_string {
            match (escaped, ch) {
                (true, _) => escaped = false,
                (false, '\\') => escaped = true,
                (false, '"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' | '[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    deepest
}

fn assert_accepted(ir: Node) -> Codec {
    let codec = compile(ir).unwrap();
    assert_eq!(artifact_nesting(codec.artifact()), 512);
    codec
}

#[test]
fn nested_arrays_reach_the_bound() {
    assert_accepted(arrays(510, Node::Bool));
    assert_rejected(arrays(511, Node::Bool));
}

#[test]
fn enum_members_count_one_level() {
    let members = Node::Enum(vec!["a".into()]);
    assert_accepted(arrays(509, members.clone()));
    assert_rejected(arrays(510, members));
}

#[test]
fn nested_nullables_reach_the_bound() {
    assert_accepted(nullables(510));
    assert_rejected(nullables(511));
}

#[test]
fn each_struct_level_costs_three() {
    assert_accepted(structs(170, Node::Bool));
    assert_rejected(structs(170, nullable(Node::Bool)));
    assert_rejected(structs(171, Node::Bool));
}

#[test]
fn empty_struct_fields_array_counts() {
    assert_accepted(structs(169, arrays(2, Node::Struct(vec![]))));
    assert_rejected(structs(170, Node::Struct(vec![])));
}

#[test]
fn deepest_branch_decides() {
    let wide = Node::Struct(vec![
        Field {
            name: "shallow".into(),
            ty: Node::Bool,
            optional: false,
            nullable: false,
        },
        Field {
            name: "deep".into(),
            ty: arrays(507, Node::Bool),
            optional: true,
            nullable: true,
        },
    ]);
    assert_accepted(wide.clone());
    let Node::Struct(mut fields) = wide else {
        unreachable!()
    };
    fields[1].ty = arrays(508, Node::Bool);
    assert_rejected(Node::Struct(fields));
}

#[test]
fn mixed_shapes_compile_at_the_bound_for_both_plans() {
    let mixed = || array(structs(100, nullables(208)));
    assert_eq!(artifact_nesting(compile(mixed()).unwrap().artifact()), 511);
    let at_bound = || array(structs(100, nullables(209)));
    for plan in [Plan::Row, Plan::Columnar] {
        let codec = Codec::compile(at_bound(), CompileOptions::new().with_plan(plan)).unwrap();
        assert_eq!(artifact_nesting(codec.artifact()), 512);
        let err = Codec::compile(
            array(structs(100, nullables(210))),
            CompileOptions::new().with_plan(plan),
        )
        .unwrap_err();
        assert_eq!(err.code(), ErrorCode::Ir);
    }
}

#[test]
fn million_deep_ir_is_rejected_without_overflow() {
    assert_rejected(arrays(1_000_000, Node::Bool));
    assert_rejected(nullables(1_000_000));
    assert_rejected(structs(1_000_000, Node::Bool));
}

fn deep_value(levels: usize) -> Value {
    (0..levels).fold(Value::Bool(true), |value, _| Value::Array(vec![value]))
}

#[test]
fn deep_values_round_trip_with_raised_max_depth() {
    let mut limits = Limits::default();
    limits.max_depth = 1000;
    for plan in [Plan::Row, Plan::Columnar] {
        let options = CompileOptions::new()
            .with_plan(plan)
            .with_limits(limits.clone());
        let codec = Codec::compile(arrays(128, Node::Bool), options).unwrap();
        let value = deep_value(128);
        let bytes = codec.encode(&value).unwrap();
        assert_eq!(codec.decode(&bytes).unwrap(), value);
    }
}
