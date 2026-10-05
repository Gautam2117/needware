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
        let signing = needware_control_plane::installation_signing_key(
            std::env::var("NEEDWARE_FIXTURE_MODE").is_ok_and(|value| value == "1"),
            std::env::var("NEEDWARE_SIGNING_SEED_HEX").ok(),
        )?;
        Some(Compiler::new(Config::from_environment()?, policy, signing)?)
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
    // Remain private: only the authenticated account worker dispatches hosted requests.
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Local compiler gateway listening on 127.0.0.1:{port}");
    axum::serve(listener, needware_control_plane::router(gateway))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
