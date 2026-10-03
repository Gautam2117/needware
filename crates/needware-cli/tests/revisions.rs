use needware_crypto::SecretKey;
use needware_ir::{DataType, Field, Migration, MigrationOp, Value, examples::habit_tracker};
use needware_storage::{SqliteStore, Store};
use std::{fs, process::Command};
#[test]
fn cli_preview_then_reviewed_activation_preserves_snapshot()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let source = habit_tracker();
    let signer = SecretKey::from_bytes([23; 32]);
    let first = needware_package::build(source.clone(), vec![], &signer)?;
    let mut target = source.clone();
    target.parent = Some(needware_package::verify(&first)?.digest());
    target.revision = "ab2d402a-94df-4d30-b228-cb606772601d".into();
    target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .insert(
            "priority".into(),
            Field {
                data_type: DataType::Integer,
                default: Some(Value::Integer("0".into())),
                max_length: None,
                minimum: None,
                maximum: None,
                derived: None,
            },
        );
    target.migrations = vec![Migration {
        from_revision: source.revision.clone(),
        operations: vec![MigrationOp::AddField {
            collection: "habits".into(),
            field: "priority".into(),
            default: Value::Integer("0".into()),
        }],
    }];
    let from = directory.path().join("from.need");
    let to = directory.path().join("to.need");
    let db = directory.path().join("data.sqlite");
    fs::write(&from, first)?;
    fs::write(
        &to,
        needware_package::build(target.clone(), vec![], &signer)?,
    )?;
    let from = from.to_str().ok_or("path")?;
    let to = to.to_str().ok_or("path")?;
    let db = db.to_str().ok_or("path")?;
    let key = hex::encode(signer.public_key());
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_needware"))
            .args(args)
            .output()
    };
    assert!(
        run(&["state-init", from, db, "--trust", &key])?
            .status
            .success()
    );
    let preview = run(&["revision-preview", from, to, db, "--trust", &key])?;
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&preview.stdout)?;
    assert!(
        !run(&[
            "revision-apply",
            from,
            to,
            db,
            "--trust",
            &key,
            "--review",
            "wrong"
        ])?
        .status
        .success()
    );
    let digest = report["review_digest"].as_str().ok_or("digest")?;
    assert!(
        run(&[
            "revision-apply",
            from,
            to,
            db,
            "--trust",
            &key,
            "--review",
            digest
        ])?
        .status
        .success()
    );
    let store = SqliteStore::open(db)?;
    assert_eq!(
        store.load(&source.id)?.ok_or("state")?.1.revision,
        target.revision
    );
    assert_eq!(
        store.snapshot(&source.id, 1)?.ok_or("snapshot")?.revision,
        source.revision
    );
    assert!(
        !run(&[
            "revision-rollback",
            to,
            from,
            db,
            "--trust",
            &key,
            "--snapshot",
            "1",
            "--expected-generation",
            "1",
            "--accept-rollback"
        ])?
        .status
        .success()
    );
    assert!(
        run(&[
            "revision-rollback",
            to,
            from,
            db,
            "--trust",
            &key,
            "--snapshot",
            "1",
            "--expected-generation",
            "2",
            "--accept-rollback"
        ])?
        .status
        .success()
    );
    assert_eq!(
        store.load(&source.id)?.ok_or("restored")?.1.revision,
        source.revision
    );
    assert_eq!(
        store
            .snapshot(&source.id, 2)?
            .ok_or("rollback backup")?
            .revision,
        target.revision
    );
    Ok(())
}
