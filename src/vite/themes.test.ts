/** Verifies production theme colours across Vite CSS processing modes. @module */
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Lightning from 'lightningcss'
import { chromium } from 'playwright'
import * as Vite from 'vite'
import { describe, expect, test } from 'vite-plus/test'
import { zyzz } from 'zyzz/vite'

describe('zyzz', () => {
  test.each([
    ['postcss', false],
    ['postcss', 'esbuild'],
    ['postcss', 'lightningcss'],
    ['lightningcss', false],
    ['lightningcss', 'esbuild'],
    ['lightningcss', 'lightningcss'],
  ] as const)(
    'preserves inline theme schemes with %s processing and %s minification',
    async (transformer, cssMinify) => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-theme-scheme-'))
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      let server: Vite.PreviewServer | undefined

      try {
        browser = await chromium.launch()
        await Fs.writeFile(
          Path.join(root, 'index.html'),
          '<script type="module" src="/main.ts"></script>',
        )
        await Fs.writeFile(
          Path.join(root, 'main.ts'),
          "\nimport { Config, Vars } from 'zyzz'\nconst base = Vars.define({ color: { surface: { light: '#ffffff', dark: '#202029' }, text: { light: '#20202a', dark: '#f4f4f8' } } })\nconst { style, vars:themes } = Config.create({ defaultVars: 'base', vars: { base } })\nconst card = style({ backgroundColor: 'surface', color: 'text', border: '1px solid', borderColor: 'text' })\nconst scope = themes({ set:'base', colorScheme: 'light' })\nconst props = card()\ndocument.body.innerHTML = '<main class=\"' + scope.className + '\"><div id=\"card\" class=\"' + props.className + '\">Theme</div></main>'\nObject.assign(document.querySelector('main').style, scope.style)\n",
        )
        const config: Vite.InlineConfig = {
          build: { cssMinify, cssTarget: ['chrome123'] },
          configFile: false,
          css: {
            transformer,
            lightningcss: { targets: { chrome: 123 << 16 } },
          },
          logLevel: 'silent',
          plugins: [
            zyzz(),
            {
              name: 'application-css',
              config: () => ({
                css: {
                  lightningcss: {
                    exclude: 1,
                    include: Lightning.Features.LightDark,
                  },
                },
              }),
            },
          ],
          root,
        }

        await Vite.build(config)
        server = await Vite.preview({
          ...config,
          preview: { host: '127.0.0.1', port: 0 },
        })
        const page = await browser.newPage()
        await page.goto(server.resolvedUrls!.local[0]!)
        await page.waitForSelector('#card')

        for (const scheme of ['light', 'dark', 'light']) {
          await page.locator('main').evaluate((element, value) => {
            element.style.colorScheme = value
          }, scheme)
          const actual = await page.locator('#card').evaluate((element) => {
            const style = getComputedStyle(element)
            return [
              style.backgroundColor,
              style.color,
              style.borderTopColor,
              style.borderRightColor,
            ]
          })

          if (scheme === 'dark')
            expect(actual).toMatchInlineSnapshot(`
              [
                "rgb(32, 32, 41)",
                "rgb(244, 244, 248)",
                "rgb(244, 244, 248)",
                "rgb(244, 244, 248)",
              ]
            `)
          else
            expect(actual).toMatchInlineSnapshot(`
              [
                "rgb(255, 255, 255)",
                "rgb(32, 32, 42)",
                "rgb(32, 32, 42)",
                "rgb(32, 32, 42)",
              ]
            `)
        }
        if (transformer === 'postcss' && cssMinify === false) {
          for (const overrides of [
            { build: { cssTarget: ['chrome120'] } },
            { css: { lightningcss: { targets: { chrome: 120 << 16 } } } },
          ]) {
            const result = await Vite.build(
              Vite.mergeConfig(config, overrides),
            ).then(
              () => 'built',
              (error: unknown) =>
                String(error).includes(
                  'Zyzz keeps light-dark() native, which these CSS targets would lower.',
                ),
            )
            expect(result).toMatchInlineSnapshot('true')
          }
        }
      } finally {
        try {
          await browser?.close()
        } finally {
          try {
            if (server)
              await new Promise<void>((resolve, reject) =>
                server!.httpServer.close((error) =>
                  error ? reject(error) : resolve(),
                ),
              )
          } finally {
            await Fs.rm(root, { recursive: true, force: true })
          }
        }
      }
    },
    30000,
  )
  test.each(['chrome120', 'es2015', 'es2020', 'esnext'])(
    'checks application CSS targets from a later plugin: %s',
    async (target) => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-application-theme-'))

      try {
        await Fs.writeFile(
          Path.join(root, 'index.html'),
          '<script type="module" src="/main.ts"></script>',
        )
        await Fs.writeFile(
          Path.join(root, 'main.ts'),
          "import './style.css'; import { style } from 'zyzz'; document.body.className = style({ padding: '1px' })().className",
        )
        await Fs.writeFile(
          Path.join(root, 'style.css'),
          'body { color: light-dark(black, white) }',
        )
        const config: Vite.InlineConfig = {
          configFile: false,
          css: { transformer: 'lightningcss' },
          logLevel: 'silent',
          plugins: [
            zyzz(),
            {
              name: 'application-target',
              config: () => ({ build: { target } }),
            },
          ],
          root,
        }

        // ECMAScript targets name no browser, so CSS falls back to the native light-dark() targets.
        const result = await Vite.build(config).then(
          (output) => {
            const outputs = (
              Array.isArray(output) ? output : [output]
            ) as Vite.Rollup.RollupOutput[]
            const css = outputs
              .flatMap((entry) => entry.output)
              .find((entry) => entry.fileName.endsWith('.css'))

            return css?.type === 'asset' ? String(css.source).trim() : undefined
          },
          (error: unknown) =>
            String(error)
              .split('\n')
              .find((line) => line.includes('uses light-dark()'))
              ?.replace(/assets\/[^ ]+\.css/, '<asset>'),
        )
        if (target === 'chrome120')
          expect(result).toMatchInlineSnapshot(
            `"RolldownError: <asset> uses light-dark(). Zyzz keeps light-dark() native, which these CSS targets would lower. Set build.cssTarget and css.lightningcss.targets to Chrome/Edge 123+, Firefox 120+, or Safari/iOS 17.5+."`,
          )
        else
          expect(result).toMatchInlineSnapshot(
            `"body{color:light-dark(#000,#fff)}.z_YiE3S90{padding:1px}"`,
          )

        await Vite.build({ ...config, build: { cssTarget: 'chrome123' } })
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test.each([undefined, 'chrome120'])(
    'builds server environments with a node target and CSS target %s',
    async (cssTarget) => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-server-theme-'))

      try {
        await Fs.writeFile(
          Path.join(root, 'server.ts'),
          "import { Config, Vars } from 'zyzz'\nconst base = Vars.define({ color: { text: { light: '#20202a', dark: '#f4f4f8' } } })\nconst { style } = Config.create({ defaultVars: 'base', vars: { base } })\nconst card = style({ color: 'text' })\nexport const render = () => '<div class=\"' + card().className + '\"></div>'\n",
        )

        const output = (await Vite.build({
          build: {
            ...(cssTarget ? { cssTarget } : {}),
            rolldownOptions: { input: Path.join(root, 'server.ts') },
            ssr: true,
            ssrEmitAssets: true,
            target: 'node20',
          },
          configFile: false,
          logLevel: 'silent',
          plugins: [zyzz()],
          root,
        })) as Vite.Rollup.RollupOutput
        const css = output.output.find((entry) =>
          entry.fileName.endsWith('.css'),
        )

        // The server build collects theme colours without shipping a browser stylesheet.
        expect(
          css?.type === 'asset' && String(css.source).includes('light-dark('),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test('builds older browser targets without theme colours', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-legacy-target-'))

    try {
      await Fs.writeFile(
        Path.join(root, 'index.html'),
        '<script type="module" src="/main.ts"></script>',
      )
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        "import { style } from 'zyzz'\ndocument.body.className = style({ color: 'rebeccapurple', padding: '1px' })().className\n",
      )

      const output = (await Vite.build({
        build: { cssMinify: false, cssTarget: 'chrome120' },
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        root,
      })) as Vite.Rollup.RollupOutput
      const css = output.output.find((entry) => entry.fileName.endsWith('.css'))

      // 1. Styles without light-dark() build for targets that would lower it.
      expect(css?.type === 'asset' ? String(css.source).trim() : undefined)
        .toMatchInlineSnapshot(`
          ".z_YiE3S90{color:rebeccapurple;}
          .z_YiE3S91{padding:1px;}"
        `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
