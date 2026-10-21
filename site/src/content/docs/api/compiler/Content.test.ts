/** Runs and type-checks the compiler API reference examples through public compiler entrypoints. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { defineVars, extendVars } from 'zyzz'
import { Graph, Native, Source, Transform } from 'zyzz/compiler'
import { NativeContext } from 'zyzz/runtime'
import type { Css } from 'zyzz/web'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
let root = ''
let count = 0

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-compiler-api-'))
  await Fs.mkdir(Path.join(root, 'node_modules'))
  await Fs.symlink(project, Path.join(root, 'node_modules/zyzz'), 'dir')
  for (const name of ['@types', 'react-native'])
    await Fs.symlink(
      Path.join(project, 'node_modules', name),
      Path.join(root, 'node_modules', name),
      'dir',
    )
})

afterAll(async () => {
  if (root) await Fs.rm(root, { force: true, recursive: true })
})

/** Reads a page's TypeScript examples in order, optionally from one section. */
async function examples(page: string, heading?: string | undefined) {
  const document = await Fs.readFile(
    new URL(`./${page}.mdx`, import.meta.url),
    'utf8',
  )
  const section =
    heading === undefined
      ? document
      : document
          .split(/^#{2,3} /m)
          .find((entry) => entry.startsWith(`${heading}\n`))
  if (section === undefined)
    throw new Error(`${page} has no ${heading} section.`)

  return Array.from(
    section.matchAll(/```tsx?([^\n]*)\n([\s\S]*?)```/g),
    (match) => ({
      name: match[1]!.match(/title="([^"]+)"/)?.[1],
      source: match[2]!,
    }),
  ).filter((example) => !example.source.includes('// @errors'))
}

/** Reads the first importing example of a page or one of its sections. */
async function example(page: string, heading?: string | undefined) {
  const found = (await examples(page, heading)).find((entry) =>
    entry.source.includes('import '),
  )
  if (!found) throw new Error(`${page} ${heading} has no importing example.`)

  return found.source
}

/** Reads the module text of each `'id': \`…\`` or `source: \`…\`` template in an example. */
function templates(code: string) {
  return Object.fromEntries(
    Array.from(
      code.matchAll(/(?:'([^']+)'|source): `([\s\S]*?)`/g),
      (match) => [match[1] ?? 'source', match[2]!],
    ),
  )
}

/** Exports module-level `const` bindings, leaving module text inside templates unchanged. */
function exported(code: string) {
  let template = false

  return code
    .split('\n')
    .map((line) => {
      const next =
        template || !line.startsWith('const ') ? line : `export ${line}`
      if ((line.replaceAll('\\`', '').match(/`/g)?.length ?? 0) % 2)
        template = !template
      return next
    })
    .join('\n')
}

/** Imports an example module, with its module-level `const` bindings exported, as the shape a test reads. */
async function run<module>(code: string): Promise<module> {
  const file = Path.join(root, `example-${count++}.ts`)
  await Fs.writeFile(file, exported(code))

  return (await import(file)) as module
}

/** Writes compiled module code and imports it, so its callables run against `zyzz/runtime`. */
async function load<module>(code: string): Promise<module> {
  const file = Path.join(root, `compiled-${count++}.ts`)
  await Fs.writeFile(file, code)

  return (await import(file)) as module
}

describe('Source.extract', () => {
  test('extracts the overview example', async () => {
    const module = await run<{
      css: string
      output: Source.extract.ReturnType
    }>(await example('namespaces/Source'))

    expect(module.css).toMatchInlineSnapshot(`".z_0{padding:1rem;}"`)
    expect(module.output.styles.styles[0]?.declarations).toMatchInlineSnapshot(`
      [
        {
          "property": "padding",
          "value": "1rem",
        },
      ]
    `)
    expect(module.output.calls[0]).toMatchInlineSnapshot(`
      {
        "cssName": "FdvK6e-card",
        "cssNamespace": undefined,
        "end": 76,
        "identity": "z-style-FdvK6e-card",
        "name": "style-12aqmga1qxkrpc-50",
        "start": 50,
      }
    `)
    expect(module.output.themeCalls).toMatchInlineSnapshot(`[]`)
    expect(module.output.contributions).toMatchInlineSnapshot(`undefined`)
    // Set only when Graph.compile extracts the module
    expect(module.output.themeExports).toMatchInlineSnapshot(`undefined`)
  })

  test('returns portable identities without rewriting', async () => {
    const { source } = templates(await example('namespaces/Source'))
    const output = Source.extract({
      compiler: false,
      moduleId: 'app/Card.tsx',
      source: source!,
    })

    expect(output.calls[0]?.portable).toMatchInlineSnapshot(
      `"z-content-_5b__5b__22_padding_22__2c__22_1rem_22__2c_false_5d__5d_"`,
    )
  })

  test('omits portable identities for dynamic, variant, and empty styles', () => {
    const output = Source.extract({
      compiler: false,
      moduleId: 'app/Card.tsx',
      source: `import { style, variants } from 'zyzz'
export const bar = style((values: { alpha: number }) => ({ opacity: values.alpha }))
export const button = variants({ variants: { tone: { loud: { opacity: 1 } } } })
export const empty = style({})
`,
    })

    expect(output.calls.map((call) => call.portable)).toMatchInlineSnapshot(`
      [
        undefined,
        undefined,
        undefined,
      ]
    `)
  })

  test('compiles extracted variable sets', async () => {
    const module = await run<{
      output: Source.extract.ReturnType
      result: Css.compile.ReturnType
    }>(await example('namespaces/Source', 'vars'))

    expect(module.result.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_0{color:var(--z-color-brand,#06c);}"
    `)
    expect(module.result.vars).toMatchInlineSnapshot(`
      {
        "src-Card-8E7ByFdvK6e-style-theme": "z-theme-theme",
      }
    `)
    expect(module.output.themeCalls.length).toMatchInlineSnapshot(`1`)
    expect(module.output.themeCalls.map((call) => [call.name, call.tokenType]))
      .toMatchInlineSnapshot(`
      [
        [
          "src-Card-8E7ByFdvK6e-style-theme",
          "{readonly "color":{readonly "brand":"#06c"}}",
        ],
      ]
    `)
  })

  test('returns contributions and variable calls', () => {
    const output = Source.extract({
      moduleId: 'app/theme.ts',
      source: `import { variable } from 'zyzz'
import { global } from 'zyzz/web'

export const accent = variable('color')

global({ body: { margin: 0 } })
`,
    })

    expect(output.contributions).toMatchInlineSnapshot(`
      [
        {
          "kind": "rule",
          "selector": "body",
          "style": {
            "declarations": [
              {
                "property": "margin",
                "value": 0,
              },
            ],
            "name": "contribution",
          },
        },
      ]
    `)
    expect(output.variableCalls?.[0]?.explicit).toMatchInlineSnapshot(`false`)
    expect(output.variableCalls?.[0]?.slots).toMatchInlineSnapshot(`
      {
        "value": {
          "name": "--z-accent",
          "type": "color",
          "variable": true,
        },
      }
    `)
  })

  test('aligns contribution starts and names named factories', () => {
    const source = `import { global, keyframes } from 'zyzz/web'
global({ body: { margin: 0 }, html: { color: 'red' } })
export const spin = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } })
`

    const output = Source.extract({ moduleId: 'app/g.ts', source })

    expect(output.contributions?.map((entry) => entry.kind))
      .toMatchInlineSnapshot(`
      [
        "rule",
        "rule",
        "keyframes",
      ]
    `)
    expect(output.contributionStarts).toMatchInlineSnapshot(`
      [
        45,
        45,
        121,
      ]
    `)
    expect(output.contributionCalls?.map((call) => [call.kind, call.name]))
      .toMatchInlineSnapshot(`
      [
        [
          "global",
          undefined,
        ],
        [
          "keyframes",
          "z-k-spin",
        ],
      ]
    `)

    expect(Transform.compile({ moduleId: 'app/g.ts', source }).code)
      .toMatchInlineSnapshot(`
      "
      void 0
      export const spin = "z-k-spin"
      "
    `)
  })

  test('omits offsets for config layer contributions', () => {
    const output = Source.extract({
      moduleId: 'app/config.ts',
      source: `import { defineConfig } from 'zyzz'
import { global } from 'zyzz/web'
const { style } = defineConfig({ layers: ['base', 'components'] })
global({ body: { margin: 0 } })
export const card = style({ color: 'red' })
`,
    })

    expect(output.contributions?.map((entry) => entry.kind))
      .toMatchInlineSnapshot(`
      [
        "rule",
        "layers",
      ]
    `)
    expect(output.contributionStarts).toMatchInlineSnapshot(`
      [
        137,
      ]
    `)
  })

  test('orders variable registrations before contribution calls', () => {
    const output = Source.extract({
      moduleId: 'app/theme.ts',
      source: `import { defineConfig, variable } from 'zyzz'
import { global } from 'zyzz/web'
global({ body: { margin: 0 } })
export const accent = variable('color', { inherits: true, initialValue: 'red' })
const { style } = defineConfig({ layers: ['base'] })
export const card = style({ color: 'red' })
`,
    })

    expect(output.contributions?.map((entry) => entry.kind))
      .toMatchInlineSnapshot(`
      [
        "property",
        "rule",
        "layers",
      ]
    `)
    expect(output.contributionStarts).toMatchInlineSnapshot(`
      [
        134,
        80,
      ]
    `)
  })

  test('returns contribution, namespace, and config helper fields', () => {
    const output = Source.extract({
      moduleId: 'app/theme.tsx',
      source: `import { defineConfig } from 'zyzz'
import { global, namespace } from 'zyzz/web'

const { appearance, script, style, vars } = defineConfig({
  vars: { color: { brand: '#06c' } },
})

global({ body: { margin: 0 } })

namespace({ prefix: 'svg', uri: 'http://www.w3.org/2000/svg' })

export const tag = script()

export const card = style({ color: 'brand' })

const tokens = { color: vars.color.brand } as const

export const box = style({ color: tokens.color })
`,
    })

    expect(output.contributionCalls?.map((call) => call.kind))
      .toMatchInlineSnapshot(`
      [
        "global",
        "namespace",
      ]
    `)
    expect(output.contributionStarts).toMatchInlineSnapshot(`
      [
        183,
        216,
      ]
    `)
    expect(output.namespaces).toMatchInlineSnapshot(`
      [
        {
          "kind": "namespace",
          "name": "z-n1s08wvjtx687h-60",
          "prefix": "svg",
          "uri": "http://www.w3.org/2000/svg",
        },
      ]
    `)
    expect(output.staticThemeReferences).toMatchInlineSnapshot(`
      [
        {
          "end": 397,
          "start": 381,
          "value": "var(--z-color-brand,#06c)",
        },
      ]
    `)
    expect(output.themeAppearances).toMatchInlineSnapshot(`
      [
        "src-theme-eqLm6-5DbIH-appearance-theme",
      ]
    `)
    expect(output.themeScripts).toMatchInlineSnapshot(`
      [
        "src-theme-eqLm6-5DbIH-appearance-theme",
      ]
    `)
    expect(output.themeSelections).toMatchInlineSnapshot(`
      [
        "src-theme-eqLm6-5DbIH-appearance-theme",
      ]
    `)
  })

  test('returns native variable arguments', () => {
    const output = Source.extract({
      moduleId: 'app/Gap.tsx',
      source: `import { defineVars } from 'zyzz'
import { useVars } from 'zyzz/react-native/react'

const vars = defineVars({ spacing: { gap: '4px' } })

export function read() {
  return useVars(vars)
}
`,
      target: 'native',
    })

    expect(Object.keys(output.nativeVars?.[0] ?? {}).sort())
      .toMatchInlineSnapshot(`
      [
        "defaultVars",
        "end",
        "owner",
        "start",
        "unnamed",
        "vars",
      ]
    `)
    expect(output.nativeVars?.map((read) => Object.keys(read.vars)))
      .toMatchInlineSnapshot(`
      [
        [
          "default",
        ],
      ]
    `)
  })

  test('resolves static input', async () => {
    const source = await example('namespaces/Source', 'Static Input')
    const output = Source.extract({ moduleId: 'app/Card.tsx', source })

    expect(output.styles.styles[0]?.declarations).toMatchInlineSnapshot(`
      [
        {
          "property": "display",
          "value": "block",
        },
        {
          "property": "display",
          "value": "grid",
        },
        {
          "property": "padding",
          "value": "8px",
        },
        {
          "important": true,
          "property": "color",
          "value": "red",
        },
      ]
    `)
  })

  test('rejects exported configs without a graph', () => {
    expect(() =>
      Source.extract({
        moduleId: 'app/zyzz.config.ts',
        source: `import { defineConfig } from 'zyzz'
export const { style } = defineConfig({ vars: { color: { brand: '#06c' } } })
`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/zyzz.config.ts:49: Define local themes with a module-level const; exported themes require source linking.]`,
    )
  })

  test('throws the documented error', async () => {
    const { source } = templates(
      await example('namespaces/Source', 'Source.ExtractError'),
    )

    expect(() =>
      Source.extract({ moduleId: 'app/Card.tsx', source: source! }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/Card.tsx:66: Expected a literal string or number; expressions are not evaluated.]`,
    )
  })
})

describe('Transform.compile', () => {
  test('rejects native output', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'app/Card.tsx',
        source: '',
        target: 'native',
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Use Native.compile for native source output.]`,
    )
  })

  test('compiles the overview example', async () => {
    const module = await run<{ output: Transform.compile.ReturnType }>(
      await example('namespaces/Transform'),
    )

    expect(module.output.code).toMatchInlineSnapshot(`
      "
      import { Props as __zyzzProps } from 'zyzz/runtime';


      export const card = /*#__PURE__*/__zyzzProps.create({className:"z_FdvK6e0 z-style-FdvK6e-card"})
      "
    `)
    expect(module.output.css).toMatchInlineSnapshot(
      `".z_FdvK6e0{padding:1rem;}"`,
    )
    expect(module.output.classes).toMatchInlineSnapshot(`
      {
        "style-12aqmga1qxkrpc-50": "z_FdvK6e0 z-style-FdvK6e-card",
      }
    `)
    expect(module.output.vars).toMatchInlineSnapshot(`{}`)
    expect(module.output.map.sources).toMatchInlineSnapshot(`
      [
        "app/Card.tsx",
      ]
    `)
    expect(module.output.cssMap.sources).toMatchInlineSnapshot(`
      [
        "app/Card.tsx",
      ]
    `)
  })

  test('applies the documented options', async () => {
    const { source } = templates(await example('namespaces/Transform'))

    expect(
      Transform.compile({
        compiler: false,
        moduleId: 'app/Card.tsx',
        source: source!,
      }).code === source,
    ).toMatchInlineSnapshot(`true`)
    expect(
      Transform.compile({
        cssOutput: 'grouped',
        moduleId: 'app/Card.tsx',
        source: source!,
      }).css,
    ).toMatchInlineSnapshot(`".z_FdvK6e0{padding:1rem;}"`)
    expect(
      Transform.compile({
        moduleId: 'app/Card.tsx',
        schemes: true,
        source: source!,
      }).css,
    ).toMatchInlineSnapshot(`
      ".z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_FdvK6e0{padding:1rem;}"
    `)
  })

  test('prunes replaced config factory imports', () => {
    const output = Transform.compile({
      moduleId: 'app/Card.tsx',
      source: `import { defineConfig } from 'zyzz'
const { style } = defineConfig({ vars: { color: { brand: '#06c' } } })
export const card = style({ color: 'brand' })
`,
    })

    expect(output.code.split('\n').filter((line) => line.startsWith('import')))
      .toMatchInlineSnapshot(`
      [
        "import { Props as __zyzzProps } from 'zyzz/runtime';",
      ]
    `)
  })

  test('rejects relative contribution assets', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'app/fonts.ts',
        source: `import { fontFace } from 'zyzz/web'
fontFace({ fontFamily: 'Geist', src: 'url(./Geist.woff2)' })
`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/fonts.ts:36: Relative contribution assets require Graph.compile and a relocation host.]`,
    )
  })

  test('requires explicit ids that extraction accepts without them', () => {
    const source = `import { variable } from 'zyzz'
export const accent = variable('color')
`

    expect(
      Source.extract({ compiler: false, moduleId: 'app/vars.ts', source })
        .calls,
    ).toMatchInlineSnapshot(`[]`)
    expect(() =>
      Transform.compile({ compiler: false, moduleId: 'app/vars.ts', source }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: CSS-only output requires an explicit variable id.]`,
    )
  })

  test('requires explicit ids for dynamic styles without rewriting', () => {
    expect(() =>
      Transform.compile({
        compiler: false,
        moduleId: 'app/Bar.tsx',
        source: `import { style } from 'zyzz'
export const bar = style((values: { alpha: number }) => ({ opacity: values.alpha }))
`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: CSS-only output requires an explicit id for dynamic styles, variants, and compositions.]`,
    )
  })

  test('keeps unreached definitions in development', () => {
    const source = `import { style } from 'zyzz'

const unused = style({ color: 'red' })

export const card = style({ padding: '1rem' })
`

    expect(
      Transform.compile({ moduleId: 'app/Card.tsx', source }).css,
    ).toMatchInlineSnapshot(`".z_FdvK6e0{padding:1rem;}"`)
    expect(
      Transform.compile({ development: true, moduleId: 'app/Card.tsx', source })
        .css,
    ).toMatchInlineSnapshot(`
      ".z-FdvK6e-text-red{color:red;}
      .z-FdvK6e-p-1rem{padding:1rem;}"
    `)
  })

  test('gives repeated declarations their own classes in development', () => {
    const source = `import { style } from 'zyzz'
export const a = style({ color: 'red' })
export const b = style({ color: 'blue' })
export const c = style({ color: 'red' })
`

    const css = (development: boolean) =>
      Transform.compile({
        composition: 'independent',
        development,
        moduleId: 'app/Text.tsx',
        source,
      }).css

    expect(css(false)).toMatchInlineSnapshot(`
      ".z_JJZ3wD0{color:red;}
      .z_JJZ3wD1{color:blue;}"
    `)
    expect(css(true)).toMatchInlineSnapshot(`
      ".z-JJZ3wD-a-text-0{color:red;}
      .z-JJZ3wD-b-text-0{color:blue;}
      .z-JJZ3wD-c-text-0{color:red;}"
    `)
  })

  test('prunes replaced zyzz/web imports', () => {
    const output = Transform.compile({
      moduleId: 'app/global.ts',
      source: `import { global, keyframes } from 'zyzz/web'
import React from 'react'
global({ body: { margin: 0 } })
export const spin = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } })
export const element = React
`,
    })

    expect(output.code.split('\n').filter((line) => line.startsWith('import')))
      .toMatchInlineSnapshot(`
      [
        "import React from 'react'",
      ]
    `)
  })

  test('reuses rules with independent composition', async () => {
    const module = await run<{ output: Transform.compile.ReturnType }>(
      await example('namespaces/Transform', 'options.composition'),
    )
    const { source } = templates(
      await example('namespaces/Transform', 'options.composition'),
    )

    expect(module.output.classes).toMatchInlineSnapshot(`
      {
        "style-1ykuc7f14p42q1-132": "z_JJZ3wD0 z-style-JJZ3wD-c",
        "style-1ykuc7f14p42q1-47": "z_JJZ3wD0 z-style-JJZ3wD-a",
        "style-1ykuc7f14p42q1-89": "z_JJZ3wD1 z-style-JJZ3wD-b",
      }
    `)
    expect(Transform.compile({ moduleId: 'app/Text.tsx', source: source! }).css)
      .toMatchInlineSnapshot(`
        ".z_JJZ3wD0{color:red;}
        .z_JJZ3wD1{color:blue;}
        .z_JJZ3wD2{color:red;}"
      `)
  })

  test('returns scope classes for local variable sets', async () => {
    const { source } = templates(await example('namespaces/Source', 'vars'))

    expect(
      Transform.compile({ moduleId: 'app/Card.tsx', source: source! }).vars,
    ).toMatchInlineSnapshot(`
      {
        "src-Card-8E7ByFdvK6e-style-theme": "z-theme-theme",
      }
    `)
  })

  test('throws the documented error', async () => {
    const { source } = templates(
      await example('namespaces/Transform', 'Errors'),
    )

    expect(() =>
      Transform.compile({
        cssOutput: 'nested' as never,
        moduleId: 'app/Card.tsx',
        source: source!,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Css.CompileError: ["cssOutput"]: cssOutput must be atomic or grouped.]`,
    )
  })
})

describe('Graph.compile', () => {
  test('compiles the native graph output example', async () => {
    const module = await run<{ output: Graph.compile.ReturnType }>(
      await example('namespaces/Native', 'Graph Output'),
    )

    expect(module.output.modules['app/card.ts']?.code).toMatchInlineSnapshot(`
      "
      import {Native as __zyzzNative} from 'zyzz/runtime';




      import { style } from 'zyzz'

      export const card = (__zyzzNative.create({"axes":{},"defaults":{},"styles":{"0":{"opacity":0.5}}}) as import('zyzz/runtime').Native.Callable<{}>)
      "
    `)
    expect(module.output.modules['app/card.ts']?.css).toMatchInlineSnapshot(
      `""`,
    )
    expect(module.output.modules['app/card.ts']?.classes).toMatchInlineSnapshot(
      `{}`,
    )
    expect(module.output.dependencies).toMatchInlineSnapshot(`
      {
        "app/card.ts": [],
        "app/index.ts": [
          "app/card.ts",
        ],
      }
    `)
  })

  test('exports native profiles from the defining module', () => {
    const output = Graph.compile({
      modules: {
        'app/Gap.tsx': `import { useVars } from 'zyzz/react-native/react'
import { vars } from './vars.js'

export function Gap() {
  return useVars(vars).spacing.gap
}
`,
        'app/vars.ts': `import { defineVars } from 'zyzz'

export const vars = defineVars({ spacing: { gap: '4px' } })
`,
      },
      native: { colorScheme: 'light' },
    })

    expect(
      output.modules['app/vars.ts']?.code.includes(
        'export const __zyzzProfile',
      ),
    ).toMatchInlineSnapshot(`true`)
    expect(
      /import \{__zyzzProfile\w+\} from "\.\/vars\.js"/.test(
        output.modules['app/Gap.tsx']?.code ?? '',
      ),
    ).toMatchInlineSnapshot(`true`)
  })

  test('requires explicit ids for configs without rewriting', async () => {
    const modules = templates(await example('namespaces/Graph'))

    expect(() =>
      Graph.compile({ compiler: false, modules }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: CSS-only themes require an explicit id on Config.create or Vars.define.]`,
    )
  })

  test('links the overview example', async () => {
    const module = await run<{ output: Graph.compile.ReturnType }>(
      await example('namespaces/Graph'),
    )

    expect(module.output.dependencies).toMatchInlineSnapshot(`
      {
        "app/Card.tsx": [
          "app/zyzz.config.ts",
        ],
        "app/zyzz.config.ts": [],
      }
    `)
    expect(module.output.modules['app/Card.tsx']?.code).toMatchInlineSnapshot(`
      "
      import { Props as __zyzzProps } from 'zyzz/runtime';
      import { style } from './zyzz.config.js'

      export const card = /*#__PURE__*/__zyzzProps.create({className:"z_FdvK6e0 z-style-FdvK6e-card"})
      "
    `)
    expect(module.output.modules['app/Card.tsx']?.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_FdvK6e0{color:var(--z-color-brand,#06c);}"
    `)
    expect(module.output.sharedCss).toMatchInlineSnapshot(`undefined`)
  })

  test('consumes a library contract', async () => {
    const { library } = await run<{ library: Graph.compile.ReturnType }>(
      await example('namespaces/Graph', 'Library Contracts'),
    )
    const modules = templates(
      await example('namespaces/Graph', 'options.contracts'),
    )
    const output = Graph.compile({
      contracts: {
        'library/index.js': library.contracts['library/index.ts']!,
      },
      imports: { 'app/Card.tsx': { '@acme/theme': 'library/index.js' } },
      modules: { 'app/Card.tsx': modules['app/Card.tsx']! },
    })

    expect(Object.keys(library.contracts)).toMatchInlineSnapshot(`
      [
        "library/index.ts",
      ]
    `)
    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "app/Card.tsx": [
          "library/index.js",
        ],
      }
    `)
    expect(output.modules['app/Card.tsx']?.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_FdvK6e0{color:var(--z-color-brand,#06c);}"
    `)
  })

  test('publishes literal exports without evaluating runtime exports', () => {
    const output = Graph.compile({
      modules: {
        'app/constants.ts': `export const size = 1
`,
        'app/runtime.ts': `export const size = () => 1
`,
      },
    })

    expect(output.contracts).toMatchInlineSnapshot(`
      {
        "app/constants.ts": "{"literals":{"size":"1"},"exports":{},"themes":{},"version":35}",
      }
    `)
  })

  test('emits contracts for private appearance and script reads', () => {
    const output = Graph.compile({
      modules: {
        'app/a.ts': `import { defineConfig } from 'zyzz'
const { appearance } = defineConfig({ vars: { color: { brand: { light: '#000', dark: '#fff' } } } })
const props = appearance('dark')
export const size = () => 1
`,
        'app/b.ts': `import { defineConfig } from 'zyzz'
const { script } = defineConfig({ vars: { color: { brand: '#000' } } })
script()
export const size = () => 2
`,
      },
    })

    expect(Object.keys(output.contracts)).toMatchInlineSnapshot(`
      [
        "app/a.ts",
        "app/b.ts",
      ]
    `)
  })

  test('emits private appearance contracts only in web graphs', () => {
    const modules = {
      'app/a.ts': `import { defineConfig } from 'zyzz'
const { appearance } = defineConfig({ vars: { color: { brand: { light: '#000', dark: '#fff' } } } })
const props = appearance('dark')
export const size = () => 1
`,
    }

    const native = Graph.compile({
      modules,
      native: { colorScheme: 'light', contextual: true },
    })

    expect(Object.keys(native.contracts)).toMatchInlineSnapshot(`[]`)
  })

  test('rejects relative and nonliteral dynamic imports', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'app/a.ts': `export const load = () => import('./lazy.js')
`,
          'app/lazy.ts': `export const size = 1
`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/a.ts:26: Source graph dependencies require static imports.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'app/a.ts': `export const load = (path: string) => import(path)
`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/a.ts:38: Source graph dependencies require static imports.]`,
    )

    const output = Graph.compile({
      modules: {
        'app/a.ts': `export const load = () => import('react')
`,
      },
    })

    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "app/a.ts": [],
      }
    `)
  })

  test('emits contracts for stylesheet contributions and their importers', () => {
    const output = Graph.compile({
      modules: {
        'app/global.ts': `import { global } from 'zyzz/web'
global({ body: { margin: 0 } })
`,
        'app/index.ts': `import './global.js'
export const size = () => 1
`,
        'app/plain.ts': `export const size = () => 2
`,
      },
    })

    expect(Object.keys(output.contracts)).toMatchInlineSnapshot(`
      [
        "app/global.ts",
        "app/index.ts",
      ]
    `)
  })

  test('needs no host resolution for type-only imports', () => {
    const output = Graph.compile({
      imports: { 'app/Card.tsx': { zyzz: null } },
      modules: {
        'app/Card.tsx': `import type { ReactNode } from 'react'
import { style } from 'zyzz'
export const card = style({ color: 'red' })
`,
      },
    })

    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "app/Card.tsx": [],
      }
    `)
  })

  test('requires host resolution for every import', () => {
    expect(() =>
      Graph.compile({
        imports: { 'app/Card.tsx': {} },
        modules: {
          'app/Card.tsx': `import { style } from 'zyzz'
export const card = style({ color: 'red' })
`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/Card.tsx:0: Missing host resolution: zyzz]`,
    )
  })

  test('resolves index files and extensionless paths', () => {
    const output = Graph.compile({
      modules: {
        'app/card/index.ts': `import { style } from 'zyzz'
export const card = style({ color: 'red' })
`,
        'app/index.ts': `export { card } from './card'
`,
      },
    })

    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "app/card/index.ts": [],
        "app/index.ts": [
          "app/card/index.ts",
        ],
      }
    `)
  })

  test('returns shared CSS, the reset, and assets', () => {
    const output = Graph.compile({
      modules: {
        'app/fonts.ts': `import { fontFace, global } from 'zyzz/web'

fontFace({ fontFamily: 'Geist', src: "url('./Geist.woff2') format('woff2')" })

global({ body: { margin: 0 } })
`,
      },
      reset: '@layer reset { * { margin: 0 } }',
    })

    expect(output.sharedCss).toMatchInlineSnapshot(`
      "@layer reset;
      @font-face {
        font-family: Geist;
        src: url("zyzz-asset:app%2FGeist.woff2") format("woff2");
      }
      body{margin:0;}
      @layer reset { * { margin: 0 } }"
    `)
    expect(output.sharedCssMap?.sources).toMatchInlineSnapshot(`
      [
        "app/fonts.ts",
        "zyzz/reset.css",
      ]
    `)
    expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:app%2FGeist.woff2": "app/Geist.woff2",
      }
    `)
    expect(output.sharedAssetOwners).toMatchInlineSnapshot(`
      {
        "zyzz-asset:app%2FGeist.woff2": "app/fonts.ts",
      }
    `)
    expect(output.modules['app/fonts.ts']?.css).toMatchInlineSnapshot(`""`)
  })

  test('rejects circular imports and invalid contracts', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'a.ts': `import { b } from './b.js'
export const a = b
`,
          'b.ts': `import { a } from './a.js'
export const b = a
`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: a.ts:0: Circular source dependencies are not supported yet.]`,
    )
    expect(() =>
      Graph.compile({
        contracts: { 'library/index.js': '{"version":999}' },
        imports: { 'app/Card.tsx': { library: 'library/index.js' } },
        modules: {
          'app/Card.tsx': `import { style } from 'library'
export const card = style({ color: 'brand' })
`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library/index.js:0: Invalid library contract: Unsupported Zyzz contract version.]`,
    )
  })

  test('throws the documented error', async () => {
    const modules = templates(await example('namespaces/Graph', 'Errors'))

    expect(() => Graph.compile({ modules })).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/Card.tsx:0: Missing source module: ./missing.js]`,
    )
  })
})

describe('Graph.create', () => {
  test('reuses unaffected results across snapshots', async () => {
    const modules = templates(await example('namespaces/Graph'))
    const compiler = Graph.create()
    const first = compiler.compile({ modules })

    expect(compiler.compile({ modules }) === first).toMatchInlineSnapshot(
      `true`,
    )

    const edited = {
      ...modules,
      'app/Card.tsx': modules['app/Card.tsx']!.replace(
        "'brand'",
        "'red !custom'",
      ),
    }
    const next = compiler.compile({ modules: edited })

    expect(
      next.modules['app/zyzz.config.ts'] ===
        first.modules['app/zyzz.config.ts'],
    ).toMatchInlineSnapshot(`true`)
    expect(next.modules['app/Card.tsx']?.css).toMatchInlineSnapshot(`
      ".z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_FdvK6e0{color:red;}"
    `)
    expect(() =>
      compiler.compile({
        modules: { ...modules, 'app/Card.tsx': 'export const = 1' },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/Card.tsx:13: Unexpected token]`,
    )
    // The failed snapshot leaves the last successful one in place.
    expect(
      compiler.compile({ modules: edited }) === next,
    ).toMatchInlineSnapshot(`true`)
  })

  test('keeps unchanged module results after a config edit', () => {
    const modules = {
      'app/Card.tsx': `import { style } from './zyzz.config.js'

export const card = style({ color: 'brand' })
`,
      'app/Other.tsx': `import { style } from 'zyzz'

export const other = style({ color: 'red' })
`,
      'app/zyzz.config.ts': `import { defineConfig } from 'zyzz'

export const { style } = defineConfig({ vars: { color: { brand: '#06c' } } })
`,
    }
    const compiler = Graph.create()
    const first = compiler.compile({ modules })
    const card = compiler.compile({
      modules: { ...modules, 'app/Card.tsx': `${modules['app/Card.tsx']}\n` },
    })

    // An unrelated module keeps its result after a non-config edit
    expect(
      card.modules['app/Other.tsx'] === first.modules['app/Other.tsx'],
    ).toMatchInlineSnapshot(`true`)

    const themed = compiler.compile({
      modules: {
        ...modules,
        'app/zyzz.config.ts': modules['app/zyzz.config.ts'].replace(
          '#06c',
          '#f00',
        ),
      },
    })

    // A config edit recompiles every module and keeps the results it leaves unchanged
    expect(
      themed.modules['app/Card.tsx'] === card.modules['app/Card.tsx'],
    ).toMatchInlineSnapshot(`false`)
    expect(
      themed.modules['app/Other.tsx'] === card.modules['app/Other.tsx'],
    ).toMatchInlineSnapshot(`true`)
  })
})

describe('Native.compile', () => {
  test('compiles the overview example', async () => {
    const module = await run<{ output: Native.compile.ReturnType }>(
      await example('namespaces/Native'),
    )

    expect(module.output.code).toMatchInlineSnapshot(`
      "
      import {Native as __zyzzNative,NativeStatic as __zyzzNativeStatic} from 'zyzz/runtime';




      import { variants } from 'zyzz'

      export const button = (__zyzzNativeStatic.create({"axes":{"tone":["quiet","loud"]},"defaults":{"tone":"quiet"},"rules":[{"matches":[],"steps":["0"]},{"matches":[["tone",["quiet"]]],"steps":["1"]},{"matches":[["tone",["loud"]]],"steps":["2"]}],"styles":{"0":{"paddingTop":8},"1":{"opacity":0.5},"2":{"opacity":1}}}) as import('zyzz/runtime').Native.Callable<{"tone":readonly ["quiet","loud"]}>)
      "
    `)
    expect(module.output.recipes).toMatchInlineSnapshot(`{}`)
    expect(JSON.parse(module.output.map).sources).toMatchInlineSnapshot(`
      [
        "app/Button.tsx",
      ]
    `)
  })

  test('applies the documented options', () => {
    const label = `import { defineConfig } from 'zyzz'

const { style } = defineConfig({
  vars: { color: { ink: { light: '#171717', dark: '#fafafa' } } },
})

export const label = style({ color: 'ink', fontFamily: 'Geist', padding: '1rem' })
`
    const fixed = Native.compile({
      colorScheme: 'dark',
      fonts: { Geist: 'Geist-Regular' },
      moduleId: 'app/Label.tsx',
      source: label,
      units: { rem: 16 },
    })

    expect(fixed.code.includes('"color":"#fafafa"')).toMatchInlineSnapshot(
      `true`,
    )
    expect(Object.values(fixed.recipes)[0]?.styles).toMatchInlineSnapshot(`
      {
        "default": {
          "dark": {
            "0": {
              "color": "#fafafa",
              "fontFamily": "Geist-Regular",
              "paddingBottom": 16,
              "paddingLeft": 16,
              "paddingRight": 16,
              "paddingTop": 16,
            },
          },
          "light": {
            "0": {
              "color": "#171717",
              "fontFamily": "Geist-Regular",
              "paddingBottom": 16,
              "paddingLeft": 16,
              "paddingRight": 16,
              "paddingTop": 16,
            },
          },
        },
      }
    `)
    expect(
      Native.compile({
        colorScheme: 'light',
        contextual: true,
        fonts: { Geist: 'Geist-Regular' },
        moduleId: 'app/Label.tsx',
        source: label,
        units: { rem: 16 },
      }).code.includes('"dark":'),
    ).toMatchInlineSnapshot(`true`)
    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Label.tsx',
        source: label,
        units: { rem: 16 },
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [StyleSheet.CompileError: ["default","light","0","fontFamily"]: Provide an explicit fonts mapping for this family.
      ["default","dark","0","fontFamily"]: Provide an explicit fonts mapping for this family.]
    `)
    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Label.tsx',
        source: `import { style } from 'zyzz'
export const label = style({ targets: { ios: { opacity: 1 } } })
`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.CompileError: ["0","targets"]: Platform branches require an explicit platform.]`,
    )
  })

  test('labels tables with vars and selects a set', () => {
    const base = defineVars({ color: { ink: '#171717' } })
    const brand = extendVars(base, { color: { ink: '#2563eb' } })
    const source = `import { style } from 'zyzz'
export const label = style({ opacity: 0.5 })
`
    const output = Native.compile({
      colorScheme: 'light',
      moduleId: 'app/Label.tsx',
      set: 'brand',
      source,
      vars: { base, brand },
    })

    expect(Object.keys(Object.values(output.recipes)[0]!.styles))
      .toMatchInlineSnapshot(`
      [
        "base",
        "brand",
      ]
    `)
    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Label.tsx',
        set: 'missing',
        source,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.SelectionError: Select an existing set label and light or dark colorScheme.]`,
    )
  })

  test('labels tables with extracted config scopes', () => {
    const config = `import { defineConfig } from 'zyzz'

const { style } = defineConfig({ vars: { color: { ink: '#171717' } } })

export const label = style({ color: 'ink' })
`
    const extracted = Source.extract({
      moduleId: 'app/Label.tsx',
      source: config,
      target: 'native',
    })

    const output = Native.compile({
      colorScheme: 'light',
      moduleId: 'app/Label.tsx',
      set: Object.keys(extracted.vars)[0]!,
      source: config,
      vars: extracted.vars,
    })

    expect(
      Object.values(output.recipes).map((recipe) => Object.keys(recipe.styles)),
    ).toMatchInlineSnapshot(`
      [
        [
          "src-Label-0_yIk1Y48PY-style-theme",
        ],
      ]
    `)
  })

  test("labels contextual tables with a local config's named sets", () => {
    const source = `import { defineConfig } from 'zyzz'
const { style } = defineConfig({
  defaultVars: 'base',
  vars: { base: { color: { ink: '#000' } }, brand: { color: { ink: '#f00' } } },
})
export const label = style({ color: 'ink' })
`

    const labels = (contextual: boolean) =>
      Object.values(
        Native.compile({
          colorScheme: 'light',
          contextual,
          moduleId: 'app/Label.tsx',
          source,
        }).recipes,
      ).map((recipe) => Object.keys(recipe.styles))

    expect(labels(true)).toMatchInlineSnapshot(`
      [
        [
          "base",
          "brand",
        ],
      ]
    `)
    expect(labels(false)).toMatchInlineSnapshot(`
      [
        [
          "default",
        ],
      ]
    `)
  })

  test("prefers a local config's defaultVars over set in contextual output", async () => {
    const output = Native.compile({
      colorScheme: 'light',
      contextual: true,
      moduleId: 'app/Label.tsx',
      set: 'brand',
      source: `import { defineConfig } from 'zyzz'
const { style } = defineConfig({
  defaultVars: 'base',
  vars: { base: { color: { ink: '#000000' } }, brand: { color: { ink: '#ff0000' } } },
})
export const label = style({ color: 'ink' })
`,
    })
    const module = await load<{ label: () => { style: unknown } }>(output.code)

    expect(
      NativeContext.resolve(module.label().style, { colorScheme: 'light' }),
    ).toMatchInlineSnapshot(`
      {
        "color": "#000000",
      }
    `)
  })

  test('defers set validation in contextual output', async () => {
    const output = Native.compile({
      colorScheme: 'light',
      contextual: true,
      moduleId: 'app/Label.tsx',
      set: 'missing',
      source: `import { style } from 'zyzz'
export const label = style({ opacity: 0.5 })
`,
    })

    expect(output.code.includes('"missing"')).toMatchInlineSnapshot(`true`)

    const module = await load<{ label: () => { style: unknown } }>(output.code)

    expect(() =>
      NativeContext.resolve(module.label().style, { colorScheme: 'light' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Unknown native set: missing.]`,
    )
    expect(
      NativeContext.resolve(module.label().style, {
        colorScheme: 'light',
        set: 'default',
      }),
    ).toMatchInlineSnapshot(`
      {
        "opacity": 0.5,
      }
    `)
  })

  test('compiles useVars arguments to native profiles', async () => {
    const source = await example('namespaces/Native', 'Variable Reads')
    const output = Native.compile({
      colorScheme: 'light',
      moduleId: 'app/Gap.tsx',
      source,
    })

    const profile = output.code.match(
      /__zyzzNativeVars\.create\(JSON\.parse\((".*?")\)\)/,
    )?.[1]

    expect(JSON.parse(JSON.parse(profile ?? '"null"'))).toMatchInlineSnapshot(`
      {
        "defaultVars": "default",
        "profiles": {
          "default": {
            "dark": {
              "spacing": {
                "gap": 4,
              },
            },
            "light": {
              "spacing": {
                "gap": 4,
              },
            },
          },
        },
        "unnamed": true,
      }
    `)
    expect(
      output.code.includes('useVars((__zyzzNativeVars0 as typeof vars))'),
    ).toMatchInlineSnapshot(`true`)
  })

  test('requires contextual output for media queries', () => {
    const source = `import { style } from 'zyzz'
export const panel = style({ opacity: 0.2, '@media (width >= 768px)': { opacity: 0.8 } })
`

    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Panel.tsx',
        source,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.CompileError: ["style-1xdpvwof0zvei-50"]: Selectors, queries, and nested rules are not supported on native.]`,
    )
    expect(
      Native.compile({
        colorScheme: 'light',
        contextual: true,
        moduleId: 'app/Panel.tsx',
        source,
      }).recipes,
    ).toMatchInlineSnapshot(`{}`)
  })

  test('accepts appearance and script reads only in contextual output', () => {
    const source = `import { defineConfig } from 'zyzz'

const { appearance, script, style } = defineConfig({
  vars: { color: { ink: { light: '#171717', dark: '#fafafa' } } },
})

export const label = style({ color: 'ink' })
`

    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Label.tsx',
        source,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native static modules do not support CSS contributions, variables, or web set controls.]`,
    )
    expect(
      typeof Native.compile({
        colorScheme: 'light',
        contextual: true,
        moduleId: 'app/Label.tsx',
        source,
      }).code,
    ).toMatchInlineSnapshot(`"string"`)
  })

  test('defers payload errors in contextual output', async () => {
    const output = Native.compile({
      colorScheme: 'light',
      contextual: true,
      moduleId: 'app/Bar.tsx',
      source: `import { style } from 'zyzz'
export const bar = style((values: { alpha: number }) => ({ opacity: values.alpha }))
`,
    })
    const module = await load<{
      bar: (values: { alpha: number }) => { style: unknown }
    }>(output.code)
    const props = module.bar({} as never)

    expect(() =>
      NativeContext.resolve(props.style, { colorScheme: 'light' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Missing or invalid native payload: alpha.]`,
    )
  })

  test('runs the compiled callables', async () => {
    const source = await example('namespaces/Native', 'Callables')
    const output = Native.compile({
      colorScheme: 'light',
      moduleId: 'app/Button.tsx',
      source: exported(source),
    })
    const module = await load<{
      bar: (values: { alpha: number }) => unknown
      button: (options?: object) => unknown
    }>(output.code)

    expect(module.button({ tone: 'loud' })).toMatchInlineSnapshot(`
      {
        "style": {
          "opacity": 1,
          "paddingTop": 8,
        },
      }
    `)
    expect(module.button({ tone: null })).toMatchInlineSnapshot(`
      {
        "style": {
          "paddingTop": 8,
        },
      }
    `)
    expect(module.button({ style: { marginTop: 4 } })).toMatchInlineSnapshot(`
      {
        "style": [
          {
            "opacity": 0.5,
            "paddingTop": 8,
          },
          {
            "marginTop": 4,
          },
        ],
      }
    `)
    expect(module.bar({ alpha: 0.25 })).toMatchInlineSnapshot(`
      {
        "style": {
          "opacity": 0.25,
        },
      }
    `)
    expect(() => module.bar({} as never)).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Missing or invalid native payload: alpha.]`,
    )
  })

  test('throws the documented errors', async () => {
    const compile = templates(
      await example('namespaces/Native', 'Native.CompileError'),
    )
    const styleSheet = templates(
      await example('namespaces/Native', 'StyleSheet.CompileError'),
    )

    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/global.ts',
        source: compile.source!,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native static modules do not support CSS contributions, variables, or web set controls.]`,
    )
    expect(() =>
      Native.compile({
        colorScheme: 'light',
        moduleId: 'app/Card.tsx',
        source: styleSheet.source!,
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [StyleSheet.CompileError: ["default","light","0","padding"]: Provide units.rem for rem lengths.
      ["default","dark","0","padding"]: Provide units.rem for rem lengths.]
    `)
  })
})

describe('compiler API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      [
        '../compiler',
        'namespaces/Graph',
        'namespaces/Native',
        'namespaces/Source',
        'namespaces/Transform',
      ].map((page) => examples(page)),
    )
    const files = await Promise.all(
      pages
        .flat()
        .filter((entry) => entry.source.includes('import '))
        .map(async (entry, index) => {
          const directory = Path.join(root, 'types', String(index))
          const file = Path.join(directory, entry.name ?? 'Example.tsx')
          await Fs.mkdir(directory, { recursive: true })
          await Fs.writeFile(file, entry.source)
          return file
        }),
    )

    const checked = ChildProcess.spawnSync(
      process.execPath,
      [
        Path.join(
          Path.dirname(require.resolve('typescript/package.json')),
          'bin/tsc',
        ),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--exactOptionalPropertyTypes',
        '--noUncheckedIndexedAccess',
        '--skipLibCheck',
        '--jsx',
        'react-jsx',
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        // Error examples import `zyzz/react-native` as Metro resolves it.
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        ...files,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30000 },
    )

    expect(files.length).toMatchInlineSnapshot(`26`)
    // The diagnostics are empty when every example type-checks.
    expect(checked.stdout + checked.stderr).toMatchInlineSnapshot(`""`)
    expect(checked.status).toMatchInlineSnapshot(`0`)
  }, 60_000)
})
