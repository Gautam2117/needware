//! Deterministic migration planning; callers validate both application/state schemas.
use needware_expr::{Budget, Context, evaluate};
use needware_ir::{Application, Expr, MigrationOp, State, Value};
use serde::Serialize;
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MigrationError {
    #[error("migration source, target or state identity mismatch")]
    Identity,
    #[error("migration is missing, ambiguous or does not describe the schema change")]
    Schema,
    #[error("migration resource limit exceeded")]
    Limit,
    #[error("migration expressions cannot read events or ambient context")]
    Context,
    #[error("migration expression failed: {0}")]
    Expression(String),
}
#[derive(Debug, Clone, Serialize)]
pub struct Impact {
    pub operation: String,
    pub collection: String,
    pub field: Option<String>,
    pub previous_field: Option<String>,
    pub affected_records: u32,
    pub destructive: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    pub from_revision: String,
    pub to_revision: String,
    pub requires_confirmation: bool,
    pub impacts: Vec<Impact>,
}
pub struct Plan {
    from_revision: String,
    to_revision: String,
    operations: Vec<MigrationOp>,
}
pub struct Preview {
    pub report: Report,
    pub state: State,
}

/// Checks declarations even when no source package is currently installed.
pub fn validate_declarations(app: &Application) -> Result<(), MigrationError> {
    if app.migrations.len() > 32 {
        return Err(MigrationError::Limit);
    }
    let mut sources = std::collections::BTreeSet::new();
    for migration in &app.migrations {
        if uuid::Uuid::parse_str(&migration.from_revision).is_err()
            || migration.from_revision == app.revision
            || !sources.insert(&migration.from_revision)
        {
            return Err(MigrationError::Identity);
        }
        if migration.operations.len() > 256 {
            return Err(MigrationError::Limit);
        }
        let mut nodes = 0;
        for operation in &migration.operations {
            if let MigrationOp::Transform { value, .. } = operation {
                expression(value, 0, &mut nodes)?;
            }
        }
    }
    Ok(())
}

impl Plan {
    pub fn between(source: &Application, target: &Application) -> Result<Self, MigrationError> {
        validate_declarations(target)?;
        if source.id != target.id || source.revision == target.revision {
            return Err(MigrationError::Identity);
        }
        // State namespace operations require their own declared IR operations.
        if source.state.keys().ne(target.state.keys()) {
            return Err(MigrationError::Schema);
        }
        let migration = target
            .migrations
            .iter()
            .find(|m| m.from_revision == source.revision);
        let operations = migration.map(|m| m.operations.clone()).unwrap_or_default();
        let mut schema = source.collections.clone();
        for operation in &operations {
            match operation {
                MigrationOp::AddField {
                    collection, field, ..
                } => {
                    let definition = target
                        .collections
                        .get(collection)
                        .and_then(|c| c.fields.get(field))
                        .ok_or(MigrationError::Schema)?
                        .clone();
                    let fields = &mut schema
                        .get_mut(collection)
                        .ok_or(MigrationError::Schema)?
                        .fields;
                    if fields.insert(field.clone(), definition).is_some() {
                        return Err(MigrationError::Schema);
                    }
                }
                MigrationOp::RenameField {
                    collection,
                    from,
                    to,
                } => {
                    let fields = &mut schema
                        .get_mut(collection)
                        .ok_or(MigrationError::Schema)?
                        .fields;
                    let definition = fields.remove(from).ok_or(MigrationError::Schema)?;
                    if fields.insert(to.clone(), definition).is_some() {
                        return Err(MigrationError::Schema);
                    }
                }
                MigrationOp::RemoveField { collection, field } => {
                    schema
                        .get_mut(collection)
                        .ok_or(MigrationError::Schema)?
                        .fields
                        .remove(field)
                        .ok_or(MigrationError::Schema)?;
                }
                MigrationOp::AddCollection { name } => {
                    let definition = target
                        .collections
                        .get(name)
                        .ok_or(MigrationError::Schema)?
                        .clone();
                    if schema.insert(name.clone(), definition).is_some() {
                        return Err(MigrationError::Schema);
                    }
                }
                MigrationOp::RemoveCollection { name } => {
                    schema.remove(name).ok_or(MigrationError::Schema)?;
                }
                MigrationOp::Transform {
                    collection, field, ..
                } => {
                    let definition = target
                        .collections
                        .get(collection)
                        .and_then(|c| c.fields.get(field))
                        .ok_or(MigrationError::Schema)?
                        .clone();
                    let fields = &mut schema
                        .get_mut(collection)
                        .ok_or(MigrationError::Schema)?
                        .fields;
                    if !fields.contains_key(field) {
                        return Err(MigrationError::Schema);
                    }
                    fields.insert(field.clone(), definition);
                }
            }
        }
        if schema.len() != target.collections.len()
            || schema.iter().any(|(name, c)| {
                target
                    .collections
                    .get(name)
                    .is_none_or(|t| c.fields != t.fields)
            })
        {
            return Err(MigrationError::Schema);
        }
        Ok(Self {
            from_revision: source.revision.clone(),
            to_revision: target.revision.clone(),
            operations,
        })
    }

    pub fn preview(&self, input: &State) -> Result<Preview, MigrationError> {
        if input.revision != self.from_revision {
            return Err(MigrationError::Identity);
        }
        bounded(input)?;
        let mut state = input.clone();
        let mut budget = Budget::new(1_000_000);
        let mut impacts = Vec::new();
        for operation in &self.operations {
            let mut state_bytes = encoded_size(&state)?;
            let (name, kind, destructive) = match operation {
                MigrationOp::AddField { collection, .. } => (collection, "add_field", false),
                MigrationOp::RenameField { collection, .. } => (collection, "rename_field", false),
                MigrationOp::RemoveField { collection, .. } => (collection, "remove_field", true),
                MigrationOp::AddCollection { name } => (name, "add_collection", false),
                MigrationOp::RemoveCollection { name } => (name, "remove_collection", true),
                MigrationOp::Transform { collection, .. } => (collection, "transform", true),
            };
            let affected = state.collections.get(name).map_or(0, BTreeMap::len);
            budget
                .consume(u32::try_from(affected.max(1)).map_err(|_| MigrationError::Limit)?)
                .map_err(|_| MigrationError::Limit)?;
            // Reject multiplicative expansion before cloning defaults into records.
            if let MigrationOp::AddField { field, default, .. } = operation {
                let growth = encoded_size(field)?
                    .checked_add(encoded_size(default)?)
                    .and_then(|n| n.checked_add(2))
                    .and_then(|n| n.checked_mul(affected))
                    .ok_or(MigrationError::Limit)?;
                check_growth(state_bytes, growth)?;
            }
            match operation {
                MigrationOp::AddCollection { name } => {
                    if state
                        .collections
                        .insert(name.clone(), BTreeMap::new())
                        .is_some()
                    {
                        return Err(MigrationError::Schema);
                    }
                }
                MigrationOp::RemoveCollection { name } => {
                    state
                        .collections
                        .remove(name)
                        .ok_or(MigrationError::Schema)?;
                }
                MigrationOp::Transform {
                    collection,
                    field,
                    value,
                } => {
                    // Every row observes the same pre-operation state, independent of iteration order.
                    let before = state.clone();
                    let rows = state
                        .collections
                        .get_mut(collection)
                        .ok_or(MigrationError::Schema)?;
                    for (id, row) in rows {
                        let mut item = row.clone();
                        item.insert("_id".into(), Value::String(id.clone()));
                        let event = BTreeMap::new();
                        let context = Context {
                            state: &before,
                            event: &event,
                            item: Some(&item),
                            now: "",
                            locale: "",
                            timezone: "",
                        };
                        let result =
                            evaluate(value, &context, &mut budget).map_err(|e| match e {
                                needware_expr::EvalError::Limit => MigrationError::Limit,
                                other => MigrationError::Expression(other.to_string()),
                            })?;
                        let previous = row.get(field).map(encoded_size).transpose()?.unwrap_or(0);
                        let extra_key = if row.contains_key(field) {
                            0
                        } else {
                            encoded_size(field)? + 2
                        };
                        let next_bytes = state_bytes
                            .checked_sub(previous)
                            .and_then(|n| n.checked_add(extra_key))
                            .ok_or(MigrationError::Limit)?;
                        state_bytes = check_growth(next_bytes, encoded_size(&result)?)?;
                        row.insert(field.clone(), result);
                    }
                }
                other => {
                    let rows = state
                        .collections
                        .get_mut(name)
                        .ok_or(MigrationError::Schema)?;
                    for row in rows.values_mut() {
                        match other {
                            MigrationOp::AddField { field, default, .. } => {
                                if row.insert(field.clone(), default.clone()).is_some() {
                                    return Err(MigrationError::Schema);
                                }
                            }
                            MigrationOp::RenameField { from, to, .. } => {
                                if let Some(value) = row.remove(from)
                                    && row.insert(to.clone(), value).is_some()
                                {
                                    return Err(MigrationError::Schema);
                                }
                            }
                            MigrationOp::RemoveField { field, .. } => {
                                row.remove(field);
                            }
                            _ => return Err(MigrationError::Schema),
                        }
                    }
                }
            }
            bounded(&state)?;
            impacts.push(Impact {
                operation: kind.into(),
                collection: name.clone(),
                field: match operation {
                    MigrationOp::AddField { field, .. }
                    | MigrationOp::RemoveField { field, .. }
                    | MigrationOp::Transform { field, .. } => Some(field.clone()),
                    MigrationOp::RenameField { to, .. } => Some(to.clone()),
                    _ => None,
                },
                previous_field: match operation {
                    MigrationOp::RenameField { from, .. } => Some(from.clone()),
                    _ => None,
                },
                affected_records: affected as u32,
                destructive,
            });
        }
        state.revision = self.to_revision.clone();
        Ok(Preview {
            report: Report {
                from_revision: self.from_revision.clone(),
                to_revision: self.to_revision.clone(),
                requires_confirmation: impacts.iter().any(|i| i.destructive),
                impacts,
            },
            state,
        })
    }
}
fn bounded(state: &State) -> Result<(), MigrationError> {
    check_growth(0, encoded_size(state)?)?;
    Ok(())
}
fn encoded_size<T: Serialize>(value: &T) -> Result<usize, MigrationError> {
    Ok(serde_json::to_vec(value)
        .map_err(|_| MigrationError::Schema)?
        .len())
}
fn check_growth(bytes: usize, growth: usize) -> Result<usize, MigrationError> {
    bytes
        .checked_add(growth)
        .filter(|n| *n <= 16 * 1024 * 1024)
        .ok_or(MigrationError::Limit)
}
fn expression(expr: &Expr, depth: u32, nodes: &mut u32) -> Result<(), MigrationError> {
    *nodes += 1;
    if depth > 64 || *nodes > 16384 {
        return Err(MigrationError::Limit);
    }
    let mut child = |expr| expression(expr, depth + 1, nodes);
    match expr {
        Expr::Context { .. } | Expr::Event { .. } => return Err(MigrationError::Context),
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
            for value in values {
                child(value)?;
            }
        }
        Expr::Map { collection, value }
        | Expr::Filter {
            collection,
            predicate: value,
        } => {
            child(collection)?;
            child(value)?;
        }
        Expr::Sort { collection, .. } | Expr::Sum { collection, .. } => child(collection)?,
        _ => {}
    }
    Ok(())
}
