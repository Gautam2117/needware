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
    let expensive = Action::Set {
        key: "counter".into(),
        value: Expr::Length {
            value: Box::new(Expr::Map {
                collection: Box::new(Expr::Event { key: "rows".into() }),
                value: Box::new(Expr::Item { field: "n".into() }),
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
        .insert("rows".into(), Value::List(vec![row; 5000]));
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
        assert_eq!(r.state().values["counter"], Value::Integer("5000".into()));
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
