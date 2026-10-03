//! Browser generation contract. No credential is represented by these types.
use crate::{CompileError, StageEvent, Usage, provider::Kind};
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct CompileRequest {
    pub prompt: String,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ProviderInfo {
    pub fixture: bool,
    pub kind: Kind,
    pub model: String,
    pub endpoint: String,
    pub credential_owner: String,
}
#[derive(Serialize, ts_rs::TS)]
pub struct ProviderResponse {
    pub provider: Option<ProviderInfo>,
}
#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompileMessage {
    Stage {
        event: StageEvent,
    },
    Package {
        package_base64: String,
        usage: Usage,
    },
    Error {
        code: String,
        message: String,
    },
}
impl CompileMessage {
    pub fn failure(error: &CompileError) -> Self {
        let (code, message) = match error {
            CompileError::Configuration => (
                "generation_disabled",
                "Creation is not configured on this installation.",
            ),
            CompileError::Limit => (
                "generation_limit",
                "Creation reached its resource or spending limit.",
            ),
            CompileError::Cancelled => ("generation_cancelled", "Creation was cancelled."),
            CompileError::Timeout => (
                "generation_timeout",
                "Creation reached its time limit. You can try again.",
            ),
            CompileError::Transport | CompileError::ProviderStatus(_) => (
                "provider_unavailable",
                "The configured provider could not complete the request.",
            ),
            CompileError::Refused => (
                "provider_refused",
                "The provider declined or did not complete this request.",
            ),
            CompileError::Unsupported => (
                "unsupported_intent",
                "The request needs features that are not supported yet.",
            ),
            _ => (
                "invalid_definition",
                "The application did not pass validation. It was not started.",
            ),
        };
        Self::Error {
            code: code.into(),
            message: message.into(),
        }
    }
}
