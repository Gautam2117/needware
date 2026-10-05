use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::{Action, Component, Expr, Value, widgets_example};
use needware_runtime::{Event, Runtime};
use std::collections::BTreeMap;
type Result = std::result::Result<(), Box<dyn std::error::Error>>;
fn runtime() -> std::result::Result<Runtime, Box<dyn std::error::Error>> {
    let app = widgets_example::application();
    let key = SecretKey::from_bytes([13; 32]);
    let bytes = needware_package::build(app.clone(), vec![], &key)?;
    Ok(Runtime::load(
        needware_package::verify(&bytes)?,
        None,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: app.capabilities,
        },
        &[key.public_key()],
    )?)
}
#[test]
fn bindings_scope_contracts_and_decimal_values_survive_native_cut() -> Result {
    let runtime = runtime()?;
    let view = runtime.view()?;
    let input = &view.children[1].children[1];
    assert_eq!(input.form_scope.as_deref(), Some("primary_form"));
    assert_eq!(input.value.as_ref(), runtime.state().values.get("amount"));
    assert!(input.input_contract.is_some());
    assert_eq!(
        view.children[2].children[0].form_scope.as_deref(),
        Some("secondary_form")
    );
    Ok(())
}
#[test]
fn invalid_projection_and_external_contract_events_never_change_data() -> Result {
    let mut runtime = runtime()?;
    let before = runtime.state().clone();
    let mut event = Event {
        action: "invalid_progress".into(),
        values: BTreeMap::new(),
        now: "2026-10-05T00:00:00Z".into(),
        timezone: "UTC".into(),
    };
    assert!(runtime.dispatch(&event).is_err());
    assert_eq!(*runtime.state(), before);
    event.action = "save_primary".into();
    event.values = before.values.clone();
    event.values.remove("secondary_name");
    event
        .values
        .insert("amount".into(), Value::String("9007199254740993.01".into()));
    assert!(runtime.dispatch(&event).is_err());
    assert_eq!(*runtime.state(), before);
    event.values = before.values.clone();
    event.values.remove("secondary_name");
    runtime.dispatch(&event)?;
    assert_eq!(*runtime.state(), before);
    Ok(())
}
#[test]
fn features_contracts_options_and_nested_forms_fail_closed() -> Result {
    let original = widgets_example::application();
    let mut app = original.clone();
    app.runtime_features
        .retain(|f| f != "declarative_widgets_v1");
    assert!(needware_validation::validate(app).is_err());
    let mut app = original.clone();
    app.screens[0].root.children[1].children[2].kind = Component::NumericInput;
    assert!(needware_validation::validate(app).is_err());
    let mut app = original.clone();
    app.screens[0].root.children[1].children[4]
        .options
        .push("Forged".into());
    assert!(needware_validation::validate(app).is_err());
    let mut app = original.clone();
    let second = app.screens[0].root.children.remove(2);
    app.screens[0].root.children[1].children.push(second);
    assert!(needware_validation::validate(app).is_err());
    let mut app = original;
    app.actions.insert(
        "invalid".into(),
        Action::Set {
            key: "level".into(),
            value: Expr::Literal {
                value: Value::Integer("0".into()),
            },
        },
    );
    assert!(needware_validation::validate(app).is_err());
    Ok(())
}
