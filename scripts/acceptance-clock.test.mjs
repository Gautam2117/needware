import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceAcceptanceWindow } from './acceptance-clock.mjs';
const database = 'needware_acceptance_' + 'a'.repeat(32);
test('time adjustment fails closed before any mutation outside the isolated database', async () => {
  const previous = { marker: process.env.NEEDWARE_ACCEPTANCE_DATABASE, url: process.env.DATABASE_URL };
  let mutations = 0;
  const pool = { async query(sql) { if (!sql.startsWith('SELECT')) mutations++; return { rows: [{ name: 'original_needware' }] }; } };
  try {
    delete process.env.NEEDWARE_ACCEPTANCE_DATABASE;
    assert.equal(await advanceAcceptanceWindow(pool, { account: 'fixture' }), false);
    for (const [marker, url] of [[database, `postgres://localhost/original_needware`], [database, `postgres://remote.invalid/${database}`], ['needware', 'postgres://localhost/needware'], [database, `postgres://localhost/${database}`]]) {
      process.env.NEEDWARE_ACCEPTANCE_DATABASE = marker; process.env.DATABASE_URL = url;
      await assert.rejects(advanceAcceptanceWindow(pool, { account: 'fixture' }));
    }
    assert.equal(mutations, 0);
  } finally {
    for (const [key, value] of [['NEEDWARE_ACCEPTANCE_DATABASE', previous.marker], ['DATABASE_URL', previous.url]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
