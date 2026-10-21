import { Vars } from 'zyzz'
/**
 * Exercises the public Transform workflow through real collaborating modules.
 * @module
 */
import * as Font from '../../test/fixtures/AtRuleFont.js'
import * as Targets from '../../test/fixtures/AtRuleTargets.js'
import * as Backgrounds from '../../test/fixtures/Backgrounds.js'
import * as BorderLists from '../../test/fixtures/BorderLists.js'
import * as Borders from '../../test/fixtures/Borders.js'
import * as BorderShorthand from '../../test/fixtures/BorderShorthand.js'
import * as BoxLists from '../../test/fixtures/BoxLists.js'
import * as fontPaletteFont from '../../test/fixtures/ColorFont.js'
import * as namedRulesFont from '../../test/fixtures/ColorFont.js'
import * as Profile from '../../test/fixtures/ColorProfile.js'
import * as Colors from '../../test/fixtures/Colors.js'
import * as Columns from '../../test/fixtures/Columns.js'
import * as Conformance from '../../test/fixtures/Conformance.js'
import * as ContainerSizing from '../../test/fixtures/ContainerSizing.js'
import * as Controls from '../../test/fixtures/Controls.js'
import * as Corners from '../../test/fixtures/Corners.js'
import * as Declarations from '../../test/fixtures/Declarations.js'
import * as Flex from '../../test/fixtures/Flex.js'
import * as FontFeatures from '../../test/fixtures/FontFeatures.js'
import * as Fonts from '../../test/fixtures/Fonts.js'
import * as FunctionalColors from '../../test/fixtures/FunctionalColors.js'
import * as Functions from '../../test/fixtures/Functions.js'
import * as Geometry from '../../test/fixtures/Geometry.js'
import * as Grid from '../../test/fixtures/Grid.js'
import * as GridLines from '../../test/fixtures/GridLines.js'
import * as GridLists from '../../test/fixtures/GridLists.js'
import * as GroupingRules from '../../test/fixtures/GroupingRules.js'
import * as Identifiers from '../../test/fixtures/Identifiers.js'
import * as Interaction from '../../test/fixtures/Interaction.js'
import * as KeywordGroups from '../../test/fixtures/KeywordGroups.js'
import * as Layout from '../../test/fixtures/Layout.js'
import * as Lengths from '../../test/fixtures/Lengths.js'
import * as Logical from '../../test/fixtures/Logical.js'
import * as Masks from '../../test/fixtures/Masks.js'
import * as MathExpressions from '../../test/fixtures/MathExpressions.js'
import * as Motion from '../../test/fixtures/Motion.js'
import * as MotionLists from '../../test/fixtures/MotionLists.js'
import * as NamedDescriptors from '../../test/fixtures/NamedDescriptors.js'
import * as Packed from '../../test/fixtures/Packed.js'
import * as Margins from '../../test/fixtures/PageMargins.js'
import * as Pages from '../../test/fixtures/Pages.js'
import * as Percentage from '../../test/fixtures/Percentage.js'
import * as Prefixed from '../../test/fixtures/Prefixed.js'
import * as Ranges from '../../test/fixtures/Ranges.js'
import * as Reading from '../../test/fixtures/Reading.js'
import * as Registrations from '../../test/fixtures/Registrations.js'
import * as Responsive from '../../test/fixtures/Responsive.js'
import * as Scalars from '../../test/fixtures/Scalars.js'
import * as Scrolling from '../../test/fixtures/Scrolling.js'
import * as Sizing from '../../test/fixtures/Sizing.js'
import * as Snapping from '../../test/fixtures/Snapping.js'
import * as Statements from '../../test/fixtures/Statements.js'
import * as Substitution from '../../test/fixtures/Substitution.js'
import * as Svg from '../../test/fixtures/Svg.js'
import * as Tables from '../../test/fixtures/Tables.js'
import * as Templates from '../../test/fixtures/Templates.js'
import * as TextDecoration from '../../test/fixtures/TextDecoration.js'
import * as TextFlow from '../../test/fixtures/TextFlow.js'
import * as TextTimeline from '../../test/fixtures/TextTimeline.js'
import * as Tuples from '../../test/fixtures/Tuples.js'
import * as WeasyPrint from '../../test/fixtures/WeasyPrint.js'
import * as Literal from '../internal/Literal.js'
import * as Trace from '@jridgewell/trace-mapping'
import * as CssTree from 'css-tree'
import * as Esbuild from 'esbuild'
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Http from 'node:http'
import * as Module from 'node:module'
import * as Path from 'node:path'
import * as Util from 'node:util'
import * as Pdf from 'pdf-lib'
import { chromium } from 'playwright'
import * as React from 'react'
import * as Server from 'react-dom/server'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { Config, Style } from 'zyzz'
import { Graph, Source, Transform } from 'zyzz/compiler'
import { Dynamic, Props } from 'zyzz/runtime'
import { Css } from 'zyzz/web'

const root = Path.resolve(import.meta.dirname, '../..')

describe('compile', () => {
  test('includes responsive defaults in standalone module CSS', async () => {
    const output = Transform.compile({
      moduleId: 'entry.js',
      source: `import {Config,Vars} from 'zyzz';
        const tokens=Vars.define({editorial:{labelSize:{default:'14px','@media (width >= 1024px)':'16px'},space:{default:'8px','@media (width >= 1024px)':'12px'}}});
        const extended=Vars.extend(tokens,{editorial:{labelSize:{default:'20px','@media (width >= 1024px)':'24px'}}});
        const {style,vars}=Config.create({vars:{base:tokens,large:extended},defaultVars:'base',mappings:false});
        export const first=style({fontSize:'editorial.labelSize'})();
        export const second=style({fontSize:'editorial.labelSize',padding:'editorial.space'})();
        export const base=vars({set:'base'});
        export const large=vars({set:'large'});`,
    })
    await Responsive.verify({
      code: await Packed.bundle({
        entry: 'entry.js',
        modules: { 'entry.js': output.code },
      }),
      css: output.css,
    })
  })

  describe('reachability', () => {
    test('preserves live packed styles and complete theme token scopes', () => {
      const library = Graph.compile({
        modules: {
          'library.ts':
            "import {Config} from 'zyzz';\n            export const {style, vars:themes} = Config.create({defaultVars:'mint',vars:{mint:{color:{brand:'red',extra:'blue'}}}});\n            export namespace styles { export const card = style({color:'brand'}); }",
        },
      })
      const output = Graph.compile({
        contracts: { 'library.js': library.contracts['library.ts']! },
        imports: { 'app.ts': { library: 'library.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'zyzz'; import {styles, themes} from 'library';
            const unused = style({width:'123px'});
            export const props = styles.card();
            export const scope = themes({set:'mint'});`,
        },
      })

      expect(
        output.modules['app.ts']!.css.includes('width:123px;'),
      ).toMatchInlineSnapshot('false')
      expect(
        output.modules['app.ts']!.css.includes('blue'),
      ).toMatchInlineSnapshot('true')
      expect(
        library.modules['library.ts']!.css.includes('color:'),
      ).toMatchInlineSnapshot('true')
    })

    test('matches independent browser styles after pruning', async () => {
      const browser = await chromium.launch()

      try {
        for (const cssOutput of ['atomic', 'grouped'] as const) {
          const output = Transform.compile({
            cssOutput,
            moduleId: 'browser.ts',
            source: `import {style} from 'zyzz';
              const unused = style({padding:'100px'});
              export const card = style({padding:'8px',paddingLeft:'2px',color:'red'});`,
          })
          const page = await browser.newPage()

          await page.setContent(
            `<style>${output.css}</style><div id="actual" class="${Object.values(output.classes).filter(Boolean).at(-1)}"></div><div id="control" style="padding:8px;padding-left:2px;color:red"></div>`,
          )

          for (const property of [
            'color',
            'paddingLeft',
            'paddingRight',
          ] as const) {
            const actual = await page
              .locator('#actual')
              .evaluate(
                (element, property) => getComputedStyle(element)[property],
                property,
              )
            const control = await page
              .locator('#control')
              .evaluate(
                (element, property) => getComputedStyle(element)[property],
                property,
              )

            expect(actual === control).toMatchInlineSnapshot('true')
          }

          await page.close()
        }
      } finally {
        await browser.close()
      }
    })

    test.each(['atomic', 'grouped'] as const)(
      'prunes unused locals and members in %s output',
      (cssOutput) => {
        const output = Transform.compile({
          cssOutput,
          moduleId: 'reachability.ts',
          source: `import {style} from 'zyzz';
          const unused = style({width:'123px'});
          namespace styles {
            export const dead = style({height:'456px'});
            export const live = style({color:'red'});
          }
          export const props = styles.live();`,
        })

        expect(output.css.includes('width:')).toMatchInlineSnapshot('false')
        expect(output.css.includes('height:')).toMatchInlineSnapshot('false')
        expect(output.css.includes('color:red;')).toMatchInlineSnapshot('true')
      },
    )

    test.each([
      'export {card}',
      'export const alias = card',
      'export const props = card()',
      'eval("card()")',
    ])('retains observable definitions: %s', (usage) => {
      const output = Transform.compile({
        moduleId: 'observable.ts',
        source: `import {style} from 'zyzz'; const card = style({color:'red'}); ${usage}`,
      })

      expect(output.css.includes('color:red;')).toMatchInlineSnapshot('true')
    })

    test('retains sibling selector references and escaped namespaces', () => {
      const source = `import {style} from 'zyzz';
        namespace styles {
          export const parent = style({padding:'8px'});
          export const child = style({selectors:{[\`\${parent} &\`]:{color:'red'}}});
          export const unused = style({height:'456px'});
        }
        export const props = styles.child();`
      const output = Transform.compile({ moduleId: 'siblings.ts', source })

      expect(output.css.includes('padding:8px;')).toMatchInlineSnapshot('true')
      expect(output.css.includes('height:')).toMatchInlineSnapshot('false')

      const escaped = Transform.compile({
        moduleId: 'siblings.ts',
        source: `${source} export const all = styles;`,
      })

      expect(escaped.css.includes('height:456px;')).toMatchInlineSnapshot(
        'true',
      )
    })

    test('retains development and CSS-only definitions', () => {
      const source = `import {style} from 'zyzz'; const unused = style({width:'123px'});`

      for (const options of [
        { development: true },
        { compiler: false },
      ] as const) {
        const output = Transform.compile({
          moduleId: 'retained.ts',
          source,
          ...options,
        })

        expect(output.css.includes('width:123px;')).toMatchInlineSnapshot(
          'true',
        )
      }
    })

    test('retains computed access and reopened namespaces', () => {
      for (const usage of [
        `export const props = styles['card']()`,
        `namespace styles { export const alias = card; } export const props = styles.alias()`,
      ]) {
        const output = Transform.compile({
          moduleId: 'retained.ts',
          source: `import {style} from 'zyzz'; namespace styles {export const card = style({color:'red'});} ${usage}`,
        })

        expect(output.css.includes('color:red;')).toMatchInlineSnapshot('true')
      }
    })

    test('ignores shadowed reads when proving a local definition unused', () => {
      const output = Transform.compile({
        moduleId: 'shadowed.ts',
        source: `import {style} from 'zyzz'; const card = style({color:'red'}); export function read(card: string) {return card;}`,
      })

      expect(output.css).toMatchInlineSnapshot('""')
    })

    test('retains all alternatives in an exported variant', () => {
      const output = Transform.compile({
        moduleId: 'variants.ts',
        source: `import {variants} from 'zyzz'; export const button = variants({variants:{size:{sm:{padding:'4px'},lg:{padding:'16px'}}},defaultVariants:{size:'sm'}})`,
      })

      expect(output.css.includes('padding:4px;')).toMatchInlineSnapshot('true')
      expect(output.css.includes('padding:16px;')).toMatchInlineSnapshot('true')
    })
  })

  test('CSS conformance compiles scroll axis locking with fallbacks and importance', () => {
    const output = Transform.compile({
      moduleId: 'scroll.ts',
      source: `import { style } from 'zyzz';
        export const scroll = style({ scrollAxisLock: ['auto', 'none !important'] })();`,
    })
    const declarations: string[] = []

    CssTree.walk(CssTree.parse(output.css), (node) => {
      if (node.type === 'Declaration') declarations.push(CssTree.generate(node))
    })

    expect(declarations).toMatchInlineSnapshot(`
      [
        "scroll-axis-lock:auto",
        "scroll-axis-lock:none!important",
      ]
    `)
  })

  test('CSS conformance covers every implemented property and pinned upstream grammar', async () => {
    const inventory = JSON.parse(
      await Fs.readFile(
        Path.join(root, 'test/conformance/coverage.json'),
        'utf8',
      ),
    ) as {
      families: { properties: Record<string, { status: string }> }
    }

    expect(Conformance.properties().length).toMatchInlineSnapshot(`1009`)

    const implemented = [
      ...Object.keys(Literal.rules).map(Conformance.name),
      '--*',
    ].sort()

    const classified = Object.entries(inventory.families.properties)
      .filter(
        ([, entry]) =>
          entry.status === 'partial' || entry.status === 'supported',
      )
      .map(([name]) => name)
      .sort()

    expect(
      classified.filter((name) => !implemented.includes(name)),
    ).toMatchInlineSnapshot(`[]`)
    expect(
      implemented.filter((name) => !classified.includes(name)),
    ).toMatchInlineSnapshot(`[]`)

    const { stderr } = await Util.promisify(ChildProcess.execFile)(
      process.execPath,
      ['scripts/css-conformance.ts'],
      { cwd: root },
    )

    expect(stderr).toMatchInlineSnapshot(`""`)
  })

  test('CSS conformance fails stale grammars and unclassified upstream properties', async () => {
    const directory = await Fs.mkdtemp(
      Path.join(root, '.fixture-css-inventory-'),
    )

    try {
      const inventory = JSON.parse(
        await Fs.readFile(
          Path.join(root, 'test/conformance/coverage.json'),
          'utf8',
        ),
      ) as {
        families: {
          properties: Record<string, { grammar: string; status: string }>
        }
      }

      delete inventory.families.properties['display']
      inventory.families.properties['color']!.grammar = 'unreviewed'

      const file = Path.join(directory, 'coverage.json')

      await Fs.writeFile(file, JSON.stringify(inventory))

      const result = ChildProcess.spawnSync(
        process.execPath,
        ['scripts/css-conformance.ts', '--inventory', file],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      )

      expect(result.status).toMatchInlineSnapshot(`1`)
      expect(result.stderr).toMatchInlineSnapshot(`
        "
        Changed properties: color
        Added properties: display
        Unclassified properties: display
        Review upstream changes with pnpm update:css, then classify coverage.json entries.
        "
      `)

      const update = ChildProcess.spawnSync(
        process.execPath,
        ['scripts/css-conformance.ts', '--inventory', file, '--update'],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      )

      expect(update.status).toMatchInlineSnapshot(`0`)

      const check = ChildProcess.spawnSync(
        process.execPath,
        ['scripts/css-conformance.ts', '--inventory', file],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      )

      expect(check.status).toMatchInlineSnapshot(`1`)
      expect(check.stderr).toMatchInlineSnapshot(`
        "
        Unclassified properties: display
        Review upstream changes with pnpm update:css, then classify coverage.json entries.
        "
      `)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }
  })

  describe('CSS conformance validates emitted values against independent MDN grammar', () => {
    let cases: readonly Conformance.Case[]
    let lexer: ReturnType<typeof Conformance.lexer>

    beforeAll(() => {
      cases = Conformance.cases()
      lexer = Conformance.lexer()
    }, 30_000)

    test.each(Array.from({ length: 10 }, (_, index) => index))(
      'partition %i',
      (partition) => {
        const size = Math.ceil(cases.length / 10)
        const probes = cases.slice(partition * size, (partition + 1) * size)
        const failures: string[] = []

        // Batches bound compiler input size while still exercising fallback and importance rewriting.
        for (let start = 0; start < probes.length; start += 100) {
          const batch = probes.slice(start, start + 100)

          const source = `import { style } from 'zyzz';\n${batch
            .map(
              ({ property, value }, index) =>
                `export const case${index} = style({${property}: [${JSON.stringify(value)}, ${JSON.stringify(`${value} !important`)}]})();`,
            )
            .join('\n')}`

          const output = Transform.compile({
            moduleId: 'conformance.ts',
            source,
          })
          let count = 0

          CssTree.walk(CssTree.parse(output.css), (node) => {
            if (node.type !== 'Declaration') return

            count++

            const value = CssTree.generate(node.value)
            const error = lexer.matchProperty(node.property, value).error

            if (error)
              failures.push(`${node.property}: ${value}: ${error.message}`)
          })

          if (count !== batch.length * 2)
            failures.push(`Declaration count: ${count} != ${batch.length * 2}`)
        }

        expect(failures).toMatchInlineSnapshot(`[]`)
      },
      30_000,
    )
  })

  test('interaction declarations preserve importance and source maps', () => {
    const output = Transform.compile({
      moduleId: 'example/interaction.ts',
      source: Interaction.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z_7sxPYh0{cursor:not-allowed;}
      .z_7sxPYh1{pointer-events:auto;pointer-events:none!important;pointer-events:auto;}
      .z_7sxPYh2{resize:none;}
      .z_7sxPYh3{user-select:none;}
      .z_7sxPYh4{visibility:visible;}
      .z_7sxPYh5{cursor:text;}
      .z_7sxPYh6{pointer-events:auto;}
      .z_7sxPYh7{resize:both;}
      .z_7sxPYh8{user-select:text;}
      .z_7sxPYh9{cursor:default;}
      .z_7sxPYha{resize:none;}
      .z_7sxPYhb{user-select:auto;}
      .z_7sxPYhc{visibility:hidden;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('pointer-events:none!important'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        column: lines[line]!.indexOf('pointer-events:none!important'),
        line: line + 1,
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 45,
        "line": 4,
        "name": "pointerEvents",
        "source": "example/interaction.ts",
      }
    `)
  })

  test('interaction declarations match browser hit testing, selection, and visibility', async () => {
    const output = Transform.compile({
      moduleId: 'example/interaction.ts',
      source: Interaction.source,
    })
    const js = await Esbuild.transform(output.code, {
      format: 'esm',
      loader: 'ts',
    })
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>.panel{position:relative;width:160px;height:60px;margin:8px}.panel>button,.overlay{position:absolute;inset:0;width:160px;height:60px;box-sizing:border-box}.overlay{overflow:auto;background:white}${output.css}</style>${Object.entries(
          Interaction.controls,
        )
          .map(
            ([name, css]) =>
              `<div class="panel"><button>Underneath</button><div id="${name}" class="overlay ${module[name].className}">Selection</div></div><div class="panel"><button>Underneath</button><div id="${name}-control" class="overlay" style="${css}">Selection</div></div>`,
          )
          .join('')}`,
      )

      expect(
        await page.evaluate(
          (names) =>
            names.filter((name) => {
              const actual = document.getElementById(name)!
              const control = document.getElementById(`${name}-control`)!
              const a = getComputedStyle(actual)
              const b = getComputedStyle(control)

              return (
                [
                  'cursor',
                  'pointer-events',
                  'resize',
                  'user-select',
                  'visibility',
                ].some(
                  (property) =>
                    a.getPropertyValue(property) !==
                    b.getPropertyValue(property),
                ) ||
                actual.getBoundingClientRect().height !==
                  control.getBoundingClientRect().height
              )
            }),
          Object.keys(Interaction.controls),
        ),
      ).toMatchInlineSnapshot(`[]`)

      await page.evaluate(() => {
        for (const panel of document.querySelectorAll('.panel'))
          panel.addEventListener('click', (event) => {
            const target = event.target as HTMLElement

            panel.setAttribute('data-target', target.tagName)
          })
      })

      for (const name of Object.keys(Interaction.controls)) {
        for (const suffix of ['', '-control']) {
          const box = await page
            .locator(`#${name}${suffix}`)
            .evaluate((element) => {
              const rect = element.getBoundingClientRect()

              return { x: rect.x, y: rect.y }
            })

          await page.mouse.click(box.x + 80, box.y + 30)
        }
      }

      expect(
        await page
          .locator('.panel')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-target')),
          ),
      ).toMatchInlineSnapshot(`
        [
          "BUTTON",
          "BUTTON",
          "DIV",
          "DIV",
          "BUTTON",
          "BUTTON",
        ]
      `)
      expect(
        await page
          .locator('#hidden')
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toMatchInlineSnapshot(`60`)

      // Isolate selection from the disabled control's hit-testing declaration.
      await page
        .locator('#disabled')
        .evaluate((element) =>
          element.style.setProperty('pointer-events', 'auto', 'important'),
        )
      await page.locator('#disabled').dblclick({ position: { x: 20, y: 8 } })

      expect(
        await page.evaluate(() => getSelection()!.toString()),
      ).toMatchInlineSnapshot(`""`)

      await page.locator('#editable').dblclick({ position: { x: 20, y: 8 } })

      expect(
        await page.evaluate(() => getSelection()!.toString()),
      ).toMatchInlineSnapshot(`"Selection"`)
    } finally {
      await browser.close()
    }
  })

  test('table declarations preserve fallback priority and source maps', () => {
    const output = Transform.compile({
      moduleId: 'example/tables.ts',
      source: Tables.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z_FG6gl60{border-collapse:collapse;}
      .z_FG6gl61{border-spacing:12px;}
      .z_FG6gl62{caption-side:top;}
      .z_FG6gl63{empty-cells:show;}
      .z_FG6gl64{table-layout:auto;}
      .z_FG6gl65{border-collapse:separate;}
      .z_FG6gl66{border-spacing:2px;border-spacing:8px!important;border-spacing:4px;}
      .z_FG6gl67{caption-side:bottom;}
      .z_FG6gl68{empty-cells:hide;}
      .z_FG6gl69{table-layout:fixed;}
      .z_FG6gl6a{border-collapse:separate;}
      .z_FG6gl6b{border-spacing:0;}
      .z_FG6gl6c{caption-side:top;}
      .z_FG6gl6d{empty-cells:show;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('border-spacing:8px!important'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        column: lines[line]!.indexOf('border-spacing:8px!important'),
        line: line + 1,
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 49,
        "line": 4,
        "name": "borderSpacing",
        "source": "example/tables.ts",
      }
    `)
  })

  test('table declarations match browser layout and inherited cell styles', async () => {
    const output = Transform.compile({
      moduleId: 'example/tables.ts',
      source: Tables.source,
    })
    const js = await Esbuild.transform(output.code, {
      format: 'esm',
      loader: 'ts',
    })
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const rows =
        '<caption>Caption</caption><tbody><tr><td>Wide content</td><td></td></tr><tr><td>A</td><td>B</td></tr></tbody>'

      await page.setContent(
        `<style>table{width:240px}td{border:2px solid;padding:0;height:24px}${output.css}</style>${Object.entries(
          Tables.controls,
        )
          .map(
            ([name, css]) =>
              `<table id="${name}" class="${module[name].className}">${rows}</table><table id="${name}-control" style="${css}">${rows}</table>`,
          )
          .join('')}`,
      )

      for (const direction of ['ltr', 'rtl']) {
        await page.locator('body').evaluate((element, direction) => {
          element.style.direction = direction
        }, direction)

        expect(
          await page.evaluate(
            (names) =>
              names.filter((name) => {
                const actual = document.getElementById(name)!
                const control = document.getElementById(`${name}-control`)!

                for (const selector of [
                  '',
                  'caption',
                  'td',
                  'td:nth-child(2)',
                ]) {
                  const a = selector ? actual.querySelector(selector)! : actual
                  const b = selector
                    ? control.querySelector(selector)!
                    : control
                  const aa = getComputedStyle(a)
                  const bb = getComputedStyle(b)
                  if (
                    [
                      'border-collapse',
                      'border-spacing',
                      'caption-side',
                      'empty-cells',
                      'table-layout',
                    ].some(
                      (property) =>
                        aa.getPropertyValue(property) !==
                        bb.getPropertyValue(property),
                    )
                  )
                    return true

                  const ar = a.getBoundingClientRect()
                  const br = b.getBoundingClientRect()
                  if (
                    ar.width !== br.width ||
                    ar.height !== br.height ||
                    ar.top - actual.getBoundingClientRect().top !==
                      br.top - control.getBoundingClientRect().top
                  )
                    return true
                }

                return false
              }),
            Object.keys(Tables.controls),
          ),
        ).toMatchInlineSnapshot(`[]`)
      }

      expect(
        await page.locator('#separated').evaluate((element) => {
          const cells = element.querySelectorAll('td')

          return {
            captionBelow:
              element.querySelector('caption')!.getBoundingClientRect().top >=
              cells[2]!.getBoundingClientRect().bottom,
            emptyCells: getComputedStyle(cells[1]!).emptyCells,
            gap:
              cells[0]!.getBoundingClientRect().left -
              cells[1]!.getBoundingClientRect().right,
            spacing: getComputedStyle(element).borderSpacing,
            tableLayout: getComputedStyle(element).tableLayout,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "captionBelow": true,
          "emptyCells": "hide",
          "gap": 8,
          "spacing": "8px",
          "tableLayout": "fixed",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('text decorations preserve color domains, spacing tokens, priority, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/decoration.ts',
      source: TextDecoration.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-stroke:2px;--z-textUnderlineOffset-offset:4px;}
      .z_Y21ZU90{text-decoration-line:underline;}
      .z_Y21ZU91{text-decoration-thickness:from-font;}
      .z_Y21ZU92{text-underline-offset:auto;}
      .z_Y21ZU93{text-decoration-skip-ink:auto;}
      .z_Y21ZU94{text-decoration-line:underline;text-decoration-line:underline overline!important;}
      .z_Y21ZU95{text-decoration-color:var(--z-color-brand,#06c);}
      .z_Y21ZU96{text-decoration-style:wavy;}
      .z_Y21ZU97{text-decoration-thickness:var(--z-spacing-stroke,2px);}
      .z_Y21ZU98{text-underline-offset:var(--z-textUnderlineOffset-offset,4px);}
      .z_Y21ZU99{text-decoration-skip-ink:none;}
      .z_Y21ZU9a{text-decoration-line:line-through;}
      .z_Y21ZU9b{text-decoration-thickness:10%;}
      .z_Y21ZU9c{text-underline-offset:-10%;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('text-decoration-line:underline overline'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('text-decoration-line:underline overline'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 34,
        "line": 5,
        "name": "textDecorationLine",
        "source": "example/decoration.ts",
      }
    `)
  })

  test('text decorations match native browser controls across writing modes', async () => {
    const output = Transform.compile({
      moduleId: 'example/decoration.ts',
      source: TextDecoration.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>body{font:24px/2 monospace}${output.css}</style><main>${Object.entries(
          TextDecoration.controls,
        )
          .map(
            ([name, css]) =>
              `<div id="${name}" class="${module[name].className}">Typography</div><div id="${name}-control" style="${css}">Typography</div>`,
          )
          .join('')}</main>`,
      )

      for (const writingMode of ['horizontal-tb', 'vertical-lr', 'vertical-rl'])
        for (const direction of ['ltr', 'rtl']) {
          await page.locator('main').evaluate(
            (element, mode) => {
              element.style.direction = mode.direction
              element.style.writingMode = mode.writingMode
            },
            { direction, writingMode },
          )

          expect(
            await page.evaluate((names) => {
              const properties = [
                'text-decoration-color',
                'text-decoration-line',
                'text-decoration-style',
                'text-decoration-thickness',
                'text-decoration-skip-ink',
                'text-underline-offset',
              ]

              return names.filter((name) => {
                const actual = getComputedStyle(document.getElementById(name)!)
                const control = getComputedStyle(
                  document.getElementById(`${name}-control`)!,
                )

                return properties.some(
                  (property) =>
                    actual.getPropertyValue(property) !==
                    control.getPropertyValue(property),
                )
              })
            }, Object.keys(TextDecoration.controls)),
          ).toMatchInlineSnapshot(`[]`)
        }

      expect(
        await page.locator('#decorated').evaluate((element) => {
          const style = getComputedStyle(element)

          return {
            color: style.textDecorationColor,
            line: style.textDecorationLine,
            offset: style.textUnderlineOffset,
            skip: style.textDecorationSkipInk,
            style: style.textDecorationStyle,
            thickness: style.textDecorationThickness,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "color": "rgb(0, 102, 204)",
          "line": "underline overline",
          "offset": "4px",
          "skip": "none",
          "style": "wavy",
          "thickness": "2px",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('text flow preserves indentation tokens, fallback priority, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/text.ts',
      source: TextFlow.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-indent:12px;}
      .z_xcRSGS0{width:65px;}
      .z_xcRSGS1{word-break:break-all;}
      .z_xcRSGS2{letter-spacing:normal;letter-spacing:2px;}
      .z_xcRSGS3{width:200px;}
      .z_xcRSGS4{text-indent:var(--z-spacing-indent,12px);}
      .z_xcRSGS5{text-align-last:start;}
      .z_xcRSGS6{hyphens:manual;}
      .z_xcRSGS7{text-transform:uppercase;}
      .z_xcRSGS8{width:65px;}
      .z_xcRSGS9{overflow:hidden;}
      .z_xcRSGSa{white-space:pre;white-space:nowrap!important;}
      .z_xcRSGSb{text-overflow:ellipsis;}
      .z_xcRSGSc{word-spacing:3px;}
      .z_xcRSGSd{overflow-wrap:anywhere;}
      .z_xcRSGSe{white-space:normal;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('white-space:nowrap'))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('white-space:nowrap'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 80,
        "line": 6,
        "name": "whiteSpace",
        "source": "example/text.ts",
      }
    `)
  })

  test('text flow wraps and spaces text like native CSS in the browser', async () => {
    const output = Transform.compile({
      moduleId: 'example/text.ts',
      source: TextFlow.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const text = 'abcdefghij'

      await page.setContent(
        `<style>body{font:20px/1 monospace}${output.css}</style>${Object.entries(
          TextFlow.controls,
        )
          .map(
            ([name, control]) =>
              `<div id="${name}" class="${module[name].className}"><span>${text}</span></div><div id="${name}-control" style="${control}"><span>${text}</span></div>`,
          )
          .join(
            '',
          )}<span id="letters-measure" class="${module.letters.className}">abcd</span><span id="letters-plain">abcd</span><span id="words-measure" class="${module.words.className}">a a</span><span id="words-plain">a a</span>`,
      )

      expect(
        await page.evaluate((names) => {
          const properties = [
            'hyphens',
            'letter-spacing',
            'overflow-wrap',
            'text-align-last',
            'text-indent',
            'text-overflow',
            'text-transform',
            'white-space',
            'word-break',
            'word-spacing',
          ]

          return names.filter((name) => {
            const actual = document.getElementById(name)!
            const control = document.getElementById(`${name}-control`)!
            const style = getComputedStyle(actual)
            const expected = getComputedStyle(control)

            return (
              actual.scrollWidth !== control.scrollWidth ||
              actual.getBoundingClientRect().height !==
                control.getBoundingClientRect().height ||
              properties.some(
                (property) =>
                  style.getPropertyValue(property) !==
                  expected.getPropertyValue(property),
              )
            )
          })
        }, Object.keys(TextFlow.controls)),
      ).toMatchInlineSnapshot(`[]`)
      expect(
        await page.evaluate(() => {
          const width = (id: string) =>
            document.getElementById(id)!.getBoundingClientRect().width
          const paragraph = document.getElementById('paragraph')!
          const truncate = document.getElementById('truncate')!

          return {
            brokenHeight: document
              .getElementById('breaks')!
              .getBoundingClientRect().height,
            indent:
              paragraph.firstElementChild!.getBoundingClientRect().left -
              paragraph.getBoundingClientRect().left,
            letterSpacing: width('letters-measure') - width('letters-plain'),
            truncatedHeight: truncate.getBoundingClientRect().height,
            truncates: truncate.scrollWidth > truncate.clientWidth,
            wordSpacing: width('words-measure') - width('words-plain'),
            wrappedHeight: document
              .getElementById('wrap')!
              .getBoundingClientRect().height,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "brokenHeight": 40,
          "indent": 12,
          "letterSpacing": 8,
          "truncatedHeight": 20,
          "truncates": true,
          "wordSpacing": 3,
          "wrappedHeight": 40,
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('scroll snap preserves compound keywords, fallback importance, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/snapping.ts',
      source: Snapping.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-edge:10px;}
      .z_lahY7n0{display:flex;}
      .z_lahY7n1{gap:40px;}
      .z_lahY7n2{overflow:auto;}
      .z_lahY7n3{width:100px;}
      .z_lahY7n4{height:100px;}
      .z_lahY7n5{scroll-padding:var(--z-spacing-edge,10px);}
      .z_lahY7n6{scroll-snap-type:x proximity;scroll-snap-type:x mandatory!important;}
      .z_lahY7n7{flex-direction:column;}
      .z_lahY7n8{scroll-padding:10px;}
      .z_lahY7n9{scroll-snap-type:y mandatory;}
      .z_lahY7na{width:60px;}
      .z_lahY7nb{height:60px;}
      .z_lahY7nc{flex-shrink:0;}
      .z_lahY7nd{scroll-margin:5px;}
      .z_lahY7ne{scroll-snap-align:start;}
      .z_lahY7nf{scroll-snap-stop:normal;scroll-snap-stop:always!important;}
      .z_lahY7ng{scroll-snap-align:none center;}
      .z_lahY7nh{scroll-snap-type:both proximity;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('scroll-snap-type:x mandatory'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('scroll-snap-type:x mandatory'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 53,
        "line": 5,
        "name": "scrollSnapType",
        "source": "example/snapping.ts",
      }
    `)
  })

  test('scroll snap aligns both axes and respects always stops in the browser', async () => {
    const output = Transform.compile({
      moduleId: 'example/snapping.ts',
      source: Snapping.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const children = (props: string) =>
        Array.from({ length: 5 }, () => `<div ${props}></div>`).join('')

      await page.setContent(
        `<style>${output.css}</style>${['horizontal', 'vertical'].map((axis) => `<div id="${axis}" class="${module[axis].className}">${children(`class="${module.item.className}"`)}</div><div id="${axis}-control" style="${Snapping.controls[axis as 'horizontal' | 'vertical']}">${children(`style="${Snapping.controls.item}"`)}</div>`).join('')}<div id="pair" class="${module.pair.className}"></div>`,
      )

      expect(
        await page.evaluate(() => {
          const horizontal = document.getElementById('horizontal')!
          const vertical = document.getElementById('vertical')!
          const horizontalControl =
            document.getElementById('horizontal-control')!
          const verticalControl = document.getElementById('vertical-control')!

          horizontal.scrollTo({ left: 75, behavior: 'instant' })
          horizontalControl.scrollTo({ left: 75, behavior: 'instant' })
          vertical.scrollTo({ top: 75, behavior: 'instant' })
          verticalControl.scrollTo({ top: 75, behavior: 'instant' })

          return {
            horizontal: horizontal.scrollLeft,
            horizontalControl: horizontalControl.scrollLeft,
            vertical: vertical.scrollTop,
            verticalControl: verticalControl.scrollTop,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "horizontal": 85,
          "horizontalControl": 85,
          "vertical": 85,
          "verticalControl": 85,
        }
      `)
      expect(
        await page.evaluate(() => {
          const horizontal = document.getElementById('horizontal')!
          const control = document.getElementById('horizontal-control')!

          horizontal.scrollTo({ left: 0, behavior: 'instant' })
          control.scrollTo({ left: 0, behavior: 'instant' })
          horizontal.scrollBy({ left: 350, behavior: 'instant' })
          control.scrollBy({ left: 350, behavior: 'instant' })

          return { actual: horizontal.scrollLeft, control: control.scrollLeft }
        }),
      ).toMatchInlineSnapshot(`
        {
          "actual": 85,
          "control": 85,
        }
      `)
      expect(
        await page.locator('#pair').evaluate((element) => ({
          align: getComputedStyle(element).scrollSnapAlign,
          type: getComputedStyle(element).scrollSnapType,
        })),
      ).toMatchInlineSnapshot(`
        {
          "align": "none center",
          "type": "both",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('scroll spacing preserves token domains, priority, and source maps', () => {
    const output = Transform.compile({
      moduleId: 'example/scrolling.ts',
      source: Scrolling.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-offset:20px;--z-spacing-auto:24px;}
      .z_it1fs60{overflow:auto;}
      .z_it1fs61{height:100px;}
      .z_it1fs62{width:100px;}
      .z_it1fs63{scroll-behavior:auto;}
      .z_it1fs64{scroll-padding-top:10px;scroll-padding-top:var(--z-spacing-offset,20px);}
      .z_it1fs65{scroll-padding-inline:auto;}
      .z_it1fs66{overscroll-behavior:auto;overscroll-behavior:contain!important;}
      .z_it1fs67{overscroll-behavior-x:none;}
      .z_it1fs68{scroll-margin-top:10px;}
      .z_it1fs69{height:20px;}
      .z_it1fs6a{scroll-padding-top:var(--z-spacing-auto,24px);}
      .z_it1fs6b{scroll-padding-block-start:var(--z-spacing-offset,20px)!important;}
      .z_it1fs6c{scroll-behavior:smooth;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('scroll-padding-top:var('),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('scroll-padding-top:var('),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 35,
        "line": 5,
        "name": "scrollPaddingTop",
        "source": "example/scrolling.ts",
      }
    `)
  })

  test('scroll spacing offsets scroll-into-view in the browser', async () => {
    const output = Transform.compile({
      moduleId: 'example/scrolling.ts',
      source: Scrolling.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const contents = (target: string) =>
        `<div style="height:300px"></div><div ${target}></div><div style="height:300px"></div>`

      await page.setContent(
        `<style>${output.css}</style><div id="actual" class="${module.container.className}">${contents(`class="${module.target.className}"`)}</div><div id="control" style="overflow:auto;height:100px;width:100px;scroll-padding-top:20px;scroll-behavior:auto">${contents('style="scroll-margin-top:10px;height:20px"')}</div><div id="smooth" class="${module.smooth.className}" style="overflow:auto;height:100px"><div style="height:500px"></div></div>`,
      )

      expect(
        await page.evaluate(() => {
          const actual = document.getElementById('actual')!
          const control = document.getElementById('control')!

          actual.children[1]!.scrollIntoView({ block: 'start' })
          control.children[1]!.scrollIntoView({ block: 'start' })

          const style = getComputedStyle(actual)

          return {
            actual: actual.scrollTop,
            control: control.scrollTop,
            overscrollX: style.overscrollBehaviorX,
            overscrollY: style.overscrollBehaviorY,
            paddingInline: style.scrollPaddingInline,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "actual": 270,
          "control": 270,
          "overscrollX": "contain",
          "overscrollY": "contain",
          "paddingInline": "auto",
        }
      `)

      await page
        .locator('#smooth')
        .evaluate((element) => element.scrollTo({ top: 100 }))
      await page.waitForFunction(
        () => document.getElementById('smooth')!.scrollTop === 100,
        undefined,
        { timeout: 5000 },
      )

      expect(
        await page.locator('#smooth').evaluate((element) => ({
          behavior: getComputedStyle(element).scrollBehavior,
          position: element.scrollTop,
        })),
      ).toMatchInlineSnapshot(`
        {
          "behavior": "smooth",
          "position": 100,
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('intrinsic sizing preserves keyword precedence, explicit tokens, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/sizing.ts',
      source: Sizing.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-min_2d_content:24px;--z-spacing-narrow:40px;}
      .z_tWUOQH0{inline-size:min-content;}
      .z_tWUOQH1{inline-size:max-content;}
      .z_tWUOQH2{inline-size:100%;inline-size:fit-content!important;}
      .z_tWUOQH3{min-width:auto;}
      .z_tWUOQH4{max-width:none;}
      .z_tWUOQH5{width:var(--z-spacing-min_2d_content,24px);}
      .z_tWUOQH6{min-inline-size:var(--z-spacing-narrow,40px);}
      .z_tWUOQH7{max-inline-size:max-content;}
      .z_tWUOQH8{block-size:fit-content;}
      .z_tWUOQH9{min-block-size:auto;}
      .z_tWUOQHa{max-block-size:none;}
      .z_tWUOQHb{flex-basis:content;}
      .z_tWUOQHc{width:5px;}
      .z_tWUOQHd{flex-shrink:0;}
      .z_tWUOQHe{min-width:0;}
      .z_tWUOQHf{flex-basis:auto;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('inline-size:fit-content'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('inline-size:fit-content'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 45,
        "line": 5,
        "name": "inlineSize",
        "source": "example/sizing.ts",
      }
    `)
  })

  test('intrinsic sizing and flex content resolve native browser widths', async () => {
    const output = Transform.compile({
      moduleId: 'example/sizing.ts',
      source: Sizing.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const content =
        '<span style="display:inline-block;width:40px;height:10px"></span><wbr><span style="display:inline-block;width:40px;height:10px"></span>'

      await page.setContent(
        `<style>${output.css}</style><main style="width:60px">${['minimum', 'maximum', 'fit'].map((name) => `<div id="${name}" class="${module[name].className}">${content}</div>`).join('')}<div id="explicit" class="${module.explicit.className}"></div></main><section style="display:flex;width:200px"><div id="content" class="${module.content.className}">${content}</div><div id="automatic" class="${module.automatic.className}">${content}</div></section>`,
      )

      expect(
        await page.evaluate(() =>
          Object.fromEntries(
            [
              'minimum',
              'maximum',
              'fit',
              'explicit',
              'content',
              'automatic',
            ].map((id) => [
              id,
              document.getElementById(id)!.getBoundingClientRect().width,
            ]),
          ),
        ),
      ).toMatchInlineSnapshot(`
        {
          "automatic": 5,
          "content": 80,
          "explicit": 24,
          "fit": 60,
          "maximum": 80,
          "minimum": 40,
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('border source tokens and mixed physical/logical priority render in the browser', async () => {
    const output = Transform.compile({
      moduleId: 'example/borders.ts',
      source: Borders.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>div{width:100px;height:100px}${output.css}</style><main><div id="box" class="${module.box.className}"></div><div id="control" style="border-style:solid;border-width:2px;border-left-width:3px;border-inline-start-width:4px;border-inline-start-width:5px!important;border-color:#06c;border-inline-end-color:#fff;border-radius:8px;border-start-start-radius:10px;outline-color:#fff;outline-style:dashed;outline-width:2px;outline-offset:-1px"></div></main>`,
      )

      for (const writingMode of ['horizontal-tb', 'vertical-rl', 'vertical-lr'])
        for (const direction of ['ltr', 'rtl']) {
          await page.locator('main').evaluate(
            (element, values) => {
              element.style.writingMode = values.writingMode
              element.style.direction = values.direction
            },
            { writingMode, direction },
          )

          expect(
            await page.evaluate(() => {
              const actual = getComputedStyle(document.getElementById('box')!)
              const expected = getComputedStyle(
                document.getElementById('control')!,
              )

              return [
                'border-top-width',
                'border-left-width',
                'border-bottom-width',
                'border-right-width',
                'border-top-color',
                'border-left-color',
                'border-bottom-color',
                'border-right-color',
                'border-top-left-radius',
                'border-top-right-radius',
                'border-bottom-left-radius',
                'border-bottom-right-radius',
                'outline-color',
                'outline-width',
                'outline-style',
                'outline-offset',
              ].filter(
                (property) =>
                  actual.getPropertyValue(property) !==
                  expected.getPropertyValue(property),
              )
            }),
          ).toMatchInlineSnapshot(`[]`)
        }
    } finally {
      await browser.close()
    }
  })

  test('border tokens, priority, and per-entry source maps survive compilation', () => {
    const output = Transform.compile({
      moduleId: 'example/borders.ts',
      source: Borders.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-borderColor-brand:#06c;--z-color-brand:#fff;--z-radius-round:8px;}
      .z_2em1cQ0{border-style:solid;}
      .z_2em1cQ1{border-width:2px;}
      .z_2em1cQ2{border-left-width:3px;}
      .z_2em1cQ3{border-inline-start-width:4px;border-inline-start-width:5px!important;}
      .z_2em1cQ4{border-color:var(--z-borderColor-brand,#06c);}
      .z_2em1cQ5{border-inline-end-color:var(--z-color-brand,#fff);}
      .z_2em1cQ6{border-radius:var(--z-radius-round,8px);}
      .z_2em1cQ7{border-start-start-radius:10px;}
      .z_2em1cQ8{outline-color:var(--z-color-brand,#fff);}
      .z_2em1cQ9{outline-style:dashed;}
      .z_2em1cQa{outline-width:2px;}
      .z_2em1cQb{outline-offset:-1px;}
      .z_2em1cQc{border-width:2px;}
      .z_2em1cQd{border-inline-start-width:5px;}
      .z_2em1cQe{border-left-width:3px;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) =>
      line.includes('border-inline-start-width:5px'),
    )

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('border-inline-start-width:5px'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 92,
        "line": 4,
        "name": "borderInlineStartWidth",
        "source": "example/borders.ts",
      }
    `)
  })

  test('flex sizing and overflow preserve tokens, importance, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/flex.ts',
      source: Flex.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-item:60px;}
      .z_MhD43s0{display:flex;}
      .z_MhD43s1{flex-wrap:wrap;}
      .z_MhD43s2{width:180px;}
      .z_MhD43s3{height:100px;}
      .z_MhD43s4{align-content:space-between;}
      .z_MhD43s5{align-items:flex-start;}
      .z_MhD43s6{flex-basis:40px;flex-basis:var(--z-spacing-item,60px);}
      .z_MhD43s7{flex-grow:0;}
      .z_MhD43s8{flex-shrink:0;}
      .z_MhD43s9{height:20px;}
      .z_MhD43sa{align-self:flex-end;}
      .z_MhD43sb{order:-1!important;}
      .z_MhD43sc{width:40px;}
      .z_MhD43sd{height:40px;}
      .z_MhD43se{overflow:hidden;overflow:clip!important;}
      .z_MhD43sf{overflow-x:visible;}
      .z_MhD43sg{overflow-x:clip;}
      .z_MhD43sh{overflow:hidden;}
      .z_MhD43si{overflow-y:scroll;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('flex-basis:var('))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('flex-basis:var('),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 58,
        "line": 4,
        "name": "flexBasis",
        "source": "example/flex.ts",
      }
    `)
  })

  test('flex sizing, line alignment, and overflow match native browser layout', async () => {
    const output = Transform.compile({
      moduleId: 'example/flex.ts',
      source: Flex.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()
      const children = (item: string) =>
        `<div style="width:60px;height:40px;flex-shrink:0"></div><div ${item}></div><div style="width:60px;height:20px;flex-shrink:0"></div><div style="width:60px;height:20px;flex-shrink:0"></div>`

      await page.setContent(
        `<style>${output.css}</style><main id="actual" class="${module.container.className}">${children(`class="${module.item.className}"`)}</main><main id="expected" style="display:flex;flex-wrap:wrap;width:180px;height:100px;align-content:space-between;align-items:flex-start">${children('style="flex-basis:60px;flex-grow:0;flex-shrink:0;height:20px;align-self:flex-end;order:-1!important"')}</main><div id="clip" class="${module.clip.className}"><div style="width:200px;height:200px"></div></div><div id="scroll" class="${module.scroll.className}"><div style="width:200px;height:200px"></div></div>`,
      )

      expect(
        await page.evaluate(() => {
          const layout = (id: string) => {
            const parent = document.getElementById(id)!
            const origin = parent.getBoundingClientRect()

            return Array.from(parent.children, (child) => {
              const box = child.getBoundingClientRect()

              return {
                height: box.height,
                width: box.width,
                x: box.x - origin.x,
                y: box.y - origin.y,
              }
            })
          }

          return (
            JSON.stringify(layout('actual')) ===
            JSON.stringify(layout('expected'))
          )
        }),
      ).toMatchInlineSnapshot(`true`)
      expect(
        await page.locator('#actual').evaluate((parent) => {
          const child = parent.children[1]!
          const box = child.getBoundingClientRect()
          const origin = parent.getBoundingClientRect()

          return {
            height: box.height,
            width: box.width,
            x: box.x - origin.x,
            y: box.y - origin.y,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "height": 20,
          "width": 60,
          "x": 0,
          "y": 20,
        }
      `)
      expect(
        await page.locator('#clip').evaluate((element) => {
          element.scrollTop = 10

          const style = getComputedStyle(element)

          return {
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            scrollTop: element.scrollTop,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "overflowX": "clip",
          "overflowY": "clip",
          "scrollTop": 0,
        }
      `)
      expect(
        await page.locator('#scroll').evaluate((element) => {
          element.scrollTop = 10

          const style = getComputedStyle(element)

          return {
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            scrollTop: element.scrollTop,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "overflowX": "hidden",
          "overflowY": "scroll",
          "scrollTop": 10,
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('logical boxes preserve tokens, importance, and fallback source maps', () => {
    const output = Transform.compile({
      moduleId: 'example/logical.ts',
      source: Logical.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-space:12px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_i9aFWE0{width:60px;}
      .z_i9aFWE1{inline-size:70px;inline-size:80px!important;}
      .z_i9aFWE2{block-size:40px;}
      .z_i9aFWE3{padding-left:2px;}
      .z_i9aFWE4{padding-inline-start:4px;padding-inline-start:var(--z-spacing-space,12px);}
      .z_i9aFWE5{margin-inline-end:var(--z-spacing-space,12px)!important;}
      .z_i9aFWE6{position:relative;}
      .z_i9aFWE7{inset-inline-start:-3px;}
      .z_i9aFWE8{inline-size:30px;}
      .z_i9aFWE9{width:50px;}
      .z_i9aFWEa{padding-inline-start:6px;}
      .z_i9aFWEb{padding-left:8px;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('inline-size:80px'))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('inline-size:80px'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 50,
        "line": 4,
        "name": "inlineSize",
        "source": "example/logical.ts",
      }
    `)
  })

  test('logical boxes render inherited writing modes and scope overrides in the browser', async () => {
    const output = Transform.compile({
      moduleId: 'example/logical.ts',
      source: Logical.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${output.css}</style><main style="writing-mode:horizontal-tb;direction:ltr"><div id="box" class="${module.logical.className}"></div><div id="control" style="width:60px;inline-size:70px;inline-size:80px!important;block-size:40px;padding-left:2px;padding-inline-start:4px;padding-inline-start:12px;margin-inline-end:12px!important;position:relative;inset-inline-start:-3px"></div><div id="physical" class="${module.physical.className}"></div><div id="physical-control" style="inline-size:30px;width:50px;padding-inline-start:6px;padding-left:8px"></div></main>`,
      )

      for (const writingMode of [
        'horizontal-tb',
        'vertical-rl',
        'vertical-lr',
      ]) {
        for (const direction of ['ltr', 'rtl']) {
          await page.locator('main').evaluate(
            (element, values) => {
              element.style.writingMode = values.writingMode
              element.style.direction = values.direction
            },
            { writingMode, direction },
          )

          expect(
            await page.evaluate(() => {
              const properties = [
                'width',
                'height',
                'padding-left',
                'padding-right',
                'padding-top',
                'padding-bottom',
                'margin-left',
                'margin-right',
                'margin-top',
                'margin-bottom',
                'left',
                'right',
                'top',
                'bottom',
              ]

              return [
                ['box', 'control'],
                ['physical', 'physical-control'],
              ].flatMap(([actual, expected]) => {
                const a = getComputedStyle(document.getElementById(actual!)!)
                const b = getComputedStyle(document.getElementById(expected!)!)

                return properties
                  .filter(
                    (property) =>
                      a.getPropertyValue(property) !==
                      b.getPropertyValue(property),
                  )
                  .map((property) => ({
                    actual: a.getPropertyValue(property),
                    expected: b.getPropertyValue(property),
                    property,
                  }))
              })
            }),
          ).toMatchInlineSnapshot(`[]`)
        }
      }

      await page.locator('main').evaluate((element, scope) => {
        element.setAttribute('class', scope)
      }, module.scope)
      // A scope edit must update both the shorthand and explicit reference.
      await page.addStyleTag({
        content: `.${module.scope}{${output.css.match(/--[^:]+(?=:12px)/)![0]}:20px;}`,
      })

      expect(
        await page.locator('#box').evaluate((element) => {
          const style = getComputedStyle(element)

          return {
            marginInlineEnd: style.marginInlineEnd,
            paddingInlineStart: style.paddingInlineStart,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "marginInlineEnd": "20px",
          "paddingInlineStart": "20px",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('important zero shorthands retain token identity before literal coercion', () => {
    const output = Transform.compile({
      moduleId: 'zero.ts',
      source:
        "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz';\nconst theme = Vars.define({spacing:{0:'8px'}}); const themeConfig=Config.create({vars:theme});\nexport const token = themeConfig.style({padding:'0 !important'})();\nexport const literal = style({padding:'0 !important'})();\nexport const plain = themeConfig.style({padding:0})();",
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-0:8px;}
      .z_WUKCte0{padding:var(--z-spacing-0,8px)!important;}
      .z_WUKCte1{padding:0!important;}
      .z_WUKCte2{padding:var(--z-spacing-0,8px);}"
    `)
  })

  test('asserted fallback arrays retain token references and entry source maps', () => {
    const output = Transform.compile({
      moduleId: 'assertions.ts',
      source:
        "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme});\nexport const props = themeConfig.style({\n  display: ['block','flex'] as const,\n  color: ((['#000 !custom',theme.color.brand] as const) satisfies readonly unknown[])!,\n})();",
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_viRWul0{display:block;display:flex;}
      .z_viRWul1{color:#000;color:var(--z-color-brand,#06c);}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('color:var('))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('color:var('),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 27,
        "line": 6,
        "name": "color",
        "source": "assertions.ts",
      }
    `)
  })

  test('standard lengths preserve source spelling, token fallbacks, and maps', () => {
    const output = Transform.compile({
      moduleId: 'example/lengths.ts',
      source: Lengths.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-space:1lh;}
      .z_GgEBF40{width:50vw;width:50cqi!important;}
      .z_GgEBF41{height:10dvh;}
      .z_GgEBF42{margin-left:-1in;}
      .z_GgEBF43{border-width:1pc;}
      .z_GgEBF44{border-style:solid;}
      .z_GgEBF45{padding:1rem;padding:var(--z-spacing-space,1lh);}
      .z_GgEBF46{margin-top:2rlh!important;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('width:50cqi'))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('width:50cqi'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 41,
        "line": 3,
        "name": "width",
        "source": "example/lengths.ts",
      }
    `)
  })

  test('standard lengths resolve against browser viewport, container, and font metrics', async () => {
    const output = Transform.compile({
      moduleId: 'example/lengths.ts',
      source: Lengths.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
      })

      await page.setContent(
        `<style>html{font-size:16px;line-height:24px}main{container-type:size;width:400px;height:300px;line-height:30px}${output.css}</style><main><div id="root" class="${module.root.className}"></div><div id="themed" class="${module.themed.className}"></div></main>`,
      )

      expect(
        await page.locator('#root').evaluate((element) => {
          const style = getComputedStyle(element)

          return {
            borderWidth: style.borderTopWidth,
            height: style.height,
            marginLeft: style.marginLeft,
            width: style.width,
          }
        }),
      ).toMatchInlineSnapshot(`
        {
          "borderWidth": "16px",
          "height": "60px",
          "marginLeft": "-96px",
          "width": "200px",
        }
      `)
      expect(
        await page.locator('#themed').evaluate((element) => {
          const style = getComputedStyle(element)

          return { marginTop: style.marginTop, padding: style.paddingTop }
        }),
      ).toMatchInlineSnapshot(`
        {
          "marginTop": "48px",
          "padding": "30px",
        }
      `)
    } finally {
      await browser.close()
    }
  })

  test('importance syntax cannot collide with theme token names', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/reserved.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({spacing:{md:'4px','md!':'8px'}}); const themeConfig=Config.create({vars:theme});\nexport const props = themeConfig.style({padding:'md!'})();",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/reserved.ts:72: ["spacing","md!"]: Expected a nonempty variable key without importance or conditions.]`,
    )
    expect(() =>
      Transform.compile({
        moduleId: 'example/reserved-config.ts',
        source:
          "import { Config } from 'zyzz';\nconst zyzz = Config.create({vars:{spacing:{'nested!':{md:'8px'}}}});\nexport const props = zyzz.style({padding:'nested!.md'})();",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/reserved-config.ts:44: ["spacing","nested!"]: Expected a nonempty variable key without importance or conditions.]`,
    )
  })

  test('fractional numeric variable keys resolve as tokens and references', () => {
    const output = Transform.compile({
      moduleId: 'example/fractional.ts',
      source:
        "import { defineConfig } from 'zyzz';\nconst { style, vars } = defineConfig({vars:{spacing:{0:'0px',0.5:'2px',2.5:'10px'}}});\nexport const props = style({gap:2.5,margin:vars.spacing[0.5],padding:vars.spacing['0']})();",
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-2-5:10px;--z-spacing-0-5:2px;--z-spacing-0:0px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_OyLMsc0{gap:var(--z-spacing-2-5,10px);}
      .z_OyLMsc1{margin:var(--z-spacing-0-5,2px);}
      .z_OyLMsc2{padding:var(--z-spacing-0,0px);}"
    `)
  })

  test('dotted variable categories and colliding paths report their path', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/dotted-category.ts',
        source:
          "import { defineConfig } from 'zyzz';\nconst { style } = defineConfig({vars:{'spacing.x':'2px'}});\nexport const props = style({gap:'x'})();",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/dotted-category.ts:55: ["spacing.x"]: Variable categories and typography keys cannot contain dots.]`,
    )
    expect(() =>
      Transform.compile({
        moduleId: 'example/colliding.ts',
        source:
          "import { defineConfig } from 'zyzz';\nconst { style } = defineConfig({vars:{spacing:{'0.5':'2px',0:{5:'4px'}}}});\nexport const props = style({gap:0.5})();",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/colliding.ts:55: ["spacing","0.5"]: Variable paths must join to distinct names.]`,
    )
    expect(() =>
      Transform.compile({
        moduleId: 'example/dotted-weight.ts',
        source:
          "import { defineConfig } from 'zyzz';\nconst { style } = defineConfig({vars:{fontWeight:{'medium.5':'500'}}});\nexport const props = style({fontWeight:'medium.5'})();",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/dotted-weight.ts:55: Font weight token fontWeight.medium.5 must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )
  })

  test('fallback declarations retain importance, token identity, and element source maps', () => {
    const output = Transform.compile({
      moduleId: 'example/fallbacks.ts',
      source: Declarations.source,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_wjwnAQ0{color:#000;color:var(--z-color-brand,#06c);color:var(--z-color-brand,#06c)!important;}
      .z_wjwnAQ1{display:block;display:flex;}
      .z_wjwnAQ2{opacity:0.25!important;opacity:0.75;}
      .z_wjwnAQ3{padding:4px!important;padding:8px;}
      .z_wjwnAQ4{padding-left:12px;}
      .z_wjwnAQ5{color:#fff;}
      .z_wjwnAQ6{padding:20px;}"
    `)

    const lines = output.css.split('\n')
    const line = lines.findIndex((line) => line.includes('color:var('))

    expect(
      Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
        line: line + 1,
        column: lines[line]!.indexOf('color:var('),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 26,
        "line": 7,
        "name": "color",
        "source": "example/fallbacks.ts",
      }
    `)
  })

  test('fallback order and importance select browser styles with inherited tokens', async () => {
    const output = Transform.compile({
      moduleId: 'example/fallbacks.ts',
      source: Declarations.source,
    })
    const js = await Esbuild.build({
      stdin: { contents: output.code, loader: 'ts', resolveDir: root },
      bundle: true,
      conditions: ['src'],
      format: 'esm',
      write: false,
    }).then((result) => ({ code: result.outputFiles[0]!.text }))
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
    )
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${output.css}</style><main class="${module.scope}"><div id="card" class="${module.props.className} ${module.later.className}"></div></main>`,
      )

      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).opacity),
      ).toMatchInlineSnapshot(`"0.25"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).paddingLeft),
      ).toMatchInlineSnapshot(`"4px"`)
      expect(
        await page
          .locator('#card')
          .evaluate((element) => getComputedStyle(element).display),
      ).toMatchInlineSnapshot(`"flex"`)
    } finally {
      await browser.close()
    }
  })

  test('explicit token paths compile through bound aliases with defining fallbacks', async () => {
    const result = Transform.compile({
      moduleId: 'example/tokens.ts',
      source:
        "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({ color: { transparent: '#06c', palette: { 500: '#123' } }, spacing: { 0: '8px', 4: '16px' } }); const themeConfig=Config.create({vars:theme});\nconst alternate = Vars.extend(theme, { color: { transparent: '#175', palette: { 500: '#456' } } }); const alternateConfig=Config.create({vars:alternate});\nconst { style } = themeConfig;\nexport const scope = alternateConfig.vars().className;\nexport const props = style({ color: theme.color.transparent, borderColor: (theme.color.palette['500']!), padding: theme.spacing[0] })();\n",
    })

    expect(result.code).toMatchInlineSnapshot(`
      "
      import { Selection as __zyzzSelection } from 'zyzz/runtime';


      const theme = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "transparent":"#06c";readonly "palette":{readonly 500:"#123"}};readonly "spacing":{readonly 0:"8px";readonly 4:"16px"}}>); const themeConfig=({} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "transparent":"#06c";readonly "palette":{readonly "500":"#123"}};readonly "spacing":{readonly "0":"8px";readonly "4":"16px"}}}>);
      const alternate = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "transparent":"#06c";readonly "palette":{readonly 500:"#123"}};readonly "spacing":{readonly 0:"8px";readonly 4:"16px"}}>); const alternateConfig=({vars:__zyzzSelection.create([["default","z-theme-theme"]],false,'set',"default")} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "transparent":"#175";readonly "palette":{readonly "500":"#456"}};readonly "spacing":{readonly "0":"8px";readonly "4":"16px"}}}>);
      const { style } = (themeConfig as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "transparent":"#06c";readonly "palette":{readonly "500":"#123"}};readonly "spacing":{readonly "0":"8px";readonly "4":"16px"}}}>);
      export const scope = alternateConfig.vars().className;
      export const props = ({className:"z_tVIWWz0 z_tVIWWz1 z_tVIWWz2"});
      "
    `)
    expect(result.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-transparent:#06c;--z-color-palette-500:#123;--z-spacing-0:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_tVIWWz0{color:var(--z-color-transparent,#06c);}
      .z_tVIWWz1{border-color:var(--z-color-palette-500,#123);}
      .z_tVIWWz2{padding:var(--z-spacing-0,8px);}"
    `)

    const output = await Esbuild.build({
      bundle: true,
      format: 'cjs',
      metafile: true,
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })

    expect(output.metafile!.outputs['stdin.js']!.imports).toMatchInlineSnapshot(
      `[]`,
    )

    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-tokens-'))

    try {
      const path = Path.join(directory, 'module.cjs')

      await Fs.writeFile(path, output.outputFiles[0]!.text)

      const executed = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          '-e',
          `console.log(JSON.stringify(require(${JSON.stringify(path)}).props))`,
        ],
      )

      expect(executed.stdout).toMatchInlineSnapshot(`
        "{"className":"z_tVIWWz0 z_tVIWWz1 z_tVIWWz2"}
        "
      `)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }

    const map = new Trace.TraceMap(result.cssMap)
    const lines = result.css.split('\n')
    const line = lines.findIndex((value) => value.includes('color:var('))

    expect(
      Trace.originalPositionFor(map, {
        line: line + 1,
        column: lines[line]!.indexOf('color:'),
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 29,
        "line": 7,
        "name": "color",
        "source": "example/tokens.ts",
      }
    `)
  })

  test('explicit token diagnostics reject dynamic paths', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color[key] });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Token paths require static property names without optional access.]`,
    )
  })

  test('explicit token diagnostics reject unknown paths', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color.missing });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Unknown theme token path.]`,
    )
  })

  test('explicit token diagnostics reject palette references', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Expected a scalar theme token reference.]`,
    )
  })

  test('explicit token diagnostics reject escaping tokens', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import { Config, style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); export const value = theme.color.brand;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:116: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('explicit token diagnostics reject root style tokens', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import { Config, style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); style({ color: theme.color.brand });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:110: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('explicit token diagnostics reject token expressions', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color.brand + '' });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('explicit token diagnostics reject token writes', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import { Config, style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); theme.color.brand = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:95: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('explicit token diagnostics reject optional tokens', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color?.brand });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Token paths require static property names without optional access.]`,
    )
  })

  test('explicit token diagnostics reject token metadata', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/tokens.ts',
        source:
          "import {Config} from 'zyzz';\nimport { style, Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({ color: theme.color.brand.value });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/tokens.ts:190: Unknown theme token path.]`,
    )
  })

  test('local themes compile to scope constants and executable token styles', async () => {
    const source =
      "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({ color: { brand: { dark: '#fff', light: '#000' } }, spacing: { 1: '4px', md: '8px' } }); const themeConfig=Config.create({vars:theme});\nconst alternate = Vars.extend(theme, { color: { brand: '#f00' } }); const alternateConfig=Config.create({vars:alternate});\nexport type Brand = typeof theme.color.brand;\nexport const scope = alternateConfig.vars().className;\nexport const props = themeConfig.style({ color: 'brand', padding: 'md' })();"

    const result = Transform.compile({ moduleId: 'example/theme.ts', source })

    const bundle = await Esbuild.build({
      bundle: true,
      format: 'esm',
      metafile: true,
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })

    expect(result.code).toMatchInlineSnapshot(`
      "
      import { Selection as __zyzzSelection } from 'zyzz/runtime';


      const theme = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":{readonly "dark":"#fff";readonly "light":"#000"}};readonly "spacing":{readonly 1:"4px";readonly "md":"8px"}}>); const themeConfig=({} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":{readonly "light":"#000";readonly "dark":"#fff"}};readonly "spacing":{readonly "1":"4px";readonly "md":"8px"}}}>);
      const alternate = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":{readonly "dark":"#fff";readonly "light":"#000"}};readonly "spacing":{readonly 1:"4px";readonly "md":"8px"}}>); const alternateConfig=({vars:__zyzzSelection.create([["default","z-theme-theme"]],false,'set',"default")} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#f00"};readonly "spacing":{readonly "1":"4px";readonly "md":"8px"}}}>);
      export type Brand = typeof theme.color.brand;
      export const scope = alternateConfig.vars().className;
      export const props = ({className:"z_pXWEgW0 z_pXWEgW1"});"
    `)
    expect(result.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:light-dark(#000,#fff);--z-spacing-md:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_pXWEgW0{color:var(--z-color-brand,light-dark(#000,#fff));}
      .z_pXWEgW1{padding:var(--z-spacing-md,8px);}"
    `)
    expect(result.vars).toMatchInlineSnapshot(`
      {
        "src-theme-bdnuEpXWEgW-alternate": "z-theme-alternate",
        "src-theme-bdnuEpXWEgW-alternateConfig-theme": "z-theme-theme",
        "src-theme-bdnuEpXWEgW-theme": "z-theme-theme",
        "src-theme-bdnuEpXWEgW-themeConfig-theme": "z-theme-theme",
      }
    `)
    expect(bundle.metafile!.outputs['stdin.js']!.imports).toMatchInlineSnapshot(
      `[]`,
    )
    expect(
      bundle.outputFiles[0]!.text.includes('Vars.define'),
    ).toMatchInlineSnapshot('false')

    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-theme-types-'))

    try {
      const file = Path.join(directory, 'theme.ts')

      await Fs.writeFile(
        file,
        `${result.code}\nthemeConfig.style({ padding: 1 });\n// @ts-expect-error The numeric token 2 is undeclared.\nthemeConfig.style({ padding: 2 });`,
      )

      const checked = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          Path.join(root, 'node_modules/typescript/bin/tsc'),
          '--ignoreConfig',
          '--customConditions',
          'src',
          '--module',
          'NodeNext',
          '--noEmit',
          '--skipLibCheck',
          '--strict',
          '--target',
          'ES2022',
          file,
        ],
        { timeout: 30_000 },
      ).catch((error: Error & { stdout?: string }) => {
        throw new Error(error.stdout || error.message)
      })

      expect(checked.stdout).toMatchInlineSnapshot('""')
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }

    const map = new Trace.TraceMap(result.cssMap)
    const lines = result.css.split('\n')
    const line = lines.findIndex((value) => value.includes('color:var('))

    expect(
      Trace.originalPositionFor(map, {
        column: lines[line]!.indexOf('color:'),
        line: line + 1,
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 41,
        "line": 7,
        "name": "color",
        "source": "example/theme.ts",
      }
    `)
    expect(
      Trace.originalPositionFor(map, {
        column: 0,
        line: lines.findIndex((line) => line.startsWith('.z-theme-')) + 1,
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 90,
        "line": 4,
        "name": "src-theme-bdnuEpXWEgW-alternateConfig-theme",
        "source": "example/theme.ts",
      }
    `)
  }, 35_000)

  test('theme identity survives value edits and preceding unrelated definitions', () => {
    const source =
      "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); export const scope = themeConfig.vars().className; export const props = themeConfig.style({ color: 'brand' })();"
    const original = Transform.compile({ moduleId: 'example/theme.ts', source })
    const changed = Transform.compile({
      moduleId: 'example/theme.ts',
      source: source.replace("'#000'", "'#fff'"),
    })

    const inserted = Transform.compile({
      moduleId: 'example/theme.ts',
      source: source.replace(
        'const theme',
        "const other = Vars.define({ spacing: { sm: '4px' } }); const theme",
      ),
    })

    const separate = Transform.compile({ moduleId: 'another/theme.ts', source })

    expect(original.vars).toMatchInlineSnapshot(`
      {
        "src-theme-bdnuEpXWEgW-theme": "z-theme-theme",
        "src-theme-bdnuEpXWEgW-themeConfig-theme": "z-theme-theme",
      }
    `)
    expect(changed.vars).toMatchInlineSnapshot(`
      {
        "src-theme-bdnuEpXWEgW-theme": "z-theme-theme",
        "src-theme-bdnuEpXWEgW-themeConfig-theme": "z-theme-theme",
      }
    `)
    expect(inserted.vars).toMatchInlineSnapshot(`
      {
        "src-theme-bdnuEpXWEgW-other": "z-theme-other",
        "src-theme-bdnuEpXWEgW-theme": "z-theme-theme",
        "src-theme-bdnuEpXWEgW-themeConfig-theme": "z-theme-theme",
      }
    `)
    expect(separate.vars).toMatchInlineSnapshot(`
      {
        "src-theme-8Q0wokpYm5p-theme": "z-theme-theme",
        "src-theme-8Q0wokpYm5p-themeConfig-theme": "z-theme-theme",
      }
    `)
    expect(original.css.match(/--z-color-brand/g)).toMatchInlineSnapshot(`
      [
        "--z-color-brand",
        "--z-color-brand",
      ]
    `)
    expect(changed.css.match(/--z-color-brand/g)).toMatchInlineSnapshot(`
      [
        "--z-color-brand",
        "--z-color-brand",
      ]
    `)
    expect(inserted.css.match(/--z-color-brand/g)).toMatchInlineSnapshot(`
      [
        "--z-color-brand",
        "--z-color-brand",
      ]
    `)
  })

  test.each(['direct', 'member', 'destructured', 'tokens'] as const)(
    'local themed callables preserve overrides, scope inheritance, and schemes in Chromium: %s',
    async (kind) => {
      const alias = (() => {
        if (kind === 'member') {
          return 'const style = theme.style;'
        }

        if (kind === 'destructured') {
          return 'const { style } = theme;'
        }

        return ''
      })()

      const source = `import { Config, Vars } from 'zyzz';
const base = Vars.define({ color: { brand: { dark: '#fff', light: '#000' } }, spacing: { md: '8px' } });
const alternate = Vars.extend(base, { color: { brand: '#f00' } });
const theme = Config.create({vars:{base,alternate},defaultVars:'base'});
export const alternateScope = theme.vars({set:'alternate'}).className;
export const baseScope = theme.vars().className;
${alias}
export const button = ${kind === 'direct' || kind === 'tokens' ? 'theme.style' : 'style'}(${kind === 'tokens' ? '{ color: theme.vars.color.brand, padding: theme.vars.spacing.md }' : "{ color: 'brand', padding: 'md' }"});`

      const result = Transform.compile({ moduleId: 'example/theme.ts', source })

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
        bundle: true,
        format: 'iife',
        globalName: 'Fixture',
        metafile: true,
        stdin: { contents: result.code, loader: 'ts', resolveDir: root },
        write: false,
      })

      expect(
        Object.keys(bundle.metafile!.inputs).some((path) =>
          /Theme\.ts|compiler\//.test(path),
        ),
      ).toMatchInlineSnapshot('false')

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          '<section id="scope"><button id="button">Continue</button></section>',
        )
        await page.addStyleTag({ content: result.css })
        await page.addScriptTag({ content: bundle.outputFiles[0]!.text })

        const rendered = await page.evaluate(() => {
          const fixture = (
            window as unknown as {
              Fixture: {
                alternateScope: string
                baseScope: string
                button: (options: { className: string }) => {
                  className: string
                }
              }
            }
          ).Fixture

          const scope = document.querySelector<HTMLElement>('#scope')!
          const button = document.querySelector<HTMLElement>('#button')!

          button.className = fixture.button({ className: 'external' }).className

          const values: string[] = []

          for (const name of ['', fixture.alternateScope, fixture.baseScope]) {
            scope.className = name

            for (const scheme of ['light', 'dark']) {
              scope.style.colorScheme = scheme
              values.push(getComputedStyle(button).color)
            }
          }

          return values
        })

        expect(rendered).toMatchInlineSnapshot(`
          [
            "rgb(0, 0, 0)",
            "rgb(255, 255, 255)",
            "rgb(255, 0, 0)",
            "rgb(255, 0, 0)",
            "rgb(0, 0, 0)",
            "rgb(255, 255, 255)",
          ]
      `)
        expect(
          await page
            .locator('#button')
            .evaluate((element) => element.classList.contains('external')),
        ).toMatchInlineSnapshot('true')
        expect(
          await page
            .locator('#button')
            .evaluate((element) => getComputedStyle(element).padding),
        ).toMatchInlineSnapshot('"8px"')
      } finally {
        await browser.close()
      }
    },
  )

  test('JavaScript theme modules remain JavaScript and shadowed factories remain untouched', async () => {
    const source =
      "import { Config, Vars as T } from 'zyzz'; const values = T.define({ color: { brand: '#000' } }); const theme = Config.create({vars:values}); export const props = theme.style({ color: 'brand' })(); export function other(T) { return T.define({ arbitrary: true }); }"
    const result = Transform.compile({ moduleId: 'example/theme.js', source })
    const transformed = await Esbuild.transform(result.code, { loader: 'js' })

    expect(transformed.code).toMatchInlineSnapshot(`
      "import { Vars as T } from "zyzz";
      const values = {};
      const theme = {};
      export const props = { className: "z_hXWEpA0" };
      export function other(T2) {
        return T2.define({ arbitrary: true });
      }
      "
    `)
  })

  test('exported theme objects require linking instead of losing their authoring contract', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import { Vars } from 'zyzz'; export const theme = Vars.define({ color: { brand: '#000' } });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:42: Define local themes with a module-level const; exported themes require source linking.]`,
    )
  })

  test('theme expressions are rejected without executing application code', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: readColor() } });",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:73: Theme values must be literal data; expressions are not evaluated.]`,
    )
  })

  test('theme style aliases and destructuring compile with lexical shadowing', async () => {
    const result = Transform.compile({
      moduleId: 'example/aliases.ts',
      source:
        "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({ color: { brand: '#06c' }, spacing: { md: '8px' } }); const themeConfig=Config.create({vars:theme});\nconst style = themeConfig.style;\nconst chained = style;\nconst { style: renamed } = themeConfig;\nexport type Styles = Parameters<typeof renamed>[0];\nexport const first = chained({ color: 'brand' })();\nexport const second = renamed({ padding: 'md' })();\nexport function shadow(style: (input: string) => string) { return style('untouched') }\n",
    })

    expect(result.code).toMatchInlineSnapshot(`
      "

      const theme = ({} as import('zyzz').Vars.Definition<{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}>); const themeConfig=({} as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}}>);
      const style = (undefined as unknown as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}}>['style']);
      const chained = (undefined as unknown as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}}>['style']);
      const { style: renamed } = (themeConfig as import('zyzz').Config.VariableConfig<{readonly "vars":{readonly "color":{readonly "brand":"#06c"};readonly "spacing":{readonly "md":"8px"}}}>);
      export type Styles = Parameters<typeof renamed>[0];
      export const first = ({className:"z_RfEg8H0"});
      export const second = ({className:"z_RfEg8H1"});
      export function shadow(style: (input: string) => string) { return style('untouched') }
      "
    `)
    expect(result.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-brand:#06c;--z-spacing-md:8px;}
      .z_RfEg8H0{color:var(--z-color-brand,#06c);}
      .z_RfEg8H1{padding:var(--z-spacing-md,8px);}"
    `)

    const bundle = await Esbuild.build({
      bundle: true,
      format: 'cjs',
      metafile: true,
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })

    expect(bundle.metafile!.outputs['stdin.js']!.imports).toMatchInlineSnapshot(
      `[]`,
    )

    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-alias-'))

    try {
      const file = Path.join(directory, 'module.cjs')

      await Fs.writeFile(file, bundle.outputFiles[0]!.text)

      const executed = await Util.promisify(ChildProcess.execFile)(
        process.execPath,
        [
          '-e',
          `const value = require(${JSON.stringify(file)}); console.log(JSON.stringify(value.first)); console.log(JSON.stringify(value.second)); console.log(value.shadow(value => value));`,
        ],
      )

      expect(executed.stdout).toMatchInlineSnapshot(`
        "{"className":"z_RfEg8H0"}
        {"className":"z_RfEg8H1"}
        untouched
        "
      `)

      await Fs.writeFile(
        Path.join(directory, 'module.ts'),
        `${result.code}
renamed({ color: 'brand' });
// @ts-expect-error Unknown tokens remain rejected after rewriting.
renamed({ color: 'unknown' });
// @ts-expect-error Aliases preserve token domains.
style({ color: 'md' });
`,
      )

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
          Path.join(directory, 'module.ts'),
        ],
        { timeout: 30_000 },
      )

      expect(checked.stdout).toMatchInlineSnapshot(`""`)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }
  }, 35_000)

  test('JavaScript aliases remain JavaScript and parameter initializers retain lexical bindings', async () => {
    const result = Transform.compile({
      moduleId: 'example/aliases.js',
      source:
        "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz';\nconst theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme});\nconst { style } = themeConfig;\nexport function card(value = style({color:'brand'})()) { var style = 1; return value }\n",
    })

    expect(result.code).toMatchInlineSnapshot(`
      "

      const theme = ({}); const themeConfig=({});
      const { style } = themeConfig;
      export function card(value = ({className:"z_tfEg1R0"})) { var style = 1; return value }
      "
    `)

    const output = await Esbuild.transform(result.code, { loader: 'js' })

    expect(output.warnings).toMatchInlineSnapshot(`[]`)
  })

  test('theme alias diagnostics reject exported aliases', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); export const style = themeConfig.style;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:169: Theme style aliases require a local module-level const binding.]`,
    )
  })

  test('theme alias diagnostics reject escaping aliases', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); const style = themeConfig.style; consume(style);",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:197: Theme style aliases support direct calls only; exporting or escaping them requires source linking.]`,
    )
  })

  test('theme alias diagnostics reject reassigned aliases', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); const style = themeConfig.style; (style as unknown) = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:190: Theme style aliases support direct calls only; exporting or escaping them requires source linking.]`,
    )
  })

  test('theme alias diagnostics reject destructuring defaults', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const { style = fallback } = theme;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:88: Destructure only style or variants into const bindings without defaults or rest properties.]`,
    )
  })

  test('theme alias diagnostics reject destructuring rest', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const { style, ...rest } = theme;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:95: Destructure only style or variants into const bindings without defaults or rest properties.]`,
    )
  })

  test('theme alias diagnostics reject mutable aliases', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); let style = themeConfig.style;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:160: Theme style aliases require a local module-level const binding.]`,
    )
  })

  test('theme alias diagnostics reject early alias calls', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); style({color:'brand'}); const style = themeConfig.style;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:156: Theme style alias references must follow their definition.]`,
    )
  })

  test('theme alias diagnostics reject optional alias calls', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); const style = themeConfig.style; style?.({color:'brand'});",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:189: Theme style aliases support direct calls only; exporting or escaping them requires source linking.]`,
    )
  })

  test('theme alias diagnostics reject export specifiers', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/aliases.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({color:{brand:'#06c'}}); const themeConfig=Config.create({vars:theme}); const style = themeConfig.style; export { style };",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/aliases.ts:198: Theme style aliases support direct calls only; exporting or escaping them requires source linking.]`,
    )
  })

  test.each([
    'Z.Vars.define({ color: { brand: "#000" } })',
    'Z["Vars"].define({ color: { brand: "#000" } })',
    'Z.Vars.extend(base, {})',
  ])('namespace theme factories produce a source diagnostic: %s', (factory) => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/namespace.ts',
        source: `import * as Z from 'zyzz'; const theme = ${factory}; export const scope = theme.className;`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/namespace.ts:41: Import Vars by name; namespace authoring calls are not supported yet.]`,
    )
  })

  test('rejects wrapped scope writes: (theme.className as string) = value;', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); (theme.color.brand as string) = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:163: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: (theme.className!) = value;', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); (theme.color.brand!) = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:163: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: (theme.className satisfies string) = value;', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); (theme.color.brand satisfies string) = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:163: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: ((theme.className as string)!) = value;', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); ((theme.color.brand as string)!) = value;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:163: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: (theme.className as string)++;', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); (theme.color.brand as string)++;",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:163: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: delete (theme.className as string);', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); delete (theme.color.brand as string);",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:170: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: ({ value: (theme.className as string) } = input);', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); ({ value: (theme.color.brand as string) } = input);",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:173: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('rejects wrapped scope writes: for ((theme.className as string) of values) {}', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); for ((theme.color.brand as string) of values) {}",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:168: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('theme scopes cannot be assigned through destructuring targets', () => {
    expect(() =>
      Transform.compile({
        moduleId: 'example/theme.ts',
        source:
          "import {Config} from 'zyzz';\nimport { Vars } from 'zyzz'; const theme = Vars.define({ color: { brand: '#000' } }); const themeConfig=Config.create({vars:theme}); ({ value: theme.color.brand } = input);",
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: example/theme.ts:172: Token references must be direct property values in bound theme style calls.]`,
    )
  })

  test('folded applications need no runtime and maps trace Unicode and CRLF sources', async () => {
    const source = `import { style } from 'zyzz';\r\nconst text = '🎉';\r\nexport const props = style({ color: '#f00', padding: '8px' })();`
    const result = Transform.compile({ moduleId: 'example/inline.ts', source })

    const bundle = await Esbuild.build({
      bundle: true,
      format: 'esm',
      metafile: true,
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })

    const cssMap = new Trace.TraceMap(result.cssMap)
    const map = new Trace.TraceMap(result.map)
    const outputLines = result.code.split('\n')
    const row = outputLines.findIndex((line) => line.includes('className'))

    expect(result.code).toMatchInlineSnapshot(`
      "
      const text = '🎉';
      export const props = ({className:"z_GkHrU20 z_GkHrU21"});"
    `)

    expect(result.css).toMatchInlineSnapshot(
      `
      ".z_GkHrU20{color:#f00;}
      .z_GkHrU21{padding:8px;}"
    `,
    )

    expect(
      ['color:', 'padding:'].map((property) =>
        Trace.originalPositionFor(cssMap, {
          column: result.css.indexOf(property),
          line: 1,
        }),
      ),
    ).toMatchInlineSnapshot(`
      [
        {
          "column": 29,
          "line": 3,
          "name": "color",
          "source": "example/inline.ts",
        },
        {
          "column": 29,
          "line": 3,
          "name": "color",
          "source": "example/inline.ts",
        },
      ]
    `)

    expect(bundle.metafile!.outputs['stdin.js']!.imports).toMatchInlineSnapshot(
      `[]`,
    )

    expect(
      Trace.originalPositionFor(map, {
        column: outputLines[row]!.indexOf('className'),
        line: row + 1,
      }),
    ).toMatchInlineSnapshot(`
      {
        "column": 21,
        "line": 3,
        "name": null,
        "source": "example/inline.ts",
      }
    `)

    expect(result.map.sources).toMatchInlineSnapshot(`
    [
      "example/inline.ts",
    ]
  `)

    expect(result.cssMap.sources).toMatchInlineSnapshot(`
    [
      "example/inline.ts",
    ]
  `)

    expect(result.map.sourcesContent).toMatchInlineSnapshot(`
    [
      "import { style } from 'zyzz';
    const text = '🎉';
    export const props = style({ color: '#f00', padding: '8px' })();",
    ]
  `)

    expect(result.cssMap.sourcesContent).toMatchInlineSnapshot(`
    [
      "import { style } from 'zyzz';
    const text = '🎉';
    export const props = style({ color: '#f00', padding: '8px' })();",
    ]
  `)
  })

  test('imports, hashbangs, type references, shadowing, and surrounding JSX survive rewriting', async () => {
    const sources = [
      `import other, { style } from 'zyzz'; export const props = style({})(); export { other };`,
      `"use client"; import { style } from 'zyzz'; export const button = style({});`,
      `#!/usr/bin/env node\nimport { style, Style } from 'zyzz'; export const button = style({}); export { Style };`,
      `import { Style, style, style as other } from 'zyzz'; export const a = style({})(); export const b = other({})(); export { Style };`,
      `import { style, Style, style as other } from 'zyzz'; export const a = style({})(); export const b = other({})(); export { Style };`,
      `import { style } from 'zyzz'; export type Signature = typeof style; export const button = style({});`,
      `import { style } from 'zyzz'; const __zyzzProps = 1; export const el = <button {...style({color:'#f00'})()} />; export const button = style({});`,
      `import { style } from 'zyzz'; export function f(value = style({})()) { var style; return value; }`,
      `export const untouched = '🎉';`,
    ]

    const outputs = []

    for (const source of sources) {
      const result = Transform.compile({
        moduleId: 'example/syntax.tsx',
        source,
      })

      await Esbuild.transform(result.code, { loader: 'tsx' })
      outputs.push(result.code)
    }

    expect(outputs).toMatchInlineSnapshot(`
      [
        "import other from 'zyzz'; export const props = ({className:""}); export { other };",
        ""use client";
      import { Props as __zyzzProps } from 'zyzz/runtime';
        export const button = /*#__PURE__*/__zyzzProps.create({className:"z-style-illRZq-button"});",
        "#!/usr/bin/env node

      import { Props as __zyzzProps } from 'zyzz/runtime';
      import { Style } from 'zyzz'; export const button = /*#__PURE__*/__zyzzProps.create({className:"z-style-illRZq-button"}); export { Style };",
        "import { Style,  } from 'zyzz'; export const a = ({className:""}); export const b = ({className:""}); export { Style };",
        "import { Style } from 'zyzz'; export const a = ({className:""}); export const b = ({className:""}); export { Style };",
        "
      import { Props as __zyzzProps } from 'zyzz/runtime';
      import { style } from 'zyzz'; export type Signature = typeof style; export const button = /*#__PURE__*/__zyzzProps.create({className:"z-style-illRZq-button"});",
        "
      import { Props as __zyzzProps_ } from 'zyzz/runtime';
       const __zyzzProps = 1; export const el = <button {...({className:"z_illRZq0"})} />; export const button = /*#__PURE__*/__zyzzProps_.create({className:"z-style-illRZq-button"});",
        "import { style } from 'zyzz'; export function f(value = ({className:""})) { var style; return value; }",
        "export const untouched = '🎉';",
      ]
    `)
  })

  test('prunes replaced defineConfig, defineVars, and extendVars imports', () => {
    const imports = (source: string) =>
      Transform.compile({ moduleId: 'app/card.ts', source })
        .code.split('\n')
        .filter((line) => line.startsWith('import'))

    expect(
      imports(`import { defineConfig } from 'zyzz'
const { style } = defineConfig({ cssOutput: 'grouped' })
export const card = style({ color: 'red' })
`),
    ).toMatchInlineSnapshot(`
      [
        "import { Props as __zyzzProps } from 'zyzz/runtime';",
      ]
    `)

    expect(
      imports(`import { defineConfig, defineVars, extendVars } from 'zyzz'
const base = defineVars({ color: { brand: '#06c' } })
const dark = extendVars(base, { color: { brand: '#9cf' } })
const { style } = defineConfig({ defaultVars: 'base', vars: { base, dark } })
export const card = style({ color: 'brand' })
`),
    ).toMatchInlineSnapshot(`
      [
        "import { Props as __zyzzProps } from 'zyzz/runtime';",
      ]
    `)

    // Type queries and shadowed names are references outside replaced calls.
    expect(
      imports(`import { defineConfig } from 'zyzz'
export type Factory = typeof defineConfig
const { style } = defineConfig({})
export const card = style({ color: 'red' })
`),
    ).toMatchInlineSnapshot(`
      [
        "import { Props as __zyzzProps } from 'zyzz/runtime';",
        "import { defineConfig } from 'zyzz'",
      ]
    `)

    expect(
      imports(`import { defineConfig } from 'zyzz'
const { style } = defineConfig({})
export const card = style({ color: 'red' })
export function f() { var defineConfig = 1; return defineConfig }
`),
    ).toMatchInlineSnapshot(`
      [
        "import { Props as __zyzzProps } from 'zyzz/runtime';",
        "import { defineConfig } from 'zyzz'",
      ]
    `)
  })

  test('separately transformed modules render without class collisions in Chromium', async () => {
    const browser = await chromium.launch()
    const directory = await Fs.mkdtemp(Path.join(root, '.fixture-transform-'))

    try {
      const first = Transform.compile({
        moduleId: 'package/first.ts',
        source: `import { style } from 'zyzz'; export const button = style({ color: '#f00', padding: '8px' });`,
      })
      const second = Transform.compile({
        moduleId: 'package/second.ts',
        source: `import { style } from 'zyzz'; export const props = style({ color: '#00f', padding: '4px' })();`,
      })

      await Fs.writeFile(Path.join(directory, 'first.ts'), first.code)
      await Fs.writeFile(Path.join(directory, 'second.ts'), second.code)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
        bundle: true,
        format: 'iife',
        globalName: 'fixture',
        stdin: {
          contents: `import { button } from './first'; import { props } from './second'; export const values = [button(), props, button({ className: 'external', style: { paddingLeft: '2px' } })];`,
          loader: 'ts',
          resolveDir: directory,
        },
        write: false,
      })

      const page = await browser.newPage()

      await page.setContent('<!doctype html><body></body>')
      await page.addStyleTag({ content: first.css + '\n' + second.css })
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })

      const result = await page.evaluate(`fixture.values.map(props => {
      const element = document.createElement('button');
      element.className = props.className;
      Object.assign(element.style, props.style);
      document.body.append(element);
      const style = getComputedStyle(element);
      return { color: style.color, padding: style.padding };
    })`)

      expect(result).toMatchInlineSnapshot(`
      [
        {
          "color": "rgb(255, 0, 0)",
          "padding": "8px",
        },
        {
          "color": "rgb(0, 0, 255)",
          "padding": "4px",
        },
        {
          "color": "rgb(255, 0, 0)",
          "padding": "8px 8px 8px 2px",
        },
      ]
    `)
    } finally {
      await browser.close()
      await Fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('compiled library exports run against the packed runtime without a styling plugin', async () => {
    const directory = await Fs.mkdtemp(
      Path.join(root, '.fixture-transform-pack-'),
    )

    try {
      const run = Util.promisify(ChildProcess.execFile)

      // The integration command builds once before workers consume package artifacts.
      await Fs.access(Path.join(root, 'dist/runtime/index.js'))
      await run('pnpm', ['pack', '--pack-destination', directory], {
        cwd: root,
      })

      const archive = (await Fs.readdir(directory)).find((name) =>
        name.endsWith('.tgz'),
      )!
      const installed = Path.join(directory, 'node_modules/zyzz')

      await Fs.mkdir(installed, { recursive: true })
      await run('tar', [
        '-xzf',
        Path.join(directory, archive),
        '--strip-components=1',
        '-C',
        installed,
      ])

      const output = Transform.compile({
        moduleId: 'library/button.ts',
        source: `import { style } from 'zyzz'; export const button = style({ color: '#f00' });`,
      })

      await Fs.writeFile(Path.join(directory, 'button.ts'), output.code)

      const consumer = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { button } from './button.ts'; console.log(JSON.stringify(button({className:'external'})));`,
        ],
        { cwd: directory },
      )

      const bundle = await Esbuild.build({
        bundle: true,
        metafile: true,
        platform: 'browser',
        stdin: {
          contents: `export { button } from './button.ts'`,
          resolveDir: directory,
        },
        write: false,
      })

      const platforms = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { Style } from 'zyzz'; import { Css } from 'zyzz/web'; console.log(JSON.stringify(Css.compile({ styles: Style.define({ button: { padding: 0 } }) })));`,
        ],
        { cwd: directory },
      )

      expect(JSON.parse(platforms.stdout)).toMatchInlineSnapshot(`
        {
          "classes": {
            "button": "z_0",
          },
          "css": ".z_0{padding:0;}",
          "vars": {},
        }
      `)

      const listing = await run('tar', ['-tzf', Path.join(directory, archive)])

      expect(
        Object.keys(bundle.metafile!.inputs).some((name) =>
          /oxc|compiler|web\/Css/.test(name),
        ),
      ).toMatchInlineSnapshot(`false`)

      expect(JSON.parse(consumer.stdout)).toMatchInlineSnapshot(`
        {
          "className": "z_3DNxjG0 z-style-3DNxjG-button external",
        }
      `)

      expect(
        /\.(?:test|test-d|bench)\.ts/.test(listing.stdout),
      ).toMatchInlineSnapshot(`false`)
    } finally {
      await Fs.rm(directory, { force: true, recursive: true })
    }
  }, 30000)

  test('maps quoted braces in selector conditions to their authored keys', () => {
    const source = `import {style} from 'zyzz'; export const card=style({selectors:{'&[data-state="{"]':{color:'red'}}})`
    const output = Transform.compile({ moduleId: 'quoted.ts', source })
    const offset = output.css.indexOf('&[data-state')
    const prefix = output.css.slice(0, offset).split('\n')
    const original = Trace.originalPositionFor(
      new Trace.TraceMap(output.cssMap),
      { column: prefix.at(-1)!.length, line: prefix.length },
    )
    expect(original.name).toMatchInlineSnapshot(`"'&[data-state="{"]'"`)
  })
})

describe('applications', () => {
  describe('compile', () => {
    test('folded applications and specialized recipes render the props of runtime callables', async () => {
      const source = `import { style, variants } from 'zyzz'
const Capture = (props: object) => JSON.stringify(props)
const Base = (props: { className?: string | undefined }) => <Capture {...styles.base({ className: props.className })} />
const Outer = (props: { className?: string | undefined }) => <Base {...styles.outer({ className: props.className })} />
export const early = () => <Capture {...styles.base()} />
export const App = () => <main>
<Capture {...styles.base()} />
<Outer />
<Outer className="external" />
<Capture className="before" {...styles.inline({ className: 'literal' })} />
<Capture {...styles.inline({ style: { color: 'red' } })} />
<span>{styles.base().className}</span>
<Capture {...styles.button()} />
<Capture {...styles.button({ active: true, tone: null })} />
<Capture {...styles.button({ active: false, className: 'x', tone: 'loud', vars: { '--a': '1' }, style: { color: 'red' } })} />
</main>
early()
namespace styles {
export const base=style({color:'red'})
export const outer=style({padding:'8px'})
export const inline=style({margin:'4px'})
export const button=variants({base:{display:'flex'},variants:{active:{false:{opacity:0.5},true:{}},tone:{loud:{color:'red'},quiet:{color:'gray'}}},defaultVariants:{tone:'quiet'}})
}`
      const output = Transform.compile({ moduleId: 'App.tsx', source })

      expect(output.code).toMatchInlineSnapshot(`
        "
        import { Props as __zyzzProps } from 'zyzz/runtime';
        import { style } from 'zyzz'
        const Capture = (props: object) => JSON.stringify(props)
        const Base = (props: { className?: string | undefined }) => <Capture className={styles.base?__zyzzProps.merge("z_l0kPgl0",props.className):styles.base({className:props.className}).className} />
        const Outer = (props: { className?: string | undefined }) => <Base className={styles.outer?__zyzzProps.merge("z_l0kPgl1",props.className):styles.outer({className:props.className}).className} />
        export const early = () => <Capture className={(styles.base?"z_l0kPgl0":styles.base().className)} />
        export const App = () => <main>
        <Capture className={(styles.base?"z_l0kPgl0":styles.base().className)} />
        <Outer />
        <Outer className="external" />
        <Capture className="before" {...styles.inline({ className: 'literal' })} />
        <Capture {...styles.inline({ style: { color: 'red' } })} />
        <span>{(styles.base?"z_l0kPgl0":styles.base().className)}</span>
        <Capture {...styles.button()} />
        <Capture {...styles.button({ active: true, tone: null })} />
        <Capture {...styles.button({ active: false, className: 'x', tone: 'loud', vars: { '--a': '1' }, style: { color: 'red' } })} />
        </main>
        early()
        namespace styles {
        export const base=(1 as unknown as import('zyzz').style.ReturnType)
        export const outer=(1 as unknown as import('zyzz').style.ReturnType)
        export const inline=/*#__PURE__*/__zyzzProps.create({className:"z_l0kPgl2"})
        export const button=(((input:Record<string,unknown>&import('zyzz').style.Options={})=>{const external=input.className,style=input.style,vars=input.vars,inline=vars?{...vars,...style}:style,className=external?"z_l0kPgl3 z_l0kPgl4 z_l0kPgl5 z_l0kPgl6"+" "+external:"z_l0kPgl3 z_l0kPgl4 z_l0kPgl5 z_l0kPgl6",result:Record<string,unknown>=inline?{className,style:inline}:{className};let value;value=Object.hasOwn(input,"active")?input["active"]:void 0;if(value!==null&&value!==void 0)result["data-active"]=String(value);value=Object.hasOwn(input,"tone")?input["tone"]:void 0;if(value===void 0)value="quiet";if(value!==null&&value!==void 0)result["data-tone"]=String(value);return result}) as unknown as import('zyzz').variants.ReturnType<{variants:{"active":{"false":{};"true":{}};"tone":{"loud":{};"quiet":{}}}}>)
        }"
      `)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        bundle: true,
        external: ['react'],
        format: 'cjs',
        jsx: 'automatic',
        platform: 'node',
        stdin: {
          contents: output.code.replace(
            '\nearly()',
            '\nexport const failure = (() => { try { early() } catch (error) { return String(error) } })()',
          ),
          loader: 'tsx',
          resolveDir: process.cwd(),
        },
        write: false,
      })
      const module = {
        exports: {} as { App: () => React.ReactNode; failure: string },
      }

      new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(
        module,
        module.exports,
        Module.createRequire(import.meta.url),
      )

      // Applications before the namespace initializes still fail.
      expect(module.exports.failure).toMatchInlineSnapshot(
        `"TypeError: Cannot read properties of undefined (reading 'base')"`,
      )

      expect(
        Server.renderToStaticMarkup(React.createElement(module.exports.App)),
      ).toMatchInlineSnapshot(
        `"<main>{&quot;className&quot;:&quot;z_l0kPgl0&quot;}{&quot;className&quot;:&quot;z_l0kPgl0 z_l0kPgl1&quot;}{&quot;className&quot;:&quot;z_l0kPgl0 z_l0kPgl1 external&quot;}{&quot;className&quot;:&quot;z_l0kPgl2 literal&quot;}{&quot;className&quot;:&quot;z_l0kPgl2&quot;,&quot;style&quot;:{&quot;color&quot;:&quot;red&quot;}}<span>z_l0kPgl0</span>{&quot;className&quot;:&quot;z_l0kPgl3 z_l0kPgl4 z_l0kPgl5 z_l0kPgl6&quot;,&quot;data-tone&quot;:&quot;quiet&quot;}{&quot;className&quot;:&quot;z_l0kPgl3 z_l0kPgl4 z_l0kPgl5 z_l0kPgl6&quot;,&quot;data-active&quot;:&quot;true&quot;}{&quot;className&quot;:&quot;z_l0kPgl3 z_l0kPgl4 z_l0kPgl5 z_l0kPgl6 x&quot;,&quot;style&quot;:{&quot;--a&quot;:&quot;1&quot;,&quot;color&quot;:&quot;red&quot;},&quot;data-active&quot;:&quot;false&quot;,&quot;data-tone&quot;:&quot;loud&quot;}</main>"`,
      )
    })
  })
})

describe('atRuleAcceptance', () => {
  const source = `import {counterStyle,fontFace,page,viewTransition,customMedia,cssFunction,namespace,importCss,global} from 'zyzz/web';
export const dots=counterStyle({system:'cyclic',symbols:'"●"'});
fontFace({fontFamily:'Evidence',src:'url(/evidence.ttf)'});
page({descriptors:{size:'A4','@top-center':{content:'"Page"'}}});
viewTransition({navigation:'auto'});
export const compact=customMedia('(width < 40rem)');
export const twice=cssFunction({parameters:[{name:'--x',syntax:'<length>'}],returns:'<length>',body:{result:'calc(var(--x) * 2)'}});
namespace({prefix:'s',uri:'urn:svg'});
importCss({url:'https://example.com/base.css'});
global({'s|item':{color:'red'}});`

  describe('compile', () => {
    test('counts contribution CSS separately from theme output', () => {
      const output = Transform.compile({
        moduleId: 'theme.ts',
        source:
          "import {Config} from 'zyzz';import {counterStyle,fontFace} from 'zyzz/web';\nconst config=Config.create({vars:{color:{brand:'red'}}});\nexport const dots=counterStyle({symbols:'\"x\"'});\nfontFace({fontFamily:'Evidence',src:'url(/font.ttf)'});\nexport namespace styles {\n  export const text = config.style({color:'brand'})\n}",
      })
      const trace = new Trace.TraceMap(output.cssMap)
      const line =
        output.css
          .split('\n')
          .findIndex((line) => line.startsWith('@font-face')) + 1
      expect(Trace.originalPositionFor(trace, { line, column: 0 }))
        .toMatchInlineSnapshot(`
      {
        "column": 0,
        "line": 4,
        "name": null,
        "source": "theme.ts",
      }
    `)
    })
    test('maps hoisted declarations back to their source calls in direct and packed output', () => {
      const direct = Transform.compile({ moduleId: 'rules.ts', source })
      const library = Graph.compile({ modules: { 'rules.ts': source } })
      const packed = Graph.compile({
        contracts: { 'lib/rules.js': library.contracts['rules.ts']! },
        imports: { 'app.ts': { lib: 'lib/rules.js' } },
        modules: { 'app.ts': `import 'lib'` },
      })
      const origins = (css: string, map: typeof direct.cssMap) => {
        const trace = new Trace.TraceMap(map)
        return css.split('\n').flatMap((line, index) =>
          /^@(?:import|namespace|counter-style|font-face|page|view-transition|custom-media|function)\b/.test(
            line,
          )
            ? [
                {
                  rule: line.split(/[ {]/)[0],
                  ...Trace.originalPositionFor(trace, {
                    line: index + 1,
                    column: 0,
                  }),
                },
              ]
            : [],
        )
      }
      expect(origins(direct.css, direct.cssMap)).toMatchInlineSnapshot(`
      [
        {
          "column": 0,
          "line": 9,
          "name": null,
          "rule": "@import",
          "source": "rules.ts",
        },
        {
          "column": 0,
          "line": 8,
          "name": null,
          "rule": "@namespace",
          "source": "rules.ts",
        },
        {
          "column": 18,
          "line": 2,
          "name": null,
          "rule": "@counter-style",
          "source": "rules.ts",
        },
        {
          "column": 0,
          "line": 3,
          "name": null,
          "rule": "@font-face",
          "source": "rules.ts",
        },
        {
          "column": 0,
          "line": 4,
          "name": null,
          "rule": "@page",
          "source": "rules.ts",
        },
        {
          "column": 0,
          "line": 5,
          "name": null,
          "rule": "@view-transition",
          "source": "rules.ts",
        },
        {
          "column": 21,
          "line": 6,
          "name": null,
          "rule": "@custom-media",
          "source": "rules.ts",
        },
        {
          "column": 19,
          "line": 7,
          "name": null,
          "rule": "@function",
          "source": "rules.ts",
        },
      ]
    `)
      expect(origins(packed.sharedCss!, packed.sharedCssMap!))
        .toMatchInlineSnapshot(`
      [
        {
          "column": 0,
          "line": 9,
          "name": null,
          "rule": "@import",
          "source": "lib/rules.ts",
        },
        {
          "column": 0,
          "line": 8,
          "name": null,
          "rule": "@namespace",
          "source": "lib/rules.ts",
        },
        {
          "column": 18,
          "line": 2,
          "name": null,
          "rule": "@counter-style",
          "source": "lib/rules.ts",
        },
        {
          "column": 0,
          "line": 3,
          "name": null,
          "rule": "@font-face",
          "source": "lib/rules.ts",
        },
        {
          "column": 0,
          "line": 4,
          "name": null,
          "rule": "@page",
          "source": "lib/rules.ts",
        },
        {
          "column": 0,
          "line": 5,
          "name": null,
          "rule": "@view-transition",
          "source": "lib/rules.ts",
        },
        {
          "column": 21,
          "line": 6,
          "name": null,
          "rule": "@custom-media",
          "source": "lib/rules.ts",
        },
        {
          "column": 19,
          "line": 7,
          "name": null,
          "rule": "@function",
          "source": "lib/rules.ts",
        },
      ]
    `)
    })
    test('keeps Unicode content and explicit legacy document conditions without an encoding declaration', () => {
      const output = Transform.compile({
        moduleId: 'legacy.ts',
        source: `import {global} from 'zyzz/web';global({'@document url-prefix("https://example.com/")':{body:{'&::before':{content:'"héllo ●"'}}}});`,
      })
      expect({
        css: output.css,
        utf8: new TextDecoder('utf-8', { fatal: true }).decode(
          new TextEncoder().encode(output.css),
        ),
        charset: output.css.includes('@charset'),
        bom: output.css.charCodeAt(0) === 0xfeff,
      }).toMatchInlineSnapshot(`
      {
        "bom": false,
        "charset": false,
        "css": "@document url-prefix("https://example.com/"){body{&::before{content:"héllo ●";}}}",
        "utf8": "@document url-prefix("https://example.com/"){body{&::before{content:"héllo ●";}}}",
      }
    `)
    })
  })
})

describe('atRuleBrowser', () => {
  describe('compile', () => {
    test('Chromium loads a real font and applies counters, keyframes, namespace boundaries, and position fallbacks', async () => {
      const output = Graph.compile({
        modules: {
          'rules.ts': `import {style} from 'zyzz';import {fontFace,counterStyle,keyframes,positionTry,global,page} from 'zyzz/web';
fontFace({fontFamily:'Evidence',src:${JSON.stringify(`url("${Font.url}")`)},fontDisplay:'block'});
export const dots=counterStyle({system:'cyclic',symbols:'"●"',suffix:'" "'});
export const fade=keyframes({from:{opacity:0},to:{opacity:1}});
export const above=positionTry({positionArea:'top'});
global({'html':{height:'100%',overflow:'hidden'},'body':{margin:0,height:'100%',overflow:'hidden'},'#font':{fontFamily:'Evidence',fontSize:'100px',display:'inline-block'},'#animation':{animationName:fade,animationDuration:'1s',animationDelay:'-0.5s',animationPlayState:'paused',animationTimingFunction:'linear'},'#anchor':{anchorName:'--target',position:'absolute',top:'180px',left:'100px',width:'20px',height:'10px'},'#tooltip':{position:'absolute',positionAnchor:'--target',positionArea:'bottom',positionTryFallbacks:above,width:'50px',height:'30px'},'.counter':{listStyleType:dots,listStylePosition:'inside',width:'100px',height:'24px',fontFamily:'Arial',fontSize:'16px'}});
page({descriptors:{size:'A4','@top-center':{content:'"Page"'}}});`,
          'svg.ts': `import {namespace,global} from 'zyzz/web';namespace({uri:'http://www.w3.org/2000/svg'});global({'.icon':{fill:'red'}});`,
        },
      })
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage({
          viewport: { width: 300, height: 200 },
        })
        await page.setContent(
          '<span id="font">A</span><div id="animation">fade</div><div id="anchor"></div><div id="tooltip"></div><svg><rect id="svg" class="icon"/></svg><rect id="html" class="icon"></rect><li id="compiled" class="counter">item</li><li id="native" class="counter">item</li>',
        )
        await page.addStyleTag({ content: output.sharedCss! })
        await page.addStyleTag({
          content:
            '@counter-style reference {system:cyclic;symbols:"●";suffix:" "} #native {list-style-type:reference} ',
        })
        await page.evaluate(() => document.fonts.ready)
        expect(
          await page.evaluate(() => document.fonts.check('100px Evidence')),
        ).toMatchInlineSnapshot('true')
        expect(
          await page
            .locator('#font')
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toMatchInlineSnapshot('60')
        expect(
          await page
            .locator('#animation')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot('"0.5"')
        expect(
          await page
            .locator('#svg')
            .evaluate((element) => getComputedStyle(element).fill),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        expect(
          await page
            .locator('#html')
            .evaluate((element) => getComputedStyle(element).fill),
        ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
        expect(
          await page.locator('#tooltip').evaluate((element) => {
            const box = element.getBoundingClientRect()
            return {
              bottom: box.bottom,
              height: box.height,
              left: box.left,
              width: box.width,
            }
          }),
        ).toMatchInlineSnapshot(`
        {
          "bottom": 180,
          "height": 30,
          "left": 85,
          "width": 50,
        }
      `)
        expect(
          Buffer.compare(
            await page.locator('#compiled').screenshot(),
            await page.locator('#native').screenshot(),
          ) === 0,
        ).toMatchInlineSnapshot('true')
      } finally {
        await browser.close()
      }
    })
    test('Chromium reports experimental and legacy rule availability separately from emitted CSS', async () => {
      const cases = {
        colorProfile: `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({src:'url(/profile.icc)'});`,
        customMedia: `import {customMedia} from 'zyzz/web';export const query=customMedia('(width > 1px)');`,
        cssFunction: `import {cssFunction,global} from 'zyzz/web';export const twice=cssFunction({parameters:[{name:'--x',syntax:'<length>'}],returns:'<length>',body:{result:'calc(var(--x) * 2)'}});global({'#target':{width:twice('2px')}});`,
        document: `import {global} from 'zyzz/web';global({'@document url-prefix("https://example.com/")':{body:{color:'red'}}});`,
        fontFeatureValues: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Evidence',fontDisplay:'swap',features:{'@styleset':{editorial:[1,2]}}});`,
        viewTransition: `import {viewTransition} from 'zyzz/web';viewTransition({navigation:'auto',types:'slide'});`,
      }
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        const capabilities: Record<
          string,
          {
            accepted: boolean
            cssom: readonly string[]
            rendering?: 'unavailable' | 'unverified' | 'verified'
          }
        > = {}
        for (const [name, source] of Object.entries(cases)) {
          const output = Transform.compile({ moduleId: `${name}.ts`, source })
          const rules = await page.evaluate((css) => {
            const sheet = new CSSStyleSheet()
            sheet.replaceSync(css)
            return [...sheet.cssRules].map((rule) => rule.cssText)
          }, output.css)
          capabilities[name] = {
            accepted: rules.some((rule) => rule.startsWith('@')),
            cssom: rules,
          }
          if (name === 'colorProfile')
            capabilities[name].rendering = capabilities[name].accepted
              ? 'unverified'
              : 'unavailable'
          await Fs.mkdir('test-results', { recursive: true })
          await Fs.writeFile(
            'test-results/at-rule-browser-capabilities.json',
            JSON.stringify(
              { browser: browser.version(), capabilities },
              null,
              2,
            ),
          )
          if (name === 'cssFunction' && capabilities[name].accepted) {
            await page.setContent('<div id="target"></div>')
            await page.addStyleTag({ content: output.css })
            expect(
              await page
                .locator('#target')
                .evaluate((element) => getComputedStyle(element).width),
            ).toMatchInlineSnapshot('"4px"')
          }
        }
        expect(Object.keys(capabilities)).toMatchInlineSnapshot(`
        [
          "colorProfile",
          "customMedia",
          "cssFunction",
          "document",
          "fontFeatureValues",
          "viewTransition",
        ]
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('atRules', () => {
  describe('compile', () => {
    test('preserves base definitions and nested conditional branches', () => {
      const output = Transform.compile({
        moduleId: 'nested.ts',
        source: `import {fontFace,keyframes} from 'zyzz/web';
fontFace({fontFamily:'Base',src:'local("Arial")','@layer fonts':{'@media screen':{fontFamily:'Screen',src:'local("Arial")'}}});
export const fade=keyframes({from:{opacity:0},to:{opacity:1},'@media (prefers-reduced-motion: reduce)':{from:{opacity:1},to:{opacity:1}}});`,
      })
      expect(output.css).toMatchInlineSnapshot(`
        "@font-face{font-family:Base;src:local("Arial");}
        @layer fonts{@media screen{@font-face{font-family:Screen;src:local("Arial");}}}
        @keyframes z-k-fade{from{opacity:0;}to{opacity:1;}}
        @media (prefers-reduced-motion: reduce){@keyframes z-k-fade{from{opacity:1;}to{opacity:1;}}}"
      `)
    })

    test('preserves group order around complete base definitions', () => {
      const output = Transform.compile({
        moduleId: 'order.ts',
        source: `import {viewTransition} from 'zyzz/web';viewTransition({'@media screen':{navigation:'auto'},navigation:'none','@media print':{navigation:'auto'}});`,
      })
      expect(output.css).toMatchInlineSnapshot(`
        "@media screen{@view-transition{navigation:auto;}}
        @view-transition{navigation:none;}
        @media print{@view-transition{navigation:auto;}}"
      `)
    })

    test('rejects incomplete grouped descriptors and inconsistent function signatures', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {fontFace} from 'zyzz/web';fontFace({'@layer fonts':{fontFamily:'Body'}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:34: Font faces require family/source and scalar supported descriptors.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({'@media screen':{parameters:[],body:{result:1}},'@media print':{parameters:[{name:'--x'}],body:{result:1}}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:53: Grouped CSS function definitions must use the same parameters and return syntax.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {fontFace} from 'zyzz/web';fontFace({fontFamily:'Body',src:'local("Arial")'},{within:['@layer fonts']});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:34: Unknown contribution context option. Use nested at-rule keys for enclosing groups.]`,
      )
    })

    test('preserves grouped font descriptors and timeline range stops', () => {
      const output = Transform.compile({
        moduleId: 'rules.ts',
        source: `import { fontFace, keyframes } from 'zyzz/web';
fontFace({ '@layer fonts': { '@media screen': {fontFamily:'Body',src:'local("Arial")',fontFeatureSettings:'"kern"',fontVariationSettings:'"wght" 400'} } });
export const fade = keyframes({ '@supports (display: grid)': {'entry 0%, cover 10%':{opacity:0},'exit 100%':{opacity:1}} });`,
      })
      expect(output.css).toMatchInlineSnapshot(`
        "@layer fonts{@media screen{@font-face{font-family:Body;src:local("Arial");font-feature-settings:"kern";font-variation-settings:"wght" 400;}}}
        @supports (display: grid){@keyframes z-k-fade{entry 0%, cover 10%{opacity:0;}exit 100%{opacity:1;}}}"
      `)
      expect(output.code).toMatchInlineSnapshot(`
        "
        void 0;
        export const fade = "z-k-fade";"
      `)
    })
    test('resolves configured queries across CSS whitespace and comment boundaries', () => {
      const output = Transform.compile({
        moduleId: 'queries.ts',
        source:
          "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz';const theme=Vars.define({breakpoint:{tablet:'48rem'}}); const themeConfig=Config.create({vars:theme});export namespace styles {\n  export const card = themeConfig.style({'@media\\ttablet':{color:'red'},'@media/**/tablet':{color:'blue'}})\n}",
      })
      expect(output.css).toMatchInlineSnapshot(
        `
        "@media (width >= 48rem){.z_XSk4U00{color:red;}}
        @media (width >= 48rem){.z_XSk4U01{color:blue;}}"
      `,
      )
    })
    test('keeps scope, layer, and scroll-state nesting in authored order', () => {
      const output = Transform.compile({
        moduleId: 'scope.ts',
        source: `import {style} from 'zyzz'; export namespace styles {
  export const box = style({'@scope (.outer) to (.stop)':{'@layer components':{color:'red','@container scroll-state(stuck: top)':{color:'blue'}}}})
}`,
      })
      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_oO6_9C0{@scope (.outer) to (.stop){@layer components{color:red;}}}
        .z_oO6_9C1{@scope (.outer) to (.stop){@layer components{@container scroll-state(stuck: top){color:blue;}}}}"
      `,
      )
    })
    test('defaults undefined contexts and accepts anonymous and CSS-whitespace groups', () => {
      const output = Transform.compile({
        moduleId: 'contexts.ts',
        source: `import {fontFace,keyframes,global} from 'zyzz/web';fontFace({fontFamily:'Body',src:'url(/body)'},undefined);export const fade=keyframes({from:{opacity:0},to:{opacity:1}},void 1);fontFace({ '@layer': {fontFamily:'Layered',src:'url(/body)'} });global({'@media\\nscreen':{body:{color:'red'}},'@supports(display:grid)':{body:{display:'grid'}},'@media/**/print':{body:{color:'blue'}}});`,
      })
      expect(output.css).toMatchInlineSnapshot(`
        "@font-face{font-family:Body;src:url(/body);}
        @keyframes z-k-fade{from{opacity:0;}to{opacity:1;}}
        @layer{@font-face{font-family:Layered;src:url(/body);}}
        @media
        screen{body{color:red;}}
        @supports(display:grid){body{display:grid;}}
        @media/**/print{body{color:blue;}}"
      `)
    })
    test('Chromium applies local scope and layer rules as a scroll-state query changes', async () => {
      const output = Transform.compile({
        moduleId: 'nested.ts',
        source: `import {style} from 'zyzz';export namespace styles {
  export const item = style({'@scope (&) to (.stop)':{'@layer components':{'& .item':{color:'red','@container scroll-state(stuck: top)':{color:'blue'}}}}})
}`,
      })
      const name = Object.values(output.classes)[0]!
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<div class="outer ${name}" style="height:80px;overflow:auto"><div style="container-type:scroll-state;position:sticky;top:0"><span id="inside" class="item">inside</span><div class="stop"><span id="outside" class="item">outside</span></div></div><div style="height:300px"></div></div>`,
        )
        await page.addStyleTag({ content: output.css })
        expect(
          await page
            .locator('#inside')
            .evaluate((el) => getComputedStyle(el).color),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        await page.locator('.outer').evaluate((el) => {
          el.scrollTop = 40
        })
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('#inside')!).color ===
            'rgb(0, 0, 255)',
        )
        expect(
          await page
            .locator('#inside')
            .evaluate((el) => getComputedStyle(el).color),
        ).toMatchInlineSnapshot('"rgb(0, 0, 255)"')
        expect(
          await page
            .locator('#outside')
            .evaluate((el) => getComputedStyle(el).color),
        ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      } finally {
        await browser.close()
      }
    })
    test('keeps layer order top-level without empty conditional wrappers', () => {
      expect(
        Css.compile({
          styles: { styles: [] },
          contributions: [
            { kind: 'layers', names: ['base'], within: ['@media screen'] },
          ],
        }).css,
      ).toMatchInlineSnapshot('"@layer base;"')
    })
    test('Chromium applies scope boundaries', async () => {
      const output = Transform.compile({
        moduleId: 'scope.ts',
        source: `import {global} from 'zyzz/web'; global({'@scope (.outer) to (.stop)':{p:{color:'red'}}})`,
      })
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          '<div class="outer"><p id="inside">Inside</p><div class="stop"><p id="outside">Outside</p></div></div>',
        )
        await page.addStyleTag({ content: output.css })
        expect(
          await page
            .locator('#inside')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        expect(
          await page
            .locator('#outside')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot('"rgb(0, 0, 0)"')
      } finally {
        await browser.close()
      }
    })
  })
})

describe('atomicReview', () => {
  describe('compile', () => {
    test('switches grouped compiler defaults without reusing atomic graph output', () => {
      const compiler = Graph.create()
      const modules = {
        'styles.ts':
          "import {style} from 'zyzz';export const a=style({color:'red',padding:'2px'});export const b=style({color:'blue',padding:'4px'})",
      }
      const atomic = compiler.compile({ modules })
      const grouped = compiler.compile({
        composition: 'independent',
        cssOutput: 'grouped',
        modules,
      })
      expect(grouped.modules['styles.ts']!.css).toMatchInlineSnapshot(`
        ".z_b8Bx0E0{color:red;padding:2px;}
        .z_b8Bx0E1{color:blue;padding:4px;}"
      `)
      expect(Object.values(grouped.modules['styles.ts']!.classes))
        .toMatchInlineSnapshot(`
          [
            "z_b8Bx0E0 z-style-b8Bx0E-a",
            "z_b8Bx0E1 z-style-b8Bx0E-b",
          ]
        `)
      expect(grouped.modules['styles.ts']!.css).not.toBe(
        atomic.modules['styles.ts']!.css,
      )
      expect(compiler.compile({ modules })).toEqual(atomic)
    })

    test('maps repeated declaration occurrences to their authored keys', () => {
      const source = `import {style} from 'zyzz'; export const card=style({padding:'8px',paddingLeft:'2px',selectors:{'&:hover':{paddingLeft:'4px'},'&:focus':{paddingLeft:'6px'}}})`
      const output = Transform.compile({ moduleId: 'atomic.ts', source })
      const map = new Trace.TraceMap(output.cssMap)
      const locations = [...output.css.matchAll(/padding-left:/g)].map(
        (match) => {
          const prefix = output.css.slice(0, match.index).split('\n')
          return Trace.originalPositionFor(map, {
            column: prefix.at(-1)!.length,
            line: prefix.length,
          }).column
        },
      )

      expect(locations).toMatchInlineSnapshot(`
        [
          67,
          107,
          137,
        ]
      `)
    })

    test('deduplicates whole independent applications without reversing conflicts', async () => {
      const a = { padding: '10px', paddingLeft: '1px' } as const
      const output = Css.compile({
        composition: 'independent',
        styles: Style.define({
          a,
          b: { paddingLeft: '1px', padding: '10px' },
          again: a,
        }),
      })

      expect(output.classes).toMatchInlineSnapshot(`
        {
          "a": "z_0",
          "again": "z_0",
          "b": "z_1",
        }
      `)
      expect(output.css).toMatchInlineSnapshot(`
        ".z_0{padding:10px;padding-left:1px;}
        .z_1{padding-left:1px;padding:10px;}"
      `)

      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${output.css}</style>${Object.entries(output.classes)
            .map(([id, name]) => `<div id="${id}" class="${name}"></div>`)
            .join('')}`,
        )
        expect(
          await page
            .locator('div')
            .evaluateAll((elements) =>
              elements.map((element) => getComputedStyle(element).paddingLeft),
            ),
        ).toMatchInlineSnapshot(`
        [
          "1px",
          "10px",
          "1px",
        ]
      `)
      } finally {
        await browser.close()
      }
    })

    test('development utilities reflect values and preserve equivalent declarations', () => {
      const source = (value: string, added = '') =>
        `import {style} from 'zyzz'; const first=style({color:'${value}'}); const second=style({${added}color:'blue',padding:'8px'})`
      const before = Transform.compile({
        development: true,
        moduleId: 'dev.ts',
        source: source('red'),
      })
      const after = Transform.compile({
        development: true,
        moduleId: 'dev.ts',
        source: source('rebeccapurple', "display:'block',"),
      })
      expect(Object.values(before.classes)[0]).toMatchInlineSnapshot(
        `"z-Z2S8Qr-first-text-0"`,
      )
      expect(Object.values(after.classes)[0]).toMatchInlineSnapshot(
        `"z-Z2S8Qr-first-text-0"`,
      )
      expect(Object.values(before.classes)[1]).toMatchInlineSnapshot(
        `"z-Z2S8Qr-second-text-0 z-Z2S8Qr-p-8px"`,
      )
      expect(Object.values(after.classes)[1]).toMatchInlineSnapshot(
        `"z-Z2S8Qr-block z-Z2S8Qr-second-text-1 z-Z2S8Qr-p-8px"`,
      )
    })
  })
})

describe('backgrounds', () => {
  describe('compile', () => {
    test('backgrounds preserve fallback positions and color keyword precedence', () => {
      const output = Transform.compile({
        moduleId: 'backgrounds.ts',
        source: Backgrounds.source,
      })

      expect(output.css.match(/background-position-[xy]:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "background-position-x:left",
        "background-position-x:25%!important",
        "background-position-y:-4px",
      ]
    `)
      expect(output.css.match(/(?:accent|caret)-color:auto/g))
        .toMatchInlineSnapshot(`
          [
            "accent-color:auto",
            "caret-color:auto",
          ]
        `)
      expect(/--z-color-auto,#06c\)/.test(output.css)).toMatchInlineSnapshot(
        `true`,
      )
    })

    test('backgrounds and color controls match computed browser declarations', async () => {
      const output = Transform.compile({
        moduleId: 'backgrounds.ts',
        source: Backgrounds.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>input{width:100px;height:40px}${output.css}</style>${Object.entries(
            Backgrounds.controls,
          )
            .map(
              ([name, css]) =>
                `<input id="${name}" class="${module[name].className}" value="Color"><input id="${name}-control" style="${css}" value="Color">`,
            )
            .join('')}`,
        )

        expect(
          await page.evaluate(
            (names) =>
              names.filter((name) => {
                const a = getComputedStyle(document.getElementById(name)!)
                const b = getComputedStyle(
                  document.getElementById(`${name}-control`)!,
                )

                return [
                  'accent-color',
                  'background-attachment',
                  'background-blend-mode',
                  'background-clip',
                  'background-origin',
                  'background-position-x',
                  'background-position-y',
                  'background-repeat',
                  'background-size',
                  'caret-color',
                  'color-scheme',
                  'forced-color-adjust',
                  'mix-blend-mode',
                  'print-color-adjust',
                ].some(
                  (property) =>
                    a.getPropertyValue(property) !==
                    b.getPropertyValue(property),
                )
              }),
            Object.keys(Backgrounds.controls),
          ),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#control')
            .evaluate((element) => getComputedStyle(element).caretColor),
        ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)
        expect(
          await page
            .locator('#background')
            .evaluate(
              (element) => getComputedStyle(element).backgroundPositionX,
            ),
        ).toMatchInlineSnapshot(`"25%"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('bindings', () => {
  const source = [
    `import { style, variable } from 'zyzz';`,
    `const vars = ({amount:variable("percentage"),count:variable("number"),gap:variable("length")});`,
    'export const bar = style({width:vars.amount, marginLeft:`calc(${vars.gap} + 2px)`})();',
    `export const assignments = ({...vars["amount"].set("50%"),...vars["count"].set(2),...vars["gap"].set("8px")});`,
    `export const update = () => ({...vars["amount"].set("75%")});`,
    'export const assign = (values: any) => vars.amount.set(values.amount);',
  ].join('\n')

  describe('compile', () => {
    test('identifies explicit variables in template diagnostics', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad-template.ts',
          source: `import { style, variable } from 'zyzz'; const vars=({size:variable("length")}); style({color:\`calc(\${vars.size})\`})`,
        }),
      ).toThrow('Variable domain is incompatible with this property.')
    })
    test('keeps contracts distinct with shadowed globals and assertion types', async () => {
      const output = Transform.compile({
        moduleId: 'hygiene.ts',
        source: `
      import {variable} from 'zyzz';
      const Object = {}; const __zyzzVariable = 0;
      const ab = ({c:variable('length')});
      const a = ({bc:variable('length')});
      export const first = ab as { c: variable.Reference<'length'> };
      export const second = a satisfies { bc: variable.Reference<'length'> };
    `,
      })

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const result = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(
        result.first.c.name === result.second.bc.name,
      ).toMatchInlineSnapshot(`false`)
      expect(
        Object.isFrozen(result.first) && Object.isFrozen(result.first.c),
      ).toMatchInlineSnapshot(`false`)
    })

    test('preserves asserted reads and compatible border length templates', () => {
      expect(
        Transform.compile({
          moduleId: 'border.ts',
          source: `import { style, variable } from 'zyzz'; const border=({size:variable("length")}); style({borderWidth:\`calc(\${border.size})\`,width:(border.size satisfies unknown)})`,
        }).css,
      ).toMatchInlineSnapshot(
        `
        ".z_Hgy0Gw0{border-width:calc(var(--z-border-size));}
        .z_Hgy0Gw1{width:var(--z-border-size);}"
      `,
      )
    })
    test('rejects incompatible direct binding domains', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import { style, variable } from 'zyzz'; const vars=({color:variable("color")}); style({width:vars.color})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:93: Variable domain is incompatible with this property.]`,
      )
    })

    test('emits fixed slots and executes typed assignments without generating rules', async () => {
      const output = Transform.compile({ moduleId: 'slots.ts', source })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_nYY8mX0{width:var(--z-vars-amount);}
        .z_nYY8mX1{margin-left:calc(var(--z-vars-gap) + 2px);}"
      `,
      )

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const module = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(module.assignments).toMatchInlineSnapshot(`
        {
          "--z-vars-amount": "50%",
          "--z-vars-count": 2,
          "--z-vars-gap": "8px",
        }
      `)
      expect(module.update()).toMatchInlineSnapshot(`
        {
          "--z-vars-amount": "75%",
        }
      `)
      expect(Object.values(module.assign({ amount: '60%' }))).toEqual(['60%'])
      expect(output.code.includes('variable(')).toMatchInlineSnapshot(`false`)
    })

    test('updates native widths through fixed variable slots', async () => {
      const output = Transform.compile({ moduleId: 'slots.ts', source })

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const module = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div style="width:200px"><div id="bar" class="${module.bar.className}"></div></div>`,
        )
        await page.locator('#bar').evaluate((element, values) => {
          for (const [key, value] of Object.entries(values))
            (element as HTMLElement).style.setProperty(key, String(value))
        }, module.assignments)

        expect(
          await page
            .locator('#bar')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"100px"`)

        await page.locator('#bar').evaluate((element, values) => {
          for (const [key, value] of Object.entries(values))
            (element as HTMLElement).style.setProperty(key, String(value))
        }, module.update())

        expect(
          await page
            .locator('#bar')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"150px"`)
      } finally {
        await browser.close()
      }
    })

    test('keeps matching schemas in different definitions isolated', () => {
      expect(
        Transform.compile({
          moduleId: 'isolated.ts',
          source: `import { style, variable } from 'zyzz'; const a = ({x:variable("number")}); const b = ({x:variable("number")}); style({opacity:a.x})(); style({opacity:b.x})()`,
        }).css,
      ).toMatchInlineSnapshot(`
        ".z_B0G1Ix0{opacity:var(--z-a-x);}
        .z_B0G1Ix1{opacity:var(--z-b-x);}"
      `)
    })

    test('rejects unknown schema domains without evaluating calls', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {variable} from 'zyzz'; const a = ({x:variable(arbitrary())});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:45: variable requires a scalar domain and optional literal registration options.]`,
      )
    })
  })
})

describe('borderLists', () => {
  describe('compile', () => {
    test('border shorthand lists agree with independent grammar and preserve importance', () => {
      const lexer = Conformance.lexer()

      for (const [property, value] of [
        ['border-color', 'red rgb(0 128 0) blue gold'],
        ['border-style', 'solid dashed dotted double'],
        ['border-width', 'thin medium thick 2px'],
        ['border-radius', '10px 20px 30px 40px / 20px 30px 40px 50px'],
        ['border-top-left-radius', '10px 20%'],
      ])
        expect(
          lexer.matchProperty(property!, value!).error,
        ).toMatchInlineSnapshot(`null`)

      const output = Transform.compile({
        moduleId: 'border-lists.ts',
        source: BorderLists.source,
      })

      expect(output.css.match(/border-radius:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "border-radius:1px/2px",
        "border-radius:10px 20px 30px 40px / 20px 30px 40px 50px!important",
      ]
    `)
    })
    test('border lists match browser longhands in both writing modes', async () => {
      const output = Transform.compile({
        moduleId: 'border-lists.ts',
        source: BorderLists.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}.box{width:300px;height:300px}</style><div id="actual" class="box ${module.box.className}"></div><div id="control" class="box" style="${BorderLists.control}"></div>`,
        )

        for (const mode of ['horizontal-tb', 'vertical-rl']) {
          await page.evaluate((mode) => {
            for (const id of ['actual', 'control'])
              document.getElementById(id)!.style.writingMode = mode
          }, mode)

          expect(
            await page.evaluate(() => {
              const actual = getComputedStyle(
                document.getElementById('actual')!,
              )
              const control = getComputedStyle(
                document.getElementById('control')!,
              )

              const keys = [
                ...['top', 'right', 'bottom', 'left'].flatMap((side) =>
                  ['color', 'style', 'width'].map(
                    (kind) => `border-${side}-${kind}`,
                  ),
                ),
                ...['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(
                  (corner) => `border-${corner}-radius`,
                ),
                'outline-width',
              ]

              return keys.filter(
                (key) =>
                  actual.getPropertyValue(key) !==
                  control.getPropertyValue(key),
              )
            }),
          ).toMatchInlineSnapshot(`[]`)
        }

        expect(
          await page
            .locator('#actual')
            .evaluate(
              (element) => getComputedStyle(element).borderTopLeftRadius,
            ),
        ).toMatchInlineSnapshot(`"10px 20px"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('borderShorthand', () => {
  describe('compile', () => {
    test('line shorthands retain A/B/A longhand conflicts', () => {
      const a = {
        border: '2px solid red',
        outline: '1px dotted black',
        columnRule: '3px dashed blue',
      } as const

      const output = Css.compile({
        styles: Style.define({
          a,
          b: {
            borderTopColor: 'green',
            outlineWidth: '5px',
            columnRuleStyle: 'solid',
          },
          c: a,
        }),
      })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_0{border:2px solid red;}
        .z_1{outline:1px dotted black;}
        .z_2{column-rule:3px dashed blue;}
        .z_3{border-top-color:green;}
        .z_4{outline-width:5px;}
        .z_5{column-rule-style:solid;}
        .z_6{border:2px solid red;}
        .z_7{outline:1px dotted black;}
        .z_8{column-rule:3px dashed blue;}"
      `)
    })
    test('combined borders match native declarations across writing modes', async () => {
      const output = Transform.compile({
        moduleId: 'border-shorthand.ts',
        source: BorderShorthand.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )

      const a = {
        border: '2px solid red',
        outline: '1px dotted black',
        columnRule: '3px dashed blue',
      } as const

      const cascade = Css.compile({
        styles: Style.define({
          a,
          b: {
            borderTopColor: 'green',
            outlineWidth: '5px',
            columnRuleStyle: 'solid',
          },
          c: a,
        }),
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>.z-a{border-image-source:linear-gradient(red,blue)}${output.css}${cascade.css}</style><div id="parent"><div id="actual" class="${module.box.className}"></div><div id="control" style="${BorderShorthand.control}"></div></div><div id="cascade" class="${cascade.classes.a} ${cascade.classes.b} ${cascade.classes.c} z-a"></div>`,
        )

        for (const writingMode of [
          'horizontal-tb',
          'vertical-rl',
          'vertical-lr',
        ])
          for (const direction of ['ltr', 'rtl']) {
            await page.locator('#parent').evaluate(
              (element, values) => {
                element.style.writingMode = values.writingMode
                element.style.direction = values.direction
              },
              { writingMode, direction },
            )

            expect(
              await page.evaluate(() => {
                const a = getComputedStyle(document.getElementById('actual')!)
                const b = getComputedStyle(document.getElementById('control')!)

                return [
                  'border-top-width',
                  'border-top-style',
                  'border-top-color',
                  'border-right-width',
                  'border-right-style',
                  'border-right-color',
                  'border-bottom-width',
                  'border-bottom-style',
                  'border-bottom-color',
                  'border-left-width',
                  'border-left-style',
                  'border-left-color',
                  'outline-width',
                  'outline-style',
                  'outline-color',
                  'column-rule-width',
                  'column-rule-style',
                  'column-rule-color',
                ].filter(
                  (property) =>
                    a.getPropertyValue(property) !==
                    b.getPropertyValue(property),
                )
              }),
            ).toMatchInlineSnapshot(`[]`)
          }

        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).borderImageSource),
        ).toMatchInlineSnapshot(`"none"`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).borderTopColor),
        ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).outlineWidth),
        ).toMatchInlineSnapshot(`"1px"`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).columnRuleStyle),
        ).toMatchInlineSnapshot(`"dashed"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('boxLists', () => {
  describe('compile', () => {
    test('box lists preserve fallback ordering and importance', () => {
      const output = Transform.compile({
        moduleId: 'box-lists.ts',
        source: BoxLists.source,
      })

      expect(output.css.match(/padding:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "padding:1px 2px",
        "padding:4px 8px 12px 16px!important",
      ]
    `)
      expect(
        output.css.includes('margin-inline:20px 30px'),
      ).toMatchInlineSnapshot(`true`)
    })

    test('box list expansion and logical overrides match browser longhands', async () => {
      const output = Transform.compile({
        moduleId: 'box-lists.ts',
        source: BoxLists.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}.box{width:100px;height:100px;position:relative}</style><div id="actual" class="box ${module.box.className}"></div><div id="control" class="box" style="${BoxLists.control}"></div>`,
        )

        for (const mode of ['horizontal-tb', 'vertical-rl']) {
          await page.evaluate((mode) => {
            for (const id of ['actual', 'control'])
              document.getElementById(id)!.style.writingMode = mode
          }, mode)

          expect(
            await page.evaluate(() => {
              const actual = getComputedStyle(
                document.getElementById('actual')!,
              )
              const control = getComputedStyle(
                document.getElementById('control')!,
              )

              const keys = [
                'top',
                'right',
                'bottom',
                'left',
                ...['top', 'right', 'bottom', 'left'].flatMap((side) => [
                  `margin-${side}`,
                  `padding-${side}`,
                  `border-${side}-width`,
                  `scroll-margin-${side}`,
                  `scroll-padding-${side}`,
                ]),
              ]

              return keys.filter(
                (key) =>
                  actual.getPropertyValue(key) !==
                  control.getPropertyValue(key),
              )
            }),
          ).toMatchInlineSnapshot(`[]`)
        }

        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).paddingLeft),
        ).toMatchInlineSnapshot(`"16px"`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).marginTop),
        ).toMatchInlineSnapshot(`"20px"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('case', () => {
  describe('compile', () => {
    test('token names precede same-spelled case-insensitive literals', () => {
      const theme = Vars.define({ color: { Brand: 'blue', ReD: 'blue' } })
      const styles = Style.define(
        { card: { color: 'ReD', display: 'FlEx', padding: '2PX' } },
        { vars: theme },
      )

      expect(Css.compile({ styles }).css).toMatchInlineSnapshot(
        `
        ".z_0{color:var(--z0,blue);}
        .z_1{display:FlEx;}
        .z_2{padding:2PX;}"
      `,
      )
    })

    test('whitespace and importance preserve authored literal data', () => {
      const styles = Style.define({
        card: { color: ' ReD !important', display: 'BlOcK\tFlow' },
      })

      expect(Css.compile({ styles }).css).toMatchInlineSnapshot(
        `
        ".z_0{color: ReD!important;}
        .z_1{display:BlOcK	Flow;}"
      `,
      )
    })

    test('escaped literals retain native token semantics with importance', async () => {
      const theme = Vars.define({ color: { '\\72 ed': 'blue' } })

      const styles = Style.define(
        {
          card: {
            color: '\\72 ed/**/ !custom !important',
            display: 'bl\\6f ck/**/flow',
            padding: '1\\70 x',
          },
        },
        { vars: theme },
      )

      const output = Css.compile({ styles })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_0{color:\\72 ed/**/!important;}
        .z_1{display:bl\\6f ck/**/flow;}
        .z_2{padding:1\\70 x;}"
      `,
      )

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="actual" class="${output.classes.card}"></div><div id="control" style="color:red!important;display:block flow;padding:1px"></div>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return ['color', 'display', 'padding'].filter(
              (property) =>
                actual.getPropertyValue(property) !==
                control.getPropertyValue(property),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })

    test('mixed keyword, function, unit, numeric, and importance spellings match native CSS', async () => {
      const styles = Style.define({
        card: {
          color: ' #AbC !important',
          display: 'BlOcK\tFlow',
          gridColumnEnd: 'span +01',
          height: '+.5PX',
          margin: '-0px',
          order: '+01 !important',
          padding: ['2PX', '0e3 !important'],
          transform: 'RoTaTe(45DEG)',
          width: '1e2px',
        },
      })

      const output = Css.compile({ styles })
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="actual" class="${output.classes.card}"></div><div id="control" style="color:#abc!important;display:block flow;grid-column-end:span 1;height:.5px;margin:0;order:1!important;padding:0!important;transform:rotate(45deg);width:100px"></div>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return [
              'color',
              'display',
              'grid-column-end',
              'height',
              'margin',
              'order',
              'padding',
              'transform',
              'width',
            ].filter(
              (property) =>
                actual.getPropertyValue(property) !==
                control.getPropertyValue(property),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('colors', () => {
  describe('compile', () => {
    test('named colors preserve token disambiguation, fallbacks, and maps', () => {
      const output = Transform.compile({
        moduleId: 'colors.ts',
        source: Colors.source,
      })

      expect(output.css.includes('color:red;')).toMatchInlineSnapshot(`true`)
      expect(/--z-color-red,blue\)/.test(output.css)).toMatchInlineSnapshot(
        `true`,
      )
      expect(
        output.css.includes('color:navy;color:rebeccapurple!important'),
      ).toMatchInlineSnapshot(`true`)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('color:rebeccapurple!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('color:rebeccapurple!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 43,
          "line": 5,
          "name": "color",
          "source": "colors.ts",
        }
      `)
    })

    test('named colors and token scheme changes match native browser colors', async () => {
      const output = Transform.compile({
        moduleId: 'colors.ts',
        source: Colors.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage({ colorScheme: 'light' })

        await page.setContent(
          `<style>:root{color-scheme:light dark}${output.css}#theme-control{color:coral}@media(prefers-color-scheme:dark){#theme-control{color:gold}}</style><div id="literal" class="${module.literal.className}">Literal</div><div id="theme" class="${module.theme.className}">Theme</div><div id="theme-control">Control</div><div id="fallback" class="${module.fallback.className}">Fallback</div><div id="system" class="${module.system.className}">System</div><div id="system-control" style="color:CanvasText;background-color:Canvas;color-scheme:light dark;forced-color-adjust:none">Control</div>`,
        )

        expect(
          await page
            .locator('#literal')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
        expect(
          await page
            .locator('#literal')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
        expect(
          await page
            .locator('#fallback')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(102, 51, 153)"`)
        expect(
          await page
            .locator('#theme')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(255, 127, 80)"`)

        const lightSystem = await page
          .locator('#system')
          .evaluate((element) => getComputedStyle(element).color)

        await page.emulateMedia({ colorScheme: 'dark' })

        expect(
          await page
            .locator('#theme')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(255, 215, 0)"`)
        expect(
          await page.evaluate(
            () =>
              getComputedStyle(document.getElementById('theme')!).color ===
              getComputedStyle(document.getElementById('theme-control')!).color,
          ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#system')
            .evaluate(
              (element, light) => getComputedStyle(element).color !== light,
              lightSystem,
            ),
        ).toMatchInlineSnapshot(`true`)

        await page.emulateMedia({ forcedColors: 'active' })

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('system')!)
            const b = getComputedStyle(
              document.getElementById('system-control')!,
            )

            return ['color', 'background-color'].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('columns', () => {
  describe('compile', () => {
    test('columns preserve tokens, count keywords, priority, and maps', () => {
      const output = Transform.compile({
        moduleId: 'columns.ts',
        source: Columns.source,
      })
      const declarations: string[] = []

      CssTree.walk(CssTree.parse(output.css), (node) => {
        if (node.type === 'Declaration' && !node.property.startsWith('--'))
          declarations.push(
            `${node.property}:${CssTree.generate(node.value)}${node.important ? '!' : ''}`,
          )
      })

      expect(declarations).toMatchInlineSnapshot(`
        [
          "column-count:2",
          "column-width:auto",
          "column-gap:12px",
          "column-fill:auto",
          "column-rule-color:var(--z-color-rule,#06c)",
          "column-rule-style:solid",
          "column-rule-width:thin",
          "orphans:2",
          "widows:3",
          "break-before:auto",
          "break-before:column!",
          "break-after:auto",
          "break-inside:avoid-column",
          "column-span:none",
          "column-span:all",
          "break-before:auto",
          "column-count:auto",
          "column-width:80px",
          "column-gap:normal",
          "column-fill:balance",
        ]
      `)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('break-before:column!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          column: lines[line]!.indexOf('break-before:column!important'),
          line: line + 1,
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 51,
          "line": 4,
          "name": "breakBefore",
          "source": "columns.ts",
        }
      `)
    })

    test('columns match browser rules and forced fragmentation', async () => {
      const output = Transform.compile({
        moduleId: 'columns.ts',
        source: Columns.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>section{width:240px;height:100px}p{height:20px;margin:0}${output.css}</style><section id="actual" class="${module.columns.className}"><p>First</p><p class="${module.fragment.className}">Second</p></section><section id="control" style="${Columns.controls.columns}"><p>First</p><p style="${Columns.controls.fragment}">Second</p></section>`,
        )

        expect(
          await page.locator('#actual').evaluate((element) => {
            const children = element.querySelectorAll('p')

            return (
              children[1]!.getBoundingClientRect().left -
              children[0]!.getBoundingClientRect().left
            )
          }),
        ).toMatchInlineSnapshot(`126`)

        for (const direction of ['ltr', 'rtl']) {
          await page.locator('body').evaluate((element, direction) => {
            element.style.direction = direction
          }, direction)

          expect(
            await page.evaluate(() => {
              const a = document.getElementById('actual')!
              const b = document.getElementById('control')!

              const properties = [
                'column-count',
                'column-width',
                'column-gap',
                'column-fill',
                'column-rule-color',
                'column-rule-style',
                'column-rule-width',
                'column-span',
                'break-before',
                'break-after',
                'break-inside',
                'orphans',
                'widows',
              ]

              return ['', 'p', 'p:nth-child(2)'].filter((selector) => {
                const x = selector ? a.querySelector(selector)! : a
                const y = selector ? b.querySelector(selector)! : b
                const xx = getComputedStyle(x),
                  yy = getComputedStyle(y)

                return (
                  properties.some(
                    (property) =>
                      xx.getPropertyValue(property) !==
                      yy.getPropertyValue(property),
                  ) ||
                  x.getBoundingClientRect().left -
                    a.getBoundingClientRect().left !==
                    y.getBoundingClientRect().left -
                      b.getBoundingClientRect().left
                )
              })
            }),
          ).toMatchInlineSnapshot(`[]`)
        }
      } finally {
        await browser.close()
      }
    })
  })
})

describe('conditions', () => {
  const source =
    'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const theme=Vars.define({breakpoint:{tablet:"48rem",desktop:"64rem"},container:{card:"24rem"},containerNames:["sidebar"],spacing:{small:"4px",large:"16px"}}); const themeConfig=Config.create({vars:theme}); export const box=themeConfig.style({padding:"small", ":hover":{padding:"large"}, "@media tablet..desktop":{width:\'100px !custom\',"&[data-active]":{height:\'20px !custom\'}}, "@container sidebar >=card":{display:"grid"},"@supports (display:grid)":{gap:"small"},"@starting-style":{opacity:0}})()'
  describe('compile', () => {
    test('preserves media case and ignores selector comments for dynamic locality', () => {
      const source =
        'import {style} from "zyzz"; style((v:{alpha:number})=>({"&/* state, & */:hover":{opacity:v.alpha},"@media SCREEN":{color:"red"}}))'
      const output = Transform.compile({ moduleId: 'comments.ts', source })

      expect(output.css).toContain('@media SCREEN')
      expect(output.css).toContain('opacity:var(')
    })
    test('reports invalid condition grammar at each authored key', () => {
      const source =
        'import {style} from "zyzz"; style({"@supports display: grid":{color:"red"},"@supports color: red":{color:"blue"}})'

      try {
        Transform.compile({ moduleId: 'locations.ts', source })
        throw new Error('Expected source diagnostics')
      } catch (error) {
        if (!(error instanceof Source.ExtractError)) throw error

        expect(error.diagnostics.map((diagnostic) => diagnostic.start)).toEqual(
          [
            source.indexOf('"@supports display'),
            source.indexOf('"@supports color'),
          ],
        )
      }
    })
    test('scopes pseudo selectors containing ampersands in data', () => {
      const output = Transform.compile({
        moduleId: 'data.ts',
        source: `import { style } from 'zyzz'; style({ ':hover[data-token="a&b"]': { color: 'red' } })`,
      })

      expect(output.css).toContain('&:hover[data-token="a&b"]')
      expect(() =>
        Transform.compile({
          moduleId: 'backdrop.ts',
          source: `import { style } from 'zyzz'; style((v: { alpha: number }) => ({ '::backdrop': { opacity: v.alpha } }))`,
        }),
      ).toThrow()
    })
    test('maps condition keys and supports local dynamic selector lists', () => {
      const source = `import {style} from 'zyzz'; style((v:{alpha:number})=>({'&:hover, &:focus':{opacity:v.alpha},'@media screen':{color:'red'}}))`
      const output = Transform.compile({ moduleId: 'keys.ts', source })
      const map = new Trace.TraceMap(output.cssMap)

      for (const key of ['&:hover, &:focus', '@media screen']) {
        const lines = output.css.slice(0, output.css.indexOf(key)).split('\n')
        const location = Trace.originalPositionFor(map, {
          line: lines.length,
          column: lines.at(-1)!.length,
        })

        expect(location.column).toBe(source.indexOf(`'${key}'`))
      }
    })
    test('freezes nested diagnostic paths and locations', () => {
      try {
        Reflect.apply(Style.define, undefined, [
          { box: { ':hover': { color: [] } } },
          {
            locations: [
              {
                path: ['box', ':hover', 'color'],
                source: 'input.ts',
                start: 1,
                end: 2,
              },
            ],
          },
        ])
        throw new Error('Expected validation failure')
      } catch (error) {
        expect(error).toBeInstanceOf(Style.InvalidError)

        if (!(error instanceof Style.InvalidError)) throw error

        const diagnostic = error.diagnostics[0]!

        expect(
          [
            diagnostic,
            diagnostic.path,
            diagnostic.location,
            diagnostic.location?.path,
          ].every(Object.isFrozen),
        ).toBe(true)
        expect(diagnostic.location?.path).toEqual(['box', ':hover', 'color'])
      }
    })

    test('preserves explicit pseudo relationships and qualified media types', () => {
      expect(
        Transform.compile({
          moduleId: 'selectors.ts',
          source:
            'import {style} from "zyzz"; style({":where(.dark) &":{color:"red"},"@media only screen":{display:"grid"},"@media not print":{display:"block"}})',
        }).css,
      ).toMatchInlineSnapshot(
        `
        ".z_Osf2pa0{:where(.dark) &{color:red;}}
        @media only screen{.z_Osf2pa1{display:grid;}}
        @media not print{.z_Osf2pa2{display:block;}}"
      `,
      )
    })
    test('maps declarations after matching text in feature conditions', () => {
      const source =
        'import {style} from "zyzz"; style({"@supports (display:grid)":{display:"grid"}})'
      const output = Transform.compile({ moduleId: 'supports.ts', source })
      const column = output.css.lastIndexOf('display:')

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: 1,
          column,
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 63,
          "line": 1,
          "name": "display",
          "source": "supports.ts",
        }
      `)
    })
    test('rejects private dynamic values on relationship subjects', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'sibling.ts',
          source:
            'import {style} from "zyzz"; style((v:{alpha:number})=>({"& + .peer":{opacity:v.alpha}}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(`
        [Source.ExtractError: sibling.ts:77: Dynamic values require conditions that select the styled element.
        sibling.ts:77: Expected a literal string or number; expressions are not evaluated.]
      `)
    })
    test('preserves functional pseudo lists and multiline conditions', () => {
      const output = Transform.compile({
        moduleId: 'lines.ts',
        source:
          'import {style} from "zyzz"; style({":is(:hover,:focus)":{color:"red"},"@media (width > 1px)\\n and (hover: hover)":{padding:"2px"}})',
      })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_YB3XzN0{&:is(:hover,:focus){color:red;}}
        @media (width > 1px)  and (hover: hover){.z_YB3XzN1{padding:2px;}}"
      `,
      )
    })
    test('rejects malformed conditions in the direct compiler pipeline', () => {
      expect(() =>
        Css.compile({
          styles: Style.define({ body: { '&[': { color: 'red' } } }),
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Style.InvalidError: ["body","&["]: Unbalanced condition delimiters.]`,
      )
    })
    test('Chromium retains flat A/B/A overrides around conditional declarations', async () => {
      const output = Css.compile({
        styles: Style.define({
          a: { marginLeft: '2px' },
          b: { marginLeft: '4px', ':hover': { color: 'red' } },
          c: { marginLeft: '2px' },
        }),
      })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_0{margin-left:2px;}
        .z_1{margin-left:4px;}
        .z_2{&:hover{color:red;}}
        .z_3{margin-left:2px;}"
      `)

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="box" class="${output.classes.a} ${output.classes.b} ${output.classes.c}">Box</div>`,
        )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).marginLeft),
        ).toMatchInlineSnapshot(`"2px"`)
      } finally {
        await browser.close()
      }
    })
    test('maps nested declarations and passes through raw media lists', () => {
      const source =
        'import {style} from "zyzz"; style({color:"red","@media screen, print":{padding:"2px"}})'
      const output = Transform.compile({ moduleId: 'mapped.ts', source })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_A1zKnx0{color:red;}
        @media screen, print{.z_A1zKnx1{padding:2px;}}"
      `,
      )

      const prefix = output.css.slice(0, output.css.indexOf('padding:'))
      const lines = prefix.split('\n')
      const column = lines.at(-1)!.length

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: lines.length,
          column,
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 71,
          "line": 1,
          "name": "padding",
          "source": "mapped.ts",
        }
      `)
    })
    test('requires nesting in every selector list member', () => {
      for (const selector of ['&:hover, :focus', ':hover, &:focus'])
        expect(() =>
          Transform.compile({
            moduleId: 'list.ts',
            source: `import {style} from 'zyzz'; style({${JSON.stringify(selector)}:{color:'red'}})`,
          }),
        ).toThrow('Selector lists require explicit & selectors.')

      expect(
        Transform.compile({
          moduleId: 'list.ts',
          source: `import {style} from 'zyzz'; style({'&:is(:hover, :focus), &:active':{color:'red'}})`,
        }).css,
      ).toContain('&:is(')
    })
    test('requires explicit nesting in pseudo selector lists', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'list.ts',
          source:
            'import {style} from "zyzz"; style({":hover, :focus":{color:"red"}})',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: list.ts:35: Selector lists require explicit & selectors.]`,
      )
    })
    test('preserves authored nesting and resolves distinct threshold domains', () => {
      expect(Transform.compile({ moduleId: 'conditions.ts', source }).css)
        .toMatchInlineSnapshot(`
          ".z-theme-theme{--z-spacing-small:4px;--z-spacing-large:16px;}
          .z_FlkpGI0{padding:var(--z-spacing-small,4px);}
          .z_FlkpGI1{&:hover{padding:var(--z-spacing-large,16px);}}
          @media (48rem <= width < 64rem){.z_FlkpGI2{width:100px;}}
          @media (48rem <= width < 64rem){.z_FlkpGI3{&[data-active]{height:20px;}}}
          .z_FlkpGI4{@container sidebar (width >= 24rem){display:grid;}}
          @supports (display:grid){.z_FlkpGI5{gap:var(--z-spacing-small,4px);}}
          .z_FlkpGI6{@starting-style{opacity:0;}}"
        `)
    })
    test('retains dynamic and theme variables inside nested contexts', () => {
      expect(
        Transform.compile({
          moduleId: 'dynamic.ts',
          source:
            'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const theme=Vars.define({spacing:{gap:"4px"}}); const themeConfig=Config.create({vars:theme}); export const box=themeConfig.style((values:{alpha:number})=>({":hover":{opacity:values.alpha,marginLeft:`calc(${theme.spacing.gap} + 2px) !custom`}}))',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-spacing-gap:4px;}
        .z_RPENcp0{&:hover{opacity:var(--z-RPENcp-box-alpha);}}
        .z_RPENcp1{&:hover{margin-left:calc(var(--z-spacing-gap,4px) + 2px);}}"
      `)
    })
    test('resolves imported thresholds through the packed contract', () => {
      const library = Graph.compile({
        modules: {
          'theme.ts':
            'import {Vars} from "zyzz"; export const theme=Vars.define({breakpoint:{tablet:"48rem"}})',
        },
      })

      const output = Graph.compile({
        contracts: { 'library.js': library.contracts['theme.ts']! },
        imports: { 'app.ts': { library: 'library.js', zyzz: null } },
        modules: {
          'app.ts':
            'import {Config} from \'zyzz\';\nimport {theme} from "library"; const themeConfig=Config.create({vars:theme}); export const box=themeConfig.style({"@media tablet":{width:"100px"}})()',
        },
      })

      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{}
        @media (width >= 48rem){.z_Zf5JrJ0{width:100px;}}"
      `)
    })
    test.each([
      ['@media missing', 'Unknown query threshold.'],
      ['@media desktop..tablet', 'Query range must increase.'],
      ['@container missing >=card', 'Unknown container name.'],
    ])('rejects invalid alias %s', (key, message) => {
      try {
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {Config} from "zyzz"; const {style}=Config.create({vars:{breakpoint:{tablet:"48rem",desktop:"64rem"},container:{card:"24rem"}}}); style({${JSON.stringify(key)}:{width:"1px"}})`,
        })
        throw new Error('Expected rejection')
      } catch (error) {
        expect(
          (error as Error).message.endsWith(message!),
        ).toMatchInlineSnapshot(`true`)
      }
    })
    test('rejects malformed selector syntax before emission', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: 'import {style} from "zyzz"; style({"&[":{color:"red"}})',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:35: Unbalanced condition delimiters.]`,
      )
    })
    test('Chromium resolves named container thresholds', async () => {
      const output = Transform.compile({
        moduleId: 'container.ts',
        source:
          'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const theme=Vars.define({container:{card:"24rem"},containerNames:["sidebar"]}); const themeConfig=Config.create({vars:theme}); export const box=themeConfig.style({width:"40px !custom","@container sidebar >=card":{width:"100px !custom"}})()',
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><section id="container" style="container-type:inline-size;container-name:sidebar;width:500px"><div id="box" class="${Object.values(output.classes)[0]}"></div></section>`,
        )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"100px"`)

        await page
          .locator('#container')
          .evaluate(
            (element) => ((element as HTMLElement).style.width = '300px'),
          )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"40px"`)
      } finally {
        await browser.close()
      }
    })
    test('Chromium evaluates pointer and viewport conditions with ordered declarations', async () => {
      const output = Transform.compile({
        moduleId: 'browser.ts',
        source:
          'import {style} from "zyzz"; export const box=style({width:"40px",height:"20px",":hover":{width:"80px"},"@media (width >= 800px)":{height:"40px"},"&[data-active]":{opacity:0.5}})()',
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage({
          viewport: { width: 600, height: 500 },
        })

        await page.setContent(
          `<style>${output.css}</style><div id="box" class="${Object.values(output.classes)[0]}"></div>`,
        )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"40px"`)

        await page.locator('#box').hover()

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"80px"`)

        await page.setViewportSize({ width: 900, height: 500 })

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).height),
        ).toMatchInlineSnapshot(`"40px"`)

        await page
          .locator('#box')
          .evaluate((element) => element.setAttribute('data-active', ''))

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.5"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('conformance', () => {
  describe('compile', () => {
    test('CSS conformance enforces full coverage and exact threshold misses', async () => {
      const root = Path.resolve(import.meta.dirname, '../..')

      const inventory = JSON.parse(
        await Fs.readFile(
          Path.join(root, 'test/conformance/coverage.json'),
          'utf8',
        ),
      ) as {
        families: {
          properties: Record<string, { grammar: string; status: string }>
        }
      }

      const current = ChildProcess.spawnSync(
        process.execPath,
        ['scripts/css-conformance.ts', '--require-full'],
        { cwd: root, encoding: 'utf8', timeout: 10_000 },
      )

      expect(current.status).toMatchInlineSnapshot(`0`)
      expect(current.stderr).toMatchInlineSnapshot(`""`)
      expect(
        current.stdout.includes(
          'Partial properties receive no completion credit.',
        ),
      ).toMatchInlineSnapshot(`true`)

      const directory = await Fs.mkdtemp(
        Path.join(root, '.fixture-conformance-threshold-'),
      )

      try {
        // These inventories test threshold arithmetic, not implementation conformance.
        for (const entry of Object.values(inventory.families.properties))
          entry.status = 'supported'

        const file = Path.join(directory, 'coverage.json')

        await Fs.writeFile(file, JSON.stringify(inventory))

        const complete = ChildProcess.spawnSync(
          process.execPath,
          ['scripts/css-conformance.ts', '--inventory', file, '--require-full'],
          { cwd: root, encoding: 'utf8', timeout: 10_000 },
        )

        expect(complete.status).toMatchInlineSnapshot(`0`)
        expect(
          complete.stdout.includes('1009/1009 (100.00%)'),
        ).toMatchInlineSnapshot(`true`)

        inventory.families.properties.color!.status = 'partial'
        await Fs.writeFile(file, JSON.stringify(inventory))

        const partial = ChildProcess.spawnSync(
          process.execPath,
          ['scripts/css-conformance.ts', '--inventory', file, '--require-full'],
          { cwd: root, encoding: 'utf8', timeout: 10_000 },
        )

        expect(partial.status).toMatchInlineSnapshot(`1`)
        expect(partial.stderr).toMatchInlineSnapshot(
          `"CSS property conformance is below 100%: 1008/1009 fully supported; 1 incomplete.\n"`,
        )
        expect(
          partial.stdout.includes('| color | partial |'),
        ).toMatchInlineSnapshot(`true`)

        inventory.families.properties.color!.status = 'supported'
        inventory.families.properties.color!.grammar = 'unreviewed'
        await Fs.writeFile(file, JSON.stringify(inventory))

        const stale = ChildProcess.spawnSync(
          process.execPath,
          ['scripts/css-conformance.ts', '--inventory', file, '--require-full'],
          { cwd: root, encoding: 'utf8', timeout: 10_000 },
        )

        expect(stale.status).toMatchInlineSnapshot(`1`)
        expect(
          stale.stderr.includes('Changed properties: color'),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await Fs.rm(directory, { force: true, recursive: true })
      }
    })
  })
})

describe('containerSizing', () => {
  describe('compile', () => {
    test('container sizing preserves fallbacks and field policies', () => {
      const output = Transform.compile({
        moduleId: 'sizing.ts',
        source: ContainerSizing.source,
      })

      expect(output.css.match(/container-type:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "container-type:normal",
        "container-type:inline-size!important",
      ]
    `)
      expect(output.css.includes('field-sizing:content')).toMatchInlineSnapshot(
        `true`,
      )
      expect(
        output.css.includes('interpolate-size:allow-keywords'),
      ).toMatchInlineSnapshot(`true`)
    })

    test('container queries and field growth match native browser controls', async () => {
      const output = Transform.compile({
        moduleId: 'sizing.ts',
        source: ContainerSizing.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}input{font:16px monospace}.child{height:10px;width:10px}@container(min-width:150px){.child{width:100px}}</style><div id="container" class="${module.container.className}"><div class="child"></div></div><div id="control" style="container-type:inline-size;width:200px"><div class="child"></div></div><input id="field" class="${module.field.className}" value="a"><input id="field-control" style="field-sizing:content;interpolate-size:allow-keywords" value="a"><input id="fixed" style="field-sizing:fixed" value="a">`,
        )

        expect(
          await page
            .locator('#container .child')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"100px"`)

        await page.evaluate(() => {
          for (const id of ['container', 'control'])
            document.getElementById(id)!.style.width = '100px'
        })

        expect(
          await page
            .locator('#container .child')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"10px"`)
        expect(
          await page.evaluate(
            () =>
              document
                .querySelector('#container .child')!
                .getBoundingClientRect().width ===
              document.querySelector('#control .child')!.getBoundingClientRect()
                .width,
          ),
        ).toMatchInlineSnapshot(`true`)

        const initial = await page
          .locator('#field')
          .evaluate((element) => element.getBoundingClientRect().width)
        const fixed = await page
          .locator('#fixed')
          .evaluate((element) => element.getBoundingClientRect().width)

        for (const id of ['field', 'field-control', 'fixed'])
          await page.locator(`#${id}`).fill('a much longer input value')

        expect(
          await page
            .locator('#field')
            .evaluate(
              (element, width) => element.getBoundingClientRect().width > width,
              initial,
            ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#fixed')
            .evaluate(
              (element, width) =>
                element.getBoundingClientRect().width === width,
              fixed,
            ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page.evaluate(
            () =>
              document.getElementById('field')!.getBoundingClientRect()
                .width ===
              document.getElementById('field-control')!.getBoundingClientRect()
                .width,
          ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#field')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue('interpolate-size'),
            ),
        ).toMatchInlineSnapshot(`"allow-keywords"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('contributions', () => {
  describe('stylesheet contributions', () => {
    test('preserves layer discovery order and omits optional font descriptors', () => {
      const output = Transform.compile({
        moduleId: 'effects.ts',
        source: `import {layers,fontFace,global} from 'zyzz/web'; layers(['reset','base']); layers(['components']); fontFace({fontFamily:'App',src:'url(/app.woff2)',fontWeight:undefined}); global({'body::before':{content:'"url(relative)"'}})`,
      })

      expect(output.css).toMatchInlineSnapshot(`
      "@layer reset,base,components;
      @font-face{font-family:App;src:url(/app.woff2);}
      body::before{content:"url(relative)";}"
    `)
    })
    test('rejects conditional classes and runtime descriptors', () => {
      for (const source of [
        `class Never { static { global({body:{color:'red'}}) } }`,
        `const unused = false ? class { static { global({body:{color:'red'}}) } } : null`,
        `const undefined = getWeight(); fontFace({fontFamily:'App',src:'url(/app.woff2)',fontWeight:undefined})`,
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'bad.ts',
            source: `import {global,fontFace} from 'zyzz/web'; ${source}`,
          }),
        ).toThrow()
    })
    test('resolves an immutable shadowed undefined descriptor instead of omitting it', () => {
      const output = Transform.compile({
        moduleId: 'font.ts',
        source: `import {fontFace} from 'zyzz/web';const undefined='bold';fontFace({fontFamily:'App',src:'url(/app.woff2)',fontWeight:undefined});`,
      })
      expect(output.css).toContain('font-weight:bold')
    })
    test('locates a malformed later contribution at its own span', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'located.ts',
          source: `import {global} from 'zyzz/web'; global({body:{color:'red'}}); global({body:{color:unknown}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: located.ts:63: Stylesheet contributions require literal data.]`,
      )
    })

    test('Chromium applies global layers and static keyframes', async () => {
      const output = Transform.compile({
        moduleId: 'browser.ts',
        source:
          'import {global,keyframes,layers} from "zyzz/web"; layers(["reset","base"]); const fade=keyframes({from:{opacity:0},to:{opacity:1}}); global({"@layer reset":{body:{margin:"20px"}},"@layer base":{body:{margin:0}},body:{animationName:fade,animationDuration:"1s",animationTimingFunction:"linear",animationDelay:"-0.5s",animationPlayState:"paused"}})',
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent('<body>Animation</body>')
        await page.addStyleTag({ content: output.css })

        expect(
          await page.evaluate(() => getComputedStyle(document.body).margin),
        ).toMatchInlineSnapshot(`"0px"`)
        expect(
          await page.evaluate(() => getComputedStyle(document.body).opacity),
        ).toMatchInlineSnapshot(`"0.5"`)
      } finally {
        await browser.close()
      }
    })
    test('extracts global rules, fonts, layers and live animation names', () => {
      const result = Transform.compile({
        moduleId: 'app/styles.ts',
        source:
          'import {style} from "zyzz"; import {global,fontFace,keyframes,layers} from "zyzz/web"; layers(["reset","base"]); global({"@layer reset":{"body":{margin:0}},"body":{color:"red"}}); fontFace({fontFamily:"App",src:"url(/font.woff2)",fontDisplay:"swap"}); const unused=keyframes({from:{opacity:0},to:{opacity:1}}); const fade=keyframes({from:{opacity:0},to:{opacity:1}}); export const box=style({animationName:fade})()',
      })

      expect(result.css).toMatchInlineSnapshot(`
        "@layer reset,base;
        @layer reset{body{margin:0;}}
        body{color:red;}
        @font-face{font-family:App;src:url(/font.woff2);font-display:swap;}
        @keyframes z-k-fade{from{opacity:0;}to{opacity:1;}}
        .z_qfO5i60{animation-name:z-k-fade;}"
      `)
      expect(result.code).toMatchInlineSnapshot(
        `"  void 0; void 0; void 0; const unused="z-k-unused"; const fade="z-k-fade"; export const box=({className:"z_qfO5i60"})"`,
      )
    })
    test('keeps theme references live in global rules', () => {
      expect(
        Transform.compile({
          moduleId: 'app.ts',
          source:
            'import {Vars} from "zyzz"; import {global} from "zyzz/web"; const theme=Vars.define({color:{ink:"red"}}); global({body:{color:theme.color.ink}})',
        }).css,
      ).toMatchInlineSnapshot(`
        "body{color:var(--z-color-ink,red);}
        .z-theme-theme{--z-color-ink:red;}"
      `)
    })
    test('rejects invalid contributions', () => {
      const failures = [
        'if(true) global({body:{color:"red"}})',
        'global({"[":{color:"red"}})',
        'layers(["one","two"]); layers(["two","one"])',
        'export const frames=keyframes({"101%":{opacity:0}})',
      ].map((source) => {
        try {
          Transform.compile({
            moduleId: 'bad.ts',
            source:
              'import {global,layers,keyframes} from "zyzz/web";' + source,
          })

          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      })

      expect(failures).toMatchInlineSnapshot(`
      [
        "bad.ts:58: Stylesheet contributions require direct module-level calls and constant named stylesheet bindings.",
        "bad.ts:49: Unexpected end of input",
        "bad.ts:49: ["contributions"]: Conflicting layer order constraints.",
        "bad.ts:69: Keyframe stops require from, to, 0–100% offsets, or named timeline percentages.",
      ]
    `)
    })
    test('collects unimported effects once and replaces the snapshot on deletion', () => {
      const compiler = Graph.create()

      const modules = {
        'app.ts':
          'import {style} from "zyzz"; export const box=style({color:"blue"})()',
        'global.ts':
          'import {global,layers} from "zyzz/web"; layers(["reset","app"]); global({body:{margin:0}})',
      }

      const first = compiler.compile({ modules })

      expect({
        shared: first.sharedCss,
        modules: Object.values(first.modules).map((value) => value.css),
      }).toMatchInlineSnapshot(`
        {
          "modules": [
            ".z_Zf5JrJ0{color:blue;}",
            "",
          ],
          "shared": "@layer reset,app;
        body{margin:0;}",
        }
      `)
      expect(
        compiler.compile({ modules: { 'app.ts': modules['app.ts'] } })
          .sharedCss,
      ).toMatchInlineSnapshot(`undefined`)
    })
  })
})

describe('controls', () => {
  describe('compile', () => {
    test('input controls preserve numeric tab fallbacks, touch combinations, and maps', () => {
      const output = Transform.compile({
        moduleId: 'controls.ts',
        source: Controls.source,
      })

      expect(output.css.match(/tab-size:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "tab-size:4",
        "tab-size:8!important",
      ]
    `)
      expect(
        output.css.includes('touch-action:pinch-zoom pan-left pan-up'),
      ).toMatchInlineSnapshot(`true`)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('tab-size:8!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('tab-size:8!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 165,
          "line": 3,
          "name": "tabSize",
          "source": "controls.ts",
        }
      `)
    })

    test('list markers match native pixels and input controls match independent CSS', async () => {
      const output = Transform.compile({
        moduleId: 'controls.ts',
        source: Controls.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>ol{margin:0;padding:10px;width:180px;font:16px monospace;background:white}pre{display:inline-block;font:16px monospace}${output.css}</style><ol id="list" class="${module.list.className}"><li>First</li><li>Second</li></ol><ol id="list-control" style="${Controls.controls.list}"><li>First</li><li>Second</li></ol><ol id="unmarked" style="list-style-type:none"><li>First</li><li>Second</li></ol><pre id="input" class="${module.input.className}">a\tb</pre><pre id="input-control" style="${Controls.controls.input}">a\tb</pre>`,
        )

        expect(
          await page.evaluate(() => {
            const properties = {
              input: [
                'appearance',
                'overflow-anchor',
                'overscroll-behavior-block',
                'overscroll-behavior-inline',
                'scrollbar-width',
                'tab-size',
                'text-size-adjust',
                'touch-action',
              ],
              list: [
                'line-break',
                'list-style-position',
                'list-style-type',
                'text-spacing-trim',
                'unicode-bidi',
              ],
            }

            return Object.entries(properties).flatMap(([name, keys]) => {
              const a = getComputedStyle(document.getElementById(name)!)
              const b = getComputedStyle(
                document.getElementById(`${name}-control`)!,
              )

              return keys.filter(
                (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
              )
            })
          }),
        ).toMatchInlineSnapshot(`[]`)

        const actual = await page.locator('#list').screenshot()
        const control = await page.locator('#list-control').screenshot()
        const unmarked = await page.locator('#unmarked').screenshot()

        expect(actual.equals(control)).toMatchInlineSnapshot(`true`)
        expect(actual.equals(unmarked)).toMatchInlineSnapshot(`false`)
        expect(
          await page.evaluate(
            () =>
              document.getElementById('input')!.getBoundingClientRect()
                .width ===
              document.getElementById('input-control')!.getBoundingClientRect()
                .width,
          ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#input')
            .evaluate((element) => getComputedStyle(element).tabSize),
        ).toMatchInlineSnapshot(`"8"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('corners', () => {
  describe('compile', () => {
    test('corner and layout values match independent grammar', () => {
      const lexer = Conformance.lexer()

      for (const declarations of Object.values(Corners.styles)) {
        for (const [property, value] of Object.entries(declarations)) {
          const output = Transform.compile({
            moduleId: 'corners.ts',
            source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}});`,
          })
          const name = Conformance.name(property)

          expect(output.css.includes(`${name}:${value}`)).toMatchInlineSnapshot(
            `true`,
          )
          expect(
            lexer.matchProperty(name, String(value)).error,
          ).toMatchInlineSnapshot(`null`)
        }
      }
    })
    test('bevel clipping matches a native polygon and all preserves authored overrides', async () => {
      const output = Transform.compile({
        moduleId: 'corners.ts',
        source: Corners.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="bevel" class="${module.bevel.className}" style="position:absolute;left:0;top:0"></div><div id="control" style="position:absolute;left:150px;top:0;width:100px;height:100px;background:blue;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)"></div><div id="reset" class="${module.first.className} ${module.reset.className} ${module.last.className}"></div><div id="grid" class="${module.grid.className}"></div>`,
        )

        expect(
          await page.evaluate(() => CSS.supports('corner-shape', 'bevel')),
        ).toMatchInlineSnapshot(`true`)

        for (const point of [
          { x: 20, y: 20, inside: false },
          { x: 30, y: 30, inside: true },
          { x: 50, y: 50, inside: true },
        ]) {
          expect(
            await page.evaluate(
              ({ x, y, inside }) =>
                (document.elementFromPoint(x, y)?.id === 'bevel') === inside,
              point,
            ),
          ).toMatchInlineSnapshot(`true`)
          expect(
            await page.evaluate(
              ({ x, y, inside }) =>
                (document.elementFromPoint(x + 150, y)?.id === 'control') ===
                inside,
              point,
            ),
          ).toMatchInlineSnapshot(`true`)
        }

        expect(
          await page
            .locator('#reset')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
        expect(
          await page
            .locator('#reset')
            .evaluate((element) => getComputedStyle(element).fontWeight),
        ).toMatchInlineSnapshot(`"700"`)
        expect(
          await page
            .locator('#grid')
            .evaluate((element) => getComputedStyle(element).rowGap),
        ).toMatchInlineSnapshot(`"10px"`)
        expect(
          await page
            .locator('#grid')
            .evaluate((element) => getComputedStyle(element).columnGap),
        ).toMatchInlineSnapshot(`"12px"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('custom', () => {
  const source = `import { style } from 'zyzz';
export const parent = style({'--Accent':'red', '--accent':'blue', '--data':'"a;b:c"', '--count':2})();
export const child = style({all:'initial', color:'var(--Accent)', backgroundColor:'var(--accent)', '--choice':['red','blue !important']})();`

  describe('compile', () => {
    test('preserves case-sensitive names and custom declaration data', () => {
      const output = Transform.compile({ moduleId: 'custom.ts', source })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_SM3vav0{--Accent:red;}
        .z_SM3vav1{--accent:blue;}
        .z_SM3vav2{--data:"a;b:c";}
        .z_SM3vav3{--count:2;}
        .z_SM3vav4{all:initial;}
        .z_SM3vav5{color:var(--Accent);}
        .z_SM3vav6{background-color:var(--accent);}
        .z_SM3vav7{--choice:red;--choice:blue!important;}"
      `)
    })

    test('escaped punctuation retains custom-property data and importance', () => {
      const styles = Style.define({
        punctuation: {
          '--escaped': 'hello\\!',
          '--escapedWord': 'hello\\!important',
          '--even': 'hello\\\\ !important',
          '--space': 'hello\\  !important',
        },
      })

      expect(Css.compile({ styles }).css).toMatchInlineSnapshot(
        `
        ".z_0{--escaped:hello\\!;}
        .z_1{--escapedWord:hello\\!important;}
        .z_2{--even:hello\\\\!important;}
        .z_3{--space:hello\\ !important;}"
      `,
      )
    })

    test('all preserves inherited custom properties and direction', async () => {
      const output = Transform.compile({ moduleId: 'custom.ts', source })
      const javascript = await Esbuild.transform(output.code, {
        format: 'esm',
        loader: 'ts',
      })
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(javascript.code).toString('base64')}`
      )
      const classes = ['parent', 'child'].map(
        (name) => module[name].className as string,
      )

      expect(classes.length).toMatchInlineSnapshot(`2`)

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div class="${classes[0]}" dir="rtl"><div id="child" class="${classes[1]}"></div></div>`,
        )

        const result = await page.locator('#child').evaluate((element) => {
          const style = getComputedStyle(element)

          return {
            accent: style.getPropertyValue('--Accent'),
            background: style.backgroundColor,
            choice: style.getPropertyValue('--choice'),
            color: style.color,
            direction: style.direction,
          }
        })

        expect(result).toMatchInlineSnapshot(`
        {
          "accent": "red",
          "background": "rgb(0, 0, 255)",
          "choice": "blue",
          "color": "rgb(255, 0, 0)",
          "direction": "rtl",
        }
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('descriptorAcceptance', () => {
  describe('compile', () => {
    for (const family of Object.keys(
      NamedDescriptors.definitions,
    ) as (keyof typeof NamedDescriptors.definitions)[]) {
      test(`retains every ${family} descriptor across packed publication with maps`, () => {
        const source = NamedDescriptors.source(family)
        const direct = Transform.compile({ moduleId: 'names.ts', source })
        const library = Graph.compile({ modules: { 'names.ts': source } })
        const packed = Graph.compile({
          contracts: { 'lib/names.js': library.contracts['names.ts']! },
          imports: { 'app.ts': { lib: 'lib/names.js' } },
          modules: {
            'app.ts':
              family === 'font' ? `import 'lib';` : `export {name} from 'lib';`,
          },
        })
        for (const key of NamedDescriptors.keys[family]) {
          expect(direct.css.includes(`${key}:`)).toMatchInlineSnapshot('true')
          expect(packed.sharedCss?.includes(`${key}:`)).toMatchInlineSnapshot(
            'true',
          )
        }
        expect(direct.css.includes('@layer names')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          packed.sharedCss?.includes('@media print'),
        ).toMatchInlineSnapshot('true')
        expect(
          packed.sharedCss?.includes('body{color:red;}'),
        ).toMatchInlineSnapshot('true')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }).source,
        ).toMatchInlineSnapshot('"lib/names.ts"')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }).line,
        ).toMatchInlineSnapshot('2')
      })
    }
    test('rejects invalid font counter and palette descriptor grammar before output', () => {
      const failures = [
        `export const x=counterStyle({system:'numeric',symbols:'"0"'});`,
        `export const x=counterStyle({system:'additive',additiveSymbols:'1 "I",10 "X"'});`,
        `export const x=counterStyle({symbols:'"x"',range:'5 1'});`,
        `export const x=counterStyle({symbols:'"x"',pad:'nope'});`,
        `fontFace({fontFamily:'Body',src:'url(/a)',fontWeight:'garbage'});`,
        `fontFace({fontFamily:'Body',src:'url(/a)',sizeAdjust:'-10%'});`,
        `export const x=fontPaletteValues({fontFamily:'Body',overrideColors:'0 currentColor'});`,
        `export const x=fontPaletteValues({fontFamily:'Body',overrideColors:'0 color-mix(in srgb,red,currentColor)'});`,
        `export const x=fontPaletteValues({fontFamily:'Body',overrideColors:'-1 red'});`,
      ].map((source) => {
        try {
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {counterStyle,fontFace,fontPaletteValues} from 'zyzz/web';${source}`,
          })
          return 'accepted'
        } catch (error) {
          if (!(error instanceof Source.ExtractError)) throw error
          return error.diagnostics.map((diagnostic) => diagnostic.message)
        }
      })
      expect(failures).toMatchInlineSnapshot(`
      [
        [
          "Numeric and alphabetic counters require at least two symbols.",
        ],
        [
          "Additive symbol weights must strictly descend.",
        ],
        [
          "Counter ranges must have increasing bounds.",
        ],
        [
          "Invalid @counter-style pad: Mismatch
        syntax: <integer [0,∞]> && <symbol>
         value: nope
        --------^",
        ],
        [
          "Invalid @font-face font-weight: Mismatch
        syntax: <font-weight-absolute>{1,2}
         value: garbage
        --------^",
        ],
        [
          "@font-face size-adjust cannot be negative.",
        ],
        [
          "Palette overrides require absolute colors.",
        ],
        [
          "Palette overrides require absolute colors.",
        ],
        [
          "Invalid @font-palette-values override-colors: Mismatch
        syntax: [ <integer [0,∞]> <color> ]#
         value: -1 red
        --------^",
        ],
      ]
    `)
    })
  })
})

describe('documentRules', () => {
  describe('compile', () => {
    test('accepts selector lists, CSS identifiers, optional blocks, and authored descriptor order', () => {
      const output = Transform.compile({
        moduleId: 'document.ts',
        source: `import {page,fontFeatureValues,viewTransition} from 'zyzz/web';
page({selector:':first, :left',descriptors:{size:'landscape JIS-B4'}},undefined);
fontFeatureValues({families:'Body',features:{'@swash':undefined,'@styleset':{'--ornament':1,'café':[1,3],'𝒜lternate':2}},fontDisplay:' SWAP '},void 0);
viewTransition({navigation:' AUTO '});`,
      })
      expect(output.css).toMatchInlineSnapshot(`
      "@page :first, :left{size:landscape JIS-B4;}
      @font-feature-values Body{@styleset{--ornament:1;café:1 3;𝒜lternate:2;}font-display: SWAP ;}
      @view-transition{navigation: AUTO ;}"
    `)
    })
    test('rejects malformed feature values in packed contracts', () => {
      const library = Graph.compile({
        modules: {
          'library.ts': `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',features:{'@swash':{flow:1}}});`,
        },
      })
      const contract = JSON.parse(library.contracts['library.ts']!)
      contract.stylesheets[0].css =
        '@font-feature-values Body{@swash{flow:foo;}}'
      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib'` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib.js:0: Invalid library contract: Invalid value]`,
      )
    })
    test('preserves CSS escapes in family arrays', () => {
      const output = Transform.compile({
        moduleId: 'family.ts',
        source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:['A\\tB'],features:{'@swash':{flow:1}}});`,
      })
      expect(output.css).toMatchInlineSnapshot(
        `"@font-feature-values "A\\9 B"{@swash{flow:1;}}"`,
      )
    })
    test('rejects feature indexes outside safe decimal integers', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'index.ts',
          source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',features:{'@swash':{flow:1e21}}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: index.ts:43: Expected feature aliases with nonnegative integer indices.]`,
      )
    })
    test('rejects reserved aliases, malformed families, and table-only page properties', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',fontDisplay:'blocK',features:{}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:43: Invalid font display descriptor.]`,
      )
      for (const name of [
        'initial',
        'inherit',
        'unset',
        'revert',
        'revert-layer',
        'default',
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'bad.ts',
            source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',features:{'@styleset':{'${name}':1}}});`,
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: bad.ts:43: Expected feature aliases with nonnegative integer indices.]`,
        )
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'123',features:{}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:43: Unexpected token Number { has_sign: false, value: 123.0, int_value: Some(123) }]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {page} from 'zyzz/web';page({descriptors:{borderCollapse:'collapse'}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:30: Unsupported page or page-margin declaration.]`,
      )
    })
    test('keeps declarations after feature blocks mapped to their source', () => {
      const output = Transform.compile({
        moduleId: 'maps.ts',
        source: `import {style} from 'zyzz';import {fontFeatureValues} from 'zyzz/web';
fontFeatureValues({families:'Body',features:{'@styleset':{'\\\\65 ditorial':[1,3]}}});
export namespace styles {
  export const text = style({color:'red'})
}`,
      })
      const line =
        output.css.split('\n').findIndex((line) => line.includes('color:red')) +
        1
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line,
          column: 0,
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 22,
          "line": 4,
          "name": "style-1mqnwyd110b1y9-204",
          "source": "maps.ts",
        }
      `)
    })
    test('preserves page descriptors and every margin box in authored order', () => {
      const margins = [
        'top-left-corner',
        'top-left',
        'top-center',
        'top-right',
        'top-right-corner',
        'bottom-left-corner',
        'bottom-left',
        'bottom-center',
        'bottom-right',
        'bottom-right-corner',
        'left-top',
        'left-middle',
        'left-bottom',
        'right-top',
        'right-middle',
        'right-bottom',
      ]
      const output = Transform.compile({
        moduleId: 'print.ts',
        source: `import {page} from 'zyzz/web';page({'@media print':{selector:':first',descriptors:{size:'A4 landscape',margin:'2cm',${margins.map((name, index) => JSON.stringify('@' + name) + ':{content:' + JSON.stringify('"' + index + '"') + '}').join(',')},pageOrientation:'upright',marks:'crop cross',bleed:'3mm'}}});`,
      })
      expect(output.css).toMatchInlineSnapshot(
        `"@media print{@page :first{size:A4 landscape;margin:2cm;@top-left-corner{content:"0";}@top-left{content:"1";}@top-center{content:"2";}@top-right{content:"3";}@top-right-corner{content:"4";}@bottom-left-corner{content:"5";}@bottom-left{content:"6";}@bottom-center{content:"7";}@bottom-right{content:"8";}@bottom-right-corner{content:"9";}@left-top{content:"10";}@left-middle{content:"11";}@left-bottom{content:"12";}@right-top{content:"13";}@right-middle{content:"14";}@right-bottom{content:"15";}page-orientation:upright;marks:crop cross;bleed:3mm;}}"`,
      )
      expect(output.code).toMatchInlineSnapshot(`"void 0;"`)
    })
    test('retains feature blocks and view-transition descriptors in packed libraries', () => {
      const library = Graph.compile({
        modules: {
          'document.ts': `import {fontFeatureValues,viewTransition} from 'zyzz/web';fontFeatureValues({families:['Body','Alternate'],fontDisplay:'swap',features:{'@annotation':{circled:1},'@character-variant':{alternate:[2,3]},'@ornaments':{fleuron:4},'@styleset':{editorial:[1,2]},'@stylistic':{round:3},'@swash':{flow:1}}});viewTransition({ '@layer transitions': {navigation:'auto',types:'slide forwards'} });viewTransition({ '@media (prefers-reduced-motion: reduce)': {navigation:'none'} });`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib/document.js': library.contracts['document.ts']! },
        imports: { 'app.ts': { lib: 'lib/document.js' } },
        modules: { 'app.ts': `import 'lib'` },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(`
      "@font-feature-values "Body","Alternate"{font-display:swap;@annotation{circled:1;}@character-variant{alternate:2 3;}@ornaments{fleuron:4;}@styleset{editorial:1 2;}@stylistic{round:3;}@swash{flow:1;}}
      @layer transitions{@view-transition{navigation:auto;types:slide forwards;}}
      @media (prefers-reduced-motion: reduce){@view-transition{navigation:none;}}"
    `)
    })
    test('rejects descriptors in the wrong page context', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {page} from 'zyzz/web';page({descriptors:{'@top-center':{size:'A4'}}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:30: Unsupported page or page-margin declaration.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',features:{'@swash':{flow:[1,2]}}})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:43: Expected feature aliases with nonnegative integer indices.]`,
      )
    })
  })
})

describe('dynamic', () => {
  const source = [
    'import { style } from "zyzz";',
    'export const bar = style((values: { amount: `${number}%`; gap: `${number}px`; alpha: number }) => ({ display:"block", width:values.amount, marginLeft:`calc(${values.gap} + 2px)`,opacity:values.alpha }));',
    'export const first = bar({amount:"25%",gap:"4px",alpha:0.5});',
  ].join('\n')

  describe('compile', () => {
    test('unwraps all transparent callback assertions and rejects token concatenation', () => {
      for (const callback of [
        '(((v:{alpha:number})=>({opacity:v.alpha}))!)',
        '(((v:{alpha:number})=>({opacity:v.alpha}))! as unknown)',
      ])
        expect(
          Transform.compile({
            moduleId: 'asserted.ts',
            source: 'import {style} from "zyzz"; style(' + callback + ')',
          }).css,
        ).toContain('opacity:var(')

      for (const body of [
        '{color:`#${v.hex}`}',
        '{fontFamily:`prefix${v.hex}`}',
        '{fontFamily:`${v.hex}suffix`}',
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'joined.ts',
            source:
              'import {style} from "zyzz"; style((v:{hex:"fff"|"000"})=>(' +
              body +
              '))',
          }),
        ).toThrow()
    })
    test('supports zero dimensions and rejects private-property keywords and quoted substitutions', async () => {
      const output = Transform.compile({
        moduleId: 'zero.ts',
        source:
          'import {style} from "zyzz"; export const card=style((v:{width:0|`${number}px`})=>({width:v.width}))',
      })

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const result = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(Object.values(result.card({ width: 0 }).style)).toEqual([0])
      expect(Object.values(result.card({ width: '10px' }).style)).toEqual([
        '10px',
      ])

      for (const source of [
        'style((v:{color:"initial"|"red"})=>({color:v.color}))',
        'style((v:{text:string})=>({content:`"${v.text}"`}))',
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'bad.ts',
            source: 'import {style} from "zyzz"; ' + source,
          }),
        ).toThrow()
    })

    test('supports asserted callbacks, quoted fields, negative literals, and empty values', async () => {
      const output = Transform.compile({
        moduleId: 'scalars.ts',
        source: `import {style} from 'zyzz'; export const card = style(((v: {'item-size': string; order: -1 | 1}) => ({marginLeft: v['item-size'], order: v.order})) satisfies unknown)`,
      })

      expect(output.css).toContain('order:var(')

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const result = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(Object.values(result.card({ 'item-size': '', order: -1 }).style))
        .toMatchInlineSnapshot(`
      [
        " ",
        -1,
      ]
    `)
    })
    test('rejects a sign joined to a private numeric token', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'sign.ts',
          source:
            'import {style} from "zyzz"; style((v:{alpha:number})=>({opacity:`+${v.alpha}`}))',
        }),
      ).toThrow()
    })

    test('rejects constrained and reserved callback domains', () => {
      const errors = [
        'style((v:{level:number})=>({zIndex:v.level}))',
        'style((v:{ref:number})=>({opacity:v.ref}))',
        'style((v:{key:number})=>({opacity:v.key}))',
        'style((v:{class:number})=>({opacity:v.class}))',
        'style((v:{width:`${number}%!`})=>({width:v.width}))',
      ].map((source) => {
        try {
          Transform.compile({
            moduleId: 'invalid.ts',
            source: 'import {style} from "zyzz"; ' + source,
          })

          return 'accepted'
        } catch (error) {
          return String(error)
        }
      })

      expect(errors).toMatchInlineSnapshot(`
        [
          "Source.ExtractError: invalid.ts:63: Variable domain is incompatible with this property.",
          "Source.ExtractError: invalid.ts:38: Dynamic values require unique required scalar fields without styling override keys.",
          "Source.ExtractError: invalid.ts:38: Dynamic values require unique required scalar fields without styling override keys.",
          "Source.ExtractError: invalid.ts:38: Dynamic values require unique required scalar fields without styling override keys.",
          "Source.ExtractError: invalid.ts:38: Dynamic values require explicit string or number scalar types.",
        ]
      `)
    })

    test('binds positive literal ratios and rejects degenerate ratio literals', () => {
      expect(
        Transform.compile({
          moduleId: 'ratio.ts',
          source:
            'import {style} from "zyzz"; style((v:{ratio:1|1.5})=>({aspectRatio:v.ratio}))',
        }).css,
      ).toMatchInlineSnapshot(
        `".z_uD69fJ0{aspect-ratio:var(--z-uD69fJ-style-0-ratio);}"`,
      )

      const errors = ['0|1', '-1|1'].map((type) => {
        try {
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {style} from "zyzz"; style((v:{ratio:${type}})=>({aspectRatio:v.ratio}))`,
          })

          return 'accepted'
        } catch (error) {
          return String(error)
        }
      })

      expect(errors).toMatchInlineSnapshot(`
        [
          "Source.ExtractError: invalid.ts:65: Variable domain is incompatible with this property.",
          "Source.ExtractError: invalid.ts:66: Variable domain is incompatible with this property.",
        ]
      `)
    })
    test('unwraps non-null callback bodies before binding theme variables', () => {
      expect(
        Transform.compile({
          moduleId: 'body.ts',
          source:
            'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const t=Vars.define({color:{ink:"red"}}); const tConfig=Config.create({vars:t}); tConfig.style((v:{alpha:number})=>({color:t.color.ink,opacity:v.alpha})!)',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-t{--z-color-ink:red;}
        .z_i84kRs0{color:var(--z-color-ink,red);}
        .z_i84kRs1{opacity:var(--z-i84kRs-style-0-alpha);}"
      `)
    })
    test('rejects imported names in callback template annotations', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'annotation.ts',
          source:
            'import {style,Vars} from "zyzz"; style((v:{width:`${Theme.Length}px`})=>({width:v.width}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: annotation.ts:43: Dynamic values require explicit string or number scalar types.]`,
      )
    })
    test('static callable bundles omit the dynamic helper', async () => {
      const output = Transform.compile({
        moduleId: 'static.ts',
        source:
          'import {style} from "zyzz"; export const card=style({display:"block"})',
      })

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        metafile: true,
        conditions: ['src'],
      })

      expect(
        Object.keys(built.metafile!.inputs)
          .filter((path) => path.endsWith('/runtime/Dynamic.ts'))
          .flatMap((path) =>
            Object.values(built.metafile!.outputs).map(
              (output) => output.inputs[path]?.bytesInOutput ?? 0,
            ),
          ),
      ).toMatchInlineSnapshot(`
      [
        0,
      ]
    `)
    })
    test('rejects number slots adjacent to dimension suffixes', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'units.ts',
          source:
            'import {style} from "zyzz"; style((v:{size:number})=>({width:`${v.size}px`}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: units.ts:61: Expected a literal string or number; expressions are not evaluated.]`,
      )
    })
    test('retains static fallbacks in asserted theme callbacks', () => {
      expect(
        Transform.compile({
          moduleId: 'fallback.ts',
          source:
            'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const t=Vars.define({color:{ink:"red"}}); const tConfig=Config.create({vars:t}); tConfig.style(((v:{alpha:number})=>({opacity:v.alpha,color:[\'blue !custom\',t.color.ink]})) satisfies Callback)',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-t{--z-color-ink:red;}
        .z_oc2law0{opacity:var(--z-oc2law-style-0-alpha);}
        .z_oc2law1{color:blue;color:var(--z-color-ink,red);}"
      `)
    })
    test('compiles callbacks to fixed rules and preserves callable values', async () => {
      const output = Transform.compile({ moduleId: 'dynamic.ts', source })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_RPENcp0{display:block;}
        .z_RPENcp1{width:var(--z-RPENcp-bar-amount);}
        .z_RPENcp2{margin-left:calc(var(--z-RPENcp-bar-gap) + 2px);}
        .z_RPENcp3{opacity:var(--z-RPENcp-bar-alpha);}"
      `,
      )
      expect(output.code.includes('values.amount')).toMatchInlineSnapshot(
        `false`,
      )
      expect(output.code.includes('style.Dynamic')).toMatchInlineSnapshot(
        `true`,
      )

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'node',
        conditions: ['src'],
        format: 'esm',
      })

      const module = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(module.first).toMatchInlineSnapshot(`
        {
          "className": "z_RPENcp0 z_RPENcp1 z_RPENcp2 z_RPENcp3 z-style-RPENcp-bar",
          "style": {
            "--z-RPENcp-bar-alpha": 0.5,
            "--z-RPENcp-bar-amount": "25%",
            "--z-RPENcp-bar-gap": "4px",
          },
        }
      `)
      expect(
        module.bar({
          amount: '75%',
          gap: '8px',
          alpha: 1,
          className: 'external',
          style: { color: 'red' },
        }),
      ).toMatchInlineSnapshot(`
        {
          "className": "z_RPENcp0 z_RPENcp1 z_RPENcp2 z_RPENcp3 z-style-RPENcp-bar external",
          "style": {
            "--z-RPENcp-bar-alpha": 1,
            "--z-RPENcp-bar-amount": "75%",
            "--z-RPENcp-bar-gap": "8px",
            "color": "red",
          },
        }
      `)

      const key = Object.keys(module.first.style)[0]!

      expect(
        module.bar({
          amount: '50%',
          gap: '8px',
          alpha: 1,
          style: { [key]: 'bad' },
        }).style[key],
      ).toBe('50%')
    })

    test('Chromium updates values with stable classes and rule counts', async () => {
      const output = Transform.compile({ moduleId: 'dynamic.ts', source })

      const built = await Esbuild.build({
        stdin: {
          contents: output.code,
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
          loader: 'ts',
        },
        bundle: true,
        write: false,
        platform: 'browser',
        conditions: ['src'],
        format: 'iife',
        globalName: 'fixture',
      })

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div style="width:200px"><div id="bar"></div></div>`,
        )
        await page.addScriptTag({
          content:
            built.outputFiles[0]!.text +
            `;globalThis.update = (amount) => { const props = fixture.bar({amount,gap:'0px',alpha:1}); const element = document.getElementById('bar'); element.className = props.className; for(const [key,value] of Object.entries(props.style)) element.style.setProperty(key,String(value)); }; globalThis.update('25%');`,
        })

        expect(
          await page
            .locator('#bar')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"50px"`)

        const original = await page.locator('#bar').getAttribute('class')

        await page.addScriptTag({
          content: `for(let i=0;i<20;i++) globalThis.update('75%')`,
        })

        expect(
          await page
            .locator('#bar')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"150px"`)
        expect(
          (await page.locator('#bar').getAttribute('class')) === original,
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page.evaluate(() => document.styleSheets[0]!.cssRules.length),
        ).toMatchInlineSnapshot(`4`)
      } finally {
        await browser.close()
      }
    })

    test('writes fields that fill one declaration inline on elements styled alone', async () => {
      const source = `import { style } from 'zyzz'
export const App = (props: { label: string; x: number }) => <main>
<div id="dot" {...styles.dot({ transform: \`translateX(\${props.x}px)\`, width: props.label as \`\${number}px\` })} />
<div id="shared" className="shared" {...styles.dot({ transform: 'translateX(0px)', width: '3px' })} />
<div id="later" {...styles.later({ width: props.label })} />
<div id="hover" {...styles.hover({ width: props.label })} />
<div id="mixed" {...styles.mixed({ opacity: 0.5, width: props.label as \`\${number}px\` })} />
<div id="keyword" {...styles.keyword({ width: props.label })} />
</main>
namespace styles {
  export const dot = style((values: { transform: \`translateX(\${number}px)\`; width: \`\${number}px\` }) => ({
    display: 'block',
    width: values.width,
    transform: values.transform,
  }))

  export const later = style((values: { width: string }) => ({ width: values.width, minInlineSize: '20px' }))

  export const hover = style((values: { width: string }) => ({ width: values.width, selectors: { '&:hover': { width: '1px' } } }))

  export const mixed = style((values: { opacity: number; width: \`\${number}px\` }) => ({ opacity: values.opacity, width: values.width }))

  export const keyword = style((values: { width: string }) => ({ width: values.width }))
}`
      const output = Transform.compile({ moduleId: 'App.tsx', source })

      // Applications spread alone fold to their props, and other applications and fields that admit CSS-wide keywords keep variables.
      expect(
        output.code.slice(
          output.code.indexOf('<main>'),
          output.code.indexOf('</main>'),
        ),
      ).toMatchInlineSnapshot(`
        "<main>
        <div id="dot" {...(styles.dot?{className:"z_l0kPgl0 z_l0kPgl1 z_l0kPgl2",style:{"transform":(\`translateX(\${props.x}px)\`)||"unset","width":(props.label as \`\${number}px\`)||"unset"}}:styles.dot())} />
        <div id="shared" className="shared" {...styles.dot({ transform: 'translateX(0px)', width: '3px' })} />
        <div id="later" {...styles.later({ width: props.label })} />
        <div id="hover" {...styles.hover({ width: props.label })} />
        <div id="mixed" {...(styles.mixed?{className:"z_l0kPgl7 z_l0kPgl8",style:{"--z-l0kPgl-styles-mixed-opacity":\`\${(0.5)}\`||" ","width":(props.label as \`\${number}px\`)||"unset"}}:styles.mixed())} />
        <div id="keyword" {...styles.keyword({ width: props.label })} />
        "
      `)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        bundle: true,
        external: ['react'],
        format: 'cjs',
        jsx: 'automatic',
        platform: 'node',
        stdin: {
          contents: output.code,
          loader: 'tsx',
          resolveDir: process.cwd(),
        },
        write: false,
      })
      const module = {
        exports: {} as {
          App: (props: { label: string; x: number }) => React.ReactNode
        },
      }

      new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(
        module,
        module.exports,
        Module.createRequire(import.meta.url),
      )

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        const render = async (props: { label: string; x: number }) => {
          await page.setContent(
            `<style>${output.css}</style>${Server.renderToStaticMarkup(React.createElement(module.exports.App, props))}`,
          )

          return page.locator('div').evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element)

              return [element.id, style.transform, style.width, style.opacity]
            }),
          )
        }

        expect(await render({ label: '10px', x: 4 })).toMatchInlineSnapshot(`
          [
            [
              "dot",
              "matrix(1, 0, 0, 1, 4, 0)",
              "10px",
              "1",
            ],
            [
              "shared",
              "matrix(1, 0, 0, 1, 0, 0)",
              "3px",
              "1",
            ],
            [
              "later",
              "none",
              "20px",
              "1",
            ],
            [
              "hover",
              "none",
              "10px",
              "1",
            ],
            [
              "mixed",
              "none",
              "10px",
              "0.5",
            ],
            [
              "keyword",
              "none",
              "10px",
              "1",
            ],
          ]
        `)

        // An empty value leaves each property unset, as an invalid variable does.
        expect(await render({ label: '', x: 4 })).toMatchInlineSnapshot(`
          [
            [
              "dot",
              "matrix(1, 0, 0, 1, 4, 0)",
              "1264px",
              "1",
            ],
            [
              "shared",
              "matrix(1, 0, 0, 1, 0, 0)",
              "3px",
              "1",
            ],
            [
              "later",
              "none",
              "1264px",
              "1",
            ],
            [
              "hover",
              "none",
              "1264px",
              "1",
            ],
            [
              "mixed",
              "none",
              "1264px",
              "0.5",
            ],
            [
              "keyword",
              "none",
              "1264px",
              "1",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }
    })

    test('keeps the callable when a member read could replace the definition', () => {
      const source = `import { style } from 'zyzz'
const styles = {
  dot: style((values: { width: string }) => ({ width: values.width })),
}
styles.dot = ((values: { width: string }) => ({ className: 'other', style: { height: values.width } })) as typeof styles.dot
export const App = () => <div {...styles.dot({ width: '10px' })} />`
      const output = Transform.compile({ moduleId: 'App.tsx', source })

      expect(
        output.code.slice(output.code.indexOf('<div')),
      ).toMatchInlineSnapshot(`"<div {...styles.dot({ width: '10px' })} />"`)
    })

    test('keeps the variable when a later all resets the declaration', () => {
      const source = `import { style } from 'zyzz'
export const App = () => <div {...styles.reset({ width: '10px' })} />
namespace styles {
  export const reset = style((values: { width: string }) => ({ width: values.width, all: 'unset' }))
}`
      const output = Transform.compile({ moduleId: 'App.tsx', source })

      const start = output.code.indexOf('<div')

      expect(
        output.code.slice(start, output.code.indexOf('\n', start)),
      ).toMatchInlineSnapshot(`"<div {...styles.reset({ width: '10px' })} />"`)
    })

    test('keeps keyword templates and merged namespace members callable', () => {
      const source = `import { style } from 'zyzz'
export const A = () => <div {...styles.keyword({ width: 'inherit' })} />
namespace styles {
  export const keyword = style((values: { width: \`\${'in'}herit\` }) => ({ width: values.width }))

  export const spaced = style((values: { width: \` \${'in'}herit \` }) => ({ width: values.width }))
}
export const C = () => <div {...styles.spaced({ width: ' inherit ' })} />
export const B = () => <div {...merged.dot({ width: '10px' })} />
namespace merged {
  export const dot = style((values: { width: \`\${number}px\` }) => ({ width: values.width }))
}
namespace merged {
  export const other = style({ color: 'red' })
}`
      const output = Transform.compile({ moduleId: 'App.tsx', source })
      const lines = output.code
        .split('\n')
        .filter((line) => line.includes('<div'))

      expect(lines).toMatchInlineSnapshot(`
        [
          "export const A = () => <div {...styles.keyword({ width: 'inherit' })} />",
          "export const C = () => <div {...styles.spaced({ width: ' inherit ' })} />",
          "export const B = () => <div {...merged.dot({ width: '10px' })} />",
        ]
      `)
    })

    test('mixes bound theme references with static and dynamic declarations', () => {
      expect(
        Transform.compile({
          moduleId: 'theme-dynamic.ts',
          source:
            'import {Config} from \'zyzz\';\nimport { Vars } from "zyzz"; const theme = Vars.define({color:{brand:"red"}}); const themeConfig=Config.create({vars:theme}); export const bar = themeConfig.style((values: {alpha:number})=>({color:theme.color.brand,opacity:values.alpha}));',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-color-brand:red;}
        .z_mSk-e50{color:var(--z-color-brand,red);}
        .z_mSk-e51{opacity:var(--z-mSk-e5-bar-alpha);}"
      `)
    })

    test('encodes identifier characters in private CSS names', () => {
      expect(
        Transform.compile({
          moduleId: 'dollar.ts',
          source:
            'import { style } from "zyzz"; style((values:{$alpha:number})=>({opacity:values.$alpha}))',
        }).css,
      ).toMatchInlineSnapshot(
        `".z_8ludUQ0{opacity:var(--z-8ludUQ-style-0-_24_alpha);}"`,
      )
    })

    test('rejects interpolated dynamic fallback entries', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'fallback.ts',
          source:
            'import { style } from "zyzz"; style((values:{width:number})=>({width:["1px",`${values.width}px`]}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(`
        [Source.ExtractError: fallback.ts:76: Expected a literal string or number; expressions are not evaluated.
        fallback.ts:79: Dynamic fallback entries are not supported.
        fallback.ts:79: Dynamic fallback entries are not supported.]
      `)
    })

    test('rejects dynamic rule structure and optional values', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            'import { style } from "zyzz"; style((values:{width?:string})=>({width:values.width}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:45: Dynamic values require unique required scalar fields without styling override keys.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            'import { style } from "zyzz"; style((values:{width:string})=>({...values}))',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:63: Static spreads require an immutable object literal.]`,
      )
    })
  })
})

describe('finalAcceptance', () => {
  describe('compile', () => {
    test('rejects invalid page property and function grammar from packed stylesheets', () => {
      const library = Graph.compile({ modules: { 'lib.ts': Pages.source() } })
      for (const css of [
        '@page{bleed:10%}',
        '@page{size:calc(1deg)}',
        '@property --x{syntax:"<length>";inherits:false;initial-value:1em}',
        '@property --x{syntax:"<length>";inherits:false}',
        '@property --x{syntax:"<length>";inherits:no;initial-value:1px}',
        '@function --x(--a <length>+: 1px red){result:1}',
        '@function --x(--a,--a){result:1}',
        '@function --x(){@page{result:1}}',
        '@function --x() returns invalid syntax{result:1}',
      ]) {
        const contract = JSON.parse(library.contracts['lib.ts']!)
        contract.stylesheets[0].css = css
        expect(
          () =>
            Graph.compile({
              contracts: { 'lib.js': JSON.stringify(contract) },
              imports: { 'app.ts': { lib: 'lib.js' } },
              modules: { 'app.ts': `import 'lib';` },
            }),
          css,
        ).toThrow()
      }
    })
    test('rejects forbidden enclosing and element contexts for final descriptor families', () => {
      for (const call of [
        "page({descriptors:{size:'A4'}}",
        "property({name:'--x',syntax:'*',inherits:false}",
        'cssFunction({parameters:[],body:{result:1}}',
      ])
        for (const within of [
          'body',
          '@page',
          '@starting-style',
          '@keyframes x',
        ])
          expect(() =>
            Transform.compile({
              moduleId: 'invalid.ts',
              source: `import {page,property,cssFunction} from 'zyzz/web';${call.replace('(', `({${JSON.stringify(within)}:`)}});`,
            }),
          ).toThrow(Source.ExtractError)
    })

    for (const [family, source, rule] of [
      ['page', Pages.source(), '@page'],
      ['property', Registrations.source(), '@property'],
    ] as const) {
      test(`retains ${family} grammar and contexts in packed output with source maps`, () => {
        const direct = Transform.compile({ moduleId: 'library.ts', source })
        const library = Graph.compile({ modules: { 'library.ts': source } })
        const packed = Graph.compile({
          contracts: { 'lib/index.js': library.contracts['library.ts']! },
          imports: { 'app.ts': { lib: 'lib/index.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        expect(direct.css.includes(rule)).toMatchInlineSnapshot('true')
        expect(packed.sharedCss?.includes(rule)).toMatchInlineSnapshot('true')
        expect(
          direct.css.replaceAll(/\s+/g, '') ===
            packed.sharedCss?.replaceAll(/\s+/g, ''),
        ).toMatchInlineSnapshot('true')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }).source,
        ).toMatchInlineSnapshot('"lib/library.ts"')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }).line,
        ).toMatchInlineSnapshot('2')
      })
    }
    test('compiles page margin safety and validates packed descriptors', async () => {
      const source = `import {page} from 'zyzz/web';page({descriptors:{pageMarginSafety:'none'}});page({selector:':left',descriptors:{pageMarginSafety:'clamp'}});page({selector:':right',descriptors:{pageMarginSafety:'ADD'}});`
      const direct = Transform.compile({ moduleId: 'library.ts', source })
      const library = Graph.compile({ modules: { 'library.ts': source } })
      const packed = Graph.compile({
        contracts: { 'lib.js': library.contracts['library.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })

      expect(direct.css).toMatchInlineSnapshot(`
        "@page{page-margin-safety:none;}
        @page :left{page-margin-safety:clamp;}
        @page :right{page-margin-safety:ADD;}"
      `)
      expect(packed.sharedCss).toMatchInlineSnapshot(`
        "@page{page-margin-safety:none;}
        @page :left{page-margin-safety:clamp;}
        @page :right{page-margin-safety:ADD;}"
      `)

      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.addStyleTag({ content: direct.css })

        expect(
          await page.evaluate(() =>
            Array.from(document.styleSheets[0]!.cssRules, (rule) =>
              (rule as CSSPageRule).style.getPropertyValue(
                'page-margin-safety',
              ),
            ),
          ),
        ).toMatchInlineSnapshot(`
          [
            "none",
            "clamp",
            "add",
          ]
        `)
      } finally {
        await browser.close()
      }

      const value = 'auto'
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {page} from 'zyzz/web';page({descriptors:{pageMarginSafety:${JSON.stringify(value)}}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(`
          [Source.ExtractError: invalid.ts:30: Invalid @page page-margin-safety: Mismatch
            syntax: none | clamp | add
             value: auto
            --------^]
        `)

      const contract = JSON.parse(library.contracts['library.ts']!)
      contract.stylesheets[0].css = `@page{page-margin-safety:${value}}`

      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(`
          [Source.ExtractError: lib.js:0: Invalid library contract: Invalid @page page-margin-safety: Mismatch
            syntax: none | clamp | add
             value: auto
            --------^]
        `)
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {page} from 'zyzz/web';page({descriptors:{'@top-center':{pageMarginSafety:'clamp'}}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:30: Unsupported page or page-margin declaration.]`,
      )
    })

    test('rejects invalid page lengths descriptors and selectors', () => {
      for (const options of [
        { descriptors: { bleed: '10%' } },
        { descriptors: { bleed: 'calc(1deg)' } },
        { descriptors: { size: '-1px' } },
        { descriptors: { size: '1px 2px 3px' } },
        { descriptors: { marks: 'crop crop' } },
        { descriptors: { pageOrientation: 'landscape' } },
        { descriptors: { bleed: '1px;color:red' } },
        { selector: ':hover', descriptors: { size: 'A4' } },
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {page} from 'zyzz/web';page(${JSON.stringify(options)});`,
          }),
        ).toThrow(Source.ExtractError)
    })
    test('rejects invalid registrations and computational dependencies', () => {
      for (const options of [
        { syntax: '<length>', initialValue: '1em' },
        { syntax: '<length>', initialValue: 'calc(1px + 2em)' },
        { syntax: '<length>', initialValue: 'calc(1deg)' },
        { syntax: '<length>', initialValue: 'red' },
        { syntax: '<color>', initialValue: 'currentColor' },
        { syntax: '<length>', initialValue: 'var(--other)' },
        { syntax: '<length>' },
        { syntax: '<length> || <number>', initialValue: '1px' },
        { syntax: '<transform-list>+', initialValue: 'rotate(1deg)' },
        { syntax: '<string>', initialValue: '"no"' },
        { syntax: '<length>', initialValue: '1px;inherits:true' },
        { syntax: '<length>', initialValue: '1px', inherits: 'false' },
      ])
        expect(
          () =>
            Transform.compile({
              moduleId: 'invalid.ts',
              source: `import {property} from 'zyzz/web';property(${JSON.stringify({ name: '--invalid', inherits: false, ...options })});`,
            }),
          JSON.stringify(options),
        ).toThrow(Source.ExtractError)
    })
  })
})

describe('fontFeatures', () => {
  describe('compile', () => {
    test('retains every feature alias block and display keyword with packed maps', () => {
      for (const display of [
        'auto',
        'block',
        'fallback',
        'optional',
        'swap',
        ' SWAP ',
        '\\73 wap',
      ]) {
        const source = FontFeatures.source(1, display)
        const direct = Transform.compile({ moduleId: 'fonts.ts', source })
        const library = Graph.compile({ modules: { 'fonts.ts': source } })
        const packed = Graph.compile({
          contracts: { 'lib/fonts.js': library.contracts['fonts.ts']! },
          imports: { 'app.ts': { lib: 'lib/fonts.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        for (const [index, block] of FontFeatures.blocks.entries()) {
          expect(
            direct.css.includes(`${block}{alias${index}:`),
          ).toMatchInlineSnapshot('true')
          expect(
            packed.sharedCss?.includes(`${block}{alias${index}:`),
          ).toMatchInlineSnapshot('true')
        }
        expect(
          packed.sharedCss?.includes('font-display:'),
        ).toMatchInlineSnapshot('true')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }),
        ).toMatchInlineSnapshot(`
        {
          "column": 0,
          "line": 2,
          "name": null,
          "source": "lib/fonts.ts",
        }
      `)
      }
    })
    test('rejects invalid alias indices across every nested feature block', () => {
      for (const block of FontFeatures.blocks) {
        for (const value of [
          -1,
          1.5,
          [],
          [1, 2, 3, 4].filter(() => block !== '@styleset'),
        ]) {
          expect(() =>
            Transform.compile({
              moduleId: 'invalid.ts',
              source: `import {fontFeatureValues} from 'zyzz/web';fontFeatureValues({families:'Body',features:{${JSON.stringify(block)}:{alias:${JSON.stringify(value)}}}});`,
            }),
          ).toThrowErrorMatchingInlineSnapshot(
            `[Source.ExtractError: invalid.ts:43: Expected feature aliases with nonnegative integer indices.]`,
          )
        }
      }
    })
  })
})

describe('fontPalette', () => {
  describe('compile', () => {
    test('preserves font-family lists and descriptor maps across packed aliases', () => {
      const library = Graph.compile({
        modules: {
          'palette.ts': `import {fontPaletteValues} from 'zyzz/web';\nexport const palette=fontPaletteValues({fontFamily:'Evidence, "Second Family"',basePalette:1,overrideColors:'0 red, 0 blue'});`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib/palette.js': library.contracts['palette.ts']! },
        imports: { 'app.ts': { lib: 'lib/palette.js', 'zyzz/web': null } },
        modules: {
          'app.ts': `import {palette as blue} from 'lib';import {global} from 'zyzz/web';global({body:{fontPalette:blue}});`,
        },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(`
        "@font-palette-values --z-fontpalettevalues-palette{font-family:Evidence, "Second Family";base-palette:1;override-colors:0 red, 0 blue;}
        body{font-palette:--z-fontpalettevalues-palette;}"
      `)
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.sharedCssMap!), {
          line: 1,
          column: 0,
        }),
      ).toMatchInlineSnapshot(`
      {
        "column": 21,
        "line": 2,
        "name": null,
        "source": "lib/palette.ts",
      }
    `)
    })

    test('rejects conflicting packed palette definitions after parser shielding', () => {
      const library = Graph.compile({
        modules: {
          'palette.ts': `import {fontPaletteValues} from 'zyzz/web';export const palette=fontPaletteValues({fontFamily:'A, B',basePalette:1});`,
        },
      })
      const contract = library.contracts['palette.ts']!
      expect(() =>
        Graph.compile({
          contracts: {
            'first.js': contract,
            'second.js': contract.replaceAll(
              'base-palette:1',
              'base-palette:0',
            ),
          },
          imports: { 'app.ts': { first: 'first.js', second: 'second.js' } },
          modules: { 'app.ts': `import 'first';import 'second';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: second.js:0: Conflicting packed stylesheet contributions.]`,
      )
    })

    test('matches native palette keywords, index fallbacks, and color overrides in Chromium', async () => {
      const cases = [
        { options: {}, native: '' },
        { options: { basePalette: 1 }, native: 'base-palette:1' },
        { options: { basePalette: 'light' }, native: 'base-palette:light' },
        { options: { basePalette: 'dark' }, native: 'base-palette:dark' },
        { options: { basePalette: 99 }, native: 'base-palette:99' },
        {
          options: { basePalette: 1, overrideColors: '0 red' },
          native: 'base-palette:1;override-colors:0 red',
        },
        {
          options: { overrideColors: '0 red, 0 blue, 99 green' },
          native: 'override-colors:0 red,0 blue,99 green',
        },
        {
          options: { overrideColors: '0 rgb(0 128 0 / .5)' },
          native: 'override-colors:0 rgb(0 128 0 / .5)',
        },
        {
          options: { overrideColors: '0 color(display-p3 0 1 0)' },
          native: 'override-colors:0 color(display-p3 0 1 0)',
        },
        {
          options: {
            fontFamily: 'PaletteEvidence, "Palette Alias"',
            basePalette: 1,
          },
          native: 'font-family:PaletteEvidence, "Palette Alias";base-palette:1',
        },
      ]
      const library = Graph.compile({
        modules: {
          'palettes.ts': `import {fontFace,fontPaletteValues,global} from 'zyzz/web';fontFace({fontFamily:'PaletteEvidence',src:${JSON.stringify(`url("${fontPaletteFont.url}")`)}});fontFace({fontFamily:'Palette Alias',src:${JSON.stringify(`url("${fontPaletteFont.url}")`)}});global({'#compiled9,#native9':{fontFamily:'"Palette Alias"'}});${cases.map((entry, index) => `export const p${index}=fontPaletteValues(${JSON.stringify({ fontFamily: 'PaletteEvidence', ...entry.options })});global({'#compiled${index}':{fontPalette:p${index}}});`).join('\n')}`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib.js': library.contracts['palettes.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        await page.setContent(
          cases
            .map(
              (_, index) =>
                `<div id="compiled${index}" class="font">A</div><div id="native${index}" class="font">A</div>`,
            )
            .join(''),
        )
        await page.addStyleTag({ content: output.sharedCss! })
        await page.addStyleTag({
          content:
            '.font{font:40px PaletteEvidence;width:60px;height:40px;background:white}' +
            cases
              .map(
                (entry, index) =>
                  `@font-palette-values --native${index}{font-family:PaletteEvidence;${entry.native}}#native${index}{font-palette:--native${index}}`,
              )
              .join(''),
        })
        await page.evaluate(() => document.fonts.ready)
        expect(
          await page.evaluate(() =>
            document.fonts.check('40px PaletteEvidence'),
          ),
        ).toMatchInlineSnapshot('true')
        const images = []
        for (let index = 0; index < cases.length; index++) {
          const compiled = await page.locator(`#compiled${index}`).screenshot()
          const native = await page.locator(`#native${index}`).screenshot()
          expect(Buffer.compare(compiled, native)).toMatchInlineSnapshot('0')
          images.push(compiled)
        }
        expect(
          Buffer.compare(images[0]!, images[1]!) === 0,
        ).toMatchInlineSnapshot('false')
        for (const index of [2, 3, 4, 5])
          expect(
            Buffer.compare(images[0]!, images[index]!),
          ).toMatchInlineSnapshot('0')
        expect(Buffer.compare(images[1]!, images[6]!)).toMatchInlineSnapshot(
          '0',
        )
        expect(Buffer.compare(images[1]!, images[9]!)).toMatchInlineSnapshot(
          '0',
        )
        for (const index of [7, 8])
          expect(
            Buffer.compare(images[0]!, images[index]!) === 0,
          ).toMatchInlineSnapshot('false')
      } finally {
        await browser.close()
      }
    })
  })
})

describe('fonts', () => {
  describe('compile', () => {
    test('font controls preserve numeric variants, emphasis tokens, and maps', () => {
      const output = Transform.compile({
        moduleId: 'fonts.ts',
        source: Fonts.source,
      })

      expect(output.css.match(/font-variant-numeric:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "font-variant-numeric:normal",
        "font-variant-numeric:tabular-nums!important",
      ]
    `)
      expect(/--z-color-accent,#06c\)/.test(output.css)).toMatchInlineSnapshot(
        `true`,
      )

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('font-variant-numeric:tabular-nums!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf(
            'font-variant-numeric:tabular-nums!important',
          ),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 317,
          "line": 3,
          "name": "fontVariantNumeric",
          "source": "fonts.ts",
        }
      `)
    })

    test('font controls match independent CSS and native ruby placement', async () => {
      const output = Transform.compile({
        moduleId: 'fonts.ts',
        source: Fonts.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>body{font:20px monospace}ruby{margin:20px}span{display:inline-block}${output.css}</style><p id="font" class="${module.font.className}">Font 123</p><p id="font-control" style="${Fonts.controls.font}">Font 123</p><ruby id="ruby" class="${module.ruby.className}"><span>base</span><rt>annotation</rt></ruby><ruby id="ruby-control" style="${Fonts.controls.ruby}"><span>base</span><rt>annotation</rt></ruby><span id="vertical" class="${module.vertical.className}">AB</span><span id="vertical-control" style="${Fonts.controls.vertical}">AB</span>`,
        )

        expect(
          await page.evaluate(() => {
            const properties = {
              font: [
                'font-kerning',
                'font-optical-sizing',
                'font-stretch',
                'font-synthesis-small-caps',
                'font-synthesis-style',
                'font-synthesis-weight',
                'font-variant-caps',
                'font-variant-east-asian',
                'font-variant-ligatures',
                'font-variant-numeric',
                'font-variant-position',
                'text-emphasis-color',
                'text-emphasis-style',
                'text-emphasis-position',
                'text-justify',
              ],
              ruby: ['ruby-align', 'ruby-position'],
              vertical: [
                'writing-mode',
                'text-orientation',
                'text-combine-upright',
              ],
            }

            return Object.entries(properties).flatMap(([name, keys]) => {
              const a = getComputedStyle(document.getElementById(name)!)
              const b = getComputedStyle(
                document.getElementById(`${name}-control`)!,
              )

              return keys.filter(
                (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
              )
            })
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page.locator('#ruby').evaluate((element) => {
            const base = element.querySelector('span')!.getBoundingClientRect()
            const annotation = element
              .querySelector('rt')!
              .getBoundingClientRect()

            return (
              annotation.top + annotation.height / 2 >
              base.top + base.height / 2
            )
          }),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page.locator('#vertical').evaluate((element) => {
            const bounds = element.getBoundingClientRect()

            return bounds.height > bounds.width
          }),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#font')
            .evaluate((element) => getComputedStyle(element).textEmphasisColor),
        ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('functionAcceptance', () => {
  describe('compile', () => {
    test('retains escaped syntax nested references and conditional results through packed publication', () => {
      const source = Functions.source()
      const direct = Transform.compile({ moduleId: 'functions.ts', source })
      const library = Graph.compile({ modules: { 'functions.ts': source } })
      expect(
        JSON.parse(library.contracts['functions.ts']!).version,
      ).toMatchInlineSnapshot(`31`)
      const packed = Graph.compile({
        contracts: { 'lib/index.js': library.contracts['functions.ts']! },
        imports: { 'app.ts': { lib: 'lib/index.js', 'zyzz/web': null } },
        modules: {
          'app.ts': `import {inner,outer,list,words} from 'lib';import {global} from 'zyzz/web';global({body:{width:outer(inner()),'--list':list('3px 5px'),'--word':words('日本語')}});`,
        },
      })
      expect(direct.css.includes('--日本語')).toMatchInlineSnapshot('true')
      expect(
        direct.css.includes('@container (width > 1px)'),
      ).toMatchInlineSnapshot('true')
      expect(
        packed.sharedCss?.includes('@supports (width: 1px)'),
      ).toMatchInlineSnapshot('true')
      expect(
        (packed.sharedCss + packed.modules['app.ts']!.css).includes(
          '(3px 5px)',
        ),
      ).toMatchInlineSnapshot('true')
      expect(
        (packed.sharedCss + packed.modules['app.ts']!.css).includes(
          '(--z-cssfunction',
        ),
      ).toMatchInlineSnapshot('true')
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
          line: 1,
          column: 0,
        }).source,
      ).toMatchInlineSnapshot('"lib/functions.ts"')
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
          line: 1,
          column: 0,
        }).line,
      ).toMatchInlineSnapshot('2')
    })
    test('rejects invalid list items arity escaped names and declaration injection', () => {
      const definition = `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--x',syntax:'<integer>+'}],body:{result:'var(--x)'}});`
      for (const call of [
        "fn('1 2px')",
        "fn('1 2.5')",
        'fn()',
        'fn(1,2)',
        "fn('1;result:2')",
      ]) {
        expect(
          () =>
            Transform.compile({
              moduleId: 'invalid.ts',
              source: definition + call,
            }),
          call,
        ).toThrow(Source.ExtractError)
        const library = Graph.compile({ modules: { 'fn.ts': definition } })
        expect(
          () =>
            Graph.compile({
              contracts: { 'lib.js': library.contracts['fn.ts']! },
              imports: { 'app.ts': { lib: 'lib.js' } },
              modules: { 'app.ts': `import {fn} from 'lib';${call}` },
            }),
          call,
        ).toThrow()
      }
      for (const options of [
        {
          parameters: [{ name: '--x', syntax: 'type(\\69 nherit | auto)' }],
          body: { result: 'auto' },
        },
        {
          parameters: [{ name: '--x' }, { name: '--\\78' }],
          body: { result: '1' },
        },
        {
          parameters: [
            { name: '--x', syntax: '<length>+', default: '1px red' },
          ],
          body: { result: '1' },
        },
        { parameters: [], body: { result: '1;--injected:2' } },
        { parameters: [], body: { '@page': { result: '1' } } },
      ])
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {cssFunction} from 'zyzz/web';export const fn=cssFunction(${JSON.stringify(options)});`,
          }),
        ).toThrow(Source.ExtractError)
    })
  })
})

describe('functionSyntax.browser', () => {
  describe('compile', () => {
    test('evaluates composite types, default values, and media-dependent results', async () => {
      const output = Transform.compile({
        moduleId: 'functions.ts',
        source: `import {cssFunction,global} from 'zyzz/web';
const size=cssFunction({parameters:[{name:'--size',syntax:'type(<length> | <percentage>)',default:'25%'}],returns:'type(<length> | <percentage>)',body:{result:'calc(var(--size) * 2)','@media (width < 300px)':{result:'var(--size)'}}});
const colors=cssFunction({parameters:[{name:'--colors',syntax:'<color>#'}],returns:'<color>#',body:{result:'var(--colors)'}});
global({main:{width:'200px'},'#gradient':{backgroundImage:\`linear-gradient(to right, \${colors('red, blue')})\`},'#default':{width:size()},'#fixed':{width:size('20px')}});`,
      })
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage({
          viewport: { width: 400, height: 300 },
        })
        await page.setContent(
          '<main><div id="default"></div><div id="fixed"></div><div id="gradient"></div></main>',
        )
        await page.addStyleTag({ content: output.css })

        expect(
          await page
            .locator('#default')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot('"100px"')
        expect(
          await page
            .locator('#fixed')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot('"40px"')
        expect(
          await page
            .locator('#gradient')
            .evaluate((element) => getComputedStyle(element).backgroundImage),
        ).toMatchInlineSnapshot(
          '"linear-gradient(to right, rgb(255, 0, 0), rgb(0, 0, 255))"',
        )
        await page.setViewportSize({ width: 200, height: 300 })
        expect(
          await page
            .locator('#default')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot('"50px"')
        expect(
          await page
            .locator('#fixed')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot('"20px"')
      } finally {
        await browser.close()
      }
    })
  })
})

describe('functionSyntax', () => {
  describe('compile', () => {
    test('formats comma-list arguments identically in emitted JavaScript', async () => {
      const output = Transform.compile({
        moduleId: 'list.ts',
        source: `import {cssFunction} from 'zyzz/web';export const colors=cssFunction({parameters:[{name:'--colors',syntax:'<color>#'}],returns:'<color>#',body:{result:'var(--colors)'}});`,
      })
      const code = (
        await Esbuild.transform(output.code, { loader: 'ts', format: 'esm' })
      ).code
      const compiled = await import(
        'data:text/javascript,' + encodeURIComponent(code)
      )

      expect(compiled.colors('red, blue')).toMatchInlineSnapshot(
        `"--z-cssfunction-colors({red, blue})"`,
      )
      expect(compiled.colors('{red, blue}')).toMatchInlineSnapshot(
        `"--z-cssfunction-colors({red, blue})"`,
      )
    })
    test('preserves union, repetition, keyword, and universal signatures', () => {
      const output = Transform.compile({
        moduleId: 'functions.ts',
        source: `import {cssFunction} from 'zyzz/web';
export const scale=cssFunction({parameters:[{name:'--x',syntax:'type(<number> | <percentage>)',default:'50%'}],returns:'type(<number> | <percentage>)',body:{result:'var(--x)'}});
export const space=cssFunction({parameters:[{name:'--x',syntax:'<length>+'}],returns:'<length>+',body:{result:'var(--x)'}});
export const auto=cssFunction({parameters:[{name:'--x',syntax:'type(auto | <length>)'}],returns:'type(auto | <length>)',body:{result:'var(--x)'}});
export const any=cssFunction({parameters:[{name:'--x',syntax:'type(*)'}],returns:'type(*)',body:{result:'var(--x)'}});`,
      })

      expect(output.css).toMatchInlineSnapshot(`
        "@function --z-cssfunction-scale(--x type(<number> | <percentage>): 50%) returns type(<number> | <percentage>){result:var(--x);}
        @function --z-cssfunction-space(--x <length>+) returns <length>+{result:var(--x);}
        @function --z-cssfunction-auto(--x type(auto | <length>)) returns type(auto | <length>){result:var(--x);}
        @function --z-cssfunction-any(--x type(*)) returns type(*){result:var(--x);}"
      `)
    })

    test('retains composite signatures and default invocation across packed re-exports', () => {
      const library = Graph.compile({
        modules: {
          'functions.ts': `import {cssFunction} from 'zyzz/web';export const size=cssFunction({parameters:[{name:'--size',syntax:'type(<length> | <percentage>)',default:'25%'}],returns:'type(<length> | <percentage>)',body:{result:'var(--size)'}});`,
        },
      })
      expect(
        JSON.parse(library.contracts['functions.ts']!).version,
      ).toMatchInlineSnapshot(`31`)
      const output = Graph.compile({
        contracts: { 'lib/functions.js': library.contracts['functions.ts']! },
        imports: { 'app.ts': { lib: 'lib/functions.js', zyzz: null } },
        modules: {
          'app.ts': `import {size as scale} from 'lib';import {style} from 'zyzz';export const styles={default:style({width:scale()}),fixed:style({width:scale('20px')})};`,
        },
      })

      expect(output.sharedCss).toMatchInlineSnapshot(
        `"@function --z-cssfunction-size(--size type(<length> | <percentage>): 25%) returns type(<length> | <percentage>){result:var(--size);}"`,
      )
      expect(output.modules['app.ts']?.css).toMatchInlineSnapshot(`
        ".z_Zf5JrJ0{width:--z-cssfunction-size();}
        .z_Zf5JrJ1{width:--z-cssfunction-size(20px);}"
      `)
    })

    test('keeps authored parameter key order in types and contracts', () => {
      const source = `import {cssFunction} from 'zyzz/web';export const fluid=cssFunction({parameters:[{name:'--min',syntax:'<length>',default:'1rem'},{default:'3rem',name:'--max',syntax:'<length>'}],returns:'<length>',body:{result:'clamp(var(--min), 4vw, var(--max))'}});`
      const output = Transform.compile({ moduleId: 'functions.ts', source })
      const library = Graph.compile({ modules: { 'functions.ts': source } })

      // Raw text keeps key order, which object snapshots would sort.
      expect(output.code.match(/Reference<\[.*?\]/)?.[0]).toMatchInlineSnapshot(
        `"Reference<[{"name":"--min","syntax":"<length>","default":"1rem"},{"default":"3rem","name":"--max","syntax":"<length>"}]"`,
      )
      expect(
        library.contracts['functions.ts']!.match(/"parameters":\[.*?\]/)?.[0],
      ).toMatchInlineSnapshot(
        `""parameters":[{"name":"--min","syntax":"<length>","default":"1rem"},{"default":"3rem","name":"--max","syntax":"<length>"}]"`,
      )
    })

    test.each(['1px', '1%', '1.5', '1e2', '-1turn', ' 1px '])(
      'rejects non-integer token %s in source and packed calls',
      (value) => {
        const source = `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--n',syntax:'type(<integer> | auto)'}],returns:'<integer>',body:{result:'var(--n)'}});`
        const library = Graph.compile({ modules: { 'fn.ts': source } })

        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: source + `fn(${JSON.stringify(value)});`,
          }),
        ).toThrowError(/CSS integer parameters require integer tokens/)
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': library.contracts['fn.ts']! },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: {
              'app.ts': `import {fn} from 'lib';fn(${JSON.stringify(value)});`,
            },
          }),
        ).toThrowError(/CSS integer parameters require integer tokens/)
      },
    )

    test.each([
      '<custom-ident>',
      '<image>',
      '<resolution>',
      '<string>',
      '<transform-function>',
      '<transform-list>',
      '<url>',
    ])(
      'versions added scalar syntax %s separately from the legacy contract',
      (syntax) => {
        for (const returns of [syntax, '<color>']) {
          const library = Graph.compile({
            modules: {
              'fn.ts': `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--x',syntax:${JSON.stringify(syntax)}}],returns:${JSON.stringify(returns)},body:{result:'var(--x)'}});`,
            },
          })
          expect(
            JSON.parse(library.contracts['fn.ts']!).version,
          ).toMatchInlineSnapshot(`31`)

          const packed = Graph.compile({
            contracts: { 'lib.js': library.contracts['fn.ts']! },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import {fn} from 'lib';export {fn};` },
          })
          expect(
            JSON.parse(packed.contracts['app.ts']!).version,
          ).toMatchInlineSnapshot(`31`)
        }
      },
    )

    test.each(['+', '#'])(
      'accepts one-item numbers in repeated %s alternatives through packed calls',
      (repeat) => {
        const library = Graph.compile({
          modules: {
            'fn.ts': `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--x',syntax:'type(<integer> | <number>${repeat})'}],body:{result:'var(--x)'}});`,
          },
        })
        const packed = Graph.compile({
          contracts: { 'lib.js': library.contracts['fn.ts']! },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: {
            'app.ts': `import {fn} from 'lib';export const value=fn(1.5);`,
          },
        })
        expect(
          packed.modules['app.ts']!.code.includes('(1.5)'),
        ).toMatchInlineSnapshot('true')

        const output = Transform.compile({
          moduleId: 'lists.ts',
          source: `import {cssFunction} from 'zyzz/web';const fn=cssFunction({parameters:[{name:'--x',syntax:'<integer>${repeat}'}],body:{result:'var(--x)'}});fn('${repeat === '+' ? '1 2' : '1, 2'}');`,
        })
        expect(output.css.includes('@function')).toMatchInlineSnapshot('true')
      },
    )

    test('retains scalar contract compatibility and valid alternative arguments', () => {
      const source = `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--n',syntax:'<integer>'}],returns:'<integer>',body:{result:'var(--n)'}});fn(2);`
      const library = Graph.compile({ modules: { 'fn.ts': source } })
      expect(
        JSON.parse(library.contracts['fn.ts']!).version,
      ).toMatchInlineSnapshot(`31`)

      const output = Transform.compile({
        moduleId: 'valid.ts',
        source: `import {cssFunction} from 'zyzz/web';const fn=cssFunction({parameters:[{name:'--n',syntax:'type(<integer> | <percentage> | auto)'}],body:{result:'var(--n)'}});fn('25%');fn('auto');fn(2);`,
      })
      expect(output.code.includes('25%')).toMatchInlineSnapshot('true')
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {cssFunction} from 'zyzz/web';const fn=cssFunction({parameters:[{name:'--n',syntax:'type(<integer> | <percentage>)'}],body:{result:'var(--n)'}});fn('1px');`,
        }),
      ).toThrowError(/CSS integer parameters require integer tokens/)
    })

    test.each([
      'type(<length> && <color>)',
      'type(<length> |)',
      '<length> | <percentage>',
      'type(<unknown>)',
      '<transform-list>+',
    ])('rejects invalid signature %s at its source', (syntax) => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[],returns:${JSON.stringify(syntax)},body:{result:0}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:53: Expected CSS function parameters, body, and optional return syntax.]`,
      )
    })
  })
})

describe('functionalColors', () => {
  describe('compile', () => {
    test('functional colors agree with independent CSS grammar', () => {
      const lexer = Conformance.lexer()

      for (const color of FunctionalColors.valid) {
        const output = Transform.compile({
          moduleId: 'color.ts',
          source: `import { style } from 'zyzz'; style({color:${JSON.stringify(color)}})`,
        })

        expect(output.css.includes(`color:${color}`)).toMatchInlineSnapshot(
          `true`,
        )
        expect(lexer.matchProperty('color', color).error).toMatchInlineSnapshot(
          `null`,
        )
      }

      const output = Transform.compile({
        moduleId: 'color.ts',
        source: FunctionalColors.source,
      })

      expect(output.css.match(/background-color:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "background-color:rgb(255, 0, 0)",
        "background-color:hsl(120deg 50% 50% / .5)!important",
      ]
    `)
    })
    test('functional colors match native theme inheritance and SVG output', async () => {
      const output = Transform.compile({
        moduleId: 'color.ts',
        source: FunctionalColors.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div class="${module.scope}"><div id="actual" class="${module.box.className}"><span id="child">child</span></div><svg><rect id="shape" class="${module.svg.className}" /></svg></div><div id="control" style="${FunctionalColors.control}"><span id="control-child">child</span></div><svg><rect id="shape-control" style="fill:lab(50% 20 -30);stroke:oklab(.5 .1 -.1)" /></svg>`,
        )

        expect(
          await page.evaluate(() => {
            return [
              [
                'actual',
                'control',
                [
                  'color',
                  'background-color',
                  'border-top-color',
                  'outline-color',
                ],
              ],
              ['child', 'control-child', ['color']],
              ['shape', 'shape-control', ['fill', 'stroke']],
            ].flatMap(([actual, control, keys]) => {
              const a = getComputedStyle(
                document.getElementById(actual as string)!,
              )
              const b = getComputedStyle(
                document.getElementById(control as string)!,
              )

              return (keys as string[]).filter(
                (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
              )
            })
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
        ).toMatchInlineSnapshot(`"rgba(64, 191, 64, 0.5)"`)

        for (const color of FunctionalColors.valid) {
          expect(
            await page.evaluate((color) => CSS.supports('color', color), color),
          ).toMatchInlineSnapshot(`true`)
        }
      } finally {
        await browser.close()
      }
    })
  })
})

describe('geometry', () => {
  describe('compile', () => {
    test('all canonical transform functions match independent grammar', () => {
      const lexer = Conformance.lexer()

      for (const transform of Geometry.functions) {
        const output = Transform.compile({
          moduleId: 'geometry.ts',
          source: `import { style } from 'zyzz'; style({transform:${JSON.stringify(transform)}});`,
        })

        expect(
          output.css.includes(`transform:${transform}`),
        ).toMatchInlineSnapshot(`true`)
        expect(
          lexer.matchProperty('transform', transform).error,
        ).toMatchInlineSnapshot(`null`)
      }
    })
    test('ratios and ordered transforms match native rendered bounds', async () => {
      const output = Transform.compile({
        moduleId: 'geometry.ts',
        source: Geometry.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}.positioned{position:absolute;left:100px;top:100px;transform-origin:0 0}</style><div id="aspect" class="${module.aspect.className}"></div><div id="individual" class="positioned ${module.individual.className}"></div><div id="list" class="positioned ${module.list.className}"></div><div id="control" class="positioned" style="${Geometry.controls.list}"></div><div id="spatial" class="${module.spatial.className}"></div><div id="spatial-control" style="${Geometry.controls.spatial}"></div>`,
        )

        expect(
          await page
            .locator('#aspect')
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toMatchInlineSnapshot(`90`)
        expect(
          await page
            .locator('#individual')
            .evaluate((element) => element.getBoundingClientRect().toJSON()),
        ).toMatchInlineSnapshot(`
        {
          "bottom": 220,
          "height": 80,
          "left": 70,
          "right": 130,
          "top": 140,
          "width": 60,
          "x": 70,
          "y": 140,
        }
      `)
        expect(
          await page.evaluate(() => {
            const control = JSON.stringify(
              document
                .getElementById('control')!
                .getBoundingClientRect()
                .toJSON(),
            )

            return ['individual', 'list'].filter(
              (id) =>
                JSON.stringify(
                  document.getElementById(id)!.getBoundingClientRect().toJSON(),
                ) !== control,
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page.evaluate(
            () =>
              getComputedStyle(document.getElementById('spatial')!)
                .transform ===
              getComputedStyle(document.getElementById('spatial-control')!)
                .transform,
          ),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('grid-lines', () => {
  describe('compile', () => {
    test('grid placement preserves named lines and shorthand order', () => {
      const lexer = Conformance.lexer()

      for (const [property, value] of Object.entries(GridLines.styles)) {
        const name = Conformance.name(property)
        const output = Transform.compile({
          moduleId: 'grid.ts',
          source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}});`,
        })

        expect(output.css.includes(`${name}:${value}`)).toMatchInlineSnapshot(
          `true`,
        )
        expect(lexer.matchProperty(name, value).error).toMatchInlineSnapshot(
          `null`,
        )
      }

      const output = Transform.compile({
        moduleId: 'grid.ts',
        source: GridLines.source,
      })

      expect(
        output.css.match(/grid-column:1 \/ 3;/g)?.length,
      ).toMatchInlineSnapshot(`2`)
    })
    test('grid placement matches native named and numbered layout', async () => {
      const output = Transform.compile({
        moduleId: 'grid.ts',
        source: GridLines.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>.grid{display:grid;grid-template-columns:[start] 40px 40px [end] 40px;grid-template-rows:30px 30px;width:120px}${output.css}</style><div class="grid"><div id="actual" class="${module.placement.className}"></div></div><div class="grid"><div id="control" style="grid-area:1 / 2 / 3 / 4"></div></div><div class="grid"><div id="named" class="${module.named.className}"></div></div><div class="grid"><div id="named-control" style="grid-column:start / end;grid-row:1 / span 2"></div></div><div class="grid"><div id="override" class="${module.first.className} ${module.second.className} ${module.third.className}"></div></div>`,
        )

        for (const id of ['actual', 'control', 'named', 'named-control']) {
          expect(
            await page
              .locator(`#${id}`)
              .evaluate((element) => [
                element.getBoundingClientRect().width,
                element.getBoundingClientRect().height,
              ]),
          ).toMatchInlineSnapshot(`
          [
            80,
            60,
          ]
        `)
        }

        expect(
          await page
            .locator('#override')
            .evaluate((element) => getComputedStyle(element).gridColumnStart),
        ).toMatchInlineSnapshot(`"1"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('grid', () => {
  describe('compile', () => {
    test('grid tracks preserve flexible units, line fallback importance, and maps', () => {
      const output = Transform.compile({
        moduleId: 'grid.ts',
        source: Grid.source,
      })

      expect(output.css.match(/grid-column-start:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "grid-column-start:1",
        "grid-column-start:2!important",
      ]
    `)
      expect(
        output.css.includes('grid-auto-columns:1fr'),
      ).toMatchInlineSnapshot(`true`)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('grid-column-start:2!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('grid-column-start:2!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 44,
          "line": 3,
          "name": "gridColumnStart",
          "source": "grid.ts",
        }
      `)
    })

    test('grid tracks and spans match independent browser geometry', async () => {
      const output = Transform.compile({
        moduleId: 'grid.ts',
        source: Grid.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><section id="actual" class="${module.grid.className}"><div class="${module.cell.className}">Span</div></section><section id="control" style="${Grid.controls.grid}"><div style="${Grid.controls.cell}">Span</div></section>`,
        )

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('actual')!)
            const b = getComputedStyle(document.getElementById('control')!)

            return [
              'grid-auto-columns',
              'grid-auto-rows',
              'grid-auto-flow',
              'grid-template-columns',
              'grid-template-rows',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual > div')
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toMatchInlineSnapshot(`200`)
        expect(
          await page
            .locator('#actual > div')
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toMatchInlineSnapshot(`40`)
        expect(
          await page
            .locator('#actual > div')
            .evaluate(
              (element) =>
                element.getBoundingClientRect().left -
                element.parentElement!.getBoundingClientRect().left,
            ),
        ).toMatchInlineSnapshot(`100`)
        expect(
          await page.evaluate(() => {
            const a = document
              .querySelector('#actual > div')!
              .getBoundingClientRect()
            const b = document
              .querySelector('#control > div')!
              .getBoundingClientRect()

            return a.width === b.width && a.height === b.height
          }),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('gridLists', () => {
  describe('compile', () => {
    test('structured grid values agree with the independent track grammar', () => {
      const lexer = Conformance.lexer()

      for (const value of GridLists.valid) {
        const output = Transform.compile({
          moduleId: 'grid-list.ts',
          source: `import { style } from 'zyzz'; style({gridTemplateColumns:${JSON.stringify(value)}});`,
        })

        expect(
          output.css.includes(`grid-template-columns:${value}`),
        ).toMatchInlineSnapshot(`true`)
        expect(
          lexer.matchProperty('grid-template-columns', value).error,
        ).toMatchInlineSnapshot(`null`)
      }

      const output = Transform.compile({
        moduleId: 'grid-list.ts',
        source: GridLists.source,
      })

      expect(
        output.css.includes(
          'grid-template-columns:1fr 2fr;grid-template-columns:repeat(auto-fit, minmax(80px, 1fr))!important',
        ),
      ).toMatchInlineSnapshot(`true`)
    })

    test('repeat and auto-fit tracks match responsive native browser geometry', async () => {
      const output = Transform.compile({
        moduleId: 'grid-list.ts',
        source: GridLists.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        const cells = '<i></i>'.repeat(6)

        await page.setContent(
          `<style>${output.css}i{height:10px}</style><div id="fixed" class="${module.fixed.className}">${cells}</div><div id="fixed-control" style="display:grid;width:300px;grid-template-columns:[start] repeat(3,minmax(0,1fr)) [end];grid-auto-rows:20px 30px">${cells}</div><div id="fluid" class="${module.fluid.className}">${cells}</div><div id="fluid-control" style="display:grid;width:300px;grid-template-columns:repeat(auto-fit,minmax(80px,1fr))">${cells}</div>`,
        )

        expect(
          await page
            .locator('#fixed')
            .evaluate(
              (element) => getComputedStyle(element).gridTemplateColumns,
            ),
        ).toMatchInlineSnapshot(`"[start] 100px 100px 100px [end]"`)
        expect(
          await page
            .locator('#fixed')
            .evaluate((element) => getComputedStyle(element).gridTemplateRows),
        ).toMatchInlineSnapshot(`"20px 30px"`)

        for (const width of ['300px', '150px']) {
          await page.evaluate((width) => {
            for (const id of ['fluid', 'fluid-control'])
              document.getElementById(id)!.style.width = width
          }, width)

          expect(
            await page.evaluate(() =>
              ['fixed', 'fluid'].flatMap((id) => {
                const a = getComputedStyle(document.getElementById(id)!)
                const b = getComputedStyle(
                  document.getElementById(`${id}-control`)!,
                )

                return ['grid-template-columns', 'grid-template-rows'].filter(
                  (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
                )
              }),
            ),
          ).toMatchInlineSnapshot(`[]`)
        }

        expect(
          await page
            .locator('#fluid')
            .evaluate(
              (element) => getComputedStyle(element).gridTemplateColumns,
            ),
        ).toMatchInlineSnapshot(`"150px"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('groupingAcceptance', () => {
  describe('compile', () => {
    test('rejects malformed grouping productions at their source boundary', () => {
      const failures = [
        '@media ???',
        '@supports display:grid',
        '@container card',
        '@scope .root',
        '@layer a,b',
        '@starting-style invalid',
      ]
        .flatMap((header) => [
          `import {global} from 'zyzz/web';global({${JSON.stringify(header)}:{body:{color:'red'}}});`,
          `import {style} from 'zyzz';export const text=style({${JSON.stringify(header)}:{color:'red'}});`,
        ])
        .map((source) => {
          try {
            Transform.compile({
              moduleId: 'invalid.ts',
              source,
            })
            return 'accepted'
          } catch (error) {
            if (!(error instanceof Source.ExtractError)) throw error
            return error.diagnostics.map((diagnostic) => diagnostic.message)
          }
        })
      expect(failures).toMatchInlineSnapshot(`
      [
        [
          "Unexpected token Delim('?')",
        ],
        [
          "Unknown query threshold.",
        ],
        [
          "Unexpected token Ident("display")",
        ],
        [
          "Invalid selector or condition: Unexpected token Ident("display")",
        ],
        [
          "Container rules require a query after the optional name.",
        ],
        [
          "Unknown query threshold.",
        ],
        [
          "Unexpected token Delim('.')",
        ],
        [
          "Invalid selector or condition: Unexpected token Delim('.')",
        ],
        [
          "Invalid @ rule body",
        ],
        [
          "Invalid selector or condition: Invalid @ rule body",
        ],
        [
          "Expected a selector or supported grouping rule.",
        ],
        [
          "Expected a literal string or number; expressions are not evaluated.",
        ],
      ]
    `)
    })

    for (const [family, headers] of Object.entries(GroupingRules.rules)) {
      test(`preserves ${family} grammar in global and nested packed output with maps`, () => {
        for (const header of headers) {
          const source = GroupingRules.source(header)
          const direct = Transform.compile({ moduleId: 'groups.ts', source })
          const library = Graph.compile({ modules: { 'groups.ts': source } })
          const packed = Graph.compile({
            contracts: { 'lib/groups.js': library.contracts['groups.ts']! },
            imports: { 'app.ts': { lib: 'lib/groups.js' } },
            modules: { 'app.ts': `export {styles} from 'lib';` },
          })
          expect(direct.css.includes(header)).toMatchInlineSnapshot('true')
          expect(direct.css.includes('body{color:red;}')).toMatchInlineSnapshot(
            'true',
          )
          expect(
            packed.sharedCss?.includes('body{color:red;}'),
          ).toMatchInlineSnapshot('true')
          expect(
            Trace.originalPositionFor(
              new Trace.TraceMap(packed.sharedCssMap!),
              {
                line: 1,
                column: 0,
              },
            ),
          ).toMatchInlineSnapshot(`
          {
            "column": 0,
            "line": 2,
            "name": null,
            "source": "lib/groups.ts",
          }
        `)
        }
      })
    }
  })
})

describe('identifiers', () => {
  describe('compile', () => {
    test('native names resolve case-sensitive keyframes and named container queries', async () => {
      const output = Transform.compile({
        moduleId: 'identifiers.ts',
        source: Identifiers.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${Identifiers.native}${output.css}</style><div id="container" class="${module.container.className}"><span id="probe" class="probe">probe</span></div><div id="motion" class="${module.motion.className}"></div><div id="control" style="animation-name:Fade;animation-duration:1s;animation-delay:-250ms;animation-play-state:paused;animation-timing-function:linear;animation-fill-mode:both"></div><div id="names" class="${module.names.className}"></div>`,
        )

        expect(
          await page
            .locator('#motion')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.25"`)
        expect(
          await page
            .locator('#control')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.25"`)
        expect(
          await page
            .locator('#probe')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(0, 128, 0)"`)
        expect(
          await page
            .locator('#container')
            .evaluate((element) => getComputedStyle(element).containerName),
        ).toMatchInlineSnapshot(`"Card Secondary"`)
        expect(
          await page
            .locator('#names')
            .evaluate(
              (element) => getComputedStyle(element).viewTransitionName,
            ),
        ).toMatchInlineSnapshot(`"Hero"`)
        expect(
          await page
            .locator('#names')
            .evaluate(
              (element) => getComputedStyle(element).transitionProperty,
            ),
        ).toMatchInlineSnapshot(`"opacity, transform"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('images', () => {
  describe('compile', () => {
    test('preserves quoted image fallbacks and marker shorthand order', () => {
      const styles = Style.define({
        image: {
          backgroundImage: [
            'url("image.png")',
            'linear-gradient(red, blue) !important',
          ],
        },
        first: { marker: 'url(#first)' },
        second: { markerStart: 'url(#second)' },
        third: { marker: 'url(#first)', opacity: 0.5 },
      })

      expect(Css.compile({ styles }).css).toMatchInlineSnapshot(`
        ".z_0{background-image:url("image.png");background-image:linear-gradient(red, blue)!important;}
        .z_1{marker:url(#first);}
        .z_2{marker-start:url(#second);}
        .z_3{marker:url(#first);}
        .z_4{opacity:0.5;}"
      `)

      const lexer = Conformance.lexer()

      for (const value of [
        'url("image.png")',
        'linear-gradient(red, blue)',
        'url(#paint), none',
      ])
        expect(
          lexer.matchProperty('background-image', value).error,
        ).toMatchInlineSnapshot(`null`)
    })

    test('leaves CSS value validity to static authoring and the browser', () => {
      const styles = Reflect.apply(Style.define, undefined, [
        { card: { color: '#12', order: 0.5 } },
      ]) as Style.Definition

      expect(Css.compile({ styles }).css).toMatchInlineSnapshot(
        `
        ".z_0{color:#12;}
        .z_1{order:0.5;}"
      `,
      )

      const output = Transform.compile({
        moduleId: 'unchecked.ts',
        source: `import { style } from 'zyzz'; export const card = style({ color: '#12', order: 0.5 })();`,
      })

      expect(output.css.includes('color:#12;order:0.5;')).toMatchInlineSnapshot(
        `false`,
      )
    })

    test('image fallbacks and SVG markers match native browser declarations', async () => {
      const output = Transform.compile({
        moduleId: 'images.ts',
        source: `import { style } from 'zyzz'; export const image = style({ backgroundImage: ['url("missing.png")', 'linear-gradient(red, blue) !important'], maskImage: 'linear-gradient(black, transparent)' })(); export const marker = style({marker:'url(#arrow)', markerStart:'none'})();`,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="actual" class="${module.image.className}"></div><div id="control" style="background-image:linear-gradient(red, blue)!important;mask-image:linear-gradient(black, transparent)"></div><svg><defs><marker id="arrow" markerWidth="10" markerHeight="10"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs><path id="actual-marker" class="${module.marker.className}" d="M10,10 L50,10"/><path id="control-marker" style="marker:url(#arrow);marker-start:none" d="M10,30 L50,30"/></svg>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )
            const marker = getComputedStyle(
              document.getElementById('actual-marker')!,
            )
            const native = getComputedStyle(
              document.getElementById('control-marker')!,
            )

            return (
              actual.backgroundImage === control.backgroundImage &&
              actual.maskImage === control.maskImage &&
              marker.markerStart === native.markerStart &&
              marker.markerEnd === native.markerEnd
            )
          }),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('keyframeAcceptance', () => {
  describe('compile', () => {
    test('retains escaped stops exponent offsets and unrestricted timeline percentages through packed references', () => {
      for (const stop of [
        'FROM',
        '\\66 rom',
        '+0%,1e2%',
        'contain -20%',
        'cover 150%',
        'entry 20%',
        'entry-crossing 50%',
        'exit 100%',
        'exit-crossing 120%',
      ]) {
        const library = Graph.compile({
          modules: {
            'frames.ts': `import {keyframes} from 'zyzz/web';\nexport const fade=keyframes({'@layer motion':{'@media screen':{${JSON.stringify(stop)}:{opacity:0},to:{opacity:1}}}});`,
          },
        })
        const packed = Graph.compile({
          contracts: { 'lib/frames.js': library.contracts['frames.ts']! },
          imports: { 'app.ts': { lib: 'lib/frames.js', 'zyzz/web': null } },
          modules: {
            'app.ts': `import {fade} from 'lib';import {global} from 'zyzz/web';global({body:{animationName:fade}});`,
          },
        })
        expect(packed.sharedCss?.includes('@keyframes')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          packed.sharedCss?.includes('animation-name:z-'),
        ).toMatchInlineSnapshot('true')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }),
        ).toMatchInlineSnapshot(`
        {
          "column": 18,
          "line": 2,
          "name": null,
          "source": "lib/frames.ts",
        }
      `)
      }
    })
    test('rejects malformed and out-of-range ordinary frame selectors', () => {
      for (const stop of [
        '-1%',
        '101%',
        '0x10%',
        'entry',
        'unknown 50%',
        'from,',
        'from}body{color:red;',
      ]) {
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {keyframes} from 'zyzz/web';export const fade=keyframes({${JSON.stringify(stop)}:{opacity:0}});`,
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: invalid.ts:53: Keyframe stops require from, to, 0–100% offsets, or named timeline percentages.]`,
        )
      }
    })
  })
})

describe('keywordGroups', () => {
  describe('compile', () => {
    test('keyword groups agree with independent grammar in authored orders', () => {
      const lexer = Conformance.lexer()

      for (const [property, value] of [
        ['contain', 'layout style paint'],
        ['fontSynthesis', 'style weight small-caps'],
        ['fontVariantEastAsian', 'jis78 full-width ruby'],
        ['fontVariantLigatures', 'no-common-ligatures contextual'],
        ['fontVariantNumeric', 'oldstyle-nums tabular-nums slashed-zero'],
      ] as const) {
        for (const words of [value, value.split(' ').reverse().join(' ')]) {
          const output = Transform.compile({
            moduleId: 'groups.ts',
            source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(words)}})`,
          })

          expect(
            output.css.includes(`${Conformance.name(property)}:${words}`),
          ).toMatchInlineSnapshot(`true`)
          expect(
            lexer.matchProperty(Conformance.name(property), words).error,
          ).toMatchInlineSnapshot(`null`)
        }
      }
    })
    test('keyword groups match native browser declarations and priority', async () => {
      const output = Transform.compile({
        moduleId: 'groups.ts',
        source: KeywordGroups.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="actual" class="${module.text.className}" style="font-variant-numeric:lining-nums">123</div><div id="control" style="${KeywordGroups.control}">123</div>`,
        )

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('actual')!)
            const b = getComputedStyle(document.getElementById('control')!)

            return [
              'contain',
              'font-synthesis',
              'font-variant-east-asian',
              'font-variant-ligatures',
              'font-variant-numeric',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate(
              (element) => getComputedStyle(element).fontVariantNumeric,
            ),
        ).toMatchInlineSnapshot(`"oldstyle-nums tabular-nums slashed-zero"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('layout', () => {
  describe('compile', () => {
    test('layout preserves stacking importance', () => {
      const output = Transform.compile({
        moduleId: 'layout.ts',
        source: Layout.source,
      })

      expect(output.css.match(/z-index:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "z-index:auto",
        "z-index:2!important",
        "z-index:1",
      ]
    `)
    })

    test('layout matches browser float clearance, containment, and stacking', async () => {
      const output = Transform.compile({
        moduleId: 'layout.ts',
        source: Layout.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        const attributes = (
          name: keyof typeof Layout.controls,
          control: boolean,
        ) =>
          control
            ? `id="${name}-control" style="${Layout.controls[name]}"`
            : `id="${name}" class="${module[name].className}"`

        const markup = (control: boolean) =>
          `<main><div ${attributes('floatBox', control)}>Float</div><div ${attributes('cleared', control)}>Clear</div><section ${attributes('context', control)}><div ${attributes('front', control)}>Front</div><div ${attributes('back', control)}>Back</div></section><img ${attributes('image', control)} width="20" height="20" alt=""></main>`

        await page.setContent(
          `<style>${output.css}</style>${markup(false)}${markup(true)}`,
        )

        expect(
          await page.evaluate(
            (names) =>
              names.filter((name) => {
                const a = getComputedStyle(document.getElementById(name)!)
                const b = getComputedStyle(
                  document.getElementById(`${name}-control`)!,
                )

                return [
                  'backface-visibility',
                  'box-decoration-break',
                  'clear',
                  'contain',
                  'content-visibility',
                  'display',
                  'float',
                  'isolation',
                  'object-fit',
                  'transform-style',
                  'z-index',
                ].some(
                  (property) =>
                    a.getPropertyValue(property) !==
                    b.getPropertyValue(property),
                )
              }),
            Object.keys(Layout.controls),
          ),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#cleared')
            .evaluate(
              (element) =>
                element.getBoundingClientRect().top >=
                document.getElementById('floatBox')!.getBoundingClientRect()
                  .bottom,
            ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page.locator('#context').evaluate((element) => {
            const box = element.getBoundingClientRect()

            return document.elementFromPoint(box.x + 10, box.y + 10)?.id
          }),
        ).toMatchInlineSnapshot(`"front"`)
        expect(
          await page.locator('#context-control').evaluate((element) => {
            const box = element.getBoundingClientRect()

            return document.elementFromPoint(box.x + 10, box.y + 10)?.id
          }),
        ).toMatchInlineSnapshot(`"front-control"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('masks', () => {
  describe('compile', () => {
    test('masks preserve fallback sizes, background axis precedence, and maps', () => {
      const output = Transform.compile({
        moduleId: 'masks.ts',
        source: Masks.source,
      })

      expect(output.css.match(/background-position(?:-x)?:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "background-position-x:10px",
        "background-position:right",
        "background-position-x:20px",
      ]
    `)
      expect(output.css.match(/mask-size:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "mask-size:auto",
        "mask-size:50%!important",
      ]
    `)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('mask-size:50%!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('mask-size:50%!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 251,
          "line": 2,
          "name": "maskSize",
          "source": "masks.ts",
        }
      `)
    })

    test('masks match independent browser pixels and background precedence', async () => {
      const output = Transform.compile({
        moduleId: 'masks.ts',
        source: Masks.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>.box{width:80px;height:80px;padding:8px;border:8px solid #06c;background:#06c;mask-image:linear-gradient(black,black)}${output.css}</style><div id="actual" class="box ${module.mask.className}"></div><div id="control" class="box" style="${Masks.control}"></div><div id="unmasked" class="box" style="mask-image:none"></div>`,
        )

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('actual')!)
            const b = getComputedStyle(document.getElementById('control')!)

            return [
              'background-position',
              'image-rendering',
              'mask-clip',
              'mask-composite',
              'mask-mode',
              'mask-origin',
              'mask-position',
              'mask-repeat',
              'mask-size',
              'mask-type',
              'object-position',
              'perspective',
              'perspective-origin',
              'shape-margin',
              'transform-box',
              'transform-origin',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate(
              (element) => getComputedStyle(element).backgroundPosition,
            ),
        ).toMatchInlineSnapshot(`"100% 50%"`)

        const actual = await page.locator('#actual').screenshot()
        const control = await page.locator('#control').screenshot()
        const unmasked = await page.locator('#unmasked').screenshot()

        expect(actual.equals(control)).toMatchInlineSnapshot(`true`)
        expect(actual.equals(unmasked)).toMatchInlineSnapshot(`false`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('mathExpressions', () => {
  describe('compile', () => {
    test('dimensional expressions agree with independent CSS grammar', () => {
      const lexer = Conformance.lexer()

      for (const [property, value] of [
        ['width', 'clamp(20px, calc(50% - 10px), 200px)'],
        ['padding', 'calc(2px * 3) min(20px, 5%)'],
        ['borderRadius', 'calc(20px / 2) / max(10px, 5%)'],
        ['opacity', 'calc(1 / 2)'],
        ['order', 'calc(1.5)'],
        ['transitionDuration', 'calc(1s + 250ms), min(2s, 500ms)'],
        [
          'gridTemplateColumns',
          'minmax(calc(10px + 2px), 1fr) clamp(20px, 10%, 50px)',
        ],
      ] as const) {
        const output = Transform.compile({
          moduleId: 'math.ts',
          source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}})`,
        })

        expect(
          output.css.includes(`${Conformance.name(property)}:${value}`),
        ).toMatchInlineSnapshot(`true`)
        expect(
          lexer.matchProperty(Conformance.name(property), value).error,
        ).toMatchInlineSnapshot(`null`)
      }
    })
    test('nested math matches browser layout, integer rounding, and duration values', async () => {
      const output = Transform.compile({
        moduleId: 'math.ts',
        source: MathExpressions.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage({
          viewport: { width: 800, height: 600 },
        })

        await page.setContent(
          `<style>${output.css}.parent{width:400px}.grid{width:300px}</style><div class="parent"><div id="actual" class="${module.box.className}"></div><div id="control" style="${MathExpressions.control}"></div></div><div id="grid" class="grid ${module.grid.className}"></div><div id="grid-control" class="grid" style="display:grid;grid-template-columns:minmax(calc(10px + 2px),1fr) clamp(20px,10%,50px)"></div>`,
        )

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('actual')!)
            const b = getComputedStyle(document.getElementById('control')!)

            return [
              'width',
              'height',
              'padding-top',
              'padding-right',
              'border-top-left-radius',
              'opacity',
              'order',
              'transition-duration',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"190px"`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).order),
        ).toMatchInlineSnapshot(`"2"`)
        expect(
          await page.evaluate(
            () =>
              getComputedStyle(document.getElementById('grid')!)
                .gridTemplateColumns ===
              getComputedStyle(document.getElementById('grid-control')!)
                .gridTemplateColumns,
          ),
        ).toMatchInlineSnapshot(`true`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('motion', () => {
  describe('compile', () => {
    test('motion controls preserve units, importance, and source maps', () => {
      const output = Transform.compile({
        moduleId: 'motion.ts',
        source: Motion.source,
      })

      expect(output.css.match(/animation-duration:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "animation-duration:1s",
        "animation-duration:2s!important",
      ]
    `)

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('animation-duration:2s!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('animation-duration:2s!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 75,
          "line": 2,
          "name": "animationDuration",
          "source": "motion.ts",
        }
      `)
    })

    test('motion controls drive native paused animation timing', async () => {
      const output = Transform.compile({
        moduleId: 'motion.ts',
        source: Motion.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>@keyframes fade{from{opacity:0}to{opacity:1}}#actual,#control{animation-name:fade}${output.css}</style><div id="actual" class="${module.motion.className}">Motion</div><div id="control" style="${Motion.controls.motion}">Control</div><div id="transition" class="${module.transition.className}">Transition</div><div id="transition-control" style="${Motion.controls.transition}">Control</div>`,
        )

        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('actual')!)
            const b = getComputedStyle(document.getElementById('control')!)

            return [
              'animation-delay',
              'animation-duration',
              'animation-direction',
              'animation-fill-mode',
              'animation-iteration-count',
              'animation-play-state',
              'animation-timing-function',
              'opacity',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.25"`)
        expect(
          await page
            .locator('#actual')
            .evaluate(
              (element) =>
                element.getAnimations()[0]!.effect!.getTiming().duration,
            ),
        ).toMatchInlineSnapshot(`2000`)
        expect(
          await page
            .locator('#actual')
            .evaluate(
              (element) =>
                element.getAnimations()[0]!.effect!.getTiming().delay,
            ),
        ).toMatchInlineSnapshot(`-500`)
        expect(
          await page.evaluate(() => {
            const a = getComputedStyle(document.getElementById('transition')!)
            const b = getComputedStyle(
              document.getElementById('transition-control')!,
            )

            return [
              'transition-delay',
              'transition-duration',
              'transition-timing-function',
              'transition-behavior',
            ].filter(
              (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('motionLists', () => {
  describe('compile', () => {
    test('motion functions agree with independent CSS grammar', () => {
      const lexer = Conformance.lexer()

      for (const value of MotionLists.easing) {
        const output = Transform.compile({
          moduleId: 'motion-lists.ts',
          source: `import { style } from 'zyzz'; style({animationTimingFunction:${JSON.stringify(value)}});`,
        })

        expect(
          output.css.includes(`animation-timing-function:${value}`),
        ).toMatchInlineSnapshot(`true`)
        expect(
          lexer.matchProperty('animation-timing-function', value).error,
        ).toMatchInlineSnapshot(`null`)
      }

      const output = Transform.compile({
        moduleId: 'motion-lists.ts',
        source: MotionLists.source,
      })

      expect(output.css.match(/transition-duration:[^;}]+/g))
        .toMatchInlineSnapshot(`
      [
        "transition-duration:1s, 2s",
        "transition-duration:250ms, 500ms!important",
      ]
    `)
    })

    test('motion lists match native computed styles and paused curve output', async () => {
      const output = Transform.compile({
        moduleId: 'motion-lists.ts',
        source: MotionLists.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}@keyframes fade{from{opacity:0}to{opacity:1}}@keyframes move{from{left:0px}to{left:100px}}.animated{animation-name:fade,move;position:relative}</style><div id="actual" class="animated ${module.motion.className}"></div><div id="control" class="animated" style="${MotionLists.control}"></div>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return [
              'animation-delay',
              'animation-direction',
              'animation-duration',
              'animation-fill-mode',
              'animation-iteration-count',
              'animation-play-state',
              'animation-timing-function',
              'transition-behavior',
              'transition-delay',
              'transition-duration',
              'transition-timing-function',
              'opacity',
              'left',
            ].filter(
              (key) =>
                actual.getPropertyValue(key) !== control.getPropertyValue(key),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0.25"`)
        // Seek real CSS animations to a fixed time; no wall-clock timing assumptions.
        expect(
          await page.evaluate(() => {
            for (const animation of document.getAnimations())
              animation.currentTime = 500

            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return {
              left: actual.left,
              matches:
                actual.left === control.left &&
                actual.opacity === control.opacity,
              opacity: actual.opacity,
            }
          }),
        ).toMatchInlineSnapshot(`
        {
          "left": "75px",
          "matches": true,
          "opacity": "0.75",
        }
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('namedRules.browser', () => {
  describe('compile', () => {
    test('Chromium renders named descriptors and exact anchor fallback placement', async () => {
      const output = Transform.compile({
        moduleId: 'render.ts',
        source: `import {fontFace,fontPaletteValues,counterStyle,positionTry,global} from 'zyzz/web';
fontFace({fontFamily:'PaletteEvidence',src:${JSON.stringify(`url("${namedRulesFont.url}")`)}});
const blue=fontPaletteValues({fontFamily:'PaletteEvidence',basePalette:1});
const dots=counterStyle({system:'cyclic',symbols:'"●"',suffix:'" "'});
const above=positionTry({positionArea:'top'});
global({'#compiled':{fontPalette:blue},'#counter':{listStyleType:dots},'#tooltip':{position:'absolute',positionAnchor:'--target',positionArea:'bottom',positionTryFallbacks:above,width:'50px',height:'30px'}});`,
      })
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage({
          viewport: { width: 300, height: 200 },
        })
        await page.setContent(
          '<div id="compiled" class="font">A</div><div id="native" class="font">A</div><div id="red" class="font">A</div><li id="counter">item</li><li id="control">item</li><div id="anchor"></div><div id="tooltip"></div>',
        )
        await page.addStyleTag({ content: output.css })
        await page.addStyleTag({
          content:
            '@font-palette-values --native {font-family:PaletteEvidence;base-palette:1} @counter-style reference {system:cyclic;symbols:"●";suffix:" "} .font{font:40px PaletteEvidence;width:60px;height:40px} #native{font-palette:--native} #red{font-palette:normal} li{list-style-position:inside;width:100px;height:24px;font:16px Arial} #control{list-style-type:reference} #anchor{anchor-name:--target;position:absolute;top:180px;left:100px;width:20px;height:10px}',
        })
        await page.evaluate(() => document.fonts.ready)
        expect(
          await page.evaluate(() =>
            document.fonts.check('40px PaletteEvidence'),
          ),
        ).toMatchInlineSnapshot('true')
        expect(
          Buffer.compare(
            await page.locator('#compiled').screenshot(),
            await page.locator('#native').screenshot(),
          ),
        ).toMatchInlineSnapshot('0')
        expect(
          Buffer.compare(
            await page.locator('#compiled').screenshot(),
            await page.locator('#red').screenshot(),
          ) === 0,
        ).toMatchInlineSnapshot('false')
        expect(
          Buffer.compare(
            await page.locator('#counter').screenshot(),
            await page.locator('#control').screenshot(),
          ),
        ).toMatchInlineSnapshot('0')
        expect(
          await page.locator('#tooltip').evaluate((element) => {
            const box = element.getBoundingClientRect()
            return {
              bottom: box.bottom,
              height: box.height,
              left: box.left,
              width: box.width,
            }
          }),
        ).toMatchInlineSnapshot(`
        {
          "bottom": 180,
          "height": 30,
          "left": 85,
          "width": 50,
        }
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('namedRules', () => {
  describe('compile', () => {
    test('rejects property templates with palette identities', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            "import {style} from 'zyzz';import {counterStyle,fontPaletteValues} from 'zyzz/web';const palette=fontPaletteValues({fontFamily:'Body'});export const result=style({listStyleType:`${palette}`});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(`
        [Source.ExtractError: invalid.ts:177: Expected a literal string or number; expressions are not evaluated.
        invalid.ts:180: Named stylesheet reference is incompatible with this property.
        invalid.ts:180: Named stylesheet reference is incompatible with this property.]
      `)
    })
    test('rejects descriptor templates with palette identities', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            "import {style} from 'zyzz';import {counterStyle,fontPaletteValues} from 'zyzz/web';const palette=fontPaletteValues({fontFamily:'Body'});export const result=counterStyle({symbols:'\"x\"',fallback:`${palette}`});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:156: Named stylesheet reference is incompatible with this descriptor.]`,
      )
    })
    test('rejects negative base palette indexes', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            "import {style} from 'zyzz';import {counterStyle,fontPaletteValues} from 'zyzz/web';const palette=fontPaletteValues({fontFamily:'Body'});export const result=fontPaletteValues({fontFamily:\"Body\",basePalette:-1});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:156: Expected supported scalar descriptors and required fields.]`,
      )
    })
    test('rejects fractional base palette indexes', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            "import {style} from 'zyzz';import {counterStyle,fontPaletteValues} from 'zyzz/web';const palette=fontPaletteValues({fontFamily:'Body'});export const result=fontPaletteValues({fontFamily:\"Body\",basePalette:1.5});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:156: Expected supported scalar descriptors and required fields.]`,
      )
    })
    test.each([
      `export * from 'zyzz/web';export {counterStyle} from './local.js';`,
      `export * from 'zyzz/web';export function counterStyle(){return 'local'}`,
    ])(
      'preserves explicit exports before factory star exports: %s',
      (barrel) => {
        const output = Graph.compile({
          modules: {
            'barrel.ts': barrel,
            'local.ts': `export function counterStyle(){return 'local'}`,
            'main.ts': `import {counterStyle} from './barrel.js';export const result=counterStyle();`,
          },
        })
        expect(output.sharedCss).toMatchInlineSnapshot(`undefined`)
      },
    )
    test('maps contributions after an empty layer list', () => {
      const output = Transform.compile({
        moduleId: 'layers.ts',
        source: `import {layers,fontFace} from 'zyzz/web';layers([]);fontFace({fontFamily:'Body',src:'url(/font.ttf)'});`,
      })
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: 1,
          column: 0,
        }),
      ).toMatchInlineSnapshot(`
      {
        "column": 52,
        "line": 1,
        "name": null,
        "source": "layers.ts",
      }
    `)
    })
    test('rejects bare profile references as element colors', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'profile.js',
          source: `import {style} from 'zyzz';import {colorProfile} from 'zyzz/web';const profile=colorProfile({src:'url(/profile.icc)'});export namespace styles {
  export const text = style({color:profile})
}`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: profile.js:180: Named stylesheet reference is incompatible with this property.]`,
      )
    })
    test('emits valid JavaScript, prunes dead names, and resolves wrapped references', async () => {
      const output = Transform.compile({
        moduleId: 'names.js',
        source: `import {counterStyle,fontPaletteValues,positionTry,colorProfile} from 'zyzz/web';const unused=counterStyle({symbols:'"x"'});const unusedPalette=fontPaletteValues({fontFamily:'Body'});const unusedPosition=positionTry({top:'1px'});const unusedProfile=colorProfile({src:'url(/profile.icc)'});const base=counterStyle({symbols:'"x"'});export const alias=counterStyle({system:'extends decimal',fallback:(base)});`,
      })
      expect(
        (await Esbuild.transform(output.code, { loader: 'js' })).warnings,
      ).toMatchInlineSnapshot('[]')
      expect(output.css).toMatchInlineSnapshot(`
        "@counter-style z-counterstyle-base{symbols:"x";}
        @counter-style z-counterstyle-alias{system:extends decimal;fallback:z-counterstyle-base;}"
      `)
      const map = new Trace.TraceMap(output.cssMap)
      expect(Trace.originalPositionFor(map, { line: 2, column: 0 }))
        .toMatchInlineSnapshot(`
      {
        "column": 349,
        "line": 1,
        "name": null,
        "source": "names.js",
      }
    `)
    })
    test('rejects untyped cross-domain references and malformed descriptors', () => {
      const cases = [
        `export const x=counterStyle({});`,
        `export const x=counterStyle({system:'fixedfoo',symbols:'"x"'});`,
        `export const x=counterStyle({symbols:'"x"',fallback:1});`,
        `const p=fontPaletteValues({fontFamily:'Body'});export const x=style({listStyleType:p});`,
        `const p=fontPaletteValues({fontFamily:'Body'});export const x=counterStyle({symbols:'"x"',fallback:(p)});`,
      ]
      expect(
        cases.map((source) => {
          try {
            Transform.compile({
              moduleId: 'bad.js',
              source:
                `import {style} from 'zyzz';import {counterStyle,fontPaletteValues} from 'zyzz/web';` +
                source,
            })
            return 'accepted'
          } catch (error) {
            return error
          }
        }),
      ).toMatchInlineSnapshot(`
        [
          [Source.ExtractError: bad.js:98: The counter system requires symbols or additiveSymbols.],
          [Source.ExtractError: bad.js:98: Expected a supported counter system, with an integer after fixed.],
          [Source.ExtractError: bad.js:98: Expected supported scalar descriptors and required fields.],
          [Source.ExtractError: bad.js:166: Named stylesheet reference is incompatible with this property.],
          [Source.ExtractError: bad.js:145: Named stylesheet reference is incompatible with this descriptor.],
        ]
      `)
    })
    test('emits each named descriptor family and direct references', () => {
      const output = Transform.compile({
        moduleId: 'names.ts',
        source: `import {style} from 'zyzz'; import {colorProfile,counterStyle,fontPaletteValues,positionTry} from 'zyzz/web';
export const dots=counterStyle({system:'cyclic',symbols:'"●"',suffix:'" "'});
export const palette=fontPaletteValues({fontFamily:'Body',basePalette:0,overrideColors:'0 red'});
export const below=positionTry({positionArea:'bottom',marginTop:'4px'});
export const profile=colorProfile({src:'url(/profile.icc)',renderingIntent:'relative-colorimetric'});
export namespace styles {
  export const list = style({listStyleType:dots,fontPalette:palette,positionTryFallbacks:below})
}`,
      })
      expect(output.css).toMatchInlineSnapshot(`
        "@counter-style z-counterstyle-dots{system:cyclic;symbols:"●";suffix:" ";}
        @font-palette-values --z-fontpalettevalues-palette{font-family:Body;base-palette:0;override-colors:0 red;}
        @position-try --z-positiontry-below{position-area:bottom;margin-top:4px;}
        @color-profile --z-colorprofile-profile{src:url(/profile.icc);rendering-intent:relative-colorimetric;}
        .z_aRWX0o0{list-style-type:z-counterstyle-dots;}
        .z_aRWX0o1{font-palette:--z-fontpalettevalues-palette;}
        .z_aRWX0o2{position-try-fallbacks:--z-positiontry-below;}"
      `)
      expect(
        output.code
          .split('\n')
          .map((line) => line.trimEnd())
          .join('\n'),
      ).toMatchInlineSnapshot(`
        "
        import { Props as __zyzzProps } from 'zyzz/runtime';

        export const dots="z-counterstyle-dots" as import('zyzz/web').counterStyle.Reference;
        export const palette="--z-fontpalettevalues-palette" as import('zyzz/web').fontPaletteValues.Reference;
        export const below="--z-positiontry-below" as import('zyzz/web').positionTry.Reference;
        export const profile="--z-colorprofile-profile" as import('zyzz/web').colorProfile.Reference;
        export namespace styles {
          export const list = /*#__PURE__*/__zyzzProps.create({className:"z_aRWX0o0 z_aRWX0o1 z_aRWX0o2 z-style-aRWX0o-styles-list"})
        }"
      `)
    })
    test('preserves aliases and re-exports through packed metadata and rebuilds', () => {
      const compiler = Graph.create()
      const library = Graph.compile({
        modules: {
          'names.ts': `import {counterStyle} from 'zyzz/web';const dots=counterStyle({system:'cyclic',symbols:'"●"'});const alias=dots;export {alias};`,
        },
      })
      const input = {
        contracts: { 'lib/names.js': library.contracts['names.ts']! },
        imports: { 'app.ts': { lib: 'lib/names.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'zyzz';import {alias} from 'lib';export namespace styles {
  export const list = style({listStyleType:alias})
}`,
        },
      }
      const output = compiler.compile(input)
      expect(output.sharedCss).toMatchInlineSnapshot(
        `"@counter-style z-counterstyle-dots{system:cyclic;symbols:"●";}"`,
      )
      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{list-style-type:z-counterstyle-dots;}"`,
      )
      expect(
        JSON.parse(library.contracts['names.ts']!).version,
      ).toMatchInlineSnapshot(`31`)
      const edited = Graph.compile({
        modules: {
          'names.ts': `import {counterStyle} from 'zyzz/web';export const alias=counterStyle({system:'cyclic',symbols:'"■"'});`,
        },
      })
      expect(
        compiler.compile({
          ...input,
          contracts: { 'lib/names.js': edited.contracts['names.ts']! },
        }).sharedCss,
      ).toMatchInlineSnapshot(
        `"@counter-style z-counterstyle-alias{system:cyclic;symbols:"■";}"`,
      )
    })
    test('rejects unsupported descriptor keys and position declarations at the source call', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {positionTry} from 'zyzz/web';export const fallback=positionTry({color:'red'})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:59: Unsupported position-try declaration.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {fontPaletteValues} from 'zyzz/web';export const palette=fontPaletteValues({src:'url(/font)'})`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:64: Expected supported scalar descriptors and required fields.]`,
      )
    })
  })
})

describe('namespace', () => {
  const source = `import {namespace,global} from 'zyzz/web';
namespace({prefix:'svg',uri:'urn:obsolete'});
global({'svg|rect':{fill:'red'},'图|circle':{fill:'blue'},'[svg|mark]':{stroke:'green'}});
namespace({prefix:${JSON.stringify('\\73 vg')},uri:'http://www.w3.org/2000/svg'});
namespace({prefix:'图',uri:'http://www.w3.org/2000/svg'});`

  describe('compile', () => {
    test('versions namespace metadata while reading legacy ASCII contracts', () => {
      for (const prefixes of [
        ['图'],
        ['\\73 vg'],
        ['svg', 'svg'],
        [undefined, undefined],
        ['svg'],
      ]) {
        const library = Graph.compile({
          modules: {
            'names.ts': `import {namespace} from 'zyzz/web';${prefixes.map((prefix, index) => `namespace(${JSON.stringify({ prefix, uri: 'urn:' + index })});`).join('')}`,
          },
        })
        expect(
          JSON.parse(library.contracts['names.ts']!).version === 31,
        ).toMatchInlineSnapshot(`true`)

        const contract = JSON.parse(library.contracts['names.ts']!)
        if (prefixes.length === 1 && prefixes[0] === 'svg')
          contract.version = 10
        const packed = Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        expect(
          JSON.parse(packed.contracts['app.ts']!).version === 31,
        ).toMatchInlineSnapshot(`true`)
      }
    })

    test('preserves namespace URI control characters through packed output and native matching', async () => {
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        for (const uri of [
          'urn:line\nbreak',
          'urn:tab\treturn\r',
          'urn:quote"slash\\',
          'urn:control\u0001',
        ]) {
          const library = Graph.compile({
            modules: {
              'uri.ts': `import {namespace,global} from 'zyzz/web';namespace({prefix:'s',uri:${JSON.stringify(uri)}});global({'s|item':{color:'red'}});`,
            },
          })
          expect(
            JSON.parse(library.contracts['uri.ts']!).version,
          ).toMatchInlineSnapshot(`31`)
          const output = Graph.compile({
            contracts: { 'lib.js': library.contracts['uri.ts']! },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          })
          await page.setContent('<body></body>')
          await page.evaluate((uri) => {
            const element = document.createElementNS(uri, 'item')
            element.id = 'target'
            document.body.append(element)
          }, uri)
          await page.addStyleTag({ content: output.sharedCss! })
          expect(
            await page
              .locator('#target')
              .evaluate((element) => getComputedStyle(element).color),
          ).toMatchInlineSnapshot('"rgb(255, 0, 0)"')
        }
      } finally {
        await browser.close()
      }
    })
    test('resolves equivalent escaped prefixes using the last module binding and retains packed maps', () => {
      const library = Graph.compile({ modules: { 'shapes.ts': source } })
      const output = Graph.compile({
        contracts: { 'lib/shapes.js': library.contracts['shapes.ts']! },
        imports: { 'app.ts': { shapes: 'lib/shapes.js' } },
        modules: { 'app.ts': `import 'shapes';` },
      })

      expect(output.sharedCss).toMatchInlineSnapshot(`
      "@namespace z-n1tmgscii6bosa-17 "urn:obsolete";
      @namespace z-n1tmgscii6bosa-4z "http://www.w3.org/2000/svg";
      @namespace z-n1tmgscii6bosa-6r "http://www.w3.org/2000/svg";
      z-n1tmgscii6bosa-4z|rect {
        fill: red;
      }
      z-n1tmgscii6bosa-6r|circle {
        fill: #00f;
      }
      [z-n1tmgscii6bosa-4z|mark] {
        stroke: green;
      }"
    `)
      expect(
        JSON.parse(library.contracts['shapes.ts']!).stylesheets[0].namespaces,
      ).toMatchInlineSnapshot(`
      [
        {
          "kind": "namespace",
          "name": "z-n1tmgscii6bosa-17",
          "prefix": "svg",
          "uri": "urn:obsolete",
        },
        {
          "kind": "namespace",
          "name": "z-n1tmgscii6bosa-4z",
          "prefix": "\\73 vg",
          "uri": "http://www.w3.org/2000/svg",
        },
        {
          "kind": "namespace",
          "name": "z-n1tmgscii6bosa-6r",
          "prefix": "图",
          "uri": "http://www.w3.org/2000/svg",
        },
      ]
    `)
      const line =
        output
          .sharedCss!.split('\n')
          .findIndex((line) => line.includes('fill: red')) + 1
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.sharedCssMap!), {
          line,
          column: 2,
        }),
      ).toMatchInlineSnapshot(`
      {
        "column": 0,
        "line": 3,
        "name": null,
        "source": "lib/shapes.ts",
      }
    `)
    })

    test.each(['图', '--', '\\31 a', '\\|', '\\1f600 '])(
      'links the CSS identifier %s in source and packed selectors',
      (prefix) => {
        const library = Graph.compile({
          modules: {
            'rules.ts': `import {namespace,global} from 'zyzz/web';namespace({prefix:${JSON.stringify(prefix)},uri:''});global({${JSON.stringify(`${prefix}|item`)}:{color:'red'}});`,
          },
        })
        const output = Graph.compile({
          contracts: { 'lib.js': library.contracts['rules.ts']! },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        expect(output.sharedCss?.includes('|item')).toMatchInlineSnapshot(
          'true',
        )
        expect(output.sharedCss?.includes('color: red')).toMatchInlineSnapshot(
          'true',
        )
      },
    )

    test.each([
      '',
      '1abc',
      'a\\',
      'a b',
      'a\\\nb',
      'svg "urn:injected"; @namespace bad',
    ])('rejects malformed source and packed prefixes: %s', (prefix) => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {namespace} from 'zyzz/web';namespace({prefix:${JSON.stringify(prefix)},uri:'urn:a'});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:35: Expected a namespace URI and optional identifier prefix.]`,
      )
      const library = Graph.compile({
        modules: {
          'rules.ts': `import {namespace,global} from 'zyzz/web';namespace({prefix:'valid',uri:'urn:a'});global({'valid|item':{color:'red'}});`,
        },
      })
      const contract = JSON.parse(library.contracts['rules.ts']!)
      for (const section of contract.stylesheets)
        section.namespaces[0].prefix = prefix
      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib.js:0: Invalid library contract: Invalid packed namespace.]`,
      )
    })

    test('keeps empty and default namespaces distinct in Chromium', async () => {
      const output = Graph.compile({
        modules: {
          'shapes.ts': source,
          'default.ts': `import {namespace,global} from 'zyzz/web';namespace({uri:'urn:obsolete'});global({'.box':{color:'purple'},':is(.box)':{backgroundColor:'yellow'}});namespace({uri:'http://www.w3.org/1999/xhtml'});`,
          'empty.ts': `import {namespace,global} from 'zyzz/web';namespace({prefix:'empty',uri:''});global({'empty|item':{color:'orange'},'*|item':{backgroundColor:'pink'}});`,
        },
      })
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        const values: string[][][] = []
        for (const css of [
          output.sharedCss!,
          `@namespace svg "urn:obsolete";@namespace svg "http://www.w3.org/2000/svg";@namespace 图 "http://www.w3.org/2000/svg";svg|rect{fill:red}图|circle{fill:blue}[svg|mark]{stroke:green}`,
          `@namespace "urn:obsolete";@namespace "http://www.w3.org/1999/xhtml";.box{color:purple}:is(.box){background-color:yellow}`,
          `@namespace empty "";empty|item{color:orange}*|item{background-color:pink}`,
        ]) {
          if (values.length === 0 || css.startsWith('@namespace svg')) {
            await page.setContent(
              '<div id="html" class="box"></div><svg><rect id="rect" class="box"/><circle id="circle"/></svg><item id="html-item"></item>',
            )
            await page.evaluate(() => {
              document
                .querySelector('#rect')!
                .setAttributeNS('http://www.w3.org/2000/svg', 'mark', 'yes')
              const empty = document.createElementNS(null, 'item')
              empty.id = 'empty'
              document.body.append(empty)
            })
          }
          await page.addStyleTag({ content: css })
          if (css === output.sharedCss || css.startsWith('@namespace empty'))
            values.push(
              await page.evaluate(() =>
                ['html', 'rect', 'circle', 'empty', 'html-item'].map((id) => {
                  const value = getComputedStyle(document.getElementById(id)!)
                  return [
                    value.color,
                    value.backgroundColor,
                    value.fill,
                    value.stroke,
                  ]
                }),
              ),
            )
        }
        expect(values[0]).toMatchInlineSnapshot(`
        [
          [
            "rgb(128, 0, 128)",
            "rgb(255, 255, 0)",
            "rgb(0, 0, 0)",
            "none",
          ],
          [
            "rgb(0, 0, 0)",
            "rgba(0, 0, 0, 0)",
            "rgb(255, 0, 0)",
            "rgb(0, 128, 0)",
          ],
          [
            "rgb(0, 0, 0)",
            "rgba(0, 0, 0, 0)",
            "rgb(0, 0, 255)",
            "none",
          ],
          [
            "rgb(255, 165, 0)",
            "rgb(255, 192, 203)",
            "rgb(0, 0, 0)",
            "none",
          ],
          [
            "rgb(0, 0, 0)",
            "rgb(255, 192, 203)",
            "rgb(0, 0, 0)",
            "none",
          ],
        ]
      `)
        expect(values[1]).toMatchInlineSnapshot(`
        [
          [
            "rgb(128, 0, 128)",
            "rgb(255, 255, 0)",
            "rgb(0, 0, 0)",
            "none",
          ],
          [
            "rgb(0, 0, 0)",
            "rgba(0, 0, 0, 0)",
            "rgb(255, 0, 0)",
            "rgb(0, 128, 0)",
          ],
          [
            "rgb(0, 0, 0)",
            "rgba(0, 0, 0, 0)",
            "rgb(0, 0, 255)",
            "none",
          ],
          [
            "rgb(255, 165, 0)",
            "rgb(255, 192, 203)",
            "rgb(0, 0, 0)",
            "none",
          ],
          [
            "rgb(0, 0, 0)",
            "rgb(255, 192, 203)",
            "rgb(0, 0, 0)",
            "none",
          ],
        ]
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('namespaces', () => {
  const source = `import { style } from 'zyzz';
export namespace styles {
  const spacing = { padding: '8px' } as const;
  const base = { ...spacing, color: 'red' } as const;
  export const card = style(base);
  export const button = style({ ...base, color: 'blue' });
  export const dynamic = style((values: { width: '10px' | '20px' }) => ({ ...base, width: values.width }));
  export const alias = card;
}
export const card = styles.alias();
export const button = styles.button();
export const dynamic = styles.dynamic({ width: '20px' });`

  describe('compile', () => {
    test('reuses private declarations and exported callables within a namespace', async () => {
      const output = Transform.compile({ moduleId: 'namespace.ts', source })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_Kokhlf0{padding:8px;}
        .z_Kokhlf1{color:red;}
        .z_Kokhlf2{color:blue;}
        .z_Kokhlf3{color:red;}
        .z_Kokhlf4{width:var(--z-Kokhlf-styles-dynamic-width);}"
      `)

      const built = await Esbuild.build({
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        platform: 'node',
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: Path.resolve('.'),
        },
        write: false,
      })
      const result = await import(
        `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`
      )

      expect(result.card).toMatchInlineSnapshot(`
        {
          "className": "z_Kokhlf0 z_Kokhlf1 z-style-Kokhlf-styles-card",
        }
      `)
      expect(result.button).toMatchInlineSnapshot(`
        {
          "className": "z_Kokhlf0 z_Kokhlf2 z-style-Kokhlf-styles-button",
        }
      `)
      expect(result.dynamic).toMatchInlineSnapshot(`
        {
          "className": "z_Kokhlf0 z_Kokhlf3 z_Kokhlf4 z-style-Kokhlf-styles-dynamic",
          "style": {
            "--z-Kokhlf-styles-dynamic-width": "20px",
          },
        }
      `)
      expect(result.styles.alias === result.styles.card).toMatchInlineSnapshot(
        'true',
      )
    })

    test('keeps identically named declarations in separate namespace scopes', () => {
      const output = Transform.compile({
        moduleId: 'scopes.ts',
        source: `import {style} from 'zyzz';
      namespace first { const base = {color:'red'} as const; export const card = style(base); }
      namespace second { const base = {color:'blue'} as const; export const card = style(base); }`,
      })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_dRwjil0{color:red;}
        .z_dRwjil1{color:blue;}"
      `)
    })

    test('rejects mutation of reused namespace declarations', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'mutation.ts',
          source: `import {style} from 'zyzz'; namespace styles { const base = {color:'red'}; base.color='blue'; export const card = style(base); }`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: mutation.ts:75: Static data cannot be mutated or escape through unsupported expressions.]`,
      )
    })
  })
})

describe('output', () => {
  describe('compile', () => {
    test('inherits output through config aliases, re-exports, and theme handles', () => {
      for (const cssOutput of ['atomic', 'grouped'] as const) {
        const output = Graph.compile({
          modules: {
            'pkg/config.ts': `import { Config } from 'zyzz'
import { Css } from 'zyzz/web';export const { style, variants, vars:theme } = Config.create({cssOutput:'${cssOutput}',output:'html',vars:{color:{brand:'red'}}});`,
            'pkg/index.ts': `export { style as styled, theme, variants } from './config.js';`,
            'app.ts':
              "import {Config} from 'zyzz';\nimport { styled, variants, theme } from './pkg/index.js';\nexport const card=styled({color:'brand',padding:'8px'});\nexport const other=styled({color:'brand',padding:'8px'});\nexport const button=variants({base:{color:'brand',padding:'8px'},variants:{size:{large:{padding:'12px'}}}});\nexport const props=card();",
          },
        })
        const app = output.modules['app.ts']!

        if (cssOutput === 'atomic') {
          expect(app.code).toMatchInlineSnapshot(`
            "
            import { CompositionHtml as __zyzzCompositionHtml, Props as __zyzzProps, Recipe as __zyzzRecipe } from 'zyzz/runtime';

            import { styled, variants, theme } from './pkg/index.js';
            export const card=(__zyzzCompositionHtml.bind(__zyzzProps.create({className:"z_Zf5JrJ0 z_Zf5JrJ1 z-style-Zf5JrJ-card"})) as import('zyzz').style.ReturnType<'html'>);
            export const other=(__zyzzCompositionHtml.bind(__zyzzProps.create({className:"z_Zf5JrJ0 z_Zf5JrJ1 z-style-Zf5JrJ-other"})) as import('zyzz').style.ReturnType<'html'>);
            export const button=(__zyzzCompositionHtml.bind(/*#__PURE__*/__zyzzRecipe.create({"axes":{"size":["large"]},"defaults":{},"className":"z_Zf5JrJ0 z_Zf5JrJ2 z_Zf5JrJ3 z-style-Zf5JrJ-button"})) as import('zyzz').variants.ReturnType<{variants:{"size":{"large":{}}}},"html">);
            export const props=card();"
          `)
          expect(app.css).toMatchInlineSnapshot(`
            ".z-theme-theme{--z-color-brand:red;}
            .z_scheme-dark{color-scheme:dark;}
            .z_scheme-light{color-scheme:light;}
            .z_scheme-light-dark{color-scheme:light dark;}
            .z_Zf5JrJ0{color:var(--z-color-brand,red);}
            .z_Zf5JrJ1{padding:8px;}
            .z_Zf5JrJ2{padding:8px;}
            .z_Zf5JrJ3{&:where([data-size="large"]){padding:12px;}}"
          `)
        } else {
          expect(app.code).toMatchInlineSnapshot(`
            "
            import { CompositionHtml as __zyzzCompositionHtml, Props as __zyzzProps, Recipe as __zyzzRecipe } from 'zyzz/runtime';

            import { styled, variants, theme } from './pkg/index.js';
            export const card=(__zyzzCompositionHtml.bind(__zyzzProps.create({className:"z_Zf5JrJ0 z-style-Zf5JrJ-card"})) as import('zyzz').style.ReturnType<'html'>);
            export const other=(__zyzzCompositionHtml.bind(__zyzzProps.create({className:"z_Zf5JrJ1 z-style-Zf5JrJ-other"})) as import('zyzz').style.ReturnType<'html'>);
            export const button=(__zyzzCompositionHtml.bind(/*#__PURE__*/__zyzzRecipe.create({"axes":{"size":["large"]},"defaults":{},"className":"z_Zf5JrJ2 z-style-Zf5JrJ-button"})) as import('zyzz').variants.ReturnType<{variants:{"size":{"large":{}}}},"html">);
            export const props=card();"
          `)
          expect(app.css).toMatchInlineSnapshot(`
            ".z-theme-theme{--z-color-brand:red;}
            .z_scheme-dark{color-scheme:dark;}
            .z_scheme-light{color-scheme:light;}
            .z_scheme-light-dark{color-scheme:light dark;}
            .z_Zf5JrJ0{color:var(--z-color-brand,red);padding:8px;}
            .z_Zf5JrJ1{color:var(--z-color-brand,red);padding:8px;}
            .z_Zf5JrJ2{color:var(--z-color-brand,red);padding:8px;&:where([data-size="large"]){padding:12px;}}"
          `)
        }
      }
    })

    test('mode changes invalidate class output and preserve declaration tracing', () => {
      const source = (mode: string) =>
        `import {Config} from 'zyzz';const {style}=Config.create({cssOutput:'${mode}'});export const card=style({color:'red',padding:'8px'});`
      const atomic = Transform.compile({
        moduleId: 'app.ts',
        source: source('atomic'),
      })
      const grouped = Transform.compile({
        moduleId: 'app.ts',
        source: source('grouped'),
      })

      expect(atomic.classes).toMatchInlineSnapshot(`
        {
          "style-1e8a67z1uaws1j-96": "z_Zf5JrJ0 z_Zf5JrJ1 z-style-Zf5JrJ-card",
        }
      `)
      expect(grouped.classes).toMatchInlineSnapshot(`
        {
          "style-1e8a67z1uaws1j-97": "z_Zf5JrJ0 z-style-Zf5JrJ-card",
        }
      `)
      for (const [mode, output] of [
        ['atomic', atomic],
        ['grouped', grouped],
      ] as const) {
        const lines = output.css.split('\n')
        const line = lines.findIndex((line) => line.includes('padding:8px'))
        const mapped = Trace.originalPositionFor(
          new Trace.TraceMap(output.cssMap),
          {
            column: lines[line]!.indexOf('padding:8px'),
            line: line + 1,
          },
        )
        expect(mapped.source).toMatchInlineSnapshot(`"app.ts"`)
        if (mode === 'atomic')
          expect(mapped.column).toMatchInlineSnapshot(`115`)
        else expect(mapped.column).toMatchInlineSnapshot(`116`)
      }
    })

    test('rejects unsupported output options through config and extraction', () => {
      expect(() =>
        Config.create({ cssOutput: 'automatic' } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Config.InvalidError: cssOutput must be atomic or grouped.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'app.ts',
          source:
            "import {Config} from 'zyzz';const {style}=Config.create({cssOutput:'automatic'});const card=style({color:'red'});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:42: cssOutput must be atomic or grouped.]`,
      )
    })
    test('rejects unsupported composition options through config and extraction', () => {
      expect(() =>
        Config.create({ composition: 'shared' } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Config.InvalidError: composition must be independent or ordered.]`,
      )
      expect(() =>
        Transform.compile({
          moduleId: 'app.ts',
          source:
            "import {Config} from 'zyzz';const {style}=Config.create({composition:'shared'});const card=style({color:'red'});",
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: app.ts:42: composition must be independent or ordered.]`,
      )
    })

    test('configured independent composition shares rules with bound styles only', async () => {
      // The config's styles share equal declarations, while root helpers stay ordered.
      const source = `import {Config,cx,style} from 'zyzz';
const independent=Config.create({composition:'independent'});
namespace styles {
  export const card=independent.style({color:'red',padding:'8px'});
  export const label=independent.style({color:'red',padding:'4px'});
  export const plain=style({color:'red',padding:'8px'});
}
export const composed=cx(styles.card(),styles.label());
export const classes=[styles.card().className,styles.label().className,styles.plain().className,composed.className];`
      const output = Transform.compile({ moduleId: 'app.ts', source })

      expect(output.classes).toMatchInlineSnapshot(`
        {
          "composition-1e8a67z1uaws1j-337": "z_Zf5JrJ5 z_Zf5JrJ6",
          "style-1e8a67z1uaws1j-139": "z_Zf5JrJ0 z_Zf5JrJ1",
          "style-1e8a67z1uaws1j-208": "z_Zf5JrJ0 z_Zf5JrJ2",
          "style-1e8a67z1uaws1j-277": "z_Zf5JrJ3 z_Zf5JrJ4",
        }
      `)
      expect(output.css).toMatchInlineSnapshot(`
        ".z_Zf5JrJ0{color:red;}
        .z_Zf5JrJ1{padding:8px;}
        .z_Zf5JrJ2{padding:4px;}
        .z_Zf5JrJ3{color:red;}
        .z_Zf5JrJ4{padding:8px;}
        .z_Zf5JrJ5{color:red;color:red;}
        .z_Zf5JrJ6{padding:8px;padding:4px;}"
      `)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        bundle: true,
        format: 'iife',
        globalName: 'fixture',
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        write: false,
      })
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(`<style>${output.css}</style>`)
        await page.addScriptTag({ content: bundle.outputFiles[0]!.text })

        expect(
          await page.evaluate(() =>
            (
              window as unknown as { fixture: { classes: string[] } }
            ).fixture.classes.map((className) => {
              const element = document.createElement('div')

              element.className = className
              document.body.append(element)

              const style = getComputedStyle(element)

              return [style.color, style.padding]
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
              "4px",
            ],
            [
              "rgb(255, 0, 0)",
              "8px",
            ],
            [
              "rgb(255, 0, 0)",
              "4px",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }
    })

    test('shares atomic rules of styles that render alone and keeps combined styles ordered', async () => {
      // title and body render alone on DOM elements, and base and accent compose
      // only through cx. card takes an override, wide reaches a component, and
      // note and muted join in a template, so they keep definition order.
      const source = `import {cx,style} from 'zyzz';
function Card(props:{children:unknown,className:string}){return <article {...styles.card({className:props.className})}>{props.children}</article>}
export function App(){return <main>
<Card className={styles.wide().className}><h2 {...styles.title()}>Title</h2></Card>
<p className={styles.body().className}>Body</p>
<p className={\`\${styles.note().className} \${styles.muted().className}\`}>Joined</p>
<span {...cx(styles.base(),styles.accent())}>Accent</span>
</main>}
namespace styles {
export const title=style({padding:'24px'});
export const card=style({color:'red',padding:'8px'});
export const wide=style({padding:'24px'});
export const body=style({color:'blue',padding:'24px'});
export const note=style({padding:'8px'});
export const muted=style({padding:'24px'});
export const base=style({color:'red'});
export const accent=style({color:'blue'});
}`
      const output = Transform.compile({ moduleId: 'App.tsx', source })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_l0kPgl0{padding:24px;}
        .z_l0kPgl1{color:red;}
        .z_l0kPgl2{padding:8px;}
        .z_l0kPgl3{padding:24px;}
        .z_l0kPgl4{color:blue;}
        .z_l0kPgl5{padding:8px;}
        .z_l0kPgl6{padding:24px;}
        .z_l0kPgl7{color:red;}
        .z_l0kPgl8{color:red;}
        .z_l0kPgl9{color:blue;}"
      `)

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        bundle: true,
        external: ['react'],
        format: 'cjs',
        jsx: 'automatic',
        platform: 'node',
        stdin: {
          contents: output.code,
          loader: 'tsx',
          resolveDir: process.cwd(),
        },
        write: false,
      })
      const module = { exports: {} as { App: () => React.ReactNode } }

      new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(
        module,
        module.exports,
        Module.createRequire(import.meta.url),
      )

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style>${Server.renderToStaticMarkup(React.createElement(module.exports.App))}`,
        )

        // Wide and muted are defined after the rules they override.
        expect(
          await page.locator('article, h2, p, span').evaluateAll((elements) =>
            elements.map((element) => {
              const style = getComputedStyle(element)

              return [element.localName, style.color, style.paddingLeft]
            }),
          ),
        ).toMatchInlineSnapshot(`
          [
            [
              "article",
              "rgb(255, 0, 0)",
              "24px",
            ],
            [
              "h2",
              "rgb(255, 0, 0)",
              "24px",
            ],
            [
              "p",
              "rgb(0, 0, 255)",
              "24px",
            ],
            [
              "p",
              "rgb(0, 0, 0)",
              "24px",
            ],
            [
              "span",
              "rgb(0, 0, 255)",
              "0px",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }

      expect(
        Transform.compile({
          development: true,
          moduleId: 'App.tsx',
          source,
        }).css.includes('.z_'),
      ).toMatchInlineSnapshot(`false`)
    })

    test('preserves immutable configured output across extraction and composition', () => {
      for (const cssOutput of ['atomic', 'grouped'] as const) {
        const source = `import {Config,cx} from 'zyzz';const {style}=Config.create({cssOutput:'${cssOutput}'});const a=style({color:'red',padding:'8px'});const b=style({paddingLeft:'2px'});export const props=cx(a(),b());`
        const extracted = Source.extract({ moduleId: 'config.ts', source })
        function frozen(
          style: (typeof extracted.styles.styles)[number],
        ): boolean {
          return (
            Object.isFrozen(style) &&
            Object.isFrozen(style.declarations) &&
            (!style.rules ||
              (Object.isFrozen(style.rules) &&
                style.rules.every(
                  (rule) => Object.isFrozen(rule) && frozen(rule.style),
                )))
          )
        }
        expect(extracted.styles.styles.every(frozen)).toMatchInlineSnapshot(
          `true`,
        )
        if (cssOutput === 'atomic')
          expect(extracted.styles.styles.map((style) => style.cssOutput))
            .toMatchInlineSnapshot(`
            [
              "atomic",
              "atomic",
              "atomic",
            ]
          `)
        else
          expect(extracted.styles.styles.map((style) => style.cssOutput))
            .toMatchInlineSnapshot(`
            [
              "grouped",
              "grouped",
              "atomic",
            ]
          `)
        const output = Transform.compile({ moduleId: 'config.ts', source })
        const emitted = Css.compile({
          cssOutput: cssOutput === 'atomic' ? 'grouped' : 'atomic',
          styles: extracted.styles,
        })
        if (cssOutput === 'atomic') {
          expect(output.css).toMatchInlineSnapshot(`
            ".z_EZaLq60{color:red;}
            .z_EZaLq61{padding:8px;}
            .z_EZaLq62{padding-left:2px;}
            .z_EZaLq63{color:red;}
            .z_EZaLq64{padding:8px;}
            .z_EZaLq65{padding-left:2px;}"
          `)
          expect(emitted.css).toMatchInlineSnapshot(`
            ".z_0{color:red;}
            .z_1{padding:8px;}
            .z_2{padding-left:2px;}
            .z_3{padding:8px;}
            .z_4{padding-left:2px;}"
          `)
        } else {
          expect(output.css).toMatchInlineSnapshot(`
            ".z_EZaLq60{color:red;padding:8px;}
            .z_EZaLq61{padding-left:2px;}
            .z_EZaLq62{color:red;padding:8px;}
            .z_EZaLq63{padding-left:2px;}"
          `)
          expect(emitted.css).toMatchInlineSnapshot(`
            ".z_0{color:red;padding:8px;}
            .z_1{padding-left:2px;}
            .z_2{color:red;padding:8px;}
            .z_3{padding-left:2px;}"
          `)
        }
      }
    })

    test('rejects invalid style output metadata through the public emitter', () => {
      const extracted = Source.extract({
        moduleId: 'invalid.ts',
        source: "import {style} from 'zyzz'; style({color:'red'})",
      })
      const styles = {
        ...extracted.styles,
        styles: extracted.styles.styles.map((style) => ({
          ...style,
          cssOutput: 'invalid' as 'atomic',
        })),
      }
      expect(() => Css.compile({ styles })).toThrowErrorMatchingInlineSnapshot(
        `[Css.CompileError: ["style-1snulh75pd83z-28","cssOutput"]: cssOutput must be atomic or grouped.]`,
      )
    })

    test('preserves descendant output modes when deduplicating independent compositions', () => {
      const extracted = Source.extract({
        moduleId: 'modes.ts',
        source: `import {Config,cx,style} from 'zyzz';const atomic=Config.create({cssOutput:'atomic'});const grouped=Config.create({cssOutput:'grouped'});const a=atomic.style({color:'red',padding:'8px'});const b=grouped.style({color:'red',padding:'8px'});const empty=style();export const x=cx(a(),empty());export const y=cx(b(),empty())`,
      })
      const output = Css.compile({
        composition: 'independent',
        styles: extracted.styles,
      })
      const calls = extracted.calls.filter((call) => call.composition)
      expect(calls.map((call) => output.classes[call.name]!.split(' ').length))
        .toMatchInlineSnapshot(`
      [
        2,
        1,
      ]
    `)
    })
  })
})

describe('page.browser', () => {
  describe('compile', () => {
    test('prints named pages, pseudo-pages, counters, and all sixteen margin boxes', async () => {
      const output = Transform.compile({
        moduleId: 'print.ts',
        source: `import {global,page} from 'zyzz/web';
page({descriptors:{size:'200px 300px',margin:'30px','@top-left-corner':{content:'"TLC"'},'@top-left':{content:'"TL"'},'@top-center':{content:'"TC"'},'@top-right':{content:'"TR"'},'@top-right-corner':{content:'"TRC"'},'@bottom-left-corner':{content:'"BLC"'},'@bottom-left':{content:'"BL"'},'@bottom-center':{content:'counter(page) " / " counter(pages)'},'@bottom-right':{content:'"BR"'},'@bottom-right-corner':{content:'"BRC"'},'@left-top':{content:'"LT"'},'@left-middle':{content:'"LM"'},'@left-bottom':{content:'"LB"'},'@right-top':{content:'"RT"'},'@right-middle':{content:'"RM"'},'@right-bottom':{content:'"RB"'}}});
page({selector:':first',descriptors:{marginTop:'40px','@top-center':{content:'"First"'}}});
page({selector:':left',descriptors:{marginLeft:'40px'}});
page({selector:'wide',descriptors:{size:'400px 200px'}});
global({body:{margin:0,fontFamily:'Arial',fontSize:'8px'},section:{breakAfter:'page'},'section:last-child':{breakAfter:'auto'},'.wide':{page:'wide'}});`,
      })
      const reference = `@page {size:200px 300px;margin:30px;@top-left-corner{content:"TLC"}@top-left{content:"TL"}@top-center{content:"TC"}@top-right{content:"TR"}@top-right-corner{content:"TRC"}@bottom-left-corner{content:"BLC"}@bottom-left{content:"BL"}@bottom-center{content:counter(page) " / " counter(pages)}@bottom-right{content:"BR"}@bottom-right-corner{content:"BRC"}@left-top{content:"LT"}@left-middle{content:"LM"}@left-bottom{content:"LB"}@right-top{content:"RT"}@right-middle{content:"RM"}@right-bottom{content:"RB"}}
@page :first {margin-top:40px;@top-center{content:"First"}}
@page :left {margin-left:40px}
@page wide {size:400px 200px}
body{margin:0;font-family:Arial;font-size:8px}section{break-after:page}section:last-child{break-after:auto}.wide{page:wide}`
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        const html =
          '<section>One</section><section class="wide">Two</section><section>Three</section>'
        await page.setContent(html)
        await page.addStyleTag({ content: output.css })
        const compiled = await Pdf.PDFDocument.load(
          await page.pdf({ preferCSSPageSize: true, printBackground: true }),
        )
        await page.setContent(html)
        await page.addStyleTag({ content: reference })
        const native = await Pdf.PDFDocument.load(
          await page.pdf({ preferCSSPageSize: true, printBackground: true }),
        )

        expect(
          compiled.getPages().map((page) => {
            const { width, height } = page.getSize()
            return { height: Math.round(height), width: Math.round(width) }
          }),
        ).toMatchInlineSnapshot(`
          [
            {
              "height": 225,
              "width": 150,
            },
            {
              "height": 150,
              "width": 300,
            },
            {
              "height": 225,
              "width": 150,
            },
          ]
        `)
        expect(native.getPageCount()).toMatchInlineSnapshot('3')
        for (const [index, page] of compiled.getPages().entries()) {
          const reference = native.getPage(index)

          expect(
            Buffer.compare(streams(page), streams(reference)) === 0,
          ).toMatchInlineSnapshot('true')
        }
        // Each box must affect the PDF; equality alone could hide rules ignored by both paths.
        for (const box of Margins.boxes) {
          await page.setContent(html)
          await page.addStyleTag({
            content: reference.replace(
              new RegExp(`${box}\\{[^}]*\\}`, 'g'),
              '',
            ),
          })
          const omitted = await Pdf.PDFDocument.load(
            await page.pdf({ preferCSSPageSize: true, printBackground: true }),
          )
          expect(
            Buffer.compare(
              streams(native.getPage(1)),
              streams(omitted.getPage(1)),
            ) === 0,
          ).toMatchInlineSnapshot('false')
        }
      } finally {
        await browser.close()
      }
    })
  })

  function streams(page: Pdf.PDFPage) {
    const contents = page.node.Contents()
    const entries =
      contents instanceof Pdf.PDFArray ? contents.asArray() : [contents]
    return Buffer.concat(
      entries.map((entry) => {
        const stream = page.doc.context.lookup(entry)
        if (!(stream instanceof Pdf.PDFRawStream))
          throw new Error('Expected a PDF page content stream.')
        return Buffer.from(Pdf.decodePDFRawStream(stream).decode())
      }),
    )
  }
})

describe('page', () => {
  describe('compile', () => {
    test('retains every margin box and its source call through a packed library dependency', () => {
      const source = Margins.source('before')
      const direct = Transform.compile({ moduleId: 'pages.ts', source })
      const library = Graph.compile({
        imports: {
          'index.ts': { './pages.js': 'pages.ts' },
          'pages.ts': { 'zyzz/web': null },
        },
        modules: {
          'index.ts': `import './pages.js';`,
          'pages.ts': source,
        },
      })
      const packed = Graph.compile({
        contracts: {
          'lib/index.js': library.contracts['index.ts']!,
          'lib/pages.js': library.contracts['pages.ts']!,
        },
        imports: {
          'app.ts': { lib: 'lib/index.js' },
          'lib/index.js': { './pages.js': 'lib/pages.js' },
        },
        modules: { 'app.ts': `import 'lib';` },
      })

      for (const [css, map, owner] of [
        [direct.css, direct.cssMap, 'pages.ts'],
        [packed.sharedCss!, packed.sharedCssMap!, 'lib/pages.ts'],
      ] as const) {
        const trace = new Trace.TraceMap(map)
        for (const [index, box] of Margins.boxes.entries()) {
          const offset = css.indexOf(`${box}{`)
          expect(offset >= 0).toMatchInlineSnapshot('true')
          expect(
            css
              .slice(offset)
              .startsWith(`${box}{content:"before-${index}";color:red;}`),
          ).toMatchInlineSnapshot('true')

          const prefix = css.slice(0, offset).split('\n')
          const origin = Trace.originalPositionFor(trace, {
            column: prefix.at(-1)!.length,
            line: prefix.length,
          })
          expect(origin.source === owner).toMatchInlineSnapshot('true')
          expect(origin.line === index + 2).toMatchInlineSnapshot('true')
          expect(origin.column).toMatchInlineSnapshot('0')
        }
      }
    })
  })
})

describe('pagination', () => {
  describe('compile', () => {
    test('prints every page orientation and preserves avoid-break fragmentation through packed imports', async () => {
      const browser = await chromium.launch(
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : {},
      )
      try {
        const page = await browser.newPage()
        const geometry: Record<string, { height: number; width: number }> = {}
        const rotations: Record<string, Buffer> = {}
        for (const orientation of ['upright', 'rotate-left', 'rotate-right']) {
          const library = Graph.compile({
            modules: {
              'print.ts': `import {page} from 'zyzz/web';page({descriptors:{size:'200px 300px',margin:0,pageOrientation:${JSON.stringify(orientation)}}});`,
            },
          })
          const packed = Graph.compile({
            contracts: { 'print.js': library.contracts['print.ts']! },
            imports: { 'app.ts': { print: 'print.js' } },
            modules: { 'app.ts': `import 'print';` },
          })
          const documents = []
          for (const css of [
            packed.sharedCss!,
            `@page{size:200px 300px;margin:0;page-orientation:${orientation}}`,
          ]) {
            await page.setContent(
              '<div style="width:40px;height:20px;background:red">A</div>',
            )
            await page.addStyleTag({ content: css })
            documents.push(
              await Pdf.PDFDocument.load(
                await page.pdf({
                  preferCSSPageSize: true,
                  printBackground: true,
                }),
              ),
            )
          }
          const compiled = documents[0]!.getPage(0)
          const reference = documents[1]!.getPage(0)
          expect(
            Buffer.compare(stream(compiled), stream(reference)),
          ).toMatchInlineSnapshot('0')
          expect(
            JSON.stringify(compiled.getSize()) ===
              JSON.stringify(reference.getSize()),
          ).toMatchInlineSnapshot('true')
          const { height, width } = compiled.getSize()
          rotations[orientation] = stream(compiled)
          geometry[orientation] = {
            height: Math.round(height),
            width: Math.round(width),
          }
        }
        expect(geometry).toMatchInlineSnapshot(`
        {
          "rotate-left": {
            "height": 150,
            "width": 225,
          },
          "rotate-right": {
            "height": 150,
            "width": 225,
          },
          "upright": {
            "height": 225,
            "width": 150,
          },
        }
      `)
        expect(
          Buffer.compare(
            rotations['rotate-left']!,
            rotations['rotate-right']!,
          ) === 0,
        ).toMatchInlineSnapshot('false')

        const library = Graph.compile({
          modules: {
            'print.ts': `import {global,page} from 'zyzz/web';page({descriptors:{size:'200px 200px',margin:0}});global({body:{margin:0},article:{breakInside:'avoid',height:'120px',backgroundColor:'red'},'article:nth-child(2)':{backgroundColor:'blue'}});`,
          },
        })
        const packed = Graph.compile({
          contracts: { 'print.js': library.contracts['print.ts']! },
          imports: { 'app.ts': { print: 'print.js' } },
          modules: { 'app.ts': `import 'print';` },
        })
        const reference =
          '@page{size:200px 200px;margin:0}body{margin:0}article{break-inside:avoid;height:120px;background:red}article:nth-child(2){background:blue}'
        const documents = []
        for (const css of [
          packed.sharedCss!,
          reference,
          reference.replace('break-inside:avoid', 'break-inside:auto'),
        ]) {
          await page.setContent(
            '<article></article><article></article><article></article>',
          )
          await page.addStyleTag({ content: css })
          documents.push(
            await Pdf.PDFDocument.load(
              await page.pdf({
                preferCSSPageSize: true,
                printBackground: true,
              }),
            ),
          )
        }
        expect(documents.map((document) => document.getPageCount()))
          .toMatchInlineSnapshot(`
        [
          3,
          3,
          2,
        ]
      `)
        for (let index = 0; index < 3; index++)
          expect(
            Buffer.compare(
              stream(documents[0]!.getPage(index)),
              stream(documents[1]!.getPage(index)),
            ),
          ).toMatchInlineSnapshot('0')
      } finally {
        await browser.close()
      }
    }, 30_000)
  })

  function stream(page: Pdf.PDFPage): Buffer {
    const contents = page.node.Contents()
    const entries =
      contents instanceof Pdf.PDFArray ? contents.asArray() : [contents]
    return Buffer.concat(
      entries.map((entry) => {
        const value = page.doc.context.lookup(entry)
        if (!(value instanceof Pdf.PDFRawStream))
          throw new Error('Expected a PDF content stream.')
        return Buffer.from(Pdf.decodePDFRawStream(value).decode())
      }),
    )
  }
})

describe('percentage', () => {
  describe('compile', () => {
    test('percentages preserve units and match independent grammar', () => {
      const lexer = Conformance.lexer()

      for (const declarations of Object.values(Percentage.styles)) {
        for (const [property, value] of Object.entries(declarations)) {
          const name = property.replace(
            /[A-Z]/g,
            (letter) => `-${letter.toLowerCase()}`,
          )
          const output = Transform.compile({
            moduleId: 'percentage.ts',
            source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}});`,
          })

          expect(output.css.includes(`${name}:${value}`)).toMatchInlineSnapshot(
            `true`,
          )
          expect(
            lexer.matchProperty(name, String(value)).error,
          ).toMatchInlineSnapshot(`null`)
        }
      }
    })
    test('alpha values clamp in the browser and preserve important fallbacks', async () => {
      const output = Transform.compile({
        moduleId: 'percentage.ts',
        source: Percentage.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><svg><rect id="high" class="${module.high.className}"/><rect id="low" class="${module.low.className}"/></svg><div id="text" class="${module.text.className}"></div><div id="text-control" style="font-stretch:120%;font-width:125%;zoom:125%"></div>`,
        )

        expect(
          await page
            .locator('#high')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"1"`)
        expect(
          await page
            .locator('#high')
            .evaluate((element) => getComputedStyle(element).fillOpacity),
        ).toMatchInlineSnapshot(`"1"`)
        expect(
          await page
            .locator('#high')
            .evaluate((element) => getComputedStyle(element).strokeOpacity),
        ).toMatchInlineSnapshot(`"1"`)
        expect(
          await page
            .locator('#low')
            .evaluate((element) => getComputedStyle(element).opacity),
        ).toMatchInlineSnapshot(`"0"`)
        expect(
          await page
            .locator('#low')
            .evaluate((element) => getComputedStyle(element).floodOpacity),
        ).toMatchInlineSnapshot(`"0"`)
        expect(
          await page
            .locator('#low')
            .evaluate((element) => getComputedStyle(element).stopOpacity),
        ).toMatchInlineSnapshot(`"1"`)
        expect(
          await page
            .locator('#text')
            .evaluate((element) => getComputedStyle(element).fontStretch),
        ).toMatchInlineSnapshot(`"120%"`)
        expect(
          await page
            .locator('#text-control')
            .evaluate((element) => getComputedStyle(element).fontStretch),
        ).toMatchInlineSnapshot(`"120%"`)
        expect(
          await page.evaluate(() => CSS.supports('font-width', '125%')),
        ).toMatchInlineSnapshot(`false`)
        expect(
          await page
            .locator('#text')
            .evaluate((element) => getComputedStyle(element).zoom),
        ).toMatchInlineSnapshot(`"1.25"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('performance', () => {
  async function execute(source: string) {
    const output = Transform.compile({ moduleId: 'performance.ts', source })

    const runtime = await Esbuild.build({
      entryPoints: [Path.resolve('src/runtime/index.ts')],
      bundle: true,
      format: 'esm',
      write: false,
    })

    const url = `data:text/javascript;base64,${Buffer.from(runtime.outputFiles[0]!.text).toString('base64')}`
    const lowered = await Esbuild.transform(
      output.code.replace("'zyzz/runtime'", JSON.stringify(url)),
      { loader: 'ts', format: 'esm', target: 'esnext' },
    )
    const consumer = await import(
      `data:text/javascript;base64,${Buffer.from(lowered.code).toString('base64')}`
    )

    return { consumer, output }
  }

  describe('compile', () => {
    test('folds local namespace applications and retains escaping namespaces', async () => {
      const { consumer, output } = await execute(`import {style} from 'zyzz';
      export function apply(){return styles.card()}
      export let failed=false;
      try {apply()} catch(error){failed=error instanceof Error}
      namespace styles {export const card=style({color:'red'});}`)

      expect(
        output.code.includes('(styles.card?{className:'),
      ).toMatchInlineSnapshot('true')
      expect(consumer.failed).toMatchInlineSnapshot('true')
      expect(consumer.apply() === consumer.apply()).toMatchInlineSnapshot(
        'false',
      )

      for (const body of [
        `export namespace styles {export const card=style({color:'red'});} export function apply(){return styles.card()}`,
        `namespace styles {export const card=style({color:'red'});} export {styles}; export function apply(){return styles.card()}`,
        `namespace styles {export const card=style({color:'red'});} styles.card=()=>({className:'replaced'}); export function apply(){return styles.card()}`,
        `namespace styles {export const card=style({color:'red'});} export function apply(styles){return styles.card()}`,
      ]) {
        const { output } = await execute(`import {style} from 'zyzz';${body}`)

        expect(output.code.includes('?{className:')).toMatchInlineSnapshot(
          'false',
        )
      }
    })

    test('erases namespaces whose applications all follow initialization', async () => {
      const { consumer, output } = await execute(`import {style} from 'zyzz';
      namespace styles {export const card=style({color:'red'});export const label=style({color:'blue'})}
      export const classes=[styles.card().className,styles.label().className]`)

      expect(output.code).toMatchInlineSnapshot(`
        "
              
              export const classes=["z_iFQJXQ0","z_iFQJXQ1"]"
      `)
      expect(consumer.classes).toMatchInlineSnapshot(`
        [
          "z_iFQJXQ0",
          "z_iFQJXQ1",
        ]
      `)

      // A type that names the namespace keeps its member types.
      const typed = await execute(`import {style} from 'zyzz';
      namespace styles {export const card=style({color:'red'})}
      export type Card = typeof styles.card
      export const classes=[styles.card().className]`)

      expect(typed.output.code).toMatchInlineSnapshot(`
        "
              declare namespace styles {export const card: import('zyzz').style.ReturnType}
              export type Card = typeof styles.card
              export const classes=["z_iFQJXQ0"]"
      `)
    })

    test('folds class reads into class lists and keeps other uses of the object', async () => {
      const { consumer, output } = await execute(`import {style} from 'zyzz';
      const card=style({color:'red'});
      export const read=card().className;
      export const reads=[card().className,\`\${card().className} extra\`];
      export function write(){card().className='replaced'}
      export const optional=card()?.className;
      export const other=card().style`)

      // Plain reads fold, while writes, optional reads, and other members keep the object.
      expect(output.code).toMatchInlineSnapshot(`
        "import {style} from 'zyzz';
              const card=(1 as unknown as import('zyzz').style.ReturnType);
              export const read="z_iFQJXQ0";
              export const reads=["z_iFQJXQ0",\`\${"z_iFQJXQ0"} extra\`];
              export function write(){(card?{className:"z_iFQJXQ0"}:card()).className='replaced'}
              export const optional=({className:"z_iFQJXQ0"})?.className;
              export const other=({className:"z_iFQJXQ0"}).style"
      `)
      expect(consumer.read).toMatchInlineSnapshot(`"z_iFQJXQ0"`)
      expect(consumer.reads).toMatchInlineSnapshot(`
        [
          "z_iFQJXQ0",
          "z_iFQJXQ0 extra",
        ]
      `)
      expect(consumer.optional).toMatchInlineSnapshot(`"z_iFQJXQ0"`)
    })

    test('keeps guarded definitions without repeating their class lists', async () => {
      const { consumer, output } = await execute(`import {style} from 'zyzz';
      export function apply(){return [styles.card(),styles.label()]}
      export let failed=false;
      try {apply()} catch(error){failed=error instanceof TypeError}
      namespace styles {export const card=style({color:'red'});export const label=style({color:'blue'})}
      export const classes=[styles.label().className]
      const button=style({padding:'2px'});
      export const padding=button().className`)

      // The guarded card keeps a truthy definition, while the label and button follow initialization.
      expect(output.code).toMatchInlineSnapshot(`
        "
              export function apply(){return [(styles.card?{className:"z_iFQJXQ0"}:styles.card()),(styles.label?{className:"z_iFQJXQ1"}:styles.label())]}
              export let failed=false;
              try {apply()} catch(error){failed=error instanceof TypeError}
              namespace styles {export const card=(1 as unknown as import('zyzz').style.ReturnType);export const label=(1 as unknown as import('zyzz').style.ReturnType)}
              export const classes=["z_iFQJXQ1"]
              const button=(void 0 as unknown as import('zyzz').style.ReturnType);
              export const padding="z_iFQJXQ2""
      `)
      expect(consumer.failed).toMatchInlineSnapshot(`true`)
      expect(consumer.apply()).toMatchInlineSnapshot(`
        [
          {
            "className": "z_iFQJXQ0",
          },
          {
            "className": "z_iFQJXQ1",
          },
        ]
      `)
      expect(consumer.classes).toMatchInlineSnapshot(`
        [
          "z_iFQJXQ1",
        ]
      `)
      expect(consumer.padding).toMatchInlineSnapshot(`"z_iFQJXQ2"`)
    })

    test('folds local calls into fresh props while preserving initialization errors', async () => {
      const { consumer, output } = await execute(`import {style} from 'zyzz';
      export function early(){return card()}
      export let failed=false;
      try { early() } catch(error) { failed=error instanceof ReferenceError }
      const card=style({color:'red'});
      const styles={button:style({color:'blue'})};
      export function apply(){return [card(),styles.button()]}`)

      const first = consumer.apply()
      const second = consumer.apply()

      expect([
        consumer.failed,
        first[0] !== second[0],
        first[1] !== second[1],
        output.code.includes('(styles.button?{className:'),
      ]).toMatchInlineSnapshot(`
      [
        true,
        true,
        true,
        true,
      ]
    `)
    })

    test('bundled calls still fail when invoked before initialization', async () => {
      const output = Transform.compile({
        moduleId: 'early.ts',
        source: `import {style} from 'zyzz';
      export function early(){return card()}
      export let failed=false;
      try {early()} catch(error){failed=error instanceof Error}
      const card=style({color:'red'});`,
      })

      const bundle = await Esbuild.build({
        alias: { 'zyzz/runtime': Path.resolve('src/runtime/index.ts') },
        bundle: true,
        format: 'esm',
        minify: true,
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: process.cwd(),
        },
        write: false,
      })

      const consumer = await import(
        `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
      )

      expect(consumer.failed).toMatchInlineSnapshot(`true`)
    })

    test('does not mistake immediately applied props for a callable definition', async () => {
      for (const source of [
        `const props=style({color:'red'})();export function apply(){return props()}`,
        `const styles={card:style({color:'red'})()};export function apply(){return styles.card()}`,
      ]) {
        const { consumer } = await execute(
          `import {style} from 'zyzz';${source}`,
        )
        let failed = false

        try {
          consumer.apply()
        } catch (error) {
          failed = error instanceof TypeError
        }

        expect(failed).toMatchInlineSnapshot(`true`)
      }
    })

    test('retains escaping objects, shadowed bindings, overrides, and optional calls', async () => {
      for (const body of [
        `const styles={button:style({color:'red'})}; export {styles}; export function apply(){return styles.button()}`,
        `const card=style({color:'red'}); export function apply(card){return card()}`,
        `const card=style({color:'red'}); export function apply(){return card({className:'extra'})}`,
        `const card=style({color:'red'}); export function apply(){return card?.()}`,
      ]) {
        const { output } = await execute(`import {style} from 'zyzz'; ${body}`)

        expect(output.code.includes('?{className:')).toMatchInlineSnapshot(
          `false`,
        )
      }

      const { consumer } = await execute(`import {style} from 'zyzz';
      const styles={button:style({color:'red'})};
      styles.button=()=>({className:'replaced'});
      export function apply(){return styles.button()}`)

      expect(consumer.apply()).toMatchInlineSnapshot(`
      {
        "className": "replaced",
      }
    `)
    })

    test('specialized slots preserve getter order, empty values, precedence, and fresh styles', async () => {
      const source = `import {style} from 'zyzz'; export const apply=style((values:{width:string;alpha:number})=>({width:values.width,opacity:values.alpha}))`
      const { consumer, output } = await execute(source)
      const slots = Source.extract({ moduleId: 'performance.ts', source })
        .calls[0]!.slots!
      const generic = Dynamic.create({
        className: Object.values(output.classes)[0]!,
        slots,
      })
      const privateName = slots.width!.name

      for (const apply of [consumer.apply, generic]) {
        const reads: string[] = []
        const style = { color: 'red', [privateName]: 'wrong' }

        const input = {
          get width() {
            reads.push('width')

            return ''
          },
          get alpha() {
            reads.push('alpha')

            return 0
          },
          get className() {
            reads.push('className')

            return 'external'
          },
          get style() {
            reads.push('style')

            return style
          },
        }

        const props = apply(input)

        expect(reads).toMatchInlineSnapshot(`
        [
          "width",
          "alpha",
          "className",
          "style",
        ]
      `)
        expect([
          props.style[privateName],
          props.style !== style,
          style[privateName],
          props !== apply(input),
        ]).toMatchInlineSnapshot(`
        [
          " ",
          true,
          "wrong",
          true,
        ]
      `)
      }

      expect(output.code.includes('Dynamic as')).toMatchInlineSnapshot(`false`)
    })
  })

  describe('create', () => {
    test('returns fresh props and forwards unchanged styles with single getter reads', () => {
      for (const className of ['', 'generated']) {
        const apply = Props.create({ className })
        const style = { color: 'red' } as const
        const reads: string[] = []

        const result = apply({
          get className() {
            reads.push('className')

            return 'external'
          },
          get style() {
            reads.push('style')

            return style
          },
        })

        expect([
          apply() !== apply(),
          apply(undefined).className === className,
          result.style === style,
          result.className === (className ? 'generated external' : 'external'),
        ]).toMatchInlineSnapshot(`
        [
          true,
          true,
          true,
          true,
        ]
      `)
        expect(reads).toMatchInlineSnapshot(`
        [
          "className",
          "style",
        ]
      `)
      }
    })
  })
})

describe('prefixed', () => {
  describe('compile', () => {
    test('prefixed declarations retain exact names and match independent grammar', () => {
      const lexer = Conformance.lexer()
      const output = Transform.compile({
        moduleId: 'prefixed.ts',
        source: Prefixed.source,
      })

      expect(
        output.css.includes('-ms-scrollbar-3dlight-color:red;'),
      ).toMatchInlineSnapshot(`true`)
      expect(
        output.css.includes('-webkit-mask-composite:source-over, xor;'),
      ).toMatchInlineSnapshot(`true`)
      expect(
        output.css.includes('-webkit-border-before:2px solid red;'),
      ).toMatchInlineSnapshot(`true`)

      for (const declarations of Object.values(Prefixed.styles)) {
        for (const [property, value] of Object.entries(declarations)) {
          expect(
            lexer.matchProperty(Conformance.name(property), String(value))
              .error,
          ).toMatchInlineSnapshot(`null`)
        }
      }
    })
    test('prefixed aliases match native borders and preserve repeated overrides', async () => {
      const output = Transform.compile({
        moduleId: 'prefixed.ts',
        source:
          Prefixed.source +
          `
export const first = style({WebkitUserSelect:'none'})();
export const second = style({userSelect:'text'})();
export const third = style({WebkitUserSelect:'none',opacity:.5})();`,
      })

      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="borders" class="${module.borders.className}"></div><div id="control" style="${Prefixed.control}"></div><div id="text" class="${module.text.className}"></div><div id="repeat" class="${module.first.className} ${module.second.className} ${module.third.className}"></div>`,
        )

        expect(
          await page.evaluate(() =>
            CSS.supports('-webkit-border-before', '2px solid red'),
          ),
        ).toMatchInlineSnapshot(`true`)

        for (const writingMode of [
          'horizontal-tb',
          'vertical-rl',
          'vertical-lr',
        ]) {
          for (const direction of ['ltr', 'rtl']) {
            await page.locator('#borders, #control').evaluateAll(
              (elements, options) => {
                for (const element of elements) {
                  const style = (element as HTMLElement).style

                  style.writingMode = options.writingMode
                  style.direction = options.direction
                }
              },
              { direction, writingMode },
            )

            for (const property of [
              'border-top',
              'border-right',
              'border-bottom',
              'border-left',
            ]) {
              const actual = await page
                .locator('#borders')
                .evaluate(
                  (element, property) =>
                    getComputedStyle(element).getPropertyValue(property),
                  property,
                )

              const control = await page
                .locator('#control')
                .evaluate(
                  (element, property) =>
                    getComputedStyle(element).getPropertyValue(property),
                  property,
                )

              expect(actual === control).toMatchInlineSnapshot(`true`)
            }
          }
        }

        expect(
          await page
            .locator('#text')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue(
                '-webkit-text-fill-color',
              ),
            ),
        ).toMatchInlineSnapshot(`"rgb(10, 20, 30)"`)
        expect(
          await page
            .locator('#text')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue(
                '-webkit-text-stroke-width',
              ),
            ),
        ).toMatchInlineSnapshot(`"2px"`)
        expect(
          await page
            .locator('#text')
            .evaluate((element) => getComputedStyle(element).userSelect),
        ).toMatchInlineSnapshot(`"text"`)
        expect(
          await page
            .locator('#repeat')
            .evaluate((element) => getComputedStyle(element).userSelect),
        ).toMatchInlineSnapshot(`"none"`)
      } finally {
        await browser.close()
      }
    })
    test('legacy box display keywords clamp lines like an inline control', async () => {
      const declarations =
        'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font:16px/20px monospace;width:80px'
      const output = Transform.compile({
        moduleId: 'clamp.ts',
        source: `import { style } from 'zyzz'
export const block = style({ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', font: '16px/20px monospace', width: '80px' })()
export const inline = style({ display: '-webkit-inline-box' })()`,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const lexer = Conformance.lexer()

      for (const value of ['-webkit-box', '-webkit-inline-box'])
        expect(
          lexer.matchProperty('display', value).error,
        ).toMatchInlineSnapshot(`null`)

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        const text = 'one two three four five six seven eight nine ten'

        await page.setContent(
          `<style>${output.css}</style><div id="block" class="${module.block.className}">${text}</div><div id="control" style="${declarations}">${text}</div><span id="inline" class="${module.inline.className}"></span>`,
        )

        const display = (selector: string) =>
          page
            .locator(selector)
            .evaluate((element) => getComputedStyle(element).display)

        expect(
          (await display('#block')) === (await display('#control')),
        ).toMatchInlineSnapshot(`true`)
        expect(await display('#inline')).toMatchInlineSnapshot(
          `"-webkit-inline-box"`,
        )
        expect(
          await page
            .locator('#block')
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toMatchInlineSnapshot(`40`)
        expect(
          await page
            .locator('#control')
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toMatchInlineSnapshot(`40`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('print', () => {
  describe('compile', () => {
    test('prints packed bleed and marks with independent geometry and raster controls', async () => {
      const library = Graph.compile({
        modules: {
          'print.ts': `import {page} from 'zyzz/web';page({descriptors:{size:'100mm 100mm',margin:'10mm',bleed:'3mm',marks:'crop cross'}});`,
        },
      })
      const packed = Graph.compile({
        contracts: { 'lib.js': library.contracts['print.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })
      const compiled = await WeasyPrint.render(
        `<style>${packed.sharedCss}</style>`,
      )
      const reference = await WeasyPrint.render(
        '<style>@page{size:100mm 100mm;margin:10mm;bleed:3mm;marks:crop cross}</style>',
      )
      const control = await WeasyPrint.render(
        '<style>@page{size:100mm 100mm;margin:10mm;bleed:3mm;marks:none}</style>',
      )

      expect(
        Buffer.compare(compiled.pixels, reference.pixels),
      ).toMatchInlineSnapshot('0')
      expect(
        compiled.pixels.some((channel) => channel < 250),
      ).toMatchInlineSnapshot('true')
      expect(
        control.pixels.every((channel) => channel === 255),
      ).toMatchInlineSnapshot('true')

      const document = await Pdf.PDFDocument.load(compiled.pdf)
      const page = document.getPage(0)
      for (const name of ['BleedBox', 'MediaBox']) {
        const box = page.node.lookup(Pdf.PDFName.of(name), Pdf.PDFArray)
        expect(
          box
            .asArray()
            .map(
              (value) =>
                Math.round((value as Pdf.PDFNumber).asNumber() * 1000) / 1000,
            ),
        ).toMatchInlineSnapshot(`
        [
          -8.504,
          -8.504,
          291.969,
          291.969,
        ]
      `)
      }
      expect(page.getTrimBox()).toMatchInlineSnapshot(`
      {
        "height": 283.464567,
        "width": 283.464567,
        "x": 0,
        "y": 0,
      }
    `)
    }, 30_000)

    test('paints packed ICC references and reports unsupported relative-profile rendering', async () => {
      const library = Graph.compile({
        modules: {
          'colors.ts': `import {colorProfile,global} from 'zyzz/web';export const profile=colorProfile({src:${JSON.stringify(`url("${Profile.url}")`)},components:'r,g,b'});global({'#sample':{backgroundColor:\`color(\${profile} 1 0 0)\`}});`,
        },
      })
      const packed = Graph.compile({
        contracts: { 'lib.js': library.contracts['colors.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })
      const html = (css: string) =>
        `<style>@page{size:40px 40px;margin:0}body{margin:0}#sample{width:40px;height:40px}${css}</style><div id="sample"></div>`
      const compiled = await WeasyPrint.render(html(packed.sharedCss!))
      const reference = await WeasyPrint.render(
        html(
          `@color-profile --reference{src:url("${Profile.url}");components:r,g,b}#sample{background:color(--reference 1 0 0)}`,
        ),
      )
      const relative = await WeasyPrint.render(
        html(
          `@color-profile --reference{src:url("${Profile.url}");components:r,g,b}#sample{background:color(from color(--reference 1 0 0) --reference r g b)}`,
        ),
      )

      expect(
        Buffer.compare(compiled.pixels, reference.pixels),
      ).toMatchInlineSnapshot('0')
      const center =
        (Math.floor(compiled.height / 2) * compiled.width +
          Math.floor(compiled.width / 2)) *
        3
      expect([...compiled.pixels.subarray(center, center + 3)])
        .toMatchInlineSnapshot(`
      [
        255,
        0,
        0,
      ]
    `)
      expect(
        relative.pixels.every((channel) => channel === 255),
      ).toMatchInlineSnapshot('true')

      const document = await Pdf.PDFDocument.load(compiled.pdf)
      const resources = document.getPage(0).node.Resources()!
      const spaces = resources.lookup(Pdf.PDFName.of('ColorSpace'), Pdf.PDFDict)
      const custom = spaces
        .entries()
        .find(([name]) => name.asString().startsWith('/--z-'))!
      const space = document.context.lookup(custom[1], Pdf.PDFArray)
      expect(space.get(0).toString()).toMatchInlineSnapshot('"/ICCBased"')
      const profile = document.context.lookup(space.get(1))
      if (!(profile instanceof Pdf.PDFRawStream))
        throw new Error('Expected an embedded ICC profile stream.')

      expect(
        profile.dict.lookup(Pdf.PDFName.of('N'), Pdf.PDFNumber).asNumber(),
      ).toMatchInlineSnapshot('3')
      expect(
        Buffer.compare(
          Buffer.from(Pdf.decodePDFRawStream(profile).decode()),
          Buffer.from(Profile.url.split(',')[1]!, 'base64'),
        ),
      ).toMatchInlineSnapshot('0')

      await Fs.mkdir('test-results', { recursive: true })
      await Fs.writeFile(
        'test-results/at-rule-print-capabilities.json',
        JSON.stringify(
          {
            engine: compiled.version,
            features: {
              iccPainting: 'verified',
              relativeProfileColors: 'unsupported',
              renderingIntent: 'unverified',
            },
          },
          null,
          2,
        ),
      )
    }, 30_000)
  })
})

describe('profile', () => {
  const source = `import {colorProfile, global} from 'zyzz/web';
export const profile = colorProfile({src:'url(./print.icc)',components:'c, m, y, k',renderingIntent:'relative-colorimetric'});
global({body:{color:\`color(\${profile} 0 1 1 0)\`}});`

  describe('compile', () => {
    test('requires a URL source', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({src:'local(profile)'});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:59: Color-profile src requires one URL.]`,
      )
    })

    test('rejects an unknown rendering intent', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({src:'url(/p.icc)',renderingIntent:'auto'});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:59: Invalid color-profile rendering intent.]`,
      )
    })

    test('rejects malformed profile descriptors from packed libraries', () => {
      const library = Graph.compile({
        modules: {
          'profile.ts': `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({src:'url(/p.icc)'});`,
        },
      })
      const contract = JSON.parse(library.contracts['profile.ts']!)
      contract.stylesheets[0].css =
        '@color-profile --profile{src:url(/p.icc);components:r,none,b;}'
      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: { 'app.ts': `import 'lib';` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib.js:0: Invalid library contract: Color-profile components require comma-separated identifiers other than none.]`,
      )
    })

    test('validates all profile descriptor grammars before source and packed publication', () => {
      for (const components of [
        'r,g,b',
        '图, \\72 ed, pi',
        'inherit, default, --custom',
        'r,r,b',
      ]) {
        for (const renderingIntent of [
          'absolute-colorimetric',
          'relative-colorimetric',
          'perceptual',
          'saturation',
        ]) {
          const library = Graph.compile({
            modules: {
              'profile.ts': `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({'@layer colors':{'@media print':{src:'url(/print.icc)',components:${JSON.stringify(components)},renderingIntent:${JSON.stringify(renderingIntent)}}}});`,
            },
          })
          const packed = Graph.compile({
            contracts: { 'lib.js': library.contracts['profile.ts']! },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `export {profile} from 'lib';` },
          })
          expect(
            packed.sharedCss?.includes('rendering-intent:'),
          ).toMatchInlineSnapshot('true')
          expect(
            packed.sharedCss?.includes('components:'),
          ).toMatchInlineSnapshot('true')
        }
      }
    })
    test('rejects invalid component lists instead of emitting an unusable profile', () => {
      for (const components of [
        '',
        'r g b',
        'none',
        'r,NoNe,b',
        'r,\\6e one,b',
        'r,,b',
        'r,b,',
        '1r,g,b',
        '"r",g,b',
      ]) {
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {colorProfile} from 'zyzz/web';export const profile=colorProfile({src:'url(/print.icc)',components:${JSON.stringify(components)}});`,
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: invalid.ts:59: Color-profile components require comma-separated identifiers other than none.]`,
        )
      }
    })

    test('preserves profile components and color expressions across packed aliases', () => {
      const library = Graph.compile({ modules: { 'profiles.ts': source } })
      const output = Graph.compile({
        contracts: { 'lib/profiles.js': library.contracts['profiles.ts']! },
        imports: { 'app.ts': { lib: 'lib/profiles.js', zyzz: null } },
        modules: {
          'app.ts': `import {profile as print} from 'lib';import {style} from 'zyzz';export const styles={text:style({color:\`color(\${print} 0 0 0 1)\`})};`,
        },
      })

      expect(output.sharedCss).toMatchInlineSnapshot(`
        "@color-profile --z-colorprofile-profile {
          src:url("zyzz-asset:lib%2Fprint.icc");components:c, m, y, k;rendering-intent:relative-colorimetric;
        }
        body{color:color(--z-colorprofile-profile 0 1 1 0);}"
      `)
      expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:lib%2Fprint.icc": "lib/print.icc",
      }
    `)
      expect(output.modules['app.ts']?.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{color:color(--z-colorprofile-profile 0 0 0 1);}"`,
      )
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.sharedCssMap!), {
          line: 1,
          column: 0,
        }),
      ).toMatchInlineSnapshot(`
      {
        "column": 23,
        "line": 2,
        "name": null,
        "source": "lib/profiles.ts",
      }
    `)
    })

    test('preserves relative colors and nested profile interpolation', () => {
      const output = Transform.compile({
        moduleId: 'relative.ts',
        source: `import {colorProfile,global} from 'zyzz/web';const profile=colorProfile({src:'url(/print.icc)',components:'c,m,y,k'});global({body:{color:\`color(from rgb(1 2 3) \${profile} c m y k)\`,backgroundColor:\`color(\${\`\${profile}\`} 0 0 0 1)\`}});`,
      })

      expect(output.css).toMatchInlineSnapshot(`
        "@color-profile --z-colorprofile-profile{src:url(/print.icc);components:c,m,y,k;}
        body{color:color(from rgb(1 2 3) --z-colorprofile-profile c m y k);background-color:color(--z-colorprofile-profile 0 0 0 1);}"
      `)
    })

    test('retains referenced origins before relative profile names in packed output', () => {
      const library = Graph.compile({
        modules: {
          'relative.ts':
            "import {Vars} from 'zyzz';import {colorProfile,global} from 'zyzz/web';const theme=Vars.define({color:{base:'red'}});const profile=colorProfile({src:'url(/print.icc)',components:'c,m,y,k'});global({body:{color:`color(from ${theme.color.base} ${profile} c m y k)`}});",
        },
      })
      const packed = Graph.compile({
        contracts: { 'lib.js': library.contracts['relative.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })

      expect(packed.sharedCss).toMatchInlineSnapshot(`
        "@color-profile --z-colorprofile-profile{src:url(/print.icc);components:c,m,y,k;}
        body{color:color(from var(--z-color-base,red) --z-colorprofile-profile c m y k);}"
      `)
    })

    test('rejects a profile interpolated outside color()', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'invalid.ts',
          source: `import {colorProfile,global} from 'zyzz/web';const profile=colorProfile({src:'url(/print.icc)'});global({body:{color:\`\${profile}\`}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: invalid.ts:97: Named stylesheet reference is incompatible with this descriptor.]`,
      )
    })

    test('retains Unicode, import ordering, and source maps without a BOM or charset contribution', () => {
      const output = Graph.compile({
        modules: {
          'unicode.ts': `import {global,importCss} from 'zyzz/web';\nglobal({'body::before':{content:'"héllo ● 日本語"'}});\nimportCss({url:'https://example.com/base.css'});`,
        },
      })
      const packed = Graph.compile({
        contracts: { 'lib/unicode.js': output.contracts['unicode.ts']! },
        imports: { 'app.ts': { lib: 'lib/unicode.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })

      expect(packed.sharedCss).toBe(output.sharedCss)
      const css = packed.sharedCss!

      expect(css).toMatchInlineSnapshot(`
      "@import url("https://example.com/base.css");
      body::before{content:"héllo ● 日本語";}"
    `)
      expect(
        new TextDecoder('utf-8', { fatal: true }).decode(
          new TextEncoder().encode(css),
        ),
      ).toMatchInlineSnapshot(`
      "@import url("https://example.com/base.css");
      body::before{content:"héllo ● 日本語";}"
    `)
      expect(css.startsWith('@import')).toMatchInlineSnapshot('true')
      expect(css.includes('@charset')).toMatchInlineSnapshot('false')
      expect(css.charCodeAt(0) === 0xfeff).toMatchInlineSnapshot('false')
    })
  })
})

describe('properties', () => {
  const require = Module.createRequire(import.meta.url)
  const properties: Record<
    string,
    { initial: string | readonly string[] }
  > = require('mdn-data/css/properties.json')

  describe('compile', () => {
    test('every property preserves native declaration and computed-style behavior', async () => {
      const samples = new Map<string, Conformance.Case[]>()

      for (const entry of Conformance.cases()) {
        const group = samples.get(entry.property) ?? []

        group.push(entry)
        samples.set(entry.property, group)
      }

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        const selected = await page.evaluate(
          (groups) =>
            groups.map(([property, entries]) => ({
              property,
              entries: entries.filter(({ name, value }) =>
                CSS.supports(name, String(value)),
              ),
            })),
          [...samples].map(
            ([property, entries]) =>
              [
                property,
                entries.map((entry) => ({
                  ...entry,
                  name: Conformance.name(entry.property),
                })),
              ] as const,
          ),
        )

        const unsupported = selected
          .filter(({ entries }) => !entries.length)
          .map(({ property }) => Conformance.name(property))
          .sort()

        await Fs.mkdir('test-results', { recursive: true })
        await Fs.writeFile(
          'test-results/css-browser-capabilities.json',
          JSON.stringify(
            {
              browser: browser.version(),
              tested: Object.fromEntries(
                selected.map(({ property, entries }) => [
                  Conformance.name(property),
                  entries.length,
                ]),
              ),
              unsupported,
            },
            null,
            2,
          ),
        )

        const cases = selected.flatMap(({ entries }) => entries)
        const covered = new Set(cases.map(({ name }) => name))

        expect(
          [
            'background',
            'box-shadow',
            'clip-path',
            'color',
            'font',
            'grid',
            'mask',
            'offset',
            'transition',
          ].filter((name) => !covered.has(name)),
        ).toMatchInlineSnapshot(`[]`)

        const failures: string[] = []

        for (let start = 0; start < cases.length; start += 100) {
          const batch = cases.slice(start, start + 100)
          const source = `import { style } from 'zyzz';\n${batch.map(({ property, value }, index) => `export const p${index} = style({${JSON.stringify(property)}: ${JSON.stringify(value)}})();`).join('\n')}`
          const output = Transform.compile({
            moduleId: 'properties.ts',
            source,
          })
          const javascript = await Esbuild.transform(output.code, {
            format: 'esm',
            loader: 'ts',
          })
          const module = await import(
            `data:text/javascript;base64,${Buffer.from(javascript.code).toString('base64')}`
          )
          const classes = batch.map(
            (_, index) => module[`p${index}`].className as string,
          )

          expect(classes.length === batch.length).toMatchInlineSnapshot(`true`)

          failures.push(
            ...(await page.evaluate(
              ({ batch, classes, css }) => {
                const sheet = document.createElement('style')

                sheet.textContent = css
                document.head.append(sheet)

                const failures: string[] = []

                for (const [index, { name, value }] of batch.entries()) {
                  const actual = document.createElement('div')
                  const control = document.createElement('div')

                  actual.className = classes[index]!
                  control.style.setProperty(name, String(value))
                  document.body.append(actual, control)

                  const compiled =
                    getComputedStyle(actual).getPropertyValue(name)
                  const native =
                    getComputedStyle(control).getPropertyValue(name)

                  if (compiled !== native)
                    failures.push(`${name}: ${value}: ${compiled} != ${native}`)

                  actual.remove()
                  control.remove()
                }

                sheet.remove()

                return failures
              },
              { batch, classes, css: output.css },
            )),
          )
        }

        expect(failures).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    }, 120_000)

    test('all browser-supported shorthand relationships retain repeated overrides', async () => {
      const cases = Conformance.cases()
      const byName = new Map<string, (string | number)[]>()

      for (const { property, value } of cases) {
        const name = Conformance.name(property)
        const group = byName.get(name) ?? []

        group.push(value)
        byName.set(name, group)
      }

      // Reset-only relationships are specified independently of shorthand value grammar.
      const resets: Record<string, readonly string[]> = {
        animation: [
          'animation-range-start',
          'animation-range-end',
          'animation-timeline',
        ],
        border: ['border-image-source'],
        font: [
          'font-kerning',
          'font-feature-settings',
          'font-size-adjust',
          'font-variation-settings',
        ],
        mask: ['mask-border-source'],
        'text-decoration': ['text-decoration-thickness'],
        'view-timeline': ['view-timeline-inset'],
      }

      function children(
        name: string,
        seen = new Set<string>(),
      ): readonly string[] {
        if (seen.has(name)) return []

        seen.add(name)

        const initial = properties[name]?.initial
        const direct = [
          ...(Array.isArray(initial) ? initial : []),
          ...(resets[name] ?? []),
        ]

        return [
          ...new Set(
            direct.flatMap((child) => [child, ...children(child, seen)]),
          ),
        ]
      }

      const pairs = Object.keys(properties).flatMap((shorthand) =>
        children(shorthand).map((longhand) => ({
          shorthand,
          longhand,
          values: byName.get(longhand) ?? [],
        })),
      )

      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        const probes = await page.evaluate((pairs) => {
          const element = document.createElement('div')

          document.body.append(element)

          const output: {
            shorthand: string
            longhand: string
            value: string
          }[] = []

          for (const { shorthand, longhand, values } of pairs) {
            if (!CSS.supports(shorthand, 'initial')) continue

            for (const candidate of values) {
              const value = String(candidate)
              if (
                [
                  'inherit',
                  'initial',
                  'revert',
                  'revert-layer',
                  'unset',
                ].includes(value) ||
                !CSS.supports(longhand, value)
              )
                continue

              element.style.cssText = ''
              element.style.setProperty(longhand, value)

              const before =
                getComputedStyle(element).getPropertyValue(longhand)

              element.style.setProperty(shorthand, 'initial')

              if (
                getComputedStyle(element).getPropertyValue(longhand) !== before
              ) {
                output.push({ shorthand, longhand, value })
                break
              }
            }
          }

          element.remove()

          return output
        }, pairs)

        expect(probes.length > 100).toMatchInlineSnapshot(`true`)

        const failures: string[] = []

        for (const { shorthand, longhand, value } of probes) {
          const camel = (name: string) =>
            name.replace(/-([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            )
          const output = Transform.compile({
            moduleId: 'cascade.ts',
            source: `import { style } from 'zyzz'; export const a = style({${camel(longhand)}: ${JSON.stringify(value)}})(); export const b = style({${camel(shorthand)}: 'initial'})(); export const c = style({${camel(longhand)}: ${JSON.stringify(value)}})();`,
          })
          const javascript = await Esbuild.transform(output.code, {
            format: 'esm',
            loader: 'ts',
          })
          const module = await import(
            `data:text/javascript;base64,${Buffer.from(javascript.code).toString('base64')}`
          )
          const classes = ['a', 'b', 'c'].map(
            (name) => module[name].className as string,
          )

          expect(classes.length).toMatchInlineSnapshot(`3`)

          const result = await page.evaluate(
            ({ classes, css, longhand, shorthand, value }) => {
              const sheet = document.createElement('style')

              sheet.textContent = css
              document.head.append(sheet)

              const actual = document.createElement('div')
              const control = document.createElement('div')

              actual.className = classes.join(' ')
              control.style.setProperty(shorthand, 'initial')
              control.style.setProperty(longhand, value)
              document.body.append(actual, control)

              const equal =
                getComputedStyle(actual).getPropertyValue(longhand) ===
                getComputedStyle(control).getPropertyValue(longhand)

              actual.remove()
              control.remove()
              sheet.remove()

              return equal
            },
            { classes, css: output.css, longhand, shorthand, value },
          )

          if (!result) failures.push(`${shorthand} resets ${longhand}`)
        }

        expect(failures).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    }, 120_000)
  })
})

describe('ranges', () => {
  describe('compile', () => {
    test('timeline ranges preserve names, offsets, and list boundaries', () => {
      const lexer = Conformance.lexer()

      for (const [property, value] of Object.entries(Ranges.styles)) {
        const name = Conformance.name(property)
        const output = Transform.compile({
          moduleId: 'ranges.ts',
          source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}});`,
        })

        expect(output.css.includes(`${name}:${value}`)).toMatchInlineSnapshot(
          `true`,
        )
        expect(lexer.matchProperty(name, value).error).toMatchInlineSnapshot(
          `null`,
        )
      }
    })
    test('timeline ranges match native view-animation progress', async () => {
      const output = Transform.compile({
        moduleId: 'ranges.ts',
        source: Ranges.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>@keyframes fade{from{opacity:0}to{opacity:1}}.scroller{width:100px;height:100px;overflow:auto}.spacer{height:100px}.subject{height:100px;background:blue;animation:fade 1s linear both;animation-timeline:view()}${output.css}</style><div class="scroller"><div class="spacer"></div><div id="actual" class="subject ${module.range.className}"></div><div class="spacer"></div></div><div class="scroller"><div class="spacer"></div><div id="control" class="subject" style="animation-range-start:entry 20%;animation-range-end:exit 80%"></div><div class="spacer"></div></div>`,
        )
        await page.evaluate(async () => {
          for (const element of document.querySelectorAll('.scroller'))
            element.scrollTop = 80

          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
        })

        const actual = await page
          .locator('#actual')
          .evaluate((element) => Number(getComputedStyle(element).opacity))
        const control = await page
          .locator('#control')
          .evaluate((element) => Number(getComputedStyle(element).opacity))

        expect(actual === control).toMatchInlineSnapshot(`true`)
        expect(actual > 0 && actual < 1).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue(
                'animation-range-start',
              ),
            ),
        ).toMatchInlineSnapshot(`"entry 20%"`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue('animation-range-end'),
            ),
        ).toMatchInlineSnapshot(`"exit 80%"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('reading', () => {
  describe('compile', () => {
    test('reading order preserves numeric and keyword fallbacks', () => {
      const output = Transform.compile({
        moduleId: 'reading.ts',
        source: Reading.source,
      })

      expect(output.css.match(/reading-order:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "reading-order:0",
        "reading-order:-1!important",
      ]
    `)
      expect(
        output.css.includes(
          'reading-flow:normal;reading-flow:flex-visual!important',
        ),
      ).toMatchInlineSnapshot(`true`)
    })

    test('reading flow and ordinal groups control browser keyboard navigation', async () => {
      const output = Transform.compile({
        moduleId: 'reading.ts',
        source: Reading.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><button id="start">Start</button><div class="${module.visual.className}"><button id="v1">One</button><button id="v2">Two</button><button id="v3">Three</button></div><div style="display:flex;flex-direction:row-reverse;reading-flow:flex-visual"><button id="c1">One</button><button id="c2">Two</button><button id="c3">Three</button></div><div class="${module.ordered.className}"><button id="o1">One</button><button id="o2">Two</button><button id="o3" class="${module.first.className}">Three</button></div><div style="display:flex;reading-flow:source-order"><button id="r1">One</button><button id="r2">Two</button><button id="r3" style="reading-order:-1">Three</button></div><div style="display:flex;flex-direction:row-reverse;reading-flow:normal"><button id="n1">One</button><button id="n2">Two</button><button id="n3">Three</button></div>`,
        )
        await page.locator('#start').focus()

        const sequence: string[] = []

        for (let index = 0; index < 15; index++) {
          await page.keyboard.press('Tab')
          sequence.push(await page.evaluate(() => document.activeElement!.id))
        }

        expect(sequence).toMatchInlineSnapshot(`
        [
          "v3",
          "v2",
          "v1",
          "c3",
          "c2",
          "c1",
          "o3",
          "o1",
          "o2",
          "r3",
          "r1",
          "r2",
          "n1",
          "n2",
          "n3",
        ]
      `)
        expect(
          await page
            .locator('#o3')
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue('reading-order'),
            ),
        ).toMatchInlineSnapshot(`"-1"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('scalars', () => {
  describe('compile', () => {
    test('related scalar declarations retain A/B/A cascade order', () => {
      const a = {
        fontSynthesis: 'none',
        whiteSpace: 'normal',
        overflow: 'hidden',
        wordWrap: 'normal',
      } as const

      const output = Css.compile({
        styles: Style.define({
          a,
          b: {
            fontSynthesisWeight: 'auto',
            whiteSpaceCollapse: 'preserve',
            textWrapMode: 'nowrap',
            overflowBlock: 'scroll',
            overflowWrap: 'break-word',
          },
          c: a,
        }),
      })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_0{font-synthesis:none;}
        .z_1{white-space:normal;}
        .z_2{overflow:hidden;}
        .z_3{word-wrap:normal;}
        .z_4{font-synthesis-weight:auto;}
        .z_5{white-space-collapse:preserve;}
        .z_6{text-wrap-mode:nowrap;}
        .z_7{overflow-block:scroll;}
        .z_8{overflow-wrap:break-word;}
        .z_9{font-synthesis:none;}
        .z_a{white-space:normal;}
        .z_b{overflow:hidden;}
        .z_c{word-wrap:normal;}"
      `)
    })
    test('SVG geometry and text scalars match native browser output', async () => {
      const output = Transform.compile({
        moduleId: 'scalars.ts',
        source: Scalars.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><svg width="200" height="100"><circle id="circle" class="${module.circle.className}"/><circle id="circle-control" style="${Scalars.controls.circle}"/><rect id="rectangle" width="50" height="30" class="${module.rectangle.className}"/><rect id="rectangle-control" width="50" height="30" style="${Scalars.controls.rectangle}"/></svg><div id="text" class="${module.text.className}">a  b</div><div id="text-control" style="${Scalars.controls.text}">a  b</div>`,
        )

        expect(
          await page.evaluate(() => {
            const differences: string[] = []

            for (const [id, properties] of [
              ['circle', ['cx', 'cy', 'r']],
              ['rectangle', ['x', 'y', 'rx', 'ry']],
              [
                'text',
                [
                  'baseline-shift',
                  'text-anchor',
                  'font-variant-emoji',
                  'white-space-collapse',
                  'text-wrap-mode',
                  'word-wrap',
                  'scrollbar-gutter',
                ],
              ],
            ] as const) {
              const a = getComputedStyle(document.getElementById(id)!)
              const b = getComputedStyle(
                document.getElementById(`${id}-control`)!,
              )

              for (const property of properties)
                if (
                  a.getPropertyValue(property) !== b.getPropertyValue(property)
                )
                  differences.push(property)
            }

            return differences
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page.locator('#circle').evaluate((element) => {
            const box = (element as SVGGraphicsElement).getBBox()

            return [box.x, box.y, box.width, box.height]
          }),
        ).toMatchInlineSnapshot(`
        [
          20,
          10,
          40,
          40,
        ]
      `)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('statementAcceptance', () => {
  describe('compile', () => {
    test('retains import layer supports and media combinations with packed ordering and maps', () => {
      const library = Graph.compile({
        modules: { 'statements.ts': Statements.imports() },
      })
      const packed = Graph.compile({
        contracts: { 'lib/statements.js': library.contracts['statements.ts']! },
        imports: { 'app.ts': { lib: 'lib/statements.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })
      expect(packed.sharedCss?.match(/@import/g)?.length).toMatchInlineSnapshot(
        '24',
      )
      expect(packed.sharedCss?.startsWith('@import')).toMatchInlineSnapshot(
        'true',
      )
      expect(packed.sharedCss?.includes('supports(')).toMatchInlineSnapshot(
        'true',
      )
      expect(packed.sharedCss?.includes('layer(')).toMatchInlineSnapshot('true')
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
          line: 1,
          column: 0,
        }),
      ).toMatchInlineSnapshot(`
      {
        "column": 0,
        "line": 2,
        "name": null,
        "source": "lib/statements.ts",
      }
    `)
    })
    test('retains custom-media query productions and imported computed references', () => {
      for (const query of Statements.queries) {
        const library = Graph.compile({
          modules: {
            'statements.ts': `import {customMedia} from 'zyzz/web';\nexport const query=customMedia(${JSON.stringify(query)});`,
          },
        })
        const packed = Graph.compile({
          contracts: {
            'lib/statements.js': library.contracts['statements.ts']!,
          },
          imports: { 'app.ts': { lib: 'lib/statements.js', 'zyzz/web': null } },
          modules: {
            'app.ts': `import {query} from 'lib';import {global} from 'zyzz/web';global({[query]:{body:{color:'red'}}});`,
          },
        })
        expect(
          packed.sharedCss?.includes('@custom-media --'),
        ).toMatchInlineSnapshot('true')
        expect(packed.sharedCss?.includes('@media (--')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }),
        ).toMatchInlineSnapshot(`
        {
          "column": 19,
          "line": 2,
          "name": null,
          "source": "lib/statements.ts",
        }
      `)
      }
    })
    test('retains legacy document matching functions across packed publication with maps', () => {
      for (const matching of Statements.documents) {
        const library = Graph.compile({
          modules: {
            'statements.ts': `import {global} from 'zyzz/web';\nglobal({'@document ${matching}':{body:{color:'red'}}});`,
          },
        })
        const packed = Graph.compile({
          contracts: {
            'lib/statements.js': library.contracts['statements.ts']!,
          },
          imports: { 'app.ts': { lib: 'lib/statements.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        expect(packed.sharedCss?.includes('@document')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          packed.sharedCss?.includes('body{color:red;}'),
        ).toMatchInlineSnapshot('true')
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }),
        ).toMatchInlineSnapshot(`
        {
          "column": 0,
          "line": 2,
          "name": null,
          "source": "lib/statements.ts",
        }
      `)
      }
    })
    test('rejects malformed queries and legacy matching functions before publication', () => {
      const failures = [
        `export const query=customMedia('???');`,
        `export const query=customMedia('(color); @import "bad.css"');`,
        `global({'@document garbage()':{body:{color:'red'}}});`,
        `global({'@document domain(123)':{body:{color:'red'}}});`,
        `importCss({url:'/a.css',supports:'???'});`,
      ].map((source) => {
        try {
          Graph.compile({
            modules: {
              'invalid.ts': `import {customMedia,global,importCss} from 'zyzz/web';${source}`,
            },
          })
          return 'accepted'
        } catch (error) {
          if (!(error instanceof Source.ExtractError)) throw error
          return error.diagnostics.map((diagnostic) => diagnostic.message)
        }
      })
      expect(failures).toMatchInlineSnapshot(`
      [
        [
          "Invalid custom-media query: Mismatch
        syntax: <media-query-list>
         value: ???
        --------^",
        ],
        [
          "Invalid custom-media query: Mismatch
        syntax: <media-query-list>
         value: (color); @import "bad.css"
        ---------------^",
        ],
        [
          "Invalid document matching functions: Mismatch
        syntax: [ <url> | url-prefix( <string> ) | domain( <string> ) | media-document( <string> ) | regexp( <string> ) ]#
         value: garbage()
        --------^",
        ],
        [
          "Invalid document matching functions: Mismatch
        syntax: [ <url> | url-prefix( <string> ) | domain( <string> ) | media-document( <string> ) | regexp( <string> ) ]#
         value: domain(123)
        ---------------^",
        ],
        [
          "Unexpected token Delim('?')",
        ],
      ]
    `)
    })
  })
})

describe('statements', () => {
  describe('compile', () => {
    test('rejects fractional CSS integer parameters', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'integer.ts',
          source: `import {style} from 'zyzz';import {cssFunction} from 'zyzz/web';const fn=cssFunction({parameters:[{name:'--n',syntax:'<integer>'}],body:{result:1}});export const card=style({zIndex:fn(1.5)});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: integer.ts:181: CSS integer parameters require integer tokens.]`,
      )
    })
    test('rejects custom media as a declaration value', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'query.ts',
          source: `import {style} from 'zyzz';import {customMedia} from 'zyzz/web';const query=customMedia('(width>1px)');export const card=style({color:query});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: query.ts:134: Named stylesheet reference is incompatible with this property.]`,
      )
    })
    test('rejects a context on a custom media statement', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'query.ts',
          source: `import {customMedia} from 'zyzz/web';export const query=customMedia('(width>1px)',{within:['@layer queries']});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: query.ts:56: Unknown contribution context option. Use nested at-rule keys for enclosing groups.]`,
      )
    })
    test('rejects conflicting packed customMedia identities', () => {
      const helper = 'customMedia'
      const expression = `customMedia('(width>1px)')`
      const library = Graph.compile({
        modules: {
          'library.ts': `import {${helper}} from 'zyzz/web';export const rule=${expression};`,
        },
      })
      const first = JSON.parse(library.contracts['library.ts']!)
      const second = JSON.parse(library.contracts['library.ts']!)
      second.stylesheets[0].key = 'other'
      second.stylesheets[0].css = second.stylesheets[0].css
        .replace('1px', '2px')
        .replace('result:1', 'result:2')
      expect(() =>
        Graph.compile({
          contracts: {
            'first.js': JSON.stringify(first),
            'second.js': JSON.stringify(second),
          },
          imports: { 'app.ts': { first: 'first.js', second: 'second.js' } },
          modules: { 'app.ts': `import 'first';import 'second'` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: second.js:0: Conflicting stylesheet identity: --z-custommedia-rule; supply distinct declaration ids.]`,
      )
    })
    test('rejects conflicting packed cssFunction identities', () => {
      const helper = 'cssFunction'
      const expression = `cssFunction({parameters:[],body:{result:1}})`
      const library = Graph.compile({
        modules: {
          'library.ts': `import {${helper}} from 'zyzz/web';export const rule=${expression};`,
        },
      })
      const first = JSON.parse(library.contracts['library.ts']!)
      const second = JSON.parse(library.contracts['library.ts']!)
      second.stylesheets[0].key = 'other'
      second.stylesheets[0].css = second.stylesheets[0].css
        .replace('1px', '2px')
        .replace('result:1', 'result:2')
      expect(() =>
        Graph.compile({
          contracts: {
            'first.js': JSON.stringify(first),
            'second.js': JSON.stringify(second),
          },
          imports: { 'app.ts': { first: 'first.js', second: 'second.js' } },
          modules: { 'app.ts': `import 'first';import 'second'` },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: second.js:0: Conflicting stylesheet identity: --z-cssfunction-rule; supply distinct declaration ids.]`,
      )
    })
    test('prunes unused named statements and emits JavaScript function formatters', async () => {
      const output = Transform.compile({
        moduleId: 'functions.js',
        source: `import {style} from 'zyzz';import {cssFunction,customMedia} from 'zyzz/web';const unused=customMedia(false);const dead=cssFunction({parameters:[],body:{result:1}});const twice=cssFunction({parameters:[{name:'--x',syntax:'<number>'}],returns:'<number>',body:{result:'calc(var(--x)*2)'}});export namespace styles {
  export const box = style({opacity:twice(+1)})
}`,
      })
      expect(
        (await Esbuild.transform(output.code, { loader: 'ts' })).warnings,
      ).toMatchInlineSnapshot('[]')
      expect(output.css).toMatchInlineSnapshot(`
        "@function --z-cssfunction-twice(--x <number>) returns <number>{result:calc(var(--x)*2);}
        .z_ttf1Y30{opacity:--z-cssfunction-twice(1);}"
      `)
    })
    test('rejects unsupported CSS function arguments without emitting a bare identity', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {style} from 'zyzz';import {cssFunction} from 'zyzz/web';const amount=2;const twice=cssFunction({parameters:[{name:'--x',syntax:'<number>'}],body:{result:2}});export namespace styles {
  export const box = style({opacity:twice(amount)})
}`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:228: Expected a literal string or number; expressions are not evaluated.]`,
      )
    })
    test('hoists conditioned imports before namespace and ordinary rules', () => {
      const output = Graph.compile({
        modules: {
          'statements.ts': `import {global,importCss,namespace} from 'zyzz/web';global({'s|circle':{fill:'red'}});namespace({prefix:'s',uri:'http://www.w3.org/2000/svg'});importCss({url:'./base.css',layer:'base',supports:'display: grid',media:'screen'});`,
        },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(`
      "@import "zyzz-asset:base.css" layer(base) supports(display: grid) screen;
      @namespace z-n17dmz821ctten8-2e "http://www.w3.org/2000/svg";
      z-n17dmz821ctten8-2e|circle {
        fill: red;
      }"
    `)
      expect(Object.values(output.sharedAssets ?? {})).toMatchInlineSnapshot(`
      [
        "base.css",
      ]
    `)
    })
    test('preserves anonymous import layers while relocating assets', () => {
      const output = Graph.compile({
        modules: {
          'app.ts': `import {importCss} from 'zyzz/web';importCss({url:'./a.css',layer:true});importCss({url:'./b.css'});`,
        },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(`
      "@import "zyzz-asset:a.css" layer;
      @import "zyzz-asset:b.css";"
    `)
    })
    test('retains computed custom-media keys across packed imports', () => {
      const library = Graph.compile({
        modules: {
          'query.ts': `import {customMedia} from 'zyzz/web';export const compact=customMedia('(width < 40rem)');`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib/query.js': library.contracts['query.ts']! },
        imports: { 'app.ts': { lib: 'lib/query.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'zyzz';import {compact} from 'lib';export namespace styles {
  export const box = style({[compact]:{color:'red'}})
}`,
        },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(
        `"@custom-media --z-custommedia-compact (width < 40rem);"`,
      )
      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(
        `"@media (--z-custommedia-compact){.z_Zf5JrJ0{color:red;}}"`,
      )
    })
    test('emits native functions and callable fixed expressions', async () => {
      const output = Transform.compile({
        moduleId: 'function.ts',
        source: `import {cssFunction} from 'zyzz/web';export const twice=cssFunction({parameters:[{name:'--amount',syntax:'<length>',default:'1px'}],returns:'<length>',body:{result:'calc(var(--amount) * 2)','@media (width > 40rem)':{result:'calc(var(--amount) * 3)'}}});`,
      })
      expect(output.css).toMatchInlineSnapshot(
        `"@function --z-cssfunction-twice(--amount <length>: 1px) returns <length>{result:calc(var(--amount) * 2);@media (width > 40rem){result:calc(var(--amount) * 3);}}"`,
      )
      const code = (
        await Esbuild.transform(output.code, { loader: 'ts', format: 'esm' })
      ).code
      const compiled = await import(
        'data:text/javascript,' + encodeURIComponent(code)
      )
      expect(compiled.twice('2px')).toMatchInlineSnapshot(
        `"--z-cssfunction-twice(2px)"`,
      )
    })
    test('isolates reused and default namespace prefixes across modules and packed output', () => {
      const library = Graph.compile({
        modules: {
          'svg.ts': `import {namespace,global} from 'zyzz/web';namespace({uri:'http://www.w3.org/2000/svg'});global({'.icon':{fill:'red'}});`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib/svg.js': library.contracts['svg.ts']! },
        imports: { 'app.ts': { lib: 'lib/svg.js', 'zyzz/web': null } },
        modules: {
          'app.ts': `import 'lib';import {namespace,global} from 'zyzz/web';namespace({prefix:'s',uri:'urn:application'});global({'s|item':{color:'blue'},'.icon':{color:'green'}});`,
        },
      })
      expect(output.sharedCss).toMatchInlineSnapshot(`
      "@namespace z-n1eqhovc1o4c8ak-16 "http://www.w3.org/2000/svg";
      @namespace z-n1e8a67z1uaws1j-1j "urn:application";
      z-n1eqhovc1o4c8ak-16|*.icon {
        fill: red;
      }
      z-n1e8a67z1uaws1j-1j|item {
        color: #00f;
      }
      .icon {
        color: green;
      }"
    `)
    })
    test('uses imported native function calls as declaration values', () => {
      const library = Graph.compile({
        modules: {
          'function.ts': `import {cssFunction} from 'zyzz/web';export const twice=cssFunction({parameters:[{name:'--amount',syntax:'<length>'}],returns:'<length>',body:{result:'calc(var(--amount) * 2)'}});`,
        },
      })
      const output = Graph.compile({
        contracts: { 'lib/function.js': library.contracts['function.ts']! },
        imports: { 'app.ts': { lib: 'lib/function.js', zyzz: null } },
        modules: {
          'app.ts': `import {style} from 'zyzz';import {twice} from 'lib';export namespace styles {
  export const box = style({width:twice('2px')})
}`,
        },
      })
      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(
        `".z_Zf5JrJ0{width:--z-cssfunction-twice(2px);}"`,
      )
    })
    test('rejects malformed function parameter data', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'bad.ts',
          source: `import {cssFunction} from 'zyzz/web';export const fn=cssFunction({parameters:[{name:'--x'},{name:'--x'}],body:{result:1}});`,
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: bad.ts:53: Expected unique CSS parameters with supported syntaxes and scalar defaults.]`,
      )
    })
  })
})

describe('substitution', () => {
  describe('compile', () => {
    test('variable expressions compile for every mapped property and parse independently', () => {
      for (const property of Conformance.properties()) {
        const output = Transform.compile({
          moduleId: 'variable.ts',
          source: `import { style } from 'zyzz'; style({${JSON.stringify(property)}:'var(--probe)'});`,
        })

        expect(
          output.css.includes(`${Conformance.name(property)}:var(--probe)`),
        ).toMatchInlineSnapshot(`true`)

        const functions: string[] = []

        CssTree.walk(
          CssTree.parse(output.css, { parseCustomProperty: true }),
          (node) => {
            if (node.type === 'Function') functions.push(node.name)
          },
        )

        expect(functions).toMatchInlineSnapshot(`
        [
          "var",
        ]
      `)
      }

      for (const value of [
        'var(--name,)',
        'var(--name, var(--fallback, 1px))',
        'calc(1px + var(--gap))',
        'rgb(var(--channels) / .5)',
      ]) {
        const output = Transform.compile({
          moduleId: 'variable.ts',
          source: `import { style } from 'zyzz'; style({width:${JSON.stringify(value)}});`,
        })

        // Property grammar is intentionally deferred until the browser substitutes references.
        expect(output.css.includes(value)).toMatchInlineSnapshot(`true`)
      }
    })
    test('variables preserve inheritance, cycles, empty fallback, and computed-time invalidity', async () => {
      const output = Transform.compile({
        moduleId: 'variables.ts',
        source: Substitution.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div id="parent" style="width:400px;--width:200px;--gap:20px;--fallback:blue;--pad:6px 8px"><div id="actual" class="${module.box.className}" style="color:red"></div><div id="control" style="${Substitution.control}"></div><div id="empty" class="${module.empty.className}"></div></div>`,
        )

        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"180px"`)
        expect(
          await page
            .locator('#empty')
            .evaluate((element) => getComputedStyle(element).paddingTop),
        ).toMatchInlineSnapshot(`"0px"`)

        for (const phase of ['initial', 'override', 'cycle', 'invalid']) {
          await page.evaluate((phase) => {
            const style = document.getElementById('parent')!.style

            if (phase === 'override') {
              style.setProperty('--ink', 'green')
              style.setProperty('--width', '300px')
            }

            if (phase === 'cycle') {
              style.setProperty('--ink', 'var(--loop)')
              style.setProperty('--loop', 'var(--ink)')
            }

            if (phase === 'invalid') style.setProperty('--width', 'nonsense')
          }, phase)

          expect(
            await page.evaluate(() => {
              const a = getComputedStyle(document.getElementById('actual')!)
              const b = getComputedStyle(document.getElementById('control')!)

              return [
                'color',
                'width',
                'padding-top',
                'padding-right',
                'opacity',
                'display',
              ].filter(
                (key) => a.getPropertyValue(key) !== b.getPropertyValue(key),
              )
            }),
          ).toMatchInlineSnapshot(`[]`)
        }

        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).color),
        ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)

        const properties = Conformance.properties().map(Conformance.name)

        expect(
          await page.evaluate(
            (properties) =>
              properties.filter(
                (property) =>
                  CSS.supports(property, 'initial') !==
                  CSS.supports(property, 'var(--probe)'),
              ),
            properties,
          ),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('svg', () => {
  describe('compile', () => {
    test('SVG paint preserves tokens, fallbacks, importance, and source maps', () => {
      const output = Transform.compile({
        moduleId: 'svg.ts',
        source: Svg.source,
      })

      expect(output.css.match(/fill-rule:[^;}]+/g)).toMatchInlineSnapshot(`
      [
        "fill-rule:nonzero",
        "fill-rule:evenodd!important",
      ]
    `)
      expect(/--z-color-ink,#06c\)/.test(output.css)).toMatchInlineSnapshot(
        `true`,
      )

      const lines = output.css.split('\n')
      const line = lines.findIndex((line) =>
        line.includes('fill-rule:evenodd!important'),
      )

      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.cssMap), {
          line: line + 1,
          column: lines[line]!.indexOf('fill-rule:evenodd!important'),
        }),
      ).toMatchInlineSnapshot(`
        {
          "column": 80,
          "line": 3,
          "name": "fillRule",
          "source": "svg.ts",
        }
      `)
    })

    test('SVG paint matches browser declarations and evenodd geometry', async () => {
      const output = Transform.compile({
        moduleId: 'svg.ts',
        source: Svg.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        const path = 'M0 0H100V100H0Z M25 25H75V75H25Z'

        await page.setContent(
          `<style>${output.css}</style><svg width="300" height="120"><path id="actual" d="${path}" class="${module.paint.className}"/><path id="control" d="${path}" style="${Svg.controls.paint}" transform="translate(120 0)"/><filter><feFlood id="flood" class="${module.filter.className}"/><feFlood id="flood-control" style="${Svg.controls.filter}"/></filter></svg>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return [
              'fill',
              'fill-opacity',
              'fill-rule',
              'stroke',
              'stroke-width',
              'stroke-opacity',
              'stroke-linecap',
              'stroke-linejoin',
              'stroke-miterlimit',
              'stroke-dashoffset',
              'clip-rule',
              'paint-order',
              'shape-rendering',
              'text-rendering',
              'vector-effect',
            ].filter(
              (property) =>
                actual.getPropertyValue(property) !==
                control.getPropertyValue(property),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) =>
              (element as SVGGeometryElement).isPointInFill(
                new DOMPoint(50, 50),
              ),
            ),
        ).toMatchInlineSnapshot(`false`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) =>
              (element as SVGGeometryElement).isPointInFill(
                new DOMPoint(10, 10),
              ),
            ),
        ).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#actual')
            .evaluate((element) => getComputedStyle(element).fill),
        ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)
        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('flood')!)
            const control = getComputedStyle(
              document.getElementById('flood-control')!,
            )

            return [
              'flood-color',
              'flood-opacity',
              'lighting-color',
              'color-interpolation-filters',
            ].filter(
              (property) =>
                actual.getPropertyValue(property) !==
                control.getPropertyValue(property),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('targets', () => {
  describe('compile', () => {
    test('reviews Chromium rule and descriptor retention against independent native controls', async () => {
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        const page = await browser.newPage()
        const report: Record<string, readonly string[]> = {}

        for (const [name, fixture] of Object.entries(Targets.rules)) {
          const library = Graph.compile({
            modules: { 'rules.ts': fixture.source },
          })
          const packed = Graph.compile({
            contracts: { 'rules.js': library.contracts['rules.ts']! },
            imports: { 'app.ts': { rules: 'rules.js' } },
            modules: { 'app.ts': `import 'rules';` },
          })
          const outputs = [
            fixture.css,
            library.sharedCss ?? '',
            packed.sharedCss ?? '',
          ]
          const retained: string[][] = []

          for (const css of outputs) {
            retained.push(
              await page.evaluate(
                ({ css, name }) => {
                  const element = document.createElement('style')
                  element.textContent = css
                  document.head.append(element)

                  try {
                    const visit = (rules: CSSRuleList): string[] => {
                      for (const rule of rules) {
                        if (
                          rule.cssText.startsWith(`${name} `) ||
                          rule.cssText.startsWith(`${name}{`) ||
                          rule.cssText.startsWith(`${name} {`)
                        ) {
                          const descriptors = [
                            ...rule.cssText.matchAll(
                              /(?<=[;{}])\s*(@?[a-z][a-z-]*)\s*[:{]/g,
                            ),
                          ]
                            .map((match) => match[1]!)
                            .filter(
                              (value) =>
                                value !== 'body' && !value.startsWith('alias'),
                            )

                          return [...new Set([name, ...descriptors])].sort()
                        }

                        if ('cssRules' in rule) {
                          const nested = visit(
                            (rule as CSSGroupingRule).cssRules,
                          )
                          if (nested.length) return nested
                        }
                      }

                      return []
                    }

                    return visit(element.sheet!.cssRules)
                  } finally {
                    element.remove()
                  }
                },
                { css, name },
              ),
            )
          }

          expect(
            JSON.stringify(retained[1]) === JSON.stringify(retained[0]),
          ).toMatchInlineSnapshot('true')
          expect(
            JSON.stringify(retained[2]) === JSON.stringify(retained[0]),
          ).toMatchInlineSnapshot('true')
          report[name] = retained[0]!
        }

        expect(report).toMatchInlineSnapshot(`
        {
          "@container": [
            "@container",
            "color",
          ],
          "@counter-style": [
            "@counter-style",
            "additive-symbols",
            "fallback",
            "negative",
            "pad",
            "prefix",
            "range",
            "speak-as",
            "suffix",
            "symbols",
            "system",
          ],
          "@custom-media": [],
          "@document": [],
          "@font-face": [
            "@font-face",
            "ascent-override",
            "descent-override",
            "font-display",
            "font-family",
            "font-feature-settings",
            "font-stretch",
            "font-style",
            "font-variation-settings",
            "font-weight",
            "line-gap-override",
            "size-adjust",
            "src",
            "unicode-range",
          ],
          "@font-feature-values": [
            "@character-variant",
            "@font-feature-values",
            "@ornaments",
            "@styleset",
            "@stylistic",
            "@swash",
          ],
          "@font-palette-values": [
            "@font-palette-values",
            "base-palette",
            "font-family",
            "override-colors",
          ],
          "@function": [
            "@function",
            "result",
          ],
          "@import": [
            "@import",
          ],
          "@keyframes": [
            "@keyframes",
            "opacity",
          ],
          "@layer": [
            "@layer",
            "color",
          ],
          "@media": [
            "@media",
            "color",
          ],
          "@page": [
            "@page",
            "page-orientation",
            "size",
          ],
          "@position-try": [
            "@position-try",
            "margin",
            "position-area",
          ],
          "@property": [
            "@property",
            "inherits",
            "initial-value",
            "syntax",
          ],
          "@scope": [
            "@scope",
            "color",
          ],
          "@starting-style": [
            "@starting-style",
            "opacity",
          ],
          "@supports": [
            "@supports",
            "color",
          ],
        }
      `)

        await Fs.mkdir('test-results', { recursive: true })
        await Fs.writeFile(
          'test-results/at-rule-target-retention.json',
          JSON.stringify(
            {
              browser: browser.version(),
              evidence:
                'CSSOM retention only; this report does not establish complete rendering.',
              rules: report,
            },
            null,
            2,
          ),
        )
      } finally {
        await browser.close()
      }
    }, 30_000)
  })
})

describe('templates', () => {
  describe('compile', () => {
    test('folds negative bigint substitutions without losing precision', () => {
      const output = Transform.compile({
        moduleId: 'bigint.ts',
        source:
          'import { style } from "zyzz"; style({ marginLeft: `${-12n}px`, "--large": `${-9007199254740993n}`, "--zero": `${-0n}` })',
      })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_6aJ_Bj0{margin-left:-12px;}
        .z_6aJ_Bj1{--large:-9007199254740993;}
        .z_6aJ_Bj2{--zero:0;}"
      `,
      )
    })

    test('bounds nested template extraction', () => {
      const nested = (count: number) =>
        '`'.concat('${`'.repeat(count), '8', '`}'.repeat(count), '`')

      expect(
        Transform.compile({
          moduleId: 'depth.ts',
          source:
            'import { style } from "zyzz"; style({ "--value": ' +
            nested(127) +
            ' })',
        }).css,
      ).toMatchInlineSnapshot(`".z_5phr510{--value:8;}"`)
      expect(() =>
        Transform.compile({
          moduleId: 'depth.ts',
          source:
            'import { style } from "zyzz"; style({ "--value": ' +
            nested(128) +
            ' })',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: depth.ts:49: Expected a literal string or number; expressions are not evaluated.]`,
      )
    })

    test('folds primitive templates with the same CSS as ordinary strings', async () => {
      const output = Transform.compile({
        moduleId: 'templates.ts',
        source: Templates.source,
      })

      expect(output.css).toMatchInlineSnapshot(
        `
        ".z_caKKsf0{color:red;}
        .z_caKKsf1{content:"true:null:12";}
        .z_caKKsf2{margin-left:-2px;}
        .z_caKKsf3{padding:4px;padding:8px!important;}
        .z_caKKsf4{width:calc(100% - 16px);}"
      `,
      )

      const literal = Transform.compile({
        moduleId: 'templates.ts',
        source: `import { style } from 'zyzz'; export const box = style({ color: 'red', content: '"true:null:12"', marginLeft: '-2px', padding: ['4px', '8px !important'], width: 'calc(100% - 16px)' })()`,
      })

      expect(output.css === literal.css).toMatchInlineSnapshot(`true`)
      expect(output.code.includes('${')).toMatchInlineSnapshot(`false`)

      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )

      expect(module.box).toMatchInlineSnapshot(`
        {
          "className": "z_caKKsf0 z_caKKsf1 z_caKKsf2 z_caKKsf3 z_caKKsf4",
        }
      `)
      expect(
        Trace.originalPositionFor(new Trace.TraceMap(output.map), {
          line: 2,
          column: 0,
        }).source,
      ).toMatchInlineSnapshot(`"templates.ts"`)
    })

    test('preserves cooked escapes, empty text, and bound token resolution', () => {
      const source = [
        "import { Vars } from 'zyzz'",
        "const theme = Vars.define({ color: { brand: '#06c' } })",
        'export const box = themeConfig.style({ color: `br${"and"}`, content: `"\\u0041"`, "--empty": `` })()',
      ].join('\n')

      expect(
        Transform.compile({ moduleId: 'theme.ts', source }).css,
      ).toMatchInlineSnapshot(`""`)
    })

    test('reports exact diagnostics for unsupported template expressions', () => {
      const diagnostics = [
        'unknown',
        '(()=>{throw Error("executed")})()',
        '({toString(){throw Error("executed")}})',
        '[]',
        '/x/',
        '1e999',
        '+12n',
        'String.raw`x`',
        '1 + 2',
      ].map((expression) => {
        const source =
          'import { style } from "zyzz"; style({ width: `${' +
          expression +
          '}px` })'

        try {
          Transform.compile({ moduleId: 'invalid.ts', source })
          throw new Error('Expected extraction failure')
        } catch (error) {
          if (!(error instanceof Source.ExtractError)) throw error

          return error.diagnostics
        }
      })

      expect(diagnostics).toMatchInlineSnapshot(`
        [
          [
            {
              "code": "unsupported_syntax",
              "end": 59,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 85,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 85,
              "message": "Static data requires literal property keys without methods.",
              "source": "invalid.ts",
              "start": 50,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 54,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 55,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 57,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 56,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 65,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
          [
            {
              "code": "unsupported_syntax",
              "end": 57,
              "message": "Expected a literal string or number; expressions are not evaluated.",
              "source": "invalid.ts",
              "start": 45,
            },
          ],
        ]
      `)
    })

    test('matches native CSS for template fallbacks, math, and importance', async () => {
      const output = Transform.compile({
        moduleId: 'templates.ts',
        source: Templates.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div style="width:400px"><div id="actual" class="${module.box.className}" style="padding:1px"></div><div id="control" style="color:red;content:'true:null:12';margin-left:-2px;padding:8px!important;width:calc(100% - 16px)"></div></div>`,
        )

        expect(
          await page.evaluate(() => {
            const actual = getComputedStyle(document.getElementById('actual')!)
            const control = getComputedStyle(
              document.getElementById('control')!,
            )

            return [
              'color',
              'content',
              'margin-left',
              'padding',
              'width',
            ].filter(
              (property) =>
                actual.getPropertyValue(property) !==
                control.getPropertyValue(property),
            )
          }),
        ).toMatchInlineSnapshot(`[]`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('textTimeline', () => {
  describe('compile', () => {
    test('text and flex shorthands preserve A/B/A overrides and page aliases', () => {
      const a = {
        flexFlow: 'row nowrap',
        textWrap: 'wrap balance',
        pageBreakBefore: 'avoid',
      } as const

      const output = Css.compile({
        styles: Style.define({
          a,
          b: {
            flexDirection: 'column',
            textWrapStyle: 'pretty',
            breakBefore: 'page',
          },
          c: a,
        }),
      })

      expect(output.css).toMatchInlineSnapshot(`
        ".z_0{flex-flow:row nowrap;}
        .z_1{text-wrap:wrap balance;}
        .z_2{page-break-before:avoid;}
        .z_3{flex-direction:column;}
        .z_4{text-wrap-style:pretty;}
        .z_5{break-before:page;}
        .z_6{flex-flow:row nowrap;}
        .z_7{text-wrap:wrap balance;}
        .z_8{page-break-before:avoid;}"
      `)
    })
    test('text and flex values match native browser controls', async () => {
      const output = Transform.compile({
        moduleId: 'text-timeline.ts',
        source: TextTimeline.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        const a = {
          flexFlow: 'row nowrap',
          textWrap: 'wrap balance',
          pageBreakBefore: 'avoid',
        } as const

        const cascade = Css.compile({
          styles: Style.define({
            a,
            b: {
              flexDirection: 'column',
              textWrapStyle: 'pretty',
              breakBefore: 'page',
            },
            c: a,
          }),
        })

        await page.setContent(
          `<style>${output.css}${cascade.css}</style><div id="cascade" class="${cascade.classes.a} ${cascade.classes.b} ${cascade.classes.c} z-a"></div><div id="flow" class="${module.flow.className}"><span>one</span><span>two</span></div><div id="flow-control" style="${TextTimeline.controls.flow}"><span>one</span><span>two</span></div><span id="text" class="${module.text.className}">text</span><span id="text-control" style="${TextTimeline.controls.text}">text</span>`,
        )

        expect(
          await page.evaluate(() => {
            const differences: string[] = []

            for (const [id, properties] of [
              [
                'flow',
                [
                  'flex-direction',
                  'flex-wrap',
                  'text-wrap-mode',
                  'text-wrap-style',
                ],
              ],
              [
                'text',
                [
                  'text-underline-position',
                  'vertical-align',
                  'border-image-repeat',
                  'view-timeline-axis',
                  'interest-delay-start',
                ],
              ],
            ] as const) {
              const a = getComputedStyle(document.getElementById(id)!)
              const b = getComputedStyle(
                document.getElementById(`${id}-control`)!,
              )

              for (const property of properties)
                if (
                  a.getPropertyValue(property) !== b.getPropertyValue(property)
                )
                  differences.push(property)
            }

            return differences
          }),
        ).toMatchInlineSnapshot(`[]`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).flexDirection),
        ).toMatchInlineSnapshot(`"row"`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).textWrapStyle),
        ).toMatchInlineSnapshot(`"balance"`)
        expect(
          await page
            .locator('#cascade')
            .evaluate((element) => getComputedStyle(element).breakBefore),
        ).toMatchInlineSnapshot(`"avoid"`)
        expect(
          await page
            .locator('#flow')
            .evaluate((element) => getComputedStyle(element).flexDirection),
        ).toMatchInlineSnapshot(`"row"`)
        expect(
          await page
            .locator('#flow')
            .evaluate((element) => getComputedStyle(element).flexWrap),
        ).toMatchInlineSnapshot(`"wrap"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('tuples', () => {
  describe('compile', () => {
    test('scalar tuples preserve units, markers, and shorthand overrides', () => {
      const lexer = Conformance.lexer()

      for (const declarations of Object.values(Tuples.styles)) {
        for (const [property, value] of Object.entries(declarations)) {
          const name = Conformance.name(property)
          const output = Transform.compile({
            moduleId: 'tuples.ts',
            source: `import { style } from 'zyzz'; style({${property}:${JSON.stringify(value)}});`,
          })

          expect(output.css.includes(`${name}:${value}`)).toMatchInlineSnapshot(
            `true`,
          )
          expect(
            lexer.matchProperty(name, String(value)).error,
          ).toMatchInlineSnapshot(`null`)
        }
      }

      const output = Transform.compile({
        moduleId: 'tuples.ts',
        source: Tuples.source,
      })

      expect(
        output.css.match(/contain-intrinsic-size:80px 40px;/g)?.length,
      ).toMatchInlineSnapshot(`2`)
      expect(
        output.css.match(/interest-delay:100ms 200ms;/g)?.length,
      ).toMatchInlineSnapshot(`2`)
    })
    test('border-image tuples match native painting and scrollbar colors', async () => {
      const output = Transform.compile({
        moduleId: 'tuples.ts',
        source: Tuples.source,
      })
      const js = await Esbuild.build({
        stdin: { contents: output.code, loader: 'ts', resolveDir: root },
        bundle: true,
        conditions: ['src'],
        format: 'esm',
        write: false,
      }).then((result) => ({ code: result.outputFiles[0]!.text }))
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.code).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>.frame{display:inline-block;vertical-align:top;width:160px;height:160px;background:white}.box{width:60px;height:60px;margin:30px;border:10px solid transparent;border-image-source:linear-gradient(90deg,red,blue)}${output.css}</style><div id="actual" class="frame"><div class="box ${module.border.className}"></div></div><div id="control" class="frame"><div class="box" style="${Tuples.control}"></div></div><div id="intrinsic" class="${module.intrinsic.className}"></div><div id="intrinsic-control" style="contain:size;contain-intrinsic-size:auto 80px auto 40px;display:inline-block"></div><div id="text" class="${module.text.className}"></div>`,
        )

        const size = await page
          .locator('#intrinsic')
          .evaluate((element) => [
            element.getBoundingClientRect().width,
            element.getBoundingClientRect().height,
          ])

        expect(size).toMatchInlineSnapshot(`
        [
          80,
          40,
        ]
      `)
        expect(
          await page
            .locator('#intrinsic-control')
            .evaluate((element) => [
              element.getBoundingClientRect().width,
              element.getBoundingClientRect().height,
            ]),
        ).toMatchInlineSnapshot(`
        [
          80,
          40,
        ]
      `)

        const computed = await page
          .locator('#actual .box')
          .evaluate((element) => {
            const style = getComputedStyle(element)

            return [
              style.borderImageSource,
              style.borderImageSlice,
              style.borderImageWidth,
              style.borderImageOutset,
              style.borderImageRepeat,
            ]
          })

        const native = await page
          .locator('#control .box')
          .evaluate((element) => {
            const style = getComputedStyle(element)

            return [
              style.borderImageSource,
              style.borderImageSlice,
              style.borderImageWidth,
              style.borderImageOutset,
              style.borderImageRepeat,
            ]
          })

        expect(
          JSON.stringify(computed) === JSON.stringify(native),
        ).toMatchInlineSnapshot(`true`)

        // Paint both controls at the same device coordinates to avoid gradient dithering differences.
        await page.addStyleTag({
          content:
            '#actual,#control{position:absolute;left:0;top:0}#control{visibility:hidden}',
        })

        const actual = await page.locator('#actual').screenshot()

        await page.addStyleTag({
          content: '#actual{visibility:hidden}#control{visibility:visible}',
        })

        const control = await page.locator('#control').screenshot()

        expect(actual.equals(control)).toMatchInlineSnapshot(`true`)
        expect(
          await page
            .locator('#actual .box')
            .evaluate((element) => getComputedStyle(element).borderImageSlice),
        ).toMatchInlineSnapshot(`"25% fill"`)
        expect(
          await page
            .locator('#actual .box')
            .evaluate((element) => getComputedStyle(element).borderImageOutset),
        ).toMatchInlineSnapshot(`"2px 4px 6px 8px"`)
        expect(
          await page
            .locator('#text')
            .evaluate((element) => getComputedStyle(element).scrollbarColor),
        ).toMatchInlineSnapshot(`"rgb(255, 0, 0) rgb(0, 0, 255)"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('variables', () => {
  describe('compile', () => {
    test('removes consumed variable imports and retains runtime references', () => {
      const source = `import {variable} from 'zyzz'; export const vars = ({size:variable("length")});`

      expect(
        Transform.compile({ moduleId: 'vars.ts', source }).code,
      ).not.toContain('from "zyzz"')
      expect(
        Transform.compile({
          moduleId: 'error.ts',
          source: source + 'export const gap = vars.size',
        }).code,
      ).toContain('export const gap = vars.size')
      expect(() =>
        Transform.compile({
          moduleId: 'signed.ts',
          source: `import { style, variable } from 'zyzz'; const vars = ({size:variable("signedLength")}); style({ lineHeight: vars.size })`,
        }),
      ).toThrow('Variable domain is incompatible')
    })
    test('retains type-only generic references to variable', () => {
      const output = Transform.compile({
        moduleId: 'generic.ts',
        source: `import {variable} from 'zyzz'; const v=({gap:variable("length")}); function identity<T>(v:T){return v}; export const typed=identity<{gap: variable.Reference<'length'>}>(v)`,
      })

      expect(output.code).toMatchInlineSnapshot(
        `
        "
        import { Variable as __zyzzVariable } from 'zyzz/runtime';
        import {variable} from 'zyzz'; const v=({gap:__zyzzVariable.create({"name":"--z-v-gap","type":"length","variable":true})}); function identity<T>(v:T){return v}; export const typed=identity<{gap: variable.Reference<'length'>}>(v)"
      `,
      )
    })
    test('rejects namespace variable authoring', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'namespace.ts',
          source:
            'import * as zyzz from "zyzz"; export const v=zyzz.variable("length")',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: namespace.ts:45: Import variable by name; namespace authoring calls are not supported yet.]`,
      )
    })

    test('rejects theme variables in root style', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'root.ts',
          source:
            'import {style,Vars} from "zyzz"; const theme=Vars.define({spacing:{md:"8px"}}); style({width:theme.spacing.md})',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: root.ts:93: Token references must be direct property values in bound theme style calls.]`,
      )
    })
    test('renders theme colors in gradients, shadows, and variable assignments', async () => {
      const output = Transform.compile({
        moduleId: 'color-expressions.ts',
        source: [
          'import { Config, Vars, variable } from "zyzz";',
          'const theme = Vars.define({ color: { surface: { light: "red", dark: "blue" } } });const themeConfig=Config.create({vars:theme});',
          'const foreground = variable("color");',
          'export const box = themeConfig.style({ vars: { [foreground]: theme.color.surface }, color: foreground, backgroundImage: `linear-gradient(${theme.color.surface}, transparent)`, boxShadow: `0 0 2px ${theme.color.surface}` })();',
        ].join('\n'),
      })
      const js = await Esbuild.build({
        stdin: {
          contents: output.code,
          loader: 'ts',
          resolveDir: Path.resolve(import.meta.dirname, '../..'),
        },
        bundle: true,
        write: false,
        conditions: ['src'],
        format: 'esm',
      })
      const module = await import(
        `data:text/javascript;base64,${Buffer.from(js.outputFiles[0]!.text).toString('base64')}`
      )
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${output.css}</style><div id="actual" class="${module.box.className}"></div>`,
        )

        const computed = []
        for (const scheme of ['light', 'dark']) {
          await page.evaluate((scheme) => {
            document.documentElement.style.colorScheme = scheme
          }, scheme)
          computed.push(
            await page.locator('#actual').evaluate((element) => {
              const style = getComputedStyle(element)
              return [style.color, style.backgroundImage, style.boxShadow]
            }),
          )
        }
        expect(computed).toMatchInlineSnapshot(`
          [
            [
              "rgb(255, 0, 0)",
              "linear-gradient(rgb(255, 0, 0), rgba(0, 0, 0, 0))",
              "rgb(255, 0, 0) 0px 0px 2px 0px",
            ],
            [
              "rgb(0, 0, 255)",
              "linear-gradient(rgb(0, 0, 255), rgba(0, 0, 0, 0))",
              "rgb(0, 0, 255) 0px 0px 2px 0px",
            ],
          ]
        `)
      } finally {
        await browser.close()
      }
    })

    test('compiles custom shadow templates with theme colors', () => {
      expect(
        Transform.compile({
          moduleId: 'shadow.ts',
          source:
            'import { Config, Vars } from "zyzz"; const theme = Vars.define({ color: { brand: "red" }, shadow: { soft: "0 1px 2px red" } }); const themeConfig = Config.create({ vars: theme }); export const box = themeConfig.style({ boxShadow: `0 0 2px ${theme.color.brand} !custom` })();',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-color-brand:red;}
        .z_xDWieG0{box-shadow:0 0 2px var(--z-color-brand,red);}"
      `)
    })

    test('compiles independent color variables inside gradients', () => {
      expect(
        Transform.compile({
          moduleId: 'gradient.ts',
          source:
            'import { style, variable } from "zyzz"; const color = variable("color"); export const box = style({ vars: { [color]: "red" }, backgroundImage: `linear-gradient(${color}, transparent)` })();',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z_jv0DKG0{--z-color:red;}
        .z_jv0DKG1{background-image:linear-gradient(var(--z-color), transparent);}"
      `)
    })

    test.each([
      'width: `${theme.color.brand}`',
      'backgroundImage: `${theme.color.brand}`',
      'backgroundImage: `url(${theme.color.brand})`',
    ])('rejects incompatible color expressions: %s', (declaration) => {
      try {
        Transform.compile({
          moduleId: 'invalid-color.ts',
          source:
            'import {Config} from \'zyzz\';\nimport { Vars } from "zyzz"; const theme = Vars.define({color:{brand:"red"}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({' +
            declaration +
            '})',
        })
        throw new Error('Expected an incompatible color diagnostic')
      } catch (error) {
        if (!(error instanceof Source.ExtractError)) throw error
        expect(error.diagnostics.map((diagnostic) => diagnostic.message))
          .toMatchInlineSnapshot(`
            [
              "Theme variable domain is incompatible with this property.",
            ]
          `)
      }
    })

    test('strips importance across nested template segments', () => {
      expect(
        Transform.compile({
          moduleId: 'nested.ts',
          source:
            'import {Config} from \'zyzz\';\nimport {Vars} from "zyzz"; const theme=Vars.define({spacing:{md:"8px"}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({width:`${`calc(${theme.spacing.md}) !custom !important`}`})',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-spacing-md:8px;}
        .z_6y9KKx0{width:calc(var(--z-spacing-md,8px))!important;}"
      `)
    })
    test('preserves assertions around nested variable templates and fallbacks', () => {
      expect(
        Transform.compile({
          moduleId: 'assertions.ts',
          source:
            'import {Config} from \'zyzz\';\nimport { style, Vars } from "zyzz"; const theme=Vars.define({spacing:{md:"8px"}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({width:[\'1px !custom\', (`calc(${(`${theme.spacing.md}` satisfies string)}) !custom` as string)]})',
        }).css,
      ).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-spacing-md:8px;}
        .z_viRWul0{width:1px;width:calc(var(--z-spacing-md,8px));}"
      `)
    })
    test('rejects spacing variables in integer properties', () => {
      expect(() =>
        Transform.compile({
          moduleId: 'domains.ts',
          source:
            'import {Config} from \'zyzz\';\nimport { style, Vars } from "zyzz"; const theme=Vars.define({spacing:{md:"8px"}}); const themeConfig=Config.create({vars:theme}); themeConfig.style({maxLines:theme.spacing.md})',
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: domains.ts:187: Theme variable domain is incompatible with this property.]`,
      )
    })

    test('retains live references in bound declarations and important templates', () => {
      const source = [
        'import { Config, style, Vars } from "zyzz";',
        'const theme = Vars.define({spacing:{md:"8px"},color:{brand:"red",unused:"blue"}});const themeConfig=Config.create({vars:theme});',
        'export const box = themeConfig.style({width:`calc(100% - ${theme.spacing.md}) !custom !important`, color:theme.color.brand})()',
      ].join('\n')

      expect(Transform.compile({ moduleId: 'vars.ts', source }).css)
        .toMatchInlineSnapshot(`
          ".z-theme-theme{--z-spacing-md:8px;--z-color-brand:red;}
          .z_ECnQlq0{width:calc(100% - var(--z-spacing-md,8px))!important;}
          .z_ECnQlq1{color:var(--z-color-brand,red);}"
        `)
    })

    test('links imported variables and compatible scopes without copying declaration values', () => {
      const result = Graph.compile({
        modules: {
          'theme.ts':
            'import { Vars } from "zyzz"; export const theme = Vars.define({ spacing: { md: "8px" }, color: { brand: { light: "red", dark: "blue" } } }); export const alt = Vars.extend(theme, { spacing: { md: "16px" } });',
          'app.ts':
            'import {Config} from \'zyzz\';const paletteConfig=Config.create({vars:palette});import { style } from "zyzz"; import { theme as palette, alt } from "./theme.js"; export const box = paletteConfig.style({ width: `calc(100% - ${palette.spacing.md}) !custom`, color: palette.color.brand })(); const altConfig=Config.create({vars:alt});export const scope=altConfig.vars().className;',
        },
      })

      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-spacing-md:8px;--z-color-brand:light-dark(red,blue);}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_Zf5JrJ0{width:calc(100% - var(--z-spacing-md,8px));}
        .z_Zf5JrJ1{color:var(--z-color-brand,light-dark(red,blue));}"
      `)
      expect(result.modules['theme.ts']!.css).toMatchInlineSnapshot(`
        ".z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}"
      `)
    })

    test('compiles named configuration variables from packed contracts', () => {
      const library = Graph.compile({
        modules: {
          'config.ts':
            'import { Config } from "zyzz"; export const zyzz = Config.create({ vars: { spacing: { md: "8px" } } });',
        },
      })

      const output = Graph.compile({
        contracts: { 'library/index.js': library.contracts['config.ts']! },
        imports: {
          'app.ts': { '@acme/theme': 'library/index.js', zyzz: null },
        },
        modules: {
          'app.ts':
            'import { style } from "zyzz"; import { zyzz } from "@acme/theme"; export const box = zyzz.style({width:`calc(100% - ${zyzz.vars.spacing.md}) !custom`})()',
        },
      })

      expect(output.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-spacing-md:8px;}
        .z_Zf5JrJ0{width:calc(100% - var(--z-spacing-md,8px));}"
      `)
      expect(
        output.modules['app.ts']!.code.includes('.vars'),
      ).toMatchInlineSnapshot(`false`)
    })

    test.each([
      [
        'escaped reads',
        'export const value = String(theme.spacing.md)',
        'Token references must be direct',
      ],
      [
        'wrong domains',
        'themeConfig.style({ color: `${theme.spacing.md}` })',
        'incompatible',
      ],
      [
        'unknown paths',
        'themeConfig.style({ width: `${theme.spacing.missing}` })',
        'Unknown theme token path',
      ],
    ])('rejects %s', (_name, source, message) => {
      try {
        Transform.compile({
          moduleId: 'invalid.ts',
          source:
            'import { Config, style, Vars } from "zyzz"; const theme = Vars.define({spacing:{md:"8px"}});const themeConfig=Config.create({vars:theme});' +
            source.replaceAll('theme.style', 'themeConfig.style'),
        })
        throw new Error('Expected source failure')
      } catch (error) {
        if (!(error instanceof Source.ExtractError)) throw error

        expect(error.message.includes(message!)).toMatchInlineSnapshot(`true`)
      }
    })

    test('inherits variable overrides in native CSS', async () => {
      const output = Transform.compile({
        moduleId: 'browser.ts',
        source: `import {Config, Vars} from 'zyzz';
const base=Vars.define({spacing:{md:'8px'}});
const alt=Vars.extend(base,{spacing:{md:'16px'}});
const {style,vars}=Config.create({vars:{base,alt},defaultVars:'base'});
export const box=style({width:\`calc(100% - \${vars.spacing.md}) !custom\`})();
export const scope=vars({set:'alt'}).className;`,
      })

      const className = Object.values(output.classes)[0]!
      const scope = output.css.match(/\.([^{}]+)\{[^{}]*:16px;/)![1]!
      const browser = await chromium.launch()

      try {
        const page = await browser.newPage()

        await page.setContent(
          `<style>${output.css}</style><div style="width:100px"><div id="box" class="${className}"></div></div>`,
        )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"92px"`)

        await page
          .locator('#box')
          .evaluate(
            (element, scope) => element.parentElement!.classList.add(scope),
            scope,
          )

        expect(
          await page
            .locator('#box')
            .evaluate((element) => getComputedStyle(element).width),
        ).toMatchInlineSnapshot(`"84px"`)
      } finally {
        await browser.close()
      }
    })
  })
})

describe('viewTransition.browser', () => {
  describe('compile', () => {
    test('captures navigation, activates declared types, and obeys conditional opt-out', async () => {
      const library = Graph.compile({
        modules: {
          'transitions.ts': `import {viewTransition} from 'zyzz/web';
viewTransition({navigation:'auto',types:'slide forward'});
viewTransition({ '@media (width < 500px)': {navigation:'none'} });`,
        },
      })
      const packed = Graph.compile({
        contracts: { 'lib.js': library.contracts['transitions.ts']! },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: { 'app.ts': `import 'lib';` },
      })
      const server = Http.createServer((request, response) => {
        const native = request.url?.startsWith('/native')
        const css = native
          ? '@view-transition{navigation:auto;types:slide forward}@media(width < 500px){@view-transition{navigation:none}}'
          : packed.sharedCss!
        response.setHeader('Content-Type', 'text/html')
        response.end(`<!doctype html><style>${css}
::view-transition-group(root){animation-duration:1s}
</style><script>
addEventListener('pagereveal', event => {
  const transition = event.viewTransition;
  if (!transition) {
    document.documentElement.dataset.capture = 'none';
    return;
  }
  transition.ready.then(() => {
    document.documentElement.dataset.capture = JSON.stringify({
      active: document.documentElement.matches(':active-view-transition'),
      forward: document.documentElement.matches(':active-view-transition-type(forward)'),
      image: getComputedStyle(document.documentElement, '::view-transition-new(root)').animationName !== 'none',
      types: [...transition.types].sort(),
    });
  }, error => { document.documentElement.dataset.capture = error.name; });
});
</script><a href="${native ? '/native' : '/compiled'}/next">Next</a><p>${request.url?.endsWith('/next') ? 'New page' : 'Old page'}</p>`)
      })
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      const browser = await chromium.launch(
        executablePath ? { executablePath } : {},
      )
      try {
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        )
        const address = server.address()
        if (!address || typeof address === 'string')
          throw new Error('Expected a TCP listener.')

        for (const width of [800, 400]) {
          for (const route of ['compiled', 'native']) {
            const page = await browser.newPage({
              viewport: { height: 600, width },
            })
            try {
              await page.goto(`http://127.0.0.1:${address.port}/${route}`)
              await page.locator('a').click()
              await page.waitForURL(`**/${route}/next`)
              await page.waitForFunction(
                () => document.documentElement.dataset.capture !== undefined,
              )
              const capture = await page.evaluate(
                () => document.documentElement.dataset.capture,
              )

              if (width === 800)
                expect(JSON.parse(capture!)).toMatchInlineSnapshot(`
                {
                  "active": true,
                  "forward": true,
                  "image": true,
                  "types": [
                    "forward",
                    "slide",
                  ],
                }
              `)
              else expect(capture).toMatchInlineSnapshot('"none"')
            } finally {
              await page.close()
            }
          }
        }
      } finally {
        await browser.close()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    })
  })
})

describe('viewTransition', () => {
  describe('compile', () => {
    test('rejects invalid packed transition descriptors before parser recovery', () => {
      const library = Graph.compile({
        modules: {
          'transition.ts': `import {viewTransition} from 'zyzz/web';viewTransition({navigation:'auto',types:'slide'});`,
        },
      })
      {
        const contract = JSON.parse(library.contracts['transition.ts']!)
        contract.stylesheets[0].css = '@view-transition{types:slide,forwards}'
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': JSON.stringify(contract) },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib.js:0: Invalid library contract: Invalid view-transition descriptor.]`,
        )
      }
      {
        const contract = JSON.parse(library.contracts['transition.ts']!)
        contract.stylesheets[0].css = '@view-transition{types:none slide}'
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': JSON.stringify(contract) },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib.js:0: Invalid library contract: Invalid view-transition types.]`,
        )
      }
      {
        const contract = JSON.parse(library.contracts['transition.ts']!)
        contract.stylesheets[0].css = '@view-transition{navigation:always}'
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': JSON.stringify(contract) },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib.js:0: Invalid library contract: Invalid view-transition navigation.]`,
        )
      }
      {
        const contract = JSON.parse(library.contracts['transition.ts']!)
        contract.stylesheets[0].css = '@view-transition{unknown:auto}'
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': JSON.stringify(contract) },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib.js:0: Invalid library contract: Unknown view-transition descriptor.]`,
        )
      }
      {
        const contract = JSON.parse(library.contracts['transition.ts']!)
        contract.stylesheets[0].css =
          '@view-transition invalid{navigation:auto}'
        expect(() =>
          Graph.compile({
            contracts: { 'lib.js': JSON.stringify(contract) },
            imports: { 'app.ts': { lib: 'lib.js' } },
            modules: { 'app.ts': `import 'lib';` },
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: lib.js:0: Invalid library contract: View-transition rules require a descriptor block and no prelude.]`,
        )
      }
    })
    test('validates transition identifiers and preserves conditional packed descriptors', () => {
      for (const types of [
        'none',
        'NONE',
        'slide forwards',
        '\\73 lide 图',
        'slide/**/forwards',
        'slide slide',
      ]) {
        const source = `import {viewTransition} from 'zyzz/web';\nviewTransition({'@layer transitions':{'@media (width > 1px)':{'@supports (color: red)':{'@container (width > 1px)':{navigation:${JSON.stringify('\\61 uto')},types:${JSON.stringify(types)}}}}}});`
        const direct = Transform.compile({ moduleId: 'transition.ts', source })
        const library = Graph.compile({ modules: { 'transition.ts': source } })
        const packed = Graph.compile({
          contracts: {
            'lib/transition.js': library.contracts['transition.ts']!,
          },
          imports: { 'app.ts': { lib: 'lib/transition.js' } },
          modules: { 'app.ts': `import 'lib';` },
        })
        expect(direct.css.includes('types:')).toMatchInlineSnapshot('true')
        expect(packed.sharedCss?.includes('types:')).toMatchInlineSnapshot(
          'true',
        )
        expect(
          Trace.originalPositionFor(new Trace.TraceMap(packed.sharedCssMap!), {
            line: 1,
            column: 0,
          }),
        ).toMatchInlineSnapshot(`
        {
          "column": 0,
          "line": 2,
          "name": null,
          "source": "lib/transition.ts",
        }
      `)
      }
    })

    test('rejects malformed transition types and forbidden enclosing contexts', () => {
      for (const types of [
        '',
        'none slide',
        'slide NONE',
        'inherit',
        'initial',
        'unset',
        'revert',
        'revert-layer',
        'default',
        'slide,forwards',
        '"slide"',
        '1slide',
        'slide;navigation:none',
        '\\6e one slide',
      ]) {
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {viewTransition} from 'zyzz/web';viewTransition({types:${JSON.stringify(types)}});`,
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: invalid.ts:40: Expected none or a list of view-transition custom identifiers.]`,
        )
      }
      for (const within of [
        'body',
        '@page',
        '@font-face',
        '@starting-style',
        '@keyframes fade',
      ]) {
        expect(() =>
          Transform.compile({
            moduleId: 'invalid.ts',
            source: `import {viewTransition} from 'zyzz/web';viewTransition({${JSON.stringify(within)}:{navigation:'auto'}});`,
          }),
        ).toThrowErrorMatchingInlineSnapshot(
          `[Source.ExtractError: invalid.ts:40: Expected navigation or types view-transition descriptors.]`,
        )
      }
    })
  })
})
