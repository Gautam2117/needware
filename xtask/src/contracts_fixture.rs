use needware_ir::{Action, DataType, Expr, Field, Value};
use std::collections::BTreeMap;
pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::examples::typed_habit_tracker();
    app.runtime_features.push("exact_arithmetic_v1".into());
    let amount = Field {
        data_type: DataType::Decimal { scale: 2 },
        default: None,
        derived: None,
        minimum: None,
        maximum: None,
        max_length: None,
    };
    app.state.insert(
        "balance".into(),
        Value::Decimal(needware_ir::Decimal {
            coefficient: "125".into(),
            scale: 2,
        }),
    );
    app.state_schema.insert("balance".into(), amount.clone());
    for (name, operator) in [
        ("add_amount", needware_ir::BinaryOp::Add),
        ("divide_amount", needware_ir::BinaryOp::Divide),
    ] {
        app.actions.insert(
            name.into(),
            Action::Set {
                key: "balance".into(),
                value: Expr::Binary {
                    operator,
                    left: Box::new(Expr::State {
                        key: "balance".into(),
                    }),
                    right: Box::new(Expr::Event {
                        key: "amount".into(),
                    }),
                },
            },
        );
        app.event_schema.insert(
            name.into(),
            BTreeMap::from([("amount".into(), amount.clone())]),
        );
    }
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
