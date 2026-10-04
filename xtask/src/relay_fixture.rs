pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    let mut app = needware_ir::examples::typed_habit_tracker();
    app.description = "Authored private relay transport fixture; no model inference.".into();
    app.capabilities
        .push(needware_capabilities::Capability::Storage {
            synchronized: true,
            write: true,
            collections: vec!["habits".into()],
        });
    app.capabilities
        .push(needware_capabilities::Capability::Collaboration { write: true });
    let mut pixels = Vec::with_capacity(1024 * 1024 * 3);
    let mut generator = 19_u32;
    for _ in 0..1024 * 1024 * 3 {
        // Reproducible noisy image fixture; this generator never supplies cryptographic keys.
        generator ^= generator << 13;
        generator ^= generator >> 17;
        generator ^= generator << 5;
        pixels.push(generator as u8);
    }
    let image = image::RgbImage::from_raw(1024, 1024, pixels).ok_or("image fixture")?;
    let mut encoded = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image).write_to(&mut encoded, image::ImageFormat::Png)?;
    let asset = needware_package::Asset {
        media_type: "image/png".into(),
        bytes: encoded.into_inner(),
    };
    // Public transport-fixture identity; never a hosted signing key.
    let key = needware_crypto::SecretKey::from_bytes([29; 32]);
    let bytes = needware_package::build(app, vec![asset], &key)?;
    needware_package::verify(&bytes)?;
    std::fs::create_dir_all("artifacts")?;
    std::fs::write("artifacts/relay-transport-fixture.need", bytes)?;
    println!("Authored 3 MiB private PNG relay fixture generated");
    Ok(())
}
