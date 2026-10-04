//! Exact fixed-scale and millisecond arithmetic; no implicit coercion or rounding.
use crate::{EvalError, integer};
use needware_ir::{BinaryOp, Decimal, Value};

pub(super) fn calculate(op: &BinaryOp, a: &Value, b: &Value) -> Result<Value, EvalError> {
    match (a, b) {
        (Value::Integer(_), Value::Integer(_)) => {
            let (x, y) = (integer(a)?, integer(b)?);
            let n = match op {
                BinaryOp::Add => x.checked_add(y),
                BinaryOp::Subtract => x.checked_sub(y),
                BinaryOp::Multiply => x.checked_mul(y),
                BinaryOp::Divide => x.checked_div(y),
                _ => None,
            }
            .ok_or(EvalError::Arithmetic)?;
            Ok(Value::Integer(n.to_string()))
        }
        (Value::Decimal(a), Value::Decimal(b)) => decimal(op, a, b),
        (Value::Duration(a), Value::Duration(b)) => {
            let (x, y) = (parse(a)?, parse(b)?);
            let n = match op {
                BinaryOp::Add => x.checked_add(y),
                BinaryOp::Subtract => x.checked_sub(y),
                _ => return Err(EvalError::Type),
            }
            .ok_or(EvalError::Arithmetic)?;
            Ok(Value::Duration(n.to_string()))
        }
        (Value::Date(a), Value::Duration(b)) => {
            let date = date(a)?;
            let millis = offset(op, parse(b)?)?;
            if millis % 86_400_000 != 0 {
                return Err(EvalError::Arithmetic);
            }
            let delta = chrono::TimeDelta::try_milliseconds(millis).ok_or(EvalError::Arithmetic)?;
            let result = date
                .checked_add_signed(delta)
                .ok_or(EvalError::Arithmetic)?;
            Ok(Value::Date(result.format("%Y-%m-%d").to_string()))
        }
        (Value::Datetime(a), Value::Duration(b)) => {
            let time = datetime(a)?;
            let delta = chrono::TimeDelta::try_milliseconds(offset(op, parse(b)?)?)
                .ok_or(EvalError::Arithmetic)?;
            let result = time
                .checked_add_signed(delta)
                .ok_or(EvalError::Arithmetic)?;
            Ok(Value::Datetime(result.to_rfc3339()))
        }
        (Value::Date(a), Value::Date(b)) if matches!(op, BinaryOp::Subtract) => {
            Ok(Value::Duration(
                date(a)?
                    .signed_duration_since(date(b)?)
                    .num_milliseconds()
                    .to_string(),
            ))
        }
        (Value::Datetime(a), Value::Datetime(b)) if matches!(op, BinaryOp::Subtract) => {
            let delta = datetime(a)?.signed_duration_since(datetime(b)?);
            if delta.subsec_nanos() % 1_000_000 != 0 {
                return Err(EvalError::Arithmetic);
            }
            Ok(Value::Duration(delta.num_milliseconds().to_string()))
        }
        _ => Err(EvalError::Type),
    }
}
fn parse(s: &str) -> Result<i64, EvalError> {
    let n = s.parse::<i64>().map_err(|_| EvalError::Arithmetic)?;
    if n.to_string() != s {
        return Err(EvalError::Arithmetic);
    }
    Ok(n)
}
fn decimal(op: &BinaryOp, a: &Decimal, b: &Decimal) -> Result<Value, EvalError> {
    if a.scale != b.scale || a.scale > 18 {
        return Err(EvalError::Type);
    }
    let (x, y) = (
        i128::from(parse(&a.coefficient)?),
        i128::from(parse(&b.coefficient)?),
    );
    let scale = 10_i128.pow(u32::from(a.scale));
    let exact_div = |n: i128, d: i128| {
        if d == 0 || n % d != 0 {
            Err(EvalError::Arithmetic)
        } else {
            Ok(n / d)
        }
    };
    let n = match op {
        BinaryOp::Add => x + y,
        BinaryOp::Subtract => x - y,
        BinaryOp::Multiply => exact_div(x * y, scale)?,
        BinaryOp::Divide => exact_div(x * scale, y)?,
        _ => return Err(EvalError::Type),
    };
    let n = i64::try_from(n).map_err(|_| EvalError::Arithmetic)?;
    Ok(Value::Decimal(Decimal {
        coefficient: n.to_string(),
        scale: a.scale,
    }))
}
fn offset(op: &BinaryOp, millis: i64) -> Result<i64, EvalError> {
    match op {
        BinaryOp::Add => Ok(millis),
        BinaryOp::Subtract => millis.checked_neg().ok_or(EvalError::Arithmetic),
        _ => Err(EvalError::Type),
    }
}
fn date(s: &str) -> Result<chrono::NaiveDate, EvalError> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| EvalError::Type)
}
fn datetime(s: &str) -> Result<chrono::DateTime<chrono::FixedOffset>, EvalError> {
    chrono::DateTime::parse_from_rfc3339(s).map_err(|_| EvalError::Type)
}
