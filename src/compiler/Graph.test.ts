import { Vars } from 'zyzz'
/**
 * Exercises linked source modules through compilation and actual module execution.
 * @module
 */
import * as ConfigFixture from '../../test/fixtures/ConfigGraph.js'
import * as Fixture from '../../test/fixtures/ThemeGraph.js'
import * as Packed from '../../test/fixtures/Packed.js'
import * as Responsive from '../../test/fixtures/Responsive.js'
import * as Universal from '../../test/fixtures/UniversalLibrary.js'
import * as Library from '../../test/fixtures/VariantLibrary.js'
import * as ClassName from '../web/internal/ClassName.js'
import * as ThemeRules from '../web/internal/Themes.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Util from 'node:util'
import * as Vm from 'node:vm'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Graph, Source, Transform } from 'zyzz/compiler'
import { Host } from 'zyzz/node'
import { Css } from 'zyzz/web'

const root = Path.resolve(import.meta.dirname, '../..')
const modules = Fixture.modules

describe('compile', () => {
  test('retains literal token exports across packed configurations and re-exports', () => {
    const publisher = Graph.compile({
      modules: {
        'index.ts': `export * from './left.js'; export * from './right.js';`,
        'left.ts': `export { tokens as palette } from './tokens.js';`,
        'mutated.ts': `export const tokens = {color:{ink:'red'}}; tokens.color.ink='blue';`,
        'right.ts': `export { tokens as palette } from './tokens.js';`,
        'tokens.ts': `const ink = '#123456'; export const tokens = { color: { ink }, spacing: { gap: '7px' } } as const;`,
      },
    })
    expect(publisher.contracts['mutated.ts']).toMatchInlineSnapshot(`undefined`)

    const options = {
      contracts: { library: publisher.contracts['index.ts']! },
      imports: {
        'config.ts': { library: 'library', 'zyzz/base-ui/react': null },
        'item.ts': {
          './config.js': 'config.ts',
          '@base-ui/react/select': null,
        },
      },
      modules: {
        'config.ts': `import {palette} from 'library'; import {defineConfig} from 'zyzz/base-ui/react'; export const {style} = defineConfig({id:'packed',vars:palette});`,
        'item.ts': `import {Select} from '@base-ui/react/select'; import {style} from './config.js'; export const item=style(Select.Item,{padding:'gap',states:{highlighted:{color:'ink'}}});`,
      },
    }

    const result = Graph.compile(options)
    expect(result.modules['item.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-packed-theme{--z-packed-spacing-gap:7px;--z-packed-color-ink:#123456;}
      .z_packed-mhCyMV0{padding:var(--z-packed-spacing-gap,7px);}
      .z_packed-mhCyMV1{&[data-highlighted]{color:var(--z-packed-color-ink,#123456);}}"
    `)

    const contract = JSON.parse(publisher.contracts['index.ts']!)
    contract.version = 34
    expect(() =>
      Graph.compile({
        ...options,
        contracts: { library: JSON.stringify(contract) },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library:0: Invalid library contract: Literal exports require contract version 35 or later.]`,
    )

    contract.version = 35
    contract.literals.palette = `(()=>{throw new Error('must not run')})()`
    expect(() =>
      Graph.compile({
        ...options,
        contracts: { library: JSON.stringify(contract) },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library:0: Invalid library contract: Invalid packed literal export.]`,
    )
  })

  test('validates packed native style catalogs', () => {
    const publisher = Graph.compile({
      modules: {
        'styles.ts': `import {Config} from 'zyzz';const {style}=Config.create({defaultVars:'base',vars:{base:{color:{ink:'#123456'}},alternate:{color:{ink:'#abcdef'}}}});export const card=style({color:'ink'});`,
      },
    })
    const contract = JSON.parse(publisher.contracts['styles.ts']!)
    const compile = () =>
      Graph.compile({
        contracts: { 'styles.ts': JSON.stringify(contract) },
        modules: {
          'app.ts': `import {card} from './styles.js';export const result=card();`,
        },
        native: { colorScheme: 'light', contextual: true, platform: 'ios' },
      })
    expect(contract.version).toMatchInlineSnapshot(`33`)
    contract.version = 32
    expect(compile).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: styles.ts:0: Invalid library contract: Native style catalogs require contract version 33 or later.]`,
    )
    contract.version = 33
    contract.exports.card.nativeContext.defaultVars = 'missing'
    expect(compile).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: styles.ts:0: Invalid library contract: Invalid packed native style default.]`,
    )
    contract.exports.card.nativeContext.defaultVars = 'base'
    contract.exports.card.nativeContext.vars.base = 'missing'
    expect(compile).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: styles.ts:0: Invalid library contract: Unknown packed native style catalog.]`,
    )
  })

  test('versions packed native provider metadata', () => {
    const native = {
      colorScheme: 'light',
      contextual: true,
      platform: 'ios',
    } as const
    const publisher = Graph.compile({
      modules: {
        'config.ts': `import {defineConfig} from 'zyzz/react-native/react';export const config=defineConfig({vars:{color:{ink:'#123456'}}});`,
      },
      native,
    })
    const contract = JSON.parse(publisher.contracts['config.ts']!)

    expect(contract.version).toMatchInlineSnapshot(`32`)
    contract.version = 31
    expect(() =>
      Graph.compile({
        contracts: { 'config.ts': JSON.stringify(contract) },
        modules: {
          'app.ts': `import {config} from './config.js';export const vars=config.vars;`,
        },
        native,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:0: Invalid library contract: Native providers require contract version 32 or later.]`,
    )
  })

  test('qualifies readable utilities with their module path', async () => {
    const source = `import {style} from 'zyzz';export const heading=style({display:'inline-grid',opacity:0,filter:'blur(4px)'})();`
    const first = Transform.compile({ moduleId: 'one.ts', source })
    const second = Transform.compile({ moduleId: 'nested/two.ts', source })

    expect(Object.values(first.classes)).toMatchInlineSnapshot(`
      [
        "z_9Ak_080 z_9Ak_081 z_9Ak_082",
      ]
    `)
    expect(first.css).toMatchInlineSnapshot(`
      ".z_9Ak_080{display:inline-grid;}
      .z_9Ak_081{opacity:0;}
      .z_9Ak_082{filter:blur(4px);}"
    `)
    expect(first.css === second.css).toMatchInlineSnapshot(`false`)
    expect(
      Object.values(first.classes).join(' ') ===
        Object.values(second.classes).join(' '),
    ).toMatchInlineSnapshot(`false`)

    const contextual = Source.extract({
      moduleId: 'named.ts',
      source:
        "import {style} from 'zyzz';export const heading=style({opacity:0,selectors:{'&:hover':{opacity:1}}})();",
    })
    expect(Object.values(Css.compile({ styles: contextual.styles }).classes))
      .toMatchInlineSnapshot(`
        [
          "z_0 z_1",
        ]
      `)

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${first.css}</style><h1 class="${Object.values(first.classes)[0]}">Heading</h1>`,
      )

      expect(
        await page
          .locator('h1')
          .evaluate((node) => getComputedStyle(node).display),
      ).toMatchInlineSnapshot('"inline-grid"')
      expect(
        await page
          .locator('h1')
          .evaluate((node) => getComputedStyle(node).filter),
      ).toMatchInlineSnapshot('"blur(4px)"')
      expect(
        await page
          .locator('h1')
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toMatchInlineSnapshot('"0"')
    } finally {
      await browser.close()
    }
  })

  test('preserves variable path boundaries in browser assignments', async () => {
    const source = `import {style,variable} from 'zyzz';
export const fields={'foo-bar':variable('color'),foo:{bar:variable('color')}};
export const flat=style({color:fields['foo-bar'],vars:{[fields['foo-bar']]:'red',[fields.foo.bar]:'blue'}})();
export const nested=style({color:fields.foo.bar,vars:{[fields['foo-bar']]:'red',[fields.foo.bar]:'blue'}})();`
    const output = Transform.compile({ moduleId: 'paths.js', source })
    const code = await Packed.bundle({
      entry: 'paths.js',
      modules: { 'paths.js': output.code },
    })
    const fixture = Vm.runInNewContext(`${code}\nFixture`) as {
      fields: { 'foo-bar': { name: string }; foo: { bar: { name: string } } }
      flat: { className: string }
      nested: { className: string }
    }

    expect(fixture.fields['foo-bar'].name).toMatchInlineSnapshot(
      '"--z-fields-foo_2d_bar"',
    )
    expect(fixture.fields.foo.bar.name).toMatchInlineSnapshot(
      '"--z-fields-foo-bar"',
    )

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${output.css}</style><div id="flat" class="${fixture.flat.className}">Flat</div><div id="nested" class="${fixture.nested.className}">Nested</div>`,
      )
      expect(
        await page
          .locator('#flat')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page
          .locator('#nested')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('isolates repeated namespace members across modules in both CSS modes', async () => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      for (const cssOutput of ['atomic', 'grouped'] as const) {
        const output = Graph.compile({
          modules: {
            'config.js': `import {Config} from 'zyzz';export const {style}=Config.create({cssOutput:'${cssOutput}'});`,
            'button.ts': `import {style} from './config.js';namespace styles{export const card=style({color:'red',selectors:{'&:hover':{color:'green'}}})}export const props=styles.card();`,
            'button.tsx': `import {style} from './config.js';namespace styles{export const card=style({color:'blue',selectors:{'&:hover':{color:'purple'}}})}export const props=styles.card();`,
            'entry.js': `export {props as left} from './button.ts';export {props as right} from './button.tsx';`,
          },
        })
        const code = await Packed.bundle({
          entry: 'entry.js',
          modules: {
            'config.js': output.modules['config.js']!.code,
            'left.js': output.modules['button.ts']!.code,
            'right.js': output.modules['button.tsx']!.code,
            'entry.js':
              "export {props as left} from './left.js';export {props as right} from './right.js';",
          },
        })
        const fixture = Vm.runInNewContext(`${code}\nFixture`) as {
          left: { className: string }
          right: { className: string }
        }
        expect(
          fixture.left.className === fixture.right.className,
        ).toMatchInlineSnapshot('false')
        await page.setContent(
          `<style>${Object.values(output.modules)
            .map((module) => module.css)
            .join(
              '',
            )}</style><div id="left" class="${fixture.left.className}">Left</div><div id="right" class="${fixture.right.className}">Right</div>`,
        )
        expect(
          await page
            .locator('#left')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        expect(
          await page
            .locator('#right')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
        await page.locator('#left').hover()
        expect(
          await page
            .locator('#left')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot('"rgb(0, 128, 0)"')
        await page.locator('#right').hover()
        expect(
          await page
            .locator('#right')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot('"rgb(128, 0, 128)"')
        await page.mouse.move(0, 0)
      }
    } finally {
      await browser.close()
    }
  })

  test('separates config IDs from explicit style IDs', async () => {
    const output = Graph.compile({
      modules: {
        'left.js':
          "import {Config} from 'zyzz';const {style}=Config.create({id:'a-b'});export const props=style({color:'red',selectors:{'&:hover':{color:'green'}}},{id:'card'})();",
        'right.js':
          "import {Config} from 'zyzz';const {style}=Config.create({id:'a'});export const props=style({color:'blue',selectors:{'&:hover':{color:'purple'}}},{id:'b-card'})();",
        'entry.js':
          "export {props as left} from './left.js';export {props as right} from './right.js';",
      },
    })
    const code = await Packed.bundle({
      entry: 'entry.js',
      modules: Object.fromEntries(
        Object.entries(output.modules).map(([name, module]) => [
          name,
          module.code,
        ]),
      ),
    })
    const fixture = Vm.runInNewContext(`${code}\nFixture`) as {
      left: { className: string }
      right: { className: string }
    }
    expect(fixture.left.className).toMatchInlineSnapshot(
      `"z_a_2d_b-A4MzJF0 z_a_2d_b-A4MzJF1"`,
    )
    expect(fixture.right.className).toMatchInlineSnapshot(
      `"z_a-oRmHDO0 z_a-oRmHDO1"`,
    )
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${Object.values(output.modules)
          .map((module) => module.css)
          .join(
            '',
          )}</style><div id="left" class="${fixture.left.className}">Left</div><div id="right" class="${fixture.right.className}">Right</div>`,
      )
      expect(
        await page
          .locator('#left')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page
          .locator('#right')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('versions standalone readable identifier contracts consistently', () => {
    for (const source of [
      "import {variable} from 'zyzz';export const gap=variable('length');",
      "import {keyframes} from 'zyzz/web';export const spin=keyframes({to:{transform:'rotate(1turn)'}});",
      "import {customMedia} from 'zyzz/web';export const narrow=customMedia('(width < 40rem)');",
    ]) {
      const library = Graph.compile({ modules: { 'library.js': source } })
      expect(
        JSON.parse(library.contracts['library.js']!).version,
      ).toMatchInlineSnapshot(`31`)
      expect(() =>
        Graph.compile({
          contracts: library.contracts,
          modules: {
            'app.js': "import * as values from 'library.js';export {values};",
          },
        }),
      ).not.toThrow()
    }
  })

  test('namespaces independently authored configs using consumer ids', async () => {
    const source = (id: string, color: string) =>
      `import {Config} from 'zyzz';export const {style,vars}=Config.create({id:'${id}',vars:{color:{brand:'${color}'}}});export const heading=style({color:'brand',selectors:{'&:hover':{opacity:1}}})();export const scope=vars().className;`
    const modules = {
      'first.js': source('first', 'red'),
      'second.js': source('second', 'blue'),
      'entry.js': `export {heading as firstHeading,scope as firstScope} from './first.js';export {heading as secondHeading,scope as secondScope} from './second.js';`,
    }
    const output = Graph.compile({ modules })

    expect(output.modules['first.js']!.css).toMatchInlineSnapshot(`
      ".z-theme-first-theme{--z-first-color-brand:red;}
      .z-theme-second-theme{--z-second-color-brand:blue;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_first-bugww80{color:var(--z-first-color-brand,red);}
      .z_first-bugww81{&:hover{opacity:1;}}"
    `)
    expect(output.modules['second.js']!.css).toMatchInlineSnapshot(`
      ".z-theme-first-theme{--z-first-color-brand:red;}
      .z-theme-second-theme{--z-second-color-brand:blue;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_second-XWlTb20{color:var(--z-second-color-brand,blue);}
      .z_second-XWlTb21{&:hover{opacity:1;}}"
    `)
    const code = await Packed.bundle({
      entry: 'entry.js',
      modules: Object.fromEntries(
        Object.entries(output.modules).map(([name, module]) => [
          name,
          module.code,
        ]),
      ),
    })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${Object.values(output.modules)
          .map((module) => module.css)
          .join('')}</style>`,
      )
      await page.addScriptTag({ content: code })
      await page.evaluate(() => {
        const fixture = (
          window as typeof window & {
            Fixture: {
              firstHeading: { className: string }
              firstScope: string
              secondHeading: { className: string }
              secondScope: string
            }
          }
        ).Fixture
        document.body.innerHTML = `<div class="${fixture.firstScope}"><p id="first" class="${fixture.firstHeading.className}"></p></div><div class="${fixture.secondScope}"><p id="second" class="${fixture.secondHeading.className}"></p></div>`
      })

      expect(
        await page
          .locator('#first')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('rejects incompatible config scope names without consumer ids', () => {
    const source = (color: string) =>
      `import {Config} from 'zyzz';export const {style,vars}=Config.create({vars:{color:{brand:'${color}'}}});export const heading=style({color:'brand'})();export const scope=vars().className;`

    expect(() =>
      Graph.compile({
        modules: { 'first.js': source('red'), 'second.js': source('blue') },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Css.CompileError: ["second.js"]: Generated scope z-theme-theme conflicts with module first.js. Supply distinct config or style ids.]`,
    )
  })

  test('derives standalone variable names from bindings and preserves explicit ids', () => {
    const output = Transform.compile({
      moduleId: 'variables.ts',
      source: `import {style,variable} from 'zyzz';namespace variables{export const offset=variable('length');export const explicit=variable('length',{id:'heading-offset'});}export const heading=style({width:variables.offset,height:variables.explicit})();`,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z_CqGk9p0{width:var(--z-variables-offset);}
      .z_CqGk9p1{height:var(--z-heading_2d_offset);}"
    `)
    expect(output.code.includes('--z-variables-offset')).toMatchInlineSnapshot(
      'true',
    )
    expect(output.code.includes('--z-heading_2d_offset')).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('shares responsive defaults across modules and replaces obsolete defaults on edits', async () => {
    const compiler = Graph.create()
    const output = compiler.compile({ modules: Responsive.modules })

    expect(
      output.sharedCss?.match(/:where\(\*\)/g)?.length,
    ).toMatchInlineSnapshot('4')

    expect(
      Object.values(output.modules).some((module) =>
        module.css.includes(':where(*)'),
      ),
    ).toMatchInlineSnapshot('false')

    const code = await Packed.bundle({
      entry: 'entry.js',
      modules: Object.fromEntries(
        Object.entries(output.modules).map(([name, module]) => [
          name,
          module.code,
        ]),
      ),
    })
    await Responsive.verify({
      code,
      css: [
        output.sharedCss,
        ...Object.values(output.modules).map((module) => module.css),
      ].join('\n'),
    })

    const changed = compiler.compile({
      modules: {
        ...Responsive.modules,
        'config.js': Responsive.modules['config.js'].replace(
          "'14px'",
          "'18px'",
        ),
      },
    })
    expect(changed.sharedCss?.includes(':14px;')).toMatchInlineSnapshot('false')
    expect(changed.sharedCss?.match(/:18px;/g)?.length).toMatchInlineSnapshot(
      '1',
    )

    const removed = compiler.compile({
      modules: { 'entry.js': 'export const value=1' },
    })
    expect(removed.sharedCss).toMatchInlineSnapshot('undefined')
  })

  test('publishes shared token resources once instead of in every module', () => {
    const output = Graph.compile({
      [ThemeRules.shared]: 'all',
      compiler: false,
      modules: {
        'config.ts': `import { Config } from 'zyzz'; export const { style } = Config.create({ id: 'app', vars: { color: { brand: '#06c' }, spacing: { md: '8px' } } });`,
        ...Object.fromEntries(
          Array.from({ length: 3 }, (_, index) => [
            `card${index}.ts`,
            `import { style } from './config.js'; export const card = style({ color: 'brand', padding: 'md', zIndex: ${index} });`,
          ]),
        ),
      },
    })

    expect(
      Object.values(output.modules).filter(
        (module) => module[ThemeRules.shared],
      ).length,
    ).toMatchInlineSnapshot(`0`)
    expect(
      Object.values(output.modules).flatMap((module) =>
        Object.keys(module[ClassName.rules]).filter((name) =>
          name.startsWith('@scope:'),
        ),
      ).length,
    ).toMatchInlineSnapshot(`0`)

    expect(output.sharedCss).toMatchInlineSnapshot(
      `".z-theme-app-theme{--z-app-color-brand:#06c;--z-app-spacing-md:8px;}"`,
    )
  })

  test('keeps readable variable labels distinct across modules and token paths', async () => {
    const modules = {
      'first/config.ts': `import {Config} from 'zyzz';export const {style,vars}=Config.create({id:'first',mappings:false,vars:{'label-size':'14px',label:{size:'20px'}}});export const first=style({fontSize:'label-size'})();export const nested=style({fontSize:'label.size'})();`,
      'second/config.ts': `import {Config} from 'zyzz';export const {style,vars}=Config.create({id:'second',mappings:false,vars:{'label-size':'24px'}});export const second=style({fontSize:'label-size'})();`,
      'entry.ts': `export {first,nested,vars as firstVars} from './first/config.js';export {second,vars as secondVars} from './second/config.js';`,
    }
    const result = Graph.compile({ modules })
    const css = Object.values(result.modules)
      .map((module) => module.css)
      .join('\n')
    expect(
      new Set(css.match(/--z-(?:first|second)-label[\w-]*(?=:)/g)).size,
    ).toMatchInlineSnapshot(`3`)
    const reversed = Graph.compile({
      modules: Object.fromEntries(Object.entries(modules).reverse()),
    })
    expect(
      reversed.modules['first/config.ts']!.css ===
        result.modules['first/config.ts']!.css,
    ).toMatchInlineSnapshot('true')

    const code = await Packed.bundle({
      entry: 'entry.ts',
      modules: Object.fromEntries(
        Object.entries(result.modules).map(([name, module]) => [
          name,
          module.code,
        ]),
      ),
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${css}</style><div class="${fixture.firstVars().className}"><p id="first" class="${fixture.first.className}"></p><p id="nested" class="${fixture.nested.className}"></p></div><div class="${fixture.secondVars().className}"><p id="second" class="${fixture.second.className}"></p></div>`,
      )
      expect(
        await page
          .locator('#first')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot('"14px"')
      expect(
        await page
          .locator('#nested')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot('"20px"')
      expect(
        await page
          .locator('#second')
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toMatchInlineSnapshot('"24px"')
    } finally {
      await browser.close()
    }
  })

  test('preserves styles across component imports and generated modules', () => {
    const compiler = Graph.create()
    const input = {
      modules: {
        'tokens.ts': "export const tokens={color:'red'}",
        'component.ts':
          "import {tokens} from './tokens';export default function Component(){return tokens.color}",
        'styles.ts':
          "import {style} from 'zyzz';import {tokens} from './tokens';export const button=style({color:tokens.color})",
      },
      imports: {
        'tokens.ts': {},
        'component.ts': { './tokens': 'tokens.ts' },
        'styles.ts': { zyzz: null, './tokens': 'tokens.ts' },
      },
    }
    const first = compiler.compile(input)
    const added = compiler.compile({
      ...input,
      imports: { ...input.imports, 'generated.ts': {} },
      modules: {
        ...input.modules,
        'generated.ts': 'export const generated=true',
      },
    })
    expect(
      added.modules['styles.ts']!.css === first.modules['styles.ts']!.css,
    ).toMatchInlineSnapshot('true')
    compiler.compile({
      imports: { 'other.ts': {} },
      modules: { 'other.ts': 'export const other=true' },
    })
    const returned = compiler.compile(input)
    expect(Object.keys(returned.modules)).toMatchInlineSnapshot(`
      [
        "component.ts",
        "styles.ts",
        "tokens.ts",
      ]
    `)
    expect(
      returned.modules['styles.ts']!.css === first.modules['styles.ts']!.css,
    ).toMatchInlineSnapshot('true')
    compiler.compile({
      imports: { 'tokens.ts': {} },
      modules: { 'tokens.ts': "export const tokens={color:'blue'}" },
    })
    const changed = compiler.compile({
      ...input,
      modules: {
        ...input.modules,
        'tokens.ts': "export const tokens={color:'blue'}",
      },
    })
    expect(
      changed.modules['styles.ts']!.css.includes('color:blue;'),
    ).toMatchInlineSnapshot('true')
  })

  test('uses exported default typography values in global declarations', async () => {
    const result = Graph.compile({
      modules: {
        'default.ts': await Fs.readFile(
          Path.join(root, 'src/default.ts'),
          'utf8',
        ),
        'config.ts': `import {tokens} from './default.js';import {global} from 'zyzz/web';global({button:tokens.typography.button['16']});`,
      },
    })

    expect(result.sharedCss).toContain('button{')
    expect(result.sharedCss).toContain('font-size:16px')
    expect(result.sharedCss).toContain('line-height:20px')
    expect(result.sharedCss).toContain('font-family:Geist,')
  })

  test('rejects mutations of literal objects used in global declarations', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'config.ts': `import {global} from 'zyzz/web';const copy={fontSize:'16px'};copy.fontSize='24px';global({body:copy});`,
        },
      }),
    ).toThrow('Static data cannot be mutated')
  })

  test('preserves shared style ownership across successive compositions', async () => {
    const result = Graph.compile({
      modules: {
        'shared.ts': `import {style} from 'zyzz'; export const paragraph = style({margin: 0});`,
        'first.ts': `import {cx,style} from 'zyzz'; import {paragraph} from './shared.js'; const detail = style({marginBlockStart: '24px'},{id:'first-detail'}); export const first = cx(paragraph(), detail());`,
        'second.ts': `import {cx,style} from 'zyzz'; import {paragraph} from './shared.js'; const detail = style({marginBlockStart: '72px'},{id:'second-detail'}); export const second = cx(paragraph(), detail());`,
        'entry.ts': `export {first} from './first.js'; export {second} from './second.js';`,
      },
      imports: {
        'shared.ts': { zyzz: null },
        'first.ts': { zyzz: null, './shared.js': 'shared.ts' },
        'second.ts': { zyzz: null, './shared.js': 'shared.ts' },
        'entry.ts': { './first.js': 'first.ts', './second.js': 'second.ts' },
      },
    })
    const code = await Packed.bundle({
      entry: 'entry.ts',
      modules: Object.fromEntries(
        Object.entries(result.modules).map(([name, module]) => [
          name,
          module.code,
        ]),
      ),
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${result.sharedCss ?? ''}${Object.values(result.modules)
          .map((module) => module.css)
          .join(
            '',
          )}</style><p id="first" class="${fixture.first.className}"></p><p id="second" class="${fixture.second.className}"></p>`,
      )
      expect(
        await page
          .locator('#first')
          .evaluate((node) => getComputedStyle(node).marginTop),
      ).toBe('24px')
      expect(
        await page
          .locator('#second')
          .evaluate((node) => getComputedStyle(node).marginTop),
      ).toBe('72px')
    } finally {
      await browser.close()
    }
  })

  test('releases native graph inputs while retaining source maps', async () => {
    const directory = await Fs.mkdtemp(
      Path.resolve('.fixture-native-retention-'),
    )
    try {
      // The bundle sits two levels below the root, as source modules do, so it finds the addon.
      const outfile = Path.join(directory, 'dist', 'retention.mjs')
      await Esbuild.build({
        bundle: true,
        entryPoints: [
          Path.join(root, 'test/fixtures/process/NativeRetention.ts'),
        ],
        format: 'esm',
        outfile,
        packages: 'external',
        platform: 'node',
      })
      const { stdout } = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        ['--expose-gc', outfile],
      )
      const result = JSON.parse(stdout)

      expect(result.released).toMatchInlineSnapshot('true')
      expect(result.sources).toMatchInlineSnapshot(`
        [
          "app.ts",
        ]
      `)
      expect(result.sourcesContent).toMatchInlineSnapshot(`
        [
          "import {style} from 'zyzz';export const card=style({width:'12px'});",
        ]
      `)
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  test.each([
    `import * as ns from './library.js';export {ns};`,
    `import label,* as ns from './library.js';export {ns,label};`,
    `export * as ns from './library.js';`,
  ])('executes packed native namespaces: %s', async (source) => {
    const root = await Fs.mkdtemp(Path.resolve('.fixture-native-namespace-'))
    try {
      const library = Graph.compile({
        modules: {
          'library.ts': `import {variants} from 'zyzz';export let count=0;export function increment(){count++};export default 'ordinary';export const card=variants({base:{opacity:0.2},variants:{size:{small:{fontSize:'12px'},large:{fontSize:'20px'}}},defaultVariants:{size:'small'}});export namespace styles {export const label='nested';export const button=variants({base:{opacity:0.7}});}`,
        },
      })
      const output = Graph.compile({
        contracts: { 'library.js': library.contracts['library.ts']! },
        imports: { 'app.ts': { './library.js': 'library.js' } },
        modules: { 'app.ts': source },
        native: { colorScheme: 'light' },
      })
      const js = await Esbuild.transform(library.modules['library.ts']!.code, {
        loader: 'ts',
        format: 'esm',
      })
      await Fs.writeFile(Path.join(root, 'library.js'), js.code)
      await Fs.writeFile(
        Path.join(root, 'library.ts'),
        library.modules['library.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(root, 'app.ts'),
        output.modules['app.ts']!.code,
      )
      await Fs.writeFile(
        Path.join(root, 'consumer.ts'),
        `import {ns} from './app.js';ns.card({size:'large'}).style;ns.styles.button().style;
// @ts-expect-error Packed choices remain finite.
ns.card({size:'huge'});
// @ts-expect-error Native props exclude web class names.
ns.card({className:'web'});`,
      )
      await Util.promisify(ChildProcess.execFile)(process.execPath, [
        Path.resolve('node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--module',
        'nodenext',
        '--target',
        'esnext',
        '--strict',
        '--skipLibCheck',
        Path.join(root, 'consumer.ts'),
      ]).catch((error) => {
        throw new Error(error.stdout || error.message)
      })
      const contract = JSON.parse(output.contracts['app.ts']!)
      expect(() =>
        Graph.compile({
          modules: {},
          contracts: {
            'barrel.js': JSON.stringify({ ...contract, version: 21 }),
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: barrel.js:0: Invalid library contract: Invalid style reference member.]`,
      )
      const downstream = Graph.compile({
        contracts: { 'barrel.js': output.contracts['app.ts']! },
        imports: { 'consumer.ts': { './barrel.js': 'barrel.js' } },
        modules: {
          'consumer.ts': `import {ns} from './barrel.js';export const props=ns.card({size:'large'});`,
        },
        native: { colorScheme: 'light' },
      })
      expect(
        downstream.modules['consumer.ts']!.code.includes('fontSize'),
      ).toMatchInlineSnapshot('true')
      const bundle = await Esbuild.build({
        entryPoints: [Path.join(root, 'app.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
      })
      await Fs.writeFile(
        Path.join(root, 'app.mjs'),
        bundle.outputFiles[0]!.text,
      )
      const exec = Util.promisify(ChildProcess.execFile)
      const result = await exec(process.execPath, [
        '--input-type=module',
        '-e',
        `import {ns} from ${JSON.stringify(Path.join(root, 'app.mjs'))};const before=ns.count;ns.increment();console.log(JSON.stringify({before,after:ns.count,default:ns.default,props:ns.card({size:'large'}),nested:ns.styles.button(),label:ns.styles.label,frozen:Object.isFrozen(ns)}));`,
      ])
      expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
        {
          "after": 1,
          "before": 0,
          "default": "ordinary",
          "frozen": true,
          "label": "nested",
          "nested": {
            "style": {
              "opacity": 0.7,
            },
          },
          "props": {
            "style": {
              "fontSize": 20,
              "opacity": 0.2,
            },
          },
        }
      `)
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  test('executes one source-free package in browser and native consumers', async () => {
    const directory = await Fs.mkdtemp(
      Path.join(Os.tmpdir(), 'zyzz-universal-consumer-'),
    )
    try {
      const library = await Universal.create(directory)
      expect(
        (await Fs.readdir(Path.join(library.installed, 'native'))).some(
          (file) => file.endsWith('.ts') && !file.endsWith('.d.ts'),
        ),
      ).toMatchInlineSnapshot('false')
      const contract = await Fs.readFile(
        Path.join(library.installed, 'web/index.js.zyzz.json'),
        'utf8',
      )
      const source = `import {button} from '@acme/universal';export const props=button({size:'large',active:true});`
      const inputs = {
        contracts: { '@acme/universal/index.js': contract },
        imports: {
          'app.ts': { '@acme/universal': '@acme/universal/index.js' },
        },
        modules: { 'app.ts': source },
      }
      const native = Graph.compile({
        ...inputs,
        native: { colorScheme: 'dark', platform: 'android' },
      })
      const web = Graph.compile(inputs)
      await Fs.writeFile(
        Path.join(directory, 'native.ts'),
        native.modules['app.ts']!.code,
      )
      const built = await Esbuild.build({
        entryPoints: [Path.join(directory, 'native.ts')],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
      })
      await Fs.writeFile(
        Path.join(directory, 'native.mjs'),
        built.outputFiles[0]!.text,
      )
      const exec = Util.promisify(ChildProcess.execFile)
      const executed = await exec(process.execPath, [
        '--input-type=module',
        '-e',
        `import {props} from ${JSON.stringify(Path.join(directory, 'native.mjs'))};console.log(JSON.stringify(props));`,
      ])
      expect(executed.stdout).toMatchInlineSnapshot(`
        "{"style":{"color":"#abcdef","fontSize":20,"opacity":0.8}}
        "
      `)
      const published = await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {button} from '@acme/universal/native';console.log(JSON.stringify(button({size:'large',active:true})));`,
        ],
        { cwd: directory },
      )
      expect(published.stdout).toMatchInlineSnapshot(`
        "{"style":{"color":"#123456","fontSize":20,"opacity":0.8}}
        "
      `)
      await Fs.writeFile(
        Path.join(directory, 'consumer.ts'),
        `import {button} from '@acme/universal/native';import {props} from './native.js';button({size:'large',active:true});button({size:null});props.style;
// @ts-expect-error Choices stay finite across the package boundary.
button({size:'huge'});
// @ts-expect-error Native props exclude web class names.
button({className:'web'});`,
      )
      await exec(process.execPath, [
        Path.join(root, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--module',
        'nodenext',
        '--target',
        'esnext',
        '--strict',
        '--skipLibCheck',
        Path.join(directory, 'consumer.ts'),
      ]).catch((error) => {
        throw new Error(error.stdout || error.message)
      })
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage({ colorScheme: 'dark' })
        const bundle = await Esbuild.build({
          stdin: {
            contents: `import '@acme/universal/style.css';
${web.modules['app.ts']!.code}`,
            loader: 'ts',
            resolveDir: directory,
          },
          bundle: true,
          platform: 'browser',
          format: 'iife',
          globalName: 'Fixture',
          outdir: Path.join(directory, 'browser'),
          write: false,
        })
        const css = bundle.outputFiles.find((file) =>
          file.path.endsWith('.css'),
        )!.text
        await page.setContent(
          `<style>:root{color-scheme:dark}${css}${web.modules['app.ts']!.css}</style><div id="button"></div><div id="control" style="color:#abcdef;font-size:20px;opacity:0.8"></div>`,
        )
        await page.addScriptTag({
          content:
            bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text +
            `;const element=document.querySelector('#button');for(const [key,value] of Object.entries(Fixture.props)){if(key==='style')Object.assign(element.style,value);else element.setAttribute(key==='className'?'class':key,String(value))}`,
        })
        const computed = await page.locator('#button').evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            opacity: style.opacity,
          }
        })
        expect(computed).toMatchInlineSnapshot(`
          {
            "color": "rgb(171, 205, 239)",
            "fontSize": "20px",
            "opacity": "0.8",
          }
        `)
        const control = await page.locator('#control').evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: style.fontSize,
            opacity: style.opacity,
          }
        })
        expect(
          JSON.stringify(computed) === JSON.stringify(control),
        ).toMatchInlineSnapshot('true')
      } finally {
        await browser.close()
      }
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  }, 120000)

  test.each([
    ['web', 'single'],
    ['native', 'single'],
    ['web', 'base,mint'],
    ['web', 'mint,base'],
    ['native', 'base,mint'],
    ['native', 'mint,base'],
  ] as const)(
    'compiles packed %s recipes with catalog order %s into native consumer callables',
    async (target, order) => {
      const themes = Object.fromEntries(
        order.split(',').map((name) => [
          name,
          {
            color: {
              ink: {
                light: name === 'base' ? '#000000' : '#008844',
                dark: name === 'base' ? '#ffffff' : '#00ff88',
              },
            },
          },
        ]),
      )
      const source = `import {Config} from 'zyzz';const {variants}=Config.create(${JSON.stringify(order === 'single' ? { vars: { color: { ink: { light: '#000000', dark: '#ffffff' } } } } : { defaultVars: 'base', vars: themes })});export const card=variants({base:{color:'ink'},variants:{size:{small:{fontSize:'12px'},large:{fontSize:'20px'}}},defaultVariants:{size:'small'},compoundVariants:[{when:{size:'large'},style:{targets:{ios:{opacity:0.7},android:{opacity:0.8}}}}]});`
      const library = Graph.compile({
        modules: { 'library/card.ts': source },
        ...(target === 'native'
          ? {
              native: {
                colorScheme: 'light' as const,
                platform: 'ios' as const,
              },
            }
          : {}),
      })
      const output = Graph.compile({
        contracts: { 'library/card.ts': library.contracts['library/card.ts']! },
        imports: { 'app/index.ts': { library: 'library/card.ts' } },
        modules: {
          'app/index.ts': `import {card as button} from 'library';export {card} from 'library';export const result=button({size:'large'});`,
        },
        native: { colorScheme: 'dark', platform: 'android' },
      })
      const directory = await Fs.mkdtemp(
        Path.join(root, '.fixture-native-packed-'),
      )
      try {
        await Fs.writeFile(
          Path.join(directory, 'package.json'),
          JSON.stringify({ type: 'module', sideEffects: true }),
        )
        await Fs.writeFile(
          Path.join(directory, 'library.ts'),
          library.modules['library/card.ts']!.code,
        )
        const built = await Esbuild.build({
          stdin: {
            contents: output.modules['app/index.ts']!.code,
            loader: 'ts',
            resolveDir: root,
          },
          alias: {
            library: Path.join(directory, 'library.ts'),
            'zyzz/runtime': Path.join(root, 'src/runtime/index.ts'),
            zyzz: Path.join(root, 'src/index.ts'),
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
        })
        await Fs.writeFile(
          Path.join(directory, 'bundle.mjs'),
          built.outputFiles[0]!.text,
        )
        const executed = await Util.promisify(ChildProcess.execFile)(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import {result,card} from ${JSON.stringify(Path.join(directory, 'bundle.mjs'))};console.log(JSON.stringify(result));console.log(JSON.stringify(card()));`,
          ],
        )
        expect(executed.stdout).toMatchInlineSnapshot(`
          "{"style":{"color":"#ffffff","fontSize":20,"opacity":0.8}}
          {"style":{"color":"#ffffff","fontSize":12}}
          "
        `)
        expect(output.dependencies['app/index.ts']).toMatchInlineSnapshot(`
          [
            "library/card.ts",
          ]
        `)
        if (order === 'single')
          expect(
            JSON.parse(output.contracts['app/index.ts']!).version,
          ).toMatchInlineSnapshot(`31`)
        else
          expect(
            JSON.parse(output.contracts['app/index.ts']!).version,
          ).toMatchInlineSnapshot(`33`)
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }
    },
  )

  test('reads rule references alongside version 21 callable recipes', () => {
    const library = Graph.compile({
      modules: {
        'library.ts': `import {style} from 'zyzz';import {customMedia} from 'zyzz/web';export const card=style({opacity:0.5});export const compact=customMedia('(width < 40rem)');`,
      },
    })
    const output = Graph.compile({
      contracts: { 'library.js': library.contracts['library.ts']! },
      imports: { 'app.ts': { library: 'library.js' } },
      modules: { 'app.ts': `export {card,compact} from 'library';` },
    })

    expect(
      JSON.parse(output.contracts['app.ts']!).version,
    ).toMatchInlineSnapshot(`31`)
    expect(
      JSON.parse(output.contracts['app.ts']!).exports.compact.kind,
    ).toMatchInlineSnapshot('"rule-reference"')
  })

  test.each([
    `import {type Props} from 'types';`,
    `export {type Props} from 'types';`,
  ])('skips native specifier-only type dependencies: %s', (source) => {
    const output = Graph.compile({
      imports: { 'app.ts': { zyzz: null } },
      modules: {
        'app.ts': `${source}import {style} from 'zyzz';export const card=style({opacity:0.5});`,
      },
      native: { colorScheme: 'light' },
    })

    expect(output.dependencies['app.ts']).toMatchInlineSnapshot('[]')
    expect(
      output.modules['app.ts']!.code.includes('"opacity":0.5'),
    ).toMatchInlineSnapshot('true')
  })

  test.each([
    `import card from 'library';export const props=card();`,
    `export * from 'library';`,
    `export {default as card} from 'library';`,
  ])('retains native types through packed import forms: %s', (source) => {
    const library = Graph.compile({
      modules: {
        'library.ts': `import {style} from 'zyzz';export const card=style({opacity:0.5});export {card as default};`,
      },
    })
    const result = Graph.compile({
      contracts: { 'library.js': library.contracts['library.ts']! },
      imports: { 'app.ts': { library: 'library.js' } },
      modules: { 'app.ts': source },
      native: { colorScheme: 'light' },
    })
    expect(
      result.modules['app.ts']!.code.includes('Native.Callable'),
    ).toMatchInlineSnapshot('true')
    expect(
      result.modules['app.ts']!.code.includes('"opacity":0.5'),
    ).toMatchInlineSnapshot('true')
  })

  test('rejects missing and malformed packed native recipes', () => {
    const library = Graph.compile({
      modules: {
        'library.ts': `import {variants} from 'zyzz';export const card=variants({variants:{size:{small:{opacity:0.5}}}});`,
      },
    })
    const raw = JSON.parse(library.contracts['library.ts']!)
    const compile = (contract: string) =>
      Graph.compile({
        contracts: { 'library.ts': contract },
        imports: { 'app.ts': { './library.js': 'library.ts' } },
        modules: {
          'app.ts': `import {card} from './library.js';export const result=card();`,
        },
        native: { colorScheme: 'light' },
      })
    delete raw.exports.card.style.staticRecipe
    expect(() =>
      compile(JSON.stringify(raw)),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Packed native callable card requires a static recipe contract.]`,
    )
    const malformed = JSON.parse(library.contracts['library.ts']!)
    malformed.exports.card.style.staticRecipe.defaults.size = 'unknown'
    expect(() =>
      compile(JSON.stringify(malformed)),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library.ts:0: Invalid library contract: Invalid packed recipe default.]`,
    )
  })

  test.each([`export * from 'zyzz';`, `export * as styling from 'zyzz';`])(
    'rejects unbounded native re-exports: %s',
    (source) => {
      expect(() =>
        Graph.compile({
          modules: { 'barrel.ts': source },
          native: { colorScheme: 'light' },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Native.CompileError: Native modules require named re-exports from zyzz.]`,
      )
    },
  )

  test('rejects web-only authoring and disabled rewriting in native graphs', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'card.ts': `import {style} from 'zyzz';export const card=style({selectors:{'&:hover':{opacity:0.5}}});`,
        },
        native: { colorScheme: 'light' },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.CompileError: ["style-1slxe42dbli7u-45"]: Selectors, queries, and nested rules are not supported on native.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {},
        compiler: false,
        native: { colorScheme: 'light' },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native graph compilation requires source rewriting.]`,
    )
  })

  test.each([
    `export {cx as merge, style as unused} from 'zyzz';`,
    `import {cx} from 'zyzz';export {cx as merge};`,
  ])('executes native barrel composition: %s', async (composition) => {
    const modules = {
      'theme.ts':
        "import {Config} from 'zyzz';export const {style,variants}=Config.create({vars:{color:{ink:{light:'#000000',dark:'#ffffff'}}}});",
      'barrel.ts': `export {style,variants} from './theme.js';${composition}`,
      'card.ts': `import {variants} from './barrel.js';export const card=variants({base:{color:'ink'},variants:{size:{small:{fontSize:'12px'},large:{fontSize:'20px'}}},defaultVariants:{size:'small'}});`,
      'overlay.ts': `import {style} from './barrel.js';export const overlay=style({targets:{native:{opacity:0.5},ios:{opacity:0.7}}});`,
      'index.ts': `import {merge as cx} from './barrel.js';import {card} from './card.js';import {overlay} from './overlay.js';export {card} from './card.js';export const result=cx(card({size:'large'}),overlay());`,
    }
    const compiler = Graph.create()
    const native = { colorScheme: 'dark', platform: 'ios' } as const
    const result = compiler.compile({ modules, native })
    expect(result.dependencies['index.ts']).toMatchInlineSnapshot(`
      [
        "barrel.ts",
        "card.ts",
        "overlay.ts",
      ]
    `)
    expect(
      Object.values(result.modules).every((module) => module.css === ''),
    ).toMatchInlineSnapshot('true')
    expect(
      compiler.compile({ modules, native }) === result,
    ).toMatchInlineSnapshot('true')
    const directory = await Fs.mkdtemp(
      Path.join(root, '.fixture-native-graph-'),
    )
    try {
      await Promise.all(
        Object.entries(result.modules).map(([name, module]) =>
          Fs.writeFile(Path.join(directory, name), module.code),
        ),
      )
      const output = await Esbuild.build({
        entryPoints: [Path.join(directory, 'index.ts')],
        alias: {
          'zyzz/runtime': Path.join(root, 'src/runtime/index.ts'),
          zyzz: Path.join(root, 'src/index.ts'),
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
      })
      const file = Path.join(directory, 'bundle.mjs')
      await Fs.writeFile(
        file,
        output.outputFiles[0]!.text + `\nconsole.log(JSON.stringify(result));`,
      )
      const executed = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [file],
      )
      expect(JSON.parse(executed.stdout)).toMatchInlineSnapshot(`
        {
          "style": [
            {
              "color": "#ffffff",
              "fontSize": 20,
            },
            {
              "opacity": 0.7,
            },
          ],
        }
      `)
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
    const light = compiler.compile({
      modules,
      native: { ...native, colorScheme: 'light' },
    })
    expect(
      light.modules['card.ts']!.code.includes('#000000'),
    ).toMatchInlineSnapshot('true')
    expect(
      light.modules['card.ts']!.code === result.modules['card.ts']!.code,
    ).toMatchInlineSnapshot('false')
    const edited = compiler.compile({
      modules: {
        ...modules,
        'theme.ts': modules['theme.ts'].replace('#000000', '#123456'),
      },
      native: { ...native, colorScheme: 'light' },
    })
    expect(
      edited.modules['card.ts']!.code.includes('#123456'),
    ).toMatchInlineSnapshot('true')
  })

  test.each([
    [
      `export default {opacity:.6};`,
      `export {default as native} from './values.js';`,
    ],
    [`export const native={opacity:.6};`, `export * from './values.js';`],
    [
      `export const native={opacity:.6};`,
      `import {native} from './values.js';export {native};`,
    ],
    [
      `export default {opacity:.6};`,
      `import native from './values.js';export {native};`,
    ],
    [
      `export const native={opacity:.6,lineHeight:undefined};`,
      `export * from './values.js';`,
    ],
  ])(
    'resolves immutable target constants through barrels',
    (values, barrel) => {
      const output = Graph.compile({
        modules: {
          'values.ts': values,
          'barrel.ts': barrel,
          'card.ts': `import {style} from 'zyzz';import {native} from './barrel.js';export const card=style({targets:{native}});`,
        },
      })

      expect(
        JSON.parse(output.contracts['card.ts']!).exports.card.style.style
          .targets.native,
      ).toMatchInlineSnapshot(`
      {
        "opacity": 0.6,
      }
    `)
    },
  )

  test('resolves direct default target imports', () => {
    const output = Graph.compile({
      modules: {
        'values.ts': `const native={opacity:.6};export default native;`,
        'card.ts': `import {style} from 'zyzz';import native from './values.js';export const card=style({targets:{native}});`,
      },
    })

    expect(
      JSON.parse(output.contracts['card.ts']!).exports.card.style.style.targets
        .native,
    ).toMatchInlineSnapshot(`
      {
        "opacity": 0.6,
      }
    `)
  })

  test.each([
    `native.opacity=.8;`,
    `Object.assign(native,{opacity:.8});`,
    `consume(native);`,
  ])('rejects mutations and escapes in target re-exports', (mutation) => {
    expect(() =>
      Graph.compile({
        modules: {
          'values.ts': `export const native={opacity:.6};`,
          'barrel.ts': `import {native} from './values.js';${mutation}export {native};`,
          'card.ts': `import {style} from 'zyzz';import {native} from './barrel.js';export const card=style({targets:{native}});`,
        },
      }),
    ).toThrow()
  })

  test('rejects ambiguous target star exports and terminates cycles', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'a.ts': `export const native={opacity:.6};`,
          'b.ts': `export const native={opacity:.8};`,
          'barrel.ts': `export * from './a.js';export * from './b.js';export * from './cycle.js';`,
          'cycle.ts': `export * from './barrel.js';`,
          'card.ts': `import {style} from 'zyzz';import {native} from './barrel.js';export const card=style({targets:{native}});`,
        },
      }),
    ).toThrow()
  })

  test('renders web target overrides in variant alternatives', async () => {
    const output = Graph.compile({
      modules: {
        'card.ts': `import {variants} from 'zyzz';export const card=variants({base:{opacity:.1,targets:{web:{opacity:.2},native:{opacity:.3}}},variants:{active:{yes:{targets:{web:{opacity:.8},ios:{opacity:.9}}}}}});export const props=card({active:'yes'});`,
      },
    })
    const contract = JSON.parse(output.contracts['card.ts']!)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent('<div id="card">Card</div>')
      await page.addStyleTag({ content: output.modules['card.ts']!.css })
      await page.locator('#card').evaluate((element, classes) => {
        element.setAttribute('class', classes)
        element.setAttribute('data-active', 'yes')
      }, Object.values(output.modules['card.ts']!.classes)[0]!)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toMatchInlineSnapshot(`"0.8"`)
      expect(contract.version).toMatchInlineSnapshot(`31`)
      expect(
        JSON.stringify(contract).includes('"ios":{"opacity":0.9}'),
      ).toMatchInlineSnapshot('true')
      const packed = Graph.compile({
        contracts: { 'lib/index.js': JSON.stringify(contract) },
        modules: {},
      })
      expect(packed).toBeDefined()
    } finally {
      await browser.close()
    }
  }, 30_000)

  test.each([
    `export const native={opacity:.6};native.opacity=.8;`,
    `export const native={opacity:.6};Object.assign(native,{opacity:.8});`,
    `export const native={get opacity(){throw new Error('must not execute')}};`,
    `export const native=(()=>({opacity:.6}))();`,
  ])('rejects nonliteral or mutable imported native declarations', (source) => {
    expect(() =>
      Graph.compile({
        modules: {
          'values.ts': source,
          'card.ts': `import {style} from 'zyzz';import {native} from './values.js';export const card=style({targets:{native}});`,
        },
      }),
    ).toThrow()
  })

  test('preserves target branches through re-exports and packed contracts', () => {
    const output = Graph.compile({
      modules: {
        'lib/values.ts': `const native={opacity:.6};export {native};`,
        'lib/values-index.ts': `export {native as shared} from './values.js';`,
        'lib/card.ts': `import {style} from 'zyzz';import {shared} from './values-index.js';export const card=style({opacity:.2,targets:{web:{opacity:.7},native:shared,ios:{opacity:.8}}});`,
        'lib/index.ts': `export {card} from './card.js';`,
      },
    })
    const contract = JSON.parse(output.contracts['lib/index.ts']!)
    const packed = Graph.compile({
      contracts: { 'lib/index.js': JSON.stringify(contract) },
      imports: { 'app.ts': { lib: 'lib/index.js' } },
      modules: {
        'app.ts': `import {card} from 'lib';export const props=card();export {card};`,
      },
    })
    const restored = JSON.parse(packed.contracts['app.ts']!)

    expect(contract.version).toMatchInlineSnapshot(`31`)
    expect(restored.exports.card.style.style.targets.native)
      .toMatchInlineSnapshot(`
      {
        "opacity": 0.6,
      }
    `)
    expect(restored.exports.card.style.style.targets.ios).toMatchInlineSnapshot(
      `
      {
        "opacity": 0.8,
      }
    `,
    )
    expect(restored.exports.card.style.style.targets.web.declarations)
      .toMatchInlineSnapshot(`
      [
        {
          "property": "opacity",
          "value": 0.7,
        },
      ]
    `)
    expect(
      output.modules['lib/card.ts']!.css.includes('opacity:0.7'),
    ).toMatchInlineSnapshot('true')
    expect(
      output.modules['lib/card.ts']!.css.includes('opacity:0.8'),
    ).toMatchInlineSnapshot('false')
    delete contract.exports.card.style.staticRecipe
    contract.version = 19
    expect(() =>
      Graph.compile({
        contracts: { 'lib/index.js': JSON.stringify(contract) },
        modules: {},
      }),
    ).toThrow('Target branches require contract version 20')
  })

  test('destructured config exports compile grouped styles through re-exports and packed contracts', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config } from 'zyzz'; export const { style, vars:theme } = Config.create({vars:{color:{brand:'#06c'},spacing:{md:'8px'}}});",
        'pkg/index.ts': `export { style, theme } from './config.js';`,
        'pkg/card.ts': `import { style, theme } from './index.js'; export namespace styles {
  export const card = style({padding:'md'})

  export const label = style({color:theme.color.brand})
} export const props = styles.card(); export const scope = theme().className;`,
      },
    })

    expect(output.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-md:8px;--z-color-brand:#06c;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_LMAxOH0{padding:var(--z-spacing-md,8px);}
      .z_LMAxOH1{color:var(--z-color-brand,#06c);}"
    `)
    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(`
      "
      import { Props as __zyzzProps } from 'zyzz/runtime';
      import { style, theme } from './index.js'; export namespace styles {
        export const card = /*#__PURE__*/__zyzzProps.create({className:"z_LMAxOH0 z-style-LMAxOH-styles-card"})

        export const label = /*#__PURE__*/__zyzzProps.create({className:"z_LMAxOH1 z-style-LMAxOH-styles-label"})
      } export const props = styles.card(); export const scope = theme().className;"
    `)

    const packed = Graph.compile({
      contracts: { 'library/index.js': output.contracts['pkg/index.ts']! },
      modules: {
        'app/card.ts': `import { style, theme } from 'library'; export namespace styles {
  export const card = style({color:'brand'})
} export const scope = theme().className;`,
      },
      imports: { 'app/card.ts': { library: 'library/index.js' } },
    })

    expect(packed.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_rnRBDm0{color:var(--z-color-brand,#06c);}"
    `)
  })

  test('renamed destructured config bindings retain token inference during compilation', () => {
    const output = Graph.compile({
      modules: {
        'app/card.ts':
          "import { Config } from 'zyzz'; const { style: styled, vars:palette } = Config.create({vars:{color:{brand:'#06c'}}}); export namespace styles {\n  export const card = styled({color:palette.color.brand})\n}",
      },
    })

    expect(output.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_rnRBDm0{color:var(--z-color-brand,#06c);}"
    `)
  })

  test('preceding handle aliases feed later theme and configuration factories', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config, Vars } from 'zyzz';\nconst zyzz = Config.create({vars:{color:{brand:'#06c'}}});\nconst instance = zyzz;\nconst theme = instance.vars, alias = theme;\nconst mint = Vars.extend(alias,{color:{brand:'#175'}}); const mintConfig=Config.create({id:'mint',vars:mint});\nconst other = Config.create({vars:alias});\nexport const original = zyzz.style({color:'brand'})();\nexport const props = other.style({color:'brand'})();\nexport const scope = mintConfig.vars().className;",
      },
    })

    expect(output.modules['pkg/config.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z-theme-mint-theme{--z-mint-color-brand:#175;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_vqLXml0{color:var(--z-color-brand,#06c);}"
    `)
    expect(
      output.modules['pkg/config.ts']!.code.includes('Config.create('),
    ).toMatchInlineSnapshot(`false`)
  })

  test('numeric configuration keys retain tokens and reject string-equivalent duplicates', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config } from 'zyzz'; const zyzz = Config.create({vars:{color:{brand:{500:'#06c'}},spacing:{2:'8px'}}}); export const props = zyzz.style({color:'brand.500',padding:zyzz.vars.spacing[2]})();",
      },
    })

    expect(output.modules['pkg/config.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand-500:#06c;--z-spacing-2:8px;}
      .z_vqLXml0{color:var(--z-color-brand-500,#06c);}
      .z_vqLXml1{padding:var(--z-spacing-2,8px);}"
    `)
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/config.ts':
            "import { Config } from 'zyzz'; const zyzz = Config.create({vars:{spacing:{2:'8px','2':'12px'}}});",
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/config.ts:44: Configuration requires unique literal keys.]`,
    )
  })

  test('dotted catalog keys retain member boundaries in source and packed libraries', () => {
    const library = Graph.compile({
      modules: {
        'pkg/config.js':
          "import { Config } from 'zyzz'; export const zyzz = Config.create({defaultVars:'brand.dark',vars:{'brand.dark':{color:{brand:'#06c'}}}}); export const props = zyzz.style({color:'brand'})(); export const scope = zyzz.vars({set:'brand.dark'}).className;",
      },
    })

    expect(library.modules['pkg/config.js']!.code).toMatchInlineSnapshot(
      `
      "
      import { Appearance as __zyzzAppearance, Selection as __zyzzSelection } from 'zyzz/runtime';
       export const zyzz = ({appearance:__zyzzAppearance.root([["brand.dark","z-theme-brand_2e_dark"]],{"defaultVars":"brand.dark"}),script:__zyzzAppearance.create([["brand.dark","z-theme-brand_2e_dark"]]),vars:__zyzzSelection.create([["brand.dark","z-theme-brand_2e_dark"]],false,'set',"brand.dark")}); export const props = ({className:"z_TqLXxb0"}); export const scope = zyzz.vars({set:'brand.dark'}).className;"
    `,
    )

    const options = {
      contracts: { 'library/index.js': library.contracts['pkg/config.js']! },
      imports: { 'app/card.js': { '@acme/theme': 'library/index.js' } },
      modules: {
        'app/card.js': `import { zyzz } from '@acme/theme'; export const props = zyzz.style({color:zyzz.vars.color.brand})(); export const scope = zyzz.vars({set:'brand.dark'}).className;`,
      },
    }

    expect(Graph.compile(options).modules['app/card.js']!.css)
      .toMatchInlineSnapshot(`
        ".z-theme-brand_2e_dark{--z-color-brand:#06c;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_jnRBM80{color:var(--z-color-brand,#06c);}"
      `)
    expect(() =>
      Graph.compile({
        ...options,
        modules: {
          'app/card.js': options.modules['app/card.js'].replaceAll(
            'zyzz.vars.color.brand',
            'zyzz.vars.brand.dark.color.brand',
          ),
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app/card.js:75: Unknown theme token path.]`,
    )
  })

  test('configuration defaults, aliases, edits, and packed metadata retain the same contract', () => {
    const compiler = Graph.create()
    const output = compiler.compile({ modules: ConfigFixture.modules })

    expect(output.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint{--z-color-brand:light-dark(#175,#afa);--z-spacing-md:12px;}
      .z-theme-base{--z-color-brand:light-dark(#06c,#9cf);--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_LMAxOH0{color:var(--z-color-brand,light-dark(#06c,#9cf));}
      .z_LMAxOH1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(output.modules['pkg/zyzz.config.ts']!.code).toMatchInlineSnapshot(
      `
      "
      import { Appearance as __zyzzAppearance, Selection as __zyzzSelection } from 'zyzz/runtime';
       import { base } from './base.js'; export const zyzz = ({appearance:__zyzzAppearance.root([["mint","z-theme-mint"],["base","z-theme-base"]],{"defaultVars":"base"}),script:__zyzzAppearance.create([["mint","z-theme-mint"],["base","z-theme-base"]]),vars:__zyzzSelection.create([["mint","z-theme-mint"],["base","z-theme-base"]],false,'set',"base")} as import('zyzz').Config.VariableConfig<{readonly "layers":readonly ["reset","components"];readonly "vars":{readonly "mint":{readonly "color":{readonly "brand":{readonly "light":"#175";readonly "dark":"#afa"}};readonly "spacing":{readonly "md":"12px"}};readonly "base":{readonly "color":{readonly "brand":{readonly "light":"#06c";readonly "dark":"#9cf"}};readonly "spacing":{readonly "md":"8px"}}};readonly "defaultVars":"base"}>);"
    `,
    )
    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"import { design } from './index.js'; const zyzz = (design as import('zyzz').Config.VariableConfig<{readonly "layers":readonly ["reset","components"];readonly "vars":{readonly "mint":{readonly "color":{readonly "brand":{readonly "light":"#175";readonly "dark":"#afa"}};readonly "spacing":{readonly "md":"12px"}};readonly "base":{readonly "color":{readonly "brand":{readonly "light":"#06c";readonly "dark":"#9cf"}};readonly "spacing":{readonly "md":"8px"}}};readonly "defaultVars":"base"}>); const { style } = (zyzz as import('zyzz').Config.VariableConfig<{readonly "layers":readonly ["reset","components"];readonly "vars":{readonly "mint":{readonly "color":{readonly "brand":{readonly "light":"#175";readonly "dark":"#afa"}};readonly "spacing":{readonly "md":"12px"}};readonly "base":{readonly "color":{readonly "brand":{readonly "light":"#06c";readonly "dark":"#9cf"}};readonly "spacing":{readonly "md":"8px"}}};readonly "defaultVars":"base"}>); export const props = ({className:"z_LMAxOH0 z_LMAxOH1"}); export const scope = zyzz.vars({set:'mint'}).className;"`,
    )

    const updated = compiler.compile({
      modules: {
        ...ConfigFixture.modules,
        'pkg/zyzz.config.ts': ConfigFixture.modules[
          'pkg/zyzz.config.ts'
        ].replace("'#175'", "'#f00'"),
      },
    })

    expect(updated.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint{--z-color-brand:light-dark(#f00,#afa);--z-spacing-md:12px;}
      .z-theme-base{--z-color-brand:light-dark(#06c,#9cf);--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_LMAxOH0{color:var(--z-color-brand,light-dark(#06c,#9cf));}
      .z_LMAxOH1{padding:var(--z-spacing-md,8px);}"
    `)

    const mapping = new Trace.TraceMap(output.modules['pkg/card.ts']!.cssMap)

    expect(
      Trace.originalPositionFor(mapping, { line: 1, column: 0 }).source,
    ).toMatchInlineSnapshot(`"pkg/zyzz.config.ts"`)

    const packed = Graph.compile({
      contracts: { 'library/index.js': output.contracts['pkg/index.ts']! },
      imports: { 'app/card.ts': { '@acme/theme': 'library/index.js' } },
      modules: {
        'app/card.ts': `import { design as zyzz } from '@acme/theme'; export const props = zyzz.style({color:'brand',padding:'md'})(); export const scope = zyzz.vars({set:'mint'}).className;`,
      },
    })

    expect(packed.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-brand:light-dark(#06c,#9cf);--z-spacing-md:8px;}
      .z-theme-mint{--z-color-brand:light-dark(#175,#afa);--z-spacing-md:12px;}
      .z-theme-base{--z-color-brand:light-dark(#06c,#9cf);--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_rnRBDm0{color:var(--z-color-brand,light-dark(#06c,#9cf));}
      .z_rnRBDm1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(packed.modules['app/card.ts']!.code).toMatchInlineSnapshot(
      `"import { design as zyzz } from '@acme/theme'; export const props = ({className:"z_rnRBDm0 z_rnRBDm1"}); export const scope = zyzz.vars({set:'mint'}).className;"`,
    )
  })

  test('single and token-free configuration calls compile without runtime factories', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config, Vars } from 'zyzz'; export const empty = Config.create(); const base = Vars.define({color:{brand:'#06c'}}); export const zyzz = Config.create({vars:base}); const theme = zyzz.vars; export const mint = Vars.extend(zyzz.vars,{color:{brand:'#175'}}); export const props = zyzz.style({color:theme.color.brand})(); export const plain = empty.style({padding:'8px'})();",
      },
    })

    expect(output.modules['pkg/config.ts']!.code).toMatchInlineSnapshot(
      `
      "
      import { Appearance as __zyzzAppearance, Selection as __zyzzSelection } from 'zyzz/runtime';
       export const empty = ({appearance:__zyzzAppearance.root([]),script:__zyzzAppearance.create([])} as import('zyzz').Config.create.ReturnType<{}>); const base = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":"#06c"}}>); export const zyzz = ({appearance:__zyzzAppearance.root([]),script:__zyzzAppearance.create([]),vars:__zyzzSelection.create([["default","z-theme-theme"]],false,'set',"default")} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"}}}>); const theme = (zyzz.vars as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"}}}>['vars']); export const mint = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":"#06c"}}>); export const props = ({className:"z_vqLXml0"}); export const plain = ({className:"z_vqLXml1"});"
    `,
    )
    expect(output.modules['pkg/config.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_vqLXml0{color:var(--z-color-brand,#06c);}
      .z_vqLXml1{padding:8px;}"
    `)
  })

  test('destructured appearance controls compile with the configured storage key', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config } from 'zyzz'; export const { appearance, style } = Config.create({ defaultVars: 'base', storageKey: 'app', vars: { base: { color: { ink: '#123456' } }, mint: { color: { ink: '#008844' } } } }); export const initial = appearance.get(); export const controls = appearance;",
        'pkg/single.ts':
          "import { Config } from 'zyzz'; export const zyzz = Config.create({ vars: { color: { ink: '#123456' } } }); export const select = () => zyzz.appearance.set({ colorScheme: 'dark' });",
      },
    })
    const code = output.modules['pkg/config.ts']!.code

    expect(
      code.includes('appearance:__zyzzAppearance.root('),
    ).toMatchInlineSnapshot('true')
    expect(
      code.includes('{"defaultVars":"base","storageKey":"app"}'),
    ).toMatchInlineSnapshot('true')
    expect(code.includes('script:')).toMatchInlineSnapshot('false')
    expect(
      output.modules['pkg/single.ts']!.code.includes(
        'appearance:__zyzzAppearance.root([])',
      ),
    ).toMatchInlineSnapshot('true')
  })

  test('destructured selectors pass to runtime helpers as values', () => {
    const output = Graph.compile({
      modules: {
        'pkg/config.ts':
          "import { Config } from 'zyzz'; export const { vars:themes } = Config.create({ defaultVars: 'base', vars: { base: { color: { ink: '#123456' } }, mint: { color: { ink: '#008844' } } } }); export const names = Object.keys(themes); export const catalog = [themes];",
      },
    })
    const code = output.modules['pkg/config.ts']!.code

    expect(code.includes('__zyzzSelection.create(')).toMatchInlineSnapshot(
      'true',
    )
    expect(code.includes('Object.keys(themes)')).toMatchInlineSnapshot('true')
    expect(code.includes('[themes]')).toMatchInlineSnapshot('true')
  })

  test('configuration dynamic access and escaping fail before emission', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/config.ts': `import { Config } from 'zyzz'; const zyzz = Config.create(); console.log(zyzz);`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/config.ts:73: Use direct configuration style calls or static theme members; configurations cannot escape or be mutated.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/config.ts':
            "import { Config } from 'zyzz'; const zyzz = Config.create({vars:{color:{brand:'#06c'}}}); const key = 'theme'; export const scope = zyzz[key].className;",
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/config.ts:132: Use direct configuration style calls or static theme members; configurations cannot escape or be mutated.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/config.ts':
            "import { Config } from 'zyzz'; const zyzz = Config.create({vars:{base:{color:{brand:'#06c'}}},defaultVars:'missing'});",
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/config.ts:44: defaultTheme must name a theme in the catalog.]`,
    )
  })

  test('serialized library contracts link aliases, extensions, and consumer scopes', () => {
    const library = Graph.compile({
      modules: {
        'library/theme.ts':
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#06c'},spacing:{md:'8px'}}); const themeConfig=Config.create({vars:theme}); export const mint = Vars.extend(theme,{color:{brand:'#175'}}); const mintConfig=Config.create({id:'mint',vars:mint}); export const style = themeConfig.style;",
        'library/index.ts': `export * from './theme.js';`,
      },
    })

    const compiler = Graph.create()

    const options = {
      contracts: { 'library/index.js': library.contracts['library/index.ts']! },
      imports: {
        'app/card.ts': { '@acme/theme': 'library/index.js', zyzz: null },
      },
      modules: {
        'app/card.ts':
          "import {Config} from 'zyzz';import { mint, style, theme } from '@acme/theme'; import { Vars } from 'zyzz'; export const local = Vars.extend(theme,{color:{brand:'#f00'}}); export const props = style({color:theme.color.brand,padding:'md'})(); const scopeConfig=Config.create({id:'mint',vars:mint});export const scope=scopeConfig.vars().className;",
      },
    }

    const output = compiler.compile(options)

    expect(output.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;}
      .z-theme-mint-theme{--z-mint-color-brand:#175;--z-mint-spacing-md:8px;}
      .z-theme-local{--z-color-brand:#f00;--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_rnRBDm0{color:var(--z-color-brand,#06c);}
      .z_rnRBDm1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(output.modules['app/card.ts']!.code).toMatchInlineSnapshot(
      `
      "
      import { Selection as __zyzzSelection } from 'zyzz/runtime';
      import { mint, style, theme } from '@acme/theme';  export const local = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}>); export const props = ({className:"z_rnRBDm0 z_rnRBDm1"}); const scopeConfig=({vars:__zyzzSelection.create([["default","z-theme-mint-theme"]],false,'set',"default")} as import('zyzz').Config.VariableConfig<{readonly "id":"mint";readonly "vars":{readonly "color":{readonly "brand":"#175"};readonly "spacing":{readonly "md":"8px"}}}>);export const scope=scopeConfig.vars().className;"
    `,
    )

    const updated = compiler.compile({
      ...options,
      contracts: {
        'library/index.js': options.contracts['library/index.js'].replaceAll(
          '#175',
          '#080',
        ),
      },
    })

    expect(updated.modules['app/card.ts']!.classes).toMatchInlineSnapshot(`
      {
        "style-ujlnau19561g8-192": "z_rnRBDm0 z_rnRBDm1",
      }
    `)
    expect(updated.modules['app/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z-theme-mint{--z-color-brand:#080;--z-spacing-md:8px;}
      .z-theme-mint-theme{--z-mint-color-brand:#080;--z-mint-spacing-md:8px;}
      .z-theme-local{--z-color-brand:#f00;--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_rnRBDm0{color:var(--z-color-brand,#06c);}
      .z_rnRBDm1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(() =>
      compiler.compile({
        ...options,
        contracts: { 'library/index.js': '{"version":999}' },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: library/index.js:0: Invalid library contract: Unsupported Zyzz contract version.]`,
    )
    expect(
      compiler.compile(options).modules['app/card.ts']!.css ===
        output.modules['app/card.ts']!.css,
    ).toMatchInlineSnapshot(`true`)
  })

  test('unchanged and edited consumers retain one imported contract identity', () => {
    const library = Graph.compile({ modules: Fixture.modules })
    const compiler = Graph.create()

    const options = {
      contracts: { 'library/index.js': library.contracts['pkg/index.ts']! },
      imports: {
        'app/a.ts': { '@acme/theme': 'library/index.js' },
        'app/b.ts': { '@acme/theme': 'library/index.js' },
      },
      modules: {
        'app/a.ts': `import { styles } from '@acme/theme'; export const a = style({color:'brand'})();`,
        'app/b.ts': `import { styles } from '@acme/theme'; export const b = style({padding:'md'})();`,
      },
    }

    compiler.compile(options)

    const next = {
      ...options,
      modules: {
        ...options.modules,
        'app/b.ts': options.modules['app/b.ts'].replace(
          "padding:'md'",
          "color:'brand',padding:'md'",
        ),
      },
    }

    const output = compiler.compile(next)

    expect(output.modules['app/a.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-base{--z-color-brand:#06c;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;--z-spacing-unused:99px;}"
    `)
    expect(output.modules['app/b.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-base{--z-color-brand:#06c;--z-spacing-md:8px;--z-spacing-unused:99px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;--z-spacing-unused:99px;}"
    `)
    expect(
      JSON.stringify(output) === JSON.stringify(Graph.compile(next)),
    ).toMatchInlineSnapshot(`true`)
  })

  test('conflicting installed copies fail before compiling consumers', () => {
    const library = Graph.compile({ modules: Fixture.modules })
    const contract = library.contracts['pkg/index.ts']!

    expect(() =>
      Graph.compile({
        contracts: {
          first: contract,
          second: contract.replaceAll('#06c', '#f00'),
        },
        imports: { 'app/card.ts': { first: 'first', second: 'second' } },
        modules: {
          'app/card.ts':
            "import {Config} from 'zyzz';import { styles } from 'first'; import { mint } from 'second'; export const props = style({color:'brand'})(); const scopeConfig=Config.create({vars:mint});export const scope=scopeConfig.vars().className;",
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: second:0: Invalid library contract: Conflicting library theme identity: src-theme-dOJPxq0YtPK-theme]`,
    )
  })

  test('ordinary exports named like object prototype properties remain ordinary imports', () => {
    const output = Graph.compile({
      modules: {
        'pkg/utility.ts': `export function toString() { return 'ordinary' }`,
        'pkg/card.ts': `import { toString } from './utility.js'; export const value = toString();`,
      },
    })

    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"import { toString } from './utility.js'; export const value = toString();"`,
    )
    expect(output.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`""`)
  })

  test('dynamic source imports fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          ...modules,
          'pkg/lazy.ts': `export const load = () => import('./theme.js');`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/lazy.ts:26: Source graph dependencies require static imports.]`,
    )
  })

  test('explicit non-theme exports shadow star contracts', () => {
    const output = Graph.compile({
      modules: {
        ...modules,
        'pkg/index.ts': `export * from './theme.js'; export const theme = { css: (value: string) => value };`,
        'pkg/card.ts':
          "import { theme } from './index.js'; export const value = theme.style('ordinary');",
      },
    })

    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"import { theme } from './index.js'; export const value = theme.style('ordinary');"`,
    )
    expect(output.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`""`)
  })
  test('conflicting star contracts fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/a.ts':
            "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#000'}});",
          'pkg/b.ts':
            "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#fff'}});",
          'pkg/index.ts': `export * from './a.js'; export * from './b.js';`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/index.ts:0: Ambiguous theme re-export: theme]`,
    )
  })
  test('type-only imports do not load source dependencies', () => {
    const output = Graph.compile({
      modules: {
        'pkg/types.ts': `import type { Theme } from './missing.js'; export type Contract = Theme;`,
      },
    })

    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "pkg/types.ts": [],
      }
    `)
  })
  test('imported aliases retain shadowed bindings', () => {
    const output = Graph.compile({
      modules: {
        ...modules,
        'pkg/card.ts': `import { style } from './theme.js'; export function run(style: (value: string) => string) { return style('ordinary') } export const props = style({color:'brand'})();`,
      },
    })

    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"import { style } from './theme.js'; export function run(style: (value: string) => string) { return style('ordinary') } export const props = style({color:'brand'})();"`,
    )
  })

  test('imports, aliases, extensions and re-exports share token identities and source maps', async () => {
    const output = Graph.compile({ modules })

    expect(output.dependencies).toMatchInlineSnapshot(`
      {
        "pkg/alternate.ts": [
          "pkg/theme.ts",
        ],
        "pkg/card.ts": [
          "pkg/index.ts",
        ],
        "pkg/index.ts": [
          "pkg/theme.ts",
          "pkg/alternate.ts",
        ],
        "pkg/theme.ts": [],
      }
    `)
    expect(output.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"import { vars, style } from './index.js'; export const props = ({className:"z_LMAxOH0 z_LMAxOH1"}); export const scope = vars({set:'mint'}).className;"`,
    )
    expect(output.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}
      .z_LMAxOH1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(
      Trace.originalPositionFor(
        new Trace.TraceMap(output.modules['pkg/card.ts']!.cssMap),
        { line: 1, column: 0 },
      ),
    ).toMatchInlineSnapshot(`
      {
        "column": 159,
        "line": 1,
        "name": "src-index-3SribQXHRu1-style-base",
        "source": "pkg/index.ts",
      }
    `)

    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-graph-'))

    try {
      for (const [name, module] of Object.entries(output.modules)) {
        const file = Path.join(directory, name)

        await Fs.mkdir(Path.dirname(file), { recursive: true })
        await Fs.writeFile(file, module.code)
      }

      const bundle = await Esbuild.build({
        entryPoints: [Path.join(directory, 'pkg/card.ts')],
        bundle: true,
        format: 'cjs',
        metafile: true,
        write: false,
      })

      expect(
        Object.keys(bundle.metafile!.inputs).some((path) =>
          /Theme\.ts|compiler\//.test(path),
        ),
      ).toMatchInlineSnapshot(`false`)

      const path = Path.join(directory, 'bundle.cjs')

      await Fs.writeFile(path, bundle.outputFiles[0]!.text)

      const executed = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path)})))`],
      )

      expect(executed.stdout).toMatchInlineSnapshot(`
        "{"props":{"className":"z_LMAxOH0 z_LMAxOH1"},"scope":"z-theme-mint"}
        "
      `)

      const checked = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          Path.join(root, 'node_modules/typescript/bin/tsc'),
          '--ignoreConfig',
          '--customConditions',
          'src',
          '--module',
          'NodeNext',
          '--target',
          'esnext',
          '--strict',
          '--skipLibCheck',
          '--noEmit',
          Path.join(directory, 'pkg/card.ts'),
        ],
        { timeout: 30_000 },
      )

      expect(checked.stdout).toMatchInlineSnapshot(`""`)
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  }, 35_000)

  test('token edits preserve identities and removing the last use removes declarations', () => {
    const before = Graph.compile({ modules })

    const after = Graph.compile({
      modules: {
        ...modules,
        'pkg/theme.ts': modules['pkg/theme.ts'].replace("'#06c'", "'#f00'"),
      },
    })

    expect(after.modules['pkg/card.ts']!.classes).toMatchInlineSnapshot(`
      {
        "style-5ngs574r5xr9-63": "z_LMAxOH0 z_LMAxOH1",
      }
    `)
    expect(after.modules['pkg/card.ts']!.vars).toMatchInlineSnapshot(`
      {
        "src-alternate-0hQC3ZHQfTf-mint": "z-theme-mint",
        "src-index-3SribQXHRu1-style-base": "z-theme-base",
        "src-index-3SribQXHRu1-style-mint": "z-theme-mint",
        "src-theme-dOJPxq0YtPK-theme": "z-theme-theme",
      }
    `)
    expect(before.modules['pkg/card.ts']!.classes).toMatchInlineSnapshot(`
      {
        "style-5ngs574r5xr9-63": "z_LMAxOH0 z_LMAxOH1",
      }
    `)

    const removed = Graph.compile({
      modules: {
        ...modules,
        'pkg/card.ts':
          "import {Config} from 'zyzz';import { mint } from './alternate.js'; const scopeConfig=Config.create({id:'mint',vars:mint});export const scope=scopeConfig.vars().className;",
      },
    })

    expect(removed.modules['pkg/alternate.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint-theme{--z-mint-color-brand:#175;--z-mint-spacing-md:8px;--z-mint-spacing-unused:99px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
    expect(removed.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint-theme{--z-mint-color-brand:#175;--z-mint-spacing-md:8px;--z-mint-spacing-unused:99px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
    expect(removed.modules['pkg/index.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint-theme{--z-mint-color-brand:#175;--z-mint-spacing-md:8px;--z-mint-spacing-unused:99px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
    expect(removed.modules['pkg/theme.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint-theme{--z-mint-color-brand:#175;--z-mint-spacing-md:8px;--z-mint-spacing-unused:99px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
  })

  test('linked scopes render inherited values in Chromium', async () => {
    const output = Graph.compile({ modules })
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent('<main id="scope"><div id="card">Card</div></main>')
      await page.addStyleTag({
        content: Object.values(output.modules)
          .map((module) => module.css)
          .join('\n'),
      })

      const classes = Object.values(output.modules['pkg/card.ts']!.classes)[0]!

      await page
        .locator('#card')
        .evaluate(
          (element, classes) => element.setAttribute('class', classes),
          classes,
        )

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)

      const scope =
        output.modules['pkg/card.ts']!.vars[
          Object.keys(output.modules['pkg/card.ts']!.vars).find((name) =>
            name.endsWith('-style-mint'),
          )!
        ]!

      await page
        .locator('#scope')
        .evaluate(
          (element, scope) => element.setAttribute('class', scope),
          scope,
        )

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(17, 119, 85)"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"8px"`)
    } finally {
      await browser.close()
    }
  })

  test('extensionless imports link themes from every supported source extension', () => {
    const stylesheets: Record<string, string> = {}
    for (const extension of [
      'cjs',
      'cjsx',
      'cts',
      'ctsx',
      'js',
      'jsx',
      'mjs',
      'mjsx',
      'mts',
      'mtsx',
      'ts',
      'tsx',
    ]) {
      for (const suffix of ['', '/index']) {
        const id = `pkg/theme${suffix}.${extension}`
        const output = Graph.compile({
          modules: {
            'pkg/card.ts':
              "const themeConfig=Config.create({vars:theme});import {Config} from 'zyzz';\nimport { theme } from './theme'; export const props = themeConfig.style({color:'brand'})();",
            [id]: modules['pkg/theme.ts'],
          },
        })
        expect(
          output.modules['pkg/card.ts']!.code.includes(
            JSON.stringify(
              Object.values(output.modules['pkg/card.ts']!.classes)[0],
            ),
          ),
        ).toMatchInlineSnapshot('true')
        stylesheets[id] = output.modules['pkg/card.ts']!.css
      }
    }
    expect(stylesheets).toMatchInlineSnapshot(`
      {
        "pkg/theme.cjs": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.cjsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.cts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.ctsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.js": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.jsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.mjs": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.mjsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.mts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.mtsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.ts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme.tsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.cjs": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.cjsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.cts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.ctsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.js": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.jsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.mjs": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.mjsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.mts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.mtsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.ts": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
        "pkg/theme/index.tsx": ".z-theme-theme{--z-color-brand:#06c;}
      .z_LMAxOH0{color:var(--z-color-brand,#06c);}",
      }
    `)
  })

  test.each(['pkg/theme.mts', 'pkg/theme/index.mjs'])(
    'extensionless imports reject ambiguity with %s',
    (moduleId) => {
      expect(() =>
        Graph.compile({
          modules: {
            'pkg/card.ts': `import { theme } from './theme';`,
            'pkg/theme.cts': modules['pkg/theme.ts'],
            [moduleId]: modules['pkg/theme.ts'],
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: pkg/card.ts:0: Ambiguous source import: ./theme]`,
      )
    },
  )

  test('missing source imports fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: { 'pkg/card.ts': `import { theme } from './missing.js';` },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/card.ts:0: Missing source module: ./missing.js]`,
    )
  })
  test('component import cycles compile independent styles', async () => {
    const result = Graph.compile({
      modules: {
        'app.tsx': `import {style} from 'zyzz'; import {Route} from './routes/__root.js'; export function App() { Route.useRouteContext(); return <main {...styles.app()} />; } namespace styles { export const app = style({color:'red'}); }`,
        'routes/__root.tsx': `import {style} from 'zyzz'; import {App} from '../app.js'; export const Route = {component:App, useRouteContext() { return {}; }}; export function Root() { return <div {...styles.root()}><App /></div>; } namespace styles { export const root = style({padding:'8px'}); }`,
      },
    })

    expect(result.dependencies).toMatchInlineSnapshot(`
      {
        "app.tsx": [
          "routes/__root.tsx",
        ],
        "routes/__root.tsx": [
          "app.tsx",
        ],
      }
    `)
    expect(result.modules['app.tsx']!.css).toMatchInlineSnapshot(
      `".z_kNYrjR0{color:red;}"`,
    )
    expect(result.modules['routes/__root.tsx']!.css).toMatchInlineSnapshot(
      `".z_Kup_0T0{padding:8px;}"`,
    )

    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-graph-cycle-'))

    try {
      for (const [id, output] of Object.entries(result.modules)) {
        const file = Path.join(directory, id)

        await Fs.mkdir(Path.dirname(file), { recursive: true })
        await Fs.writeFile(file, output.code)
      }

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
        bundle: true,
        entryPoints: [Path.join(directory, 'routes/__root.tsx')],
        format: 'iife',
        globalName: 'Fixture',
        jsx: 'automatic',
        write: false,
      })
      const context = Vm.createContext({})

      Vm.runInContext(bundle.outputFiles[0]!.text, context)

      expect(
        Vm.runInContext('Fixture.Route.component().props.className', context),
      ).toMatchInlineSnapshot(`"z_kNYrjR0"`)
      expect(
        Vm.runInContext('Fixture.Root().props.className', context),
      ).toMatchInlineSnapshot(`"z_Kup_0T0"`)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }
  })

  test.each([
    'export default function App() { return props(); }',
    'export default () => props();',
    'export const App = () => props();',
  ])('runtime export cycles compile: %s', (declaration) => {
    const output = Graph.compile({
      modules: {
        'a.ts': `import './b.js'; import {style} from 'zyzz'; const props = style({color:'red'}); export const Route = {}; export function Root() { return props(); }`,
        'b.ts': `import './a.js'; import {style} from 'zyzz'; const props = style({padding:'8px'}); ${declaration}`,
      },
    })

    expect(output.modules['a.ts']!.css).toMatchInlineSnapshot(
      `".z_ZYrHvJ0{color:red;}"`,
    )
    expect(output.modules['b.ts']!.css).toMatchInlineSnapshot(
      `".z_hYrPIe0{padding:8px;}"`,
    )
  })

  test('cyclic style values fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/a.ts': `import {style} from 'zyzz'; import {b} from './b.js'; export const a = style({...b, color:'red'});`,
          'pkg/b.ts': `import {style} from 'zyzz'; import {a} from './a.js'; export const b = style({...a, padding:'8px'});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/a.ts:0: Circular source dependencies are not supported yet.]`,
    )
  })

  test('cyclic re-exports fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/a.ts': `export * from './b.js';`,
          'pkg/b.ts': `export * from './a.js';`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/a.ts:0: Circular source dependencies are not supported yet.]`,
    )
  })
  test('ambiguous source extensions fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'pkg/a.ts': `import './b';`,
          'pkg/b.ts': '',
          'pkg/b.tsx': '',
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/a.ts:0: Ambiguous source import: ./b]`,
    )
  })
  test('namespace theme imports fail before output', () => {
    expect(() =>
      Graph.compile({
        modules: {
          ...modules,
          'pkg/card.ts': `import * as Themes from './theme.js';`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/card.ts:7: Import theme contracts by name; namespace imports are not supported.]`,
    )
  })
})

describe('create', () => {
  test('runtime cycles survive edits and changes to style exports', () => {
    const compiler = Graph.create()
    const sources = {
      'app.ts': `import {style} from 'zyzz'; import {Route} from './root.js'; const props = style({color:'red'}); export function App() { Route.context(); return props(); }`,
      'root.ts': `import {App} from './app.js'; export {App}; export const Route = {component:App, context() { return {}; }}; export function render() { return App(); }`,
    }
    const before = compiler.compile({ modules: sources })

    expect(
      compiler.compile({ modules: sources }) === before,
    ).toMatchInlineSnapshot(`true`)

    const edited = {
      ...sources,
      'app.ts': sources['app.ts'].replace("'red'", "'blue'"),
    }
    const after = compiler.compile({ modules: edited })

    expect(after.modules['app.ts']!.css).toMatchInlineSnapshot(
      `".z_Zf5JrJ0{color:blue;}"`,
    )
    expect(
      after.modules['root.ts']!.code === before.modules['root.ts']!.code,
    ).toMatchInlineSnapshot(`true`)

    // A formerly runtime-only export now supplies a style to the same importer.
    const styled = {
      ...sources,
      'app.ts': `import {style} from 'zyzz'; export const App = style({color:'green'});`,
    }
    const linked = compiler.compile({ modules: styled })

    expect(linked.modules['app.ts']!.css).toMatchInlineSnapshot(
      `".z_Zf5JrJ0{color:green;}"`,
    )
    expect(linked.modules['root.ts']!.css).toMatchInlineSnapshot(`""`)
    expect(Object.keys(JSON.parse(linked.contracts['root.ts']!).exports))
      .toMatchInlineSnapshot(`
      [
        "App",
      ]
    `)

    // Reintroducing the component cycle must discard the previous style-link edge.
    const restored = compiler.compile({ modules: sources })

    expect(restored.modules['app.ts']!.css).toMatchInlineSnapshot(
      `".z_Zf5JrJ0{color:red;}"`,
    )
    expect(
      restored.modules['root.ts']!.code === before.modules['root.ts']!.code,
    ).toMatchInlineSnapshot(`true`)
    expect(restored.modules['root.ts']!.css).toMatchInlineSnapshot(`""`)
    expect(restored.contracts['root.ts']).toMatchInlineSnapshot(`undefined`)
  })

  test.each([false, true])(
    'snapshots mutable nested native options with fresh outer options: %s',
    (fresh) => {
      const compiler = Graph.create()
      const fonts = { Inter: 'Inter-Regular' }
      const themes: Record<string, Vars.Definition> = {
        base: Vars.define({ color: { ink: '#123456' } }),
      }
      const units = { rem: 16 }
      const modules = {
        'app.ts':
          "import {Config} from 'zyzz';const {style}=Config.create({vars:{color:{ink:'#000000'}}});export const card=style({color:'ink',fontFamily:'Inter',paddingTop:'1rem'});",
      }
      const native = {
        colorScheme: 'light',
        fonts,
        set: 'base',
        vars: themes,
        units,
      } as const
      const initial = compiler.compile({
        modules,
        native: fresh ? { ...native } : native,
      })

      fonts.Inter = 'Inter-Bold'
      const font = compiler.compile({
        modules,
        native: fresh ? { ...native } : native,
      })
      expect(
        font.modules['app.ts']!.code.includes('Inter-Bold'),
      ).toMatchInlineSnapshot('true')
      expect(font === initial).toMatchInlineSnapshot('false')

      units.rem = 20
      const unit = compiler.compile({
        modules,
        native: fresh ? { ...native } : native,
      })
      expect(
        unit.modules['app.ts']!.code.includes('"paddingTop":20'),
      ).toMatchInlineSnapshot('true')
      expect(unit === font).toMatchInlineSnapshot('false')

      themes.base = Vars.define({ color: { ink: '#654321' } })
      const theme = compiler.compile({
        modules,
        native: fresh ? { ...native } : native,
      })
      expect(theme === unit).toMatchInlineSnapshot('false')
      expect(
        compiler.compile({
          modules,
          native: fresh ? { ...native } : native,
        }) === theme,
      ).toMatchInlineSnapshot(`true`)

      delete themes.base
      expect(() =>
        compiler.compile({ modules, native: fresh ? { ...native } : native }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[StyleSheet.CompileError: ["vars"]: Supply at least one set, or omit vars for a default table.]`,
      )
    },
  )
  test('invalidates reused native context values and nested mappings', () => {
    const compiler = Graph.create()
    const fonts = { Example: 'FirstFont' }
    const themes: Record<string, Vars.Definition> = {
      selected: Vars.define({ color: { ink: '#111111' } }),
    }
    const units = { rem: 10 }
    const native = {
      colorScheme: 'light' as 'light' | 'dark',
      fonts,
      platform: 'ios' as 'ios' | 'android',
      set: 'selected',
      vars: themes,
      units,
    }
    const modules = {
      'card.ts': `import {style} from 'zyzz';export const card=style({fontFamily:'Example',fontSize:'2rem',targets:{ios:{opacity:.7},android:{opacity:.4}}});`,
    }
    const first = compiler.compile({ modules, native })
    expect(
      compiler.compile({ modules, native }) === first,
    ).toMatchInlineSnapshot(`true`)

    fonts.Example = 'SecondFont'
    const nested = compiler.compile({ modules, native })
    expect(nested === first).toMatchInlineSnapshot('false')
    expect(
      nested.modules['card.ts']!.code.includes('SecondFont'),
    ).toMatchInlineSnapshot('true')
    units.rem = 12
    const scaled = compiler.compile({ modules, native })
    expect(
      scaled.modules['card.ts']!.code.includes('"fontSize":24'),
    ).toMatchInlineSnapshot('true')

    themes.selected = Vars.define({ color: { ink: '#222222' } })
    const themed = compiler.compile({ modules, native })
    expect(themed === scaled).toMatchInlineSnapshot('false')

    native.colorScheme = 'dark'
    native.platform = 'android'
    const changed = compiler.compile({ modules, native })
    expect(changed === themed).toMatchInlineSnapshot('false')
    expect(
      changed.modules['card.ts']!.code.includes('"opacity":0.4'),
    ).toMatchInlineSnapshot('true')
    expect(
      compiler.compile({ modules, native }) === changed,
    ).toMatchInlineSnapshot(`true`)

    delete (fonts as Partial<typeof fonts>).Example
    expect(() => compiler.compile({ modules, native }))
      .toThrowErrorMatchingInlineSnapshot(`
      [StyleSheet.CompileError: ["selected","light","0","fontFamily"]: Provide an explicit fonts mapping for this family.
      ["selected","dark","0","fontFamily"]: Provide an explicit fonts mapping for this family.]
    `)
  })

  test('unchanged snapshots reuse results within an isolated compiler', () => {
    const compiler = Graph.create()
    const before = compiler.compile({ modules })

    expect(
      compiler.compile({ modules: { ...modules } }) === before,
    ).toMatchInlineSnapshot(`true`)
    expect(
      Graph.create().compile({ modules }) === before,
    ).toMatchInlineSnapshot(`false`)
  })

  test('a consumer edit retains unrelated transforms and snapshots caller inputs', () => {
    const compiler = Graph.create()
    const sources = Fixture.project(3)
    const before = compiler.compile({ modules: sources })

    sources['pkg/card0.ts'] = sources['pkg/card0.ts']!.replace('0px', '20px')

    const after = compiler.compile({ modules: sources })

    expect(
      after.modules['pkg/card1.ts'] === before.modules['pkg/card1.ts'],
    ).toMatchInlineSnapshot(`true`)
    expect(
      after.modules['pkg/card0.ts'] === before.modules['pkg/card0.ts'],
    ).toMatchInlineSnapshot(`false`)
    expect(after.modules['pkg/card0.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-brand:#06c;}
      .z-theme-mint{--z-color-brand:#175;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_I2R_br0{color:var(--z-color-brand,#06c);}
      .z_I2R_br1{padding:20px;}"
    `)
    expect(before.modules['pkg/card0.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-brand:#06c;}
      .z-theme-mint{--z-color-brand:#175;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_I2R_br0{color:var(--z-color-brand,#06c);}
      .z_I2R_br1{padding:0px;}"
    `)
  })

  test('theme edits propagate through re-exports and preserve defining source maps', () => {
    const compiler = Graph.create()

    compiler.compile({ modules })

    const after = compiler.compile({
      modules: {
        ...modules,
        'pkg/theme.ts':
          '\n' + modules['pkg/theme.ts'].replace("'#06c'", "'#f00'"),
      },
    })

    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-base{--z-color-brand:#f00;--z-spacing-md:8px;}
      .z-theme-mint{--z-color-brand:#175;--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_LMAxOH0{color:var(--z-color-brand,#f00);}
      .z_LMAxOH1{padding:var(--z-spacing-md,8px);}"
    `)

    const map = new Trace.TraceMap(after.modules['pkg/card.ts']!.cssMap)

    expect(Trace.originalPositionFor(map, { column: 0, line: 1 }))
      .toMatchInlineSnapshot(`
        {
          "column": 159,
          "line": 1,
          "name": "src-index-3SribQXHRu1-style-base",
          "source": "pkg/index.ts",
        }
      `)
    expect(after.modules['pkg/card.ts']!.cssMap.sourcesContent)
      .toMatchInlineSnapshot(`
        [
          "import { vars, style } from './index.js'; export const props = style({color:vars.color.brand,padding:'md'})(); export const scope = vars({set:'mint'}).className;",
          "import { Config } from 'zyzz'; import { theme } from './theme.js'; import { mint } from './alternate.js'; export { theme, mint }; export const { style, vars }=Config.create({vars:{base:theme,mint},defaultVars:'base'});",
        ]
      `)
  })

  test('unimported compatible scope edits keep unchanged consumer output', () => {
    const compiler = Graph.create()
    const sources = {
      ...modules,
      'pkg/card.ts': `import { style } from './theme.js'; export const props = style({color:'brand'})();`,
    }
    const before = compiler.compile({ modules: sources })

    const after = compiler.compile({
      modules: {
        ...sources,
        'pkg/alternate.ts': modules['pkg/alternate.ts'].replace(
          "'#175'",
          "'#f00'",
        ),
      },
    })

    expect(
      after.modules['pkg/card.ts'] === before.modules['pkg/card.ts'],
    ).toMatchInlineSnapshot(`true`)
    expect(after.dependencies['pkg/card.ts']).toMatchInlineSnapshot(`
      [
        "pkg/theme.ts",
      ]
    `)
    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
  })

  test('import edits preserve the new graph scope order', () => {
    const compiler = Graph.create()

    const sources = {
      'pkg/a.ts': `export const value = 1;`,
      'pkg/b.ts':
        "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#000'}},{id:'dark'});",
      'pkg/c.ts':
        "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#fff'}},{id:'light'});",
      'pkg/styles.ts':
        "const themeConfig=Config.create({vars:theme});import {Config} from 'zyzz';\nimport { theme } from './b.js'; export const props = themeConfig.style({color:'brand'})();",
    }

    const before = compiler.compile({ modules: sources })

    const after = compiler.compile({
      modules: {
        ...sources,
        'pkg/a.ts': `import './c.js'; export const value = 1;`,
      },
    })

    expect(
      after.modules['pkg/styles.ts'] === before.modules['pkg/styles.ts'],
    ).toMatchInlineSnapshot(`false`)
    expect(Object.keys(after.modules['pkg/styles.ts']!.vars))
      .toMatchInlineSnapshot(`
        [
          "id-light",
          "id-dark",
          "src-styles-3e054v0_jNX-themeConfig-theme",
        ]
      `)
  })

  test('edited imports replace dependency edges before later theme edits', () => {
    const compiler = Graph.create()

    compiler.compile({ modules })

    const sources = {
      ...modules,
      'pkg/card.ts': `import {Config} from 'zyzz'; import { mint } from './alternate.js'; const config=Config.create({id:'mint',vars:mint}); export const props = config.style({color:'brand'})();`,
    }

    compiler.compile({ modules: sources })

    const after = compiler.compile({
      modules: {
        ...sources,
        'pkg/alternate.ts': modules['pkg/alternate.ts'].replace(
          "'#175'",
          "'#f00'",
        ),
      },
    })

    expect(after.dependencies['pkg/card.ts']).toMatchInlineSnapshot(`
      [
        "pkg/alternate.ts",
      ]
    `)
    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-mint-theme{--z-mint-color-brand:#f00;--z-mint-spacing-md:8px;--z-mint-spacing-unused:99px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_mint-LMAxOH0{color:var(--z-mint-color-brand,#f00);}"
    `)
  })

  test('failed edits retain the last successful graph and recover', () => {
    const compiler = Graph.create()
    const before = compiler.compile({ modules })

    expect(() =>
      compiler.compile({
        modules: {
          ...modules,
          'pkg/theme.ts': `import { theme } from './index.js'; export { theme };`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/theme.ts:0: Circular source dependencies are not supported yet.]`,
    )
    expect(compiler.compile({ modules }) === before).toMatchInlineSnapshot(
      `true`,
    )

    const after = compiler.compile({
      modules: {
        ...modules,
        'pkg/card.ts': `export const value = 'recovered';`,
      },
    })

    expect(after.modules['pkg/card.ts']!.code).toMatchInlineSnapshot(
      `"export const value = 'recovered';"`,
    )
    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}"
    `)
  })

  test('file additions recheck ambiguity and removals drop stale scopes', () => {
    const compiler = Graph.create()
    const sources = {
      ...modules,
      'pkg/card.ts': `import { style } from './theme'; export const props = style({color:'brand'})();`,
    }
    const before = compiler.compile({ modules: sources })

    expect(() =>
      compiler.compile({
        modules: {
          ...sources,
          'pkg/theme.mts': modules['pkg/theme.ts'],
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/card.ts:0: Ambiguous source import: ./theme]`,
    )
    expect(
      compiler.compile({ modules: sources }) === before,
    ).toMatchInlineSnapshot(`true`)

    const after = compiler.compile({
      modules: {
        'pkg/card.ts': sources['pkg/card.ts'],
        'pkg/theme.ts': sources['pkg/theme.ts'],
      },
    })

    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`""`)
    expect(Object.keys(after.modules)).toMatchInlineSnapshot(`
      [
        "pkg/card.ts",
        "pkg/theme.ts",
      ]
    `)
    expect(() =>
      compiler.compile({
        modules: {
          'pkg/card.ts': sources['pkg/card.ts'],
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/card.ts:0: Missing source module: ./theme]`,
    )
  })

  test('incremental scope edits render without changing component classes in Chromium', async () => {
    const compiler = Graph.create()
    const before = compiler.compile({ modules })
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const scope =
        before.modules['pkg/card.ts']!.vars['src-index-3SribQXHRu1-style-mint']!
      const className = Object.values(
        before.modules['pkg/card.ts']!.classes,
      ).join(' ')

      await page.setContent(
        `<main class="${scope}"><div id="card" class="${className}">Card</div></main>`,
      )

      const sheet = await page.addStyleTag({
        content: before.modules['pkg/card.ts']!.css,
      })

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(17, 119, 85)"`)

      const after = compiler.compile({
        modules: {
          ...modules,
          'pkg/alternate.ts': modules['pkg/alternate.ts'].replace(
            "'#175'",
            "'#f00'",
          ),
        },
      })

      await sheet.evaluate((element, css) => {
        element.textContent = css
      }, after.modules['pkg/card.ts']!.css)

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"8px"`)
    } finally {
      await browser.close()
    }
  })
})

describe('create', () => {
  test('retains host-resolved styles across generated module additions and removals', async () => {
    const compiler = Graph.create()
    const modules = {
      'card.ts':
        "import {style} from 'zyzz';export const card=style({opacity:0.5});",
    }
    const imports = { 'card.ts': { zyzz: null } }
    const first = compiler.compile({ imports, modules })
    const added = compiler.compile({
      imports: { ...imports, 'page.mdx.tsx': {} },
      modules: {
        ...modules,
        'page.mdx.tsx': 'export default function Page(){return <h1>Page</h1>}',
      },
    })

    expect(
      added.modules['card.ts'] === first.modules['card.ts'],
    ).toMatchInlineSnapshot('true')
    expect(
      added.modules['page.mdx.tsx']!.code.includes('<h1>Page</h1>'),
    ).toMatchInlineSnapshot('true')

    const removed = compiler.compile({ imports, modules })
    expect(
      removed.modules['card.ts'] === first.modules['card.ts'],
    ).toMatchInlineSnapshot('true')
    expect(removed.modules['page.mdx.tsx']).toMatchInlineSnapshot('undefined')

    const edited = compiler.compile({
      imports,
      modules: { 'card.ts': modules['card.ts'].replace('0.5', '0.75') },
    })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${edited.modules['card.ts']!.css}</style><h1 class="${Object.values(edited.modules['card.ts']!.classes).join(' ')}">Page</h1>`,
      )
      expect(
        await page
          .locator('h1')
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toMatchInlineSnapshot('"0.75"')
    } finally {
      await browser.close()
    }
  })

  test('rejects deleted host dependencies after caching a graph', () => {
    const compiler = Graph.create()
    const modules = {
      'theme.ts': 'export const opacity=0.5;',
      'card.ts':
        "import {style} from 'zyzz';import {opacity} from './theme';export const card=style({opacity});",
    }
    const imports = {
      'theme.ts': {},
      'card.ts': { zyzz: null, './theme': 'theme.ts' },
    }
    compiler.compile({ imports, modules })

    expect(() =>
      compiler.compile({ imports, modules: { 'card.ts': modules['card.ts'] } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: card.ts:27: Missing host source module: ./theme]`,
    )
  })

  test('host resolution controls aliases and invalidates changed targets', () => {
    const compiler = Graph.create()

    const modules = {
      'pkg/a.ts':
        "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#000'}},{id:'dark'});",
      'pkg/b.ts':
        "import { Vars } from 'zyzz'; export const theme = Vars.define({color:{brand:'#fff'}},{id:'light'});",
      'pkg/card.ts':
        "const themeConfig=Config.create({vars:theme});import {Config} from 'zyzz';\nimport { theme } from '@theme'; export const props = themeConfig.style({color:'brand'})();",
    }

    const imports = {
      'pkg/a.ts': { zyzz: null },
      'pkg/b.ts': { zyzz: null },
      'pkg/card.ts': { '@theme': 'pkg/a.ts', zyzz: null },
    }

    const before = compiler.compile({ imports, modules })

    imports['pkg/card.ts']['@theme'] = 'pkg/b.ts'

    const after = compiler.compile({ imports, modules })

    expect(after.dependencies['pkg/card.ts']).toMatchInlineSnapshot(`
      [
        "pkg/b.ts",
      ]
    `)
    expect(after.modules['pkg/card.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#fff;}
      .z_LMAxOH0{color:var(--z-color-brand,#fff);}"
    `)
    expect(after === before).toMatchInlineSnapshot(`false`)
    expect(() =>
      compiler.compile({ imports: {}, modules }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/a.ts:0: Missing host resolution: zyzz]`,
    )
    expect(() =>
      compiler.compile({
        imports: { ...imports, 'pkg/card.ts': { '@theme': 'pkg/missing.ts' } },
        modules,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: pkg/card.ts:46: Missing host resolution: zyzz]`,
    )
    expect(
      compiler.compile({ imports, modules }) === after,
    ).toMatchInlineSnapshot(`true`)
  })
})

describe('output', () => {
  describe('compile', () => {
    test('retains producer modes and dynamic composition across all mode pairs', async () => {
      const browser = await chromium.launch()
      try {
        for (const producer of ['atomic', 'grouped'] as const) {
          const root = await Fs.mkdtemp(Path.resolve('.fixture-css-output-'))
          try {
            const library = await Library.create(root, {
              cssOutput: producer,
              output: 'react',
            })
            const contract = await Fs.readFile(
              Path.join(library.installed, 'index.js.zyzz.json'),
              'utf8',
            )
            const libraryCss = await Fs.readFile(
              Path.join(library.installed, 'style.css'),
              'utf8',
            )
            expect(JSON.parse(contract).version).toMatchInlineSnapshot(`31`)
            if (producer === 'atomic')
              expect(
                JSON.parse(contract).exports.controls.members.button.style.style
                  .cssOutput,
              ).toMatchInlineSnapshot(`"atomic"`)
            else
              expect(
                JSON.parse(contract).exports.controls.members.button.style.style
                  .cssOutput,
              ).toMatchInlineSnapshot(`"grouped"`)
            expect(await Fs.readdir(library.installed)).not.toContain(
              'styles.ts',
            )

            for (const consumer of ['atomic', 'grouped'] as const) {
              const source = `import {Config,cx} from 'zyzz';import {controls,style} from '@acme/variants';
const {style:configured}=Config.create({cssOutput:'${consumer}'});
const override=configured({paddingLeft:'5px'});
export const authored=style({color:'red !custom',padding:'6px !custom'});
export function sample(active:boolean){return cx(controls.button({size:active?{custom:{padding:'20px'}}:undefined,active,conditions:{wide:{size:'lg'}}}),override())}`
              const input = {
                contracts: { 'library/index.js': contract },
                imports: {
                  'app.ts': {
                    '@acme/variants': 'library/index.js',
                    zyzz: null,
                  },
                },
                modules: { 'app.ts': source },
              }
              const result = Graph.compile(input)
              const app = result.modules['app.ts']!
              if (producer === 'grouped')
                expect(
                  app.css.includes('{color:red;padding:6px;}'),
                ).toMatchInlineSnapshot(`true`)
              else
                expect(
                  app.css.includes('{color:red;padding:6px;}'),
                ).toMatchInlineSnapshot(`false`)
              const built = await Esbuild.build({
                bundle: true,
                format: 'iife',
                globalName: 'fixture',
                platform: 'browser',
                stdin: { contents: app.code, loader: 'ts', resolveDir: root },
                write: false,
              })
              const page = await browser.newPage({
                viewport: { width: 450, height: 400 },
              })
              try {
                // Both independent stylesheet orders must preserve explicit cx precedence.
                for (const css of [
                  libraryCss + '\n' + app.css,
                  app.css + '\n' + libraryCss,
                ]) {
                  await page.setContent(
                    `<style>${result.sharedCss ?? ''}\n${css}</style><div id="card"></div>`,
                  )
                  await page.addScriptTag({
                    content: built.outputFiles[0]!.text,
                  })
                  for (const active of [false, true, false]) {
                    const value = await page.evaluate((active) => {
                      const sample = (
                        window as unknown as {
                          fixture: {
                            sample(active: boolean): Record<string, unknown>
                          }
                        }
                      ).fixture.sample
                      const props = sample(active)
                      const element = document.querySelector(
                        '#card',
                      ) as HTMLElement
                      for (const name of element.getAttributeNames())
                        if (name !== 'id') element.removeAttribute(name)
                      element.className = props.className as string
                      for (const [key, value] of Object.entries(props)) {
                        if (key.startsWith('data-'))
                          element.setAttribute(key, String(value))
                        if (key === 'style')
                          for (const [name, scalar] of Object.entries(
                            value as Record<string, string>,
                          ))
                            element.style.setProperty(name, scalar)
                      }
                      const style = getComputedStyle(element)
                      return {
                        border: style.borderTopWidth,
                        keys: Object.keys(props).filter(
                          (key) =>
                            !['className', 'style'].includes(key) &&
                            !key.startsWith('data-'),
                        ),
                        opacity: style.opacity,
                        paddingLeft: style.paddingLeft,
                        paddingRight: style.paddingRight,
                      }
                    }, active)
                    if (active)
                      expect(value).toMatchInlineSnapshot(`
                    {
                      "border": "3px",
                      "keys": [],
                      "opacity": "1",
                      "paddingLeft": "5px",
                      "paddingRight": "20px",
                    }
                  `)
                    else
                      expect(value).toMatchInlineSnapshot(`
                    {
                      "border": "0px",
                      "keys": [],
                      "opacity": "0.5",
                      "paddingLeft": "5px",
                      "paddingRight": "4px",
                    }
                  `)
                  }
                  await page.setViewportSize({ width: 900, height: 400 })
                  expect(
                    await page
                      .locator('#card')
                      .evaluate(
                        (element) => getComputedStyle(element).paddingRight,
                      ),
                  ).toMatchInlineSnapshot(`"12px"`)
                  await page.setViewportSize({ width: 450, height: 400 })
                }
              } finally {
                await page.close()
              }
            }
          } finally {
            await Fs.rm(root, { force: true, recursive: true })
          }
        }
      } finally {
        await browser.close()
      }
    }, 180000)

    test('rejects invalid or conflicting packed output identities', () => {
      const compiled = Graph.compile({
        modules: Library.sources({ cssOutput: 'grouped', output: 'react' }),
      })
      const metadata = compiled.contracts['@acme/variants/index.ts']!
      const data = JSON.parse(metadata)
      const theme = Object.values(data.themes)[0] as { cssOutput: string }
      theme.cssOutput = 'automatic'
      expect(() =>
        Graph.compile({
          contracts: { 'library/index.js': JSON.stringify(data) },
          modules: {},
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: library/index.js:0: Invalid library contract: Invalid packed CSS output mode.]`,
      )

      const old = JSON.parse(metadata, (key, value) =>
        key === 'staticRecipe' ? undefined : value,
      )
      old.version = 16
      const stripold = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        const entry = value as Record<string, unknown>
        if (entry.kind === 'token') delete entry.value
        for (const child of Object.values(entry)) stripold(child)
      }
      stripold(old)
      for (const entry of Object.values(old.themes) as Record<
        string,
        unknown
      >[])
        delete entry.variableSet
      expect(() =>
        Graph.compile({
          contracts: { 'library/index.js': JSON.stringify(old) },
          imports: { 'app.ts': { './library/index.js': 'library/index.js' } },
          modules: {
            'app.ts': `import {controls} from './library/index.js';export const props=controls.button();`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: library/index.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
      )

      const conflicting = metadata.replaceAll(
        '"cssOutput":"grouped"',
        '"cssOutput":"atomic"',
      )
      expect(() =>
        Graph.compile({
          contracts: { 'first.js': metadata, 'second.js': conflicting },
          modules: {},
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: second.js:0: Invalid library contract: Conflicting packed CSS output modes for one theme identity.]`,
      )
    })
    test('rejects legacy variable names through a source barrel', () => {
      const compiled = Graph.compile({
        modules: Library.sources({ cssOutput: 'atomic' }),
      })
      const data = JSON.parse(compiled.contracts['@acme/variants/index.ts']!)
      data.version = 30

      expect(() =>
        Graph.compile({
          contracts: { 'legacy.js': JSON.stringify(data) },
          imports: { 'barrel.ts': { './legacy.js': 'legacy.js' } },
          modules: { 'barrel.ts': `export {controls} from './legacy.js';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: legacy.js:0: Invalid library contract: Legacy packed variable names are unsupported. Rebuild the library with the current version of Zyzz.]`,
      )
    })

    test('shares published identities across consumers and retains nested child modes', () => {
      const first = Graph.compile({
        modules: {
          'first.ts':
            "import {Config} from 'zyzz'; const {style}=Config.create({cssOutput:'grouped'}); export const base=style({color:'red',padding:'8px'})",
        },
      })
      const packed = JSON.parse(first.contracts['first.ts']!)
      const grouped = packed.exports.base.style.style
      // Model a previously packed composition whose atomic parent owns a grouped child.
      packed.exports.base.style.style = {
        ...grouped,
        cssOutput: 'atomic',
        declarations: [],
        rules: [{ style: grouped }],
      }
      const second = Graph.compile({
        contracts: { 'first.js': JSON.stringify(packed) },
        imports: { 'second.ts': { './first.js': 'first.js' } },
        modules: { 'second.ts': "export {base} from './first.js'" },
      })
      const result = Graph.compile({
        contracts: { 'second.js': second.contracts['second.ts']! },
        imports: {
          'a.ts': { './second.js': 'second.js', zyzz: null },
          'b.ts': { './second.js': 'second.js', zyzz: null },
        },
        modules: {
          'a.ts':
            "import {cx,style} from 'zyzz'; import {base} from './second.js'; const local=style({opacity:0.5},{id:'first-local'}); export const props=cx(base(),local())",
          'b.ts':
            "import {cx,style} from 'zyzz'; import {base} from './second.js'; const local=style({opacity:1},{id:'second-local'}); export const props=cx(base(),local())",
        },
      })
      expect(result.modules['a.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-src_2d_first_2d_dcTfYzugwnm_2d_style{}
        .z_ZYrHvJ0{opacity:0.5;}
        .z_ZYrHvJ1{color:red;padding:8px;}
        .z_ZYrHvJ2{opacity:0.5;}"
      `)
      expect(result.modules['b.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-src_2d_first_2d_dcTfYzugwnm_2d_style{}
        .z_hYrPIe0{opacity:1;}
        .z_hYrPIe1{color:red;padding:8px;}
        .z_hYrPIe2{opacity:1;}"
      `)
    })

    test('restores legacy grouped configuration metadata before re-export', () => {
      const output = Graph.compile({
        modules: {
          'config.ts':
            "import {Config} from 'zyzz'; export const config=Config.create({cssOutput:'grouped'}); export const style=config.style; export const card=style({color:'red',padding:'8px'})",
        },
      })
      const packed = JSON.parse(output.contracts['config.ts']!, (key, value) =>
        key === 'staticRecipe' ? undefined : value,
      )
      packed.version = 16
      const strippacked = (value: unknown): void => {
        if (!value || typeof value !== 'object') return
        const entry = value as Record<string, unknown>
        if (entry.kind === 'token') delete entry.value
        for (const child of Object.values(entry)) strippacked(child)
      }
      strippacked(packed)
      for (const entry of Object.values(packed.themes) as Record<
        string,
        unknown
      >[])
        delete entry.variableSet
      for (const theme of Object.values(packed.themes) as Record<
        string,
        unknown
      >[])
        delete theme.cssOutput
      const barrel = Graph.compile({
        contracts: { 'config.js': JSON.stringify(packed) },
        imports: { 'barrel.ts': { './config.js': 'config.js' } },
        modules: {
          'barrel.ts': "export {card,config,style} from './config.js'",
        },
      })
      const consumer = Graph.compile({
        contracts: { 'barrel.js': barrel.contracts['barrel.ts']! },
        imports: { 'app.ts': { './barrel.js': 'barrel.js' } },
        modules: {
          'app.ts':
            "import {style} from './barrel.js'; export const card=style({color:'blue',padding:'2px'},{id:'consumer-card'})",
        },
      })
      expect(consumer.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-src_2d_config_2d_6Q0EnEZaLq6_2d_config{}
        .z_Zf5JrJ0{color:blue;padding:2px;}"
      `)
    })

    test('retains the graph default on packed root callables', () => {
      const result = Graph.compile({
        cssOutput: 'grouped',
        modules: {
          'lib.ts': `import {style} from 'zyzz';export const card=style({color:'red',padding:'8px'})`,
        },
      })
      const contract = JSON.parse(result.contracts['lib.ts']!)
      expect(contract.exports.card.style.style.cssOutput).toMatchInlineSnapshot(
        '"grouped"',
      )
      const consumer = Graph.compile({
        contracts: { 'lib.js': result.contracts['lib.ts']! },
        imports: { 'app.ts': { './lib.js': 'lib.js', zyzz: null } },
        modules: {
          'app.ts': `import {cx} from 'zyzz';import {card} from './lib.js';export const props=cx(card())`,
        },
      })
      expect(
        consumer.modules['app.ts']!.css.includes('color:red;padding:8px;'),
      ).toMatchInlineSnapshot('true')
    })

    test('carries configured composition through library contracts', async () => {
      // The helper and its styles keep the independent mode across a re-export.
      const library = Graph.compile({
        modules: {
          'config.ts':
            "import {defineConfig} from 'zyzz'; export const {style}=defineConfig({composition:'independent'}); export const badge=style({color:'red'})",
        },
      })
      const contract = library.contracts['config.ts']!

      expect(JSON.parse(contract).version).toMatchInlineSnapshot(`34`)

      const barrel = Graph.compile({
        contracts: { 'config.js': contract },
        imports: { 'barrel.ts': { './config.js': 'config.js' } },
        modules: { 'barrel.ts': "export {badge,style} from './config.js'" },
      })

      expect(
        JSON.parse(barrel.contracts['barrel.ts']!).exports.badge.style.style
          .composition,
      ).toMatchInlineSnapshot(`"independent"`)

      const consumer = Graph.compile({
        contracts: { 'barrel.js': barrel.contracts['barrel.ts']! },
        imports: { 'app.ts': { './barrel.js': 'barrel.js' } },
        modules: {
          'app.ts':
            "import {style} from './barrel.js'; export const card=style({color:'red',padding:'8px'}); export const label=style({color:'red'})",
        },
      })
      const app = consumer.modules['app.ts']!

      expect(Object.values(app.classes)).toMatchInlineSnapshot(`
        [
          "z_Zf5JrJ0 z_Zf5JrJ1 z-style-Zf5JrJ-card",
          "z_Zf5JrJ0 z-style-Zf5JrJ-label",
        ]
      `)
      expect(app.css).toMatchInlineSnapshot(`
        ".z-theme-src_2d_config_2d_6Q0EnEZaLq6_2d_style{}
        .z_Zf5JrJ0{color:red;}
        .z_Zf5JrJ1{padding:8px;}"
      `)

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${app.css}</style>${Object.values(app.classes)
            .map((className) => `<div class="${className}"></div>`)
            .join('')}`,
        )

        expect(
          await page.locator('div').evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element)

              return [style.color, style.paddingLeft]
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
              "0px",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('stylesheets', () => {
  describe('compile', () => {
    test('isolates packed reset layers while retaining graph-wide ordering', () => {
      const library = Graph.compile({
        modules: {
          'a.ts': `import 'zyzz/reset.css';import {layers} from 'zyzz/web';layers(['a']);`,
          'b.ts': `import 'zyzz/reset.css';import {layers} from 'zyzz/web';layers(['b']);`,
        },
      })

      expect(library.sharedCss).toMatchInlineSnapshot(`"@layer reset,a,b;"`)

      const app = Graph.compile({
        contracts: { 'lib/a.js': library.contracts['a.ts']! },
        imports: { 'app.ts': { lib: 'lib/a.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })

      expect(app.sharedCss).toMatchInlineSnapshot(`"@layer reset,a;"`)

      const consumer = Graph.compile({
        contracts: { 'lib/a.js': library.contracts['a.ts']! },
        imports: {
          'app.ts': { lib: 'lib/a.js' },
          'extra.ts': { 'zyzz/web': null },
        },
        modules: {
          'app.ts': `import 'lib';`,
          'extra.ts': `import {layers} from 'zyzz/web';layers(['extra']);`,
        },
      })

      expect(consumer.sharedCss).toMatchInlineSnapshot(
        `"@layer reset,a,extra;"`,
      )
    })

    test('excludes unreachable library layers from reset ordering', () => {
      const library = Graph.compile({
        modules: {
          'unused.ts': `import {layers} from 'zyzz/web';layers(['unused']);`,
        },
      })

      const app = Graph.compile({
        contracts: { 'unused.js': library.contracts['unused.ts']! },
        modules: {
          'app.ts': `import 'zyzz/reset.css';export const loaded=true;`,
        },
      })

      expect(app.sharedCss).toMatchInlineSnapshot(`"@layer reset;"`)
    })

    test('invalidates repacked ownership when only contract resolutions change', () => {
      const dependency = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./pixel.svg)'}});`,
        },
      })

      const wrapper = Graph.compile({
        contracts: { 'dep/index.js': dependency.contracts['index.ts']! },
        imports: { 'wrapper/index.ts': { dep: 'dep/index.js' } },
        modules: {
          'wrapper/index.ts': `import 'dep';export const loaded=true;`,
        },
      })

      const contracts = {
        'wrapper/index.js': wrapper.contracts['wrapper/index.ts']!,
        'a/index.js': dependency.contracts['index.ts']!,
        'b/index.js': dependency.contracts['index.ts']!,
      }

      const modules = { 'app.ts': `import 'wrapper';` }
      const compiler = Graph.create()

      const first = compiler.compile({
        contracts,
        modules,
        imports: {
          'app.ts': { wrapper: 'wrapper/index.js' },
          'wrapper/index.js': { dep: 'a/index.js' },
        },
      })

      expect(Object.values(first.sharedAssets ?? {})).toMatchInlineSnapshot(`
      [
        "a/pixel.svg",
      ]
    `)

      const second = compiler.compile({
        contracts,
        modules,
        imports: {
          'app.ts': { wrapper: 'wrapper/index.js' },
          'wrapper/index.js': { dep: 'b/index.js' },
        },
      })

      expect(Object.values(second.sharedAssets ?? {})).toMatchInlineSnapshot(`
      [
        "b/pixel.svg",
      ]
    `)
      expect(Object.values(second.sharedAssetOwners ?? {}))
        .toMatchInlineSnapshot(`
      [
        "b/index.js",
      ]
    `)
      const repacked = Graph.compile({
        contracts: { ...contracts, 'repacked.js': second.contracts['app.ts']! },
        imports: {
          'consumer.ts': { repacked: 'repacked.js' },
          'repacked.js': { wrapper: 'wrapper/index.js' },
          'wrapper/index.js': { dep: 'b/index.js' },
        },
        modules: { 'consumer.ts': "import 'repacked';" },
      })
      expect(Object.values(repacked.sharedAssets ?? {})).toMatchInlineSnapshot(`
        [
          "b/pixel.svg",
        ]
      `)
    })
    test('retains reset ordering in every independent packed entry', () => {
      const library = Graph.compile({
        modules: {
          'a.ts': `import 'zyzz/reset.css';import {Config} from 'zyzz';const config=Config.create({layers:['components']});import {global} from 'zyzz/web';global({'@layer components':{body:{color:'red'}}});`,
          'b.ts': `import 'zyzz/reset.css';import {Config} from 'zyzz';const config=Config.create({layers:['components']});import {global} from 'zyzz/web';global({'@layer components':{body:{color:'blue'}}});`,
        },
      })

      const app = Graph.compile({
        contracts: { 'lib/b.js': library.contracts['b.ts']! },
        imports: { 'app.ts': { lib: 'lib/b.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })

      expect(app.sharedCss).toMatchInlineSnapshot(`
      "@layer reset,components;
      @layer components{body{color:blue;}}"
    `)
    })
    test('rejects malformed optional packed source-map fields', () => {
      const library = Graph.compile({
        modules: {
          'index.ts': `import {global} from 'zyzz/web';global({body:{color:'red'}});`,
        },
      })

      for (const invalid of [
        { content: 1 },
        { content: null },
        { start: -1 },
        { start: 0.5 },
        { start: '0' },
      ]) {
        const contract = JSON.parse(library.contracts['index.ts']!)

        Object.assign(contract.stylesheets[0], invalid)

        expect(() =>
          Graph.compile({
            contracts: { 'lib/index.js': JSON.stringify(contract) },
            modules: { 'app.ts': 'export {}' },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib/index.js:0: Invalid library contract: Invalid packed stylesheet section.]`,
        )
      }
    })

    test('rejects conflicting packed animations and orders optional reset first', () => {
      const first = Graph.compile({
        modules: {
          'index.ts': `import {keyframes} from 'zyzz/web';export const fade=keyframes({from:{opacity:0},to:{opacity:1}});`,
        },
      })

      const second = Graph.compile({
        modules: {
          'index.ts': `import {keyframes} from 'zyzz/web';export const fade=keyframes({from:{opacity:1},to:{opacity:0}});`,
        },
      })

      expect(() =>
        Graph.compile({
          contracts: {
            'a/index.js': first.contracts['index.ts']!,
            'b/index.js': second.contracts['index.ts']!,
          },
          imports: { 'app.ts': { a: 'a/index.js', b: 'b/index.js' } },
          modules: { 'app.ts': `import 'a';import 'b';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: b/index.js:0: Conflicting animation identity: z-k-fade; supply distinct declaration ids.]`,
      )

      const source = `import 'zyzz/reset.css';import {Config} from 'zyzz';const config=Config.create({layers:['base','components']});import {global} from 'zyzz/web';global({'@layer components':{button:{fontSize:'24px'},img:{maxWidth:'none'}}});`

      expect(Graph.compile({ modules: { 'app.ts': source } }).sharedCss)
        .toMatchInlineSnapshot(`
      "@layer reset,base,components;
      @layer components{button{font-size:24px;}img{max-width:none;}}"
    `)
    })
    test('keeps optional reset below component layers in Chromium', async () => {
      const source = `import 'zyzz/reset.css';import {Config} from 'zyzz';const config=Config.create({layers:['base','components']});import {global} from 'zyzz/web';global({'@layer components':{button:{fontSize:'24px'},img:{maxWidth:'none'}}});`
      const result = Graph.compile({ modules: { 'app.ts': source } })
      const reset = await Fs.readFile(Path.resolve('src/reset.css'), 'utf8')
      const browser = await chromium.launch({ headless: true })

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${result.sharedCss}\n${reset}</style><button>Button</button><img><h1>Heading</h1><ul><li>Item</li></ul>`,
        )

        expect(
          await page
            .locator('button')
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toMatchInlineSnapshot('"24px"')
        expect(
          await page
            .locator('img')
            .evaluate((node) => getComputedStyle(node).maxWidth),
        ).toMatchInlineSnapshot('"none"')

        expect(
          await page
            .locator('h1')
            .evaluate((node) => [
              getComputedStyle(node).fontSize,
              getComputedStyle(node).fontWeight,
              getComputedStyle(node).marginTop,
            ]),
        ).toMatchInlineSnapshot(`
          [
            "16px",
            "400",
            "0px",
          ]
        `)
        expect(
          await page
            .locator('ul')
            .evaluate((node) => getComputedStyle(node).listStyleType),
        ).toMatchInlineSnapshot('"none"')
      } finally {
        await browser.close()
      }
    })

    test('injects host reset CSS below component layers in Chromium', async () => {
      const source = `import {Config} from 'zyzz';const config=Config.create({layers:['base','components']});import {global} from 'zyzz/web';global({'@layer components':{button:{fontSize:'24px'},img:{maxWidth:'none'}}});`
      const reset = await Fs.readFile(Path.resolve('src/reset.css'), 'utf8')
      const compiler = Graph.create()
      const result = compiler.compile({ modules: { 'app.ts': source }, reset })
      expect(
        compiler
          .compile({ modules: { 'app.ts': source } })
          .sharedCss?.includes('box-sizing'),
      ).toMatchInlineSnapshot('false')
      expect(() =>
        compiler.compile({
          modules: {
            'app.ts': `import {layers} from 'zyzz/web';layers(['components','reset']);`,
          },
          reset,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:0: Conflicting layer order constraints.]`,
      )
      const browser = await chromium.launch({ headless: true })

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${result.sharedCss}</style><button>Button</button><img><h1>Heading</h1><ul><li>Item</li></ul>`,
        )

        expect(
          await page
            .locator('button')
            .evaluate((node) => getComputedStyle(node).fontSize),
        ).toMatchInlineSnapshot('"24px"')
        expect(
          await page
            .locator('img')
            .evaluate((node) => getComputedStyle(node).maxWidth),
        ).toMatchInlineSnapshot('"none"')

        expect(
          await page
            .locator('h1')
            .evaluate((node) => [
              getComputedStyle(node).fontSize,
              getComputedStyle(node).fontWeight,
              getComputedStyle(node).marginTop,
            ]),
        ).toMatchInlineSnapshot(`
          [
            "16px",
            "400",
            "0px",
          ]
        `)
        expect(
          await page
            .locator('ul')
            .evaluate((node) => getComputedStyle(node).listStyleType),
        ).toMatchInlineSnapshot('"none"')
      } finally {
        await browser.close()
      }
    })

    test('links default-exported keyframes from packed libraries', () => {
      const library = Graph.compile({
        modules: {
          'effects.ts': `import {keyframes} from 'zyzz/web';const fade=keyframes({from:{opacity:0},to:{opacity:1}});export default (fade satisfies string);`,
        },
      })

      const app = Graph.compile({
        contracts: { 'lib/index.js': library.contracts['effects.ts']! },
        imports: { 'app.ts': { lib: 'lib/index.js', zyzz: null } },
        modules: {
          'app.ts': `import fade from 'lib';import {style} from 'zyzz';export namespace styles {
  export const card = style({animationName:fade})
}`,
        },
      })

      expect(app.modules['app.ts']!.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{animation-name:z-k-fade;}"`,
      )
      expect(app.sharedCss).toMatchInlineSnapshot(
        `"@keyframes z-k-fade{from{opacity:0;}to{opacity:1;}}"`,
      )
    })

    test('preserves suffix URLs and rejects relative assets without a graph host', () => {
      const source = `import {global} from 'zyzz/web';global({body:{backgroundImage:'url("?v=1")'},html:{backgroundImage:'url("")'}});`
      const result = Graph.compile({ modules: { 'app.ts': source } })

      expect(result.sharedAssets).toMatchInlineSnapshot(`{}`)
      expect(result.sharedCss).toMatchInlineSnapshot(`
      "body{background-image:url("?v=1");}
      html{background-image:url("");}"
    `)
      expect(Transform.compile({ moduleId: 'app.ts', source }).css)
        .toMatchInlineSnapshot(`
      "body{background-image:url("?v=1");}
      html{background-image:url("");}"
    `)
      expect(() =>
        Transform.compile({
          moduleId: 'app.ts',
          source: `import {global} from 'zyzz/web';global({body:{backgroundImage:'url("./image.svg")'}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:32: Relative contribution assets require Graph.compile and a relocation host.]`,
      )
    })

    test('rejects conflicting source maps and attributes layer failures to packed owners', () => {
      const library = Graph.compile({
        modules: {
          'effects.ts': `import {global,layers} from 'zyzz/web';layers(['a','b']);global({body:{color:'red'}});`,
        },
      })

      const first = JSON.parse(library.contracts['effects.ts']!)
      const second = JSON.parse(library.contracts['effects.ts']!)

      second.stylesheets[0].content += '\n'

      expect(() =>
        Graph.compile({
          contracts: {
            'pkg/first.js': JSON.stringify(first),
            'pkg/second.js': JSON.stringify(second),
          },
          imports: { 'app.ts': { a: 'pkg/first.js', b: 'pkg/second.js' } },
          modules: { 'app.ts': `import 'a';import 'b';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: pkg/second.js:0: Conflicting packed stylesheet contributions.]`,
      )

      const errors = [['bad name'], ['a', 'a'], ['b', 'a']].map((layers) => {
        const contract = JSON.parse(library.contracts['effects.ts']!)

        contract.stylesheets.push({
          source: 'effects.ts',
          key: 'extra',
          css: '',
          layers: [layers],
        })

        try {
          Graph.compile({
            contracts: { 'pkg/index.js': JSON.stringify(contract) },
            modules: { 'app.ts': `export {}` },
          })

          return 'accepted'
        } catch (error) {
          return error
        }
      })

      expect(errors).toMatchInlineSnapshot(`
      [
        [Source.ExtractError: pkg/index.js:0: Invalid library contract: Invalid layer name.],
        [Source.ExtractError: pkg/index.js:0: Invalid library contract: Duplicate layer name.],
        [Source.ExtractError: pkg/index.js:0: Invalid library contract: Conflicting layer order constraints.],
      ]
    `)
    })
    test('packs source content once and links TypeScript animation aliases', () => {
      const source = `import {global,keyframes} from 'zyzz/web';global({body:{color:'red'}});const fade=keyframes({from:{opacity:0},to:{opacity:1}});export const enter=fade satisfies string;`
      const library = Graph.compile({ modules: { 'index.ts': source } })
      const sections = JSON.parse(library.contracts['index.ts']!).stylesheets

      expect(
        sections.filter(
          (section: { content?: string }) => section.content !== undefined,
        ).length,
      ).toMatchInlineSnapshot('1')

      const app = Graph.compile({
        contracts: { 'lib.js': library.contracts['index.ts']! },
        imports: { 'app.ts': { lib: 'lib.js', zyzz: null } },
        modules: {
          'app.ts': `import {enter} from 'lib';import {style} from 'zyzz';export namespace styles {
  export const card = style({animationName:enter})
}`,
        },
      })

      expect(app.modules['app.ts']!.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{animation-name:z-k-fade;}"`,
      )
      expect(new Trace.TraceMap(app.sharedCssMap!).sourcesContent)
        .toMatchInlineSnapshot(`
      [
        "import {global,keyframes} from 'zyzz/web';global({body:{color:'red'}});const fade=keyframes({from:{opacity:0},to:{opacity:1}});export const enter=fade satisfies string;",
      ]
    `)
    })

    const source = `import {fontFace,global,keyframes,layers} from 'zyzz/web';layers(['reset','components']);fontFace({fontFamily:'App',src:'url(./assets/app.woff2)'});global({body:{backgroundImage:'url(./assets/pixel.png)'}});export const fade=keyframes({from:{opacity:0},to:{opacity:1}});`

    test('links relocated animation aliases and preserves packed side effects once', () => {
      const library = Graph.compile({
        modules: {
          'pkg/effects.ts': source + 'export const enter=fade;',
          'pkg/index.ts': `export {enter as fade} from './effects.js';`,
        },
      })

      const output = Graph.compile({
        contracts: {
          'app/node_modules/lib/index.js': library.contracts['pkg/index.ts']!,
        },
        imports: {
          'app/main.ts': { lib: 'app/node_modules/lib/index.js', zyzz: null },
        },
        modules: {
          'app/main.ts': `import {fade as enter} from 'lib';import {style} from 'zyzz';const alias=enter;export namespace styles {
  export const card = style({animationName:alias})
}`,
        },
      })

      expect(
        output.modules['app/main.ts']!.css.includes('animation-name:z-k'),
      ).toMatchInlineSnapshot('true')
      expect(
        output.sharedCss?.match(/@keyframes/g)?.length,
      ).toMatchInlineSnapshot('1')
      expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:app%2Fnode_modules%2Flib%2Fassets%2Fapp.woff2": "app/node_modules/lib/assets/app.woff2",
        "zyzz-asset:app%2Fnode_modules%2Flib%2Fassets%2Fpixel.png": "app/node_modules/lib/assets/pixel.png",
      }
    `)
      expect(
        output.sharedCss?.includes('@layer reset,components;'),
      ).toMatchInlineSnapshot('true')

      const map = new Trace.TraceMap(output.sharedCssMap!)

      expect(
        Trace.originalPositionFor(map, { line: 2, column: 0 }).source,
      ).toMatchInlineSnapshot('"app/node_modules/lib/effects.ts"')
      expect(
        map.sourcesContent?.some(
          (content) => content === source + 'export const enter=fade;',
        ),
      ).toMatchInlineSnapshot('true')
    })
    test('preserves path-like URL suffixes and rejects nested output collisions', async () => {
      const graph = Graph.compile({
        modules: {
          'pkg/a.ts': `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./asset.svg?fallback=/../other.svg)'}});`,
        },
      })

      expect(Object.values(graph.sharedAssets ?? {})).toMatchInlineSnapshot(`
      [
        "pkg/asset.svg?fallback=/../other.svg",
      ]
    `)

      const root = await Fs.mkdtemp(Path.resolve('.fixture-asset-collision-'))

      try {
        await Fs.mkdir(Path.join(root, 'effects.ts.css'))
        await Fs.writeFile(Path.join(root, 'effects.ts.css/pixel.png'), 'pixel')
        await Fs.writeFile(
          Path.join(root, 'effects.ts'),
          `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./effects.ts.css/pixel.png)'}})`,
        )

        const host = await Host.create({
          root,
          outDir: Path.join(root, 'out'),
          packageId: 'pkg',
        })

        await expect(host.build()).rejects.toThrow(
          'Asset path conflicts with generated output.',
        )
        await Fs.mkdir(Path.join(root, 'assets'))
        await Fs.writeFile(Path.join(root, 'assets/icon:dark.svg'), 'icon')
        await Fs.writeFile(
          Path.join(root, 'effects.ts'),
          `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(./assets/icon:dark.svg)'}})`,
        )
        await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
          `[Error: Asset path escapes the package root.]`,
        )
        await host.close()
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
    test('maps separate contribution calls to their own authored positions', () => {
      const source = `import {global} from 'zyzz/web';
global({body:{color:'red'}});

global({html:{color:'blue'}});`
      const library = Graph.compile({ modules: { 'effects.ts': source } })

      const output = Graph.compile({
        modules: { 'app.ts': `import 'lib'` },
        imports: { 'app.ts': { lib: 'lib/index.js' } },
        contracts: { 'lib/index.js': library.contracts['effects.ts']! },
      })

      const map = new Trace.TraceMap(output.sharedCssMap!)
      const line =
        output
          .sharedCss!.split('\n')
          .findIndex((line) => line.includes('html')) + 1

      expect(
        Trace.originalPositionFor(map, { line, column: 0 }).line,
      ).toMatchInlineSnapshot('4')
    })
    test('does not capture nested shadows of imported animations', () => {
      const output = Graph.compile({
        modules: {
          'effects.ts': source,
          'app.ts': `import {fade} from './effects.js';function other(fade:unknown){let alias=fade;return alias}export {fade}`,
        },
      })

      expect(output.sharedCss?.includes('@keyframes')).toMatchInlineSnapshot(
        'true',
      )
    })
    test('attributes malformed packed CSS and rejects conflicting layer metadata', () => {
      const library = Graph.compile({ modules: { 'effects.ts': source } })
      const contract = JSON.parse(library.contracts['effects.ts']!)

      contract.stylesheets[1].css = '@import ;'

      expect(() =>
        Graph.compile({
          modules: { 'app.ts': `import 'lib'` },
          imports: { 'app.ts': { lib: 'lib/index.js' } },
          contracts: { 'lib/index.js': JSON.stringify(contract) },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib/index.js:0: Invalid library contract: Unexpected end of input]`,
      )

      const first = JSON.parse(library.contracts['effects.ts']!)
      const second = JSON.parse(library.contracts['effects.ts']!)

      second.stylesheets[0].layers = [['different']]

      expect(() =>
        Graph.compile({
          modules: { 'app.ts': `import 'a';import 'b'` },
          imports: { 'app.ts': { a: 'lib/a.js', b: 'lib/b.js' } },
          contracts: {
            'lib/a.js': JSON.stringify(first),
            'lib/b.js': JSON.stringify(second),
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        '[Source.ExtractError: lib/b.js:0: Conflicting packed stylesheet contributions.]',
      )
    })
    test('normalizes encoded asset traversal and rejects generated or control-file collisions', async () => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-assets-paths-'))

      try {
        await Fs.mkdir(Path.join(root, 'sub'))
        await Fs.writeFile(
          Path.join(root, 'asset.png'),
          new Uint8Array([1, 2, 3]),
        )
        await Fs.writeFile(
          Path.join(root, 'sub/effects.ts'),
          `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(%2e%2e/asset.png)'}})`,
        )

        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'out'),
          packageId: 'pkg',
        })

        await host.build()

        expect((await host.build()).changed).toMatchInlineSnapshot('[]')

        for (const name of [
          'zyzz.css',
          'zyzz.shared.css',
          '.ZYZZ.JSON',
          'sub/effects.ts.css',
        ]) {
          await Fs.writeFile(Path.join(root, name), 'asset')
          await Fs.writeFile(
            Path.join(root, 'sub/effects.ts'),
            `import {global} from 'zyzz/web';global({body:{backgroundImage:'url(../${name})'}})`,
          )
          await expect(host.build()).rejects.toThrow(/conflicts/)
        }
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
    test('retains animations exported through a specifier list', () => {
      const output = Graph.compile({
        modules: {
          'effects.ts': `import {keyframes} from 'zyzz/web';const fade=keyframes({from:{opacity:0},to:{opacity:1}});export {fade}`,
        },
      })

      expect(output.sharedCss?.includes('@keyframes')).toMatchInlineSnapshot(
        'true',
      )
    })
    test('does not retain animation names exported only as types', () => {
      const output = Graph.compile({
        modules: {
          'effects.ts': `import {keyframes} from 'zyzz/web';const fade=keyframes({from:{opacity:0},to:{opacity:1}});type fade=typeof fade;export type {fade}`,
        },
      })

      expect(output.sharedCss).toMatchInlineSnapshot('undefined')
    })
    test('serves relocated assets and layers with the optional reset in Chromium', async () => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-assets-browser-'))

      const server = Http.createServer(async (request, response) => {
        try {
          if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html')
            response.end(
              '<link rel="stylesheet" href="/reset.css"><link rel="stylesheet" href="/zyzz.shared.css"><body>Styled page</body>',
            )

            return
          }

          const file = Path.join(root, 'out', request.url!.slice(1))

          response.setHeader(
            'Content-Type',
            file.endsWith('.svg') ? 'image/svg+xml' : 'text/css',
          )
          response.end(await Fs.readFile(file))
        } catch {
          response.statusCode = 404
          response.end()
        }
      })

      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

      try {
        await Fs.mkdir(Path.join(root, 'assets'))
        await Fs.writeFile(
          Path.join(root, 'assets/pixel.svg'),
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
        )
        await Fs.writeFile(
          Path.join(root, 'effects.ts'),
          `import {global} from 'zyzz/web';global({body:{margin:'13px',backgroundImage:'url(./assets/pixel.svg)'}});`,
        )

        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'out'),
          packageId: 'pkg',
        })

        await host.build()
        await Fs.copyFile(
          Path.resolve('src/reset.css'),
          Path.join(root, 'out/reset.css'),
        )
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        )
        browser = await chromium.launch()

        const page = await browser.newPage()
        const loaded: string[] = []

        page.on('response', (response) => {
          if (response.url().endsWith('pixel.svg') && response.status() === 200)
            loaded.push('asset')
        })
        await page.goto(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        )

        expect(
          await page
            .locator('body')
            .evaluate((el) => getComputedStyle(el).marginTop),
        ).toMatchInlineSnapshot('"13px"')
        expect(loaded).toMatchInlineSnapshot(`
          [
            "asset",
          ]
        `)

        await page.evaluate(
          `document.head.append(document.querySelector('link[href="/reset.css"]'))`,
        )

        expect(
          await page
            .locator('body')
            .evaluate((el) => getComputedStyle(el).marginTop),
        ).toMatchInlineSnapshot('"13px"')
      } finally {
        await browser?.close()

        if (server.listening)
          await new Promise<void>((resolve) => server.close(() => resolve()))

        await Fs.rm(root, { recursive: true, force: true })
      }
    })
    test('publishes binary relative assets with source maps and updates them atomically', async () => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-assets-'))

      try {
        await Fs.mkdir(Path.join(root, 'assets'))
        await Fs.writeFile(Path.join(root, 'effects.ts'), source)
        await Fs.writeFile(
          Path.join(root, 'assets/app.woff2'),
          new Uint8Array([0, 255, 1, 128]),
        )
        await Fs.writeFile(
          Path.join(root, 'assets/pixel.png'),
          new Uint8Array([137, 80, 78, 71, 0, 255]),
        )

        await using host = await Host.create({
          root,
          outDir: Path.join(root, 'out'),
          packageId: 'pkg',
        })

        await host.build()

        expect([
          ...(await Fs.readFile(Path.join(root, 'out/assets/app.woff2'))),
        ]).toMatchInlineSnapshot(`
        [
          0,
          255,
          1,
          128,
        ]
      `)
        expect(
          (
            await Fs.readFile(Path.join(root, 'out/zyzz.shared.css'), 'utf8')
          ).includes('zyzz-asset:'),
        ).toMatchInlineSnapshot('false')
        expect(
          JSON.parse(
            await Fs.readFile(
              Path.join(root, 'out/zyzz.shared.css.map'),
              'utf8',
            ),
          ).sourcesContent.includes(source),
        ).toMatchInlineSnapshot('true')
        expect((await host.build()).changed).toMatchInlineSnapshot('[]')

        await Fs.writeFile(
          Path.join(root, 'assets/app.woff2'),
          new Uint8Array([5, 255, 2]),
        )

        expect((await host.build()).changed).toMatchInlineSnapshot(`
        [
          "assets/app.woff2",
        ]
      `)
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    })
  })
})

describe('variables', () => {
  describe('compile', () => {
    test('resolves computed literal static keys with authored override order', () => {
      const result = Graph.compile({
        modules: {
          'app.ts': `import {style} from 'zyzz';const first={width:'5px',['width']:'10px'};const second={['width']:'20px',width:'30px'};const third={['width']:'40px'};export namespace styles {
  export const a = style({width:first.width})

  export const b = style({width:second.width})

  export const c = style({width:third.width})
}`,
        },
      })

      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z_Zf5JrJ0{width:10px;}
        .z_Zf5JrJ1{width:30px;}
        .z_Zf5JrJ2{width:40px;}"
      `)
    })

    test('rejects indexed folding across array spreads', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts': `import {style} from 'zyzz';const prefix=['5px','6px'];const sizes=['10px',...prefix,'20px'];export namespace styles {
  export const card = style({width:sizes[2]})
}`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:153: Static array indexes cannot cross spread elements.]`,
      )
    })

    test('rejects source/packed slot collisions and unresolved computed overrides', () => {
      const library = Graph.compile({
        modules: {
          'vars.ts': `import {variable} from 'zyzz';export const vars=({gap:variable('length')});`,
        },
      })

      expect(() =>
        Graph.compile({
          contracts: { 'lib/vars.js': library.contracts['vars.ts']! },
          modules: {
            'vars.ts': `import {variable} from 'zyzz';export const vars=({gap:variable('length')});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: vars.ts:54: Conflicting variable identity: --z-vars-gap; supply distinct declaration ids.]`,
      )
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts': `import {style} from 'zyzz';const base={width:'10px',[key]:'20px'};export namespace styles {
  export const card = style({width:base.width})
}`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:127: Static member reads cannot cross unresolved computed keys.]`,
      )
    })

    test('normalizes wrapped compound static values and rejects loop mutation', () => {
      const source =
        "import {style} from 'zyzz';const size=10;export namespace styles {\n  export const card = style({width:(`${size}px` as const)})\n}"

      expect(
        Graph.compile({ modules: { 'app.ts': source } }).modules['app.ts']!.css,
      ).toMatchInlineSnapshot(`".z_Zf5JrJ0{width:10px;}"`)

      const errors = [
        "for(base.width of ['20px']){}",
        'for(base.width in {changed:true}){}',
      ].map((loop) => {
        try {
          Graph.compile({
            modules: {
              'app.ts': `import {style} from 'zyzz';const base={width:'10px'};${loop}export namespace styles {export const card=style(base);}`,
            },
          })

          return 'accepted'
        } catch (error) {
          return (error as import('zyzz/compiler').Source.ExtractError)
            .diagnostics
        }
      })

      expect(errors).toMatchInlineSnapshot(`
        [
          [
            {
              "code": "unsupported_syntax",
              "end": 82,
              "message": "Static data cannot be mutated or escape through unsupported expressions.",
              "source": "app.ts",
              "start": 53,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 88,
              "message": "Static data cannot be mutated or escape through unsupported expressions.",
              "source": "app.ts",
              "start": 53,
            },
          ],
        ]
      `)
    })

    test('attributes invalid registration CSS to its descriptor', () => {
      try {
        Graph.compile({
          modules: {
            'app.ts': `import {variable} from 'zyzz';
export const vars=({gap:variable('signedLength', {inherits:false,initialValue:'}'})});`,
          },
        })
        throw new Error('Expected invalid registration')
      } catch (error) {
        expect(
          (error as import('zyzz/compiler').Source.ExtractError).diagnostics,
        ).toMatchInlineSnapshot(`
          [
            {
              "code": "unsupported_syntax",
              "end": 114,
              "message": "Registered initial values must match the declared syntax.",
              "source": "app.ts",
              "start": 55,
            },
          ]
        `)
      }
    })
    test('compiles overlapping dynamic fields and default exported static records', () => {
      const result = Graph.compile({
        modules: {
          'app.ts': `import {style} from 'zyzz';const base={color:'red'};export default base;type Values={width:string;zIndex:number}&{width:'10px';zIndex:1|2};export namespace styles {
  export const card = style(base)

  export const dynamic = style((v:Values)=>({width:v.width,zIndex:v.zIndex}))
}`,
        },
      })

      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z_Zf5JrJ0{color:red;}
        .z_Zf5JrJ1{width:var(--z-Zf5JrJ-styles-dynamic-width);}
        .z_Zf5JrJ2{z-index:var(--z-Zf5JrJ-styles-dynamic-zIndex);}"
      `)
    })

    test('shares defining variable identities across package entrypoint sidecars', () => {
      const library = Graph.compile({
        modules: {
          'vars.ts': `import {variable} from 'zyzz';export const vars=({gap:variable('length')});`,
          'index.ts': `export {vars} from './vars.js';`,
        },
      })

      const app = Graph.compile({
        contracts: {
          'pkg/vars.js': library.contracts['vars.ts']!,
          'pkg/index.js': library.contracts['index.ts']!,
        },
        imports: {
          'app.ts': { a: 'pkg/vars.js', b: 'pkg/index.js', zyzz: null },
        },
        modules: {
          'app.ts': `import {vars as a} from 'a';import {vars as b} from 'b';import {style} from 'zyzz';export namespace styles {
  export const card = style({width:a.gap,padding:b.gap})
}`,
        },
      })

      expect(app.modules['app.ts']!.css).toMatchInlineSnapshot(
        `
        ".z_Zf5JrJ0{width:var(--z-vars-gap);}
        .z_Zf5JrJ1{padding:var(--z-vars-gap);}"
      `,
      )
    })
    test('allows scalar copies and asserted static token bindings', () => {
      const result = Graph.compile({
        modules: {
          'app.ts':
            "import {Config} from 'zyzz';const {vars:theme,style}=Config.create({vars:{color:{ink:'#123'}}});const dimensions={width:'10px',nested:{width:'20px'}};const width=dimensions.width;consume(width);consume(dimensions.width);const color=(theme.color.ink as string);export namespace styles {\n  export const card = style({width:dimensions.width,color})\n}",
        },
      })

      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-color-ink:#123;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_Zf5JrJ0{width:10px;}
        .z_Zf5JrJ1{color:var(--z-color-ink,#123);}"
      `)
    })
    test('links default variable exports through packed contracts', () => {
      const library = Graph.compile({
        modules: {
          'vars.ts': `import {variable} from 'zyzz';const vars=({gap:variable('length')});export default vars;`,
        },
      })

      const app = Graph.compile({
        contracts: { 'lib.js': library.contracts['vars.ts']! },
        imports: { 'app.ts': { lib: 'lib.js', zyzz: null } },
        modules: {
          'app.ts': `import vars from 'lib';import {style} from 'zyzz';export namespace styles {
  export const card = style({width:vars.gap})
}`,
        },
      })

      expect(app.modules['app.ts']!.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{width:var(--z-vars-gap);}"`,
      )
    })
    test('rejects static records returned to runtime code', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts': `import {style} from 'zyzz';const base={width:'10px'};function get(){return base};get().width='20px';style(base);`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:53: Static data cannot be mutated or escape through unsupported expressions.]`,
      )
    })

    const librarySource = `import {variable} from 'zyzz';export const vars=({amount:variable('percentage', {inherits:false,initialValue:'25%'}),gap:variable('length', {inherits:true,initialValue:'4px'})});`

    function compile() {
      const library = Graph.compile({
        modules: {
          'vars.ts': librarySource,
          'index.ts': `export {vars as layout} from './vars.js';`,
        },
      })

      const app = Graph.compile({
        contracts: { 'lib/index.js': library.contracts['index.ts']! },
        imports: { 'app.ts': { lib: 'lib/index.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'zyzz';import {layout} from 'lib';export {layout};const base={height:'20px',padding:layout.gap} as const;type Width='10px'|'30px';interface Values {width:Width}export namespace styles {
  export const registered = style({...base,width:layout.amount})

  export const dynamic = style((values:Values)=>({...base,width:values.width}))
}`,
        },
      })

      return { library, app }
    }

    async function bundle() {
      const { library, app } = compile()
      const root = await Fs.mkdtemp(Path.resolve('.fixture-variable-package-'))

      try {
        const packageRoot = Path.join(root, 'node_modules/lib')

        await Fs.mkdir(packageRoot, { recursive: true })
        await Fs.writeFile(
          Path.join(packageRoot, 'package.json'),
          JSON.stringify({
            name: 'lib',
            type: 'module',
            exports: './index.js',
          }),
        )

        for (const [id, module] of Object.entries(library.modules)) {
          const filename = id.replace(/\.ts$/, '.js')

          await Fs.writeFile(
            Path.join(packageRoot, filename),
            (await Esbuild.transform(module.code, { loader: 'ts' })).code,
          )

          if (library.contracts[id])
            await Fs.writeFile(
              Path.join(packageRoot, filename + '.zyzz.json'),
              library.contracts[id]!,
            )
        }

        await Fs.writeFile(
          Path.join(root, 'app.ts'),
          app.modules['app.ts']!.code,
        )

        const bundle = await Esbuild.build({
          entryPoints: [Path.join(root, 'app.ts')],
          bundle: true,
          write: false,
          format: 'iife',
          globalName: 'Fixture',
          alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        })

        return {
          css: (app.sharedCss ?? '') + app.modules['app.ts']!.css,
          code: bundle.outputFiles[0]!.text,
        }
      } finally {
        await Fs.rm(root, { recursive: true, force: true })
      }
    }

    test('rejects variable identity collisions across independent libraries', () => {
      const a = Graph.compile({ modules: { 'vars.ts': librarySource } })
      const b = Graph.compile({
        modules: { 'vars.ts': librarySource.replace('25%', '50%') },
      })

      expect(() =>
        Graph.compile({
          contracts: {
            'a.js': a.contracts['vars.ts']!,
            'b.js': b.contracts['vars.ts']!,
          },
          modules: { 'app.ts': 'export {}' },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: b.js:0: Invalid library contract: Conflicting packed variable identity: --z-vars-amount; supply distinct declaration ids.]`,
      )
    })
    test('renders statically expanded theme records in a browser', async () => {
      const result = Graph.compile({
        modules: {
          'app.ts':
            "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz';const theme=Vars.define({color:{primary:'#123'}}); const themeConfig=Config.create({vars:theme});const base={color:theme.color.primary,backgroundColor:theme.color.primary};export const style=themeConfig.style(base);export const scope=themeConfig.vars().className;",
        },
      })

      const bundle = await Esbuild.build({
        stdin: {
          contents: result.modules['app.ts']!.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'Fixture',
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${result.modules['app.ts']!.css}</style><main><div id="card"></div></main>`,
        )
        await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
        await page.evaluate(
          `document.querySelector('main').className=Fixture.scope;document.getElementById('card').className=Fixture.style().className`,
        )

        expect(
          await page
            .locator('#card')
            .evaluate((el) => [
              getComputedStyle(el).color,
              getComputedStyle(el).backgroundColor,
            ]),
        ).toMatchInlineSnapshot(`
      [
        "rgb(17, 34, 51)",
        "rgb(17, 34, 51)",
      ]
    `)
      } finally {
        await browser.close()
      }
    })
    test('expands immutable theme references and rejects hidden mutations and duplicate packed slots', async () => {
      const result = Graph.compile({
        modules: {
          'app.ts':
            "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz';const theme=Vars.define({color:{primary:'#123'}}); const themeConfig=Config.create({vars:theme});const base={color:theme.color.primary,backgroundColor:theme.color.primary};export const style=themeConfig.style(base);",
        },
      })

      expect(
        result.modules['app.ts']!.css.includes('#123'),
      ).toMatchInlineSnapshot('true')

      const bundle = await Esbuild.build({
        stdin: {
          contents: result.modules['app.ts']!.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'Fixture',
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
      })

      expect(
        Vm.runInNewContext(
          `${bundle.outputFiles![0]!.text};typeof Fixture.style().className`,
        ),
      ).toMatchInlineSnapshot('"string"')
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts': `import {style} from 'zyzz';const base={width:'10px'};const [alias]=[base];alias.width='20px';export const card=style(base);`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:59: Static data cannot be mutated or escape to runtime calls.]`,
      )

      const library = Graph.compile({ modules: { 'vars.ts': librarySource } })
      const data = JSON.parse(library.contracts['vars.ts']!)

      data.exports.vars.members.gap.variables.value.name =
        data.exports.vars.members.amount.variables.value.name

      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(data) },
          imports: { 'app.ts': { lib: 'lib.js', zyzz: null } },
          modules: {
            'app.ts': `import {style} from 'zyzz';import {vars} from 'lib';export const card=style({width:vars.gap});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib.js:0: Invalid library contract: Conflicting packed variable identity: --z-vars-amount; supply distinct declaration ids.]`,
      )
    })
    test('merges finite interface declarations and rejects unsafe static records', () => {
      const graph = Graph.compile({
        modules: {
          'app.ts': `import {style} from 'zyzz';interface Values {width:'10px'|'20px'} interface Values {opacity:0|1} export const card=style((values:Values)=>({width:values.width,opacity:values.opacity}));`,
        },
      })

      expect(
        graph.modules['app.ts']!.css.includes('opacity:var('),
      ).toMatchInlineSnapshot('true')

      const errors = [
        `const base={width:'10px'};let alias=base;alias.width='20px';style(base)`,
        `const base={__proto__:'red'};style({color:base.__proto__})`,
        `const vars=({__proto__:variable('length')});style({width:vars.__proto__})`,
        `const base={width:'10px'};const alias=flag?base:{};alias.width='20px';style(base)`,
        `const base={width:'10px'};const holder={safe:base,unsafe:flag?base:{}};holder.unsafe.width='20px';style(base)`,
      ].map((source) => {
        try {
          Graph.compile({
            modules: {
              'app.ts': `import {style,variable} from 'zyzz';${source}`,
            },
          })

          return 'accepted'
        } catch (error) {
          return error
        }
      })

      expect(errors).toMatchInlineSnapshot(`
        [
          [Source.ExtractError: app.ts:66: Static data cannot be mutated or escape to runtime calls.],
          [Source.ExtractError: app.ts:48: Static object prototypes are unsupported.],
          "accepted",
          [Source.ExtractError: app.ts:74: Static data cannot be mutated or escape through unsupported expressions.],
          [Source.ExtractError: app.ts:93: Static data cannot be mutated or escape through unsupported expressions.],
        ]
      `)
    })

    test('links registered variable references and assignments through packed aliases', async () => {
      expect(
        JSON.parse(compile().library.contracts['vars.ts']!).version,
      ).toMatchInlineSnapshot(`31`)

      const { code, css } = await bundle()

      const value = Vm.runInNewContext(`${code};Fixture;`) as {
        layout: {
          amount: import('zyzz').variable.Reference<'percentage'>
          gap: import('zyzz').variable.Reference<'length'>
        }
        styles: {
          dynamic: (values: { width: string }) => {
            style: Record<string, string>
          }
        }
      }

      expect(
        Object.values({
          ...value.layout['amount'].set('50%'),
          ...value.layout['gap'].set('8px'),
        }),
      ).toMatchInlineSnapshot(`
      [
        "50%",
        "8px",
      ]
    `)
      expect(Object.values(value.styles.dynamic({ width: '30px' }).style))
        .toMatchInlineSnapshot(`
      [
        "30px",
      ]
    `)
      expect(css).toMatchInlineSnapshot(`
        "@property --z-vars-amount{syntax:"<percentage>";inherits:false;initial-value:25%;}
        @property --z-vars-gap{syntax:"<length>";inherits:true;initial-value:4px;}.z_Zf5JrJ0{height:20px;}
        .z_Zf5JrJ1{padding:var(--z-vars-gap);}
        .z_Zf5JrJ2{width:var(--z-vars-amount);}
        .z_Zf5JrJ3{width:var(--z-Zf5JrJ-styles-dynamic-width);}"
      `)
    })
    test('expands immutable members and shorthand while retaining dynamic intersections', () => {
      const graph = Graph.compile({
        modules: {
          'static.ts': `import { style, variable } from 'zyzz';const dimensions={width:'12px',padding:'4px'} as const;const width=dimensions.width;const base={width,padding:dimensions.padding};type Width='10px'|'30px';type Values={width:Width}&{opacity:0|1};export const count=({n:variable('number', {inherits:false,initialValue:-1})});export namespace styles {
  export const card = style({...base,padding:'8px'})

  export const dynamic = style((values:Values)=>({width:values.width,opacity:values.opacity}))
}`,
        },
      })

      expect(graph.modules['static.ts']!.css).toMatchInlineSnapshot(`
        ".z_r9-r0Q0{width:12px;}
        .z_r9-r0Q1{padding:8px;}
        .z_r9-r0Q2{width:var(--z-r9-r0Q-styles-dynamic-width);}
        .z_r9-r0Q3{opacity:var(--z-r9-r0Q-styles-dynamic-opacity);}"
      `)
      expect(graph.sharedCss).toMatchInlineSnapshot(
        `"@property --z-count-n{syntax:"<number>";inherits:false;initial-value:-1;}"`,
      )
      expect(
        graph.modules['static.ts']!.code.includes('values:Values'),
      ).toMatchInlineSnapshot('false')
    })
    test('keeps module type aliases when unrelated nested declarations shadow their names', () => {
      const output = Graph.compile({
        modules: {
          'app.ts': `import { style, variable } from 'zyzz';type Values={width:'10px'};function unrelated(){type Values={width:unknown}}export const vars=({gap:variable('length', {inherits:true,initialValue:'4px',syntax:undefined})});export const card=style((values:Values)=>({width:values.width}));`,
        },
      })

      expect(
        output.modules['app.ts']!.css.includes('width:var('),
      ).toMatchInlineSnapshot('true')
      expect(output.sharedCss?.includes('@property')).toMatchInlineSnapshot(
        'true',
      )
    })
    test('rejects mutation through nested record aliases', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts': `import {style} from 'zyzz';const base={width:'10px'};const holder={nested:{base}};holder.nested.base.width='20px';export const card=style(base);`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:82: Static data cannot be mutated or escape through unsupported expressions.]`,
      )
    })
    test('does not resolve a shadowed type alias using the outer declaration', () => {
      expect(() =>
        Graph.compile({
          modules: {
            'shadow.ts': `import {style} from 'zyzz';type Values={width:'10px'};function render(){type Values={width:unknown};return style((values:Values)=>({width:values.width}))}`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: shadow.ts:85: Dynamic values require explicit string or number scalar types.]`,
      )
    })
    test('rejects mutated and escaping static records through aliases', () => {
      const mutations = [
        `base.width='30px';`,
        `const alias=base;alias.width='30px';`,
        `consume(base);`,
      ]

      expect(
        mutations.map((mutation) => {
          try {
            Graph.compile({
              modules: {
                'app.ts': `import {style} from 'zyzz';const base={width:'10px'};${mutation}export const card=style(base);`,
              },
            })

            return 'accepted'
          } catch (error) {
            return error
          }
        }),
      ).toMatchInlineSnapshot(`
        [
          [Source.ExtractError: app.ts:53: Static data cannot be mutated or escape through unsupported expressions.],
          [Source.ExtractError: app.ts:70: Static data cannot be mutated or escape through unsupported expressions.],
          [Source.ExtractError: app.ts:53: Static data cannot be mutated or escape through unsupported expressions.],
        ]
      `)
    })
    test('rejects loop writes and noncanonical array member keys', () => {
      const errors = [
        `for(base.width of ['20px']){}`,
        `for(base.width in {x:1}){}`,
      ].map((write) => {
        try {
          Graph.compile({
            modules: {
              'app.js': `import {style} from 'zyzz';const base={width:'10px'};${write}export const card=style(base)`,
            },
          })

          return 'accepted'
        } catch (error) {
          return error
        }
      })

      expect(errors).toMatchInlineSnapshot(`
        [
          [Source.ExtractError: app.js:53: Static data cannot be mutated or escape through unsupported expressions.],
          [Source.ExtractError: app.js:53: Static data cannot be mutated or escape through unsupported expressions.],
        ]
      `)
      expect(() =>
        Graph.compile({
          modules: {
            'app.js': `import {style} from 'zyzz';const sizes=['10px','20px'];export const card=style({width:sizes['01']})`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.js:86: Expected a literal string or number; expressions are not evaluated.]`,
      )
    })
    test('does not publish values through type-only variable exports', () => {
      const output = Graph.compile({
        modules: {
          'vars.ts': `import {variable} from 'zyzz';const vars=({gap:variable('length')});type vars=typeof vars;export type {vars};export {type vars as other}`,
        },
      })

      expect(output.contracts['vars.ts']).toMatchInlineSnapshot('undefined')
    })
    test('applies registered defaults, inheritance, and assignment in Chromium', async () => {
      const { code, css } = await bundle()
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${css}</style><main style="width:400px"><div id="card"></div></main>`,
        )
        await page.addScriptTag({ content: code })
        await page.evaluate(
          `document.getElementById('card').className=Fixture.styles.registered().className`,
        )

        expect(
          await page
            .locator('#card')
            .evaluate((el) => getComputedStyle(el).width),
        ).toMatchInlineSnapshot('"100px"')

        await page.evaluate(
          `for(const [key,value]of Object.entries(({...Fixture.layout["amount"].set('50%'),...Fixture.layout["gap"].set('8px')})))document.querySelector('main').style.setProperty(key,value)`,
        )

        expect(
          await page
            .locator('#card')
            .evaluate((el) => getComputedStyle(el).width),
        ).toMatchInlineSnapshot('"100px"')
        expect(
          await page
            .locator('#card')
            .evaluate((el) => getComputedStyle(el).paddingLeft),
        ).toMatchInlineSnapshot('"8px"')

        await page.evaluate(
          `for(const [key,value]of Object.entries(({...Fixture.layout["amount"].set('75%')})))document.getElementById('card').style.setProperty(key,value)`,
        )

        expect(
          await page
            .locator('#card')
            .evaluate((el) => getComputedStyle(el).width),
        ).toMatchInlineSnapshot('"300px"')
      } finally {
        await browser.close()
      }
    })
  })
})
