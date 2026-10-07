import { type BetterAuthOptions } from 'better-auth';
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getCurrentAdapter, getCurrentAuthEndpointContext } from '@better-auth/core/context';

export const accountEmailStatus = new AsyncLocalStorage<{ failed: boolean; queued?: boolean }>();

const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
let resources: { options: BetterAuthOptions; pool: Pool; mail: ReturnType<typeof nodemailer.createTransport>; from: string; origin: string } | undefined;
export function authConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL);
}
export function authResources() {
  if (resources) return resources;
  if (!authConfigured()) throw new Error('Account service requires database, auth secret and canonical URL');
  const origin = new URL(process.env.BETTER_AUTH_URL!);
  const database = new URL(process.env.DATABASE_URL!);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
      || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback(origin.hostname)))) throw new Error('Account service URL must be canonical HTTPS or local loopback');
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('PostgreSQL is required');
  if (process.env.BETTER_AUTH_SECRET!.length < 32) throw new Error('Account signing secret is too short');
  if (!process.env.SMTP_HOST) throw new Error('Transactional email must be configured');
  const port = Number(process.env.SMTP_PORT ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP port');
  if (!loopback(origin.hostname) && !process.env.NEEDWARE_MAIL_FROM) throw new Error('Production email sender is required');
  if (Boolean(process.env.SMTP_USER) !== Boolean(process.env.SMTP_PASSWORD)) throw new Error('Both SMTP credentials are required');
  const databaseLocal = loopback(database.hostname);
  if (!databaseLocal && database.searchParams.get('sslmode') === 'disable') throw new Error('Remote database TLS is required');
  // pg connection-string SSL parameters must not override certificate verification.
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) database.searchParams.delete(key);
  const pool = new Pool({ connectionString: database.toString(), max: 10, connectionTimeoutMillis: 5000, query_timeout: 10_000, statement_timeout: 10_000,
    idleTimeoutMillis: 30_000, ssl: databaseLocal ? undefined : { rejectUnauthorized: true, ca: process.env.NEEDWARE_DATABASE_CA_PEM } });
  const mail = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
    requireTLS: !loopback(process.env.SMTP_HOST), connectionTimeout: 10_000, socketTimeout: 15_000,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD! } : undefined,
    tls: { rejectUnauthorized: true }, logger: false, debug: false });
  const enqueue = async (user: { id: string; email: string }, url: string, kind: string) => {
    try {
      if (new URL(url).origin !== origin.origin) throw new Error('Account email URL origin mismatch');
      // Durable enqueue only: SMTP latency never occurs in an auth response.
      const adapter = await getCurrentAdapter(getCurrentAuthEndpointContext().context.adapter);
      await adapter.create({ model: 'needwareEmailOutbox', data: {
        userId: user.id, recipient: user.email, kind, link: url,
        expiresAt: new Date(Date.now() + (kind === 'verify' ? 3600 : 900) * 1000),
      } });
      const status = accountEmailStatus.getStore(); if (status) status.queued = true;
    } catch (failure) {
      const code = failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' ? failure.code : 'ENQUEUE_FAILED';
      const status = accountEmailStatus.getStore(); if (status) status.failed = true;
      const column = failure && typeof failure === 'object' && 'column' in failure && typeof failure.column === 'string' ? failure.column : '';
      console.error('Account email enqueue failed', code, column); throw failure;
    }
  };
  const options: BetterAuthOptions = {
    appName: 'Needware', baseURL: origin.origin, secret: process.env.BETTER_AUTH_SECRET,
    database: pool, trustedOrigins: [origin.origin], telemetry: { enabled: false },
    // Reviewed SQL owns this table's constraints/defaults; the public adapter joins auth transactions.
    plugins: [{ id: 'needware-durable-email', schema: {
      needwareEmailOutbox: { modelName: 'needware_email_outbox', disableMigration: true, fields: {
        userId: { type: 'string', fieldName: 'user_id', references: { model: 'user', field: 'id', onDelete: 'cascade' } },
        recipient: { type: 'string' }, kind: { type: 'string' }, link: { type: 'string' },
        expiresAt: { type: 'date', fieldName: 'expires_at' },
      } },
    } }],
    user: { modelName: 'auth_user', deleteUser: { enabled: true,
      sendDeleteAccountVerification: ({ user, url }) => enqueue(user, url, 'delete') } },
    account: { modelName: 'auth_account', accountLinking: { enabled: false } },
    verification: { modelName: 'auth_verification' },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128,
      requireEmailVerification: true, revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 15 * 60,
      sendResetPassword: ({ user, url }) => enqueue(user, url, 'reset') },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: false, expiresIn: 60 * 60,
      sendVerificationEmail: ({ user, url }) => enqueue(user, url, 'verify') },
    session: { modelName: 'auth_session', expiresIn: 7 * 86400, updateAge: 12 * 3600,
      freshAge: 15 * 60, cookieCache: { enabled: false } },
    advanced: { database: { generateId: 'uuid' }, useSecureCookies: origin.protocol === 'https:',
      cookiePrefix: 'needware', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: origin.protocol === 'https:' },
      ipAddress: { ipAddressHeaders: ['x-needware-auth-ip'] } },
    rateLimit: { enabled: true, storage: 'database', modelName: 'auth_rate_limit', window: 60, max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 }, '/send-verification-email': { window: 60, max: 5 } } },
    logger: { disabled: true },
  };
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {};
  for (const provider of ['google', 'github'] as const) {
    const key = provider.toUpperCase(); const clientId = process.env[`${key}_CLIENT_ID`]; const clientSecret = process.env[`${key}_CLIENT_SECRET`];
    if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('Both OAuth credentials are required');
    if (clientId && clientSecret) socialProviders[provider] = { clientId, clientSecret };
  }
  options.socialProviders = socialProviders;
  resources = { options, pool, mail, from: process.env.NEEDWARE_MAIL_FROM ?? 'Needware <no-reply@example.invalid>', origin: origin.origin };
  return resources;
}
