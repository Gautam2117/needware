use needware_capabilities::{Capability, Grants};
use needware_crypto::SecretKey;
use needware_ir::{Action, DataType, Expr, Field, Value};
use needware_runtime::{EffectOutcome, Event, Runtime};
use std::collections::BTreeMap;
type Result = std::result::Result<(), Box<dyn std::error::Error>>;
fn definition() -> needware_ir::Application {
    let mut app = needware_ir::widgets_example::application();
    app.runtime_features.push("typed_effects_v1".into());
    app.capabilities.push(Capability::Clipboard { read: false });
    app.state.insert("copied".into(), Value::Boolean(false));
    app.state_schema.insert(
        "copied".into(),
        Field {
            data_type: DataType::Boolean,
            default: None,
            max_length: None,
            minimum: None,
            maximum: None,
            derived: None,
        },
    );
    app.actions.insert(
        "copy".into(),
        Action::AwaitEffect {
            capability: Capability::Clipboard { read: false },
            input: Expr::Event { key: "name".into() },
            output: app.state_schema["copied"].clone(),
            on_success: Box::new(Action::Sequence {
                actions: vec![
                    Action::Set {
                        key: "copied".into(),
                        value: Expr::Event {
                            key: "result".into(),
                        },
                    },
                    Action::Set {
                        key: "name".into(),
                        value: Expr::Event { key: "name".into() },
                    },
                ],
            }),
            on_failure: Box::new(Action::Set {
                key: "name".into(),
                value: Expr::Event {
                    key: "error".into(),
                },
            }),
        },
    );
    app.event_schema.insert(
        "copy".into(),
        BTreeMap::from([("name".into(), app.state_schema["name"].clone())]),
    );
    app
}
fn load(
    app: needware_ir::Application,
    capabilities: Option<Vec<Capability>>,
) -> std::result::Result<Runtime, Box<dyn std::error::Error>> {
    let key = SecretKey::from_bytes([13; 32]);
    let bytes = needware_package::build(app.clone(), vec![], &key)?;
    Ok(Runtime::load(
        needware_package::verify(&bytes)?,
        None,
        Grants {
            application: app.id,
            revision: app.revision,
            capabilities: capabilities.unwrap_or(app.capabilities),
        },
        &[key.public_key()],
    )?)
}
fn request() -> Event {
    Event {
        action: "copy".into(),
        values: BTreeMap::from([("name".into(), Value::String("Known clipboard input".into()))]),
        now: "2026-10-05T00:00:00Z".into(),
        timezone: "UTC".into(),
    }
}
#[test]
fn typed_completion_is_atomic_one_shot_and_savepoints_restore_pending_intents() -> Result {
    let mut runtime = load(definition(), None)?;
    let original = runtime.state().clone();
    let effect = runtime.dispatch(&request())?.remove(0);
    assert_eq!(runtime.state(), &original);
    assert_eq!(effect.input, request().values["name"]);
    let cut = runtime.savepoint();
    assert!(
        runtime
            .complete_effect(
                &effect.id,
                EffectOutcome::Success {
                    value: Value::String("wrong output".into())
                }
            )
            .is_err()
    );
    assert_eq!(runtime.state(), &original);
    assert_eq!(runtime.pending_effects().len(), 1);
    runtime.complete_effect(
        &effect.id,
        EffectOutcome::Success {
            value: Value::Boolean(true),
        },
    )?;
    assert_eq!(runtime.state().values["copied"], Value::Boolean(true));
    assert_eq!(runtime.state().values["name"], request().values["name"]);
    assert!(runtime.pending_effects().is_empty());
    assert!(
        runtime
            .complete_effect(
                &effect.id,
                EffectOutcome::Success {
                    value: Value::Boolean(true)
                }
            )
            .is_err()
    );
    runtime.restore_savepoint(&cut)?;
    assert_eq!(runtime.state(), &original);
    assert_eq!(runtime.pending_effects()[0].id, effect.id);
    runtime.complete_effect(
        &effect.id,
        EffectOutcome::Failure {
            code: "permission_denied".into(),
        },
    )?;
    assert_eq!(
        runtime.state().values["name"],
        Value::String("permission_denied".into())
    );
    Ok(())
}
#[test]
fn completion_is_bound_to_exact_state_and_scope_and_slots_are_bounded() -> Result {
    let mut runtime = load(definition(), None)?;
    runtime.bind_execution_scope("document:one:epoch:1")?;
    let original = runtime.state().clone();
    let effect = runtime.dispatch(&request())?.remove(0);
    assert!(
        runtime
            .bind_execution_scope("document:two:epoch:1")
            .is_err()
    );
    let mut changed = original.clone();
    changed
        .values
        .insert("name".into(), Value::String("Newer saved edit".into()));
    runtime.restore(changed.clone())?;
    assert!(
        runtime
            .complete_effect(
                &effect.id,
                EffectOutcome::Success {
                    value: Value::Boolean(true)
                }
            )
            .is_err()
    );
    assert_eq!(runtime.state(), &changed);
    assert_eq!(runtime.pending_effects().len(), 1);
    runtime.discard_effect(&effect.id)?;
    runtime.bind_execution_scope("document:two:epoch:1")?;
    for _ in 0..4 {
        runtime.dispatch(&request())?;
    }
    let checkpoint = runtime.effect_checkpoint()?;
    assert!(runtime.dispatch(&request()).is_err());
    assert_eq!(runtime.effect_checkpoint()?, checkpoint);
    Ok(())
}
#[test]
fn cold_checkpoint_revalidates_signed_action_and_rejects_tampering_and_cross_scope() -> Result {
    let app = definition();
    let mut runtime = load(app.clone(), None)?;
    runtime.bind_execution_scope("document:one")?;
    let effect = runtime.dispatch(&request())?.remove(0);
    let checkpoint = runtime.effect_checkpoint()?;
    let mut cold = load(app.clone(), None)?;
    cold.bind_execution_scope("document:one")?;
    cold.restore_effect_checkpoint(&checkpoint)?;
    cold.complete_effect(
        &effect.id,
        EffectOutcome::Success {
            value: Value::Boolean(true),
        },
    )?;
    let mut wrong = load(app.clone(), None)?;
    wrong.bind_execution_scope("document:other")?;
    assert!(wrong.restore_effect_checkpoint(&checkpoint).is_err());
    assert!(wrong.pending_effects().is_empty());
    let mut forged: serde_json::Value = serde_json::from_str(&checkpoint)?;
    forged["records"][0]["effect"]["input"] =
        serde_json::json!({"type":"string","value":"Forged private export"});
    let mut target = load(app, None)?;
    target.bind_execution_scope("document:one")?;
    assert!(
        target
            .restore_effect_checkpoint(&serde_json::to_string(&forged)?)
            .is_err()
    );
    assert!(target.pending_effects().is_empty());
    Ok(())
}
#[test]
fn missing_grants_and_mixed_mutations_never_publish_an_intent() -> Result {
    let mut app = definition();
    let without = app
        .capabilities
        .iter()
        .filter(|capability| !matches!(capability, Capability::Clipboard { .. }))
        .cloned()
        .collect();
    let mut denied = load(app.clone(), Some(without))?;
    let original = denied.state().clone();
    assert!(denied.dispatch(&request()).is_err());
    assert_eq!(denied.state(), &original);
    assert!(denied.pending_effects().is_empty());
    let action = app.actions["copy"].clone();
    app.actions.insert(
        "copy".into(),
        Action::Sequence {
            actions: vec![
                Action::Set {
                    key: "name".into(),
                    value: Expr::Literal {
                        value: Value::String("Must not commit".into()),
                    },
                },
                action,
            ],
        },
    );
    let mut mixed = load(app, None)?;
    let original = mixed.state().clone();
    assert!(mixed.dispatch(&request()).is_err());
    assert_eq!(mixed.state(), &original);
    assert!(mixed.pending_effects().is_empty());
    Ok(())
}
#[test]
fn completion_cannot_smuggle_a_second_effect_or_navigation() -> Result {
    for callback in [
        Action::Effect {
            capability: Capability::Clipboard { read: false },
            input: Expr::Literal {
                value: Value::String("Unreviewed second export".into()),
            },
        },
        Action::Navigate {
            screen: "widgets".into(),
        },
    ] {
        let mut app = definition();
        if let Some(Action::AwaitEffect { on_success, .. }) = app.actions.get_mut("copy") {
            **on_success = callback;
        }
        assert!(needware_validation::validate(app).is_err());
    }
    Ok(())
}

#[test]
fn bounded_checkpoints_remain_cold_restorable_after_rejected_aggregate_request() -> Result {
    let mut app = definition();
    let mut field = app.state_schema.get("name").ok_or("name")?.clone();
    field.max_length = Some(65_536);
    let mut event = request();
    for index in 0..12 {
        let name = format!("retained_{index}");
        app.event_schema
            .get_mut("copy")
            .ok_or("copy")?
            .insert(name.clone(), field.clone());
        event.values.insert(name, Value::String("a".repeat(65_500)));
    }
    let mut runtime = load(app.clone(), None)?;
    runtime.dispatch(&event)?;
    runtime.dispatch(&event)?;
    let checkpoint = runtime.effect_checkpoint()?;
    assert!(checkpoint.len() > 1024 * 1024 && checkpoint.len() <= 2 * 1024 * 1024);
    assert!(runtime.dispatch(&event).is_err());
    assert_eq!(runtime.effect_checkpoint()?, checkpoint);
    let mut cold = load(app, None)?;
    cold.restore_effect_checkpoint(&checkpoint)?;
    assert_eq!(cold.effect_checkpoint()?, checkpoint);
    assert!(
        cold.restore_effect_checkpoint(&" ".repeat(2 * 1024 * 1024 + 1))
            .is_err()
    );
    assert_eq!(cold.effect_checkpoint()?, checkpoint);
    Ok(())
}
