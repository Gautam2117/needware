use super::*;
#[wasm_bindgen]
pub struct BrowserGenerationResult {
    envelope: GenerationEnvelope,
}
#[wasm_bindgen]
impl BrowserGenerationResult {
    pub fn metadata(&self) -> Result<String, JsValue> {
        json(&self.envelope.metadata)
    }
    pub fn ciphertext(&self) -> Vec<u8> {
        self.envelope.ciphertext.clone()
    }
}
#[wasm_bindgen]
pub fn seal_generation_package(
    package: &[u8],
    recipient: &str,
    context: &str,
) -> Result<BrowserGenerationResult, JsValue> {
    if package.len() > 4 * 1024 * 1024 {
        return Err(error("generation package size limit"));
    }
    needware_package::verify(package).map_err(error)?;
    Ok(BrowserGenerationResult {
        envelope: seal_generation_result(parse(context)?, parse(recipient)?, package)
            .map_err(error)?,
    })
}
#[wasm_bindgen]
impl BrowserVault {
    pub fn open_generation_package(
        &self,
        job: &str,
        metadata: &str,
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, JsValue> {
        if ciphertext.len() > 4 * 1024 * 1024 + 16 {
            return Err(error("generation ciphertext size limit"));
        }
        let metadata: GenerationMetadata = parse(metadata)?;
        let expected = GenerationContext {
            version: 1,
            account: self.root()?.context().account.clone(),
            job: job.into(),
        };
        let plaintext = self
            .device
            .open_generation_result(
                &GenerationEnvelope {
                    metadata,
                    ciphertext: ciphertext.to_vec(),
                },
                &expected,
            )
            .map_err(error)?;
        needware_package::verify(&plaintext).map_err(error)?;
        Ok(plaintext.to_vec())
    }
}
