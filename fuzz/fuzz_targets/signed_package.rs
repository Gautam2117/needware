#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|bytes: &[u8]| {
    // Includes binary header/lengths, canonical manifest/IR, embedded raster decode
    // and signatures. Campaign memory/input bounds are set by the runner.
    let _ = needware_package::verify(bytes);
});
