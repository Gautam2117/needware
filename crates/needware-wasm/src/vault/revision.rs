use super::*;
#[wasm_bindgen]
pub struct BrowserRevisionReview {
    review: needware_sync::RevisionEpochReview,
    package: needware_package::VerifiedPackage,
    trusted: Vec<[u8; 32]>,
    runtime_digest: String,
    info: String,
}
#[wasm_bindgen]
impl BrowserRevisionReview {
    pub fn info(&self) -> String {
        self.info.clone()
    }
}
#[wasm_bindgen]
impl BrowserSync {
    pub fn review_revision(
        &self,
        package: &[u8],
        scope: &str,
    ) -> Result<BrowserRevisionReview, JsValue> {
        if self.runtime.state() != self.replica.state() {
            return Err(error("revision source differs from synchronized state"));
        }
        let target = needware_package::verify(package).map_err(error)?;
        let scope: Scope = parse(scope)?;
        check_scope(target.application().application(), &scope, true)?;
        let trusted = target.signers().to_vec();
        let runtime = self
            .runtime
            .preview_revision(target.clone(), &trusted)
            .map_err(error)?;
        let review = self
            .replica
            .review_revision(self.runtime.package(), &target, &trusted, scope)
            .map_err(error)?;
        let runtime_digest = runtime.report().review_digest.clone();
        let info = json(
            &serde_json::json!({"review_digest":hex::encode(review.digest()),"runtime":runtime.report(),
            "scope":review.scope(),"signers":trusted.iter().map(hex::encode).collect::<Vec<_>>(),"package_digest":target.digest()}),
        )?;
        Ok(BrowserRevisionReview {
            review,
            package: target,
            trusted,
            runtime_digest,
            info,
        })
    }
    pub fn install_revision_epoch(
        &mut self,
        checkpoint: &[u8],
        previous_binding: &str,
    ) -> Result<String, JsValue> {
        let previous: needware_sync::Binding = parse(previous_binding)?;
        let root = KeyContext {
            version: 1,
            kind: KeyKind::AccountRoot,
            account: self.replica.binding().document.account.clone(),
            document: None,
            epoch: self.owner_epoch,
        };
        let mut candidate = self.replica.fork_session().map_err(error)?;
        let transition = candidate
            .install_revision_epoch(
                checkpoint,
                EpochTrust {
                    previous: &previous,
                    root: &root,
                    authority: &self.authority,
                    roster: &self.roster,
                },
            )
            .map_err(error)?;
        let mut runtime = self.runtime.clone();
        runtime.restore(candidate.state().clone()).map_err(error)?;
        self.replica = candidate;
        self.runtime = runtime;
        json(&transition)
    }
}
#[wasm_bindgen]
impl BrowserVault {
    pub fn prepare_revision_document_epoch(
        &self,
        session: &mut BrowserSync,
        review: &BrowserRevisionReview,
        approved_digest: &str,
        consent: bool,
        destructive_consent: bool,
    ) -> Result<BrowserEpoch, JsValue> {
        if !consent {
            return Err(error(
                "explicit signer, permission and shared schema approval required",
            ));
        }
        let previous = session.replica.binding().document.clone();
        let key = self
            .documents
            .get(
                previous
                    .document
                    .as_ref()
                    .ok_or_else(|| error("invalid document"))?,
            )
            .ok_or_else(|| error("document key unavailable"))?;
        if key.context() != &previous {
            return Err(error("document epoch changed"));
        }
        let next = key.rotate().map_err(error)?;
        let root = self.root()?;
        let device = root
            .certify_device(self.device.public().map_err(error)?)
            .map_err(error)?
            .verify(root.context(), &root.authority().map_err(error)?)
            .map_err(error)?;
        let generation = session
            .replica
            .binding()
            .generation
            .checked_add(1)
            .ok_or_else(|| error("generation exhausted"))?;
        let membership = root
            .document_membership(&next, &device, DocumentRole::Write, generation)
            .map_err(error)?;
        let verified = membership
            .verify(
                next.context(),
                root.context().epoch,
                &root.authority().map_err(error)?,
                generation,
            )
            .map_err(error)?;
        let app = review.package.application().application();
        let runtime = session
            .runtime
            .preview_revision(review.package.clone(), &review.trusted)
            .map_err(error)?
            .approve(
                &session.runtime,
                &review.runtime_digest,
                Grants {
                    application: app.id.clone(),
                    revision: app.revision.clone(),
                    capabilities: app.capabilities.clone(),
                },
                destructive_consent,
            )
            .map_err(error)?;
        let prepared = session
            .replica
            .prepare_revision_epoch(
                root,
                next.fork_session(),
                &verified,
                &review.review,
                &authority(approved_digest)?,
                destructive_consent,
            )
            .map_err(error)?;
        if runtime.state() != prepared.replica.state() {
            return Err(error("revision migration mismatch"));
        }
        Ok(BrowserEpoch {
            previous,
            held: root.wrap_held_document(&next).map_err(error)?,
            next_key: Some(next),
            session: Some(BrowserSync {
                replica: prepared.replica,
                runtime,
                membership,
                roster: vec![verified],
                owner_epoch: root.context().epoch,
                authority: root.authority().map_err(error)?,
            }),
            checkpoint: prepared.checkpoint,
            transition: prepared.transition,
            archive: prepared.archive,
        })
    }
}
