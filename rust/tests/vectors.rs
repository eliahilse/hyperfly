use hyperfly_core::ir::{
    Derivation, GrammarCase, GrammarNum, GrammarToken, Profile, ProfileColumn,
};
use hyperfly_core::{
    fingerprint_of, serialize_artifact, Codec, Field, Limits, Literal, Node, Plan, Value,
};
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
            json["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m.as_str().unwrap().to_owned())
                .collect(),
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
        Json::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(k, v)| (k.clone(), value_of(v)))
                .collect(),
        ),
    }
}

fn deep_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Int(x), Value::Float(y)) | (Value::Float(y), Value::Int(x)) => *x as f64 == *y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((ka, va), (kb, vb))| ka == kb && deep_eq(va, vb))
        }
        _ => a == b,
    }
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
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
        let encoded = codec
            .encode_body(&value)
            .unwrap_or_else(|e| panic!("{name}: encode failed: {e}"));
        assert_eq!(
            to_hex(&encoded),
            v["hex"].as_str().unwrap(),
            "{name}: bytes"
        );
        let decoded = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .unwrap();
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
        let decoded = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .unwrap();
        assert!(deep_eq(&decoded, &value_of(&v["value"])), "{}", v["name"]);
    }
}

#[test]
fn packed_without_inflate_fails_closed() {
    let file = load("columnar.json");
    let v = &file["packedDecode"][0];
    let codec =
        Codec::compile(node_of(&v["ir"]), Plan::Columnar, Limits::default(), false).unwrap();
    let e = codec
        .decode_body(&from_hex(v["hex"].as_str().unwrap()))
        .unwrap_err();
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
        let profile = case.get("profile").map(profile_of).transpose().unwrap();
        let canonical = serialize_artifact(&node_of(&case["ir"]), plan, profile.as_ref());
        assert_eq!(
            canonical,
            case["canonical"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            to_hex(&fingerprint_of(&canonical)),
            case["fingerprint"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn envelope_roundtrip() {
    let file = load("vectors.json");
    let v = &file["valid"][0];
    let codec = compile(&v["ir"], Plan::Row);
    let value = value_of(&v["value"]);
    let wire = codec.encode(&value).unwrap();
    assert_eq!(
        wire.len(),
        hyperfly_core::HEADER_SIZE + from_hex(v["hex"].as_str().unwrap()).len()
    );
    assert!(deep_eq(&codec.decode(&wire).unwrap(), &value));
    let other = compile(&file["valid"][3]["ir"], Plan::Row);
    assert_eq!(
        other.decode(&wire).unwrap_err().code.as_str(),
        "fingerprint"
    );
}

fn profile_of(json: &Json) -> Result<Profile, String> {
    fn object<'a>(
        value: &'a Json,
        path: &str,
    ) -> Result<&'a serde_json::Map<String, Json>, String> {
        value
            .as_object()
            .ok_or_else(|| format!("{path} must be an object"))
    }

    fn keys(
        object: &serde_json::Map<String, Json>,
        path: &str,
        allowed: &[&str],
        required: &[&str],
    ) -> Result<(), String> {
        for key in object.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(format!("{path}: unknown key {key}"));
            }
        }
        for key in required {
            if !object.contains_key(*key) {
                return Err(format!("{path}: missing key {key}"));
            }
        }
        Ok(())
    }

    fn portable_string(value: &Json, path: &str) -> Result<String, String> {
        value
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("{path} must be a string"))
    }

    let root = object(json, "profile document")?;
    keys(
        root,
        "profile document",
        &["version", "shared", "hints"],
        &["version", "shared"],
    )?;
    if let Some(hints) = root.get("hints") {
        object(hints, "profile hints")?;
    }
    let version = root["version"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "profile version must be an integer".to_owned())?;
    let shared = object(&root["shared"], "profile shared")?;
    keys(shared, "profile shared", &["columns"], &["columns"])?;
    let raw_columns = shared["columns"]
        .as_array()
        .ok_or_else(|| "profile shared.columns must be an array".to_owned())?;

    let mut columns = Vec::with_capacity(raw_columns.len());
    for (column_index, raw_column) in raw_columns.iter().enumerate() {
        let path = format!("profile shared.columns[{column_index}]");
        let column = object(raw_column, &path)?;
        if version == 1 {
            keys(column, &path, &["leaf", "dict"], &["leaf", "dict"])?;
        } else {
            keys(
                column,
                &path,
                &["leaf", "dict", "grammar", "derived"],
                &["leaf"],
            )?;
        }
        let leaf = column["leaf"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| format!("{path}.leaf must be a non-negative integer"))?;

        let dict = match column.get("dict") {
            None => None,
            Some(raw) => {
                let entries = raw
                    .as_array()
                    .ok_or_else(|| format!("{path}.dict must be an array"))?;
                Some(
                    entries
                        .iter()
                        .enumerate()
                        .map(|(i, entry)| portable_string(entry, &format!("{path}.dict[{i}]")))
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
        };

        let grammar = match column.get("grammar") {
            None => None,
            Some(raw) => {
                let tokens = raw
                    .as_array()
                    .ok_or_else(|| format!("{path}.grammar must be an array"))?;
                let mut grammar = Vec::with_capacity(tokens.len());
                for (token_index, raw_token) in tokens.iter().enumerate() {
                    let token_path = format!("{path}.grammar[{token_index}]");
                    let token = object(raw_token, &token_path)?;
                    if token.len() != 1
                        || (!token.contains_key("lit") && !token.contains_key("num"))
                    {
                        return Err(format!("{token_path} must hold exactly one of lit or num"));
                    }
                    if let Some(literal) = token.get("lit") {
                        grammar.push(GrammarToken::Lit(portable_string(
                            literal,
                            &format!("{token_path}.lit"),
                        )?));
                        continue;
                    }
                    let num_path = format!("{token_path}.num");
                    let num = object(&token["num"], &num_path)?;
                    keys(
                        num,
                        &num_path,
                        &["base", "len", "case"],
                        &["base", "len", "case"],
                    )?;
                    let base = num["base"]
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or_else(|| format!("{num_path}.base must be an integer"))?;
                    let len = num["len"]
                        .as_u64()
                        .and_then(|value| u32::try_from(value).ok())
                        .ok_or_else(|| format!("{num_path}.len must be an integer"))?;
                    let case = match num["case"].as_str() {
                        Some("lower") => GrammarCase::Lower,
                        Some("upper") => GrammarCase::Upper,
                        _ => return Err(format!("{num_path}.case must be lower or upper")),
                    };
                    grammar.push(GrammarToken::Num(GrammarNum { base, len, case }));
                }
                Some(grammar)
            }
        };

        let derived = match column.get("derived") {
            None => None,
            Some(raw) => {
                let derived_path = format!("{path}.derived");
                let derived = object(raw, &derived_path)?;
                keys(
                    derived,
                    &derived_path,
                    &["source", "values"],
                    &["source", "values"],
                )?;
                let source = derived["source"]
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        format!("{derived_path}.source must be a non-negative integer")
                    })?;
                let raw_values = derived["values"]
                    .as_array()
                    .ok_or_else(|| format!("{derived_path}.values must be an array"))?;
                let values = raw_values
                    .iter()
                    .enumerate()
                    .map(|(i, value)| {
                        portable_string(value, &format!("{derived_path}.values[{i}]"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Some(Derivation { source, values })
            }
        };
        columns.push(ProfileColumn {
            leaf,
            dict,
            grammar,
            derived,
        });
    }
    Ok(Profile { version, columns })
}

fn profiled_codec(v: &Json, with_profile: bool) -> Codec {
    let profile = if with_profile {
        Some(profile_of(&v["profile"]).unwrap())
    } else {
        None
    };
    Codec::compile_with_profile(
        node_of(&v["ir"]),
        Plan::Columnar,
        Limits::default(),
        false,
        profile,
    )
    .unwrap()
}

#[test]
fn profiled_vectors() {
    let file = load("columnar.json");
    let profiled = &file["profiled"];

    for v in profiled["valid"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, true);
        let value = value_of(&v["value"]);
        let encoded = codec
            .encode_body(&value)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            to_hex(&encoded),
            v["hex"].as_str().unwrap(),
            "{name}: bytes"
        );
        assert!(
            deep_eq(
                &codec
                    .decode_body(&from_hex(v["hex"].as_str().unwrap()))
                    .unwrap(),
                &value
            ),
            "{name}"
        );
    }

    for v in profiled["decodeOnly"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, true);
        let decoded = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .unwrap();
        assert!(deep_eq(&decoded, &value_of(&v["value"])), "{name}");
    }

    for v in profiled["invalidDecode"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, true);
        let e = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .expect_err(name);
        assert_eq!(e.code.as_str(), v["error"].as_str().unwrap(), "{name}");
    }

    for v in profiled["requiresProfile"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let codec = profiled_codec(v, false);
        let e = codec
            .decode_body(&from_hex(v["hex"].as_str().unwrap()))
            .expect_err(name);
        assert_eq!(e.code.as_str(), v["error"].as_str().unwrap(), "{name}");
    }

    for v in profiled["invalidProfile"].as_array().unwrap() {
        let name = v["name"].as_str().unwrap();
        let code = match profile_of(&v["profile"]) {
            Err(_) => "ir",
            Ok(profile) => match Codec::compile_with_profile(
                node_of(&v["ir"]),
                Plan::Columnar,
                Limits::default(),
                false,
                Some(profile),
            ) {
                Ok(_) => panic!("{name}: expected profile compilation failure"),
                Err(error) => error.code.as_str(),
            },
        };
        assert_eq!(code, v["error"].as_str().unwrap(), "{name}");
    }
}
