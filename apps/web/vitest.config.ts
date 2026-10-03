import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['../../packages/browser-host/src/**/*.test.ts'] } });
