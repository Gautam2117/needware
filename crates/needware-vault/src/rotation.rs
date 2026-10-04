use super::*;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootTransition {
    pub previous: KeyContext,
    pub next: KeyContext,
    pub previous_authority: [u8; 32],
    pub next_authority: [u8; 32],
    pub signature: Vec<u8>,
}
pub struct VerifiedAuthority {
    context: KeyContext,
    public: [u8; 32],
}
impl VerifiedAuthority {
    pub fn context(&self) -> &KeyContext {
        &self.context
    }
    pub fn public(&self) -> &[u8; 32] {
        &self.public
    }
}
impl RootTransition {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(
            b"NEEDWARE-ROOT-TRANSITION\0",
            &(
                &self.previous,
                &self.next,
                self.previous_authority,
                self.next_authority,
            ),
        )
    }
    fn validate(&self) -> Result<()> {
        self.previous.validate()?;
        self.next.validate()?;
        if self.previous.kind != KeyKind::AccountRoot
            || self.next.kind != KeyKind::AccountRoot
            || self.previous.account != self.next.account
            || self.previous.epoch.checked_add(1) != Some(self.next.epoch)
            || self.previous_authority == self.next_authority
            || self.next_authority == [0; 32]
        {
            return Err(VaultError::Context);
        }
        Ok(())
    }
    pub fn verify(
        &self,
        expected_previous: &KeyContext,
        authority: &[u8; 32],
    ) -> Result<VerifiedAuthority> {
        self.validate()?;
        expected_previous.validate()?;
        if self.previous != *expected_previous
            || self.previous_authority != *authority
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
        )
        .map_err(|_| VaultError::Authentication)?;
        Ok(VerifiedAuthority {
            context: self.next.clone(),
            public: self.next_authority,
        })
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
}
impl AccountVault {
    pub fn transition_to(&self, next: &Self) -> Result<RootTransition> {
        let mut transition = RootTransition {
            previous: self.context.clone(),
            next: next.context.clone(),
            previous_authority: self.authority()?,
            next_authority: next.authority()?,
            signature: vec![],
        };
        transition.validate()?;
        transition.signature = self.signing()?.sign(&transition.message()?).to_vec();
        Ok(transition)
    }
}
