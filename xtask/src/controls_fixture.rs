pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let app = needware_ir::examples::runtime_controls_demo();
    let key = needware_crypto::SecretKey::from_bytes([13; 32]);
    std::fs::create_dir_all("artifacts/controls")?;
    std::fs::write(
        "artifacts/controls/runtime.need",
        needware_package::build(app.clone(), vec![], &key)?,
    )?;
    let mut encrypted = app;
    encrypted.title = "Encrypted controls fixture".into();
    encrypted
        .capabilities
        .push(needware_capabilities::Capability::Storage {
            synchronized: true,
            write: true,
            collections: vec!["habits".into()],
        });
    encrypted
        .capabilities
        .push(needware_capabilities::Capability::Collaboration { write: true });
    std::fs::write(
        "artifacts/controls/encrypted-controls.need",
        needware_package::build(encrypted, vec![], &key)?,
    )?;
    let mut drafts = needware_ir::examples::runtime_controls_demo();
    drafts.title = "Cross-screen drafts fixture".into();
    let original = needware_ir::examples::habit_tracker();
    for (index, label) in [(0, "Home draft"), (1, "Details draft")] {
        let mut input = original.screens[0].root.children[1].clone();
        input.id = format!("draft_input_{index}");
        input.text = Some(needware_ir::Expr::Literal {
            value: needware_ir::Value::String(label.into()),
        });
        let mut save = original.screens[0].root.children[2].clone();
        save.id = format!("draft_save_{index}");
        save.text = Some(needware_ir::Expr::Literal {
            value: needware_ir::Value::String(format!("Save {label}")),
        });
        drafts.screens[index].root.children.extend([input, save]);
    }
    std::fs::write(
        "artifacts/controls/draft-screens.need",
        needware_package::build(drafts.clone(), vec![], &key)?,
    )?;
    drafts.title = "Ambiguous inputs fixture".into();
    let mut duplicate = original.screens[0].root.children[1].clone();
    duplicate.id = "duplicate_home_input".into();
    duplicate.text = Some(needware_ir::Expr::Literal {
        value: needware_ir::Value::String("Second home draft".into()),
    });
    drafts.screens[0].root.children.push(duplicate);
    std::fs::write(
        "artifacts/controls/ambiguous-drafts.need",
        needware_package::build(drafts, vec![], &key)?,
    )?;
    std::fs::write(
        "artifacts/controls/widgets.need",
        needware_package::build(needware_ir::widgets_example::application(), vec![], &key)?,
    )?;
    let raster = include_bytes!("../../tests/fixtures/raster.png");
    let asset = needware_package::Asset {
        media_type: "image/png".into(),
        bytes: raster.to_vec(),
    };
    let digest = needware_crypto::digest(raster)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let app = needware_ir::visuals_example::application(&digest);
    std::fs::write(
        "artifacts/controls/visuals.need",
        needware_package::build(app, vec![asset], &key)?,
    )?;
    Ok(())
}
