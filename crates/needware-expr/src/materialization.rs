use super::{Budget, EvalError};
use needware_ir::Value;
use std::{collections::BTreeMap, io::Write};

impl Budget {
    pub(crate) fn bytes(&mut self, bytes: usize) -> Result<(), EvalError> {
        if bytes > self.materialized {
            self.materialized = 0;
            return Err(EvalError::Limit);
        }
        self.materialized -= bytes;
        Ok(())
    }
    fn reserve(&mut self, value: &Value, depth: u32) -> Result<(), EvalError> {
        if depth > 64 {
            return Err(EvalError::Limit);
        }
        match value {
            Value::String(s)
            | Value::Integer(s)
            | Value::Date(s)
            | Value::Datetime(s)
            | Value::Duration(s) => self.bytes(s.len())?,
            Value::Decimal(d) => self.bytes(d.coefficient.len())?,
            Value::Reference(r) => self.bytes(r.collection.len().saturating_add(r.record.len()))?,
            Value::List(values) => {
                self.bytes(
                    values
                        .len()
                        .checked_mul(std::mem::size_of::<Value>())
                        .ok_or(EvalError::Limit)?,
                )?;
                for value in values {
                    self.reserve(value, depth + 1)?;
                }
            }
            Value::Map(values) => self.record(values, depth + 1)?,
            _ => {}
        }
        Ok(())
    }
    pub(crate) fn record(
        &mut self,
        values: &BTreeMap<String, Value>,
        depth: u32,
    ) -> Result<(), EvalError> {
        if depth > 64 {
            return Err(EvalError::Limit);
        }
        for (key, value) in values {
            // Conservative charge for owned map keys and tree/container metadata.
            self.bytes(key.len().saturating_add(128))?;
            self.reserve(value, depth + 1)?;
        }
        Ok(())
    }
    pub(crate) fn copy(&mut self, value: &Value) -> Result<Value, EvalError> {
        self.reserve(value, 0)?;
        Ok(value.clone())
    }
}
struct LimitedText(Vec<u8>);
impl Write for LimitedText {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > 65536 {
            return Err(std::io::Error::other("text limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// Bounded text for generated view nodes and concatenation, including structured values.
pub fn display(value: &Value) -> Result<String, EvalError> {
    match value {
        Value::Null => Ok(String::new()),
        Value::String(s)
        | Value::Integer(s)
        | Value::Date(s)
        | Value::Datetime(s)
        | Value::Duration(s) => {
            if s.len() > 65536 {
                return Err(EvalError::Limit);
            }
            Ok(s.clone())
        }
        Value::Boolean(b) => Ok(b.to_string()),
        Value::Decimal(d) => {
            if d.coefficient.len() > 65520 {
                return Err(EvalError::Limit);
            }
            Ok(format!("{}e-{}", d.coefficient, d.scale))
        }
        _ => {
            let mut text = LimitedText(Vec::new());
            serde_json::to_writer(&mut text, value).map_err(|_| EvalError::Limit)?;
            String::from_utf8(text.0).map_err(|_| EvalError::Type)
        }
    }
}
