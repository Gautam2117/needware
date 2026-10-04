use needware_crypto::SecretKey;
use needware_vault::*;
use proptest::prelude::*;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const DOCUMENT: &str = "33333333-3333-4333-8333-333333333333";
fn verified(vault: &AccountVault, device: &DeviceKeys) -> Result<VerifiedDevice> {
    Ok(vault
        .certify_device(device.public()?)?
        .verify(vault.context(), &vault.authority()?)?)
}
#[test]
fn trusted_device_enrollment_restores_root_and_local_device_lock_is_context_bound() -> Result {
    let vault = AccountVault::create(ACCOUNT)?;
    let device = DeviceKeys::create()?;
    let document = vault.create_document(DOCUMENT)?;
    let ciphertext = document.seal(b"private definition and asset", b"package revision 1")?;
    let wrapped = vault.wrap_document(&document)?;
    let envelope = vault.enroll_device(&verified(&vault, &device)?)?;
    let restored = device.open_account(&envelope, vault.context(), &vault.authority()?)?;
    let opened = restored.unwrap_document(&wrapped, document.context())?;
    assert_eq!(
        opened.open(&ciphertext, b"package revision 1")?.as_slice(),
        b"private definition and asset"
    );
    let lock = SecretKey::random()?;
    let local = device.lock_local(&lock)?;
    let reopened = DeviceKeys::unlock_local(&device.public()?.id, &local, &lock)?;
    assert_eq!(device.public()?, reopened.public()?);
    needware_crypto::verify(
        &device.public()?.signing,
        b"message",
        &reopened.sign(b"message")?,
    )?;
    assert!(DeviceKeys::unlock_local(OTHER, &local, &lock).is_err());
    assert!(DeviceKeys::unlock_local(&device.public()?.id, &local, &SecretKey::random()?).is_err());
    let mut altered = local;
    altered[30] ^= 1;
    assert!(DeviceKeys::unlock_local(&device.public()?.id, &altered, &lock).is_err());
    Ok(())
}
#[test]
fn user_held_recovery_code_recovers_documents_after_all_original_device_keys_are_lost() -> Result {
    let (context, authority, recovery, wrapped, document_context, ciphertext, code) = {
        let vault = AccountVault::create(ACCOUNT)?;
        let document = vault.create_document(DOCUMENT)?;
        let code = RecoveryCode::create()?;
        (
            vault.context().clone(),
            vault.authority()?,
            vault.recovery_envelope(&code)?,
            vault.wrap_document(&document)?,
            document.context().clone(),
            document.seal(b"offline private state", b"state schema 1")?,
            code.export(),
        )
    };
    // The original vault, document key and recovery-code object have been dropped.
    let recovered = AccountVault::recover(&RecoveryCode::parse(&code)?, &recovery, &context)?;
    assert_eq!(recovered.authority()?, authority);
    let document = recovered.unwrap_document(&wrapped, &document_context)?;
    assert_eq!(
        document.open(&ciphertext, b"state schema 1")?.as_slice(),
        b"offline private state"
    );
    let new_device = DeviceKeys::create()?;
    let envelope = recovered.enroll_device(&verified(&recovered, &new_device)?)?;
    assert_eq!(
        new_device
            .open_account(&envelope, &context, &authority)?
            .authority()?,
        authority
    );
    assert!(AccountVault::recover(&RecoveryCode::create()?, &recovery, &context).is_err());
    let mut altered = recovery.clone();
    altered.ciphertext[35] ^= 1;
    assert!(AccountVault::recover(&RecoveryCode::parse(&code)?, &altered, &context).is_err());
    let mut altered = recovery;
    altered.authority[0] ^= 1;
    assert!(AccountVault::recover(&RecoveryCode::parse(&code)?, &altered, &context).is_err());
    Ok(())
}
#[test]
fn collaborator_receives_one_document_key_without_receiving_the_account_root() -> Result {
    let owner = AccountVault::create(ACCOUNT)?;
    let collaborator = AccountVault::create(OTHER)?;
    let device = DeviceKeys::create()?;
    let recipient = verified(&collaborator, &device)?;
    assert!(owner.enroll_device(&recipient).is_err());
    let document = owner.create_document(DOCUMENT)?;
    let shared = owner.share_document(&document, &recipient)?;
    let opened = device.open_document(
        &shared,
        document.context(),
        owner.context().epoch,
        &owner.authority()?,
    )?;
    let ciphertext = document.seal(b"shared private content", b"revision 1")?;
    assert_eq!(
        opened.open(&ciphertext, b"revision 1")?.as_slice(),
        b"shared private content"
    );
    assert!(
        device
            .open_account(&shared, owner.context(), &owner.authority()?)
            .is_err()
    );
    assert!(
        DeviceKeys::create()?
            .open_document(
                &shared,
                document.context(),
                owner.context().epoch,
                &owner.authority()?
            )
            .is_err()
    );
    assert!(collaborator.wrap_document(&document).is_err());
    Ok(())
}
#[test]
fn device_certificates_require_pinned_authority_exact_account_and_current_epoch() -> Result {
    let vault = AccountVault::create(ACCOUNT)?;
    let device = DeviceKeys::create()?;
    let certificate = vault.certify_device(device.public()?)?;
    let authority = vault.authority()?;
    certificate.verify(vault.context(), &authority)?;
    assert!(
        certificate
            .verify(
                vault.context(),
                &AccountVault::create(ACCOUNT)?.authority()?
            )
            .is_err()
    );
    let mut changed = vault.context().clone();
    changed.account = OTHER.into();
    assert!(certificate.verify(&changed, &authority).is_err());
    changed = vault.context().clone();
    changed.epoch += 1;
    assert!(certificate.verify(&changed, &authority).is_err());
    let mut tampered = certificate.clone();
    tampered.device.encryption[0] ^= 1;
    assert!(tampered.verify(vault.context(), &authority).is_err());
    let mut tampered = certificate;
    tampered.device.id = OTHER.into();
    assert!(tampered.verify(vault.context(), &authority).is_err());
    Ok(())
}
#[test]
fn hpke_envelopes_reject_signature_context_recipient_and_ciphertext_tampering() -> Result {
    let vault = AccountVault::create(ACCOUNT)?;
    let device = DeviceKeys::create()?;
    let original = vault.enroll_device(&verified(&vault, &device)?)?;
    let mut cases = Vec::new();
    let mut e = original.clone();
    e.context.version = 2;
    cases.push(e);
    let mut e = original.clone();
    e.context.account = OTHER.into();
    cases.push(e);
    let mut e = original.clone();
    e.context.epoch += 1;
    cases.push(e);
    let mut e = original.clone();
    e.root_epoch += 1;
    cases.push(e);
    let mut e = original.clone();
    e.authority[0] ^= 1;
    cases.push(e);
    let mut e = original.clone();
    e.recipient.signing[0] ^= 1;
    cases.push(e);
    let mut e = original.clone();
    e.recipient.id = OTHER.into();
    cases.push(e);
    let mut e = original.clone();
    e.encapsulated[0] ^= 1;
    cases.push(e);
    let mut e = original.clone();
    e.ciphertext[0] ^= 1;
    cases.push(e);
    let mut e = original.clone();
    e.signature[0] ^= 1;
    cases.push(e);
    let mut e = original.clone();
    e.signature.push(0);
    cases.push(e);
    for e in cases {
        assert!(
            device
                .open_account(&e, vault.context(), &vault.authority()?)
                .is_err()
        );
    }
    assert!(
        device
            .open_document(
                &original,
                vault.context(),
                vault.context().epoch,
                &vault.authority()?
            )
            .is_err()
    );
    Ok(())
}
#[test]
fn fresh_rotation_prevents_old_keys_from_opening_future_payloads_but_keeps_existing_copies()
-> Result {
    let owner = AccountVault::create(ACCOUNT)?;
    let old = owner.create_document(DOCUMENT)?;
    let downloaded = old.seal(b"already downloaded", b"epoch 1")?;
    let next = old.rotate()?;
    let ciphertext = next.seal(b"future state", b"epoch 2")?;
    assert!(old.open(&ciphertext, b"epoch 2").is_err());
    assert_eq!(
        old.open(&downloaded, b"epoch 1")?.as_slice(),
        b"already downloaded"
    );
    let rotated_owner = owner.rotate()?;
    assert_ne!(owner.authority()?, rotated_owner.authority()?);
    let wrapped = rotated_owner.wrap_document(&next)?;
    assert!(owner.unwrap_document(&wrapped, next.context()).is_err());
    assert_eq!(
        rotated_owner
            .unwrap_document(&wrapped, next.context())?
            .open(&ciphertext, b"epoch 2")?
            .as_slice(),
        b"future state"
    );
    let device = DeviceKeys::create()?;
    let certificate = owner.certify_device(device.public()?)?;
    assert!(
        certificate
            .verify(rotated_owner.context(), &rotated_owner.authority()?)
            .is_err()
    );
    let shared = owner.share_document(&old, &verified(&owner, &device)?)?;
    assert!(
        device
            .open_document(
                &shared,
                next.context(),
                owner.context().epoch,
                &owner.authority()?
            )
            .is_err()
    );
    Ok(())
}
#[test]
fn root_authority_transitions_require_the_previous_pin_and_reject_replay_or_epoch_skips() -> Result
{
    let previous = AccountVault::create(ACCOUNT)?;
    let next = previous.rotate()?;
    let transition = previous.transition_to(&next)?;
    let pinned = transition.verify(previous.context(), &previous.authority()?)?;
    assert_eq!(pinned.context(), next.context());
    assert_eq!(*pinned.public(), next.authority()?);
    let device = DeviceKeys::create()?;
    let enrollment = next.enroll_device(&verified(&next, &device)?)?;
    assert_eq!(
        device
            .open_account(&enrollment, pinned.context(), pinned.public())?
            .authority()?,
        next.authority()?
    );
    assert!(
        transition
            .verify(next.context(), &next.authority()?)
            .is_err()
    );
    assert!(previous.transition_to(&next.rotate()?).is_err());
    assert!(
        previous
            .transition_to(&AccountVault::create(OTHER)?.rotate()?)
            .is_err()
    );
    let mut altered = transition.clone();
    altered.next_authority[0] ^= 1;
    assert!(
        altered
            .verify(previous.context(), &previous.authority()?)
            .is_err()
    );
    let mut altered = transition;
    altered.next.epoch += 1;
    assert!(
        altered
            .verify(previous.context(), &previous.authority()?)
            .is_err()
    );
    Ok(())
}
#[test]
fn payloads_are_nonce_randomized_metadata_bound_and_resource_limited() -> Result {
    let owner = AccountVault::create(ACCOUNT)?;
    let document = owner.create_document(DOCUMENT)?;
    let a = document.seal(b"private", b"snapshot schema 1")?;
    let b = document.seal(b"private", b"snapshot schema 1")?;
    assert_ne!(a, b);
    assert!(document.open(&a, b"change schema 1").is_err());
    assert!(
        owner
            .create_document(OTHER)?
            .open(&a, b"snapshot schema 1")
            .is_err()
    );
    assert!(document.seal(b"private", &[0; 1025]).is_err());
    assert!(document.open(&[0; 39], b"snapshot schema 1").is_err());
    assert!(document.seal(&vec![0; 32 * 1024 * 1024 + 1], b"").is_err());
    assert!(AccountVault::create("not a UUID").is_err());
    Ok(())
}
#[test]
fn recovery_codes_and_wire_envelopes_reject_typographical_and_structural_corruption() -> Result {
    let code = RecoveryCode::create()?.export();
    assert_eq!(code.len(), 77);
    RecoveryCode::parse(&code)?;
    let mut typo = code.as_bytes().to_vec();
    typo[4] = if typo[4] == b'a' { b'b' } else { b'a' };
    assert!(RecoveryCode::parse(&String::from_utf8(typo)?).is_err());
    assert!(RecoveryCode::parse(&code.to_uppercase()).is_err());
    let owner = AccountVault::create(ACCOUNT)?;
    let device = DeviceKeys::create()?;
    let envelope = owner.enroll_device(&verified(&owner, &device)?)?;
    let bytes = serde_json::to_vec(&envelope)?;
    let parsed = DeviceEnvelope::parse(&bytes)?;
    device.open_account(&parsed, owner.context(), &owner.authority()?)?;
    let mut unknown = serde_json::to_value(&envelope)?;
    unknown["unknown"] = serde_json::json!(true);
    assert!(DeviceEnvelope::parse(&serde_json::to_vec(&unknown)?).is_err());
    assert!(DeviceEnvelope::parse(&vec![0; 8193]).is_err());
    assert!(DeviceEnvelope::parse(br#"{"context":{},"context":{}}"#).is_err());
    assert!(DeviceEnvelope::parse(&bytes[..bytes.len() - 1]).is_err());
    Ok(())
}
proptest! {
    #[test]
    fn hostile_wire_and_recovery_inputs_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..10000)) {
        let _ = DeviceEnvelope::parse(&bytes); let _ = WrappedKey::parse(&bytes); let _ = RecoveryEnvelope::parse(&bytes); let _ = DeviceCertificate::parse(&bytes);
        let _ = RootTransition::parse(&bytes);
        let _ = RecoveryCode::parse(&String::from_utf8_lossy(&bytes));
    }
}
