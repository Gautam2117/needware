fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
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
