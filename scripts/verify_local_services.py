"""Actual local database/mail persistence checks, never delivery to real recipients."""
from pathlib import Path
from email.message import EmailMessage
import hashlib
import json
import os
import shutil
import smtplib
import subprocess
import sys
import urllib.request
import uuid

root = Path(__file__).resolve().parents[1]
os.chdir(root)
config = root / ".local/dev.env"
before = hashlib.sha256(config.read_bytes()).digest()
subprocess.run([sys.executable, "scripts/bootstrap.py"], check=True)
assert before == hashlib.sha256(config.read_bytes()).digest(), "bootstrap replaced local secrets"
assert config.stat().st_mode & 0o077 == 0, "local secrets permissions"
compose = (["docker-compose"] if shutil.which("docker-compose") else ["docker", "compose"]) + ["--project-name", "needware-dev", "--env-file", str(config), "-f", "infra/compose.dev.yaml"]
def sql(query):
    # PostgreSQL's maintained client reads the existing container password from
    # its environment. The secret never enters command arguments or output.
    result = subprocess.run(compose + ["exec", "-T", "postgres", "sh", "-c", 'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U needware -d needware -v ON_ERROR_STOP=1 -At'], input=query, capture_output=True, text=True, check=True)
    return result.stdout.strip()
token = str(uuid.uuid4())
assert sql("SHOW server_version;").startswith("18.6"), "database version drift"
sql("CREATE TABLE IF NOT EXISTS needware_dev_probe(id UUID PRIMARY KEY);")
sql(f"INSERT INTO needware_dev_probe VALUES ('{token}');")
message = EmailMessage()
message["From"] = "needware-test@example.invalid"
message["To"] = "needware-test@example.invalid"
message["Subject"] = f"Needware local persistence fixture {token}"
message.set_content("Authored local mail fixture. No real verification or external delivery.")
with smtplib.SMTP("127.0.0.1", 51025, timeout=10) as smtp:
    smtp.send_message(message)
def captured():
    with urllib.request.urlopen("http://127.0.0.1:58025/api/v1/messages", timeout=10) as response:
        payload = json.load(response)
    return any(m.get("Subject") == message["Subject"] for m in payload["messages"])
assert captured(), "local SMTP capture failed"
subprocess.run(compose + ["restart", "postgres", "mailpit"], check=True)
subprocess.run(compose + ["up", "-d", "--wait", "--wait-timeout", "90"], check=True)
assert sql(f"SELECT count(*) FROM needware_dev_probe WHERE id='{token}';") == "1", "database restart lost data"
assert captured(), "mail restart lost capture"
sql(f"DELETE FROM needware_dev_probe WHERE id='{token}';")
print("PASS PostgreSQL 18.6 authenticated client, durable restart, local SMTP capture/restart, idempotent bootstrap and private secrets")
print("This is dependency evidence, not implemented account authentication or real email delivery.")
