use super::*;
use needware_ir::{Application, DataType, Expr, Field, Value};
use needware_vault::{AccountVault, DocumentRole, VerifiedMembership};
use proptest::prelude::*;
type TestResult<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
const RECORD: &str = "fc7c4ce0-9885-4875-9e77-149b16778983";
fn app() -> TestResult<ValidatedApplication> {
    let mut app: Application = needware_ir::examples::typed_habit_tracker();
    app.runtime_features.push("derived_fields_v1".into());
    app.collections
        .get_mut("habits")
        .ok_or("schema")?
        .fields
        .insert(
            "label".into(),
            Field {
                data_type: DataType::String,
                default: None,
                max_length: None,
                minimum: None,
                maximum: None,
                derived: Some(Expr::Concat {
                    values: vec![
                        Expr::Literal {
                            value: Value::String("Habit: ".into()),
                        },
                        Expr::Item {
                            field: "name".into(),
                        },
                    ],
                }),
            },
        );
    // Explicitly local data never appears in encrypted cloud transport either.
    app.state.insert(
        "private_local".into(),
        Value::String("local default".into()),
    );
    app.state_schema.insert(
        "private_local".into(),
        Field {
            data_type: DataType::String,
            default: None,
            max_length: None,
            minimum: None,
            maximum: None,
            derived: None,
        },
    );
    Ok(needware_validation::validate(app)?)
}
struct World {
    owner: AccountVault,
    key: DocumentKey,
    clients: Vec<Replica>,
    roster: Vec<VerifiedMembership>,
}
fn world(roles: &[DocumentRole]) -> TestResult<World> {
    let owner = AccountVault::create(&uuid::Uuid::new_v4().to_string())?;
    let key = owner.create_document(&uuid::Uuid::new_v4().to_string())?;
    let wrapped = owner.wrap_document(&key)?;
    let scope = Scope {
        values: BTreeSet::new(),
        collections: BTreeSet::from(["habits".into()]),
    };
    let mut clients = Vec::new();
    let mut roster = Vec::new();
    for (index, role) in roles.iter().enumerate() {
        let device = DeviceKeys::create()?;
        // Third client is an independent collaborator account, not another owner device.
        let other = AccountVault::create(&uuid::Uuid::new_v4().to_string())?;
        let account = if index == 2 { &other } else { &owner };
        let verified_device = account
            .certify_device(device.public()?)?
            .verify(account.context(), &account.authority()?)?;
        let membership = owner
            .document_membership(&key, &verified_device, *role, 1)?
            .verify(key.context(), owner.context().epoch, &owner.authority()?, 1)?;
        let client_key = owner.unwrap_document(&wrapped, key.context())?;
        clients.push(Replica::new(
            app()?,
            scope.clone(),
            client_key,
            device,
            &membership,
            1,
        )?);
        roster.push(membership);
    }
    Ok(World {
        owner,
        key,
        clients,
        roster,
    })
}
fn create(replica: &mut Replica, name: &str) -> TestResult {
    let mut state = replica.state().clone();
    state
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .insert(
            RECORD.into(),
            BTreeMap::from([
                ("name".into(), Value::String(name.into())),
                ("done".into(), Value::Boolean(false)),
            ]),
        );
    materialize(replica, &mut state)?;
    replica.commit_state(state)?;
    Ok(())
}
fn materialize(replica: &Replica, state: &mut State) -> TestResult {
    needware_validation::derived::materialize(
        replica.app.application(),
        state,
        &mut needware_expr::Budget::new(100_000),
    )?;
    Ok(())
}
fn update(replica: &mut Replica, field: &str, value: Value) -> TestResult {
    let mut state = replica.state().clone();
    state
        .collections
        .get_mut("habits")
        .and_then(|rows| rows.get_mut(RECORD))
        .ok_or("record")?
        .insert(field.into(), value);
    materialize(replica, &mut state)?;
    replica.commit_state(state)?;
    Ok(())
}
fn send(world: &mut World, from: usize, to: usize) -> TestResult<usize> {
    let known = world.clients[to].known();
    let frames = world.clients[from].export(&known)?;
    let mut changes = 0;
    for frame in frames {
        changes += world.clients[to].receive(&frame, &world.roster)?;
    }
    Ok(changes)
}
#[test]
fn independent_devices_and_collaborator_converge_field_edits_offline() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 3])?;
    create(&mut world.clients[0], "Walk")?;
    send(&mut world, 0, 1)?;
    send(&mut world, 0, 2)?;
    update(&mut world.clients[0], "name", Value::String("Run".into()))?;
    update(&mut world.clients[1], "done", Value::Boolean(true))?;
    // No service exists during these writes. Changes are forwarded with original signatures.
    send(&mut world, 1, 2)?;
    send(&mut world, 0, 2)?;
    send(&mut world, 2, 0)?;
    send(&mut world, 2, 1)?;
    assert_eq!(world.clients[0].state(), world.clients[1].state());
    assert_eq!(world.clients[0].state(), world.clients[2].state());
    let record = &world.clients[0].state().collections["habits"][RECORD];
    assert_eq!(record["name"], Value::String("Run".into()));
    assert_eq!(record["done"], Value::Boolean(true));
    assert_eq!(record["label"], Value::String("Habit: Run".into()));
    assert_eq!(send(&mut world, 2, 0)?, 0);
    Ok(())
}
#[test]
fn concurrent_same_field_has_stable_winner_and_delete_wins() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 3])?;
    create(&mut world.clients[0], "Walk")?;
    send(&mut world, 0, 1)?;
    send(&mut world, 0, 2)?;
    update(&mut world.clients[0], "name", Value::String("Run".into()))?;
    update(&mut world.clients[1], "name", Value::String("Swim".into()))?;
    send(&mut world, 0, 1)?;
    send(&mut world, 1, 0)?;
    assert_eq!(world.clients[0].state(), world.clients[1].state());
    let mut deleted = world.clients[2].state().clone();
    deleted
        .collections
        .get_mut("habits")
        .ok_or("collection")?
        .clear();
    world.clients[2].commit_state(deleted)?;
    send(&mut world, 1, 2)?;
    send(&mut world, 2, 0)?;
    send(&mut world, 2, 1)?;
    assert!(
        world
            .clients
            .iter()
            .all(|client| client.state().collections["habits"].is_empty())
    );
    let heads = world.clients[0].heads();
    assert!(create(&mut world.clients[0], "Resurrect").is_err());
    assert_eq!(world.clients[0].heads(), heads);
    Ok(())
}
#[test]
fn same_uuid_concurrent_creates_converge() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 2])?;
    create(&mut world.clients[0], "A")?;
    create(&mut world.clients[1], "B")?;
    send(&mut world, 0, 1)?;
    send(&mut world, 1, 0)?;
    assert_eq!(world.clients[0].state(), world.clients[1].state());
    Ok(())
}
#[test]
fn ciphertext_signatures_read_roles_and_roster_removal_reject_atomically() -> TestResult {
    let mut world = world(&[DocumentRole::Write, DocumentRole::Read])?;
    create(&mut world.clients[0], "Private name")?;
    let frame = world.clients[0].checkpoint()?;
    let serialized = wire::canonical(&frame)?;
    assert!(!String::from_utf8_lossy(&serialized).contains("Private name"));
    let mut damaged = frame.clone();
    damaged.ciphertext[30] ^= 1;
    assert!(world.clients[1].receive(&damaged, &world.roster).is_err());
    assert!(world.clients[1].state().collections["habits"].is_empty());
    assert!(world.clients[1].receive(&frame, &[]).is_err());
    world.clients[1].receive(&frame, &world.roster)?;
    assert!(update(&mut world.clients[1], "done", Value::Boolean(true)).is_err());
    // Possession of the document key lets a reader encrypt but never forge a writer signature.
    let mut forged = world.clients[0]
        .log
        .values()
        .next()
        .ok_or("change")?
        .clone();
    forged.device = world.roster[1].device().id.clone();
    forged.signature = world.clients[1]
        .device
        .sign(&forged.message(world.clients[1].binding())?)?
        .to_vec();
    let attack =
        EncryptedFrame::seal(world.clients[1].binding(), &world.clients[1].key, &[forged])?;
    assert!(world.clients[0].receive(&attack, &world.roster).is_err());
    Ok(())
}
#[test]
fn retry_missing_dependencies_snapshot_restart_and_local_only_state() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 2])?;
    create(&mut world.clients[0], "A")?;
    let initial_known = world.clients[0].known();
    update(&mut world.clients[0], "name", Value::String("B".into()))?;
    let later = world.clients[0].export(&initial_known)?;
    assert!(matches!(
        world.clients[1].receive(&later[0], &world.roster),
        Err(SyncError::MissingDependencies)
    ));
    assert!(world.clients[1].known().is_empty());
    send(&mut world, 0, 1)?;
    let mut local = world.clients[1].state().clone();
    local
        .values
        .insert("private_local".into(), Value::String("Never sync".into()));
    world.clients[1].commit_state(local)?;
    assert_eq!(send(&mut world, 1, 0)?, 0);
    let snapshot = world.clients[1].checkpoint()?;
    let lock = needware_crypto::SecretKey::random()?;
    let public = world.clients[1].device.public()?;
    let stored = world.clients[1].device.lock_local(&lock)?;
    let device = DeviceKeys::unlock_local(&public.id, &stored, &lock)?;
    let key = world
        .owner
        .unwrap_document(&world.owner.wrap_document(&world.key)?, world.key.context())?;
    let mut reopened = Replica::new(
        app()?,
        world.clients[1].scope.clone(),
        key,
        device,
        &world.roster[1],
        1,
    )?;
    reopened.receive(
        &EncryptedFrame::parse(&wire::canonical(&snapshot)?)?,
        &world.roster,
    )?;
    assert_eq!(
        reopened.state().collections,
        world.clients[0].state().collections
    );
    assert_eq!(
        reopened.state().values["private_local"],
        Value::String("local default".into())
    );
    assert_ne!(reopened.doc.get_actor(), world.clients[1].doc.get_actor());
    Ok(())
}
#[test]
fn epoch_context_scope_and_wire_bounds_fail_without_state_changes() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 2])?;
    create(&mut world.clients[0], "A")?;
    let original = world.clients[0].checkpoint()?;
    for field in ["protocol", "epoch", "generation", "revision", "schema"] {
        let mut frame = original.clone();
        match field {
            "protocol" => frame.binding.protocol += 1,
            "epoch" => frame.binding.document.epoch += 1,
            "generation" => frame.binding.generation += 1,
            "revision" => frame.binding.revision.push('x'),
            _ => frame.binding.schema_digest.push('x'),
        }
        assert!(world.clients[1].receive(&frame, &world.roster).is_err());
    }
    assert!(world.clients[1].known().is_empty());
    let invalid = Scope {
        values: BTreeSet::from(["absent".into()]),
        collections: BTreeSet::new(),
    };
    assert!(invalid.validate(app()?.application()).is_err());
    assert!(EncryptedFrame::parse(&vec![0; MAX_FRAME_BYTES + 1]).is_err());
    let duplicate = wire::canonical(&original)?;
    let mut value: serde_json::Value = serde_json::from_slice(&duplicate)?;
    value["unexpected"] = serde_json::Value::Bool(true);
    assert!(EncryptedFrame::parse(&serde_json::to_vec(&value)?).is_err());
    Ok(())
}
#[test]
fn membership_pins_roles_and_generations_are_owner_authenticated() -> TestResult {
    let world = world(&[DocumentRole::Write])?;
    let device = DeviceKeys::create()?;
    let certified = world
        .owner
        .certify_device(device.public()?)?
        .verify(world.owner.context(), &world.owner.authority()?)?;
    let grant = world
        .owner
        .document_membership(&world.key, &certified, DocumentRole::Read, 2)?;
    assert!(
        grant
            .verify(world.key.context(), 1, &world.owner.authority()?, 1)
            .is_err()
    );
    let mut escalated = grant.clone();
    escalated.role = DocumentRole::Write;
    assert!(
        escalated
            .verify(world.key.context(), 1, &world.owner.authority()?, 2)
            .is_err()
    );
    assert!(grant.verify(world.key.context(), 1, &[1; 32], 2).is_err());
    grant.verify(world.key.context(), 1, &world.owner.authority()?, 2)?;
    Ok(())
}
#[test]
fn authenticated_hostile_changes_and_actor_forks_are_rejected() -> TestResult {
    let mut world = world(&[DocumentRole::Write; 2])?;
    create(&mut world.clients[0], "Original")?;
    let original = world.clients[0]
        .doc
        .get_last_local_change()
        .ok_or("change")?;
    for attack in ["derived", "field", "type", "actor", "operation", "hash"] {
        let mut expanded = original.decode();
        let op = expanded
            .operations
            .iter_mut()
            .find(|op| matches!(&op.key, automerge::legacy::Key::Map(key) if key.contains("name")))
            .ok_or("name")?;
        match attack {
            "derived" => {
                if let automerge::legacy::Key::Map(key) = &mut op.key {
                    *key = key.replace("name", "label").into();
                }
            }
            "field" => {
                if let automerge::legacy::Key::Map(key) = &mut op.key {
                    *key = key.replace("name", "unknown").into();
                }
            }
            "type" => {
                op.action = automerge::legacy::OpType::Put(ScalarValue::Str(
                    "{\"type\":\"boolean\",\"value\":true}".into(),
                ))
            }
            "actor" => expanded.actor_id = ActorId::from(vec![7; 48]),
            "operation" => op.action = automerge::legacy::OpType::Increment(5),
            _ => {}
        }
        expanded.hash = None;
        let change = Change::from(expanded);
        let mut signed = wire::SignedChange::create(
            &world.clients[0].binding,
            &world.clients[0].device,
            &change,
        )?;
        if attack == "hash" {
            let mut bad = change.decode();
            bad.hash = Some(ChangeHash([0; 32]));
            signed.change = String::from_utf8(wire::canonical(&bad)?)?;
            signed.signature = world.clients[0]
                .device
                .sign(&signed.message(&world.clients[0].binding)?)?
                .to_vec();
        }
        let frame =
            EncryptedFrame::seal(world.clients[0].binding(), &world.clients[0].key, &[signed])?;
        assert!(
            world.clients[1].receive(&frame, &world.roster).is_err(),
            "accepted {attack}"
        );
        assert!(world.clients[1].known().is_empty());
    }
    send(&mut world, 0, 1)?;
    let before = world.clients[1].state().clone();
    let heads = world.clients[1].heads();
    let mut fork = original.decode();
    if let automerge::legacy::OpType::Put(ScalarValue::Str(value)) = &mut fork.operations[0].action
    {
        *value = "{\"type\":\"boolean\",\"value\":true}".into();
    }
    fork.hash = None;
    let signed = wire::SignedChange::create(
        &world.clients[0].binding,
        &world.clients[0].device,
        &Change::from(fork),
    )?;
    let frame = EncryptedFrame::seal(world.clients[0].binding(), &world.clients[0].key, &[signed])?;
    assert!(world.clients[1].receive(&frame, &world.roster).is_err());
    assert_eq!(world.clients[1].state(), &before);
    assert_eq!(world.clients[1].heads(), heads);
    Ok(())
}
#[test]
fn identity_is_stable_and_separates_accounts_and_instances() -> TestResult {
    let account = uuid::Uuid::new_v4().to_string();
    let app = app()?.application().id.clone();
    let instance = uuid::Uuid::new_v4().to_string();
    let first = Replica::document_id(&account, &app, &instance)?;
    assert_eq!(first, Replica::document_id(&account, &app, &instance)?);
    assert_ne!(
        first,
        Replica::document_id(&account, &app, &uuid::Uuid::new_v4().to_string())?
    );
    assert_ne!(
        first,
        Replica::document_id(&uuid::Uuid::new_v4().to_string(), &app, &instance)?
    );
    Ok(())
}
proptest! {
    #[test]
    fn hostile_wire_never_panics(bytes in prop::collection::vec(any::<u8>(), 0..16384)) {
        let _ = EncryptedFrame::parse(&bytes);
    }
}
proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn signed_hostile_plaintext_never_changes_a_replica(bytes in prop::collection::vec(any::<u8>(), 0..8192)) {
        let checked = (|| -> TestResult<bool> {
            let mut world = world(&[DocumentRole::Write;2])?;
            let mut entry = wire::SignedChange { device: world.roster[0].device().id.clone(),
                change: String::from_utf8_lossy(&bytes).to_string(), operations: 1, signature: vec![] };
            entry.signature = world.clients[0].device.sign(&entry.message(world.clients[0].binding())?)?.to_vec();
            let frame = EncryptedFrame::seal(world.clients[0].binding(), &world.clients[0].key, &[entry])?;
            Ok(world.clients[1].receive(&frame, &world.roster).is_err() && world.clients[1].known().is_empty())
        })();
        prop_assert!(matches!(checked, Ok(true)));
    }
}
