/** Exercises portable adapters with real builds, incremental compilation, and browser rendering. @module */
import * as Esbuild from 'esbuild'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Url from 'node:url'
import { chromium } from 'playwright'
import * as Rollup from 'rollup'
import * as Vite from 'vite'
import * as Watch from '../../test/fixtures/Watch.js'
import * as Library from '../../test/fixtures/Library.js'
import * as PlainPackage from '../../test/fixtures/PlainPackage.js'
import * as Responsive from '../../test/fixtures/Responsive.js'
import { describe, expect, test, vi } from 'vite-plus/test'
import Webpack from 'webpack'
import { zyzz as esbuild } from 'zyzz/esbuild'
import { zyzz as rollup } from 'zyzz/rollup'
import { zyzz } from 'zyzz/unplugin'
import { zyzz as webpack } from 'zyzz/webpack'

async function fixture() {
  const root = await Fs.mkdtemp(Path.resolve('.fixture-unplugin-'))
  await Fs.writeFile(
    Path.join(root, 'theme.js'),
    "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#0066cc' } });",
  )
  await Fs.writeFile(
    Path.join(root, 'global.js'),
    `import { global } from 'zyzz/web'; global({ body: { margin: '0px' } });`,
  )
  await Fs.writeFile(
    Path.join(root, 'main.js'),
    `import {Config} from 'zyzz';import { theme } from './theme.js';const config=Config.create({vars:theme}); export const props = config.style({ color: 'brand', padding: '8px' })();`,
  )
  return root
}

async function render(root: string) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await Fs.writeFile(
      Path.join(root, 'dist/index.html'),
      '<link rel="stylesheet" href="zyzz.css"><div id="card"></div><script src="app.js"></script>',
    )
    await page.goto(Url.pathToFileURL(Path.join(root, 'dist/index.html')).href)
    expect(errors).toMatchInlineSnapshot('[]')
    return await page.evaluate(() => {
      const element = document.querySelector('#card')!
      const app = (
        globalThis as typeof globalThis & {
          App: { props: { className: string } }
        }
      ).App
      element.className = app.props.className
      const computed = getComputedStyle(element)
      return {
        boxSizing: computed.boxSizing,
        color: computed.color,
        margin: getComputedStyle(document.body).margin,
        padding: computed.padding,
      }
    })
  } finally {
    await browser.close()
  }
}

const runtime = Path.resolve('dist/runtime/index.js')

describe('zyzz', () => {
  for (const reset of [false, true])
    for (const bundler of ['esbuild', 'rollup', 'webpack'] as const) {
      test(`${bundler} emits matching JavaScript, shared CSS, and source maps (reset: ${reset})`, async () => {
        const root = await fixture()
        try {
          for (const [name, source] of Object.entries(Responsive.modules))
            await Fs.writeFile(Path.join(root, name), source)
          await Fs.appendFile(
            Path.join(root, 'main.js'),
            "export * from './entry.js';",
          )

          if (bundler === 'esbuild') {
            await Esbuild.build({
              alias: { 'zyzz/runtime': runtime },
              bundle: true,
              entryPoints: [Path.join(root, 'main.js')],
              format: 'iife',
              globalName: 'App',
              outdir: Path.join(root, 'dist'),
              entryNames: 'app',
              plugins: [esbuild({ root, reset })],
            })
          } else if (bundler === 'rollup') {
            const build = await Rollup.rollup({
              input: Path.join(root, 'main.js'),
              plugins: [
                rollup({ root, reset }),
                {
                  name: 'runtime',
                  resolveId(id) {
                    if (id === 'zyzz/runtime') return runtime
                  },
                },
              ],
            })
            try {
              await build.write({
                dir: Path.join(root, 'dist'),
                entryFileNames: 'app.js',
                format: 'iife',
                name: 'App',
              })
            } finally {
              await build.close()
            }
          } else {
            const compiler = Webpack({
              context: root,
              entry: './main.js',
              mode: 'development',
              output: {
                path: Path.join(root, 'dist'),
                filename: 'app.js',
                library: { name: 'App', type: 'var' },
              },
              plugins: [webpack({ root, reset })],
              resolve: { alias: { 'zyzz/runtime': runtime } },
            })
            try {
              await new Promise<void>((resolve, reject) =>
                compiler.run((error, stats) =>
                  error || stats?.hasErrors()
                    ? reject(error ?? new Error(stats?.toString('errors-only')))
                    : resolve(),
                ),
              )
            } finally {
              await new Promise<void>((resolve, reject) =>
                compiler.close((error) => (error ? reject(error) : resolve())),
              )
            }
          }

          const rendered = await render(root)
          await Responsive.verify({
            code:
              (await Fs.readFile(Path.join(root, 'dist/app.js'), 'utf8')) +
              ';var Fixture=App;',
            css: await Fs.readFile(Path.join(root, 'dist/zyzz.css'), 'utf8'),
          })
          const { boxSizing, ...styles } = rendered
          if (reset) expect(boxSizing).toMatchInlineSnapshot('"border-box"')
          else expect(boxSizing).toMatchInlineSnapshot('"content-box"')
          expect(styles).toMatchInlineSnapshot(`
          {
            "color": "rgb(0, 102, 204)",
            "margin": "0px",
            "padding": "8px",
          }
        `)
          const map = JSON.parse(
            await Fs.readFile(Path.join(root, 'dist/zyzz.css.map'), 'utf8'),
          ) as { sources: string[]; sourcesContent: string[] }
          expect(
            map.sources.some((file) => file.endsWith('/main.js')),
          ).toMatchInlineSnapshot('true')
          expect(
            map.sourcesContent.some((source) =>
              source.includes("padding: '8px'"),
            ),
          ).toMatchInlineSnapshot('true')
          expect(
            (
              await Fs.readFile(Path.join(root, 'dist/app.js'), 'utf8')
            ).includes('Theme.define'),
          ).toMatchInlineSnapshot('false')
        } finally {
          await Fs.rm(root, { force: true, recursive: true })
        }
      }, 30000)
    }

  test('esbuild recompiles imported themes and removes deleted global contributions', async () => {
    const root = await fixture()
    const context = await Esbuild.context({
      alias: { 'zyzz/runtime': runtime },
      bundle: true,
      entryPoints: [Path.join(root, 'main.js')],
      entryNames: 'app',
      format: 'iife',
      globalName: 'App',
      logLevel: 'silent',
      outdir: Path.join(root, 'dist'),
      plugins: [zyzz.esbuild({ root })],
    })
    try {
      await context.rebuild()
      await Fs.writeFile(
        Path.join(root, 'theme.js'),
        "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#ff0000' } });",
      )
      await Fs.rm(Path.join(root, 'global.js'))
      await context.rebuild()
      expect(await render(root)).toMatchInlineSnapshot(`
        {
          "boxSizing": "content-box",
          "color": "rgb(255, 0, 0)",
          "margin": "8px",
          "padding": "8px",
        }
      `)
      await Fs.writeFile(
        Path.join(root, 'main.js'),
        `import { style } from 'zyzz'; export const props = style({ color: unknownColor })();`,
      )
      await expect(
        context
          .rebuild()
          .catch((error: Esbuild.BuildFailure) => error.errors[0]?.text),
      ).resolves.toMatchInlineSnapshot(
        '"app/main.js:66: Expected a literal string or number; expressions are not evaluated."',
      )
      await Fs.writeFile(
        Path.join(root, 'main.js'),
        `import { style } from 'zyzz'; export const props = style({ color: 'green' })();`,
      )
      await context.rebuild()
      expect((await render(root)).color).toMatchInlineSnapshot(
        '"rgb(0, 128, 0)"',
      )
    } finally {
      await context.dispose()
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('esbuild watches edits and newly created global modules', async () => {
    const root = await fixture()
    const context = await Esbuild.context({
      alias: { 'zyzz/runtime': runtime },
      bundle: true,
      entryPoints: [Path.join(root, 'main.js')],
      entryNames: 'app',
      format: 'iife',
      globalName: 'App',
      logLevel: 'silent',
      outdir: Path.join(root, 'dist'),
      plugins: [zyzz.esbuild({ root })],
    })
    try {
      await context.watch()
      await vi.waitFor(
        async () => {
          const css = await Fs.readFile(
            Path.join(root, 'dist/zyzz.css'),
            'utf8',
          )
          if (!css.includes('#06c'))
            throw new Error('Waiting for the stylesheet rebuild.')
        },
        { timeout: 10000 },
      )
      await Fs.writeFile(
        Path.join(root, 'theme.js'),
        "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#ff0000' } });",
      )
      await vi.waitFor(
        async () => {
          const css = await Fs.readFile(
            Path.join(root, 'dist/zyzz.css'),
            'utf8',
          )
          if (!css.includes('red'))
            throw new Error('Waiting for the stylesheet rebuild.')
        },
        { timeout: 10000 },
      )
      await Fs.writeFile(
        Path.join(root, 'added.js'),
        `import { global } from 'zyzz/web'; global({ body: { padding: '13px' } });`,
      )
      await vi.waitFor(
        async () => {
          const css = await Fs.readFile(
            Path.join(root, 'dist/zyzz.css'),
            'utf8',
          )
          if (!css.includes('13px'))
            throw new Error('Waiting for the stylesheet rebuild.')
        },
        { timeout: 10000 },
      )
      expect(await render(root)).toMatchInlineSnapshot(`
        {
          "boxSizing": "content-box",
          "color": "rgb(255, 0, 0)",
          "margin": "0px",
          "padding": "8px",
        }
      `)
    } finally {
      await context.dispose()
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('webpack emits complete copied assets and nested CSS imports', async () => {
    const root = await fixture()
    await Fs.mkdir(Path.join(root, 'assets'))
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>'
    await Fs.writeFile(Path.join(root, 'assets/pixel.svg'), svg)
    await Fs.writeFile(
      Path.join(root, 'assets/nested.css'),
      '#card { border: 3px solid red; background-image: url(./pixel.svg); }',
    )
    await Fs.writeFile(
      Path.join(root, 'assets/base.css'),
      '@import "./nested.css";',
    )
    await Fs.writeFile(
      Path.join(root, 'global.js'),
      `import { importCss } from 'zyzz/web'; importCss({ url: './assets/base.css' });`,
    )
    const compiler = Webpack({
      context: root,
      entry: './main.js',
      mode: 'development',
      output: {
        path: Path.join(root, 'dist'),
        filename: 'app.js',
        library: { name: 'App', type: 'var' },
      },
      plugins: [webpack({ root })],
      resolve: { alias: { 'zyzz/runtime': runtime } },
    })
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.run((error, stats) =>
          error || stats?.hasErrors()
            ? reject(error ?? new Error(stats?.toString('errors-only')))
            : resolve(),
        ),
      )
      const names = await Fs.readdir(Path.join(root, 'dist/zyzz-assets'))
      expect(
        names.filter((name) => name.endsWith('.css')).length,
      ).toMatchInlineSnapshot('2')
      expect(
        await Fs.readFile(
          Path.join(
            root,
            'dist/zyzz-assets',
            names.find((name) => name.endsWith('.svg'))!,
          ),
          'utf8',
        ),
      ).toMatchInlineSnapshot(
        '"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>"',
      )
      await render(root)
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        await page.goto(
          Url.pathToFileURL(Path.join(root, 'dist/index.html')).href,
        )
        expect(
          await page
            .locator('#card')
            .evaluate((element) => getComputedStyle(element).borderTopWidth),
        ).toMatchInlineSnapshot('"3px"')
        expect(
          await page.locator('#card').evaluate(async (element) => {
            const image = new Image()
            image.src = getComputedStyle(element).backgroundImage.slice(5, -2)
            await image.decode()
            return image.naturalWidth
          }),
        ).toMatchInlineSnapshot('1')
      } finally {
        await browser.close()
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      )
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('esbuild resolves aliased packed themes and compiles TypeScript namespaces', async () => {
    const directory = await Fs.mkdtemp(
      Path.resolve('.fixture-unplugin-packed-'),
    )
    try {
      const root = await Library.create(directory)
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        `import { style } from '@design'; namespace styles { export const card = style({ color: 'brand', padding: 'md' }); } export const props = styles.card();`,
      )
      await Esbuild.build({
        absWorkingDir: root,
        alias: { '@design': '@acme/theme', 'zyzz/runtime': runtime },
        bundle: true,
        entryPoints: [Path.join(root, 'main.ts')],
        entryNames: 'app',
        format: 'iife',
        globalName: 'App',
        outdir: Path.join(root, 'dist'),
        plugins: [zyzz.esbuild({ root })],
      })
      expect(await render(root)).toMatchInlineSnapshot(`
        {
          "boxSizing": "content-box",
          "color": "rgb(0, 102, 204)",
          "margin": "8px",
          "padding": "8px",
        }
      `)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }
  }, 30000)

  test('esbuild derives contracts for installed packages without sidecars', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-unplugin-derived-'))
    try {
      await PlainPackage.install(root)
      await Fs.symlink(
        process.cwd(),
        Path.join(root, 'node_modules/zyzz'),
        'dir',
      )
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        `import {global} from 'zyzz/web';import {style,vars} from '@acme/tokens';global({':root':{'--gap':vars.spacing['16']}});export const props=style({padding:'16'})();`,
      )

      await Esbuild.build({
        absWorkingDir: root,
        bundle: true,
        entryPoints: [Path.join(root, 'main.ts')],
        entryNames: 'app',
        format: 'esm',
        outdir: Path.join(root, 'dist'),
        plugins: [zyzz.esbuild({ root })],
      })

      expect(await Fs.readFile(Path.join(root, 'dist/zyzz.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ":root {
            --gap: var(--z-acme-spacing-16, 16px);
          }

          .z-theme-acme_2f_variables-variables {
            --z-acme_2f_variables-color-ink: #123456;
            --z-acme_2f_variables-spacing-16: 16px;
          }

          .z-theme-acme-theme {
            --z-acme-spacing-16: 16px;
            --z-acme-color-ink: #123456;
          }

          .z_acme-YiE3S90 {
            padding: var(--z-acme-spacing-16, 16px);
          }

          /*# sourceMappingURL=zyzz.css.map */
          "
        `)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('esbuild declares scheme classes once across modules', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-unplugin-schemes-'))
    try {
      await Fs.writeFile(
        Path.join(root, 'config.ts'),
        `import { defineConfig, defineVars } from 'zyzz'; const base = defineVars({ spacing: { page: '1rem' } }); export const { vars } = defineConfig({ vars: base });`,
      )
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        `import { vars } from './config.js'; export const props = vars({ colorScheme: 'dark' });`,
      )
      await Esbuild.build({
        alias: { 'zyzz/runtime': runtime },
        bundle: true,
        entryPoints: [Path.join(root, 'main.ts')],
        entryNames: 'app',
        format: 'iife',
        globalName: 'App',
        outdir: Path.join(root, 'dist'),
        plugins: [zyzz.esbuild({ root })],
      })
      expect(await Fs.readFile(Path.join(root, 'dist/zyzz.css'), 'utf8'))
        .toMatchInlineSnapshot(`
        ".z_scheme-dark {
          color-scheme: dark;
        }

        .z_scheme-light {
          color-scheme: light;
        }

        .z_scheme-light-dark {
          color-scheme: light dark;
        }

        /*# sourceMappingURL=zyzz.css.map */
        "
      `)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('esbuild publishes shared independent rules once across modules', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-unplugin-units-'))
    try {
      await Fs.writeFile(
        Path.join(root, 'config.ts'),
        `import { defineConfig } from 'zyzz'; export const { style } = defineConfig({ composition: 'independent' });`,
      )
      await Fs.writeFile(
        Path.join(root, 'card.ts'),
        `import { style } from './config.js'; const card = style({ color: 'red', padding: '8px' }); export const props = card();`,
      )
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        `import { style } from './config.js'; import { props as card } from './card.js'; const label = style({ color: 'red', padding: '4px' }); export const props = [card, label()];`,
      )
      await Esbuild.build({
        alias: { 'zyzz/runtime': runtime },
        bundle: true,
        entryPoints: [Path.join(root, 'main.ts')],
        entryNames: 'app',
        format: 'iife',
        globalName: 'App',
        outdir: Path.join(root, 'dist'),
        plugins: [zyzz.esbuild({ root })],
      })
      // The consumer reuses the dependency's color rule, published once.
      expect(await Fs.readFile(Path.join(root, 'dist/zyzz.css'), 'utf8'))
        .toMatchInlineSnapshot(`
        ".z_rnRBDm0 {
          color: red;
        }

        .z_rnRBDm1 {
          padding: 8px;
        }

        .z_YiE3S91 {
          padding: 4px;
        }

        /*# sourceMappingURL=zyzz.css.map */
        "
      `)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('rollup invalidates cached transforms after a shared theme edit', async () => {
    const root = await fixture()
    const plugin = rollup({ root })
    let cache: Rollup.RollupCache | undefined
    try {
      for (const color of ['#0066cc', '#ff0000']) {
        await Fs.writeFile(
          Path.join(root, 'theme.js'),
          `import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '${color}' } });`,
        )
        const build = await Rollup.rollup({
          cache,
          input: Path.join(root, 'main.js'),
          plugins: [
            plugin,
            {
              name: 'runtime',
              resolveId(id) {
                if (id === 'zyzz/runtime') return runtime
              },
            },
          ],
        })
        try {
          await build.write({
            dir: Path.join(root, 'dist'),
            entryFileNames: 'app.js',
            format: 'iife',
            name: 'App',
          })
          cache = build.cache
        } finally {
          await build.close()
        }
      }
      expect((await render(root)).color).toMatchInlineSnapshot(
        '"rgb(255, 0, 0)"',
      )
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('vite retains automatic CSS delivery through the unplugin entrypoint', async () => {
    const root = await fixture()
    try {
      await Vite.build({
        configFile: false,
        root,
        logLevel: 'silent',
        plugins: [zyzz.vite()],
        resolve: { alias: { 'zyzz/runtime': runtime } },
        build: {
          lib: {
            entry: Path.join(root, 'main.js'),
            formats: ['iife'],
            name: 'App',
            fileName: () => 'app.js',
            cssFileName: 'zyzz',
          },
        },
      })
      expect(await render(root)).toMatchInlineSnapshot(`
        {
          "boxSizing": "content-box",
          "color": "rgb(0, 102, 204)",
          "margin": "0px",
          "padding": "8px",
        }
      `)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('webpack uses the graph source when its filesystem cache predates an edit', async () => {
    const root = await fixture()
    const compiler = Webpack({
      context: root,
      entry: './main.js',
      mode: 'development',
      output: {
        path: Path.join(root, 'dist'),
        filename: 'app.js',
        library: { name: 'App', type: 'var' },
      },
      plugins: [webpack({ root })],
      resolve: { alias: { 'zyzz/runtime': runtime } },
    })
    compiler.hooks.beforeCompile.tapPromise('edit', async () => {
      const path = Path.join(root, 'theme.js')
      await new Promise<void>((resolve, reject) =>
        compiler.inputFileSystem!.readFile(path, (error) =>
          error ? reject(error) : resolve(),
        ),
      )
      await Watch.write({
        path,
        source:
          "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#ff0000' } });",
      })
    })
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.run((error, stats) =>
          error || stats?.hasErrors()
            ? reject(error ?? new Error(stats?.toString('errors-only')))
            : resolve(),
        ),
      )
      expect((await render(root)).color).toMatchInlineSnapshot(
        '"rgb(255, 0, 0)"',
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve())),
      )
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test.each(['filesystem', 'manual'])(
    'webpack watches shared themes and new global contributions with %s invalidation',
    async (invalidation) => {
      const root = await fixture()
      const compiler = Webpack({
        cache: invalidation !== 'manual',
        context: root,
        entry: './main.js',
        mode: 'development',
        output: {
          path: Path.join(root, 'dist'),
          filename: 'app.js',
          library: { name: 'App', type: 'var' },
        },
        plugins: [webpack({ root })],
        resolve: { alias: { 'zyzz/runtime': runtime } },
      })
      let completed = 0
      compiler.hooks.afterDone.tap('test', () => {
        completed++
      })
      let failure: Error | undefined
      // Temporary writes and emitted assets must not start a source rebuild.
      const watcher = compiler.watch(
        {
          ignored: [
            '**/*.tmp',
            Path.join(root, 'dist'),
            ...(invalidation === 'manual' ? [Path.join(root, 'theme.js')] : []),
          ],
        },
        (error, stats) => {
          if (error || stats?.hasErrors())
            failure = error ?? new Error(stats?.toString('errors-only'))
        },
      )
      try {
        if (!watcher) throw new Error('Webpack watcher did not start.')

        await vi.waitFor(
          async () => {
            if (failure) throw failure
            expect(completed).toBeGreaterThan(0)
          },
          { timeout: 10000 },
        )
        const initial = completed
        await Watch.write({
          path: Path.join(root, 'theme.js'),
          source:
            "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#ff0000' } });",
        })
        if (invalidation === 'manual') watcher.invalidate()
        await vi.waitFor(
          async () => {
            if (failure) throw failure
            expect(completed).toBeGreaterThan(initial)
            const css = await Fs.readFile(
              Path.join(root, 'dist/zyzz.css'),
              'utf8',
            )
            if (!css.includes('red'))
              throw new Error('Waiting for the theme rebuild.')
          },
          { timeout: 10000 },
        )
        const updated = completed
        await Watch.write({
          path: Path.join(root, 'added.js'),
          source: `import { global } from 'zyzz/web'; global({ body: { padding: '13px' } });`,
        })
        await vi.waitFor(
          async () => {
            if (failure) throw failure
            expect(completed).toBeGreaterThan(updated)
            const css = await Fs.readFile(
              Path.join(root, 'dist/zyzz.css'),
              'utf8',
            )
            if (!css.includes('13px'))
              throw new Error('Waiting for the new contribution.')
          },
          { timeout: 10000 },
        )
        expect((await render(root)).color).toMatchInlineSnapshot(
          '"rgb(255, 0, 0)"',
        )
      } finally {
        if (watcher)
          await new Promise<void>((resolve, reject) =>
            watcher.close((error) => (error ? reject(error) : resolve())),
          )
        await new Promise<void>((resolve, reject) =>
          compiler.close((error) => (error ? reject(error) : resolve())),
        )
        await Fs.rm(root, { force: true, recursive: true })
      }
    },
    30000,
  )

  test('esbuild rejects output modes that cannot receive emitted assets', async () => {
    await expect(
      Esbuild.build({
        logLevel: 'silent',
        plugins: [zyzz.esbuild()],
        stdin: { contents: '' },
        write: false,
      }).catch((error: Esbuild.BuildFailure) => error.errors[0]?.text),
    ).resolves.toMatchInlineSnapshot(
      '"Zyzz requires esbuild outdir and write: true to emit CSS assets."',
    )
  })
})
