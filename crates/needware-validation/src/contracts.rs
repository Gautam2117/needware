//! Contracts bind state defaults and every action's external inputs to one schema.
use super::*;

pub(super) fn validate_contracts(app: &Application) -> Result<(), Diagnostic> {
    let enabled = app
        .runtime_features
        .iter()
        .any(|f| f == "typed_contracts_v1");
    if !enabled {
        if !app.state_schema.is_empty() || !app.event_schema.is_empty() {
            return Err(fail(
                "contracts",
                "typed contracts require typed_contracts_v1",
            ));
        }
        return Ok(());
    }
    if app.state_schema.keys().ne(app.state.keys())
        || app.event_schema.keys().ne(app.actions.keys())
    {
        return Err(fail(
            "contracts",
            "contracts must cover exactly all state keys and actions",
        ));
    }
    validate_fields(&app.state_schema, app)?;
    for (key, value) in &app.state {
        validate_value(value, &app.state_schema[key], 0)?;
    }
    for fields in app.event_schema.values() {
        validate_fields(fields, app)?;
    }
    Ok(())
}

pub(super) fn validate_fields(
    fields: &BTreeMap<String, Field>,
    app: &Application,
) -> Result<(), Diagnostic> {
    if fields.len() > 128 {
        return Err(fail("contracts", "input field limit"));
    }
    for (name, field) in fields {
        if !identifier(name) {
            return Err(fail("contracts", "invalid field identifier"));
        }
        validate_type(&field.data_type, app, 0)?;
        validate_contract_field(field, 0)?;
    }
    Ok(())
}

fn validate_contract_field(field: &Field, depth: u32) -> Result<(), Diagnostic> {
    if depth > 16 || field.default.is_some() || field.derived.is_some() {
        return Err(fail(
            "contracts",
            "defaults/derived expressions are not input contracts",
        ));
    }
    if field.max_length.is_some_and(|n| n > 65536) {
        return Err(fail(
            "contracts",
            "string constraint exceeds resource limit",
        ));
    }
    let mut inner = &field.data_type;
    while let DataType::Optional { inner: next } = inner {
        inner = next;
    }
    if field.max_length.is_some()
        && !matches!(
            inner,
            DataType::String | DataType::Url | DataType::Enum { .. }
        )
    {
        return Err(fail("contracts", "length constraints require a string"));
    }
    let mut bounds = Vec::new();
    for bound in [&field.minimum, &field.maximum] {
        bounds.push(match bound {
            Some(s) => {
                let n = s
                    .parse::<i64>()
                    .map_err(|_| fail("contracts", "invalid numeric bound"))?;
                if !matches!(inner, DataType::Integer | DataType::Decimal { .. })
                    || n.to_string() != *s
                {
                    return Err(fail("contracts", "bounds require canonical integers"));
                }
                Some(n)
            }
            None => None,
        });
    }
    if matches!((bounds[0], bounds[1]), (Some(min), Some(max)) if min > max) {
        return Err(fail("contracts", "minimum exceeds maximum"));
    }
    validate_nested_contract(&field.data_type, depth + 1)
}

fn validate_nested_contract(t: &DataType, depth: u32) -> Result<(), Diagnostic> {
    if depth > 16 {
        return Err(fail("contracts", "type depth limit"));
    }
    match t {
        DataType::Optional { inner }
        | DataType::List { item: inner }
        | DataType::Map { value: inner } => validate_nested_contract(inner, depth + 1),
        DataType::Record { fields } => {
            for (name, field) in fields {
                if !identifier(name) {
                    return Err(fail("contracts", "invalid nested field identifier"));
                }
                validate_contract_field(field, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Validate before preparing effects, navigation, or transactional state changes.
pub fn validate_event(
    action: &str,
    values: &BTreeMap<String, Value>,
    app: &Application,
) -> Result<(), Diagnostic> {
    if !app.actions.contains_key(action) {
        return Err(fail("event", "unknown action"));
    }
    if let Some(fields) = app.event_schema.get(action) {
        validate_record(
            values,
            &Collection {
                fields: fields.clone(),
                indexes: vec![],
            },
        )?;
    } else {
        if values.len() > 128 {
            return Err(fail("event", "input field limit"));
        }
        for value in values.values() {
            bounded_value(value, 0)?;
        }
    }
    Ok(())
}
