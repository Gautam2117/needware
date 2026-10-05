use needware_vault::{DeviceKeys, GenerationContext, GenerationEnvelope, seal_generation_result};
fn context() -> GenerationContext {
    GenerationContext {
        version: 1,
        account: "d21fb619-accc-4c41-8c7e-94b232a05255".into(),
        job: "a88f9c02-9d55-4f93-bb9a-12ef12292b95".into(),
    }
}
#[test]
fn generation_results_bind_account_job_recipient_and_exact_ciphertext_without_root_escrow()
-> Result<(), Box<dyn std::error::Error>> {
    let recipient = DeviceKeys::create()?;
    let other = DeviceKeys::create()?;
    let payload = vec![42; 3 * 1024 * 1024];
    let envelope = seal_generation_result(context(), recipient.public()?, &payload)?;
    assert_eq!(
        recipient
            .open_generation_result(&envelope, &context())?
            .as_slice(),
        payload
    );
    assert!(other.open_generation_result(&envelope, &context()).is_err());
    let mut wrong = context();
    wrong.job = "6e3a7f3e-49a7-435a-b958-f1ec36623c1f".into();
    assert!(recipient.open_generation_result(&envelope, &wrong).is_err());
    wrong = context();
    wrong.account = "edac7e7a-6e20-4c63-aa3e-953e59bd0875".into();
    assert!(recipient.open_generation_result(&envelope, &wrong).is_err());
    for mutation in 0..5 {
        let mut changed = GenerationEnvelope {
            metadata: envelope.metadata.clone(),
            ciphertext: envelope.ciphertext.clone(),
        };
        match mutation {
            0 => changed.metadata.context.account = wrong.account.clone(),
            1 => changed.metadata.digest[0] ^= 1,
            2 => changed.metadata.encapsulated[0] ^= 1,
            3 => changed.ciphertext[0] ^= 1,
            _ => changed.metadata.bytes -= 1,
        }
        assert!(
            recipient
                .open_generation_result(&changed, &context())
                .is_err()
        );
    }
    assert!(seal_generation_result(context(), recipient.public()?, &[]).is_err());
    assert!(
        seal_generation_result(
            context(),
            recipient.public()?,
            &vec![0; 4 * 1024 * 1024 + 1]
        )
        .is_err()
    );
    assert!(
        seal_generation_result(
            GenerationContext {
                version: 2,
                ..context()
            },
            recipient.public()?,
            b"bad version"
        )
        .is_err()
    );
    Ok(())
}
