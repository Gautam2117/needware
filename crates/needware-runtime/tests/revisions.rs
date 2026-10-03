use needware_capabilities::Grants;
use needware_crypto::SecretKey;
use needware_ir::*;
use needware_package::{VerifiedPackage, build, verify};
use needware_runtime::{Event, Runtime, RuntimeError};
use needware_storage::{SqliteStore, Store};
use std::collections::BTreeMap;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
fn field() -> Field {
    Field {
        data_type: DataType::Integer,
        default: Some(Value::Integer("0".into())),
        minimum: None,
        maximum: None,
        max_length: None,
        derived: None,
    }
}
fn grants(app: &Application) -> Grants {
    Grants {
        application: app.id.clone(),
        revision: app.revision.clone(),
        capabilities: app.capabilities.clone(),
    }
}
fn package(app: Application) -> Result<VerifiedPackage> {
    Ok(verify(&build(
        app,
        vec![],
        &SecretKey::from_bytes([19; 32]),
    )?)?)
}
fn source() -> Result<(Runtime, Application, [u8; 32])> {
    let mut app = examples::habit_tracker();
    app.collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .insert("score".into(), field());
    let p = package(app.clone())?;
    let key = SecretKey::from_bytes([19; 32]).public_key();
    let mut r = Runtime::load(p, None, grants(&app), &[key])?;
    r.dispatch(&Event {
        action: "add".into(),
        values: BTreeMap::from([
            (
                "record_id".into(),
                Value::String("937f0e0c-a3af-40b8-9f30-ab741e85c13f".into()),
            ),
            ("name".into(), Value::String("Read".into())),
        ]),
        now: "2026-10-04T00:00:00Z".into(),
        timezone: "UTC".into(),
    })?;
    let mut target = app.clone();
    target.revision = "757b187f-5d19-4a77-a223-228bed58bb77".into();
    target.parent = Some(package(app)?.digest());
    Ok((r, target, key))
}
fn migration(target: &mut Application, source: &Runtime, operations: Vec<MigrationOp>) {
    target.migrations = vec![Migration {
        from_revision: source.application().revision.clone(),
        operations,
    }];
}
#[test]
fn rename_preview_commits_with_recoverable_snapshot_and_reopens() -> Result {
    let (runtime, mut target, key) = source()?;
    let fields = &mut target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields;
    let score = fields.remove("score").ok_or("field")?;
    fields.insert("priority".into(), score);
    fields.insert("count".into(), field());
    migration(
        &mut target,
        &runtime,
        vec![
            MigrationOp::RenameField {
                collection: "habits".into(),
                from: "score".into(),
                to: "priority".into(),
            },
            MigrationOp::AddField {
                collection: "habits".into(),
                field: "count".into(),
                default: Value::Integer("3".into()),
            },
        ],
    );
    let before = runtime.state().clone();
    let preview = runtime.preview_revision(package(target.clone())?, &[key])?;
    assert!(!preview.report().migration.requires_confirmation);
    assert_eq!(preview.report().migration.impacts[0].affected_records, 1);
    let review = preview.report().review_digest.clone();
    let upgraded = preview.approve(&runtime, &review, grants(&target), false)?;
    assert_eq!(runtime.state(), &before);
    let record = upgraded.state().collections["habits"]
        .values()
        .next()
        .ok_or("record")?;
    assert!(!record.contains_key("score"));
    assert_eq!(record["count"], Value::Integer("3".into()));
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("data.sqlite");
    {
        let mut store = SqliteStore::open(&path)?;
        store.commit(&target.id, 0, &before)?;
        assert!(store.commit(&target.id, 1, upgraded.state()).is_err());
        assert_eq!(
            store.commit_revision(&target.id, 1, &before, upgraded.state())?,
            2
        );
    }
    let store = SqliteStore::open(path)?;
    assert_eq!(store.snapshot(&target.id, 1)?, Some(before));
    let (_, state) = store.load(&target.id)?.ok_or("state")?;
    assert!(
        Runtime::load(
            package(target.clone())?,
            Some(state),
            grants(&target),
            &[key]
        )?
        .view()
        .is_ok()
    );
    Ok(())
}
#[test]
fn destructive_consent_stale_reviews_parent_and_identity_fail_closed() -> Result {
    let (mut runtime, mut target, key) = source()?;
    target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .remove("score");
    migration(
        &mut target,
        &runtime,
        vec![MigrationOp::RemoveField {
            collection: "habits".into(),
            field: "score".into(),
        }],
    );
    let preview = runtime.preview_revision(package(target.clone())?, &[key])?;
    let review = preview.report().review_digest.clone();
    assert!(matches!(
        preview.approve(&runtime, &review, grants(&target), false),
        Err(RuntimeError::Permission)
    ));
    let preview = runtime.preview_revision(package(target.clone())?, &[key])?;
    let mut state = runtime.state().clone();
    state
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .clear();
    runtime.restore(state)?;
    assert!(
        preview
            .approve(&runtime, &review, grants(&target), true)
            .is_err()
    );
    let preview = runtime.preview_revision(package(target.clone())?, &[key])?;
    assert!(
        preview
            .approve(&runtime, "incorrect-review", grants(&target), true)
            .is_err()
    );
    target.parent = None;
    assert!(runtime.preview_revision(package(target)?, &[key]).is_err());
    Ok(())
}
#[test]
fn transformations_are_checked_before_activation_and_cannot_use_ambient_context() -> Result {
    let (runtime, mut target, key) = source()?;
    let transform = |value| MigrationOp::Transform {
        collection: "habits".into(),
        field: "score".into(),
        value,
    };
    migration(
        &mut target,
        &runtime,
        vec![transform(Expr::Binary {
            operator: BinaryOp::Add,
            left: Box::new(Expr::Item {
                field: "score".into(),
            }),
            right: Box::new(Expr::Literal {
                value: Value::Integer("2".into()),
            }),
        })],
    );
    let preview = runtime.preview_revision(package(target.clone())?, &[key])?;
    let review = preview.report().review_digest.clone();
    let next = preview.approve(&runtime, &review, grants(&target), true)?;
    assert_eq!(
        next.state().collections["habits"]
            .values()
            .next()
            .ok_or("record")?["score"],
        Value::Integer("2".into())
    );
    target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .get_mut("score")
        .ok_or("field")?
        .maximum = Some("1".into());
    assert!(
        runtime
            .preview_revision(package(target.clone())?, &[key])
            .is_err()
    );
    migration(
        &mut target,
        &runtime,
        vec![transform(Expr::Event {
            key: "secret".into(),
        })],
    );
    assert!(package(target).is_err());
    Ok(())
}
#[test]
fn migration_work_is_bounded_across_operations() -> Result {
    let (mut runtime, mut target, key) = source()?;
    let mut state = runtime.state().clone();
    let row = state.collections["habits"]
        .values()
        .next()
        .ok_or("record")?
        .clone();
    let rows = state.collections.get_mut("habits").ok_or("collection")?;
    rows.clear();
    for i in 1..=5000 {
        rows.insert(format!("00000000-0000-4000-8000-{i:012x}"), row.clone());
    }
    runtime.restore(state.clone())?;
    migration(
        &mut target,
        &runtime,
        vec![
            MigrationOp::Transform {
                collection: "habits".into(),
                field: "score".into(),
                value: Expr::Literal {
                    value: Value::Integer("1".into())
                }
            };
            101
        ],
    );
    assert!(matches!(
        runtime.preview_revision(package(target)?, &[key]),
        Err(RuntimeError::Limit)
    ));
    assert_eq!(runtime.state(), &state);
    Ok(())
}
#[test]
fn expanding_defaults_fail_without_changing_source() -> Result {
    let (mut runtime, mut target, key) = source()?;
    let mut state = runtime.state().clone();
    let row = state.collections["habits"]
        .values()
        .next()
        .ok_or("record")?
        .clone();
    let rows = state.collections.get_mut("habits").ok_or("collection")?;
    rows.clear();
    for i in 1..=300 {
        rows.insert(format!("00000000-0000-4000-8000-{i:012x}"), row.clone());
    }
    runtime.restore(state.clone())?;
    let default = Value::String("x".repeat(65536));
    target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .insert(
            "note".into(),
            Field {
                data_type: DataType::String,
                default: Some(default.clone()),
                ..field()
            },
        );
    migration(
        &mut target,
        &runtime,
        vec![MigrationOp::AddField {
            collection: "habits".into(),
            field: "note".into(),
            default,
        }],
    );
    assert!(matches!(
        runtime.preview_revision(package(target)?, &[key]),
        Err(RuntimeError::Limit)
    ));
    assert_eq!(runtime.state(), &state);
    Ok(())
}
