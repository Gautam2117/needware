'use client';
import { useState } from 'react';
import type { RevisionReport } from '../../../packages/browser-host/src/protocol';
export default function RevisionReview({ report, busy, activate, cancel }: { report: RevisionReport; busy: boolean; activate: (destructive: boolean, permissions: boolean) => void; cancel: () => void }) {
  const [destructive, setDestructive] = useState(false);
  const [permissions, setPermissions] = useState(false);
  return <section className="review" aria-labelledby="revision-title">
    <h2 id="revision-title">Review application revision</h2>
    <p>This revision will replace the active definition. A recovery copy of the current package and data will be saved on this device.</p>
    <p>From <code>{report.migration.from_revision}</code> to <code>{report.migration.to_revision}</code></p>
    <ul>{report.migration.impacts.map((impact, index) => <li key={index}>{impact.operation}: {impact.collection}{impact.field ? ` / ${impact.field}` : ''}{impact.previous_field ? ` (previously ${impact.previous_field})` : ''} · {impact.affected_records} records{impact.destructive ? ' · destructive change' : ''}</li>)}</ul>
    {!!report.permissions_added.length && <><p>New or broader permissions:</p><pre>{JSON.stringify(report.permissions_added, null, 2)}</pre><label><input type="checkbox" checked={permissions} onChange={e => setPermissions(e.target.checked)} /> Allow the new permissions for this revision</label></>}
    {!!report.permissions_removed.length && <><p>Permissions being removed:</p><pre>{JSON.stringify(report.permissions_removed, null, 2)}</pre></>}
    {report.migration.requires_confirmation && <label><input type="checkbox" checked={destructive} onChange={e => setDestructive(e.target.checked)} /> I approve these destructive data changes</label>}
    <button disabled={busy || (report.migration.requires_confirmation && !destructive) || (!!report.permissions_added.length && !permissions)} onClick={() => activate(destructive, permissions)}>Activate reviewed revision</button>
    <button disabled={busy} onClick={cancel}>Cancel revision</button>
  </section>;
}
