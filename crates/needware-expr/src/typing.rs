//! Reject statically impossible expressions. Undeclared event input remains unknown
//! and must still pass runtime checks; this is not a complete event-type system.
use needware_ir::{Application, BinaryOp, Collection, DataType, Expr, Value};
use std::collections::BTreeMap;
use thiserror::Error;
#[derive(Debug, Clone, PartialEq)]
pub enum Hint {
    Unknown,
    Mixed,
    Null,
    String,
    Boolean,
    Integer,
    Decimal(u8),
    Date,
    Datetime,
    Duration,
    Reference(String),
    List(Box<Hint>),
    Map(Box<Hint>),
    Record(BTreeMap<String, Hint>),
    Optional(Box<Hint>),
}
#[derive(Debug, Error)]
#[error("statically incompatible expression types")]
pub struct TypeError;
impl Hint {
    pub fn accepts(&self, actual: &Self) -> bool {
        match (self, actual) {
            (Self::Unknown, _) | (_, Self::Unknown) => true,
            (Self::Optional(_), Self::Null) => true,
            (Self::Optional(a), Self::Optional(b))
            | (Self::List(a), Self::List(b))
            | (Self::Map(a), Self::Map(b)) => a.accepts(b),
            (Self::Optional(a), b) => a.accepts(b),
            (Self::Map(t), Self::Record(values)) => values.values().all(|v| t.accepts(v)),
            (Self::Record(a), Self::Record(b)) => {
                b.keys().all(|k| a.contains_key(k))
                    && a.iter().all(|(k, t)| {
                        b.get(k)
                            .map_or(matches!(t, Self::Optional(_)), |v| t.accepts(v))
                    })
            }
            _ => self == actual,
        }
    }
}
pub fn declared(t: &DataType) -> Hint {
    match t {
        DataType::String | DataType::Url | DataType::Enum { .. } => Hint::String,
        DataType::Boolean => Hint::Boolean,
        DataType::Integer => Hint::Integer,
        DataType::Decimal { scale } => Hint::Decimal(*scale),
        DataType::Date => Hint::Date,
        DataType::Datetime => Hint::Datetime,
        DataType::Duration => Hint::Duration,
        DataType::Reference { collection } => Hint::Reference(collection.clone()),
        DataType::Optional { inner } => Hint::Optional(Box::new(declared(inner))),
        DataType::List { item } => Hint::List(Box::new(declared(item))),
        DataType::Map { value } => Hint::Map(Box::new(declared(value))),
        DataType::Record { fields } => Hint::Record(
            fields
                .iter()
                .map(|(k, v)| (k.clone(), declared(&v.data_type)))
                .collect(),
        ),
    }
}
pub fn literal(v: &Value) -> Hint {
    match v {
        Value::Null => Hint::Null,
        Value::String(_) => Hint::String,
        Value::Boolean(_) => Hint::Boolean,
        Value::Integer(_) => Hint::Integer,
        Value::Decimal(d) => Hint::Decimal(d.scale),
        Value::Date(_) => Hint::Date,
        Value::Datetime(_) => Hint::Datetime,
        Value::Duration(_) => Hint::Duration,
        Value::Reference(r) => Hint::Reference(r.collection.clone()),
        Value::Map(m) => Hint::Record(m.iter().map(|(k, v)| (k.clone(), literal(v))).collect()),
        Value::List(v) => Hint::List(Box::new(
            v.iter()
                .map(literal)
                .reduce(|a, b| unify(a, b).unwrap_or(Hint::Mixed))
                .unwrap_or(Hint::Unknown),
        )),
    }
}
fn unify(a: Hint, b: Hint) -> Result<Hint, TypeError> {
    if a == Hint::Unknown || b == Hint::Unknown {
        return Ok(Hint::Unknown);
    }
    if a == Hint::Null && b != Hint::Null {
        return Ok(if matches!(b, Hint::Optional(_)) {
            b
        } else {
            Hint::Optional(Box::new(b))
        });
    }
    if b == Hint::Null && a != Hint::Null {
        return Ok(if matches!(a, Hint::Optional(_)) {
            a
        } else {
            Hint::Optional(Box::new(a))
        });
    }
    if a.accepts(&b) {
        Ok(a)
    } else if b.accepts(&a) {
        Ok(b)
    } else {
        Err(TypeError)
    }
}
fn require(expected: &Hint, actual: &Hint) -> Result<(), TypeError> {
    if expected.accepts(actual) {
        Ok(())
    } else {
        Err(TypeError)
    }
}
fn collection_hint(c: &Collection) -> Hint {
    let fields: BTreeMap<_, _> = c
        .fields
        .iter()
        .map(|(k, f)| (k.clone(), declared(&f.data_type)))
        .collect();
    Hint::Record(fields)
}
fn element(hint: Hint) -> Result<Hint, TypeError> {
    match hint {
        Hint::List(item) => Ok(*item),
        Hint::Unknown => Ok(Hint::Unknown),
        _ => Err(TypeError),
    }
}
fn field(item: &Hint, name: &str) -> Result<Hint, TypeError> {
    match item {
        Hint::Unknown => Ok(Hint::Unknown),
        Hint::Record(fields) => fields.get(name).cloned().ok_or(TypeError),
        Hint::Map(value) => Ok(*value.clone()),
        _ => Err(TypeError),
    }
}
pub fn check(e: &Expr, app: &Application, item: Option<&Collection>) -> Result<Hint, TypeError> {
    infer(e, app, &item.map(collection_hint).unwrap_or(Hint::Null), 0)
}
fn infer(e: &Expr, app: &Application, item: &Hint, depth: u32) -> Result<Hint, TypeError> {
    if depth > 64 {
        return Err(TypeError);
    }
    let child = |e| infer(e, app, item, depth + 1);
    Ok(match e {
        Expr::Literal { value } => literal(value),
        Expr::Event { .. } => Hint::Unknown,
        Expr::State { key } => literal(app.state.get(key).ok_or(TypeError)?),
        Expr::Context { .. } => Hint::String,
        Expr::Item { field: name } => field(item, name)?,
        Expr::Collection { name } => {
            let Hint::Record(mut fields) =
                collection_hint(app.collections.get(name).ok_or(TypeError)?)
            else {
                return Err(TypeError);
            };
            fields.insert("_id".into(), Hint::String);
            Hint::List(Box::new(Hint::Record(fields)))
        }
        Expr::Not { value } => {
            require(&Hint::Boolean, &child(value)?)?;
            Hint::Boolean
        }
        Expr::If { condition, yes, no } => {
            require(&Hint::Boolean, &child(condition)?)?;
            unify(child(yes)?, child(no)?)?
        }
        Expr::Binary {
            operator,
            left,
            right,
        } => {
            let (a, b) = (child(left)?, child(right)?);
            match operator {
                BinaryOp::Add | BinaryOp::Subtract | BinaryOp::Multiply | BinaryOp::Divide => {
                    require(&Hint::Integer, &a)?;
                    require(&Hint::Integer, &b)?;
                    Hint::Integer
                }
                BinaryOp::And | BinaryOp::Or => {
                    require(&Hint::Boolean, &a)?;
                    require(&Hint::Boolean, &b)?;
                    Hint::Boolean
                }
                BinaryOp::Eq | BinaryOp::Ne => {
                    unify(a, b)?;
                    Hint::Boolean
                }
                BinaryOp::Lt | BinaryOp::Le | BinaryOp::Gt | BinaryOp::Ge => {
                    for h in [&a, &b] {
                        if !matches!(
                            h,
                            Hint::Unknown
                                | Hint::String
                                | Hint::Boolean
                                | Hint::Integer
                                | Hint::Decimal(_)
                                | Hint::Date
                                | Hint::Datetime
                                | Hint::Duration
                        ) {
                            return Err(TypeError);
                        }
                    }
                    unify(a, b)?;
                    Hint::Boolean
                }
            }
        }
        Expr::Length { value } => {
            if !matches!(
                child(value)?,
                Hint::Unknown | Hint::String | Hint::List(_) | Hint::Map(_) | Hint::Record(_)
            ) {
                return Err(TypeError);
            }
            Hint::Integer
        }
        Expr::Concat { values } => {
            for v in values {
                child(v)?;
            }
            Hint::String
        }
        Expr::Coalesce { values } => {
            let mut hint = Hint::Null;
            let mut nullable = true;
            for v in values {
                let h = child(v)?;
                nullable &= matches!(h, Hint::Null | Hint::Optional(_) | Hint::Unknown);
                let h = match h {
                    Hint::Optional(inner) => *inner,
                    other => other,
                };
                if h != Hint::Null {
                    hint = if hint == Hint::Null {
                        h
                    } else {
                        unify(hint, h)?
                    };
                }
            }
            if nullable && !matches!(hint, Hint::Null | Hint::Unknown) {
                Hint::Optional(Box::new(hint))
            } else {
                hint
            }
        }
        Expr::Filter {
            collection,
            predicate,
        } => {
            let list = child(collection)?;
            let next_item = element(list.clone())?;
            require(
                &Hint::Boolean,
                &infer(predicate, app, &next_item, depth + 1)?,
            )?;
            list
        }
        Expr::Map { collection, value } => {
            let next_item = element(child(collection)?)?;
            Hint::List(Box::new(infer(value, app, &next_item, depth + 1)?))
        }
        Expr::Sort {
            collection,
            field: name,
            ..
        } => {
            let list = child(collection)?;
            let h = field(&element(list.clone())?, name)?;
            if !matches!(
                h,
                Hint::Unknown
                    | Hint::String
                    | Hint::Boolean
                    | Hint::Integer
                    | Hint::Decimal(_)
                    | Hint::Date
                    | Hint::Datetime
                    | Hint::Duration
            ) {
                return Err(TypeError);
            }
            list
        }
        Expr::Sum {
            collection,
            field: name,
        } => {
            require(&Hint::Integer, &field(&element(child(collection)?)?, name)?)?;
            Hint::Integer
        }
    })
}
