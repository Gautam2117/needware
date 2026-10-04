use needware_vault::*;
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const HOLDER: &str = "22222222-2222-4222-8222-222222222222";
const DOCUMENT: &str = "33333333-3333-4333-8333-333333333333";

#[test]
fn foreign_document_key_recovery_is_bound_to_holder_and_owner_contexts() -> Result {
    let owner = AccountVault::create(OWNER)?;
    let holder = AccountVault::create(HOLDER)?;
    let document = owner.create_document(DOCUMENT)?;
    let payload = document.seal(b"shared document", b"scope")?;
    // Owner-only wrapping retains its original cross-account rejection.
    assert!(holder.wrap_document(&document).is_err());
    let held = holder.wrap_held_document(&document)?;
    let opened = holder.unwrap_held_document(&held, document.context())?;
    assert_eq!(
        opened.open(&payload, b"scope")?.as_slice(),
        b"shared document"
    );
    assert!(
        owner
            .unwrap_held_document(&held, document.context())
            .is_err()
    );
    let code = RecoveryCode::create()?;
    let recovered =
        AccountVault::recover(&code, &holder.recovery_envelope(&code)?, holder.context())?;
    let retained = recovered.unwrap_held_document(&held, document.context())?;
    assert_eq!(
        retained.open(&payload, b"scope")?.as_slice(),
        b"shared document"
    );
    assert!(
        holder
            .rotate()?
            .unwrap_held_document(&held, document.context())
            .is_err()
    );
    for field in 0..5 {
        let mut altered = held.clone();
        match field {
            0 => altered.document.account = HOLDER.into(),
            1 => altered.document.epoch += 1,
            2 => altered.holder.epoch += 1,
            3 => altered.authority[0] ^= 1,
            _ => altered.ciphertext[0] ^= 1,
        }
        assert!(
            holder
                .unwrap_held_document(&altered, document.context())
                .is_err()
        );
    }
    assert_eq!(
        document.fork_session().open(&payload, b"scope")?.as_slice(),
        b"shared document"
    );
    Ok(())
}
