//! Verified packages execute transactionally; platform effects remain typed data.
mod controls;
mod inputs;
mod revisions;
mod visuals;
mod widgets;
pub use controls::RuntimeSavepoint;
use controls::{Controls, change_controls};
use needware_capabilities::{Capability, Grants, authorize};
use needware_expr::{Budget, Context, boolean, evaluate};
use needware_ir::*;
use needware_package::VerifiedPackage;
pub use revisions::{RevisionPreview, RevisionReport};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;
pub use visuals::Raster;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("package signer is not trusted")]
    Untrusted,
    #[error("permission denied")]
    Permission,
    #[error("invalid state or event: {0}")]
    Invalid(String),
    #[error("runtime resource limit exceeded")]
    Limit,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub action: String,
    pub values: BTreeMap<String, Value>,
    pub now: String,
    pub timezone: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct Effect {
    pub id: String,
    pub capability: Capability,
    pub input: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
pub struct ViewNode {
    pub id: String,
    pub kind: Component,
    pub text: String,
    pub value: Option<Value>,
    pub input_contract: Option<Field>,
    pub form_scope: Option<String>,
    pub disabled: bool,
    pub raster: Option<Raster>,
    pub theme: Option<Theme>,
    pub field: Option<String>,
    pub action: Option<String>,
    pub event_fields: Option<Vec<String>>,
    pub acknowledged_fields: Option<Vec<String>>,
    pub record: Option<String>,
    pub options: Vec<String>,
    pub style: Style,
    pub open: bool,
    pub active_overlay: bool,
    pub children: Vec<ViewNode>,
}
#[derive(Clone)]
pub struct Runtime {
    package: VerifiedPackage,
    state: State,
    grants: Grants,
    instance: String,
    controls: Controls,
    input_fields: BTreeMap<String, inputs::Fields>,
}
impl Runtime {
    pub fn load(
        package: VerifiedPackage,
        state: Option<State>,
        grants: Grants,
        trusted: &[[u8; 32]],
    ) -> Result<Self, RuntimeError> {
        if !package.signers().iter().any(|s| trusted.contains(s)) {
            return Err(RuntimeError::Untrusted);
        }
        let app = package.application().application();
        if grants.application != app.id || grants.revision != app.revision {
            return Err(RuntimeError::Permission);
        }
        let state = state.unwrap_or_else(|| State::empty(app));
        needware_validation::validate_state(&state, app)
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let screen = app.initial_screen.clone();
        let input_fields = inputs::contracts(app)?;
        Ok(Self {
            package,
            state,
            grants,
            input_fields,
            instance: uuid::Uuid::new_v4().to_string(),
            controls: Controls {
                screen,
                history: vec![],
                overlays: vec![],
            },
        })
    }
    pub fn application(&self) -> &Application {
        self.package.application().application()
    }
    pub fn package(&self) -> &VerifiedPackage {
        &self.package
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    pub fn restore(&mut self, state: State) -> Result<(), RuntimeError> {
        needware_validation::validate_state(&state, self.application())
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        if self
            .application()
            .runtime_features
            .iter()
            .any(|feature| feature == "declarative_widgets_v1")
        {
            self.view_cut(&state, &self.controls)?;
        }
        self.state = state;
        Ok(())
    }
    pub fn dispatch(&mut self, event: &Event) -> Result<Vec<Effect>, RuntimeError> {
        if serde_json::to_vec(event)
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?
            .len()
            > 1024 * 1024
        {
            return Err(RuntimeError::Limit);
        }
        needware_validation::validate_event(&event.action, &event.values, self.application())
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let mut event = event.clone();
        if let Some(fields) = self.application().event_schema.get(&event.action) {
            for (key, field) in fields {
                if matches!(field.data_type, DataType::Optional { .. }) {
                    event.values.entry(key.clone()).or_insert(Value::Null);
                }
            }
        }
        let action = self
            .application()
            .actions
            .get(&event.action)
            .ok_or_else(|| RuntimeError::Invalid("unknown action".into()))?
            .clone();
        let mut next = self.state.clone();
        let mut effects = vec![];
        let mut controls = self.controls.clone();
        let mut count = 0;
        let mut budget = Budget::new(1_000_000);
        apply(
            &action,
            self.application(),
            &self.grants,
            &mut next,
            &event,
            &mut effects,
            &mut controls,
            &mut count,
            &mut budget,
            0,
        )?;
        needware_validation::validate_state(&next, self.application())
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        if self
            .application()
            .runtime_features
            .iter()
            .any(|feature| feature == "declarative_widgets_v1")
        {
            self.view_cut(&next, &controls)?;
        }
        self.state = next;
        self.controls = controls;
        Ok(effects)
    }
    pub fn view(&self) -> Result<ViewNode, RuntimeError> {
        self.view_cut(&self.state, &self.controls)
    }
    fn view_cut(&self, state: &State, controls: &Controls) -> Result<ViewNode, RuntimeError> {
        let app = self.application();
        if !app.collections.is_empty() {
            permission(
                app,
                &self.grants,
                &Capability::Storage {
                    synchronized: false,
                    write: false,
                    collections: app.collections.keys().cloned().collect(),
                },
            )?;
        }
        let screen = app
            .screens
            .iter()
            .find(|s| s.id == controls.screen)
            .ok_or_else(|| RuntimeError::Invalid("unknown screen".into()))?;
        let event = BTreeMap::new();
        let ctx = Context {
            state,
            event: &event,
            item: None,
            now: "",
            locale: &app.locale,
            timezone: "UTC",
        };
        render(
            &screen.root,
            app,
            &ctx,
            None,
            &widgets::RenderScope {
                controls,
                form: None,
                scope_id: None,
                package: &self.package,
                input_fields: &self.input_fields,
            },
            &mut Budget::new(1_000_000),
            &mut visuals::RenderMeter::default(),
        )
    }
}
fn permission(app: &Application, grants: &Grants, cap: &Capability) -> Result<(), RuntimeError> {
    if !app.capabilities.iter().any(|c| c.covers(cap)) {
        return Err(RuntimeError::Permission);
    }
    authorize(grants, &app.id, &app.revision, cap).map_err(|_| RuntimeError::Permission)
}
fn value(
    expr: &Expr,
    state: &State,
    event: &Event,
    item: Option<&BTreeMap<String, Value>>,
    app: &Application,
    budget: &mut Budget,
) -> Result<Value, RuntimeError> {
    evaluate(
        expr,
        &Context {
            state,
            event: &event.values,
            item,
            now: &event.now,
            locale: &app.locale,
            timezone: &event.timezone,
        },
        budget,
    )
    .map_err(expression_error)
}
fn expression_error(error: needware_expr::EvalError) -> RuntimeError {
    match error {
        needware_expr::EvalError::Limit => RuntimeError::Limit,
        other => RuntimeError::Invalid(other.to_string()),
    }
}
#[allow(clippy::too_many_arguments)]
fn apply(
    a: &Action,
    app: &Application,
    grants: &Grants,
    state: &mut State,
    event: &Event,
    effects: &mut Vec<Effect>,
    controls: &mut Controls,
    count: &mut u32,
    budget: &mut Budget,
    depth: u32,
) -> Result<(), RuntimeError> {
    *count += 1;
    if *count > 256 || depth > 32 {
        return Err(RuntimeError::Limit);
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
            permission(
                app,
                grants,
                &Capability::Storage {
                    synchronized: false,
                    write: true,
                    collections: vec![collection.clone()],
                },
            )?;
            let Value::String(id) = value(id, state, event, None, app, budget)? else {
                return Err(RuntimeError::Invalid("record id must be a string".into()));
            };
            if uuid::Uuid::parse_str(&id).is_err() {
                return Err(RuntimeError::Invalid("record id must be UUID".into()));
            }
            let schema = app
                .collections
                .get(collection)
                .ok_or_else(|| RuntimeError::Invalid("unknown collection".into()))?;
            let old = state
                .collections
                .get(collection)
                .and_then(|c| c.get(&id))
                .cloned();
            if matches!(a, Action::Create { .. }) && old.is_some() {
                return Err(RuntimeError::Invalid("record already exists".into()));
            }
            if matches!(a, Action::Update { .. }) && old.is_none() {
                return Err(RuntimeError::Invalid("record missing".into()));
            }
            let mut record = old.clone().unwrap_or_else(|| {
                schema
                    .fields
                    .iter()
                    .filter_map(|(k, f)| f.default.clone().map(|v| (k.clone(), v)))
                    .collect()
            });
            for (field, expr) in values {
                record.insert(
                    field.clone(),
                    value(expr, state, event, old.as_ref(), app, budget)?,
                );
            }
            needware_validation::validate_record(&record, schema)
                .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
            state
                .collections
                .get_mut(collection)
                .ok_or_else(|| RuntimeError::Invalid("unknown collection".into()))?
                .insert(id, record);
        }
        Action::Delete { collection, id } => {
            permission(
                app,
                grants,
                &Capability::Storage {
                    synchronized: false,
                    write: true,
                    collections: vec![collection.clone()],
                },
            )?;
            let Value::String(id) = value(id, state, event, None, app, budget)? else {
                return Err(RuntimeError::Invalid("record id must be a string".into()));
            };
            if uuid::Uuid::parse_str(&id).is_err() {
                return Err(RuntimeError::Invalid("record id must be UUID".into()));
            }
            state
                .collections
                .get_mut(collection)
                .ok_or_else(|| RuntimeError::Invalid("unknown collection".into()))?
                .remove(&id);
        }
        Action::Set { key, value: expr } => {
            if !app.state.contains_key(key) {
                return Err(RuntimeError::Invalid("unknown state key".into()));
            }
            let v = value(expr, state, event, None, app, budget)?;
            state.values.insert(key.clone(), v);
        }
        Action::Sequence { actions } | Action::Parallel { actions } => {
            // Local mutations and effect preparation are deterministic and ordered.
            // A parallel group shares the event budget; only host effects may run concurrently.
            for a in actions {
                apply(
                    a,
                    app,
                    grants,
                    state,
                    event,
                    effects,
                    controls,
                    count,
                    budget,
                    depth + 1,
                )?;
            }
        }
        Action::Conditional { condition, yes, no } => {
            if boolean(value(condition, state, event, None, app, budget)?)
                .map_err(|e| RuntimeError::Invalid(e.to_string()))?
            {
                apply(
                    yes,
                    app,
                    grants,
                    state,
                    event,
                    effects,
                    controls,
                    count,
                    budget,
                    depth + 1,
                )?;
            } else if let Some(no) = no {
                apply(
                    no,
                    app,
                    grants,
                    state,
                    event,
                    effects,
                    controls,
                    count,
                    budget,
                    depth + 1,
                )?;
            }
        }
        Action::Navigate { .. } | Action::Back | Action::Open { .. } | Action::Close { .. } => {
            change_controls(a, app, controls)?
        }
        Action::Effect { capability, input } => {
            permission(app, grants, capability)?;
            if effects.len() >= 4 {
                return Err(RuntimeError::Limit);
            }
            effects.push(Effect {
                id: uuid::Uuid::new_v4().to_string(),
                capability: capability.clone(),
                input: value(input, state, event, None, app, budget)?,
            });
        }
    }
    if matches!(
        a,
        Action::Create { .. } | Action::Update { .. } | Action::Delete { .. } | Action::Set { .. }
    ) {
        let collections: Vec<_> = app
            .collections
            .iter()
            .filter(|(_, c)| c.fields.values().any(|f| f.derived.is_some()))
            .map(|(name, _)| name.clone())
            .collect();
        if !collections.is_empty() {
            permission(
                app,
                grants,
                &Capability::Storage {
                    synchronized: false,
                    write: true,
                    collections,
                },
            )?;
            needware_validation::derived::materialize(app, state, budget)
                .map_err(expression_error)?;
        }
    }
    Ok(())
}
fn render(
    node: &Node,
    app: &Application,
    ctx: &Context<'_>,
    record: Option<&str>,
    scope: &widgets::RenderScope<'_>,
    budget: &mut Budget,
    meter: &mut visuals::RenderMeter,
) -> Result<ViewNode, RuntimeError> {
    meter.nodes += 1;
    let theme = if meter.nodes == 1 {
        Some(app.theme.clone())
    } else {
        None
    };
    if meter.nodes > 4096 {
        return Err(RuntimeError::Limit);
    }
    let input_fields = node
        .action
        .as_ref()
        .and_then(|action| scope.input_fields.get(action));
    if let Some(fields) = input_fields {
        let bytes =
            fields
                .request
                .iter()
                .chain(&fields.acknowledged)
                .try_fold(0usize, |sum, field| {
                    sum.checked_add(field.len())
                        .and_then(|sum| sum.checked_add(3))
                        .ok_or(RuntimeError::Limit)
                })?;
        meter.input_bytes = meter
            .input_bytes
            .checked_add(bytes)
            .ok_or(RuntimeError::Limit)?;
        if meter.input_bytes > 4 * 1024 * 1024 {
            return Err(RuntimeError::Limit);
        }
    }
    let text = match &node.text {
        Some(e) => needware_expr::display(&evaluate(e, ctx, budget).map_err(expression_error)?)
            .map_err(expression_error)?,
        None => String::new(),
    };
    let mut children = vec![];
    let is_overlay = matches!(node.kind, Component::Modal | Component::Drawer);
    let open = !is_overlay || scope.controls.overlays.contains(&node.id);
    let form = if node.kind == Component::Form {
        node.action.as_deref()
    } else {
        scope.form
    };
    let nested_scope = widgets::RenderScope {
        controls: scope.controls,
        form,
        package: scope.package,
        input_fields: scope.input_fields,
        scope_id: if node.kind == Component::Form {
            Some(&node.id)
        } else {
            scope.scope_id
        },
    };
    let (input_contract, value, disabled) = widgets::binding(node, app, ctx, form, budget)?;
    let raster = visuals::prepare(node, &value, &text, scope.package, meter)?;
    if open && matches!(node.kind, Component::List | Component::Table) {
        let collection = node
            .collection
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("list missing collection".into()))?;
        let rows = ctx
            .state
            .collections
            .get(collection)
            .ok_or_else(|| RuntimeError::Invalid("unknown collection".into()))?;
        for (id, row) in rows.iter().take(100) {
            let nested = Context {
                item: Some(row),
                ..*ctx
            };
            for child in &node.children {
                children.push(render(
                    child,
                    app,
                    &nested,
                    Some(id),
                    &nested_scope,
                    budget,
                    meter,
                )?);
            }
        }
    } else if open {
        for child in &node.children {
            children.push(render(
                child,
                app,
                ctx,
                record,
                &nested_scope,
                budget,
                meter,
            )?);
        }
    }
    Ok(ViewNode {
        id: match record {
            Some(id) => format!("{}-{id}", node.id),
            None => node.id.clone(),
        },
        kind: node.kind.clone(),
        text,
        value,
        input_contract,
        form_scope: Some(match nested_scope.scope_id {
            Some(name) => match record {
                Some(id) => format!("{name}:{id}"),
                None => name.into(),
            },
            None => match record {
                Some(id) => format!("@screen:{}:{id}", scope.controls.screen),
                None => format!("@screen:{}", scope.controls.screen),
            },
        }),
        disabled,
        raster,
        theme,
        field: node.field.clone(),
        action: node.action.clone(),
        event_fields: node
            .action
            .as_ref()
            .and_then(|a| scope.input_fields.get(a))
            .map(|fields| fields.request.clone()),
        acknowledged_fields: node
            .action
            .as_ref()
            .and_then(|a| scope.input_fields.get(a))
            .map(|fields| fields.acknowledged.clone()),
        record: record.map(str::to_owned),
        options: node.options.clone(),
        style: node.style.clone(),
        open,
        active_overlay: is_overlay && scope.controls.overlays.last() == Some(&node.id),
        children,
    })
}
