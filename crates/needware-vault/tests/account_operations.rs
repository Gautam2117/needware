use needware_vault::*;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const NONCE: &str = "22222222-2222-4222-8222-222222222222";

#[test]
fn account_proofs_bind_device_possession_account_authority_intent_nonce_and_payload() -> Result {
    let root = AccountVault::create(ACCOUNT)?;
    let device = DeviceKeys::create()?;
    let certificate = root.certify_device(device.public()?)?;
    let verified = certificate.verify(root.context(), &root.authority()?)?;
    let kind = AccountOperationKind::CreateVault;
    let digest = [17; 32];
    let proof = device.account_operation(&verified, NONCE, kind.clone(), digest)?;
    let authority = root.authority()?;
    let verify =
        |proof: &AccountOperation| proof.verify(root.context(), &authority, NONCE, &kind, &digest);
    assert_eq!(verify(&proof)?.public(), &device.public()?);
    assert!(
        DeviceKeys::create()?
            .account_operation(&verified, NONCE, kind.clone(), digest)
            .is_err()
    );
    assert!(
        device
            .account_operation(&verified, "invalid-nonce", kind.clone(), digest)
            .is_err()
    );
    for field in 0..7 {
        let mut altered = proof.clone();
        match field {
            0 => altered.nonce = "33333333-3333-4333-8333-333333333333".into(),
            1 => altered.operation = AccountOperationKind::RegisterDevice,
            2 => altered.digest[0] ^= 1,
            3 => altered.certificate.device.encryption[0] ^= 1,
            4 => altered.certificate.context.epoch += 1,
            5 => altered.certificate.signature[0] ^= 1,
            _ => altered.signature[0] ^= 1,
        }
        assert!(verify(&altered).is_err());
    }
    let mut wrong_account = root.context().clone();
    wrong_account.account = NONCE.into();
    assert!(
        proof
            .verify(&wrong_account, &root.authority()?, NONCE, &kind, &digest)
            .is_err()
    );
    assert!(
        proof
            .verify(root.context(), &[0; 32], NONCE, &kind, &digest)
            .is_err()
    );
    Ok(())
}
