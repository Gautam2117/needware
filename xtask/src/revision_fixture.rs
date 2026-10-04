use needware_ir::{DataType, Field, Migration, MigrationOp, Value};
pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    // Public fixture-only signing key. Never use for production or local-development identity.
    let key = needware_crypto::SecretKey::from_bytes([19; 32]);
    let mut source = needware_ir::examples::habit_tracker();
    source
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .insert(
            "score".into(),
            Field {
                data_type: DataType::Integer,
                default: Some(Value::Integer("0".into())),
                minimum: None,
                maximum: None,
                max_length: None,
                derived: None,
            },
        );
    let bytes = needware_package::build(source.clone(), vec![], &key)?;
    let digest = needware_package::verify(&bytes)?.digest();
    let mut target = source.clone();
    target.title = "Habit tracker revised".into();
    target.revision = "757b187f-5d19-4a77-a223-228bed58bb77".into();
    target.parent = Some(digest);
    let field = Field {
        data_type: DataType::String,
        default: Some(Value::String("Reviewed".into())),
        minimum: None,
        maximum: None,
        max_length: Some(120),
        derived: None,
    };
    let fields = &mut target
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields;
    fields.remove("score");
    fields.insert("note".into(), field.clone());
    target.migrations = vec![Migration {
        from_revision: source.revision,
        operations: vec![
            MigrationOp::RemoveField {
                collection: "habits".into(),
                field: "score".into(),
            },
            MigrationOp::AddField {
                collection: "habits".into(),
                field: "note".into(),
                default: Value::String("Reviewed".into()),
            },
        ],
    }];
    std::fs::create_dir_all("artifacts/revisions")?;
    std::fs::write("artifacts/revisions/source.need", bytes)?;
    std::fs::write(
        "artifacts/revisions/target.need",
        needware_package::build(target.clone(), vec![], &key)?,
    )?;
    target.parent = Some("00".repeat(32));
    std::fs::write(
        "artifacts/revisions/wrong-parent.need",
        needware_package::build(target, vec![], &key)?,
    )?;
    println!("Signed authored revision fixtures generated; no inference occurred");
    Ok(())
}
