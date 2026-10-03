//! Deterministic expression evaluation with explicit context and bounded work.
use needware_ir::{BinaryOp, ContextKey, Expr, State, Value};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EvalError {
    #[error("expression resource limit exceeded")]
    Limit,
    #[error("expression type mismatch")]
    Type,
    #[error("missing expression reference: {0}")]
    Missing(String),
    #[error("arithmetic overflow or division by zero")]
    Arithmetic,
}
pub struct Context<'a> {
    pub state: &'a State,
    pub event: &'a BTreeMap<String, Value>,
    pub item: Option<&'a BTreeMap<String, Value>>,
    pub now: &'a str,
    pub locale: &'a str,
    pub timezone: &'a str,
}
pub struct Budget {
    remaining: u32,
}
impl Budget {
    pub fn new(fuel: u32) -> Self {
        Self { remaining: fuel }
    }
}
pub fn boolean(v: Value) -> Result<bool, EvalError> {
    if let Value::Boolean(b) = v {
        Ok(b)
    } else {
        Err(EvalError::Type)
    }
}
pub fn integer(v: &Value) -> Result<i64, EvalError> {
    if let Value::Integer(s) = v {
        s.parse().map_err(|_| EvalError::Type)
    } else {
        Err(EvalError::Type)
    }
}
pub fn evaluate(expr: &Expr, ctx: &Context<'_>, budget: &mut Budget) -> Result<Value, EvalError> {
    eval(expr, ctx, budget, 0)
}
fn eval(
    expr: &Expr,
    ctx: &Context<'_>,
    budget: &mut Budget,
    depth: u32,
) -> Result<Value, EvalError> {
    if depth > 64 || budget.remaining == 0 {
        return Err(EvalError::Limit);
    }
    budget.remaining -= 1;
    let child = |e: &Expr, b: &mut Budget| eval(e, ctx, b, depth + 1);
    match expr {
        Expr::Literal { value } => Ok(value.clone()),
        Expr::Event { key } => ctx
            .event
            .get(key)
            .cloned()
            .ok_or_else(|| EvalError::Missing(key.clone())),
        Expr::State { key } => ctx
            .state
            .values
            .get(key)
            .cloned()
            .ok_or_else(|| EvalError::Missing(key.clone())),
        Expr::Item { field } => ctx
            .item
            .and_then(|i| i.get(field))
            .cloned()
            .ok_or_else(|| EvalError::Missing(field.clone())),
        Expr::Collection { name } => Ok(Value::List(
            ctx.state
                .collections
                .get(name)
                .ok_or_else(|| EvalError::Missing(name.clone()))?
                .iter()
                .map(|(id, r)| {
                    let mut r = r.clone();
                    r.insert("_id".into(), Value::String(id.clone()));
                    Value::Map(r)
                })
                .collect(),
        )),
        Expr::Context { key } => Ok(Value::String(
            match key {
                ContextKey::Now => ctx.now,
                ContextKey::Locale => ctx.locale,
                ContextKey::Timezone => ctx.timezone,
            }
            .into(),
        )),
        Expr::Not { value } => Ok(Value::Boolean(!boolean(child(value, budget)?)?)),
        Expr::If { condition, yes, no } => {
            if boolean(child(condition, budget)?)? {
                child(yes, budget)
            } else {
                child(no, budget)
            }
        }
        Expr::Binary {
            operator,
            left,
            right,
        } => {
            let a = child(left, budget)?;
            if matches!(operator, BinaryOp::And) && !boolean(a.clone())? {
                return Ok(Value::Boolean(false));
            }
            if matches!(operator, BinaryOp::Or) && boolean(a.clone())? {
                return Ok(Value::Boolean(true));
            }
            let b = child(right, budget)?;
            match operator {
                BinaryOp::Eq => Ok(Value::Boolean(a == b)),
                BinaryOp::Ne => Ok(Value::Boolean(a != b)),
                BinaryOp::And => Ok(Value::Boolean(boolean(a)? && boolean(b)?)),
                BinaryOp::Or => Ok(Value::Boolean(boolean(a)? || boolean(b)?)),
                BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                    let order = match (&a, &b) {
                        (Value::Integer(_), Value::Integer(_)) => integer(&a)?.cmp(&integer(&b)?),
                        (Value::String(x), Value::String(y)) => x.cmp(y),
                        _ => return Err(EvalError::Type),
                    };
                    Ok(Value::Boolean(match operator {
                        BinaryOp::Lt => order.is_lt(),
                        BinaryOp::Le => !order.is_gt(),
                        BinaryOp::Gt => order.is_gt(),
                        _ => !order.is_lt(),
                    }))
                }
                _ => {
                    let x = integer(&a)?;
                    let y = integer(&b)?;
                    let n = match operator {
                        BinaryOp::Add => x.checked_add(y),
                        BinaryOp::Subtract => x.checked_sub(y),
                        BinaryOp::Multiply => x.checked_mul(y),
                        BinaryOp::Divide => x.checked_div(y),
                        _ => None,
                    }
                    .ok_or(EvalError::Arithmetic)?;
                    Ok(Value::Integer(n.to_string()))
                }
            }
        }
        Expr::Length { value } => {
            let n = match child(value, budget)? {
                Value::List(v) => v.len(),
                Value::Map(v) => v.len(),
                Value::String(s) => s.chars().count(),
                _ => return Err(EvalError::Type),
            };
            Ok(Value::Integer(n.to_string()))
        }
        Expr::Concat { values } => {
            let mut s = String::new();
            for v in values {
                s.push_str(&child(v, budget)?.text());
                if s.len() > 65536 {
                    return Err(EvalError::Limit);
                }
            }
            Ok(Value::String(s))
        }
        Expr::Coalesce { values } => {
            for v in values {
                let x = child(v, budget)?;
                if x != Value::Null {
                    return Ok(x);
                }
            }
            Ok(Value::Null)
        }
        Expr::Map { collection, value }
        | Expr::Filter {
            collection,
            predicate: value,
        } => {
            let Value::List(rows) = child(collection, budget)? else {
                return Err(EvalError::Type);
            };
            let mut out = Vec::new();
            for row in rows {
                let Value::Map(ref fields) = row else {
                    return Err(EvalError::Type);
                };
                let nested = Context {
                    item: Some(fields),
                    ..*ctx
                };
                let result = eval(value, &nested, budget, depth + 1)?;
                if matches!(expr, Expr::Map { .. }) {
                    out.push(result)
                } else if boolean(result)? {
                    out.push(row)
                }
            }
            Ok(Value::List(out))
        }
        Expr::Sort {
            collection,
            field,
            descending,
        } => {
            let Value::List(mut rows) = child(collection, budget)? else {
                return Err(EvalError::Type);
            };
            if rows.len() > budget.remaining as usize {
                return Err(EvalError::Limit);
            }
            budget.remaining -= rows.len() as u32;
            rows.sort_by_key(|row| match row {
                Value::Map(m) => m.get(field).map(Value::text).unwrap_or_default(),
                _ => String::new(),
            });
            if *descending {
                rows.reverse()
            }
            Ok(Value::List(rows))
        }
        Expr::Sum { collection, field } => {
            let Value::List(rows) = child(collection, budget)? else {
                return Err(EvalError::Type);
            };
            let mut sum = 0i64;
            for row in rows {
                if budget.remaining == 0 {
                    return Err(EvalError::Limit);
                }
                budget.remaining -= 1;
                let Value::Map(m) = row else {
                    return Err(EvalError::Type);
                };
                sum = sum
                    .checked_add(integer(
                        m.get(field)
                            .ok_or_else(|| EvalError::Missing(field.clone()))?,
                    )?)
                    .ok_or(EvalError::Arithmetic)?;
            }
            Ok(Value::Integer(sum.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn literal(n: i64) -> Expr {
        Expr::Literal {
            value: Value::Integer(n.to_string()),
        }
    }
    #[test]
    fn overflow_division_and_fuel_fail_safely() {
        let state = State {
            revision: "r".into(),
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
        for (op, a, b) in [
            (BinaryOp::Add, i64::MAX, 1),
            (BinaryOp::Divide, 1, 0),
            (BinaryOp::Divide, i64::MIN, -1),
        ] {
            assert_eq!(
                evaluate(
                    &Expr::Binary {
                        operator: op,
                        left: Box::new(literal(a)),
                        right: Box::new(literal(b))
                    },
                    &ctx,
                    &mut Budget::new(100)
                ),
                Err(EvalError::Arithmetic)
            );
        }
        assert_eq!(
            evaluate(&literal(1), &ctx, &mut Budget::new(0)),
            Err(EvalError::Limit)
        );
    }
}
