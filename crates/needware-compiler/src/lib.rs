//! Structured intent compilation. Provider output never crosses verification as executable code.
pub mod protocol;
pub mod provider;
mod response_json;
pub mod schema;
use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_expr::{Budget, Context, boolean, evaluate};
use needware_ir::{Application, BehaviorTest};
use needware_runtime::{Event, Runtime};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::watch;

#[derive(Debug, Error)]
pub enum CompileError {
    #[error("invalid compiler configuration")]
    Configuration,
    #[error("compiler budget or resource limit exceeded")]
    Limit,
    #[error("generation cancelled")]
    Cancelled,
    #[error("generation time limit exceeded")]
    Timeout,
    #[error("provider transport failed; no automatic retry occurred")]
    Transport,
    #[error("provider rejected the request (HTTP {0})")]
    ProviderStatus(u16),
    #[error("provider refused or did not finish structured generation")]
    Refused,
    #[error("invalid structured provider output")]
    InvalidOutput,
    #[error("intent includes unsupported requirements")]
    Unsupported,
    #[error("application failed validation or behavioral tests")]
    Validation,
    #[error("{path}: {message}")]
    Diagnostics { path: String, message: String },
}
#[derive(Clone)]
pub struct Cancellation(watch::Sender<bool>);
impl Default for Cancellation {
    fn default() -> Self {
        Self::new()
    }
}
impl Cancellation {
    pub fn new() -> Self {
        Self(watch::channel(false).0)
    }
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub max_tokens: u64,
    pub max_cost_microusd: u64,
    pub max_output_tokens: u32,
    pub max_repairs: u8,
    pub overall_seconds: u64,
    pub request_seconds: u64,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            max_tokens: 250_000,
            max_cost_microusd: 500_000,
            max_output_tokens: 8192,
            max_repairs: 2,
            overall_seconds: 180,
            request_seconds: 60,
        }
    }
}
#[derive(Debug, Clone, Serialize, Default, ts_rs::TS)]
pub struct Usage {
    #[ts(type = "number")]
    pub input_tokens: u64,
    #[ts(type = "number")]
    pub output_tokens: u64,
    #[ts(type = "number")]
    pub configured_cost_microusd: u64,
    pub unknown_usage_requests: u32,
    #[ts(type = "number")]
    pub conservative_cost_microusd: u64,
}
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct StageEvent {
    pub stage: &'static str,
    pub attempt: u8,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
    pub usage: Usage,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Intent {
    goal: String,
    requirements: Vec<String>,
    /// Only genuinely unsupported requirements. Use an empty array when none exist;
    /// never include supported requirements or explanations such as "none" here.
    unsupported: Vec<String>,
}
pub struct Compiled {
    pub package: Vec<u8>,
    pub usage: Usage,
    pub provider: provider::Kind,
    pub model: String,
}
pub struct Compiler {
    adapter: provider::Adapter,
    key: SecretKey,
    policy: Policy,
    schema: schema::WireSchema,
    canonical: bool,
}
impl Compiler {
    pub fn new(
        config: provider::Config,
        policy: Policy,
        key: SecretKey,
    ) -> Result<Self, CompileError> {
        if policy.max_tokens == 0
            || policy.max_tokens > 1_000_000
            || policy.max_repairs > 2
            || policy.max_cost_microusd > 1_000_000_000
            || policy.max_output_tokens == 0
            || policy.max_output_tokens > 32768
            || policy.overall_seconds == 0
            || policy.overall_seconds > 180
            || policy.request_seconds == 0
            || policy.request_seconds > 60
        {
            return Err(CompileError::Configuration);
        }
        Ok(Self {
            adapter: provider::Adapter::new(config, policy.request_seconds)?,
            key,
            policy,
            schema: schema::WireSchema::new(),
            canonical: false,
        })
    }
    /// Explicit OpenAI-compatible JSON mode; the default remains acyclic structured output.
    pub fn new_canonical(
        config: provider::Config,
        policy: Policy,
        key: SecretKey,
    ) -> Result<Self, CompileError> {
        if config.kind != provider::Kind::Local {
            return Err(CompileError::Configuration);
        }
        let mut compiler = Self::new(config, policy, key)?;
        compiler.canonical = true;
        compiler.adapter.json_mode = true;
        Ok(compiler)
    }
    pub fn provider_name(&self) -> (&provider::Kind, &str) {
        (&self.adapter.config.kind, &self.adapter.config.model)
    }
    pub fn provider_info(&self) -> protocol::ProviderInfo {
        protocol::ProviderInfo {
            fixture: self.adapter.config.fixture,
            kind: self.adapter.config.kind,
            model: self.adapter.config.model.clone(),
            endpoint: self.adapter.config.endpoint.to_string(),
            credential_owner: "installation".into(),
            signing_authority: hex::encode(self.key.public_key()),
            max_cost_microusd: self.policy.max_cost_microusd,
            input_microusd_per_million: self.adapter.config.input_microusd_per_million,
            output_microusd_per_million: self.adapter.config.output_microusd_per_million,
        }
    }
    pub async fn compile(
        &self,
        prompt: &str,
        acceptance: &[BehaviorTest],
        cancel: &Cancellation,
        mut stage: impl FnMut(StageEvent),
    ) -> Result<Compiled, CompileError> {
        if prompt.trim().is_empty() || prompt.len() > 32768 || acceptance.len() > 128 {
            return Err(CompileError::Limit);
        }
        let started = Instant::now();
        let mut usage = Usage::default();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(CompileError::Cancelled),
            result = tokio::time::timeout(Duration::from_secs(self.policy.overall_seconds), self.pipeline(prompt, acceptance, &mut stage, &mut usage, started)) => result.unwrap_or(Err(CompileError::Timeout)),
        };
        if result.is_err() {
            emit(
                &mut stage,
                started,
                if matches!(result, Err(CompileError::Cancelled)) {
                    "cancelled"
                } else {
                    "failed"
                },
                0,
                &usage,
            );
        }
        result
    }
    async fn pipeline(
        &self,
        prompt: &str,
        acceptance: &[BehaviorTest],
        stage: &mut impl FnMut(StageEvent),
        usage: &mut Usage,
        started: Instant,
    ) -> Result<Compiled, CompileError> {
        emit(stage, started, "extract_intent", 0, usage);
        let intent_schema = schemars::schema_for!(Intent).to_value();
        let intent_response = self.generate(&format!("Extract the requested application intent for Needware, which produces declarative typed application IR executed by an existing runtime. Built-in local state, inputs, buttons and typed actions do not require generated executable code. Mark actual requirements unsupported if they require user-supplied or generated executable code, arbitrary HTML/SQL/WASM, or hidden permissions. When all requirements are supported, return unsupported as an empty array; never place supported requirements or explanatory 'none' entries in unsupported. Preserve every user requirement, including unsupported ones. Intent:\n{prompt}"), &intent_schema, usage).await?;
        let intent: Intent = serde_json::from_value(
            needware_package::parse_json(intent_response.as_bytes())
                .map_err(|_| CompileError::InvalidOutput)?,
        )
        .map_err(|_| CompileError::InvalidOutput)?;
        if !intent.unsupported.is_empty() {
            return Err(CompileError::Unsupported);
        }
        if intent.goal.is_empty()
            || intent.goal.len() > 8192
            || intent.requirements.len() > 128
            || intent.requirements.iter().any(|r| r.len() > 4096)
        {
            return Err(CompileError::InvalidOutput);
        }
        let normalized = serde_json::to_string(&intent).map_err(|_| CompileError::InvalidOutput)?;
        let acceptance_json =
            serde_json::to_string(acceptance).map_err(|_| CompileError::InvalidOutput)?;
        let mut feedback = String::new();
        for attempt in 0..=self.policy.max_repairs {
            emit(
                stage,
                started,
                if attempt == 0 {
                    "generate_definition"
                } else {
                    "repair_definition"
                },
                attempt,
                usage,
            );
            let representation = if self.canonical {
                "Use the supplied canonical JSON schema with nested typed expressions/actions/types/values/nodes and ordinary JSON maps. Component identifiers must be globally unique ASCII alphanumeric or underscore characters, 1-64 characters; hyphens are invalid."
            } else {
                "Use the supplied acyclic schema: expressions/actions/types/values/nodes contain nodes; integer references index the corresponding table. Maps are arrays of unique key/value entries."
            };
            let guidance = format!(
                "Produce a complete Needware application matching this intent: {normalized}. Original request: {prompt}. Independent canonical acceptance cases: {acceptance_json}. {representation} Supply fresh UUID application/revision identities, schema_version=1, runtime_features including typed_contracts_v1 and declarative_widgets_v1 for node value/disabled bindings, an initial screen and explicit scoped capabilities. Declare state_schema for exactly every state default and event_schema for exactly every action, including empty contracts for actions without inputs. Contracts use Field types with no default or derived expression; optional inputs are nullable, unknown inputs reject. No scripts, raw HTML, SQL, remote assets, executable output, recursive table cycles, or hidden effects. Use only supported components: text,heading,button,stack,row,grid,card,divider,spacer,list,text_input,numeric_input,date_input,datetime_input,textarea,badge,alert,empty_state,stat. Include deterministic behavioral tests; each case starts from default state and dispatches exactly one action. Do not add capabilities that the application does not need. {feedback}"
            );
            let canonical_schema;
            let definition_schema = if self.canonical {
                canonical_schema = self.schema.canonical_schema();
                &canonical_schema
            } else {
                self.schema.schema()
            };
            let response = self.generate(&guidance, definition_schema, usage).await?;
            emit(stage, started, "validate_definition", attempt, usage);
            let candidate = if self.canonical {
                self.schema.decode_canonical(response.as_bytes())
            } else {
                needware_package::parse_json(response.as_bytes())
                    .map_err(|_| CompileError::InvalidOutput)
                    .and_then(|wire| self.schema.decode(&wire))
            };
            match candidate.and_then(|app| self.verify_candidate(app, acceptance)) {
                Ok(package) => {
                    emit(stage, started, "package_verified", attempt, usage);
                    return Ok(Compiled {
                        package,
                        usage: usage.clone(),
                        provider: self.adapter.config.kind,
                        model: self.adapter.config.model.clone(),
                    });
                }
                Err(error) => {
                    feedback = format!(
                        "Previous candidate failed: {error}. Generate a corrected full definition; keep all user requirements."
                    );
                }
            }
        }
        Err(CompileError::Validation)
    }
    fn verify_candidate(
        &self,
        app: Application,
        acceptance: &[BehaviorTest],
    ) -> Result<Vec<u8>, CompileError> {
        needware_validation::validate(app.clone()).map_err(|diagnostic| {
            CompileError::Diagnostics {
                path: diagnostic.path.chars().take(128).collect(),
                message: diagnostic.message.chars().take(256).collect(),
            }
        })?;
        let package = needware_package::build(app, vec![], &self.key)
            .map_err(|_| CompileError::Validation)?;
        let verified = needware_package::verify(&package).map_err(|_| CompileError::Validation)?;
        let application = verified.application().application();
        let mut tests = application.tests.clone();
        tests.extend_from_slice(acceptance);
        if tests.is_empty() || tests.len() > 256 {
            return Err(CompileError::Validation);
        }
        for test in tests {
            let grants = Grants {
                application: application.id.clone(),
                revision: application.revision.clone(),
                capabilities: application.capabilities.clone(),
            };
            let mut runtime = Runtime::load(
                needware_package::verify(&package).map_err(|_| CompileError::Validation)?,
                None,
                grants,
                &[self.key.public_key()],
            )
            .map_err(|_| CompileError::Validation)?;
            let event = Event {
                action: test.action,
                values: test.event,
                now: "2026-01-01T00:00:00Z".into(),
                timezone: "UTC".into(),
            };
            let effects = runtime
                .dispatch(&event)
                .map_err(|_| CompileError::Validation)?;
            if !effects.is_empty() {
                return Err(CompileError::Validation);
            }
            let context = Context {
                state: runtime.state(),
                event: &event.values,
                item: None,
                now: &event.now,
                locale: &application.locale,
                timezone: &event.timezone,
            };
            if !boolean(
                evaluate(&test.assertion, &context, &mut Budget::new(1_000_000))
                    .map_err(|_| CompileError::Validation)?,
            )
            .map_err(|_| CompileError::Validation)?
            {
                return Err(CompileError::Validation);
            }
            runtime.view().map_err(|_| CompileError::Validation)?;
        }
        Ok(package)
    }
    async fn generate(
        &self,
        prompt: &str,
        schema: &serde_json::Value,
        usage: &mut Usage,
    ) -> Result<String, CompileError> {
        // Reserve a conservative text-byte token bound before invoking a provider. Reported
        // usage reconciles it. A remote provider's hidden tokens cannot be pre-counted here.
        let estimate =
            self.adapter
                .request_size(prompt, schema, self.policy.max_output_tokens)? as u64
                + 4096;
        let reserve = self
            .adapter
            .cost(estimate, self.policy.max_output_tokens.into())?;
        if usage
            .input_tokens
            .checked_add(usage.output_tokens)
            .and_then(|v| v.checked_add(estimate))
            .and_then(|v| v.checked_add(self.policy.max_output_tokens.into()))
            .is_none_or(|v| v > self.policy.max_tokens)
            || usage
                .configured_cost_microusd
                .checked_add(reserve)
                .is_none_or(|v| v > self.policy.max_cost_microusd)
        {
            return Err(CompileError::Limit);
        }
        usage.unknown_usage_requests += 1;
        usage.conservative_cost_microusd = usage
            .conservative_cost_microusd
            .checked_add(reserve)
            .ok_or(CompileError::Limit)?;
        let generated = self
            .adapter
            .generate(prompt, schema, self.policy.max_output_tokens)
            .await?;
        if generated.usage.input_tokens > estimate
            || generated.usage.output_tokens > u64::from(self.policy.max_output_tokens)
        {
            return Err(CompileError::Limit);
        }
        usage.unknown_usage_requests -= 1;
        usage.conservative_cost_microusd -= reserve;
        usage.input_tokens = usage
            .input_tokens
            .checked_add(generated.usage.input_tokens)
            .ok_or(CompileError::Limit)?;
        usage.output_tokens = usage
            .output_tokens
            .checked_add(generated.usage.output_tokens)
            .ok_or(CompileError::Limit)?;
        usage.configured_cost_microusd = usage
            .configured_cost_microusd
            .checked_add(
                self.adapter
                    .cost(generated.usage.input_tokens, generated.usage.output_tokens)?,
            )
            .ok_or(CompileError::Limit)?;
        if generated.usage.input_tokens > estimate
            || generated.usage.output_tokens > u64::from(self.policy.max_output_tokens)
            || usage.input_tokens + usage.output_tokens > self.policy.max_tokens
            || usage.configured_cost_microusd > self.policy.max_cost_microusd
        {
            return Err(CompileError::Limit);
        }
        generated.output
    }
}
fn emit(
    stage: &mut impl FnMut(StageEvent),
    started: Instant,
    name: &'static str,
    attempt: u8,
    usage: &Usage,
) {
    stage(StageEvent {
        stage: name,
        attempt,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        usage: usage.clone(),
    });
}

#[cfg(test)]
mod tests;
