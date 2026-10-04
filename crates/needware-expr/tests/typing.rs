use needware_expr::typing::{Hint, check};
use needware_ir::*;
#[test]
fn nullable_iteration_coalesces_to_a_nonnullable_typed_default()
-> Result<(), Box<dyn std::error::Error>> {
    let mut app = examples::habit_tracker();
    let name = app
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .fields
        .get_mut("name")
        .ok_or("field")?;
    name.data_type = DataType::Optional {
        inner: Box::new(DataType::String),
    };
    let expression = Expr::Map {
        collection: Box::new(Expr::Collection {
            name: "habits".into(),
        }),
        value: Box::new(Expr::Coalesce {
            values: vec![
                Expr::Item {
                    field: "name".into(),
                },
                Expr::Literal {
                    value: Value::String("Unnamed".into()),
                },
            ],
        }),
    };
    assert_eq!(
        check(&expression, &app, None)?,
        Hint::List(Box::new(Hint::String))
    );
    Ok(())
}
