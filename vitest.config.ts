import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    globals: false,
    coverage: {
      provider: 'v8',
      // Покрытие меряется только для ядра обратного разбора (фаза 6, задача 6.5).
      include: ['src/core/query/sdblParser.ts', 'src/core/query/sdblLexer.ts'],
      reporter: ['text'],
    },
  },
  resolve: {
    alias: {
      '@shared': '/workspaces/query_console_vscode/src/shared',
      '@core': '/workspaces/query_console_vscode/src/core',
    },
  },
});
