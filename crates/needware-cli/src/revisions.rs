use needware_capabilities::Grants;
use needware_package::VerifiedPackage;
use needware_runtime::Runtime;
use needware_storage::{SqliteStore, Store};
use std::{fs, path::Path};
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn rollback(args: &[String]) -> Result {
    if args.len() != 10
        || args[3] != "--trust"
        || args[5] != "--snapshot"
        || args[7] != "--expected-generation"
        || args[9] != "--accept-rollback"
    {
        return Err("usage: needware revision-rollback CURRENT.need PREVIOUS.need DATABASE --trust SIGNER_HEX[,SIGNER_HEX] --snapshot GENERATION --expected-generation GENERATION --accept-rollback".into());
    }
    if !Path::new(&args[2]).is_file() {
        return Err("database does not exist".into());
    }
    let current = package(&args[0])?;
    let previous = package(&args[1])?;
    if current.application().application().id != previous.application().application().id {
        return Err("snapshot package belongs to another application".into());
    }
    let keys = trusted(&args[4])?;
    let mut store = SqliteStore::open(&args[2])?;
    let (generation, state) = store
        .load(&current.application().application().id)?
        .ok_or("state")?;
    if generation != args[8].parse::<u64>()? {
        return Err("state changed since rollback was reviewed".into());
    }
    let snapshot = store
        .snapshot(&current.application().application().id, args[6].parse()?)?
        .ok_or("snapshot does not exist")?;
    let source_grants = grants(&current);
    let previous_grants = grants(&previous);
    let current = Runtime::load(current, Some(state), source_grants, &keys)?;
    let restored = Runtime::load(previous, Some(snapshot), previous_grants, &keys)?;
    let next = store.commit_revision(
        &current.application().id,
        generation,
        current.state(),
        restored.state(),
    )?;
    println!(
        "Restored revision {}; generation {next}; state before rollback retained as snapshot {generation}.",
        restored.application().revision
    );
    Ok(())
}

fn package(path: &str) -> Result<VerifiedPackage> {
    if fs::metadata(path)?.len() > needware_package::MAX_BYTES as u64 {
        return Err("package too large".into());
    }
    Ok(needware_package::verify(&fs::read(path)?)?)
}
fn trusted(value: &str) -> Result<Vec<[u8; 32]>> {
    let keys: Vec<[u8; 32]> = value
        .split(',')
        .map(|key| {
            let bytes = hex::decode(key)?;
            bytes
                .try_into()
                .map_err(|_| "trust keys must contain exactly 32 bytes".into())
        })
        .collect::<Result<_>>()?;
    if keys.is_empty() || keys.len() > 8 {
        return Err("between one and eight signer keys are required".into());
    }
    Ok(keys)
}
fn grants(package: &VerifiedPackage) -> Grants {
    let app = package.application().application();
    Grants {
        application: app.id.clone(),
        revision: app.revision.clone(),
        capabilities: vec![],
    }
}
pub fn initialize(args: &[String]) -> Result {
    if args.len() != 4 || args[2] != "--trust" {
        return Err(
            "usage: needware state-init PACKAGE.need DATABASE --trust SIGNER_HEX[,SIGNER_HEX]"
                .into(),
        );
    }
    let package = package(&args[0])?;
    let grants = grants(&package);
    let runtime = Runtime::load(package, None, grants, &trusted(&args[3])?)?;
    let mut store = SqliteStore::open(&args[1])?;
    store.commit(&runtime.application().id, 0, runtime.state())?;
    println!("Initialized empty local state; browser permissions are reviewed separately.");
    Ok(())
}
pub fn revision(args: &[String], apply: bool) -> Result {
    if args.len() < 5
        || args[3] != "--trust"
        || (!apply && args.len() != 5)
        || (apply
            && (args.len() < 7
                || args[5] != "--review"
                || args[7..].iter().any(|a| {
                    !["--accept-destructive", "--accept-permissions"].contains(&a.as_str())
                })))
    {
        return Err("usage: needware revision-preview SOURCE.need TARGET.need DATABASE --trust SIGNER_HEX[,SIGNER_HEX]; revision-apply additionally requires --review DIGEST [--accept-destructive] [--accept-permissions]".into());
    }
    if !Path::new(&args[2]).is_file() {
        return Err("database does not exist; initialize or select existing state".into());
    }
    let keys = trusted(&args[4])?;
    let source = package(&args[0])?;
    let target = package(&args[1])?;
    let mut store = SqliteStore::open(&args[2])?;
    let source_grants = grants(&source);
    let target_grants = grants(&target);
    let (generation, state) = store
        .load(&source_grants.application)?
        .ok_or("application has no stored state")?;
    let runtime = Runtime::load(source, Some(state), source_grants, &keys)?;
    let preview = runtime.preview_revision(target, &keys)?;
    if !apply {
        println!("{}", serde_json::to_string_pretty(preview.report())?);
        return Ok(());
    }
    if !preview.report().permissions_added.is_empty()
        && !args[7..].iter().any(|a| a == "--accept-permissions")
    {
        return Err(
            "new permissions require explicit review; pass --accept-permissions after reviewing"
                .into(),
        );
    }
    let upgraded = preview.approve(
        &runtime,
        &args[6],
        target_grants,
        args[7..].iter().any(|a| a == "--accept-destructive"),
    )?;
    let next = store.commit_revision(
        &runtime.application().id,
        generation,
        runtime.state(),
        upgraded.state(),
    )?;
    println!(
        "Activated revision {}; generation {next}; recoverable snapshot generation {generation}.",
        upgraded.application().revision
    );
    Ok(())
}
