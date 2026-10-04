"""Inspect tools without modifying the host or exposing configuration values."""
import shutil
import subprocess
import sys
import os
from pathlib import Path

local_node = Path(__file__).resolve().parents[1] / ".local/node/bin"
if local_node.exists():
    os.environ["PATH"] = str(local_node) + os.pathsep + os.environ.get("PATH", "")

failed = False
for tool, args in [("rustc", ["--version"]), ("cargo", ["--version"]), ("node", ["--version"]), ("pnpm", ["--version"]), ("wasm-bindgen", ["--version"]), ("docker", ["info", "--format", "{{.ServerVersion}}"] )]:
    if not shutil.which(tool):
        print(f"FAIL {tool}: missing")
        failed = True
        continue
    result = subprocess.run([tool, *args], capture_output=True, text=True, timeout=30)
    version = result.stdout.splitlines()[0] if result.stdout else "unavailable"
    ok = result.returncode == 0
    if tool == "node":
        ok = ok and version == "v24.21.0"
    if tool == "pnpm":
        ok = ok and version == "11.5.3"
    if tool == "wasm-bindgen":
        ok = ok and version == "wasm-bindgen 0.2.129"
    if tool == "rustc":
        ok = ok and "1.99.0" in version
    print(f"{'PASS' if ok else 'FAIL'} {tool}: {version}")
    failed |= not ok
target = subprocess.run(["rustup", "target", "list", "--installed"], capture_output=True, text=True) if shutil.which("rustup") else None
ok = target is not None and target.returncode == 0 and "wasm32-unknown-unknown" in target.stdout.splitlines()
print(f"{'PASS' if ok else 'FAIL'} WASM target")
failed |= not ok
sys.exit(int(failed))
