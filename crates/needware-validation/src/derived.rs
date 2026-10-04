//! Deterministic record projections with acyclic dependencies and bounded work.
use super::*;
use needware_expr::{Budget, Context, EvalError, evaluate};

fn dependencies(
    e: &Expr,
    original_item: bool,
    names: &mut BTreeSet<String>,
    depth: u32,
) -> Result<(), Diagnostic> {
    if depth > 64 {
        return Err(fail("derived", "expression depth limit"));
    }
    let mut child = |e: &Expr| dependencies(e, original_item, names, depth + 1);
    match e {
        Expr::Event { .. } | Expr::Context { .. } | Expr::Collection { .. } => {
            return Err(fail(
                "derived",
                "derived fields read only record and explicit state values",
            ));
        }
        Expr::Item { field } if original_item => {
            names.insert(field.clone());
        }
        Expr::Binary { left, right, .. } => {
            child(left)?;
            child(right)?;
        }
        Expr::If { condition, yes, no } => {
            child(condition)?;
            child(yes)?;
            child(no)?;
        }
        Expr::Not { value } | Expr::Length { value } => child(value)?,
        Expr::Concat { values } | Expr::Coalesce { values } => {
            for e in values {
                child(e)?;
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
            dependencies(predicate, false, names, depth + 1)?;
        }
        Expr::Sort { collection, .. } | Expr::Sum { collection, .. } => child(collection)?,
        _ => {}
    }
    Ok(())
}

pub(super) fn order(schema: &Collection) -> Result<Vec<String>, Diagnostic> {
    let mut edges = BTreeMap::new();
    for (name, field) in &schema.fields {
        if let Some(e) = &field.derived {
            if field.default.is_some() {
                return Err(fail("derived", "derived fields cannot have defaults"));
            }
            let mut deps = BTreeSet::new();
            dependencies(e, true, &mut deps, 0)?;
            if deps.iter().any(|name| !schema.fields.contains_key(name)) {
                return Err(fail("derived", "unknown record dependency"));
            }
            edges.insert(name.clone(), deps);
        }
    }
    let mut pending: BTreeSet<_> = edges.keys().cloned().collect();
    let mut result = Vec::new();
    while !pending.is_empty() {
        let next = pending
            .iter()
            .find(|name| edges[*name].iter().all(|d| !pending.contains(d)))
            .cloned()
            .ok_or_else(|| fail("derived", "cyclic derived field dependency"))?;
        pending.remove(&next);
        result.push(next);
    }
    Ok(result)
}

/// Recompute after all local mutations using the event's shared fuel/materialization budget.
/// The caller owns a candidate state and must discard it when any operation fails.
pub fn materialize(
    app: &Application,
    state: &mut State,
    budget: &mut Budget,
) -> Result<(), EvalError> {
    let event = BTreeMap::new();
    for (name, schema) in &app.collections {
        let order = order(schema).map_err(|_| EvalError::Type)?;
        if order.is_empty() {
            continue;
        }
        let records = state
            .collections
            .get(name)
            .ok_or_else(|| EvalError::Missing(name.clone()))?;
        let mut next = BTreeMap::new();
        for (id, source) in records {
            budget.consume(1)?;
            budget.record(source, 0)?;
            budget.bytes(id.len() + 128)?;
            let mut row = source.clone();
            for field in &order {
                let expr = schema.fields[field]
                    .derived
                    .as_ref()
                    .ok_or(EvalError::Type)?;
                let ctx = Context {
                    state,
                    event: &event,
                    item: Some(&row),
                    now: "",
                    locale: &app.locale,
                    timezone: "UTC",
                };
                let value = evaluate(expr, &ctx, budget)?;
                budget.bytes(field.len() + 128)?;
                row.insert(field.clone(), value);
            }
            next.insert(id.clone(), row);
        }
        state.collections.insert(name.clone(), next);
    }
    Ok(())
}

pub(super) fn verify(app: &Application, state: &State) -> Result<(), Diagnostic> {
    let mut budget = Budget::new(1_000_000);
    let event = BTreeMap::new();
    for (name, schema) in &app.collections {
        let order = order(schema)?;
        if order.is_empty() {
            continue;
        }
        let records = state
            .collections
            .get(name)
            .ok_or_else(|| fail("derived", "missing collection"))?;
        for row in records.values() {
            budget
                .consume(1)
                .map_err(|_| fail("derived", "verification fuel limit"))?;
            let ctx = Context {
                state,
                event: &event,
                item: Some(row),
                now: "",
                locale: &app.locale,
                timezone: "UTC",
            };
            for field in &order {
                let expr = schema.fields[field]
                    .derived
                    .as_ref()
                    .ok_or_else(|| fail("derived", "missing expression"))?;
                let value = evaluate(expr, &ctx, &mut budget)
                    .map_err(|_| fail("derived", "invalid or excessive derived evaluation"))?;
                if row.get(field) != Some(&value) {
                    return Err(fail(
                        "derived",
                        "persisted derived value differs from its expression",
                    ));
                }
            }
        }
    }
    Ok(())
}
