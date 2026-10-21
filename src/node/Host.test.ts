import { Vars } from 'zyzz'
/**
 * Exercises the public Host workflow through real collaborating modules.
 * @module
 */
import * as ColorProfile from '../../test/fixtures/ColorProfile.js'
import * as FontFeatures from '../../test/fixtures/FontFeatures.js'
import * as Functions from '../../test/fixtures/Functions.js'
import * as GroupingRules from '../../test/fixtures/GroupingRules.js'
import * as NamedDescriptors from '../../test/fixtures/NamedDescriptors.js'
import * as Margins from '../../test/fixtures/PageMargins.js'
import * as Pages from '../../test/fixtures/Pages.js'
import * as PlainPackage from '../../test/fixtures/PlainPackage.js'
import * as Registrations from '../../test/fixtures/Registrations.js'
import * as Statements from '../../test/fixtures/Statements.js'
import * as Universal from '../../test/fixtures/UniversalLibrary.js'
import * as Watch from '../../test/fixtures/Watch.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as ChildProcess from 'node:child_process'
import * as Esbuild from 'esbuild'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Util from 'node:util'
import { chromium } from 'playwright'
import { describe, expect, test, vi } from 'vite-plus/test'
import { Graph, Source, Transform } from 'zyzz/compiler'
import { Host } from 'zyzz/node'

const project = Path.resolve(import.meta.dirname, '../..')
const source = `import { style } from 'zyzz'; export const button = style({ padding: '8px' });`

describe('create', () => {
  test('leaves explicit external imports for downstream plugins and compiles local styles', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-external-'))
    try {
      await Fs.mkdir(Path.join(root, 'src'))
      await Fs.writeFile(
        Path.join(root, 'src/theme.ts'),
        `import {Config} from 'zyzz';export const {style}=Config.create({layers:['components'],defaultLayer:'components'});`,
      )
      await Fs.writeFile(
        Path.join(root, 'src/app.ts'),
        `import Icon from '~icons/lucide/check';import config from 'virtual:config';import plugin from 'framework-config';import {style} from './theme.js';export const card=style({color:'red'});export const view=[Icon,config,plugin,card()];`,
      )
      await using host = await Host.create({
        css: false,
        external: ['~icons/*', 'framework-config'],
        outDir: Path.join(root, 'dist'),
        packageId: 'app',
        root: Path.join(root, 'src'),
      })

      await host.build()

      const code = await Fs.readFile(Path.join(root, 'dist/app.ts'), 'utf8')
      expect(
        code.includes("import Icon from '~icons/lucide/check'"),
      ).toMatchInlineSnapshot('true')
      expect(
        code.includes("import plugin from 'framework-config'"),
      ).toMatchInlineSnapshot('true')
      expect(code.includes("style({color:'red'})")).toMatchInlineSnapshot(
        'false',
      )
      const css = await Fs.readFile(Path.join(root, 'dist/zyzz.css'), 'utf8')
      expect(css.includes('@layer components')).toMatchInlineSnapshot('true')
      expect(/color:\s*red/.test(css)).toMatchInlineSnapshot('true')

      await Fs.writeFile(
        Path.join(root, 'src/app.ts'),
        `import missing from 'framework-config-extra';export const value=missing;`,
      )
      const error = await host.build().catch((error: Error) => error)
      expect(
        error instanceof Error
          ? error.message.replaceAll(root, '<root>')
          : error,
      ).toMatchInlineSnapshot(
        '"app/app.ts:0: Unable to resolve "framework-config-extra" from <root>/src/app.ts: Cannot find module \'framework-config-extra\'"',
      )
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('rejects unsupported external import patterns', async () => {
    await expect(
      Host.create({
        external: ['~icons/*/check'],
        packageId: 'app',
        root: 'src',
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      '[Error: External imports require exact names or a trailing * prefix.]',
    )
  })

  test('rejects external values used in statically compiled styles', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-host-external-style-'),
    )
    try {
      await Fs.mkdir(Path.join(root, 'src'))
      await Fs.writeFile(
        Path.join(root, 'src/app.ts'),
        `import {accent} from 'plugin-theme';import {style} from 'zyzz';export const card=style({color:accent});`,
      )
      await using host = await Host.create({
        external: ['plugin-theme'],
        outDir: Path.join(root, 'dist'),
        packageId: 'app',
        root: Path.join(root, 'src'),
      })

      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app/app.ts:94: Expected a literal string or number; expressions are not evaluated.]`,
      )
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each(['@acme/universal', '@acme/universal/button', '#button'])(
    'compiles installed import-condition contracts from %s',
    async (specifier) => {
      const root = await Fs.realpath(
        await Fs.mkdtemp(Path.join(Os.tmpdir(), 'zyzz-host-package-')),
      )
      try {
        const library = await Universal.create(root)
        const manifest = Path.join(library.installed, 'package.json')
        const metadata = JSON.parse(await Fs.readFile(manifest, 'utf8'))
        metadata.exports['./button'] = {
          require: './missing.cjs',
          import: './web/button.js',
        }
        await Fs.writeFile(manifest, JSON.stringify(metadata))
        await Fs.writeFile(
          Path.join(root, 'package.json'),
          JSON.stringify({
            private: true,
            type: 'module',
            imports: { '#button': '@acme/universal/button' },
          }),
        )
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/app.ts'),
          `import * as library from '${specifier}';import type {Uninstalled} from 'type-only-package';export const props=library.button({size:'large',active:true});`,
        )
        const outDir = Path.join(root, 'dist')
        await using host = await Host.create({
          root: Path.join(root, 'src'),
          outDir,
          packageId: 'app',
          native: { colorScheme: 'dark', platform: 'android' },
        })
        await host.build()
        expect((await host.build()).changed).toMatchInlineSnapshot('[]')
        const bundle = await Esbuild.build({
          entryPoints: [Path.join(outDir, 'app.ts')],
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
        })
        await Fs.writeFile(
          Path.join(root, 'consumer.mjs'),
          bundle.outputFiles[0]!.text,
        )
        const result = await Util.promisify(ChildProcess.execFile)(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {props} from ${JSON.stringify(Path.join(root, 'consumer.mjs'))};console.log(JSON.stringify(props));`,
          ],
        )
        expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
          {
            "style": {
              "color": "#abcdef",
              "fontSize": 20,
              "opacity": 0.8,
            },
          }
        `)
        expect(
          (await Fs.readdir(outDir)).some((name) => name.endsWith('.css')),
        ).toMatchInlineSnapshot('false')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    120000,
  )

  test('loads transitive packed contributions without executing packages', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-host-contracts-'),
    )
    try {
      const library = Path.join(root, 'node_modules/library')
      await Fs.mkdir(library, { recursive: true })
      await Fs.mkdir(Path.join(root, 'src'))
      await Fs.writeFile(
        Path.join(library, 'package.json'),
        JSON.stringify({ name: 'library', exports: './index.js' }),
      )
      const dependency = Graph.compile({
        modules: {
          'library/global.ts': `import {global} from 'zyzz/web';global({body:{color:'red'}});`,
        },
      })
      const packed = Graph.compile({
        contracts: {
          'library/global.js': dependency.contracts['library/global.ts']!,
        },
        imports: { 'library/index.ts': { './global.js': 'library/global.js' } },
        modules: {
          'library/index.ts': `import './global.js';export const version=1;`,
        },
      })
      for (const [name, content] of Object.entries({
        ...dependency.contracts,
        ...packed.contracts,
      })) {
        const entry = Path.join(
          library,
          Path.basename(name).replace('.ts', '.js'),
        )
        await Fs.writeFile(
          entry,
          `throw new Error('Package must not execute during compilation');`,
        )
        await Fs.writeFile(entry + '.zyzz.json', content)
      }
      await Fs.writeFile(
        Path.join(root, 'src/app.ts'),
        `import {version} from 'library';export {version};`,
      )
      await using host = await Host.create({
        root: Path.join(root, 'src'),
        outDir: Path.join(root, 'dist'),
        packageId: 'app',
        css: false,
      })
      await host.build()
      expect(
        await Fs.readFile(Path.join(root, 'dist/zyzz.shared.css'), 'utf8'),
      ).toMatchInlineSnapshot(`"body{color:red;}"`)
      expect(
        (await Fs.readFile(Path.join(root, 'dist/app.ts'), 'utf8')).includes(
          'version',
        ),
      ).toMatchInlineSnapshot('true')
      const sidecar = Path.join(library, 'global.js.zyzz.json')
      const saved = await Fs.readFile(sidecar, 'utf8')
      await Fs.writeFile(sidecar, '{')
      await expect(host.build()).rejects.toThrow('Invalid library contract')
      expect(
        await Fs.readFile(Path.join(root, 'dist/zyzz.shared.css'), 'utf8'),
      ).toMatchInlineSnapshot(`"body{color:red;}"`)
      await Fs.writeFile(sidecar, saved)
      expect((await host.build()).changed).toMatchInlineSnapshot('[]')
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each([false, true])(
    'watches package replacement and recovery (linked: %s)',
    async (linked) => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-package-watch-'),
      )
      try {
        const installed = Path.join(root, 'node_modules/library')
        const library = linked ? Path.join(root, 'linked') : installed
        const outDir = Path.join(root, 'dist')
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.mkdir(Path.dirname(installed))
        await Fs.writeFile(Path.join(root, 'src/app.ts'), `import 'library';`)
        await using host = await Host.create({
          root: Path.join(root, 'src'),
          outDir,
          packageId: 'app',
          css: false,
        })
        const errors: unknown[] = []
        host.watch({
          onResult(event) {
            if ('error' in event) errors.push(event.error)
          },
        })
        await vi.waitFor(() => {
          if (!errors.length)
            throw new Error('Awaiting missing package diagnostic')
        })
        expect(
          String(errors[0]).includes('Unable to resolve "library"'),
        ).toMatchInlineSnapshot('true')

        await Fs.mkdir(library, { recursive: true })
        if (linked) await Fs.symlink(library, installed, 'dir')
        const manifest = Path.join(library, 'package.json')
        await Fs.writeFile(
          manifest,
          JSON.stringify({ name: 'library', exports: './index.js' }),
        )
        await Fs.writeFile(Path.join(library, 'index.js'), '')
        const sidecar = Path.join(library, 'index.js.zyzz.json')
        const red = Graph.compile({
          modules: {
            'library/index.ts': `import {global} from 'zyzz/web';global({body:{color:'red'}});`,
          },
        }).contracts['library/index.ts']!
        const blue = Graph.compile({
          modules: {
            'library/index.ts': `import {global} from 'zyzz/web';global({body:{color:'blue'}});`,
          },
        }).contracts['library/index.ts']!
        const output = Path.join(outDir, 'zyzz.shared.css')
        await Watch.write({ path: sidecar, source: red })
        await vi.waitFor(
          async () => {
            if ((await Fs.readFile(output, 'utf8')) !== 'body{color:red;}')
              throw new Error('Awaiting red stylesheet')
          },
          { timeout: 10000 },
        )
        const count = errors.length
        await Watch.write({ path: sidecar, source: '{' })
        await vi.waitFor(() => {
          if (errors.length === count)
            throw new Error('Awaiting metadata diagnostic')
        })
        expect(await Fs.readFile(output, 'utf8')).toMatchInlineSnapshot(
          `"body{color:red;}"`,
        )
        await Watch.write({ path: sidecar, source: blue })
        await vi.waitFor(
          async () => {
            if ((await Fs.readFile(output, 'utf8')) !== 'body{color:blue;}')
              throw new Error('Awaiting blue stylesheet')
          },
          { timeout: 10000 },
        )

        const removed = errors.length
        await Fs.rm(sidecar)
        await vi.waitFor(() => {
          if (errors.length === removed)
            throw new Error('Awaiting missing sidecar diagnostic')
        })
        expect(await Fs.readFile(output, 'utf8')).toMatchInlineSnapshot(
          `"body{color:blue;}"`,
        )
        await Watch.write({ path: sidecar, source: red })
        await vi.waitFor(
          async () => {
            if ((await Fs.readFile(output, 'utf8')) !== 'body{color:red;}')
              throw new Error('Awaiting restored stylesheet')
          },
          { timeout: 10000 },
        )

        await Fs.writeFile(Path.join(library, 'alternate.js'), '')
        const switched = errors.length
        await Watch.write({
          path: manifest,
          source: JSON.stringify({
            name: 'library',
            exports: './alternate.js',
          }),
        })
        await vi.waitFor(() => {
          if (errors.length === switched)
            throw new Error('Awaiting missing export contract diagnostic')
        })
        expect(await Fs.readFile(output, 'utf8')).toMatchInlineSnapshot(
          `"body{color:red;}"`,
        )
        await Fs.writeFile(Path.join(library, 'alternate.js.zyzz.json'), blue)
        await vi.waitFor(
          async () => {
            if ((await Fs.readFile(output, 'utf8')) !== 'body{color:blue;}')
              throw new Error('Awaiting new export')
          },
          { timeout: 10000 },
        )
        const missing = errors.length
        await Fs.rename(library, library + '-saved')
        await vi.waitFor(() => {
          if (errors.length === missing)
            throw new Error('Awaiting removed package diagnostic')
        })
        expect(await Fs.readFile(output, 'utf8')).toMatchInlineSnapshot(
          `"body{color:blue;}"`,
        )
        await Fs.writeFile(
          Path.join(library + '-saved', 'alternate.js.zyzz.json'),
          red,
        )
        await Fs.rename(library + '-saved', library)
        await vi.waitFor(
          async () => {
            if ((await Fs.readFile(output, 'utf8')) !== 'body{color:red;}')
              throw new Error('Awaiting restored package')
          },
          { timeout: 10000 },
        )
        if (linked) {
          await Fs.cp(library, library + '-other', { recursive: true })
          await Fs.writeFile(
            Path.join(library + '-other', 'alternate.js.zyzz.json'),
            blue,
          )
          await Fs.unlink(installed)
          await Fs.symlink(library + '-other', installed, 'dir')
          await vi.waitFor(
            async () => {
              if ((await Fs.readFile(output, 'utf8')) !== 'body{color:blue;}')
                throw new Error('Awaiting retargeted package')
            },
            { timeout: 10000 },
          )
        }
        const final = await Fs.readFile(output, 'utf8')
        await host.close()
        await Watch.write({ path: sidecar, source: blue })
        expect(await Fs.readFile(output, 'utf8')).toBe(final)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    },
    30000,
  )

  test('captures native context before creation yields and preserves it across rebuilds', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-context-'))
    const outDir = Path.join(root, 'output')
    const native = {
      colorScheme: 'light' as 'dark' | 'light',
      fonts: { Inter: 'Inter-Regular' },
      platform: 'ios' as 'android' | 'ios',
      set: 'initial',
      vars: { changed: Vars.define({}), initial: Vars.define({}) },
      units: { px: 2, rem: 16 },
    }
    const options = { native, outDir, packageId: 'native-app', root }
    const source =
      "import {Config} from 'zyzz';\n      const {style}=Config.create({vars:{color:{ink:{light:'#123456',dark:'#654321'}}}});\n      export const card=style({color:'ink',fontFamily:'Inter',fontSize:'1rem',width:'10px',targets:{ios:{opacity:0.7},android:{opacity:0.3}}});"

    try {
      await Fs.writeFile(Path.join(root, 'card.ts'), source)

      const pending = Host.create(options)
      native.colorScheme = 'dark'
      await using host = await pending
      native.fonts.Inter = 'Inter-Bold'
      native.platform = 'android'
      native.set = 'changed'
      delete (native.vars as Partial<typeof native.vars>).initial
      delete (native.vars as Partial<typeof native.vars>).changed
      native.units.px = 3
      native.units.rem = 20

      for (const edited of [false, true]) {
        if (edited)
          await Fs.writeFile(
            Path.join(root, 'card.ts'),
            source + '\nexport const edited = true;',
          )

        await host.build()
        expect((await host.build()).changed).toMatchInlineSnapshot('[]')

        const output = await Esbuild.build({
          entryPoints: [Path.join(outDir, 'card.ts')],
          alias: { 'zyzz/runtime': Path.join(project, 'src/runtime/index.ts') },
          bundle: true,
          format: 'esm',
          platform: 'node',
          write: false,
        })
        const file = Path.join(root, 'bundle.mjs')
        await Fs.writeFile(
          file,
          output.outputFiles[0]!.text +
            '\nconsole.log(JSON.stringify(card()));',
        )
        const executed = await Util.promisify(ChildProcess.execFile)(
          process.execPath,
          [file],
        )

        expect(JSON.parse(executed.stdout)).toMatchInlineSnapshot(`
          {
            "style": {
              "color": "#123456",
              "fontFamily": "Inter-Regular",
              "fontSize": 16,
              "opacity": 0.7,
              "width": 20,
            },
          }
        `)
        options.native = { ...native, colorScheme: 'dark' }
      }
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('publishes native modules and recovers watched imported token edits', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-native-'))
    const outDir = Path.join(root, 'output')
    const config =
      "import {Config} from 'zyzz';export const {style}=Config.create({vars:{color:{ink:'#123456'}}});"
    try {
      await Fs.writeFile(Path.join(root, 'theme.ts'), config)
      await Fs.writeFile(
        Path.join(root, 'card.ts'),
        `import {style} from './theme.js';export const card=style({color:'ink'});`,
      )
      await using host = await Host.create({
        root,
        outDir,
        packageId: 'native-app',
        native: { colorScheme: 'light', platform: 'ios' },
      })
      const watch = Watch.create({ path: 'card.ts' })
      const initial = watch.next()
      let recovering = false
      host.watch({
        onResult(event) {
          if (recovering && 'error' in event) return
          watch.onResult(event)
        },
      })
      await initial
      const original = await Fs.readFile(Path.join(outDir, 'card.ts'), 'utf8')
      expect(original.includes('#123456')).toMatchInlineSnapshot('true')
      expect((await host.build()).changed).toMatchInlineSnapshot('[]')
      expect(
        (await host.build()).files.some(
          (path) => /\.css(?:\.map)?$/.test(path) || path === 'zyzz.js',
        ),
      ).toMatchInlineSnapshot('false')
      await expect(
        watch.next(() =>
          Watch.write({
            path: Path.join(root, 'theme.ts'),
            source: 'export const =',
          }),
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: native-app/theme.ts:13: Unexpected token]`,
      )
      expect(
        (await Fs.readFile(Path.join(outDir, 'card.ts'), 'utf8')) === original,
      ).toMatchInlineSnapshot('true')
      recovering = true
      await watch.next(() =>
        Watch.write({
          path: Path.join(root, 'theme.ts'),
          source: config.replace('#123456', '#654321'),
        }),
      )
      expect(
        (await Fs.readFile(Path.join(outDir, 'card.ts'), 'utf8')).includes(
          '#654321',
        ),
      ).toMatchInlineSnapshot('true')
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('excludes fixture contributions from standalone CSS', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-host-contributions-'),
    )
    const outDir = Path.join(root, 'output')

    try {
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        'import { global } from "zyzz/web"; global({body:{color:"blue"}})',
      )

      for (const directory of [
        'test',
        'tests',
        '__tests__',
        'fixtures',
        '__fixtures__',
      ]) {
        await Fs.mkdir(Path.join(root, directory))
        await Fs.writeFile(
          Path.join(root, directory, 'reset.ts'),
          'import { global } from "zyzz/web"; global({body:{color:"red"}})',
        )
      }

      await using host = await Host.create({
        root,
        outDir,
        packageId: 'example',
      })

      await host.build()

      const css = await Fs.readFile(
        Path.join(outDir, 'zyzz.shared.css'),
        'utf8',
      )

      expect(css).toContain('#00f')
      expect(css).not.toContain('red')
      expect(css).not.toContain('#f00')
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
  test('await using drains builds and releases output ownership on scope exit', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-dispose-'))
    const outDir = Path.join(root, 'output')
    const options = { outDir, packageId: 'example', root }

    try {
      await Fs.writeFile(Path.join(root, 'button.ts'), source)
      await expect(
        (async () => {
          await using host = await Host.create(options)

          void host.build()
          throw new Error('Scope failed')
        })(),
      ).rejects.toThrowErrorMatchingInlineSnapshot('[Error: Scope failed]')

      expect(await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ".z_CVE4-Z0 {
            padding: 8px;
          }
          "
        `)

      await using host = await Host.create(options)

      expect((await host.build()).changed).toMatchInlineSnapshot('[]')
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('explicit config scopes deliver unused catalog variables in Chromium', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-complete-config-'),
    )
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      await Fs.mkdir(Path.join(root, 'src'))
      const entry = Path.join(root, 'src/config.ts')
      await Fs.writeFile(
        entry,
        `import {Config,Vars} from 'zyzz';
const base=Vars.define({color:{ink:'#123456',surface:'#abcdef'},dimension:{gutter:{default:'16px','@media (min-width: 768px)':'24px'}}},{id:'catalog'});
const inverse=Vars.extend(base,{color:{surface:'#000000'}});
export const {style,vars}=Config.create({id:'complete-config',vars:{base,inverse},defaultVars:'base',mappings:false});
export const card=style({color:'color.ink'});
export const dark=vars({set:'inverse',colorScheme:'dark'});`,
      )
      browser = await chromium.launch()

      for (const { compiler, modules } of [
        { compiler: false, modules: false },
        { compiler: true, modules: false },
        { compiler: true, modules: true },
      ]) {
        const outDir = Path.join(root, `${compiler}-${modules}`)
        await using host = await Host.create({
          compiler,
          modules,
          outDir,
          packageId: 'catalog',
          root: Path.join(root, 'src'),
        })
        await host.build()

        if (!modules) {
          const css = await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')
          await Fs.writeFile(
            Path.join(root, `src/icons-${compiler}.ts`),
            'export const icon = "<svg></svg>";',
          )

          await host.build()

          expect(
            (
              await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')
            ).trim() === css.trim(),
          ).toMatchInlineSnapshot('true')
        }

        const bundle = await Esbuild.build({
          alias: {
            zyzz: Path.join(project, 'src/index.ts'),
            'zyzz/runtime': Path.join(project, 'src/runtime/index.ts'),
          },
          bundle: true,
          entryPoints: [modules ? Path.join(outDir, 'config.ts') : entry],
          format: 'iife',
          globalName: 'Fixture',
          write: false,
        })
        const page = await browser.newPage({
          viewport: { width: 767, height: 600 },
        })
        await page.setContent('<section><div>Catalog</div></section>')
        await page.addStyleTag({
          content: await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8'),
        })
        await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
        await page.evaluate(() => {
          const { vars } = (
            window as unknown as {
              Fixture: {
                dark: { className: string }
                vars: (options: { set: string }) => { className: string }
              }
            }
          ).Fixture
          const scope = document.querySelector('section')!
          scope.className = vars({ set: 'inverse' }).className
          const properties = Array.from(getComputedStyle(scope))
          const surface = properties.find((name) =>
            name.endsWith('-color-surface'),
          )
          const gutter = properties.find((name) =>
            name.endsWith('-dimension-gutter'),
          )
          if (!surface || !gutter)
            throw new Error('Incomplete variable catalog')
          const element = document.querySelector('div')!
          element.style.backgroundColor = `var(${surface})`
          element.style.paddingInline = `var(${gutter})`
        })

        expect(
          await page
            .locator('div')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
        expect(
          await page
            .locator('div')
            .evaluate(
              (element) => getComputedStyle(element).paddingInlineStart,
            ),
        ).toMatchInlineSnapshot('"16px"')

        await page.evaluate(() => {
          const fixture = (
            window as unknown as { Fixture: { dark: { className: string } } }
          ).Fixture
          document.querySelector('section')!.className = fixture.dark.className
        })

        expect(
          await page
            .locator('section')
            .evaluate((element) => getComputedStyle(element).colorScheme),
        ).toMatchInlineSnapshot('"dark"')

        await page.setViewportSize({ width: 768, height: 600 })

        expect(
          await page
            .locator('div')
            .evaluate(
              (element) => getComputedStyle(element).paddingInlineStart,
            ),
        ).toMatchInlineSnapshot('"24px"')
        await page.close()
      }
    } finally {
      await browser?.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 30_000)

  test('processed themes and props render in Chromium', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-css-browser-'))
    const outDir = Path.join(root, 'output')

    const host = await Host.create({
      css: { minify: true, targets: { safari: 8 << 16 } },
      outDir,
      packageId: 'example',
      root,
    })

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      await Fs.writeFile(
        Path.join(root, 'card.ts'),
        "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({ color: { brand: '#ff0000' } });\nconst alternate = Vars.extend(theme, { color: { brand: '#0000ff' } }); const config=Config.create({vars:{base:theme,alternate},defaultVars:'base'});\nexport const scope = config.vars({set:'alternate'}).className;\nexport const card = config.style({ color: 'brand', display: 'flex', padding: '8px' })();",
      )
      await host.build()

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.join(project, 'src/runtime/index.ts') },
        bundle: true,
        entryPoints: [Path.join(outDir, 'card.ts')],
        format: 'iife',
        globalName: 'Fixture',
        write: false,
      })

      browser = await chromium.launch()

      const page = await browser.newPage()

      await page.setContent('<section><div>Card</div></section>')
      await page.addStyleTag({
        content: await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8'),
      })
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            Fixture: { card: { className: string }; scope: string }
          }
        ).Fixture

        document.querySelector('section')!.className = fixture.scope
        document.querySelector('div')!.className = fixture.card.className
      })

      expect(
        await page
          .locator('div')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
      expect(
        await page
          .locator('div')
          .evaluate((element) => getComputedStyle(element).display),
      ).toMatchInlineSnapshot('"flex"')
      expect(
        await page
          .locator('div')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot('"8px"')
    } finally {
      await browser?.close()
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('publishes one complete stylesheet with dependencies before consumers', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-complete-css-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      // Lexical order puts the consumer first; the complete stylesheet must not.
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import { style } from 'zyzz';
import { global } from 'zyzz/web';
import { widget } from './widget.js';
global({ body: { margin: 0 } });
export const app = style({ color: '#0000ff' });
export { widget };`,
      )
      await Fs.writeFile(
        Path.join(root, 'widget.ts'),
        `import { style } from 'zyzz';
export const widget = style({ color: '#ff0000', padding: '4px' });`,
      )

      const result = await host.build()

      expect(result.files.filter((file) => file.startsWith('zyzz.')))
        .toMatchInlineSnapshot(`
        [
          "zyzz.css",
          "zyzz.css.map",
          "zyzz.shared.css",
          "zyzz.shared.css.map",
        ]
      `)

      const css = await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')

      expect(css).toMatchInlineSnapshot(`
        "body {
          margin: 0;
        }
        .z_nBAAG70 {
          color: red;
        }

        .z_nBAAG71 {
          padding: 4px;
        }
        .z_2cB71a0 {
          color: #00f;
        }
        "
      `)

      const map = new Trace.TraceMap(
        await Fs.readFile(Path.join(outDir, 'zyzz.css.map'), 'utf8'),
      )

      expect(map.sources).toMatchInlineSnapshot(`
        [
          "example/app.ts",
          "zyzz.shared.css",
          "example/widget.ts",
          "example/widget.ts.css",
          "example/app.ts.css",
        ]
      `)
      expect(Trace.originalPositionFor(map, { column: 0, line: 4 }))
        .toMatchInlineSnapshot(`
          {
            "column": 22,
            "line": 2,
            "name": "style-uhlxslorn1at-52",
            "source": "example/widget.ts",
          }
        `)
      expect(Trace.originalPositionFor(map, { column: 0, line: 11 }))
        .toMatchInlineSnapshot(`
          {
            "column": 19,
            "line": 5,
            "name": "style-1nmg2kgs6bjew-155",
            "source": "example/app.ts",
          }
        `)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.join(project, 'src/runtime/index.ts') },
        bundle: true,
        entryPoints: [Path.join(outDir, 'app.ts')],
        format: 'iife',
        globalName: 'Fixture',
        write: false,
      })

      browser = await chromium.launch()

      const page = await browser.newPage()

      await page.setContent('<div>Widget</div>')
      await page.addStyleTag({ content: css })
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      await page.evaluate(() => {
        const fixture = (
          window as unknown as {
            Fixture: {
              app: () => { className: string }
              widget: () => { className: string }
            }
          }
        ).Fixture

        document.querySelector('div')!.className =
          `${fixture.widget().className} ${fixture.app().className}`
      })

      // The consumer's color wins over the imported widget's color of equal specificity.
      expect(
        await page
          .locator('div')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
      expect(
        await page
          .locator('div')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"4px"`)
      expect(
        await page
          .locator('body')
          .evaluate((element) => getComputedStyle(element).margin),
      ).toMatchInlineSnapshot(`"0px"`)
    } finally {
      await browser?.close()
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('orders sibling stylesheets by authored import order from graph roots', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-root-order-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })

    try {
      // Name order would put a before z; the entry imports z first.
      await Fs.writeFile(
        Path.join(root, 'main.ts'),
        `import { z } from './z.js'; import { a } from './a.js'; export { a, z };`,
      )
      await Fs.writeFile(
        Path.join(root, 'z.ts'),
        `import { style } from 'zyzz'; export const z = style({ padding: '1px' });`,
      )
      await Fs.writeFile(
        Path.join(root, 'a.ts'),
        `import { style } from 'zyzz'; export const a = style({ padding: '2px' });`,
      )
      await host.build()

      expect(
        (await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')).match(
          /padding: \dpx/g,
        ),
      ).toMatchInlineSnapshot(`
        [
          "padding: 1px",
          "padding: 2px",
        ]
      `)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('declares scheme classes once in the complete stylesheet', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-complete-schemes-'),
    )
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'x', root })

    try {
      await Fs.writeFile(
        Path.join(root, 'zyzz.config.ts'),
        `import { defineConfig, defineVars } from 'zyzz'
const base = defineVars({ spacing: { page: '1rem' } })
export const { appearance, script, style, variants, vars } = defineConfig({ vars: base })`,
      )
      await Fs.writeFile(
        Path.join(root, 'Preview.tsx'),
        `import { vars } from './zyzz.config.js'
export function Preview() {
  return <section {...vars({ colorScheme: 'dark' })} />
}`,
      )
      await host.build()

      expect(await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8'))
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
        "
      `)

      // Module stylesheets keep their own declarations for independent loading.
      expect(await Fs.readFile(Path.join(outDir, 'Preview.tsx.css'), 'utf8'))
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
        "
      `)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('shares independent rules across modules and rebuilds them like a fresh build', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-independent-host-'),
    )
    const fresh = await Fs.mkdtemp(
      Path.join(project, '.fixture-independent-fresh-'),
    )
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'x', root })
    const module = (name: string, style: string) =>
      `import { style } from './zyzz.config.js'

namespace styles {
  export const card = style(${style})
}

export const ${name} = styles.card().className
`

    try {
      await Fs.writeFile(
        Path.join(root, 'zyzz.config.ts'),
        `import { defineConfig } from 'zyzz'

export const { style } = defineConfig({ composition: 'independent' })
`,
      )
      await Fs.writeFile(
        Path.join(root, 'a.ts'),
        module('a', `{ color: 'red', padding: '8px' }`),
      )
      await Fs.writeFile(
        Path.join(root, 'b.ts'),
        module('b', `{ color: 'red', padding: '4px' }`),
      )
      await host.build()

      // Each module stylesheet loads alone, and the complete stylesheet keeps one rule per name.
      expect(await Fs.readFile(Path.join(outDir, 'b.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
        ".z_q7GXvW0 {
          color: red;
        }

        .z_S7Ghdp1 {
          padding: 4px;
        }
        "
      `)
      expect(await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8'))
        .toMatchInlineSnapshot(`
        ".z_q7GXvW0 {
          color: red;
        }

        .z_q7GXvW1 {
          padding: 8px;
        }
        .z_S7Ghdp1 {
          padding: 4px;
        }
        "
      `)

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        const classes = await Promise.all(
          ['a', 'b'].map(async (name) => {
            const code = await Fs.readFile(
              Path.join(outDir, `${name}.ts`),
              'utf8',
            )

            // The folded class read is the module's class list.
            return /export const \w+ = "([^"]+)"/.exec(code)![1]!
          }),
        )

        await page.setContent(
          `<style>${await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')}</style>${classes.map((className) => `<div class="${className}"></div>`).join('')}`,
        )

        expect(
          await page.locator('div').evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element)

              return [style.color, style.padding]
            }),
          ),
        ).toMatchInlineSnapshot(`
          [
            [
              "rgb(255, 0, 0)",
              "8px",
            ],
            [
              "rgb(255, 0, 0)",
              "4px",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }

      // Removing the lender's rule makes the cached borrower name it itself.
      await Fs.writeFile(
        Path.join(root, 'a.ts'),
        module('a', `{ padding: '8px' }`),
      )
      await host.build()

      for (const name of ['zyzz.config.ts', 'a.ts', 'b.ts'])
        await Fs.copyFile(Path.join(root, name), Path.join(fresh, name))

      const freshOutput = Path.join(fresh, 'output')
      const rebuilt = await Host.create({
        outDir: freshOutput,
        packageId: 'x',
        root: fresh,
      })

      try {
        await rebuilt.build()

        for (const name of ['a.ts', 'b.ts', 'zyzz.css'])
          expect(
            (await Fs.readFile(Path.join(outDir, name), 'utf8')) ===
              (await Fs.readFile(Path.join(freshOutput, name), 'utf8')),
            name,
          ).toMatchInlineSnapshot(`true`)
      } finally {
        await rebuilt.close()
      }

      expect(await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8'))
        .toMatchInlineSnapshot(`
        ".z_q7GXvW0 {
          padding: 8px;
        }
        .z_S7Ghdp0 {
          color: red;
        }

        .z_S7Ghdp1 {
          padding: 4px;
        }
        "
      `)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
      await Fs.rm(fresh, { force: true, recursive: true })
    }
  })

  test('publishes initialization for configurations kept local to a module', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-local-config-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })

    try {
      await Fs.writeFile(
        Path.join(root, 'local.ts'),
        "import { Config } from 'zyzz';\nconst { style, appearance } = Config.create({ defaultVars: 'base', storageKey: 'kept', vars: { base: { color: { ink: '#123456' } } } });\nexport const card = style({ color: 'ink' });\nexport const select = appearance.set;",
      )
      // A scheme-only configuration emits no CSS and exports no binding, so
      // the catalog alone justifies the module's contract.
      await Fs.writeFile(
        Path.join(root, 'toggle.ts'),
        `import { Config } from 'zyzz';
const { appearance } = Config.create({ storageKey: 'scheme-only' });
export function dark() { appearance.set({ colorScheme: 'dark' }) }`,
      )
      await host.build()

      const script = await Fs.readFile(Path.join(outDir, 'zyzz.js'), 'utf8')

      expect(
        script.includes('localStorage.getItem("kept")'),
      ).toMatchInlineSnapshot(`true`)
      expect(script.includes('["base","z-theme-')).toMatchInlineSnapshot(`true`)
      expect(
        script.includes('localStorage.getItem("scheme-only")'),
      ).toMatchInlineSnapshot(`true`)

      // Local root controls need the runtime helper older readers lack.
      const version = async (name: string) =>
        (
          JSON.parse(await Fs.readFile(Path.join(outDir, name), 'utf8')) as {
            version: number
          }
        ).version

      expect(await version('local.ts.zyzz.json')).toMatchInlineSnapshot(`33`)
      expect(await version('toggle.ts.zyzz.json')).toMatchInlineSnapshot(`31`)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('rejects a script path that names another artifact', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-script-clash-'))
    const outDir = Path.join(root, 'output')

    try {
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import { style } from 'zyzz'; export const card = style({ color: 'red' });`,
      )

      for (const name of ['zyzz.css', '.zyzz.json', 'app.ts.css']) {
        const host = await Host.create({
          outDir,
          packageId: 'example',
          root,
          script: Path.join(outDir, name),
        })

        try {
          await expect(host.build()).rejects.toThrow(
            `The script path collides with the artifact ${name}.`,
          )
        } finally {
          await host.close()
        }
      }

      // The rejected builds published nothing beside the lock and manifest.
      expect(
        (await Fs.readdir(outDir)).filter(
          (name) => !['.zyzz-lock', '.zyzz.json'].includes(name),
        ),
      ).toMatchInlineSnapshot(`[]`)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('rebases nested module URLs in the complete stylesheet', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-rebase-css-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })

    try {
      await Fs.mkdir(Path.join(root, 'components'))
      await Fs.writeFile(
        Path.join(root, 'components/card.ts'),
        `import { style } from 'zyzz';
export const card = style({ backgroundImage: 'url(./icon.svg)', maskImage: 'url(/shared/mask.svg)' });`,
      )
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import { card } from './components/card.js'; export { card };`,
      )
      await host.build()

      const urls = (css: string) => css.match(/url\([^)]*\)/g)

      // The module stylesheet keeps URLs relative to its own directory.
      expect(
        urls(
          await Fs.readFile(
            Path.join(outDir, 'components/card.ts.css'),
            'utf8',
          ),
        ),
      ).toMatchInlineSnapshot(`
        [
          "url("./icon.svg")",
          "url("/shared/mask.svg")",
        ]
      `)
      expect(urls(await Fs.readFile(Path.join(outDir, 'zyzz.css'), 'utf8')))
        .toMatchInlineSnapshot(`
        [
          "url("components/icon.svg")",
          "url("/shared/mask.svg")",
        ]
      `)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('publishes the initialization script inside the output or at an external path', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-script-'))
    const source = Path.join(root, 'src')
    const outDir = Path.join(root, 'output')
    const external = Path.join(root, 'public/zyzz.js')
    const configuration = (storageKey: string) =>
      `import { Config } from 'zyzz';
export const { style, themes } = Config.create({ defaultVars: 'base', storageKey: '${storageKey}', vars: { base: { color: { ink: '#123456' } } } });`

    try {
      await Fs.mkdir(source)
      await Fs.writeFile(Path.join(source, 'config.ts'), configuration('owned'))

      await using owned = await Host.create({
        outDir,
        packageId: 'example',
        root: source,
      })

      const result = await owned.build()
      const script = await Fs.readFile(Path.join(outDir, 'zyzz.js'), 'utf8')

      expect(result.files.includes('zyzz.js')).toMatchInlineSnapshot(`true`)
      expect(
        script.includes('localStorage.getItem("owned")'),
      ).toMatchInlineSnapshot(`true`)
      expect(script.includes('["base","z-theme-')).toMatchInlineSnapshot(`true`)

      await owned.close()

      // An external path serves a bundler's public directory; unchanged content is left alone.
      await Fs.writeFile(
        Path.join(source, 'config.ts'),
        configuration('shared'),
      )

      await using host = await Host.create({
        outDir,
        packageId: 'example',
        root: source,
        script: external,
      })

      expect(
        (await host.build()).files.includes('zyzz.js'),
      ).toMatchInlineSnapshot(`false`)
      expect(
        (await Fs.readFile(external, 'utf8')).includes(
          'localStorage.getItem("shared")',
        ),
      ).toMatchInlineSnapshot(`true`)

      const written = (await Fs.stat(external)).mtimeMs

      await host.build()

      expect(
        (await Fs.stat(external)).mtimeMs === written,
      ).toMatchInlineSnapshot(`true`)

      // Removing every configuration removes the script this host wrote.
      await Fs.writeFile(
        Path.join(source, 'config.ts'),
        `import { style } from 'zyzz'; export const card = style({ padding: '4px' });`,
      )
      await host.build()

      expect(
        await Fs.access(external).then(
          () => 'present',
          () => 'absent',
        ),
      ).toMatchInlineSnapshot(`"absent"`)
      expect(
        await Fs.access(Path.join(outDir, 'zyzz.js')).then(
          () => 'present',
          () => 'absent',
        ),
      ).toMatchInlineSnapshot(`"absent"`)

      await expect(
        Host.create({
          outDir,
          packageId: 'example',
          root: source,
          script: Path.join(source, 'zyzz.js'),
        }),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: The script path must not be inside the source directory.]`,
      )

      await host.close()

      // A script left by an earlier host is recognized by its banner and removed
      // by the first build without configurations; a foreign file rejects the build.
      await Fs.writeFile(
        external,
        '/* zyzz initialization */\n(()=>{/* stale */})();\n',
      )

      await using fresh = await Host.create({
        outDir,
        packageId: 'example',
        root: source,
        script: external,
      })

      await fresh.build()

      expect(
        await Fs.access(external).then(
          () => 'present',
          () => 'absent',
        ),
      ).toMatchInlineSnapshot(`"absent"`)

      await Fs.writeFile(external, 'console.log("theirs")\n')
      await Fs.writeFile(
        Path.join(source, 'config.ts'),
        configuration('shared'),
      )

      expect(
        await fresh.build().then(
          () => 'built',
          (error: unknown) => String(error).replace(root, '<root>'),
        ),
      ).toMatchInlineSnapshot(
        `"Error: Refusing to replace a foreign script: <root>/public/zyzz.js"`,
      )
      expect(await Fs.readFile(external, 'utf8')).toMatchInlineSnapshot(`
        "console.log("theirs")
        "
      `)
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('processes browser targets and minification with original source maps and recovery', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-css-host-'))
    const outDir = Path.join(root, 'output')
    const options = { minify: true, targets: { safari: 8 << 16 } }

    const host = await Host.create({
      css: options,
      outDir,
      packageId: 'example',
      root,
    })

    const input = `import { style } from 'zyzz';
export const card = style({ display: 'flex', color: '#ff0000' });`
    const path = Path.join(root, 'card.ts')

    try {
      // The lifecycle captures processing options before callers can mutate them.
      options.targets.safari = 99 << 16
      options.minify = false
      await Fs.writeFile(path, input)
      await host.build()

      const css = await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8')

      expect(css).toMatchInlineSnapshot(
        `".z_KeUUb-0{display:-webkit-flex;display:flex}.z_KeUUb-1{color:red}"`,
      )

      const map = new Trace.TraceMap(
        await Fs.readFile(Path.join(outDir, 'card.ts.css.map'), 'utf8'),
      )

      expect(Trace.originalPositionFor(map, { column: 0, line: 1 }))
        .toMatchInlineSnapshot(`
          {
            "column": 20,
            "line": 2,
            "name": "style-4lx6a318y1wl5-50",
            "source": "example/card.ts",
          }
        `)
      expect(map.sourcesContent).toMatchInlineSnapshot(`
        [
          ".z_KeUUb-0{display:flex;}
        .z_KeUUb-1{color:#ff0000;}",
          "import { style } from 'zyzz';
        export const card = style({ display: 'flex', color: '#ff0000' });",
        ]
      `)
      expect((await host.build()).changed).toMatchInlineSnapshot('[]')

      await Fs.writeFile(path, input.replace("'#ff0000'", "'rgb('"))
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[SyntaxError: Unexpected token CloseCurlyBracket]`,
      )

      expect(
        await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8'),
      ).toMatchInlineSnapshot(
        `".z_KeUUb-0{display:-webkit-flex;display:flex}.z_KeUUb-1{color:red}"`,
      )

      await Fs.writeFile(path, input.replace('#ff0000', '#0000ff'))
      await host.build()

      expect(
        await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8'),
      ).toMatchInlineSnapshot(
        `".z_KeUUb-0{display:-webkit-flex;display:flex}.z_KeUUb-1{color:#00f}"`,
      )
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('can preserve intermediate CSS for another processor', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-raw-css-'))
    const outDir = Path.join(root, 'output')

    const host = await Host.create({
      css: false,
      outDir,
      packageId: 'example',
      root,
    })

    try {
      await Fs.writeFile(Path.join(root, 'button.ts'), source)
      await host.build()

      expect(
        await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8'),
      ).toMatchInlineSnapshot(`".z_CVE4-Z0{padding:8px;}"`)
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('shared theme edits rebuild consumers and recover after missing dependencies', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-graph-host-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })
    const notifications = Watch.create({ path: 'card.ts.css' })
    const themePath = Path.join(root, 'theme.ts')
    const themeSource =
      "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#06c'}});"

    try {
      await Fs.writeFile(themePath, themeSource)
      await Fs.writeFile(
        Path.join(root, 'card.ts'),
        `import {Config} from 'zyzz';import { theme } from './theme.js';const config=Config.create({vars:theme}); export const props = config.style({color:'brand'})();`,
      )
      await host.build()

      expect(
        await Fs.readFile(Path.join(outDir, 'theme.ts.zyzz.json'), 'utf8'),
      ).toMatchInlineSnapshot(
        `"{"exports":{"theme":{"variableSet":true,"directVariables":true,"binding":"src-theme-bdnuEpXWEgW-theme","kind":"theme","theme":"src-theme-bdnuEpXWEgW-theme"}},"themes":{"src-theme-bdnuEpXWEgW-theme":{"cssName":"theme","variableSet":true,"identity":"src-theme-bdnuEpXWEgW-theme","tokens":{"color":{"brand":"#06c"}}},"src-card-12soMKeUUb--config-theme":{"cssName":"theme","cssOutput":"atomic","variableSet":true,"identity":"src-card-12soMKeUUb--config","tokens":{"color":{"brand":"#06c"}}}},"version":31}"`,
      )

      const before = await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8')

      expect(before).toMatchInlineSnapshot(`
        ".z-theme-theme {
          --z-color-brand: #06c;
        }

        .z_KeUUb-0 {
          color: var(--z-color-brand, #06c);
        }
        "
      `)
      expect((await host.build()).changed).toMatchInlineSnapshot(`[]`)

      host.watch({ onResult: notifications.onResult })
      await notifications.next(() =>
        Fs.writeFile(themePath, themeSource.replace("'#06c'", "'#175'")),
      )

      expect(
        await Fs.readFile(Path.join(outDir, 'theme.ts.zyzz.json'), 'utf8'),
      ).toMatchInlineSnapshot(
        `"{"exports":{"theme":{"variableSet":true,"directVariables":true,"binding":"src-theme-bdnuEpXWEgW-theme","kind":"theme","theme":"src-theme-bdnuEpXWEgW-theme"}},"themes":{"src-theme-bdnuEpXWEgW-theme":{"cssName":"theme","variableSet":true,"identity":"src-theme-bdnuEpXWEgW-theme","tokens":{"color":{"brand":"#175"}}},"src-card-12soMKeUUb--config-theme":{"cssName":"theme","cssOutput":"atomic","variableSet":true,"identity":"src-card-12soMKeUUb--config","tokens":{"color":{"brand":"#175"}}}},"version":31}"`,
      )

      const after = await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8')

      expect(after).toMatchInlineSnapshot(`
        ".z-theme-theme {
          --z-color-brand: #175;
        }

        .z_KeUUb-0 {
          color: var(--z-color-brand, #175);
        }
        "
      `)

      await expect(
        notifications.next(() => Fs.rm(themePath)),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: example/card.ts:28: Missing source module: ./theme.js]`,
      )

      expect(await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ".z-theme-theme {
            --z-color-brand: #175;
          }

          .z_KeUUb-0 {
            color: var(--z-color-brand, #175);
          }
          "
        `)

      await notifications.next(() => Fs.writeFile(themePath, themeSource))

      expect(await Fs.readFile(Path.join(outDir, 'card.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ".z-theme-theme {
            --z-color-brand: #06c;
          }

          .z_KeUUb-0 {
            color: var(--z-color-brand, #06c);
          }
          "
        `)
    } finally {
      await host.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('local theme edits rebuild CSS while keeping scope identities stable', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-theme-host-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })
    const source =
      "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); export const scope = themeConfig.vars().className; const { style } = themeConfig; export const props = style({ color: theme.color.brand })();"

    try {
      await Fs.writeFile(Path.join(root, 'theme.ts'), source)
      await host.build()

      const before = await Fs.readFile(
        Path.join(outDir, 'theme.ts.css'),
        'utf8',
      )

      expect(before).toMatchInlineSnapshot(`
        ".z-theme-theme {
          --z-color-brand: #000;
        }

        .z_scheme-dark {
          color-scheme: dark;
        }

        .z_scheme-light {
          color-scheme: light;
        }

        .z_scheme-light-dark {
          color-scheme: light dark;
        }

        .z_pXWEgW0 {
          color: var(--z-color-brand, #000);
        }
        "
      `)

      await Fs.writeFile(
        Path.join(root, 'theme.ts'),
        source.replace("'#000'", "'#fff'"),
      )

      const rebuilt = await host.build()

      expect(rebuilt.changed).toMatchInlineSnapshot(`
        [
          "theme.ts",
          "theme.ts.css",
          "theme.ts.css.map",
          "theme.ts.map",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)

      const after = await Fs.readFile(Path.join(outDir, 'theme.ts.css'), 'utf8')

      expect(after).toMatchInlineSnapshot(`
        ".z-theme-theme {
          --z-color-brand: #fff;
        }

        .z_scheme-dark {
          color-scheme: dark;
        }

        .z_scheme-light {
          color-scheme: light;
        }

        .z_scheme-light-dark {
          color-scheme: light dark;
        }

        .z_pXWEgW0 {
          color: var(--z-color-brand, #fff);
        }
        "
      `)
      expect(
        before.split('{')[0] === after.split('{')[0],
      ).toMatchInlineSnapshot('true')
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('file builds preserve working artifacts, cache unchanged inputs, and clean owned outputs', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })

    try {
      await Fs.writeFile(Path.join(root, 'button.ts'), source)
      await Fs.writeFile(
        Path.join(root, 'button.test.ts'),
        'invalid ignored test source',
      )
      await Fs.writeFile(Path.join(outDir, 'keep.txt'), 'unrelated')
      await Fs.writeFile(
        Path.join(outDir, 'ignored.ts'),
        'invalid output source',
      )

      const result = await host.build()

      expect(result.files).toMatchInlineSnapshot(`
        [
          "button.ts",
          "button.ts.css",
          "button.ts.css.map",
          "button.ts.map",
          "button.ts.zyzz.json",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)

      const expected = Transform.compile({
        moduleId: 'example/button.ts',
        source,
      })

      expect(await Fs.readFile(Path.join(outDir, 'button.ts'), 'utf8'))
        .toMatchInlineSnapshot(`
          "
          import { Props as __zyzzProps } from 'zyzz/runtime';
           export const button = /*#__PURE__*/__zyzzProps.create({className:"z_CVE4-Z0 z-style-CVE4-Z-button"});"
        `)
      expect(await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ".z_CVE4-Z0 {
            padding: 8px;
          }
          "
        `)
      expect(
        (await Fs.readFile(Path.join(outDir, 'button.ts.map'), 'utf8')) ===
          JSON.stringify(expected.map),
      ).toMatchInlineSnapshot('true')
      expect((await host.build()).changed).toMatchInlineSnapshot('[]')

      const before = await Fs.readFile(
        Path.join(outDir, 'button.ts.css'),
        'utf8',
      )

      await Fs.writeFile(
        Path.join(root, 'button.ts'),
        `import { style } from 'zyzz'; style({ padding: unknown });`,
      )
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: example/button.ts:47: Expected a literal string or number; expressions are not evaluated.]`,
      )

      expect(await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8'))
        .toMatchInlineSnapshot(`
          ".z_CVE4-Z0 {
            padding: 8px;
          }
          "
        `)
      expect(
        (await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8')) ===
          before,
      ).toMatchInlineSnapshot('true')

      await Fs.writeFile(
        Path.join(root, 'button.ts'),
        source.replace('8px', '4px'),
      )
      await host.build()
      await Fs.rename(
        Path.join(root, 'button.ts'),
        Path.join(root, 'renamed.ts'),
      )

      expect((await host.build()).changed).toMatchInlineSnapshot(`
        [
          "button.ts",
          "button.ts.css",
          "button.ts.css.map",
          "button.ts.map",
          "button.ts.zyzz.json",
          "renamed.ts",
          "renamed.ts.css",
          "renamed.ts.css.map",
          "renamed.ts.map",
          "renamed.ts.zyzz.json",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)
      expect((await Fs.readdir(outDir)).sort()).toMatchInlineSnapshot(`
        [
          ".zyzz-lock",
          ".zyzz.json",
          "ignored.ts",
          "keep.txt",
          "renamed.ts",
          "renamed.ts.css",
          "renamed.ts.css.map",
          "renamed.ts.map",
          "renamed.ts.zyzz.json",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)

      await Fs.rm(Path.join(root, 'renamed.ts'))

      expect((await host.build()).files).toMatchInlineSnapshot('[]')
      expect(
        await Fs.readFile(Path.join(outDir, 'keep.txt'), 'utf8'),
      ).toMatchInlineSnapshot('"unrelated"')
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('ownership survives reopening and refuses modified files and symlink outputs', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-host-ownership-'),
    )
    const outDir = Path.join(root, 'output')
    const options = { outDir, packageId: 'example', root }
    let host = await Host.create(options)

    try {
      const conflict = await Host.create(options).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error)
          return error.code

        throw error
      })

      expect(conflict).toMatchInlineSnapshot('"EEXIST"')

      await Fs.writeFile(Path.join(root, 'button.ts'), source)
      await host.build()
      await host.close()
      host = await Host.create(options)

      expect((await host.build()).changed).toMatchInlineSnapshot('[]')

      await Fs.writeFile(
        Path.join(outDir, 'button.ts.css'),
        'edited by consumer',
      )
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Refusing to replace an unowned or modified output: button.ts.css]`,
      )

      expect(
        await Fs.readFile(Path.join(outDir, 'button.ts.css'), 'utf8'),
      ).toMatchInlineSnapshot('"edited by consumer"')

      await Fs.rm(Path.join(outDir, 'button.ts.css'))
      await Fs.symlink(
        Path.join(outDir, 'button.ts'),
        Path.join(outDir, 'button.ts.css'),
      )
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Output paths must be regular files and directories.]`,
      )
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('real recursive watching handles nested additions, failures, recovery, and disposal', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-watch-'))
    const outDir = Path.join(root, 'output')
    const host = await Host.create({ outDir, packageId: 'example', root })
    const events: Host.Event[] = []
    let notify: (() => void) | undefined

    async function next(
      predicate: (event: Host.Event) => boolean,
    ): Promise<Host.Event> {
      const deadline = Date.now() + 5000

      while (true) {
        const event = events.shift()
        if (event && predicate(event)) return event
        if (event) continue

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Watch event timed out.')),
            Math.max(0, deadline - Date.now()),
          )

          notify = () => {
            clearTimeout(timeout)
            resolve()
          }
        })
      }
    }

    try {
      host.watch({
        onResult(event) {
          events.push(event)
          notify?.()
          notify = undefined
        },
      })

      expect(await next((event) => 'result' in event)).toMatchInlineSnapshot(`
      {
        "result": {
          "changed": [],
          "files": [],
        },
      }
    `)

      await Fs.mkdir(Path.join(root, 'nested'))
      await Fs.writeFile(Path.join(root, 'nested/button.ts'), source)

      const added = await next(
        (event) =>
          'result' in event && event.result.files.includes('nested/button.ts'),
      )
      if (!('result' in added)) throw new Error('Expected build result.')

      expect(added.result.files).toMatchInlineSnapshot(`
        [
          "nested/button.ts",
          "nested/button.ts.css",
          "nested/button.ts.css.map",
          "nested/button.ts.map",
          "nested/button.ts.zyzz.json",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)

      await Fs.writeFile(
        Path.join(root, 'nested/button.ts'),
        `import { style } from 'zyzz'; style({ padding: unknown });`,
      )

      const failed = await next((event) => 'error' in event)
      if (
        !('error' in failed) ||
        !(failed.error instanceof Source.ExtractError)
      )
        throw new Error('Expected source error.')

      expect(failed.error.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "code": "unsupported_syntax",
            "end": 54,
            "message": "Expected a literal string or number; expressions are not evaluated.",
            "source": "example/nested/button.ts",
            "start": 47,
          },
        ]
      `)

      await Fs.writeFile(
        Path.join(root, 'nested/button.ts'),
        source.replace('8px', '2px'),
      )
      await next(
        (event) =>
          'result' in event &&
          event.result.changed.includes('nested/button.ts.css'),
      )
      await expect
        .poll(async () =>
          (
            await Fs.readFile(Path.join(outDir, 'nested/button.ts.css'), 'utf8')
          ).includes('padding: 2px;'),
        )
        .toBe(true)

      expect(
        await Fs.readFile(Path.join(outDir, 'nested/button.ts.css'), 'utf8'),
      ).toMatchInlineSnapshot(`
        ".z_TnNkY-0 {
          padding: 2px;
        }
        "
      `)

      await Fs.rename(Path.join(root, 'nested'), Path.join(root, 'renamed'))
      await next(
        (event) =>
          'result' in event && event.result.files.includes('renamed/button.ts'),
      )
      await Watch.write({
        path: Path.join(root, 'renamed/button.ts'),
        source: source.replace('8px', '3px'),
      })
      await next(
        (event) =>
          'result' in event &&
          event.result.changed.includes('renamed/button.ts.css'),
      )
      expect(
        (
          await Fs.readFile(Path.join(outDir, 'renamed/button.ts.css'), 'utf8')
        ).includes('padding: 3px;'),
      ).toMatchInlineSnapshot('true')

      await Fs.rm(Path.join(root, 'renamed/button.ts'))
      await next(
        (event) => 'result' in event && event.result.files.length === 0,
      )
      await host.close()
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Host is closed.]`,
      )

      const reopened = await Host.create({ outDir, packageId: 'example', root })

      await reopened.close()
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 15000)

  test('prefixed sources and case-only renames survive rebuilds and reopening', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-case-'))
    const outDir = Path.join(root, 'output')
    const options = { outDir, packageId: 'example', root }
    let host = await Host.create(options)

    try {
      await Fs.mkdir(Path.join(root, '.zyzz-components'))
      await Fs.writeFile(Path.join(root, '.zyzz.ts'), source)
      await Fs.writeFile(Path.join(root, '.zyzz-components/Button.ts'), source)
      await Fs.writeFile(Path.join(root, 'Plain.ts'), 'export const value = 1')
      await host.build()

      expect((await host.build()).changed).toMatchInlineSnapshot('[]')

      await Fs.rename(
        Path.join(root, '.zyzz-components/Button.ts'),
        Path.join(root, '.zyzz-components/button.ts'),
      )
      await Fs.rename(Path.join(root, 'Plain.ts'), Path.join(root, 'plain.ts'))

      expect((await host.build()).files).toMatchInlineSnapshot(`
        [
          ".zyzz-components/button.ts",
          ".zyzz-components/button.ts.css",
          ".zyzz-components/button.ts.css.map",
          ".zyzz-components/button.ts.map",
          ".zyzz-components/button.ts.zyzz.json",
          ".zyzz.ts",
          ".zyzz.ts.css",
          ".zyzz.ts.css.map",
          ".zyzz.ts.map",
          ".zyzz.ts.zyzz.json",
          "plain.ts",
          "plain.ts.css",
          "plain.ts.css.map",
          "plain.ts.map",
          "plain.ts.zyzz.json",
          "zyzz.css",
          "zyzz.css.map",
        ]
      `)
      expect(
        await Fs.readFile(Path.join(outDir, 'plain.ts'), 'utf8'),
      ).toMatchInlineSnapshot('"export const value = 1"')
      expect(
        await Fs.readFile(
          Path.join(outDir, '.zyzz-components/button.ts.css'),
          'utf8',
        ),
      ).toMatchInlineSnapshot(`
        ".z_2Ygvve0 {
          padding: 8px;
        }
        "
      `)

      if (process.platform === 'darwin') {
        // This CI fixture must exercise a real case-insensitive volume.
        expect(
          await Fs.readFile(Path.join(outDir, 'PLAIN.ts'), 'utf8'),
        ).toMatchInlineSnapshot('"export const value = 1"')
      }

      await host.close()
      host = await Host.create(options)

      expect((await host.build()).changed).toMatchInlineSnapshot('[]')

      await Fs.writeFile(
        Path.join(outDir, '.zyzz-components/button.ts.css'),
        'consumer edit',
      )
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Refusing to replace an unowned or modified output: .zyzz-components/button.ts.css]`,
      )
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })

  test('benchmark notifications reject real watch errors and time out without an edit', async () => {
    const root = await Fs.mkdtemp(
      Path.join(project, '.fixture-host-notifications-'),
    )

    let host = await Host.create({
      outDir: Path.join(root, 'output'),
      packageId: 'example',
      root,
    })

    const notifications = Watch.create({
      path: 'cards.ts.css',
      timeoutMs: 1000,
    })

    try {
      await Fs.writeFile(Path.join(root, 'cards.ts'), source)

      const initial = notifications.next()

      host.watch({ onResult: notifications.onResult })
      await initial

      await expect(
        notifications.next(() =>
          Watch.write({
            path: Path.join(root, 'cards.ts'),
            source: `import { style } from 'zyzz'; style({ padding: unknown });`,
          }),
        ),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: example/cards.ts:47: Expected a literal string or number; expressions are not evaluated.]`,
      )
      // Drain failed builds before observing a fresh watch lifecycle.
      await host.close()
      await Watch.write({
        path: Path.join(root, 'cards.ts'),
        source: source.replace('8px', '4px'),
      })
      host = await Host.create({
        outDir: Path.join(root, 'output'),
        packageId: 'example',
        root,
      })

      const recovery = notifications.next()

      host.watch({ onResult: notifications.onResult })
      await recovery
      await expect(
        notifications.next(),
      ).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Watch build timed out.]`,
      )
    } finally {
      await host.close()
      await Fs.rm(root, { force: true, recursive: true })
    }
  })
  test('closes during initial directory discovery without leaving watcher handles', async () => {
    const root = await Fs.mkdtemp(Path.join(project, '.fixture-host-close-'))
    const resources = () =>
      process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap')
        .length
    const before = resources()
    try {
      await Fs.mkdir(Path.join(root, 'nested'))
      await Fs.writeFile(Path.join(root, 'nested/card.ts'), source)
      const host = await Host.create({
        root,
        outDir: Path.join(root, 'output'),
        packageId: 'close-test',
      })
      host.watch({ onResult() {} })
      await host.close()
      await expect.poll(resources).toBe(before)
      await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Host is closed.]`,
      )
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('contributions', () => {
  describe('create', () => {
    test('publishes unimported globals and removes the shared artifact on deletion', async () => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-contributions-'))

      try {
        await Fs.writeFile(Path.join(root, 'app.ts'), 'export const value=1')
        await Fs.writeFile(
          Path.join(root, 'global.ts'),
          'import {global} from "zyzz/web"; global({body:{margin:0}})',
        )

        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'app',
          css: false,
        })

        await host.build()

        expect(
          await Fs.readFile(Path.join(root, 'output/zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`"body{margin:0;}"`)

        await Fs.unlink(Path.join(root, 'global.ts'))
        await host.build()

        expect(
          (await Fs.readdir(Path.join(root, 'output'))).includes(
            'zyzz.shared.css',
          ),
        ).toMatchInlineSnapshot(`false`)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('descriptorAcceptance', () => {
  const updates = {
    counter: [
      ["system:'additive'", "system:'symbolic'"],
      ['10 "X", 1 "I", 0 "O"', '20 "Y", 2 "J", 0 "Z"'],
      ["fallback:'decimal'", "fallback:'lower-roman'"],
      ['negative:\'"(" ")"\'', 'negative:\'"-"\''],
      ['2 "0"', '3 "x"'],
      ['prefix:\'"["\'', 'prefix:\'"("\''],
      ["range:'0 99'", "range:'1 100'"],
      ["speakAs:'numbers'", "speakAs:'words'"],
      ['suffix:\'"]"\'', 'suffix:\'")"\''],
      ['symbols:\'"I"\'', 'symbols:\'"J"\''],
    ],
    font: [
      ['Body', 'Changed'],
      ["fontDisplay:'swap'", "fontDisplay:'optional'"],
      ['"kern" 1', '"liga" 0'],
      ['"wght" 450', '"wght" 500'],
      ['75% 125%', '80% 120%'],
      ['oblique 0deg 20deg', 'italic'],
      ['100 900', '200 800'],
      ['U+0-7F,U+4??', 'U+20-FF'],
      ['90%', '85%'],
      ['20%', '25%'],
      ['5%', '6%'],
      ['110%', '120%'],
      ['/body.woff2', '/changed.woff2'],
    ],
    palette: [
      ['Body', 'Changed'],
      ["basePalette:'dark'", "basePalette:'light'"],
      ['0 red, 1 color(display-p3 0 1 0), 1 #00f', '0 blue, 1 green'],
    ],
    position: [
      ["'bottom'", "'top'"],
      ['--target', '--changed'],
      ['100px', '120px'],
      ['20px', '30px'],
      ['4px', '8px'],
      ['1px', '2px'],
      ['auto', '0px'],
      ['center', 'end'],
    ],
  } as const

  describe('create', () => {
    for (const family of Object.keys(
      NamedDescriptors.definitions,
    ) as (keyof typeof NamedDescriptors.definitions)[]) {
      test(`replaces ${family} descriptors and retains source-owned names during watch`, async () => {
        const root = await Fs.mkdtemp(
          Path.resolve(import.meta.dirname, '../../.fixture-descriptor-'),
        )
        try {
          const path = Path.join(root, 'names.ts')
          const source = NamedDescriptors.source(family)
          const updatedSource = updates[family].reduce(
            (source, [before, after]) => source.replaceAll(before, after),
            source,
          )
          await Fs.writeFile(path, source)
          await using host = await Host.create({
            root,
            outDir: Path.join(root, 'output'),
            packageId: 'descriptors',
          })
          await host.build()
          const initial = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )

          const notifications = Watch.create({ path: 'zyzz.shared.css' })
          host.watch({ onResult: notifications.onResult })
          await notifications.next(() =>
            Watch.write({ path, source: updatedSource }),
          )
          const updated = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          const freshRoot = await Fs.mkdtemp(
            Path.resolve(
              import.meta.dirname,
              '../../.fixture-descriptor-fresh-',
            ),
          )
          try {
            await Fs.writeFile(Path.join(freshRoot, 'names.ts'), updatedSource)
            await using fresh = await Host.create({
              root: freshRoot,
              outDir: Path.join(freshRoot, 'output'),
              packageId: 'descriptors',
            })
            await fresh.build()
            expect(
              updated ===
                (await Fs.readFile(
                  Path.join(freshRoot, 'output/zyzz.shared.css'),
                  'utf8',
                )),
            ).toMatchInlineSnapshot('true')
          } finally {
            await Fs.rm(freshRoot, { recursive: true, force: true })
          }
          expect(updated === initial).toMatchInlineSnapshot('false')
          expect(updated.includes('@media print')).toMatchInlineSnapshot('true')
          expect(updated.includes('body')).toMatchInlineSnapshot('true')
        } finally {
          await Fs.rm(root, { recursive: true, force: true })
        }
      })
    }
  })
})

describe('documentRules', () => {
  describe('create', () => {
    test('publishes feature display descriptors alongside relocated assets', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-document-'),
      )
      try {
        await Fs.writeFile(
          Path.join(root, 'document.ts'),
          `import {fontFeatureValues,global} from 'zyzz/web';fontFeatureValues({families:'Body',fontDisplay:'swap',features:{'@styleset':{editorial:[1,2]}}});global({body:{backgroundImage:'url(./pixel.svg)'}})`,
        )
        await Fs.writeFile(
          Path.join(root, 'pixel.svg'),
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
        )
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'document',
        })
        await host.build()
        expect(
          await Fs.readFile(Path.join(root, 'output/zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`
        "@font-feature-values Body {
          font-display:swap;@styleset{editorial:1 2;}
        }

        body {
          background-image: url("pixel.svg");
        }
        "
      `)
        expect(
          await Fs.readFile(Path.join(root, 'output/pixel.svg'), 'utf8'),
        ).toMatchInlineSnapshot('"<svg xmlns="http://www.w3.org/2000/svg"/>"')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('finalAcceptance', () => {
  const sources = {
    function: Functions.source,
    page: Pages.source,
    property: Registrations.source,
  }
  describe('create', () => {
    for (const [family, source] of Object.entries(sources)) {
      test(`replaces ${family} definitions during source watch`, async () => {
        const root = await Fs.mkdtemp(
          Path.resolve(import.meta.dirname, '../../.fixture-statements-'),
        )
        try {
          const path = Path.join(root, 'statements.ts')
          await Fs.writeFile(path, source(false))
          await using host = await Host.create({
            root,
            outDir: Path.join(root, 'output'),
            packageId: 'statements',
          })
          await host.build()
          const initial = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          const notifications = Watch.create({ path: 'zyzz.shared.css' })
          host.watch({ onResult: notifications.onResult })
          await notifications.next(() =>
            Watch.write({ path, source: source(true) }),
          )
          const updated = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          expect(updated === initial).toMatchInlineSnapshot('false')
          if (family === 'page') {
            expect(
              initial.includes('page-margin-safety: none'),
            ).toMatchInlineSnapshot('true')
            expect(
              updated.includes('page-margin-safety: add'),
            ).toMatchInlineSnapshot('true')
            expect(
              updated.includes('page-margin-safety: none'),
            ).toMatchInlineSnapshot('false')
          }
          expect(updated.includes('before')).toMatchInlineSnapshot('false')
          expect(
            updated.includes(
              family === 'function' ? '<length>: 2px' : 'width > 1px',
            ),
          ).toMatchInlineSnapshot('false')
          expect(
            updated.includes(family === 'page' ? 'Before' : 'inherits: false'),
          ).toMatchInlineSnapshot('false')
        } finally {
          await Fs.rm(root, { recursive: true, force: true })
        }
      })
    }
  })
})

describe('fontFeatures', () => {
  describe('create', () => {
    test('replaces every feature alias block and font display policy during watch', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-features-'),
      )
      try {
        const path = Path.join(root, 'fonts.ts')
        await Fs.writeFile(path, FontFeatures.source(1))
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'features',
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        for (const [index, block] of FontFeatures.blocks.entries())
          expect(
            initial.includes(`${block}{alias${index}:1`),
          ).toMatchInlineSnapshot('true')
        expect(initial.includes('font-display:swap')).toMatchInlineSnapshot(
          'true',
        )

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({ path, source: FontFeatures.source(4, 'optional') }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        for (const [index, block] of FontFeatures.blocks.entries()) {
          expect(
            updated.includes(`${block}{alias${index}:4`),
          ).toMatchInlineSnapshot('true')
          expect(
            updated.includes(`${block}{alias${index}:1`),
          ).toMatchInlineSnapshot('false')
        }
        expect(updated.includes('font-display:optional')).toMatchInlineSnapshot(
          'true',
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('groupingAcceptance', () => {
  describe('create', () => {
    for (const [family, headers] of Object.entries(GroupingRules.rules)) {
      test(`replaces ${family} groups through source watch`, async () => {
        const root = await Fs.mkdtemp(
          Path.resolve(import.meta.dirname, '../../.fixture-group-'),
        )
        try {
          const path = Path.join(root, 'groups.ts')
          const source = (color: string) =>
            `import {global} from 'zyzz/web';${headers.map((header) => `global({${JSON.stringify(header)}:{body:{color:${JSON.stringify(color)}}}});`).join('\n')}`
          await Fs.writeFile(path, source('red'))
          await using host = await Host.create({
            root,
            outDir: Path.join(root, 'output'),
            packageId: 'groups',
          })
          await host.build()
          const initial = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          expect(initial.includes('color: red;')).toMatchInlineSnapshot('true')
          expect(initial.includes('color: #00f;')).toMatchInlineSnapshot(
            'false',
          )

          const notifications = Watch.create({ path: 'zyzz.shared.css' })
          host.watch({ onResult: notifications.onResult })
          await notifications.next(() =>
            Watch.write({ path, source: source('blue') }),
          )
          const updated = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          expect(updated.includes('color: #00f;')).toMatchInlineSnapshot('true')
          expect(updated.includes('color: red;')).toMatchInlineSnapshot('false')
        } finally {
          await Fs.rm(root, { recursive: true, force: true })
        }
      })
    }
  })
})

describe('keyframeAcceptance', () => {
  describe('create', () => {
    test('replaces named timeline keyframes while retaining animation references during watch', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-frames-'),
      )
      try {
        const path = Path.join(root, 'frames.ts')
        const source = (stop: string) =>
          `import {keyframes,global} from 'zyzz/web';const fade=keyframes({${JSON.stringify(stop)}:{opacity:0},to:{opacity:1}});global({body:{animationName:fade}});`
        await Fs.writeFile(path, source('entry -20%'))
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'frames',
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(initial.includes('entry -20%')).toMatchInlineSnapshot('true')
        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({ path, source: source('exit 120%') }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(updated.includes('entry -20%')).toMatchInlineSnapshot('false')
        expect(updated.includes('exit 120%')).toMatchInlineSnapshot('true')
        expect(updated.includes('animation-name: z-')).toMatchInlineSnapshot(
          'true',
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('namespace', () => {
  describe('create', () => {
    test('rebuilds Unicode namespace bindings and preserves unrelated module scopes', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-namespace-'),
      )
      const source = (uri: string) =>
        `import {namespace as ns,global} from 'zyzz/web';ns({prefix:'图',uri:${JSON.stringify(uri)}});global({'图|item':{color:'red'}});`
      try {
        await Fs.writeFile(Path.join(root, 'shapes.ts'), source('urn:first'))
        await Fs.writeFile(
          Path.join(root, 'other.ts'),
          `import {namespace,global} from 'zyzz/web';namespace({prefix:'图',uri:'urn:other'});global({'图|item':{color:'blue'}});`,
        )
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'namespaces',
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(initial.includes('"urn:first"')).toMatchInlineSnapshot('true')
        expect(initial.includes('"urn:other"')).toMatchInlineSnapshot('true')

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({
            path: Path.join(root, 'shapes.ts'),
            source: source('urn:second'),
          }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(updated.includes('"urn:first"')).toMatchInlineSnapshot('false')
        expect(updated.includes('"urn:second"')).toMatchInlineSnapshot('true')
        expect(updated.includes('"urn:other"')).toMatchInlineSnapshot('true')
        expect(updated.includes('color: red')).toMatchInlineSnapshot('true')
        expect(updated.includes('color: #00f')).toMatchInlineSnapshot('true')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('packageContracts', () => {
  describe('create', () => {
    test('derives missing contracts from plain package JavaScript', async () => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-derived-'),
      )
      try {
        const library = await PlainPackage.install(root)
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/card.ts'),
          `import {style} from '@acme/tokens';export const card=style({padding:'16'})();`,
        )
        await Fs.writeFile(
          Path.join(root, 'src/global.ts'),
          `import {global} from 'zyzz/web';import {vars} from '@acme/tokens';global({':root':{'--gap':vars.spacing['16']}});`,
        )
        await Fs.writeFile(
          Path.join(root, 'src/view.ts'),
          `import {cx} from 'zyzz';import {style} from '@acme/tokens';export function view(active:boolean){return cx(styles.one(),active&&styles.two())}namespace styles{export const one=style({padding:'16'});export const two=style({color:'ink'})}`,
        )
        await using host = await Host.create({
          css: false,
          outDir: Path.join(root, 'dist'),
          packageId: 'app',
          root: Path.join(root, 'src'),
        })

        await host.build()

        const card = await Fs.readFile(Path.join(root, 'dist/card.ts'), 'utf8')
        expect(card).toMatchInlineSnapshot(
          `"import {style} from '@acme/tokens';export const card=({className:"z_acme-rnRBDm0"});"`,
        )
        expect(await Fs.readFile(Path.join(root, 'dist/card.ts.css'), 'utf8'))
          .toMatchInlineSnapshot(`
            ".z-theme-acme_2f_variables-variables{--z-acme_2f_variables-color-ink:#123456;--z-acme_2f_variables-spacing-16:16px;}
            .z-theme-acme-theme{--z-acme-spacing-16:16px;--z-acme-color-ink:#123456;}
            .z_acme-rnRBDm0{padding:var(--z-acme-spacing-16,16px);}"
          `)
        expect(await Fs.readFile(Path.join(root, 'dist/view.ts'), 'utf8'))
          .toMatchInlineSnapshot(`
            "
            const __zyzzComposition103=/*#__PURE__*/[{className:"z_u3iffL2"},{className:"z_u3iffL2 z_u3iffL3"}].map(Object.freeze);

            import { Props as __zyzzProps } from 'zyzz/runtime';
            import {style} from '@acme/tokens';export function view(active:boolean){return __zyzzComposition103[((styles.one as unknown)||styles.one(),0)|((active)?((styles.two as unknown)||styles.two(),1):0)]}namespace styles{export const one=/*#__PURE__*/__zyzzProps.create({className:"z_acme-u3iffL0"});export const two=/*#__PURE__*/__zyzzProps.create({className:"z_acme-u3iffL1"})}"
          `)
        expect(await Fs.readFile(Path.join(root, 'dist/view.ts.css'), 'utf8'))
          .toMatchInlineSnapshot(`
            ".z-theme-acme_2f_variables-variables{--z-acme_2f_variables-color-ink:#123456;--z-acme_2f_variables-spacing-16:16px;}
            .z-theme-acme-theme{--z-acme-spacing-16:16px;--z-acme-color-ink:#123456;}
            .z_acme-u3iffL0{padding:var(--z-acme-spacing-16,16px);}
            .z_acme-u3iffL1{color:var(--z-acme-color-ink,#123456);}
            .z_u3iffL2{padding:var(--z-acme-spacing-16,16px);}
            .z_u3iffL3{color:var(--z-acme-color-ink,#123456);}"
          `)
        expect(
          await Fs.readFile(Path.join(root, 'dist/zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`":root{--gap:var(--z-acme-spacing-16,16px);}"`)

        await Fs.writeFile(
          Path.join(library, 'dist/vars.js'),
          PlainPackage.files['dist/vars.js'].replace('16px', '18px'),
        )
        await host.build()

        expect(
          await Fs.readFile(Path.join(root, 'dist/zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`":root{--gap:var(--z-acme-spacing-16,18px);}"`)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })

    test('resolves config-bound package references in application variables', async () => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-derived-bound-'),
      )
      try {
        await PlainPackage.install(root)
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/config.ts'),
          `import {Config,Vars} from 'zyzz';import {vars as acme} from '@acme/tokens';const tokens=Vars.define({spacing:{gutter:acme.spacing['16']}},{id:'app/vars'});export const {style}=Config.create({id:'app',vars:tokens});export const card=style({padding:'gutter'})();`,
        )
        await using host = await Host.create({
          css: false,
          outDir: Path.join(root, 'dist'),
          packageId: 'app',
          root: Path.join(root, 'src'),
        })

        await host.build()

        expect(await Fs.readFile(Path.join(root, 'dist/config.ts.css'), 'utf8'))
          .toMatchInlineSnapshot(`
            ".z-theme-acme_2f_variables-variables{--z-acme_2f_variables-color-ink:#123456;--z-acme_2f_variables-spacing-16:16px;}
            .z-theme-acme-theme{--z-acme-spacing-16:16px;--z-acme-color-ink:#123456;}
            .z-theme-app-theme{--z-app-spacing-gutter:var(--z-acme-spacing-16,16px);}
            .z_app-rYs9RE0{padding:var(--z-app-spacing-gutter,var(--z-acme-spacing-16,16px));}"
          `)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })

    test('prefers shipped contracts and watches their removal', async () => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-derived-sidecar-'),
      )
      try {
        const library = await PlainPackage.install(root)
        const sidecar = Path.join(library, 'dist/global.js.zyzz.json')
        await Fs.writeFile(
          sidecar,
          Graph.compile({
            modules: {
              'global.ts': `import {global} from 'zyzz/web';global({body:{color:'red'}});`,
            },
          }).contracts['global.ts']!,
        )
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/app.ts'),
          `import '@acme/tokens/global';`,
        )
        const outDir = Path.join(root, 'dist')
        await using host = await Host.create({
          css: false,
          outDir,
          packageId: 'app',
          root: Path.join(root, 'src'),
        })

        await host.build()

        expect(
          await Fs.readFile(Path.join(outDir, 'zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`"body{color:red;}"`)

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() => Fs.rm(sidecar))

        expect(
          await Fs.readFile(Path.join(outDir, 'zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`"body{color:blue;}"`)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })

    test('keeps packages outside Zyzz authoring as runtime imports', async () => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-derived-runtime-'),
      )
      try {
        await PlainPackage.install(root)
        // Without a declared zyzz dependency, the package is never parsed for authoring.
        const plain = Path.join(root, 'node_modules/plain')
        await Fs.mkdir(plain, { recursive: true })
        await Fs.writeFile(
          Path.join(plain, 'package.json'),
          JSON.stringify({
            name: 'plain',
            type: 'module',
            exports: './index.js',
          }),
        )
        await Fs.writeFile(
          Path.join(plain, 'index.js'),
          `import {global} from 'zyzz/web';global({body:{color:'red'}});export const version=1;`,
        )
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/app.ts'),
          `import {add} from '@acme/tokens/utils';import {version} from 'plain';import {Button} from '@acme/tokens';export const value=[add(1,version),Button];`,
        )
        await using host = await Host.create({
          css: false,
          outDir: Path.join(root, 'dist'),
          packageId: 'app',
          root: Path.join(root, 'src'),
        })

        expect((await host.build()).files).toMatchInlineSnapshot(`
          [
            "app.ts",
            "app.ts.css",
            "app.ts.css.map",
            "app.ts.map",
            "zyzz.css",
            "zyzz.css.map",
            "zyzz.js",
          ]
        `)
        expect(
          await Fs.readFile(Path.join(root, 'dist/app.ts'), 'utf8'),
        ).toMatchInlineSnapshot(
          `"import {add} from '@acme/tokens/utils';import {version} from 'plain';import {Button} from '@acme/tokens';export const value=[add(1,version),Button];"`,
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })

    test('names the package file when derivation fails', async () => {
      const root = await Fs.mkdtemp(
        Path.join(project, '.fixture-host-derived-error-'),
      )
      try {
        await PlainPackage.install(root, {
          'dist/index.js': `import {style} from './config.js';export const card=style({color:globalThis.color});`,
        })
        await Fs.mkdir(Path.join(root, 'src'))
        await Fs.writeFile(
          Path.join(root, 'src/app.ts'),
          `import {card} from '@acme/tokens';export const props=card();`,
        )
        await using host = await Host.create({
          css: false,
          outDir: Path.join(root, 'dist'),
          packageId: 'app',
          root: Path.join(root, 'src'),
        })

        const error = await host.build().catch((error: Error) => error)

        expect(
          error instanceof Error
            ? error.message.replaceAll(root, '<root>')
            : error,
        ).toMatchInlineSnapshot(
          `"app/app.ts:0: Unable to derive the Zyzz contract of <root>/node_modules/@acme/tokens/dist/index.js: @acme/tokens/dist/index.js:65: Expected a literal string or number; expressions are not evaluated."`,
        )
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('page', () => {
  describe('create', () => {
    test('replaces all page-margin contents without retaining stale declarations', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-page-'),
      )
      try {
        const path = Path.join(root, 'pages.ts')
        await Fs.writeFile(path, Margins.source('before'))
        await using host = await Host.create({
          outDir: Path.join(root, 'output'),
          packageId: 'pages',
          root,
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        for (const [index, box] of Margins.boxes.entries()) {
          expect(initial.includes(box)).toMatchInlineSnapshot('true')
          expect(initial.includes(`"before-${index}"`)).toMatchInlineSnapshot(
            'true',
          )
        }

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({ path, source: Margins.source('after') }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(updated.includes('before-')).toMatchInlineSnapshot('false')
        for (const [index, box] of Margins.boxes.entries()) {
          expect(updated.includes(box)).toMatchInlineSnapshot('true')
          expect(updated.includes(`"after-${index}"`)).toMatchInlineSnapshot(
            'true',
          )
        }
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('profile', () => {
  describe('create', () => {
    test('replaces profile components intent and source assets through watch', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-profile-'),
      )
      try {
        const path = Path.join(root, 'profile.ts')
        await Fs.writeFile(
          Path.join(root, 'before.icc'),
          Buffer.from(ColorProfile.url.split(',')[1]!, 'base64'),
        )
        await Fs.writeFile(
          Path.join(root, 'after.icc'),
          Buffer.from(ColorProfile.url.split(',')[1]!, 'base64'),
        )
        await Fs.writeFile(
          path,
          `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({ '@media print': {src:'url(./before.icc)',components:'r,g,b',renderingIntent:'perceptual'} });`,
        )
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'profiles',
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(initial.includes('before.icc')).toMatchInlineSnapshot('true')
        expect(initial.includes('components:r,g,b')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          initial.includes('rendering-intent:perceptual'),
        ).toMatchInlineSnapshot('true')
        expect(
          (await Fs.readFile(Path.join(root, 'output/before.icc'))).equals(
            Buffer.from(ColorProfile.url.split(',')[1]!, 'base64'),
          ),
        ).toMatchInlineSnapshot('true')

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({
            path,
            source: `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({ '@media print': {src:'url(./after.icc)',components:'red,green,blue',renderingIntent:'saturation'} });`,
          }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(updated.includes('after.icc')).toMatchInlineSnapshot('true')
        expect(
          updated.includes('components:red,green,blue'),
        ).toMatchInlineSnapshot('true')
        expect(
          updated.includes('rendering-intent:saturation'),
        ).toMatchInlineSnapshot('true')
        expect(updated.includes('before.icc')).toMatchInlineSnapshot('false')
        expect(
          (await Fs.readFile(Path.join(root, 'output/after.icc'))).equals(
            Buffer.from(ColorProfile.url.split(',')[1]!, 'base64'),
          ),
        ).toMatchInlineSnapshot('true')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('statementAcceptance', () => {
  const sources = {
    customMedia: (after: boolean) =>
      `import {customMedia,global} from 'zyzz/web';const query=customMedia('(width > ${after ? 2 : 1}px)');global({[query]:{body:{color:'red'}}});`,
    document: (after: boolean) =>
      `import {global} from 'zyzz/web';global({'@document domain("${after ? 'after' : 'before'}.example")':{body:{color:'red'}}});`,
    import: (after: boolean) =>
      Statements.imports(
        `https://example.com/${after ? 'after' : 'before'}.css`,
      ),
  }
  describe('create', () => {
    for (const [family, source] of Object.entries(sources)) {
      test(`replaces ${family} definitions during source watch`, async () => {
        const root = await Fs.mkdtemp(
          Path.resolve(import.meta.dirname, '../../.fixture-statements-'),
        )
        try {
          const path = Path.join(root, 'statements.ts')
          await Fs.writeFile(path, source(false))
          await using host = await Host.create({
            root,
            outDir: Path.join(root, 'output'),
            packageId: 'statements',
          })
          await host.build()
          const initial = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          const notifications = Watch.create({ path: 'zyzz.shared.css' })
          host.watch({ onResult: notifications.onResult })
          await notifications.next(() =>
            Watch.write({ path, source: source(true) }),
          )
          const updated = await Fs.readFile(
            Path.join(root, 'output/zyzz.shared.css'),
            'utf8',
          )
          expect(updated === initial).toMatchInlineSnapshot('false')
          expect(updated.includes('before')).toMatchInlineSnapshot('false')
          expect(updated.includes('width > 1px')).toMatchInlineSnapshot('false')
          expect(updated.includes('body')).toMatchInlineSnapshot('true')
        } finally {
          await Fs.rm(root, { recursive: true, force: true })
        }
      })
    }
  })
})

describe('statements', () => {
  describe('create', () => {
    test('publishes UTF-8 stylesheet bytes without a BOM or encoding declaration', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-encoding-'),
      )
      try {
        await Fs.writeFile(
          Path.join(root, 'app.ts'),
          `import {global} from 'zyzz/web';global({'body::before':{content:'"héllo ● 日本語"'}});`,
        )
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'encoding',
        })
        await host.build()
        const bytes = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
        )

        expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          .toMatchInlineSnapshot(`
        "body:before {
          content: "héllo ● 日本語";
        }
        "
      `)
        expect(
          bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        ).toMatchInlineSnapshot('false')

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({
            path: Path.join(root, 'app.ts'),
            source: `import {global} from 'zyzz/web';global({'body::before':{content:'"été ◇ 한국어"'}});`,
          }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
        )

        expect(new TextDecoder('utf-8', { fatal: true }).decode(updated))
          .toMatchInlineSnapshot(`
        "body:before {
          content: "été ◇ 한국어";
        }
        "
      `)
        expect(
          updated.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        ).toMatchInlineSnapshot('false')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
    test('copies nested stylesheet imports and their relative assets', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-imports-'),
      )
      try {
        await Fs.mkdir(Path.join(root, 'styles'))
        await Fs.writeFile(
          Path.join(root, 'app.ts'),
          `import {importCss} from 'zyzz/web';importCss({url:'./styles/base.css',layer:'base'});`,
        )
        await Fs.writeFile(
          Path.join(root, 'styles/base.css'),
          '@import "nested.css";body{background-image:url(../pixel.svg)}',
        )
        await Fs.writeFile(
          Path.join(root, 'styles/nested.css'),
          'body{color:red}',
        )
        await Fs.writeFile(Path.join(root, 'pixel.svg'), '<svg/>')
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'imports',
        })
        await host.build()
        expect(
          await Fs.readFile(Path.join(root, 'output/zyzz.shared.css'), 'utf8'),
        ).toMatchInlineSnapshot(`
        "@import "styles/base.css" layer(base);
        "
      `)
        expect(
          await Fs.readFile(Path.join(root, 'output/styles/base.css'), 'utf8'),
        ).toMatchInlineSnapshot(
          '"@import "nested.css";body{background-image:url(../pixel.svg)}"',
        )
        expect(
          await Fs.readFile(
            Path.join(root, 'output/styles/nested.css'),
            'utf8',
          ),
        ).toMatchInlineSnapshot('"body{color:red}"')
        expect(
          await Fs.readFile(Path.join(root, 'output/pixel.svg'), 'utf8'),
        ).toMatchInlineSnapshot('"<svg/>"')
        const notifications = Watch.create({ path: 'styles/nested.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({
            path: Path.join(root, 'styles/nested.css'),
            source: 'body{color:blue}',
          }),
        )
        expect(
          await Fs.readFile(
            Path.join(root, 'output/styles/nested.css'),
            'utf8',
          ),
        ).toMatchInlineSnapshot('"body{color:blue}"')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('viewTransition', () => {
  describe('create', () => {
    test('replaces navigation and types through source watch updates', async () => {
      const root = await Fs.mkdtemp(
        Path.resolve(import.meta.dirname, '../../.fixture-transition-'),
      )
      try {
        const path = Path.join(root, 'transition.ts')
        await Fs.writeFile(
          path,
          `import {viewTransition} from 'zyzz/web';viewTransition({ '@layer transitions': {navigation:'auto',types:'slide forwards'} });`,
        )
        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'output'),
          packageId: 'transitions',
        })
        await host.build()
        const initial = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(initial.includes('navigation: auto')).toMatchInlineSnapshot(
          'true',
        )
        expect(initial.includes('types: slide forwards')).toMatchInlineSnapshot(
          'true',
        )

        const notifications = Watch.create({ path: 'zyzz.shared.css' })
        host.watch({ onResult: notifications.onResult })
        await notifications.next(() =>
          Watch.write({
            path,
            source: `import {viewTransition} from 'zyzz/web';viewTransition({ '@layer transitions': {navigation:'none',types:'backwards'} });`,
          }),
        )
        const updated = await Fs.readFile(
          Path.join(root, 'output/zyzz.shared.css'),
          'utf8',
        )
        expect(updated.includes('navigation: none')).toMatchInlineSnapshot(
          'true',
        )
        expect(updated.includes('types: backwards')).toMatchInlineSnapshot(
          'true',
        )
        expect(updated.includes('forwards')).toMatchInlineSnapshot('false')
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})
