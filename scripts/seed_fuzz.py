"""Authored public corpus only; never use user packages/state as fuzz seeds."""
from pathlib import Path
import json
import shutil
import struct

root = Path(__file__).resolve().parent.parent
for target in ("signed_package", "strict_json", "runtime_transaction"):
    (root / "fuzz/corpus" / target).mkdir(parents=True, exist_ok=True)
(root / "fuzz/corpus-seeds").mkdir(exist_ok=True)
for selector, name in enumerate(("runtime", "widgets", "visuals")):
    source = root / f"artifacts/controls/{name}.need"
    payload = source.read_bytes()
    shutil.copyfile(source, root / f"fuzz/corpus-seeds/{name}.need")
    shutil.copyfile(source, root / f"fuzz/corpus/signed_package/{name}.need")
    manifest_length, ir_length = struct.unpack_from("<II", payload, 10)
    ir = payload[20 + manifest_length:20 + manifest_length + ir_length]
    application = json.loads(ir)
    state = {"revision": application["revision"], "values": application["state"],
             "collections": {collection: {} for collection in application["collections"]}}
    encoded = json.dumps(state, separators=(",", ":")).encode()
    (root / f"fuzz/corpus/strict_json/{name}-ir").write_bytes(ir)
    (root / f"fuzz/corpus/strict_json/{name}-state").write_bytes(encoded)
    (root / f"fuzz/corpus/runtime_transaction/{name}-state").write_bytes(bytes([selector | 4]) + encoded)
    for action in application["actions"]:
        fields = application.get("event_schema", {}).get(action, {})
        values = {field: application["state"].get(field, {"type":"string","value":"11111111-1111-4111-8111-111111111111" if field=="record_id" else "Authored fuzz seed"}) for field in fields}
        event = {"action": action, "values": values, "now": "2026-10-05T00:00:00.000Z", "timezone": "UTC"}
        (root / f"fuzz/corpus/runtime_transaction/{name}-{action}").write_bytes(bytes([selector]) + json.dumps(event, separators=(",", ":")).encode())
        event["values"] = {}
        (root / f"fuzz/corpus/runtime_transaction/{name}-{action}-empty").write_bytes(bytes([selector]) + json.dumps(event, separators=(",", ":")).encode())
for name, content in (("empty", b"{}"), ("duplicate", b'{"revision":"a","revision":"b","values":{},"collections":{}}')):
    (root / f"fuzz/corpus/strict_json/{name}").write_bytes(content)
for index, page in enumerate((("habits", 0), ("habits", 1), ("habits", 100), ("missing", 0), ("habits", 4294967295))):
    (root / f"fuzz/corpus/runtime_transaction/page-{index}").write_bytes(bytes([8]) + json.dumps(page, separators=(",", ":")).encode())
print("Seeded three authored signed fixtures and action/state/page/duplicate-key corpora")
