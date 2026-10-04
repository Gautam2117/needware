"""Start isolated local dependencies; preserve existing configuration and volumes."""
from pathlib import Path
import os
import secrets
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
os.chdir(root)
local_node = root / ".local/node/bin"
if local_node.exists():
    os.environ["PATH"] = str(local_node) + os.pathsep + os.environ.get("PATH", "")
subprocess.run([sys.executable, "scripts/doctor.py"], check=True)
if shutil.which("docker-compose"):
    compose = ["docker-compose"]
else:
    subprocess.run(["docker", "compose", "version"], check=True)
    compose = ["docker", "compose"]

local = root / ".local"
local.mkdir(exist_ok=True)
config = local / "dev.env"
try:
    fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    if config.is_symlink() or not config.is_file() or config.stat().st_mode & 0o077:
        raise SystemExit("Local secrets must be a regular private file (mode 600); existing content preserved.")
else:
    password = secrets.token_hex(32)
    with os.fdopen(fd, "w") as output:
        output.write(f"NEEDWARE_POSTGRES_PASSWORD={password}\nDATABASE_URL=postgresql://needware:{password}@127.0.0.1:55432/needware\n")
        output.write(f"NEEDWARE_CONTROL_TOKEN={secrets.token_hex(32)}\nBETTER_AUTH_SECRET={secrets.token_hex(32)}\n")
        output.write("SMTP_HOST=127.0.0.1\nSMTP_PORT=51025\n")
if not (root / ".env").exists():
    # Exclusive creation also preserves a file created by another process.
    try:
        with (root / ".env").open("x") as output:
            output.write((root / ".env.example").read_text())
    except FileExistsError:
        pass
subprocess.run(["pnpm", "install", "--frozen-lockfile"], check=True)
command = compose + ["--project-name", "needware-dev", "--env-file", str(config), "-f", "infra/compose.dev.yaml"]
subprocess.run(command + ["config", "--quiet"], check=True)
subprocess.run(command + ["up", "-d", "--wait", "--wait-timeout", "90"], check=True)
print("PASS local dependencies ready: PostgreSQL 127.0.0.1:55432; SMTP 127.0.0.1:51025; mail http://127.0.0.1:58025")
print("Existing configuration and database volumes preserved. Authentication and cloud services remain under implementation.")
