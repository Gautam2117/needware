import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
export function loadEnvironment() {
  for (const file of ['.env', '.local/dev.env']) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (value && process.env[key] === undefined) process.env[key] = value;
    }
  }
  process.env.BETTER_AUTH_URL ||= 'http://127.0.0.1:3000';
}
