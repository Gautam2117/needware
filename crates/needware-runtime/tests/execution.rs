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
