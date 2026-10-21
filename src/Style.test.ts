/**
 * Exercises the public Style workflow through real collaborating modules.
 * @module
 */
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import * as Util from 'node:util'
import * as Vm from 'node:vm'
import * as Worker from 'node:worker_threads'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { Style } from 'zyzz'
import * as Theme from './internal/Theme.js'
import { Css } from 'zyzz/web'
import { components } from '../test/fixtures/components.js'
import * as Conformance from '../test/fixtures/Conformance.js'

function diagnose(input: unknown, options: Style.define.Options = {}) {
  try {
    // @ts-expect-error Exercise untyped consumers through the public boundary.
    return Style.define(input, options)
  } catch (error) {
    if (!(error instanceof Style.InvalidError)) throw error

    return { diagnostics: error.diagnostics, name: error.name }
  }
}

describe('define', () => {
  test.each([
    'red!',
    'red !',
    'red!important',
    'red !IMPORTANT',
    'red ! important',
    'red !important ',
    'red\t!important',
    'red !impor\\74 ant',
  ])('rejects noncanonical importance in %s', (color) => {
    expect(diagnose({ card: { color } })).toMatchInlineSnapshot(`
      {
        "diagnostics": [
          {
            "code": "invalid_value",
            "message": "Value markers require " !custom" followed by optional " !important", or " !important" alone.",
            "path": [
              "card",
              "color",
            ],
          },
        ],
        "name": "Style.InvalidError",
      }
    `)
  })

  test('retains web target paths and source locations in diagnostics', () => {
    const path = ['card', 'targets', 'web', '@media x']
    try {
      Style.define(
        { card: { targets: { web: { '@media x': undefined } } } } as never,
        { locations: [{ path, source: 'card.ts', start: 10, end: 20 }] },
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(Style.InvalidError)
      expect(
        (error as Style.InvalidError).diagnostics.map(({ path, location }) => ({
          path,
          location,
        })),
      ).toMatchInlineSnapshot(`
        [
          {
            "location": {
              "end": 20,
              "path": [
                "card",
                "targets",
                "web",
                "@media x",
              ],
              "source": "card.ts",
              "start": 10,
            },
            "path": [
              "card",
              "targets",
              "web",
              "@media x",
            ],
          },
        ]
      `)
    }
  })

  test('rejects forged binding objects without executing their getters', () => {
    const values = [
      Object.freeze({
        variable: true,
        type: 'length',
        name: '--x);background:red;--y',
      }),
      Object.freeze({
        variable: true,
        type: 'length',
        get name() {
          throw new Error('Getter executed')
        },
      }),
    ]

    for (const value of values)
      expect(() =>
        Style.define({ box: { width: value } } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Style.InvalidError: ["box","width"]: Invalid compiler binding reference.]`,
      )
  })

  test('theme shorthand and explicit references emit identical scoped styles', () => {
    const theme = Theme.define({
      backgroundColor: { brand: '#fff' },
      borderColor: { brand: '#000' },
      borderRadius: { md: '4px' },
      color: { blue: { 500: '#06c' }, brand: '#06c' },
      spacing: { 4: '1rem' },
      textColor: { brand: { dark: '#fff', light: '#111' } },
    })

    const named = Style.define(
      {
        card: {
          backgroundColor: 'brand',
          borderColor: 'brand',
          borderRadius: 'md',
          color: 'brand',
          padding: 4,
        },
        link: { color: 'blue.500' },
      },
      { vars: theme },
    )

    const explicit = Style.define({
      card: {
        backgroundColor: theme.tokens.backgroundColor.brand,
        borderColor: theme.tokens.borderColor.brand,
        borderRadius: theme.tokens.borderRadius.md,
        color: theme.tokens.textColor.brand,
        padding: theme.tokens.spacing[4],
      },
      link: { color: theme.tokens.color.blue[500] },
    })

    const alternate = Theme.extend(theme, { spacing: { 4: '2rem' } })
    const output = Css.compile({
      styles: named,
      vars: { alternate, base: theme },
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z0{--z0:#fff;--z1:#000;--z2:4px;--z3:light-dark(#111,#fff);--z4:2rem;--z5:#06c;}
      .z1{--z0:#fff;--z1:#000;--z2:4px;--z3:light-dark(#111,#fff);--z4:1rem;--z5:#06c;}
      .z_0{background-color:var(--z0,#fff);}
      .z_1{border-color:var(--z1,#000);}
      .z_2{border-radius:var(--z2,4px);}
      .z_3{color:var(--z3,light-dark(#111,#fff));}
      .z_4{padding:var(--z4,1rem);}
      .z_5{color:var(--z5,#06c);}"
    `)
    expect(
      output.css ===
        Css.compile({ styles: explicit, vars: { alternate, base: theme } }).css,
    ).toMatchInlineSnapshot('true')
  })

  test('repeated shorthand tokens remain isolated by property and theme', () => {
    const styles = {
      first: { color: 'brand', padding: 'brand', width: '1px !custom' },
      second: { color: 'brand', padding: 'brand', width: '2px !custom' },
    } as const

    for (const theme of [
      Theme.define({ color: { brand: 'red' }, spacing: { brand: '4px' } }),
      Theme.define({ color: { brand: 'blue' }, spacing: { brand: '8px' } }),
    ]) {
      const named = Style.define(styles, { vars: theme })

      const explicit = Style.define({
        first: {
          color: theme.tokens.color.brand,
          padding: theme.tokens.spacing.brand,
          width: '1px',
        },
        second: {
          color: theme.tokens.color.brand,
          padding: theme.tokens.spacing.brand,
          width: '2px',
        },
      })

      expect(
        Css.compile({ styles: named, vars: { base: theme } }).css ===
          Css.compile({ styles: explicit, vars: { base: theme } }).css,
      ).toMatchInlineSnapshot(`true`)
    }
  })

  test('token names precede colliding CSS literals and zero', () => {
    const theme = Theme.define({
      color: { white: '#000' },
      spacing: { 0: '8px', '1rem': '2rem' },
    })

    const styles = Style.define(
      {
        explicit: {
          color: theme.tokens.color.white,
          padding: theme.tokens.spacing[0],
        },
        literal: { color: 'white', padding: 0, width: '1rem' },
      },
      { vars: theme },
    )

    expect(Css.compile({ styles }).css).toMatchInlineSnapshot(`
      ".z_0{color:var(--z0,#000);}
      .z_1{padding:var(--z1,8px);}
      .z_2{width:var(--z2,2rem);}"
    `)
  })

  test('named tokens follow inherited theme and scheme changes in Chromium', async () => {
    const theme = Theme.define({
      color: { brand: { dark: '#fff', light: '#111' } },
      spacing: { md: '8px' },
    })
    const alternate = Theme.extend(theme, {
      color: { brand: { dark: '#9cf', light: '#06c' } },
      spacing: { md: '16px' },
    })
    const styles = Style.define(
      { card: { color: 'brand', padding: 'md' } },
      { vars: theme },
    )
    const output = Css.compile({ styles, vars: { alternate, base: theme } })
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage({ colorScheme: 'light' })

      await page.setContent(
        `<style>:root{color-scheme:light dark}${output.css}</style><main><div class="${output.classes.card}">Card</div></main>`,
      )

      async function read() {
        return page.locator('div').evaluate((element) => {
          const style = getComputedStyle(element)

          return { color: style.color, padding: style.padding }
        })
      }

      expect(await read()).toMatchInlineSnapshot(`
        {
          "color": "rgb(17, 17, 17)",
          "padding": "8px",
        }
      `)

      await page.locator('main').evaluate((element, scope) => {
        element.setAttribute('class', scope)
      }, output.vars.alternate)

      expect(await read()).toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 102, 204)",
          "padding": "16px",
        }
      `)

      await page.emulateMedia({ colorScheme: 'dark' })

      expect(await read()).toMatchInlineSnapshot(`
        {
          "color": "rgb(153, 204, 255)",
          "padding": "16px",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('preserves named declarations and cascade-significant order across modules', () => {
    const definition = Style.define(components)

    expect({
      definition,
      repeatMatches:
        JSON.stringify(Style.define(components)) === JSON.stringify(definition),
      roundtripMatches:
        JSON.stringify(JSON.parse(JSON.stringify(definition))) ===
        JSON.stringify(definition),
    }).toMatchInlineSnapshot(`
      {
        "definition": {
          "styles": [
            {
              "declarations": [
                {
                  "property": "display",
                  "value": "flex",
                },
                {
                  "property": "flexDirection",
                  "value": "column",
                },
                {
                  "property": "gap",
                  "value": "0.5rem",
                },
                {
                  "property": "padding",
                  "value": "1rem",
                },
                {
                  "property": "paddingLeft",
                  "value": 0,
                },
                {
                  "property": "marginTop",
                  "value": "-2px",
                },
                {
                  "property": "width",
                  "value": "100%",
                },
                {
                  "property": "maxWidth",
                  "value": "40rem",
                },
                {
                  "property": "backgroundColor",
                  "value": "#fff",
                },
                {
                  "property": "borderWidth",
                  "value": "1px",
                },
                {
                  "property": "borderStyle",
                  "value": "solid",
                },
                {
                  "property": "borderColor",
                  "value": "#0003",
                },
                {
                  "property": "borderRadius",
                  "value": "0.5rem",
                },
              ],
              "name": "card",
            },
            {
              "declarations": [
                {
                  "property": "color",
                  "value": "currentColor",
                },
                {
                  "property": "fontSize",
                  "value": "1rem",
                },
                {
                  "property": "fontWeight",
                  "value": 600,
                },
                {
                  "property": "lineHeight",
                  "value": 1.5,
                },
                {
                  "property": "textAlign",
                  "value": "start",
                },
                {
                  "property": "opacity",
                  "value": 0.8,
                },
              ],
              "name": "label",
            },
            {
              "declarations": [
                {
                  "property": "display",
                  "value": "none",
                },
              ],
              "name": "hidden",
            },
          ],
        },
        "repeatMatches": true,
        "roundtripMatches": true,
      }
    `)
  })

  test('copies input and freezes the entire public data graph', () => {
    const input = { card: { padding: '1rem' as const } }
    const definition = Style.define(input)

    Object.assign(input.card, { padding: '9rem' })

    const objects = [
      definition,
      definition.styles,
      definition.styles[0],
      definition.styles[0]?.declarations,
      definition.styles[0]?.declarations[0],
    ]

    expect({
      frozen: objects.map(Object.isFrozen),
      mutationAccepted: Reflect.set(definition.styles, '0', {}),
      value: definition.styles[0]?.declarations[0]?.value,
    }).toMatchInlineSnapshot(`
      {
        "frozen": [
          true,
          true,
          true,
          true,
          true,
        ],
        "mutationAccepted": false,
        "value": "1rem",
      }
    `)
  })

  test('rejects executable and non-data inputs without invoking accessors', () => {
    let reads = 0

    const input = {
      card: {
        get padding() {
          reads++

          return '1rem'
        },
      },
    }

    const failures = [
      input,
      null,
      [],
      () => ({}),
      new Date(),
      { card: null },
      { card: { [Symbol('color')]: '#fff' } },
    ].map((value) => diagnose(value))

    expect({ failures, reads }).toMatchInlineSnapshot(`
      {
        "failures": [
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Only enumerable string-keyed data properties are supported; accessors and symbols are not evaluated.",
                "path": [
                  "card",
                  "padding",
                ],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Expected a plain object with enumerable data properties.",
                "path": [],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Expected a plain object with enumerable data properties.",
                "path": [],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Expected a plain object with enumerable data properties.",
                "path": [],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Expected a plain object with enumerable data properties.",
                "path": [],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Expected a plain object with enumerable data properties.",
                "path": [
                  "card",
                ],
              },
            ],
            "name": "Style.InvalidError",
          },
          {
            "diagnostics": [
              {
                "code": "invalid_structure",
                "message": "Only enumerable string-keyed data properties are supported; accessors and symbols are not evaluated.",
                "path": [
                  "card",
                ],
              },
            ],
            "name": "Style.InvalidError",
          },
        ],
        "reads": 0,
      }
    `)
  })

  test('accepts empty definitions and null-prototype data without interpreting style names', () => {
    const input = Object.assign(
      Object.create(null) as Record<string, Style.Properties>,
      {
        constructor: { color: '#abcdef' as const },
        toString: { margin: 'auto' as const },
      },
    )

    expect({
      empty: Style.define({}),
      emptyStyle: Style.define({ empty: {} }),
      nullPrototype: Style.define(input),
    }).toMatchInlineSnapshot(`
      {
        "empty": {
          "styles": [],
        },
        "emptyStyle": {
          "styles": [
            {
              "declarations": [],
              "name": "empty",
            },
          ],
        },
        "nullPrototype": {
          "styles": [
            {
              "declarations": [
                {
                  "property": "color",
                  "value": "#abcdef",
                },
              ],
              "name": "constructor",
            },
            {
              "declarations": [
                {
                  "property": "margin",
                  "value": "auto",
                },
              ],
              "name": "toString",
            },
          ],
        },
      }
    `)
  })

  test('preserves numeric names through public authoring', () => {
    expect(Style.define({ 0: { color: '#fff' }, 1.5: { padding: 0 } }))
      .toMatchInlineSnapshot(`
    {
      "styles": [
        {
          "declarations": [
            {
              "property": "color",
              "value": "#fff",
            },
          ],
          "name": "0",
        },
        {
          "declarations": [
            {
              "property": "padding",
              "value": 0,
            },
          ],
          "name": "1.5",
        },
      ],
    }
  `)
  })

  test('accepts cross-realm records while rejecting class instances without reading getters', () => {
    const foreign: unknown = Vm.runInNewContext(`({
    card: { color: '#fff', padding: 0 },
  })`)
    const nested: unknown = { card: Vm.runInNewContext("({ color: '#fff' })") }

    const instances: readonly unknown[] = Vm.runInNewContext(`[
    new (class Card { color = '#fff' })(),
    new Date(),
    Object.create({ color: '#fff' }),
    new (class Card extends null { constructor() {
      return Object.create(new.target.prototype)
    } })(),
  ]`)

    let reads = 0
    const prototype = Object.create(null) as object

    Object.defineProperty(prototype, 'constructor', {
      get() {
        reads++

        return Object
      },
    })

    const rejected = [...instances, Object.create(prototype)].map((card) =>
      diagnose({ card }),
    )

    expect({
      foreign: diagnose(foreign),
      nested: diagnose(nested),
      reads,
      rejected,
    }).toMatchInlineSnapshot(`
    {
      "foreign": {
        "styles": [
          {
            "declarations": [
              {
                "property": "color",
                "value": "#fff",
              },
              {
                "property": "padding",
                "value": 0,
              },
            ],
            "name": "card",
          },
        ],
      },
      "nested": {
        "styles": [
          {
            "declarations": [
              {
                "property": "color",
                "value": "#fff",
              },
            ],
            "name": "card",
          },
        ],
      },
      "reads": 0,
      "rejected": [
        {
          "diagnostics": [
            {
              "code": "invalid_structure",
              "message": "Expected a plain object with enumerable data properties.",
              "path": [
                "card",
              ],
            },
          ],
          "name": "Style.InvalidError",
        },
        {
          "diagnostics": [
            {
              "code": "invalid_structure",
              "message": "Expected a plain object with enumerable data properties.",
              "path": [
                "card",
              ],
            },
          ],
          "name": "Style.InvalidError",
        },
        {
          "diagnostics": [
            {
              "code": "invalid_structure",
              "message": "Expected a plain object with enumerable data properties.",
              "path": [
                "card",
              ],
            },
          ],
          "name": "Style.InvalidError",
        },
        {
          "diagnostics": [
            {
              "code": "invalid_structure",
              "message": "Expected a plain object with enumerable data properties.",
              "path": [
                "card",
              ],
            },
          ],
          "name": "Style.InvalidError",
        },
        {
          "diagnostics": [
            {
              "code": "invalid_structure",
              "message": "Expected a plain object with enumerable data properties.",
              "path": [
                "card",
              ],
            },
          ],
          "name": "Style.InvalidError",
        },
      ],
    }
  `)
  })

  const portableSource = `import { Style } from 'zyzz'
; import { Css } from 'zyzz/web';
export const result = Css.compile({ styles: Style.define({ button: { color: '#f00', padding: 0 } }) });`

  async function portableBundle() {
    const bundle = await Esbuild.build({
      bundle: true,
      conditions: ['src'],
      format: 'iife',
      globalName: 'fixture',
      metafile: true,
      platform: 'browser',
      stdin: {
        contents: portableSource,
        resolveDir: Path.resolve(import.meta.dirname, '..'),
      },
      target: 'es2022',
      write: false,
    })

    expect(
      Object.keys(bundle.metafile.inputs).filter((path) =>
        /oxc|compiler|node:|themes/.test(path),
      ),
    ).toMatchInlineSnapshot('[]')

    return bundle.outputFiles[0]!.text
  }

  test('the browser compilation pipeline agrees in a Node context and a worker', async () => {
    const code = await portableBundle()
    // A bare context holds only ECMAScript built-ins, so the encoding globals browsers define are passed in.
    const server = Vm.runInNewContext(
      `${code}; JSON.stringify(fixture.result)`,
      {
        TextDecoder,
        TextEncoder,
      },
    )

    expect(JSON.parse(server)).toMatchInlineSnapshot(`
      {
        "classes": {
          "button": "z_0 z_1",
        },
        "css": ".z_0{color:#f00;}
      .z_1{padding:0;}",
        "vars": {},
      }
    `)

    const worker = new Worker.Worker(
      `${code}; require('node:worker_threads').parentPort.postMessage(JSON.stringify(fixture.result));`,
      { eval: true },
    )

    try {
      const result = await new Promise<string>((resolve, reject) => {
        worker.once('error', reject)
        worker.once('message', resolve)
      })

      expect(JSON.parse(result)).toMatchInlineSnapshot(`
        {
          "classes": {
            "button": "z_0 z_1",
          },
          "css": ".z_0{color:#f00;}
        .z_1{padding:0;}",
          "vars": {},
        }
      `)
    } finally {
      await worker.terminate()
    }
  })

  test('the browser compilation pipeline runs in Chromium and a browser worker', async () => {
    const code = await portableBundle()
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.addScriptTag({ content: code })

      expect(await page.evaluate('fixture.result')).toMatchInlineSnapshot(`
        {
          "classes": {
            "button": "z_0 z_1",
          },
          "css": ".z_0{color:#f00;}
        .z_1{padding:0;}",
          "vars": {},
        }
      `)

      const result = await page.evaluate(async (code) => {
        const url = URL.createObjectURL(
          new Blob([code + '; postMessage(fixture.result);'], {
            type: 'text/javascript',
          }),
        )

        const worker = new globalThis.Worker(url)

        try {
          return await new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data)
            worker.onerror = (event) => reject(new Error(event.message))
          })
        } finally {
          worker.terminate()
          URL.revokeObjectURL(url)
        }
      }, code)

      expect(result).toMatchInlineSnapshot(`
        {
          "classes": {
            "button": "z_0 z_1",
          },
          "css": ".z_0{color:#f00;}
        .z_1{padding:0;}",
          "vars": {},
        }
      `)
    } finally {
      await browser.close()
    }
  })
})

describe('consumer types', () => {
  const root = Path.resolve(import.meta.dirname, '..')
  let cases: readonly Conformance.Case[]

  beforeAll(() => {
    cases = Conformance.cases()
  }, 30_000)

  // Programs within each group share one incremental cache and cannot overlap.
  describe.concurrent.each([0, 1])('group %i', (group) => {
    let directory: string

    beforeAll(async () => {
      directory = await Fs.mkdtemp(Path.join(root, '.fixture-css-types-'))
    }, 30_000)

    afterAll(async () => {
      await Fs.rm(directory, { force: true, recursive: true })
    })

    test.sequential.for(
      Array.from({ length: 5 }, (_, index) => group * 5 + index),
    )('partition %i', { timeout: 310_000 }, async (partition, context) => {
      const groups = new Map<string, string>()
      // Separate programs bound checker work without reducing the property or value corpus.
      const properties = Conformance.properties().filter(
        (_, index) => index % 10 === partition,
      )

      const declarations = properties.map((property) => {
        const values = [
          ...cases
            .filter((entry) => entry.property === property)
            .map(({ value }) => value),
          'var(--probe)',
          'var(--probe,)',
          'calc(1px + var(--probe))',
        ].flatMap((value) => [value, `${value} !important`])

        const checks: string[] = []

        // Check scalars individually to avoid native compiler tuple-comparison limits.
        for (const value of values) {
          const key = JSON.stringify(value)
          let group = groups.get(key)

          if (!group) {
            group = `values${groups.size}`
            groups.set(key, group)
          }

          checks.push(`${group} satisfies Style.Properties['${property}'];`)
        }

        return `${checks.join('\n')}\nstyle({${JSON.stringify(property)}: [${values
          .slice(0, 16)
          .map((value) => JSON.stringify(value))
          .join(',')}]});`
      })

      const rejections = Conformance.rejected
        .filter((_, index) => index % 10 === partition)
        .map(
          ({ property, value }) =>
            `// @ts-expect-error Invalid or deliberately unsupported scalar.\nstyle({${property}: ${JSON.stringify(value)}});\n// @ts-expect-error Importance must preserve rejection.\nstyle({${property}: ${JSON.stringify(`${value} !important`)}});`,
        )
      const booleans = properties.map(
        (property) =>
          `style({${JSON.stringify(property)}: [' InHeRiT !important', ${JSON.stringify(String.raw`\69 nherit/**/ !important`)}]});\n// @ts-expect-error Booleans are outside every CSS scalar domain.\nstyle({${JSON.stringify(property)}: true});`,
      )
      const source = `/** Checks generated consumer declarations. @module */\nimport { describe, test } from 'vite-plus/test';\nimport { style, type Style } from 'zyzz';\ndescribe('style', () => {\n  test('validates generated conformance probes', () => {\n${[...[...groups].map(([values, group]) => `const ${group} = ${values} as const;`), ...declarations, ...rejections, ...booleans].join('\n')}\n  });\n});`

      await Fs.writeFile(Path.join(directory, 'consumer.test-d.ts'), source)
      await Fs.writeFile(
        Path.join(directory, 'tsconfig.json'),
        JSON.stringify({
          exclude: [],
          extends: '../tsconfig.json',
          include: ['./consumer.test-d.ts'],
        }),
      )

      const require = Module.createRequire(import.meta.url)

      const { stderr, stdout } = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          '--max-old-space-size=6144',
          Path.join(
            Path.dirname(require.resolve('typescript/package.json')),
            'bin/tsc',
          ),
          '--incremental',
          '--project',
          Path.join(directory, 'tsconfig.json'),
          '--tsBuildInfoFile',
          Path.join(directory, 'consumer.tsbuildinfo'),
        ],
        { cwd: root, maxBuffer: 1024 * 1024, timeout: 300_000 },
      ).catch(async (error: unknown) => {
        await Fs.mkdir(Path.join(root, 'test-results'), { recursive: true })
        await Fs.writeFile(
          Path.join(root, `test-results/css-consumer-${partition}.test-d.ts`),
          source,
        )

        if (error && typeof error === 'object' && 'stdout' in error)
          throw new Error(
            String(error.stdout) ||
              String('stderr' in error ? error.stderr : error),
          )

        throw error
      })

      context.expect(stderr).toMatchInlineSnapshot(`""`)
      context.expect(stdout).toMatchInlineSnapshot(`""`)
    })
  })
})
