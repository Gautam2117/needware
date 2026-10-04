use needware_ir::*;
use needware_validation::{validate, validate_event, validate_state};
use std::collections::BTreeMap;

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
fn app() -> Application {
    let mut app = examples::habit_tracker();
    app.runtime_features.push("typed_contracts_v1".into());
    app.state.insert("selection".into(), Value::Null);
    app.state.insert("numbers".into(), Value::List(vec![]));
    app.state_schema.insert(
        "selection".into(),
        field(DataType::Optional {
            inner: Box::new(DataType::String),
        }),
    );
    app.state_schema.insert(
        "numbers".into(),
        field(DataType::List {
            item: Box::new(DataType::Integer),
        }),
    );
    app.event_schema = app
        .actions
        .keys()
        .map(|action| {
            let mut fields = BTreeMap::from([("record_id".into(), field(DataType::String))]);
            if action == "add" {
                fields.insert("name".into(), field(DataType::String));
            }
            (action.clone(), fields)
        })
        .collect();
    app
}

#[test]
fn contracts_cover_state_and_actions_and_preserve_legacy_serialization()
-> Result<(), Box<dyn std::error::Error>> {
    let base = app();
    validate(base.clone())?;
    let mut missing_state = base.clone();
    missing_state.state_schema.remove("selection");
    assert!(validate(missing_state).is_err());
    let mut missing_action = base.clone();
    missing_action.event_schema.remove("add");
    assert!(validate(missing_action).is_err());
    let mut extra_action = base.clone();
    extra_action
        .event_schema
        .insert("unknown".into(), BTreeMap::new());
    assert!(validate(extra_action).is_err());
    let mut missing_feature = base;
    missing_feature.runtime_features.clear();
    assert!(validate(missing_feature).is_err());
    let legacy = examples::habit_tracker();
    let bytes = serde_json::to_vec(&legacy)?;
    let json: serde_json::Value = serde_json::from_slice(&bytes)?;
    assert!(json.get("state_schema").is_none());
    assert!(json.get("event_schema").is_none());
    assert_eq!(serde_json::from_slice::<Application>(&bytes)?, legacy);
    Ok(())
}

#[test]
fn declared_null_and_empty_collections_enforce_persisted_types()
-> Result<(), Box<dyn std::error::Error>> {
    let app = app();
    validate(app.clone())?;
    let mut state = State::empty(&app);
    state
        .values
        .insert("selection".into(), Value::String("chosen".into()));
    state.values.insert(
        "numbers".into(),
        Value::List(vec![Value::Integer("4".into())]),
    );
    validate_state(&state, &app)?;
    state.values.insert(
        "numbers".into(),
        Value::List(vec![Value::String("4".into())]),
    );
    assert!(validate_state(&state, &app).is_err());
    state.values.insert("numbers".into(), Value::List(vec![]));
    state
        .values
        .insert("selection".into(), Value::Boolean(true));
    assert!(validate_state(&state, &app).is_err());
    let mut wrong_initial = app;
    wrong_initial
        .state
        .insert("selection".into(), Value::Boolean(true));
    assert!(validate(wrong_initial).is_err());
    Ok(())
}

#[test]
fn action_context_rejects_unknown_inputs_bad_assignment_and_unsafe_optional_use()
-> Result<(), Box<dyn std::error::Error>> {
    let base = app();
    let mut typo = base.clone();
    typo.actions.insert(
        "remove".into(),
        Action::Delete {
            collection: "habits".into(),
            id: Expr::Event { key: "typo".into() },
        },
    );
    assert!(validate(typo).is_err());
    let mut wrong = base.clone();
    wrong
        .event_schema
        .get_mut("add")
        .ok_or("missing test schema")?
        .insert("name".into(), field(DataType::Boolean));
    assert!(validate(wrong).is_err());
    let mut optional = base.clone();
    optional
        .event_schema
        .get_mut("add")
        .ok_or("missing test schema")?
        .insert(
            "name".into(),
            field(DataType::Optional {
                inner: Box::new(DataType::String),
            }),
        );
    assert!(validate(optional).is_err());
    let mut wrong_state = base.clone();
    wrong_state.actions.insert(
        "remove".into(),
        Action::Set {
            key: "numbers".into(),
            value: Expr::Literal {
                value: Value::List(vec![Value::Boolean(true)]),
            },
        },
    );
    assert!(validate(wrong_state).is_err());
    let mut view_event = base;
    view_event.screens[0].root.text = Some(Expr::Event { key: "name".into() });
    assert!(validate(view_event).is_err());
    Ok(())
}

#[test]
fn runtime_input_validation_rejects_missing_unknown_wrong_types_and_limits()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = app();
    app.event_schema
        .get_mut("add")
        .ok_or("add")?
        .get_mut("name")
        .ok_or("name")?
        .max_length = Some(3);
    let inputs = BTreeMap::from([
        ("record_id".into(), Value::String("id".into())),
        ("name".into(), Value::String("abc".into())),
    ]);
    validate_event("add", &inputs, &app)?;
    let mut missing = inputs.clone();
    missing.remove("name");
    assert!(validate_event("add", &missing, &app).is_err());
    let mut unknown = inputs.clone();
    unknown.insert("unused".into(), Value::Null);
    assert!(validate_event("add", &unknown, &app).is_err());
    let mut wrong = inputs.clone();
    wrong.insert("name".into(), Value::Boolean(false));
    assert!(validate_event("add", &wrong, &app).is_err());
    let mut long = inputs;
    long.insert("name".into(), Value::String("abcd".into()));
    assert!(validate_event("add", &long, &app).is_err());
    assert!(validate_event("absent", &BTreeMap::new(), &app).is_err());
    Ok(())
}

#[test]
fn input_constraints_are_checked_even_without_initial_or_test_values()
-> Result<(), Box<dyn std::error::Error>> {
    let base = app();
    let mut default = base.clone();
    default
        .event_schema
        .get_mut("add")
        .ok_or("missing test schema")?
        .get_mut("name")
        .ok_or("missing test schema")?
        .default = Some(Value::String("x".into()));
    assert!(validate(default).is_err());
    let mut nested = base.clone();
    let mut derived = field(DataType::Integer);
    derived.derived = Some(Expr::Literal {
        value: Value::Integer("1".into()),
    });
    nested
        .event_schema
        .get_mut("remove")
        .ok_or("missing test schema")?
        .insert(
            "nested".into(),
            field(DataType::Record {
                fields: BTreeMap::from([("value".into(), derived)]),
            }),
        );
    assert!(validate(nested).is_err());
    let mut bound = base.clone();
    bound
        .event_schema
        .get_mut("remove")
        .ok_or("missing test schema")?
        .get_mut("record_id")
        .ok_or("missing test schema")?
        .minimum = Some("1".into());
    assert!(validate(bound).is_err());
    let mut inverted = base;
    let mut integer = field(DataType::Integer);
    integer.minimum = Some("2".into());
    integer.maximum = Some("1".into());
    inverted
        .event_schema
        .get_mut("remove")
        .ok_or("missing test schema")?
        .insert("count".into(), integer);
    assert!(validate(inverted).is_err());
    Ok(())
}
