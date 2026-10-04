import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60_000, fullyParallel: false, workers: process.env.CI ? 1 : 3,
  use: { baseURL: process.env.NEEDWARE_TEST_URL ?? 'http://127.0.0.1:3107', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }, { name: 'firefox', use: devices['Desktop Firefox'] }, { name: 'webkit', use: devices['Desktop Safari'] }],
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }]],
});
