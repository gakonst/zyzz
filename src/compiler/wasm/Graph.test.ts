/**
 * Compiles packed-library consumers in the WebAssembly compiler, in Node and in a Chromium bundle
 * that resolves no Node built-ins, against the native graph's output.
 * @module
 */
import * as Esbuild from 'esbuild'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import * as Compiler from 'zyzz/compiler'
import * as Wasm from 'zyzz/compiler/wasm'

const root = Path.resolve(import.meta.dirname, '../../..')
const module = Path.join(root, 'binding/compiler.wasm')

/** The browser bundle's global, which compiles with a module the page compiled. */
type Fixture = {
  readonly compile: (
    module: WebAssembly.Module,
    inputs: Wasm.Graph.compile.Options,
  ) => Wasm.Graph.compile.ReturnType
}

/** A consumer of a separately compiled library, linked through its contract. */
function consumer(source: string) {
  const library = Compiler.Graph.compile({
    modules: {
      'library/index.ts': `export * from './theme.js'`,
      'library/theme.ts': `import { Config, Vars } from 'zyzz'

export const theme = Vars.define({ color: { brand: '#06c' }, spacing: { md: '8px' } })

export const { style } = Config.create({ vars: theme })
`,
    },
  })

  return {
    contracts: { 'library/index.js': library.contracts['library/index.ts']! },
    imports: {
      'app/card.ts': { '@acme/theme': 'library/index.js', zyzz: null },
    },
    modules: { 'app/card.ts': source },
  }
}

describe('create', () => {
  test('compiles library consumers as the native graph does', async () => {
    const compiler = Wasm.Graph.create({ module: await Fs.readFile(module) })
    const inputs = consumer(`import { style } from '@acme/theme'

export const card = style({ color: 'brand', padding: 'md' })
`)

    const output = compiler.compile(inputs)

    expect(output.modules['app/card.ts']!.code).toMatchInlineSnapshot(`
      "
      import { Props as __zyzzProps } from 'zyzz/runtime';
      import { style } from '@acme/theme'

      export const card = /*#__PURE__*/__zyzzProps.create({className:"z_rnRBDm0 z_rnRBDm1 z-style-rnRBDm-card"})
      "
    `)
    expect(output.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z_rnRBDm0{color:var(--z-color-brand,#06c);}
      .z_rnRBDm1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(
      JSON.stringify(output) === JSON.stringify(Compiler.Graph.compile(inputs)),
    ).toMatchInlineSnapshot(`true`)
  })

  test('reports unknown tokens with the native diagnostic', async () => {
    const compiler = Wasm.Graph.create({ module: await Fs.readFile(module) })
    const inputs = consumer(`import { style } from '@acme/theme'

export const card = style({ padding: 'huge' })
`)

    const error = (() => {
      try {
        compiler.compile(inputs)
      } catch (error) {
        return error as Wasm.Graph.CompileError
      }
      throw new Error('Expected a compile error.')
    })()

    expect(error).toMatchInlineSnapshot(
      `[Graph.CompileError: app/card.ts:74: Expected a configured token or a CSS value with the " !custom" suffix.]`,
    )
    expect(error.failure).toMatchInlineSnapshot(`"Source.ExtractError"`)
    expect(error.diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "invalid_literal",
          "end": 80,
          "message": "Expected a configured token or a CSS value with the " !custom" suffix.",
          "source": "app/card.ts",
          "start": 74,
        },
      ]
    `)
    expect(() => Compiler.Graph.compile(inputs)).toThrow(error.message)
  })

  test('compiles in Chromium from a bundle without Node built-ins', async () => {
    const inputs = consumer(`import { style } from '@acme/theme'

export const card = style({ color: 'brand', padding: 'md' })
`)
    // Wrangler's resolution conditions, with the source-first package entrypoints.
    const bundle = await Esbuild.build({
      bundle: true,
      conditions: ['src', 'workerd', 'worker', 'browser'],
      format: 'iife',
      globalName: 'Fixture',
      metafile: true,
      platform: 'browser',
      stdin: {
        contents: `import { Graph } from 'zyzz/compiler/wasm'

export function compile(module, inputs) {
  return Graph.create({ module }).compile(inputs)
}
`,
        resolveDir: root,
      },
      write: false,
    })

    expect(
      Object.keys(bundle.metafile.inputs).filter((input) =>
        /Addon|Engine|lightningcss|node:/.test(input),
      ),
    ).toMatchInlineSnapshot(`[]`)

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.route('https://zyzz.test/**', (route) =>
        route.request().url().endsWith('.wasm')
          ? route.fulfill({
              contentType: 'application/wasm',
              path: module,
            })
          : route.fulfill({
              body: '<div id="card"></div>',
              contentType: 'text/html',
            }),
      )
      await page.goto('https://zyzz.test/')
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })

      // A compiled module, as Workers import it, instead of bytes compiled synchronously.
      const output = await page.evaluate(async (inputs) => {
        const module = await WebAssembly.compileStreaming(
          fetch('/compiler.wasm'),
        )
        const fixture = (globalThis as unknown as { Fixture: Fixture }).Fixture
        const compiled = fixture.compile(module, inputs).modules['app/card.ts']!
        const element = document.querySelector<HTMLElement>('#card')!
        const style = document.createElement('style')

        style.textContent = compiled.css
        document.head.append(style)
        element.className = Object.values(compiled.classes).join(' ')

        return {
          color: getComputedStyle(element).color,
          css: compiled.css,
          padding: getComputedStyle(element).padding,
        }
      }, inputs)

      expect(output.color).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)
      expect(output.padding).toMatchInlineSnapshot(`"8px"`)
      expect(
        output.css ===
          Compiler.Graph.compile(inputs).modules['app/card.ts']!.css,
      ).toMatchInlineSnapshot(`true`)
    } finally {
      await browser.close()
    }
  }, 120_000)
})
