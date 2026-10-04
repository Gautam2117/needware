#!/usr/bin/env python3
"""Run tools with complete local logs and bounded diagnostic output."""
import argparse
import datetime
import pathlib
import re
import subprocess
import sys
import tempfile

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["run"])
    parser.add_argument("command")
    args = parser.parse_args()
    logs = pathlib.Path(".logs")
    logs.mkdir(exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    with tempfile.NamedTemporaryFile(mode="w", dir=logs, prefix=f"{stamp}-", suffix=".log", delete=False) as stream:
        log = logs / pathlib.Path(stream.name).name
        result = subprocess.run(args.command, shell=True, stdout=stream, stderr=subprocess.STDOUT)
    lines = log.read_text(errors="replace").splitlines()
    print(f"{'PASS' if result.returncode == 0 else 'FAIL'} exit={result.returncode} log={log}")
    if result.returncode:
        first = next((i for i, line in enumerate(lines) if re.search(r'^(?:Error:|AssertionError|.*Error \[|\s*Traceback \()', line)), None)
        if first is not None and first < len(lines) - 18:
            for line in lines[first:first + 8]:
                print(line[:300])
        for line in lines[-18:]:
            print(line[:300])
    else:
        results = [re.search(r'test result: ok\. (\d+) passed', line) for line in lines]
        counts = [int(match.group(1)) for match in results if match]
        if counts:
            print(f"Rust tests: {sum(counts)} passed across {len(counts)} suites")
        useful = [x for x in lines if any(k in x for k in ('passed', 'Finished')) and 'test result:' not in x]
        for line in useful[-4:]:
            print(line[:200])
    return result.returncode

if __name__ == "__main__":
    sys.exit(main())
