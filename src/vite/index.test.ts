/**
 * Exercises the public Vite plugin through builds, HTTP, and real file updates.
 * @module
 */
import * as Trace from '@jridgewell/trace-mapping'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import {
  type Config as RouterConfig,
  tanstackRouter,
} from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Util from 'node:util'
import * as Fs from 'node:fs/promises'
import * as NodeFs from 'node:fs'
import * as Path from 'node:path'
import * as Os from 'node:os'
import * as Universal from '../../test/fixtures/UniversalLibrary.js'
import { chromium } from 'playwright'
import * as Tailwind from 'tailwindcss'
import * as Vite from 'vite'
import { describe, expect, test, vi } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'
import { zyzz } from 'zyzz/vite'
import * as Library from '../../test/fixtures/Library.js'
import * as Responsive from '../../test/fixtures/Responsive.js'
import * as Fixture from '../../test/fixtures/Vite.js'
import * as Font from '../../test/fixtures/AtRuleFont.js'
import * as PlainPackage from '../../test/fixtures/PlainPackage.js'
import * as TanStack from '../../test/fixtures/TanStack.js'
import * as Watch from '../../test/fixtures/Watch.js'

async function create(files: Readonly<Record<string, string>> = Fixture.files) {
  const root = await Fs.mkdtemp(Path.resolve('.fixture-vite-'))

  for (const [name, content] of Object.entries(files))
    await Fs.writeFile(Path.join(root, name), content)

  const config: Vite.InlineConfig = {
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true },
    plugins: [zyzz()],
    resolve: {
      alias: {
        '@theme': Path.join(root, 'theme.ts'),
        'zyzz/runtime': Path.resolve('src/runtime/index.ts'),
      },
    },
    root,
    server: { host: '127.0.0.1', port: 0 },
  }

  return { config, root }
}

/** Creates a consumer whose runtime resolves from the packed package inside node_modules. */
async function install(files: Readonly<Record<string, string>> = {}) {
  const root = await Fs.mkdtemp(Path.resolve('.fixture-vite-installed-'))
  const exec = Util.promisify(ChildProcess.execFile)
  const packed = await exec('npm', [
    'pack',
    '--ignore-scripts',
    '--offline',
    '--json',
    '--pack-destination',
    root,
  ])
  const archive = (JSON.parse(packed.stdout) as { filename: string }[])[0]!
  const installed = Path.join(root, 'node_modules/zyzz')

  await Fs.mkdir(installed, { recursive: true })
  await exec('tar', [
    '-xf',
    Path.join(root, archive.filename),
    '-C',
    installed,
    '--strip-components=1',
  ])

  for (const [name, content] of Object.entries({
    ...files,
    'package.json': '{"private":true,"type":"module"}',
  }))
    await Fs.writeFile(Path.join(root, name), content)

  return root
}

function message(
  socket: WebSocket,
  action: () => Promise<unknown>,
  accept?: (text: string) => boolean,
) {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Vite HMR timed out'))
    }, 10000)

    function cleanup() {
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
    }

    function onMessage(event: MessageEvent) {
      const text = String(event.data)
      if (
        !text.includes('"type":"update"') &&
        !text.includes('"type":"full-reload"')
      )
        return

      if (accept && !accept(text)) return

      cleanup()
      resolve(text)
    }

    socket.addEventListener('message', onMessage)
    void action().catch((error: unknown) => {
      cleanup()
      reject(error)
    })
  })
}

describe('zyzz', () => {
  test.each(['Router', 'Start'])(
    'compiles TanStack %s split routes in development and production',
    async (framework) => {
      const { config, root } = await create(TanStack.files)
      config.optimizeDeps = {
        include: [
          '@tanstack/react-router',
          'react',
          'react-dom/client',
          'react/jsx-dev-runtime',
          'react/jsx-runtime',
        ],
      }
      await Fs.mkdir(Path.join(root, 'routes'))
      for (const name of ['__root.tsx', 'settings.tsx'])
        await Fs.rename(Path.join(root, name), Path.join(root, 'routes', name))

      if (framework === 'Start')
        await Fs.writeFile(
          Path.join(root, 'routes/__root.tsx'),
          `import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router'
export const Route = createRootRoute({ component: () => <html><head><HeadContent /></head><body><Outlet /><Scripts /></body></html> })`,
        )

      const router: Partial<RouterConfig> = {
        autoCodeSplitting: true,
        codeSplittingOptions: {
          defaultBehavior: [
            ['loader', 'component'],
            ['errorComponent'],
            ['notFoundComponent'],
          ],
        },
        generatedRouteTree: Path.join(root, 'routeTree.gen.ts'),
        routesDirectory: Path.join(root, 'routes'),
      }
      const plugins = () => [
        zyzz({ include: ['.'], script: false }),
        framework === 'Start'
          ? tanstackStart({ router, srcDirectory: '.' })
          : tanstackRouter(router),
        react(),
      ]
      const browser = await chromium.launch()
      let server: Vite.ViteDevServer | undefined
      let preview: Vite.PreviewServer | undefined

      try {
        server = await Vite.createServer({ ...config, plugins: plugins() })
        await server.listen()
        const page = await browser.newPage()
        page.setDefaultTimeout(8000)
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`${server.resolvedUrls!.local[0]}settings`)
        await vi.waitUntil(
          async () =>
            (await page.locator('#page').count()) ||
            (await page.getByText('Something went wrong!').count()),
          { timeout: 10000 },
        )
        expect(
          await page.evaluate(() => ({
            error: document.body.textContent?.includes('styles is not defined'),
            padding: document.querySelector('#page')
              ? getComputedStyle(document.querySelector('#page')!).padding
              : null,
          })),
        ).toMatchInlineSnapshot(`
        {
          "error": false,
          "padding": "24px",
        }
      `)
        await page.locator('#page[data-hydrated="true"]').waitFor()
        expect(
          await page
            .locator('#dynamic')
            .evaluate((node) => getComputedStyle(node).opacity),
        ).toMatchInlineSnapshot('"0.4"')

        await page.evaluate(() => {
          document.body.dataset.preserved = 'yes'
        })
        await Watch.write({
          path: Path.join(root, 'routes/settings.tsx'),
          source: TanStack.files['settings.tsx'].replace("'24px'", "'32px'"),
        })
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#page')!).padding ===
            '32px',
        )
        expect(
          await page.evaluate(() => document.body.dataset.preserved),
        ).toMatchInlineSnapshot('"yes"')

        async function boundaries(url: string) {
          const padding: string[] = []
          for (const state of ['error', 'missing']) {
            await page.goto(`${url}settings?${state}=true`)
            await page.locator(`#${state}`).waitFor()
            // Hydration replaces a server-rendered error boundary, and a detached node has no
            // computed style, so the lookup and the read share one evaluation.
            padding.push(
              await page.evaluate(
                (id) => getComputedStyle(document.getElementById(id)!).padding,
                state,
              ),
            )
          }
          expect(padding).toMatchInlineSnapshot(`
          [
            "13px",
            "7px",
          ]
        `)
        }
        await boundaries(server.resolvedUrls!.local[0]!)

        for (const target of [
          'component---loader',
          'errorComponent',
          'notFoundComponent',
          'component&t=123&v=456&import',
        ]) {
          const output = await server.transformRequest(
            `/routes/settings.tsx?tsr-split=${target}`,
          )
          expect({
            authoring: /\bstyle\(/.test(output!.code),
            stylesheet: output!.code.includes('zyzz:'),
          }).toMatchInlineSnapshot(`
          {
            "authoring": false,
            "stylesheet": true,
          }
        `)
          if (target === 'component---loader') {
            const before = output!.code.slice(
              0,
              output!.code.indexOf('function Page('),
            )
            const original = Trace.originalPositionFor(
              new Trace.TraceMap(JSON.stringify(output!.map)),
              {
                column: before.length - before.lastIndexOf('\n') - 1,
                line: before.split('\n').length,
              },
            )
            expect({
              line: original.line,
              source: original.source,
            }).toMatchInlineSnapshot(`
              {
                "line": 16,
                "source": "settings.tsx",
              }
            `)
          }
        }
        await server.close()
        server = undefined
        await Fs.writeFile(
          Path.join(root, 'routes/settings.tsx'),
          TanStack.files['settings.tsx'],
        )

        if (framework === 'Start') {
          const builder = await Vite.createBuilder({
            ...config,
            plugins: plugins(),
          })
          await builder.buildApp()
        } else await Vite.build({ ...config, plugins: plugins() })

        preview = await Vite.preview({
          ...config,
          appType: framework === 'Start' ? 'custom' : 'spa',
          build: { outDir: framework === 'Start' ? 'dist/client' : 'dist' },
          plugins: [],
          preview: { host: '127.0.0.1', port: 0 },
        })
        if (framework === 'Start') {
          const built = (await import(
            Path.join(root, 'dist/server/server.js')
          )) as { default: { fetch: (request: Request) => Promise<Response> } }
          preview.middlewares.use(async (request, response, next) => {
            try {
              const result = await built.default.fetch(
                new Request(
                  new URL(request.url!, preview!.resolvedUrls!.local[0]!),
                ),
              )
              response.statusCode = result.status
              result.headers.forEach((value: string, name: string) =>
                response.setHeader(name, value),
              )
              response.end(await result.text())
            } catch (error) {
              next(error)
            }
          })
        }
        await page.goto(`${preview.resolvedUrls!.local[0]}settings`)
        await page.locator('#page[data-hydrated="true"]').waitFor()
        expect(
          await page
            .locator('#page')
            .evaluate((node) => getComputedStyle(node).padding),
        ).toMatchInlineSnapshot('"24px"')
        expect(
          await page
            .locator('#dynamic')
            .evaluate((node) => getComputedStyle(node).opacity),
        ).toMatchInlineSnapshot('"0.4"')
        await boundaries(preview.resolvedUrls!.local[0]!)
        expect(errors).toMatchInlineSnapshot('[]')
      } finally {
        await browser.close()
        await server?.close()
        await preview?.close()
        await Fs.rm(root, { force: true, recursive: true })
      }
    },
  )

  test('keeps foreign resource queries out of split-route compilation', async () => {
    const { config, root } = await create({
      'style.ts':
        "import { style } from 'zyzz'; export const card = style({ padding: '24px' });",
    })
    config.resolve = { alias: { zyzz: Path.resolve('src') } }
    const server = await Vite.createServer(config)

    try {
      for (const query of [
        'raw',
        'tsr-split=component&raw',
        'tsr-split=component&unknown',
        'unknown',
        'url',
        'worker',
      ]) {
        const output = await server.transformRequest(`/style.ts?${query}`)
        expect(output!.code.includes('zyzz:')).toMatchInlineSnapshot('false')
      }
      const output = await server.transformRequest(
        '/style.ts?tsr-split=component',
      )
      expect({
        authoring: /\bstyle\(/.test(output!.code),
        stylesheet: output!.code.includes('zyzz:'),
      }).toMatchInlineSnapshot(`
        {
          "authoring": false,
          "stylesheet": true,
        }
      `)
    } finally {
      await server.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('rejects include patterns outside an existing directory', async () => {
    const { config, root } = await create()
    try {
      await expect(
        Vite.createServer({
          ...config,
          plugins: [zyzz({ include: ['missing/**'] })],
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        '[Error: Zyzz include patterns must start in an existing directory: missing/**]',
      )
      await expect(
        Vite.createServer({
          ...config,
          plugins: [zyzz({ include: ['main.ts/**'] })],
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        '[Error: Zyzz include patterns must start in an existing directory: main.ts/**]',
      )
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('builds and hot reloads explicitly included linked library sources', async () => {
    const { config, root } = await create({
      'index.html':
        '<input id="state"><main id="card"></main><script type="module" src="/main.js"></script>',
      'main.js': `import './utilities.css';import './vocs.css';import {card} from '@fixture/library/card';document.querySelector('main').className=card().className+' vocs:p-4 p-2 vocs:dark:bg-black dark:text-white';if(import.meta.hot)import.meta.hot.accept();`,
    })
    const library = await Fs.mkdtemp(Path.resolve('.fixture-vite-included-'))
    let server: Vite.ViteDevServer | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      for (const [prefix, layer, candidates, file] of [
        ['', 'utilities', ['p-2', 'dark:text-white'], 'utilities.css'],
        [
          'vocs',
          'vocs_utilities',
          ['vocs:p-4', 'vocs:dark:bg-black'],
          'vocs.css',
        ],
      ] as const) {
        const utilities = await Tailwind.compile(
          `@layer library, vocs_utilities, utilities;@theme ${prefix ? 'prefix(vocs)' : ''} {--spacing:4px;--color-white:#fff;--color-black:#000;}@custom-variant dark (&:where([style*="color-scheme: dark"], [style*="color-scheme: dark"] *));@layer ${layer} {@tailwind utilities;}`,
        )
        await Fs.writeFile(
          Path.join(root, file),
          utilities.build([...candidates]),
        )
      }

      await Fs.mkdir(Path.join(root, 'node_modules/@fixture'), {
        recursive: true,
      })
      await Fs.symlink(
        library,
        Path.join(root, 'node_modules/@fixture/library'),
      )
      await Fs.writeFile(
        Path.join(library, 'package.json'),
        JSON.stringify({
          name: '@fixture/library',
          type: 'module',
          exports: { './card': './card.ts' },
        }),
      )
      await Fs.writeFile(
        Path.join(library, 'theme.ts'),
        `import {Config} from 'zyzz';export const {style}=Config.create({layers:['library'],defaultLayer:'library'});`,
      )
      await Fs.writeFile(
        Path.join(library, 'card.ts'),
        `import {style} from './theme.js';export const card=style({color:'red',padding:'24px',backgroundImage:'url(./image.svg)'});`,
      )
      await Fs.writeFile(
        Path.join(library, 'image.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      )
      // Configuration and nested dependencies remain outside source discovery.
      await Fs.writeFile(
        Path.join(root, 'vite.config.ts'),
        `import missing from 'missing-build-plugin';throw missing;`,
      )
      await Fs.mkdir(Path.join(library, 'node_modules/unlisted'), {
        recursive: true,
      })
      await Fs.symlink(
        Path.resolve('.'),
        Path.join(library, 'node_modules/zyzz'),
      )
      await Fs.writeFile(
        Path.join(library, 'node_modules/unlisted/index.ts'),
        `import missing from 'missing-transitive-package';throw missing;`,
      )
      const unlisted = await Vite.build({ ...config, build: { write: false } })
      if (Array.isArray(unlisted) || !('output' in unlisted))
        throw new Error('Expected a Vite build')
      const unlistedCss = unlisted.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')
      expect(/color:\s*red/.test(unlistedCss)).toMatchInlineSnapshot('false')

      config.plugins = [zyzz({ include: ['node_modules/@fixture/library'] })]
      config.server = { ...config.server, fs: { allow: [root, library] } }

      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false, sourcemap: true },
      })
      const output = Array.isArray(result) ? result[0] : result
      if (!output || !('output' in output))
        throw new Error('Expected a Vite build')
      const css = output.output.find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      )
      if (css?.type !== 'asset') throw new Error('Missing CSS output')
      expect(/color:\s*red/.test(String(css.source))).toMatchInlineSnapshot(
        'true',
      )
      expect(
        String(css.source).includes('@layer library'),
      ).toMatchInlineSnapshot('true')
      const map = output.output.find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.js.map'),
      )
      if (map?.type !== 'asset') throw new Error('Missing JavaScript map')
      expect(
        (JSON.parse(String(map.source)).sources as string[]).some((source) =>
          source.endsWith('/card.ts'),
        ),
      ).toMatchInlineSnapshot('true')

      browser = await chromium.launch()
      const production = await browser.newPage()
      const chunk = output.output.find(
        (file) => file.type === 'chunk' && file.isEntry,
      )
      if (chunk?.type !== 'chunk') throw new Error('Missing JavaScript output')
      await production.setContent('<main id="card"></main>')
      await production.addStyleTag({ content: String(css.source) })
      await production.addScriptTag({ type: 'module', content: chunk.code })
      await production.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).color ===
          'rgb(255, 0, 0)',
      )
      expect(
        await production
          .locator('#card')
          .evaluate((node) =>
            getComputedStyle(node).backgroundImage.startsWith('url('),
          ),
      ).toMatchInlineSnapshot('true')
      expect(
        await production
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot('"8px"')
      expect(
        await production.locator('#card').evaluate((node) => {
          node.classList.remove('p-2')
          return getComputedStyle(node).padding
        }),
      ).toMatchInlineSnapshot('"16px"')
      await production.locator('#card').evaluate((node) => {
        node.classList.add('p-2')
      })
      await production.evaluate(() => {
        document.documentElement.style.colorScheme = 'dark'
      })
      expect(
        await production
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 255, 255)"')
      expect(
        await production
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      await production.close()

      server = await Vite.createServer(config)
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).color ===
          'rgb(255, 0, 0)',
      )
      expect(
        await page
          .locator('#card')
          .evaluate((node) =>
            getComputedStyle(node).backgroundImage.startsWith('url('),
          ),
      ).toMatchInlineSnapshot('true')
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot('"8px"')
      expect(
        await page.locator('#card').evaluate((node) => {
          node.classList.remove('p-2')
          return getComputedStyle(node).padding
        }),
      ).toMatchInlineSnapshot('"16px"')
      await page.locator('#card').evaluate((node) => {
        node.classList.add('p-2')
      })
      await page.evaluate(() => {
        document.documentElement.style.colorScheme = 'dark'
      })
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 255, 255)"')
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      await page.evaluate(() => {
        document.documentElement.style.colorScheme = 'light'
      })
      await page.locator('#state').fill('retained')

      await Fs.writeFile(
        Path.join(library, 'card.ts'),
        `import {style} from './theme.js';export const card=style({color:'blue',padding:'24px'});`,
      )
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).color ===
          'rgb(0, 0, 255)',
      )
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"retained"',
      )
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).backgroundImage),
      ).toMatchInlineSnapshot('"none"')

      const global = Path.join(library, 'global.ts')
      await Fs.writeFile(
        global,
        `import {global} from 'zyzz/web';global({'#card':{backgroundColor:'lime'}});`,
      )
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).backgroundColor ===
          'rgb(0, 255, 0)',
      )
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"retained"',
      )

      await Fs.rm(global)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).backgroundColor ===
          'rgba(0, 0, 0, 0)',
      )
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"retained"',
      )
    } finally {
      await browser?.close()
      await server?.close()
      await Fs.rm(root, { force: true, recursive: true })
      await Fs.rm(library, { force: true, recursive: true })
    }
  }, 60000)

  test('shares responsive defaults in production CSS', async () => {
    const { config, root } = await create(Responsive.modules)
    try {
      const result = await Vite.build({
        ...config,
        build: {
          lib: {
            entry: Path.join(root, 'entry.js'),
            formats: ['iife'],
            name: 'Fixture',
          },
          minify: false,
          write: false,
        },
      })
      const output = Array.isArray(result) ? result[0] : result
      if (!output || !('output' in output))
        throw new Error('Expected a Vite build')
      const code = output.output.find((file) => file.type === 'chunk')
      const css = output.output.find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      )
      if (code?.type !== 'chunk' || css?.type !== 'asset')
        throw new Error('Missing fixture output')

      await Responsive.verify({ code: code.code, css: String(css.source) })
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('replaces shared responsive defaults during HMR without reloading', async () => {
    const { config, root } = await create({
      ...Responsive.modules,
      'index.html':
        '<input id="state"><main></main><script type="module" src="/main.js"></script>',
      'main.js': `import {base,first,large,second} from './entry.js';document.querySelector('main').innerHTML='<div class="'+base.className+'"><div id="first" class="'+first.className+'"></div><div class="'+large.className+'"><div id="second" class="'+second.className+'"></div></div></div>';if(import.meta.hot)import.meta.hot.accept();`,
    })
    const server = await Vite.createServer(config)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch()
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')
      const page = await browser.newPage({
        viewport: { height: 600, width: 800 },
      })
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#first')!).fontSize ===
          '14px',
      )
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toMatchInlineSnapshot('"20px"')
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot('"8px"')

      async function css() {
        return page.evaluate(() =>
          [...document.styleSheets]
            .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
            .join('\n'),
        )
      }
      expect(
        (await css()).match(/--z-editorial-labelSize-fallback-[\w-]+:\s*14px/g)
          ?.length,
      ).toMatchInlineSnapshot('1')
      await page.setViewportSize({ height: 600, width: 1200 })
      expect(
        await page
          .locator('#first')
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toMatchInlineSnapshot('"16px"')
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toMatchInlineSnapshot('"24px"')
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot('"12px"')

      await page.setViewportSize({ height: 600, width: 800 })
      await page.waitForLoadState('networkidle')
      await page.locator('#state').fill('preserved')
      await Watch.write({
        path: Path.join(root, 'config.js'),
        source: Responsive.modules['config.js'].replace("'14px'", "'18px'"),
      })
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#first')!).fontSize ===
          '18px',
      )
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"preserved"',
      )
      expect(
        (await css()).match(/--z-editorial-labelSize-fallback-[\w-]+:\s*18px/g)
          ?.length,
      ).toMatchInlineSnapshot('1')
      expect((await css()).includes(': 14px;')).toMatchInlineSnapshot('false')
    } finally {
      await browser?.close()
      await server.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30000)

  test('updates shared dependencies across independently transformed entries', async () => {
    const files: Record<string, string> = {
      'theme.ts':
        "import {Vars} from 'zyzz';export const theme=Vars.define({color:{brand:'red'}})",
      'config.ts':
        "import {Config} from 'zyzz';import {theme} from './theme';export const {style,vars}=Config.create({vars:theme})",
      'index.html':
        '<input id="state"><main id="scope"></main><script type="module" src="/main.ts"></script>',
    }
    for (let i = 0; i < 12; i++)
      files[`card${i}.ts`] =
        `import {style} from './config';export const props=style({color:'brand',opacity:${i === 0 ? '0.5' : '1'}})()`
    files['main.ts'] =
      `${Array.from({ length: 12 }, (_, i) => `import {props as p${i}} from './card${i}';`).join('')}import {vars} from './config';const scope=document.querySelector('#scope')!;scope.dataset.renders=String(Number(scope.dataset.renders??0)+1);scope.className=vars().className;[${Array.from({ length: 12 }, (_, i) => `p${i}`).join(',')}].forEach((p,i)=>{let card=document.querySelector('#card'+i);if(!card){card=document.createElement('div');card.id='card'+i;scope.append(card)}card.textContent='Card';card.className=p.className});if(import.meta.hot)import.meta.hot.accept()`
    const { root, config } = await create(files)
    const server = await Vite.createServer(config)
    const browser = await chromium.launch()
    try {
      await server.listen()
      const page = await browser.newPage()
      await page.goto(server.resolvedUrls!.local[0]!)
      await page.waitForLoadState('networkidle')
      await page.locator('#state').fill('retained')
      await Watch.write({
        path: Path.join(root, 'theme.ts'),
        source: files['theme.ts']!.replace("'red'", "'blue'"),
      })
      // Consumer class names carry the theme value as a fallback, so the
      // accepting entry runs again once its cards and stylesheets update.
      await page.waitForFunction(
        () =>
          document.querySelector('#scope')!.getAttribute('data-renders') ===
          '2',
      )
      expect(
        await page
          .locator('#card11')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
      expect(
        await page
          .locator('#card0')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"retained"',
      )
      await Watch.write({
        path: Path.join(root, 'card0.ts'),
        source: files['card0.ts']!.replace('0.5', '0.75'),
      })
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card0')!).opacity ===
          '0.75',
      )
      expect(
        await page
          .locator('#card11')
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toMatchInlineSnapshot('"1"')
      await Watch.write({
        path: Path.join(root, 'main.ts'),
        source: files['main.ts']!.replace(
          "card.textContent='Card'",
          "card.textContent='Updated'",
        ),
      })
      await page.waitForFunction(
        () => document.querySelector('#card0')?.textContent === 'Updated',
      )
      expect(await page.locator('#state').inputValue()).toMatchInlineSnapshot(
        '"retained"',
      )
    } finally {
      await browser.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('loads package font URLs and static global values in development and production', async () => {
    const { config, root } = await create({
      'index.html':
        '<script type="module" src="/config.ts"></script><p>AAA</p>',
      'tokens.ts': `export const tokens={copy:{fontFamily:'Evidence',fontSize:'20px'}};export type Tokens=typeof tokens;`,
      'config.ts': `import {tokens} from './tokens';import {fontFace,global} from 'zyzz/web';fontFace({fontFamily:'Evidence',src:'url("@fixture/font/font.ttf") format("truetype")'});global({p:tokens.copy});`,
    })
    const directory = await Fs.mkdtemp(Path.resolve('.fixture-font-@pnpm+'))
    const browser = await chromium.launch()
    let server: Vite.ViteDevServer | Vite.PreviewServer | undefined
    try {
      await Fs.writeFile(
        Path.join(directory, 'package.json'),
        JSON.stringify({
          name: '@fixture/font',
          exports: { './font.ttf': './font.ttf' },
        }),
      )
      await Fs.writeFile(
        Path.join(directory, 'font.ttf'),
        Buffer.from(Font.url.split(',')[1]!, 'base64'),
      )
      await Fs.mkdir(Path.join(root, 'node_modules/@fixture'), {
        recursive: true,
      })
      await Fs.symlink(directory, Path.join(root, 'node_modules/@fixture/font'))
      for (const production of [false, true]) {
        if (production) {
          await Vite.build(config)
          server = await Vite.preview({
            ...config,
            preview: { host: '127.0.0.1', port: 0 },
          })
        } else {
          server = await Vite.createServer(config)
          await server.listen()
        }
        const page = await browser.newPage()
        await page.goto(server.resolvedUrls!.local[0]!)
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('p')!).fontFamily ===
            'Evidence',
        )
        expect(
          await page.evaluate(async () => {
            await document.fonts.load('20px Evidence', 'AAA')
            const range = document.createRange()
            range.selectNodeContents(document.querySelector('p')!)
            return {
              loaded: document.fonts.check('20px Evidence', 'AAA'),
              width: range.getBoundingClientRect().width,
            }
          }),
        ).toEqual({ loaded: true, width: 36 })
        await page.close()
        await server.close()
        server = undefined
      }
    } finally {
      await server?.close()
      await browser.close()
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(directory, { recursive: true, force: true })
    }
  }, 30000)

  test('loads relative font URLs from scoped packed contracts in development and production', async () => {
    const { config, root } = await create({
      'index.html': '<script type="module" src="/main.ts"></script><p>AAA</p>',
      'main.ts': `import '@acme/ds/core';import {global} from 'zyzz/web';global({p:{fontFamily:'Evidence',fontSize:'20px'}});`,
    })
    const browser = await chromium.launch()
    let server: Vite.ViteDevServer | Vite.PreviewServer | undefined
    try {
      // The scope places `@` in the installed path that the relative URL resolves against.
      const directory = Path.join(root, 'node_modules/@acme/ds')
      const compiled = Graph.compile({
        modules: {
          'dist/core/index.ts': `import {fontFace} from 'zyzz/web';fontFace({fontFamily:'Evidence',src:"url('../fonts/Evidence.ttf') format('truetype')"});`,
        },
      })

      await Fs.mkdir(Path.join(directory, 'dist/core'), { recursive: true })
      await Fs.mkdir(Path.join(directory, 'dist/fonts'), { recursive: true })
      await Fs.writeFile(
        Path.join(directory, 'package.json'),
        JSON.stringify({
          exports: { './core': './dist/core/index.js' },
          name: '@acme/ds',
          type: 'module',
        }),
      )
      await Fs.writeFile(
        Path.join(directory, 'dist/core/index.js'),
        Esbuild.transformSync(compiled.modules['dist/core/index.ts']!.code, {
          format: 'esm',
          loader: 'ts',
        }).code,
      )
      await Fs.writeFile(
        Path.join(directory, 'dist/core/index.js.zyzz.json'),
        compiled.contracts['dist/core/index.ts']!,
      )
      await Fs.writeFile(
        Path.join(directory, 'dist/fonts/Evidence.ttf'),
        Buffer.from(Font.url.split(',')[1]!, 'base64'),
      )

      for (const production of [false, true]) {
        if (production) {
          await Vite.build(config)
          server = await Vite.preview({
            ...config,
            preview: { host: '127.0.0.1', port: 0 },
          })
        } else {
          server = await Vite.createServer(config)
          await server.listen()
        }

        const page = await browser.newPage()

        await page.goto(server.resolvedUrls!.local[0]!)
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('p')!).fontFamily ===
            'Evidence',
        )

        expect(
          await page.evaluate(async () => {
            await document.fonts.load('20px Evidence', 'AAA')
            const range = document.createRange()
            range.selectNodeContents(document.querySelector('p')!)
            return {
              loaded: document.fonts.check('20px Evidence', 'AAA'),
              width: range.getBoundingClientRect().width,
            }
          }),
        ).toMatchInlineSnapshot(`
          {
            "loaded": true,
            "width": 36,
          }
        `)

        await page.close()
        await server.close()
        server = undefined
      }
    } finally {
      await server?.close()
      await browser.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  for (const reset of [undefined, false, true])
    test(`delivers optional reset in development and production (${reset})`, async () => {
      const { config, root } = await create({
        'index.html':
          '<script type="module" src="/app.ts"></script><h1>Heading</h1><button>Button</button>',
        'app.ts': `import {global,layers} from 'zyzz/web';layers(['components']);global({'@layer components':{button:{fontSize:'24px'}}});`,
      })
      config.plugins = [zyzz({ reset })]
      const browser = await chromium.launch({ headless: true })
      let server: Vite.ViteDevServer | Vite.PreviewServer | undefined
      try {
        for (const production of [false, true]) {
          if (production) {
            await Vite.build(config)
            server = await Vite.preview({
              ...config,
              preview: { host: '127.0.0.1', port: 0 },
            })
          } else {
            server = await Vite.createServer(config)
            await server.listen()
          }
          const page = await browser.newPage()
          await page.goto(server.resolvedUrls!.local[0]!)
          await page.waitForFunction(
            () =>
              getComputedStyle(document.querySelector('button')!).fontSize ===
              '24px',
          )
          const sizing = await page
            .locator('h1')
            .evaluate((node) => getComputedStyle(node).boxSizing)
          if (reset) expect(sizing).toMatchInlineSnapshot('"border-box"')
          else expect(sizing).toMatchInlineSnapshot('"content-box"')
          await page.close()
          await server.close()
          server = undefined
        }
      } finally {
        await server?.close()
        await browser.close()
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 30000)

  test('builds a source-free namespace package for web and native consumers', async () => {
    const root = await Fs.mkdtemp(
      Path.join(Os.tmpdir(), 'zyzz-routing-consumer-'),
    )
    try {
      await Universal.create(root)
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import * as library from '@acme/universal';export const props=library.button({size:'large',active:true});`,
      )
      await Fs.writeFile(
        Path.join(root, 'web.ts'),
        `import '@acme/universal/style.css';export {props} from './app.js';`,
      )
      for (const target of ['native', 'web'] as const) {
        await Vite.build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [
            zyzz(
              target === 'native'
                ? { native: { colorScheme: 'dark', platform: 'android' } }
                : {},
            ),
          ],
          build: {
            outDir: `dist/${target}`,
            lib: {
              entry: Path.join(root, target === 'native' ? 'app.ts' : 'web.ts'),
              formats: [target === 'native' ? 'es' : 'iife'],
              name: 'Consumer',
              cssFileName: 'styles',
              fileName: () => (target === 'native' ? 'native.mjs' : 'web.js'),
            },
          },
        })
      }
      const exec = Util.promisify(ChildProcess.execFile)
      const native = await exec(process.execPath, [
        '--input-type=module',
        '-e',
        `import {props} from ${JSON.stringify(Path.join(root, 'dist/native/native.mjs'))};console.log(JSON.stringify(props));`,
      ])
      expect(JSON.parse(native.stdout)).toMatchInlineSnapshot(`
        {
          "style": {
            "color": "#abcdef",
            "fontSize": 20,
            "opacity": 0.8,
          },
        }
      `)
      expect(await Fs.readdir(Path.join(root, 'dist/native')))
        .toMatchInlineSnapshot(`
        [
          "native.mjs",
        ]
      `)
      const files = await Fs.readdir(Path.join(root, 'dist/web'))
      const css = await Fs.readFile(
        Path.join(
          root,
          'dist/web',
          files.find((file) => file.endsWith('.css'))!,
        ),
        'utf8',
      )
      const js = await Fs.readFile(Path.join(root, 'dist/web/web.js'), 'utf8')
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ colorScheme: 'dark' })
        await page.setContent(
          `<style>:root{color-scheme:dark}${css}</style><div id="actual"></div><div id="control" style="color:#abcdef;font-size:20px;opacity:0.8"></div>`,
        )
        await page.addScriptTag({
          content:
            js +
            `;const element=document.querySelector('#actual');for(const [key,value] of Object.entries(Consumer.props)){if(key==='style')Object.assign(element.style,value);else element.setAttribute(key==='className'?'class':key,String(value))}`,
        })
        const actual = await page.locator('#actual').evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            opacity: style.opacity,
          }
        })
        expect(actual).toMatchInlineSnapshot(`
          {
            "color": "rgb(171, 205, 239)",
            "fontSize": "20px",
            "opacity": "0.8",
          }
        `)
        const control = await page.locator('#control').evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            opacity: style.opacity,
          }
        })
        expect(
          JSON.stringify(actual) === JSON.stringify(control),
        ).toMatchInlineSnapshot('true')
      } finally {
        await browser.close()
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 120000)

  test('builds and updates native modules without web delivery', async () => {
    const { root, config } = await create({
      'config.ts':
        "import {Config} from 'zyzz';export const {style}=Config.create({vars:{color:{ink:{light:'#123456',dark:'#abcdef'}}}});",
      'index.ts': `import {style} from './config.js';export const card=style({color:'ink',targets:{ios:{opacity:0.5},android:{opacity:0.8}}});export const props=card();`,
    })
    const context: { colorScheme: 'dark' | 'light'; platform: 'android' } = {
      colorScheme: 'dark',
      platform: 'android',
    }
    config.plugins = [zyzz({ native: context })]
    context.colorScheme = 'light'
    const server = await Vite.createServer(config)
    try {
      await server.listen()
      const output = await server.transformRequest('/index.ts')
      expect(output!.code.includes('zyzz:')).toMatchInlineSnapshot('false')
      expect(output!.code.includes('#abcdef')).toMatchInlineSnapshot('true')
      const html = await server.transformIndexHtml(
        '/index.html',
        '<html><head></head><body></body></html>',
      )
      expect(html.includes('localStorage')).toMatchInlineSnapshot('false')
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source:
          "import {Config} from 'zyzz';export const {style}=Config.create({vars:{color:{ink:{light:'#123456',dark:'#fedcba'}}}});",
      })
      await vi.waitFor(async () => {
        const updated = await server.transformRequest('/index.ts')
        if (!updated!.code.includes('#fedcba'))
          throw new Error('Waiting for updated theme')
      })
      await server.close()
      await Vite.build({
        ...config,
        build: {
          lib: {
            entry: Path.join(root, 'index.ts'),
            formats: ['es'],
            fileName: () => 'native.mjs',
          },
        },
      })
      const files = await Fs.readdir(Path.join(root, 'dist'))
      expect(files).toMatchInlineSnapshot(`
[
  "native.mjs",
]
`)
      const exec = Util.promisify(ChildProcess.execFile)
      const result = await exec(process.execPath, [
        '--input-type=module',
        '-e',
        `import {props} from ${JSON.stringify(Path.join(root, 'dist/native.mjs'))};console.log(JSON.stringify(props));`,
      ])
      expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
{
  "style": {
    "color": "#fedcba",
    "opacity": 0.8,
  },
}
`)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('rejects native output without source compilation', () => {
    expect(() =>
      zyzz({ compiler: false, native: { colorScheme: 'light' } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Native builds require source compilation.]`,
    )
  })

  for (const configuration of [false, true]) {
    function source(value: string) {
      const migrated = value
        .replace(
          /\{ mint, props as libraryProps, style, theme \}/g,
          '{ vars, props as libraryProps, style, theme }',
        )
        .replace(
          '{ mint, props, style, theme }',
          '{ vars, props, style, theme }',
        )
        .replaceAll('theme.tokens.', 'theme.')
        .replaceAll('mint.className', "vars({set:'mint'}).className")
        .replaceAll('theme.className', 'vars().className')
      if (!configuration) return migrated
      return migrated
        .replace(
          '{ vars, props as libraryProps, style, theme }',
          '{ zyzz, props as libraryProps }',
        )
        .replace('{ vars, props, style, theme }', '{ zyzz, props }')
        .replace('{ style, theme }', '{ zyzz }')
        .replace(/\btheme\./g, 'zyzz.vars.')
        .replace(/(?<!\.)\bvars\(/g, 'zyzz.vars(')
        .replace(/(?<!\.)\bstyle\(/g, 'zyzz.style(')
        .replace('Vars.extend(theme,', 'Vars.extend(zyzz.vars,')
        .replaceAll('zyzz.zyzz.style', 'zyzz.style')
    }

    test(`packed ${configuration ? 'configurations' : 'themes'} retain types and compile through Vite package exports`, async () => {
      const directory = await Fs.mkdtemp(Path.resolve('.fixture-library-'))

      try {
        const root = await Library.create(directory, { configuration })

        await Fs.writeFile(
          Path.join(root, 'app.ts'),
          source(`import { mint, props as libraryProps, style, theme } from '@acme/theme';
import '@acme/theme/style.css';
export const props = style({color:theme.tokens.color.brand,padding:'md'})();
export const scope = mint.className;
export { libraryProps };
document.body.innerHTML = '<main class="' + scope + '"><div id="library" class="' + libraryProps.className + '"></div><div id="app" class="' + props.className + '"></div></main>';`),
        )
        await Fs.writeFile(
          Path.join(root, 'types.ts'),
          source(`import { style, theme } from '@acme/theme'; style({color:'brand',padding:'md'}); style({color:theme.tokens.color.brand});
// @ts-expect-error Unknown tokens remain invalid through packed declarations.
style({color:'missing'});
// @ts-expect-error Imported references preserve property domains.
style({padding:theme.tokens.color.brand});
${configuration ? "zyzz.style({'@layer components':{color:'brand'}});\n// @ts-expect-error Packed layer keys remain exact.\nzyzz.style({'@layer missing':{color:'brand'}});" : ''}`),
        )

        const checked = await Util.promisify(ChildProcess.execFile)(
          process.execPath,
          [
            Path.resolve('node_modules/typescript/bin/tsc'),
            '--ignoreConfig',
            '--customConditions',
            'src',
            '--module',
            'nodenext',
            '--target',
            'esnext',
            '--strict',
            '--skipLibCheck',
            '--noEmit',
            Path.join(root, 'types.ts'),
          ],
        )

        expect(checked.stdout).toMatchInlineSnapshot(`""`)

        // Remove negative type probes before the eager application source scan.
        await Fs.rm(Path.join(root, 'types.ts'))

        await Fs.writeFile(
          Path.join(root, 'index.html'),
          '<script type="module" src="/app.ts"></script>',
        )

        const config: Vite.InlineConfig = {
          build: { cssTarget: ['chrome123', 'firefox128', 'safari17.5'] },
          configFile: false,
          logLevel: 'silent',
          optimizeDeps: { exclude: ['@acme/theme'] },
          plugins: [zyzz()],
          root,
          server: { host: '127.0.0.1', port: 0 },
        }

        const build = await Vite.build({ ...config, build: { minify: false } })
        if (Array.isArray(build) || !('output' in build))
          throw new Error('Expected a Vite build')

        const scripts = build.output
          .filter((entry) => entry.type === 'chunk')
          .map((entry) => entry.code)
          .join('\n')

        expect(
          /Theme\.define|theme\.tokens|\.style\(\{|zyzz\.json|Unsupported Zyzz contract/.test(
            scripts,
          ),
        ).toMatchInlineSnapshot(`false`)

        const styles = build.output
          .filter(
            (entry) =>
              entry.type === 'asset' && entry.fileName.endsWith('.css'),
          )
          .map((entry) => (entry.type === 'asset' ? String(entry.source) : ''))
          .join('\n')

        expect(styles.includes('light-dark(')).toMatchInlineSnapshot(`true`)

        const server = await Vite.createServer(config)

        try {
          await server.listen()

          const transformed = await server.transformRequest('/app.ts')

          expect(
            transformed!.code.includes('theme.tokens'),
          ).toMatchInlineSnapshot(`false`)

          const origin = server.resolvedUrls!.local[0]!.replace(/\/$/, '')
          const cssPath = transformed!.code.match(
            /import "([^"\n]*zyzz:(?!shared\.css)[^"\n]*\.css)"/,
          )![1]!
          const css = await (await fetch(origin + cssPath)).text()

          expect(css.includes('--z-color-brand')).toMatchInlineSnapshot(`true`)
        } finally {
          await server.close()
        }
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    }, 30000)

    test(`packed ${configuration ? 'configuration' : 'theme'} library and app styles share scopes and schemes in Chromium`, async () => {
      const directory = await Fs.mkdtemp(
        Path.resolve('.fixture-library-browser-'),
      )

      try {
        const root = await Library.create(directory, { configuration })

        await Fs.writeFile(
          Path.join(root, 'index.html'),
          '<script type="module" src="/app.ts"></script>',
        )
        await Fs.writeFile(
          Path.join(root, 'app.ts'),
          source(
            "import {Config} from 'zyzz';\nimport { mint, props, style, theme } from '@acme/theme'; import { Vars } from 'zyzz'; import '@acme/theme/style.css';\nconst extended = Vars.extend(theme, {spacing:{md:'16px'}}); const extendedConfig=Config.create({id:'extended',vars:extended});const extendedProps=extendedConfig.style({color:'brand',padding:'md'})();\nconst app = style({color:'brand'})();\ndocument.body.innerHTML = '<main class=\"' + mint.className + '\"><div id=\"library\" class=\"' + props.className + '\"></div><div id=\"app\" class=\"' + app.className + '\"></div><section class=\"' + theme.className + '\"><div id=\"nested\" class=\"' + app.className + '\"></div></section><section class=\"' + extendedConfig.vars().className + '\"><div id=\"extended\" class=\"' + extendedProps.className + '\"></div></section></main>';",
          ),
        )

        const config: Vite.InlineConfig = {
          build: { cssTarget: ['chrome123', 'firefox128', 'safari17.5'] },
          configFile: false,
          logLevel: 'silent',
          optimizeDeps: { exclude: ['@acme/theme'] },
          plugins: [zyzz()],
          root,
          server: { host: '127.0.0.1', port: 0 },
        }

        await Vite.build(config)

        const server = await Vite.preview({
          ...config,
          preview: { host: '127.0.0.1', port: 0 },
        })

        try {
          const browser = await chromium.launch()

          try {
            const page = await browser.newPage()

            await page.goto(server.resolvedUrls!.local[0]!)
            await page.waitForSelector('#app', { state: 'attached' })

            for (const selector of ['#library', '#app']) {
              expect(
                await page
                  .locator(selector)
                  .evaluate((element) => getComputedStyle(element).color),
              ).toMatchInlineSnapshot(`"rgb(17, 119, 85)"`)
            }

            expect(
              await page
                .locator('#library')
                .evaluate((element) => getComputedStyle(element).padding),
            ).toMatchInlineSnapshot(`"8px"`)
            expect(
              await page
                .locator('#extended')
                .evaluate((element) => getComputedStyle(element).padding),
            ).toMatchInlineSnapshot(`"16px"`)

            expect(
              await page
                .locator('#nested')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)

            const className = await page.locator('#app').getAttribute('class')

            await page.evaluate(() => {
              document.documentElement.style.colorScheme = 'dark'
            })

            expect(
              await page
                .locator('#app')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot(`"rgb(170, 255, 170)"`)
            expect(
              await page
                .locator('#library')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot(`"rgb(170, 255, 170)"`)
            expect(
              await page
                .locator('#nested')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot(`"rgb(153, 204, 255)"`)
            expect(
              (await page.locator('#app').getAttribute('class')) === className,
            ).toMatchInlineSnapshot(`true`)
          } finally {
            await browser.close()
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.httpServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          )
        }
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    }, 30000)
  }

  test.each(['atomic', 'grouped'] as const)(
    'production leaves lazy styles in Vite dynamic chunks (%s)',
    async (cssOutput) => {
      const { config, root } = await create({
        ...Fixture.lazyFiles,
        'config.ts': Fixture.files['config.ts'].replace(
          'Config.create({',
          `Config.create({cssOutput:'${cssOutput}',`,
        ),
      })

      try {
        await Fs.appendFile(
          Path.join(root, 'lazy.ts'),
          `\nthrow new Error('lazy source was executed');`,
        )

        const result = await Vite.build({
          ...config,
          build: { manifest: true, minify: false, write: false },
        })
        if (Array.isArray(result) || !('output' in result))
          throw new Error('Expected one Vite build output')

        const manifest = result.output.find(
          (file) => file.fileName === '.vite/manifest.json',
        )
        if (!manifest || manifest.type !== 'asset')
          throw new Error('Missing Vite manifest')

        const entries = JSON.parse(String(manifest.source)) as Record<
          string,
          {
            css?: string[]
            dynamicImports?: string[]
            isDynamicEntry?: boolean
          }
        >

        expect(entries['index.html']?.dynamicImports).toMatchInlineSnapshot(`
        [
          "lazy.ts",
        ]
      `)

        const entryCss = result.output
          .flatMap((file) =>
            file.type === 'asset' &&
            entries['index.html']?.css?.includes(file.fileName)
              ? [String(file.source)]
              : [],
          )
          .join('')

        expect(entryCss.trim()).toMatchInlineSnapshot(`
          ".z_scheme-dark{color-scheme:dark;}
          .z_scheme-light{color-scheme:light;}
          .z_scheme-light-dark{color-scheme:light dark;}
          .z-theme-app-base{--z-app-color-brand:#06c;}
          .z-theme-app-mint{--z-app-color-brand:#175;}"
        `)
        expect(entries['lazy.ts']?.isDynamicEntry).toMatchInlineSnapshot('true')
        expect(entries['lazy.ts']?.css?.length).toMatchInlineSnapshot('1')

        const sheet = result.output.find(
          (file) => file.fileName === entries['lazy.ts']?.css?.[0],
        )
        if (!sheet || sheet.type !== 'asset')
          throw new Error('Missing lazy stylesheet')

        expect(String(sheet.source).includes('#175')).toMatchInlineSnapshot(
          'false',
        )
        expect(
          String(sheet.source).includes('padding:8px'),
        ).toMatchInlineSnapshot('true')

        const javascript = result.output
          .filter((file) => file.type === 'chunk')
          .map((file) => file.code)
          .join('\n')

        expect(javascript.includes('Theme.define')).toMatchInlineSnapshot(
          'false',
        )
        expect(
          javascript.includes('lazy source was executed'),
        ).toMatchInlineSnapshot('true')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
  )

  test('development loads dynamic modules through Vite and preserves SSR imports', async () => {
    const { config, root } = await create(Fixture.lazyFiles)
    const server = await Vite.createServer(config)

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${origin}/main.ts`)

      expect(response.status).toMatchInlineSnapshot('200')
      expect(
        (await response.text()).includes('import("/lazy.ts")'),
      ).toMatchInlineSnapshot('true')

      const lazy = await fetch(`${origin}/lazy.ts`)

      expect(lazy.status).toMatchInlineSnapshot('200')

      const cssPath = (await lazy.text()).match(
        /import\s*["']([^"']*zyzz:shared\.css)["']/,
      )?.[1]
      if (!cssPath) throw new Error('Missing shared CSS import')

      expect(
        (await (await fetch(origin + cssPath)).text()).includes('#175'),
      ).toMatchInlineSnapshot('true')

      await Fs.writeFile(
        Path.join(root, 'server.ts'),
        `export const load = () => import('./card');`,
      )

      const module = (await server.ssrLoadModule('/server.ts')) as {
        load: () => Promise<{ props: { className: string } }>
      }

      expect((await module.load()).props.className).toMatchInlineSnapshot(
        `"z-app-rnRBDm-text-[var(--z-app-color-brand,#06c)] z-app-rnRBDm-p-8px"`,
      )
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('pre-bundles the installed runtime before the first client and SSR requests', async () => {
    const root = await install({
      'index.html':
        '<main id="card"></main><script type="module" src="/main.ts"></script>',
      'main.ts':
        "import { style } from 'zyzz'\n\nexport const card = style({ color: 'red' })\n\ndocument.querySelector('#card')!.className = card().className\n",
      'server.ts':
        "import { style } from 'zyzz'\n\nexport const card = style({ color: 'red' })\n\nexport const className = card().className\n",
    })
    const server = await Vite.createServer({
      configFile: false,
      environments: {
        // Worker runtimes bundle server dependencies and discover them as the client does.
        ssr: {
          optimizeDeps: { entries: ['server.ts'], noDiscovery: false },
          resolve: { noExternal: true },
        },
      },
      logLevel: 'silent',
      plugins: [zyzz()],
      root,
      server: { host: '127.0.0.1', port: 0 },
    })

    // Settles the initial optimizer run and any re-run a request triggers.
    async function settle(environment: Vite.DevEnvironment) {
      const optimizer = environment.depsOptimizer!

      await environment.waitForRequestsIdle()
      await optimizer.scanProcessing
      await Promise.all(
        Object.values(optimizer.metadata.discovered).map(
          (dependency) => dependency.processing,
        ),
      )

      return optimizer.metadata
    }

    try {
      await server.listen()

      const client = server.environments.client
      const initial = await settle(client)

      expect(Object.keys(initial.optimized)).toMatchInlineSnapshot(`
        [
          "zyzz",
          "zyzz/runtime",
        ]
      `)

      const main = await fetch(
        new URL('main.ts', server.resolvedUrls!.local[0]!),
      )

      expect(main.status).toMatchInlineSnapshot(`200`)
      expect(
        (await main.text()).includes(
          '/node_modules/.vite/deps/zyzz_runtime.js?v=',
        ),
      ).toMatchInlineSnapshot(`true`)
      // A re-run replaces the optimizer metadata.
      expect((await settle(client)) === initial).toMatchInlineSnapshot(`true`)

      const ssr = server.environments.ssr
      const initialSsr = await settle(ssr)

      expect(Object.keys(initialSsr.optimized)).toMatchInlineSnapshot(`
        [
          "zyzz",
          "zyzz/runtime",
        ]
      `)

      const module = (await server.ssrLoadModule('/server.ts')) as {
        className: string
      }

      expect(module.className).toMatchInlineSnapshot(
        `"z-Skd157-text-red z-style-Skd157-card"`,
      )
      expect((await settle(ssr)) === initialSsr).toMatchInlineSnapshot(`true`)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  test('leaves excluded, aliased, and undiscovered runtimes out of optimizeDeps.include', async () => {
    const root = await install()

    try {
      for (const options of [
        { optimizeDeps: { exclude: ['zyzz'] } },
        // Aliased and linked runtimes resolve outside node_modules.
        {
          resolve: {
            alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
          },
        },
      ]) {
        const server = await Vite.createServer({
          ...options,
          configFile: false,
          logLevel: 'silent',
          plugins: [zyzz()],
          root,
        })

        try {
          expect(
            server.environments.client.config.optimizeDeps.include,
          ).toMatchInlineSnapshot(`[]`)
          // The default SSR environment externalizes dependencies without discovery.
          expect(
            server.environments.ssr.config.optimizeDeps.include,
          ).toMatchInlineSnapshot(`[]`)
        } finally {
          await server.close()
        }
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('reads environment options that later plugins set before including the runtime', async () => {
    const root = await install()
    const server = await Vite.createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        zyzz(),
        {
          // Runs after the pre-enforced Zyzz plugin in hook order.
          configEnvironment: () => ({ optimizeDeps: { noDiscovery: true } }),
          name: 'no-discovery',
        },
      ],
      root,
    })

    try {
      expect(
        server.environments.client.config.optimizeDeps.include,
      ).toMatchInlineSnapshot(`[]`)
      expect(server.environments.client.depsOptimizer).toMatchInlineSnapshot(
        `undefined`,
      )
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('includes a symlinked runtime only when Vite preserves symlinks', async () => {
    const root = await install()
    const linked = await Fs.mkdtemp(Path.resolve('.fixture-vite-linked-'))
    const installed = Path.join(root, 'node_modules/zyzz')

    await Fs.rename(installed, Path.join(linked, 'zyzz'))
    await Fs.symlink(Path.join(linked, 'zyzz'), installed, 'dir')

    // Reads the client include list with Vite's symlink policy.
    async function include(preserveSymlinks: boolean) {
      const server = await Vite.createServer({
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        resolve: { preserveSymlinks },
        root,
      })

      try {
        return server.environments.client.config.optimizeDeps.include
      } finally {
        await server.close()
      }
    }

    try {
      expect(await include(false)).toMatchInlineSnapshot(`[]`)
      expect(await include(true)).toMatchInlineSnapshot(`
        [
          "zyzz/runtime",
        ]
      `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
      await Fs.rm(linked, { recursive: true, force: true })
    }
  })

  test.each(['atomic', 'grouped'] as const)(
    'lazy CSS loads on demand and updates without reload in Chromium (%s)',
    async (cssOutput) => {
      const { config, root } = await create({
        ...Fixture.lazyFiles,
        'config.ts': Fixture.files['config.ts'].replace(
          'Config.create({',
          `Config.create({cssOutput:'${cssOutput}',`,
        ),
      })
      const server = await Vite.createServer(config)
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

      try {
        browser = await chromium.launch()
        await server.listen()

        const address = server.httpServer!.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing server port')

        const page = await browser.newPage()

        await page.goto(`http://127.0.0.1:${address.port}`)

        expect(
          await page.locator('#card').getAttribute('class'),
        ).toMatchInlineSnapshot('null')

        await page.click('#load')
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#card')!).color ===
            'rgb(17, 119, 85)',
        )

        expect(
          await page
            .locator('#card')
            .evaluate((element) => getComputedStyle(element).padding),
        ).toMatchInlineSnapshot('"8px"')

        // Wait for startup document reloads before asserting edit-time node preservation.
        await page.waitForLoadState('networkidle')
        await page
          .locator('#card')
          .evaluate((element) => element.setAttribute('data-preserved', 'yes'))
        await Watch.write({
          path: Path.join(root, 'alternate.ts'),
          source: Fixture.files['alternate.ts'].replace('#175', '#f00'),
        })
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#card')!).color ===
            'rgb(255, 0, 0)',
        )

        await Watch.write({
          path: Path.join(root, 'card.ts'),
          source: Fixture.files['card.ts'].replace('8px', '16px'),
        })
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#card')!).padding ===
            '16px',
        )

        expect(
          await page.locator('#card').getAttribute('data-preserved'),
        ).toMatchInlineSnapshot('"yes"')
      } finally {
        await browser?.close()
        await server.close()
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test.each(['atomic', 'grouped'] as const)(
    'production loads lazy HTML styles once on demand (%s)',
    async (cssOutput) => {
      const { config, root } = await create({
        ...Fixture.lazyFiles,
        'config.ts': Fixture.files['config.ts'].replace(
          'Config.create({',
          `Config.create({cssOutput:'${cssOutput}',`,
        ),
      })
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      let preview: Vite.PreviewServer | undefined
      try {
        await Vite.build(config)
        preview = await Vite.preview({
          ...config,
          preview: { host: '127.0.0.1', port: 0 },
        })
        browser = await chromium.launch()
        const page = await browser.newPage()
        const sheets: string[] = []
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        page.on('request', (request) => {
          if (new URL(request.url()).pathname.endsWith('.css'))
            sheets.push(request.url())
        })
        await page.goto(preview.resolvedUrls!.local[0]!)
        const initialRequests = sheets.length
        expect(
          await page.evaluate(
            () =>
              [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
                .length,
          ),
        ).toMatchInlineSnapshot(`5`)
        expect(
          await page.locator('#card').getAttribute('class'),
        ).toMatchInlineSnapshot('null')
        await page
          .locator('#card')
          .evaluate((element) => element.setAttribute('data-preserved', 'yes'))
        for (const iteration of [0, 1]) {
          if (iteration)
            await page
              .locator('#card')
              .evaluate((element) => element.removeAttribute('class'))
          await page.click('#load')
          await page.waitForFunction(
            () =>
              getComputedStyle(document.querySelector('#card')!).color ===
              'rgb(17, 119, 85)',
          )
          expect(
            await page
              .locator('#card')
              .evaluate((element) => getComputedStyle(element).padding),
          ).toMatchInlineSnapshot('"8px"')
          expect(sheets.length - initialRequests).toMatchInlineSnapshot('1')
          expect(
            await page.locator('#card').getAttribute('data-preserved'),
          ).toMatchInlineSnapshot('"yes"')
        }
        expect(
          await page.evaluate((grouped) => {
            const card = document.querySelector('#card')!
            const rules = [...document.styleSheets]
              .flatMap((sheet) => [...sheet.cssRules])
              .filter(
                (rule): rule is CSSStyleRule =>
                  rule instanceof CSSStyleRule &&
                  card.matches(rule.selectorText) &&
                  rule.style.padding === '8px',
              )
            return (
              rules.length > 0 &&
              rules.every((rule) => Boolean(rule.style.color) === grouped)
            )
          }, cssOutput === 'grouped'),
        ).toMatchInlineSnapshot('true')
        expect(errors).toMatchInlineSnapshot('[]')
      } finally {
        await browser?.close()
        if (preview)
          await new Promise<void>((resolve, reject) =>
            preview!.httpServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          )
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test('production uses Vite resolution and emits linked CSS without executing sources', async () => {
    const { config, root } = await create()

    try {
      await Fs.appendFile(
        Path.join(root, 'theme.ts'),
        `\nthrow new Error('authoring was executed');`,
      )

      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const sheet = result.output.find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      )
      if (!sheet || sheet.type !== 'asset')
        throw new Error('No stylesheet emitted')

      expect(String(sheet.source)).toMatchInlineSnapshot(`
        ".z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z-theme-app-base{--z-app-color-brand:#06c;}
        .z-theme-app-mint{--z-app-color-brand:#175;}.z_app-rnRBDm0{color:var(--z-app-color-brand,#06c);}
        .z_app-rnRBDm1{padding:8px;}"
      `)

      const javascript = result.output
        .filter((file) => file.type === 'chunk')
        .map((file) => file.code)
        .join('\n')

      expect(javascript.includes('Theme.define')).toMatchInlineSnapshot(`false`)
      expect(
        javascript.includes('authoring was executed'),
      ).toMatchInlineSnapshot(`false`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('production links no stylesheet for a chunk without styles', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'main.ts': `import { props } from './card'; document.body.className = props.className; void import('./plain');`,
      'plain.ts': `export const label = 'plain';`,
    })

    try {
      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const plain = result.output.find(
        (file) => file.type === 'chunk' && file.name === 'plain',
      )
      if (!plain || plain.type !== 'chunk')
        throw new Error('Missing plain chunk')

      expect([...plain.viteMetadata!.importedCss]).toMatchInlineSnapshot(`[]`)
      expect(
        result.output.flatMap((file) =>
          file.type === 'asset' &&
          file.fileName.endsWith('.css') &&
          !String(file.source).trim()
            ? [file.names]
            : [],
        ),
      ).toMatchInlineSnapshot(`[]`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('production keeps only the identity classes that selectors reference', async () => {
    const { config, root } = await create({
      'index.html': `<!doctype html><html><head><title>Fixture</title></head><body><script type="module" src="/main.ts"></script></body></html>`,
      'card.ts': `import { style } from 'zyzz';export const card = style({ color: 'red' });export const label = style({ color: 'blue' });`,
      'item.ts': `import { style } from 'zyzz';import { card } from './card';export const item = style({ selectors: { [\`\${card}:hover &\`]: { color: 'green' } } });`,
      'main.ts': `import { card, label } from './card';import { item } from './item';document.body.className = [card().className, label().className, item().className].join(' ');`,
    })

    try {
      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const javascript = result.output
        .filter((file) => file.type === 'chunk')
        .map((file) => file.code)
        .join('\n')
      const stylesheet = result.output
        .filter(
          (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
        )
        .map((file) => (file.type === 'asset' ? String(file.source) : ''))
        .join('\n')

      // The card module's graph includes the selector that interpolates card, so only card
      // keeps its identity class.
      expect([...new Set(javascript.match(/z-style-[\w-]+/g))])
        .toMatchInlineSnapshot(`
        [
          "z-style-rnRBDm-card",
        ]
      `)
      expect([...new Set(stylesheet.match(/z-style-[\w-]+/g))])
        .toMatchInlineSnapshot(`
        [
          "z-style-rnRBDm-card",
        ]
      `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('derives contracts for installed packages without sidecars', async () => {
    const { config, root } = await create({
      'index.html': `<!doctype html><html><head><title>Fixture</title></head><body><script type="module" src="/main.ts"></script></body></html>`,
      'main.ts': `import {global} from 'zyzz/web';import {style,vars} from '@acme/tokens';global({':root':{'--gap':vars.spacing['16']}});document.body.className=style({padding:'16'})().className;`,
    })

    try {
      await PlainPackage.install(root)
      await Fs.symlink(
        process.cwd(),
        Path.join(root, 'node_modules/zyzz'),
        'dir',
      )

      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const sheet = result.output.find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      )
      if (!sheet || sheet.type !== 'asset')
        throw new Error('No stylesheet emitted')

      expect(String(sheet.source)).toMatchInlineSnapshot(`
        ":root{--gap:var(--z-acme-spacing-16,16px);}
        .z-theme-acme_2f_variables-variables{--z-acme_2f_variables-color-ink:#123456;--z-acme_2f_variables-spacing-16:16px;}
        .z-theme-acme-theme{--z-acme-spacing-16:16px;--z-acme-color-ink:#123456;}.z_acme-YiE3S90{padding:var(--z-acme-spacing-16,16px);}"
      `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('derives an installed package contract once across module compiles', async () => {
    const component = (name: string) =>
      `import {style} from '@acme/tokens';export const ${name} = style({padding:'16'})().className;`
    const { config, root } = await create({
      'a.ts': component('a'),
      'b.ts': component('b'),
      'c.ts': component('c'),
      'main.ts': `import {a} from './a.js';import {b} from './b.js';import {c} from './c.js';document.body.className=[a,b,c].join(' ');`,
    })

    try {
      const directory = await PlainPackage.install(root)
      await Fs.symlink(
        process.cwd(),
        Path.join(root, 'node_modules/zyzz'),
        'dir',
      )
      const sidecar = Path.join(
        await Fs.realpath(directory),
        'dist/index.js.zyzz.json',
      )
      const server = await Vite.createServer(config)
      const stat = vi.spyOn(NodeFs.promises, 'stat')

      try {
        await server.transformRequest('/main.ts')
        await server.transformRequest('/a.ts')

        // Each lookup of a sidecar-less package first probes its missing sidecar.
        expect(
          stat.mock.calls.filter(([file]) => file === sidecar).length,
        ).toMatchInlineSnapshot(`1`)
      } finally {
        stat.mockRestore()
        await server.close()
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('names independent rules consistently across per-module graphs', async () => {
    // Vite compiles each module within several graphs, so siblings never borrow each other's names.
    const { config, root } = await create({
      'card.ts': `import { style } from './config.js'
export namespace styles {
  export const card = style({ color: 'red', padding: '8px' })
}
`,
      'config.ts': `import { defineConfig } from 'zyzz'
export const { style } = defineConfig({ composition: 'independent' })
`,
      'index.html': '<script type="module" src="./main.ts"></script>',
      'label.ts': `import { style } from './config.js'
namespace styles {
  export const label = style({ color: 'red', padding: '4px' })
}
export const label = styles.label().className
`,
      'main.ts': `import { cx } from 'zyzz'
import { label } from './label.js'
import { styles as shared } from './card.js'
import { style } from './config.js'
namespace styles {
  export const local = style({ color: 'blue' })
}
export function props(flag: boolean) {
  return cx(flag && shared.card(), styles.local())
}
Object.assign(globalThis, { fixture: { card: shared.card().className, label, props } })
`,
    })

    try {
      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const css = result.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')
      const javascript = result.output
        .flatMap((file) => (file.type === 'chunk' ? [file.code] : []))
        .join('\n')
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(`<style>${css}</style>`)
        await page.addScriptTag({ content: javascript, type: 'module' })

        const fixture = await page.waitForFunction(() => {
          const value = (
            globalThis as unknown as {
              fixture?: {
                card: string
                label: string
                props: (flag: boolean) => { className: string }
              }
            }
          ).fixture
          return (
            value && {
              card: value.card,
              composed: value.props(true).className,
              label: value.label,
            }
          )
        })

        // The label keeps its own names, and the consumer's composition strips the card's classes.
        expect(await fixture.jsonValue()).toMatchInlineSnapshot(`
          {
            "card": "z_rnRBDm0 z_rnRBDm1",
            "composed": "z_YiE3S91 z_rnRBDm1",
            "label": "z_ya-T9A0 z_ya-T9A1",
          }
        `)
      } finally {
        await browser.close()
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('keeps consumer overrides after rules that unrelated modules share', async () => {
    // The unrelated module repeats the button's declarations after the overriding modules.
    const { config, root } = await create({
      'button.ts': `import { style } from 'zyzz'
namespace styles {
  export const base = style({ background: '#2563eb', borderColor: '#000', color: '#fff' })
}
export function button(props: { className?: string | undefined } = {}) {
  return styles.base({ className: props.className })
}
`,
      'ghost.ts': `import { style } from 'zyzz'
import { button } from './button.js'
namespace styles {
  export const ghost = style({ background: 'transparent', color: '#374151' })
}
export function ghost(props: { className?: string | undefined } = {}) {
  return button(styles.ghost({ className: props.className }))
}
`,
      'index.html': '<script type="module" src="./main.ts"></script>',
      'main.ts': `import { ghost } from './ghost.js'
import { primary } from './primary.js'
import { unrelated } from './unrelated.js'
Object.assign(globalThis, {
  fixture: {
    ghost: ghost().className,
    primary: primary().className,
    unrelated: unrelated().className,
  },
})
`,
      'primary.ts': `import { style } from 'zyzz'
import { ghost } from './ghost.js'
namespace styles {
  export const primary = style({ borderColor: '#2563eb', color: '#2563eb' })
}
export function primary(props: { className?: string | undefined } = {}) {
  return ghost(styles.primary({ className: props.className }))
}
`,
      'unrelated.ts': `import { style } from 'zyzz'
namespace styles {
  export const card = style({ background: '#2563eb', color: '#fff' })
}
export function unrelated(props: { className?: string | undefined } = {}) {
  return styles.card({ className: props.className })
}
`,
    })

    try {
      const result = await Vite.build({
        ...config,
        build: { minify: false, write: false },
      })
      if (Array.isArray(result) || !('output' in result))
        throw new Error('Expected one Vite build output')

      const css = result.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')
      const javascript = result.output
        .flatMap((file) => (file.type === 'chunk' ? [file.code] : []))
        .join('\n')
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(`<style>${css}</style>`)
        await page.addScriptTag({ content: javascript, type: 'module' })
        await page.waitForFunction(() => 'fixture' in globalThis)

        const styles = await page.evaluate(() => {
          const fixture = (
            globalThis as unknown as {
              fixture: Record<'ghost' | 'primary' | 'unrelated', string>
            }
          ).fixture

          return Object.fromEntries(
            Object.entries(fixture).map(([name, className]) => {
              const element = document.createElement('button')

              element.className = className
              document.body.append(element)

              const style = getComputedStyle(element)

              return [
                name,
                `${style.backgroundColor} ${style.borderTopColor} ${style.color}`,
              ]
            }),
          )
        })

        expect(styles).toMatchInlineSnapshot(`
          {
            "ghost": "rgba(0, 0, 0, 0) rgb(0, 0, 0) rgb(55, 65, 81)",
            "primary": "rgba(0, 0, 0, 0) rgb(37, 99, 235) rgb(37, 99, 235)",
            "unrelated": "rgb(37, 99, 235) rgb(0, 0, 0) rgb(255, 255, 255)",
          }
        `)
        expect(css).toMatchInlineSnapshot(`
          ".z_PTgY5k0{background:#2563eb;}
          .z_PTgY5k1{border-color:#000;}
          .z_PTgY5k2{color:#fff;}.z_toAUkB0{background:transparent;}
          .z_toAUkB1{color:#374151;}.z_NZ8pJe0{border-color:#2563eb;}
          .z_NZ8pJe1{color:#2563eb;}.z_z2JeWm0{background:#2563eb;}
          .z_z2JeWm1{color:#fff;}"
        `)
      } finally {
        await browser.close()
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('ignores Node builtins in unreachable server files during browser discovery', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'server.ts': `import { readFile } from 'node:fs/promises'; import path from 'path'; export const read = () => readFile(path.resolve('data.json'));`,
    })
    try {
      const result = await Vite.build({
        ...config,
        environments: { client: { resolve: { noExternal: true } } },
        build: { write: false },
      })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')
      expect(
        output.output.some(
          (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
        ),
      ).toMatchInlineSnapshot(`true`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('keeps server-only contributions out of client stylesheets', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'entry.server.ts': `import { global } from 'zyzz/web'; global({ body: { color: 'rebeccapurple' } });`,
    })
    const server = await Vite.createServer(config)
    try {
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')
      const origin = `http://127.0.0.1:${address.port}`
      const code = await (await fetch(`${origin}/main.ts`)).text()
      const path = code.match(/import\s*["']([^"']*zyzz:shared\.css)["']/)?.[1]
      if (!path) throw new Error('Missing shared stylesheet')
      const response = await fetch(`${origin}${path}?direct`)
      expect(response.status).toMatchInlineSnapshot('200')
      expect(
        (await response.text()).includes('rebeccapurple'),
      ).toMatchInlineSnapshot('false')

      const result = await Vite.build({ ...config, build: { write: false } })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')
      const css = output.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [file.source]
            : [],
        )
        .join('\n')
      expect(css.includes('rebeccapurple')).toMatchInlineSnapshot('false')
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('skips excluded sources and tool configuration in development and production', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'card.stories.ts': `import { global } from 'zyzz/web'; global({ body: { color: 'rebeccapurple' } });`,
      // The server bundle does not exist until a production build writes it.
      'server.mjs': `import { createServer } from 'node:http'; import handler from './dist/server/index.js'; createServer(handler).listen(3000);`,
      'vitest.config.ts': `import { defineConfig } from 'tool'; export default defineConfig({});`,
    })
    const options = {
      ...config,
      // Skips the entry scan but keeps runtime discovery of resolved packages.
      optimizeDeps: { entries: [] },
      plugins: [zyzz({ exclude: ['server.mjs', /\.stories\.ts$/] })],
      resolve: {
        alias: {
          ...(config.resolve!.alias as Record<string, string>),
          'zyzz/web': Path.resolve('src/web/index.ts'),
        },
      },
    }

    await Fs.mkdir(Path.join(root, 'node_modules/tool'), { recursive: true })
    await Fs.writeFile(
      Path.join(root, 'node_modules/tool/package.json'),
      JSON.stringify({ exports: './index.js', name: 'tool', type: 'module' }),
    )
    await Fs.writeFile(
      Path.join(root, 'node_modules/tool/index.js'),
      'export const defineConfig = (config) => config;',
    )

    const server = await Vite.createServer(options)
    try {
      await server.listen()

      const main = await server.transformRequest('/main.ts')
      const shared = await server.transformRequest('\0zyzz:shared.css')
      const metadata = server.environments.client.depsOptimizer!.metadata

      expect(main!.code.includes('zyzz:shared.css')).toMatchInlineSnapshot(
        `true`,
      )
      expect(shared!.code.includes('rebeccapurple')).toMatchInlineSnapshot(
        `false`,
      )
      expect(
        Object.hasOwn(
          { ...metadata.discovered, ...metadata.optimized },
          'tool',
        ),
      ).toMatchInlineSnapshot(`false`)

      const stories = await server.transformRequest('/card.stories.ts')

      expect(stories!.code.includes('zyzz:shared.css')).toMatchInlineSnapshot(
        `false`,
      )

      const result = await Vite.build({ ...options, build: { write: false } })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')
      const css = output.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')

      expect(css.includes('#06c')).toMatchInlineSnapshot(`true`)
      expect(css.includes('rebeccapurple')).toMatchInlineSnapshot(`false`)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('skips nested packages in discovery unless included', async () => {
    const { config, root } = await create()
    const example = Path.join(root, 'examples/web')

    await Fs.mkdir(Path.join(example, 'src'), { recursive: true })
    await Fs.writeFile(
      Path.join(example, 'package.json'),
      JSON.stringify({ name: 'example' }),
    )
    await Fs.writeFile(
      Path.join(example, 'src/global.ts'),
      `import { global } from 'zyzz/web'; global({ body: { color: 'rebeccapurple' } });`,
    )

    function configure(options: zyzz.Options = {}) {
      return {
        ...config,
        plugins: [zyzz(options)],
        resolve: {
          alias: {
            ...(config.resolve!.alias as Record<string, string>),
            'zyzz/web': Path.resolve('src/web/index.ts'),
          },
        },
      }
    }

    async function css(options: zyzz.Options = {}) {
      const result = await Vite.build({
        ...configure(options),
        // Minification would rewrite color keywords.
        build: { cssMinify: false, write: false },
      })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')

      return output.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')
    }

    const server = await Vite.createServer(configure())
    try {
      await server.listen()

      await server.transformRequest('/main.ts')
      const shared = await server.transformRequest('\0zyzz:shared.css')

      expect(shared!.code.includes('rebeccapurple')).toMatchInlineSnapshot(
        `false`,
      )

      // Sources added after startup follow the same rule. The application's own addition shows
      // that the watcher reported both.
      await Fs.writeFile(
        Path.join(example, 'src/late.ts'),
        `import { global } from 'zyzz/web'; global({ body: { color: 'papayawhip' } });`,
      )
      await Fs.writeFile(
        Path.join(root, 'late.ts'),
        `import { global } from 'zyzz/web'; global({ body: { color: 'peachpuff' } });`,
      )
      await expect
        .poll(
          async () =>
            (await server.transformRequest('\0zyzz:shared.css'))!.code.includes(
              'peachpuff',
            ),
          { timeout: 10_000 },
        )
        .toBe(true)
      const updated = await server.transformRequest('\0zyzz:shared.css')

      expect(updated!.code.includes('papayawhip')).toMatchInlineSnapshot(
        `false`,
      )
    } finally {
      await server.close()
    }

    try {
      const skipped = await css()

      expect(skipped.includes('#06c')).toMatchInlineSnapshot(`true`)
      expect(skipped.includes('rebeccapurple')).toMatchInlineSnapshot(`false`)

      const included = await css({ include: ['examples/web'] })

      expect(included.includes('rebeccapurple')).toMatchInlineSnapshot(`true`)

      // An include below the nested package's root still discovers it.
      const source = await css({ include: ['examples/web/src'] })

      expect(source.includes('rebeccapurple')).toMatchInlineSnapshot(`true`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('scopes discovery to zyzz.config directories unless include globs are set', async () => {
    const { config, root } = await create()

    for (const [name, content] of Object.entries({
      'src/global.ts': `import { global } from 'zyzz/web'; global({ body: { color: 'rebeccapurple' } });`,
      'src/zyzz.config.ts': 'export {}',
      'tools/global.ts': `import { global } from 'zyzz/web'; global({ body: { color: 'papayawhip' } });`,
    })) {
      await Fs.mkdir(Path.dirname(Path.join(root, name)), { recursive: true })
      await Fs.writeFile(Path.join(root, name), content)
    }

    function configure(options: zyzz.Options = {}) {
      return {
        ...config,
        plugins: [zyzz(options)],
        resolve: {
          alias: {
            ...(config.resolve!.alias as Record<string, string>),
            'zyzz/web': Path.resolve('src/web/index.ts'),
          },
        },
      }
    }

    async function css(options: zyzz.Options = {}) {
      const result = await Vite.build({
        ...configure(options),
        // Minification would rewrite color keywords.
        build: { cssMinify: false, write: false },
      })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')

      return output.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')
    }

    const server = await Vite.createServer(configure())
    try {
      await server.listen()

      await server.transformRequest('/main.ts')
      const shared = await server.transformRequest('\0zyzz:shared.css')

      expect(shared!.code.includes('rebeccapurple')).toMatchInlineSnapshot(
        `true`,
      )
      expect(shared!.code.includes('papayawhip')).toMatchInlineSnapshot(`false`)
    } finally {
      await server.close()
    }

    try {
      const configured = await css()

      // Modules the application imports compile outside the configuration directory.
      expect(configured.includes('#06c')).toMatchInlineSnapshot(`true`)
      expect(configured.includes('rebeccapurple')).toMatchInlineSnapshot(`true`)
      expect(configured.includes('papayawhip')).toMatchInlineSnapshot(`false`)

      const globbed = await css({ include: ['tools/**/*.ts'] })

      expect(globbed.includes('#06c')).toMatchInlineSnapshot(`true`)
      expect(globbed.includes('rebeccapurple')).toMatchInlineSnapshot(`false`)
      expect(globbed.includes('papayawhip')).toMatchInlineSnapshot(`true`)

      const excluded = await css({
        exclude: ['tools/global.ts'],
        include: ['**'],
      })

      expect(excluded.includes('rebeccapurple')).toMatchInlineSnapshot(`true`)
      expect(excluded.includes('papayawhip')).toMatchInlineSnapshot(`false`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('derives no contract from excluded sources that modules import', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'legacy.ts': `import { global } from 'zyzz/web'; global({ body: { color: 'rebeccapurple' } }); export const legacy = 'legacy';`,
      'main.ts': `${Fixture.files['main.ts']} import { legacy } from './legacy'; document.body.className = legacy;`,
      // A manifest depending on Zyzz would otherwise derive a contract from the excluded module.
      'package.json': JSON.stringify({
        dependencies: { zyzz: '*' },
        name: 'app',
      }),
    })
    try {
      const result = await Vite.build({
        ...config,
        build: { write: false },
        plugins: [zyzz({ exclude: ['legacy.ts'] })],
        resolve: {
          alias: {
            ...(config.resolve!.alias as Record<string, string>),
            'zyzz/web': Path.resolve('src/web/index.ts'),
          },
        },
      })
      const output = Array.isArray(result) ? result[0]! : result
      if (!('output' in output)) throw new Error('Unexpected watch build')
      const css = output.output
        .flatMap((file) =>
          file.type === 'asset' && file.fileName.endsWith('.css')
            ? [String(file.source)]
            : [],
        )
        .join('\n')

      expect(css.includes('#06c')).toMatchInlineSnapshot(`true`)
      expect(css.includes('rebeccapurple')).toMatchInlineSnapshot(`false`)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('resolves imports that framework transforms remove as development scans', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'loader.ts': `import { secret } from './secret'; export const load = () => secret();`,
      'main.ts': `import { load } from './loader'; ${Fixture.files['main.ts']} void load;`,
      'secret.ts': `export const secret = () => 'server';`,
    })
    const scans = new Set<boolean | undefined>()
    const server = await Vite.createServer({
      ...config,
      plugins: [
        zyzz(),
        {
          enforce: 'pre',
          name: 'server-only',
          resolveId(source, _, options) {
            if (source !== './secret') return

            // Vite forwards `scan` without declaring it on the hook options.
            const scan = (options as { scan?: boolean }).scan

            scans.add(scan)

            // Like import protection, only a scan may resolve the server-only module.
            if (!scan) this.error('Denied a server-only import')
          },
        },
        {
          name: 'server-functions',
          transform(code, id) {
            if (!id.endsWith('/loader.ts')) return

            // Framework compilers replace server-only calls before Vite reads imports.
            return code
              .replace(/import \{ secret \} from ["']\.\/secret["'];?/, '')
              .replace('secret()', `fetch('/load')`)
          },
        },
      ],
    })

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`

      expect((await fetch(`${origin}/main.ts`)).status).toMatchInlineSnapshot(
        `200`,
      )
      expect((await fetch(`${origin}/loader.ts`)).status).toMatchInlineSnapshot(
        `200`,
      )
      expect([...scans]).toMatchInlineSnapshot(`
        [
          true,
        ]
      `)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each(['cloudflare:workers', './missing', 'missing-package'])(
    'analyzes server-only imports before TanStack removes %s',
    async (specifier) => {
      const { config, root } = await create({
        ...TanStack.files,
        'declarations.ts': `export const declarations = { padding: '17px' } as const;`,
        'main.tsx': `export { getClient, styles } from './rpc';`,
        'rpc.ts': `import { createIsomorphicFn } from '@tanstack/react-start'
import { env } from '${specifier}'
import { declarations } from 'styles:declarations'
import { style } from 'zyzz'

export const getClient = createIsomorphicFn()
  .server(() => env)
  .client(() => 'browser')

export namespace styles {
  export const card = style(declarations)
}`,
      })
      await Fs.mkdir(Path.join(root, 'routes'))
      for (const name of ['__root.tsx', 'settings.tsx'])
        await Fs.rename(Path.join(root, name), Path.join(root, 'routes', name))

      const server = await Vite.createServer({
        ...config,
        plugins: [
          zyzz({ include: ['.'], script: false }),
          tanstackStart({
            router: {
              generatedRouteTree: Path.join(root, 'routeTree.gen.ts'),
              routesDirectory: Path.join(root, 'routes'),
            },
            srcDirectory: '.',
          }),
          react(),
        ],
        resolve: {
          alias: {
            ...(config.resolve!.alias as Record<string, string>),
            // Resolvable protocols still supply statically evaluated declarations.
            'styles:declarations': Path.join(root, 'declarations.ts'),
          },
        },
      })

      try {
        await server.listen()

        // The importer walks rpc.ts before Start transforms its server branch.
        const output = server.environments.client.transformRequest('/main.tsx')

        if (specifier !== 'cloudflare:workers') {
          const error = await output.catch((error: unknown) =>
            String(error).replace(root, '<root>'),
          )

          if (specifier === './missing')
            expect(error).toMatchInlineSnapshot(
              `"Source.ExtractError: <root>/rpc.ts:59: Unable to resolve "./missing""`,
            )
          else
            expect(error).toMatchInlineSnapshot(
              `"Source.ExtractError: <root>/rpc.ts:59: Unable to resolve "missing-package""`,
            )

          return
        }

        expect((await output) !== null).toMatchInlineSnapshot(`true`)

        const rpc = await server.environments.client.transformRequest('/rpc.ts')

        expect(rpc?.code.includes('cloudflare:workers')).toMatchInlineSnapshot(
          `false`,
        )
        expect(rpc?.code.includes('browser')).toMatchInlineSnapshot(`true`)
      } finally {
        await server.close()
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
  )

  test('keeps unreachable analysis imports out of dependency optimization', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'server.ts': `import MagicString from 'magic-string'; export const edit = (code: string) => new MagicString(code).toString();`,
    })
    const server = await Vite.createServer({
      ...config,
      cacheDir: Path.join(root, '.vite'),
      optimizeDeps: { noDiscovery: false },
    })

    try {
      await server.listen()

      const optimizer = server.environments.client.depsOptimizer
      if (!optimizer) throw new Error('Missing dependency optimizer')

      await optimizer.scanProcessing

      // The document compiles every discovered source, including server.ts.
      expect(
        (await fetch(server.resolvedUrls!.local[0]!)).status,
      ).toMatchInlineSnapshot(`200`)
      expect(Object.keys(optimizer.metadata.discovered)).toMatchInlineSnapshot(
        `[]`,
      )
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('serves shared and module stylesheets with Vite CSS queries', async () => {
    const { config, root } = await create({
      ...Fixture.files,
      'main.ts':
        Fixture.files['main.ts'] +
        `import { style } from 'zyzz'; export const box = style({ margin: '2px' });`,
    })
    const server = await Vite.createServer(config)
    try {
      await server.listen()
      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')
      const origin = `http://127.0.0.1:${address.port}`
      const code = await (await fetch(`${origin}/main.ts`)).text()
      const paths = [
        ...code.matchAll(/import\s*["']([^"']*zyzz:[^"']+\.css)["']/g),
      ].map((match) => match[1]!)
      expect(paths.length).toMatchInlineSnapshot(`2`)
      const stylesheets: string[] = []
      for (const path of paths) {
        const direct = await fetch(`${origin}${path}?direct`)
        expect(direct.status).toMatchInlineSnapshot(`200`)
        expect(direct.headers.get('content-type')).toContain('text/css')
        stylesheets.push(await direct.text())
        const inline = await fetch(`${origin}${path}?inline`)
        expect(inline.status).toMatchInlineSnapshot(`200`)
        expect(await inline.text()).toContain('export default')
      }
      expect(stylesheets.join('')).toContain('margin:2px')
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each([
    [true, 'atomic'],
    [true, 'grouped'],
    [false, 'atomic'],
    [false, 'grouped'],
  ] as const)(
    'emits theme scopes and dependency CSS once with compiler %s and %s output',
    async (compiler, cssOutput) => {
      const { config, root } = await create({
        ...Fixture.files,
        'barrel.ts': "export { props } from './card';",
        'config.ts': Fixture.files['config.ts'].replace(
          "id:'app'",
          `cssOutput:'${cssOutput}',id:'app'`,
        ),
        'main.ts':
          Fixture.files['main.ts'].replace('./card', './barrel') +
          "import { style } from './config'; const box = style({ margin: '2px' })(); document.querySelector('#card')!.className += ' ' + box.className;",
        'theme.ts':
          "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#06c' } }, { id: 'app' });",
      })
      const options = {
        ...config,
        optimizeDeps: { ...config.optimizeDeps, include: ['zyzz'] },
        plugins: [zyzz({ compiler })],
      }
      const server = await Vite.createServer(options)
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

      try {
        browser = await chromium.launch()
        await server.listen()

        const origin = server.resolvedUrls!.local[0]!
        const page = await browser.newPage()

        const response = await fetch(new URL('main.ts', origin))

        expect(response.status).toMatchInlineSnapshot('200')

        const main = await response.text()

        await page.goto(origin)
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#card')!).color ===
            'rgb(17, 119, 85)',
        )

        expect(
          await page
            .locator('#card')
            .evaluate((element) => getComputedStyle(element).padding),
        ).toMatchInlineSnapshot('"8px"')
        expect(
          await page
            .locator('#card')
            .evaluate((element) => getComputedStyle(element).margin),
        ).toMatchInlineSnapshot('"2px"')

        const css = await page.evaluate(() =>
          [...document.querySelectorAll('style[data-vite-dev-id]')]
            .map((element) => element.textContent)
            .join('\n'),
        )

        expect(
          css.match(/--z-app-color-brand:\s*#175/g)?.length,
        ).toMatchInlineSnapshot('1')
        expect(css.match(/padding:\s*8px/g)?.length).toMatchInlineSnapshot('1')
        expect(css.match(/margin:\s*2px/g)?.length).toMatchInlineSnapshot('1')

        const path = main.match(
          /import\s*["']([^"']*zyzz:(?!shared\.css)[^"']+\.css)["']/,
        )?.[1]
        if (!path) throw new Error('Missing main stylesheet')

        const own = await (
          await fetch(new URL(`${path}?direct`, origin))
        ).text()

        expect(own.includes('padding')).toMatchInlineSnapshot('false')
        expect(own.includes('margin')).toMatchInlineSnapshot('true')

        const barrel = await (await fetch(new URL('barrel.ts', origin))).text()
        const barrelPath = barrel.match(
          /import\s*["']([^"']*zyzz:(?!shared\.css)[^"']+\.css)["']/,
        )?.[1]
        if (!barrelPath) throw new Error('Missing barrel stylesheet')

        const barrelCss = await (
          await fetch(new URL(`${barrelPath}?direct`, origin))
        ).text()

        expect(barrelCss.trim()).toMatchInlineSnapshot('""')

        const result = await Vite.build({
          ...options,
          build: { cssMinify: false, minify: false, write: false },
        })
        const output = Array.isArray(result) ? result[0]! : result
        if (!('output' in output)) throw new Error('Unexpected watch build')

        const production = output.output
          .flatMap((file) =>
            file.type === 'asset' && file.fileName.endsWith('.css')
              ? [file.source]
              : [],
          )
          .join('\n')

        expect(
          production.match(/--z-app-color-brand:\s*#175/g)?.length,
        ).toMatchInlineSnapshot('1')
        expect(
          production.match(/padding:\s*8px/g)?.length,
        ).toMatchInlineSnapshot('1')
        expect(
          production.match(/margin:\s*2px/g)?.length,
        ).toMatchInlineSnapshot('1')
      } finally {
        await browser?.close()
        await server.close()
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test('development invalidates virtual CSS after theme edits and recovers from deletion', async () => {
    const { config, root } = await create()
    const server = await Vite.createServer(config)
    let socket: WebSocket | undefined

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`
      const response = await fetch(`${origin}/card.ts`)
      const code = await response.text()

      expect(response.status).toMatchInlineSnapshot(`200`)

      const cssPath = code.match(
        /import\s*["']([^"']*zyzz:(?!shared\.css)[^"']+\.css)["']/,
      )?.[1]
      if (!cssPath) throw new Error(`Missing CSS import in ${code}`)
      const sharedPath = code.match(
        /import\s*["']([^"']*zyzz:shared\.css)["']/,
      )?.[1]
      if (!sharedPath) throw new Error('Missing shared CSS import')

      const stylesheet = async () => (await fetch(origin + sharedPath)).text()

      await fetch(origin + cssPath)
      await stylesheet()

      const cssModule = [
        ...server.environments.client!.moduleGraph.idToModuleMap.values(),
      ].find(
        (module) =>
          module.id?.startsWith('\0zyzz:') && module.id !== '\0zyzz:shared.css',
      )
      if (!cssModule) throw new Error('Missing virtual CSS module')

      const loaded = await server.environments.client!.pluginContainer.load(
        cssModule.id!,
      )
      if (!loaded || typeof loaded === 'string' || !loaded.map)
        throw new Error('Missing CSS source map')

      const trace = new Trace.TraceMap(
        typeof loaded.map === 'string'
          ? loaded.map
          : JSON.stringify(loaded.map),
      )

      const line =
        loaded.code
          .split('\n')
          .findIndex((line) => line.includes('color:var(')) + 1
      const location = Trace.originalPositionFor(trace, { column: 0, line })

      expect(Path.relative(root, location.source!)).toMatchInlineSnapshot(
        `"card.ts"`,
      )
      expect(location.line).toMatchInlineSnapshot(`1`)

      const rendered = (await server.ssrLoadModule('/card.ts')) as {
        props: { className: string }
      }

      expect(rendered.props.className).toMatchInlineSnapshot(
        `"z-app-rnRBDm-text-[var(--z-app-color-brand,#06c)] z-app-rnRBDm-p-8px"`,
      )

      expect((await stylesheet()).includes('#175')).toMatchInlineSnapshot(
        `true`,
      )

      socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
        'vite-hmr',
      )
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve()
        socket!.onerror = () => reject(new Error('WebSocket failed'))
      })

      const path = Path.join(root, 'alternate.ts')

      const update = await message(
        socket,
        () =>
          Watch.write({
            path,
            source: Fixture.files['alternate.ts'].replace('#175', '#f00'),
          }),
        // Initial fixture creation can queue an unrelated document reload.
        (text) => text.includes('zyzz:'),
      )

      expect(update.includes('zyzz:')).toMatchInlineSnapshot(`true`)
      expect((await stylesheet()).includes('#f00')).toMatchInlineSnapshot(
        `true`,
      )

      await message(socket, () => Fs.rm(path))

      await vi.waitUntil(
        async () => (await fetch(origin + cssPath)).status === 500,
      )
      expect((await fetch(origin + cssPath)).status).toMatchInlineSnapshot(
        `500`,
      )

      await message(socket, () =>
        Watch.write({ path, source: Fixture.files['alternate.ts'] }),
      )

      expect((await stylesheet()).includes('#175')).toMatchInlineSnapshot(
        `true`,
      )

      await message(socket, () =>
        Watch.write({
          path: Path.join(root, 'config.ts'),
          source: Fixture.files['config.ts'].replace(
            './alternate',
            './new-theme',
          ),
        }),
      )

      await vi.waitUntil(
        async () => (await fetch(origin + cssPath)).status === 500,
      )
      expect((await fetch(origin + cssPath)).status).toMatchInlineSnapshot(
        `500`,
      )

      await message(socket, () =>
        Watch.write({
          path: Path.join(root, 'new-theme.ts'),
          source: Fixture.files['alternate.ts'].replace('#175', '#00f'),
        }),
      )

      expect((await stylesheet()).includes('#00f')).toMatchInlineSnapshot(
        `true`,
      )
    } finally {
      socket?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('development compiles a module with its own import closure', async () => {
    // `banner.ts` styles a page the card never imports.
    const { config, root } = await create({
      ...Fixture.files,
      'banner.ts': `import { style } from './config'; export const props = style({ color: 'brand', margin: '4px' })();`,
    })
    const server = await Vite.createServer(config)

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`

      // 1. Transform the card alone, as a page that imports only the card does.
      await fetch(`${origin}/card.ts`)

      const card = server.environments.client.moduleGraph.getModuleById(
        Path.join(root, 'card.ts'),
      )
      const imported = [...(card?.importedModules ?? [])]
        .map((module) =>
          decodeURIComponent(module.url).replace('\0', '').split('/').pop(),
        )
        .sort()

      // 2. Its compile reads only what it imports, so an edit to the banner leaves it unchanged.
      expect(imported).toMatchInlineSnapshot(`
        [
          "alternate.ts",
          "card.ts",
          "card.ts.css",
          "config.ts",
          "theme.ts",
          "zyzz:shared.css",
        ]
      `)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('development announces a module update once until the environment loads it', async () => {
    const accepted = (name: string, padding: string) =>
      `import { style } from './config'; export const ${name} = style({ color: 'brand', padding: '${padding}' })(); if (import.meta.hot) import.meta.hot.accept();`
    const { config, root } = await create({
      ...Fixture.files,
      'banner.ts': accepted('banner', '4px'),
      'card.ts': accepted('card', '8px'),
    })
    const server = await Vite.createServer(config)
    let socket: WebSocket | undefined

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`

      // 1. Serve both modules and their stylesheets once.
      for (const path of ['/card.ts', '/banner.ts']) {
        const code = await (await fetch(origin + path)).text()

        for (const [, stylesheet] of code.matchAll(
          /import\s*["']([^"']*zyzz:[^"']+\.css)["']/g,
        ))
          await fetch(origin + stylesheet!)
      }

      socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
        'vite-hmr',
      )
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve()
        socket!.onerror = () => reject(new Error('WebSocket failed'))
      })

      const names = (text: string) =>
        (
          JSON.parse(text) as { updates: { path: string; type: string }[] }
        ).updates
          .map(
            (update) =>
              `${update.type} ${decodeURIComponent(update.path).split('/').pop()}`,
          )
          .sort()

      // 2. Edit the card's padding, which renames its atomic class and so changes its code. Nothing
      // requests the card again, as a server that renders later does not.
      const card = await message(
        socket,
        () =>
          Watch.write({
            path: Path.join(root, 'card.ts'),
            source: accepted('card', '12px'),
          }),
        (text) => text.includes('card.ts'),
      )

      expect(names(card)).toMatchInlineSnapshot(`
        [
          "js-update card.ts",
          "js-update card.ts.css",
        ]
      `)

      // 3. Edit the banner. Its update leaves out the card, whose announced update is pending.
      const banner = await message(
        socket,
        () =>
          Watch.write({
            path: Path.join(root, 'banner.ts'),
            source: accepted('banner', '6px'),
          }),
        (text) => text.includes('banner.ts'),
      )

      expect(names(banner)).toMatchInlineSnapshot(`
        [
          "js-update banner.ts",
          "js-update banner.ts.css",
        ]
      `)
    } finally {
      socket?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('development leaves server stylesheets that no request transformed', async () => {
    // Grouped output keeps class names across value edits, so only the stylesheet changes.
    const { config, root } = await create({
      ...Fixture.files,
      'config.ts': Fixture.files['config.ts'].replace(
        "id:'app',",
        "id:'app',cssOutput:'grouped',",
      ),
    })
    const passed = Promise.withResolvers<readonly string[]>()

    // Plugins after Zyzz receive the modules it leaves Vite to update.
    config.plugins!.push({
      name: 'server-update',
      hotUpdate(options) {
        if (
          this.environment.name === 'ssr' &&
          options.file === Path.join(root, 'card.ts')
        )
          passed.resolve(options.modules.map((module) => module.url))
      },
    })

    const server = await Vite.createServer(config)

    try {
      await server.listen()

      const environment = server.environments.ssr!
      const stylesheet = `\0zyzz:${encodeURIComponent(Path.join(root, 'card.ts'))}.css`

      // 1. Transform the card for the server and load its stylesheet through the plugins only, as a
      // renderer that collects styles for the document does. Vite never transforms the sheet.
      await environment.transformRequest('/card.ts')
      await environment.pluginContainer.load(stylesheet)

      // 2. Edit a declaration value. The sheet only invalidates, since nothing evaluated it.
      await Watch.write({
        path: Path.join(root, 'card.ts'),
        source: Fixture.files['card.ts'].replace("'8px'", "'12px'"),
      })

      expect(await passed.promise).toMatchInlineSnapshot(`[]`)
      expect(
        environment.moduleGraph.getModuleById(stylesheet)?.lastHMRTimestamp !==
          0,
      ).toMatchInlineSnapshot(`true`)
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('development updates only the stylesheet a value edit changes', async () => {
    const card = `import './fonts'; ${Fixture.files['card.ts']}`
    // The font asset makes the served shared stylesheet differ from the compiled one.
    const { config, root } = await create({
      ...Fixture.files,
      'Evidence.ttf': 'font',
      'card.ts': card,
      'config.ts': Fixture.files['config.ts'].replace(
        "id:'app',",
        "id:'app',cssOutput:'grouped',",
      ),
      'fonts.ts': `import {fontFace} from 'zyzz/web';fontFace({fontFamily:'Evidence',src:"url('./Evidence.ttf') format('truetype')"});`,
    })
    const server = await Vite.createServer(config)
    let socket: WebSocket | undefined

    try {
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const origin = `http://127.0.0.1:${address.port}`
      const code = await (await fetch(`${origin}/card.ts`)).text()
      const paths = [
        ...code.matchAll(/import\s*["']([^"']*zyzz:[^"']+\.css)["']/g),
      ].map((match) => match[1]!)

      // 1. Serve both stylesheets, as a page loading the card does.
      for (const path of paths) await fetch(origin + path)

      socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/?token=${server.config.webSocketToken}`,
        'vite-hmr',
      )
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve()
        socket!.onerror = () => reject(new Error('WebSocket failed'))
      })

      // 2. Edit a declaration value, which leaves the card's class names and the shared stylesheet unchanged.
      const update = await message(
        socket,
        () =>
          Watch.write({
            path: Path.join(root, 'card.ts'),
            source: card.replace("'8px'", "'12px'"),
          }),
        (text) => text.includes('zyzz:'),
      )
      const { updates } = JSON.parse(update) as {
        updates: { path: string; type: string }[]
      }

      expect(
        updates.map(
          (update) =>
            `${update.type} ${decodeURIComponent(update.path).split('/').pop()}`,
        ),
      ).toMatchInlineSnapshot(`
        [
          "js-update card.ts.css",
        ]
      `)
      expect(
        (await (await fetch(origin + paths.at(-1)!)).text()).includes('12px'),
      ).toMatchInlineSnapshot(`true`)
    } finally {
      socket?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('Vite HMR applies a stylesheet-only edit in Chromium', async () => {
    // Grouped output keeps class names across value edits, so only the stylesheet module updates.
    const { config, root } = await create({
      ...Fixture.files,
      'config.ts': Fixture.files['config.ts'].replace(
        "id:'app',",
        "id:'app',cssOutput:'grouped',",
      ),
    })
    const server = await Vite.createServer(config)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      browser = await chromium.launch()
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const page = await browser.newPage()

      // 1. Load the card, whose module imports its stylesheet.
      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).padding === '8px',
      )
      await page.waitForLoadState('networkidle')

      const className = await page.locator('#card').getAttribute('class')

      // 2. Edit a declaration value. The client applies the update only when it names the
      // stylesheet as the module's hot context does.
      await Watch.write({
        path: Path.join(root, 'card.ts'),
        source: Fixture.files['card.ts'].replace("'8px'", "'12px'"),
      })
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).padding === '12px',
        undefined,
        { timeout: 10000 },
      )

      expect(
        (await page.locator('#card').getAttribute('class')) === className,
      ).toMatchInlineSnapshot(`true`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"12px"`)
    } finally {
      await browser?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('Vite HMR updates server-rendered stylesheet links in Chromium', async () => {
    const { config, root } = await create()
    const server = await Vite.createServer(config)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      browser = await chromium.launch()
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      // 1. Render the card on the server only and link its stylesheet, as RSC and SSR hosts do.
      const file = Path.join(root, 'card.ts')
      const { props } = await server.ssrLoadModule('/card.ts')
      await Fs.writeFile(
        Path.join(root, 'index.html'),
        `<link rel="stylesheet" href="/@id/__x00__zyzz:${encodeURIComponent(file)}.css"><div id="card" class="${props.className}">Card</div>`,
      )
      const page = await browser.newPage()

      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).padding === '8px',
      )

      expect(
        server.environments.client.moduleGraph.getModuleById(file),
      ).toBeUndefined()

      // 2. Edit the server-only module and keep the document.
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => {
        document.querySelector('#card')!.setAttribute('data-preserved', 'yes')
      })
      await Watch.write({
        path: file,
        source: Fixture.files['card.ts'].replace("'8px'", "'12px'"),
      })
      await page.waitForFunction(() =>
        [...document.styleSheets].some((sheet) =>
          [...sheet.cssRules].some((rule) =>
            rule.cssText.includes('padding: 12px'),
          ),
        ),
      )

      // 3. Apply the class a server re-render returns, which only the updated link styles.
      const { props: next } = await server.ssrLoadModule('/card.ts')
      await page.evaluate((className) => {
        document.querySelector('#card')!.className = className
      }, next.className)

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"12px"`)
      expect(
        await page.locator('#card').getAttribute('data-preserved'),
      ).toMatchInlineSnapshot(`"yes"`)
    } finally {
      await browser?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('Vite HMR updates rendered theme scopes in Chromium', async () => {
    const { config, root } = await create()
    const server = await Vite.createServer(config)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      browser = await chromium.launch()
      await server.listen()

      const address = server.httpServer!.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing server port')

      const page = await browser.newPage()

      await page.goto(`http://127.0.0.1:${address.port}`)
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).color ===
          'rgb(17, 119, 85)',
      )

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(17, 119, 85)"`)

      // Wait for startup document reloads before asserting edit-time node preservation.
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => {
        document.querySelector('#card')!.setAttribute('data-preserved', 'yes')
      })
      await Watch.write({
        path: Path.join(root, 'alternate.ts'),
        source: Fixture.files['alternate.ts'].replace('#175', '#f00'),
      })
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('#card')!).color ===
          'rgb(255, 0, 0)',
      )

      expect(
        await page.locator('#card').getAttribute('data-preserved'),
      ).toMatchInlineSnapshot(`"yes"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"8px"`)
    } finally {
      await browser?.close()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)

  test('HTML initialization reads fresh sources during a background transform', async () => {
    const files = {
      'a.ts': "import './gate'; import './config'",
      'background.ts': "import './gate'; export const value = 1",
      'gate.ts': 'export const value = 1',
      'config.ts':
        "import { Config } from 'zyzz'; import { global } from 'zyzz/web'; export const config = Config.create({ defaultVars: 'base', vars: { base: { color: { ink: 'red' } } } }); global({body:{color:'red'}})",
      'index.html': '<script type="module" src="/a.ts"></script>',
    }
    const { config, root } = await create(files)
    const background = Promise.withResolvers<void>()
    const document = Promise.withResolvers<void>()
    let active = false
    let backgroundWaiting = false
    let documentWaiting = false
    config.plugins!.push({
      name: 'coordinate-source-reads',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!active || source !== './gate') return
        if (importer === Path.join(root, 'background.ts')) {
          backgroundWaiting = true
          await background.promise
        } else if (importer === Path.join(root, 'a.ts')) {
          documentWaiting = true
          await document.promise
        }
      },
    })
    const server = await Vite.createServer(config)
    try {
      await server.listen()
      expect(
        (
          await server.transformIndexHtml('/index.html', files['index.html'])
        ).includes('localStorage.getItem("zyzz")'),
      ).toMatchInlineSnapshot('true')
      // Requests must observe disk changes even before watcher notifications arrive.
      await server.watcher.close()
      active = true
      const transform = server.transformRequest('/background.ts')
      await vi.waitUntil(() => backgroundWaiting)
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: 'export const value = 1',
      })
      const html = server.transformIndexHtml('/index.html', files['index.html'])
      await vi.waitUntil(() => documentWaiting)
      background.resolve()
      await transform
      document.resolve()
      expect(
        (await html).includes('localStorage.getItem("zyzz")'),
      ).toMatchInlineSnapshot('false')
    } finally {
      background.resolve()
      document.resolve()
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('inlines configuration initialization before other head scripts in development and production', async () => {
    // An unrelated earlier module and layer-free configurations exercise whole-project discovery.
    const files = {
      'a.ts': 'export const unrelated = 1',
      'config.ts':
        "import { Config } from 'zyzz'; export const { style, vars:themes } = Config.create({ defaultVars: 'base', vars: { base: { color: { ink: '#123456' } }, mint: { color: { ink: '#008844' } } } }); export const other = Config.create({ defaultVars: 'night', vars: { night: { color: { ink: '#000000' } }, 'brand.dark': { color: { ink: '#ffffff' } } } }); export const { script: onlyScript } = Config.create({ defaultVars: 'solo', vars: { solo: { color: { ink: '#aabbcc' } } } });",
      'index.html': `<!doctype html><html><head><title>Fixture</title></head><body><script type="module" src="/main.ts"></script></body></html>`,
      'main.ts': `import { themes } from './config'; const root = document.documentElement; root.dataset.initial = root.className; root.dataset.mint = themes({set:'mint'}).className; root.dataset.ready = 'true';`,
    }
    const { config, root } = await create(files)
    const browser = await chromium.launch({ headless: true })
    let server: Vite.ViteDevServer | undefined
    let preview: Vite.PreviewServer | undefined

    try {
      server = await Vite.createServer(config)
      await server.listen()

      const development = await server.transformIndexHtml(
        '/index.html',
        files['index.html'],
      )
      const restore = development.indexOf('localStorage.getItem("zyzz")')

      expect(restore > -1).toMatchInlineSnapshot('true')
      expect(
        restore < development.indexOf('/@vite/client'),
      ).toMatchInlineSnapshot('true')

      const scripts = (html: string) =>
        html.split('localStorage.getItem("zyzz")').length - 1

      // Each configuration keeps its own catalog, dotted keys use the compiled
      // escaping, and a script-only export derives its catalog from the options.
      expect(scripts(development)).toMatchInlineSnapshot('3')
      expect(/z-theme-brand_2e_dark/.test(development)).toMatchInlineSnapshot(
        `true`,
      )
      expect(
        /\["solo","z-theme-solo"\]/.test(development),
      ).toMatchInlineSnapshot(`true`)

      // A source error stays with its module; the document still initializes
      // from the catalogs collected before the edit.
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: files['config.ts'].replace("'#123456'", 'unknownColor()'),
      })

      const broken = await server.transformIndexHtml(
        '/index.html',
        files['index.html'],
      )

      expect(scripts(broken)).toMatchInlineSnapshot('3')

      // An edit that drops the configuration import while failing to compile
      // keeps scoping the document through the last successful graph.
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: files['config.ts'],
      })
      await Watch.write({
        path: Path.join(root, 'main.ts'),
        source: `import { style } from 'zyzz'; export const broken = style({ color: unknownColor() });`,
      })

      const detached = await server.transformIndexHtml(
        '/index.html',
        files['index.html'],
      )

      expect(scripts(detached)).toMatchInlineSnapshot('3')

      await Watch.write({
        path: Path.join(root, 'main.ts'),
        source: files['main.ts'],
      })

      // Removed configurations leave the document on the next request.
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: files['config.ts'].slice(
          0,
          files['config.ts'].indexOf(' export const other'),
        ),
      })

      const reduced = await server.transformIndexHtml(
        '/index.html',
        files['index.html'],
      )

      expect(scripts(reduced)).toMatchInlineSnapshot('1')

      // A module that stops emitting a contract altogether drops its catalogs too.
      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: `export const themes = { mint: { className: 'plain' } }`,
      })

      const detachedConfiguration = await server.transformIndexHtml(
        '/index.html',
        files['index.html'],
      )

      expect(scripts(detachedConfiguration)).toMatchInlineSnapshot('0')

      await Watch.write({
        path: Path.join(root, 'config.ts'),
        source: files['config.ts'],
      })
      await server.close()
      server = undefined

      const outDir = Path.join(root, 'dist')

      await Vite.build({ ...config, build: { outDir } })

      const production = await Fs.readFile(
        Path.join(outDir, 'index.html'),
        'utf8',
      )

      expect(
        /<head>\s*<script>\(\(\)=>\{try\{const value=JSON\.parse\(localStorage\.getItem\("zyzz"\)/.test(
          production,
        ),
      ).toMatchInlineSnapshot('true')

      preview = await Vite.preview({
        ...config,
        build: { outDir },
        preview: { host: '127.0.0.1', port: 0 },
      })

      const page = await browser.newPage()

      await page.goto(preview.resolvedUrls!.local[0]!)
      await page.waitForFunction(
        'document.documentElement.dataset.ready === "true"',
      )
      await page.evaluate(
        `localStorage.setItem('zyzz', JSON.stringify({ set:'mint', colorScheme: 'dark' }))`,
      )
      await page.reload()
      await page.waitForFunction(
        'document.documentElement.dataset.ready === "true"',
      )

      // The entry module observed the restored classes when it evaluated.
      expect(
        await page.evaluate(
          'document.documentElement.dataset.initial === `${document.documentElement.dataset.mint} z_scheme-dark`',
        ),
      ).toMatchInlineSnapshot('true')
      expect(
        await page.evaluate('document.documentElement.style.colorScheme'),
      ).toMatchInlineSnapshot('"dark"')

      await Vite.build({
        ...config,
        build: { outDir: Path.join(root, 'plain') },
        plugins: [zyzz({ script: false })],
      })

      expect(
        (
          await Fs.readFile(Path.join(root, 'plain/index.html'), 'utf8')
        ).includes('localStorage'),
      ).toMatchInlineSnapshot('false')
    } finally {
      await browser.close()
      await server?.close()

      if (preview)
        await new Promise<void>((resolve, reject) =>
          preview!.httpServer.close((error) =>
            error ? reject(error) : resolve(),
          ),
        )

      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60000)

  test('scopes built initialization scripts to the configurations each page bundles', async () => {
    const page = (entry: string) =>
      `<!doctype html><html><head><title>${entry}</title></head><body><script type="module" src="/${entry}.ts"></script></body></html>`
    const configuration = (name: string) =>
      `import { Config } from 'zyzz'; export const { style, vars:themes } = Config.create({ defaultVars: '${name}', storageKey: '${name}', vars: { ${name}: { color: { ink: '#123456' } } } });`
    // Each page imports only style, so its configuration module leaves the bundle.
    // Page c reaches its configuration only through a lazy import.
    const files = {
      'a.html': page('a'),
      'a.ts': `import { style } from './alpha'; document.body.className = style({ color: 'ink' })().className;`,
      'alpha.ts': configuration('alpha'),
      'b.html': page('b'),
      'b.ts': `import { style } from './beta'; document.body.className = style({ color: 'ink' })().className;`,
      'beta.ts': configuration('beta'),
      'c.html': page('c'),
      'c.ts': `void import('./gamma').then(({ style }) => { document.body.className = style({ color: 'ink' })().className; });`,
      // Page d reaches its entry through an inline module script.
      'd.html': `<!doctype html><html><head><title>d</title></head><body><script type="module">import './d.ts'</script></body></html>`,
      'd.ts': `import { style } from './delta'; document.body.className = style({ color: 'ink' })().className;`,
      'delta.ts': configuration('delta'),
      // Page e reaches its entry through an aliased inline import.
      'e.html': `<!doctype html><html><head><title>e</title></head><body><script type="module">import '@pages/e.ts'</script></body></html>`,
      'e.ts': `import { style } from './epsilon'; document.body.className = style({ color: 'ink' })().className;`,
      'epsilon.ts': configuration('epsilon'),
      'gamma.ts': configuration('gamma'),
      // Without a package.json the repository's sideEffects list would let the bundler drop a side-effect import.
      'package.json': '{ "name": "pages", "private": true, "type": "module" }',
    }
    const { config: base, root } = await create(files)
    const config: Vite.InlineConfig = {
      ...base,
      resolve: { alias: { ...base.resolve?.alias, '@pages': root } },
    }
    let server: Vite.ViteDevServer | undefined

    const keys = (html: string) =>
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].filter((key) =>
        html.includes(`localStorage.getItem("${key}")`),
      )

    try {
      // The dev server follows each document's module scripts through the compiled graph.
      server = await Vite.createServer(config)
      await server.listen()

      expect(keys(await server.transformIndexHtml('/a.html', files['a.html'])))
        .toMatchInlineSnapshot(`
        [
          "alpha",
        ]
      `)
      expect(keys(await server.transformIndexHtml('/b.html', files['b.html'])))
        .toMatchInlineSnapshot(`
        [
          "beta",
        ]
      `)
      expect(keys(await server.transformIndexHtml('/c.html', files['c.html'])))
        .toMatchInlineSnapshot(`
        [
          "gamma",
        ]
      `)
      expect(keys(await server.transformIndexHtml('/d.html', files['d.html'])))
        .toMatchInlineSnapshot(`
          [
            "delta",
          ]
        `)
      expect(keys(await server.transformIndexHtml('/e.html', files['e.html'])))
        .toMatchInlineSnapshot(`
          [
            "epsilon",
          ]
        `)

      await server.close()
      server = undefined

      const outDir = Path.join(root, 'dist')

      await Vite.build({
        ...config,
        build: {
          outDir,
          rollupOptions: {
            input: {
              a: Path.join(root, 'a.html'),
              b: Path.join(root, 'b.html'),
              c: Path.join(root, 'c.html'),
              d: Path.join(root, 'd.html'),
              e: Path.join(root, 'e.html'),
            },
          },
        },
      })

      expect(keys(await Fs.readFile(Path.join(outDir, 'a.html'), 'utf8')))
        .toMatchInlineSnapshot(`
        [
          "alpha",
        ]
      `)
      expect(keys(await Fs.readFile(Path.join(outDir, 'b.html'), 'utf8')))
        .toMatchInlineSnapshot(`
        [
          "beta",
        ]
      `)
      expect(keys(await Fs.readFile(Path.join(outDir, 'c.html'), 'utf8')))
        .toMatchInlineSnapshot(`
        [
          "gamma",
        ]
      `)
      expect(keys(await Fs.readFile(Path.join(outDir, 'd.html'), 'utf8')))
        .toMatchInlineSnapshot(`
          [
            "delta",
          ]
        `)
      expect(keys(await Fs.readFile(Path.join(outDir, 'e.html'), 'utf8')))
        .toMatchInlineSnapshot(`
          [
            "epsilon",
          ]
        `)
    } finally {
      await server?.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60000)
  test('initializes packed configurations reached only through another packed contract', async () => {
    const files = {
      'index.html': `<!doctype html><html><head><title>Fixture</title></head><body><script type="module" src="/main.ts"></script></body></html>`,
      'main.ts': `import 'wrapper'; document.documentElement.dataset.ready = 'true';`,
    }
    const { config, root } = await create(files)

    try {
      // The dependency owns a configuration and a shared contribution; the
      // wrapper repacks that contribution, so its contract names the dependency.
      const dependency = Graph.compile({
        modules: {
          'index.ts':
            "import { Config } from 'zyzz'; import { global } from 'zyzz/web'; global({ body: { margin: 0 } }); export const { style, vars:themes } = Config.create({ defaultVars: 'nested', storageKey: 'nested', vars: { nested: { color: { ink: '#123456' } } } });",
        },
      })
      const wrapper = Graph.compile({
        contracts: { 'dep/index.js': dependency.contracts['index.ts']! },
        imports: { 'wrapper/index.ts': { dep: 'dep/index.js' } },
        modules: {
          'wrapper/index.ts': `import 'dep'; export const loaded = true;`,
        },
      })
      const wrapperRoot = Path.join(root, 'node_modules/wrapper')
      const dependencyRoot = Path.join(wrapperRoot, 'node_modules/dep')

      for (const [directory, name, module, contract] of [
        [
          dependencyRoot,
          'dep',
          dependency.modules['index.ts']!.code,
          dependency.contracts['index.ts']!,
        ],
        [
          wrapperRoot,
          'wrapper',
          wrapper.modules['wrapper/index.ts']!.code,
          wrapper.contracts['wrapper/index.ts']!,
        ],
      ] as const) {
        await Fs.mkdir(directory, { recursive: true })
        await Fs.writeFile(
          Path.join(directory, 'package.json'),
          JSON.stringify({
            name,
            type: 'module',
            exports: './index.js',
            sideEffects: false,
          }),
        )
        await Fs.writeFile(
          Path.join(directory, 'index.js'),
          Esbuild.transformSync(module, { loader: 'ts', format: 'esm' }).code,
        )
        await Fs.writeFile(Path.join(directory, 'index.js.zyzz.json'), contract)
      }

      const outDir = Path.join(root, 'dist')

      await Vite.build({ ...config, build: { outDir } })

      const html = await Fs.readFile(Path.join(outDir, 'index.html'), 'utf8')

      expect(
        html.includes('localStorage.getItem("nested")'),
      ).toMatchInlineSnapshot('true')
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 60000)
})
