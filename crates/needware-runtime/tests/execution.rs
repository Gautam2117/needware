use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::{Action, Expr, Value, examples::habit_tracker};
use needware_runtime::{Event, Runtime};
use std::collections::BTreeMap;
fn runtime(app: needware_ir::Application) -> Result<Runtime, Box<dyn std::error::Error>> {
    let key = SecretKey::from_bytes([7; 32]);
    let bytes = needware_package::build(app.clone(), vec![], &key)?;
    let package = needware_package::verify(&bytes)?;
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
fn event(action: &str, name: &str) -> Event {
    Event {
        action: action.into(),
        values: BTreeMap::from([
            (
                "record_id".into(),
                Value::String("bfa88e2a-894c-44aa-bf03-69712c7018d3".into()),
            ),
            ("name".into(), Value::String(name.into())),
        ]),
        now: "2026-10-03T00:00:00Z".into(),
        timezone: "UTC".into(),
    }
}
#[test]
fn real_application_add_toggle_delete_and_snapshot_restore()
-> Result<(), Box<dyn std::error::Error>> {
    let mut r = runtime(habit_tracker())?;
    r.dispatch(&event("add", "Read"))?;
    assert_eq!(r.state().collections["habits"].len(), 1);
    let snapshot = r.state().clone();
    r.dispatch(&event("toggle", ""))?;
    assert_eq!(
        r.state().collections["habits"]
            .values()
            .next()
            .and_then(|v| v.get("done")),
        Some(&Value::Boolean(true))
    );
    assert!(r.view().is_ok());
    r.dispatch(&event("remove", ""))?;
    assert!(r.state().collections["habits"].is_empty());
    r.restore(snapshot)?;
    assert_eq!(r.state().collections["habits"].len(), 1);
    Ok(())
}
#[test]
fn failed_sequence_is_atomic() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = habit_tracker();
    let add = app.actions["add"].clone();
    app.actions.insert(
        "atomic".into(),
        Action::Sequence {
            actions: vec![add.clone(), add],
        },
    );
    let mut r = runtime(app)?;
    assert!(r.dispatch(&event("atomic", "Read")).is_err());
    assert!(r.state().collections["habits"].is_empty());
    Ok(())
}
#[test]
fn expression_fuel_is_shared_across_actions_and_rolls_back()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = habit_tracker();
    app.state
        .insert("counter".into(), Value::Integer("0".into()));
    let mut body = Expr::Item { field: "n".into() };
    // Cheap scalar conditions make node fuel, rather than copied-data limits,
    // the binding resource for this regression.
    for _ in 0..4 {
        body = Expr::If {
            condition: Box::new(Expr::Literal {
                value: Value::Boolean(true),
            }),
            yes: Box::new(body),
            no: Box::new(Expr::Literal { value: Value::Null }),
        };
    }
    let expensive = Action::Set {
        key: "counter".into(),
        value: Expr::Length {
            value: Box::new(Expr::Map {
                collection: Box::new(Expr::Event { key: "rows".into() }),
                value: Box::new(body),
            }),
        },
    };
    let first_mutation = Action::Set {
        key: "counter".into(),
        value: Expr::Literal {
            value: Value::Integer("1".into()),
        },
    };
    let left = Action::Sequence {
        actions: vec![expensive.clone(); 100],
    };
    let right = Action::Sequence {
        actions: vec![expensive.clone(); 101],
    };
    let branch = |condition: bool, selected: Action| Action::Conditional {
        condition: Expr::Literal {
            value: Value::Boolean(condition),
        },
        yes: Box::new(if condition {
            selected.clone()
        } else {
            first_mutation.clone()
        }),
        no: Some(Box::new(if condition {
            first_mutation.clone()
        } else {
            selected
        })),
    };
    let groups = [
        (
            "sequence",
            Action::Sequence {
                actions: vec![expensive.clone(); 201],
            },
        ),
        (
            "nested",
            Action::Sequence {
                actions: vec![left.clone(), right.clone()],
            },
        ),
        (
            "conditional",
            Action::Sequence {
                actions: vec![branch(true, left.clone()), branch(false, right.clone())],
            },
        ),
        (
            "parallel",
            Action::Parallel {
                actions: vec![left, right],
            },
        ),
    ];
    app.actions.insert("bounded".into(), expensive);
    let mut input = event("exhaust", "");
    let row = Value::Map(BTreeMap::from([("n".into(), Value::Integer("1".into()))]));
    input
        .values
        .insert("rows".into(), Value::List(vec![row; 1000]));
    for (name, group) in groups {
        let mut candidate = app.clone();
        candidate.actions.insert(
            "exhaust".into(),
            Action::Sequence {
                actions: vec![first_mutation.clone(), group],
            },
        );
        let mut r = runtime(candidate)?;
        input.action = "exhaust".into();
        for _ in 0..2 {
            assert!(
                matches!(
                    r.dispatch(&input),
                    Err(needware_runtime::RuntimeError::Limit)
                ),
                "{name}"
            );
            assert_eq!(
                r.state().values["counter"],
                Value::Integer("0".into()),
                "{name}"
            );
        }
        input.action = "bounded".into();
        r.dispatch(&input)?;
        assert_eq!(r.state().values["counter"], Value::Integer("1000".into()));
    }
    Ok(())
}
#[test]
fn tamper_unknown_signer_and_invalid_field_are_rejected() -> Result<(), Box<dyn std::error::Error>>
{
    let app = habit_tracker();
    let key = SecretKey::from_bytes([7; 32]);
    let mut bytes = needware_package::build(app.clone(), vec![], &key)?;
    let grants = Grants {
        application: app.id.clone(),
        revision: app.revision.clone(),
        capabilities: app.capabilities.clone(),
    };
    assert!(Runtime::load(needware_package::verify(&bytes)?, None, grants, &[]).is_err());
    bytes[25] ^= 1;
    assert!(needware_package::verify(&bytes).is_err());
    let mut r = runtime(app.clone())?;
    assert!(r.dispatch(&event("add", &"x".repeat(121))).is_err());
    assert!(r.state().collections["habits"].is_empty());
    let mut bad = app;
    bad.actions.insert(
        "invalid".into(),
        Action::Set {
            key: "missing".into(),
            value: Expr::Literal { value: Value::Null },
        },
    );
    assert!(needware_validation::validate(bad).is_err());
    Ok(())
}
#[test]
fn copied_value_limit_rolls_back_prior_mutations() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = habit_tracker();
    app.state
        .insert("counter".into(), Value::Integer("0".into()));
    app.actions.insert(
        "amplify".into(),
        Action::Sequence {
            actions: vec![
                Action::Set {
                    key: "counter".into(),
                    value: Expr::Literal {
                        value: Value::Integer("1".into()),
                    },
                },
                Action::Set {
                    key: "counter".into(),
                    value: Expr::Length {
                        value: Box::new(Expr::Map {
                            collection: Box::new(Expr::Event { key: "rows".into() }),
                            value: Box::new(Expr::Literal {
                                value: Value::String("x".repeat(65536)),
                            }),
                        }),
                    },
                },
            ],
        },
    );
    let mut runtime = runtime(app)?;
    let mut input = event("amplify", "");
    input.values.insert(
        "rows".into(),
        Value::List(vec![Value::Map(BTreeMap::new()); 1000]),
    );
    assert!(matches!(
        runtime.dispatch(&input),
        Err(needware_runtime::RuntimeError::Limit)
    ));
    assert_eq!(
        runtime.state().values["counter"],
        Value::Integer("0".into())
    );
    input.values.insert(
        "rows".into(),
        Value::List(vec![Value::Map(BTreeMap::new()); 2]),
    );
    runtime.dispatch(&input)?;
    assert_eq!(
        runtime.state().values["counter"],
        Value::Integer("2".into())
    );
    Ok(())
}
#[test]
fn dynamically_wrong_state_type_and_delete_identifier_roll_back()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = habit_tracker();
    app.state
        .insert("counter".into(), Value::Integer("0".into()));
    app.actions.insert(
        "dynamic".into(),
        Action::Sequence {
            actions: vec![
                Action::Set {
                    key: "counter".into(),
                    value: Expr::Literal {
                        value: Value::Integer("1".into()),
                    },
                },
                Action::Set {
                    key: "counter".into(),
                    value: Expr::Event {
                        key: "wrong".into(),
                    },
                },
            ],
        },
    );
    let mut r = runtime(app)?;
    let mut input = event("dynamic", "");
    input
        .values
        .insert("wrong".into(), Value::String("bad".into()));
    assert!(r.dispatch(&input).is_err());
    assert_eq!(r.state().values["counter"], Value::Integer("0".into()));
    input.action = "remove".into();
    input
        .values
        .insert("record_id".into(), Value::Map(BTreeMap::new()));
    assert!(r.dispatch(&input).is_err());
    assert_eq!(r.state().values["counter"], Value::Integer("0".into()));
    Ok(())
}
