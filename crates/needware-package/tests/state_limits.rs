use needware_ir::{State, Value};
use needware_package::{PackageError, parse_json, parse_state};
use std::collections::BTreeMap;
#[test]
fn durable_state_uses_its_own_strict_bounded_json_boundary()
-> Result<(), Box<dyn std::error::Error>> {
    let state = State {
        revision: "713a48d2-4f71-4217-b313-91b5ba9c9711".into(),
        values: BTreeMap::from([(
            "rows".into(),
            Value::List(vec![Value::String("x".repeat(4096)); 1024]),
        )]),
        collections: BTreeMap::new(),
    };
    let bytes = serde_json::to_vec(&state)?;
    assert!(bytes.len() > needware_ir::MAX_IR_BYTES);
    assert!(matches!(
        parse_json::<State>(&bytes),
        Err(PackageError::Limit)
    ));
    assert_eq!(parse_state(&bytes)?, state);
    assert!(matches!(
        parse_state(&vec![b' '; 16 * 1024 * 1024 + 1]),
        Err(PackageError::Limit)
    ));
    assert!(
        parse_state(
            br#"{"revision":"a","revision":"b","screen":"home","values":{},"collections":{}}"#
        )
        .is_err()
    );
    let mut trailing = bytes;
    trailing.extend(b" false");
    assert!(parse_state(&trailing).is_err());
    Ok(())
}
