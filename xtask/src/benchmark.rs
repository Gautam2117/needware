use needware_capabilities::Grants;
use needware_ir::{State, Value};
use needware_runtime::{Event, Runtime};
use std::{collections::BTreeMap, hint::black_box, time::Instant};
type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;
fn measure(mut operation: impl FnMut() -> Result, samples: usize) -> Result<serde_json::Value> {
    for _ in 0..3 {
        operation()?;
    }
    let mut times = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        operation()?;
        times.push(start.elapsed().as_nanos());
    }
    times.sort_unstable();
    Ok(
        serde_json::json!({"samples":samples,"unit":"nanoseconds","median":times[samples/2],"p95":times[(samples*95/100).min(samples-1)],"max":times[samples-1]}),
    )
}
pub fn run() -> Result {
    let key = needware_crypto::SecretKey::from_bytes([13; 32]);
    let app = needware_ir::widgets_example::application();
    let bytes = needware_package::build(app.clone(), vec![], &key)?;
    let grants = Grants {
        application: app.id.clone(),
        revision: app.revision.clone(),
        capabilities: app.capabilities.clone(),
    };
    let mut runtime = Runtime::load(
        needware_package::verify(&bytes)?,
        None,
        grants,
        &[key.public_key()],
    )?;
    let state = serde_json::to_vec(&State {
        revision: app.revision,
        values: BTreeMap::from([("payload".into(), Value::String("x".repeat(4 * 1024 * 1024)))]),
        collections: BTreeMap::new(),
    })?;
    let report = serde_json::json!({
        "kind":"local-native-baseline-v1","architecture":std::env::consts::ARCH,"os":std::env::consts::OS,"profile":if cfg!(debug_assertions){"debug"}else{"release"},
        "limitations":"Local native timings only. No production capacity, browser/device latency, SLA or network load claim.",
        "signed_package_bytes":bytes.len(),"strict_state_bytes":state.len(),
        "verify_signed_widgets":measure(||{black_box(needware_package::verify(black_box(&bytes))?);Ok(())},100)?,
        "project_typed_widgets":measure(||{black_box(runtime.view()?);Ok(())},100)?,
        "strict_decode_four_mib_state":measure(||{black_box(needware_package::parse_state(black_box(&state))?);Ok(())},30)?,
        "dispatch_valid_typed_action":measure(||{black_box(runtime.dispatch(&Event{action:"change_name".into(),values:BTreeMap::new(),now:"2026-10-05T00:00:00.000Z".into(),timezone:"UTC".into()})?);Ok(())},100)?,
    });
    std::fs::create_dir_all("artifacts/benchmarks")?;
    std::fs::write(
        "artifacts/benchmarks/native-baseline.json",
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    println!("Native baseline saved: artifacts/benchmarks/native-baseline.json");
    Ok(())
}
