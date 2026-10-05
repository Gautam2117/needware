use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::{Action, Component, Expr, Value, examples::runtime_controls_demo};
use needware_runtime::{Event, Runtime};
use std::collections::BTreeMap;
fn load(app: needware_ir::Application) -> Result<Runtime, Box<dyn std::error::Error>> {
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
fn event(name: &str) -> Event {
    Event {
        action: name.into(),
        values: BTreeMap::new(),
        now: "2026-10-05T00:00:00Z".into(),
        timezone: "UTC".into(),
    }
}
#[test]
fn control_input_contracts_do_not_acknowledge_unsaved_values()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::widgets_example::application();
    app.runtime_features.push("runtime_controls_v1".into());
    let field = needware_ir::examples::habit_tracker().collections["habits"].fields["name"].clone();
    app.actions.insert(
        "details".into(),
        Action::Navigate {
            screen: app.initial_screen.clone(),
        },
    );
    let mut control = app.screens[0].root.clone();
    control.id = "details_button".into();
    control.kind = Component::Button;
    control.children.clear();
    control.action = Some("details".into());
    app.screens[0].root.children.push(control);
    app.event_schema.insert(
        "details".into(),
        BTreeMap::from([("name".into(), field.clone()), ("record_id".into(), field)]),
    );
    let mut runtime = load(app)?;
    let before = runtime.view()?;
    let state = runtime.state().clone();
    let button = before
        .children
        .iter()
        .find(|node| node.id == "details_button")
        .ok_or("missing navigation button")?;
    assert_eq!(
        button.event_fields.as_ref(),
        Some(&vec!["name".to_owned(), "record_id".to_owned()])
    );
    assert!(matches!(&button.acknowledged_fields, Some(fields) if fields.is_empty()));
    let mut navigation = event("details");
    navigation
        .values
        .insert("name".into(), Value::String("Keep this input".into()));
    navigation.values.insert(
        "record_id".into(),
        Value::String(uuid::Uuid::new_v4().to_string()),
    );
    runtime.dispatch(&navigation)?;
    assert_eq!(before.form_scope, runtime.view()?.form_scope);
    assert_eq!(&state, runtime.state());
    Ok(())
}
#[test]
fn legacy_event_inputs_remain_available_without_a_declared_schema()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::examples::habit_tracker();
    app.event_schema.remove("add");
    app.runtime_features
        .retain(|feature| feature != "typed_contracts_v1");
    let mut runtime = load(app)?;
    let view = runtime.view()?;
    let button = view
        .children
        .iter()
        .find(|node| node.id == "add")
        .ok_or("missing add button")?;
    assert_eq!(button.event_fields, button.acknowledged_fields);
    assert_eq!(
        button.event_fields.as_ref(),
        Some(&vec!["name".to_owned(), "record_id".to_owned()])
    );
    let id = uuid::Uuid::new_v4().to_string();
    let mut submission = event("add");
    submission
        .values
        .insert("name".into(), Value::String("Legacy input retained".into()));
    submission
        .values
        .insert("record_id".into(), Value::String(id.clone()));
    runtime.dispatch(&submission)?;
    assert_eq!(
        runtime.state().collections["habits"][&id]["name"],
        Value::String("Legacy input retained".into())
    );
    Ok(())
}
#[test]
fn repeated_input_metadata_is_bounded_before_projection_and_preserves_state()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::examples::habit_tracker();
    app.state
        .insert("output".into(), Value::String(String::new()));
    app.actions.insert(
        "wide".into(),
        Action::Set {
            key: "output".into(),
            value: Expr::Concat {
                values: (0..128)
                    .map(|index| Expr::Event {
                        key: format!("input_{index:03}"),
                    })
                    .collect(),
            },
        },
    );
    let mut button = app.screens[0].root.children[2].clone();
    button.id = "wide_button".into();
    button.action = Some("wide".into());
    app.screens[0].root.children[3].children = (0..16)
        .map(|index| {
            let mut repeated = button.clone();
            repeated.id = format!("wide_button_{index}");
            repeated
        })
        .collect();
    let mut runtime = load(app)?;
    let mut state = runtime.state().clone();
    for index in 1..=1600 {
        state
            .collections
            .get_mut("habits")
            .ok_or("missing habits")?
            .insert(
                uuid::Uuid::from_u128(index).to_string(),
                BTreeMap::from([
                    ("name".into(), Value::String("Row".into())),
                    ("done".into(), Value::Boolean(false)),
                ]),
            );
    }
    runtime.restore(state.clone())?;
    let result = runtime.view();
    assert!(
        matches!(&result, Err(needware_runtime::RuntimeError::Limit)),
        "projection result: {:?}",
        result.as_ref().map(|view| (
            view.children.len(),
            view.children.get(3).map(|node| node.children.len())
        ))
    );
    assert_eq!(runtime.state(), &state);
    Ok(())
}
#[test]
fn nested_navigation_and_back_are_atomic_and_bounded() -> Result<(), Box<dyn std::error::Error>> {
    let mut runtime = load(runtime_controls_demo())?;
    assert!(runtime.dispatch(&event("back")).is_err());
    runtime.dispatch(&event("sequence_navigation"))?;
    assert_eq!(runtime.view()?.id, "controls_details_root");
    runtime.dispatch(&event("back"))?;
    assert_eq!(runtime.view()?.id, "controls_home_root");
    for i in 0..128 {
        runtime.dispatch(&event(if i % 2 == 0 { "details" } else { "home" }))?;
    }
    runtime.dispatch(&event("details"))?;
    for _ in 0..128 {
        runtime.dispatch(&event("back"))?;
    }
    assert_eq!(runtime.view()?.id, "controls_details_root");
    assert!(runtime.dispatch(&event("back")).is_err());
    Ok(())
}
#[test]
fn failed_sequences_and_savepoints_restore_data_navigation_and_overlays()
-> Result<(), Box<dyn std::error::Error>> {
    let app = runtime_controls_demo();
    let mut runtime = load(app.clone())?;
    runtime.dispatch(&event("show_dialog"))?;
    let original = serde_json::to_string(&runtime.view()?)?;
    let state = runtime.state().clone();
    let cut = runtime.savepoint();
    assert!(runtime.dispatch(&event("failed_navigation")).is_err());
    assert_eq!(*runtime.state(), state);
    assert_eq!(serde_json::to_string(&runtime.view()?)?, original);
    runtime.dispatch(&event("details"))?;
    assert!(runtime.dispatch(&event("show_dialog")).is_err());
    runtime.restore_savepoint(&cut)?;
    assert_eq!(serde_json::to_string(&runtime.view()?)?, original);
    runtime.dispatch(&event("close_dialog"))?;
    let modal = runtime
        .view()?
        .children
        .into_iter()
        .find(|child| child.id == "control_dialog")
        .ok_or("modal")?;
    assert!(!modal.open);
    assert!(modal.children.is_empty());
    let mut unrelated = load(app)?;
    assert!(unrelated.restore_savepoint(&cut).is_err());
    Ok(())
}
#[test]
fn overlay_limits_and_active_order_preserve_prior_cut() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = runtime_controls_demo();
    for i in 0..5 {
        let id = format!("extra_overlay_{i}");
        let close = format!("close_extra_{i}");
        let show = format!("show_extra_{i}");
        let mut node = app.screens[0]
            .root
            .children
            .iter()
            .find(|node| node.kind == Component::Modal)
            .ok_or("modal")?
            .clone();
        node.id = id.clone();
        node.children.clear();
        node.action = Some(close.clone());
        app.actions.insert(
            close,
            Action::Close {
                overlay: id.clone(),
            },
        );
        app.actions.insert(show, Action::Open { overlay: id });
        app.screens[0].root.children.push(node);
    }
    let mut runtime = load(app)?;
    for i in 0..4 {
        runtime.dispatch(&event(&format!("show_extra_{i}")))?;
    }
    let before = serde_json::to_string(&runtime.view()?)?;
    assert!(runtime.dispatch(&event("show_extra_4")).is_err());
    assert_eq!(serde_json::to_string(&runtime.view()?)?, before);
    let active: Vec<_> = runtime
        .view()?
        .children
        .into_iter()
        .filter(|node| node.active_overlay)
        .collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].id, "extra_overlay_3");
    runtime.dispatch(&event("close_extra_3"))?;
    assert!(
        runtime
            .view()?
            .children
            .iter()
            .any(|node| node.id == "extra_overlay_2" && node.active_overlay)
    );
    Ok(())
}
#[test]
fn overlay_declarations_require_feature_target_and_own_close_action()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = runtime_controls_demo();
    app.runtime_features.push("declarative_widgets_v1".into());
    app.screens[0]
        .root
        .children
        .iter_mut()
        .find(|node| node.kind == Component::Modal)
        .ok_or("modal")?
        .disabled = Some(Expr::Literal {
        value: Value::Boolean(true),
    });
    assert!(needware_validation::validate(app).is_err());
    let mut app = runtime_controls_demo();
    app.runtime_features.clear();
    assert!(needware_validation::validate(app).is_err());
    let mut app = runtime_controls_demo();
    app.actions.insert(
        "wrong".into(),
        Action::Open {
            overlay: "missing".into(),
        },
    );
    assert!(needware_validation::validate(app).is_err());
    let mut app = runtime_controls_demo();
    let modal = app.screens[0]
        .root
        .children
        .iter_mut()
        .find(|node| node.kind == Component::Modal)
        .ok_or("modal")?;
    modal.action = None;
    assert!(needware_validation::validate(app).is_err());
    let mut app = runtime_controls_demo();
    let modal = app.screens[0]
        .root
        .children
        .iter()
        .find(|node| node.kind == Component::Modal)
        .ok_or("modal")?
        .clone();
    let mut list = app.screens[0].root.children[0].clone();
    list.id = "invalid_repeated_overlays".into();
    list.kind = Component::List;
    list.text = Some(Expr::Literal {
        value: Value::String("Rows".into()),
    });
    list.collection = Some("habits".into());
    list.children = vec![modal];
    app.screens[0]
        .root
        .children
        .retain(|node| node.kind != Component::Modal);
    app.screens[0].root.children.push(list);
    assert!(needware_validation::validate(app).is_err());
    Ok(())
}
