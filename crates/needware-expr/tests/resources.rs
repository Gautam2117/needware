use needware_expr::{Budget, Context, EvalError, display, evaluate};
use needware_ir::{BinaryOp, Expr, State, Value};
use proptest::prelude::*;
use std::collections::BTreeMap;
fn state() -> State {
    State {
        revision: "test".into(),
        values: BTreeMap::new(),
        collections: BTreeMap::new(),
    }
}
fn literal(value: Value) -> Expr {
    Expr::Literal { value }
}
fn run(expr: &Expr, fuel: u32) -> Result<Value, EvalError> {
    let state = state();
    let event = BTreeMap::new();
    evaluate(
        expr,
        &Context {
            state: &state,
            event: &event,
            item: None,
            now: "",
            locale: "en",
            timezone: "UTC",
        },
        &mut Budget::new(fuel),
    )
}
fn row(number: i64, label: &str) -> Value {
    Value::Map(BTreeMap::from([
        ("n".into(), Value::Integer(number.to_string())),
        ("label".into(), Value::String(label.into())),
    ]))
}
#[test]
fn amplification_is_rejected_before_materializing_large_maps() {
    let state = state();
    let rows = Value::List(vec![Value::Map(BTreeMap::new()); 1000]);
    let event = BTreeMap::from([("rows".into(), rows)]);
    let context = Context {
        state: &state,
        event: &event,
        item: None,
        now: "",
        locale: "en",
        timezone: "UTC",
    };
    let expr = Expr::Map {
        collection: Box::new(Expr::Event { key: "rows".into() }),
        value: Box::new(literal(Value::String("x".repeat(65536)))),
    };
    let mut budget = Budget::new(1_000_000);
    assert_eq!(
        evaluate(&expr, &context, &mut budget),
        Err(EvalError::Limit)
    );
    assert_eq!(
        evaluate(
            &literal(Value::String("small".into())),
            &context,
            &mut budget
        ),
        Err(EvalError::Limit)
    );
    assert_eq!(
        display(&Value::Map(BTreeMap::from([(
            "escaped".into(),
            Value::String("\0".repeat(20000))
        )]))),
        Err(EvalError::Limit)
    );
    assert_eq!(
        display(&Value::String("readable".into())),
        Ok("readable".into())
    );
}
#[test]
fn sorting_is_numeric_stable_fallible_and_time_aware() {
    let rows = vec![row(10, "a"), row(2, "b"), row(-3, "c"), row(2, "d")];
    let sort = |descending| Expr::Sort {
        collection: Box::new(literal(Value::List(rows.clone()))),
        field: "n".into(),
        descending,
    };
    assert_eq!(
        run(&sort(false), 100),
        Ok(Value::List(vec![
            rows[2].clone(),
            rows[1].clone(),
            rows[3].clone(),
            rows[0].clone()
        ]))
    );
    assert_eq!(
        run(&sort(true), 100),
        Ok(Value::List(vec![
            rows[0].clone(),
            rows[1].clone(),
            rows[3].clone(),
            rows[2].clone()
        ]))
    );
    assert_eq!(run(&sort(false), 2), Err(EvalError::Limit));
    let missing = Expr::Sort {
        collection: Box::new(literal(Value::List(rows))),
        field: "missing".into(),
        descending: false,
    };
    assert!(matches!(run(&missing, 100), Err(EvalError::Missing(_))));
    let date = Expr::Binary {
        operator: BinaryOp::Lt,
        left: Box::new(literal(Value::Datetime("2026-10-04T00:30:00+01:00".into()))),
        right: Box::new(literal(Value::Datetime("2026-10-04T00:00:00Z".into()))),
    };
    assert_eq!(run(&date, 10), Ok(Value::Boolean(true)));
}
proptest! {
    #[test]
    fn merge_order_matches_numeric_reference(values in prop::collection::vec(any::<i64>(),0..128), descending in any::<bool>()) {
        let rows:Vec<_>=values.iter().enumerate().map(|(i,n)|row(*n,&i.to_string())).collect();
        let expr=Expr::Sort { collection:Box::new(literal(Value::List(rows.clone()))),field:"n".into(),descending };
        let mut order:Vec<_>=values.iter().enumerate().collect();
        order.sort_by(|(_,a),(_,b)|if descending { b.cmp(a) } else { a.cmp(b) });
        let expected=Value::List(order.into_iter().map(|(i,_)|rows[i].clone()).collect());
        prop_assert_eq!(run(&expr,50_000),Ok(expected));
    }
}
