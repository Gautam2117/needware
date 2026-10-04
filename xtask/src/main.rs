mod contracts_fixture;
mod revision_fixture;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("revision-fixture") => {
            revision_fixture::generate()?;
            contracts_fixture::generate()?;
        }
        Some("contracts") => {
            use ts_rs::TS;
            let target = std::path::Path::new("packages/ir-types/src");
            std::fs::create_dir_all(target)?;
            let config = ts_rs::Config::default().with_out_dir(target);
            needware_ir::Application::export_all(&config)?;
            needware_ir::State::export_all(&config)?;
            needware_capabilities::Capability::export_all(&config)?;
            needware_runtime::ViewNode::export_all(&config)?;
            needware_runtime::Event::export_all(&config)?;
            needware_runtime::Effect::export_all(&config)?;
            needware_runtime::RevisionReport::export_all(&config)?;
            needware_compiler::protocol::CompileRequest::export_all(&config)?;
            needware_compiler::protocol::CompileMessage::export_all(&config)?;
            needware_compiler::protocol::ProviderResponse::export_all(&config)?;
            std::fs::create_dir_all("specs")?;
            let schema = schemars::schema_for!(needware_ir::Application);
            std::fs::write(
                "specs/application.schema.json",
                format!("{}\n", serde_json::to_string_pretty(&schema)?),
            )?;
            println!("Generated canonical IR contracts");
        }
        Some("compiler-fixture") => {
            use needware_ir::{BehaviorTest, BinaryOp, Expr, Value};
            let mut app = needware_ir::examples::typed_habit_tracker();
            app.description =
                "Authored compiler contract fixture; this is not model-generated output.".into();
            app.tests.push(BehaviorTest {
                name: "add creates a record".into(),
                action: "add".into(),
                event: std::collections::BTreeMap::from([
                    (
                        "record_id".into(),
                        Value::String("11111111-1111-4111-8111-111111111111".into()),
                    ),
                    ("name".into(), Value::String("Contract habit".into())),
                ]),
                assertion: Expr::Binary {
                    operator: BinaryOp::Eq,
                    left: Box::new(Expr::Length {
                        value: Box::new(Expr::Collection {
                            name: "habits".into(),
                        }),
                    }),
                    right: Box::new(Expr::Literal {
                        value: Value::Integer("1".into()),
                    }),
                },
            });
            let wire = needware_compiler::schema::WireSchema::new().encode(&app)?;
            std::fs::create_dir_all("artifacts")?;
            std::fs::write(
                "artifacts/compiler-fixture.json",
                serde_json::to_vec(&wire)?,
            )?;
            println!("Authored compiler fixture generated; no provider inference occurred");
        }
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
