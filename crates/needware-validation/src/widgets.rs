use super::*;
#[derive(Clone, Copy)]
pub(super) struct NodeScope<'a> {
    pub item: Option<&'a Collection>,
    pub form: Option<&'a str>,
}
fn base(data_type: &DataType) -> &DataType {
    match data_type {
        DataType::Optional { inner } => base(inner),
        other => other,
    }
}
pub(super) fn validate_node<'a>(
    node: &'a Node,
    app: &Application,
    scope: NodeScope<'a>,
) -> Result<Option<&'a str>, Diagnostic> {
    let enabled = app
        .runtime_features
        .iter()
        .any(|feature| feature == "declarative_widgets_v1");
    let new_kind = matches!(
        node.kind,
        Component::Form
            | Component::Checkbox
            | Component::Toggle
            | Component::Radio
            | Component::Select
            | Component::MultiSelect
            | Component::Slider
            | Component::Progress
    );
    if (new_kind || node.value.is_some() || node.disabled.is_some()) && !enabled {
        return Err(fail(
            "ui",
            "bindings and widgets require declarative_widgets_v1",
        ));
    }
    if node.kind == Component::Form && scope.form.is_some() {
        return Err(fail("ui", "forms cannot be nested"));
    }
    if node.kind == Component::Form {
        let mut pending: Vec<&Node> = node.children.iter().collect();
        let mut fields = BTreeSet::new();
        let mut count = 0;
        while let Some(child) = pending.pop() {
            count += 1;
            if count > 4096 {
                return Err(fail("ui", "form component limit"));
            }
            if matches!(child.kind, Component::List | Component::Table) {
                return Err(fail(
                    "ui",
                    "place each repeated form inside its record container",
                ));
            }
            if is_input(&child.kind)
                && child
                    .field
                    .as_ref()
                    .is_some_and(|field| !fields.insert(field))
            {
                return Err(fail("ui", "duplicate input field within one form"));
            }
            pending.extend(&child.children);
        }
    }
    let form = if node.kind == Component::Form {
        Some(
            node.action
                .as_deref()
                .ok_or_else(|| fail("ui", "form requires a submit action"))?,
        )
    } else {
        scope.form
    };
    let input = matches!(
        node.kind,
        Component::TextInput
            | Component::Textarea
            | Component::NumericInput
            | Component::DateInput
            | Component::DatetimeInput
            | Component::Checkbox
            | Component::Toggle
            | Component::Radio
            | Component::Select
            | Component::MultiSelect
            | Component::Slider
    );
    if enabled && input {
        if form.is_none()
            || node
                .action
                .as_deref()
                .is_some_and(|action| Some(action) != form)
        {
            return Err(fail(
                "ui",
                "typed inputs belong to one declared form submit contract",
            ));
        }
        let field = node
            .field
            .as_ref()
            .ok_or_else(|| fail("ui", "input requires a field"))?;
        if field == "record_id" {
            return Err(fail("ui", "record_id is supplied by the record container"));
        }
        let contract = node
            .action
            .as_deref()
            .or(form)
            .and_then(|action| app.event_schema.get(action))
            .and_then(|fields| fields.get(field))
            .ok_or_else(|| fail("ui", "input requires an exact event field contract"))?;
        let data_type = base(&contract.data_type);
        let valid = match node.kind {
            Component::Checkbox | Component::Toggle => matches!(data_type, DataType::Boolean),
            Component::NumericInput => {
                matches!(data_type, DataType::Integer | DataType::Decimal { .. })
            }
            Component::Slider => matches!(data_type, DataType::Integer),
            Component::DateInput => matches!(data_type, DataType::Date),
            Component::DatetimeInput => matches!(data_type, DataType::Datetime),
            Component::Radio | Component::Select => {
                matches!(data_type,DataType::Enum{values} if *values==node.options)
            }
            Component::MultiSelect => {
                matches!(data_type,DataType::List{item} if matches!(base(item),DataType::Enum{values} if *values==node.options))
            }
            _ => matches!(
                data_type,
                DataType::String | DataType::Url | DataType::Enum { .. }
            ),
        };
        if !valid {
            return Err(fail(
                "ui",
                "input kind/options disagree with its event contract",
            ));
        }
        if matches!(node.kind, Component::Slider)
            && (contract.minimum.is_none() || contract.maximum.is_none())
        {
            return Err(fail("ui", "slider requires minimum and maximum"));
        }
        if node.kind == Component::Slider {
            let bounds = contract
                .minimum
                .as_ref()
                .and_then(|minimum| minimum.parse::<i32>().ok())
                .zip(
                    contract
                        .maximum
                        .as_ref()
                        .and_then(|maximum| maximum.parse::<i32>().ok()),
                );
            if !bounds.is_some_and(|(minimum, maximum)| {
                maximum > minimum && i64::from(maximum) - i64::from(minimum) <= 1_000_000
            }) || node.value.is_none() && contract.default.is_none()
            {
                return Err(fail(
                    "ui",
                    "slider requires a bound value and an exact bounded integer range",
                ));
            }
        }
    }
    if node.kind == Component::Form && !app.event_schema.contains_key(form.unwrap_or("")) {
        return Err(fail("ui", "form requires a typed submit contract"));
    }
    if node.kind == Component::Progress && node.value.is_none() {
        return Err(fail("ui", "progress requires a value binding"));
    }
    Ok(form)
}
fn is_input(kind: &Component) -> bool {
    matches!(
        kind,
        Component::TextInput
            | Component::Textarea
            | Component::NumericInput
            | Component::DateInput
            | Component::DatetimeInput
            | Component::Checkbox
            | Component::Toggle
            | Component::Radio
            | Component::Select
            | Component::MultiSelect
            | Component::Slider
    )
}
