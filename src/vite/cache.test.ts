/** Verifies retained compilation state through real consumer builds. @module */
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Vite from 'vite'
import { describe, expect, test } from 'vite-plus/test'
import { zyzz } from 'zyzz/vite'
import * as CompilerCache from '../../test/fixtures/CompilerCache.js'
import * as PlainPackage from '../../test/fixtures/PlainPackage.js'

describe('zyzz', () => {
  test.each(['vite'])(
    '%s reuses unchanged compilation and updates edited dependencies',
    async (adapter) => {
      expect(await CompilerCache.verify(adapter)).toMatchInlineSnapshot(`
        {
          "cold": {
            "modules": 3,
            "parses": 6,
          },
          "edited": {
            "modules": 2,
            "parses": 2,
          },
          "settled": {
            "modules": 0,
            "parses": 0,
          },
          "warm": {
            "modules": 0,
            "parses": 0,
          },
        }
      `)
    },
    60_000,
  )

  test('resolves imports and package contracts once across module transforms', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-vite-lookups-'))
    const resolutions: string[] = []

    try {
      await PlainPackage.install(root)
      await Fs.symlink(
        process.cwd(),
        Path.join(root, 'node_modules/zyzz'),
        'dir',
      )

      for (let index = 0; index < 4; index++)
        await Fs.writeFile(
          Path.join(root, `card${index}.ts`),
          `import { style } from '@acme/tokens'; export const props = style({ opacity: ${(index + 1) / 4}, padding: '16' })();`,
        )

      const server = await Vite.createServer({
        configFile: false,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true },
        plugins: [
          {
            enforce: 'pre',
            name: 'resolutions',
            resolveId(source, importer) {
              if (importer)
                resolutions.push(`${Path.relative(root, importer)} ${source}`)
            },
          },
          zyzz(),
        ],
        root,
      })

      try {
        const environment = server.environments.client!
        const stylesheets: string[] = []

        // Each module transform and stylesheet load compiles every consumer.
        for (let index = 0; index < 4; index++) {
          const result = await environment.transformRequest(`/card${index}.ts`)

          for (const [, id] of result!.code.matchAll(
            /import\s*"\/@id\/__x00__(zyzz:[^"]+)"/g,
          ))
            stylesheets.push(
              (await environment.transformRequest(`\0${id}`))!.code,
            )
        }

        const count = (key: string) =>
          resolutions.filter((item) => item === key).length

        // Every compile visits each consumer, whose import resolves once.
        expect(count('card0.ts @acme/tokens')).toMatchInlineSnapshot(`1`)
        // The derived package contract resolves its own imports once.
        expect(
          count('node_modules/@acme/tokens/dist/index.js ./config.js'),
        ).toMatchInlineSnapshot(`1`)
        expect(
          stylesheets.some((code) =>
            code.includes('padding:var(--z-acme-spacing-16,16px)'),
          ),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await server.close()
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
