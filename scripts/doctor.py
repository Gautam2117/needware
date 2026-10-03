"""Inspect tools without modifying the host or exposing configuration values."""
import shutil
import subprocess
import sys

failed = False
for tool, args in [("rustc", ["--version"]), ("cargo", ["--version"]), ("node", ["--version"]), ("pnpm", ["--version"]), ("docker", ["info", "--format", "{{.ServerVersion}}"]), ("gh", ["--version"])]:
    if not shutil.which(tool):
        print(f"FAIL {tool}: missing")
        failed = True
        continue
    result = subprocess.run([tool, *args], capture_output=True, text=True, timeout=30)
    version = result.stdout.splitlines()[0] if result.stdout else "unavailable"
    ok = result.returncode == 0
    if tool == "node":
        ok = ok and version.startswith("v24.")
    if tool == "rustc":
        ok = ok and "1.99.0" in version
    print(f"{'PASS' if ok else 'FAIL'} {tool}: {version}")
    failed |= not ok
sys.exit(int(failed))
