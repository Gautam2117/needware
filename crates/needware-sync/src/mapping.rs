use super::*;
use needware_ir::{Application, Value};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Address {
    State {
        key: String,
    },
    Record {
        collection: String,
        record: String,
    },
    Field {
        collection: String,
        record: String,
        field: String,
    },
}
impl Scope {
    pub(crate) fn validate(&self, app: &Application) -> Result<()> {
        if self.values.iter().any(|key| !app.state.contains_key(key))
            || self
                .collections
                .iter()
                .any(|name| !app.collections.contains_key(name))
        {
            return Err(SyncError::Protocol);
        }
        Ok(())
    }
}
impl Address {
    pub(crate) fn parse(key: &str, app: &Application, scope: &Scope) -> Result<Self> {
        if key.len() > 2048 {
            return Err(SyncError::Limit);
        }
        let address: Self = wire::decode(key.as_bytes())?;
        match &address {
            Self::State { key } => {
                if !scope.values.contains(key) {
                    return Err(SyncError::Authorization);
                }
            }
            Self::Record { collection, record }
            | Self::Field {
                collection, record, ..
            } => {
                if !scope.collections.contains(collection) {
                    return Err(SyncError::Authorization);
                }
                let id = uuid::Uuid::parse_str(record).map_err(|_| SyncError::Invalid)?;
                if id.to_string() != *record {
                    return Err(SyncError::Invalid);
                }
                if let Self::Field { field, .. } = &address {
                    let schema = app
                        .collections
                        .get(collection)
                        .and_then(|schema| schema.fields.get(field))
                        .ok_or(SyncError::Invalid)?;
                    if schema.derived.is_some() {
                        return Err(SyncError::Invalid);
                    }
                }
            }
        }
        Ok(address)
    }
    fn key(&self) -> Result<String> {
        String::from_utf8(wire::canonical(self)?).map_err(|_| SyncError::Invalid)
    }
}
pub(crate) fn value(address: &Address, text: &str) -> Result<Option<Value>> {
    let value: Option<Value> = wire::decode(text.as_bytes())?;
    match address {
        Address::Record { .. } if !matches!(value, Some(Value::Boolean(_))) => {
            Err(SyncError::Invalid)
        }
        Address::State { .. } if value.is_none() => Err(SyncError::Invalid),
        _ => Ok(value),
    }
}
pub(crate) fn validate_cell(address: &Address, text: &str, app: &Application) -> Result<()> {
    let value = value(address, text)?;
    let field = match address {
        Address::State { key } => app.state_schema.get(key),
        Address::Field {
            collection, field, ..
        } => app
            .collections
            .get(collection)
            .and_then(|schema| schema.fields.get(field)),
        Address::Record { .. } => None,
    };
    if let Some(field) = field {
        if let Some(value) = value {
            needware_validation::validate_value(&value, field, 0)
                .map_err(|_| SyncError::Invalid)?;
        } else if !matches!(field.data_type, needware_ir::DataType::Optional { .. }) {
            return Err(SyncError::Invalid);
        }
    }
    Ok(())
}
pub(crate) fn is_deleted_record_field(key: &str, after: &BTreeMap<String, String>) -> Result<bool> {
    let address: Address = wire::decode(key.as_bytes())?;
    if let Address::Field {
        collection, record, ..
    } = address
    {
        return Ok(!after.contains_key(&Address::Record { collection, record }.key()?));
    }
    Ok(false)
}
fn cell(value: Option<&Value>) -> Result<String> {
    String::from_utf8(wire::canonical(&value)?).map_err(|_| SyncError::Invalid)
}
pub(crate) fn flatten(
    state: &State,
    app: &Application,
    scope: &Scope,
) -> Result<BTreeMap<String, String>> {
    let mut flat = BTreeMap::new();
    for key in &scope.values {
        flat.insert(
            Address::State { key: key.clone() }.key()?,
            cell(state.values.get(key))?,
        );
    }
    for collection in &scope.collections {
        for (record, fields) in state
            .collections
            .get(collection)
            .ok_or(SyncError::Invalid)?
        {
            let id = uuid::Uuid::parse_str(record).map_err(|_| SyncError::Invalid)?;
            if id.to_string() != *record {
                return Err(SyncError::Invalid);
            }
            flat.insert(
                Address::Record {
                    collection: collection.clone(),
                    record: record.clone(),
                }
                .key()?,
                cell(Some(&Value::Boolean(true)))?,
            );
            for (field, value) in fields {
                if app.collections[collection].fields[field].derived.is_some() {
                    continue;
                }
                flat.insert(
                    Address::Field {
                        collection: collection.clone(),
                        record: record.clone(),
                        field: field.clone(),
                    }
                    .key()?,
                    cell(Some(value))?,
                );
            }
        }
    }
    Ok(flat)
}
pub(crate) fn removed(key: &str) -> Result<String> {
    let address: Address = wire::decode(key.as_bytes())?;
    match address {
        Address::Record { .. } => cell(Some(&Value::Boolean(false))),
        Address::Field { .. } => cell(None),
        Address::State { .. } => Err(SyncError::Invalid),
    }
}
pub(crate) fn prevent_resurrection(doc: &AutoCommit, key: &str, next: &str) -> Result<()> {
    let address: Address = wire::decode(key.as_bytes())?;
    if matches!(address, Address::Record { .. })
        && value(&address, next)? == Some(Value::Boolean(true))
    {
        for (value, _) in doc.get_all(ROOT, key).map_err(|_| SyncError::Invalid)? {
            if let automerge::Value::Scalar(scalar) = value
                && let ScalarValue::Str(text) = scalar.as_ref()
                && self::value(&address, text)? == Some(Value::Boolean(false))
            {
                return Err(SyncError::Invalid);
            }
        }
    }
    Ok(())
}
pub(crate) fn project(
    doc: &AutoCommit,
    base: &State,
    app: &Application,
    scope: &Scope,
) -> Result<State> {
    let mut state = base.clone();
    for key in &scope.values {
        state.values.insert(key.clone(), app.state[key].clone());
    }
    for name in &scope.collections {
        state.collections.insert(name.clone(), BTreeMap::new());
    }
    let mut cells = Vec::new();
    let mut records = BTreeMap::new();
    let keys = doc.keys(ROOT).collect::<Vec<_>>();
    if keys.len() > MAX_OPERATIONS {
        return Err(SyncError::Limit);
    }
    for key in keys {
        let address = Address::parse(&key, app, scope)?;
        let (scalar, _) = doc
            .get(ROOT, &key)
            .map_err(|_| SyncError::Invalid)?
            .ok_or(SyncError::Invalid)?;
        let automerge::Value::Scalar(scalar) = scalar else {
            return Err(SyncError::Invalid);
        };
        let ScalarValue::Str(text) = scalar.as_ref() else {
            return Err(SyncError::Invalid);
        };
        let current = value(&address, text)?;
        if let Address::Record { collection, record } = &address {
            // Delete wins across concurrent creates; all field edits remain hidden by tombstones.
            let mut live = current == Some(Value::Boolean(true));
            for (value, _) in doc.get_all(ROOT, &key).map_err(|_| SyncError::Invalid)? {
                let automerge::Value::Scalar(scalar) = value else {
                    return Err(SyncError::Invalid);
                };
                let ScalarValue::Str(text) = scalar.as_ref() else {
                    return Err(SyncError::Invalid);
                };
                if self::value(&address, text)? == Some(Value::Boolean(false)) {
                    live = false;
                }
            }
            records.insert((collection.clone(), record.clone()), live);
        }
        cells.push((address, current));
    }
    for ((collection, record), live) in &records {
        if *live {
            state
                .collections
                .get_mut(collection)
                .ok_or(SyncError::Invalid)?
                .insert(record.clone(), BTreeMap::new());
        }
    }
    for (address, value) in cells {
        match address {
            Address::State { key } => {
                state.values.insert(key, value.ok_or(SyncError::Invalid)?);
            }
            Address::Field {
                collection,
                record,
                field,
            } => {
                let live = records
                    .get(&(collection.clone(), record.clone()))
                    .ok_or(SyncError::Invalid)?;
                if *live && let Some(value) = value {
                    state
                        .collections
                        .get_mut(&collection)
                        .and_then(|rows| rows.get_mut(&record))
                        .ok_or(SyncError::Invalid)?
                        .insert(field, value);
                }
            }
            Address::Record { .. } => {}
        }
    }
    needware_validation::derived::materialize(
        app,
        &mut state,
        &mut needware_expr::Budget::new(100_000),
    )
    .map_err(|_| SyncError::Invalid)?;
    needware_validation::validate_state(&state, app).map_err(|_| SyncError::Invalid)?;
    Ok(state)
}
