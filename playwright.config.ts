import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    channel: process.env.PLAYWRIGHT_CHANNEL,
    headless: true,
    launchOptions: { args: ['--enable-unsafe-webgpu'] },
  },
  webServer: {
    command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI,
  },
});
