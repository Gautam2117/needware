use super::*;

#[derive(Debug, Serialize)]
pub struct RevisionReport {
    pub review_digest: String,
    pub source_package: String,
    pub target_package: String,
    pub migration: needware_migrations::Report,
    pub permissions_added: Vec<Capability>,
    pub permissions_removed: Vec<Capability>,
}
/// Only a fully verified target and validated migration can construct a preview.
pub struct RevisionPreview {
    report: RevisionReport,
    before: State,
    after: State,
    target: VerifiedPackage,
    trusted: Vec<[u8; 32]>,
}
impl Runtime {
    pub fn preview_revision(
        &self,
        target: VerifiedPackage,
        trusted: &[[u8; 32]],
    ) -> Result<RevisionPreview, RuntimeError> {
        if !target.signers().iter().any(|s| trusted.contains(s)) {
            return Err(RuntimeError::Untrusted);
        }
        let target_app = target.application().application();
        if target_app.parent.as_deref() != Some(self.package.digest().as_str()) {
            return Err(RuntimeError::Invalid(
                "revision parent does not match the active package".into(),
            ));
        }
        let migration = needware_migrations::Plan::between(self.application(), target_app)
            .and_then(|plan| plan.preview(&self.state))
            .map_err(|e| match e {
                needware_migrations::MigrationError::Limit => RuntimeError::Limit,
                other => RuntimeError::Invalid(other.to_string()),
            })?;
        needware_validation::validate_state(&migration.state, target_app)
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        let mut review = b"needware revision review v1\0".to_vec();
        review.extend(
            serde_json::to_vec(&(self.package.digest(), target.digest(), &self.state))
                .map_err(|e| RuntimeError::Invalid(e.to_string()))?,
        );
        let old = &self.application().capabilities;
        let new = &target_app.capabilities;
        let report = RevisionReport {
            review_digest: hex::encode(needware_crypto::digest(&review)),
            source_package: self.package.digest(),
            target_package: target.digest(),
            permissions_added: new
                .iter()
                .filter(|c| !old.iter().any(|o| o.covers(c)))
                .cloned()
                .collect(),
            permissions_removed: old
                .iter()
                .filter(|c| !new.iter().any(|n| n.covers(c)))
                .cloned()
                .collect(),
            migration: migration.report,
        };
        Ok(RevisionPreview {
            report,
            before: self.state.clone(),
            after: migration.state,
            target,
            trusted: trusted.to_vec(),
        })
    }
}
impl RevisionPreview {
    pub fn report(&self) -> &RevisionReport {
        &self.report
    }
    pub fn snapshot(&self) -> &State {
        &self.before
    }
    /// The host must atomically persist snapshot + returned state before replacing its active runtime.
    pub fn approve(
        self,
        current: &Runtime,
        review_digest: &str,
        grants: Grants,
        destructive_consent: bool,
    ) -> Result<Runtime, RuntimeError> {
        if current.state != self.before
            || current.package.digest() != self.report.source_package
            || review_digest != self.report.review_digest
        {
            return Err(RuntimeError::Invalid(
                "revision preview is stale or does not match the reviewed change".into(),
            ));
        }
        if self.report.migration.requires_confirmation && !destructive_consent {
            return Err(RuntimeError::Permission);
        }
        Runtime::load(self.target, Some(self.after), grants, &self.trusted)
    }
}
