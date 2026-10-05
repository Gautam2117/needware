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
    Ok(())
}
