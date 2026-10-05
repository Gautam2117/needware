use super::*;
use needware_ir::{Migration, MigrationOp};
use needware_package::{VerifiedPackage, build, verify};
fn package(app: Application) -> TestResult<VerifiedPackage> {
    Ok(verify(&build(
        app,
        vec![],
        &needware_crypto::SecretKey::from_bytes([29; 32]),
    )?)?)
}
fn packages(
    replica: &Replica,
    destructive: bool,
) -> TestResult<(VerifiedPackage, VerifiedPackage)> {
    let source = package(replica.app.application().clone())?;
    let mut target = replica.app.application().clone();
    target.revision = uuid::Uuid::new_v4().to_string();
    target.parent = Some(source.digest());
    let operations = if destructive {
        vec![MigrationOp::Transform {
            collection: "habits".into(),
            field: "done".into(),
            value: Expr::Literal {
                value: Value::Boolean(true),
            },
        }]
    } else {
        target
            .collections
            .get_mut("habits")
            .ok_or("schema")?
            .fields
            .insert(
                "score".into(),
                Field {
                    data_type: DataType::Integer,
                    default: Some(Value::Integer("0".into())),
                    max_length: None,
                    minimum: None,
                    maximum: None,
                    derived: None,
                },
            );
        vec![MigrationOp::AddField {
            collection: "habits".into(),
            field: "score".into(),
            default: Value::Integer("0".into()),
        }]
    };
    target.migrations = vec![Migration {
        from_revision: replica.binding.revision.clone(),
        operations,
    }];
    Ok((source, package(target)?))
}
fn grant(
    world: &World,
    key: &DocumentKey,
    index: usize,
    role: DocumentRole,
) -> TestResult<VerifiedMembership> {
    let certificate = world
        .owner
        .certify_device(world.clients[index].device.public()?)?
        .verify(world.owner.context(), &world.owner.authority()?)?;
    Ok(world
        .owner
        .document_membership(key, &certificate, role, 2)?
        .verify(
            key.context(),
            world.owner.context().epoch,
            &world.owner.authority()?,
            2,
        )?)
}
#[test]
fn revision_review_rejects_changed_history_even_when_visible_state_matches() -> TestResult {
    let mut world = world(&[DocumentRole::Write])?;
    create(&mut world.clients[0], "Original")?;
    let (source, target) = packages(&world.clients[0], false)?;
    let scope = world.clients[0].scope.clone();
    let review = world.clients[0].review_revision(&source, &target, target.signers(), scope)?;
    let before = world.clients[0].state().clone();
    let before_history = world.clients[0].history_digest()?;
    update(
        &mut world.clients[0],
        "name",
        Value::String("Temporary".into()),
    )?;
    update(
        &mut world.clients[0],
        "name",
        Value::String("Original".into()),
    )?;
    assert_eq!(world.clients[0].state(), &before);
    assert_ne!(world.clients[0].history_digest()?, before_history);
    let history = world.clients[0].history_digest()?;
    let key = world.key.rotate()?;
    let writer = grant(&world, &key, 0, DocumentRole::Write)?;
    assert!(
        world.clients[0]
            .prepare_revision_epoch(&world.owner, key, &writer, &review, &review.digest(), true)
            .is_err()
    );
    assert_eq!(world.clients[0].state(), &before);
    assert_eq!(world.clients[0].history_digest()?, history);
    Ok(())
}
#[test]
fn reviewed_schema_epoch_preserves_source_and_requires_fresh_key_and_explicit_installer()
-> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read])?;
    create(&mut world.clients[0], "Before migration")?;
    let before = world.clients[0].state().clone();
    let binding = world.clients[0].binding().clone();
    let (source, target) = packages(&world.clients[0], false)?;
    let trusted = target.signers().to_vec();
    assert!(
        world.clients[0]
            .review_revision(&source, &target, &[], world.clients[0].scope.clone())
            .is_err()
    );
    assert!(
        world.clients[1]
            .review_revision(&source, &target, &trusted, world.clients[1].scope.clone())
            .is_err()
    );
    let review = world.clients[0].review_revision(
        &source,
        &target,
        &trusted,
        world.clients[0].scope.clone(),
    )?;
    let key = world.key.rotate()?;
    let writer = grant(&world, &key, 0, DocumentRole::Write)?;
    let reader = grant(&world, &key, 1, DocumentRole::Read)?;
    assert!(
        world.clients[0]
            .prepare_revision_epoch(
                &world.owner,
                key.fork_session(),
                &writer,
                &review,
                &[0; 32],
                true
            )
            .is_err()
    );
    let prepared = world.clients[0].prepare_revision_epoch(
        &world.owner,
        key.fork_session(),
        &writer,
        &review,
        &review.digest(),
        false,
    )?;
    assert_eq!(world.clients[0].state(), &before);
    assert_eq!(world.clients[0].binding(), &binding);
    assert_eq!(prepared.replica.binding.schema_epoch, 2);
    assert_eq!(
        prepared.replica.state().collections["habits"][RECORD]["score"],
        Value::Integer("0".into())
    );
    assert!(
        world
            .key
            .open(&prepared.checkpoint, b"needware owner epoch checkpoint v1")
            .is_err()
    );
    let mut peer = Replica::new(
        target.application().clone(),
        review.scope.clone(),
        key.fork_session(),
        world.clients[1].device.fork_session(),
        &reader,
        2,
    )?;
    let authority = world.owner.authority()?;
    let roster = [writer, reader];
    let trust = || EpochTrust {
        previous: &binding,
        root: world.owner.context(),
        authority: &authority,
        roster: &roster,
    };
    assert!(peer.install_epoch(&prepared.checkpoint, trust()).is_err());
    assert!(peer.known().is_empty());
    peer.install_revision_epoch(&prepared.checkpoint, trust())?;
    assert_eq!(peer.state(), prepared.replica.state());
    update(
        &mut world.clients[0],
        "name",
        Value::String("Stale offline edit".into()),
    )?;
    assert!(
        world.clients[0]
            .prepare_revision_epoch(
                &world.owner,
                key.fork_session(),
                &roster[0],
                &review,
                &review.digest(),
                true
            )
            .is_err()
    );
    assert!(!world.clients[0].matches_epoch_cut(&prepared.transition)?);
    assert_eq!(
        world.clients[0].state().collections["habits"][RECORD]["name"],
        Value::String("Stale offline edit".into())
    );
    for frame in world.clients[0].export(&BTreeSet::new())? {
        assert!(peer.receive(&frame, &world.roster).is_err());
    }
    Ok(())
}
#[test]
fn synchronized_destructive_migration_and_parent_are_review_bound() -> TestResult {
    let mut world = world(&[DocumentRole::Write])?;
    create(&mut world.clients[0], "Consent")?;
    let (source, target) = packages(&world.clients[0], true)?;
    let review = world.clients[0].review_revision(
        &source,
        &target,
        target.signers(),
        world.clients[0].scope.clone(),
    )?;
    assert!(review.report().requires_confirmation);
    let key = world.key.rotate()?;
    let writer = grant(&world, &key, 0, DocumentRole::Write)?;
    assert!(
        world.clients[0]
            .prepare_revision_epoch(
                &world.owner,
                key.fork_session(),
                &writer,
                &review,
                &review.digest(),
                false
            )
            .is_err()
    );
    let cut = world.clients[0].prepare_revision_epoch(
        &world.owner,
        key,
        &writer,
        &review,
        &review.digest(),
        true,
    )?;
    assert_eq!(
        cut.replica.state().collections["habits"][RECORD]["done"],
        Value::Boolean(true)
    );
    assert_eq!(
        world.clients[0].state().collections["habits"][RECORD]["done"],
        Value::Boolean(false)
    );
    let mut wrong = target.application().application().clone();
    wrong.parent = None;
    let wrong = package(wrong)?;
    assert!(
        world.clients[0]
            .review_revision(
                &source,
                &wrong,
                wrong.signers(),
                world.clients[0].scope.clone()
            )
            .is_err()
    );
    Ok(())
}
