use std::{env, fs};
fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("example") => {
            let path = args.get(2).ok_or("usage: needware example OUTPUT.need")?;
            let key = needware_crypto::SecretKey::random()?;
            let package =
                needware_package::build(needware_ir::examples::habit_tracker(), vec![], &key)?;
            fs::write(path, package)?;
            println!(
                "Authored example; fresh local signer {}",
                hex::encode(key.public_key())
            );
        }
        Some("verify") | Some("inspect") => {
            let path = args
                .get(2)
                .ok_or("usage: needware verify|inspect FILE.need")?;
            if fs::metadata(path)?.len() > needware_package::MAX_BYTES as u64 {
                return Err("package too large".into());
            }
            let package = needware_package::verify(&fs::read(path)?)?;
            println!("Verified digest {}", package.digest());
            for signer in package.signers() {
                println!("Signer {} (trust must be reviewed)", hex::encode(signer));
            }
            if args[1] == "inspect" {
                println!(
                    "{}",
                    serde_json::to_string_pretty(package.application().application())?
                );
            }
        }
        _ => return Err("usage: needware example|verify|inspect FILE.need".into()),
    }
    Ok(())
}
