use needware_crypto::SecretKey;
use zeroize::Zeroizing;
pub fn installation_signing_key(
    fixture: bool,
    encoded: Option<String>,
) -> Result<SecretKey, Box<dyn std::error::Error>> {
    let Some(encoded) = encoded else {
        return if fixture {
            Ok(SecretKey::random()?)
        } else {
            Err("Stable installation signing seed is required".into())
        };
    };
    let encoded = Zeroizing::new(encoded);
    let decoded = Zeroizing::new(
        hex::decode(encoded.as_str()).map_err(|_| "Invalid installation signing seed")?,
    );
    let seed = Zeroizing::new(
        <[u8; 32]>::try_from(decoded.as_slice())
            .map_err(|_| "Installation signing seed must be 32 bytes")?,
    );
    Ok(SecretKey::from_bytes(*seed))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_signing_is_stable_and_never_silently_ephemeral()
    -> Result<(), Box<dyn std::error::Error>> {
        let encoded = "21".repeat(32);
        let first = installation_signing_key(false, Some(encoded.clone()))?;
        let restart = installation_signing_key(false, Some(encoded.clone()))?;
        assert_eq!(first.public_key(), restart.public_key());
        assert_eq!(
            first.public_key(),
            installation_signing_key(true, Some(encoded))?.public_key()
        );
        assert!(installation_signing_key(false, None).is_err());
        assert!(installation_signing_key(false, Some("11".repeat(31))).is_err());
        assert!(installation_signing_key(false, Some("not-a-secret".into())).is_err());
        assert!(installation_signing_key(true, None).is_ok());
        Ok(())
    }
}
