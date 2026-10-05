use super::*;
use needware_package::VerifiedPackage;
use needware_vault::AccountVault;

/// A reviewed, immutable schema cut. Only native migration and package verification
/// can construct it; preparing keys does not replace the source replica.
pub struct RevisionEpochReview {
    pub(crate) app: ValidatedApplication,
    pub(crate) scope: Scope,
    pub(crate) state: State,
    source: Binding,
    source_state: State,
    source_history: [u8; 32],
    digest: [u8; 32],
    report: needware_migrations::Report,
}
impl RevisionEpochReview {
    pub fn digest(&self) -> [u8; 32] {
        self.digest
    }
    pub fn report(&self) -> &needware_migrations::Report {
        &self.report
    }
    pub fn state(&self) -> &State {
        &self.state
    }
    pub fn scope(&self) -> &Scope {
        &self.scope
    }
}
impl Replica {
    pub fn review_revision(
        &self,
        source: &VerifiedPackage,
        target: &VerifiedPackage,
        trusted: &[[u8; 32]],
        scope: Scope,
    ) -> Result<RevisionEpochReview> {
        if !self.writable
            || source.application().application() != self.app.application()
            || target.application().application().parent.as_deref()
                != Some(source.digest().as_str())
            || !target
                .signers()
                .iter()
                .any(|signer| trusted.contains(signer))
        {
            return Err(SyncError::Authorization);
        }
        let app = target.application().clone();
        scope.validate(app.application())?;
        let mut preview =
            needware_migrations::Plan::between(self.app.application(), app.application())
                .and_then(|plan| plan.preview(&self.state))
                .map_err(|_| SyncError::Invalid)?;
        needware_validation::derived::materialize(
            app.application(),
            &mut preview.state,
            &mut needware_expr::Budget::new(1_000_000),
        )
        .map_err(|_| SyncError::Invalid)?;
        needware_validation::validate_state(&preview.state, app.application())
            .map_err(|_| SyncError::Invalid)?;
        let source_history = self.history_digest()?;
        let digest = *blake3::hash(&wire::canonical(&(
            "needware synchronized revision review v1",
            &self.binding,
            &self.state,
            source_history,
            target.digest(),
            &scope,
            &preview.report,
            &preview.state,
        ))?)
        .as_bytes();
        Ok(RevisionEpochReview {
            app,
            scope,
            state: preview.state,
            source: self.binding.clone(),
            source_state: self.state.clone(),
            source_history,
            digest,
            report: preview.report,
        })
    }
    pub fn prepare_revision_epoch(
        &mut self,
        owner: &AccountVault,
        next_key: DocumentKey,
        membership: &VerifiedMembership,
        review: &RevisionEpochReview,
        approved_digest: &[u8; 32],
        destructive_consent: bool,
    ) -> Result<PreparedEpoch> {
        if review.source != self.binding
            || review.source_state != self.state
            || review.source_history != self.history_digest()?
            || approved_digest != &review.digest
            || (review.report.requires_confirmation && !destructive_consent)
        {
            return Err(SyncError::Protocol);
        }
        self.prepare_authorized_epoch(owner, next_key, membership, None, Some(review), true)
    }
}
