use needware_ir::{Action, DataType, Expr, Field, Value};
use std::collections::BTreeMap;
pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::examples::typed_habit_tracker();
    let field = Field {
        data_type: DataType::List {
            item: Box::new(DataType::Integer),
        },
        default: None,
        derived: None,
        minimum: None,
        maximum: None,
        max_length: None,
    };
    app.state.insert("numbers".into(), Value::List(vec![]));
    app.state_schema.insert("numbers".into(), field.clone());
    app.actions.insert(
        "set_numbers".into(),
        Action::Set {
            key: "numbers".into(),
            value: Expr::Event {
                key: "numbers".into(),
            },
        },
    );
    app.event_schema.insert(
        "set_numbers".into(),
        BTreeMap::from([("numbers".into(), field)]),
    );
    // Disclosed deterministic signing identity, exclusively for test artifacts.
    let key = needware_crypto::SecretKey::from_bytes([23; 32]);
    std::fs::create_dir_all("artifacts/revisions")?;
    std::fs::write(
        "artifacts/revisions/typed.need",
        needware_package::build(app, vec![], &key)?,
    )?;
    Ok(())
}
