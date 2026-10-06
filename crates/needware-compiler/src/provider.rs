//! Native HTTP adapters. Endpoint configuration belongs to the operator, never an application.
use crate::{CompileError, Usage};
use reqwest::{
    Client,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use url::Url;
use zeroize::Zeroizing;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    OpenAi,
    Anthropic,
    Gemini,
    Local,
}
impl Kind {
    pub fn endpoint(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1/responses",
            Self::Anthropic => "https://api.anthropic.com/v1/messages",
            Self::Gemini => "https://generativelanguage.googleapis.com/v1beta/interactions",
            Self::Local => "http://127.0.0.1:11434/v1/chat/completions",
        }
    }
}
pub struct Config {
    pub kind: Kind,
    pub endpoint: Url,
    pub model: String,
    pub api_key: Option<Zeroizing<String>>,
    /// Explicit self-hosted operator opt-in. Hosted deployments must leave false.
    pub allow_loopback: bool,
    pub fixture: bool,
    /// Configured rates, not a provider-reported invoice. Zero is an explicit free allowance.
    pub input_microusd_per_million: Option<u64>,
    pub output_microusd_per_million: Option<u64>,
}
impl Config {
    pub fn from_environment() -> Result<Self, CompileError> {
        let kind = match std::env::var("NEEDWARE_PROVIDER").as_deref() {
            Ok("open_ai") => Kind::OpenAi,
            Ok("anthropic") => Kind::Anthropic,
            Ok("gemini") => Kind::Gemini,
            Ok("local") => Kind::Local,
            _ => return Err(CompileError::Configuration),
        };
        let key_name = match kind {
            Kind::OpenAi => "OPENAI_API_KEY",
            Kind::Anthropic => "ANTHROPIC_API_KEY",
            Kind::Gemini => "GEMINI_API_KEY",
            Kind::Local => "NEEDWARE_LOCAL_API_KEY",
        };
        let rate = |name| {
            std::env::var(name)
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| s.parse::<u64>().map_err(|_| CompileError::Configuration))
                .transpose()
        };
        let endpoint = if kind == Kind::Local {
            std::env::var("NEEDWARE_LOCAL_ENDPOINT").unwrap_or_else(|_| kind.endpoint().into())
        } else {
            kind.endpoint().into()
        };
        Ok(Self {
            kind,
            endpoint: endpoint.parse().map_err(|_| CompileError::Configuration)?,
            model: std::env::var("NEEDWARE_MODEL").map_err(|_| CompileError::Configuration)?,
            api_key: std::env::var(key_name)
                .ok()
                .filter(|s| !s.is_empty())
                .map(Zeroizing::new),
            allow_loopback: std::env::var("NEEDWARE_ALLOW_LOOPBACK").as_deref() == Ok("1"),
            fixture: std::env::var("NEEDWARE_FIXTURE_MODE").as_deref() == Ok("1"),
            input_microusd_per_million: rate("NEEDWARE_INPUT_MICROUSD_PER_MILLION")?,
            output_microusd_per_million: rate("NEEDWARE_OUTPUT_MICROUSD_PER_MILLION")?,
        })
    }
}
pub struct Adapter {
    pub(crate) config: Config,
    client: Client,
    pub(crate) json_mode: bool,
}
pub struct Generated {
    pub output: Result<String, CompileError>,
    pub usage: Usage,
}
impl Adapter {
    pub fn new(config: Config, seconds: u64) -> Result<Self, CompileError> {
        let loopback = config
            .endpoint
            .host_str()
            .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
        let local_allowed = config.allow_loopback && loopback && config.endpoint.scheme() == "http";
        if config.endpoint.username() != ""
            || config.endpoint.password().is_some()
            || config.endpoint.query().is_some()
            || config.endpoint.fragment().is_some()
            || !(local_allowed || config.endpoint.scheme() == "https")
            || (config.kind != Kind::Local
                && config.endpoint.as_str() != config.kind.endpoint()
                && !local_allowed)
            || config.model.is_empty()
            || config.model.len() > 128
            || (config.fixture && config.kind != Kind::Local)
            || config.input_microusd_per_million.is_none()
            || config.output_microusd_per_million.is_none()
            || (config.kind != Kind::Local && config.api_key.as_ref().is_none_or(|k| k.is_empty()))
        {
            return Err(CompileError::Configuration);
        }
        let mut headers = HeaderMap::new();
        if let Some(key) = &config.api_key {
            let (name, secret) = match config.kind {
                Kind::Anthropic => ("x-api-key", key.to_string()),
                Kind::Gemini => ("x-goog-api-key", key.to_string()),
                _ => ("authorization", format!("Bearer {}", key.as_str())),
            };
            let mut header =
                HeaderValue::from_str(&secret).map_err(|_| CompileError::Configuration)?;
            header.set_sensitive(true);
            headers.insert(name, header);
        }
        if config.kind == Kind::Anthropic {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        let client = Client::builder()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .timeout(Duration::from_secs(seconds))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| CompileError::Configuration)?;
        Ok(Self {
            config,
            client,
            json_mode: false,
        })
    }
    fn request(&self, prompt: &str, schema: &Value, output_tokens: u32) -> Value {
        match self.config.kind {
            Kind::OpenAi => {
                json!({"model":self.config.model,"input":[{"role":"user","content":prompt}],"max_output_tokens":output_tokens,"store":false,"text":{"format":{"type":"json_schema","name":"needware_definition","strict":true,"schema":schema}}})
            }
            Kind::Anthropic => {
                json!({"model":self.config.model,"max_tokens":output_tokens,"messages":[{"role":"user","content":prompt}],"output_config":{"format":{"type":"json_schema","schema":schema}}})
            }
            Kind::Gemini => {
                json!({"model":self.config.model,"input":prompt,"store":false,"generation_config":{"max_output_tokens":output_tokens},"response_format":{"type":"text","mime_type":"application/json","schema":schema}})
            }
            Kind::Local => {
                if self.json_mode {
                    let mut body = json!({"model":self.config.model,"messages":[{"role":"user","content":format!("{prompt}\nJSON Schema: {schema}")}],"max_tokens":output_tokens,"stream":false,"temperature":0,"response_format":{"type":"json_object"}});
                    if self.config.model == "@cf/openai/gpt-oss-120b" {
                        body["reasoning_effort"] = json!("low");
                    }
                    return body;
                }
                json!({"model":self.config.model,"messages":[{"role":"user","content":prompt}],"max_tokens":output_tokens,"stream":false,"response_format":{"type":"json_schema","json_schema":{"name":"needware_definition","strict":true,"schema":schema}}})
            }
        }
    }
    pub fn request_size(
        &self,
        prompt: &str,
        schema: &Value,
        output_tokens: u32,
    ) -> Result<usize, CompileError> {
        let length = serde_json::to_vec(&self.request(prompt, schema, output_tokens))
            .map_err(|_| CompileError::InvalidOutput)?
            .len();
        if length > 512 * 1024 {
            return Err(CompileError::Limit);
        }
        Ok(length)
    }
    pub fn cost(&self, input: u64, output: u64) -> Result<u64, CompileError> {
        let input_rate = self
            .config
            .input_microusd_per_million
            .ok_or(CompileError::Configuration)?;
        let output_rate = self
            .config
            .output_microusd_per_million
            .ok_or(CompileError::Configuration)?;
        let total = (u128::from(input) * u128::from(input_rate))
            .checked_add(u128::from(output) * u128::from(output_rate))
            .ok_or(CompileError::Limit)?;
        u64::try_from(total.div_ceil(1_000_000)).map_err(|_| CompileError::Limit)
    }
    pub async fn generate(
        &self,
        prompt: &str,
        schema: &Value,
        output_tokens: u32,
    ) -> Result<Generated, CompileError> {
        self.request_size(prompt, schema, output_tokens)?;
        let mut response = self
            .client
            .post(self.config.endpoint.clone())
            .json(&self.request(prompt, schema, output_tokens))
            .send()
            .await
            .map_err(|_| CompileError::Transport)?;
        if !response.status().is_success() {
            return Err(CompileError::ProviderStatus(response.status().as_u16()));
        }
        let mut bytes = vec![];
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| CompileError::Transport)?
        {
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|n| n > needware_ir::MAX_IR_BYTES)
            {
                return Err(CompileError::Limit);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice::<crate::response_json::Response>(&bytes)
            .map_err(|_| CompileError::InvalidOutput)?
            .0;
        self.decode(&value)
    }
    pub fn decode(&self, value: &Value) -> Result<Generated, CompileError> {
        let (input, output_count) = match self.config.kind {
            Kind::OpenAi => (
                number(value, "/usage/input_tokens")?,
                number(value, "/usage/output_tokens")?,
            ),
            Kind::Anthropic => {
                let input = number(value, "/usage/input_tokens")?
                    .checked_add(optional_number(
                        value,
                        "/usage/cache_creation_input_tokens",
                    )?)
                    .and_then(|n| {
                        n.checked_add(
                            optional_number(value, "/usage/cache_read_input_tokens").ok()?,
                        )
                    })
                    .ok_or(CompileError::Limit)?;
                (input, number(value, "/usage/output_tokens")?)
            }
            Kind::Gemini => (
                number(value, "/usage/total_input_tokens")?,
                number(value, "/usage/total_output_tokens")?
                    .checked_add(optional_number(value, "/usage/total_thought_tokens")?)
                    .ok_or(CompileError::Limit)?,
            ),
            Kind::Local => (
                number(value, "/usage/prompt_tokens")?,
                number(value, "/usage/completion_tokens")?,
            ),
        };
        let output = match self.config.kind {
            Kind::OpenAi if value["status"] == "completed" => {
                let mut texts = vec![];
                if let Some(items) = value["output"].as_array() {
                    for item in items {
                        if item["type"] == "message"
                            && let Some(content) = item["content"].as_array()
                        {
                            for block in content {
                                if block["type"] == "refusal" {
                                    return Ok(Generated {
                                        output: Err(CompileError::Refused),
                                        usage: Usage {
                                            input_tokens: input,
                                            output_tokens: output_count,
                                            configured_cost_microusd: 0,
                                            ..Usage::default()
                                        },
                                    });
                                }
                                if block["type"] == "output_text"
                                    && let Some(text) = block["text"].as_str()
                                {
                                    texts.push(text.to_owned());
                                }
                            }
                        }
                    }
                }
                if texts.len() == 1 {
                    Ok(texts.remove(0))
                } else {
                    Err(CompileError::InvalidOutput)
                }
            }
            Kind::Anthropic if value["stop_reason"] == "end_turn" => single_text(&value["content"]),
            Kind::Gemini if value["status"] == "completed" => {
                let steps = value["steps"]
                    .as_array()
                    .ok_or(CompileError::InvalidOutput)?;
                let text: Vec<_> = steps
                    .iter()
                    .filter(|s| s["type"] == "model_output")
                    .collect();
                if text.len() != 1 {
                    Err(CompileError::InvalidOutput)
                } else {
                    single_text(&text[0]["content"])
                }
            }
            Kind::Local
                if value
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    == Some("stop") =>
            {
                if value
                    .pointer("/choices/0/message/refusal")
                    .is_some_and(|v| !v.is_null())
                    || value
                        .pointer("/choices/0/message/tool_calls")
                        .is_some_and(|v| !v.is_null())
                {
                    Err(CompileError::Refused)
                } else {
                    value
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or(CompileError::InvalidOutput)
                }
            }
            _ => Err(CompileError::Refused),
        };
        Ok(Generated {
            output,
            usage: Usage {
                input_tokens: input,
                output_tokens: output_count,
                configured_cost_microusd: 0,
                ..Usage::default()
            },
        })
    }
}
fn number(value: &Value, path: &str) -> Result<u64, CompileError> {
    value
        .pointer(path)
        .and_then(Value::as_u64)
        .ok_or(CompileError::InvalidOutput)
}
fn optional_number(value: &Value, path: &str) -> Result<u64, CompileError> {
    match value.pointer(path) {
        None => Ok(0),
        Some(value) => value.as_u64().ok_or(CompileError::InvalidOutput),
    }
}
fn single_text(content: &Value) -> Result<String, CompileError> {
    let parts = content.as_array().ok_or(CompileError::InvalidOutput)?;
    if parts.len() != 1 || parts[0]["type"] != "text" {
        return Err(CompileError::Refused);
    }
    parts[0]["text"]
        .as_str()
        .map(str::to_owned)
        .ok_or(CompileError::InvalidOutput)
}
