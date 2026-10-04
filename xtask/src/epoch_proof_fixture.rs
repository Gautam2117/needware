pub fn generate() -> Result<(), Box<dyn std::error::Error>> {
    use needware_capabilities::Capability;
    use needware_sync::{Replica, Scope};
    use needware_vault::{AccountVault, DeviceKeys, DocumentRole};
    use std::collections::BTreeSet;
    // Public protocol vectors only. Random secrets never leave this process.
    let owner = AccountVault::create("3104387e-40ac-4a99-8cc2-7b0f0c3b8977")?;
    let key = owner.create_document("e38ad029-7a89-4e77-a84a-f73bf12995a2")?;
    let device = DeviceKeys::create()?;
    let device_public = device.public()?;
    let recipient = owner
        .certify_device(device_public.clone())?
        .verify(owner.context(), &owner.authority()?)?;
    let grant = owner
        .document_membership(&key, &recipient, DocumentRole::Write, 1)?
        .verify(key.context(), 1, &owner.authority()?, 1)?;
    let mut app = needware_ir::examples::typed_habit_tracker();
    app.capabilities.push(Capability::Storage {
        synchronized: true,
        write: true,
        collections: vec!["habits".into()],
    });
    app.capabilities
        .push(Capability::Collaboration { write: true });
    let scope = Scope {
        values: BTreeSet::new(),
        collections: BTreeSet::from(["habits".into()]),
    };
    let mut replica = Replica::new(
        needware_validation::validate(app)?,
        scope,
        key.fork_session(),
        device,
        &grant,
        1,
    )?;
    let previous = replica.binding().clone();
    let next = key.rotate()?;
    let membership = owner.document_membership(&next, &recipient, DocumentRole::Write, 2)?;
    let verified = membership.verify(next.context(), 1, &owner.authority()?, 2)?;
    let prepared = replica.prepare_epoch(&owner, next, &verified, true)?;
    let rotated = owner.rotate()?;
    let rotation = owner.accepted_rotation_to(&rotated)?;
    let rotated_certificate = rotated.certify_device(device_public.clone())?;
    let rotated_recipient = rotated_certificate.verify(rotated.context(), &rotated.authority()?)?;
    let rotated_approval = serde_json::json!({"certificate": rotated_certificate, "envelope": rotated.enroll_device(&rotated_recipient)?});
    let retained_device = DeviceKeys::create()?;
    let retained_public = retained_device.public()?;
    let retained_previous_certificate = owner.certify_device(retained_public.clone())?;
    let retained_certificate = rotated.certify_device(retained_public)?;
    let retained_recipient =
        retained_certificate.verify(rotated.context(), &rotated.authority()?)?;
    let retained_approval = serde_json::json!({"certificate": retained_certificate, "envelope": rotated.enroll_device(&retained_recipient)?});
    let fixture = serde_json::json!({ "previous": previous, "next": prepared.replica.binding(),
        "root": owner.context(), "authority": owner.authority()?, "transition": prepared.transition,
        "membership": membership, "root_rotation": rotation,
        "previous_certificate": owner.certify_device(device_public)?, "rotated_approval": rotated_approval,
        "retained_previous_certificate": retained_previous_certificate, "retained_approval": retained_approval });
    std::fs::create_dir_all("artifacts")?;
    std::fs::write(
        "artifacts/epoch-proof-fixture.json",
        serde_json::to_vec(&fixture)?,
    )?;
    println!("Public native epoch authorization vectors generated; no secret material exported");
    Ok(())
}
