/** Exercises public recipe compilation and real browser choice transitions. @module */
import * as Packed from '../test/fixtures/Packed.js'
import * as Library from '../test/fixtures/VariantLibrary.js'
import * as Watch from '../test/fixtures/Watch.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as Esbuild from 'esbuild'
import * as Lightning from 'lightningcss'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Util from 'node:util'
import { chromium } from 'playwright'
import * as Ts from 'typescript-api'
import * as Vite from 'vite'
import { describe, expect, test } from 'vite-plus/test'
import { Graph, Source, Transform } from 'zyzz/compiler'
import { Host } from 'zyzz/node'
import { zyzz } from 'zyzz/vite'

const source = `import { variants as recipe } from 'zyzz'
export namespace styles {
  export const button = recipe({
    base: { color: 'black', padding: '2px', opacity: 1 },
    variants: {
      size: { sm: { padding: '4px' }, lg: { padding: '12px' } },
      loading: { true: { opacity: 0.5 }, false: { opacity: 1 } },
    },
    defaultVariants: { size: 'sm', loading: false },
    compoundVariants: [
      { when: { size: ['sm', 'lg'], loading: true }, style: { color: 'red' } },
      { when: { size: 'lg', loading: true }, style: { color: 'blue' } },
      { when: { size: 'lg', loading: true }, style: { fontWeight: 700 } },
    ],
  })
}`

describe('variants', () => {
  test.each([
    ["import { variants } from 'zyzz'", '', 'red'],
    [
      "import { Config } from 'zyzz'",
      "const { variants } = Config.create({ vars: { color: { brand: '#123456' } } })",
      'brand',
    ],
    [
      "import { Config } from 'zyzz'",
      "const { variants } = Config.create({ vars: { color: { brand: '#123456' } }, mappings: false, layers: ['base'] })",
      'color.brand',
    ],
    ["import { variants } from 'zyzz/default'", '', 'red.700'],
  ])(
    'suggests recipe declarations through %s',
    (imports, setup, color) => {
      const root = Path.resolve(import.meta.dirname, '..')
      const file = Path.join(root, '.fixture-variants-editor.ts')
      const source = `${imports}
${setup}
const button = variants({
  base: { /* base */ display: '/* display */', color: '/* baseColor */', flexShrink: '/* shrink */' },
  variants: {
    size: {
      small: { /* choice */ color: '/* choiceColor */', ':hover': { /* nested */ display: '/* nestedDisplay */' } },
      custom: (values: { opacity: number }) => ({ /* dynamic */ opacity: values.opacity, color: '/* dynamicColor */' }),
    },
  },
  compoundVariants: [{ when: { size: 'small' }, style: { /* compound */ color: '/* compoundColor */' } }],
})
`
      const options: Ts.CompilerOptions = {
        module: Ts.ModuleKind.ESNext,
        moduleResolution: Ts.ModuleResolutionKind.Bundler,
        noEmit: true,
        paths: {
          zyzz: [Path.join(root, 'src/index.ts')],
          'zyzz/default': [Path.join(root, 'src/default.ts')],
        },
        skipLibCheck: true,
        strict: true,
        target: Ts.ScriptTarget.ESNext,
        types: [],
      }
      const snapshots = new Map<string, Ts.IScriptSnapshot>()
      const service = Ts.createLanguageService({
        fileExists: (path) => path === file || Ts.sys.fileExists(path),
        getCompilationSettings: () => options,
        getCurrentDirectory: () => root,
        getDefaultLibFileName: Ts.getDefaultLibFilePath,
        getScriptFileNames: () => [file],
        getScriptSnapshot: (path) => {
          const cached = snapshots.get(path)
          if (cached) return cached

          const text = path === file ? source : Ts.sys.readFile(path)
          if (text === undefined) return undefined

          const snapshot = Ts.ScriptSnapshot.fromString(text)
          snapshots.set(path, snapshot)
          return snapshot
        },
        getScriptVersion: () => '0',
        readDirectory: Ts.sys.readDirectory,
        readFile: (path) => (path === file ? source : Ts.sys.readFile(path)),
      })

      try {
        for (const marker of [
          'base',
          'choice',
          'nested',
          'dynamic',
          'compound',
        ]) {
          const names =
            service
              .getCompletionsAtPosition(
                file,
                source.indexOf(`/* ${marker} */`),
                {},
              )
              ?.entries.map((entry) => entry.name.replace(/^"|"$/g, '')) ?? []
          expect(names.includes('height'), marker).toMatchInlineSnapshot(`true`)
          expect(names.includes('::before'), marker).toMatchInlineSnapshot(
            `true`,
          )
        }
        for (const [marker, expected] of [
          ['display', 'flex'],
          ['nestedDisplay', 'grid'],
          ['shrink', 'inherit'],
          ['baseColor', color],
          ['choiceColor', color],
          ['dynamicColor', color],
          ['compoundColor', color],
        ]) {
          const names =
            service
              .getCompletionsAtPosition(
                file,
                source.indexOf(`/* ${marker} */`),
                {},
              )
              ?.entries.map((entry) => entry.name) ?? []
          expect(names.includes(expected!), marker).toMatchInlineSnapshot(
            `true`,
          )
        }
      } finally {
        service.dispose()
      }
    },
    // CI runs the language service alongside other coverage-instrumented suites.
    90_000,
  )

  test('renders registered computed conditions in recipe bodies', async () => {
    const source = `import {variants} from 'zyzz';import {customMedia} from 'zyzz/web';const query=customMedia('(width > 0px)');export const button=variants({base:{[query]:{color:'red'}},variants:{size:{sm:{[query]:{padding:'4px'}}}},defaultVariants:{size:'sm'},compoundVariants:[{when:{size:'sm'},style:{[query]:{opacity:0.5}}}]});`
    const graph = Graph.compile({ modules: { 'computed.ts': source } })
    const output = graph.modules['computed.ts']!
    const bundled = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: process.cwd() },
      alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
      bundle: true,
      format: 'iife',
      globalName: 'App',
      write: false,
    })
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
    })
    try {
      const page = await browser.newPage()
      const css = Lightning.transform({
        filename: 'computed.css',
        code: Buffer.from((graph.sharedCss ?? '') + output.css),
        drafts: { customMedia: true },
        include: Lightning.Features.CustomMediaQueries,
        targets: { chrome: 120 << 16 },
      }).code.toString()
      await page.setContent(`<style>${css}</style><button></button>`)
      await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
      await page.evaluate(
        `{const el=document.querySelector('button');for(const [key,value] of Object.entries(App.button()))key==='className'?el.className=value:el.setAttribute(key,value)}`,
      )
      expect(
        await page
          .locator('button')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page
          .locator('button')
          .evaluate((element) => getComputedStyle(element).paddingTop),
      ).toMatchInlineSnapshot('"4px"')
      expect(
        await page
          .locator('button')
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toMatchInlineSnapshot('"0.5"')
    } finally {
      await browser.close()
    }
  })

  test('keeps repeated compound selector growth proportional to rule count', () => {
    function size(count: number) {
      return Transform.compile({
        moduleId: 'compounds.ts',
        source: `import {variants} from 'zyzz';export const recipe=variants({variants:{tone:{red:{}}},compoundVariants:[${Array.from({ length: count }, (_, index) => `{when:{tone:'red'},style:{zIndex:${index}}}`).join(',')}]});`,
      }).css.length
    }
    expect(size(100) < size(50) * 2.2).toMatchInlineSnapshot('true')
  })

  test('preserves own selections, static defaults, and mixed namespace folding', async () => {
    const result = Transform.compile({
      moduleId: 'edge.ts',
      source: `import { style, variants } from 'zyzz';
      namespace styles {
        export const card = style({ color: 'red' });
        export const button = variants({ variants: { constructor: { small: {} } }, defaultVariants: { constructor: 'small' } });
      }
      export const props = styles.card();
      export function recipe(input?: object) { return styles.button(input) };
      export const empty = variants({ variants: { size: { sm: {} } }, defaultVariants: { size: undefined } });`,
    })
    // The application follows the namespace, so it folds without a guard.
    expect(
      result.code.includes('export const props = ({className:'),
    ).toMatchInlineSnapshot(`true`)
    const output = await Esbuild.build({
      stdin: { contents: result.code, loader: 'ts', resolveDir: process.cwd() },
      alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
      bundle: true,
      format: 'cjs',
      write: false,
    })
    const module = {
      exports: {} as {
        recipe: (input?: object) => Record<string, unknown>
        empty: () => Record<string, unknown>
      },
    }
    new Function('module', 'exports', output.outputFiles![0]!.text)(
      module,
      module.exports,
    )
    expect(module.exports.recipe()['data-constructor']).toMatchInlineSnapshot(
      '"small"',
    )
    expect(
      module.exports.recipe(Object.create({ constructor: 'other' }))[
        'data-constructor'
      ],
    ).toMatchInlineSnapshot('"small"')
    expect(module.exports.empty()['data-size']).toMatchInlineSnapshot(
      'undefined',
    )
  })

  test('rejects unsupported recipe keys and top-level callbacks', () => {
    expect(() =>
      Source.extract({
        moduleId: 'invalid.ts',
        source: `import { variants } from 'zyzz'; variants({ variants: { size: { 1: {} } } })`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:64: Recipe choice names require CSS-safe strings.]`,
    )
    expect(() =>
      Source.extract({
        moduleId: 'invalid.ts',
        source: `import { variants } from 'zyzz'; variants({ variants: { size: { '\\0': {} } } })`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:64: Recipe choice names require CSS-safe strings.]`,
    )
    expect(() =>
      Source.extract({
        moduleId: 'invalid.ts',
        source: `import { variants } from 'zyzz'; variants((values: { opacity: number }) => ({ base: { opacity: values.opacity } }))`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:42: Recipes require static top-level objects.]`,
    )
  })

  test('renders defaults, choices, ordered compounds, null, and inline overrides', async () => {
    const result = Graph.compile({ modules: { 'recipe.ts': source } })
    const output = result.modules['recipe.ts']!
    const bundled = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: process.cwd() },
      alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
      bundle: true,
      format: 'iife',
      globalName: 'App',
      write: false,
    })
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
    })

    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${output.css}</style><button id="button">Button</button>`,
      )
      await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
      await page.evaluate(`{
        const el = document.querySelector('#button');
        window.apply = (input) => {
          const props = App.styles.button(input);
          for (const attr of [...el.attributes]) if (attr.name !== 'id') el.removeAttribute(attr.name);
          el.className = props.className;
          for (const [key, value] of Object.entries(props)) if (key.startsWith('data-')) el.setAttribute(key, value);
          Object.assign(el.style, props.style);
        };
        window.initialClass = App.styles.button().className;
        window.initialRules = document.styleSheets[0].cssRules.length;
        apply();
      }`)
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).paddingTop`,
        ),
      ).toMatchInlineSnapshot('"4px"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).color`,
        ),
      ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).opacity`,
        ),
      ).toMatchInlineSnapshot('"1"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).fontWeight`,
        ),
      ).toMatchInlineSnapshot('"400"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-size')`,
        ),
      ).toMatchInlineSnapshot('"sm"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-loading')`,
        ),
      ).toMatchInlineSnapshot('"false"')
      await page.evaluate(`apply({size:'lg',loading:true})`)
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).paddingTop`,
        ),
      ).toMatchInlineSnapshot('"12px"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).color`,
        ),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).opacity`,
        ),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).fontWeight`,
        ),
      ).toMatchInlineSnapshot('"700"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-size')`,
        ),
      ).toMatchInlineSnapshot('"lg"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-loading')`,
        ),
      ).toMatchInlineSnapshot('"true"')
      await page.evaluate(
        `apply({size:null,loading:null,style:{color:'green'}})`,
      )
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).paddingTop`,
        ),
      ).toMatchInlineSnapshot('"2px"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).color`,
        ),
      ).toMatchInlineSnapshot('"rgb(0, 128, 0)"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).opacity`,
        ),
      ).toMatchInlineSnapshot('"1"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).fontWeight`,
        ),
      ).toMatchInlineSnapshot('"400"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-size')`,
        ),
      ).toMatchInlineSnapshot('null')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-loading')`,
        ),
      ).toMatchInlineSnapshot('null')
      expect(
        await page.evaluate(
          `App.styles.button({size:'lg'}).className === initialClass`,
        ),
      ).toMatchInlineSnapshot('true')
      expect(
        await page.evaluate(
          `document.styleSheets[0].cssRules.length === initialRules`,
        ),
      ).toMatchInlineSnapshot('true')
      await page.evaluate(`apply({size:undefined,loading:false})`)
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).paddingTop`,
        ),
      ).toMatchInlineSnapshot('"4px"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).color`,
        ),
      ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).opacity`,
        ),
      ).toMatchInlineSnapshot('"1"')
      expect(
        await page.evaluate(
          `getComputedStyle(document.querySelector('#button')).fontWeight`,
        ),
      ).toMatchInlineSnapshot('"400"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-size')`,
        ),
      ).toMatchInlineSnapshot('"sm"')
      expect(
        await page.evaluate(
          `document.querySelector('#button').getAttribute('data-loading')`,
        ),
      ).toMatchInlineSnapshot('"false"')
    } finally {
      await browser.close()
    }
  })

  test('reports unsupported recipe structure at its source', () => {
    expect(() =>
      Source.extract({
        moduleId: 'recipe.ts',
        source: `import {variants} from 'zyzz'; variants({slots:{root:{}}})`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: recipe.ts:41: Unknown recipe field: slots.]`,
    )
    expect(() =>
      Source.extract({
        moduleId: 'recipe.ts',
        source: `import {variants} from 'zyzz'; variants({variants:{size:{sm:{}}},defaultVariants:{size:'lg'}})`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: recipe.ts:87: Unknown recipe choice.]`,
    )
  })
})

describe('bound', () => {
  describe('variants', () => {
    test('retains mixed theme bindings through renamed exports and packed consumers', async () => {
      const modules = {
        'theme.ts':
          "import {Config} from 'zyzz';\nexport const {vars:theme,style,variants:recipe}=Config.create({vars:{color:{brand:'#06c'}}});\nconst alias=recipe;\nexport {alias};",
        'index.ts': `export {style as styled,alias as variants,theme} from './theme.js';`,
      }
      const app = `import {styled,variants,theme} from './index.js';
export const scope=theme().className;
export const base=styled({color:'black !custom',padding:'6px !custom'});
export const button=variants({variants:{intent:{primary:{color:'brand'},quiet:{color:'red !custom'}}},defaultVariants:{intent:'primary'}});`
      const publisher = Graph.compile({ modules })
      const packed = Graph.compile({
        modules: { 'app.ts': app },
        contracts: publisher.contracts,
        imports: { 'app.ts': { './index.js': 'index.ts' } },
      })
      const source = Graph.compile({ modules: { ...modules, 'app.ts': app } })

      expect(
        packed.modules['app.ts']!.css === source.modules['app.ts']!.css,
      ).toMatchInlineSnapshot('true')
      expect(
        publisher.modules['theme.ts']!.code.includes(
          '{css:undefined,variants:undefined}',
        ),
      ).toMatchInlineSnapshot(`false`)

      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: Object.fromEntries(
          Object.entries({ ...publisher.modules, ...packed.modules }).map(
            ([id, module]) => [id, module.code],
          ),
        ),
      })

      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${publisher.sharedCss ?? ''}\n${packed.sharedCss ?? ''}\n${packed.modules['app.ts']!.css}</style><main><button>Button</button></main>`,
        )
        await page.addScriptTag({ content: code + ';globalThis.App=Fixture;' })
        expect(
          await page.evaluate(`{
        document.querySelector('main').className=App.scope;
        const button=document.querySelector('button');
        const states=[];
        for(const intent of [undefined,'quiet',null,'primary']) {
          const props=App.button({intent});
          button.className=App.base().className+' '+props.className;
          button.removeAttribute('data-intent');
          if(props['data-intent']!==undefined) button.setAttribute('data-intent',props['data-intent']);
          const computed=getComputedStyle(button);
          states.push([computed.color,computed.paddingLeft]);
        }
        states;
      }`),
        ).toMatchInlineSnapshot(`
        [
          [
            "rgb(0, 102, 204)",
            "6px",
          ],
          [
            "rgb(255, 0, 0)",
            "6px",
          ],
          [
            "rgb(0, 0, 0)",
            "6px",
          ],
          [
            "rgb(0, 102, 204)",
            "6px",
          ],
        ]
      `)
      } finally {
        await browser.close()
      }
    })

    test('preserves configured aliases through source and packed contracts', async () => {
      const config =
        "import {Config} from 'zyzz'; export const {variants,vars:theme}=Config.create({output:'html',vars:{color:{brand:'#06c'}},shorthands:{px:['paddingLeft','paddingRight']}})"
      const app = `import {variants as recipe,theme} from './config.js'; export const scope=theme().class; export const button=recipe({base:{px:'8px !custom'},variants:{intent:{primary:{color:'brand'},quiet:{color:'black !custom'}}},defaultVariants:{intent:'primary'}})`
      const publisher = Graph.compile({ modules: { 'config.ts': config } })
      const result = Graph.compile({
        modules: { 'app.ts': app },
        contracts: publisher.contracts,
        imports: { 'app.ts': { './config.js': 'config.ts' } },
      })
      const source = Graph.compile({
        modules: { 'config.ts': config, 'app.ts': app },
      })
      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(
        `
        ".z-theme-theme{--z-color-brand:#06c;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_Zf5JrJ0{padding-left:8px;}
        .z_Zf5JrJ1{padding-right:8px;}
        .z_Zf5JrJ2{&:where([data-intent="primary"]){color:var(--z-color-brand,#06c);}}
        .z_Zf5JrJ3{&:where([data-intent="quiet"]){color:black;}}"
      `,
      )
      expect(
        result.modules['app.ts']!.css === source.modules['app.ts']!.css,
      ).toMatchInlineSnapshot('true')
      expect(
        JSON.parse(publisher.contracts['config.ts']!).version,
      ).toMatchInlineSnapshot(`31`)
      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: Object.fromEntries(
          Object.entries({ ...publisher.modules, ...result.modules }).map(
            ([id, module]) => [id, module.code],
          ),
        ),
      })

      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${publisher.sharedCss ?? ''}\n${result.sharedCss ?? ''}\n${result.modules['app.ts']!.css}</style><main><button>Button</button></main>`,
        )
        await page.addScriptTag({ content: code + ';globalThis.App=Fixture;' })
        await page.evaluate(`{
        document.querySelector('main').className=App.scope;
        const button=document.querySelector('button');
        const props=App.button();
        for(const [key,value] of Object.entries(props)) button.setAttribute(key,value);
      }`)
        expect(
          await page.evaluate(
            `getComputedStyle(document.querySelector('button')).color`,
          ),
        ).toMatchInlineSnapshot('"rgb(0, 102, 204)"')
        expect(
          await page.evaluate(
            `getComputedStyle(document.querySelector('button')).paddingLeft`,
          ),
        ).toMatchInlineSnapshot('"8px"')
        expect(
          await page.evaluate(
            `getComputedStyle(document.querySelector('button')).paddingRight`,
          ),
        ).toMatchInlineSnapshot('"8px"')
        expect(
          await page.evaluate(`App.button()['data-intent']`),
        ).toMatchInlineSnapshot('"primary"')
        expect(
          await page.evaluate(`Object.hasOwn(App.button(),'className')`),
        ).toMatchInlineSnapshot('false')
      } finally {
        await browser.close()
      }
    })

    test('supports local theme recipes and destructured aliases', async () => {
      const output = Graph.compile({
        modules: {
          'app.ts':
            "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz'; const theme=Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); const {variants}=themeConfig; export const a=themeConfig.variants({base:{color:'brand'}}); export const b=variants({base:{color:'brand'}});",
        },
      })
      const bundled = await Esbuild.build({
        stdin: {
          contents: output.modules['app.ts']!.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'cjs',
        write: false,
      })
      const module = { exports: {} as { a: () => object; b: () => object } }
      new Function('module', 'exports', bundled.outputFiles![0]!.text)(
        module,
        module.exports,
      )
      expect(module.exports.a()).toMatchInlineSnapshot(`
        {
          "className": "z_Zf5JrJ0 z-style-Zf5JrJ-a",
        }
      `)
      expect(module.exports.b()).toMatchInlineSnapshot(`
        {
          "className": "z_Zf5JrJ0 z-style-Zf5JrJ-b",
        }
      `)
    })
  })
})

describe('conditions', () => {
  const config =
    "import {Config} from 'zyzz';\nexport const {variants,vars:theme}=Config.create({output:'html',vars:{breakpoint:{md:'600px'},color:{brand:'black'}}});"
  const source = `import {variants,theme} from './config.js';
export const scope=theme().class;
export const button=variants({
  base:{padding:'2px',borderWidth:'0px',borderStyle:'solid',color:'brand',opacity:1,fontWeight:400},
  conditions:{wide:'@media >=md',compact:'@media/**/(height < 500px), print',grid:'@supports(display: grid)'},
  variants:{size:{sm:{padding:'4px',borderWidth:'2px'},lg:{padding:'12px'}},loading:{true:{opacity:0.5},false:{}},constructor:{normal:{}}},
  defaultVariants:{size:'sm',loading:false,constructor:'normal'},
  compoundVariants:[
    {when:{size:['sm','lg'],loading:true},style:{fontWeight:600}},
    {when:{size:'lg',loading:true},style:{color:'blue !custom'}},
    {when:{size:'lg',loading:true},style:{fontWeight:700}}
  ]
});`

  describe('variants', () => {
    test('complements negated media types and false support queries', async () => {
      const queries = [
        '@media NOT screen',
        '@media ONLY screen and (width > 0px)',
        '@media not ((width < 0px) or (height < 0px))',
        '@supports not (display: made-up-value)',
        '@supports (display: made-up-value)',
      ]
      const source = `import {variants} from 'zyzz';${queries
        .map(
          (query, index) =>
            `export const r${index}=variants({base:{color:'black'},conditions:{when:${JSON.stringify(query)}},variants:{tone:{selected:{color:'red'}}}});`,
        )
        .join('')}`
      const output = Graph.compile({ modules: { 'app.ts': source } }).modules[
        'app.ts'
      ]!
      const bundled = await Esbuild.build({
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'iife',
        globalName: 'App',
        write: false,
      })
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${output.css}</style>${queries.map((_, index) => `<button id="r${index}">Button</button>`).join('')}`,
        )
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        await page.evaluate(`{
        for(const el of document.querySelectorAll('button')) {
          const props=App[el.id]({conditions:{when:{tone:'selected'}}});
          el.className=props.className;
          for(const [key,value] of Object.entries(props)) if(key.startsWith('data-')) el.setAttribute(key,value);
        }
        window.readColors=()=>[...document.querySelectorAll('button')].map(el=>getComputedStyle(el).color);
      }`)
        expect(await page.evaluate('readColors()')).toMatchInlineSnapshot(`
        [
          "rgb(0, 0, 0)",
          "rgb(255, 0, 0)",
          "rgb(255, 0, 0)",
          "rgb(255, 0, 0)",
          "rgb(0, 0, 0)",
        ]
      `)
        await page.emulateMedia({ media: 'print' })
        expect(await page.evaluate('readColors()')).toMatchInlineSnapshot(`
        [
          "rgb(255, 0, 0)",
          "rgb(0, 0, 0)",
          "rgb(255, 0, 0)",
          "rgb(255, 0, 0)",
          "rgb(0, 0, 0)",
        ]
      `)
      } finally {
        await browser.close()
      }
    })

    test('selects effective choices and compounds through viewport and application changes', async () => {
      const publisher = Graph.compile({ modules: { 'config.ts': config } })
      const result = Graph.compile({
        modules: { 'app.ts': source },
        contracts: publisher.contracts,
        imports: { 'app.ts': { './config.js': 'config.ts' } },
      })
      const direct = Graph.compile({
        modules: { 'config.ts': config, 'app.ts': source },
      })
      const output = result.modules['app.ts']!
      expect(
        output.css === direct.modules['app.ts']!.css,
      ).toMatchInlineSnapshot('true')
      expect(
        output.code.includes(
          'conditions:{"wide":unknown;"compact":unknown;"grid":unknown}',
        ),
      ).toMatchInlineSnapshot('true')

      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: Object.fromEntries(
          Object.entries({ ...publisher.modules, ...result.modules }).map(
            ([id, module]) => [id, module.code],
          ),
        ),
      })

      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage({
          viewport: { width: 400, height: 800 },
        })
        await page.setContent(`<style>${publisher.sharedCss ?? ''}\n${result.sharedCss ?? ''}\n${output.css}</style>
        <style>
          #control{padding:2px;border:0 solid;color:black;opacity:1;font-weight:400}
          @supports (display:grid){#control{opacity:.5}}
          @media screen and (height >= 500px) and (width < 600px){#control{padding:4px;border-width:2px;font-weight:600}}
          @media screen and (height >= 500px) and (width >= 600px){#control{padding:12px;color:blue;font-weight:700}}
        </style><main><button id="button">Recipe</button><button id="control">Control</button></main>`)
        await page.addScriptTag({ content: code + ';globalThis.App=Fixture;' })
        await page.evaluate(`{
        document.querySelector('main').className=App.scope;
        window.read = id => {
          const s=getComputedStyle(document.getElementById(id));
          return [s.paddingTop,s.borderTopWidth,s.color,s.opacity,s.fontWeight];
        };
        window.apply = input => {
          const el=document.getElementById('button');
          for(const attr of [...el.attributes]) if(attr.name!=='id') el.removeAttribute(attr.name);
          for(const [key,value] of Object.entries(App.button(input))) el.setAttribute(key,value);
          return read('button');
        };
        apply({conditions:{wide:{size:'lg'},compact:{size:null},grid:{loading:true}}});
        window.initialRules=document.styleSheets[0].cssRules.length;
      }`)

        expect(
          await page.evaluate(`App.button()['data-constructor']`),
        ).toMatchInlineSnapshot('"normal"')
        expect(
          await page.evaluate(
            `App.button({conditions:{wide:{}}})['data-zyzz-condition-0-constructor']`,
          ),
        ).toMatchInlineSnapshot('undefined')

        for (const viewport of [
          { width: 400, height: 800 },
          { width: 800, height: 800 },
          { width: 800, height: 400 },
          { width: 400, height: 400 },
          { width: 800, height: 800 },
        ]) {
          await page.setViewportSize(viewport)
          expect(
            await page.evaluate(
              `JSON.stringify(read('button'))===JSON.stringify(read('control'))`,
            ),
          ).toMatchInlineSnapshot('true')
        }
        expect(await page.evaluate(`read('button')`)).toMatchInlineSnapshot(`
        [
          "12px",
          "0px",
          "rgb(0, 0, 255)",
          "0.5",
          "700",
        ]
      `)
        await page.emulateMedia({ media: 'print' })
        expect(
          await page.evaluate(
            `JSON.stringify(read('button'))===JSON.stringify(read('control'))`,
          ),
        ).toMatchInlineSnapshot('true')
        await page.emulateMedia({ media: 'screen' })
        await page.setViewportSize({ width: 800, height: 400 })
        expect(
          await page.evaluate(
            `apply({conditions:{wide:{size:'lg',loading:true},compact:{size:undefined,loading:false},grid:undefined}})`,
          ),
        ).toMatchInlineSnapshot(`
        [
          "12px",
          "0px",
          "rgb(0, 0, 0)",
          "1",
          "400",
        ]
      `)
        expect(
          await page.evaluate(
            `apply({size:null,loading:null,conditions:{wide:{size:'lg'},compact:{size:undefined},grid:{loading:undefined}}})`,
          ),
        ).toMatchInlineSnapshot(`
        [
          "12px",
          "0px",
          "rgb(0, 0, 0)",
          "1",
          "400",
        ]
      `)
        await page.setViewportSize({ width: 400, height: 800 })
        expect(await page.evaluate(`read('button')`)).toMatchInlineSnapshot(`
        [
          "2px",
          "0px",
          "rgb(0, 0, 0)",
          "1",
          "400",
        ]
      `)
        expect(
          await page.evaluate(
            `document.styleSheets[0].cssRules.length===initialRules`,
          ),
        ).toMatchInlineSnapshot('true')
      } finally {
        await browser.close()
      }
    })

    test('rejects unsupported grouping rules at the authored condition', () => {
      expect(() =>
        Source.extract({
          moduleId: 'app.ts',
          source: `import {variants} from 'zyzz'; variants({conditions:{wide:'@container (width > 20px)'}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:58: Recipe conditions support only @media and @supports.]`,
      )
    })

    test('bounds condition expansion before generating region styles', () => {
      const conditions = Array.from(
        { length: 9 },
        (_, index) => `c${index}:'@media (width >= ${index}px)'`,
      ).join(',')
      expect(() =>
        Source.extract({
          moduleId: 'app.ts',
          source: `import {variants} from 'zyzz'; variants({conditions:{${conditions}}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:272: Recipes support at most eight named conditions (256 CSS regions).]`,
      )
    })
  })
})

describe('packed', () => {
  describe('variants', () => {
    test.each(['react', 'html'] as const)(
      'packs every alternative and composes imported %s callables',
      async (output) => {
        const root = await Fs.mkdtemp(Path.resolve('.fixture-packed-variants-'))
        const browser = await chromium.launch()
        let server: Vite.PreviewServer | undefined
        try {
          const library = await Library.create(root, { output })
          // Model independent dependency runtime copies, as dev optimization can produce.
          await Fs.cp(
            Path.join(root, 'node_modules/zyzz'),
            Path.join(library.installed, 'node_modules/zyzz'),
            { recursive: true },
          )
          await Fs.writeFile(
            Path.join(root, 'package.json'),
            '{"type":"module","private":true}',
          )
          await Fs.writeFile(
            Path.join(root, 'index.html'),
            `<style>
#native{padding:2px;opacity:.5}
#native[data-choice=sm]{padding:4px}
#native[data-choice=lg]{padding:12px}
#native[data-choice=custom]{padding:var(--padding)}
#native[data-active=true]{opacity:1}
#native[data-active=true]:is([data-choice=lg],[data-choice=custom]){border:3px solid}
@media(min-width:600px){#native[data-wide=true]{padding:12px}#native[data-wide=true][data-active=true]{border:3px solid}}
#native[data-override=true]{padding-left:3px}
</style><main><button id="actual">Variant</button><button id="native">Native</button></main><script type="module" src="/app.ts"></script>`,
          )
          await Fs.writeFile(
            Path.join(root, 'app.ts'),
            `import {cx} from 'zyzz';
import {controls as imported,vars} from '@acme/variants';
const controls=imported;
const {button:buttonVariant}=controls;
import '@acme/variants/style.css';
const element=document.querySelector('button')!;
document.querySelector('main')!.className=vars().className;
export function apply(size?:'sm'|'lg'|null|{custom:{padding:\`\${number}px\`}},active=false,wide=false,override=true) {
  const props=cx(buttonVariant({size,active,conditions:{wide:{size:wide?'lg':undefined}}}),override && controls.override());
  for(const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
  element.id='actual';
  for(const [name,value] of Object.entries(props)) {
    if(name==='style' && typeof value==='object') for(const [property,scalar] of Object.entries(value)) element.style.setProperty(property.startsWith('--')?property:property.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase()),String(scalar));
    else element.setAttribute(name==='className'?'class':name,String(value));
  }
  const native=document.querySelector('#native')! as HTMLElement;
  native.dataset.choice=size===undefined?'sm':size===null?'':typeof size==='object'?'custom':size;
  native.dataset.active=String(active);native.dataset.wide=String(wide);native.dataset.override=String(override);
  if(size && typeof size==='object') native.style.setProperty('--padding',size.custom.padding);else native.style.removeProperty('--padding');
  return props;
}
export function reset(){return cx(buttonVariant({size:{custom:{padding:'9px'}},active:true}),buttonVariant({size:null,active:null}))}
Object.assign(window,{apply,reset}); apply();`,
          )
          const types = Path.join(root, 'types.ts')
          await Fs.writeFile(
            types,
            `import {controls,variant} from '@acme/variants';
controls.button({size:{custom:{padding:'9px'}},conditions:{wide:{size:'lg'}}});
variant({base:{color:'brand'}});
// @ts-expect-error Dynamic choices require complete scoped payloads.
controls.button({size:'custom'});
// @ts-expect-error Unknown finite choice.
controls.button({size:'missing'});
// @ts-expect-error Unknown bound token.
variant({base:{color:'missing'}});`,
          )
          const checked = await Util.promisify(ChildProcess.execFile)(
            process.execPath,
            [
              Path.resolve('node_modules/typescript/bin/tsc'),
              '--ignoreConfig',
              '--module',
              'nodenext',
              '--target',
              'esnext',
              '--strict',
              '--skipLibCheck',
              '--noEmit',
              types,
            ],
          ).catch((error) => {
            throw new Error(error.stdout || error.message)
          })
          expect(checked.stdout).toMatchInlineSnapshot('""')
          await Fs.rm(types)
          const config: Vite.InlineConfig = {
            configFile: false,
            logLevel: 'silent',
            plugins: [zyzz()],
            root,
          }
          await Vite.build(config)
          server = await Vite.preview({
            ...config,
            preview: { host: '127.0.0.1', port: 0 },
          })
          const page = await browser.newPage({
            viewport: { width: 450, height: 700 },
          })
          await page.goto(server.resolvedUrls!.local[0]!)
          await page.waitForFunction("typeof window.apply === 'function'")
          expect(
            await page.evaluate(`{
        const results=[];const element=document.querySelector('button');
        for(const [size,active,wide,override] of [[undefined,false,false,true],['lg',true,false,true],[{custom:{padding:'20px'}},true,false,true],[null,false,false,false],['sm',false,false,false]]) {
          window.apply(size,active,wide,override);const style=getComputedStyle(element);
          const control=getComputedStyle(document.querySelector('#native'));
          if(['paddingLeft','paddingRight','opacity','borderTopWidth'].some(key=>style[key]!==control[key])) throw new Error('Packed composition differs from native CSS: '+JSON.stringify({size,left:style.paddingLeft,right:style.paddingRight}));
          results.push([style.paddingLeft,style.paddingRight,style.opacity,style.borderTopWidth,element.hasAttribute('style')]);
        } results;
      }`),
          ).toMatchInlineSnapshot(`
          [
            [
              "3px",
              "4px",
              "0.5",
              "2px",
              false,
            ],
            [
              "3px",
              "12px",
              "1",
              "3px",
              false,
            ],
            [
              "3px",
              "20px",
              "1",
              "3px",
              true,
            ],
            [
              "2px",
              "2px",
              "0.5",
              "2px",
              false,
            ],
            [
              "4px",
              "4px",
              "0.5",
              "2px",
              false,
            ],
          ]
        `)
          await page.evaluate("window.apply('sm',true,true,true)")
          await page.setViewportSize({ width: 900, height: 700 })
          expect(
            await page
              .locator('#actual')
              .evaluate((element) => getComputedStyle(element).paddingRight),
          ).toMatchInlineSnapshot('"12px"')
          await page.locator('main').evaluate((element) => {
            ;(element as HTMLElement).style.colorScheme = 'dark'
          })
          expect(
            await page
              .locator('#actual')
              .evaluate((element) => getComputedStyle(element).color),
          ).toMatchInlineSnapshot('"rgb(153, 204, 255)"')
          expect(
            await page.evaluate("window.reset()['data-size']"),
          ).toMatchInlineSnapshot('undefined')
          expect(
            await page.evaluate("window.reset()['data-active']"),
          ).toMatchInlineSnapshot('undefined')
          expect(
            await page.evaluate('window.reset().style'),
          ).toMatchInlineSnapshot('undefined')
          const javascript = await Fs.readFile(
            Path.join(library.installed, 'styles.js'),
            'utf8',
          )
          const javascriptMap = new Trace.TraceMap(
            JSON.parse(
              await Fs.readFile(
                Path.join(library.installed, 'styles.js.map'),
                'utf8',
              ),
            ),
          )
          const prefix = javascript.slice(0, javascript.indexOf('button ='))
          const authored = Trace.originalPositionFor(javascriptMap, {
            line: prefix.split('\n').length,
            column: prefix.length - prefix.lastIndexOf('\n') - 1,
          })
          expect(authored.source?.endsWith('styles.ts')).toMatchInlineSnapshot(
            'true',
          )
          expect(authored.line).toMatchInlineSnapshot('3')
          const map = new Trace.TraceMap(
            library.compiled.modules['@acme/variants/styles.ts']!.cssMap!,
          )
          const css = library.compiled.modules['@acme/variants/styles.ts']!.css
          const before = css.slice(0, css.indexOf('padding'))
          const original = Trace.originalPositionFor(map, {
            line: before.split('\n').length,
            column: before.length - (before.lastIndexOf('\n') + 1),
          })
          expect(original.source).toMatchInlineSnapshot(
            '"@acme/variants/styles.ts"',
          )
          expect(original.line !== null).toMatchInlineSnapshot('true')
          const version = JSON.parse(
            await Fs.readFile(
              Path.join(library.installed, 'styles.js.zyzz.json'),
              'utf8',
            ),
          ).version
          if (output === 'react') expect(version).toMatchInlineSnapshot(`31`)
          else expect(version).toMatchInlineSnapshot(`31`)
        } finally {
          await browser.close()
          if (server)
            await new Promise<void>((resolve, reject) =>
              server!.httpServer.close((error) =>
                error ? reject(error) : resolve(),
              ),
            )
          await Fs.rm(root, { recursive: true, force: true })
        }
      },
      120000,
    )

    test('traces each imported declaration to its own application', () => {
      const publisher = Graph.compile({ modules: Library.sources() })
      const compiled = Graph.compile({
        contracts: publisher.contracts,
        imports: {
          'app.ts': { '@acme/variants': '@acme/variants/index.ts', zyzz: null },
        },
        modules: {
          'app.ts': `import {cx} from 'zyzz';
import {controls} from '@acme/variants';
export const first=()=>cx(controls.button(),controls.override());
export const second=()=>cx(controls.override(),controls.button({size:'lg'}));`,
        },
      }).modules['app.ts']!
      const map = new Trace.TraceMap(compiled.cssMap)
      const lines = Object.values(compiled.classes).map((className) => {
        const start = compiled.css.indexOf(
          'padding:',
          compiled.css.indexOf('.' + className.split(' ')[0]),
        )
        const prefix = compiled.css.slice(0, start)
        return Trace.originalPositionFor(map, {
          line: prefix.split('\n').length,
          column: prefix.length - prefix.lastIndexOf('\n') - 1,
        }).line
      })
      expect(lines).toMatchInlineSnapshot(`
      [
        3,
        4,
      ]
    `)
    })

    test('rejects malformed packed ownership and mixed renderer composition', () => {
      const publisher = Graph.compile({
        modules: Library.sources({ output: 'html' }),
      })
      const contracts = { ...publisher.contracts }
      const data = JSON.parse(contracts['@acme/variants/index.ts']!)
      data.exports.controls.members.button.style.slots = ['onclick']
      contracts['@acme/variants/index.ts'] = JSON.stringify(data)
      expect(() =>
        Graph.compile({
          modules: { 'app.ts': "import {controls} from '@acme/variants'" },
          contracts,
          imports: {
            'app.ts': { '@acme/variants': '@acme/variants/index.ts' },
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: @acme/variants/index.ts:0: Invalid library contract: Invalid packed style ownership.]`,
      )
      expect(() =>
        Graph.compile({
          modules: {
            'app.ts':
              "import {cx,style} from 'zyzz'; import {controls} from '@acme/variants'; const local=style({color:'red'}); export const props=cx(controls.button(),local());",
          },
          contracts: publisher.contracts,
          imports: {
            'app.ts': {
              '@acme/variants': '@acme/variants/index.ts',
              zyzz: null,
            },
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:125: Composition cannot mix HTML and React props.]`,
      )
    })
  })
})

describe('payloads', () => {
  describe('variants', () => {
    test('reads payload getters once and accepts static template defaults', async () => {
      const source =
        "import { variants } from 'zyzz'; export const button = variants({ variants: { size: { custom: (values: { padding: `${number}px` }) => ({ padding: values.padding }) } }, defaultVariants: { size: { custom: { padding: `${12}px` } } } });"
      const output = Graph.compile({ modules: { 'getter.ts': source } })
        .modules['getter.ts']!
      const bundled = await Esbuild.build({
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'cjs',
        write: false,
      })
      const module = {
        exports: {} as { button: (input?: object) => { style: object } },
      }
      new Function('module', 'exports', bundled.outputFiles![0]!.text)(
        module,
        module.exports,
      )
      let reads = 0
      const props = module.exports.button({
        size: {
          custom: {
            get padding() {
              reads++
              return '18px'
            },
          },
        },
      })
      expect(reads).toMatchInlineSnapshot('1')
      expect(Object.values(props.style)).toMatchInlineSnapshot(`
      [
        "18px",
      ]
    `)
      expect(Object.values(module.exports.button().style))
        .toMatchInlineSnapshot(`
      [
        "12px",
      ]
    `)
    })

    test('rejects magic condition and dynamic choice names', () => {
      expect(() =>
        Source.extract({
          moduleId: 'reserved.ts',
          source:
            "import {variants} from 'zyzz'; variants({conditions:{__proto__:'@media screen'}})",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: reserved.ts:53: Static object prototypes are unsupported.]`,
      )
      expect(() =>
        Source.extract({
          moduleId: 'reserved.ts',
          source:
            "import {variants} from 'zyzz'; variants({variants:{size:{__proto__:(values:{padding:string})=>({padding:values.padding})}}})",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: reserved.ts:57: Static object prototypes are unsupported.]`,
      )
    })

    test('rejects malformed callback authoring and incomplete defaults', () => {
      for (const body of [
        'variants:{size:{custom:(values)=>({padding:values.padding})}}',
        'variants:{size:{custom:(values:{padding?:string})=>({padding:values.padding})}}',
        "variants:{size:{custom:(values:{padding:string})=>({padding:values.padding})}},defaultVariants:{size:'custom'}",
        'variants:{size:{custom:(values:{padding:string})=>({padding:values.padding})}},defaultVariants:{size:{custom:{}}}',
        "variants:{size:{custom:(values:{padding:string})=>({padding:values.padding})}},defaultVariants:{size:{custom:{padding:'4px',extra:1}}}",
        'variants:{size:{custom:(values:{padding:string})=>({padding:values.missing})}}',
        'variants:{size:{custom:(values:{count:number})=>({zIndex:values.count})}}',
      ])
        expect(() =>
          Source.extract({
            moduleId: 'bad.ts',
            source: `import {variants} from 'zyzz';variants({${body}})`,
          }),
        ).toThrow()
    })

    test('retains bound shorthands and same-named payload fields through packed contracts', async () => {
      const config =
        "import {Config} from 'zyzz';export const {variants}=Config.create({output:'html',vars:{color:{brand:'black'}},shorthands:{px:['paddingLeft','paddingRight']}});"
      const source = `import {variants as recipe} from './config.js';export const button=recipe({base:{borderColor:'brand'},variants:{size:{custom:(values:{value:\`\${number}px\`})=>({px:\`\${values.value} !custom\`,paddingLeft:'3px !custom'})},tone:{custom:(values:{value:'red'|'blue'})=>({color:\`\${values.value} !custom\`})},constructor:{normal:{}}},defaultVariants:{size:{custom:{value:'12px'}},tone:{custom:{value:'red'}}}});`
      const publisher = Graph.compile({ modules: { 'config.ts': config } })
      const packed = Graph.compile({
        modules: { 'app.ts': source },
        contracts: publisher.contracts,
        imports: { 'app.ts': { './config.js': 'config.ts' } },
      }).modules['app.ts']!
      const direct = Graph.compile({
        modules: { 'config.ts': config, 'app.ts': source },
      }).modules['app.ts']!
      expect(packed.css).toBe(direct.css)
      const bundled = await Esbuild.build({
        stdin: {
          contents: packed.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'iife',
        globalName: 'App',
        write: false,
      })
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${packed.css}</style><button>Button</button>`,
        )
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        expect(
          await page.evaluate(`{
        const props=App.button({size:{custom:{value:'18px'}},tone:{custom:{value:'blue'}}});
        const element=document.querySelector('button');
        for(const [name,value] of Object.entries(props)) element.setAttribute(name,value);
        const style=getComputedStyle(element);
        [style.paddingLeft,style.paddingRight,style.color,element.hasAttribute('data-constructor'),typeof props.style];
      }`),
        ).toEqual(['3px', '18px', 'rgb(0, 0, 255)', false, 'string'])
      } finally {
        await browser.close()
      }
    })

    test('binds independent base and conditional payloads and removes stale styles', async () => {
      const source = `import {variants} from 'zyzz';
      export const button=variants({
        base:{padding:'2px'},
        conditions:{wide:'@media (width >= 600px)'},
        variants:{size:{sm:{padding:'4px'},custom:(values:{padding:\`\${number}px\`})=>({padding:values.padding})}},
        defaultVariants:{size:{custom:{padding:'12px'}}},
        compoundVariants:[{when:{size:'custom'},style:{color:'red'}}]
      });`
      const output = Graph.compile({ modules: { 'app.ts': source } }).modules[
        'app.ts'
      ]!
      const bundled = await Esbuild.build({
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'iife',
        globalName: 'App',
        write: false,
      })
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        const page = await browser.newPage({
          viewport: { width: 500, height: 800 },
        })
        await page.setContent(
          `<style>${output.css}</style><button>Button</button>`,
        )
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        await page.evaluate(`window.apply=(input)=>{
        const element=document.querySelector('button');
        for(const name of element.getAttributeNames()) element.removeAttribute(name);
        const props=App.button(input);
        element.className=props.className;
        for(const [key,value] of Object.entries(props)) {
          if(key.startsWith('data-')) element.setAttribute(key,value);
          if(key==='style') for(const [name,bound] of Object.entries(value)) element.style.setProperty(name,String(bound));
        }
        const style=getComputedStyle(element);
        return {padding:style.padding,color:style.color,slots:Object.keys(props.style??{}).length};
      }`)
        expect(await page.evaluate('apply()')).toEqual({
          padding: '12px',
          color: 'rgb(255, 0, 0)',
          slots: 1,
        })
        expect(
          await page.evaluate(
            "apply({size:{custom:{padding:'16px'}},conditions:{wide:{size:{custom:{padding:'24px'}}}}})",
          ),
        ).toEqual({ padding: '16px', color: 'rgb(255, 0, 0)', slots: 2 })
        await page.setViewportSize({ width: 800, height: 800 })
        expect(
          await page.evaluate(
            "getComputedStyle(document.querySelector('button')).padding",
          ),
        ).toBe('24px')
        expect(await page.evaluate("apply({size:'sm'})")).toEqual({
          padding: '4px',
          color: 'rgb(0, 0, 0)',
          slots: 0,
        })
        expect(await page.evaluate('apply({size:null})')).toEqual({
          padding: '2px',
          color: 'rgb(0, 0, 0)',
          slots: 0,
        })
      } finally {
        await browser.close()
      }
    })
  })
})

describe('watch', () => {
  describe('variants', () => {
    test('preserves imported ownership across edits, failed builds, renames, and removal', async () => {
      const root = await Fs.mkdtemp(Path.resolve('.fixture-variants-watch-'))
      const outDir = Path.join(root, 'output')
      const source = `import {style,variants} from 'zyzz';
export const button=variants({base:{padding:'2px'},variants:{size:{sm:{padding:'4px'},lg:{padding:'12px'}}},defaultVariants:{size:'sm'}});
export const override=style({paddingLeft:'3px'});`
      const app = (
        file: string,
      ) => `import {cx} from 'zyzz';import {button,override} from './${file}.js';
export function apply(){return cx(button({size:'lg'}),override())}`
      const browser = await chromium.launch()
      const host = await Host.create({
        outDir,
        packageId: 'watch-variants',
        root,
      })
      const notifications = Watch.create({
        path: 'styles.ts.css',
        timeoutMs: 10000,
      })

      try {
        await Fs.writeFile(Path.join(root, 'styles.ts'), source)
        await Fs.writeFile(Path.join(root, 'app.ts'), app('styles'))
        await host.build()
        const initial = JSON.parse(
          await Fs.readFile(Path.join(outDir, 'styles.ts.zyzz.json'), 'utf8'),
        )
        const page = await browser.newPage()

        async function render(file = 'styles') {
          const bundled = await Esbuild.build({
            entryPoints: [Path.join(outDir, 'app.ts')],
            bundle: true,
            write: false,
            format: 'iife',
            globalName: 'App',
            alias: { 'zyzz/runtime': Path.resolve('dist/runtime/index.js') },
          })
          const css =
            (await Fs.readFile(Path.join(outDir, `${file}.ts.css`), 'utf8')) +
            (await Fs.readFile(Path.join(outDir, 'app.ts.css'), 'utf8'))
          await page.setContent(
            `<style>${css}</style><button id="actual"></button><button id="native" style="padding:12px;padding-left:3px"></button>`,
          )
          await page.addScriptTag({ content: bundled.outputFiles[0]!.text })
          await page.evaluate(
            `{const props=App.apply(); const element=document.querySelector('#actual'); for(const [name,value] of Object.entries(props))element.setAttribute(name==='className'?'class':name,value);}`,
          )
          return page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).paddingLeft)
        }

        expect(await render()).toMatchInlineSnapshot('"3px"')
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).paddingRight),
        ).toMatchInlineSnapshot('"12px"')
        expect(
          await page
            .locator('#native')
            .evaluate((element) => getComputedStyle(element).paddingRight),
        ).toMatchInlineSnapshot('"12px"')
        let recovering = false
        host.watch({
          onResult(event) {
            // Atomic filesystem edits may enqueue another notification for the failed source.
            if (recovering && 'error' in event) return
            notifications.onResult(event)
          },
        })
        const edit = {
          path: Path.join(root, 'styles.ts'),
          source: source.replace("'3px'", "'7px'"),
        }
        await notifications.next(async () => {
          // A build may complete while another atomic edit still owns its temporary file.
          await Promise.all([Watch.write(edit), Watch.write(edit)])
        })
        expect(await render()).toMatchInlineSnapshot('"7px"')
        const changed = JSON.parse(
          await Fs.readFile(Path.join(outDir, 'styles.ts.zyzz.json'), 'utf8'),
        )
        expect(
          changed.exports.button.binding === initial.exports.button.binding,
        ).toMatchInlineSnapshot('true')
        const published = await Fs.readFile(Path.join(outDir, 'app.ts'), 'utf8')

        await expect(
          notifications.next(() =>
            Watch.write({
              path: Path.join(root, 'styles.ts'),
              source: source.replace("'12px'", 'unknown'),
            }),
          ),
        ).rejects.toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: watch-variants/styles.ts:135: Expected a literal string or number; expressions are not evaluated.]`,
        )
        expect(
          (await Fs.readFile(Path.join(outDir, 'app.ts'), 'utf8')) ===
            published,
        ).toMatchInlineSnapshot('true')
        recovering = true
        await notifications.next(() =>
          Watch.write({ path: Path.join(root, 'styles.ts'), source }),
        )
        expect(await render()).toMatchInlineSnapshot('"3px"')
        await host.close()

        await Fs.rename(
          Path.join(root, 'styles.ts'),
          Path.join(root, 'renamed.ts'),
        )
        await Fs.writeFile(Path.join(root, 'app.ts'), app('renamed'))
        const reopened = await Host.create({
          outDir,
          packageId: 'watch-variants',
          root,
        })
        try {
          await reopened.build()
          expect(await render('renamed')).toMatchInlineSnapshot('"3px"')
          expect(
            (await Fs.readdir(outDir)).some((file) =>
              file.startsWith('styles.ts'),
            ),
          ).toMatchInlineSnapshot('false')
          await Fs.rm(Path.join(root, 'app.ts'))
          await Fs.rm(Path.join(root, 'renamed.ts'))
          expect((await reopened.build()).files).toMatchInlineSnapshot('[]')
        } finally {
          await reopened.close()
        }
      } finally {
        await host.close()
        await browser.close()
        await Fs.rm(root, { recursive: true, force: true })
      }
    }, 60000)
  })
})
