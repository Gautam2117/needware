use super::*;

/// Owner authorization binds a new key epoch to an exact historical cut and
/// compacted baseline. Digests contain no application plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionDigests {
    pub previous_binding: [u8; 32],
    pub next_binding: [u8; 32],
    pub history: [u8; 32],
    pub baseline: [u8; 32],
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentTransition {
    pub previous: KeyContext,
    pub next: KeyContext,
    pub root: KeyContext,
    pub authority: [u8; 32],
    pub previous_generation: u32,
    pub next_generation: u32,
    pub digests: TransitionDigests,
    pub signature: Vec<u8>,
}
impl DocumentTransition {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-DOCUMENT-TRANSITION-v1\0",
            &(
                &self.previous,
                &self.next,
                &self.root,
                self.authority,
                self.previous_generation,
                self.next_generation,
                &self.digests,
            ),
        )
    }
    fn validate(&self) -> Result<()> {
        self.previous.validate()?;
        self.next.validate()?;
        self.root.validate()?;
        if self.previous.kind != KeyKind::DocumentKey
            || self.next.kind != KeyKind::DocumentKey
            || self.root.kind != KeyKind::AccountRoot
            || self.previous.account != self.next.account
            || self.previous.account != self.root.account
            || self.previous.document != self.next.document
            || self.previous.epoch.checked_add(1) != Some(self.next.epoch)
            || self.previous_generation == 0
            || self.previous_generation.checked_add(1) != Some(self.next_generation)
            || self.authority == [0; 32]
        {
            return Err(VaultError::Context);
        }
        Ok(())
    }
    pub fn verify(
        &self,
        previous: &KeyContext,
        generation: u32,
        root: &KeyContext,
        authority: &[u8; 32],
        previous_binding: &[u8; 32],
    ) -> Result<()> {
        self.validate()?;
        if &self.previous != previous
            || self.previous_generation != generation
            || &self.root != root
            || &self.authority != authority
            || &self.digests.previous_binding != previous_binding
            || self.signature.len() != 64
        {
            return Err(VaultError::Authentication);
        }
        needware_crypto::verify(
            authority,
            &self.message()?,
            &self
                .signature
                .as_slice()
                .try_into()
                .map_err(|_| VaultError::Authentication)?,
        )?;
        Ok(())
    }
}
impl AccountVault {
    pub fn document_transition(
        &self,
        previous: &DocumentKey,
        next: &DocumentKey,
        generation: u32,
        digests: TransitionDigests,
    ) -> Result<DocumentTransition> {
        let mut transition = DocumentTransition {
            previous: previous.context.clone(),
            next: next.context.clone(),
            root: self.context.clone(),
            authority: self.authority()?,
            previous_generation: generation,
            next_generation: generation.checked_add(1).ok_or(VaultError::Context)?,
            digests,
            signature: Vec::new(),
        };
        transition.validate()?;
        transition.signature = self.signing()?.sign(&transition.message()?).to_vec();
        Ok(transition)
    }
}
