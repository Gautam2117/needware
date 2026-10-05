// Acceptance harness only. Production request handlers never import this module.
export async function advanceAcceptanceWindow(pool, { account, authKeys, threshold = 12 } = {}) {
  const database = process.env.NEEDWARE_ACCEPTANCE_DATABASE;
  if (!database) return false;
  const url = new URL(process.env.DATABASE_URL);
  if (!/^needware_acceptance_[a-f0-9]{32}$/.test(database)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || decodeURIComponent(url.pathname.slice(1)) !== database) {
    throw new Error('Refusing acceptance time adjustment outside an isolated local database');
  }
  if ((await pool.query('SELECT current_database() AS name')).rows[0]?.name !== database) {
    throw new Error('Acceptance pool does not match its isolated database');
  }
  if (account) {
    await pool.query("UPDATE needware_account_limit SET reset_at=now()-interval '1 second' WHERE account_id=$1 AND count>$2 AND reset_at>now()", [account, threshold]);
    // Expire the earliest window only when the existing harness would wait.
    await pool.query("UPDATE needware_vault_challenge SET expires_at=now()-interval '1 second' WHERE account_id=$1 AND expires_at=(SELECT min(expires_at) FROM needware_vault_challenge WHERE account_id=$1 AND expires_at>now()) AND (SELECT count(*) FROM needware_vault_challenge WHERE account_id=$1 AND expires_at>now())>=6", [account]);
  }
  if (authKeys?.length) await pool.query('DELETE FROM auth_rate_limit WHERE key = ANY($1)', [authKeys]);
  return true;
}
