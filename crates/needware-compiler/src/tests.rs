use super::*;
use provider::{Adapter, Config, Kind};
use schema::WireSchema;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[test]
fn typed_contracts_roundtrip_through_the_acyclic_provider_schema()
-> Result<(), Box<dyn std::error::Error>> {
    let app = needware_ir::examples::typed_habit_tracker();
    let schema = WireSchema::new();
    let encoded = schema.encode(&app)?;
    let decoded = schema.decode(&encoded)?;
    assert_eq!(decoded, app);
    needware_validation::validate(decoded)?;
    let legacy = needware_ir::examples::habit_tracker();
    assert_eq!(schema.decode(&schema.encode(&legacy)?)?, legacy);
    Ok(())
}

fn config(kind: Kind, endpoint: &str) -> Result<Config, Box<dyn std::error::Error>> {
    Ok(Config {
        kind,
        endpoint: endpoint.parse()?,
        model: "contract-fixture".into(),
        api_key: Some(zeroize::Zeroizing::new("fixture-only".into())),
        allow_loopback: true,
        fixture: false,
        input_microusd_per_million: Some(0),
        output_microusd_per_million: Some(0),
    })
}
fn acceptance() -> BehaviorTest {
    BehaviorTest {
        name: "adding a habit increases collection count".into(),
        action: "add".into(),
        event: BTreeMap::from([
            (
                "record_id".into(),
                needware_ir::Value::String("11111111-1111-4111-8111-111111111111".into()),
            ),
            (
                "name".into(),
                needware_ir::Value::String("Contract habit".into()),
            ),
        ]),
        assertion: needware_ir::Expr::Binary {
            operator: needware_ir::BinaryOp::Eq,
            left: Box::new(needware_ir::Expr::Length {
                value: Box::new(needware_ir::Expr::Collection {
                    name: "habits".into(),
                }),
            }),
            right: Box::new(needware_ir::Expr::Literal {
                value: needware_ir::Value::Integer("1".into()),
            }),
        },
    }
}
fn reply(kind: Kind, content: &str) -> Value {
    match kind {
        Kind::OpenAi => {
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":content}]}],"usage":{"input_tokens":100,"output_tokens":100}})
        }
        Kind::Anthropic => {
            json!({"stop_reason":"end_turn","content":[{"type":"text","text":content}],"usage":{"input_tokens":100,"output_tokens":100}})
        }
        Kind::Gemini => {
            json!({"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":content}]}],"usage":{"total_input_tokens":100,"total_output_tokens":80,"total_thought_tokens":20}})
        }
        Kind::Local => {
            json!({"choices":[{"finish_reason":"stop","message":{"content":content}}],"usage":{"prompt_tokens":100,"completion_tokens":100}})
        }
    }
}
async fn fixture(
    kind: Kind,
    responses: Vec<String>,
) -> Result<(String, tokio::task::JoinHandle<Result<Vec<Value>, String>>), Box<dyn std::error::Error>>
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/generation", listener.local_addr()?);
    let task = tokio::spawn(async move {
        let mut requests = vec![];
        for content in responses {
            let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut bytes = vec![];
            let mut buffer = [0; 4096];
            let (start, length) = loop {
                let count = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if count == 0 {
                    return Err("fixture request truncated".into());
                }
                bytes.extend_from_slice(&buffer[..count]);
                if bytes.len() > 600_000 {
                    return Err("fixture request too large".into());
                }
                if let Some(position) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                    let headers =
                        std::str::from_utf8(&bytes[..position]).map_err(|e| e.to_string())?;
                    let length: usize = headers
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().to_owned())
                        })
                        .ok_or("missing content length")?
                        .parse()
                        .map_err(|_| "invalid length")?;
                    break (position + 4, length);
                }
            };
            while bytes.len() < start + length {
                let count = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if count == 0 {
                    return Err("fixture body truncated".into());
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            requests.push(
                serde_json::from_slice(&bytes[start..start + length]).map_err(|e| e.to_string())?,
            );
            let mut envelope = reply(kind, &content);
            envelope["temperature"] = json!(0.7);
            let body = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.map_err(|e| e.to_string())?;
            stream.write_all(&body).await.map_err(|e| e.to_string())?;
        }
        Ok(requests)
    });
    Ok((endpoint, task))
}
#[test]
fn schema_roundtrip_rejects_cycles_duplicate_keys_and_invalid_references()
-> Result<(), Box<dyn std::error::Error>> {
    let schema = WireSchema::new();
    let app = needware_ir::examples::habit_tracker();
    let wire = schema.encode(&app)?;
    assert_eq!(
        serde_json::to_value(schema.decode(&wire)?)?,
        serde_json::to_value(&app)?
    );
    let mut duplicate = wire.clone();
    let entry = duplicate["application"]["collections"][0].clone();
    duplicate["application"]["collections"]
        .as_array_mut()
        .ok_or("not a map")?
        .push(entry);
    assert!(schema.decode(&duplicate).is_err());
    let mut cyclic = wire.clone();
    cyclic["expressions"][0] = json!({"op":"not","value":0});
    assert!(schema.decode(&cyclic).is_err());
    let mut invalid = wire;
    invalid["application"]["screens"][0]["root"] = json!(9999999);
    assert!(schema.decode(&invalid).is_err());
    Ok(())
}
#[test]
fn provider_schema_contains_no_recursive_references() -> Result<(), Box<dyn std::error::Error>> {
    fn refs(value: &Value, names: &mut Vec<String>) {
        match value {
            Value::Object(o) => {
                if let Some(name) = o
                    .get("$ref")
                    .and_then(Value::as_str)
                    .and_then(|s| s.strip_prefix("#/$defs/"))
                {
                    names.push(name.into());
                }
                for child in o.values() {
                    refs(child, names);
                }
            }
            Value::Array(a) => {
                for child in a {
                    refs(child, names);
                }
            }
            _ => {}
        }
    }
    fn visit(
        name: &str,
        defs: &serde_json::Map<String, Value>,
        active: &mut Vec<String>,
    ) -> Result<(), &'static str> {
        if active.iter().any(|n| n == name) {
            return Err("recursive provider schema");
        }
        active.push(name.into());
        let mut names = vec![];
        refs(
            defs.get(name).ok_or("dangling schema reference")?,
            &mut names,
        );
        for target in names {
            visit(&target, defs, active)?;
        }
        active.pop();
        Ok(())
    }
    let schema = WireSchema::new();
    let defs = schema.schema()["$defs"]
        .as_object()
        .ok_or("no schema definitions")?;
    for name in defs.keys() {
        visit(name, defs, &mut vec![])?;
    }
    Ok(())
}
#[tokio::test]
async fn all_four_http_adapters_compile_verified_behavior() -> Result<(), Box<dyn std::error::Error>>
{
    let schema = WireSchema::new();
    let wire = serde_json::to_string(&schema.encode(&needware_ir::examples::habit_tracker())?)?;
    for kind in [Kind::OpenAi, Kind::Anthropic, Kind::Gemini, Kind::Local] {
        let (url, task) = fixture(
            kind,
            vec![
                json!({"goal":"Track habits","requirements":["add a habit"],"unsupported":[]})
                    .to_string(),
                wire.clone(),
            ],
        )
        .await?;
        let compiler = Compiler::new(config(kind, &url)?, Policy::default(), SecretKey::random()?)?;
        let mut stages = vec![];
        let compiled = compiler
            .compile(
                "Track habits",
                &[acceptance()],
                &Cancellation::new(),
                |stage| stages.push(stage.stage),
            )
            .await?;
        assert_eq!(compiled.usage.input_tokens, 200);
        assert_eq!(compiled.usage.output_tokens, 200);
        let verified = needware_package::verify(&compiled.package)?;
        assert_eq!(verified.application().application().title, "Habit tracker");
        assert_eq!(
            stages,
            [
                "extract_intent",
                "generate_definition",
                "validate_definition",
                "package_verified"
            ]
        );
        let requests = task.await?.map_err(std::io::Error::other)?;
        assert_eq!(requests.len(), 2);
        match kind {
            Kind::OpenAi => assert_eq!(requests[1]["store"], false),
            Kind::Anthropic => assert_eq!(
                requests[1]["output_config"]["format"]["type"],
                "json_schema"
            ),
            Kind::Gemini => assert_eq!(requests[1]["store"], false),
            Kind::Local => assert_eq!(
                requests[1]["response_format"]["json_schema"]["strict"],
                true
            ),
        }
    }
    Ok(())
}
#[tokio::test]
async fn repair_is_bounded_and_acceptance_is_independent() -> Result<(), Box<dyn std::error::Error>>
{
    let intent = json!({"goal":"Track habits","requirements":[],"unsupported":[]}).to_string();
    let wire =
        serde_json::to_string(&WireSchema::new().encode(&needware_ir::examples::habit_tracker())?)?;
    let (url, task) = fixture(
        Kind::Local,
        vec![intent.clone(), "{bad".into(), wire.clone()],
    )
    .await?;
    let compiler = Compiler::new(
        config(Kind::Local, &url)?,
        Policy::default(),
        SecretKey::random()?,
    )?;
    assert!(
        compiler
            .compile(
                "Track habits",
                &[acceptance()],
                &Cancellation::new(),
                |_| {}
            )
            .await
            .is_ok()
    );
    assert_eq!(task.await?.map_err(std::io::Error::other)?.len(), 3);
    let (url, task) = fixture(Kind::Local, vec![intent, wire.clone(), wire.clone(), wire]).await?;
    let compiler = Compiler::new(
        config(Kind::Local, &url)?,
        Policy::default(),
        SecretKey::random()?,
    )?;
    let mut case = acceptance();
    case.assertion = needware_ir::Expr::Literal {
        value: needware_ir::Value::Boolean(false),
    };
    assert!(matches!(
        compiler
            .compile("Track habits", &[case], &Cancellation::new(), |_| {})
            .await,
        Err(CompileError::Validation)
    ));
    assert_eq!(task.await?.map_err(std::io::Error::other)?.len(), 4);
    Ok(())
}
#[tokio::test]
async fn limits_and_cancellation_precede_inference() -> Result<(), Box<dyn std::error::Error>> {
    let mut unknown = config(Kind::Local, "http://127.0.0.1:9/infer")?;
    unknown.input_microusd_per_million = None;
    assert!(Compiler::new(unknown, Policy::default(), SecretKey::random()?).is_err());
    let mut forbidden = config(Kind::Local, "http://127.0.0.1:9/infer")?;
    forbidden.allow_loopback = false;
    assert!(Adapter::new(forbidden, 1).is_err());
    let compiler = Compiler::new(
        config(Kind::Local, "http://127.0.0.1:9/infer")?,
        Policy {
            max_tokens: 1,
            ..Policy::default()
        },
        SecretKey::random()?,
    )?;
    assert!(matches!(
        compiler
            .compile("Habits", &[], &Cancellation::new(), |_| {})
            .await,
        Err(CompileError::Limit)
    ));
    let cancel = Cancellation::new();
    cancel.cancel();
    assert!(matches!(
        compiler.compile("Habits", &[], &cancel, |_| {}).await,
        Err(CompileError::Cancelled)
    ));
    Ok(())
}
#[test]
fn refusal_and_reasoning_tokens_are_accounted() -> Result<(), Box<dyn std::error::Error>> {
    assert!(
        serde_json::from_str::<crate::response_json::Response>("{\"usage\":1,\"usage\":2}")
            .is_err()
    );
    let adapter = Adapter::new(config(Kind::OpenAi, "http://127.0.0.1:9/infer")?, 1)?;
    let response = adapter.decode(&json!({"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}],"usage":{"input_tokens":12,"output_tokens":5}}))?;
    assert!(matches!(response.output, Err(CompileError::Refused)));
    assert_eq!(response.usage.output_tokens, 5);
    let gemini = Adapter::new(config(Kind::Gemini, "http://127.0.0.1:9/infer")?, 1)?;
    let response = gemini.decode(&reply(Kind::Gemini, "{}"))?;
    assert_eq!(response.usage.output_tokens, 100);
    Ok(())
}
