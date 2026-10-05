//! Semantic checks construct the unforgeable validated-application boundary.
mod contracts;
pub mod derived;
mod visuals;
mod widgets;
use contracts::validate_contracts;
pub use contracts::validate_event;
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
    needware_migrations::validate_declarations(&app)
        .map_err(|e| fail("migrations", &e.to_string()))?;
    if app.schema_version != IR_VERSION {
        return Err(fail("schema_version", "unsupported IR version"));
    }
    if app.runtime_features.iter().any(|f| {
        ![
            "typed_contracts_v1",
            "exact_arithmetic_v1",
            "derived_fields_v1",
            "runtime_controls_v1",
            "declarative_widgets_v1",
            "visual_components_v1",
        ]
        .contains(&f.as_str())
    }) || app.runtime_features.iter().collect::<BTreeSet<_>>().len()
        != app.runtime_features.len()
    {
        return Err(fail("runtime_features", "unsupported required feature"));
    }
    validate_contracts(&app)?;
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
        || app.state.len() > 128
    {
        return Err(fail("application", "resource limit exceeded"));
    }
    for (key, value) in &app.state {
        if !identifier(key) {
            return Err(fail("state", "invalid key"));
        }
        bounded_value(value, 0)?;
    }
    let mut screens = BTreeSet::new();
    let mut nodes = BTreeSet::new();
    let mut count = 0;
    for screen in &app.screens {
        if !screens.insert(&screen.id) {
            return Err(fail("screens", "duplicate screen identifier"));
        }
        validate_node(
            &screen.root,
            &app,
            &mut nodes,
            &mut count,
            0,
            widgets::NodeScope {
                item: None,
                form: None,
            },
        )?;
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
        derived::order(collection)?;
        for (name, field) in &collection.fields {
            if !identifier(name) || name == "_id" {
                return Err(fail("fields", "invalid or reserved field identifier"));
            }
            validate_type(&field.data_type, &app, 0)?;
            if let Some(v) = &field.default {
                validate_value(v, field, 0)?;
            }
            if let Some(e) = &field.derived {
                if !app
                    .runtime_features
                    .iter()
                    .any(|f| f == "derived_fields_v1")
                {
                    return Err(fail("derived", "derived fields require derived_fields_v1"));
                }
                validate_expr(e, &app, Some(collection), None, 0)?;
                if !needware_expr::typing::declared(&field.data_type).accepts(
                    &needware_expr::typing::check(e, &app, Some(collection))
                        .map_err(|_| fail("derived", "invalid expression type"))?,
                ) {
                    return Err(fail(
                        "derived",
                        "expression does not match derived field type",
                    ));
                }
            }
        }
        for index in &collection.indexes {
            if index.is_empty() || index.iter().any(|f| !collection.fields.contains_key(f)) {
                return Err(fail("indexes", "unknown field"));
            }
        }
    }
    for (name, action) in &app.actions {
        validate_action(action, &app, app.event_schema.get(name), 0)?;
    }
    for migration in &app.migrations {
        for operation in &migration.operations {
            if let MigrationOp::AddField {
                collection,
                field,
                default,
            } = operation
            {
                let field = app
                    .collections
                    .get(collection)
                    .and_then(|c| c.fields.get(field))
                    .ok_or_else(|| fail("migration", "unknown target field"))?;
                validate_value(default, field, 0)?;
            }
        }
    }
    for test in &app.tests {
        if !app.actions.contains_key(&test.action) {
            return Err(fail("tests", "unknown test action"));
        }
        validate_event(&test.action, &test.event, &app)?;
        validate_expr(
            &test.assertion,
            &app,
            None,
            app.event_schema.get(&test.action),
            0,
        )?;
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
                if f.derived.is_some() {
                    return Err(fail(
                        "record",
                        "derived fields belong to top-level collection records",
                    ));
                }
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
    let coefficient = match value {
        Value::Integer(s) => Some(s),
        Value::Decimal(d) => Some(&d.coefficient),
        _ => None,
    };
    if let Some(s) = coefficient {
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
    for (key, v) in &state.values {
        bounded_value(v, 0)?;
        if let Some(field) = app.state_schema.get(key) {
            validate_value(v, field, 0)?;
            continue;
        }
        let initial = app
            .state
            .get(key)
            .ok_or_else(|| fail("state", "unknown key"))?;
        if !matches!(initial, Value::Null)
            && !needware_expr::typing::literal(initial).accepts(&needware_expr::typing::literal(v))
        {
            return Err(fail("state", "value changes its inferred type"));
        }
    }
    if serde_json::to_vec(state)
        .map_err(|_| fail("state", "serialization failed"))?
        .len()
        > 16 * 1024 * 1024
    {
        return Err(fail("state", "state byte limit"));
    }
    derived::verify(app, state)?;
    Ok(())
}
fn validate_expr(
    e: &Expr,
    app: &Application,
    item: Option<&Collection>,
    event: Option<&BTreeMap<String, Field>>,
    depth: u32,
) -> Result<(), Diagnostic> {
    if depth > 64 {
        return Err(fail("expression", "depth limit"));
    }
    let child = |x: &Expr| validate_expr(x, app, item, event, depth + 1);
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
            let nested = match collection.as_ref() {
                Expr::Collection { name } => app.collections.get(name),
                _ => None,
            };
            validate_expr(predicate, app, nested, event, depth + 1)?;
        }
        Expr::Sort { collection, .. } | Expr::Sum { collection, .. } => child(collection)?,
        _ => {}
    }
    if depth == 0 {
        needware_expr::typing::check_with_event(e, app, item, event)
            .map_err(|_| fail("expression", "statically incompatible types"))?;
    }
    Ok(())
}
fn validate_action(
    a: &Action,
    app: &Application,
    event: Option<&BTreeMap<String, Field>>,
    depth: u32,
) -> Result<(), Diagnostic> {
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
            validate_expr(id, app, None, event, 0)?;
            if !needware_expr::typing::Hint::String.accepts(
                &needware_expr::typing::check_with_event(id, app, None, event)
                    .map_err(|_| fail("action", "incompatible identifier"))?,
            ) {
                return Err(fail("action", "record identifier must be a string"));
            }
            for (f, e) in values {
                if !schema.fields.contains_key(f)
                    || schema.fields.get(f).is_some_and(|f| f.derived.is_some())
                {
                    return Err(fail("action", "unknown or derived target field"));
                }
                let item = if matches!(a, Action::Update { .. }) {
                    Some(schema)
                } else {
                    None
                };
                validate_expr(e, app, item, event, 0)?;
                let field = schema
                    .fields
                    .get(f)
                    .ok_or_else(|| fail("action", "unknown field"))?;
                let hint = needware_expr::typing::check_with_event(e, app, item, event)
                    .map_err(|_| fail("action", "incompatible expression types"))?;
                if !needware_expr::typing::declared(&field.data_type).accepts(&hint) {
                    return Err(fail(
                        "action",
                        "expression result does not match field type",
                    ));
                }
            }
        }
        Action::Delete { collection, id } => {
            if !app.collections.contains_key(collection) {
                return Err(fail("action", "unknown collection"));
            }
            validate_expr(id, app, None, event, 0)?;
            if !needware_expr::typing::Hint::String.accepts(
                &needware_expr::typing::check_with_event(id, app, None, event)
                    .map_err(|_| fail("action", "incompatible identifier"))?,
            ) {
                return Err(fail("action", "record identifier must be a string"));
            }
        }
        Action::Set { key, value } => {
            if !app.state.contains_key(key) {
                return Err(fail("action", "unknown state"));
            }
            validate_expr(value, app, None, event, 0)?;
            let initial = app
                .state
                .get(key)
                .ok_or_else(|| fail("action", "unknown state"))?;
            let expected = app
                .state_schema
                .get(key)
                .map(|f| needware_expr::typing::declared(&f.data_type))
                .unwrap_or_else(|| needware_expr::typing::literal(initial));
            if (app.state_schema.contains_key(key) || !matches!(initial, Value::Null))
                && !expected.accepts(
                    &needware_expr::typing::check_with_event(value, app, None, event)
                        .map_err(|_| fail("action", "incompatible state expression"))?,
                )
            {
                return Err(fail("action", "expression result changes state type"));
            }
        }
        Action::Sequence { actions } | Action::Parallel { actions } => {
            if actions.len() > 256 || matches!(a, Action::Parallel { .. }) && actions.len() > 4 {
                return Err(fail("action", "action count limit"));
            }
            for x in actions {
                validate_action(x, app, event, depth + 1)?;
            }
        }
        Action::Conditional { condition, yes, no } => {
            validate_expr(condition, app, None, event, 0)?;
            if !needware_expr::typing::Hint::Boolean.accepts(
                &needware_expr::typing::check_with_event(condition, app, None, event)
                    .map_err(|_| fail("action", "incompatible condition"))?,
            ) {
                return Err(fail("action", "condition must be boolean"));
            }
            validate_action(yes, app, event, depth + 1)?;
            if let Some(no) = no {
                validate_action(no, app, event, depth + 1)?;
            }
        }
        Action::Navigate { screen } if !app.screens.iter().any(|s| &s.id == screen) => {
            return Err(fail("action", "unknown screen"));
        }
        Action::Back | Action::Open { .. } | Action::Close { .. } => {
            if !app
                .runtime_features
                .iter()
                .any(|feature| feature == "runtime_controls_v1")
            {
                return Err(fail("action", "runtime_controls_v1 is required"));
            }
            if let Action::Open { overlay } | Action::Close { overlay } = a {
                let mut pending: Vec<_> = app.screens.iter().map(|screen| &screen.root).collect();
                let mut found = false;
                let mut visited = 0;
                while let Some(node) = pending.pop() {
                    visited += 1;
                    if visited > 4096 {
                        return Err(fail("ui", "component limit"));
                    }
                    if node.id == *overlay
                        && matches!(node.kind, Component::Modal | Component::Drawer)
                    {
                        found = true;
                        break;
                    }
                    pending.extend(&node.children);
                }
                if !found {
                    return Err(fail("action", "unknown modal or drawer"));
                }
            }
        }
        Action::Effect { capability, input } => {
            capability
                .validate()
                .map_err(|_| fail("effect", "invalid capability"))?;
            if !app.capabilities.iter().any(|c| c.covers(capability)) {
                return Err(fail("effect", "undeclared capability"));
            }
            validate_expr(input, app, None, event, 0)?;
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
    scope: widgets::NodeScope<'_>,
) -> Result<(), Diagnostic> {
    let item = scope.item;
    let form = widgets::validate_node(node, app, scope)?;
    visuals::validate_node(node, app)?;
    *count += 1;
    if *count > 4096 || depth > 32 {
        return Err(fail("ui", "component limit"));
    }
    if !identifier(&node.id) || !ids.insert(node.id.clone()) {
        return Err(fail("ui", "invalid/duplicate component identifier"));
    }
    if matches!(node.kind, Component::Modal | Component::Drawer)
        && (item.is_some()
            || !app
                .runtime_features
                .iter()
                .any(|feature| feature == "runtime_controls_v1"))
    {
        return Err(fail(
            "ui",
            "overlays require runtime_controls_v1 outside repeated collections",
        ));
    }
    if matches!(node.kind, Component::Modal | Component::Drawer) && node.disabled.is_some() {
        return Err(fail(
            "ui",
            "an overlay's trusted close action cannot be disabled",
        ));
    }
    if matches!(node.kind, Component::Modal | Component::Drawer)
        && !node
            .action
            .as_ref()
            .and_then(|name| app.actions.get(name))
            .is_some_and(
                |action| matches!(action, Action::Close { overlay } if *overlay == node.id),
            )
    {
        return Err(fail("ui", "overlay requires its own declared close action"));
    }
    let children_item = if matches!(node.kind, Component::List | Component::Table) {
        let c = node
            .collection
            .as_ref()
            .ok_or_else(|| fail("ui", "list missing collection"))?;
        Some(
            app.collections
                .get(c)
                .ok_or_else(|| fail("ui", "unknown collection"))?,
        )
    } else {
        item
    };
    if let Some(a) = &node.action
        && !app.actions.contains_key(a)
    {
        return Err(fail("ui", "unknown action"));
    }
    if let Some(e) = &node.text {
        validate_expr(e, app, item, None, 0)?;
    }
    for expression in [&node.value, &node.disabled].into_iter().flatten() {
        validate_expr(expression, app, item, None, 0)?;
    }
    if node.options.len() > 256 {
        return Err(fail("ui", "option limit"));
    }
    for child in &node.children {
        validate_node(
            child,
            app,
            ids,
            count,
            depth + 1,
            widgets::NodeScope {
                item: children_item,
                form,
            },
        )?;
    }
    Ok(())
}
