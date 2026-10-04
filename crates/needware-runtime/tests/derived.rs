use needware_capabilities::{Capability, Grants};
use needware_crypto::SecretKey;
use needware_ir::*;
use needware_runtime::{Event, Runtime, RuntimeError};
use std::collections::BTreeMap;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
fn field(data_type: DataType, derived: Option<Expr>) -> Field {
    Field {
        data_type,
        derived,
        default: None,
        max_length: None,
        minimum: None,
        maximum: None,
    }
}
fn app() -> Result<Application> {
    let mut app = examples::typed_habit_tracker();
    app.runtime_features.push("derived_fields_v1".into());
    app.state
        .insert("prefix".into(), Value::String("first ".into()));
    app.state_schema
        .insert("prefix".into(), field(DataType::String, None));
    app.state
        .insert("divisor".into(), Value::Integer("1".into()));
    app.state_schema
        .insert("divisor".into(), field(DataType::Integer, None));
    let fields = &mut app.collections.get_mut("habits").ok_or("habits")?.fields;
    fields.insert(
        "label".into(),
        field(
            DataType::String,
            Some(Expr::Concat {
                values: vec![
                    Expr::State {
                        key: "prefix".into(),
                    },
                    Expr::Item {
                        field: "name".into(),
                    },
                ],
            }),
        ),
    );
    fields.insert(
        "a_length".into(),
        field(
            DataType::Integer,
            Some(Expr::Binary {
                operator: BinaryOp::Divide,
                left: Box::new(Expr::Length {
                    value: Box::new(Expr::Item {
                        field: "label".into(),
                    }),
                }),
                right: Box::new(Expr::State {
                    key: "divisor".into(),
                }),
            }),
        ),
    );
    for (key, data_type) in [("prefix", DataType::String), ("divisor", DataType::Integer)] {
        app.actions.insert(
            key.into(),
            Action::Set {
                key: key.into(),
                value: Expr::Event { key: key.into() },
            },
        );
        app.event_schema.insert(
            key.into(),
            BTreeMap::from([(key.into(), field(data_type, None))]),
        );
    }
    Ok(app)
}
fn runtime(app: Application, state: Option<State>, read_only: bool) -> Result<Runtime> {
    let key = SecretKey::from_bytes([31; 32]);
    let package = needware_package::verify(&needware_package::build(app.clone(), vec![], &key)?)?;
    let caps = if read_only {
        vec![Capability::Storage {
            synchronized: false,
            write: false,
            collections: vec!["habits".into()],
        }]
    } else {
        app.capabilities
    };
    Ok(Runtime::load(
        package,
        state,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: caps,
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
fn add() -> Event {
    event(
        "add",
        BTreeMap::from([
            (
                "record_id".into(),
                Value::String("11111111-1111-4111-8111-111111111111".into()),
            ),
            ("name".into(), Value::String("read".into())),
        ]),
    )
}

#[test]
fn derived_fields_follow_dependencies_refresh_on_state_changes_and_reopen() -> Result {
    let app = app()?;
    let mut first = runtime(app.clone(), None, false)?;
    first.dispatch(&add())?;
    let row = &first.state().collections["habits"]["11111111-1111-4111-8111-111111111111"];
    assert_eq!(row["label"], Value::String("first read".into()));
    assert_eq!(row["a_length"], Value::Integer("10".into()));
    first.dispatch(&event(
        "prefix",
        BTreeMap::from([("prefix".into(), Value::String("new ".into()))]),
    ))?;
    let row = &first.state().collections["habits"]["11111111-1111-4111-8111-111111111111"];
    assert_eq!(row["label"], Value::String("new read".into()));
    assert_eq!(row["a_length"], Value::Integer("8".into()));
    let saved = first.state().clone();
    let mut reopened = runtime(app, Some(saved.clone()), false)?;
    assert_eq!(reopened.state(), &saved);
    for tamper in [Some(Value::Integer("9".into())), None] {
        let mut invalid = saved.clone();
        let row = invalid
            .collections
            .get_mut("habits")
            .ok_or("habits")?
            .get_mut("11111111-1111-4111-8111-111111111111")
            .ok_or("record")?;
        match tamper {
            Some(v) => {
                row.insert("a_length".into(), v);
            }
            None => {
                row.remove("a_length");
            }
        }
        assert!(reopened.restore(invalid).is_err());
        assert_eq!(reopened.state(), &saved);
    }
    Ok(())
}

#[test]
fn later_actions_in_a_transaction_read_updated_derived_values() -> Result {
    let mut app = app()?;
    app.state.insert("labels".into(), Value::List(vec![]));
    app.state_schema.insert(
        "labels".into(),
        field(
            DataType::List {
                item: Box::new(DataType::String),
            },
            None,
        ),
    );
    let create = app.actions.remove("add").ok_or("add")?;
    app.actions.insert(
        "add".into(),
        Action::Sequence {
            actions: vec![
                create,
                Action::Set {
                    key: "labels".into(),
                    value: Expr::Map {
                        collection: Box::new(Expr::Collection {
                            name: "habits".into(),
                        }),
                        value: Box::new(Expr::Item {
                            field: "label".into(),
                        }),
                    },
                },
            ],
        },
    );
    let mut runtime = runtime(app, None, false)?;
    runtime.dispatch(&add())?;
    assert_eq!(
        runtime.state().values["labels"],
        Value::List(vec![Value::String("first read".into())])
    );
    Ok(())
}

#[test]
fn reviewed_revisions_recompute_derived_dependencies_and_preserve_source_snapshot() -> Result {
    let original = app()?;
    let key = SecretKey::from_bytes([31; 32]);
    let source_package =
        needware_package::verify(&needware_package::build(original.clone(), vec![], &key)?)?;
    let mut source = runtime(original.clone(), None, false)?;
    source.dispatch(&add())?;
    let before = source.state().clone();
    let mut target = original.clone();
    target.parent = Some(source_package.digest());
    target.revision = "11111111-1111-4111-8111-111111111199".into();
    let expr = Expr::Concat {
        values: vec![
            Expr::State {
                key: "prefix".into(),
            },
            Expr::Item {
                field: "name".into(),
            },
            Expr::Literal {
                value: Value::String("!".into()),
            },
        ],
    };
    target
        .collections
        .get_mut("habits")
        .ok_or("habits")?
        .fields
        .get_mut("label")
        .ok_or("label")?
        .derived = Some(expr.clone());
    target.migrations.push(Migration {
        from_revision: original.revision,
        operations: vec![MigrationOp::Transform {
            collection: "habits".into(),
            field: "label".into(),
            value: expr,
        }],
    });
    let target_package =
        needware_package::verify(&needware_package::build(target.clone(), vec![], &key)?)?;
    let preview = source.preview_revision(target_package, &[key.public_key()])?;
    assert_eq!(preview.snapshot(), &before);
    assert_eq!(source.state(), &before);
    assert!(preview.report().migration.requires_confirmation);
    let digest = preview.report().review_digest.clone();
    let approved = preview.approve(
        &source,
        &digest,
        Grants {
            application: target.id,
            revision: target.revision,
            capabilities: target.capabilities,
        },
        true,
    )?;
    let row = &approved.state().collections["habits"]["11111111-1111-4111-8111-111111111111"];
    assert_eq!(row["label"], Value::String("first read!".into()));
    assert_eq!(row["a_length"], Value::Integer("11".into()));
    assert_eq!(source.state(), &before);
    Ok(())
}

#[test]
fn derived_failure_rolls_back_base_mutations_and_does_not_bypass_storage_consent() -> Result {
    let app = app()?;
    let mut first = runtime(app.clone(), None, false)?;
    first.dispatch(&add())?;
    let saved = first.state().clone();
    assert!(
        first
            .dispatch(&event(
                "divisor",
                BTreeMap::from([("divisor".into(), Value::Integer("0".into()))])
            ))
            .is_err()
    );
    assert_eq!(first.state(), &saved);
    let mut read_only = runtime(app.clone(), Some(saved.clone()), true)?;
    assert!(matches!(
        read_only.dispatch(&event(
            "prefix",
            BTreeMap::from([("prefix".into(), Value::String("denied ".into()))])
        )),
        Err(RuntimeError::Permission)
    ));
    assert_eq!(read_only.state(), &saved);
    let mut candidate = saved;
    assert_eq!(
        needware_validation::derived::materialize(
            &app,
            &mut candidate,
            &mut needware_expr::Budget::new(0)
        ),
        Err(needware_expr::EvalError::Limit)
    );
    Ok(())
}

#[test]
fn derived_cycles_ambient_inputs_wrong_types_defaults_and_direct_writes_reject() -> Result {
    let base = app()?;
    for expr in [
        Expr::Item {
            field: "label".into(),
        },
        Expr::Event { key: "name".into() },
        Expr::Context {
            key: ContextKey::Now,
        },
        Expr::Collection {
            name: "habits".into(),
        },
        Expr::Literal {
            value: Value::Integer("1".into()),
        },
    ] {
        let mut invalid = base.clone();
        invalid
            .collections
            .get_mut("habits")
            .ok_or("habits")?
            .fields
            .get_mut("label")
            .ok_or("label")?
            .derived = Some(expr);
        assert!(needware_validation::validate(invalid).is_err());
    }
    let mut mutual = base.clone();
    mutual
        .collections
        .get_mut("habits")
        .ok_or("habits")?
        .fields
        .get_mut("label")
        .ok_or("label")?
        .derived = Some(Expr::Concat {
        values: vec![Expr::Item {
            field: "a_length".into(),
        }],
    });
    assert!(needware_validation::validate(mutual).is_err());
    let mut default = base.clone();
    default
        .collections
        .get_mut("habits")
        .ok_or("habits")?
        .fields
        .get_mut("label")
        .ok_or("label")?
        .default = Some(Value::String("ignored".into()));
    assert!(needware_validation::validate(default).is_err());
    let mut unsupported = base.clone();
    unsupported
        .runtime_features
        .retain(|f| f != "derived_fields_v1");
    assert!(needware_validation::validate(unsupported).is_err());
    let mut direct = base;
    direct.actions.insert(
        "prefix".into(),
        Action::Update {
            collection: "habits".into(),
            id: Expr::Literal {
                value: Value::String("11111111-1111-4111-8111-111111111111".into()),
            },
            values: BTreeMap::from([(
                "label".into(),
                Expr::Literal {
                    value: Value::String("spoof".into()),
                },
            )]),
        },
    );
    assert!(needware_validation::validate(direct).is_err());
    Ok(())
}
