/** Checks eager stylesheet delivery across disconnected source and lazy modules. @module */
import * as Esbuild from 'esbuild'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Os from 'node:os'
import * as Vite from 'vite'
import * as Util from 'node:util'
import { describe, expect, test } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'
import { zyzz } from 'zyzz/vite'

describe('zyzz', () => {
  test('links local theme imports with Vite cache queries in development and production', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-timestamp-vite-'))
    let server: Vite.ViteDevServer | undefined

    try {
      await Fs.writeFile(
        Path.join(root, 'theme.ts'),
        "import {Vars} from 'zyzz';export const theme=Vars.define({color:{brand:'red'}});",
      )
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import {Config} from 'zyzz';import {theme} from './theme.ts?t=123&v=abc';export const {style,vars}=Config.create({vars:theme});export namespace styles {
  export const card = style({color:vars.color.brand})
}`,
      )
      server = await Vite.createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        server: { port: 0 },
      })
      await server.listen()

      const transformed = await server.transformRequest('/app.ts')

      expect(transformed!.code.includes('theme.tokens')).toMatchInlineSnapshot(
        `false`,
      )

      const shared = await server.transformRequest('\0zyzz:shared.css')

      expect(shared!.code.includes('red')).toMatchInlineSnapshot(`true`)

      const development = await server.ssrLoadModule('/app.ts')

      expect(development.vars().className).toMatchInlineSnapshot(
        `"z-theme-theme"`,
      )

      const result = await Vite.build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        build: {
          write: false,
          minify: false,
          lib: { entry: Path.join(root, 'app.ts'), formats: ['es'] },
        },
      })

      const output = Array.isArray(result) ? result[0] : result
      if (!output || !('output' in output))
        throw new Error('Missing build output')

      const chunk = output.output.find(
        (file) => file.type === 'chunk' && file.isEntry,
      )
      if (!chunk || chunk.type !== 'chunk')
        throw new Error('Missing entry chunk')

      const production = await import(
        `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
      )

      expect(production.vars().className).toMatchInlineSnapshot(
        `"z-theme-theme"`,
      )
      expect(production.styles.card()).toMatchInlineSnapshot(`
        {
          "className": "z_emHxp30",
        }
      `)
    } finally {
      await server?.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('retains asset ownership through a repacked nested dependency', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-repacked-vite-'))
    const external = await Fs.realpath(
      await Fs.mkdtemp(Path.join(Os.tmpdir(), 'zyzz-sidecar-')),
    )

    try {
      const sidecar = Graph.compile({
        modules: {
          'index.ts': `import {style} from 'zyzz';export const unrelated=style({});`,
        },
      })

      await Fs.writeFile(
        Path.join(external, 'index.js'),
        Esbuild.transformSync(sidecar.modules['index.ts']!.code, {
          loader: 'ts',
          format: 'esm',
        }).code,
      )
      await Fs.writeFile(
        Path.join(external, 'index.js.zyzz.json'),
        sidecar.contracts['index.ts']!,
      )
      await Fs.mkdir(Path.join(external, 'node_modules'))
      await Fs.symlink(
        Path.resolve('.'),
        Path.join(external, 'node_modules/zyzz'),
        'dir',
      )

      const dependency = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./pixel.svg)'}});`,
        },
      })

      const raw = Graph.compile({
        modules: {
          'raw.ts': `import {global} from 'zyzz/web';global({body:{outlineColor:'pink'}});`,
        },
      })

      const wrapper = Graph.compile({
        contracts: { 'dep/index.js': dependency.contracts['index.ts']! },
        imports: { 'wrapper/index.ts': { dep: 'dep/index.js' } },
        modules: {
          'wrapper/index.ts': `import 'dep';export const loaded=true;`,
        },
      })

      const wrapperRoot = Path.join(root, 'node_modules/wrapper'),
        dependencyRoot = Path.join(wrapperRoot, 'node_modules/dep')

      for (const [directory, name, module, contract] of [
        [
          Path.join(root, 'node_modules/raw-effects'),
          'raw-effects',
          raw.modules['raw.ts']!.code,
          raw.contracts['raw.ts']!,
        ],
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
      ]) {
        await Fs.mkdir(directory!, { recursive: true })
        await Fs.writeFile(
          Path.join(directory!, 'package.json'),
          JSON.stringify({
            name,
            type: 'module',
            exports: './index.js',
            sideEffects: false,
          }),
        )
        await Fs.writeFile(Path.join(directory!, 'index.js'), module!)
        await Fs.writeFile(
          Path.join(directory!, 'index.js.zyzz.json'),
          contract!,
        )
      }

      await Fs.writeFile(
        Path.join(dependencyRoot, 'pixel.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      )
      await Fs.writeFile(
        Path.join(root, 'index.html'),
        '<script type="module" src="/app.ts"></script>',
      )
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import ${JSON.stringify(Path.join(external, 'index.js'))};import('raw-effects?raw');import 'wrapper';import {style} from 'zyzz';document.body.className=style({color:'red'})().className;`,
      )

      const result = await Vite.build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          assetsInlineLimit: 0,
        },
      })

      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (result) => ('output' in result ? result.output : []),
      )

      expect(
        outputs.filter(
          (output) =>
            output.type === 'asset' && output.fileName.endsWith('.svg'),
        ).length,
      ).toMatchInlineSnapshot('1')

      const css = outputs
        .filter(
          (output) =>
            output.type === 'asset' && output.fileName.endsWith('.css'),
        )
        .map((output) => (output.type === 'asset' ? String(output.source) : ''))
        .join('\n')

      expect(css.includes('background-image')).toMatchInlineSnapshot('true')
      expect(css.includes('outline')).toMatchInlineSnapshot('false')

      await Fs.writeFile(Path.join(external, 'index.js.zyzz.json'), '{')

      try {
        await Vite.build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [zyzz()],
          build: { write: false },
        })
        throw new Error('Expected invalid sidecar')
      } catch (error) {
        expect(
          Util.stripVTControlCharacters((error as Error).message)
            .replaceAll(root, '<root>')
            .replaceAll(external, '<external>')
            .split(/\n\s+at /)[0],
        ).toMatchInlineSnapshot(`
          "Build failed with 1 error:

          [plugin zyzz] <root>/app.ts
          Source.ExtractError: <external>/index.js:0: Invalid library contract: Expected property name or '}' in JSON at position 1 (line 1 column 2)"
        `)
      }
    } finally {
      await Fs.rm(external, { recursive: true, force: true })
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
  test('emits unimported global styles once in a production build', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-contributions-vite-'))

    try {
      for (const [name, source] of Object.entries({
        'index.html': '<script type="module" src="/app.ts"></script>',
        'app.ts':
          'import "./base.css"; document.body.textContent="App"; globalThis.load=()=>import("./lazy.ts")',
        'base.css': '@layer app { body { color: blue } }',
        'utility.ts':
          'import { Css } from "zyzz/web"; import "./cycle.ts"; export const compile = Css.compile',
        'cycle.ts': 'import "./utility.ts"; // zyzz/web',
        'lazy.ts':
          'import {style} from "zyzz"; export const lazy=style({color:"blue"})()',
        'global.ts':
          'import {global,layers} from "zyzz/web"; layers(["reset","app"]); global({body:{margin:0}})',
      }))
        await Fs.writeFile(Path.join(root, name), source)

      for (const directory of [
        'tests',
        '__tests__',
        'fixtures',
        '__fixtures__',
      ]) {
        await Fs.mkdir(Path.join(root, directory))
        await Fs.writeFile(
          Path.join(root, directory, 'example.ts'),
          'import {global} from "zyzz/web"; global({body:{color:"red"}})',
        )
      }

      const result = await Vite.build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        build: { write: false, minify: false, cssMinify: false },
      })

      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (result) => ('output' in result ? result.output : []),
      )

      const css = outputs
        .filter(
          (output) =>
            output.type === 'asset' && output.fileName.endsWith('.css'),
        )
        .map((output) => (output.type === 'asset' ? String(output.source) : ''))
        .join('\n')

      expect(css).toMatchInlineSnapshot(`
        "@layer reset,app;
        body{margin:0;}@layer app { body { color: blue } }
        .z_oAVB9I0{color:blue;}"
      `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
  test('aggregates lazy packed contributions and resolves package-owned assets', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-packed-vite-'))

    try {
      const packageRoot = Path.join(root, 'node_modules/effects')

      await Fs.mkdir(packageRoot, { recursive: true })

      const library = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./pixel%23dark.svg)'}})`,
        },
      })

      await Fs.writeFile(
        Path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'effects',
          type: 'module',
          exports: './index.js',
          sideEffects: false,
        }),
      )
      await Fs.writeFile(
        Path.join(packageRoot, 'index.js'),
        library.modules['index.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(packageRoot, 'index.js.zyzz.json'),
        library.contracts['index.ts']!,
      )
      await Fs.writeFile(
        Path.join(packageRoot, 'pixel#dark.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
      )
      await Fs.writeFile(
        Path.join(root, 'index.html'),
        '<script type="module" src="/app.ts"></script>',
      )
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        `import {style} from 'zyzz';document.body.className=style({color:'red'})().className;globalThis.load=()=>import('./lazy.ts')`,
      )
      await Fs.writeFile(
        Path.join(root, 'lazy.ts'),
        `import 'effects';export const loaded=true`,
      )
      await Fs.writeFile(
        Path.join(root, 'types.ts'),
        `import 'effects'; import {style} from 'zyzz'; // @ts-expect-error
style({color:123})`,
      )

      const directRoot = Path.join(root, 'node_modules/direct-effects')

      await Fs.mkdir(directRoot, { recursive: true })

      const directLibrary = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{outlineWidth:'23px'}});`,
        },
      })

      await Fs.writeFile(
        Path.join(directRoot, 'package.json'),
        JSON.stringify({
          name: 'direct-effects',
          type: 'module',
          exports: './index.js',
          sideEffects: false,
        }),
      )
      await Fs.writeFile(
        Path.join(directRoot, 'index.js'),
        directLibrary.modules['index.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(directRoot, 'index.js.zyzz.json'),
        directLibrary.contracts['index.ts']!,
      )
      await Fs.appendFile(
        Path.join(root, 'app.ts'),
        `;globalThis.direct=()=>import('direct-effects')`,
      )

      const typeRoot = Path.join(root, 'node_modules/type-effects')

      await Fs.mkdir(typeRoot, { recursive: true })

      const typeLibrary = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{outlineWidth:'37px'}});`,
        },
      })

      await Fs.writeFile(
        Path.join(typeRoot, 'package.json'),
        JSON.stringify({
          name: 'type-effects',
          type: 'module',
          exports: './index.js',
          sideEffects: false,
        }),
      )
      await Fs.writeFile(
        Path.join(typeRoot, 'index.js'),
        typeLibrary.modules['index.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(typeRoot, 'index.js.zyzz.json'),
        typeLibrary.contracts['index.ts']!,
      )
      await Fs.writeFile(
        Path.join(root, 'only-types.ts'),
        `import {type Foo} from 'type-effects';export {type Foo as Bar} from 'type-effects';`,
      )

      const server = await Vite.createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        server: { port: 0 },
      })

      try {
        await server.listen()
        await server.transformRequest('/app.ts')

        const shared = await server.transformRequest('\0zyzz:shared.css')

        expect(shared!.code.includes('pixel%23dark.svg')).toMatchInlineSnapshot(
          'true',
        )

        const address = server.httpServer!.address()
        if (!address || typeof address === 'string')
          throw new Error('Missing server address')

        const path = shared!.code.match(/\/@zyzz\/asset\/[^"\\\s)]+/)?.[0]
        if (!path) throw new Error('Missing asset URL')

        const response = await fetch(`http://localhost:${address.port}${path}`)

        expect(response.status).toMatchInlineSnapshot('200')
        expect(await response.text()).toMatchInlineSnapshot(
          `"<svg xmlns="http://www.w3.org/2000/svg"/>"`,
        )
      } finally {
        await server.close()
      }

      const result = await Vite.build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [zyzz()],
        build: {
          write: false,
          minify: false,
          cssMinify: false,
          assetsInlineLimit: 0,
        },
      })

      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (value) => ('output' in value ? value.output : []),
      )

      const css = outputs
        .filter(
          (value) => value.type === 'asset' && value.fileName.endsWith('.css'),
        )
        .map((value) => (value.type === 'asset' ? String(value.source) : ''))
        .join('\n')

      expect(css.includes('23px')).toMatchInlineSnapshot('true')
      expect(css.includes('37px')).toMatchInlineSnapshot('false')
      expect(css.includes('background-image')).toMatchInlineSnapshot('true')
      expect(
        outputs.some((value) => value.fileName.endsWith('.svg')),
      ).toMatchInlineSnapshot('true')
      expect(css.includes('zyzz-asset:')).toMatchInlineSnapshot('false')
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
  test('rejects packed assets outside the declaring package', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-owned-assets-'))

    try {
      const packageRoot = Path.join(root, 'node_modules/effects')

      await Fs.mkdir(packageRoot, { recursive: true })

      const library = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./private.txt)'}})`,
        },
      })

      const metadata = JSON.parse(library.contracts['index.ts']!)

      metadata.stylesheets[0].source = '../../index.ts'
      await Fs.writeFile(
        Path.join(packageRoot, 'package.json'),
        JSON.stringify({
          name: 'effects',
          type: 'module',
          exports: './index.js',
          sideEffects: true,
        }),
      )
      await Fs.writeFile(
        Path.join(packageRoot, 'index.js'),
        library.modules['index.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(packageRoot, 'index.js.zyzz.json'),
        JSON.stringify(metadata),
      )
      await Fs.writeFile(Path.join(root, 'private.txt'), 'fixture data')
      await Fs.writeFile(
        Path.join(root, 'index.html'),
        '<script type="module" src="/app.ts"></script>',
      )
      await Fs.writeFile(Path.join(root, 'app.ts'), `import 'effects'`)
      await expect(
        Vite.build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [zyzz()],
          build: { write: false },
        }),
      ).rejects.toThrow(/escapes its owning package/)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
  test('reloads shared styles after deleting the first transformed entry', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-shared-delete-'))

    const server = await Vite.createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [zyzz()],
      server: { watch: { usePolling: true, interval: 20 } },
    })

    try {
      await Fs.writeFile(
        Path.join(root, 'first.ts'),
        'import { global } from "zyzz/web"; global({body:{color:"red"}})',
      )
      await Fs.writeFile(
        Path.join(root, 'second.ts'),
        'import { global } from "zyzz/web"; global({body:{color:"blue"}})',
      )
      await server.transformRequest('/first.ts')
      await server.transformRequest('/second.ts')

      const removed = new Promise<void>((resolve) =>
        server.watcher.once('unlink', () => resolve()),
      )

      await Fs.unlink(Path.join(root, 'first.ts'))
      await removed
      await expect
        .poll(async () => {
          const output = await server.transformRequest('\0zyzz:shared.css')

          return output?.code
        })
        .toContain('blue')
    } finally {
      await server.close()
      await Fs.rm(root, { recursive: true, force: true })
    }
  })
})
