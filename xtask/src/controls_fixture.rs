pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let app = needware_ir::examples::runtime_controls_demo();
    let key = needware_crypto::SecretKey::from_bytes([13; 32]);
    std::fs::create_dir_all("artifacts/controls")?;
    std::fs::write(
        "artifacts/controls/runtime.need",
        needware_package::build(app, vec![], &key)?,
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
