//! Local compiler gateway. Account/cloud domains and durable jobs are not enabled yet.
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use needware_compiler::{
    Cancellation, Compiler,
    protocol::{CompileMessage, CompileRequest, ProviderResponse},
};
use std::{convert::Infallible, sync::Arc};
use subtle::ConstantTimeEq;
use tokio::sync::{Semaphore, mpsc};
use tokio_stream::{StreamExt, wrappers::ReceiverStream};
use zeroize::Zeroizing;

pub struct Gateway {
    compiler: Option<Arc<Compiler>>,
    token: Zeroizing<String>,
    permits: Arc<Semaphore>,
}
impl Gateway {
    pub fn new(compiler: Option<Compiler>, token: String) -> Result<Self, &'static str> {
        if token.len() < 32
            || token.len() > 128
            || !token.bytes().all(|b| b.is_ascii_alphanumeric())
        {
            return Err("internal token must be 32–128 alphanumeric characters");
        }
        Ok(Self {
            compiler: compiler.map(Arc::new),
            token: Zeroizing::new(token),
            permits: Arc::new(Semaphore::new(2)),
        })
    }
    fn authorize(&self, headers: &HeaderMap) -> Result<(), StatusCode> {
        let supplied = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if supplied.as_bytes().ct_eq(self.token.as_bytes()).into() {
            Ok(())
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}
pub fn router(gateway: Gateway) -> Router {
    Router::new()
        .route("/health/live", get(|| async { "ok" }))
        .route("/api/providers", get(providers))
        .route("/api/compile-jobs", post(compile))
        .layer(DefaultBodyLimit::max(40 * 1024))
        .with_state(Arc::new(gateway))
}
async fn providers(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
) -> Result<Json<ProviderResponse>, StatusCode> {
    state.authorize(&headers)?;
    Ok(Json(ProviderResponse {
        provider: state.compiler.as_ref().map(|c| c.provider_info()),
    }))
}
async fn compile(
    State(state): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<CompileRequest>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    state.authorize(&headers)?;
    if request.prompt.trim().is_empty() || request.prompt.len() > 32768 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let compiler = state
        .compiler
        .clone()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let permit = state
        .permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let (sender, receiver) = mpsc::channel(16);
    tokio::spawn(async move {
        let _permit = permit;
        let cancel = Cancellation::new();
        let result = tokio::select! {
            _ = sender.closed() => { cancel.cancel(); return; },
            result = compiler.compile(&request.prompt, &[], &cancel, |event| { let _ = sender.try_send(CompileMessage::Stage { event }); }) => result,
        };
        let result = match result {
            Ok(compiled) => CompileMessage::Package {
                package_base64: STANDARD.encode(compiled.package),
                usage: compiled.usage,
            },
            Err(error) => CompileMessage::failure(&error),
        };
        let _ = sender.send(result).await;
    });
    let events = ReceiverStream::new(receiver).map(|message| {
        let json = serde_json::to_string(&message).unwrap_or_else(|_| "{\"kind\":\"error\",\"code\":\"serialization\",\"message\":\"Creation could not finish.\"}".into());
        Ok(Event::default().data(json))
    });
    Ok(Sse::new(events).keep_alive(KeepAlive::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    #[tokio::test]
    async fn private_gateway_rejects_forged_identity_and_unknown_requests()
    -> Result<(), Box<dyn std::error::Error>> {
        let token = "0123456789abcdef0123456789abcdef";
        let app = router(Gateway::new(None, token.into())?);
        let forged = Request::builder()
            .uri("/api/providers")
            .header("x-user-id", "owner")
            .body(Body::empty())?;
        assert_eq!(
            app.clone().oneshot(forged).await?.status(),
            StatusCode::UNAUTHORIZED
        );
        let authenticated = Request::builder()
            .uri("/api/providers")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())?;
        assert_eq!(
            app.clone().oneshot(authenticated).await?.status(),
            StatusCode::OK
        );
        let unknown = Request::builder()
            .method("POST")
            .uri("/api/compile-jobs")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(
                "{\"prompt\":\"habits\",\"provider\":\"attacker\"}",
            ))?;
        assert_eq!(
            app.clone().oneshot(unknown).await?.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let disabled = Request::builder()
            .method("POST")
            .uri("/api/compile-jobs")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from("{\"prompt\":\"habits\"}"))?;
        assert_eq!(
            app.oneshot(disabled).await?.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        Ok(())
    }
    #[tokio::test]
    async fn concurrent_jobs_are_bounded_and_disconnect_releases_capacity()
    -> Result<(), Box<dyn std::error::Error>> {
        use needware_compiler::{
            Policy,
            provider::{Config, Kind},
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let compiler = Compiler::new(
            Config {
                kind: Kind::Local,
                endpoint: format!("http://{}/infer", listener.local_addr()?).parse()?,
                model: "contract-fixture".into(),
                api_key: None,
                allow_loopback: true,
                fixture: true,
                input_microusd_per_million: Some(0),
                output_microusd_per_million: Some(0),
            },
            Policy::default(),
            needware_crypto::SecretKey::random()?,
        )?;
        let token = "0123456789abcdef0123456789abcdef";
        let app = router(Gateway::new(Some(compiler), token.into())?);
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/api/compile-jobs")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from("{\"prompt\":\"Track habits\"}"))
        };
        let first = app.clone().oneshot(request()?).await?;
        let second = app.clone().oneshot(request()?).await?;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(second.status(), StatusCode::OK);
        assert_eq!(
            app.clone().oneshot(request()?).await?.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        drop(first);
        drop(second);
        let status = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let status = app.clone().oneshot(request()?).await?.status();
                if status != StatusCode::TOO_MANY_REQUESTS {
                    return Ok::<_, Box<dyn std::error::Error>>(status);
                }
                tokio::task::yield_now().await;
            }
        })
        .await??;
        assert_eq!(status, StatusCode::OK);
        drop(listener);
        Ok(())
    }
}
