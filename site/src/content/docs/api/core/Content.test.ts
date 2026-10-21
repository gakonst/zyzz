/** Compiles and type-checks the core API reference examples through public compiler entrypoints. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import {
  Config,
  defineConfig,
  defineVars,
  extendVars,
  Style,
  style,
  variable,
  variants,
  Vars,
} from 'zyzz'
import { Source } from 'zyzz/compiler'
import { Host } from 'zyzz/node'
import { Css } from 'zyzz/web'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
let root = ''

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-core-api-'))
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

/** Compiles one module's definitions, including definitions it does not apply. */
function css(source: string) {
  const extracted = Source.extract({ moduleId: 'Example.tsx', source })
  return Css.compile({ styles: extracted.styles }).css
}

/** Builds one example directory through the filesystem compiler, with a config module when the example imports one. */
async function build(
  name: string,
  files: readonly { name?: string | undefined; source: string }[],
  native?: Host.create.Options['native'] | undefined,
) {
  const directory = Path.join(root, name)
  await Fs.mkdir(directory)
  for (const file of files)
    await Fs.writeFile(Path.join(directory, file.name!), file.source)
  if (
    files.some((file) => file.source.includes("'./zyzz.config.js'")) &&
    !files.some((file) => file.name === 'zyzz.config.ts')
  )
    await Fs.writeFile(Path.join(directory, 'zyzz.config.ts'), config)

  await using host = await Host.create({
    ...(native ? { native } : {}),
    outDir: Path.join(directory, 'dist'),
    packageId: 'core-api',
    root: directory,
  })
  await host.build()

  return (file: string) =>
    Fs.readFile(Path.join(directory, 'dist', file), 'utf8')
}

/** Exports a snippet's module-level `const` definitions, which the compiler emits only when exported or applied. */
function exported(source: string) {
  return source.replace(/^const /gm, 'export const ')
}

/** Config module for examples that import helpers from `./zyzz.config.js`. */
const config = `import { defineConfig, defineVars, extendVars } from 'zyzz'

const base = defineVars({
  color: { foreground: { light: '#171717', dark: '#fafafa' } },
  spacing: { page: '1rem' },
})
const roomy = extendVars(base, { spacing: { page: '2rem' } })

export const { appearance, script, style, variants, vars } = defineConfig({
  defaultVars: 'base',
  vars: { base, roomy },
})
`

describe('style API page', () => {
  test('compiles the overview example', async () => {
    const [card] = await examples('style')

    expect(css(card!.source)).toMatchInlineSnapshot(`
      ".z_0{border-radius:8px;}
      .z_1{padding:16px;}
      .z_2{font-size:1.25rem;}
      .z_3{margin:0;}"
    `)
  })

  test('compiles declarations, conditions, callbacks, and compositions', async () => {
    const [declarations, conditions, callback, composition] = await examples(
      'style',
      'styles',
    )

    expect(css(declarations!.source)).toMatchInlineSnapshot(`
      ".z_0{color:black!important;}
      .z_1{display:block;display:grid;}
      .z_2{padding:16px;}"
    `)
    expect(css(conditions!.source)).toMatchInlineSnapshot(`
      ".z_0{color:blue;}
      .z_1{&:hover{color:navy;}}
      @media (width >= 48rem){.z_2{font-size:1.125rem;}}"
    `)
    expect(css(callback!.source)).toMatchInlineSnapshot(`
      ".z_0{background-color:green;}
      .z_1{width:var(--z-3oDDjY-meter-amount);}"
    `)
    expect(css(exported(composition!.source))).toMatchInlineSnapshot(`
      ".z_0{color:black;}
      .z_1{padding:8px 16px;}
      .z_2{color:black;}
      .z_3{color:white;}"
    `)
  })

  test('compiles selectors that reference another definition', async () => {
    const [label] = await examples('style', 'styles.selectors')

    expect(css(label!.source)).toMatchInlineSnapshot(`
      ".z_0{color:gray;}
      .z_1{[data-state="open"] &{color:blue;}}
      .z_2{.z-style-3oDDjY-styles-card:hover &{color:black;}}"
    `)
  })

  test('compiles static variable assignments', async () => {
    const [button] = await examples('style', 'styles.vars')

    expect(css(button!.source)).toMatchInlineSnapshot(`
      ".z_0{background-color:var(--z-variables-accent);}
      .z_1{--z-variables-accent:royalblue;}
      .z_2{&:hover{--z-variables-accent:navy;}}"
    `)
  })

  test('compiles only the web target branch for web output', async () => {
    const [balance] = await examples('style', 'styles.targets')

    expect(css(balance!.source)).toMatchInlineSnapshot(`
      ".z_0{font-size:16px;}
      .z_1{font-variant-numeric:tabular-nums;}"
    `)
  })

  test('applies an explicit identity without a compiler transform', () => {
    expect(style({}, { id: 'card' })()).toMatchInlineSnapshot(`
      {
        "className": "z-style-id-card",
      }
    `)
    expect(() => style()).toThrowErrorMatchingInlineSnapshot(
      `[Error: Empty style requires an explicit id without the compiler plugin.]`,
    )
  })

  test('compiles the types example', async () => {
    const [panel] = await examples('style', 'Types')

    expect(css(panel!.source)).toMatchInlineSnapshot(`".z_0{padding:16px;}"`)
  })

  test('builds the native example as a style table', async () => {
    const [profile] = await examples('style', 'React Native')
    const directory = Path.join(root, 'native')
    await Fs.mkdir(directory)
    await Fs.writeFile(Path.join(directory, profile!.name!), profile!.source)

    await using host = await Host.create({
      native: { colorScheme: 'light', platform: 'ios' },
      outDir: Path.join(directory, 'dist'),
      packageId: 'core-api',
      root: directory,
    })
    await host.build()

    const output = await Fs.readFile(
      Path.join(directory, 'dist/Profile.tsx'),
      'utf8',
    )
    expect(JSON.parse(output.match(/__zyzzNative\.create\((\{.*\})\)/)![1]!))
      .toMatchInlineSnapshot(`
      {
        "axes": {},
        "defaults": {},
        "styles": {
          "0": {
            "color": "#111111",
            "fontSize": 16,
          },
        },
      }
    `)
  })
})

describe('variants API page', () => {
  test('compiles the overview example', async () => {
    const [button] = await examples('variants')

    expect(css(button!.source)).toMatchInlineSnapshot(`
      ".z_0{border-radius:6px;}
      .z_1{&:where([data-size="compact"]){padding:4px 8px;}}
      .z_2{&:where([data-size="regular"]){padding:8px 16px;}}"
    `)
  })

  test('compiles the base, choices, and dynamic choices', async () => {
    const [base] = await examples('variants', 'definition.base')
    const [boolean, dynamic] = await examples('variants', 'definition.variants')

    expect(css(base!.source)).toMatchInlineSnapshot(`
      ".z_0{border-radius:6px;}
      .z_1{&:hover{opacity:0.9;}}
      .z_2{&:where([data-size="compact"]){padding:4px;}}"
    `)
    expect(css(boolean!.source)).toMatchInlineSnapshot(`
      ".z_0{&:where([data-loading="true"]){opacity:0.5;}}
      .z_1{&:where([data-size="compact"]){padding:4px;}}
      .z_2{&:where([data-size="regular"]){padding:8px;}}"
    `)
    expect(css(dynamic!.source)).toMatchInlineSnapshot(`
      ".z_0{&:where([data-size="compact"]){padding:4px;}}
      .z_1{&:where([data-size="custom"]){padding:var(--z-3oDDjY-button-1-1-0-padding);}}"
    `)
  })

  test('compiles compounds after every axis', async () => {
    const [compound] = await examples('variants', 'definition.compoundVariants')

    expect(css(compound!.source)).toMatchInlineSnapshot(`
      ".z_0{&:where([data-loading="true"]){opacity:0.5;}}
      .z_1{&:where([data-size="compact"]){padding:4px;}}
      .z_2{&:where([data-size="regular"]){padding:8px;}}
      .z_3{&:where([data-loading="true"]):where([data-size="regular"]):where(*, .__zyzz-compound-0){font-weight:600;}}"
    `)
  })

  test('compiles named conditions', async () => {
    const [conditions] = await examples('variants', 'definition.conditions')

    expect(css(conditions!.source)).toMatchInlineSnapshot(`
      "@media not ((width>=48rem)){.z_0{&:where([data-size="compact"]){padding:4px;}}}
      @media not ((width>=48rem)){.z_1{&:where([data-size="regular"]){padding:8px;}}}
      @media (width >= 48rem){.z_2{&:where([data-size="compact"]:not([data-zyzz-condition-0-size]),[data-zyzz-condition-0-size="scompact"]){padding:4px;}}}
      @media (width >= 48rem){.z_3{&:where([data-size="regular"]:not([data-zyzz-condition-0-size]),[data-zyzz-condition-0-size="sregular"]){padding:8px;}}}"
    `)
  })

  test('selects choices without a compiler transform', () => {
    const button = variants(
      {
        conditions: { wide: '@media (width >= 48rem)' },
        defaultVariants: { size: 'regular' },
        variants: {
          loading: { false: {}, true: { opacity: 0.5 } },
          size: {
            compact: { padding: '4px' },
            custom: (values: { padding: `${number}px` }) => ({
              padding: values.padding,
            }),
            regular: { padding: '8px' },
          },
        },
      },
      { id: 'button' },
    )

    expect(button()).toMatchInlineSnapshot(`
      {
        "className": "z-style-id-button",
        "data-size": "regular",
      }
    `)
    expect(button({ loading: false, size: null })).toMatchInlineSnapshot(`
      {
        "className": "z-style-id-button",
        "data-loading": "false",
      }
    `)
    expect(
      button({ conditions: { wide: { size: 'regular' } }, size: 'compact' }),
    ).toMatchInlineSnapshot(`
      {
        "className": "z-style-id-button",
        "data-size": "compact",
        "data-zyzz-condition-0-size": "sregular",
      }
    `)
    expect(button({ size: { custom: { padding: '16px' } } }))
      .toMatchInlineSnapshot(`
      {
        "className": "z-style-id-button",
        "data-size": "custom",
        "style": {
          "--z-button-2-1-0-padding": "16px",
        },
      }
    `)
    expect(() =>
      variants({ variants: { size: { compact: {} } } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: variants requires an explicit id without the compiler plugin.]`,
    )
  })

  test('compiles the types example', async () => {
    const [button] = await examples('variants', 'Types')

    expect(css(button!.source)).toMatchInlineSnapshot(`
      ".z_0{&:where([data-size="compact"]){padding:4px;}}
      .z_1{&:where([data-size="regular"]){padding:8px;}}"
    `)
  })

  test('builds the native example as a selection table', async () => {
    const [badge] = await examples('variants', 'React Native')
    const read = await build('variants-native', [badge!], {
      colorScheme: 'light',
      platform: 'ios',
    })

    const output = await read('Badge.tsx')
    expect(
      JSON.parse(output.match(/__zyzzNativeStatic\.create\((\{.*\})\)/)![1]!),
    ).toMatchInlineSnapshot(`
      {
        "axes": {
          "tone": [
            "info",
            "warning",
          ],
        },
        "defaults": {},
        "rules": [
          {
            "matches": [
              [
                "tone",
                [
                  "info",
                ],
              ],
            ],
            "steps": [
              "0",
            ],
          },
          {
            "matches": [
              [
                "tone",
                [
                  "warning",
                ],
              ],
            ],
            "steps": [
              "1",
            ],
          },
        ],
        "styles": {
          "0": {
            "color": "#0070f3",
          },
          "1": {
            "color": "#f5a623",
          },
        },
      }
    `)
  })

  test('rejects named conditions in native builds', async () => {
    const [conditions] = await examples('variants', 'definition.conditions')

    await expect(
      build(
        'variants-native-conditions',
        [{ name: 'Button.ts', source: conditions!.source }],
        { colorScheme: 'light', platform: 'ios' },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native source compilation does not support named conditions or HTML output.]`,
    )
  })
})

describe('cx API page', () => {
  test('compiles the overview example', async () => {
    const [tab] = await examples('cx')

    expect(css(tab!.source)).toMatchInlineSnapshot(`
      ".z_0{color:gray;}
      .z_1{padding:8px 12px;}
      .z_2{color:black;}
      .z_3{color:gray;}
      .z_4{color:gray;}
      .z_5{color:black;}"
    `)
  })

  test('compiles ordered shorthand and longhand conflicts', async () => {
    const [applied] = await examples('cx', 'applied')

    expect(css(applied!.source)).toMatchInlineSnapshot(`
      ".z_0{color:red;}
      .z_1{padding:8px;}
      .z_2{color:blue;}
      .z_3{padding-left:12px;}
      .z_4{color:red;}
      .z_5{padding:8px;}
      .z_6{color:blue;}
      .z_7{padding-left:12px;}"
    `)
  })

  test('builds a variable scope beside applied styles', async () => {
    const [root] = await examples('cx', 'Variable Scopes')
    const read = await build('cx-scopes', [root!])

    expect(await read('Root.tsx.css')).toMatchInlineSnapshot(`
      ".z-theme-base, .z-theme-roomy {
        --z-color-foreground: light-dark(#171717, #fafafa);
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

      .z_SlmzrP0, .z_SlmzrP1 {
        color: var(--z-color-foreground, light-dark(#171717, #fafafa));
      }
      "
    `)
  })

  test('builds the native example', async () => {
    const [label] = await examples('cx', 'React Native')
    const read = await build('cx-native', [label!], {
      colorScheme: 'light',
      platform: 'ios',
    })

    const output = await read('Label.tsx')
    expect(output.match(/const cx=[^;]+;/)?.[0]).toMatchInlineSnapshot(
      `"const cx=__zyzzNative.compose;"`,
    )
    expect(
      Array.from(
        output.matchAll(/__zyzzNative\.create\((\{.*?\})\)/g),
        (match) => JSON.parse(match[1]!),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "axes": {},
          "defaults": {},
          "styles": {
            "0": {
              "color": "#111111",
              "fontSize": 16,
            },
          },
        },
        {
          "axes": {},
          "defaults": {},
          "styles": {
            "0": {
              "color": "#2563eb",
            },
          },
        },
      ]
    `)
  })
})

describe('variable API page', () => {
  test('compiles the overview example', async () => {
    const [plan] = await examples('variable')

    expect(css(plan!.source)).toMatchInlineSnapshot(`
      ".z_0{color:var(--z-variables-accent);}
      .z_1{margin:0;}
      .z_2{border-left:4px solid;}
      .z_3{border-left-color:var(--z-variables-accent);}
      .z_4{--z-variables-accent:#0070f3;}"
    `)
  })

  test('compiles a typed reference', async () => {
    const [grid] = await examples('variable', 'kind')

    expect(css(grid!.source)).toMatchInlineSnapshot(`
      ".z_0{display:grid;}
      .z_1{gap:var(--z-variables-gap);}"
    `)
  })

  test('registers typed variables with @property', async () => {
    const [inherits] = await examples('variable', 'options.inherits')
    const [initialValue] = await examples('variable', 'options.initialValue')
    const [syntax] = await examples('variable', 'options.syntax')
    const read = await build('variable-registration', [
      { name: 'gap.ts', source: inherits!.source },
      { name: 'accent.ts', source: initialValue!.source },
      { name: 'offset.ts', source: syntax!.source },
    ])

    expect(await read('zyzz.css')).toMatchInlineSnapshot(`
      "@property --z-accent {
        syntax: "<color>";
        inherits: true;
        initial-value: #0070f3;
      }

      @property --z-gap {
        syntax: "<length>";
        inherits: false;
        initial-value: 0;
      }

      @property --z-offset {
        syntax: "<length>";
        inherits: false;
        initial-value: 0;
      }
      "
    `)
  })

  test('names and assigns variables without a compiler transform', () => {
    const accent = variable('color', { id: 'acme-accent' })
    const gap = variable('length', { id: 'gap' })

    expect(String(accent)).toMatchInlineSnapshot(`"--z-acme_2d_accent"`)
    expect(gap.set('12px')).toMatchInlineSnapshot(`
      {
        "--z-gap": "12px",
      }
    `)
    expect(Object.isFrozen(gap.set('12px'))).toMatchInlineSnapshot(`true`)
    expect(() => variable('color')).toThrowErrorMatchingInlineSnapshot(
      `[Error: variable requires an explicit id without the compiler plugin.]`,
    )
  })

  test('rejects variables in native builds', async () => {
    const [plan] = await examples('variable')

    await expect(
      build('variable-native', [plan!], {
        colorScheme: 'light',
        platform: 'ios',
      }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native static modules do not support CSS contributions, variables, or web set controls.]`,
    )
  })
})

describe('defineConfig API page', () => {
  test('builds token custom properties for a consuming style', async () => {
    const [config] = await examples('defineConfig')
    const read = await build('define-config', [
      config!,
      {
        name: 'Card.ts',
        source: `import { style } from './zyzz.config.js'\n\nexport const card = style({ color: 'foreground', padding: 'page' })\n`,
      },
    ])

    expect(await read('zyzz.css')).toMatchInlineSnapshot(`
      ".z_scheme-dark {
        color-scheme: dark;
      }

      .z_scheme-light {
        color-scheme: light;
      }

      .z_scheme-light-dark {
        color-scheme: light dark;
      }
      .z-theme-theme {
        --z-color-foreground: light-dark(#171717, #fafafa);
        --z-spacing-page: 1rem;
      }

      .z_4G1uCV0 {
        color: var(--z-color-foreground, light-dark(#171717, #fafafa));
      }

      .z_4G1uCV1 {
        padding: var(--z-spacing-page, 1rem);
      }
      "
    `)
  })

  test('builds custom values, fallbacks, shorthands, and layers', async () => {
    const [tokens] = await examples('defineConfig', 'Token Values')
    const [fallbacks] = await examples('defineConfig', 'Category Fallbacks')
    const [shorthands] = await examples('defineConfig', 'options.shorthands')
    const [layers] = await examples('defineConfig', 'options.layers')
    const read = await build('define-config-values', [
      { name: 'tokens.ts', source: exported(tokens!.source) },
      { name: 'fallbacks.ts', source: exported(fallbacks!.source) },
      { name: 'shorthands.ts', source: exported(shorthands!.source) },
    ])
    const layered = await build('define-config-layers', [
      { name: 'layers.ts', source: exported(layers!.source) },
    ])

    expect(await read('tokens.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-spacing-md: 8px;
      }

      .z_ml1WQ50 {
        padding: var(--z-spacing-md, 8px);
      }

      .z_ml1WQ51 {
        margin-top: 7px;
      }
      "
    `)
    expect(await read('fallbacks.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-color-brand: #06c;
        --z-textColor-brand: #004a99;
      }

      .z_UFW1mi0 {
        background-color: var(--z-color-brand, #06c);
      }

      .z_UFW1mi1 {
        color: var(--z-textColor-brand, #004a99);
      }
      "
    `)
    expect(await read('shorthands.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-spacing-md: 8px;
      }

      .z_Jpn02f0 {
        padding-left: var(--z-spacing-md, 8px);
      }

      .z_Jpn02f1 {
        padding-right: var(--z-spacing-md, 8px);
      }
      "
    `)
    expect(await layered('zyzz.css')).toMatchInlineSnapshot(`
      "@layer components, overrides;
      .z_n9FPFt0 {
        @layer overrides {
          color: #00f;
        }
      }
      "
    `)
  })

  test('rejects invalid options without a compiler transform', () => {
    expect(() =>
      Config.create({ bogus: true, id: 'a' } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Unknown configuration option: bogus]`,
    )
    expect(() =>
      defineConfig({
        defaultVars: 'base',
        id: 'b',
        vars: {
          base: { spacing: { page: '1rem' } },
          roomy: { spacing: { gap: '1rem' } },
        },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Theme "roomy" must have the default theme's complete token paths and domains.]`,
    )
    expect(() =>
      defineConfig({ id: 'c', layers: ['bad name'] }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Layer names must be plain CSS identifiers, optionally dotted.]`,
    )
    expect(() =>
      defineConfig({ vars: { spacing: { page: '1rem' } } }).style({
        padding: 'page',
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Config.create requires an explicit id without the compiler plugin.]`,
    )
  })
})

describe('defineVars API page', () => {
  test('builds pairs, conditional values, and query aliases', async () => {
    const [config] = await examples('defineVars')
    const [, conditional] = await examples('defineVars', 'values')
    const [typography] = await examples('defineVars', 'values.typography')
    const intro = await build('define-vars', [
      config!,
      {
        name: 'Card.ts',
        source: `import { style } from './zyzz.config.js'\n\nexport const card = style({ color: 'foreground', padding: 'page' })\n`,
      },
    ])
    const aliased = await build('define-vars-alias', [
      {
        name: 'conditional.ts',
        source: `${exported(conditional!.source)}\nimport { defineConfig } from 'zyzz'\n\nexport const { style } = defineConfig({ vars: base })\n\nexport const page = style({ padding: 'page' })\n`,
      },
    ])
    const typographic = await build('define-vars-typography', [
      { name: 'typography.ts', source: exported(typography!.source) },
    ])

    expect(await intro('zyzz.css')).toMatchInlineSnapshot(`
      ":where(*) {
        --z-spacing-page-fallback-135haxo1frqfdi: 1rem;
      }

      @media (width >= 48rem) {
        :where(*) {
          --z-spacing-page-fallback-135haxo1frqfdi: 2rem;
        }
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
      .z-theme-theme {
        --z-color-foreground: light-dark(#171717, #fafafa);
        --z-spacing-page: var(--z-spacing-page-fallback-135haxo1frqfdi);
      }

      @media (width >= 48rem) {
        .z-theme-theme {
          --z-spacing-page: 2rem;
        }
      }

      .z_4G1uCV0 {
        color: var(--z-color-foreground, light-dark(#171717, #fafafa));
      }

      .z_4G1uCV1 {
        padding: var(--z-spacing-page, var(--z-spacing-page-fallback-135haxo1frqfdi));
      }
      "
    `)
    expect(await aliased('conditional.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-spacing-page: var(--z-spacing-page-fallback-135haxo1frqfdi);
      }

      @media (width >= 48rem) {
        .z-theme-theme {
          --z-spacing-page: 2rem;
        }
      }

      .z_u6u0RP0 {
        padding: var(--z-spacing-page, var(--z-spacing-page-fallback-135haxo1frqfdi));
      }
      "
    `)
    expect(await typographic('typography.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-typography-heading-fontSize: 24px;
        --z-typography-heading-_40_media_20__3e__3d_tablet-fontSize: 40px;
      }

      .z_w4OP4a0 {
        font-size: var(--z-typography-heading-fontSize, 24px);
      }

      @media (width >= 48rem) {
        .z_w4OP4a1 {
          font-size: var(--z-typography-heading-_40_media_20__3e__3d_tablet-fontSize, 40px);
        }
      }
      "
    `)
  })

  test('rejects invalid values without a compiler transform', () => {
    expect(() =>
      defineVars({ color: { foreground: { light: '#171717' } } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","foreground"]: Expected a scalar, a complete color pair, or media overrides with a default.]`,
    )
    expect(() =>
      defineVars({ spacing: { 'md!': '1rem' } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","md!"]: Expected a nonempty variable key without importance or conditions.]`,
    )
    expect(() =>
      defineVars({ color: { ink: '#171717' } }, () => ({
        color: { ink: '#000000' },
      })),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","ink"]: Derived variables cannot replace existing paths.]`,
    )
  })
})

describe('extendVars API page', () => {
  test('builds one scope per named set', async () => {
    const [config] = await examples('extendVars')
    const read = await build('extend-vars', [
      config!,
      {
        name: 'Card.ts',
        source: `import { style } from './zyzz.config.js'\n\nexport const card = style({ color: 'accent', padding: 'page' })\n`,
      },
    ])

    expect(await read('zyzz.css')).toMatchInlineSnapshot(`
      ".z_scheme-dark {
        color-scheme: dark;
      }

      .z_scheme-light {
        color-scheme: light;
      }

      .z_scheme-light-dark {
        color-scheme: light dark;
      }
      .z-theme-base {
        --z-color-accent: #2563eb;
        --z-spacing-page: 1rem;
      }

      .z-theme-brand {
        --z-color-accent: #9333ea;
        --z-spacing-page: 1rem;
      }

      .z_4G1uCV0 {
        color: var(--z-color-accent, #2563eb);
      }

      .z_4G1uCV1 {
        padding: var(--z-spacing-page, 1rem);
      }
      "
    `)
  })

  test('removes paths from style tokens', async () => {
    const [config] = await examples('extendVars', 'Remove Paths')
    const card = (radius: string) => ({
      name: 'Card.ts',
      source: `import { style } from './zyzz.config.js'\n\nexport const card = style({ borderRadius: '${radius}' })\n`,
    })
    const read = await build('extend-vars-removal', [config!, card('2xl')])

    expect(await read('zyzz.css')).toMatch(/--z-default-radius-2xl/)
    await expect(
      build('extend-vars-removed', [config!, card('3xl')]),
    ).rejects.toThrow(
      'Expected a configured token or a CSS value with the " !custom" suffix.',
    )
  })

  test('adds paths and rejects conflicts and changed value types', () => {
    const base = defineVars({ spacing: { page: '1rem' } })

    expect(
      extendVars(base, { spacing: { section: '2rem' } }).spacing.section.value,
    ).toBe('2rem')
    expect(() =>
      extendVars(base, { spacing: '2rem' } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing"]: Extensions cannot replace a variable category with a leaf.]`,
    )
    expect(() =>
      extendVars(base, { spacing: { page: '#ffffff' } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","page"]: Variable overrides must preserve their domain.]`,
    )
  })
})

describe('vars API page', () => {
  test('returns scope props without a compiler transform', () => {
    const base = defineVars({ spacing: { page: '1rem' } })
    const roomy = extendVars(base, { spacing: { page: '2rem' } })
    const helpers = defineConfig({
      defaultVars: 'base',
      id: 'app',
      vars: { base, roomy },
    })

    expect(helpers.vars()).toMatchInlineSnapshot(`
      {
        "className": "z-theme-app-base",
      }
    `)
    expect(helpers.vars({ colorScheme: 'dark', set: 'roomy' }))
      .toMatchInlineSnapshot(`
      {
        "className": "z-theme-app-roomy z_scheme-dark",
        "style": {
          "colorScheme": "dark",
        },
      }
    `)
    expect(helpers.vars({ colorScheme: 'light dark' })).toMatchInlineSnapshot(`
      {
        "className": "z-theme-app-base z_scheme-light-dark",
        "style": {
          "colorScheme": "light dark",
        },
      }
    `)
    expect(() =>
      helpers.vars({ set: 'compact' } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[TypeError: Invalid variable selection.]`,
    )
  })

  test('builds a scope and a reference with the config module', async () => {
    const [preview] = await examples('defineConfig/vars')
    const read = await build('vars-preview', [preview!])

    expect(await read('Preview.tsx.css')).toMatchInlineSnapshot(`
      ".z-theme-base {
        --z-spacing-page: 1rem;
      }

      .z-theme-roomy {
        --z-spacing-page: 2rem;
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

      .z_CcF--v0 {
        padding: var(--z-spacing-page, 1rem);
      }
      "
    `)
  })
})

describe('script API page', () => {
  test('reads the configured storage key and set catalog', () => {
    const base = defineVars({ spacing: { page: '1rem' } })
    const roomy = extendVars(base, { spacing: { page: '2rem' } })
    const source = defineConfig({
      defaultVars: 'base',
      id: 'acme',
      storageKey: 'acme-appearance',
      vars: { base, roomy },
    }).script()

    expect(
      source.includes('localStorage.getItem("acme-appearance")'),
    ).toMatchInlineSnapshot(`true`)
    expect(source.match(/new Map\((\[\[.*?\]\])\)/)?.[1]).toMatchInlineSnapshot(
      `"[["base","z-theme-acme-base"],["roomy","z-theme-acme-roomy"]]"`,
    )
    expect(source.includes('setItem')).toMatchInlineSnapshot(`false`)
  })
})

describe('Style API page', () => {
  test('defines ordered data for the web compiler', () => {
    const styles = Style.define({ card: { padding: '1rem', paddingLeft: 0 } })

    expect(Css.compile({ styles })).toMatchInlineSnapshot(`
      {
        "classes": {
          "card": "z_0 z_1",
        },
        "css": ".z_0{padding:1rem;}
      .z_1{padding-left:0;}",
        "vars": {},
      }
    `)
    expect(
      Style.define({ card: { display: 'flex', padding: '1rem' } }).styles[0]
        ?.declarations,
    ).toMatchInlineSnapshot(`
      [
        {
          "property": "display",
          "value": "flex",
        },
        {
          "property": "padding",
          "value": "1rem",
        },
      ]
    `)
    expect(
      Style.define({ card: { opacity: '0 !important' } }).styles[0]
        ?.declarations,
    ).toMatchInlineSnapshot(`
      [
        {
          "important": true,
          "property": "opacity",
          "value": 0,
        },
      ]
    `)
  })

  test('reports structural errors with diagnostics', () => {
    const error = (() => {
      try {
        Style.define({ card: { display: [] as never } })
      } catch (error) {
        return error
      }
    })()

    expect(error instanceof Style.InvalidError).toMatchInlineSnapshot(`true`)
    expect((error as Style.InvalidError).diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "invalid_value",
          "message": "Fallback arrays must be nonempty.",
          "path": [
            "card",
            "display",
          ],
        },
      ]
    `)
  })
})

describe('Vars API page', () => {
  test('builds a composed value with live references', async () => {
    const [compose] = await examples('namespaces/Vars', 'Vars.compose')
    const read = await build('vars-compose', [
      {
        name: 'faded.ts',
        source: `${exported(compose!.source)}\nimport { defineConfig } from 'zyzz'\n\nexport const { style } = defineConfig({ vars: base })\n\nexport const badge = style({ color: 'faded' })\n`,
      },
    ])

    expect(await read('zyzz.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-color-faded: color-mix(in srgb, var(--z-color-ink, #171717) calc(var(--z-number-opacity, 25) * 1%), transparent);
        --z-color-ink: #171717;
        --z-number-opacity: 25;
      }

      .z_Bc99af0 {
        color: var(--z-color-faded, color-mix(in srgb, var(--z-color-ink, #171717) calc(var(--z-number-opacity, 25) * 1%), transparent));
      }
      "
    `)
  })

  test('rejects invalid composition parts', () => {
    expect(() =>
      Vars.compose('color', ['red; color: blue']),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: []: Composition parts must be CSS text, finite numbers, or variable references.]`,
    )
  })
})

describe('Values API page', () => {
  test('compiles each value example as authored', async () => {
    const [properties, clamp] = await examples('values', 'Properties')
    const [lengths] = await examples('values', 'Lengths')
    const [colors] = await examples('values', 'Colors')
    const [numbers] = await examples('values', 'Numbers')
    const [keywords] = await examples('values', 'Keywords')
    const [multipleValues] = await examples('values', 'Multiple Values')
    const [mathFunctions] = await examples('values', 'Math Functions')
    const [customProperties] = await examples('values', 'Custom Properties')
    const [fallbacks] = await examples('values', 'Fallbacks')
    const [importance] = await examples('values', 'Importance')

    expect(css(properties!.source)).toMatchInlineSnapshot(`
      ".z_0{-webkit-user-select:none;}
      .z_1{user-select:none;}"
    `)
    expect(css(clamp!.source)).toMatchInlineSnapshot(`
      ".z_0{display:-webkit-box;}
      .z_1{-webkit-box-orient:vertical;}
      .z_2{-webkit-line-clamp:3;}
      .z_3{overflow:hidden;}"
    `)
    expect(css(lengths!.source)).toMatchInlineSnapshot(`
      ".z_0{height:100dvh;}
      .z_1{margin:0;}
      .z_2{padding-block:1lh;}"
    `)
    expect(css(colors!.source)).toMatchInlineSnapshot(`
      ".z_0{background-color:rgb(0 112 243 / 50%);}
      .z_1{border-color:currentColor;}
      .z_2{color:oklch(0.7 0.15 250);}"
    `)
    expect(css(numbers!.source)).toMatchInlineSnapshot(`
      ".z_0{font-weight:650;}
      .z_1{line-height:1.5;}
      .z_2{opacity:0.8;}"
    `)
    expect(css(keywords!.source)).toMatchInlineSnapshot(`
      ".z_0{color:inherit;}
      .z_1{display:revert-layer;}"
    `)
    expect(css(multipleValues!.source)).toMatchInlineSnapshot(`
      ".z_0{border:1px solid currentColor;}
      .z_1{margin:0 auto;}
      .z_2{transition:opacity 200ms ease, transform 300ms;}"
    `)
    expect(css(mathFunctions!.source)).toMatchInlineSnapshot(`
      ".z_0{font-size:clamp(1rem, 2vw + 0.5rem, 2rem);}
      .z_1{width:calc(100% - 2rem);}"
    `)
    expect(css(customProperties!.source)).toMatchInlineSnapshot(
      `".z_0{color:var(--brand, blue);}"`,
    )
    expect(css(fallbacks!.source)).toMatchInlineSnapshot(`
      ".z_0{display:block;display:grid;}
      .z_1{width:80vw;width:80cqi;}"
    `)
    expect(css(importance!.source)).toMatchInlineSnapshot(`
      ".z_0{display:none!important;}
      .z_1{opacity:0!important;}"
    `)
  })
})

describe('core API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      [
        'style',
        'variants',
        'cx',
        'variable',
        'defineConfig',
        'defineVars',
        'extendVars',
        'defineConfig/vars',
        'defineConfig/appearance',
        'defineConfig/script',
        'namespaces/Config',
        'namespaces/Props',
        'namespaces/Style',
        'namespaces/Vars',
        'values',
      ].map((page) => examples(page)),
    )
    const files = await Promise.all(
      pages
        .flat()
        // Twoslash blocks that declare expected errors are checked by the site build.
        .filter((example) => !example.source.includes('// @errors'))
        .map(async (example, index) => {
          const directory = Path.join(root, 'types', String(index))
          const file = Path.join(directory, example.name ?? 'Example.tsx')
          await Fs.mkdir(directory, { recursive: true })
          await Fs.writeFile(file, example.source)
          await Fs.writeFile(Path.join(directory, 'zyzz.config.ts'), config)
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

    expect(files).toHaveLength(83)
    expect(checked.status, checked.stdout + checked.stderr).toBe(0)
  }, 60_000)
})
