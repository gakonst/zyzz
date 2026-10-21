/** Exercises variable authoring through source compilation and browser scopes. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Util from 'node:util'
import * as Vm from 'node:vm'
import * as Packed from '../test/fixtures/Packed.js'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'
import { Config, defineVars, extendVars, Style, Vars } from 'zyzz'

import { StyleSheet } from 'zyzz/react-native'
import { Css } from 'zyzz/web'

describe('compose', () => {
  test('retains live colors, opacity, units, and responsive values through packed contracts', async () => {
    const source = `import { Config, Vars } from 'zyzz'
      const base = Vars.define({
        color: { ink: { light: '#ff0000', dark: '#0000ff' } },
        number: { opacity: 25, space: { default: 16, '@media (min-width: 600px)': 24 } },
      }, (vars) => ({
        color: { faded: Vars.compose('color', ['color-mix(in srgb, ', vars.color.ink, ' calc(', vars.number.opacity, ' * 1%), transparent)']) },
        spacing: { page: Vars.compose('spacing', ['calc(', vars.number.space, ' * 1px)']) },
      }), { id: 'composed' })
      const other = Vars.extend(base, {
        color: { ink: { light: '#00ff00', dark: '#ffffff' } },
        number: { opacity: 75, space: { default: 32, '@media (min-width: 600px)': 48 } },
      })
      export const { style, vars } = Config.create({ vars: { base, other }, defaultVars: 'base' })`
    const app = `import { style, vars } from 'library'
      export const base = vars({set: 'base', colorScheme: 'light'})
      export const other = vars({set: 'other', colorScheme: 'light'})
      export const dark = vars({set: 'other', colorScheme: 'dark'})
      export const card = style({color: 'faded', padding: 'page'})`
    const library = Graph.compile({ modules: { 'index.ts': source } })
    expect(
      JSON.parse(library.contracts['index.ts']!).version,
    ).toMatchInlineSnapshot(`31`)

    const browser = await chromium.launch()
    try {
      for (const packed of [false, true]) {
        const result = Graph.compile(
          packed
            ? {
                contracts: {
                  'library/index.js': library.contracts['index.ts']!,
                },
                imports: { 'app.ts': { library: 'library/index.js' } },
                modules: { 'app.ts': app },
              }
            : {
                imports: {
                  'app.ts': { library: 'index.ts' },
                  'index.ts': { zyzz: null },
                },
                modules: { 'index.ts': source, 'app.ts': app },
              },
        )
        const code = await Packed.bundle({
          entry: 'app.ts',
          modules: { 'app.ts': result.modules['app.ts']!.code },
          packages: {
            library: {
              'index.ts': (packed ? library : result).modules['index.ts']!.code,
            },
          },
        })
        const fixture = Vm.runInNewContext(`${code};Fixture;`)
        const css =
          (packed
            ? (library.sharedCss ?? '') + library.modules['index.ts']!.css
            : '') +
          (result.sharedCss ?? '') +
          Object.values(result.modules)
            .map((module) => module.css)
            .join('')
        const page = await browser.newPage({
          viewport: { width: 500, height: 600 },
        })
        await page.setContent(
          `<style>${css}</style>${['base', 'other', 'dark'].map((key) => `<div class="${fixture[key].className}"><div data-card class="${fixture.card().className}"></div></div>`).join('')}`,
        )

        expect(
          await page.locator('[data-card]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              color: getComputedStyle(node).color,
              padding: getComputedStyle(node).padding,
            })),
          ),
        ).toMatchInlineSnapshot(`
          [
            {
              "color": "color(srgb 1 0 0 / 0.25)",
              "padding": "16px",
            },
            {
              "color": "color(srgb 0 1 0 / 0.75)",
              "padding": "32px",
            },
            {
              "color": "color(srgb 1 1 1 / 0.75)",
              "padding": "32px",
            },
          ]
        `)
        await page.setViewportSize({ width: 600, height: 600 })
        expect(
          await page
            .locator('[data-card]')
            .evaluateAll((nodes) =>
              nodes.map((node) => getComputedStyle(node).padding),
            ),
        ).toMatchInlineSnapshot(`
          [
            "24px",
            "48px",
            "48px",
          ]
        `)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })

  test('inherits independent Core overrides through source and packed modules', async () => {
    const core = `import {Config, Vars} from 'zyzz'
      export const variables = Vars.define({color: {ink: '#ff0000'}, number: {opacity: 25, space: 16}}, {id:'core'})
      const other = Vars.extend(variables, {color:{ink:'#0000ff'}, number:{opacity:75, space:32}})
      export const {vars: coreScope} = Config.create({vars:{base:variables, other}, defaultVars:'base'})`
    const source = `import {Config, Vars} from 'zyzz'
      import {variables as core} from './core.js'
      export {coreScope} from './core.js'
      const variables = Vars.define({
        color: {faded: Vars.compose('color', ['color-mix(in srgb, ', core.color.ink, ' calc(', core.number.opacity, ' * 1%), transparent)'])},
        spacing: {page: Vars.compose('spacing', ['calc(', core.number.space, ' * 1px)'])},
      }, {id:'site'})
      export const {style, vars} = Config.create({vars:variables})`
    const app = `import {coreScope, style, vars} from 'library'
      export const base = coreScope({set:'base'})
      export const other = coreScope({set:'other'})
      export const site = vars()
      export const card = style({color:'faded', padding:'page'})`
    const library = Graph.compile({
      imports: {
        'core.ts': { zyzz: null },
        'index.ts': { './core.js': 'core.ts', zyzz: null },
      },
      modules: { 'core.ts': core, 'index.ts': source },
    })
    const browser = await chromium.launch()
    try {
      for (const packed of [false, true]) {
        const result = Graph.compile(
          packed
            ? {
                contracts: {
                  'library/index.js': library.contracts['index.ts']!,
                  'library/core.js': library.contracts['core.ts']!,
                },
                imports: {
                  'app.ts': { library: 'library/index.js' },
                  'library/index.js': { './core.js': 'library/core.js' },
                },
                modules: { 'app.ts': app },
              }
            : {
                imports: {
                  'app.ts': { library: 'index.ts' },
                  'index.ts': { './core.js': 'core.ts', zyzz: null },
                  'core.ts': { zyzz: null },
                },
                modules: { 'core.ts': core, 'index.ts': source, 'app.ts': app },
              },
        )
        const code = await Packed.bundle({
          entry: 'app.ts',
          modules: { 'app.ts': result.modules['app.ts']!.code },
          packages: {
            library: {
              'index.ts': (packed ? library : result).modules['index.ts']!.code,
              'core.ts': (packed ? library : result).modules['core.ts']!.code,
            },
          },
        })
        const fixture = Vm.runInNewContext(`${code};Fixture;`)
        const css =
          (packed
            ? (library.sharedCss ?? '') +
              Object.values(library.modules)
                .map((module) => module.css)
                .join('')
            : '') +
          (result.sharedCss ?? '') +
          Object.values(result.modules)
            .map((module) => module.css)
            .join('')
        const page = await browser.newPage()
        await page.setContent(
          `<style>${css}</style>${['base', 'other'].map((key) => `<div class="${fixture[key].className}"><div class="${fixture.site.className}"><div data-card class="${fixture.card().className}"></div></div></div>`).join('')}`,
        )

        expect(
          await page.locator('[data-card]').evaluateAll((nodes) =>
            nodes.map((node) => ({
              color: getComputedStyle(node).color,
              padding: getComputedStyle(node).padding,
            })),
          ),
        ).toMatchInlineSnapshot(`
          [
            {
              "color": "color(srgb 1 0 0 / 0.25)",
              "padding": "16px",
            },
            {
              "color": "color(srgb 1 0 0 / 0.25)",
              "padding": "16px",
            },
          ]
        `)
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })

  test('rejects obsolete and malformed packed compositions', () => {
    const library = Graph.compile({
      modules: {
        'index.ts': `import {Config, Vars} from 'zyzz';
      const variables = Vars.define({color:{ink:Vars.compose('color',['red'])}});
      export const {style}=Config.create({vars:variables});`,
      },
    })
    const contract = JSON.parse(library.contracts['index.ts']!)
    const modules = {
      'app.ts': `import {style} from 'library'; export const card=style({color:'ink'});`,
    }
    const imports = { 'app.ts': { library: 'library.js' } }

    expect(() =>
      Graph.compile({
        contracts: {
          'library.js': JSON.stringify({ ...contract, version: 28 }),
        },
        imports,
        modules,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
    )

    const malformed = library.contracts['index.ts']!.replace(
      '"parts":["red"]',
      '"parts":[{"invalid":true}]',
    )
    expect(() =>
      Graph.compile({
        contracts: { 'library.js': malformed },
        imports,
        modules,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library.js:0: Invalid library contract: []: Composition parts must be CSS text, finite numbers, or variable references.]`,
    )
  })

  test('validates composed leaves, overrides, cycles, and native values', () => {
    const base = Vars.define({ number: { space: 16 } }, (vars) => ({
      spacing: {
        page: Vars.compose('spacing', ['calc(', vars.number.space, ' * 1px)']),
      },
    }))
    const native = StyleSheet.compile({
      styles: Style.define({ card: { width: base.spacing.page } }),
    })

    expect(native.styles.default.light.card).toMatchInlineSnapshot(`
      {
        "width": 16,
      }
    `)
    expect(native.styles.default.dark.card).toMatchInlineSnapshot(`
      {
        "width": 16,
      }
    `)

    expect(() =>
      Vars.define({ spacing: { page: Vars.compose('spacing', ['   ']) } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: []: Compositions require nonempty CSS parts.]`,
    )
    expect(() =>
      Vars.define({
        color: { ink: Vars.compose('color', ['red; color: blue']) },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: []: Composition parts must be CSS text, finite numbers, or variable references.]`,
    )
    expect(() =>
      Vars.extend(base, {
        spacing: { page: Vars.compose('color', ['red']) },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","page"]: Variable overrides must preserve their domain.]`,
    )
    expect(() =>
      Vars.extend(base, {
        spacing: {
          page: Vars.compose('spacing', ['calc(', base.spacing.page, ' * 2)']),
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","page"]: Cyclic variables are not supported.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'app.ts': `import {Config, Vars} from 'zyzz';
      const base = Vars.define({color:{ink:Vars.compose('color',['red; color:blue'])}});
      export const {style}=Config.create({vars:base});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app.ts:54: []: Composition parts must be CSS text, finite numbers, or variable references.]`,
    )
  })
})

describe('define', () => {
  test.each([28, 29, 30])(
    'rejects old producer variable names with a rebuild diagnostic: v%s',
    async (version) => {
      const producer = JSON.parse(
        await Fs.readFile(
          new URL(
            `../test/fixtures/legacy-explicit-variables/v${version}.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { contract: string }

      expect(() =>
        Graph.compile({
          contracts: { 'library/index.js': producer.contract },
          imports: { 'app.ts': { library: 'library/index.js' } },
          modules: {
            'app.ts': `import {Config,Vars} from 'zyzz'; import {palette} from 'library';
              const alternate=Vars.extend(palette,{color:{ink:'#0000ff'}});
              export const {style,vars}=Config.create({vars:alternate});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: library/index.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
      )
    },
  )

  test('uses readable standalone variables across scopes and media overrides without legacy aliases', async () => {
    const base = Vars.define(
      { color: { ink: '#ff0000' } },
      (vars) => ({
        color: {
          faded: Vars.compose('color', [
            'color-mix(in srgb, ',
            vars.color.ink,
            ' 50%, transparent)',
          ]),
        },
      }),
      { id: 'palette' },
    )
    const alternate = Vars.extend(base, {
      color: {
        ink: {
          default: { light: '#0000ff', dark: '#00ff00' },
          '@media (min-width: 600px)': { light: '#ffffff', dark: '#141414' },
        },
      },
    })
    const output = Css.compile({
      styles: Style.define({
        card: {
          backgroundColor: base.color.ink,
          color: base.color.faded,
        },
      }),
      vars: { base, alternate },
    })
    expect(output.css.includes('--z-tid-')).toMatchInlineSnapshot('false')

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { height: 600, width: 500 },
      })
      await page.setContent(
        `<style>${output.css}</style><div class="${output.vars.base}"><div class="${output.vars.alternate}" style="color-scheme:light"><div data-card class="${output.classes.card}"></div></div><div class="${output.vars.alternate}" style="color-scheme:dark"><div data-card class="${output.classes.card}"></div></div></div>`,
      )
      expect(
        await page.locator('[data-card]').evaluateAll((nodes) =>
          nodes.map((node) => ({
            backgroundColor: getComputedStyle(node).backgroundColor,
            color: getComputedStyle(node).color,
          })),
        ),
      ).toMatchInlineSnapshot(`
        [
          {
            "backgroundColor": "rgb(0, 0, 255)",
            "color": "color(srgb 0 0 1 / 0.5)",
          },
          {
            "backgroundColor": "rgb(0, 255, 0)",
            "color": "color(srgb 0 1 0 / 0.5)",
          },
        ]
      `)
      await page.setViewportSize({ height: 600, width: 800 })
      expect(
        await page.locator('[data-card]').evaluateAll((nodes) =>
          nodes.map((node) => ({
            backgroundColor: getComputedStyle(node).backgroundColor,
            color: getComputedStyle(node).color,
          })),
        ),
      ).toMatchInlineSnapshot(`
        [
          {
            "backgroundColor": "rgb(255, 255, 255)",
            "color": "color(srgb 1 1 1 / 0.5)",
          },
          {
            "backgroundColor": "rgb(20, 20, 20)",
            "color": "color(srgb 0.0784314 0.0784314 0.0784314 / 0.5)",
          },
        ]
      `)
    } finally {
      await browser.close()
    }
  })

  test.each(['legacy', 'hashed', 'unknown'])(
    'rejects packed variable naming metadata on themes and references: %s',
    (naming) => {
      const library = Graph.compile({
        modules: {
          'index.ts': `import {Vars} from 'zyzz';
            export const palette=Vars.define({color:{ink:'#ff0000'}},{id:'palette'});
            export const derived=Vars.define({color:{ink:palette.color.ink}},{id:'derived'});`,
        },
      })

      for (const location of ['theme', 'reference']) {
        const contract = JSON.parse(library.contracts['index.ts']!)
        const entry =
          location === 'theme'
            ? contract.themes['id-palette']
            : contract.themes['id-derived'].tokens.color.ink.$variable
        entry.variableNaming = naming

        expect(() =>
          Graph.compile({
            contracts: { 'library.js': JSON.stringify(contract) },
            imports: { 'app.ts': { library: 'library.js' } },
            modules: { 'app.ts': `export {derived} from 'library';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: library.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
        )
      }
    },
  )

  test('keeps explicit variable names readable and distinct across standalone and packed CSS', async () => {
    const core = Vars.define(
      { color: { neutral: { '000': '#ffffff', '092': '#141414' } } },
      { id: 'tds/core/variables' },
    )
    const base = Vars.define(
      {
        color: {
          background: {
            secondary: {
              light: core.color.neutral['000'],
              dark: core.color.neutral['092'],
            },
          },
        },
      },
      { id: 'tds/platform' },
    )
    const alternate = Vars.extend(base, {
      color: { background: { secondary: '#ff0000' } },
    })
    const other = Vars.define(
      { color: { background: { secondary: '#0000ff' } } },
      { id: 'tds-platform' },
    )
    const unicode = Vars.define(
      { color: { background: { secondary: '#00ff00' } } },
      { id: 'tds/plátform' },
    )
    const standalone = Css.compile({
      styles: Style.define({
        card: {
          backgroundColor: base.color.background.secondary,
          borderColor: other.color.background.secondary,
          color: unicode.color.background.secondary,
        },
      }),
      vars: { alternate, base, other, unicode },
    })
    const source = `import { Config, Vars } from 'zyzz';
      const core=Vars.define({color:{neutral:{'000':'#ffffff','092':'#141414'}}},{id:'tds/core/variables'});
      const base=Vars.define({color:{background:{secondary:{light:core.color.neutral['000'],dark:core.color.neutral['092']}}}},{id:'tds/platform'});
      const alternate=Vars.extend(base,{color:{background:{secondary:'#ff0000'}}});
      const other=Vars.define({color:{background:{secondary:'#0000ff'}}},{id:'tds-platform'});
      const unicode=Vars.define({color:{background:{secondary:'#00ff00'}}},{id:'tds/plátform'});
      export const {style,vars}=Config.create({defaultVars:'base',vars:{alternate:alternate,base:base,other:other,unicode:unicode}});
      export const card=style({backgroundColor:'background.secondary',borderColor:other.color.background.secondary,color:unicode.color.background.secondary});`
    const library = Graph.compile({ modules: { 'index.ts': source } })
    const app = `import {card,vars} from 'library'; export {card}; export const scope=vars({set:'alternate'}); export const light=vars({set:'base',colorScheme:'light'}); export const dark=vars({set:'base',colorScheme:'dark'});`
    const browser = await chromium.launch()

    try {
      for (const packed of [false, true]) {
        const result = Graph.compile(
          packed
            ? {
                contracts: {
                  'library/index.js': library.contracts['index.ts']!,
                },
                imports: { 'app.ts': { library: 'library/index.js' } },
                modules: { 'app.ts': app },
              }
            : {
                imports: {
                  'app.ts': { library: 'index.ts' },
                  'index.ts': { zyzz: null },
                },
                modules: { 'index.ts': source, 'app.ts': app },
              },
        )
        const code = await Packed.bundle({
          entry: 'app.ts',
          modules: { 'app.ts': result.modules['app.ts']!.code },
          packages: {
            library: {
              'index.ts': (packed ? library : result).modules['index.ts']!.code,
            },
          },
        })
        const fixture = Vm.runInNewContext(`${code};Fixture;`)
        const css =
          (packed
            ? (library.sharedCss ?? '') + library.modules['index.ts']!.css
            : '') +
          (result.sharedCss ?? '') +
          Object.values(result.modules)
            .map((module) => module.css)
            .join('')

        expect(css.includes('--z-tid-')).toMatchInlineSnapshot('false')
        expect([
          ...new Set(
            standalone.css.match(
              /--z-(?:[\w]+-)?color-background-secondary\b(?=:)/g,
            ),
          ),
        ]).toMatchInlineSnapshot(`
          [
            "--z-tds_2f_platform-color-background-secondary",
            "--z-tds_2d_platform-color-background-secondary",
            "--z-tds_2f_pl_e1_tform-color-background-secondary",
          ]
        `)
        const names = [
          ...new Set(
            css.match(/--z-(?:[\w]+-)?color-background-secondary\b(?=:)/g),
          ),
        ].sort()
        if (packed)
          expect(names).toMatchInlineSnapshot(`
            [
              "--z-color-background-secondary",
              "--z-tds_2d_platform-color-background-secondary",
              "--z-tds_2f_pl_e1_tform-color-background-secondary",
              "--z-tds_2f_platform-color-background-secondary",
            ]
          `)
        else
          expect(names).toMatchInlineSnapshot(`
            [
              "--z-color-background-secondary",
              "--z-tds_2d_platform-color-background-secondary",
              "--z-tds_2f_pl_e1_tform-color-background-secondary",
            ]
          `)

        const page = await browser.newPage()
        for (const output of [
          {
            css: standalone.css,
            card: standalone.classes.card,
            scopes: [
              standalone.vars.base,
              standalone.vars.base,
              standalone.vars.alternate,
            ],
          },
          {
            css,
            card: fixture.card().className,
            scopes: [
              fixture.light.className,
              fixture.dark.className,
              fixture.scope.className,
            ],
          },
        ]) {
          await page.setContent(
            `<style>${output.css}</style>${output.scopes.map((scope, index) => `<div class="${scope}" style="color-scheme:${index === 1 ? 'dark' : 'light'}"><div data-card class="${output.card}"></div></div>`).join('')}`,
          )

          expect(
            await page.locator('[data-card]').evaluateAll((nodes) =>
              nodes.map((node) => ({
                backgroundColor: getComputedStyle(node).backgroundColor,
                borderColor: getComputedStyle(node).borderColor,
                color: getComputedStyle(node).color,
              })),
            ),
          ).toMatchInlineSnapshot(`
            [
              {
                "backgroundColor": "rgb(255, 255, 255)",
                "borderColor": "rgb(0, 0, 255)",
                "color": "rgb(0, 255, 0)",
              },
              {
                "backgroundColor": "rgb(20, 20, 20)",
                "borderColor": "rgb(0, 0, 255)",
                "color": "rgb(0, 255, 0)",
              },
              {
                "backgroundColor": "rgb(255, 0, 0)",
                "borderColor": "rgb(0, 0, 255)",
                "color": "rgb(0, 255, 0)",
              },
            ]
          `)
        }
        await page.close()
      }
    } finally {
      await browser.close()
    }
  })

  test('emits inferred cross-domain declarations for installed consumers', async () => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-vars-declarations-'))
    const library = Path.join(root, 'node_modules/variable-fixture')
    const typography = Array.from(
      { length: 64 },
      (_, index) =>
        `body${index}: { default: '14px', '@media (min-width: 768px)': '16px', '@media (min-width: 1024px)': '18px', '@media (min-width: 1536px)': '20px' }`,
    ).join(',')

    try {
      await Fs.mkdir(library, { recursive: true })
      await Fs.symlink(
        process.cwd(),
        Path.join(root, 'node_modules/zyzz'),
        'dir',
      )
      await Fs.writeFile(
        Path.join(root, 'package.json'),
        JSON.stringify({ type: 'module' }),
      )
      await Fs.writeFile(
        Path.join(library, 'package.json'),
        JSON.stringify({
          name: 'variable-fixture',
          type: 'module',
          exports: {
            './core': './dist/core.config.d.ts',
            './platform': './dist/platform.config.d.ts',
          },
        }),
      )
      await Fs.writeFile(
        Path.join(library, 'core.ts'),
        `import * as zyzz from 'zyzz'
export const variables = zyzz.Vars.define({
  color: { ink: '#123456' }, dimension: { small: '8px' }, number: { radius: 999 },
}, (vars) => ({ dimension: { full: zyzz.Vars.compose('spacing', ['calc(', vars.number.radius, ' * 1px)']) } }), { id: 'fixture/core' })
`,
      )
      await Fs.writeFile(
        Path.join(library, 'platform.ts'),
        `import * as zyzz from 'zyzz'
import { variables as core } from './core.js'
export const variables = zyzz.Vars.define({
  color: { content: core.color.ink, faded: zyzz.Vars.compose('color', ['color-mix(in srgb, ', core.color.ink, ' 25%, transparent)']) }, dimension: { space: core.dimension.small, full: { default: core.dimension.full, '@media (min-width: 768px)': core.dimension.full } },
  type: { ${typography} },
}, { id: 'fixture/platform' })
`,
      )
      for (const domain of ['core', 'platform'])
        await Fs.writeFile(
          Path.join(library, `${domain}.config.ts`),
          `import { Config } from 'zyzz'
import { variables } from './${domain}.js'

export { variables } from './${domain}.js'
export const { style, variants, vars } = Config.create({ vars: variables, mappings: false, id: 'fixture/${domain}/config' })
${domain === 'platform' ? `export const catalogButton = variants({ base: { borderRadius: 'dimension.full', paddingBlock: 'dimension.space' }, variants: { scale: { large: { fontSize: '14px !custom', height: 'dimension.space' }, medium: { fontSize: '14px !custom', height: 'dimension.space' }, small: { fontSize: '12px !custom', height: 'dimension.space' } } } }, { id: 'fixture/button' })` : ''}
`,
        )

      const project = Path.join(root, 'producer.json')
      await Fs.writeFile(
        project,
        JSON.stringify({
          compilerOptions: {
            declaration: true,
            emitDeclarationOnly: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            outDir: Path.join(library, 'dist'),
            rootDir: library,
            skipLibCheck: false,
            strict: true,
            target: 'esnext',
            types: [],
          },
          files: [
            'core.ts',
            'core.config.ts',
            'platform.ts',
            'platform.config.ts',
          ].map((file) => Path.join(library, file)),
        }),
      )
      // Separate compiler processes avoid coverage overhead and keep the test worker responsive.
      const emitted = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          Path.resolve('node_modules/typescript-api/bin/tsc'),
          '--project',
          project,
        ],
        { timeout: 30_000 },
      )

      expect(emitted.stdout).toMatchInlineSnapshot('""')
      const declarations = await Fs.readFile(
        Path.join(library, 'dist/platform.d.ts'),
        'utf8',
      )
      expect(declarations.includes('internal/Token')).toMatchInlineSnapshot(
        'false',
      )

      const consumer = Path.join(root, 'consumer.ts')
      await Fs.writeFile(
        consumer,
        `import type * as zyzz from 'zyzz'
import { catalogButton, variables, style, variants, vars } from 'variable-fixture/platform'
const color: zyzz.Vars.Scalar<typeof variables.color.content> = '#123456'
const length: zyzz.Vars.Scalar<typeof variables.dimension.space> = '8px'
// @ts-expect-error Literal precision survives the Core alias and declaration boundary.
const wrongLength: zyzz.Vars.Scalar<typeof variables.dimension.space> = '12px'
style({ color: 'color.content', padding: 'dimension.space' })
style({ padding: vars.dimension.space })
style({ height: 'dimension.full', borderRadius: 'dimension.full', fontSize: 'dimension.full', borderWidth: 'dimension.full' })
catalogButton({ scale: 'medium' })
// @ts-expect-error Variant choices remain constrained with a large variable catalog.
catalogButton({ scale: 'huge' })
// @ts-expect-error Composed lengths cannot supply colors.
style({ color: 'dimension.full' })
style({ color: 'color.faded' })
style({ color: vars.color.faded })
// @ts-expect-error Composed colors remain incompatible with lengths.
style({ width: vars.color.faded })
// @ts-expect-error Color aliases remain incompatible with lengths.
style({ padding: vars.color.content })
const button = variants({ variants: { size: { small: { height: 'dimension.space' } } } })
button({ size: 'small' })
// @ts-expect-error Inferred variant selections remain narrow.
button({ size: 'large' })
void [color, length, wrongLength]
`,
      )
      const installedProject = Path.join(root, 'consumer.json')
      await Fs.writeFile(
        installedProject,
        JSON.stringify({
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: 'esnext',
            types: [],
          },
          files: [consumer],
        }),
      )
      const installed = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          Path.resolve('node_modules/typescript-api/bin/tsc'),
          '--project',
          installedProject,
        ],
        { timeout: 30_000 },
      )

      expect(installed.stdout).toMatchInlineSnapshot('""')
    } finally {
      await Fs.rm(root, { force: true, recursive: true })
    }
  }, 120_000)

  test('resolves breakpoint aliases in responsive variable fallbacks', async () => {
    const result = Graph.compile({
      modules: {
        'app.ts': `import {Config, Vars} from 'zyzz';
          const tokens = Vars.define({
            breakpoint: {tablet: '768px'},
            dimension: {space: {default: '16px', '@media >=tablet': '32px'}},
          }, (vars) => ({dimension: {derived: vars.dimension.space}}));
          export const {style, vars} = Config.create({vars: tokens, mappings: false});
          export const card = style({padding: 'dimension.derived'});`,
      },
    })
    const css = (result.sharedCss ?? '') + result.modules['app.ts']!.css
    expect(css.includes('@media >=tablet')).toMatchInlineSnapshot('false')
    expect(css.includes('@media (width >= 768px)')).toMatchInlineSnapshot(
      'true',
    )
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': result.modules['app.ts']!.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 767, height: 600 },
      })
      await page.setContent(
        `<style>${css}</style><div id="fallback" class="${fixture.card().className}"></div><div class="${fixture.vars().className}"><div id="scoped" class="${fixture.card().className}"></div></div>`,
      )
      expect(
        await page
          .locator('#fallback, #scoped')
          .evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node).padding),
          ),
      ).toMatchInlineSnapshot(`
        [
          "16px",
          "16px",
        ]
      `)
      await page.setViewportSize({ width: 768, height: 600 })
      expect(
        await page
          .locator('#fallback, #scoped')
          .evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node).padding),
          ),
      ).toMatchInlineSnapshot(`
        [
          "32px",
          "32px",
        ]
      `)
    } finally {
      await browser.close()
    }
    expect(() =>
      Vars.define({
        spacing: { page: { default: '16px', '@media >=missing': '32px' } },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","page","@media >=missing"]: Unknown query threshold.]`,
    )
  }, 30_000)

  test('merges derived vars and follows palette overrides on native', () => {
    const base = Vars.define(
      { color: { palette: { ink: '#123456' } }, spacing: { small: '4px' } },
      (vars) => ({
        color: { foreground: vars.color.palette.ink },
        spacing: { large: '16px' },
      }),
      { id: 'derived-native' },
    )
    const other = Vars.extend(base, { color: { palette: { ink: '#abcdef' } } })
    const styles = Style.define({
      card: { color: base.color.foreground, padding: base.spacing.large },
    })
    const result = StyleSheet.compile({ styles, vars: { base, other } })
    expect(result.styles.base.light.card).toMatchInlineSnapshot(`
      {
        "color": "#123456",
        "paddingBottom": 16,
        "paddingLeft": 16,
        "paddingRight": 16,
        "paddingTop": 16,
      }
    `)
    expect(result.styles.other.light.card).toMatchInlineSnapshot(`
      {
        "color": "#abcdef",
        "paddingBottom": 16,
        "paddingLeft": 16,
        "paddingRight": 16,
        "paddingTop": 16,
      }
    `)
    expect(() =>
      Vars.extend(base, { color: { palette: { ink: base.color.foreground } } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","palette","ink"]: Cyclic variables are not supported.]`,
    )
    expect(() =>
      Vars.define({ color: { ink: '#000' } }, () => ({
        color: { ink: '#fff' },
      })),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","ink"]: Derived variables cannot replace existing paths.]`,
    )
    expect(() =>
      Vars.define({ color: { palette: { ink: '#000' } } }, () => ({
        color: { palette: '#fff' },
      })),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","palette"]: Derived variables cannot replace existing paths.]`,
    )
    expect(() =>
      Vars.define({ spacing: { small: '4px' } }, () => ({
        spacing: { small: { nested: '8px' } },
      })),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","small"]: Derived variables cannot replace existing paths.]`,
    )
  })

  test('preserves anonymous derived references through configured mappings', () => {
    const base = Vars.define({ palette: { ink: '#123456' } }, (vars) => ({
      color: { foreground: vars.palette.ink },
    }))
    const other = Vars.extend(base, { palette: { ink: '#abcdef' } })
    const config = Config.create({
      id: 'derived-config',
      vars: other,
      mappings: { color: ['color'] },
    })
    const result = StyleSheet.compile({
      styles: Style.define({ card: { color: config.vars.color.foreground } }),
    })
    expect(result.styles.default.light.card).toMatchInlineSnapshot(`
      {
        "color": "#abcdef",
      }
    `)
  })

  test.each(['expression', 'block', 'function', 'full paths'])(
    'compiles derived vars through source and packed browser scopes: %s',
    async (form) => {
      const value =
        '({color:{foreground:{light:vars.color.palette.ink,dark:vars.color.palette.paper}},spacing:{large:vars.spacing.small}})'
      const callback = (() => {
        if (form === 'expression' || form === 'full paths')
          return `vars => ${value}, {id:'derived-web'}`
        if (form === 'block') return `vars => { return ${value} }`
        return `function(vars) { return ${value} }`
      })()
      const source = `import {Config, Vars} from 'zyzz';
      const base = Vars.define({color:{palette:{ink:'#123456',paper:'#ffffff'}},spacing:{small:{default:'4px','@media (min-width: 600px)':'16px'}}},
        ${callback});
      const other = Vars.extend(base,{color:{palette:{ink:'#abcdef',paper:'#000000'}},spacing:{small:{default:'8px','@media (min-width: 600px)':'32px'}}});
      export const {style,vars}=Config.create({vars:{base,other},defaultVars:'base',${form === 'full paths' ? 'mappings:false,' : ''}});`
      const app = `import {style,vars} from 'library';
      export const base=vars({set:'base',colorScheme:'light'});
      export const other=vars({set:'other',colorScheme:'light'});
      export const dark=vars({set:'other',colorScheme:'dark'});
      export const card=style({borderColor: vars.color.foreground, color:'${form === 'full paths' ? 'color.' : ''}foreground',padding:'${form === 'full paths' ? 'spacing.' : ''}large'});`
      const library = Graph.compile({ modules: { 'index.ts': source } })
      const browser = await chromium.launch()
      try {
        for (const packed of [false, true]) {
          const result = Graph.compile(
            packed
              ? {
                  contracts: {
                    'library/index.js': library.contracts['index.ts']!,
                  },
                  imports: { 'app.ts': { library: 'library/index.js' } },
                  modules: { 'app.ts': app },
                }
              : {
                  imports: {
                    'app.ts': { library: 'index.ts' },
                    'index.ts': { zyzz: null },
                  },
                  modules: { 'index.ts': source, 'app.ts': app },
                },
          )
          const code = await Packed.bundle({
            entry: 'app.ts',
            modules: { 'app.ts': result.modules['app.ts']!.code },
            packages: {
              library: {
                'index.ts': (packed ? library : result).modules['index.ts']!
                  .code,
              },
            },
          })
          const fixture = Vm.runInNewContext(`${code};Fixture;`)
          const page = await browser.newPage({
            viewport: { width: 500, height: 600 },
          })
          await page.setContent(
            `<style>${
              (packed
                ? (library.sharedCss ?? '') + library.modules['index.ts']!.css
                : '') +
              (result.sharedCss ?? '') +
              Object.values(result.modules)
                .map((module) => module.css)
                .join('')
            }</style>${['base', 'other', 'dark'].map((key) => `<div class="${fixture[key].className}"><div class="${fixture.card().className}" data-card></div></div>`).join('')}`,
          )
          expect(
            await page.locator('[data-card]').evaluateAll((nodes) =>
              nodes.map((node) => ({
                color: getComputedStyle(node).color,
                padding: getComputedStyle(node).padding,
              })),
            ),
          ).toMatchInlineSnapshot(`
          [
            {
              "color": "rgb(18, 52, 86)",
              "padding": "4px",
            },
            {
              "color": "rgb(171, 205, 239)",
              "padding": "8px",
            },
            {
              "color": "rgb(0, 0, 0)",
              "padding": "8px",
            },
          ]
        `)
          await page.setViewportSize({ width: 800, height: 600 })
          expect(
            await page
              .locator('[data-card]')
              .evaluateAll((nodes) =>
                nodes.map((node) => getComputedStyle(node).padding),
              ),
          ).toMatchInlineSnapshot(`
            [
              "16px",
              "32px",
              "32px",
            ]
          `)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    },
  )

  test('validates full paths against property domains', () => {
    const config = Config.create({
      id: 'full-paths',
      vars: { surface: { ink: '#123456' }, size: { page: '16px' } },
      mappings: false,
    })
    config.style({ color: 'surface.ink', width: 'size.page' })
    expect(() =>
      // @ts-expect-error color values cannot be used as lengths
      config.style({ width: 'surface.ink' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Style.InvalidError: ["style","width"]: Variable value is incompatible with this property.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'index.ts': `import {Config} from 'zyzz';
        const {style}=Config.create({vars:{surface:{ink:'#123456'}},mappings:false});
        export const card=style({width:'surface.ink'});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: index.ts:154: Variable value is incompatible with this property.]`,
    )
  })

  test('validates property domains when reusing a frozen reference', () => {
    const vars = Vars.define({ surface: { ink: '#123456' } })

    expect(() =>
      Style.define({
        first: { color: vars.surface.ink },
        // @ts-expect-error A reference validated for color is still invalid for width.
        second: { width: vars.surface.ink },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Style.InvalidError: ["second","width"]: Variable value is incompatible with this property.]`,
    )
  })

  test('accepts custom categories named tokens in portable styles', () => {
    const vars = Vars.define(
      { tokens: { ink: '#123456' } },
      { id: 'custom-category' },
    )
    const styles = Style.define({ card: { color: vars.tokens.ink } }, { vars })
    const native = StyleSheet.compile({ styles, vars: { base: vars } })
    expect(native.styles.base.light.card).toEqual({ color: '#123456' })
  })
  test('compiles variable sets, mappings, references, and media conditions', async () => {
    const result = Graph.compile({
      modules: {
        'app.ts': `
        import { Config, Vars } from 'zyzz'
        const base = Vars.define({
          color: { accent: '#2563eb', foreground: { light: '#171717', dark: '#fafafa' } },
          spacing: { page: { default: '16px', '@media (min-width: 768px)': '32px' } },
          surface: { panel: '#fff' },
        })
        const alternate = Vars.extend(base, { color: { accent: '#9333ea' } })
        const config = Config.create({
          vars: { base, alternate }, defaultVars: 'base',
          mappings: { surface: ['backgroundColor'], spacing: ['padding'] },
        })
        export const scope = config.vars({ set: 'alternate', colorScheme: 'dark' })
        export const card = config.style({ color: 'accent', padding: 'page', width: config.vars.spacing.page, backgroundColor: 'panel' })
      `,
      },
    })
    expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-accent:#2563eb;--z-spacing-page:var(--z-spacing-page-fallback-1i8tofc19dwsq);--z-surface-panel:#fff;}
      @media (min-width: 768px){.z-theme-base{--z-spacing-page:32px;}}
      .z-theme-alternate{--z-color-accent:#9333ea;--z-spacing-page:var(--z-spacing-page-fallback-1i8tofc19dwsq);--z-surface-panel:#fff;}
      @media (min-width: 768px){.z-theme-alternate{--z-spacing-page:32px;}}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_Zf5JrJ0{color:var(--z-color-accent,#2563eb);}
      .z_Zf5JrJ1{padding:var(--z-spacing-page,var(--z-spacing-page-fallback-1i8tofc19dwsq));}
      .z_Zf5JrJ2{width:var(--z-spacing-page,var(--z-spacing-page-fallback-1i8tofc19dwsq));}
      .z_Zf5JrJ3{background-color:var(--z-surface-panel,#fff);}"
    `)
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': result.modules['app.ts']!.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 500, height: 600 },
      })
      await page.setContent(
        `<style>${result.sharedCss ?? ''}${result.modules['app.ts']!.css}</style><div class="${fixture.scope.className}" style="color-scheme:dark"><div id="card" class="${fixture.card().className}"></div></div>`,
      )
      expect(
        await page.locator('#card').evaluate((node) => ({
          color: getComputedStyle(node).color,
          padding: getComputedStyle(node).padding,
          width: getComputedStyle(node).width,
        })),
      ).toMatchInlineSnapshot(`
        {
          "color": "rgb(147, 51, 234)",
          "padding": "16px",
          "width": "16px",
        }
      `)
      await page.setViewportSize({ width: 1000, height: 600 })
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).padding),
      ).toMatchInlineSnapshot(`"32px"`)
    } finally {
      await browser.close()
    }
  })
  test('links definitions and semantic references across source and packed modules', async () => {
    const source = `import { Vars, Config } from 'zyzz'
      const palette = Vars.define({ gray: { 50: '#fafafa', 900: '#171717' }, pair: { light: '#171717', dark: '#fafafa' } })
      const base = Vars.define({ color: { foreground: { light: palette.gray[900], dark: palette.gray[50] }, branchPair: { light: palette.pair, dark: palette.pair } }, surface: { paired: palette.pair }, spacing: { page: { default: '16px', '@media (min-width: 768px)': '32px' } } })
      const alternate = Vars.extend(base, { color: { foreground: '#9333ea' } })
      export const { style, vars } = Config.create({ vars: { base, alternate }, defaultVars: 'base', mappings: { spacing: ['padding'], surface: ['backgroundColor'] } })
      export const packedCard = style({ color: 'foreground', padding: 'page' })`
    const library = Graph.compile({ modules: { 'index.ts': source } })
    const app = Graph.compile({
      contracts: { 'library/index.js': library.contracts['index.ts']! },
      imports: { 'app.ts': { library: 'library/index.js', zyzz: null } },
      modules: {
        'app.ts': `import { style, vars, packedCard } from 'library'; export const packed = packedCard; export const scope = vars({ set: 'base', colorScheme: 'dark' }); export const card = style({ color: 'foreground', backgroundColor: 'paired', borderColor: 'branchPair', padding: 'page', width: vars.spacing.page });`,
      },
    })
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': app.modules['app.ts']!.code },
      packages: { library: { 'index.ts': library.modules['index.ts']!.code } },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 600 },
      })
      await page.setContent(
        `<style>${library.sharedCss ?? ''}${library.modules['index.ts']!.css}${app.sharedCss ?? ''}${app.modules['app.ts']!.css}</style><div class="${fixture.scope.className}"><div id="card" class="${fixture.card().className}"></div><div id="packed" class="${fixture.packed().className}"></div></div>`,
      )
      expect(
        await page.locator('#packed').evaluate((node) => ({
          color: getComputedStyle(node).color,
          padding: getComputedStyle(node).padding,
        })),
      ).toEqual({ color: 'rgb(250, 250, 250)', padding: '32px' })
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toMatchInlineSnapshot('"rgb(250, 250, 250)"')
      expect(
        await page
          .locator('#card')
          .evaluate((node) => getComputedStyle(node).borderTopColor),
      ).toMatchInlineSnapshot('"rgb(250, 250, 250)"')
      expect(
        await page.locator('#card').evaluate((node) => ({
          color: getComputedStyle(node).color,
          padding: getComputedStyle(node).padding,
          width: getComputedStyle(node).width,
        })),
      ).toMatchInlineSnapshot(`
        {
          "color": "rgb(250, 250, 250)",
          "padding": "32px",
          "width": "32px",
        }
      `)
    } finally {
      await browser.close()
    }
  })
  test.each(['source', 'packed'] as const)(
    'resolves config-bound references to scoped variables (%s)',
    async (mode) => {
      const library = `import { Config, Vars } from 'zyzz'
        const base = Vars.define({ spacing: { gap: '16px' } }, { id: 'lib/vars' })
        const wide = Vars.extend(base, { spacing: { gap: '24px' } })
        export const { vars } = Config.create({ id: 'lib', vars: { base, wide }, defaultVars: 'base' })`
      const app = (specifier: string) => `import { Config, Vars } from 'zyzz'
        import { vars as lib } from '${specifier}'
        const tokens = Vars.define({ spacing: { gutter: lib.spacing.gap } }, { id: 'app/vars' })
        export const { style } = Config.create({ id: 'app', vars: tokens })
        export const card = style({ padding: 'gutter' })
        export const wide = lib({ set: 'wide' })`
      const compiled = (() => {
        if (mode === 'source') {
          const graph = Graph.compile({
            modules: { 'app.ts': app('./lib.js'), 'lib.ts': library },
          })
          return {
            css: `${graph.sharedCss ?? ''}${graph.modules['lib.ts']!.css}${graph.modules['app.ts']!.css}`,
            modules: {
              'app.ts': graph.modules['app.ts']!.code,
              'lib.ts': graph.modules['lib.ts']!.code,
            },
            packages: {},
          }
        }

        const packed = Graph.compile({ modules: { 'index.ts': library } })
        const graph = Graph.compile({
          contracts: { 'library/index.js': packed.contracts['index.ts']! },
          imports: { 'app.ts': { library: 'library/index.js', zyzz: null } },
          modules: { 'app.ts': app('library') },
        })
        return {
          css: `${packed.sharedCss ?? ''}${packed.modules['index.ts']!.css}${graph.sharedCss ?? ''}${graph.modules['app.ts']!.css}`,
          modules: { 'app.ts': graph.modules['app.ts']!.code },
          packages: {
            library: { 'index.ts': packed.modules['index.ts']!.code },
          },
        }
      })()

      expect(
        compiled.css.match(/--z-app-spacing-gutter:[^;]+/)?.[0],
      ).toMatchInlineSnapshot(
        `"--z-app-spacing-gutter:var(--z-lib-spacing-gap,16px)"`,
      )

      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: compiled.modules,
        packages: compiled.packages,
      })
      const fixture = Vm.runInNewContext(`${code};Fixture;`)
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${compiled.css}</style><div id="base" class="${fixture.card().className}"></div><div class="${fixture.wide.className}"><div id="wide" class="${fixture.card().className}"></div></div>`,
        )

        expect(
          await page
            .locator('#base')
            .evaluate((node) => getComputedStyle(node).padding),
        ).toMatchInlineSnapshot(`"16px"`)
        expect(
          await page
            .locator('#wide')
            .evaluate((node) => getComputedStyle(node).padding),
        ).toMatchInlineSnapshot(`"24px"`)
      } finally {
        await browser.close()
      }
    },
  )

  test('selects nested sets and ordered media color pairs', async () => {
    const graph = Graph.compile({
      modules: {
        'app.ts': `
      import { Config, Vars } from 'zyzz'
      const base = Vars.define({ color: { foreground: {
        default: { light: '#fff', dark: '#000' },
        '@media (min-width: 600px)': { light: '#f00', dark: '#00f' },
        '@media (min-width: 900px)': { light: '#0f0', dark: '#800080' },
      } }, spacing: { text: '20px' } })
      const alternate = Vars.extend(base, { color: { foreground: '#ff0' } })
      export const { style, vars } = Config.create({ vars: { base, alternate }, defaultVars: 'base' })
      export const dark = vars({ colorScheme: 'dark' })
      export const light = vars({ colorScheme: 'light' })
      export const nested = vars({ set: 'alternate' })
      export const card = style({ color: 'foreground', fontSize: vars.spacing.text })
    `,
      },
    })
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': graph.modules['app.ts']!.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 1000, height: 600 },
      })
      await page.setContent(
        `<style>${graph.sharedCss ?? ''}${graph.modules['app.ts']!.css}</style><div id="scope" class="${fixture.dark.className}"><div id="outer" class="${fixture.card().className}"></div><div class="${fixture.nested.className}"><div id="inner" class="${fixture.card().className}"></div></div></div>`,
      )
      expect(
        await page
          .locator('#outer')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(128, 0, 128)"')
      expect(
        await page
          .locator('#inner')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 255, 0)"')
      expect(
        await page
          .locator('#outer')
          .evaluate((node) => getComputedStyle(node).fontSize),
      ).toMatchInlineSnapshot('"20px"')
      await page.locator('#scope').evaluate((node, className) => {
        node.setAttribute('class', className)
      }, fixture.light.className)
      expect(
        await page
          .locator('#outer')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(0, 255, 0)"')
      await page.setViewportSize({ width: 700, height: 600 })
      expect(
        await page
          .locator('#outer')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      await page.setViewportSize({ width: 500, height: 600 })
      expect(
        await page
          .locator('#outer')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 255, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('compiles native scalar pairs and rejects media-conditioned values', () => {
    const vars = Vars.define({
      foreground: { light: '#fff', dark: '#000' },
      gutter: { default: '16px', '@media (min-width: 600px)': '32px' },
    })
    const tables = StyleSheet.compile({
      styles: Style.define({ card: { color: vars.foreground } }),
    })
    expect(tables.styles.default.dark.card.color).toMatchInlineSnapshot(
      '"#000"',
    )
    expect(() =>
      StyleSheet.compile({
        styles: Style.define({ card: { padding: vars.gutter } }),
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [StyleSheet.CompileError: ["default","light","card","padding"]: Media-conditioned variables require a web target.
      ["default","dark","card","padding"]: Media-conditioned variables require a web target.]
    `)
  })

  test('consumes named rule references alongside variable configurations', () => {
    const library = Graph.compile({
      modules: {
        'config.ts': `import {Config} from 'zyzz'; import {customMedia,cssFunction} from 'zyzz/web'; export const {style}=Config.create({vars:{spacing:{gap:'8px'}}}); export const compact=customMedia('(width < 40rem)'); export const twice=cssFunction({parameters:[{name:'--x',syntax:'<length>'}],returns:'<length>',body:{result:'calc(var(--x) * 2)'}});`,
      },
    })
    const result = Graph.compile({
      contracts: { 'library.js': library.contracts['config.ts']! },
      imports: { 'app.ts': { library: 'library.js' } },
      modules: { 'app.ts': `export {style,compact,twice} from 'library'` },
    })
    expect(
      JSON.parse(result.contracts['app.ts']!).exports.compact.kind,
    ).toMatchInlineSnapshot(`"rule-reference"`)
    expect(
      JSON.parse(result.contracts['app.ts']!).exports.twice.kind,
    ).toMatchInlineSnapshot(`"rule-reference"`)
  })
  test.each([26, 27])(
    'rejects obsolete variable contracts version %s',
    (version) => {
      const library = Graph.compile({
        modules: {
          'config.ts': `import {Config} from 'zyzz'; export const {style}=Config.create({vars:{spacing:{gap:'8px'}}})`,
        },
      })
      const contract = JSON.parse(library.contracts['config.ts']!)
      contract.version = version
      expect(() =>
        Graph.compile({
          contracts: { 'library.js': JSON.stringify(contract) },
          imports: { 'app.ts': { library: 'library.js' } },
          modules: { 'app.ts': `export {style} from 'library'` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: library.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
      )
    },
  )
  test('accepts reordered category mappings across packed entrypoints', () => {
    const library = Graph.compile({
      modules: {
        'config.ts': `import {Config} from 'zyzz'; export const {style}=Config.create({vars:{spacing:{gap:'8px'},container:{gap:'16px'}},mappings:{spacing:['width'],container:['height']}})`,
      },
    })
    const original = library.contracts['config.ts']!
    const reordered = JSON.parse(original)
    for (const theme of Object.values(reordered.themes) as {
      mappings?: object
    }[])
      if (theme.mappings)
        theme.mappings = Object.fromEntries(
          Object.entries(theme.mappings).reverse(),
        )
    reordered.exports.style.variableMappings = Object.fromEntries(
      Object.entries(reordered.exports.style.variableMappings).reverse(),
    )
    const result = Graph.compile({
      contracts: { 'a.js': original, 'b.js': JSON.stringify(reordered) },
      imports: { 'app.ts': { a: 'a.js', b: 'b.js' } },
      modules: {
        'app.ts': `import {style as a} from 'a'; import {style as b} from 'b'; export const first=a({width:'gap'}); export const second=b({height:'gap'});`,
      },
    })
    expect(
      result.modules['app.ts']!.css.includes('width:var('),
    ).toMatchInlineSnapshot(`true`)
    expect(
      result.modules['app.ts']!.css.includes('height:var('),
    ).toMatchInlineSnapshot(`true`)
  })
  test.each(['custom-counter', '"custom marker"', 'escaped\\ name'])(
    'accepts valid identifier token %s',
    (value) => {
      const result = Graph.compile({
        modules: {
          'app.ts': `import {Config} from 'zyzz'; const {style}=Config.create({vars:{listStyleType:{named:${JSON.stringify(value)}}}}); export const list=style({listStyleType:'named'});`,
        },
      })
      expect(
        result.modules['app.ts']!.css.includes('list-style-type:var('),
      ).toMatchInlineSnapshot(`true`)
    },
  )
  test('rejects invalid conditional identifier token values', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'app.ts': `import {Config} from 'zyzz'; const {style}=Config.create({vars:{listStyleType:{bad:{default:'disc','@media (width > 600px)':'two words?'}}}}); export const list=style({listStyleType:'bad'});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app.ts:161: Variable value is incompatible with this property.]`,
    )
  })
  test('rejects invalid identifier token values', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'app.ts': `import {Config} from 'zyzz'; const {style}=Config.create({vars:{listStyleType:{bad:'two words?'}}}); export const list=style({listStyleType:'bad'});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app.ts:119: Variable value is incompatible with this property.]`,
    )
  })

  test('rejects mapping collisions and incompatible overrides', () => {
    expect(() =>
      Config.create({
        vars: { color: { accent: '#fff' }, surface: { accent: '#000' } },
        mappings: { surface: ['color'] },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Ambiguous variable token accent for color.]`,
    )
    const base = Vars.define({ color: { accent: '#fff' } })
    expect(() =>
      // @ts-expect-error invalid color domain
      Vars.extend(base, { color: { accent: '16px' } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["color","accent"]: Variable overrides must preserve their domain.]`,
    )
  })
})

test('rejects removed theme imports and config fields', () => {
  for (const name of ['Theme', 'Variables'])
    expect(() =>
      Graph.compile({
        modules: { 'app.ts': `import { ${name} } from 'zyzz';` },
      }),
    ).toThrow(`Import Vars instead of ${name}.`)
  for (const key of ['theme', 'themes', 'defaultTheme'])
    expect(() => Config.create({ [key]: {} } as never)).toThrow(
      `Use vars and defaultVars instead of ${key}.`,
    )
  for (const key of ['theme', 'themes'])
    expect(() =>
      Graph.compile({
        modules: {
          'app.ts': `import { Config } from 'zyzz'; const config=Config.create({vars:{color:{ink:'red'}}}); const {${key}}=config;`,
        },
      }),
    ).toThrow('Use vars')
})
test('retains named sets when only root helpers are exported', async () => {
  const result = Graph.compile({
    modules: {
      'app.ts': `import {Config} from 'zyzz'; export const {appearance,script}=Config.create({vars:{base:{color:{ink:'red'}},other:{color:{ink:'blue'}}},defaultVars:'other'});`,
    },
  })
  const code = await Packed.bundle({
    entry: 'app.ts',
    modules: { 'app.ts': result.modules['app.ts']!.code },
  })
  const fixture = Vm.runInNewContext(`${code};Fixture;`)
  expect(fixture.script()).toContain('other')
  expect(result.modules['app.ts']!.code).toContain('"defaultVars":"other"')
  expect(result.modules['app.ts']!.code).not.toContain('Selection')
})
test('keeps reference paths that collide with function properties', () => {
  const config = Config.create({
    id: 'paths',
    vars: Vars.define({ name: 'red', length: '8px' }),
  })
  expect(config.vars.name.value).toBe('red')
  expect(config.vars.length.value).toBe('8px')
  expect(typeof config.vars).toBe('function')
  expect(config.vars().className).toContain('z-theme-')
})

test('rejects missing responsive typography thresholds', () => {
  expect(() =>
    Vars.define({
      typography: { heading: { '@media >=missing': { fontSize: '24px' } } },
    }),
  ).toThrow('Unknown query threshold.')
})

test('resolves nested native pairs and rejects nested media values', () => {
  const palette = Vars.define({
    ink: { light: '#fff', dark: '#000' },
    media: { default: '#fff', '@media (min-width: 600px)': '#000' },
  })
  const nested = Vars.define({
    ink: { light: palette.ink, dark: palette.ink },
    media: { light: palette.media, dark: palette.media },
  })
  const outer = Vars.define({ ink: { light: nested.ink, dark: nested.ink } })
  const tables = StyleSheet.compile({
    styles: Style.define({ card: { color: outer.ink } }),
  })
  expect(tables.styles.default.light.card.color).toBe('#fff')
  expect(tables.styles.default.dark.card.color).toBe('#000')
  expect(() =>
    StyleSheet.compile({
      styles: Style.define({ card: { color: nested.media } }),
    }),
  ).toThrow('Media-conditioned variables require a web target.')
})

test('preserves root leaf-shaped names and query contracts', () => {
  const vars = Vars.define({
    light: '8px',
    dark: 2,
    default: 'red',
    breakpoint: { tablet: '48rem' },
    container: { compact: '20rem' },
    containerNames: ['card'],
  })
  expect(vars.light.value).toBe('8px')
  expect(vars.dark.value).toBe(2)
  expect(vars.default.value).toBe('red')
  expect(() =>
    Vars.extend(vars, {
      breakpoint: { tablet: '50rem' },
      container: { compact: '24rem' },
      containerNames: ['card'],
    }),
  ).not.toThrow()
  for (const additions of [
    { breakpoint: { desktop: '80rem' } },
    { container: { wide: '40rem' } },
    { containerNames: ['card', 'other'] },
  ])
    expect(() => Vars.extend(vars, additions)).not.toThrow()
  expect(() => Vars.extend(vars, { containerNames: ['other'] })).toThrow(
    'Extensions cannot remove container identities.',
  )
  expect(() =>
    Vars.extend(Vars.define({ ink: '#fff' }), {
      breakpoint: { desktop: '80rem' },
    }),
  ).not.toThrow()
  expect(() => Vars.define({ spacing: { scale: ['4px'] } } as never)).toThrow()
})

test('round-trips authored packed marker keys and rejects identity mode collisions', () => {
  const library = Graph.compile({
    modules: {
      'index.ts': `import {Config,Vars} from 'zyzz';
    const palette = Vars.define({ ink: '#123456' });
    export const {style,vars} = Config.create({id:'marker-config', vars:{palette:{$variable:'#fff',$object:'#000',nested:{$variable:{identity:'authored',path:'ink',value:'#abcdef'}}},color:{ink:palette.ink}}});`,
    },
  })
  const contract = library.contracts['index.ts']!
  const result = Graph.compile({
    contracts: { 'library/index.js': contract },
    imports: { 'app.ts': { library: 'library/index.js' } },
    modules: {
      'app.ts': `import {style,vars} from 'library'; export const card=style({color:vars.palette.$variable,backgroundColor:vars.palette.$object,borderColor:vars.palette.nested.$variable.value,outlineColor:'ink'});`,
    },
  })
  expect(result.modules['app.ts']!.css).toContain('#fff')
  expect(result.modules['app.ts']!.css).toContain('#000')
  expect(result.modules['app.ts']!.css).toContain('#abcdef')
  expect(result.modules['app.ts']!.css).toContain('#123456')
  const legacy = JSON.parse(contract)
  for (const entry of Object.values(legacy.themes) as {
    variableSet?: boolean
    tokens: unknown
  }[]) {
    delete entry.variableSet
    entry.tokens = { color: { ink: '#fff' } }
  }
  legacy.exports = {}
  delete legacy.configurations
  for (const contracts of [
    { 'first.js': JSON.stringify(legacy), 'second.js': contract },
    { 'first.js': contract, 'second.js': JSON.stringify(legacy) },
  ])
    expect(() => Graph.compile({ contracts, modules: {} })).toThrow(
      'Conflicting packed variable-set modes for one identity.',
    )
  const reference = (
    Object.values(JSON.parse(contract).themes) as {
      tokens: { color?: unknown }
    }[]
  ).find((entry) => entry.tokens.color)! as {
    tokens: { color: { ink: { $variable: { identity: string } } } }
  }
  for (const entry of Object.values(legacy.themes) as { identity: string }[])
    entry.identity = reference.tokens.color.ink.$variable.identity
  expect(() =>
    Graph.compile({
      contracts: {
        'legacy.js': JSON.stringify(legacy),
        'variables.js': contract,
      },
      modules: {},
    }),
  ).toThrow('Conflicting packed variable-set modes for one identity.')
})

test('keeps extended reference fallbacks distinct in source and packed scopes', async () => {
  const source = `import {Config,Vars} from 'zyzz';
    const palette = Vars.define({ink:'#ff0000',space:{default:'8px','@media (min-width: 600px)':'16px'}});
    const other = Vars.extend(palette,{ink:'#0000ff',space:{default:'24px','@media (min-width: 600px)':'32px'}});
    const base = Vars.define({color:{ink:palette.ink},spacing:{gap:palette.space}});
    const alternate = Vars.extend(base,{color:{ink:other.ink},spacing:{gap:other.space}});
    export const {style,vars}=Config.create({vars:{base,alternate},defaultVars:'base'});`
  const app = `import {style,vars} from 'library';
    export const base=vars({set:undefined});
    export const alternate=vars({set:'alternate'});
    export const card=style({color:'ink',padding:'gap'});`
  const library = Graph.compile({ modules: { 'index.ts': source } })
  const browser = await chromium.launch()
  try {
    for (const packed of [false, true]) {
      const result = Graph.compile(
        packed
          ? {
              contracts: { 'library/index.js': library.contracts['index.ts']! },
              imports: { 'app.ts': { library: 'library/index.js' } },
              modules: { 'app.ts': app },
            }
          : {
              imports: {
                'app.ts': { library: 'index.ts' },
                'index.ts': { zyzz: null },
              },
              modules: { 'index.ts': source, 'app.ts': app },
            },
      )
      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: { 'app.ts': result.modules['app.ts']!.code },
        packages: {
          library: {
            'index.ts': (packed ? library : result).modules['index.ts']!.code,
          },
        },
      })
      const fixture = Vm.runInNewContext(`${code};Fixture;`)
      const page = await browser.newPage({
        viewport: { width: 500, height: 600 },
      })
      await page.setContent(
        `<style>${
          (packed
            ? (library.sharedCss ?? '') + library.modules['index.ts']!.css
            : '') +
          (result.sharedCss ?? '') +
          Object.values(result.modules)
            .map((module) => module.css)
            .join('')
        }</style><div class="${fixture.base.className}"><div id="base" class="${fixture.card().className}"></div><div class="${fixture.alternate.className}"><div id="alternate" class="${fixture.card().className}"></div></div></div><div id="plain" class="${fixture.card().className}"></div>`,
      )
      const styles = () =>
        page.locator('#base, #alternate, #plain').evaluateAll((nodes) =>
          nodes.map((node) => ({
            color: getComputedStyle(node).color,
            padding: getComputedStyle(node).padding,
          })),
        )
      expect(await styles()).toEqual([
        { color: 'rgb(255, 0, 0)', padding: '8px' },
        { color: 'rgb(0, 0, 255)', padding: '24px' },
        { color: 'rgb(255, 0, 0)', padding: '8px' },
      ])
      await page.setViewportSize({ width: 800, height: 600 })
      expect(await styles()).toEqual([
        { color: 'rgb(255, 0, 0)', padding: '16px' },
        { color: 'rgb(0, 0, 255)', padding: '32px' },
        { color: 'rgb(255, 0, 0)', padding: '16px' },
      ])
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

describe('extend', () => {
  const core = Vars.define(
    { color: { ink: '#111111' }, spacing: { '12': '12px' } },
    { id: 'extend/core' },
  )

  test('adds leaves, categories, and derived values to the base set', () => {
    const site = Vars.extend(
      core,
      {
        color: { content: { primary: core.color.ink } },
        spacing: { '12': core.spacing['12'], page: '24px' },
      },
      (vars) => ({ spacing: { section: vars.spacing.page } }),
    )

    expect(site.spacing['12'].path).toBe('spacing.12')
    expect(site.spacing['12'].value).toBe('12px')
    expect(site.spacing.page.value).toBe('24px')
    expect(site.spacing.section.value).toMatchObject({ path: 'spacing.page' })
    expect(site.color.content.primary.value).toMatchObject({
      path: 'color.ink',
    })
  })

  test('rejects leaf and category conflicts and derived replacements', () => {
    expect(() => Vars.extend(core, { spacing: '4px' } as never)).toThrow(
      'Extensions cannot replace a variable category with a leaf.',
    )
    expect(() =>
      Vars.extend(core, { color: { ink: { shade: '#000000' } } } as never),
    ).toThrow('Extensions cannot replace a variable leaf with a category.')
    expect(() =>
      Vars.extend(core, { spacing: { page: '24px' } }, () => ({
        spacing: { page: '32px' },
      })),
    ).toThrow('Derived variables cannot replace existing paths.')
  })

  test('grows Config-bound vars', () => {
    const { vars } = Config.create({ id: 'extend/config', vars: core })
    const grown = Vars.extend(vars, { spacing: { page: '24px' } })

    expect(grown.spacing.page.value).toBe('24px')
    expect(grown.spacing['12'].value).toBe('12px')
  })

  test('names a new set over the base references', () => {
    const site = Vars.extend(
      core,
      { color: { content: core.color.ink }, spacing: { page: '24px' } },
      { id: 'extend/site' },
    )

    expect(site.spacing['12'].value).toMatchObject({ path: 'spacing.12' })
    expect(site.spacing.page.value).toBe('24px')
    expect(site.color.content.value).toMatchObject({ path: 'color.ink' })
  })

  test('compiles named extensions in their own namespace', () => {
    const result = Graph.compile({
      modules: {
        'index.ts': `import {Config,Vars} from 'zyzz';
          const core = Vars.define({color:{ink:'#111111'},spacing:{'12':'12px'}},{id:'extend/core'});
          const base = Vars.extend(core,{color:{content:core.color.ink},spacing:{'12':core.spacing['12']}},{id:'extend/site-vars'});
          const inverse = Vars.extend(base,{color:{content:'#ffffff'}});
          export const {style,vars} = Config.create({defaultVars:'base',id:'extend/site',vars:{base,inverse}});
          export const card = style({color:'content',padding:'12'});`,
      },
    })
    const css = `${result.sharedCss ?? ''}${result.modules['index.ts']!.css}`

    expect(css).not.toMatch(/--z-extend_2f_site(_2d_vars)?-spacing-12:/)
    expect(css).toMatch(
      /padding:var\(--z-extend_2f_site-spacing-12,var\(--z-extend_2f_core-spacing-12,12px\)\)/,
    )
    expect(css).toMatch(/--z-extend_2f_site_2d_vars-color-content:/)
    expect(css).not.toMatch(/--z-extend_2f_core-color-content/)
  })

  test('declares inherited paths that a sibling set overrides', () => {
    const result = Graph.compile({
      modules: {
        'index.ts': `import {Config,Vars} from 'zyzz';
          const core = Vars.define({spacing:{'12':'12px'}},{id:'extend/core'});
          const base = Vars.extend(core,{spacing:{page:'24px'}},{id:'extend/site-vars'});
          const roomy = Vars.extend(base,{spacing:{'12':'16px'}});
          export const {style} = Config.create({defaultVars:'base',id:'extend/site',vars:{base,roomy}});
          export const card = style({padding:'12'});`,
      },
    })
    const css = result.modules['index.ts']!.css

    expect(css).toMatch(
      /\.z-theme-extend_2f_site-base\{[^}]*--z-extend_2f_site-spacing-12:var\(--z-extend_2f_core-spacing-12/,
    )
    expect(css).toMatch(
      /\.z-theme-extend_2f_site-roomy\{[^}]*--z-extend_2f_site-spacing-12:16px/,
    )
  })

  test.each([false, true])(
    'compiles named extensions of package config vars (packed: %s)',
    (packed) => {
      const library = `import {Config,Vars} from 'zyzz';
        const base = Vars.define({color:{ink:'#111111'},spacing:{'12':'12px'}},{id:'extend/library-vars'});
        export const {style,vars} = Config.create({id:'extend/library',vars:base});`
      const app = `import {Config,Vars} from 'zyzz';
        import {vars as library} from 'library';
        const grown = Vars.extend(library,{spacing:{page:'24px'}},{id:'extend/app-vars'});
        export const {style} = Config.create({id:'extend/app',vars:grown});
        export const card = style({padding:'12',paddingInline:'page'});`
      const compiled = Graph.compile({ modules: { 'index.ts': library } })
      const result = Graph.compile(
        packed
          ? {
              contracts: {
                'library/index.js': compiled.contracts['index.ts']!,
              },
              imports: {
                'app.ts': { library: 'library/index.js', zyzz: null },
              },
              modules: { 'app.ts': app },
            }
          : {
              imports: {
                'app.ts': { library: 'index.ts', zyzz: null },
                'index.ts': { zyzz: null },
              },
              modules: { 'app.ts': app, 'index.ts': library },
            },
      )
      const css = `${result.sharedCss ?? ''}${result.modules['app.ts']!.css}`

      expect(css).not.toMatch(/--z-extend_2f_app(_2d_vars)?-spacing-12:/)
      expect(css).toMatch(
        /padding:var\(--z-extend_2f_app-spacing-12,var\(--z-extend_2f_library-spacing-12[,)]/,
      )
      expect(css).toMatch(/--z-extend_2f_app_2d_vars-spacing-page:24px/)
    },
  )

  test('keeps named sets on matching paths', () => {
    const base = Vars.extend(core, { spacing: { page: '24px' } })

    expect(() =>
      Config.create({
        defaultVars: 'base',
        id: 'extend/sets',
        vars: {
          base,
          other: Vars.extend(base, { color: { muted: '#999999' } }),
        },
      } as never),
    ).toThrow("must have the default theme's complete token paths and domains")
  })

  test.each([false, true])(
    'compiles Config-bound package vars grown by an app (packed: %s)',
    (packed) => {
      const library = `import {Config,Vars} from 'zyzz';
        const base = Vars.define({color:{ink:'#111111'},spacing:{'12':'12px'}},{id:'extend/library-vars'});
        export const {style,vars} = Config.create({id:'extend/library',vars:base});`
      const app = `import {Config,Vars} from 'zyzz';
        import {vars as library} from 'library';
        const grown = Vars.extend(library,{spacing:{page:'24px'}});
        export const {style} = Config.create({id:'extend/app',vars:grown});
        export const card = style({color:'ink',padding:'12',paddingInline:'page'});`
      const compiled = Graph.compile({ modules: { 'index.ts': library } })
      const result = Graph.compile(
        packed
          ? {
              contracts: {
                'library/index.js': compiled.contracts['index.ts']!,
              },
              imports: {
                'app.ts': { library: 'library/index.js', zyzz: null },
              },
              modules: { 'app.ts': app },
            }
          : {
              imports: {
                'app.ts': { library: 'index.ts', zyzz: null },
                'index.ts': { zyzz: null },
              },
              modules: { 'app.ts': app, 'index.ts': library },
            },
      )
      const css = `${result.sharedCss ?? ''}${result.modules['app.ts']!.css}`

      expect(css).toMatch(/--z-extend_2f_app-spacing-12:12px/)
      expect(css).toMatch(/--z-extend_2f_app-spacing-page:24px/)
    },
  )

  test('keeps sibling extensions of one base distinct', () => {
    const result = Graph.compile({
      modules: {
        'index.ts': `import {Config,Vars} from 'zyzz';
          const {vars:theme} = Config.create({id:'extend/siblings',vars:{spacing:{sm:'4px'}}});
          export const a = Vars.extend(theme,{spacing:{sm:'8px'}});
          export const b = Vars.extend(theme,{spacing:{sm:'16px'}});`,
      },
    })
    const css = result.modules['index.ts']!.css

    expect(css).toMatch(/\.z-theme-extend_2f_siblings-a\{[^}]*sm:8px/)
    expect(css).toMatch(/\.z-theme-extend_2f_siblings-b\{[^}]*sm:16px/)
  })

  test('compiles restated base references without self-references', () => {
    const result = Graph.compile({
      modules: {
        'index.ts': `import {Config,Vars} from 'zyzz';
          const core = Vars.define({color:{ink:'#111111'},spacing:{'12':'12px'}},{id:'extend/core'});
          const base = Vars.extend(core,{color:{content:core.color.ink},spacing:{'12':core.spacing['12'],page:'24px'}});
          const inverse = Vars.extend(base,{color:{content:'#ffffff'}});
          export const {style,vars} = Config.create({defaultVars:'base',id:'extend/site',vars:{base,inverse}});
          export const card = style({color:'content',padding:'12',paddingInline:'page'});`,
      },
    })
    const css = `${result.sharedCss ?? ''}${result.modules['index.ts']!.css}`

    expect(css).not.toMatch(/--([\w-]+-spacing-12):var\(--\1[,)]/)
    expect(css).toMatch(/spacing-page/)
    expect(css).toMatch(/#ffffff/)
  })

  describe('removals', () => {
    const base = Vars.define(
      {
        breakpoint: { md: '768px' },
        color: { brand: '#2563eb', ink: '#111111' },
        radius: { sm: '4px', xl: '24px' },
        shadow: { sm: '0 1px 2px #000', md: '0 2px 4px #000' },
        typography: {
          heading: {
            fontSize: '24px',
            '@media >=md': { fontSize: '32px' },
          },
          body: { fontSize: '16px' },
        },
      },
      (vars) => ({ color: { accent: vars.color.brand } }),
      { id: 'extend/removals' },
    )

    test('removes leaves and categories, including typography conditions', () => {
      const trimmed = Vars.extend(
        base,
        {
          radius: { xl: null },
          shadow: null,
          typography: { heading: null },
        },
        { id: 'extend/trimmed' },
      )

      expect(Object.keys(trimmed)).toMatchInlineSnapshot(`
        [
          "color",
          "radius",
          "typography",
        ]
      `)
      expect(Object.keys(trimmed.radius)).toMatchInlineSnapshot(`
        [
          "sm",
        ]
      `)
      expect(Object.keys(trimmed.typography)).toMatchInlineSnapshot(`
        [
          "body",
        ]
      `)
    })

    test('removes unnamed paths before derive, which can add them again', () => {
      const trimmed = Vars.extend(base, { radius: { xl: null } }, (vars) => ({
        radius: { lg: vars.radius.sm },
      }))
      const restored = Vars.extend(base, { radius: { xl: null } }, (vars) => ({
        radius: { xl: vars.radius.sm },
      }))

      expect(Object.keys(trimmed.radius)).toMatchInlineSnapshot(`
        [
          "sm",
          "lg",
        ]
      `)
      expect(restored.radius.xl.value).toMatchObject({ path: 'radius.sm' })
    })

    test('rejects missing paths, removals inside leaves, and derived removals', () => {
      expect(() =>
        Vars.extend(base, { radius: { lg: null } } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["radius","lg"]: Extensions can only remove existing paths.]`,
      )
      expect(() =>
        Vars.extend(base, { motion: null } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["motion"]: Extensions can only remove existing paths.]`,
      )
      expect(() =>
        Vars.extend(base, { radius: { sm: { shade: null } } } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["radius","sm"]: Extensions cannot replace a variable leaf with a category.]`,
      )
      expect(() =>
        Vars.extend(
          base,
          { radius: { sm: '8px' } },
          () =>
            ({
              radius: { sm: null },
            }) as never,
        ),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["radius","sm"]: Derived variables cannot remove paths.]`,
      )
      expect(() =>
        Vars.extend(base, { breakpoint: null } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["breakpoint"]: Expected a plain variable record.]`,
      )
    })

    test('rejects unnamed removals that remaining leaves reference', () => {
      expect(() =>
        Vars.extend(base, { color: { brand: null } } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Vars.InvalidError: ["color","brand"]: Referenced variable path is missing.]`,
      )
    })

    test('keeps named removals that remaining leaves reference through the base', () => {
      const trimmed = Vars.extend(
        base,
        { color: { brand: null } },
        { id: 'extend/trimmed' },
      )

      expect(Object.keys(trimmed.color)).toMatchInlineSnapshot(`
        [
          "ink",
          "accent",
        ]
      `)
      expect(trimmed.color.accent.value).toMatchObject({
        path: 'color.accent',
      })
    })

    test('rejects alternates whose removals change the default paths', () => {
      expect(() =>
        Config.create({
          defaultVars: 'base',
          id: 'extend/removals',
          vars: { base, other: Vars.extend(base, { radius: { xl: null } }) },
        } as never),
      ).toThrow(
        "must have the default theme's complete token paths and domains",
      )
    })

    test('omits removed paths from compiled scopes', () => {
      const result = Graph.compile({
        modules: {
          'index.ts': `import {Config,Vars} from 'zyzz';
            const core = Vars.define({radius:{sm:'4px',xl:'24px'},shadow:{sm:'0 1px 2px #000'}},{id:'extend/core'});
            const trimmed = Vars.extend(core,{radius:{xl:null},shadow:null});
            export const {style} = Config.create({id:'extend/trimmed',vars:trimmed});
            export const card = style({borderRadius:'sm'});`,
        },
      })

      expect(result.modules['index.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-extend_2f_trimmed-theme{--z-extend_2f_trimmed-radius-sm:4px;}
        .z_extend_2f_trimmed-r-SNdO0{border-radius:var(--z-extend_2f_trimmed-radius-sm,4px);}"
      `)
    })

    test('rejects removed tokens in compiled styles', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'index.ts': `import {Config,Vars} from 'zyzz';
              const core = Vars.define({radius:{sm:'4px',xl:'24px'}},{id:'extend/core'});
              const trimmed = Vars.extend(core,{radius:{xl:null}},{id:'extend/trimmed-vars'});
              export const {style} = Config.create({id:'extend/trimmed',vars:trimmed});
              export const card = style({borderRadius:'xl'});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: index.ts:361: Expected a configured token or a CSS value with the " !custom" suffix.]`,
      )
    })

    test('rejects missing removals in compiled sources', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'index.ts': `import {Config,Vars} from 'zyzz';
              const core = Vars.define({radius:{sm:'4px'}},{id:'extend/core'});
              export const trimmed = Vars.extend(core,{radius:{xl:null}},{id:'extend/trimmed-vars'});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: index.ts:151: ["radius","xl"]: Extensions can only remove existing paths.]`,
      )
    })
  })
})

describe('defineVars', () => {
  test.each([false, true])(
    'compiles variable aliases and derived references with renamed imports: %s',
    (renamed) => {
      const define = renamed ? 'values' : 'defineVars'
      const extend = renamed ? 'override' : 'extendVars'
      const config = `import {defineConfig, defineVars${renamed ? ' as values' : ''}, extendVars${renamed ? ' as override' : ''}} from 'zyzz';
      const base = ${define}({color:{brand:'#123456'}}, (vars) => ({color:{foreground:vars.color.brand}}), {id:'palette'});
      const alternate = ${extend}(base, {color:{brand:'#654321'}});
      export const {style,vars} = defineConfig({vars:alternate});`
      const library = Graph.compile({ modules: { 'config.ts': config } })

      expect(defineVars === Vars.define).toMatchInlineSnapshot(`true`)
      expect(extendVars === Vars.extend).toMatchInlineSnapshot(`true`)

      for (const packed of [false, true]) {
        const result = Graph.compile({
          ...(packed
            ? { contracts: { 'config.ts': library.contracts['config.ts']! } }
            : {}),
          imports: {
            'app.ts': { './config': 'config.ts' },
            'config.ts': { zyzz: null },
          },
          modules: {
            ...(!packed ? { 'config.ts': config } : {}),
            'app.ts': `import {style} from './config'; export const card=style({color:'brand'});`,
          },
        })

        if (packed)
          expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
            ".z-theme-palette-base{--z-palette-color-brand:#123456;--z-palette-color-foreground:var(--z-palette-color-brand,#123456);}
            .z-theme-palette-alternate{--z-palette-color-brand:#654321;--z-palette-color-foreground:var(--z-palette-color-brand,#654321);}
            .z-theme-theme{--z-color-brand:#654321;--z-color-foreground:var(--z-color-brand,#654321);}
            .z_Zf5JrJ0{color:var(--z-color-brand,#654321);}"
          `)
        else
          expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
            ".z-theme-theme{--z-color-brand:#654321;}
            .z_scheme-dark{color-scheme:dark;}
            .z_scheme-light{color-scheme:light;}
            .z_scheme-light-dark{color-scheme:light dark;}
            .z_Zf5JrJ0{color:var(--z-color-brand,#654321);}"
          `)
      }
    },
  )
})
