'use client';
import { useEffect, useRef, useState } from 'react';
import { AccountVaultClient, type DeviceRequest, type EnrollmentFile, type RecoveryFile } from './vault-client';

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}
async function fileValue<T>(file: File | undefined): Promise<T> {
  if (!file || file.size > 16 * 1024) throw new Error('Select a Needware JSON file smaller than 16 KiB');
  return JSON.parse(await file.text()) as T;
}
export default function VaultPanel({ account }: { account: string }) {
  const [client, setClient] = useState<AccountVaultClient>(); const [status, setStatus] = useState('loading');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [label, setLabel] = useState('My browser'); const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<RecoveryFile>(); const [saved, setSaved] = useState(false);
  const [request, setRequest] = useState<DeviceRequest>(); const [approved, setApproved] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true; let cancelled = false; let vault: AccountVaultClient | undefined;
    AccountVaultClient.open(account).then(value => {
      vault = value; if (cancelled) { value.close(); return; }
      setClient(value); setStatus(value.status());
    }).catch(failure => { if (!cancelled) { setError(failure instanceof Error ? failure.message : 'Encrypted account unavailable'); setStatus('error'); } });
    return () => { cancelled = true; active.current = false; vault?.close(); };
  }, [account]);
  async function run(action: () => Promise<void> | void) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : 'Encrypted account operation failed'); }
    finally { if (active.current) { setBusy(false); if (client) setStatus(client.status()); } }
  }
  return <section className="review" aria-label="Encrypted account" style={{ marginTop: 24 }}>
    <h2>Your encrypted account</h2>
    <p>Your browser holds the encryption keys. Keep your recovery file outside this browser; Needware cannot replace it if every trusted device is lost.</p>
    {status === 'loading' && <p role="status">Opening your encrypted account…</p>}
    {status === 'error' && <button onClick={() => location.reload()}>Retry opening encrypted account</button>}
    {client && <>
      {status === 'ready' && <p><a href={`/encrypted#account=${account}`}>Open encrypted applications</a></p>}
      {(status === 'new' || status === 'locked' || status === 'pending') && <label>Encryption device name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required /></label>}
      {status === 'new' && <>
        {!recovery ? <button disabled={busy} onClick={() => run(async () => { setRecovery(await client.prepareRecovery()); })}>Set up encrypted account</button> : <>
          <label>Recovery code<textarea value={recovery.code} readOnly aria-describedby="recovery-warning" /></label>
          <p id="recovery-warning">This file can unlock your encrypted account. Save it privately. Do not send it to Needware or share it with another person.</p>
          <button disabled={busy} onClick={() => download('needware-recovery.json', recovery)}>Download recovery file</button>
          <label><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} /> I saved my recovery file outside this browser</label>
          <button disabled={busy || !saved || !label.trim()} onClick={() => run(async () => {
            await client.create(recovery, label); setRecovery(undefined); setMessage('Encrypted account created. Keep your recovery file safe.');
          })}>Confirm encrypted account setup</button>
        </>}
      </>}
      {status === 'locked' && <>
        <p>This browser needs your recovery file or approval from a trusted device.</p>
        <label>Existing recovery code<textarea value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} /></label>
        <button disabled={busy || !code || !label.trim()} onClick={() => run(async () => { await client.recover(code, label); setCode(''); setMessage('Recovery completed on this browser.'); })}>Recover with code</button>
        <label className="file-label">Recover from saved file<input type="file" accept=".json,application/json" disabled={busy || !label.trim()} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          void run(async () => { await client.recoverFile(await fileValue<RecoveryFile>(file), label); setCode(''); setMessage('Recovery completed on this browser.'); });
        }} /></label>
        <details><summary>Use approval from another device</summary>
          <p>Download this device request, open it on a trusted browser, then bring the encrypted approval file back here. Compare the device identity on both browsers.</p>
          <p>Device identity: <code>{client.deviceId()}</code></p>
          <button disabled={busy} onClick={() => run(() => download('needware-device-request.json', client.deviceRequest()))}>Download device request</button>
          <label className="file-label">Import encrypted device approval<input type="file" accept=".json,application/json" disabled={busy || !label.trim()} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            void run(async () => { await client.enroll(await fileValue<EnrollmentFile>(file), label); setMessage('Trusted device enrollment completed.'); });
          }} /></label>
        </details>
      </>}
      {status === 'pending' && <><p>Keys are safe on this browser. Finish registering this encryption device with your account.</p>
        <button disabled={busy || !label.trim()} onClick={() => run(async () => { await client.registerRecovered(label); setMessage('Encryption device registered.'); })}>Register this browser</button></>}
      {status === 'ready' && <>
        <p role="status">Encryption keys are ready on this browser.</p>
        <h3>Trusted encryption devices</h3>
        {client.devices().map(device => <article className="app-card" key={device.device_id}><strong>{device.label}</strong>
          <p>{device.device_id === client.deviceId() ? 'This browser' : 'Another trusted device'} · <code>{device.device_id}</code></p></article>)}
        <details><summary>Approve another device</summary><p>Only approve a request you created on your other browser. Compare its device identity before downloading the approval.</p>
          <label className="file-label">Open device request<input type="file" accept=".json,application/json" disabled={busy} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = '';
            void run(async () => { setRequest(await fileValue<DeviceRequest>(file)); setApproved(false); });
          }} /></label>
          {request && <><p>Requested device identity: <code>{String(request.device?.id ?? 'Invalid request')}</code></p>
            <label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /> I recognize this device and approve access to my encrypted account</label>
            <button disabled={busy || !approved} onClick={() => run(() => { download('needware-device-approval.json', client.approve(request)); setRequest(undefined); setApproved(false); })}>Download encrypted approval</button></>}
        </details>
      </>}
    </>}
    {message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="notice error">{error}</p>}
  </section>;
}
