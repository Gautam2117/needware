//! Semantic checks construct the unforgeable validated-application boundary.
use needware_ir::*;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq)]
#[error("{path}: {message}")]
pub struct Diagnostic {
    pub path: String,
    pub message: String,
}
fn fail(path: &str, message: &str) -> Diagnostic {
    Diagnostic {
        path: path.into(),
        message: message.into(),
    }
}
#[derive(Debug, Clone)]
pub struct ValidatedApplication(Application);
impl ValidatedApplication {
    pub fn application(&self) -> &Application {
        &self.0
    }
}

pub fn validate(app: Application) -> Result<ValidatedApplication, Diagnostic> {
    if app.schema_version != IR_VERSION {
        return Err(fail("schema_version", "unsupported IR version"));
    }
    if !app.runtime_features.is_empty() {
        return Err(fail("runtime_features", "unsupported required feature"));
    }
    for (path, id) in [("id", &app.id), ("revision", &app.revision)] {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(fail(path, "expected UUID"));
        }
    }
    if app.title.is_empty() || app.title.len() > 120 || app.description.len() > 4096 {
        return Err(fail("metadata", "invalid title/description length"));
    }
    if app.screens.is_empty()
        || app.screens.len() > 64
        || app.collections.len() > 64
        || app.actions.len() > 256
        || app.capabilities.len() > 64
    {
        return Err(fail("application", "resource limit exceeded"));
    }
    let mut screens = BTreeSet::new();
    let mut nodes = BTreeSet::new();
    let mut count = 0;
    for screen in &app.screens {
        if !screens.insert(&screen.id) {
            return Err(fail("screens", "duplicate screen identifier"));
        }
        validate_node(&screen.root, &app, &mut nodes, &mut count, 0)?;
    }
    if !screens.contains(&app.initial_screen) {
        return Err(fail("initial_screen", "unknown screen"));
    }
    for capability in &app.capabilities {
        capability
            .validate()
            .map_err(|_| fail("capabilities", "invalid scope"))?;
    }
    for (name, collection) in &app.collections {
        if !identifier(name) || collection.fields.is_empty() || collection.fields.len() > 128 {
            return Err(fail("collections", "invalid collection"));
        }
        for (name, field) in &collection.fields {
            if !identifier(name) || name == "_id" {
                return Err(fail("fields", "invalid or reserved field identifier"));
            }
            validate_type(&field.data_type, &app, 0)?;
            if let Some(v) = &field.default {
                validate_value(v, field, 0)?;
            }
            if let Some(e) = &field.derived {
                validate_expr(e, &app, Some(collection), 0)?;
            }
        }
        for index in &collection.indexes {
            if index.is_empty() || index.iter().any(|f| !collection.fields.contains_key(f)) {
                return Err(fail("indexes", "unknown field"));
            }
        }
    }
    for action in app.actions.values() {
        validate_action(action, &app, 0)?;
    }
    for value in app.state.values() {
        bounded_value(value, 0)?;
    }
    for test in &app.tests {
        if !app.actions.contains_key(&test.action) {
            return Err(fail("tests", "unknown test action"));
        }
        validate_expr(&test.assertion, &app, None, 0)?;
    }
    Ok(ValidatedApplication(app))
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn validate_type(t: &DataType, app: &Application, depth: u32) -> Result<(), Diagnostic> {
    if depth > 16 {
        return Err(fail("data_type", "type nesting limit"));
    }
    match t {
        DataType::Optional { inner }
        | DataType::List { item: inner }
        | DataType::Map { value: inner } => validate_type(inner, app, depth + 1)?,
        DataType::Reference { collection } if !app.collections.contains_key(collection) => {
            return Err(fail("reference", "unknown collection"));
        }
        DataType::Decimal { scale } if *scale > 18 => {
            return Err(fail("decimal", "scale exceeds 18"));
        }
        DataType::Enum { values }
            if values.is_empty()
                || values.len() > 256
                || values.iter().collect::<BTreeSet<_>>().len() != values.len() =>
        {
            return Err(fail("enum", "invalid enum values"));
        }
        DataType::Record { fields } => {
            if fields.len() > 128 {
                return Err(fail("record", "field limit"));
            }
            for f in fields.values() {
                validate_type(&f.data_type, app, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn bounded_value(value: &Value, depth: u32) -> Result<(), Diagnostic> {
    if depth > 32 {
        return Err(fail("value", "value depth limit"));
    }
    match value {
        Value::String(s) if s.len() > 65536 => return Err(fail("value", "string size limit")),
        Value::Integer(s) | Value::Duration(s) => {
            let n = s
                .parse::<i64>()
                .map_err(|_| fail("value", "invalid integer"))?;
            if n.to_string() != *s {
                return Err(fail("value", "noncanonical integer"));
            }
        }
        Value::Decimal(d) => {
            let n = d
                .coefficient
                .parse::<i64>()
                .map_err(|_| fail("value", "invalid decimal"))?;
            if n.to_string() != d.coefficient || d.scale > 18 {
                return Err(fail("value", "noncanonical decimal"));
            }
        }
        Value::List(items) => {
            if items.len() > 50000 {
                return Err(fail("value", "list size limit"));
            }
            for v in items {
                bounded_value(v, depth + 1)?;
            }
        }
        Value::Map(items) => {
            if items.len() > 1024 {
                return Err(fail("value", "map size limit"));
            }
            for v in items.values() {
                bounded_value(v, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn validate_value(value: &Value, field: &Field, depth: u32) -> Result<(), Diagnostic> {
    bounded_value(value, depth)?;
    if depth > 16 {
        return Err(fail("field", "type nesting limit"));
    }
    let matches = match (&field.data_type, value) {
        (DataType::String, Value::String(_))
        | (DataType::Boolean, Value::Boolean(_))
        | (DataType::Integer, Value::Integer(_))
        | (DataType::Duration, Value::Duration(_)) => true,
        (DataType::Decimal { scale }, Value::Decimal(d)) => scale == &d.scale,
        (DataType::Enum { values }, Value::String(v)) => values.contains(v),
        (DataType::Date, Value::Date(s)) => {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
        }
        (DataType::Datetime, Value::Datetime(s)) => chrono::DateTime::parse_from_rfc3339(s).is_ok(),
        (DataType::Url, Value::String(s)) => url::Url::parse(s).is_ok_and(|u| {
            ["https", "http"].contains(&u.scheme())
                && u.username().is_empty()
                && u.password().is_none()
        }),
        (DataType::Reference { collection }, Value::Reference(r)) => {
            collection == &r.collection && uuid::Uuid::parse_str(&r.record).is_ok()
        }
        (DataType::Optional { .. }, Value::Null) => true,
        (DataType::Optional { inner }, v) => {
            return validate_value(
                v,
                &Field {
                    data_type: *inner.clone(),
                    ..field.clone()
                },
                depth + 1,
            );
        }
        (DataType::List { item }, Value::List(items)) => {
            for v in items {
                validate_value(
                    v,
                    &Field {
                        data_type: *item.clone(),
                        ..field.clone()
                    },
                    depth + 1,
                )?;
            }
            true
        }
        (DataType::Map { value: t }, Value::Map(items)) => {
            for v in items.values() {
                validate_value(
                    v,
                    &Field {
                        data_type: *t.clone(),
                        ..field.clone()
                    },
                    depth + 1,
                )?;
            }
            true
        }
        (DataType::Record { fields }, Value::Map(items)) => {
            validate_record(
                items,
                &Collection {
                    fields: fields.clone(),
                    indexes: vec![],
                },
            )?;
            true
        }
        _ => false,
    };
    if !matches {
        return Err(fail("field", "value does not match declared type"));
    }
    if let (Some(max), Value::String(s)) = (field.max_length, value)
        && s.chars().count() > max as usize
    {
        return Err(fail("field", "maximum string length exceeded"));
    }
    if let Value::Integer(s) = value {
        let n = s
            .parse::<i64>()
            .map_err(|_| fail("field", "invalid integer"))?;
        for (bound, lower) in [(&field.minimum, true), (&field.maximum, false)] {
            if let Some(b) = bound {
                let b = b
                    .parse::<i64>()
                    .map_err(|_| fail("constraint", "invalid numeric bound"))?;
                if (lower && n < b) || (!lower && n > b) {
                    return Err(fail("field", "numeric bound exceeded"));
                }
            }
        }
    }
    Ok(())
}
pub fn validate_record(
    record: &BTreeMap<String, Value>,
    schema: &Collection,
) -> Result<(), Diagnostic> {
    if record.keys().any(|k| !schema.fields.contains_key(k)) {
        return Err(fail("record", "unknown field"));
    }
    for (name, field) in &schema.fields {
        match record.get(name) {
            Some(v) => validate_value(v, field, 0)?,
            None if matches!(field.data_type, DataType::Optional { .. })
                || field.derived.is_some() => {}
            None => return Err(fail(name, "missing required field")),
        }
    }
    Ok(())
}
pub fn validate_state(state: &State, app: &Application) -> Result<(), Diagnostic> {
    if state.revision != app.revision {
        return Err(fail("state", "revision requires migration"));
    }
    if state.collections.len() != app.collections.len() {
        return Err(fail("state", "collection schema mismatch"));
    }
    for (name, records) in &state.collections {
        let schema = app
            .collections
            .get(name)
            .ok_or_else(|| fail("state", "unknown collection"))?;
        if records.len() > 50000 {
            return Err(fail("state", "record limit"));
        }
        for (id, r) in records {
            if uuid::Uuid::parse_str(id).is_err() {
                return Err(fail("state", "invalid record identifier"));
            }
            validate_record(r, schema)?;
        }
    }
    if state.values.keys().collect::<Vec<_>>() != app.state.keys().collect::<Vec<_>>() {
        return Err(fail("state", "state namespace mismatch"));
    }
    for v in state.values.values() {
        bounded_value(v, 0)?;
    }
    if serde_json::to_vec(state)
        .map_err(|_| fail("state", "serialization failed"))?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(fail("state", "state byte limit"));
    }
    Ok(())
}
fn validate_expr(
    e: &Expr,
    app: &Application,
    item: Option<&Collection>,
    depth: u32,
) -> Result<(), Diagnostic> {
    if depth > 64 {
        return Err(fail("expression", "depth limit"));
    }
    let child = |x: &Expr| validate_expr(x, app, item, depth + 1);
    match e {
        Expr::Literal { value } => bounded_value(value, 0)?,
        Expr::State { key } if !app.state.contains_key(key) => {
            return Err(fail("expression", "unknown state key"));
        }
        Expr::Collection { name } if !app.collections.contains_key(name) => {
            return Err(fail("expression", "unknown collection"));
        }
        Expr::Item { field }
            if item.is_some_and(|i| field != "_id" && !i.fields.contains_key(field)) =>
        {
            return Err(fail("expression", "unknown item field"));
        }
        Expr::Binary { left, right, .. } => {
            child(left)?;
            child(right)?;
        }
        Expr::Not { value } | Expr::Length { value } => child(value)?,
        Expr::If { condition, yes, no } => {
            child(condition)?;
            child(yes)?;
            child(no)?;
        }
        Expr::Concat { values } | Expr::Coalesce { values } => {
            if values.len() > 256 {
                return Err(fail("expression", "operand limit"));
            }
            for v in values {
                child(v)?;
            }
        }
        Expr::Filter {
            collection,
            predicate,
        }
        | Expr::Map {
            collection,
            value: predicate,
        } => {
            child(collection)?;
            child(predicate)?;
        }
        Expr::Sort { collection, .. } | Expr::Sum { collection, .. } => child(collection)?,
        _ => {}
    }
    Ok(())
}
fn validate_action(a: &Action, app: &Application, depth: u32) -> Result<(), Diagnostic> {
    if depth > 32 {
        return Err(fail("action", "depth limit"));
    }
    match a {
        Action::Create {
            collection,
            id,
            values,
        }
        | Action::Update {
            collection,
            id,
            values,
        } => {
            let schema = app
                .collections
                .get(collection)
                .ok_or_else(|| fail("action", "unknown collection"))?;
            validate_expr(id, app, Some(schema), 0)?;
            for (f, e) in values {
                if !schema.fields.contains_key(f)
                    || schema.fields.get(f).is_some_and(|f| f.derived.is_some())
                {
                    return Err(fail("action", "unknown or derived target field"));
                }
                validate_expr(e, app, Some(schema), 0)?;
            }
        }
        Action::Delete { collection, id } => {
            if !app.collections.contains_key(collection) {
                return Err(fail("action", "unknown collection"));
            }
            validate_expr(id, app, None, 0)?;
        }
        Action::Set { key, value } => {
            if !app.state.contains_key(key) {
                return Err(fail("action", "unknown state"));
            }
            validate_expr(value, app, None, 0)?;
        }
        Action::Sequence { actions } | Action::Parallel { actions } => {
            if actions.len() > 256 || matches!(a, Action::Parallel { .. }) && actions.len() > 4 {
                return Err(fail("action", "action count limit"));
            }
            for x in actions {
                validate_action(x, app, depth + 1)?;
            }
        }
        Action::Conditional { condition, yes, no } => {
            validate_expr(condition, app, None, 0)?;
            validate_action(yes, app, depth + 1)?;
            if let Some(no) = no {
                validate_action(no, app, depth + 1)?;
            }
        }
        Action::Navigate { screen } if !app.screens.iter().any(|s| &s.id == screen) => {
            return Err(fail("action", "unknown screen"));
        }
        Action::Effect { capability, input } => {
            capability
                .validate()
                .map_err(|_| fail("effect", "invalid capability"))?;
            if !app.capabilities.iter().any(|c| c.covers(capability)) {
                return Err(fail("effect", "undeclared capability"));
            }
            validate_expr(input, app, None, 0)?;
        }
        _ => {}
    }
    Ok(())
}
fn validate_node(
    node: &Node,
    app: &Application,
    ids: &mut BTreeSet<String>,
    count: &mut u32,
    depth: u32,
) -> Result<(), Diagnostic> {
    *count += 1;
    if *count > 4096 || depth > 32 {
        return Err(fail("ui", "component limit"));
    }
    if !identifier(&node.id) || !ids.insert(node.id.clone()) {
        return Err(fail("ui", "invalid/duplicate component identifier"));
    }
    let item = if let Some(c) = &node.collection {
        Some(
            app.collections
                .get(c)
                .ok_or_else(|| fail("ui", "unknown collection"))?,
        )
    } else {
        None
    };
    if let Some(a) = &node.action
        && !app.actions.contains_key(a)
    {
        return Err(fail("ui", "unknown action"));
    }
    if let Some(e) = &node.text {
        validate_expr(e, app, item, 0)?;
    }
    if node.options.len() > 256 {
        return Err(fail("ui", "option limit"));
    }
    for child in &node.children {
        validate_node(child, app, ids, count, depth + 1)?;
    }
    Ok(())
}
