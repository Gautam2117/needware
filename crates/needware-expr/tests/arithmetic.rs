use needware_expr::{Budget, Context, EvalError, evaluate};
use needware_ir::{BinaryOp, Decimal, Expr, State, Value};
use proptest::prelude::*;
use std::collections::BTreeMap;
proptest! {
    #[test]
    fn exact_decimal_identities_hold_across_all_coefficient_and_scale_bounds(a in any::<i64>(), b in any::<i64>(), scale in 0_u8..=18) {
        let value = decimal(&a.to_string(), scale);
        prop_assert_eq!(run(BinaryOp::Add, value.clone(), decimal("0", scale)), Ok(value.clone()));
        prop_assert_eq!(run(BinaryOp::Multiply, value.clone(), decimal(&10_i64.pow(u32::from(scale)).to_string(), scale)), Ok(value.clone()));
        if let Ok(sum) = run(BinaryOp::Add, value.clone(), decimal(&b.to_string(), scale)) {
            prop_assert_eq!(run(BinaryOp::Subtract, sum, decimal(&b.to_string(), scale)), Ok(value));
        }
    }
}

#[test]
fn decimal_display_preserves_fixed_precision_without_floating_point() {
    assert_eq!(
        needware_expr::display(&decimal("125", 2)),
        Ok("1.25".into())
    );
    assert_eq!(
        needware_expr::display(&decimal("-1", 2)),
        Ok("-0.01".into())
    );
    assert_eq!(needware_expr::display(&decimal("0", 2)), Ok("0.00".into()));
    assert_eq!(
        needware_expr::display(&decimal(&i64::MIN.to_string(), 18)),
        Ok("-9.223372036854775808".into())
    );
    assert_eq!(
        needware_expr::display(&decimal("1200", 2)),
        Ok("12.00".into())
    );
}
fn decimal(n: &str, scale: u8) -> Value {
    Value::Decimal(Decimal {
        coefficient: n.into(),
        scale,
    })
}
fn run(op: BinaryOp, a: Value, b: Value) -> Result<Value, EvalError> {
    let state = State {
        revision: "fixture".into(),
        values: BTreeMap::new(),
        collections: BTreeMap::new(),
    };
    let event = BTreeMap::new();
    let ctx = Context {
        state: &state,
        event: &event,
        item: None,
        now: "",
        locale: "en",
        timezone: "UTC",
    };
    evaluate(
        &Expr::Binary {
            operator: op,
            left: Box::new(Expr::Literal { value: a }),
            right: Box::new(Expr::Literal { value: b }),
        },
        &ctx,
        &mut Budget::new(100),
    )
}
#[test]
fn decimal_operations_are_exact_at_the_declared_scale() {
    assert_eq!(
        run(BinaryOp::Add, decimal("120", 2), decimal("230", 2)),
        Ok(decimal("350", 2))
    );
    assert_eq!(
        run(BinaryOp::Subtract, decimal("120", 2), decimal("230", 2)),
        Ok(decimal("-110", 2))
    );
    assert_eq!(
        run(BinaryOp::Multiply, decimal("125", 2), decimal("200", 2)),
        Ok(decimal("250", 2))
    );
    assert_eq!(
        run(BinaryOp::Divide, decimal("250", 2), decimal("200", 2)),
        Ok(decimal("125", 2))
    );
    assert_eq!(
        run(BinaryOp::Multiply, decimal("-125", 2), decimal("200", 2)),
        Ok(decimal("-250", 2))
    );
    assert_eq!(
        run(
            BinaryOp::Add,
            decimal("999999999999999999", 18),
            decimal("1", 18)
        ),
        Ok(decimal("1000000000000000000", 18))
    );
}
#[test]
fn decimal_overflow_precision_loss_invalid_encoding_and_zero_division_reject() {
    for (op, a, b) in [
        (
            BinaryOp::Add,
            decimal(&i64::MAX.to_string(), 2),
            decimal("1", 2),
        ),
        (BinaryOp::Multiply, decimal("1", 2), decimal("1", 2)),
        (BinaryOp::Divide, decimal("100", 2), decimal("300", 2)),
        (BinaryOp::Divide, decimal("100", 2), decimal("0", 2)),
        (
            BinaryOp::Divide,
            decimal(&i64::MIN.to_string(), 0),
            decimal("-1", 0),
        ),
        (BinaryOp::Add, decimal("01", 2), decimal("1", 2)),
        (
            BinaryOp::Multiply,
            decimal(&i64::MAX.to_string(), 0),
            decimal(&i64::MAX.to_string(), 0),
        ),
    ] {
        assert_eq!(run(op, a, b), Err(EvalError::Arithmetic));
    }
    assert_eq!(
        run(BinaryOp::Add, decimal("1", 1), decimal("1", 2)),
        Err(EvalError::Type)
    );
    assert_eq!(
        run(BinaryOp::Add, decimal("1", 19), decimal("1", 19)),
        Err(EvalError::Type)
    );
    assert_eq!(
        run(BinaryOp::Add, decimal("1", 2), Value::Integer("1".into())),
        Err(EvalError::Type)
    );
}
#[test]
fn date_and_datetime_arithmetic_uses_exact_milliseconds_and_calendar_bounds() {
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Date("2024-02-28".into()),
            Value::Duration("86400000".into())
        ),
        Ok(Value::Date("2024-02-29".into()))
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Date("2024-03-01".into()),
            Value::Date("2024-02-28".into())
        ),
        Ok(Value::Duration("172800000".into()))
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Date("2024-02-28".into()),
            Value::Date("2024-03-01".into())
        ),
        Ok(Value::Duration("-172800000".into()))
    );
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Datetime("2026-10-04T23:59:59.500+05:30".into()),
            Value::Duration("750".into())
        ),
        Ok(Value::Datetime("2026-10-05T00:00:00.250+05:30".into()))
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Datetime("2026-10-04T05:30:00+05:30".into()),
            Value::Datetime("2026-10-04T00:00:00Z".into())
        ),
        Ok(Value::Duration("0".into()))
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Duration("1".into()),
            Value::Duration("2".into())
        ),
        Ok(Value::Duration("-1".into()))
    );
}
#[test]
fn temporal_precision_loss_subday_date_offsets_and_overflow_reject() {
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Date("2024-02-28".into()),
            Value::Duration("1".into())
        ),
        Err(EvalError::Arithmetic)
    );
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Date("2024-02-30".into()),
            Value::Duration("86400000".into())
        ),
        Err(EvalError::Type)
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Date("2024-02-28".into()),
            Value::Duration(i64::MIN.to_string())
        ),
        Err(EvalError::Arithmetic)
    );
    assert_eq!(
        run(
            BinaryOp::Multiply,
            Value::Date("2024-02-28".into()),
            Value::Duration("1".into())
        ),
        Err(EvalError::Type)
    );
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Duration(i64::MAX.to_string()),
            Value::Duration("1".into())
        ),
        Err(EvalError::Arithmetic)
    );
    assert_eq!(
        run(
            BinaryOp::Subtract,
            Value::Datetime("2026-10-04T00:00:00.000001Z".into()),
            Value::Datetime("2026-10-04T00:00:00Z".into())
        ),
        Err(EvalError::Arithmetic)
    );
    assert_eq!(
        run(
            BinaryOp::Add,
            Value::Datetime("2026-10-04T00:00:00Z".into()),
            Value::Duration(i64::MAX.to_string())
        ),
        Err(EvalError::Arithmetic)
    );
}
