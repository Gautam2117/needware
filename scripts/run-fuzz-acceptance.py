"""Bounded AddressSanitizer campaigns against authored public corpus only."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("--seconds", type=int, default=60)
args = parser.parse_args()
if not 1 <= args.seconds <= 3600:
    parser.error("seconds must be between 1 and 3600")
root = Path(__file__).resolve().parent.parent
os.chdir(root)
subprocess.run(["cargo", "run", "-p", "xtask", "--", "controls-fixture"], check=True)
subprocess.run(["python3", "scripts/seed_fuzz.py"], check=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
Path(".logs").mkdir(exist_ok=True)
reports = []
for target in ("signed_package", "strict_json", "runtime_transaction"):
    command = ["cargo", "+nightly-2026-10-04", "fuzz", "run", target, "--",
               f"-max_total_time={args.seconds}", "-max_len=1048576", "-timeout=5",
               "-rss_limit_mb=1024", "-seed=2117"]
    log = Path(f".logs/fuzz-{stamp}-{target}.log")
    start = time.monotonic()
    with log.open("x") as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    text = log.read_text(errors="replace")
    runs = re.findall(r"Done (\d+) runs in (\d+) second", text)
    rss = re.findall(r"rss: (\d+)Mb", text)
    report = {"target": target, "status": "PASS" if result.returncode == 0 and runs and int(runs[-1][0]) > 0 else "FAIL",
              "exit_code": result.returncode, "elapsed_seconds": round(time.monotonic()-start, 2),
              "executions": int(runs[-1][0]) if runs else None,
              "reported_peak_rss_mib": max(map(int, rss)) if rss else None, "log": str(log)}
    reports.append(report)
    print(f"{report['status']} {target}: {report['executions']} executions; log={log}")
    if report["status"] != "PASS":
        break
Path("artifacts/fuzz").mkdir(parents=True, exist_ok=True)
Path("artifacts/fuzz/acceptance.json").write_text(json.dumps({
    "kind": "bounded-native-address-sanitizer-v1", "toolchain": "nightly-2026-10-04",
    "cargo_fuzz": "0.13.2", "seconds_per_target": args.seconds, "max_input_bytes": 1048576,
    "per_input_timeout_seconds": 5, "rss_limit_mib": 1024, "seed": 2117,
    "limitations": "Bounded local campaigns; not a security audit or proof of absence of vulnerabilities. IR/state production bounds retain separate native boundary tests.",
    "targets": reports,
}, indent=2)+"\n")
raise SystemExit(0 if len(reports)==3 and all(report["status"]=="PASS" for report in reports) else 1)
