//! Narrow browser boundary; core semantics stay in native-testable Rust.
mod vault;
use needware_capabilities::Grants;
use needware_runtime::{Event, Runtime, RuntimeSavepoint};
pub use vault::generation::{BrowserGenerationResult, seal_generation_package};
use wasm_bindgen::prelude::*;
fn error(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}
#[wasm_bindgen]
pub struct BrowserRuntimeSavepoint {
    inner: RuntimeSavepoint,
}
#[wasm_bindgen]
pub fn inspect_package(bytes: &[u8]) -> Result<String, JsValue> {
    let p = needware_package::verify(bytes).map_err(error)?;
    serde_json::to_string(&serde_json::json!({"application":p.application().application(),"digest":p.digest(),"signers":p.signers().iter().map(hex::encode).collect::<Vec<_>>()})).map_err(error)
}
#[wasm_bindgen]
pub fn authored_example() -> Result<Vec<u8>, JsValue> {
    let key = needware_crypto::SecretKey::random().map_err(error)?;
    needware_package::build(needware_ir::examples::typed_habit_tracker(), vec![], &key)
        .map_err(error)
}
/// Copy only a verified definition/assets; runtime state and document keys never enter a remix.
#[wasm_bindgen]
pub fn remix_package(
    bytes: &[u8],
    application: &str,
    revision: &str,
    consent: bool,
) -> Result<Vec<u8>, JsValue> {
    if !consent {
        return Err(error("explicit remix consent required"));
    }
    let source = needware_package::verify(bytes).map_err(error)?;
    let mut app = source.application().application().clone();
    if application == app.id || revision == app.revision {
        return Err(error(
            "remix requires a new application and revision identity",
        ));
    }
    app.id = application.into();
    app.revision = revision.into();
    app.parent = Some(source.digest());
    app.migrations.clear();
    let key = needware_crypto::SecretKey::random().map_err(error)?;
    needware_package::build(app, source.assets().values().cloned().collect(), &key).map_err(error)
}
#[wasm_bindgen]
pub struct BrowserRuntime {
    inner: Runtime,
    pending: Option<(needware_runtime::RevisionPreview, Grants)>,
}
#[wasm_bindgen]
impl BrowserRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], state_json: Option<String>, consent: bool) -> Result<Self, JsValue> {
        if !consent {
            return Err(error("explicit package and permission consent required"));
        }
        let p = needware_package::verify(bytes).map_err(error)?;
        let app = p.application().application();
        let grants = needware_capabilities::Grants {
            application: app.id.clone(),
            revision: app.revision.clone(),
            capabilities: app.capabilities.clone(),
        };
        let trusted = p.signers().to_vec();
        let state = state_json
            .map(|s| needware_package::parse_state(s.as_bytes()))
            .transpose()
            .map_err(error)?;
        Ok(Self {
            inner: Runtime::load(p, state, grants, &trusted).map_err(error)?,
            pending: None,
        })
    }
    pub fn preview_revision(
        &mut self,
        bytes: &[u8],
        signer_consent: bool,
    ) -> Result<String, JsValue> {
        self.pending = None;
        if !signer_consent {
            return Err(error("signer review required"));
        }
        let package = needware_package::verify(bytes).map_err(error)?;
        let grants = Grants {
            application: package.application().application().id.clone(),
            revision: package.application().application().revision.clone(),
            capabilities: package.application().application().capabilities.clone(),
        };
        let trusted = package.signers().to_vec();
        let preview = self
            .inner
            .preview_revision(package, &trusted)
            .map_err(error)?;
        let report = serde_json::to_string(preview.report()).map_err(error)?;
        self.pending = Some((preview, grants));
        Ok(report)
    }
    pub fn approve_revision(
        &mut self,
        review: &str,
        destructive: bool,
        permissions: bool,
    ) -> Result<BrowserRuntime, JsValue> {
        let (preview, grants) = self
            .pending
            .take()
            .ok_or_else(|| error("revision review required"))?;
        if !preview.report().permissions_added.is_empty() && !permissions {
            return Err(error("permission review required"));
        }
        let inner = preview
            .approve(&self.inner, review, grants, destructive)
            .map_err(error)?;
        Ok(Self {
            inner,
            pending: None,
        })
    }
    pub fn view(&self) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.view().map_err(error)?).map_err(error)
    }
    pub fn snapshot(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.inner.state()).map_err(error)
    }
    pub fn savepoint(&self) -> BrowserRuntimeSavepoint {
        BrowserRuntimeSavepoint {
            inner: self.inner.savepoint(),
        }
    }
    pub fn restore_savepoint(&mut self, cut: &BrowserRuntimeSavepoint) -> Result<(), JsValue> {
        self.inner.restore_savepoint(&cut.inner).map_err(error)
    }
    pub fn restore(&mut self, json: &str) -> Result<(), JsValue> {
        let state = needware_package::parse_state(json.as_bytes()).map_err(error)?;
        self.inner.restore(state).map_err(error)
    }
    pub fn dispatch(&mut self, json: &str) -> Result<String, JsValue> {
        let event: Event = needware_package::parse_json(json.as_bytes()).map_err(error)?;
        let effects = self.inner.dispatch(&event).map_err(error)?;
        serde_json::to_string(&effects).map_err(error)
    }
    pub fn effect_checkpoint(&self) -> Result<String, JsValue> {
        self.inner.effect_checkpoint().map_err(error)
    }
    pub fn restore_effect_checkpoint(&mut self, checkpoint: &str) -> Result<(), JsValue> {
        self.inner
            .restore_effect_checkpoint(checkpoint)
            .map_err(error)
    }
    pub fn complete_effect(&mut self, id: &str, outcome: &str) -> Result<String, JsValue> {
        if outcome.len() > 1024 * 1024 {
            return Err(error("effect outcome exceeds limit"));
        }
        let outcome = needware_package::parse_json(outcome.as_bytes()).map_err(error)?;
        serde_json::to_string(&self.inner.complete_effect(id, outcome).map_err(error)?)
            .map_err(error)
    }
    pub fn discard_effect(&mut self, id: &str) -> Result<(), JsValue> {
        self.inner.discard_effect(id).map_err(error)
    }
    pub fn select_page(&mut self, node: &str, offset: usize) -> Result<String, JsValue> {
        serde_json::to_string(&self.inner.select_page(node, offset).map_err(error)?).map_err(error)
    }
}
