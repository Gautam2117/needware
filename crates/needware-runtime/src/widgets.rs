use super::*;

pub(crate) struct RenderScope<'a> {
    pub controls: &'a Controls,
    pub form: Option<&'a str>,
    pub scope_id: Option<&'a str>,
}

pub(crate) fn binding(
    node: &Node,
    app: &Application,
    ctx: &Context<'_>,
    form: Option<&str>,
    budget: &mut Budget,
) -> Result<(Option<Field>, Option<Value>, bool), RuntimeError> {
    let contract = node.field.as_ref().and_then(|field| {
        node.action
            .as_deref()
            .or(form)
            .and_then(|action| app.event_schema.get(action))
            .and_then(|fields| fields.get(field))
            .cloned()
    });
    let value = match &node.value {
        Some(expr) => Some(evaluate(expr, ctx, budget).map_err(expression_error)?),
        None => contract.as_ref().and_then(|field| field.default.clone()),
    };
    if let (Some(value), Some(contract)) = (&value, &contract) {
        needware_validation::validate_value(value, contract, 0)
            .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
    }
    let disabled = match &node.disabled {
        Some(expr) => boolean(evaluate(expr, ctx, budget).map_err(expression_error)?)
            .map_err(expression_error)?,
        None => false,
    };
    if node.kind == Component::Progress
        && !matches!(&value, Some(Value::Integer(value)) if value.parse::<u32>().is_ok_and(|value|value<=100))
    {
        return Err(RuntimeError::Invalid(
            "progress requires an integer from 0 to 100".into(),
        ));
    }
    Ok((contract, value, disabled))
}
