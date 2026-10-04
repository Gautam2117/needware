use needware_ir::*;
use needware_validation::{validate, validate_state};
use std::collections::BTreeMap;
fn lit(v: Value) -> Expr {
    Expr::Literal { value: v }
}
#[test]
fn known_operator_branch_condition_and_assignment_errors_reject_before_execution() {
    let base = examples::habit_tracker();
    let expressions = [
        Expr::Binary {
            operator: BinaryOp::Add,
            left: Box::new(lit(Value::String("bad".into()))),
            right: Box::new(lit(Value::Integer("1".into()))),
        },
        Expr::Not {
            value: Box::new(lit(Value::Integer("1".into()))),
        },
        Expr::If {
            condition: Box::new(lit(Value::Boolean(true))),
            yes: Box::new(lit(Value::String("a".into()))),
            no: Box::new(lit(Value::Integer("1".into()))),
        },
        Expr::Filter {
            collection: Box::new(Expr::Collection {
                name: "habits".into(),
            }),
            predicate: Box::new(Expr::Item {
                field: "name".into(),
            }),
        },
    ];
    for expression in expressions {
        let mut app = base.clone();
        app.screens[0].root.text = Some(expression);
        assert!(validate(app).is_err());
    }
    let mut app = base.clone();
    app.actions.insert(
        "bad".into(),
        Action::Update {
            collection: "habits".into(),
            id: Expr::Event {
                key: "record_id".into(),
            },
            values: BTreeMap::from([("done".into(), lit(Value::String("false".into())))]),
        },
    );
    assert!(validate(app).is_err());
    let mut app = base.clone();
    app.actions.insert(
        "bad".into(),
        Action::Conditional {
            condition: lit(Value::Integer("1".into())),
            yes: Box::new(Action::Navigate {
                screen: "home".into(),
            }),
            no: None,
        },
    );
    assert!(validate(app).is_err());
    let mut app = base;
    app.actions.insert(
        "bad".into(),
        Action::Delete {
            collection: "habits".into(),
            id: lit(Value::Integer("1".into())),
        },
    );
    assert!(validate(app).is_err());
}
#[test]
fn collection_iteration_infers_the_nested_item_and_checks_missing_fields() {
    let mut app = examples::habit_tracker();
    app.screens[0].root.text = Some(Expr::Concat {
        values: vec![Expr::Map {
            collection: Box::new(Expr::Collection {
                name: "habits".into(),
            }),
            value: Box::new(Expr::Item {
                field: "done".into(),
            }),
        }],
    });
    assert!(validate(app.clone()).is_ok());
    app.screens[0].root.text = Some(Expr::Sort {
        collection: Box::new(Expr::Collection {
            name: "habits".into(),
        }),
        field: "missing".into(),
        descending: false,
    });
    assert!(validate(app).is_err());
    let mut app = examples::habit_tracker();
    app.screens[0].root.text = Some(Expr::Item {
        field: "done".into(),
    });
    assert!(validate(app).is_err());
    let mut app = examples::habit_tracker();
    app.actions.insert(
        "bad".into(),
        Action::Create {
            collection: "habits".into(),
            id: Expr::Event {
                key: "record_id".into(),
            },
            values: BTreeMap::from([(
                "name".into(),
                Expr::Item {
                    field: "name".into(),
                },
            )]),
        },
    );
    assert!(validate(app).is_err());
}
#[test]
fn persisted_state_cannot_change_an_inferred_scalar_type() {
    let mut app = examples::habit_tracker();
    app.state.insert("count".into(), Value::Integer("0".into()));
    let mut state = State::empty(&app);
    state
        .values
        .insert("count".into(), Value::String("0".into()));
    assert!(validate_state(&state, &app).is_err());
    state
        .values
        .insert("count".into(), Value::Integer("2".into()));
    assert!(validate_state(&state, &app).is_ok());
    app.state.insert(
        "numbers".into(),
        Value::List(vec![Value::Integer("0".into())]),
    );
    state.values.insert(
        "numbers".into(),
        Value::List(vec![
            Value::Integer("1".into()),
            Value::String("bad".into()),
        ]),
    );
    assert!(validate_state(&state, &app).is_err());
}
