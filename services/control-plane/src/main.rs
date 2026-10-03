use needware_compiler::{Compiler, Policy, provider::Config};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let compiler = if std::env::var("NEEDWARE_PROVIDER").is_ok_and(|value| !value.is_empty()) {
        let policy = Policy {
            max_cost_microusd: std::env::var("NEEDWARE_COST_CEILING_MICROUSD")
                .ok()
                .map(|v| v.parse())
                .transpose()?
                .unwrap_or(500_000),
            ..Policy::default()
        };
        Some(Compiler::new(
            Config::from_environment()?,
            policy,
            needware_crypto::SecretKey::random()?,
        )?)
    } else {
        None
    };
    let gateway =
        needware_control_plane::Gateway::new(compiler, std::env::var("NEEDWARE_CONTROL_TOKEN")?)?;
    let port: u16 = std::env::var("NEEDWARE_CONTROL_PORT")
        .ok()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(3001);
    // Cloud exposure waits for account authorization, durable quotas and jobs.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Local compiler gateway listening on 127.0.0.1:{port}");
    axum::serve(listener, needware_control_plane::router(gateway))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
