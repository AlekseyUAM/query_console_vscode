import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 15000,
  use: {
    headless: true,
  },
  webServer: {
    command: `npx serve test/e2e/harness -p 5555 --no-port-switching`,
    port: 5555,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
