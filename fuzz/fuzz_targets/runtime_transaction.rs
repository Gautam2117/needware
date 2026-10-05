#![no_main]
use libfuzzer_sys::fuzz_target;
use std::sync::OnceLock;
static PACKAGES: OnceLock<[Vec<u8>; 4]> = OnceLock::new();
fuzz_target!(|bytes: &[u8]| {
    if bytes.len() < 2 {
        return;
    }
    let packages = PACKAGES.get_or_init(|| {
        [
            include_bytes!("../corpus-seeds/runtime.need").to_vec(),
            include_bytes!("../corpus-seeds/widgets.need").to_vec(),
            include_bytes!("../corpus-seeds/visuals.need").to_vec(),
            include_bytes!("../corpus-seeds/encrypted-effects.need").to_vec(),
        ]
    });
    let package = needware_package::verify(&packages[usize::from(bytes[0] & 3)])
        .expect("authored signed fuzz fixture");
    let app = package.application().application();
    let grants = needware_capabilities::Grants {
        application: app.id.clone(),
        revision: app.revision.clone(),
        capabilities: app.capabilities.clone(),
    };
    let trusted = package.signers().to_vec();
    let mut runtime = needware_runtime::Runtime::load(package, None, grants, &trusted)
        .expect("trusted authored fixture");
    let before = runtime.state().clone();
    let view = serde_json::to_vec(&runtime.view().expect("initial projected view"))
        .expect("bounded view serializes");
    if bytes[0] & 16 != 0 {
        if let Ok(checkpoint) = std::str::from_utf8(&bytes[1..]) {
            let pending = runtime.effect_checkpoint().expect("empty checkpoint");
            if runtime.restore_effect_checkpoint(checkpoint).is_err() {
                assert_eq!(runtime.effect_checkpoint().ok(), Some(pending));
            }
            assert_eq!(runtime.state(), &before);
            assert_eq!(
                serde_json::to_vec(&runtime.view().expect("restore keeps view")).ok(),
                Some(view)
            );
        }
    } else if bytes[0] & 32 != 0 && bytes[0] & 3 == 3 {
        let requests = runtime
            .dispatch(&needware_runtime::Event {
                action: "copy".into(),
                values: std::collections::BTreeMap::from([(
                    "name".into(),
                    needware_ir::Value::String("Authored effect seed".into()),
                )]),
                now: "2026-10-05T00:00:00.000Z".into(),
                timezone: "UTC".into(),
            })
            .expect("authored typed intent");
        if let Ok(outcome) =
            needware_package::parse_json::<needware_runtime::EffectOutcome>(&bytes[1..])
        {
            let pending = runtime.effect_checkpoint().expect("pending checkpoint");
            let id = &requests[0].id;
            if runtime.complete_effect(id, outcome).is_err() {
                assert_eq!(runtime.state(), &before);
                assert_eq!(runtime.effect_checkpoint().ok(), Some(pending));
                assert_eq!(
                    serde_json::to_vec(&runtime.view().expect("failed outcome keeps view")).ok(),
                    Some(view)
                );
            } else {
                assert!(
                    runtime
                        .complete_effect(
                            id,
                            needware_runtime::EffectOutcome::Failure {
                                code: "replay".into()
                            }
                        )
                        .is_err()
                );
            }
        }
    } else if bytes[0] & 8 != 0 {
        if let Ok((node, offset)) = needware_package::parse_json::<(String, usize)>(&bytes[1..]) {
            let result = runtime.select_page(&node, offset);
            assert_eq!(runtime.state(), &before);
            if result.is_err() {
                assert_eq!(
                    serde_json::to_vec(&runtime.view().expect("rejected page preserves view")).ok(),
                    Some(view)
                );
            }
        }
    } else if bytes[0] & 4 == 0 {
        if let Ok(event) = needware_package::parse_json::<needware_runtime::Event>(&bytes[1..]) {
            if runtime.dispatch(&event).is_err() {
                assert_eq!(runtime.state(), &before);
                assert_eq!(
                    serde_json::to_vec(&runtime.view().expect("rejected event preserves view"))
                        .ok(),
                    Some(view)
                );
            }
        }
    } else if let Ok(state) = needware_package::parse_state(&bytes[1..]) {
        if runtime.restore(state).is_err() {
            assert_eq!(runtime.state(), &before);
            assert_eq!(
                serde_json::to_vec(&runtime.view().expect("rejected restore preserves view")).ok(),
                Some(view)
            );
        }
    }
});
