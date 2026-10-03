//! Bounded canonical container with independent cryptographic verification.
mod strict_json;
use needware_crypto::{SecretKey, digest};
use needware_ir::Application;
use needware_validation::{ValidatedApplication, validate};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

const MAGIC: &[u8; 8] = b"NEEDPKG\0";
pub const FORMAT: u16 = 1;
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MIME: &str = "application/vnd.needware.package";
#[derive(Debug, Error)]
pub enum PackageError {
    #[error("invalid package: {0}")]
    Invalid(String),
    #[error("package resource limit exceeded")]
    Limit,
    #[error("package signature invalid")]
    Signature,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    ir_digest: String,
    assets: Vec<AssetMetadata>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AssetMetadata {
    digest: String,
    length: u32,
    media_type: String,
}
#[derive(Debug, Clone)]
pub struct Asset {
    pub media_type: String,
    pub bytes: Vec<u8>,
}
#[derive(Debug, Clone)]
pub struct VerifiedPackage {
    application: ValidatedApplication,
    digest: [u8; 32],
    signers: Vec<[u8; 32]>,
    assets: BTreeMap<String, Asset>,
}
impl VerifiedPackage {
    pub fn application(&self) -> &ValidatedApplication {
        &self.application
    }
    pub fn digest(&self) -> String {
        hex::encode(self.digest)
    }
    pub fn signers(&self) -> &[[u8; 32]] {
        &self.signers
    }
    pub fn assets(&self) -> &BTreeMap<String, Asset> {
        &self.assets
    }
}
fn invalid(e: impl std::fmt::Display) -> PackageError {
    PackageError::Invalid(e.to_string())
}
pub fn canonical<T: Serialize>(value: &T) -> Result<Vec<u8>, PackageError> {
    serde_json_canonicalizer::to_vec(value).map_err(invalid)
}
pub fn parse_json<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, PackageError> {
    if bytes.len() > needware_ir::MAX_IR_BYTES {
        return Err(PackageError::Limit);
    }
    let strict: strict_json::Strict = serde_json::from_slice(bytes).map_err(invalid)?;
    serde_json::from_value(strict.0).map_err(invalid)
}
fn asset_check(asset: &Asset) -> Result<(), PackageError> {
    if asset.bytes.is_empty() || asset.bytes.len() > 8 * 1024 * 1024 {
        return Err(PackageError::Limit);
    }
    let format = match asset.media_type.as_str() {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/webp" => image::ImageFormat::WebP,
        _ => return Err(invalid("unsupported asset type")),
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&asset.bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(invalid)?;
    Ok(())
}
fn signed_message(digest: &[u8; 32]) -> Vec<u8> {
    let mut m = b"NEEDWARE-PACKAGE\0".to_vec();
    m.extend(FORMAT.to_le_bytes());
    m.extend(digest);
    m
}
pub fn build(
    app: Application,
    assets: Vec<Asset>,
    key: &SecretKey,
) -> Result<Vec<u8>, PackageError> {
    let app = validate(app).map_err(invalid)?;
    let ir = canonical(app.application())?;
    if ir.len() > needware_ir::MAX_IR_BYTES || assets.len() > 256 {
        return Err(PackageError::Limit);
    }
    let mut sorted = BTreeMap::new();
    for asset in assets {
        asset_check(&asset)?;
        let id = hex::encode(digest(&asset.bytes));
        if sorted.insert(id, asset).is_some() {
            return Err(invalid("duplicate asset"));
        }
    }
    let manifest = Manifest {
        ir_digest: hex::encode(digest(&ir)),
        assets: sorted
            .iter()
            .map(|(d, a)| AssetMetadata {
                digest: d.clone(),
                length: a.bytes.len() as u32,
                media_type: a.media_type.clone(),
            })
            .collect(),
    };
    let manifest = canonical(&manifest)?;
    if manifest.len() > 256 * 1024 {
        return Err(PackageError::Limit);
    }
    let mut out = MAGIC.to_vec();
    out.extend(FORMAT.to_le_bytes());
    out.extend((manifest.len() as u32).to_le_bytes());
    out.extend((ir.len() as u32).to_le_bytes());
    out.extend((sorted.len() as u16).to_le_bytes());
    out.extend(manifest);
    out.extend(ir);
    for asset in sorted.values() {
        out.extend((asset.bytes.len() as u64).to_le_bytes());
        out.extend(&asset.bytes);
        if out.len() > MAX_BYTES - 98 {
            return Err(PackageError::Limit);
        }
    }
    let d = digest(&out);
    out.extend(1u16.to_le_bytes());
    out.extend(key.public_key());
    out.extend(key.sign(&signed_message(&d)));
    Ok(out)
}
struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], PackageError> {
        let end = self.offset.checked_add(n).ok_or(PackageError::Limit)?;
        let s = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| invalid("truncated package"))?;
        self.offset = end;
        Ok(s)
    }
    fn array<const N: usize>(&mut self) -> Result<[u8; N], PackageError> {
        self.take(N)?.try_into().map_err(invalid)
    }
}
pub fn verify(bytes: &[u8]) -> Result<VerifiedPackage, PackageError> {
    if bytes.len() > MAX_BYTES {
        return Err(PackageError::Limit);
    }
    let mut r = Reader { bytes, offset: 0 };
    if r.take(8)? != MAGIC {
        return Err(invalid("magic"));
    }
    if u16::from_le_bytes(r.array()?) != FORMAT {
        return Err(invalid("unsupported format"));
    }
    let manifest_len = u32::from_le_bytes(r.array()?) as usize;
    let ir_len = u32::from_le_bytes(r.array()?) as usize;
    let count = u16::from_le_bytes(r.array()?) as usize;
    if manifest_len > 256 * 1024 || ir_len > needware_ir::MAX_IR_BYTES || count > 256 {
        return Err(PackageError::Limit);
    }
    let manifest_bytes = r.take(manifest_len)?;
    let manifest: Manifest = parse_json(manifest_bytes)?;
    if canonical(&manifest)? != manifest_bytes {
        return Err(invalid("noncanonical manifest"));
    }
    if count != manifest.assets.len() {
        return Err(invalid("asset count mismatch"));
    }
    let ir = r.take(ir_len)?;
    if hex::encode(digest(ir)) != manifest.ir_digest {
        return Err(invalid("IR digest mismatch"));
    }
    let app: Application = parse_json(ir)?;
    if canonical(&app)? != ir {
        return Err(invalid("noncanonical IR"));
    }
    let mut assets = BTreeMap::new();
    let mut previous = String::new();
    for m in manifest.assets {
        if m.digest.len() != 64 || m.digest <= previous {
            return Err(invalid("asset ordering/duplicate"));
        }
        previous = m.digest.clone();
        let length = u64::from_le_bytes(r.array()?);
        if length != m.length as u64 || length > 8 * 1024 * 1024 {
            return Err(PackageError::Limit);
        }
        let data = r.take(length as usize)?;
        if hex::encode(digest(data)) != m.digest {
            return Err(invalid("asset digest mismatch"));
        }
        let asset = Asset {
            media_type: m.media_type,
            bytes: data.to_vec(),
        };
        asset_check(&asset)?;
        assets.insert(m.digest, asset);
    }
    let d = digest(&bytes[..r.offset]);
    let count = u16::from_le_bytes(r.array()?);
    if count == 0 || count > 8 {
        return Err(invalid("signature count"));
    }
    let mut signers = Vec::new();
    for _ in 0..count {
        let key = r.array()?;
        let signature = r.array()?;
        if signers.contains(&key) {
            return Err(invalid("duplicate signer"));
        }
        needware_crypto::verify(&key, &signed_message(&d), &signature)
            .map_err(|_| PackageError::Signature)?;
        signers.push(key);
    }
    if r.offset != bytes.len() {
        return Err(invalid("trailing package bytes"));
    }
    Ok(VerifiedPackage {
        application: validate(app).map_err(invalid)?,
        digest: d,
        signers,
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    #[test]
    fn duplicate_json_and_noncanonical_numbers_fail() {
        assert!(parse_json::<serde_json::Value>(br#"{"a":1,"a":2}"#).is_err());
        assert!(parse_json::<serde_json::Value>(b"1.2").is_err());
        for number in [
            "9007199254740992",
            "-9007199254740992",
            "-9223372036854775808",
        ] {
            assert!(parse_json::<serde_json::Value>(number.as_bytes()).is_err());
        }
        for number in ["9007199254740991", "-9007199254740991"] {
            assert!(parse_json::<serde_json::Value>(number.as_bytes()).is_ok());
        }
    }
    proptest! {#[test]fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(),0..4096)){let _=verify(&bytes);}}
}
