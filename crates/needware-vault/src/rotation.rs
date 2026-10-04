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
/// Both authorities bind the same transition. A fresh recipient can anchor the
/// historical authority at the independently trusted current root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootRotation {
    pub transition: RootTransition,
    pub acceptance: Vec<u8>,
}
impl RootRotation {
    fn message(&self) -> Result<Vec<u8>> {
        canonical(b"NEEDWARE-ROOT-ROTATION-ACCEPT-v1\0", &self.transition)
    }
    pub fn verify(&self, previous: &KeyContext, authority: &[u8; 32]) -> Result<VerifiedAuthority> {
        let next = self.transition.verify(previous, authority)?;
        let signature: &[u8; 64] = self
            .acceptance
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::Authentication)?;
        needware_crypto::verify(next.public(), &self.message()?, signature)
            .map_err(|_| VaultError::Authentication)?;
        Ok(next)
    }
    pub fn verify_current(
        &self,
        current: &KeyContext,
        authority: &[u8; 32],
    ) -> Result<VerifiedAuthority> {
        if self.transition.next != *current || self.transition.next_authority != *authority {
            return Err(VaultError::Authentication);
        }
        self.verify(
            &self.transition.previous,
            &self.transition.previous_authority,
        )?;
        Ok(VerifiedAuthority {
            context: self.transition.previous.clone(),
            public: self.transition.previous_authority,
        })
    }
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        decode(bytes)
    }
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
    pub fn accepted_rotation_to(&self, next: &Self) -> Result<RootRotation> {
        let mut rotation = RootRotation {
            transition: self.transition_to(next)?,
            acceptance: Vec::new(),
        };
        rotation.acceptance = next.signing()?.sign(&rotation.message()?).to_vec();
        Ok(rotation)
    }
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
