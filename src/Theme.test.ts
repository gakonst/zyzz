/**
 * Exercises the public Theme workflow through real collaborating modules.
 * @module
 */
import { tokens as contextTokens } from './default.js'
import * as Util from 'node:util'
const bundled = Vars.define(contextTokens)
import * as Packed from '../test/fixtures/Packed.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as Esbuild from 'esbuild'
import * as Fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Style, Vars } from 'zyzz'
import * as Theme from './internal/Theme.js'
import { Graph, Transform } from 'zyzz/compiler'
import { StyleSheet } from 'zyzz/react-native'
import { Css } from 'zyzz/web'

const tokens = {
  backgroundColor: { surface: { dark: '#111', light: '#fff' } },
  color: { brand: '#06c', unused: '#f00' },
  spacing: { md: '8px' },
} as const

describe('define', () => {
  test.each([
    'cx(heading(), border())',
    'cx(enabled && heading(), border())',
    'cx(cx(heading(), border()), border())',
  ])('preserves typography source maps through %s', (composition) => {
    const output = Transform.compile({
      moduleId: 'composition.ts',
      source: `import {Config,cx} from 'zyzz';
const {style}=Config.create({vars:{breakpoint:{tablet:'800px'},typography:{heading:{fontFamily:'serif',fontSize:'24px','@media >=tablet':{fontSize:'40px'}}}}});
const heading=style({
  typography:'heading',
  '@media (min-width: 1000px)': { fontWeight: 500 },
});
const border=style({borderWidth:'2px'});
declare const enabled:boolean;
export const combined=${composition};`,
    })
    const mappings: Record<string, Set<number | null>> = {}
    Trace.eachMapping(
      new Trace.TraceMap(output.cssMap),
      ({ name, originalLine }) => {
        if (
          name &&
          [
            'fontSize',
            'fontFamily',
            'fontWeight',
            'borderWidth',
            'typography',
            "'@media (min-width: 1000px)'",
          ].includes(name)
        )
          (mappings[name] ??= new Set()).add(originalLine)
      },
    )
    expect(mappings).toMatchInlineSnapshot(`
      {
        "'@media (min-width: 1000px)'": Set {
          5,
        },
        "borderWidth": Set {
          7,
        },
        "fontFamily": Set {
          4,
        },
        "fontSize": Set {
          4,
        },
        "fontWeight": Set {
          5,
        },
        "typography": Set {
          4,
        },
      }
    `)
  })

  test('maps responsive typography declarations to the authored preset', () => {
    const output = Transform.compile({
      moduleId: 'responsive.ts',
      source: `import {Config} from 'zyzz';
const {style}=Config.create({vars:{breakpoint:{tablet:'800px'},typography:{heading:{fontSize:'24px','@media >=tablet':{fontSize:'40px',lineHeight:'48px'}}}}});
export const heading=style({
  typography: 'heading',
  fontWeight: 500,
});`,
    })
    const mappings: Record<string, number | null> = {}
    Trace.eachMapping(
      new Trace.TraceMap(output.cssMap),
      ({ name, originalLine }) => {
        if (name) mappings[name] = originalLine
      },
    )
    expect(mappings).toMatchInlineSnapshot(`
      {
        "fontSize": 4,
        "fontWeight": 5,
        "lineHeight": 4,
        "src-responsive-f1yBSqAOQxM-style-theme": 2,
        "style-1up51euxshgne-210": 3,
        "typography": 4,
      }
    `)
  })

  test('compiles native border tokens and rejects unsupported responsive queries', () => {
    const theme = Theme.define({
      borderWidth: { regular: '2px' },
      breakpoint: { tablet: '800px' },
      typography: {
        heading: { fontSize: '24px', '@media >=tablet': { fontSize: '40px' } },
      },
    })
    const output = StyleSheet.compile({
      styles: Style.define(
        { border: { borderWidth: 'regular' } },
        { vars: theme },
      ),
      vars: { base: theme },
    })
    expect(output.styles.base.light.border).toMatchInlineSnapshot(`
      {
        "borderBottomWidth": 2,
        "borderLeftWidth": 2,
        "borderRightWidth": 2,
        "borderTopWidth": 2,
      }
    `)
    expect(() =>
      StyleSheet.compile({
        styles: Style.define(
          { heading: { typography: 'heading' } },
          { vars: theme },
        ),
        vars: { base: theme },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.CompileError: ["heading"]: Selectors, queries, and nested rules are not supported on native.]`,
    )
  })

  test('renders responsive theme typography and border widths through packed configuration', async () => {
    const library = Graph.compile({
      modules: {
        'theme.ts': `import {Config,Vars} from 'zyzz';
const base=Vars.define({
  borderWidth:{regular:'2px',hairline:'0.5px'},
  breakpoint:{tablet:'800px'},
  container:{card:'300px'},
  typography:{heading:{fontSize:'24px',lineHeight:'30px',
    '@media >=tablet':{fontSize:'40px',lineHeight:'48px'},
    '@media (min-width: 1000.5px)':{fontSize:'48px',
      '@container >=card':{lineHeight:'60px'}}}}
});
const alternate=Vars.extend(base,{
  borderWidth:{regular:'4px'},
  typography:{heading:{'@media >=tablet':{fontSize:'44px'}}}
});
export const {style,vars}=Config.create({vars:{base,alternate},defaultVars:'base'});`,
      },
    })
    const contract = library.contracts['theme.ts']!
    expect(JSON.parse(contract).version).toMatchInlineSnapshot(`31`)
    const source = `import {style,vars} from 'library';
export const title=style({typography:'heading',borderStyle:'solid',borderWidth:'regular'});
export const fixed=style({typography:'heading',fontSize:'18px'});
export const important=style({typography:'heading !important'});
export const logical=style({borderInlineStartStyle:'solid',borderInlineStartWidth:'regular'});
export const root=vars().className;
export const other=vars({set:'alternate'}).className;`
    expect(() =>
      Graph.compile({
        contracts: {
          'library.js': JSON.stringify({
            ...JSON.parse(contract),
            version: 24,
          }),
        },
        imports: { 'app.ts': { library: 'library.js' } },
        modules: { 'app.ts': source },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
    )
    const consumer = Graph.compile({
      contracts: { 'library.js': contract },
      imports: { 'app.ts': { library: 'library.js' } },
      modules: { 'app.ts': source },
    })
    const output = consumer.modules['app.ts']!
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 600, height: 400 },
      })
      await page.setContent(
        `<style>${output.css}</style><main style="container-type:inline-size"><p id="title">Title</p><p id="fixed">Fixed</p><p id="important" style="font-size:10px">Important</p><p id="logical">Logical</p></main>`,
      )
      const script = await Packed.bundle({
        entry: 'app.ts',
        modules: {
          'app.ts':
            output.code +
            `
          document.querySelector('main').className=root;
          for(const [id,style] of Object.entries({title,fixed,important,logical})) document.getElementById(id).className=style().className;
          window.alternate=other;`,
        },
        packages: {
          library: { 'index.ts': library.modules['theme.ts']!.code },
        },
      })
      await page.addScriptTag({ content: script })
      await page.waitForFunction(
        () => document.querySelector('#title')!.className !== '',
      )
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"24px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
      ).toMatchInlineSnapshot(`"2px"`)
      expect(
        await page
          .locator('#logical')
          .evaluate(
            (element) => getComputedStyle(element).borderInlineStartWidth,
          ),
      ).toMatchInlineSnapshot(`"2px"`)
      await page.setViewportSize({ width: 900, height: 400 })
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"40px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).lineHeight),
      ).toMatchInlineSnapshot(`"48px"`)
      expect(
        await page
          .locator('#fixed')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"18px"`)
      expect(
        await page
          .locator('#important')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"40px"`)
      await page.evaluate(
        'document.querySelector("main").className=window.alternate',
      )
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"44px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
      ).toMatchInlineSnapshot(`"4px"`)
      await page.setViewportSize({ width: 1100, height: 400 })
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"48px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).lineHeight),
      ).toMatchInlineSnapshot(`"60px"`)
      expect(
        await page
          .locator('#fixed')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"18px"`)
    } finally {
      await browser.close()
    }
  })

  test('rejects malformed typography queries', () => {
    const theme = Theme.define({
      typography: {
        heading: { '@media (min-width: 800px)': { fontSize: '24px' } },
      },
    })
    expect(() =>
      Style.define(
        {
          heading: { typography: 'heading.@media (min-width: 800px)' },
        } as never,
        { vars: theme },
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Style.InvalidError: ["heading","typography"]: Expected a named typography set from the bound theme.]`,
    )
    expect(() =>
      Theme.define({
        typography: {
          heading: { '@supports (display: grid)': { fontSize: '24px' } },
        },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","heading","@supports (display: grid)"]: Typography conditions must be media or container queries.]`,
    )
    expect(() =>
      Theme.define({
        typography: { heading: { '@media >=missing': { fontSize: '24px' } } },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","heading","@media >=missing"]: Unknown query threshold.]`,
    )
    expect(() =>
      Theme.define({
        typography: {
          heading: {
            '@media (min-width: 800px)': { other: { fontSize: '24px' } },
          },
        },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","heading","@media (min-width: 800px)","other"]: Typography query blocks accept only typography fields and queries.]`,
    )
    expect(() =>
      Theme.define({
        typography: { '@media (min-width: 800px)': { fontSize: '24px' } },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","@media (min-width: 800px)"]: Typography properties require a named set.]`,
    )
  })

  test.each(['body', 'body !important', 'body  !important'])(
    'maps expanded typography fields to their authored declaration: %s',
    (typography) => {
      const source = `import {Config} from 'zyzz';
const {style}=Config.create({vars:{typography:{body:{fontSize:'14px',fontWeight:400,lineHeight:'20px'}}}});
export const body=style({
  fontWeight: 500,
  typography: '${typography}',
  ':hover': { typography: 'body', lineHeight: '24px' },
});`
      const output = Transform.compile({ moduleId: 'typography.ts', source })
      const map = new Trace.TraceMap(output.cssMap)
      const mappings: Record<
        string,
        { line: number | null; column: number | null }[]
      > = {}
      Trace.eachMapping(map, ({ name, originalLine, originalColumn }) => {
        if (name && ['fontSize', 'fontWeight', 'lineHeight'].includes(name))
          (mappings[name] ??= []).push({
            line: originalLine,
            column: originalColumn,
          })
      })

      expect(mappings).toMatchInlineSnapshot(`
      {
        "fontSize": [
          {
            "column": 2,
            "line": 5,
          },
          {
            "column": 14,
            "line": 6,
          },
        ],
        "fontWeight": [
          {
            "column": 2,
            "line": 4,
          },
          {
            "column": 14,
            "line": 6,
          },
        ],
        "lineHeight": [
          {
            "column": 2,
            "line": 5,
          },
          {
            "column": 34,
            "line": 6,
          },
        ],
      }
    `)
    },
  )

  test('rejects malformed typography data', () => {
    expect(() =>
      Theme.define({ typography: { heading: { 32: '32px' } } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","heading","32"]: Expected a typography set or a nested set group.]`,
    )
    expect(() =>
      Theme.define({
        typography: { body: { fontSize: { small: '14px' } } },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","body","fontSize"]: Typography properties require scalar values.]`,
    )
    expect(() =>
      Theme.define({ typography: { body: { color: 'red' } } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","body","color"]: Expected a typography set or a nested set group.]`,
    )
    expect(() =>
      Theme.define({ typography: { body: {} } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["typography","body"]: Token palettes cannot be empty.]`,
    )
  })

  test('renders typography sets, explicit fields, conditions, and theme overrides', async () => {
    const base = Theme.define({
      typography: {
        heading: {
          32: {
            fontFamily: 'Geist',
            fontSize: '32px',
            fontWeight: 600,
            letterSpacing: '-1.28px',
            lineHeight: '40px',
          },
        },
        label: {
          14: {
            fontSize: '14px',
            mono: {
              fontFamily: 'Geist Mono',
              fontSize: '14px',
              lineHeight: '20px',
            },
          },
        },
      },
    })
    const alternate = Theme.extend(base, {
      typography: { heading: { 32: { fontSize: '36px', lineHeight: '44px' } } },
    })
    const styles = Style.define(
      {
        title: {
          fontWeight: 500,
          typography: 'heading.32',
          ':hover': { fontWeight: 700 },
        },
        mono: { typography: 'label.14.mono' },
        responsive: {
          typography: 'heading.32',
          '@media (min-width: 800px)': { typography: 'label.14' },
        },
        important: { typography: 'heading.32 !important' },
      },
      { vars: base },
    )
    const output = Css.compile({ styles, vars: { alternate, base } })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({
        viewport: { width: 600, height: 400 },
      })
      await page.setContent(
        `<style>${output.css}</style><main class="${output.vars.base}"><p id="title" class="${output.classes.title}">Title</p><p id="mono" class="${output.classes.mono}">Mono</p><p id="responsive" class="${output.classes.responsive}">Responsive</p><p id="important" style="font-size:10px" class="${output.classes.important}">Important</p></main>`,
      )

      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"32px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontWeight),
      ).toMatchInlineSnapshot(`"500"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).lineHeight),
      ).toMatchInlineSnapshot(`"40px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).letterSpacing),
      ).toMatchInlineSnapshot(`"-1.28px"`)
      expect(
        await page
          .locator('#mono')
          .evaluate((element) => getComputedStyle(element).fontFamily),
      ).toMatchInlineSnapshot(`""Geist Mono""`)
      expect(
        await page
          .locator('#important')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"32px"`)

      await page.locator('#title').hover()
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontWeight),
      ).toMatchInlineSnapshot(`"700"`)
      await page
        .locator('main')
        .evaluate(
          (element, className) => element.setAttribute('class', className),
          output.vars.alternate,
        )
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"36px"`)
      expect(
        await page
          .locator('#title')
          .evaluate((element) => getComputedStyle(element).lineHeight),
      ).toMatchInlineSnapshot(`"44px"`)
      await page.setViewportSize({ width: 900, height: 400 })
      expect(
        await page
          .locator('#responsive')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot(`"14px"`)
    } finally {
      await browser.close()
    }
  })

  test('compiles typography fields into native tables with font mappings', () => {
    const theme = Theme.define({
      typography: {
        heading: {
          32: {
            fontFamily: 'Geist',
            fontSize: '32px',
            fontWeight: 600,
            letterSpacing: '-1.28px',
            lineHeight: '40px',
          },
        },
      },
    })
    const alternate = Theme.extend(theme, {
      typography: { heading: { 32: { fontSize: '36px' } } },
    })
    const output = StyleSheet.compile({
      fonts: { Geist: 'Geist-Native' },
      styles: Style.define(
        { title: { typography: 'heading.32', fontWeight: 500 } },
        { vars: theme },
      ),
      vars: { alternate, base: theme },
    })

    expect(output.styles.base.light.title).toMatchInlineSnapshot(`
      {
        "fontFamily": "Geist-Native",
        "fontSize": 32,
        "fontWeight": 500,
        "letterSpacing": -1.28,
        "lineHeight": 40,
      }
    `)
    expect(output.styles.alternate.light.title.fontSize).toMatchInlineSnapshot(
      `36`,
    )
  })

  test('retains typography sets through packed configurations and recipe compilation', () => {
    const library = Graph.compile({
      modules: {
        'theme.ts':
          "import {Config} from 'zyzz';export const {style,vars:theme,variants}=Config.create({vars:{typography:{copy:{14:{fontSize:'14px',fontWeight:400,lineHeight:'20px'}}}}});",
      },
    })
    const contract = library.contracts['theme.ts']!
    expect(JSON.parse(contract).version).toMatchInlineSnapshot(`31`)

    expect(() =>
      Graph.compile({
        contracts: {
          'library.js': JSON.stringify({
            ...JSON.parse(contract),
            version: 23,
          }),
        },
        imports: { 'app.ts': { library: 'library.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'library';export const body=style({typography:'copy.14'});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
    )

    const consumer = Graph.compile({
      contracts: { 'library.js': contract },
      imports: { 'app.ts': { library: 'library.js', zyzz: null } },
      modules: {
        'app.ts': `import {style,theme,variants} from 'library';export const body=style({typography:'copy.14'});export const strong=style({fontWeight:theme.typography.copy[14].fontWeight});export const text=variants({base:{typography:'copy.14'},variants:{strong:{true:{fontWeight:550}}}});`,
      },
    })

    expect(consumer.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-typography-copy-14-fontSize:14px;--z-typography-copy-14-fontWeight:400;--z-typography-copy-14-lineHeight:20px;}
      .z_Zf5JrJ0{font-size:var(--z-typography-copy-14-fontSize,14px);}
      .z_Zf5JrJ1{font-weight:var(--z-typography-copy-14-fontWeight,400);}
      .z_Zf5JrJ2{line-height:var(--z-typography-copy-14-lineHeight,20px);}
      .z_Zf5JrJ3{font-weight:var(--z-typography-copy-14-fontWeight,400);}
      .z_Zf5JrJ4{&:where([data-strong="true"]){font-weight:550;}}"
    `)
  })

  test.each(['heading', 'heading.32.fontSize', 'heading.48', ['heading.32']])(
    'rejects unknown typography set %j',
    (typography) => {
      const theme = Theme.define({
        typography: { heading: { 32: { fontSize: '32px' } } },
      })
      expect(() =>
        Style.define({ title: { typography } } as never, { vars: theme }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Style.InvalidError: ["title","typography"]: Expected a named typography set from the bound theme.]`,
      )
    },
  )

  test('bound authoring requires an explicit identity without compilation', () => {
    const theme = Theme.define(tokens)

    expect(() => theme.className).toThrowErrorMatchingInlineSnapshot(
      `[style.MissingTransformError: style requires a compile-time transform. Source extraction alone does not rewrite calls; do not execute untransformed authoring source.]`,
    )

    const { style } = theme

    expect(() =>
      style({ color: 'brand', padding: 'md' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Theme.define requires an explicit id without the compiler plugin.]`,
    )
    expect(Object.isFrozen(theme)).toMatchInlineSnapshot('true')
  })

  test('annotated token records compile with omitted optional groups', () => {
    const input: Theme.Tokens = { color: { brand: '#fff' }, spacing: undefined }
    const theme = Theme.define(input)
    const reference = theme.tokens.color!.brand as Theme.Reference<'color'>
    const output = Css.compile({
      styles: Style.define({ card: { color: reference } }),
      vars: { base: theme },
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z0{--z0:#fff;}
      .z_0{color:var(--z0,#fff);}"
    `)
  })

  test('escaped identifiers preserve independent styles and scoped palettes in Chromium', async () => {
    const base = Theme.define({
      color: { brand: { primary: '#fff' }, brand_2e_primary: '#000' },
    })
    const alternate = Theme.extend(base, {
      color: { brand: { primary: '#06c' }, brand_2e_primary: '#f00' },
    })

    const output = Css.compile({
      composition: 'independent',
      styles: Style.define({
        other: { color: base.tokens.color.brand_2e_primary },
        t_0: { color: '#175' },
        'z_theme-base': { color: base.tokens.color.brand.primary },
      }),
      vars: { base, 'foo.bar': alternate, foo_2e_bar: base },
    })

    expect(output.classes).toMatchInlineSnapshot(`
      {
        "other": "z_0",
        "t_0": "z_1",
        "z_theme-base": "z_2",
      }
    `)
    expect(output.css).toMatchInlineSnapshot(`
      ".z0{--z0:#000;--z1:#fff;}
      .z1{--z0:#f00;--z1:#06c;}
      .z2{--z0:#000;--z1:#fff;}
      .z_0{color:var(--z0,#000);}
      .z_1{color:#175;}
      .z_2{color:var(--z1,#fff);}"
    `)
    expect(output.vars).toMatchInlineSnapshot(`
      {
        "base": "z0",
        "foo.bar": "z1",
        "foo_2e_bar": "z2",
      }
    `)

    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(`<style>${output.css}</style>
        <section class="${output.vars['foo.bar']}">
          <div id="nested" class="${output.classes['z_theme-base']}"></div>
          <div id="escaped" class="${output.classes.other}"></div>
          <div id="collision" class="${output.classes.t_0}"></div>
        </section>
        <section class="${output.vars.foo_2e_bar}"><div id="base" class="${output.classes['z_theme-base']}"></div></section>`)

      expect(
        await page
          .locator('#nested')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(0, 102, 204)"')
      expect(
        await page
          .locator('#escaped')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page
          .locator('#collision')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(17, 119, 85)"')
      expect(
        await page
          .locator('#base')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(255, 255, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('portable references compile to live variables and defining fallbacks', () => {
    const theme = Theme.define(tokens)
    const independent = Theme.define(tokens)

    const styles = Style.define({
      button: {
        backgroundColor: theme.tokens.backgroundColor.surface,
        color: theme.tokens.color.brand,
        padding: theme.tokens.spacing.md,
      },
      independent: { color: independent.tokens.color.brand },
    })

    const result = Css.compile({ styles, vars: { base: theme, independent } })

    expect(result.css).toMatchInlineSnapshot(`
      ".z0{--z0:light-dark(#fff,#111);--z1:#06c;--z2:8px;}
      .z1{--z3:#06c;}
      .z_0{background-color:var(--z0,light-dark(#fff,#111));}
      .z_1{color:var(--z1,#06c);}
      .z_2{padding:var(--z2,8px);}
      .z_3{color:var(--z3,#06c);}"
    `)
    expect(result.classes).toMatchInlineSnapshot(`
      {
        "button": "z_0 z_1 z_2",
        "independent": "z_3",
      }
    `)
    expect(result.vars).toMatchInlineSnapshot(`
      {
        "base": "z0",
        "independent": "z1",
      }
    `)
    expect(Css.compile({ styles }).css).toMatchInlineSnapshot(`
      ".z_0{background-color:var(--z0,light-dark(#fff,#111));}
      .z_1{color:var(--z1,#06c);}
      .z_2{padding:var(--z2,8px);}
      .z_3{color:var(--z3,#06c);}"
    `)
    expect(Css.compile({ styles, vars: { independent, renamed: theme } }).css)
      .toMatchInlineSnapshot(`
        ".z0{--z3:#06c;}
        .z1{--z0:light-dark(#fff,#111);--z1:#06c;--z2:8px;}
        .z_0{background-color:var(--z0,light-dark(#fff,#111));}
        .z_1{color:var(--z1,#06c);}
        .z_2{padding:var(--z2,8px);}
        .z_3{color:var(--z3,#06c);}"
      `)
    expect(Object.isFrozen(theme.tokens.spacing.md)).toMatchInlineSnapshot(
      'true',
    )
    expect(Object.keys(theme)).toMatchInlineSnapshot(`
      [
        "className",
        "style",
        "tokens",
        "variants",
        "vars",
      ]
    `)
  })

  test('theme scopes stay distinct from authored style names', () => {
    const theme = Theme.define(tokens)
    const styles = Style.define({
      'theme-base': { color: theme.tokens.color.brand },
    })

    expect(Css.compile({ styles, vars: { base: theme } }).css)
      .toMatchInlineSnapshot(`
        ".z0{--z0:#06c;}
        .z_0{color:var(--z0,#06c);}"
      `)
  })

  test('invalid authoring fails before CSS can be emitted without reading accessors', () => {
    const invalid = [
      { color: { brand: { light: '#fff' } } },
      { color: { brand: { dark: '#000', light: '#fff', system: '#ccc' } } },
      { color: { 'blue.500': '#fff' } },
      { color: {} },
    ]

    for (const input of invalid) {
      let error: unknown

      try {
        const theme = Reflect.apply(Theme.define, undefined, [
          input,
        ]) as Theme.Definition

        Css.compile({ styles: Style.define({}), vars: { base: theme } })
      } catch (cause) {
        error = cause
      }

      expect(error instanceof Theme.InvalidError).toMatchInlineSnapshot('true')
    }

    let reads = 0

    const input = {
      color: {
        get brand() {
          reads++

          return '#fff' as const
        },
      },
    }

    expect(() => Theme.define(input)).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["color"]: Expected nonempty keys without dots and enumerable data properties.]`,
    )
    expect(reads).toMatchInlineSnapshot('0')
  })
})

describe('extend', () => {
  test('object-shaped length overrides fail at the public boundary', () => {
    const theme = Theme.define({ spacing: { md: '1lh' } })

    expect(() =>
      Theme.extend(theme, { spacing: { md: {} } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["spacing","md"]: A token leaf cannot become a palette.]`,
    )
    expect(() =>
      Theme.extend(theme, { spacing: { md: [] } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["spacing","md"]: Expected a plain data record.]`,
    )
    expect(() =>
      Theme.extend(theme, { spacing: { md: () => '2rem' } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["spacing","md"]: Expected a plain data record.]`,
    )
  })

  test('undefined override leaves fail while omitted leaves inherit', () => {
    const theme = Theme.define({
      color: { brand: '#06c' },
      spacing: { md: '1lh' },
    })
    const alternate = Theme.extend(theme, { color: { brand: '#fff' } })
    const styles = Style.define({ card: { padding: theme.tokens.spacing.md } })

    expect(Css.compile({ styles, vars: { alternate, base: theme } }).css)
      .toMatchInlineSnapshot(`
        ".z0{--z0:1lh;}
        .z1{--z0:1lh;}
        .z_0{padding:var(--z0,1lh);}"
      `)
    expect(() =>
      Theme.extend(theme, { spacing: { md: undefined } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["spacing","md"]: Expected a plain data record.]`,
    )
    expect(() =>
      Theme.extend(theme, { color: { brand: undefined } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["color","brand"]: Expected a plain data record.]`,
    )
  })

  test('compatible overrides retain identities and reset every live inherited value', () => {
    const input = {
      color: { blue: { 500: '#06c' } },
      spacing: { md: '8px' },
    } as const
    const theme = Theme.define(input)
    const alternate = Theme.extend(theme, { color: { blue: { 500: '#f00' } } })
    const nested = Theme.extend(alternate, { spacing: { md: '12px' } })

    const styles = Style.define({
      button: {
        color: theme.tokens.color.blue[500],
        padding: theme.tokens.spacing.md,
      },
    })

    expect(
      Css.compile({ styles, vars: { alternate, base: theme, nested } }).css,
    ).toMatchInlineSnapshot(`
      ".z0{--z0:#f00;--z1:8px;}
      .z1{--z0:#06c;--z1:8px;}
      .z2{--z0:#f00;--z1:12px;}
      .z_0{color:var(--z0,#06c);}
      .z_1{padding:var(--z1,8px);}"
    `)
    expect(
      Css.compile({
        styles: Style.define({
          button: { color: alternate.tokens.color.blue[500] },
        }),
      }).css,
    ).toMatchInlineSnapshot(`".z_0{color:var(--z0,#f00);}"`)
    expect(input).toMatchInlineSnapshot(`
      {
        "color": {
          "blue": {
            "500": "#06c",
          },
        },
        "spacing": {
          "md": "8px",
        },
      }
    `)
    expect(() =>
      Reflect.apply(Theme.extend, undefined, [
        theme,
        { color: { blue: { 600: '#fff' } } },
      ]),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["color","blue","600"]: Extensions cannot add token paths.]`,
    )
    expect(() =>
      Reflect.apply(Theme.extend, undefined, [
        theme,
        { spacing: { md: { extra: '2px' } } },
      ]),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Theme.InvalidError: ["spacing","md"]: A token leaf cannot become a palette.]`,
    )
  })

  test('scopes and preferred schemes render independently in Chromium', async () => {
    const theme = Theme.define(tokens)
    const alternate = Theme.extend(theme, {
      backgroundColor: { surface: { dark: '#222', light: '#eee' } },
      spacing: { md: '16px' },
    })
    const nested = Theme.extend(theme, { color: { brand: '#f00' } })

    const styles = Style.define({
      button: {
        backgroundColor: theme.tokens.backgroundColor.surface,
        color: theme.tokens.color.brand,
        padding: theme.tokens.spacing.md,
      },
    })

    const output = Css.compile({
      styles,
      vars: { alternate, base: theme, nested },
    })
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage({ colorScheme: 'light' })

      await page.setContent(`<style>:root{color-scheme:light dark}${output.css}</style>
        <div id="fallback" class="${output.classes.button}"></div>
        <section class="${output.vars.alternate}">
          <div id="alternate" class="${output.classes.button}"></div>
          <section class="${output.vars.nested}"><div id="nested" class="${output.classes.button}"></div></section>
          <div id="forced" style="color-scheme:dark" class="${output.classes.button}"></div>
        </section>`)

      async function read(id: string) {
        return page.locator(`#${id}`).evaluate((element) => {
          const style = getComputedStyle(element)

          return {
            backgroundColor: style.backgroundColor,
            color: style.color,
            padding: style.padding,
          }
        })
      }

      expect(await read('fallback')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(255, 255, 255)",
          "color": "rgb(0, 102, 204)",
          "padding": "8px",
        }
      `)
      expect(await read('alternate')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(238, 238, 238)",
          "color": "rgb(0, 102, 204)",
          "padding": "16px",
        }
      `)
      expect(await read('nested')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(255, 255, 255)",
          "color": "rgb(255, 0, 0)",
          "padding": "8px",
        }
      `)
      expect(await read('forced')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(34, 34, 34)",
          "color": "rgb(0, 102, 204)",
          "padding": "16px",
        }
      `)

      await page.emulateMedia({ colorScheme: 'dark' })

      expect(await read('fallback')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(17, 17, 17)",
          "color": "rgb(0, 102, 204)",
          "padding": "8px",
        }
      `)
      expect(await read('nested')).toMatchInlineSnapshot(`
        {
          "backgroundColor": "rgb(17, 17, 17)",
          "color": "rgb(255, 0, 0)",
          "padding": "8px",
        }
      `)
    } finally {
      await browser.close()
    }
  })
})

describe('queries', () => {
  describe('compile', () => {
    test('preserves dashed and non-ASCII container identifiers', () => {
      expect(() =>
        Theme.define({ containerNames: ['--sidebar', '-sidebar', '侧栏'] }),
      ).not.toThrow()
    })
    test('retains query groups in packed configuration options', () => {
      const result = Graph.compile({
        modules: {
          'config.ts':
            'import {Config,Vars} from "zyzz"; const theme=Vars.define({breakpoint:{tablet:"48rem"},container:{card:"24rem"},containerNames:["sidebar"]}); export const zyzz=Config.create({vars:theme})',
        },
      })

      expect(
        JSON.parse(result.contracts['config.ts']!).version,
      ).toMatchInlineSnapshot(`31`)
      expect(JSON.parse(result.contracts['config.ts']!).exports.zyzz.options)
        .toMatchInlineSnapshot(`
          {
            "theme": {
              "breakpoint": {
                "tablet": "48rem",
              },
              "container": {
                "card": "24rem",
              },
              "containerNames": [
                "sidebar",
              ],
            },
          }
        `)
    })
    test('resolves numeric scale names and preserves typography palette keys', () => {
      const theme = Theme.define({
        fontSize: { '2xl': '1.5rem' },
        borderRadius: { '2xl': '1rem' },
      })

      expect(
        Css.compile({
          styles: Style.define(
            { body: { fontSize: '2xl', borderRadius: '2xl' } },
            { vars: theme },
          ),
        }).css,
      ).toMatchInlineSnapshot(
        `
        ".z_0{font-size:var(--z0,1.5rem);}
        .z_1{border-radius:var(--z1,1rem);}"
      `,
      )
    })
    test('keeps generated bundled values synchronized', async () => {
      const source = await Fs.readFile(
        new URL('./default.ts', import.meta.url),
        'utf8',
      )
      const result = Graph.compile({ modules: { 'default.ts': source } })
      const contract = JSON.parse(result.contracts['default.ts']!)
      const { containerNames: _, ...generated } = Object.values(
        contract.themes as Record<string, { tokens: Record<string, unknown> }>,
      )[0]!.tokens
      expect(
        Util.isDeepStrictEqual(generated, contextTokens),
      ).toMatchInlineSnapshot(`true`)
    })
    test('links bundled source through its exported style boundary', async () => {
      const source = await Fs.readFile(
        new URL('./default.ts', import.meta.url),
        'utf8',
      )

      const output = Graph.compile({
        modules: {
          'default.ts': source,
          'app.ts':
            'import {style} from "./default.js"; export const body=style({fontFamily:"sans",fontSize:"base",color:"blue.500"})()',
        },
      })

      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-default-theme{--z-default-fontFamily-sans:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-fontSize-base:1rem;--z-default-color-blue-500:light-dark(#99ceff,#0a4380);--z-default-animate-spin:z-kid-zyzz_2d_spin 1s linear infinite;--z-default-animate-ping:z-kid-zyzz_2d_ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;--z-default-animate-pulse:z-kid-zyzz_2d_pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;--z-default-animate-bounce:z-kid-zyzz_2d_bounce 1s infinite;--z-default-aspect-video:16 / 9;--z-default-blur-xs:4px;--z-default-blur-sm:8px;--z-default-blur-md:12px;--z-default-blur-lg:16px;--z-default-blur-xl:24px;--z-default-blur-2xl:40px;--z-default-blur-3xl:64px;--z-default-color-amber-100:light-dark(#fff6e5,#291800);--z-default-color-amber-200:light-dark(#fff4d6,#331b00);--z-default-color-amber-300:light-dark(#fef0cd,#4d2a00);--z-default-color-amber-400:light-dark(#ffdd8f,#573300);--z-default-color-amber-500:light-dark(#ffc96b,#6b4105);--z-default-color-amber-600:light-dark(#f5b047,#e79d13);--z-default-color-amber-700:#ffb224;--z-default-color-amber-800:#ff990a;--z-default-color-amber-900:light-dark(#a35200,#f2a20d);--z-default-color-amber-1000:light-dark(#4e2009,#fef3dc);--z-default-color-background-primary:light-dark(#fafafa,#000);--z-default-color-background-surface:light-dark(#fff,#0a0a0a);--z-default-color-black:#000;--z-default-color-blue-100:light-dark(#f0f7ff,#0f1c2e);--z-default-color-blue-200:light-dark(#ebf5ff,#10233d);--z-default-color-blue-300:light-dark(#e0f0ff,#0f2f57);--z-default-color-blue-400:light-dark(#cce6ff,#0d3868);--z-default-color-blue-600:light-dark(#52aeff,#0091ff);--z-default-color-blue-700:#0072f5;--z-default-color-blue-800:#0062d1;--z-default-color-blue-900:light-dark(#0068d6,#52a8ff);--z-default-color-blue-1000:light-dark(#00254d,#ebf6ff);--z-default-color-foreground:light-dark(#171717,#ededed);--z-default-color-gray-100:light-dark(#f2f2f2,#1a1a1a);--z-default-color-gray-200:light-dark(#ebebeb,#1f1f1f);--z-default-color-gray-300:light-dark(#e6e6e6,#292929);--z-default-color-gray-400:light-dark(#ebebeb,#2e2e2e);--z-default-color-gray-500:light-dark(#c9c9c9,#454545);--z-default-color-gray-600:light-dark(#a8a8a8,#878787);--z-default-color-gray-700:#8f8f8f;--z-default-color-gray-800:#7d7d7d;--z-default-color-gray-900:light-dark(#4d4d4d,#a1a1a1);--z-default-color-gray-1000:light-dark(#171717,#ededed);--z-default-color-grayAlpha-100:light-dark(#0000000d,#ffffff0f);--z-default-color-grayAlpha-200:light-dark(#00000014,#ffffff17);--z-default-color-grayAlpha-300:light-dark(#0000001a,#ffffff21);--z-default-color-grayAlpha-400:light-dark(#00000014,#ffffff24);--z-default-color-grayAlpha-500:light-dark(#00000036,#ffffff3d);--z-default-color-grayAlpha-600:light-dark(#00000057,#ffffff82);--z-default-color-grayAlpha-700:light-dark(#00000070,#ffffff8a);--z-default-color-grayAlpha-800:light-dark(#00000082,#ffffff78);--z-default-color-grayAlpha-900:light-dark(#000000b3,#ffffff9c);--z-default-color-grayAlpha-1000:light-dark(#000000e8,#ffffffeb);--z-default-color-green-100:light-dark(#effbef,#0b2212);--z-default-color-green-200:light-dark(#ebfaeb,#0f2e18);--z-default-color-green-300:light-dark(#daf6da,#12361b);--z-default-color-green-400:light-dark(#c6f1c7,#0c451b);--z-default-color-green-500:light-dark(#99e69e,#126426);--z-default-color-green-600:light-dark(#6cda75,#1a9338);--z-default-color-green-700:#45a557;--z-default-color-green-800:#398e4a;--z-default-color-green-900:light-dark(#297a3a,#62c073);--z-default-color-green-1000:light-dark(#1b311e,#e5fbea);--z-default-color-pink-100:light-dark(#ffebf5,#28151d);--z-default-color-pink-200:light-dark(#feecf2,#3a1726);--z-default-color-pink-300:light-dark(#fce3ec,#4f1c31);--z-default-color-pink-400:light-dark(#f9d7e2,#551b33);--z-default-color-pink-500:light-dark(#f5b8cc,#6c1e3e);--z-default-color-pink-600:light-dark(#ee87a7,#b31957);--z-default-color-pink-700:#ea3e83;--z-default-color-pink-800:#df2670;--z-default-color-pink-900:light-dark(#bd2864,#f75f8f);--z-default-color-pink-1000:light-dark(#430a23,#feecf4);--z-default-color-purple-100:light-dark(#f9f0ff,#231528);--z-default-color-purple-200:light-dark(#f9f1fe,#2e1938);--z-default-color-purple-300:light-dark(#f4e8fc,#422154);--z-default-color-purple-400:light-dark(#eddcf9,#4f2768);--z-default-color-purple-500:light-dark(#d5b1f1,#5f2e85);--z-default-color-purple-600:light-dark(#bf89ec,#8e4ec6);--z-default-color-purple-700:#8e4ec6;--z-default-color-purple-800:#763da9;--z-default-color-purple-900:light-dark(#7820bc,#bf7af0);--z-default-color-purple-1000:light-dark(#2e004d,#f8edfc);--z-default-color-red-100:light-dark(#fff0f0,#2a1314);--z-default-color-red-200:light-dark(#ffebeb,#3c1618);--z-default-color-red-300:light-dark(#ffe5e5,#561a1e);--z-default-color-red-400:light-dark(#fdd8d8,#671e21);--z-default-color-red-500:light-dark(#f8b9b9,#832126);--z-default-color-red-600:light-dark(#f87275,#e5484d);--z-default-color-red-700:#e5484d;--z-default-color-red-800:light-dark(#da2f35,#d93036);--z-default-color-red-900:light-dark(#cb2a2f,#ff6166);--z-default-color-red-1000:light-dark(#391417,#feecee);--z-default-color-teal-100:light-dark(#eefcf9,#04201b);--z-default-color-teal-200:light-dark(#e5faf6,#062822);--z-default-color-teal-300:light-dark(#d4f7f0,#083a33);--z-default-color-teal-400:light-dark(#bef4eb,#053d35);--z-default-color-teal-500:light-dark(#86ead9,#085e53);--z-default-color-teal-600:light-dark(#45dec5,#0c9784);--z-default-color-teal-700:#12a594;--z-default-color-teal-800:#0d8c7d;--z-default-color-teal-900:light-dark(#067a6e,#0ac7b4);--z-default-color-teal-1000:light-dark(#073c34,#e0faf4);--z-default-color-white:#fff;--z-default-container-3xs:16rem;--z-default-container-2xs:18rem;--z-default-container-xs:20rem;--z-default-container-sm:24rem;--z-default-container-md:28rem;--z-default-container-lg:32rem;--z-default-container-xl:36rem;--z-default-container-2xl:42rem;--z-default-container-3xl:48rem;--z-default-container-4xl:56rem;--z-default-container-5xl:64rem;--z-default-container-6xl:72rem;--z-default-container-7xl:80rem;--z-default-dropShadow-xs:0 1px 1px rgb(0 0 0 / 0.05);--z-default-dropShadow-sm:0 1px 2px rgb(0 0 0 / 0.15);--z-default-dropShadow-md:0 3px 3px rgb(0 0 0 / 0.12);--z-default-dropShadow-lg:0 4px 4px rgb(0 0 0 / 0.15);--z-default-dropShadow-xl:0 9px 7px rgb(0 0 0 / 0.1);--z-default-dropShadow-2xl:0 25px 25px rgb(0 0 0 / 0.15);--z-default-ease-in:cubic-bezier(0.4, 0, 1, 1);--z-default-ease-out:cubic-bezier(0, 0, 0.2, 1);--z-default-ease-in_2d_out:cubic-bezier(0.4, 0, 0.2, 1);--z-default-fontFamily-mono:"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--z-default-fontFamily-serif:ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;--z-default-fontSize-xs:0.75rem;--z-default-fontSize-sm:0.875rem;--z-default-fontSize-lg:1.125rem;--z-default-fontSize-xl:1.25rem;--z-default-fontSize-2xl:1.5rem;--z-default-fontSize-3xl:1.875rem;--z-default-fontSize-4xl:2.25rem;--z-default-fontSize-5xl:3rem;--z-default-fontSize-6xl:3.75rem;--z-default-fontSize-7xl:4.5rem;--z-default-fontSize-8xl:6rem;--z-default-fontSize-9xl:8rem;--z-default-fontWeight-thin:100;--z-default-fontWeight-extralight:200;--z-default-fontWeight-light:300;--z-default-fontWeight-normal:400;--z-default-fontWeight-medium:500;--z-default-fontWeight-semibold:600;--z-default-fontWeight-bold:700;--z-default-fontWeight-extrabold:800;--z-default-fontWeight-black:900;--z-default-insetShadow-2xs:inset 0 1px rgb(0 0 0 / 0.05);--z-default-insetShadow-xs:inset 0 1px 1px rgb(0 0 0 / 0.05);--z-default-insetShadow-sm:inset 0 2px 4px rgb(0 0 0 / 0.05);--z-default-letterSpacing-tighter:-0.05em;--z-default-letterSpacing-tight:-0.025em;--z-default-letterSpacing-normal:0em;--z-default-letterSpacing-wide:0.025em;--z-default-letterSpacing-wider:0.05em;--z-default-letterSpacing-widest:0.1em;--z-default-lineHeight-tight:1.25;--z-default-lineHeight-snug:1.375;--z-default-lineHeight-normal:1.5;--z-default-lineHeight-relaxed:1.625;--z-default-lineHeight-loose:2;--z-default-perspective-dramatic:100px;--z-default-perspective-near:300px;--z-default-perspective-normal:500px;--z-default-perspective-midrange:800px;--z-default-perspective-distant:1200px;--z-default-radius-xs:0.125rem;--z-default-radius-sm:0.25rem;--z-default-radius-md:0.375rem;--z-default-radius-lg:0.5rem;--z-default-radius-xl:0.75rem;--z-default-radius-2xl:1rem;--z-default-radius-3xl:1.5rem;--z-default-radius-4xl:2rem;--z-default-shadow-2xs:0 1px rgb(0 0 0 / 0.05);--z-default-shadow-xs:0 1px 2px 0 rgb(0 0 0 / 0.05);--z-default-shadow-sm:0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1);--z-default-shadow-md:0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);--z-default-shadow-lg:0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);--z-default-shadow-xl:0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);--z-default-shadow-2xl:0 25px 50px -12px rgb(0 0 0 / 0.25);--z-default-shadow-inner:inset 0 2px 4px 0 rgb(0 0 0 / 0.05);--z-default-spacing-0:0rem;--z-default-spacing-1:0.25rem;--z-default-spacing-2:0.5rem;--z-default-spacing-3:0.75rem;--z-default-spacing-4:1rem;--z-default-spacing-5:1.25rem;--z-default-spacing-6:1.5rem;--z-default-spacing-7:1.75rem;--z-default-spacing-8:2rem;--z-default-spacing-9:2.25rem;--z-default-spacing-10:2.5rem;--z-default-spacing-11:2.75rem;--z-default-spacing-12:3rem;--z-default-spacing-14:3.5rem;--z-default-spacing-16:4rem;--z-default-spacing-20:5rem;--z-default-spacing-24:6rem;--z-default-spacing-28:7rem;--z-default-spacing-32:8rem;--z-default-spacing-36:9rem;--z-default-spacing-40:10rem;--z-default-spacing-44:11rem;--z-default-spacing-48:12rem;--z-default-spacing-52:13rem;--z-default-spacing-56:14rem;--z-default-spacing-60:15rem;--z-default-spacing-64:16rem;--z-default-spacing-72:18rem;--z-default-spacing-80:20rem;--z-default-spacing-96:24rem;--z-default-spacing-0-5:0.125rem;--z-default-spacing-1-5:0.375rem;--z-default-spacing-2-5:0.625rem;--z-default-spacing-3-5:0.875rem;--z-default-spacing-px:1px;--z-default-textShadow-2xs:0px 1px 0px rgb(0 0 0 / 0.15);--z-default-textShadow-xs:0px 1px 1px rgb(0 0 0 / 0.2);--z-default-textShadow-sm:0px 1px 0px rgb(0 0 0 / 0.075), 0px 1px 1px rgb(0 0 0 / 0.075), 0px 2px 2px rgb(0 0 0 / 0.075);--z-default-textShadow-md:0px 1px 1px rgb(0 0 0 / 0.1), 0px 1px 2px rgb(0 0 0 / 0.1), 0px 2px 4px rgb(0 0 0 / 0.1);--z-default-textShadow-lg:0px 1px 2px rgb(0 0 0 / 0.1), 0px 3px 2px rgb(0 0 0 / 0.1), 0px 4px 8px rgb(0 0 0 / 0.1);--z-default-typography-button-12-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-button-12-fontSize:12px;--z-default-typography-button-12-fontWeight:500;--z-default-typography-button-12-letterSpacing:0px;--z-default-typography-button-12-lineHeight:16px;--z-default-typography-button-14-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-button-14-fontSize:14px;--z-default-typography-button-14-fontWeight:500;--z-default-typography-button-14-letterSpacing:0px;--z-default-typography-button-14-lineHeight:20px;--z-default-typography-button-16-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-button-16-fontSize:16px;--z-default-typography-button-16-fontWeight:500;--z-default-typography-button-16-letterSpacing:0px;--z-default-typography-button-16-lineHeight:20px;--z-default-typography-copy-13-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-13-fontSize:13px;--z-default-typography-copy-13-fontWeight:400;--z-default-typography-copy-13-letterSpacing:0px;--z-default-typography-copy-13-lineHeight:18px;--z-default-typography-copy-13-mono-fontFamily:"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--z-default-typography-copy-13-mono-fontSize:13px;--z-default-typography-copy-13-mono-fontWeight:400;--z-default-typography-copy-13-mono-letterSpacing:0px;--z-default-typography-copy-13-mono-lineHeight:18px;--z-default-typography-copy-14-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-14-fontSize:14px;--z-default-typography-copy-14-fontWeight:400;--z-default-typography-copy-14-letterSpacing:0px;--z-default-typography-copy-14-lineHeight:20px;--z-default-typography-copy-14-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-14-strong-fontSize:14px;--z-default-typography-copy-14-strong-fontWeight:550;--z-default-typography-copy-14-strong-letterSpacing:0px;--z-default-typography-copy-14-strong-lineHeight:20px;--z-default-typography-copy-16-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-16-fontSize:16px;--z-default-typography-copy-16-fontWeight:400;--z-default-typography-copy-16-letterSpacing:0px;--z-default-typography-copy-16-lineHeight:24px;--z-default-typography-copy-16-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-16-strong-fontSize:16px;--z-default-typography-copy-16-strong-fontWeight:550;--z-default-typography-copy-16-strong-letterSpacing:0px;--z-default-typography-copy-16-strong-lineHeight:24px;--z-default-typography-copy-18-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-18-fontSize:18px;--z-default-typography-copy-18-fontWeight:400;--z-default-typography-copy-18-letterSpacing:0px;--z-default-typography-copy-18-lineHeight:28px;--z-default-typography-copy-18-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-18-strong-fontSize:18px;--z-default-typography-copy-18-strong-fontWeight:550;--z-default-typography-copy-18-strong-letterSpacing:0px;--z-default-typography-copy-18-strong-lineHeight:28px;--z-default-typography-copy-20-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-20-fontSize:20px;--z-default-typography-copy-20-fontWeight:400;--z-default-typography-copy-20-letterSpacing:0px;--z-default-typography-copy-20-lineHeight:28px;--z-default-typography-copy-20-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-20-strong-fontSize:20px;--z-default-typography-copy-20-strong-fontWeight:550;--z-default-typography-copy-20-strong-letterSpacing:0px;--z-default-typography-copy-20-strong-lineHeight:28px;--z-default-typography-copy-24-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-24-fontSize:24px;--z-default-typography-copy-24-fontWeight:400;--z-default-typography-copy-24-letterSpacing:0px;--z-default-typography-copy-24-lineHeight:36px;--z-default-typography-copy-24-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-copy-24-strong-fontSize:24px;--z-default-typography-copy-24-strong-fontWeight:550;--z-default-typography-copy-24-strong-letterSpacing:0px;--z-default-typography-copy-24-strong-lineHeight:36px;--z-default-typography-heading-14-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-14-fontSize:14px;--z-default-typography-heading-14-fontWeight:600;--z-default-typography-heading-14-letterSpacing:-.28px;--z-default-typography-heading-14-lineHeight:20px;--z-default-typography-heading-16-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-16-fontSize:16px;--z-default-typography-heading-16-fontWeight:600;--z-default-typography-heading-16-letterSpacing:-.32px;--z-default-typography-heading-16-lineHeight:24px;--z-default-typography-heading-16-subtle-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-16-subtle-fontSize:16px;--z-default-typography-heading-16-subtle-fontWeight:500;--z-default-typography-heading-16-subtle-letterSpacing:-.32px;--z-default-typography-heading-16-subtle-lineHeight:24px;--z-default-typography-heading-20-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-20-fontSize:20px;--z-default-typography-heading-20-fontWeight:600;--z-default-typography-heading-20-letterSpacing:-.4px;--z-default-typography-heading-20-lineHeight:26px;--z-default-typography-heading-20-subtle-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-20-subtle-fontSize:20px;--z-default-typography-heading-20-subtle-fontWeight:500;--z-default-typography-heading-20-subtle-letterSpacing:-.4px;--z-default-typography-heading-20-subtle-lineHeight:26px;--z-default-typography-heading-24-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-24-fontSize:24px;--z-default-typography-heading-24-fontWeight:600;--z-default-typography-heading-24-letterSpacing:-.96px;--z-default-typography-heading-24-lineHeight:32px;--z-default-typography-heading-24-subtle-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-24-subtle-fontSize:24px;--z-default-typography-heading-24-subtle-fontWeight:500;--z-default-typography-heading-24-subtle-letterSpacing:-.96px;--z-default-typography-heading-24-subtle-lineHeight:32px;--z-default-typography-heading-32-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-32-fontSize:32px;--z-default-typography-heading-32-fontWeight:600;--z-default-typography-heading-32-letterSpacing:-1.28px;--z-default-typography-heading-32-lineHeight:40px;--z-default-typography-heading-32-subtle-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-32-subtle-fontSize:32px;--z-default-typography-heading-32-subtle-fontWeight:500;--z-default-typography-heading-32-subtle-letterSpacing:-1.28px;--z-default-typography-heading-32-subtle-lineHeight:40px;--z-default-typography-heading-40-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-40-fontSize:40px;--z-default-typography-heading-40-fontWeight:600;--z-default-typography-heading-40-letterSpacing:-2.4px;--z-default-typography-heading-40-lineHeight:48px;--z-default-typography-heading-48-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-48-fontSize:48px;--z-default-typography-heading-48-fontWeight:600;--z-default-typography-heading-48-letterSpacing:-2.88px;--z-default-typography-heading-48-lineHeight:56px;--z-default-typography-heading-56-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-56-fontSize:56px;--z-default-typography-heading-56-fontWeight:600;--z-default-typography-heading-56-letterSpacing:-3.36px;--z-default-typography-heading-56-lineHeight:56px;--z-default-typography-heading-64-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-64-fontSize:64px;--z-default-typography-heading-64-fontWeight:600;--z-default-typography-heading-64-letterSpacing:-3.84px;--z-default-typography-heading-64-lineHeight:64px;--z-default-typography-heading-72-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-heading-72-fontSize:72px;--z-default-typography-heading-72-fontWeight:600;--z-default-typography-heading-72-letterSpacing:-4.32px;--z-default-typography-heading-72-lineHeight:72px;--z-default-typography-label-12-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-12-fontSize:12px;--z-default-typography-label-12-fontWeight:400;--z-default-typography-label-12-letterSpacing:0px;--z-default-typography-label-12-lineHeight:16px;--z-default-typography-label-12-mono-fontFamily:"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--z-default-typography-label-12-mono-fontSize:12px;--z-default-typography-label-12-mono-fontWeight:400;--z-default-typography-label-12-mono-letterSpacing:0px;--z-default-typography-label-12-mono-lineHeight:16px;--z-default-typography-label-12-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-12-strong-fontSize:12px;--z-default-typography-label-12-strong-fontWeight:500;--z-default-typography-label-12-strong-letterSpacing:0px;--z-default-typography-label-12-strong-lineHeight:16px;--z-default-typography-label-13-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-13-fontSize:13px;--z-default-typography-label-13-fontWeight:400;--z-default-typography-label-13-letterSpacing:0px;--z-default-typography-label-13-lineHeight:16px;--z-default-typography-label-13-mono-fontFamily:"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--z-default-typography-label-13-mono-fontSize:13px;--z-default-typography-label-13-mono-fontWeight:400;--z-default-typography-label-13-mono-letterSpacing:0px;--z-default-typography-label-13-mono-lineHeight:20px;--z-default-typography-label-13-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-13-strong-fontSize:13px;--z-default-typography-label-13-strong-fontWeight:500;--z-default-typography-label-13-strong-letterSpacing:0px;--z-default-typography-label-13-strong-lineHeight:16px;--z-default-typography-label-14-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-14-fontSize:14px;--z-default-typography-label-14-fontWeight:400;--z-default-typography-label-14-letterSpacing:0px;--z-default-typography-label-14-lineHeight:20px;--z-default-typography-label-14-mono-fontFamily:"Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--z-default-typography-label-14-mono-fontSize:14px;--z-default-typography-label-14-mono-fontWeight:400;--z-default-typography-label-14-mono-letterSpacing:0px;--z-default-typography-label-14-mono-lineHeight:20px;--z-default-typography-label-14-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-14-strong-fontSize:14px;--z-default-typography-label-14-strong-fontWeight:500;--z-default-typography-label-14-strong-letterSpacing:0px;--z-default-typography-label-14-strong-lineHeight:20px;--z-default-typography-label-16-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-16-fontSize:16px;--z-default-typography-label-16-fontWeight:400;--z-default-typography-label-16-letterSpacing:0px;--z-default-typography-label-16-lineHeight:20px;--z-default-typography-label-16-strong-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-16-strong-fontSize:16px;--z-default-typography-label-16-strong-fontWeight:500;--z-default-typography-label-16-strong-letterSpacing:0px;--z-default-typography-label-16-strong-lineHeight:20px;--z-default-typography-label-18-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-18-fontSize:18px;--z-default-typography-label-18-fontWeight:400;--z-default-typography-label-18-letterSpacing:0px;--z-default-typography-label-18-lineHeight:20px;--z-default-typography-label-20-fontFamily:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z-default-typography-label-20-fontSize:20px;--z-default-typography-label-20-fontWeight:400;--z-default-typography-label-20-letterSpacing:0px;--z-default-typography-label-20-lineHeight:32px;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_default-Zf5JrJ0{font-family:var(--z-default-fontFamily-sans,Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");}
        .z_default-Zf5JrJ1{font-size:var(--z-default-fontSize-base,1rem);}
        .z_default-Zf5JrJ2{color:var(--z-default-color-blue-500,light-dark(#99ceff,#0a4380));}"
      `)

      const built = await Esbuild.build({
        stdin: {
          contents: 'import * as root from "zyzz/compiler"; console.log(root)',
          resolveDir: import.meta.dirname,
        },
        bundle: true,
        platform: 'node',
        external: ['oxc-parser', 'lightningcss'],
        write: false,
        metafile: true,
        conditions: ['src'],
      })

      expect(
        Object.keys(built.metafile!.inputs).some((path) =>
          /(?:^|[/\\])(?:src|dist)[/\\]default\.[cm]?[jt]s$/.test(path),
        ),
      ).toMatchInlineSnapshot(`false`)
    })
    test('rejects sparse and accessor container identities', () => {
      const sparse: string[] = []

      sparse.length = 1

      expect(() => Theme.define({ containerNames: sparse })).toThrow(
        Theme.InvalidError,
      )

      let invoked = false

      const names = Object.defineProperty([], '0', {
        get() {
          invoked = true

          return 'card'
        },
      })

      expect(() => Theme.define({ containerNames: names })).toThrow(
        Theme.InvalidError,
      )
      expect(invoked).toMatchInlineSnapshot(`false`)
    })
    test('emits typography variables without emitting threshold variables', () => {
      const theme = Theme.define({
        breakpoint: { tablet: '48rem' },
        container: { card: '24rem' },
        containerNames: ['sidebar'],
        fontSize: { body: '1rem' },
        fontWeight: { medium: 500 },
      })

      const alternate = Theme.extend(theme, {
        breakpoint: { tablet: '50rem' },
        fontSize: { body: '1.25rem' },
      })

      const styles = Style.define({
        body: {
          fontSize: theme.tokens.fontSize.body,
          fontWeight: theme.tokens.fontWeight.medium,
        },
      })

      const output = Css.compile({ styles, vars: { base: theme, alternate } })

      expect(output.css).toMatchInlineSnapshot(`
        ".z0{--z0:1rem;--z1:500;}
        .z1{--z0:1.25rem;--z1:500;}
        .z_0{font-size:var(--z0,1rem);}
        .z_1{font-weight:var(--z1,500);}"
      `)
      expect(Object.keys(theme.vars)).toMatchInlineSnapshot(`
      [
        "fontSize",
        "fontWeight",
      ]
    `)
    })
    test('retains query metadata in packed contracts', () => {
      const library = Graph.compile({
        modules: {
          'theme.ts':
            'import {Vars} from "zyzz"; export const theme=Vars.define({breakpoint:{tablet:"48rem"},fontSize:{body:"1rem"}})',
        },
      })

      const packed = library.contracts['theme.ts']!

      expect(packed.includes('48rem')).toMatchInlineSnapshot(`true`)

      const consumer = Graph.compile({
        contracts: { 'library.js': packed },
        imports: { 'app.ts': { library: 'library.js', zyzz: null } },
        modules: {
          'app.ts':
            'import {Config} from "zyzz"; import {theme} from "library"; const config=Config.create({vars:theme}); export const body=config.style({fontSize:"body"})()',
        },
      })

      expect(consumer.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-fontSize-body:1rem;}
        .z_Zf5JrJ0{font-size:var(--z-fontSize-body,1rem);}"
      `)
    })
    test('Chromium applies bundled typography and Geist colors across schemes', async () => {
      const styles = Style.define({
        body: {
          fontSize: bundled.fontSize.base,
          color: bundled.color.foreground,
        },
      })

      const output = Css.compile({ styles, vars: { base: bundled } })
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div class="${output.vars.base}" style="color-scheme:light"><p id="body" class="${output.classes.body}">Text</p></div>`,
        )

        expect(
          await page
            .locator('#body')
            .evaluate((element) => getComputedStyle(element).fontSize),
        ).toMatchInlineSnapshot(`"16px"`)
        expect(
          await page
            .locator('#body')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(23, 23, 23)"`)

        await page
          .locator('#body')
          .evaluate(
            (element) => (element.parentElement!.style.colorScheme = 'dark'),
          )

        expect(
          await page
            .locator('#body')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(237, 237, 237)"`)
      } finally {
        await browser.close()
      }
    })
    test('compiles the opt-in bundled typography and palette', () => {
      const styles = Style.define({
        body: {
          color: bundled.color.foreground,
          fontFamily: bundled.fontFamily.sans,
          fontSize: bundled.fontSize.base,
          padding: bundled.spacing[4],
        },
      })

      const output = Css.compile({ styles, vars: { default: bundled } })

      expect(output.css).toMatchInlineSnapshot(`
        ".z0{--z0:light-dark(#171717,#ededed);--z1:Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";--z2:1rem;--z3:1rem;}
        .z_0{color:var(--z0,light-dark(#171717,#ededed));}
        .z_1{font-family:var(--z1,Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");}
        .z_2{font-size:var(--z2,1rem);}
        .z_3{padding:var(--z3,1rem);}"
      `)
      expect(contextTokens.breakpoint.md).toMatchInlineSnapshot(`"48rem"`)
    })
    test.each([
      '"-1px"',
      '"50%"',
      '20',
      '"var(--screen)"',
      '{light:"1px",dark:"2px"}',
    ])('rejects invalid threshold %s', (value) => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {Vars} from "zyzz"; const theme=Vars.define({breakpoint:{tablet:${value}}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:39: ["breakpoint","tablet"]: Expected a named nonnegative length threshold.]`,
      )
    })
  })

  describe('define', () => {
    test('preserves typography palette and exponent threshold keys', () => {
      expect(
        Theme.define({
          fontWeight: { body: { light: 300, bold: 700 } },
          container: { screen: '1e3px' },
        }).tokens.fontWeight.body.light.value,
      ).toMatchInlineSnapshot(`300`)
    })
  })
})
