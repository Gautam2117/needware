use needware_ir::{Action, Application, Expr};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
pub(crate) struct Fields {
    pub request: Vec<String>,
    pub acknowledged: Vec<String>,
}
pub(crate) fn contracts(
    app: &Application,
) -> Result<BTreeMap<String, Fields>, super::RuntimeError> {
    app.actions
        .iter()
        .map(|(name, action)| {
            let fields: Vec<String> = if let Some(schema) = app.event_schema.get(name) {
                schema.keys().cloned().collect()
            } else {
                let mut fields = BTreeSet::new();
                collect_action(action, &mut fields);
                fields.into_iter().collect()
            };
            let acknowledged: Vec<String> = committed(action).into_iter().collect();
            if fields.len() > 128 || acknowledged.len() > 128 {
                return Err(super::RuntimeError::Invalid(
                    "action input field limit".into(),
                ));
            }
            Ok((
                name.clone(),
                Fields {
                    request: fields,
                    acknowledged,
                },
            ))
        })
        .collect()
}

fn committed(action: &Action) -> BTreeSet<String> {
    match action {
        Action::Conditional { yes, no, .. } => {
            let Some(no) = no else {
                return BTreeSet::new();
            };
            let right = committed(no);
            committed(yes).intersection(&right).cloned().collect()
        }
        Action::Sequence { actions } | Action::Parallel { actions } => {
            actions.iter().flat_map(committed).collect()
        }
        Action::Navigate { .. } | Action::Back | Action::Open { .. } | Action::Close { .. } => {
            BTreeSet::new()
        }
        Action::Create { .. }
        | Action::Update { .. }
        | Action::Delete { .. }
        | Action::Set { .. }
        | Action::Effect { .. } => {
            let mut fields = BTreeSet::new();
            collect_action(action, &mut fields);
            fields
        }
    }
}

fn collect_action(action: &Action, fields: &mut BTreeSet<String>) {
    match action {
        Action::Create { id, values, .. } | Action::Update { id, values, .. } => {
            collect_expr(id, fields);
            for value in values.values() {
                collect_expr(value, fields);
            }
        }
        Action::Delete { id, .. } => collect_expr(id, fields),
        Action::Set { value, .. } => collect_expr(value, fields),
        Action::Effect { input, .. } => collect_expr(input, fields),
        Action::Sequence { actions } | Action::Parallel { actions } => {
            for action in actions {
                collect_action(action, fields);
            }
        }
        Action::Conditional { condition, yes, no } => {
            collect_expr(condition, fields);
            collect_action(yes, fields);
            if let Some(no) = no {
                collect_action(no, fields);
            }
        }
        Action::Navigate { .. } | Action::Back | Action::Open { .. } | Action::Close { .. } => {}
    }
}

fn collect_expr(expr: &Expr, fields: &mut BTreeSet<String>) {
    match expr {
        Expr::Event { key } => {
            fields.insert(key.clone());
        }
        Expr::Binary { left, right, .. } => {
            collect_expr(left, fields);
            collect_expr(right, fields);
        }
        Expr::Not { value } | Expr::Length { value } => collect_expr(value, fields),
        Expr::If { condition, yes, no } => {
            collect_expr(condition, fields);
            collect_expr(yes, fields);
            collect_expr(no, fields);
        }
        Expr::Concat { values } | Expr::Coalesce { values } => {
            for value in values {
                collect_expr(value, fields);
            }
        }
        Expr::Filter {
            collection,
            predicate,
        } => {
            collect_expr(collection, fields);
            collect_expr(predicate, fields);
        }
        Expr::Map { collection, value } => {
            collect_expr(collection, fields);
            collect_expr(value, fields);
        }
        Expr::Sort { collection, .. } | Expr::Sum { collection, .. } => {
            collect_expr(collection, fields)
        }
        Expr::Literal { .. }
        | Expr::State { .. }
        | Expr::Item { .. }
        | Expr::Collection { .. }
        | Expr::Context { .. } => {}
    }
}
