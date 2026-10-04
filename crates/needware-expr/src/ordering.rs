use super::{Budget, EvalError, integer};
use needware_ir::Value;
use std::cmp::Ordering;

pub(crate) fn compare(a: &Value, b: &Value) -> Result<Ordering, EvalError> {
    Ok(match (a, b) {
        (Value::Integer(_), Value::Integer(_)) => integer(a)?.cmp(&integer(b)?),
        (Value::String(a), Value::String(b)) => a.cmp(b),
        (Value::Boolean(a), Value::Boolean(b)) => a.cmp(b),
        (Value::Duration(a), Value::Duration(b)) => a
            .parse::<i64>()
            .map_err(|_| EvalError::Type)?
            .cmp(&b.parse::<i64>().map_err(|_| EvalError::Type)?),
        (Value::Decimal(a), Value::Decimal(b)) if a.scale == b.scale => a
            .coefficient
            .parse::<i64>()
            .map_err(|_| EvalError::Type)?
            .cmp(&b.coefficient.parse::<i64>().map_err(|_| EvalError::Type)?),
        (Value::Date(a), Value::Date(b)) => chrono::NaiveDate::parse_from_str(a, "%Y-%m-%d")
            .map_err(|_| EvalError::Type)?
            .cmp(&chrono::NaiveDate::parse_from_str(b, "%Y-%m-%d").map_err(|_| EvalError::Type)?),
        (Value::Datetime(a), Value::Datetime(b)) => chrono::DateTime::parse_from_rfc3339(a)
            .map_err(|_| EvalError::Type)?
            .cmp(&chrono::DateTime::parse_from_rfc3339(b).map_err(|_| EvalError::Type)?),
        _ => return Err(EvalError::Type),
    })
}
fn key<'a>(row: &'a Value, field: &str) -> Result<&'a Value, EvalError> {
    let Value::Map(row) = row else {
        return Err(EvalError::Type);
    };
    row.get(field)
        .ok_or_else(|| EvalError::Missing(field.into()))
}
pub(crate) fn sort(
    rows: Vec<Value>,
    field: &str,
    descending: bool,
    budget: &mut Budget,
) -> Result<Vec<Value>, EvalError> {
    for row in &rows {
        budget.consume(1)?;
        let value = key(row, field)?;
        if let Value::String(s) = value {
            budget.consume((s.len() / 64) as u32)?;
        }
        compare(value, value)?;
        if let Some(first) = rows.first() {
            compare(key(first, field)?, value)?;
        }
    }
    // Fallible stable merge sorting stops immediately on fuel exhaustion.
    // Reserve both merge buffers and the final output before allocating them.
    budget.bytes(
        rows.len()
            .checked_mul(2 * std::mem::size_of::<Option<Value>>() + std::mem::size_of::<Value>())
            .ok_or(EvalError::Limit)?,
    )?;
    let length = rows.len();
    let mut source: Vec<Option<Value>> = rows.into_iter().map(Some).collect();
    let mut output: Vec<Option<Value>> = (0..length).map(|_| None).collect();
    let mut width = 1;
    while width < length {
        for start in (0..length).step_by(width * 2) {
            let middle = (start + width).min(length);
            let end = (middle + width).min(length);
            let (mut left, mut right) = (start, middle);
            for slot in &mut output[start..end] {
                budget.consume(1)?;
                let take_left = if left == middle {
                    false
                } else if right == end {
                    true
                } else {
                    let a = key(source[left].as_ref().ok_or(EvalError::Type)?, field)?;
                    let b = key(source[right].as_ref().ok_or(EvalError::Type)?, field)?;
                    if let (Value::String(a), Value::String(b)) = (a, b) {
                        budget.consume((a.len().min(b.len()) / 64) as u32)?;
                    }
                    let order = compare(a, b)?;
                    if descending {
                        !order.is_lt()
                    } else {
                        !order.is_gt()
                    }
                };
                let selected = if take_left {
                    let i = left;
                    left += 1;
                    i
                } else {
                    let i = right;
                    right += 1;
                    i
                };
                *slot = source[selected].take();
            }
        }
        std::mem::swap(&mut source, &mut output);
        width *= 2;
    }
    source
        .into_iter()
        .map(|value| value.ok_or(EvalError::Type))
        .collect()
}
