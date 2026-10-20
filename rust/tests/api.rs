use hyperfly_core::{
    Codec, CompileOptions, Error, ErrorCode, Field, Limits, Node, Plan, Profile, ProfileColumn,
    Value,
};

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn public_types_are_send_and_sync() {
    assert_send_sync::<Codec>();
    assert_send_sync::<Error>();
    assert_send_sync::<Value>();
    assert_send_sync::<Node>();
    assert_send_sync::<Profile>();
    assert_send_sync::<CompileOptions>();
    assert_send_sync::<Limits>();
}

fn string_rows() -> Node {
    Node::Array {
        element: Box::new(Node::Struct(vec![Field {
            name: "s".into(),
            ty: Node::Str,
            optional: false,
            nullable: false,
        }])),
        length: None,
    }
}

fn header_error() -> Error {
    let codec = Codec::compile(Node::Str, CompileOptions::new()).unwrap();
    codec.decode(&[0x68]).unwrap_err()
}

#[test]
fn error_boxes_as_send_sync_std_error() {
    let boxed: Box<dyn std::error::Error + Send + Sync> = Box::new(header_error());
    assert_eq!(boxed.to_string(), "header: shorter than envelope header");
}

#[test]
fn error_display_is_code_then_message() {
    let error = header_error();
    assert_eq!(error.code(), ErrorCode::Header);
    assert_eq!(error.message(), "shorter than envelope header");
    assert_eq!(
        error.to_string(),
        format!("{}: {}", error.code().as_str(), error.message())
    );
}

#[test]
fn error_code_strings() {
    let table = [
        (ErrorCode::Varint, "varint"),
        (ErrorCode::Range, "range"),
        (ErrorCode::Type, "type"),
        (ErrorCode::Required, "required"),
        (ErrorCode::Utf8, "utf8"),
        (ErrorCode::Float, "float"),
        (ErrorCode::Marker, "marker"),
        (ErrorCode::Bitmap, "bitmap"),
        (ErrorCode::Trailing, "trailing"),
        (ErrorCode::Truncated, "truncated"),
        (ErrorCode::Depth, "depth"),
        (ErrorCode::Limit, "limit"),
        (ErrorCode::Header, "header"),
        (ErrorCode::Fingerprint, "fingerprint"),
        (ErrorCode::Ir, "ir"),
        (ErrorCode::Packed, "packed"),
        (ErrorCode::Unsupported, "unsupported"),
    ];
    for (code, name) in table {
        assert_eq!(code.as_str(), name);
        assert_eq!(code.to_string(), name);
    }
}

#[test]
fn compile_options_defaults() {
    let options = CompileOptions::default();
    assert_eq!(options.plan, Plan::Row);
    assert_eq!(options.limits, Limits::default());
    assert!(options.pack);
    assert_eq!(options.profile, None);
    assert_eq!(CompileOptions::new(), options);
}

#[test]
fn cloned_codec_keeps_identity_and_decodes_same_bytes() {
    let profile = Profile::new(1, vec![ProfileColumn::new(0).with_dict(vec!["a".into()])]);
    let codec = Codec::compile(
        string_rows(),
        CompileOptions::new()
            .with_plan(Plan::Columnar)
            .with_profile(profile),
    )
    .unwrap();
    let clone = codec.clone();
    assert_eq!(clone.fingerprint(), codec.fingerprint());
    assert_eq!(clone.artifact(), codec.artifact());
    assert_eq!(clone.plan(), codec.plan());
    assert_eq!(clone.ir(), codec.ir());
    assert_eq!(clone.limits(), codec.limits());

    let value = Value::Array(vec![Value::Object(vec![(
        "s".into(),
        Value::Str("a".into()),
    )])]);
    let bytes = codec.encode(&value).unwrap();
    assert_eq!(clone.decode(&bytes).unwrap(), value);
    assert_eq!(clone.decode(&bytes).unwrap(), codec.decode(&bytes).unwrap());
}

#[test]
fn profile_with_row_plan_is_invalid_ir() {
    let profile = Profile::new(1, vec![ProfileColumn::new(0).with_dict(vec!["a".into()])]);
    let error =
        Codec::compile(string_rows(), CompileOptions::new().with_profile(profile)).unwrap_err();
    assert_eq!(error.code(), ErrorCode::Ir);
}

#[test]
fn fingerprint_mismatch_reports_both_fingerprints() {
    let strings = Codec::compile(Node::Str, CompileOptions::new()).unwrap();
    let bools = Codec::compile(Node::Bool, CompileOptions::new()).unwrap();
    let bytes = strings.encode(&Value::Str("hi".into())).unwrap();
    let actual: String = bytes[3..19].iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(actual, strings.fingerprint());

    let error = bools.decode(&bytes).unwrap_err();
    assert_eq!(error.code(), ErrorCode::Fingerprint);
    assert_eq!(
        error.message(),
        format!(
            "codec fingerprint {} does not match payload {}",
            bools.fingerprint(),
            actual
        )
    );
    assert_eq!(
        error.fingerprint_mismatch(),
        Some((bools.fingerprint(), actual.as_str()))
    );
    assert_eq!(
        error.clone().fingerprint_mismatch(),
        error.fingerprint_mismatch()
    );
    assert_eq!(header_error().fingerprint_mismatch(), None);
}
