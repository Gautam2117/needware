use needware_compiler::{Cancellation, Compiler, Policy, provider::Config};
use std::{fs, io::Write};
pub async fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    if args.len() != 2 && args.len() != 4 {
        return Err(
            "usage: needware compile PROMPT.txt OUTPUT.need [--acceptance CASES.json]".into(),
        );
    }
    if fs::exists(&args[1])? {
        return Err("output already exists; select a new package path".into());
    }
    if fs::metadata(&args[0])?.len() > 32768 {
        return Err("prompt exceeds 32 KiB".into());
    }
    let prompt = fs::read_to_string(&args[0])?;
    let acceptance = if args.len() == 4 {
        if args[2] != "--acceptance" || fs::metadata(&args[3])?.len() > 2 * 1024 * 1024 {
            return Err("invalid acceptance file".into());
        }
        needware_package::parse_json(&fs::read(&args[3])?)?
    } else {
        vec![]
    };
    let config = Config::from_environment()?;
    let policy = Policy {
        max_cost_microusd: std::env::var("NEEDWARE_COST_CEILING_MICROUSD")
            .ok()
            .map(|v| v.parse())
            .transpose()?
            .unwrap_or(500_000),
        ..Policy::default()
    };
    let compiler = Compiler::new(config, policy, needware_crypto::SecretKey::random()?)?;
    let cancel = Cancellation::new();
    let signal = cancel.clone();
    let task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal.cancel();
        }
    });
    let result = compiler
        .compile(&prompt, &acceptance, &cancel, |stage| {
            if let Ok(json) = serde_json::to_string(&stage) {
                eprintln!("{json}");
            }
        })
        .await;
    task.abort();
    let compiled = result?;
    // Never overwrite a package/revision implicitly.
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&args[1])?;
    output.write_all(&compiled.package)?;
    output.sync_all()?;
    println!(
        "Verified generated package {}",
        needware_package::verify(&compiled.package)?.digest()
    );
    println!("{}", serde_json::to_string(&compiled.usage)?);
    Ok(())
}
