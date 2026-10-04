use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::*;
use needware_runtime::{Event, Runtime};
use std::collections::BTreeMap;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

#[test]
fn exact_decimal_events_preserve_precision_and_rollback_the_whole_sequence() -> Result {
    let mut app = examples::typed_habit_tracker();
    app.runtime_features.push("exact_arithmetic_v1".into());
    let decimal = |n: &str| {
        Value::Decimal(Decimal {
            coefficient: n.into(),
            scale: 2,
        })
    };
    app.state.insert("balance".into(), decimal("125"));
    app.state.insert("count".into(), Value::Integer("0".into()));
    app.state_schema
        .insert("balance".into(), field(DataType::Decimal { scale: 2 }));
    app.state_schema
        .insert("count".into(), field(DataType::Integer));
    for (action, operator) in [
        ("add_amount", BinaryOp::Add),
        ("divide_amount", BinaryOp::Divide),
    ] {
        app.actions.insert(
            action.into(),
            Action::Sequence {
                actions: vec![
                    Action::Set {
                        key: "count".into(),
                        value: Expr::Literal {
                            value: Value::Integer("1".into()),
                        },
                    },
                    Action::Set {
                        key: "balance".into(),
                        value: Expr::Binary {
                            operator,
                            left: Box::new(Expr::State {
                                key: "balance".into(),
                            }),
                            right: Box::new(Expr::Event {
                                key: "amount".into(),
                            }),
                        },
                    },
                ],
            },
        );
        app.event_schema.insert(
            action.into(),
            BTreeMap::from([("amount".into(), field(DataType::Decimal { scale: 2 }))]),
        );
    }
    let mut unsupported = app.clone();
    unsupported
        .runtime_features
        .retain(|f| f != "exact_arithmetic_v1");
    assert!(needware_validation::validate(unsupported).is_err());
    let mut runtime = runtime(app)?;
    let initial = runtime.state().clone();
    assert!(
        runtime
            .dispatch(&event(
                "divide_amount",
                BTreeMap::from([("amount".into(), decimal("300"))])
            ))
            .is_err()
    );
    assert_eq!(runtime.state(), &initial);
    runtime.dispatch(&event(
        "add_amount",
        BTreeMap::from([("amount".into(), decimal("75"))]),
    ))?;
    assert_eq!(runtime.state().values["balance"], decimal("200"));
    let saved = runtime.state().clone();
    assert!(
        runtime
            .dispatch(&event(
                "add_amount",
                BTreeMap::from([("amount".into(), decimal(&i64::MAX.to_string()))])
            ))
            .is_err()
    );
    assert_eq!(runtime.state(), &saved);
    Ok(())
}

fn runtime(app: Application) -> Result<Runtime> {
    let key = SecretKey::from_bytes([23; 32]);
    let package = needware_package::verify(&needware_package::build(app.clone(), vec![], &key)?)?;
    Ok(Runtime::load(
        package,
        None,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: app.capabilities,
        },
        &[key.public_key()],
    )?)
}
fn event(action: &str, values: BTreeMap<String, Value>) -> Event {
    Event {
        action: action.into(),
        values,
        now: "2026-10-04T00:00:00Z".into(),
        timezone: "UTC".into(),
    }
}
fn field(data_type: DataType) -> Field {
    Field {
        data_type,
        default: None,
        max_length: None,
        minimum: None,
        maximum: None,
        derived: None,
    }
}

#[test]
fn invalid_external_inputs_never_mutate_state_or_produce_effects() -> Result {
    let mut runtime = runtime(examples::typed_habit_tracker())?;
    let id = Value::String("11111111-1111-4111-8111-111111111111".into());
    let valid = BTreeMap::from([
        ("record_id".into(), id.clone()),
        ("name".into(), Value::String("read".into())),
    ]);
    let initial = runtime.state().clone();
    let mut wrong = valid.clone();
    wrong.insert("name".into(), Value::Boolean(false));
    let mut extra = valid.clone();
    extra.insert("undeclared".into(), Value::String("secret".into()));
    let mut missing = valid.clone();
    missing.remove("name");
    let mut oversize = valid.clone();
    oversize.insert("name".into(), Value::String("x".repeat(121)));
    for values in [wrong, extra, missing, oversize] {
        assert!(runtime.dispatch(&event("add", values)).is_err());
        assert_eq!(runtime.state(), &initial);
    }
    assert!(runtime.dispatch(&event("add", valid))?.is_empty());
    assert_eq!(runtime.state().collections["habits"].len(), 1);
    let view = serde_json::to_value(runtime.view()?)?;
    // The trusted renderer scopes outgoing form fields to each action's contract.
    let text = view.to_string();
    assert!(text.contains("event_fields"));
    let mut extra = BTreeMap::from([
        ("record_id".into(), id.clone()),
        ("name".into(), Value::String("stale input".into())),
    ]);
    let saved = runtime.state().clone();
    assert!(runtime.dispatch(&event("toggle", extra.clone())).is_err());
    assert_eq!(runtime.state(), &saved);
    extra.remove("name");
    runtime.dispatch(&event("toggle", extra))?;
    assert_eq!(
        runtime.state().collections["habits"]["11111111-1111-4111-8111-111111111111"]["done"],
        Value::Boolean(true)
    );
    Ok(())
}

#[test]
fn empty_typed_state_and_optional_inputs_survive_signed_roundtrip_and_reopen() -> Result {
    let mut app = examples::typed_habit_tracker();
    app.state.insert("numbers".into(), Value::List(vec![]));
    let numbers = field(DataType::List {
        item: Box::new(DataType::Integer),
    });
    app.state_schema.insert("numbers".into(), numbers.clone());
    app.actions.insert(
        "set_numbers".into(),
        Action::Set {
            key: "numbers".into(),
            value: Expr::Event {
                key: "numbers".into(),
            },
        },
    );
    app.event_schema.insert(
        "set_numbers".into(),
        BTreeMap::from([("numbers".into(), numbers)]),
    );
    let selected = field(DataType::Optional {
        inner: Box::new(DataType::Integer),
    });
    app.state.insert("selected".into(), Value::Null);
    app.state_schema.insert("selected".into(), selected.clone());
    app.actions.insert(
        "select".into(),
        Action::Set {
            key: "selected".into(),
            value: Expr::Event {
                key: "selected".into(),
            },
        },
    );
    app.event_schema.insert(
        "select".into(),
        BTreeMap::from([("selected".into(), selected)]),
    );
    let mut first = runtime(app.clone())?;
    first.dispatch(&event(
        "select",
        BTreeMap::from([("selected".into(), Value::Integer("7".into()))]),
    ))?;
    first.dispatch(&event("select", BTreeMap::new()))?;
    assert_eq!(first.state().values["selected"], Value::Null);
    let state = first.state().clone();
    let bad = event(
        "set_numbers",
        BTreeMap::from([("numbers".into(), Value::List(vec![Value::Boolean(false)]))]),
    );
    assert!(first.dispatch(&bad).is_err());
    assert_eq!(first.state(), &state);
    let good = event(
        "set_numbers",
        BTreeMap::from([(
            "numbers".into(),
            Value::List(vec![Value::Integer("42".into())]),
        )]),
    );
    first.dispatch(&good)?;
    let saved = first.state().clone();
    let mut second = runtime(app)?;
    second.restore(saved.clone())?;
    assert_eq!(second.state(), &saved);
    let mut invalid = saved.clone();
    invalid.values.insert(
        "numbers".into(),
        Value::List(vec![Value::String("42".into())]),
    );
    assert!(second.restore(invalid).is_err());
    assert_eq!(second.state(), &saved);
    Ok(())
}
