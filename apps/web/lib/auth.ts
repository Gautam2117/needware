import 'server-only';
import { betterAuth } from 'better-auth';
import { authResources } from './auth-options';
let instance: ReturnType<typeof betterAuth> | undefined;
export function getAuth() { return instance ??= betterAuth(authResources().options); }
