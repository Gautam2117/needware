//! Maintained primitives behind domain-separated Needware operations.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use thiserror::Error;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("secure randomness unavailable")]
    Random,
    #[error("signature invalid")]
    Signature,
    #[error("authenticated encryption failed")]
    Encryption,
    #[error("invalid key derivation context")]
    Context,
}
pub struct SecretKey(Zeroizing<[u8; 32]>);
impl SecretKey {
    pub fn random() -> Result<Self, CryptoError> {
        let mut bytes = [0; 32];
        getrandom::fill(&mut bytes).map_err(|_| CryptoError::Random)?;
        Ok(Self::from_bytes(bytes))
    }
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn derive(&self, context: &[u8]) -> Result<Self, CryptoError> {
        if context.is_empty() || context.len() > 1024 {
            return Err(CryptoError::Context);
        }
        let kdf = hkdf::Hkdf::<sha2::Sha256>::new(Some(b"needware-hkdf-1"), self.bytes());
        let mut out = [0; 32];
        kdf.expand(context, &mut out)
            .map_err(|_| CryptoError::Context)?;
        Ok(Self::from_bytes(out))
    }
    pub fn public_key(&self) -> [u8; 32] {
        SigningKey::from_bytes(self.bytes())
            .verifying_key()
            .to_bytes()
    }
    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        SigningKey::from_bytes(self.bytes())
            .sign(message)
            .to_bytes()
    }
}
pub fn digest(bytes: &[u8]) -> [u8; 32] {
    *blake3::hash(bytes).as_bytes()
}
pub fn verify(key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> Result<(), CryptoError> {
    VerifyingKey::from_bytes(key)
        .map_err(|_| CryptoError::Signature)?
        .verify_strict(message, &Signature::from_bytes(signature))
        .map_err(|_| CryptoError::Signature)
}
pub fn seal(key: &SecretKey, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut nonce = [0; 24];
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::Random)?;
    let cipher = XChaCha20Poly1305::new(key.bytes().into());
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Encryption)?;
    let mut out = nonce.to_vec();
    out.extend(encrypted);
    Ok(out)
}
pub fn open(
    key: &SecretKey,
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if ciphertext.len() < 40 {
        return Err(CryptoError::Encryption);
    }
    let cipher = XChaCha20Poly1305::new(key.bytes().into());
    let bytes = cipher
        .decrypt(
            XNonce::from_slice(&ciphertext[..24]),
            Payload {
                msg: &ciphertext[24..],
                aad,
            },
        )
        .map_err(|_| CryptoError::Encryption)?;
    Ok(Zeroizing::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_ed25519_vector_and_authenticated_context() -> Result<(), Box<dyn std::error::Error>> {
        let seed: [u8; 32] =
            hex::decode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")?
                .try_into()
                .map_err(|_| "length")?;
        let key = SecretKey::from_bytes(seed);
        assert_eq!(
            hex::encode(key.public_key()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(
            hex::encode(key.sign(b"")),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
        verify(&key.public_key(), b"", &key.sign(b""))?;
        let encrypted = seal(&key, b"private state", b"document:a:epoch:1")?;
        assert_eq!(
            open(&key, &encrypted, b"document:a:epoch:1")?.as_slice(),
            b"private state"
        );
        assert!(open(&key, &encrypted, b"document:b:epoch:1").is_err());
        assert_ne!(
            key.derive(b"package")?.bytes(),
            key.derive(b"state")?.bytes()
        );
        Ok(())
    }
}
