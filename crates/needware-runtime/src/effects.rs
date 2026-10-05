use super::*;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
pub struct EffectFlow {
    pub output: Field,
    pub success: Action,
    pub failure: Action,
}
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum EffectOutcome {
    Success { value: Value },
    Failure { code: String },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PendingEffect {
    effect: Effect,
    event: Event,
    index: usize,
    cut: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u8,
    package: String,
    scope: String,
    records: Vec<PendingEffect>,
}
impl Runtime {
    pub fn bind_execution_scope(&mut self, scope: &str) -> Result<(), RuntimeError> {
        if scope.is_empty() || scope.len() > 16384 || scope.contains('\0') {
            return Err(RuntimeError::Invalid("invalid execution scope".into()));
        }
        if scope != self.execution_scope && !self.pending_effects.is_empty() {
            return Err(RuntimeError::Invalid(
                "pending effects require review before changing execution scope".into(),
            ));
        }
        self.execution_scope = scope.into();
        Ok(())
    }
    fn effect_cut(&self) -> Result<String, RuntimeError> {
        let bytes = serde_json::to_vec(&(
            "NEEDWARE-EFFECT-CUT-v1",
            self.package.digest(),
            &self.execution_scope,
            &self.state,
        ))
        .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        if bytes.len() > 17 * 1024 * 1024 {
            return Err(RuntimeError::Limit);
        }
        Ok(hex::encode(needware_crypto::digest(&bytes)))
    }
    pub(crate) fn stage_effects(
        &self,
        next: &State,
        event: &Event,
        effects: &[Effect],
    ) -> Result<BTreeMap<String, PendingEffect>, RuntimeError> {
        let mut pending = self.pending_effects.clone();
        if effects.iter().any(|effect| effect.flow.is_some()) {
            if next != &self.state {
                return Err(RuntimeError::Invalid(
                    "external effects cannot commit mixed state changes; use a completion callback"
                        .into(),
                ));
            }
            if serde_json::to_vec(effects)
                .map_err(|error| RuntimeError::Invalid(error.to_string()))?
                .len()
                > 1024 * 1024
            {
                return Err(RuntimeError::Limit);
            }
            let cut = self.effect_cut()?;
            for (index, effect) in effects
                .iter()
                .enumerate()
                .filter(|(_, effect)| effect.flow.is_some())
            {
                pending.insert(
                    effect.id.clone(),
                    PendingEffect {
                        effect: effect.clone(),
                        event: event.clone(),
                        index,
                        cut: cut.clone(),
                    },
                );
            }
            self.encode_effect_checkpoint(&pending)?;
            if pending.len() > 4
                || serde_json::to_vec(&pending)
                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?
                    .len()
                    > 8 * 1024 * 1024
            {
                return Err(RuntimeError::Limit);
            }
        }
        Ok(pending)
    }
    fn encode_effect_checkpoint(
        &self,
        pending: &BTreeMap<String, PendingEffect>,
    ) -> Result<String, RuntimeError> {
        let json = serde_json::to_string(&Checkpoint {
            version: 1,
            package: self.package.digest(),
            scope: self.execution_scope.clone(),
            records: pending.values().cloned().collect(),
        })
        .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        if json.len() > 2 * 1024 * 1024 {
            return Err(RuntimeError::Limit);
        }
        Ok(json)
    }
    pub fn effect_checkpoint(&self) -> Result<String, RuntimeError> {
        self.encode_effect_checkpoint(&self.pending_effects)
    }
    /// Authenticated host journals may restore intents; outcomes never execute here.
    pub fn restore_effect_checkpoint(&mut self, json: &str) -> Result<(), RuntimeError> {
        if json.len() > 2 * 1024 * 1024 || !self.pending_effects.is_empty() {
            return Err(RuntimeError::Limit);
        }
        let checkpoint: Checkpoint = needware_package::parse_json(json.as_bytes())
            .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        if checkpoint.version != 1
            || checkpoint.package != self.package.digest()
            || checkpoint.scope != self.execution_scope
            || checkpoint.records.len() > 4
        {
            return Err(RuntimeError::Invalid(
                "effect checkpoint belongs to another package or scope".into(),
            ));
        }
        let cut = self.effect_cut()?;
        let mut pending = BTreeMap::new();
        for record in checkpoint.records {
            if uuid::Uuid::parse_str(&record.effect.id).is_err()
                || record.effect.flow.is_none()
                || record.cut != cut
                || pending.contains_key(&record.effect.id)
            {
                return Err(RuntimeError::Invalid(
                    "stale or invalid effect checkpoint requires review".into(),
                ));
            }
            let mut proof = self.clone();
            proof.pending_effects.clear();
            let expected = proof.dispatch(&record.event)?;
            let effect = expected
                .get(record.index)
                .ok_or_else(|| RuntimeError::Invalid("invalid effect source".into()))?;
            if effect.capability != record.effect.capability
                || effect.input != record.effect.input
                || effect.flow != record.effect.flow
            {
                return Err(RuntimeError::Invalid(
                    "effect checkpoint disagrees with the verified action".into(),
                ));
            }
            pending.insert(record.effect.id.clone(), record);
        }
        self.pending_effects = pending;
        Ok(())
    }
    pub fn pending_effects(&self) -> Vec<Effect> {
        self.pending_effects
            .values()
            .map(|record| record.effect.clone())
            .collect()
    }
    pub fn discard_effect(&mut self, id: &str) -> Result<(), RuntimeError> {
        if self.pending_effects.remove(id).is_none() {
            return Err(RuntimeError::Invalid(
                "unknown or already completed effect".into(),
            ));
        }
        Ok(())
    }
    pub fn complete_effect(
        &mut self,
        id: &str,
        outcome: EffectOutcome,
    ) -> Result<ViewNode, RuntimeError> {
        let record = self
            .pending_effects
            .get(id)
            .ok_or_else(|| RuntimeError::Invalid("unknown or already completed effect".into()))?
            .clone();
        if record.cut != self.effect_cut()? {
            return Err(RuntimeError::Invalid(
                "effect result is stale; review it against the current state".into(),
            ));
        }
        permission(self.application(), &self.grants, &record.effect.capability)?;
        let flow = record
            .effect
            .flow
            .as_ref()
            .ok_or_else(|| RuntimeError::Invalid("missing completion contract".into()))?;
        let mut event = record.event.clone();
        let callback = match outcome {
            EffectOutcome::Success { value } => {
                needware_validation::validate_value(&value, &flow.output, 0)
                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
                event.values.insert("result".into(), value);
                &flow.success
            }
            EffectOutcome::Failure { code } => {
                if code.is_empty()
                    || code.len() > 64
                    || !code.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                {
                    return Err(RuntimeError::Invalid("invalid effect failure code".into()));
                }
                event.values.insert("error".into(), Value::String(code));
                &flow.failure
            }
        };
        if serde_json::to_vec(&event)
            .map_err(|error| RuntimeError::Invalid(error.to_string()))?
            .len()
            > 1024 * 1024
        {
            return Err(RuntimeError::Limit);
        }
        let mut next = self.state.clone();
        let mut controls = self.controls.clone();
        let mut effects = vec![];
        let mut count = 0;
        let mut budget = Budget::new(1_000_000);
        apply(
            callback,
            self.application(),
            &self.grants,
            &mut next,
            &event,
            &mut effects,
            &mut controls,
            &mut count,
            &mut budget,
            0,
        )?;
        if !effects.is_empty() {
            return Err(RuntimeError::Invalid(
                "completion cannot dispatch another external effect".into(),
            ));
        }
        needware_validation::validate_state(&next, self.application())
            .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        let view = self.view_cut(&next, &controls)?;
        self.state = next;
        self.controls = controls;
        self.pending_effects.remove(id);
        Ok(view)
    }
}
