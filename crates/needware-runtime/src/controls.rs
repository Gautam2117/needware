use super::*;

#[derive(Clone)]
pub(crate) struct Controls {
    pub screen: String,
    pub history: Vec<String>,
    pub overlays: Vec<String>,
}

/// An opaque rollback cut belongs to one runtime instance, never to serialized input.
pub struct RuntimeSavepoint {
    instance: String,
    state: State,
    controls: Controls,
}

impl Runtime {
    pub fn savepoint(&self) -> RuntimeSavepoint {
        RuntimeSavepoint {
            instance: self.instance.clone(),
            state: self.state.clone(),
            controls: self.controls.clone(),
        }
    }

    pub fn restore_savepoint(&mut self, cut: &RuntimeSavepoint) -> Result<(), RuntimeError> {
        if cut.instance != self.instance {
            return Err(RuntimeError::Invalid(
                "rollback belongs to another runtime".into(),
            ));
        }
        self.state = cut.state.clone();
        self.controls = cut.controls.clone();
        Ok(())
    }
}

pub(crate) fn overlay_exists(node: &Node, id: &str) -> bool {
    (node.id == id && matches!(node.kind, Component::Modal | Component::Drawer))
        || node.children.iter().any(|child| overlay_exists(child, id))
}

pub(crate) fn change_controls(
    action: &Action,
    app: &Application,
    controls: &mut Controls,
) -> Result<(), RuntimeError> {
    match action {
        Action::Navigate { screen } => {
            if controls.screen != *screen {
                if controls.history.len() >= 128 {
                    controls.history.remove(0);
                }
                controls.history.push(controls.screen.clone());
                controls.screen = screen.clone();
                controls.overlays.clear();
            }
        }
        Action::Back => {
            controls.screen = controls
                .history
                .pop()
                .ok_or_else(|| RuntimeError::Invalid("navigation history is empty".into()))?;
            controls.overlays.clear();
        }
        Action::Open { overlay } | Action::Close { overlay } => {
            let screen = app
                .screens
                .iter()
                .find(|screen| screen.id == controls.screen)
                .ok_or_else(|| RuntimeError::Invalid("unknown screen".into()))?;
            if !overlay_exists(&screen.root, overlay) {
                return Err(RuntimeError::Invalid(
                    "overlay is unavailable on this screen".into(),
                ));
            }
            if matches!(action, Action::Close { .. }) {
                controls.overlays.retain(|id| id != overlay);
            } else if !controls.overlays.contains(overlay) {
                if controls.overlays.len() >= 4 {
                    return Err(RuntimeError::Limit);
                }
                controls.overlays.push(overlay.clone());
            }
        }
        _ => return Err(RuntimeError::Invalid("invalid navigation action".into())),
    }
    Ok(())
}
