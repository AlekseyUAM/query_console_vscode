import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      '@shared': '/workspaces/query_console_vscode/src/shared',
      '@core': '/workspaces/query_console_vscode/src/core',
    },
  },
});
