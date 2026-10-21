/** Runs benchmark fixture checks and build comparisons outside integration tests. @module */
import * as Path from 'node:path'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    alias: { zyzz: Path.resolve(import.meta.dirname, '../src') },
    globals: true,
    include: ['bench/**/*.test.ts'],
    // Generated reports and cloned comparison suites are not fixture checks.
    exclude: ['bench/native/**', 'bench/results/**'],
  },
})
