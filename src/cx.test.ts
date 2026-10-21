/** Verifies static composition order against native CSS controls in Chromium. @module */
import * as Corpus from '../bench/Corpus.js'
import * as Fixture from '../test/fixtures/composition.js'
import * as Packed from '../test/fixtures/Packed.js'
import * as Scopes from '../test/fixtures/scopes.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Url from 'node:url'
import * as Util from 'node:util'
import * as Vm from 'node:vm'
import { parseSync } from 'oxc-parser'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Graph, Source, Transform } from 'zyzz/compiler'

describe('cx', () => {
  test.each(['react', 'html'] as const)(
    'composes variable scopes with %s styles',
    async (output) => {
      const graph = Graph.compile({
        modules: {
          'config.ts': `import {Config} from 'zyzz'; export const config = Config.create({output: '${output}', mappings: false, vars: {color: {brand: '#123456'}}}); export const {vars, style} = config;`,
          'app.ts': `import {cx, Config} from 'zyzz'; import {config, vars, style} from './config.js';
          const root = style({color: 'color.brand'});
          const local = Config.create({output: '${output}', vars: {color: {brand: '#abcdef'}}});
          const {vars: localVars} = local;
          export const scope = vars();
          const applied = vars(); const alias = applied; export const aliased = cx(alias, root());
          let reads = 0; function scheme() { reads++; return 'dark'; }
          export const evaluated = cx(vars({colorScheme: scheme()}), root()); export const count = reads;
          export const direct = cx(vars({colorScheme: 'dark'}), root());
          export const member = cx(config.vars(), root());
          export const localScope = cx(localVars(), root());
          export const only = cx(vars());
          export const nested = cx(cx(vars(), root()), root());
          export const conditional = (enabled: boolean) => cx(enabled && vars({colorScheme: 'dark'}), enabled && root());
          export const invalid = () => cx(vars({set: 'missing'}), root());`,
        },
        imports: {
          'app.ts': { zyzz: null, './config.js': 'config.ts' },
          'config.ts': { zyzz: null },
        },
      })
      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: Object.fromEntries(
          Object.entries(graph.modules).map(([name, module]) => [
            name,
            module.code,
          ]),
        ),
      })
      const fixture = Vm.runInNewContext(`${code};Fixture;`)
      const key = output === 'html' ? 'class' : 'className'
      for (const props of [
        fixture.direct,
        fixture.member,
        fixture.aliased,
        fixture.evaluated,
        fixture.only,
        fixture.nested,
        fixture.conditional(true),
      ])
        expect(
          props[key].split(' ').includes(fixture.scope[key]),
        ).toMatchInlineSnapshot(`true`)
      expect(
        fixture.conditional(false)[key].includes(fixture.scope[key]),
      ).toMatchInlineSnapshot(`false`)
      if (output === 'html')
        expect(fixture.direct.style).toMatchInlineSnapshot(
          `"color-scheme:dark"`,
        )
      else
        expect(fixture.direct.style).toMatchInlineSnapshot(`
          {
            "colorScheme": "dark",
          }
        `)
      expect(fixture.count).toMatchInlineSnapshot(`1`)
      expect(() => fixture.invalid()).toThrowErrorMatchingInlineSnapshot(
        `[TypeError: Invalid variable selection.]`,
      )
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const css =
          (graph.sharedCss ?? '') +
          Object.values(graph.modules)
            .map((module) => module.css)
            .join('')
        await page.setContent(
          `<style>${css}</style><div id="root" class="${fixture.direct[key]}"></div>`,
        )
        expect(
          await page
            .locator('#root')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot(`"rgb(18, 52, 86)"`)
      } finally {
        await browser.close()
      }
    },
  )

  test.each(['react', 'html'] as const)(
    'consumes packed variable scopes with %s output',
    async (output) => {
      const library = Graph.compile({
        modules: {
          'index.ts': `import {Config} from 'zyzz'; export const config=Config.create({output:'${output}',vars:{color:{brand:'#123456'}}}); export const {vars:scope,style}=config; export const root=style({color:'brand'});`,
        },
      })
      const consumer = Graph.compile({
        contracts: { '@acme/scopes/index.js': library.contracts['index.ts']! },
        imports: {
          'app.ts': { '@acme/scopes': '@acme/scopes/index.js', zyzz: null },
        },
        modules: {
          'app.ts': `import {cx} from 'zyzz'; import {scope as vars,root} from '@acme/scopes'; const selected=vars({colorScheme:'dark'}); const alias=selected; export const props=cx(alias,root()); export const scope=vars(); export const only=cx(vars());`,
        },
      })
      const code = await Packed.bundle({
        entry: 'app.ts',
        modules: { 'app.ts': consumer.modules['app.ts']!.code },
        packages: {
          '@acme/scopes': { 'index.js': library.modules['index.ts']!.code },
        },
      })
      const fixture = Vm.runInNewContext(`${code};Fixture;`)
      const key = output === 'html' ? 'class' : 'className'
      expect(
        fixture.props[key].split(' ').includes(fixture.scope[key]),
      ).toMatchInlineSnapshot(`true`)
      expect(fixture.only[key]).toMatchInlineSnapshot(`"z-theme-theme"`)
      expect(Object.keys(fixture.props).includes(key)).toMatchInlineSnapshot(
        `true`,
      )
      if (output === 'html')
        expect(fixture.props.style).toMatchInlineSnapshot(`"color-scheme:dark"`)
      else
        expect(fixture.props.style).toMatchInlineSnapshot(
          `
          {
            "colorScheme": "dark",
          }
        `,
        )
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const css = [library, consumer]
          .map(
            (graph) =>
              (graph.sharedCss ?? '') +
              Object.values(graph.modules)
                .map((module) => module.css)
                .join(''),
          )
          .join('')
        await page.setContent(
          `<style>${css}</style><div id="root" class="${fixture.props[key]}"></div>`,
        )
        expect(
          await page
            .locator('#root')
            .evaluate((node) => getComputedStyle(node).color),
        ).toMatchInlineSnapshot(`"rgb(18, 52, 86)"`)
      } finally {
        await browser.close()
      }
    },
  )

  test.each(['react', 'html'] as const)(
    'matches manual scope props in %s',
    async (output) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        for (const composition of ['manual', 'cx'] as const) {
          const compiled = Transform.compile({
            moduleId: 'scope.ts',
            source: Scopes.create(output, composition),
          })
          const code = await Packed.bundle({
            entry: 'scope.ts',
            modules: { 'scope.ts': compiled.code },
          })
          const fixture = Vm.runInNewContext(`${code};Fixture;`)
          const props = fixture.apply('dark')
          await page.setContent(
            `<style>${compiled.css}</style><div id="root" class="${props.className ?? props.class}" style="color-scheme:dark"></div>`,
          )
          expect(
            await page
              .locator('#root')
              .evaluate((node) => getComputedStyle(node).color),
          ).toMatchInlineSnapshot(`"rgb(18, 52, 86)"`)
          if (output === 'html')
            expect(props.style).toMatchInlineSnapshot(`"color-scheme:dark"`)
          else
            expect(props.style).toMatchInlineSnapshot(`
              {
                "colorScheme": "dark",
              }
            `)
        }
      } finally {
        await browser.close()
      }
    },
  )

  test('rejects mixed variable scope and style outputs', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'mixed.ts',
        source: `import {Config, cx, style} from 'zyzz'; const {vars} = Config.create({output: 'html', vars: {color: {brand: 'red'}}}); const root = style({color: 'red'}); cx(vars(), root());`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: mixed.ts:155: Composition cannot mix HTML and React props.]`,
    )
  })

  test('uses lexical references and expands each selected mapping', () => {
    const source = `import { Config, cx, style } from 'zyzz';
      const { style: bound } = Config.create({ shorthands: { px: ['paddingLeft', 'paddingRight'] } });
      const color = style({ color: 'red' });
      const mapped = bound({ px: '8px' });
      function unrelated(color: string) { return color }
      type Input = Parameters<typeof color>[0];
      export const props = cx(color(), mapped());`
    const output = Transform.compile({ moduleId: 'mapped.ts', source })
    expect(
      output.css.includes('padding-left:8px;padding-right:8px'),
    ).toMatchInlineSnapshot(`true`)
    const prefix = output.css
      .slice(0, output.css.lastIndexOf('padding-right:8px'))
      .split('\n')
    const position = Trace.originalPositionFor(
      new Trace.TraceMap(output.cssMap),
      { line: prefix.length, column: prefix.at(-1)!.length },
    )
    expect(position.source).toMatchInlineSnapshot('"mapped.ts"')
    expect(position.line).toMatchInlineSnapshot('4')
  })

  test('composes definitions read by selector interpolations and composition entries', async () => {
    const compiled = Transform.compile({
      moduleId: 'references.ts',
      source: `import { cx, style } from 'zyzz'
const panel = style({ color: 'rgb(255, 0, 0)' })
const label = style({ selectors: { [\`\${panel}[data-open] &\`]: { color: 'rgb(0, 0, 255)' } } })
export function direct() { return { label: cx(label()), panel: cx(panel()) } }
export function namespaced() { return { badge: cx(styles.badge()), cell: cx(styles.cell()), row: cx(styles.row()) } }
namespace styles {
  export const row = style({ color: 'rgb(255, 0, 0)' })
  export const cell = style({ selectors: { [\`\${styles.row}[data-open] &\`]: { color: 'rgb(0, 0, 255)' } } })
  export const badge = style([styles.cell, { fontWeight: 700 }])
}`,
    })
    const code = await Packed.bundle({
      entry: 'references.ts',
      modules: { 'references.ts': compiled.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const direct = fixture.direct()
    const namespaced = fixture.namespaced()
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${compiled.css}</style><div class="${direct.panel.className}" data-open><span id="label" class="${direct.label.className}"></span></div><div class="${namespaced.row.className}" data-open><span id="cell" class="${namespaced.cell.className}"></span><span id="badge" class="${namespaced.badge.className}"></span></div>`,
      )

      expect(
        await page
          .locator('#label')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
      expect(
        await page
          .locator('#cell')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
      expect(
        await page
          .locator('#badge')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
      expect(
        await page
          .locator('#badge')
          .evaluate((node) => getComputedStyle(node).fontWeight),
      ).toMatchInlineSnapshot(`"700"`)
    } finally {
      await browser.close()
    }
  })

  test('composes namespace definitions that read non-exported members', async () => {
    const compiled = Transform.compile({
      moduleId: 'private.ts',
      source: `import { cx, style } from 'zyzz'
export const tile = (d: number) => cx(styles.wish(), d >= 30 && styles.wishOn())
namespace styles {
  const ring = style({ ':focus-visible': { outline: '2px solid rgb(255, 0, 0)' } })
  export const wish = style([{ color: 'rgb(255, 255, 255)' }, ring])
  export const wishOn = style({ background: 'rgb(220, 38, 38)' })
}`,
    })
    const code = await Packed.bundle({
      entry: 'private.ts',
      modules: { 'private.ts': compiled.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${compiled.css}</style><button id="off" class="${fixture.tile(0).className}"></button><button id="on" class="${fixture.tile(30).className}"></button>`,
      )
      await page.keyboard.press('Tab')

      expect(
        await page
          .locator('#off')
          .evaluate((node) => getComputedStyle(node).color),
      ).toMatchInlineSnapshot(`"rgb(255, 255, 255)"`)
      expect(
        await page
          .locator('#off')
          .evaluate((node) => getComputedStyle(node).outline),
      ).toMatchInlineSnapshot(`"rgb(255, 0, 0) solid 2px"`)
      expect(
        await page
          .locator('#off')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toMatchInlineSnapshot(`"rgb(239, 239, 239)"`)
      expect(
        await page
          .locator('#on')
          .evaluate((node) => getComputedStyle(node).backgroundColor),
      ).toMatchInlineSnapshot(`"rgb(220, 38, 38)"`)
    } finally {
      await browser.close()
    }
  })

  test('emits only reachable nested composition groups', () => {
    const output = Source.extract({
      moduleId: 'nested.ts',
      source: `import {cx,style} from 'zyzz'; const a=style({color:'red'}); export const props=cx(cx(a()),a());`,
    })
    expect(
      output.calls.filter((call) => call.composition).length,
    ).toMatchInlineSnapshot('1')
  })
  test('rejects extra style invocation', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'invalid.ts',
        source: `import {cx,style} from 'zyzz'; const a=style({}); cx(a()());`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:53: Composition requires statically known local style applications.]`,
    )
  })
  test('rejects extra inline invocation', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'invalid.ts',
        source: `import {cx,style} from 'zyzz'; cx(style({})()());`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:34: Composition requires statically known local style applications.]`,
    )
  })
  test('rejects extra nested invocation', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'invalid.ts',
        source: `import {cx,style} from 'zyzz'; const a=style({}); cx(cx(a())());`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:53: Composition requires statically known local style applications.]`,
    )
  })
  test('rejects namespace composition', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'invalid.ts',
        source: `import * as Z from 'zyzz'; import {style} from 'zyzz'; Z.cx(style({})());`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: invalid.ts:55: Import cx by name; namespace authoring calls are not supported yet.]`,
    )
  })

  test('compiles repeated groups, partial shorthands, fallbacks, importance, and matching conditions', async () => {
    const source = `import {cx,style} from 'zyzz';
      namespace styles {
        export const a=style({padding:'8px',color:'red',display:['block','grid'],'@media (width >= 600px)':{color:'green'},opacity:'0.5 !important'});
        export const b=style({paddingLeft:'12px',color:'blue','@media (width >= 600px)':{color:'purple'},opacity:1});
      }
      export const ab=cx(styles.a(),false,null,undefined,styles.b());
      export const aba=cx(styles.a(),styles.b(),styles.a());
      export const inline=cx(style({color:'red'})(),style({color:'blue'})());`
    const output = Transform.compile({ moduleId: 'app.ts', source })
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
      const page = await browser.newPage({
        viewport: { width: 500, height: 800 },
      })
      await page.setContent(`<style>${output.css}
        .a{padding:8px;color:red;display:block;display:grid;opacity:.5!important}
        .b{padding-left:12px;color:blue;opacity:1}
        .again{padding:8px;color:red;display:block;display:grid;opacity:.5!important}
        @media(width >= 600px){.a{color:green}.b{color:purple}.again{color:green}}
        </style><div id="ab"></div><div id="aba"></div><div id="inline"></div><div id="control-ab" class="a b"></div><div id="control-aba" class="a b again"></div>`)
      await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
      await page.evaluate(`for(const name of ['ab','aba','inline']) document.getElementById(name).className=App[name].className;
        window.read=(name,key)=>getComputedStyle(document.getElementById(name))[key]`)
      await page.setViewportSize({ width: 500, height: 800 })
      expect(await page.evaluate(`read('ab','padding')`)).toMatchInlineSnapshot(
        '"8px 8px 8px 12px"',
      )
      expect(
        await page.evaluate(`read('control-ab','padding')`),
      ).toMatchInlineSnapshot('"8px 8px 8px 12px"')
      expect(await page.evaluate(`read('ab','color')`)).toMatchInlineSnapshot(
        '"rgb(0, 0, 255)"',
      )
      expect(
        await page.evaluate(`read('control-ab','color')`),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
      expect(await page.evaluate(`read('ab','display')`)).toMatchInlineSnapshot(
        '"grid"',
      )
      expect(
        await page.evaluate(`read('control-ab','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(await page.evaluate(`read('ab','opacity')`)).toMatchInlineSnapshot(
        '"0.5"',
      )
      expect(
        await page.evaluate(`read('control-ab','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(`read('aba','padding')`),
      ).toMatchInlineSnapshot('"8px"')
      expect(
        await page.evaluate(`read('control-aba','padding')`),
      ).toMatchInlineSnapshot('"8px"')
      expect(await page.evaluate(`read('aba','color')`)).toMatchInlineSnapshot(
        '"rgb(255, 0, 0)"',
      )
      expect(
        await page.evaluate(`read('control-aba','color')`),
      ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
      expect(
        await page.evaluate(`read('aba','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(
        await page.evaluate(`read('control-aba','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(
        await page.evaluate(`read('aba','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(`read('control-aba','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      await page.setViewportSize({ width: 800, height: 800 })
      expect(await page.evaluate(`read('ab','padding')`)).toMatchInlineSnapshot(
        '"8px 8px 8px 12px"',
      )
      expect(
        await page.evaluate(`read('control-ab','padding')`),
      ).toMatchInlineSnapshot('"8px 8px 8px 12px"')
      expect(await page.evaluate(`read('ab','color')`)).toMatchInlineSnapshot(
        '"rgb(128, 0, 128)"',
      )
      expect(
        await page.evaluate(`read('control-ab','color')`),
      ).toMatchInlineSnapshot('"rgb(128, 0, 128)"')
      expect(await page.evaluate(`read('ab','display')`)).toMatchInlineSnapshot(
        '"grid"',
      )
      expect(
        await page.evaluate(`read('control-ab','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(await page.evaluate(`read('ab','opacity')`)).toMatchInlineSnapshot(
        '"0.5"',
      )
      expect(
        await page.evaluate(`read('control-ab','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(`read('aba','padding')`),
      ).toMatchInlineSnapshot('"8px"')
      expect(
        await page.evaluate(`read('control-aba','padding')`),
      ).toMatchInlineSnapshot('"8px"')
      expect(await page.evaluate(`read('aba','color')`)).toMatchInlineSnapshot(
        '"rgb(0, 128, 0)"',
      )
      expect(
        await page.evaluate(`read('control-aba','color')`),
      ).toMatchInlineSnapshot('"rgb(0, 128, 0)"')
      expect(
        await page.evaluate(`read('aba','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(
        await page.evaluate(`read('control-aba','display')`),
      ).toMatchInlineSnapshot('"grid"')
      expect(
        await page.evaluate(`read('aba','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(`read('control-aba','opacity')`),
      ).toMatchInlineSnapshot('"0.5"')
      expect(
        await page.evaluate(
          "getComputedStyle(document.getElementById('inline')).color",
        ),
      ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
    } finally {
      await browser.close()
    }
  })

  test('preserves initialization failures after bundling and original declaration maps', async () => {
    const source = `import {cx as compose,style} from 'zyzz';export const props=compose(a());const a=style({color:'red'});`
    const output = Transform.compile({ moduleId: 'early.ts', source })
    const bundled = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: process.cwd() },
      alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
      bundle: true,
      format: 'esm',
      write: false,
    })
    await expect(
      import(
        `data:text/javascript;base64,${Buffer.from(bundled.outputFiles![0]!.text).toString('base64')}`
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[TypeError: a is not a function]`,
    )

    const mapped = Transform.compile({
      moduleId: 'mapped.ts',
      source: `import {cx,style} from 'zyzz';const a=style({color:'red'});const b=style({padding:'8px'});export const props=cx(a(),b());`,
    })
    const start = mapped.css.lastIndexOf('color:red')
    const prefix = mapped.css.slice(0, start).split('\n')
    const position = Trace.originalPositionFor(
      new Trace.TraceMap(mapped.cssMap),
      { line: prefix.length, column: prefix.at(-1)!.length },
    )
    expect(position.source).toMatchInlineSnapshot('"mapped.ts"')
    expect(position.line).toMatchInlineSnapshot('1')
    expect(position.column).toMatchInlineSnapshot(`45`)
  })

  test('rejects unresolved runtime selections before emitting misleading composition', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'app.ts',
        source: `import {cx,style} from 'zyzz';const a=style({color:'red'});export const compose=(enabled:boolean)=>cx(enabled ? a() : undefined);`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app.ts:102: Composition requires statically known local style applications.]`,
    )
  })
  test('returns extraction spans in source order', () => {
    const source = `import {cx,style} from 'zyzz';const a=style({color:'red'});const props=cx(a());const b=style({padding:'4px'});`
    const extracted = Source.extract({ moduleId: 'order.ts', source })
    expect(extracted.calls.map((call) => source.slice(call.start, call.end)))
      .toMatchInlineSnapshot(`
      [
        "style({color:'red'})",
        "cx(a())",
        "style({padding:'4px'})",
      ]
    `)
  })
})

describe('bindings', () => {
  describe('cx', () => {
    for (const output of ['react', 'html']) {
      test(`retains ${output} props aliases, conditional bindings, and initializer order`, async () => {
        const source = `import {Config,cx} from 'zyzz';const {style}=Config.create({output:'${output}'});
        namespace styles {export const value=style((values:{padding:\`\${number}px\`})=>({padding:values.padding}));export const fixed=style({paddingLeft:'3px'})}
        export let reads=0;
        function value(){reads++;return '12px' as const}
        export function apply(enabled:boolean){const props=styles.value({padding:value()});const alias=props;const optional=enabled && styles.fixed();return cx(alias,optional)};`
        const compiled = Transform.compile({ moduleId: 'bindings.ts', source })
        const bundled = await Esbuild.build({
          stdin: {
            contents: compiled.code,
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
          await page.setContent(`<style>${compiled.css}</style><div></div>`)
          await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
          await page.evaluate(`window.apply = (enabled) => {
          const props=App.apply(enabled);const element=document.querySelector('div');
          for(const name of element.getAttributeNames())element.removeAttribute(name);
          if('class' in props) for(const [name,value]of Object.entries(props))element.setAttribute(name,value);
          else {element.className=props.className;for(const [name,value]of Object.entries(props.style??{}))element.style.setProperty(name,String(value))}
        }`)
          await page.evaluate('apply(false)')
          expect(
            await page
              .locator('div')
              .evaluate((element) => getComputedStyle(element).padding),
          ).toMatchInlineSnapshot('"12px"')
          await page.evaluate('apply(true)')
          expect(
            await page
              .locator('div')
              .evaluate((element) => getComputedStyle(element).padding),
          ).toMatchInlineSnapshot('"12px 12px 12px 3px"')
          expect(await page.evaluate('App.reads')).toMatchInlineSnapshot('2')
        } finally {
          await browser.close()
        }
      })
    }

    test('rejects property mutation', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});const p=a();p.className='changed';export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:113: Applied props bindings must not escape before composition.]`,
      )
    })
    test('rejects function escape', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});const p=a();mutate(p);export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:101: Applied props bindings must not escape before composition.]`,
      )
    })
    test('rejects alias escape', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});const p=a();const alias=p;mutate(alias);export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:119: Applied props bindings must not escape before composition.]`,
      )
    })
    test('rejects inline export', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});export const p=a();export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:98: Applied props bindings must not escape before composition.]`,
      )
    })
    test('rejects exported alias', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});const original=a();export const p=original;export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:122: Applied props bindings must not escape before composition.]`,
      )
    })
    test('rejects direct eval', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'escape.ts',
          source: `import {cx,style}from'zyzz';const a=style({color:'red'});const p=style({color:'red'})();eval('delete p.className');export const props=cx(p);`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: escape.ts:137: Applied props bindings must not escape before composition.]`,
      )
    })
    test('preserves earlier compositions and conditional asserted aliases', async () => {
      const source = `import {cx,style} from 'zyzz'; const a=style({color:'red'});const b=style({padding:'4px'});
      export function apply(enabled:boolean){const p=a();const alias=<ReturnType<typeof a>>p;const optional=enabled && alias;const inner=cx(b());return cx(inner,optional)}`
      const output = Transform.compile({ moduleId: 'aliases.ts', source })
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
      const module = { exports: {} as { apply: (enabled: boolean) => object } }
      new Function('module', 'exports', bundled.outputFiles![0]!.text)(
        module,
        module.exports,
      )
      expect(module.exports.apply(false)).toMatchInlineSnapshot(`
        {
          "className": "z_bCW_kc2",
        }
      `)
      expect(module.exports.apply(true)).toMatchInlineSnapshot(`
        {
          "className": "z_bCW_kc2 z_bCW_kc0",
        }
      `)
    })

    test('preserves TDZ reads for omitted bindings', async () => {
      for (const sentinel of ['false', 'null', 'undefined']) {
        const compiled = Transform.compile({
          moduleId: 'tdz.ts',
          source: `import {cx} from 'zyzz';const result=render();const p=${sentinel};function render(){return cx(p)};export {result};`,
        })
        const directory = await Fs.mkdtemp(
          Path.join(process.cwd(), '.fixture-tdz-'),
        )
        try {
          const file = Path.join(directory, 'entry.ts')
          await Fs.writeFile(file, compiled.code)
          const { stdout } = await Util.promisify(ChildProcess.execFile)(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import(${JSON.stringify(Url.pathToFileURL(file).href)}).then(()=>console.log('ok')).catch(error=>console.log(error.name))`,
            ],
          )
          expect(stdout.trim()).toMatchInlineSnapshot(`"ReferenceError"`)
        } finally {
          await Fs.rm(directory, { recursive: true, force: true })
        }
      }
    })

    test('allows asserted JSX spreads and limits HTML metadata to composed applications', async () => {
      const compiled = Transform.compile({
        moduleId: 'spread.tsx',
        source: `import {cx,style} from 'zyzz';const a=style({color:'red'});const p=a();const view=<div {...(p as style.Props)} />;export const composed=cx(p);`,
      })
      expect(compiled.code.includes('__zyzzComposition')).toMatchInlineSnapshot(
        `true`,
      )
      const html = Transform.compile({
        moduleId: 'html.ts',
        source: `import {Config,cx} from 'zyzz';const {style}=Config.create({output:'html'});const a=style({color:'red'});const p=a();export const composed=cx(p);export const standalone=a();`,
      })
      const bundled = await Esbuild.build({
        stdin: { contents: html.code, loader: 'ts', resolveDir: process.cwd() },
        alias: { 'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts` },
        bundle: true,
        format: 'iife',
        globalName: 'App',
        write: false,
      })
      const result = new Function(
        `${bundled.outputFiles![0]!.text};return App;`,
      )()
      expect(Reflect.ownKeys(result.standalone)).toMatchInlineSnapshot(`
    [
      "class",
    ]
  `)
      expect(
        Object.getOwnPropertySymbols(result.composed).length,
      ).toMatchInlineSnapshot(`1`)
    })
    test('keeps omitted bindings separate from conditional styles', async () => {
      const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
      })
      try {
        for (const output of ['react', 'html']) {
          for (const sentinel of ['false', 'null', 'undefined']) {
            const compiled = Transform.compile({
              moduleId: 'omitted.ts',
              source: `import {Config,cx} from 'zyzz';const {style}=Config.create({output:'${output}'});const a=style({color:'red'});export function apply(enabled:boolean){const p=${sentinel};return cx(p,enabled && a())}`,
            })
            const bundled = await Esbuild.build({
              stdin: {
                contents: compiled.code,
                loader: 'ts',
                resolveDir: process.cwd(),
              },
              alias: {
                'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts`,
              },
              bundle: true,
              format: 'iife',
              globalName: 'App',
              write: false,
            })
            const page = await browser.newPage()
            await page.setContent(
              `<style>body{color:black}${compiled.css}</style><div></div>`,
            )
            await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
            await page.evaluate(
              `document.querySelector('div').className=App.apply(false).className ?? App.apply(false).class`,
            )
            expect(
              await page
                .locator('div')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
            await page.evaluate(
              `document.querySelector('div').className=App.apply(true).className ?? App.apply(true).class`,
            )
            expect(
              await page
                .locator('div')
                .evaluate((element) => getComputedStyle(element).color),
            ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
            await page.close()
          }
        }
      } finally {
        await browser.close()
      }
    })
  })
})

describe('corpus', () => {
  describe('cx', () => {
    for (const workload of Fixture.cases) {
      test(`matches native ${workload.name} corpus styles`, async () => {
        const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox'],
        })
        try {
          for (const output of ['react', 'html'] as const) {
            for (const conditional of [false, true]) {
              const page = await browser.newPage()
              for (const binding of [false, true]) {
                const compiled = Transform.compile({
                  moduleId: `composition-${workload.name}.ts`,
                  source: Fixture.source({
                    binding,
                    conditional,
                    output,
                    workload,
                  }),
                })
                const bundled = await Esbuild.build({
                  alias: {
                    'zyzz/runtime': `${process.cwd()}/src/runtime/index.ts`,
                  },
                  bundle: true,
                  format: 'iife',
                  globalName: 'App',
                  stdin: {
                    contents: compiled.code,
                    loader: 'ts',
                    resolveDir: process.cwd(),
                  },
                  write: false,
                })
                await page.setContent(`<style>${compiled.css}</style>`)
                await page.addScriptTag({
                  content: bundled.outputFiles![0]!.text,
                })
                for (const width of [450, 900]) {
                  await page.setViewportSize({ height: 800, width })
                  for (const enabled of [false, true]) {
                    const mismatches = await page.evaluate(
                      ({ conditional, enabled, styles, width }) => {
                        const apply = (
                          globalThis as unknown as {
                            App: {
                              apply: (
                                enabled: boolean,
                              ) => Record<string, unknown>[]
                            }
                          }
                        ).App.apply
                        const props = apply(enabled)
                        const container = document.createElement('main')
                        document.body.append(container)
                        const mismatches: string[] = []
                        for (const [index, style] of styles.entries()) {
                          const actual = document.createElement('div')
                          const native = document.createElement('div')
                          const value = props[index]!
                          actual.className = String(
                            value.className ?? value.class,
                          )
                          if (typeof value.style === 'string')
                            actual.setAttribute('style', value.style)
                          else Object.assign(actual.style, value.style)
                          Object.assign(native.style, style)
                          if (!conditional || enabled) {
                            native.style.paddingLeft = '3px'
                            native.style.color = 'rebeccapurple'
                            if (width >= 600) native.style.paddingRight = '5px'
                          }
                          container.append(actual, native)
                          const observed = getComputedStyle(actual)
                          const control = getComputedStyle(native)
                          for (const property of [
                            'backgroundColor',
                            'borderRadius',
                            'color',
                            'display',
                            'fontSize',
                            'paddingTop',
                            'paddingRight',
                            'paddingBottom',
                            'paddingLeft',
                          ] as const)
                            if (observed[property] !== control[property])
                              mismatches.push(
                                `${index}:${property}:${observed[property]} != ${control[property]}`,
                              )
                        }
                        container.remove()
                        return mismatches
                      },
                      {
                        conditional,
                        enabled,
                        // These corpus cases contain flat scalar native declarations.
                        styles: Corpus.styles(
                          workload,
                        ) as unknown as readonly Record<
                          string,
                          string | number
                        >[],
                        width,
                      },
                    )
                    expect(mismatches).toMatchInlineSnapshot('[]')
                  }
                }
              }
              await page.close()
            }
          }
        } finally {
          await browser.close()
        }
      }, 120_000)
    }
  })
})

describe('runtime', () => {
  describe('cx', () => {
    test('preserves hashbangs and client directives before runtime factories', async () => {
      const source = `#!/usr/bin/env node
'use client';
import {cx,style} from 'zyzz'; const a=style((values:{padding:string})=>({padding:values.padding})); type Input=Parameters<typeof a>[0]; export const apply=()=>cx(a({padding:'4px'}));`
      const output = Transform.compile({ moduleId: 'client.ts', source })
      expect(
        output.code.startsWith('#!/usr/bin/env node'),
      ).toMatchInlineSnapshot('true')
      const program = parseSync('client.ts', output.code).program
      const first = program.body[0]
      expect(
        first?.type === 'ExpressionStatement' && first.directive,
      ).toMatchInlineSnapshot('"use client"')
      await Esbuild.transform(output.code, { loader: 'ts' })
    })

    test('selects frozen presence alternatives for known applications without runtime helpers', async () => {
      const graph = Graph.compile({
        cssOutput: 'grouped',
        imports: {
          'app.tsx': { './text.js': 'text.ts', zyzz: null },
          'text.ts': { zyzz: null },
        },
        modules: {
          'text.ts': `import {style} from 'zyzz'; export const badge=style({color:'red',padding:'1px'}); export const high=style({color:'blue'});`,
          'app.tsx': `import {cx,style} from 'zyzz'; import * as text from './text.js';
          let reads=0; export const count=()=>reads;
          function read(value:boolean){reads++;return value}
          namespace styles {
            export const base=style({color:'green',margin:'1px'});
            export const wide=style({margin:'4px'});
            export const step=style({paddingTop:'1px'});
          }
          export const imported=(high:boolean)=>cx(text.badge(),read(high) && text.high());
          export const local=(wide:boolean,high:boolean)=>cx(styles.base(),wide && styles.wide(),read(high) && text.high(),styles.step());
          export const many=(mask:number)=>cx(${Array.from(
            { length: 8 },
            (_, bit) =>
              `(mask & ${1 << bit}) !== 0 && styles.${bit % 2 ? 'wide' : 'base'}()`,
          ).join(',')});
          export const early=(()=>{try{return cx(late(),reads===0 && late())}catch(error){return String(error)}})();
          const late=style({color:'black'});`,
        },
      })
      const app = graph.modules['app.tsx']!.code

      expect(app.includes('Composition as')).toMatchInlineSnapshot(`false`)

      const fixture = Vm.runInNewContext(
        `${await Packed.bundle({
          entry: 'app.tsx',
          modules: Object.fromEntries(
            Object.entries(graph.modules).map(([name, module]) => [
              name,
              module.code,
            ]),
          ),
        })};Fixture;`,
      )

      expect(fixture.early).toMatchInlineSnapshot(
        `"TypeError: late is not a function"`,
      )
      expect(fixture.imported(true)).toBe(fixture.imported(true))
      expect(Object.isFrozen(fixture.imported(false))).toMatchInlineSnapshot(
        `true`,
      )
      expect(fixture.count()).toMatchInlineSnapshot(`3`)

      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const css =
          (graph.sharedCss ?? '') +
          Object.values(graph.modules)
            .map((module) => module.css)
            .join('')
        const read = async (props: { readonly className: string }) => {
          await page.setContent(
            `<style>${css}</style><div class="${props.className}"></div>`,
          )
          return page.locator('div').evaluate((node) => {
            const style = getComputedStyle(node)
            return `${style.color} ${style.margin} ${style.padding}`
          })
        }

        expect(await read(fixture.imported(false))).toMatchInlineSnapshot(
          `"rgb(255, 0, 0) 0px 1px"`,
        )
        expect(await read(fixture.imported(true))).toMatchInlineSnapshot(
          `"rgb(0, 0, 255) 0px 1px"`,
        )
        expect(await read(fixture.local(false, false))).toMatchInlineSnapshot(
          `"rgb(0, 128, 0) 1px 1px 0px 0px"`,
        )
        expect(await read(fixture.local(true, true))).toMatchInlineSnapshot(
          `"rgb(0, 0, 255) 4px 1px 0px 0px"`,
        )
        expect(await read(fixture.many(0b0000_0001))).toMatchInlineSnapshot(
          `"rgb(0, 128, 0) 1px 0px"`,
        )
        expect(await read(fixture.many(0b0101_0110))).toMatchInlineSnapshot(
          `"rgb(0, 128, 0) 1px 0px"`,
        )
        expect(await read(fixture.many(0b0010_1001))).toMatchInlineSnapshot(
          `"rgb(0, 128, 0) 4px 0px"`,
        )
      } finally {
        await browser.close()
      }
    })

    test('diagnoses conditional omissions without dropping evaluation', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'effect.ts',
          source: `import {cx,style} from 'zyzz';const a=style({color:'red'});export const apply=()=>cx(effect() && null,a());`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: effect.ts:85: Conditional omissions must be evaluated outside composition.]`,
      )
    })

    test('retains authored sibling composition cascade order', async () => {
      const output = Transform.compile({
        moduleId: 'siblings.ts',
        source: `import {cx,style} from 'zyzz'; const a=style({color:'red'});const b=style({color:'blue'});export const first=cx(a());export const second=cx(b());`,
      })
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
        await page.setContent(`<style>${output.css}</style><div></div>`)
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        await page.evaluate(
          `document.querySelector('div').className=App.first.className+' '+App.second.className`,
        )
        expect(
          await page
            .locator('div')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
      } finally {
        await browser.close()
      }
    })

    test('merges bindings in argument order and clears repeated recipe ownership', async () => {
      const source = `import {cx,style,variants} from 'zyzz';
      namespace styles {
        export const dynamic=style((values:{padding:\`\${number}px\`})=>({padding:values.padding}));
        export const override=style({paddingLeft:'3px'});
        export const recipe=variants({base:{color:'black'},variants:{tone:{red:{color:'red'},custom:(values:{color:'red'|'blue'})=>({color:values.color})}}});
      }
      export const apply=(padding:\`\${number}px\`)=>cx(styles.dynamic({padding}),styles.override());
      export const optional=(enabled:boolean)=>cx(styles.dynamic({padding:'8px'}),enabled && styles.override());
      export const nestedOptional=(enabled:boolean)=>cx(styles.dynamic({padding:'7px'}),cx(enabled && styles.override()));
      export const inline=()=>cx(styles.dynamic({padding:'8px',style:{padding:'20px'},className:'external'}),styles.override({style:{paddingLeft:'9px'}}),styles.dynamic({padding:'12px',style:{padding:'24px'}}));
      export const repeat=()=>cx(styles.dynamic({padding:'8px'}),styles.override(),styles.dynamic({padding:'12px'}));
      export const clear=()=>cx(styles.recipe({tone:{custom:{color:'blue'}}}),styles.recipe({tone:null}));
      export const nested=()=>cx(cx(styles.dynamic({padding:'9px'}),styles.override()),styles.recipe({tone:'red'}));`
      const output = Transform.compile({ moduleId: 'runtime.ts', source })
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
          `<style>button{padding:0}${output.css}</style><button>Button</button>`,
        )
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        const count = await page.evaluate(
          () => document.styleSheets[0]!.cssRules.length,
        )
        await page.evaluate(`window.read=(props)=>{
        const element=document.querySelector('button');
        for(const name of element.getAttributeNames()) element.removeAttribute(name);
        element.className=props.className;
        for(const [key,value] of Object.entries(props)) {
          if(key.startsWith('data-')) element.setAttribute(key,value);
          if(key==='style') for(const [name,bound] of Object.entries(value)) name.startsWith('--')?element.style.setProperty(name,String(bound)):element.style[name]=String(bound);
        }
        const style=getComputedStyle(element);
        return {padding:style.padding,color:style.color,keys:Object.keys(props).sort(),slots:Object.keys(props.style??{}).length};
      }`)
        expect(await page.evaluate("read(App.apply('16px'))"))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "16px 16px 16px 3px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.optional(false))'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "8px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.optional(true))'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "8px 8px 8px 3px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.nestedOptional(false))'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "7px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.nestedOptional(true))'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "7px 7px 7px 3px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.inline())'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "24px",
          "slots": 3,
        }
      `)
        expect(
          await page.evaluate(
            "document.querySelector('button').classList.contains('external')",
          ),
        ).toMatchInlineSnapshot(`true`)
        expect(await page.evaluate('read(App.repeat())'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
            "style",
          ],
          "padding": "12px",
          "slots": 1,
        }
      `)
        expect(await page.evaluate('read(App.clear())')).toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 0, 0)",
          "keys": [
            "className",
          ],
          "padding": "0px",
          "slots": 0,
        }
      `)
        expect(await page.evaluate('read(App.nested())'))
          .toMatchInlineSnapshot(`
        {
          "color": "rgb(255, 0, 0)",
          "keys": [
            "className",
            "data-tone",
            "style",
          ],
          "padding": "9px 9px 9px 3px",
          "slots": 1,
        }
      `)
        expect(
          (await page.evaluate(
            () => document.styleSheets[0]!.cssRules.length,
          )) === count,
        ).toMatchInlineSnapshot('true')
      } finally {
        await browser.close()
      }
    })

    test('composes HTML payloads without parsing serialized styles or leaking metadata', async () => {
      const source = `import {Config,cx} from 'zyzz';const {style,variants}=Config.create({output:'html'});
      namespace styles {
        export const value=style((values:{padding:\`\${number}px\`})=>({padding:values.padding}));
        export const fixed=style({paddingLeft:'3px'});
        export const recipe=variants({base:{color:'black'},variants:{tone:{custom:(values:{color:'red'|'blue'})=>({color:values.color})}}});
      }
      export const props=(enabled:boolean)=>cx(styles.value({padding:'16px'}),enabled && styles.fixed(),styles.recipe({tone:{custom:{color:'blue'}}}));
      export const clear=()=>cx(styles.recipe({tone:{custom:{color:'red'}}}),styles.recipe({tone:null}));
      export const nested=()=>cx(cx(styles.fixed(),styles.fixed()),styles.value({padding:'12px'}));`
      const output = Transform.compile({ moduleId: 'html.ts', source })
      const directory = await Fs.mkdtemp(Path.resolve('.fixture-compose-html-'))
      try {
        const path = Path.join(directory, 'html.ts')
        await Fs.writeFile(path, output.code)
        await Util.promisify(ChildProcess.execFile)(process.execPath, [
          Path.resolve('node_modules/typescript/bin/tsc'),
          '--ignoreConfig',
          '--customConditions',
          'src',
          '--strict',
          '--module',
          'nodenext',
          '--target',
          'esnext',
          '--skipLibCheck',
          '--noEmit',
          path,
        ]).catch((error: unknown) => {
          throw new Error((error as { stdout: string }).stdout, {
            cause: error,
          })
        })
      } finally {
        await Fs.rm(directory, { recursive: true, force: true })
      }

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
          `<style>button{padding:0}${output.css}</style><button>Button</button>`,
        )
        await page.addScriptTag({ content: bundled.outputFiles![0]!.text })
        await page.evaluate(
          `window.read=(props)=>{const element=document.querySelector('button');for(const name of element.getAttributeNames())element.removeAttribute(name);for(const [name,value] of Object.entries(props))element.setAttribute(name,value);const style=getComputedStyle(element);return [style.padding,style.color,element.getAttributeNames().sort()]}`,
        )
        expect(await page.evaluate('read(App.props(true))'))
          .toMatchInlineSnapshot(`
        [
          "16px 16px 16px 3px",
          "rgb(0, 0, 255)",
          [
            "class",
            "data-tone",
            "style",
          ],
        ]
      `)
        expect(await page.evaluate('read(App.props(false))'))
          .toMatchInlineSnapshot(`
        [
          "16px",
          "rgb(0, 0, 255)",
          [
            "class",
            "data-tone",
            "style",
          ],
        ]
      `)
        expect(await page.evaluate('read(App.clear())')).toMatchInlineSnapshot(`
        [
          "0px",
          "rgb(0, 0, 0)",
          [
            "class",
          ],
        ]
      `)
        expect(await page.evaluate('read(App.nested())'))
          .toMatchInlineSnapshot(`
        [
          "12px",
          "rgb(0, 0, 0)",
          [
            "class",
            "style",
          ],
        ]
      `)
      } finally {
        await browser.close()
      }
    }, 30000)

    test('bounds conditional expansion and rejects mixed renderer outputs', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'limit.ts',
          source: `import {cx,style} from 'zyzz';const a=style({color:'red'});export const props=(enabled:boolean)=>cx(${Array.from({ length: 9 }, () => 'enabled && a()').join(',')});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: limit.ts:97: Composition supports at most eight conditional arguments.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'mixed.ts',
          source: `import {Config,cx,style} from 'zyzz';const {style:html}=Config.create({output:'html'});const a=style({color:'red'});const b=html({color:'blue'});export const props=cx(a(),b());`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: mixed.ts:164: Composition cannot mix HTML and React props.]`,
      )
    })

    test('reports conflicting recipe attribute owners at compilation', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {cx,variants} from 'zyzz';const a=variants({variants:{tone:{red:{color:'red'}}}});const b=variants({variants:{tone:{blue:{color:'blue'}}}});export const props=cx(a(),b());`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:173: Recipe attribute data-tone has conflicting owners.]`,
      )
    })
  })
})
