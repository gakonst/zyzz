/** Exercises web and native Babel compilation through real presets, modules, and browser rendering. @module */
import * as Babel from '@babel/core'
import * as Trace from '@jridgewell/trace-mapping'
import * as Esbuild from 'esbuild'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { zyzz } from 'zyzz/babel'

const require = Module.createRequire(
  Path.resolve('examples/react-native/package.json'),
)
const expoRequire = Module.createRequire(require.resolve('expo/package.json'))
const preset = expoRequire.resolve('babel-preset-expo')

function compile(source: string, platform: 'android' | 'ios' = 'ios') {
  const caller = { name: 'metro', platform, isDev: false }

  return Babel.transformSync(source, {
    babelrc: false,
    caller,
    configFile: false,
    comments: true,
    filename: '/Fixture.ts',
    plugins: [[zyzz, { colorScheme: 'light', platform, units: { px: 1 } }]],
    presets: [preset],
    sourceMaps: true,
  })!
}

async function execute(code: string) {
  const result = await Esbuild.build({
    bundle: true,
    format: 'esm',
    platform: 'node',
    stdin: { contents: code, resolveDir: process.cwd() },
    write: false,
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`
  )
}

describe('zyzz', () => {
  test('maps authored typography to registered native families through Babel', async () => {
    const output = Babel.transformSync(
      `import {style} from 'zyzz';
       export const result=style({fontFamily:'Pilat, Arial, sans-serif',fontSize:'1rem',lineHeight:1.5})();`,
      {
        babelrc: false,
        configFile: false,
        filename: '/Fonts.ts',
        plugins: [
          [
            zyzz,
            {
              colorScheme: 'light',
              fonts: { 'Pilat, Arial, sans-serif': 'Pilat' },
              platform: 'ios',
              units: { rem: 16 },
            },
          ],
        ],
        presets: [preset],
      },
    )!
    const module = await execute(output.code!)

    expect(module.result).toMatchInlineSnapshot(`
      {
        "style": {
          "fontFamily": "Pilat",
          "fontSize": 16,
          "lineHeight": 24,
        },
      }
    `)
  })

  test('executes platform styles, variants, and changing payloads without authoring callbacks', async () => {
    const source = `import { style, variants } from 'zyzz'
      const box = style({ width: '10px', targets: { ios: { opacity: 0.5 }, android: { opacity: 0.8 } } })
      const card = variants({ base: { padding: '2px' }, variants: { big: { true: { padding: '8px' }, false: { padding: '4px' } } }, defaultVariants: { big: false } })
      const meter = style((value: { width: \`\${number}px\` }) => ({ width: value.width }))
      export const results = [box(), card(), card({ big: true }), meter({ width: '12px' }), meter({ width: '24px' })]`
    const ios = await execute(compile(source).code!)
    expect(ios.results).toMatchInlineSnapshot(`
      [
        {
          "style": {
            "opacity": 0.5,
            "width": 10,
          },
        },
        {
          "style": {
            "paddingBottom": 4,
            "paddingLeft": 4,
            "paddingRight": 4,
            "paddingTop": 4,
          },
        },
        {
          "style": {
            "paddingBottom": 8,
            "paddingLeft": 8,
            "paddingRight": 8,
            "paddingTop": 8,
          },
        },
        {
          "style": {
            "width": 12,
          },
        },
        {
          "style": {
            "width": 24,
          },
        },
      ]
    `)
    const android = await execute(compile(source, 'android').code!)
    expect(android.results[0]).toMatchInlineSnapshot(`
      {
        "style": {
          "opacity": 0.8,
          "width": 10,
        },
      }
    `)
  })

  test('keeps independent native values and identities when definitions share a structure', async () => {
    const output = compile(`import { style } from 'zyzz'
      const __zyzzNativeFactory0 = 17
      const first = style({width:'1px',opacity:0.2,transform:'translateX(3px)'})
      const second = style({width:'2px',opacity:0.4,transform:'translateX(6px)'})
      export const results = [first().style, second().style, __zyzzNativeFactory0,
        Object.isFrozen(first().style), first().style === second().style]`)
    const module = await execute(output.code!)

    expect(module.results).toEqual([
      { width: 1, opacity: 0.2, transform: [{ translateX: 3 }] },
      { width: 2, opacity: 0.4, transform: [{ translateX: 6 }] },
      17,
      true,
      false,
    ])
  })

  test('preserves escaped strings and exponent numbers in shared native factories', async () => {
    const output = compile(`import { style } from 'zyzz'
      const first = style({targets:{native:{fontFamily:${JSON.stringify('Font "null":\\ 12 true')},width:1e-7,height:1e21}}})
      const second = style({targets:{native:{fontFamily:'Other',width:2e-7,height:2e21}}})
      export const results = [first().style, second().style]`)
    const module = await execute(output.code!)

    expect(
      module.results[0].fontFamily === 'Font "null":\\ 12 true',
    ).toMatchInlineSnapshot('true')
    expect(module.results[0].width).toMatchInlineSnapshot('1e-7')
    expect(module.results[0].height).toMatchInlineSnapshot('1e+21')
    expect(module.results[1].fontFamily).toMatchInlineSnapshot('"Other"')
    expect(module.results[1].width).toMatchInlineSnapshot('2e-7')
    expect(module.results[1].height).toMatchInlineSnapshot('2e+21')
  })

  test('preserves source locations after generated imports and shortened expressions', () => {
    const output = compile(`import { style } from 'zyzz'
export const box = style({ width: '10px' })
export const marker = 'original-location'
`)
    const lines = output.code!.split('\n')
    const line = lines.findIndex((line) => line.includes('original-location'))
    const position = Trace.originalPositionFor(
      new Trace.TraceMap(JSON.stringify(output.map)),
      {
        line: line + 1,
        column: lines[line]!.indexOf('original-location'),
      },
    )
    expect(position.line).toMatchInlineSnapshot(`3`)
  })

  test.each([
    { name: 'LF', newline: '\n' },
    { name: 'CRLF', newline: '\r\n' },
    { name: 'CR', newline: '\r' },
    { name: 'line separator', newline: '\u2028' },
    { name: 'paragraph separator', newline: '\u2029' },
  ])(
    'retains comments, directives, and source locations with $name',
    async ({ newline }) => {
      const source = [
        '#!/usr/bin/env node',
        "'use client';",
        '/* 😀 */',
        "import { style } from 'zyzz'",
        'export const box = style({',
        "  width: '10px',",
        '})',
        "export const marker = 'original-location'",
      ].join(newline)
      const output = compile(source)
      const lines = output.code!.split('\n')
      const index = lines.findIndex((line) =>
        line.includes('original-location'),
      )
      const original = Trace.originalPositionFor(
        new Trace.TraceMap(JSON.stringify(output.map)),
        {
          line: index + 1,
          column: lines[index]!.indexOf('original-location'),
        },
      )

      expect(original.line).toMatchInlineSnapshot('8')
      expect(original.column).toMatchInlineSnapshot('22')
      expect(output.code!.includes('/* 😀 */')).toMatchInlineSnapshot('true')
      expect(output.code!.includes('use client')).toMatchInlineSnapshot('true')
      expect((await execute(output.code!)).box()).toMatchInlineSnapshot(`
      {
        "style": {
          "width": 10,
        },
      }
    `)
    },
  )

  test('supports an existing parser override and transforms supplied syntax trees', async () => {
    const source = `import {style} from 'zyzz'; const box=style({width:'7px'}); export const results=box();`
    const caller = { name: 'metro', platform: 'ios', isDev: false }
    const options: Babel.TransformOptions = {
      babelrc: false,
      configFile: false,
      filename: '/Fixture.ts',
      caller,
      plugins: [
        [zyzz, { platform: 'ios', colorScheme: 'light', units: { px: 1 } }],
      ],
      presets: [preset],
    }
    let parses = 0
    const custom = Babel.transformSync(source, {
      ...options,
      plugins: [
        ...options.plugins!,
        () => ({
          visitor: {},
          parserOverride(
            code: string,
            options: Babel.ParserOptions,
            parse: (
              code: string,
              options: Babel.ParserOptions,
            ) => Babel.types.File,
          ) {
            parses++
            return parse(code, options)
          },
        }),
      ],
    })!
    const ast = Babel.parseSync(source, { babelrc: false, configFile: false })!
    const supplied = Babel.transformFromAstSync(ast, source, options)!

    expect(parses).toBe(1)
    expect((await execute(custom.code!)).results).toEqual({
      style: { width: 7 },
    })
    expect((await execute(supplied.code!)).results).toEqual({
      style: { width: 7 },
    })
  })

  test('rejects graph-dependent authoring instead of emitting web helpers', () => {
    expect(() =>
      compile(
        "import { Config } from 'zyzz'; export const { style } = Config.create({})",
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: /Fixture.ts: Zyzz Babel currently supports literal style and variants definitions. Theme/config compilation requires the graph adapter.]`,
    )
    expect(() =>
      compile("export { style } from 'zyzz'"),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: /Fixture.ts: Zyzz Babel does not support re-exporting authoring helpers. Export compiled style definitions instead.]`,
    )
  })

  test('rejects web stylesheet authoring for both native platforms', () => {
    for (const platform of ['ios', 'android'] as const)
      for (const source of [
        "import { global } from 'zyzz/web'; global({ body: { color: 'red' } })",
        "import { fontFace } from 'zyzz/web'; fontFace({ fontFamily: 'Fixture', src: 'url(/font.woff2)' })",
      ])
        expect(() =>
          compile(source, platform),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Native.CompileError: /Fixture.ts: Native static modules do not support CSS contributions, variables, or web set controls.]`,
        )
  })

  test('passes ordinary modules through and rejects unsupported native declarations', async () => {
    const result = await execute(
      compile(
        "import type { Config } from 'zyzz'; export { type Style } from 'zyzz'; export const value: number = 42",
      ).code!,
    )
    expect(result.value).toMatchInlineSnapshot(`42`)
    expect(() =>
      compile(
        "import { style } from 'zyzz'; export const box = style({ selectors: { ':hover': { opacity: 0.5 } } })",
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: /Fixture.ts: babel/Fixture.ts:70: Selectors require an explicit & target.]`,
    )
  })
})

describe('web', () => {
  test('recognizes the Base UI entrypoint before extracting state styles', () => {
    const result = Babel.transformSync(
      "import {Select} from '@base-ui/react/select'; import {style} from 'zyzz/base-ui/react'; export const item=style(Select.Item,{states:{highlighted:{color:'red'}}},{id:'item'});",
      {
        babelrc: false,
        configFile: false,
        filename: Path.resolve('base-ui.js'),
        plugins: [[zyzz, { target: 'web' }]],
      },
    )!

    expect(result.metadata!.zyzz!.css).toMatchInlineSnapshot(
      `".z_pPg23S0{&[data-highlighted]{color:red;}}"`,
    )
    expect(result.code?.includes('zyzz/base-ui/react')).toMatchInlineSnapshot(
      'false',
    )
  })

  test('injects the optional reset without duplicating explicit imports', async () => {
    for (const source of [
      'export const value = 1',
      "import 'zyzz/reset.css'; export const value = 1",
    ]) {
      const result = Babel.transformSync(source, {
        babelrc: false,
        configFile: false,
        filename: Path.resolve('app.js'),
        plugins: [[zyzz, { target: 'web', reset: true }]],
      })!

      expect(
        result.code?.match(/zyzz\/reset.css/g)?.length,
      ).toMatchInlineSnapshot('1')
    }

    const transformed = Babel.transformSync(
      "import {style} from 'zyzz';export const props=style({padding: '12px'})()",
      {
        babelrc: false,
        configFile: false,
        filename: Path.resolve('app.js'),
        plugins: [[zyzz, { target: 'web', reset: true }]],
      },
    )!
    const bundle = await Esbuild.build({
      bundle: true,
      format: 'iife',
      globalName: 'App',
      outdir: 'dist',
      stdin: { contents: transformed.code!, resolveDir: process.cwd() },
      write: false,
    })
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const css = bundle.outputFiles.find((file) =>
        file.path.endsWith('.css'),
      )!.text
      const js = bundle.outputFiles.find((file) =>
        file.path.endsWith('.js'),
      )!.text
      await page.setContent(
        `<style>${css}\n${transformed.metadata!.zyzz!.css}</style><h1>Heading</h1><script>${js};document.querySelector('h1').className=App.props.className;</script>`,
      )
      expect(
        await page
          .locator('h1')
          .evaluate((node) => getComputedStyle(node).margin),
      ).toMatchInlineSnapshot('"0px"')
      expect(
        await page
          .locator('h1')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot('"12px"')
    } finally {
      await browser.close()
    }
  })

  for (const cssOutput of ['atomic', 'grouped'] as const)
    test(`renders extracted ${cssOutput} CSS with dynamic bindings and selectors`, async () => {
      const source = `import { style, variants } from 'zyzz'
        const box = style({ width: '40px', height: '12px', backgroundColor: 'red', selectors: { '&:hover': { opacity: 0.5 } } })
        const meter = style((value: { width: \`\${number}px\` }) => ({ width: value.width, height: '8px' }))
        const card = variants({ base: { opacity: 0.2 }, variants: { active: { true: { opacity: 0.7 } } } })
        export const results = [box(), meter({ width: '72px' }), card({ active: true })]`
      const output = Babel.transformSync(source, {
        babelrc: false,
        configFile: false,
        filename: '/project/left/Styles.ts',
        plugins: [[zyzz, { target: 'web', cssOutput }]],
        presets: [preset],
        root: '/project',
        sourceMaps: true,
      })!
      const metadata = output.metadata!.zyzz!
      expect(metadata.moduleId).toMatchInlineSnapshot(`"left/Styles.ts"`)
      expect(
        metadata.cssMap.sourcesContent?.includes(source),
      ).toMatchInlineSnapshot(`true`)
      const runtime = await execute(output.code!)
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          '<div id="box"></div><div id="meter"></div><div id="card"></div>',
        )
        await page.addStyleTag({ content: metadata.css })
        await page.evaluate((results) => {
          for (const [index, id] of ['box', 'meter', 'card'].entries()) {
            const element = document.getElementById(id)!
            element.className = results[index].className
            for (const [name, value] of Object.entries(results[index]))
              if (name !== 'className' && name !== 'style')
                element.setAttribute(name, String(value))
            for (const [name, value] of Object.entries(
              results[index].style ?? {},
            ))
              element.style.setProperty(name, String(value))
          }
        }, runtime.results)
        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"40px"`)
        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
        expect(
          await page
            .locator('#meter')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"72px"`)
        expect(
          await page
            .locator('#card')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.7"`)
        await page.locator('#box').hover()
        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.5"`)
      } finally {
        await browser.close()
      }

      const other = Babel.transformSync(source, {
        babelrc: false,
        configFile: false,
        filename: '/project/right/Styles.ts',
        plugins: [[zyzz, { target: 'web', cssOutput }]],
        presets: [preset],
        root: '/project',
      })!
      const otherRuntime = await execute(other.code!)
      expect(
        runtime.results[0].className === otherRuntime.results[0].className,
      ).toMatchInlineSnapshot(`false`)
    })
})
