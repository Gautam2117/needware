"""Scan tracked/worktree source for accidental credentials without printing secrets."""
import pathlib
import re
import subprocess
import sys

paths = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]).decode().split("\0")
patterns = [rb"gh[pousr]_[A-Za-z0-9]{30,}", rb"sk-(?:proj-)?[A-Za-z0-9_-]{32,}", rb"cfsk_[A-Za-z0-9_]{24,}", rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", rb"AKIA[0-9A-Z]{16}"]
errors = []
for name in paths:
    path = pathlib.Path(name)
    if not name or not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
        continue
    if name.startswith(".env") and name != ".env.example":
        errors.append(name)
        continue
    data = path.read_bytes()
    if any(re.search(pattern, data) for pattern in patterns):
        errors.append(name)
if errors:
    print("FAIL credential-pattern scan: " + ", ".join(errors))
    sys.exit(1)
print(f"PASS credential-pattern scan ({len(paths)-1} files; not a security audit)")
