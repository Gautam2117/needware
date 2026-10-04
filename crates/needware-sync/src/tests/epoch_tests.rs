use super::*;
use needware_vault::DocumentMembership;

#[test]
fn accepted_root_epoch_requires_both_pins_and_excludes_old_root_holders() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read, DocumentRole::Write])?;
    create(&mut world.clients[0], "Before owner device revocation")?;
    let previous = world.clients[0].binding().clone();
    let old_frames = world.clients[0].export(&BTreeSet::new())?;
    for frame in &old_frames {
        world.clients[2].receive(frame, &world.roster)?;
    }
    let root = world.owner.rotate()?;
    let rotation = world.owner.accepted_rotation_to(&root)?;
    let key = world.key.rotate()?;
    let grant = |index: usize, role| -> TestResult<VerifiedMembership> {
        let recipient = root
            .certify_device(world.clients[index].device.public()?)?
            .verify(root.context(), &root.authority()?)?;
        Ok(root
            .document_membership(&key, &recipient, role, 2)?
            .verify(key.context(), 2, &root.authority()?, 2)?)
    };
    let owner_grant = grant(0, DocumentRole::Write)?;
    let retained_grant = grant(1, DocumentRole::Read)?;
    assert!(
        world.clients[0]
            .prepare_epoch(&root, key.fork_session(), &owner_grant, true)
            .is_err()
    );
    let prepared = world.clients[0].prepare_root_epoch(
        &root,
        &rotation,
        key.fork_session(),
        &owner_grant,
        true,
    )?;
    assert!(world.clients[0].matches_root_epoch_cut(&prepared.transition, &rotation)?);
    assert!(
        world.clients[0]
            .matches_epoch_cut(&prepared.transition)
            .is_err()
    );
    create(
        &mut world.clients[2],
        "Revoked offline work outside the cut",
    )?;
    assert!(!world.clients[2].matches_root_epoch_cut(&prepared.transition, &rotation)?);
    let mut retained = receiver(&world, &key, &retained_grant, 1)?;
    let roster = [owner_grant, retained_grant];
    let trust = || EpochTrust {
        previous: &previous,
        root: root.context(),
        authority: &prepared.transition.authority,
        roster: &roster,
    };
    assert!(
        retained
            .install_epoch(&prepared.checkpoint, trust())
            .is_err()
    );
    assert!(retained.known().is_empty());
    let wrong = [0; 32];
    assert!(
        retained
            .install_root_epoch(
                &prepared.checkpoint,
                RootEpochTrust {
                    epoch: trust(),
                    previous_root: world.owner.context(),
                    previous_authority: &wrong
                }
            )
            .is_err()
    );
    assert!(retained.known().is_empty());
    retained.install_root_epoch(
        &prepared.checkpoint,
        RootEpochTrust {
            epoch: trust(),
            previous_root: world.owner.context(),
            previous_authority: &world.owner.authority()?,
        },
    )?;
    assert_eq!(retained.state(), world.clients[0].state());
    let mut recovered = receiver(&world, &key, &roster[1], 1)?;
    recovered.install_accepted_root_epoch(&prepared.checkpoint, trust())?;
    assert_eq!(recovered.state(), world.clients[0].state());
    assert!(
        retained
            .install_root_epoch(
                &prepared.checkpoint,
                RootEpochTrust {
                    epoch: trust(),
                    previous_root: world.owner.context(),
                    previous_authority: &world.owner.authority()?
                }
            )
            .is_err()
    );
    assert!(
        world
            .key
            .open(&prepared.checkpoint, b"needware owner epoch checkpoint v1")
            .is_err()
    );
    let held = root.wrap_held_document(&key)?;
    assert!(
        world
            .owner
            .unwrap_held_document(&held, key.context())
            .is_err()
    );
    assert!(retained.receive(&old_frames[0], &world.roster).is_err());
    let plaintext = key.open(&prepared.checkpoint, b"needware owner epoch checkpoint v1")?;
    let mut checkpoint: EpochCheckpoint = serde_json::from_slice(&plaintext)?;
    checkpoint
        .root_rotation
        .as_mut()
        .ok_or("rotation")?
        .acceptance[0] ^= 1;
    let altered = key.seal(
        &wire::canonical(&checkpoint)?,
        b"needware owner epoch checkpoint v1",
    )?;
    let mut fresh = receiver(&world, &key, &roster[1], 1)?;
    assert!(
        fresh
            .install_accepted_root_epoch(&altered, trust())
            .is_err()
    );
    assert!(fresh.known().is_empty());
    assert!(
        fresh
            .install_root_epoch(
                &altered,
                RootEpochTrust {
                    epoch: trust(),
                    previous_root: world.owner.context(),
                    previous_authority: &world.owner.authority()?
                }
            )
            .is_err()
    );
    assert!(fresh.known().is_empty());
    Ok(())
}

#[test]
fn previously_verified_grants_do_not_cross_the_current_root_authority() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read])?;
    create(&mut world.clients[0], "Old authority write")?;
    let frame = world.clients[0].export(&BTreeSet::new())?.remove(0);
    let next_root = world.owner.rotate()?;
    let device = next_root
        .certify_device(world.clients[1].device.public()?)?
        .verify(next_root.context(), &next_root.authority()?)?;
    let membership = next_root
        .document_membership(&world.key, &device, DocumentRole::Read, 1)?
        .verify(world.key.context(), 2, &next_root.authority()?, 1)?;
    let mut receiver = Replica::new(
        app()?,
        world.clients[0].scope.clone(),
        world.key.fork_session(),
        world.clients[1].device.fork_session(),
        &membership,
        1,
    )?;
    let before = receiver.state().clone();
    assert!(receiver.receive(&frame, &world.roster).is_err());
    assert_eq!(receiver.state(), &before);
    assert!(receiver.known().is_empty());
    Ok(())
}

fn next_grant(
    world: &World,
    key: &DocumentKey,
    index: usize,
    role: DocumentRole,
) -> TestResult<VerifiedMembership> {
    let public = world.clients[index].device.public()?;
    let device = world
        .owner
        .certify_device(public)?
        .verify(world.owner.context(), &world.owner.authority()?)?;
    Ok(world
        .owner
        .document_membership(key, &device, role, 2)?
        .verify(
            key.context(),
            world.owner.context().epoch,
            &world.owner.authority()?,
            2,
        )?)
}
fn receiver(
    world: &World,
    key: &DocumentKey,
    grant: &VerifiedMembership,
    index: usize,
) -> TestResult<Replica> {
    Ok(Replica::new(
        app()?,
        world.clients[0].scope.clone(),
        key.fork_session(),
        world.clients[index].device.fork_session(),
        grant,
        1,
    )?)
}
#[test]
fn owner_epoch_compacts_preserves_archive_and_rejects_revoked_keys_offline_changes() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read, DocumentRole::Write])?;
    create(&mut world.clients[0], "Original owner write")?;
    let frames = world.clients[0].export(&BTreeSet::new())?;
    for frame in &frames {
        world.clients[2].receive(frame, &world.roster)?;
    }
    let mut state = world.clients[2].state().clone();
    state
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .get_mut(RECORD)
        .ok_or("record")?
        .insert(
            "name".into(),
            Value::String("Original collaborator write".into()),
        );
    materialize(&world.clients[2], &mut state)?;
    world.clients[2].commit_state(state)?;
    let known = world.clients[0].known();
    for frame in world.clients[2].export(&known)? {
        world.clients[0].receive(&frame, &world.roster)?;
    }
    for index in 0..30 {
        let mut state = world.clients[0].state().clone();
        state
            .collections
            .get_mut("habits")
            .ok_or("collection")?
            .get_mut(RECORD)
            .ok_or("record")?
            .insert("done".into(), Value::Boolean(index % 2 == 0));
        world.clients[0].commit_state(state)?;
    }
    let mut local = world.clients[0].state().clone();
    local.values.insert(
        "private_local".into(),
        Value::String("Never copy owner local secret".into()),
    );
    world.clients[0].commit_state(local)?;
    let before = world.clients[0].state().clone();
    let old_binding = world.clients[0].binding().clone();
    let old_history = world.clients[0].history_digest()?;
    let key = world.key.rotate()?;
    let writer = next_grant(&world, &key, 0, DocumentRole::Write)?;
    let reader = next_grant(&world, &key, 1, DocumentRole::Read)?;
    assert!(
        world.clients[0]
            .prepare_epoch(&world.owner, key.fork_session(), &writer, false)
            .is_err()
    );
    assert_eq!(world.clients[0].state(), &before);
    let prepared =
        world.clients[0].prepare_epoch(&world.owner, key.fork_session(), &writer, true)?;
    assert_eq!(prepared.replica.state(), &before);
    assert!(prepared.replica.known().len() < world.clients[0].known().len());
    assert_eq!(prepared.transition.digests.history, old_history);
    assert!(world.clients[0].matches_epoch_cut(&prepared.transition)?);
    assert!(!world.clients[2].matches_epoch_cut(&prepared.transition)?);
    assert!(
        world
            .key
            .open(&prepared.checkpoint, b"needware owner epoch checkpoint v1")
            .is_err()
    );
    let mut fresh = receiver(&world, &key, &reader, 1)?;
    let roster = [writer.clone(), reader];
    fresh.install_epoch(
        &prepared.checkpoint,
        EpochTrust {
            previous: &old_binding,
            root: world.owner.context(),
            authority: &world.owner.authority()?,
            roster: &roster,
        },
    )?;
    assert_eq!(fresh.state().collections, before.collections);
    assert_eq!(
        fresh.state().values["private_local"],
        Value::String("local default".into())
    );
    let mut changed = fresh.state().clone();
    changed
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .clear();
    assert!(fresh.commit_state(changed).is_err());
    for frame in world.clients[2].export(&BTreeSet::new())? {
        assert!(fresh.receive(&frame, &world.roster).is_err());
    }
    let snapshot = fresh.state().clone();
    let mut corrupted = prepared.checkpoint.clone();
    corrupted[50] ^= 1;
    let mut unopened = receiver(&world, &key, &roster[1], 1)?;
    let empty = unopened.state().clone();
    assert!(
        unopened
            .install_epoch(
                &corrupted,
                EpochTrust {
                    previous: &old_binding,
                    root: world.owner.context(),
                    authority: &world.owner.authority()?,
                    roster: &roster
                }
            )
            .is_err()
    );
    assert_eq!(unopened.state(), &empty);
    assert_eq!(fresh.state(), &snapshot);
    // Original collaborator signatures remain recoverable with the historical
    // key/roster; compaction does not claim the owner authored their old work.
    let mut archived = Replica::new(
        app()?,
        world.clients[0].scope.clone(),
        world.key.fork_session(),
        world.clients[1].device.fork_session(),
        &world.roster[1],
        1,
    )?;
    for frame in &prepared.archive {
        archived.receive(frame, &world.roster)?;
    }
    assert_eq!(archived.state().collections, before.collections);
    assert_eq!(archived.history_digest()?, old_history);
    assert!(archived.matches_epoch_cut(&prepared.transition)?);
    Ok(())
}
#[test]
fn checkpoint_installs_large_baseline_atomically_and_retains_delete_tombstones() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read])?;
    create(&mut world.clients[0], "Deleted before compaction")?;
    let mut state = world.clients[0].state().clone();
    state
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .remove(RECORD);
    world.clients[0].commit_state(state)?;
    for index in 0..220 {
        let mut state = world.clients[0].state().clone();
        state
            .collections
            .get_mut("habits")
            .ok_or("collection")?
            .insert(
                uuid::Uuid::new_v4().to_string(),
                BTreeMap::from([
                    ("name".into(), Value::String(format!("Record {index}"))),
                    ("done".into(), Value::Boolean(false)),
                ]),
            );
        materialize(&world.clients[0], &mut state)?;
        world.clients[0].commit_state(state)?;
    }
    let before = world.clients[0].state().clone();
    let key = world.key.rotate()?;
    let writer = next_grant(&world, &key, 0, DocumentRole::Write)?;
    let reader = next_grant(&world, &key, 1, DocumentRole::Read)?;
    let prepared =
        world.clients[0].prepare_epoch(&world.owner, key.fork_session(), &writer, true)?;
    assert!(prepared.replica.known().len() > 1);
    let old_binding = world.clients[0].binding().clone();
    let roster = [writer, reader.clone()];
    let mut fresh = receiver(&world, &key, &reader, 1)?;
    fresh.install_epoch(
        &prepared.checkpoint,
        EpochTrust {
            previous: &old_binding,
            root: world.owner.context(),
            authority: &world.owner.authority()?,
            roster: &roster,
        },
    )?;
    assert_eq!(fresh.state().collections, before.collections);
    let mut owner = prepared.replica;
    assert!(create(&mut owner, "Forbidden tombstone resurrection").is_err());
    assert_eq!(owner.state(), &before);
    Ok(())
}
#[test]
fn transition_pins_owner_context_generations_baseline_and_binding() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read])?;
    create(&mut world.clients[0], "Pinned")?;
    let key = world.key.rotate()?;
    let writer = next_grant(&world, &key, 0, DocumentRole::Write)?;
    let reader = next_grant(&world, &key, 1, DocumentRole::Read)?;
    let prepared =
        world.clients[0].prepare_epoch(&world.owner, key.fork_session(), &writer, true)?;
    let transition = prepared.transition.clone();
    let authority = world.owner.authority()?;
    transition.verify(
        world.key.context(),
        1,
        world.owner.context(),
        &authority,
        &transition.digests.previous_binding,
    )?;
    assert!(
        transition
            .verify(
                key.context(),
                2,
                world.owner.context(),
                &authority,
                &transition.digests.next_binding
            )
            .is_err()
    );
    for field in ["history", "baseline", "previous_binding", "next_binding"] {
        let mut altered = transition.clone();
        match field {
            "history" => altered.digests.history[0] ^= 1,
            "baseline" => altered.digests.baseline[0] ^= 1,
            "previous_binding" => altered.digests.previous_binding[0] ^= 1,
            _ => altered.digests.next_binding[0] ^= 1,
        }
        assert!(
            altered
                .verify(
                    world.key.context(),
                    1,
                    world.owner.context(),
                    &authority,
                    &transition.digests.previous_binding
                )
                .is_err()
        );
    }
    let other = AccountVault::create(&uuid::Uuid::new_v4().to_string())?;
    assert!(
        world.clients[0]
            .prepare_epoch(&other, key.fork_session(), &writer, true)
            .is_err()
    );
    assert!(
        world.clients[1]
            .prepare_epoch(&world.owner, key.fork_session(), &reader, true)
            .is_err()
    );
    let device = world
        .owner
        .certify_device(world.clients[0].device.public()?)?
        .verify(world.owner.context(), &authority)?;
    let wrong: DocumentMembership =
        world
            .owner
            .document_membership(&key, &device, DocumentRole::Write, 3)?;
    let wrong = wrong.verify(key.context(), 1, &authority, 3)?;
    assert!(
        world.clients[0]
            .prepare_epoch(&world.owner, key.fork_session(), &wrong, true)
            .is_err()
    );
    Ok(())
}
