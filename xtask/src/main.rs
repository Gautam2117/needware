fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("contracts") => {
            use ts_rs::TS;
            let target = std::path::Path::new("packages/ir-types/src");
            std::fs::create_dir_all(target)?;
            let config = ts_rs::Config::default().with_out_dir(target);
            needware_ir::Application::export_all(&config)?;
            needware_ir::State::export_all(&config)?;
            needware_capabilities::Capability::export_all(&config)?;
            needware_runtime::ViewNode::export_all(&config)?;
            needware_runtime::Event::export_all(&config)?;
            needware_runtime::Effect::export_all(&config)?;
            std::fs::create_dir_all("specs")?;
            let schema = schemars::schema_for!(needware_ir::Application);
            std::fs::write(
                "specs/application.schema.json",
                format!("{}\n", serde_json::to_string_pretty(&schema)?),
            )?;
            println!("Generated canonical IR contracts");
        }
        Some("workspace") => {
            let status = std::process::Command::new("cargo")
                .args(["metadata", "--no-deps", "--format-version", "1"])
                .status()?;
            if !status.success() {
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("usage: cargo run -p xtask -- workspace");
            std::process::exit(2);
        }
    }
    Ok(())
}
