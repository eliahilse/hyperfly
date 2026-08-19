use hyperfly_core::{fingerprint_of, serialize_artifact, Codec, Field, Limits, Literal, Node, Plan, Value};
use serde_json::Value as Json;

fn node_of(json: &Json) -> Node {
    let kind = json["kind"].as_str().unwrap();
    match kind {
        "bool" => Node::Bool,
        "float64" => Node::Float64,
        "string" => Node::Str,
        "bytes" => Node::Bytes,
        "int" => Node::Int {
            min: json.get("min").and_then(Json::as_i64),
            max: json.get("max").and_then(Json::as_i64),
        },
        "literal" => Node::Literal(match &json["value"] {
            Json::Null => Literal::Null,
            Json::Bool(b) => Literal::Bool(*b),
            Json::Number(n) => Literal::Int(n.as_i64().unwrap()),
            Json::String(s) => Literal::Str(s.clone()),
            other => panic!("bad literal {other:?}"),
        }),
        "enum" => Node::Enum(
            json["members"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_owned()).collect(),
        ),
        "nullable" => Node::Nullable(Box::new(node_of(&json["inner"]))),
        "array" => Node::Array {
            element: Box::new(node_of(&json["element"])),
            length: json.get("length").and_then(Json::as_u64),
        },
        "struct" => Node::Struct(
            json["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| Field {
                    name: f["name"].as_str().unwrap().to_owned(),
                    ty: node_of(&f["type"]),
                    optional: f.get("optional").and_then(Json::as_bool).unwrap_or(false),
                    nullable: f.get("nullable").and_then(Json::as_bool).unwrap_or(false),
                })
                .collect(),
        ),
        other => panic!("unknown kind {other}"),
    }
}

fn value_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Int(i)
            } else {
                Value::Float(n.as_f64().unwrap())
            }
        }
        Json::String(s) => Value::Str(s.clone()),
        Json::Array(items) => Value::Array(items.iter().map(value_of).collect()),
        Json::Object(entries) => Value::Object(entries.iter().map(|(k, v)| (k.clone(), value_of(v))).collect()),
    }
}

fn deep_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Int(x), Value::Float(y)) | (Value::Float(y), Value::Int(x)) => *x as f64 == *y,
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter().zip(y).all(|((ka, va), (kb, vb))| ka == kb && deep_eq(va, vb))
        }
        _ => a == b,
    }
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn load(name: &str) -> Json {
    let path = format!("{}/../spec/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn compile(ir: &Json, plan: Plan) -> Codec {
    Codec::compile(node_of(ir), plan, Limits::default(), true).unwrap()
}

fn run_valid(file: &Json, section: &str, plan: Plan) {
    for v in file[section].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = compile(&v["ir"], plan);
        let value = value_of(&v["value"]);
        let encoded = codec.encode_body(&value).unwrap_or_else(|e| panic!("{name}: encode failed: {e}"));
        assert_eq!(to_hex(&encoded), v["hex"].as_str().unwrap(), "{name}: bytes");
        let decoded = codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).unwrap();
        assert!(deep_eq(&decoded, &value), "{name}: decode mismatch");
    }
}

fn run_invalid_decode(file: &Json, plan: Plan) {
    for v in file["invalidDecode"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = compile(&v["ir"], plan);
        let errcode = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .expect_err(&format!("{name}: expected decode failure"))
            .code
            .as_str()
            .to_owned();
        assert_eq!(errcode, v["error"].as_str().unwrap(), "{name}");
    }
}

fn run_invalid_encode(file: &Json, plan: Plan) {
    for v in file["invalidEncode"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        if v["value"].get("$surrogate").is_some() {
            continue; // Rust strings cannot hold lone surrogates; the input is unrepresentable
        }
        let codec = compile(&v["ir"], plan);
        let errcode = codec
            .encode_body(&value_of(&v["value"]))
            .expect_err(&format!("{name}: expected encode failure"))
            .code
            .as_str()
            .to_owned();
        assert_eq!(errcode, v["error"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn row_vectors() {
    let file = load("vectors.json");
    run_valid(&file, "valid", Plan::Row);
    run_invalid_decode(&file, Plan::Row);
    run_invalid_encode(&file, Plan::Row);
}

#[test]
fn columnar_vectors() {
    let file = load("columnar.json");
    run_valid(&file, "valid", Plan::Columnar);
    run_invalid_decode(&file, Plan::Columnar);
    run_invalid_encode(&file, Plan::Columnar);
    for v in file["packedDecode"].as_array().unwrap() {
        let codec = compile(&v["ir"], Plan::Columnar);
        let decoded = codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).unwrap();
        assert!(deep_eq(&decoded, &value_of(&v["value"])), "{}", v["name"]);
    }
}

#[test]
fn packed_without_inflate_fails_closed() {
    let file = load("columnar.json");
    let v = &file["packedDecode"][0];
    let codec = Codec::compile(node_of(&v["ir"]), Plan::Columnar, Limits::default(), false).unwrap();
    let e = codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).unwrap_err();
    assert_eq!(e.code.as_str(), "unsupported");
}

#[test]
fn fingerprints() {
    let file = load("fingerprints.json");
    for case in file["cases"].as_array().unwrap() {
        let plan = match case["plan"].as_str().unwrap() {
            "row" => Plan::Row,
            _ => Plan::Columnar,
        };
        let canonical = serialize_artifact(&node_of(&case["ir"]), plan, None);
        assert_eq!(canonical, case["canonical"].as_str().unwrap(), "{}", case["name"]);
        assert_eq!(to_hex(&fingerprint_of(&canonical)), case["fingerprint"].as_str().unwrap(), "{}", case["name"]);
    }
}

#[test]
fn envelope_roundtrip() {
    let file = load("vectors.json");
    let v = &file["valid"][0];
    let codec = compile(&v["ir"], Plan::Row);
    let value = value_of(&v["value"]);
    let wire = codec.encode(&value).unwrap();
    assert_eq!(wire.len(), hyperfly_core::HEADER_SIZE + from_hex(v["hex"].as_str().unwrap()).len());
    assert!(deep_eq(&codec.decode(&wire).unwrap(), &value));
    let other = compile(&file["valid"][3]["ir"], Plan::Row);
    assert_eq!(other.decode(&wire).unwrap_err().code.as_str(), "fingerprint");
}

fn profile_of(json: &Json) -> hyperfly_core::ir::Profile {
    hyperfly_core::ir::Profile {
        columns: json["shared"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| hyperfly_core::ir::ProfileColumn {
                leaf: c["leaf"].as_u64().unwrap() as usize,
                dict: c["dict"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()).collect(),
            })
            .collect(),
    }
}

fn profiled_codec(v: &Json, with_profile: bool) -> Codec {
    let profile = if with_profile { Some(profile_of(&v["profile"])) } else { None };
    Codec::compile_with_profile(node_of(&v["ir"]), Plan::Columnar, Limits::default(), false, profile).unwrap()
}

#[test]
fn profiled_vectors() {
    let file = load("columnar.json");
    let profiled = &file["profiled"];

    for v in profiled["valid"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, true);
        let value = value_of(&v["value"]);
        let encoded = codec.encode_body(&value).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(to_hex(&encoded), v["hex"].as_str().unwrap(), "{name}: bytes");
        assert!(deep_eq(&codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).unwrap(), &value), "{name}");
    }

    for v in profiled["invalidDecode"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, true);
        let e = codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).expect_err(name);
        assert_eq!(e.code.as_str(), v["error"].as_str().unwrap(), "{name}");
    }

    for v in profiled["requiresProfile"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, false);
        let e = codec.decode_body(&from_hex(v["hex"].as_str().unwrap())).expect_err(name);
        assert_eq!(e.code.as_str(), v["error"].as_str().unwrap(), "{name}");
    }
}
