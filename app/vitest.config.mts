import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./tests/helpers/server-only.ts', import.meta.url)),
    },
  },
  test: {
    coverage: {
      all: true,
      exclude: ['**/*.d.ts'],
      include: [
        'src/access/**/*.ts',
        'src/lib/billing/{contracts,math,preview,selection,stable}.ts',
        'src/lib/domain/**/*.ts',
        'src/lib/member-app/{date-time,time-filters}.ts',
        'src/lib/xero/accounting/{client,contracts,crypto,token}.ts',
        'src/lib/xero/export/**/*.ts',
        'src/lib/xero/identity/{constants,contracts}.ts',
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 70,
        statements: 70,
        'src/access/**': {
          branches: 70,
          functions: 85,
          lines: 85,
          statements: 80,
        },
        'src/lib/billing/**': {
          branches: 80,
          functions: 95,
          lines: 90,
          statements: 90,
        },
        'src/lib/domain/**': {
          branches: 70,
          functions: 85,
          lines: 80,
          statements: 75,
        },
        'src/lib/xero/export/**': {
          branches: 50,
          functions: 70,
          lines: 65,
          statements: 65,
        },
      },
    },
    environment: 'jsdom',
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['tests/**/*.int.spec.ts', 'tests/**/*.perf.spec.ts', 'tests/**/*.unit.spec.ts'],
  },
})
