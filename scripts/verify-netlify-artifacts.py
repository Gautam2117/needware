"""Validate packaging only; this is not hosted runtime or production acceptance."""
import hashlib
import json
import pathlib
import zipfile

root = pathlib.Path('apps/web')
manifest = json.loads((root / '.netlify/functions/manifest.json').read_text())
retry = [f for f in manifest['functions'] if f['name'] == 'mail-retry']
assert len(retry) == 1 and retry[0]['schedule'] == '*/15 * * * *'
assert (root / '.netlify/functions/mail-retry.zip').is_file()
billing = [f for f in manifest['functions'] if f['name'] == 'billing-retry']
assert len(billing) == 1 and billing[0]['schedule'] == '*/5 * * * *'
assert (root / '.netlify/functions/billing-retry.zip').is_file()
static = root / '.netlify/static'
assets = ['runtime-worker.js', 'encrypted-worker.js', 'vault-store.js',
          'sync-journal.js', 'relay-client.js', 'root-publication.js', 'frame.js',
          'wasm/needware_wasm.js', 'wasm/needware_wasm_bg.wasm', 'sqlite3.wasm',
          'manifest.webmanifest', 'sw.js']
for name in assets:
    expected = (root / 'public' / name).read_bytes()
    actual = (static / name).read_bytes()
    assert hashlib.sha256(actual).digest() == hashlib.sha256(expected).digest(), name
with zipfile.ZipFile(root / '.netlify/functions/___netlify-server-handler.zip') as archive:
    names = set(archive.namelist())
    handler = archive.read('___netlify-server-handler.mjs').decode()
    for name in ['request-context.cjs', 'tracer.cjs']:
        path = f'apps/web/.netlify/dist/run/handlers/{name}'
        assert f'/var/task/{path}' in handler, name
        assert path in names, name
    assert sum(info.file_size for info in archive.infolist()) < 250 * 1024 * 1024
print('PASS Netlify static asset identity and Lambda handler dependencies; hosted execution UNVERIFIED')
