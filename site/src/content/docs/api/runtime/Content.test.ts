/** Runs and type-checks the runtime API reference examples against the real runtime helpers. @module */
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import type { style, variable } from 'zyzz'
import {
  Appearance,
  Composition,
  CompositionHtml,
  ConditionalRecipe,
  Html,
  Native,
  NativeContext,
  NativeDynamic,
  NativeStatic,
  NativeVars,
  PayloadRecipe,
  Props,
  Recipe,
  Selection,
} from 'zyzz/runtime'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
let root = ''

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-runtime-api-'))
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

/** Reads a page's importing examples in order, optionally from one section. */
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
  ).filter((example) => example.source.includes('import '))
}

/** Imports a page's first example, exporting its module-level `const` declarations as the bindings `module` names. */
async function load<module>(page: string): Promise<module> {
  const [example] = await examples(page)
  const directory = await Fs.mkdtemp(Path.join(root, 'load-'))
  const file = Path.join(directory, example!.name!)
  await Fs.writeFile(
    file,
    example!.source.replace(/^const /gm, 'export const '),
  )

  return import(file)
}

describe('Props API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{ card: style.ReturnType; props: style.Props }>(
      'namespaces/Props',
    )

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-card wide",
        "style": {
          "padding": "24px",
        },
      }
    `)
    expect(example.card()).toMatchInlineSnapshot(`
      {
        "className": "z-card",
      }
    `)
    expect(example.card({ vars: { '--accent': 'crimson' } }))
      .toMatchInlineSnapshot(`
      {
        "className": "z-card",
        "style": {
          "--accent": "crimson",
        },
      }
    `)
  })

  test('returns the supplied style object without vars', () => {
    const card = Props.create({ className: 'z-card' })
    const style = { padding: '24px' }

    expect(card({ style }).style === style).toMatchInlineSnapshot(`true`)
  })
})

describe('Dynamic API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      meter: style.Dynamic<{ amount: string }>
      props: style.Props
    }>('namespaces/Dynamic')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-meter",
        "style": {
          "--meter-amount": "50%",
        },
      }
    `)
    expect(example.meter({ amount: '' }).style).toMatchInlineSnapshot(`
      {
        "--meter-amount": " ",
      }
    `)
    expect(
      example.meter({
        amount: '50%',
        style: { '--meter-amount': '10%', opacity: 0.5 },
      }).style,
    ).toMatchInlineSnapshot(`
      {
        "--meter-amount": "50%",
        "opacity": 0.5,
      }
    `)
    expect(
      example.meter({ amount: '50%', className: 'wide' }).className,
    ).toMatchInlineSnapshot(`"z-meter wide"`)
  })
})

describe('Recipe API page', () => {
  test('returns class and rejects unstringifiable choices', () => {
    const button = Recipe.create({
      axes: { size: ['small'] },
      className: 'z-button',
      defaults: {},
    })

    expect(
      Recipe.create({
        axes: {},
        className: 'z-button',
        defaults: {},
        html: true,
      })(),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-button",
      }
    `)
    expect(() =>
      button({ size: Object.create(null) }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot convert object to primitive value]`,
    )
  })

  test('applies the overview example', async () => {
    const example = await load<{
      button: ReturnType<typeof Recipe.create>
      props: unknown
    }>('namespaces/Recipe')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-button",
        "data-size": "large",
      }
    `)
    expect(example.button({ size: null })).toMatchInlineSnapshot(`
      {
        "className": "z-button",
      }
    `)
    expect(example.button({ style: { padding: '24px' } }).style)
      .toMatchInlineSnapshot(`
      {
        "padding": "24px",
      }
    `)
  })

  test('returns HTML attributes and boolean choices as strings', () => {
    expect(
      Recipe.create({
        axes: { size: ['small'] },
        className: 'z-button',
        defaults: { size: 'small' },
        html: true,
      })(),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-button",
        "data-size": "small",
      }
    `)
    expect(
      Recipe.create({
        axes: { active: ['true', 'false'] },
        className: 'z-button',
        defaults: {},
      })({ active: true }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-button",
        "data-active": "true",
      }
    `)
  })
})

describe('ConditionalRecipe API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      button: ReturnType<typeof ConditionalRecipe.create>
      props: unknown
    }>('namespaces/ConditionalRecipe')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-button",
        "data-size": "small",
        "data-zyzz-condition-0-size": "slarge",
      }
    `)
    expect(
      example.button({ size: 'large', conditions: { wide: { size: null } } }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-button",
        "data-size": "large",
        "data-zyzz-condition-0-size": "n",
      }
    `)
    expect(
      example.button({
        style: { padding: '24px' },
        vars: { '--accent': 'crimson' },
      }).style,
    ).toMatchInlineSnapshot(`
      {
        "--accent": "crimson",
        "padding": "24px",
      }
    `)
  })

  test('names conditional attributes by condition index', () => {
    expect(
      ConditionalRecipe.attribute({ axis: 'size', condition: 1 }),
    ).toMatchInlineSnapshot(`"data-zyzz-condition-1-size"`)
  })

  test('throws for a conditional value without a string form', () => {
    const button = ConditionalRecipe.create({
      axes: { size: ['small', 'large'] },
      className: 'z-button',
      conditions: ['wide'],
      defaults: {},
    })

    expect(() =>
      button({ conditions: { wide: { size: Symbol('large') } } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot convert a Symbol value to a string]`,
    )
  })

  test('skips undefined conditions', () => {
    const button = ConditionalRecipe.create({
      axes: { size: ['small', 'large'] },
      className: 'z-button',
      conditions: ['wide'],
      defaults: {},
    })

    expect(button({ conditions: { wide: undefined } })).toMatchInlineSnapshot(`
      {
        "className": "z-button",
      }
    `)
  })

  test('returns class for HTML output', () => {
    expect(
      ConditionalRecipe.create({
        axes: {},
        className: 'z-button',
        conditions: ['wide'],
        defaults: {},
        html: true,
      })(),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-button",
      }
    `)
  })
})

describe('PayloadRecipe API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      box: ReturnType<typeof PayloadRecipe.create>
      props: unknown
    }>('namespaces/PayloadRecipe')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-box",
        "data-size": "custom",
        "style": {
          "--box-padding": "12px",
        },
      }
    `)
    expect(example.box({ size: 'fixed' })).toMatchInlineSnapshot(`
      {
        "className": "z-box",
        "data-size": "fixed",
      }
    `)
    expect(example.box({ className: 'wide' })).toMatchInlineSnapshot(`
      {
        "className": "z-box wide",
      }
    `)
    expect(
      example.box({
        size: { custom: { padding: '12px' } },
        vars: { '--accent': 'crimson' },
      }).style,
    ).toMatchInlineSnapshot(`
      {
        "--accent": "crimson",
        "--box-padding": "12px",
      }
    `)
    expect(
      example.box({
        size: { custom: { padding: '12px' } },
        style: { '--box-padding': '0px' },
      }).style,
    ).toMatchInlineSnapshot(`
      {
        "--box-padding": "12px",
      }
    `)
  })

  test('binds default and conditional payload slots', () => {
    const definition = {
      axes: { size: ['custom', 'fixed'] },
      conditions: ['wide'],
      defaults: { size: 'custom' },
    }
    const box = PayloadRecipe.create({
      ...definition,
      defaultPayloads: { size: { padding: '4px' } },
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }, { padding: '--box-wide' }],
        },
      ],
      select: ConditionalRecipe.create({ ...definition, className: 'z-box' }),
    })

    expect(box()).toMatchInlineSnapshot(`
      {
        "className": "z-box",
        "data-size": "custom",
        "style": {
          "--box-padding": "4px",
        },
      }
    `)
    expect(
      box({ conditions: { wide: { size: { custom: { padding: '20px' } } } } }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-box",
        "data-size": "custom",
        "data-zyzz-condition-0-size": "scustom",
        "style": {
          "--box-padding": "4px",
          "--box-wide": "20px",
        },
      }
    `)
  })

  test('throws for a choice without a slot record', () => {
    const definition = { axes: { size: ['custom'] }, defaults: {} }
    const box = PayloadRecipe.create({
      ...definition,
      payloads: [{ axis: 'size', choice: 'custom', slots: [] }],
      select: Recipe.create({ ...definition, className: 'z-box' }),
    })

    expect(() =>
      box({ size: { custom: { padding: '12px' } } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot convert undefined or null to object]`,
    )
  })

  test('reads only the first key of a dynamic selection', () => {
    const definition = { axes: { size: ['custom', 'other'] }, defaults: {} }
    const box = PayloadRecipe.create({
      ...definition,
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }],
        },
        { axis: 'size', choice: 'other', slots: [{ padding: '--box-other' }] },
      ],
      select: Recipe.create({ ...definition, className: 'z-box' }),
    })

    expect(
      box({
        size: { custom: { padding: '12px' }, other: { padding: '4px' } },
      }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-box",
        "data-size": "custom",
        "style": {
          "--box-padding": "12px",
        },
      }
    `)
  })

  test('throws for a null field record', () => {
    const definition = { axes: { size: ['custom'] }, defaults: {} }
    const box = PayloadRecipe.create({
      ...definition,
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }],
        },
      ],
      select: Recipe.create({ ...definition, className: 'z-box' }),
    })

    expect(() =>
      box({ size: { custom: null } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot read properties of null (reading 'padding')]`,
    )
  })

  test('skips undefined conditions and misreads an HTML delegate', () => {
    const definition = {
      axes: { size: ['custom'] },
      conditions: ['wide'],
      defaults: {},
    }
    const payloads: readonly Recipe.Payload[] = [
      {
        axis: 'size',
        choice: 'custom',
        slots: [{ padding: '--box-padding' }, { padding: '--box-wide' }],
      },
    ]
    const box = PayloadRecipe.create({
      ...definition,
      payloads,
      select: Recipe.create({ ...definition, className: 'z-box' }),
    })
    const html = PayloadRecipe.create({
      ...definition,
      payloads,
      select: Recipe.create({ ...definition, className: 'z-box', html: true }),
    })

    expect(box({ conditions: { wide: undefined } })).toMatchInlineSnapshot(`
      {
        "className": "z-box",
      }
    `)
    expect(html({ size: { custom: { padding: '1px' } } }))
      .toMatchInlineSnapshot(`
      {
        "class": "z-box",
        "data-size": "custom",
        "style": {
          "--box-padding": "1px",
        },
      }
    `)
  })

  test('returns class and rejects unstringifiable HTML fields', () => {
    const definition = { axes: { size: ['custom'] }, defaults: {} }
    const payloads: readonly Recipe.Payload[] = [
      { axis: 'size', choice: 'custom', slots: [{ padding: '--box-padding' }] },
    ]
    const box = PayloadRecipe.create({
      ...definition,
      html: true,
      payloads,
      select: Recipe.create({ ...definition, className: 'z-box' }),
    })

    expect(box()).toMatchInlineSnapshot(`
      {
        "class": "z-box",
      }
    `)
    expect(() =>
      box({ size: { custom: { padding: Symbol('padding') } } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot convert a Symbol value to a string]`,
    )
  })
})

describe('Composition API page', () => {
  test('falls back to className for a mask without a case', () => {
    const compose = Composition.create({
      cases: ['z-card-only'],
      className: 'z-card-button',
      inputs: [
        { className: 'z-card' },
        { className: 'z-button', condition: 0 },
      ],
    })

    expect(compose({ className: 'z-card' }, { className: 'z-button' }))
      .toMatchInlineSnapshot(`
      {
        "className": "z-card-button",
      }
    `)
  })

  test('applies the overview example', async () => {
    const example = await load<{
      compose: ReturnType<typeof Composition.create>
      props: unknown
    }>('namespaces/Composition')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-card-button wide",
        "data-size": "large",
      }
    `)
    expect(
      Object.entries(
        example.compose(
          { className: 'z-card', style: { color: 'blue', padding: '8px' } },
          { className: 'z-button', style: { color: 'red' } },
        ).style ?? {},
      ),
    ).toMatchInlineSnapshot(`
      [
        [
          "padding",
          "8px",
        ],
        [
          "color",
          "red",
        ],
      ]
    `)
  })
})

describe('Html API page', () => {
  test('renders the overview example', async () => {
    const example = await load<{ attributes: Html.Attributes; markup: string }>(
      'namespaces/Html',
    )

    expect(example.attributes).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "data-state": "open",
        "style": "background-color:red",
      }
    `)
    expect(example.markup).toMatchInlineSnapshot(
      `"<article class="z-card" style="background-color:red" data-state="open"></article>"`,
    )
  })

  test('converts and escapes attributes', () => {
    expect(
      Html.from({
        className: 'z-card',
        style: { color: 'red', msTransform: 'none', '--x': '1' },
      }).style,
    ).toMatchInlineSnapshot(`"color:red;-ms-transform:none;--x:1"`)
    expect(
      Html.serialize({ class: 'z-card wide', 'data-x': "it's" }),
    ).toMatchInlineSnapshot(`"class="z-card&#32;wide" data-x="it&#39;s""`)
    expect(Html.create({ className: 'z-card' })({ style: { padding: '1rem' } }))
      .toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "padding:1rem",
      }
    `)
  })

  test('applies Html.create overrides', () => {
    const card = Html.create({ className: 'z-card' })

    expect(card({ className: 'wide' })).toMatchInlineSnapshot(`
      {
        "class": "z-card wide",
      }
    `)
    expect(card({ vars: { '--accent': 'crimson' } })).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "--accent:crimson",
      }
    `)
    expect(
      card({ style: { padding: '24px' }, vars: { '--accent': 'crimson' } }),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "--accent:crimson;padding:24px",
      }
    `)
  })

  test('returns attributes from Html.bind', () => {
    const html = Html.bind(Props.create({ className: 'z-card' }))
    // Generated code binds the callable created with HTML output disabled
    const button = Recipe.create({
      axes: { size: ['large'] },
      className: 'z-button',
      defaults: { size: 'large' },
    }) as (input?: style.Options) => style.Props

    expect(html({ className: 'wide' })).toMatchInlineSnapshot(`
      {
        "class": "z-card wide",
      }
    `)
    expect(html({ style: { padding: '1rem' } })).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "padding:1rem",
      }
    `)
    expect(Html.bind(button)({})).toMatchInlineSnapshot(`
      {
        "class": "z-button",
        "data-size": "large",
      }
    `)
  })
})

describe('CompositionHtml API page', () => {
  test('returns serialized attributes from bind', () => {
    const card = CompositionHtml.bind(Props.create({ className: 'z-card' }))
    const button = Recipe.create({
      axes: { size: ['large'] },
      className: 'z-button',
      defaults: { size: 'large' },
    })

    expect(card()).toMatchInlineSnapshot(`
      {
        "class": "z-card",
      }
    `)
    expect(card({ style: { padding: '1rem' } })).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "padding:1rem",
      }
    `)
    expect(CompositionHtml.bind(button)()).toMatchInlineSnapshot(`
      {
        "class": "z-button",
        "data-size": "large",
      }
    `)
  })

  test('returns serialized attributes from create', () => {
    const card = CompositionHtml.bind(Props.create({ className: 'z-card' }))
    const button = CompositionHtml.bind(
      Recipe.create({
        axes: { size: ['large'] },
        className: 'z-button',
        defaults: { size: 'large' },
      }),
    )
    const compose = CompositionHtml.create({
      className: 'z-card-composed',
      inputs: [{ className: 'z-card' }],
    })

    expect(compose(card({ style: { padding: '1rem' } })))
      .toMatchInlineSnapshot(`
      {
        "class": "z-card-composed",
        "style": "padding:1rem",
      }
    `)
    expect(
      CompositionHtml.create({
        className: 'z-button',
        inputs: [{ className: 'z-button' }],
      })(button()),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-button",
        "data-size": "large",
      }
    `)
  })

  test('returns attributes from CompositionHtml.from', () => {
    expect(
      CompositionHtml.from({ className: 'z-card', style: { padding: '1rem' } }),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-card",
        "style": "padding:1rem",
      }
    `)
    expect(
      CompositionHtml.from({ className: 'z-button', 'data-size': 'large' }),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-button",
        "data-size": "large",
      }
    `)
  })

  test('composes the overview example', async () => {
    const example = await load<{ attributes: Html.Attributes }>(
      'namespaces/CompositionHtml',
    )

    expect(example.attributes).toMatchInlineSnapshot(`
      {
        "class": "z-card-composed",
        "style": "padding:1rem",
      }
    `)
  })

  test('ignores attributes without retained props', () => {
    const compose = CompositionHtml.create({
      className: 'z-card-composed',
      inputs: [{ className: 'z-card' }],
    })

    expect(
      Object.getOwnPropertySymbols(
        CompositionHtml.from({ className: 'z-card' }),
      ),
    ).toMatchInlineSnapshot(`
      [
        Symbol(zyzz.composition.input.v1),
      ]
    `)
    expect(compose(Html.from({ className: 'z-card' }))).toMatchInlineSnapshot(`
      {
        "class": "z-card-composed",
      }
    `)
  })

  test('reads HTML-returning callables as React-shaped props', () => {
    const card = CompositionHtml.bind(Html.create({ className: 'z-card' }))
    const compose = CompositionHtml.create({
      className: 'z-card-composed',
      inputs: [{ className: 'z-card' }],
    })

    expect(card()).toMatchInlineSnapshot(`
      {
        "class": undefined,
      }
    `)
    expect(() => compose(card())).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Cannot read properties of undefined (reading 'split')]`,
    )
  })
})

describe('Selection API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      props: unknown
      vars: Selection.create.ReturnType<'base' | 'mint'>
    }>('namespaces/Selection')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "className": "z-theme-mint z_scheme-dark",
        "style": {
          "colorScheme": "dark",
        },
      }
    `)
    expect(example.vars({ set: 'base' })).toMatchInlineSnapshot(`
      {
        "className": "z-theme-base",
      }
    `)
    expect(() =>
      example.vars({ set: 'missing' } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Invalid variable selection.]`,
    )
  })

  test('returns HTML attributes and selects a default set', () => {
    const entries = [['base', 'z-theme-base']] as const

    expect(
      Selection.create(
        entries,
        true,
      )({
        set: 'base',
        colorScheme: 'light dark',
      }),
    ).toMatchInlineSnapshot(`
      {
        "class": "z-theme-base z_scheme-light-dark",
        "style": "color-scheme:light dark",
      }
    `)
    expect(
      Selection.create(entries, false, 'set', 'base')({ colorScheme: 'dark' }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-theme-base z_scheme-dark",
        "style": {
          "colorScheme": "dark",
        },
      }
    `)
    expect(
      Selection.create([['mint', 'z-theme-mint']], true)({ set: 'mint' }).class,
    ).toMatchInlineSnapshot(`"z-theme-mint"`)
    expect(
      Selection.create(
        [['mint', 'z-theme-mint']],
        true,
      )({
        colorScheme: 'dark',
        set: 'mint',
      }).style,
    ).toMatchInlineSnapshot(`"color-scheme:dark"`)
  })
})

describe('Appearance API page', () => {
  test('restores and persists the root selection in Chromium', async () => {
    const [example] = await examples('namespaces/Appearance')
    const loaded = await load<{ script: () => string }>('namespaces/Appearance')
    const bundle = await Esbuild.build({
      stdin: { contents: example!.source, loader: 'ts', resolveDir: project },
      alias: { 'zyzz/runtime': Path.join(project, 'src/runtime/index.ts') },
      bundle: true,
      format: 'iife',
      globalName: 'Example',
      write: false,
    })
    const markup = `<!doctype html><html class="external z-theme-base"><head><script>${loaded.script()}</script><script>${bundle.outputFiles[0]!.text}</script></head><body></body></html>`
    const server = Http.createServer((_, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(markup)
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      browser = await chromium.launch({ headless: true })
      const page = await browser.newPage()
      await page.goto(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      )

      expect(await page.evaluate('Example.appearance.get()'))
        .toMatchInlineSnapshot(`
        {
          "set": "base",
        }
      `)

      await page.evaluate(
        "Example.appearance.set({ colorScheme: 'dark', set: 'mint' })",
      )

      expect(
        await page.evaluate("localStorage.getItem('theme')"),
      ).toMatchInlineSnapshot(`"{"set":"mint","colorScheme":"dark"}"`)

      // The inline script restores the saved record on the next load.
      await page.reload()

      expect(
        await page.evaluate('document.documentElement.className'),
      ).toMatchInlineSnapshot(`"external z-theme-mint z_scheme-dark"`)
      expect(
        await page.evaluate(
          'getComputedStyle(document.documentElement).colorScheme',
        ),
      ).toMatchInlineSnapshot(`"dark"`)

      await page.evaluate('Example.appearance.set({ colorScheme: undefined })')
      await page.reload()

      expect(
        await page.evaluate('document.documentElement.className'),
      ).toMatchInlineSnapshot(`"external z-theme-mint"`)
      expect(
        await page.evaluate(
          "(() => { try { Example.appearance.set({ set: 'missing' }) } catch (error) { return String(error) } })()",
        ),
      ).toMatchInlineSnapshot(`"TypeError: Invalid set selection."`)
    } finally {
      await browser?.close()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  test('requires a default set for a named catalog', () => {
    expect(() =>
      Appearance.root([['mint', 'z-theme-mint']]),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: defaultVars must name a catalog set.]`,
    )
  })
})

describe('Variable API page', () => {
  test('creates the overview reference', async () => {
    const example = await load<{
      accent: variable.Reference<'color'>
      assignment: unknown
    }>('namespaces/Variable')

    expect(String(example.accent)).toMatchInlineSnapshot(`"--accent"`)
    expect(example.assignment).toMatchInlineSnapshot(`
      {
        "--accent": "crimson",
      }
    `)
    expect(Object.isFrozen(example.assignment)).toMatchInlineSnapshot(`true`)
    expect({ [example.accent]: 'red' }).toMatchInlineSnapshot(`
      {
        "--accent": "red",
      }
    `)
  })
})

describe('Native API page', () => {
  test('drops a falsy style override', () => {
    const card = Native.create({
      axes: {},
      defaults: {},
      styles: { 0: { padding: 4 } },
    })

    expect(card({ style: false })).toMatchInlineSnapshot(`
      {
        "style": {
          "padding": 4,
        },
      }
    `)
    expect(card({ style: null })).toMatchInlineSnapshot(`
      {
        "style": {
          "padding": 4,
        },
      }
    `)
  })

  test('applies the overview example', async () => {
    const example = await load<{
      badge: Native.Callable<{ size: readonly ['small', 'large'] }>
      props: unknown
    }>('namespaces/Native')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "style": {
          "padding": 8,
        },
      }
    `)
    expect(example.badge({ size: null })).toMatchInlineSnapshot(`
      {
        "style": {},
      }
    `)
    expect(example.badge({ style: { opacity: 0.5 } })).toMatchInlineSnapshot(`
      {
        "style": [
          {
            "padding": 4,
          },
          {
            "opacity": 0.5,
          },
        ],
      }
    `)
    expect(
      Native.compose(example.badge(), false, example.badge({ size: 'large' })),
    ).toMatchInlineSnapshot(`
      {
        "style": [
          {
            "padding": 4,
          },
          {
            "padding": 8,
          },
        ],
      }
    `)
    expect(() =>
      example.badge({ size: 'huge' } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Unknown native recipe choice for size.]`,
    )
  })

  test('keeps a single composed entry by reference', async () => {
    const example = await load<{
      badge: Native.Callable<{ size: readonly ['small', 'large'] }>
    }>('namespaces/Native')

    expect(
      Native.compose(example.badge(), false).style === example.badge().style,
    ).toMatchInlineSnapshot(`true`)
  })

  test('returns one frozen object for a table without axes', () => {
    const card = Native.create({
      axes: {},
      defaults: {},
      styles: { 0: { padding: 8 } },
    })

    expect(card() === card()).toMatchInlineSnapshot(`true`)
  })
})

describe('NativeStatic API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      props: unknown
      text: Native.Callable<{ size: readonly ['small', 'large'] }>
    }>('namespaces/NativeStatic')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "style": {
          "fontSize": 20,
          "lineHeight": 25,
        },
      }
    `)
    expect(example.text().style).toMatchInlineSnapshot(`
      {
        "fontSize": 16,
        "lineHeight": 20,
      }
    `)
    expect(example.text().style === example.text().style).toMatchInlineSnapshot(
      `true`,
    )
    expect(example.text({ size: null })).toMatchInlineSnapshot(`
      {
        "style": {
          "fontSize": 16,
          "lineHeight": 20,
        },
      }
    `)
    expect(example.text({ size: 'large', style: { opacity: 0.5 } }))
      .toMatchInlineSnapshot(`
      {
        "style": [
          {
            "fontSize": 20,
            "lineHeight": 25,
          },
          {
            "opacity": 0.5,
          },
        ],
      }
    `)
  })

  test('rejects a rule that names a missing fragment', () => {
    expect(() =>
      NativeStatic.create({
        axes: {},
        defaults: {},
        rules: [{ matches: [], steps: ['base'] }],
        styles: {},
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Native binding program is missing a static style.]`,
    )
  })
})

describe('NativeDynamic API page', () => {
  test('applies the overview example', async () => {
    const example = await load<{
      meter: NativeDynamic.Callable<{ width: string }>
      props: unknown
    }>('namespaces/NativeDynamic')

    expect(example.props).toMatchInlineSnapshot(`
      {
        "style": {
          "width": 12,
        },
      }
    `)
    expect(example.meter({ width: '50%' })).toMatchInlineSnapshot(`
      {
        "style": {
          "width": "50%",
        },
      }
    `)
    expect(example.meter({ width: '12px', style: { opacity: 0.5 } }))
      .toMatchInlineSnapshot(`
      {
        "style": [
          {
            "width": 12,
          },
          {
            "opacity": 0.5,
          },
        ],
      }
    `)
    expect(() => example.meter({} as never)).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Missing or invalid native payload: width.]`,
    )
  })

  test('binds payloads and converts units', () => {
    const box = NativeDynamic.create({
      axes: { size: ['custom', 'fixed'] },
      defaults: {},
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }],
        },
      ],
      program: {
        rules: [
          {
            matches: [['size', ['custom']]],
            steps: [
              { parts: [{ slot: '--box-padding' }], property: 'padding' },
            ],
          },
          { matches: [['size', ['fixed']]], steps: [{ style: 'fixed' }] },
        ],
        slots: {},
      },
      styles: { fixed: { padding: 0 } },
      units: { rem: 16 },
    })

    expect(box({ size: { custom: { padding: '1rem 12px' } } }))
      .toMatchInlineSnapshot(`
      {
        "style": {
          "paddingBottom": 16,
          "paddingLeft": 12,
          "paddingRight": 12,
          "paddingTop": 16,
        },
      }
    `)
    expect(box({ size: 'fixed' })).toMatchInlineSnapshot(`
      {
        "style": {
          "padding": 0,
        },
      }
    `)
  })

  test('rejects a line-height multiplier without a font size', () => {
    const text = NativeDynamic.create({
      axes: {},
      defaults: {},
      program: {
        rules: [
          {
            matches: [],
            steps: [
              {
                parts: [{ number: true, slot: '--text-leading' }],
                property: 'lineHeight',
              },
            ],
          },
        ],
        slots: { leading: '--text-leading' },
      },
      styles: {},
    }) as unknown as (input: { leading: number }) => unknown

    expect(() => text({ leading: 1.5 })).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Numeric lineHeight requires an explicit fontSize and a nonnegative finite multiplier.]`,
    )
  })

  test('expands gap and rejects nonfinite fields', () => {
    const grid = NativeDynamic.create({
      axes: {},
      defaults: {},
      program: {
        rules: [
          {
            matches: [],
            steps: [{ parts: [{ slot: '--grid-gap' }], property: 'gap' }],
          },
        ],
        slots: { gap: '--grid-gap' },
      },
      styles: {},
    }) as unknown as (input: { gap: number | string }) => unknown

    expect(grid({ gap: '8px' })).toMatchInlineSnapshot(`
      {
        "style": {
          "columnGap": 8,
          "rowGap": 8,
        },
      }
    `)
    expect(() => grid({ gap: Number.NaN })).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Missing or invalid native payload: gap.]`,
    )
  })

  test('assigns flex: 0 for a bound flex value', () => {
    const row = NativeDynamic.create({
      axes: {},
      defaults: {},
      program: {
        rules: [
          {
            matches: [],
            steps: [{ parts: [{ slot: '--row-flex' }], property: 'flex' }],
          },
        ],
        slots: { flex: '--row-flex' },
      },
      styles: {},
    }) as unknown as (input: { flex: string }) => unknown

    expect(row({ flex: '1 0 auto' })).toMatchInlineSnapshot(`
      {
        "style": {
          "flex": 0,
        },
      }
    `)
  })

  test('requires exactly one choice in a payload object', () => {
    const box = NativeDynamic.create({
      axes: { size: ['custom', 'other'] },
      defaults: {},
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }],
        },
      ],
      program: { rules: [], slots: {} },
      styles: {},
    }) as unknown as (input: { size: object }) => unknown

    expect(() => box({ size: {} })).toThrowErrorMatchingInlineSnapshot(
      `[Native.SelectionError: Native payloads require exactly one choice.]`,
    )
  })

  test('ignores options.conditions', () => {
    const definition = {
      axes: { size: ['custom'] },
      defaults: {},
      payloads: [
        {
          axis: 'size',
          choice: 'custom',
          slots: [{ padding: '--box-padding' }, { padding: '--box-wide' }],
        },
      ] satisfies readonly Recipe.Payload[],
      program: {
        rules: [
          {
            matches: [],
            steps: [
              { parts: [{ slot: '--box-padding' }], property: 'padding' },
            ],
          },
        ],
        slots: {},
      },
      styles: {},
    } as const
    const plain = NativeDynamic.create(definition) as unknown as (
      input: object,
    ) => unknown
    const conditional = NativeDynamic.create({
      ...definition,
      conditions: ['wide'],
    }) as unknown as (input: object) => unknown

    expect(plain({ size: { custom: { padding: '4px' } } }))
      .toMatchInlineSnapshot(`
      {
        "style": {
          "paddingBottom": 4,
          "paddingLeft": 4,
          "paddingRight": 4,
          "paddingTop": 4,
        },
      }
    `)
    expect(conditional({ size: { custom: { padding: '4px' } } }))
      .toMatchInlineSnapshot(`
      {
        "style": {
          "paddingBottom": 4,
          "paddingLeft": 4,
          "paddingRight": 4,
          "paddingTop": 4,
        },
      }
    `)
  })

  test('scales px lengths by units.px', () => {
    const box = NativeDynamic.create({
      axes: {},
      defaults: {},
      program: {
        rules: [
          {
            matches: [],
            steps: [{ parts: [{ slot: '--box-width' }], property: 'width' }],
          },
        ],
        slots: { width: '--box-width' },
      },
      styles: {},
      units: { px: 2 },
    }) as unknown as (input: { width: string }) => unknown

    expect(box({ width: '4px' })).toMatchInlineSnapshot(`
      {
        "style": {
          "width": 8,
        },
      }
    `)
  })
})

describe('NativeContext API page', () => {
  test('resolves the overview example', async () => {
    const example = await load<{ ink: Native.Callable<{}>; style: unknown }>(
      'namespaces/NativeContext',
    )

    expect(example.style).toMatchInlineSnapshot(`
      {
        "color": "#fafafa",
      }
    `)
    expect(example.ink() === example.ink()).toMatchInlineSnapshot(`true`)
    expect(
      NativeContext.resolve([example.ink().style, { opacity: 0.5 }], {
        colorScheme: 'dark',
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "color": "#fafafa",
        },
        {
          "opacity": 0.5,
        },
      ]
    `)
    expect(
      NativeContext.resolve(NativeContext.application(example.ink), {
        colorScheme: 'dark',
      }),
    ).toMatchInlineSnapshot(`
      {
        "color": "#fafafa",
      }
    `)
    expect(
      NativeContext.key(example.ink(), { colorScheme: 'dark' }).length,
    ).toMatchInlineSnapshot(`1`)
    expect(
      NativeContext.key({ color: 'red' }, { colorScheme: 'dark' }),
    ).toMatchInlineSnapshot(`[]`)
    expect(() =>
      NativeContext.resolve(example.ink().style, undefined),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Compiled native styles require a Zyzz Provider.]`,
    )
  })

  test('passes application input to the selected table', () => {
    const table = (padding: number) =>
      Native.create({
        axes: { size: ['small', 'large'] },
        defaults: { size: 'small' },
        styles: { 0: { padding }, 1: { padding: padding * 2 }, 2: {} },
      })
    const badge = NativeContext.create(
      { base: { dark: table(4), light: table(3) } },
      'base',
    )

    expect(
      NativeContext.resolve(badge, { colorScheme: 'dark' }, { size: 'large' }),
    ).toMatchInlineSnapshot(`
      {
        "padding": 8,
      }
    `)
    expect(
      NativeContext.resolve(
        NativeContext.application(badge, { size: 'large' }),
        { colorScheme: 'light' },
      ),
    ).toMatchInlineSnapshot(`
      {
        "padding": 6,
      }
    `)
  })

  test('resolves array entries without application input', () => {
    const table = Native.create({
      axes: { size: ['small', 'large'] },
      defaults: { size: 'small' },
      styles: { 0: { padding: 4 }, 1: { padding: 8 }, 2: {} },
    })
    const badge = NativeContext.create(
      { base: { dark: table, light: table } },
      'base',
    )

    expect(
      NativeContext.resolve(
        [badge],
        { colorScheme: 'dark' },
        { size: 'large' },
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "padding": 4,
        },
      ]
    `)
  })

  test('selects media alternatives from the viewport', () => {
    const table = (padding: number) =>
      Native.create({ axes: {}, defaults: {}, styles: { 0: { padding } } })
    const box = NativeContext.responsive(
      [{ kind: 'compare', left: 'width', operator: '>=', right: 600 }],
      {
        0: NativeContext.create(
          { default: { dark: table(4), light: table(4) } },
          'default',
        ),
        1: NativeContext.create(
          { default: { dark: table(8), light: table(8) } },
          'default',
        ),
      },
    )

    expect(
      NativeContext.resolve(box().style, {
        colorScheme: 'light',
        viewport: { height: 844, width: 700 },
      }),
    ).toMatchInlineSnapshot(`
      {
        "padding": 8,
      }
    `)
    expect(() =>
      NativeContext.resolve(box().style, { colorScheme: 'light' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Native media queries require the native Provider window dimensions.]`,
    )
  })

  test('lists a missing media alternative without throwing in key', () => {
    const table = Native.create({
      axes: {},
      defaults: {},
      styles: { 0: { padding: 4 } },
    })
    const box = NativeContext.responsive(
      [{ kind: 'compare', left: 'width', operator: '>=', right: 600 }],
      {
        0: NativeContext.create(
          { default: { dark: table, light: table } },
          'default',
        ),
      },
    )
    const context = {
      colorScheme: 'light',
      viewport: { height: 844, width: 700 },
    } as const

    expect(NativeContext.key(box(), context)).toMatchInlineSnapshot(`
      [
        undefined,
      ]
    `)
    expect(() =>
      NativeContext.resolve(box().style, context),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Native media alternative is missing.]`,
    )
  })
})

describe('NativeVars API page', () => {
  test('reads the overview example', async () => {
    const example = await load<{ tokens: object; values: NativeVars.Tree }>(
      'namespaces/NativeVars',
    )

    expect(example.values).toMatchInlineSnapshot(`
      {
        "color": {
          "ink": "#fafafa",
        },
      }
    `)
    expect(Object.isFrozen(example.values.color)).toMatchInlineSnapshot(`true`)
    expect(() =>
      NativeVars.read({}, { colorScheme: 'dark' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: useVars requires variables compiled by the native adapter.]`,
    )
    expect(() =>
      NativeVars.read(example.tokens, { colorScheme: 'dark', set: 'mint' }),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: Unknown native vars: mint.]`)
  })

  test('throws diagnostics when a leaf is read', () => {
    const light = {
      color: {
        faded: ['Composed values are not supported on native.'] as [string],
      },
    }
    const values = NativeVars.read(
      NativeVars.create({
        defaultVars: 'base',
        profiles: { base: { dark: light, light } },
        unnamed: false,
      }),
      { colorScheme: 'light' },
    )

    expect(
      () => (values.color as NativeVars.Tree).faded,
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Composed values are not supported on native.]`,
    )
  })
})

describe('runtime API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      [
        'namespaces/Props',
        'namespaces/Dynamic',
        'namespaces/Recipe',
        'namespaces/ConditionalRecipe',
        'namespaces/PayloadRecipe',
        'namespaces/Composition',
        'namespaces/Html',
        'namespaces/CompositionHtml',
        'namespaces/Selection',
        'namespaces/Appearance',
        'namespaces/Variable',
        'namespaces/Native',
        'namespaces/NativeStatic',
        'namespaces/NativeDynamic',
        'namespaces/NativeContext',
        'namespaces/NativeVars',
      ].map((page) => examples(page)),
    )
    const files = await Promise.all(
      pages.flat().map(async (example, index) => {
        const directory = Path.join(root, 'types', String(index))
        const file = Path.join(directory, example.name!)
        await Fs.mkdir(directory, { recursive: true })
        await Fs.writeFile(file, example.source)
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
        // Native examples import `zyzz/react-native` as Metro resolves it.
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        ...files,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30000 },
    )

    expect(files.length).toMatchInlineSnapshot(`37`)
    expect(checked.stdout + checked.stderr).toMatchInlineSnapshot(`""`)
    expect(checked.status).toMatchInlineSnapshot(`0`)
  }, 60_000)
})
