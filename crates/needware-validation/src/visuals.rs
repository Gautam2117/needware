use super::*;
pub(super) fn validate_node(node: &Node, app: &Application) -> Result<(), Diagnostic> {
    if !matches!(
        node.kind,
        Component::Icon
            | Component::Image
            | Component::Table
            | Component::Tabs
            | Component::Chart
            | Component::Calendar
    ) {
        return Ok(());
    }
    if !["visual_components_v1", "declarative_widgets_v1"]
        .iter()
        .all(|required| {
            app.runtime_features
                .iter()
                .any(|feature| feature == required)
        })
    {
        return Err(fail(
            "ui",
            "visual components require visual_components_v1 and declarative_widgets_v1",
        ));
    }
    match node.kind {
        Component::Image | Component::Chart | Component::Calendar if node.value.is_none() => {
            return Err(fail("ui", "visual data requires a value binding"));
        }
        Component::Icon
            if node.options.len() != 1
                || ![
                    "check", "heart", "clock", "calendar", "star", "info", "warning", "plus",
                    "search",
                ]
                .contains(&node.options[0].as_str()) =>
        {
            return Err(fail("ui", "icon requires one supported icon name"));
        }
        Component::Table
            if node.children.is_empty() || node.children.len() != node.options.len() =>
        {
            return Err(fail(
                "ui",
                "table headers must match its record cell templates",
            ));
        }
        Component::Tabs
            if node.children.is_empty()
                || node.children.len() > 32
                || node.children.len() != node.options.len()
                || node.options.iter().collect::<BTreeSet<_>>().len() != node.options.len() =>
        {
            return Err(fail(
                "ui",
                "tabs require distinct labels for 1 to 32 panels",
            ));
        }
        _ => {}
    }
    if node.field.is_some() {
        return Err(fail(
            "ui",
            "visual components do not bind event input fields",
        ));
    }
    if matches!(
        node.kind,
        Component::Tabs | Component::Chart | Component::Calendar
    ) && node.action.is_some()
    {
        return Err(fail(
            "ui",
            "visual data and transient tabs use separate declared action buttons",
        ));
    }
    if matches!(
        node.kind,
        Component::Image | Component::Icon | Component::Chart | Component::Calendar
    ) && !node.children.is_empty()
    {
        return Err(fail("ui", "visual leaves cannot contain ignored children"));
    }
    if matches!(node.kind, Component::Table | Component::Tabs)
        && node
            .options
            .iter()
            .any(|label| label.is_empty() || label.len() > 120)
    {
        return Err(fail("ui", "visual labels must be nonempty and bounded"));
    }
    if node.kind == Component::Tabs {
        let mut pending: Vec<&Node> = node.children.iter().collect();
        let mut count = 0;
        while let Some(child) = pending.pop() {
            count += 1;
            if count > 4096 {
                return Err(fail("ui", "tab component limit"));
            }
            if matches!(child.kind, Component::Modal | Component::Drawer) {
                return Err(fail("ui", "overlays belong outside transient tab panels"));
            }
            pending.extend(&child.children);
        }
    }
    Ok(())
}
