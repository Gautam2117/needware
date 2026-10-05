#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|bytes: &[u8]| {
    let _ = needware_package::parse_json::<needware_ir::Application>(bytes);
    if let Ok(state) = needware_package::parse_state(bytes) {
        let encoded = serde_json::to_vec(&state).expect("bounded parsed state serializes");
        assert_eq!(needware_package::parse_state(&encoded).ok(), Some(state));
    }
    let _ = needware_package::parse_json::<needware_runtime::Event>(bytes);
});
