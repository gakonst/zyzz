/**
 * Exercises configuration normalization through style validation and CSS emission.
 * @module
 */
import * as Path from 'node:path'
import * as Packed from '../test/fixtures/Packed.js'
import { Graph } from 'zyzz/compiler'
import { Config as PublicConfig, defineConfig } from 'zyzz'
import * as Ts from 'typescript-api'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Style } from 'zyzz'
import * as Theme from './internal/Theme.js'
import * as Config from './internal/Configuration.js'
import { Css } from 'zyzz/web'

describe('create', () => {
  test('enforces tokens and custom suffixes through source and packed configs', async () => {
    const config = `import {Config} from 'zyzz'; export const {style,variants,vars}=Config.create({vars:{color:{brand:'#123456',red:'blue'},spacing:{md:'8px'}}});`
    const library = Graph.compile({ modules: { 'config.ts': config } })
    for (const packed of [false, true]) {
      function compile(body: string) {
        return Graph.compile({
          ...(packed
            ? { contracts: { 'config.ts': library.contracts['config.ts']! } }
            : {}),
          imports: {
            'app.ts': { './config': 'config.ts' },
            'config.ts': { zyzz: null },
          },
          modules: {
            ...(!packed ? { 'config.ts': config } : {}),
            'app.ts': `import {style,variants,vars} from './config'; ${body}`,
          },
        })
      }
      const result =
        compile(`export const card=style({color:'red',padding:['md','7px !custom'],display:'flex',width:'calc(100% - 2rem) !custom',':hover':{color:'#123456 !custom'}});
export const button=variants({base:{padding:'md'},variants:{tone:{brand:{color:'red !custom !important'}}}});
export const dynamic=style((values:{padding:'7px'})=>({padding:\`\${values.padding} !custom\`}));`)
      expect(
        result.modules['app.ts']!.css.split('\n')
          .filter(
            (line) =>
              /^\.z[-_]/.test(line) &&
              !line.startsWith('.z-theme-') &&
              !line.startsWith('.z_scheme-'),
          )
          .join('\n'),
      ).toMatchInlineSnapshot(`
        ".z_Zf5JrJ0{color:var(--z-color-red,blue);}
        .z_Zf5JrJ1{padding:var(--z-spacing-md,8px);padding:7px;}
        .z_Zf5JrJ2{display:flex;}
        .z_Zf5JrJ3{width:calc(100% - 2rem);}
        .z_Zf5JrJ4{&:hover{color:#123456;}}
        .z_Zf5JrJ5{padding:var(--z-spacing-md,8px);}
        .z_Zf5JrJ6{&:where([data-tone="brand"]){color:red!important;}}
        .z_Zf5JrJ7{padding:var(--z-Zf5JrJ-dynamic-padding);}"
      `)
      expect(
        [
          `style({padding:'7px'})`,
          `style({padding:['md','7px']})`,
          `style({':hover':{color:'green'}})`,
          `variants({variants:{tone:{brand:{color:'green'}}}})`,
          `style({padding:{custom:'7px'}})`,
        ].map((body) => {
          try {
            compile(`export const invalid=${body}`)
            return 'accepted'
          } catch (error) {
            return (error as Error).message
          }
        }),
      ).toMatchInlineSnapshot(`
        [
          "app.ts:82: Expected a configured token or a CSS value with the " !custom" suffix.",
          "app.ts:82: Expected a configured token or a CSS value with the " !custom" suffix.",
          "app.ts:90: Expected a configured token or a CSS value with the " !custom" suffix.",
          "app.ts:106: Expected a configured token or a CSS value with the " !custom" suffix.",
          "app.ts:82: Expected a literal string or number; expressions are not evaluated.",
        ]
      `)
      const bundle = await Packed.bundle({
        entry: 'app.ts',
        modules: {
          'app.ts': result.modules['app.ts']!.code,
          'config.ts': (result.modules['config.ts'] ??
            library.modules['config.ts'])!.code,
        },
      })
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        await page.setContent(
          `<style>${result.modules['app.ts']!.css}</style><div id="card">card</div><div id="dynamic">dynamic</div>`,
        )
        await page.addScriptTag({
          type: 'module',
          content: `${bundle};document.querySelector('#card').className=Fixture.card().className;const props=Fixture.dynamic({padding:'7px'});const element=document.querySelector('#dynamic');element.className=props.className;for(const [name,value] of Object.entries(props.style))element.style.setProperty(name,value);`,
        })
        expect(
          await page.locator('#card').evaluate((e) => ({
            color: getComputedStyle(e).color,
            padding: getComputedStyle(e).padding,
          })),
        ).toMatchInlineSnapshot(`
          {
            "color": "rgb(0, 0, 255)",
            "padding": "7px",
          }
        `)
        expect(
          await page
            .locator('#dynamic')
            .evaluate((e) => getComputedStyle(e).padding),
        ).toMatchInlineSnapshot(`"7px"`)
      } finally {
        await browser.close()
      }
    }
  })

  test('ignores incompatible token leaves and CSS comment brackets', () => {
    const result = Graph.compile({
      modules: {
        'app.ts': `import {Config} from 'zyzz';
const unmapped=Config.create({vars:{color:{gap:'8px'}}});
const mapped=Config.create({vars:{space:{gap:'8px'}},mappings:{space:['color']}});
const configured=Config.create({vars:{spacing:{md:'8px'}}});
export const first=unmapped.style({color:'red'});
export const second=mapped.style({color:'blue'});
export const third=configured.style({width:'calc(1px /* ] */ + 2px) !custom'});`,
      },
    })
    expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z_Zf5JrJ0{color:red;}
      .z_Zf5JrJ1{color:blue;}
      .z_Zf5JrJ2{width:calc(1px /* ] */ + 2px);}"
    `)
    expect(() =>
      Graph.compile({
        modules: {
          'app.ts': `import {Config} from 'zyzz'; const {style}=Config.create({vars:{spacing:{md:'8px'}}});export const invalid=style((values:{padding:'md'})=>({padding:values.padding}));`,
        },
      }),
    ).toThrow(
      'Expected a configured token or a CSS value with the " !custom" suffix.',
    )
  })

  test('strips custom suffixes while preserving grid lines and quoted brackets', () => {
    const result = Graph.compile({
      modules: {
        'app.ts': `import {style} from 'zyzz'; export const box=style({opacity:'0.5 !custom',content:'"[label]" !custom',gridTemplateColumns:'[start] 1fr [end] !custom',width:'7px !custom !important'});`,
      },
    })
    expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z_Zf5JrJ0{opacity:0.5;}
      .z_Zf5JrJ1{content:"[label]";}
      .z_Zf5JrJ2{grid-template-columns:[start] 1fr [end];}
      .z_Zf5JrJ3{width:7px!important;}"
    `)
  })

  test('rejects malformed custom markers without consuming quoted text', () => {
    const invalid = [
      '7px!custom',
      '7px !CUSTOM',
      '7px !custom !custom',
      '7px !important !custom',
      ' !custom',
      '[7px]',
    ]
    expect(
      invalid.map((value) => {
        try {
          Graph.compile({
            modules: {
              'app.ts': `import {Config} from 'zyzz'; const {style}=Config.create({vars:{spacing:{md:'8px'}}}); export const box=style({padding:${JSON.stringify(value)}});`,
            },
          })
          return 'accepted'
        } catch (error) {
          return (error as Error).message
        }
      }),
    ).toMatchInlineSnapshot(`
      [
        "app.ts:119: Value markers require " !custom" followed by optional " !important", or " !important" alone.",
        "app.ts:119: Value markers require " !custom" followed by optional " !important", or " !important" alone.",
        "app.ts:119: Value markers require " !custom" followed by optional " !important", or " !important" alone.",
        "app.ts:119: Value markers require " !custom" followed by optional " !important", or " !important" alone.",
        "app.ts:119: Value markers require " !custom" followed by optional " !important", or " !important" alone.",
        "app.ts:119: Expected a configured token or a CSS value with the " !custom" suffix.",
      ]
    `)
    const result = Graph.compile({
      modules: {
        'app.ts': `import {style} from 'zyzz'; export const box=style({content:'"!custom"',width:'7px !custom !important'});`,
      },
    })
    expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z_Zf5JrJ0{content:"!custom";}
      .z_Zf5JrJ1{width:7px!important;}"
    `)
  })

  test('accepts either spelling when configured values are absent', () => {
    const sources = [
      `Config.create()`,
      `Config.create({vars:{}})`,
      `Config.create({vars:{spacing:{md:'8px'}}})`,
    ]
    expect(
      sources.map(
        (config) =>
          Graph.compile({
            modules: {
              'app.ts': `import {Config} from 'zyzz';const {style}=${config};export const label=style({color:['red','blue !custom']});`,
            },
          }).modules['app.ts']!.css,
      ),
    ).toMatchInlineSnapshot(`
      [
        ".z_Zf5JrJ0{color:red;color:blue;}",
        ".z_Zf5JrJ0{color:red;color:blue;}",
        ".z_Zf5JrJ0{color:red;color:blue;}",
      ]
    `)
    const { style } = PublicConfig.create({
      id: 'config',
      vars: { spacing: { md: '8px' } },
    })
    expect(() =>
      style({ padding: '7px' } as never, { id: 'invalid' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Style.InvalidError: ["style","padding"]: Expected a configured token or a CSS value with the " !custom" suffix.]`,
    )
    expect(style({ padding: '7px !custom' }, { id: 'custom' })())
      .toMatchInlineSnapshot(`
        {
          "className": "z-style-id-config-custom",
        }
      `)
    expect(() =>
      PublicConfig.create({ strict: true } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Unknown configuration option: strict]`,
    )
  })

  test('resolves fractional numeric variable keys', () => {
    const { style, vars } = PublicConfig.create({
      id: 'fractional',
      vars: { spacing: { 0: '0px', 0.5: '2px', 2.5: '10px' } },
    })

    expect(vars.spacing[0.5].path).toMatchInlineSnapshot(`"spacing.0.5"`)
    expect(vars.spacing['2.5'].value).toMatchInlineSnapshot(`"10px"`)
    expect(style({ gap: 0.5, padding: '2.5' }, { id: 'fractional' })())
      .toMatchInlineSnapshot(`
      {
        "className": "z-style-id-fractional-fractional",
      }
    `)
  })

  test('rejects dotted variable categories, typography keys, and colliding paths', () => {
    expect(() =>
      PublicConfig.create({ vars: { 'spacing.x': '2px' } } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing.x"]: Variable categories and typography keys cannot contain dots.]`,
    )
    expect(() =>
      PublicConfig.create({
        vars: {
          typography: { 'copy.5': { fontSize: '12px' } },
        },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["typography","copy.5"]: Variable categories and typography keys cannot contain dots.]`,
    )
    expect(() =>
      PublicConfig.create({
        vars: { spacing: { '0.5': '2px', 0: { 5: '4px' } } },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Vars.InvalidError: ["spacing","0.5"]: Variable paths must join to distinct names.]`,
    )
    expect(() =>
      PublicConfig.create({
        id: 'dotted-weight',
        vars: { fontWeight: { 'medium.5': '500' } },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Font weight token fontWeight.medium.5 must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )
  })

  test.each(['atomic', 'grouped'] as const)(
    'applies default layers to %s styles and recipes through source and packed configs',
    async (cssOutput) => {
      const config = `import { Config } from 'zyzz';
export const { style, variants } = Config.create({
  cssOutput: '${cssOutput}',
  defaultLayer: 'components',
  layers: ['components', 'overrides'],
});
export const themed = Config.create({ defaultLayer: 'components', vars: {color: {brand: 'red'}} });`
      const source = `import { style, variants, themed } from './config';
export const button = variants({
  base: { color: 'red', padding: '4px', ':hover': { color: 'orange' } },
  variants: { size: { large: { padding: '16px' } } },
  compoundVariants: [{ when: {size: 'large'}, style: { borderRadius: '8px' } }],
});
export const explicit = style({
  color: 'red',
  '@media (min-width: 1px)': { '@layer overrides': { color: 'blue' } },
});
export const dynamic = style((values: { width: '20px' }) => ({ width: values.width }));
export const plain = style({ color: 'red', ':hover': { color: 'orange' } });
export const anonymous = style({ color: 'red', '@layer': { color: 'purple' } });
export const token = themed.style({ color: 'brand' });
export const props = { anonymous: anonymous(), token: token(), button: button({size:'large'}), explicit: explicit(), dynamic: dynamic({width:'20px'}), plain: plain() };`
      const library = Graph.compile({ modules: { 'config.ts': config } })
      expect(
        JSON.parse(library.contracts['config.ts']!).version,
      ).toMatchInlineSnapshot(`31`)

      const browser = await chromium.launch()
      try {
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
              'app.ts': source,
            },
          })
          const bundle = await Packed.bundle({
            entry: 'app.ts',
            modules: {
              'app.ts': result.modules['app.ts']!.code,
              'config.ts': (result.modules['config.ts'] ??
                library.modules['config.ts'])!.code,
            },
          })
          const page = await browser.newPage()
          await page.setContent(`<style>${result.sharedCss ?? ''}${Object.values(
            result.modules,
          )
            .map((module) => module.css)
            .join('')}</style>
<style>.caller { color: green; }</style><div id="button"></div><div id="explicit"></div><div id="dynamic"></div><div id="plain"></div><div id="anonymous"></div><div id="token"></div>`)
          await page.addScriptTag({
            type: 'module',
            content: `${bundle}; for (const [id, props] of Object.entries(Fixture.props)) { const e=document.getElementById(id); e.textContent=id; e.className=props.className; for (const [key,value] of Object.entries(props.style ?? {})) e.style.setProperty(key,value); for (const [key,value] of Object.entries(props)) if (key.startsWith("data-")) e.setAttribute(key,value); }`,
          })
          await expect
            .poll(() =>
              page
                .locator('#button')
                .evaluate((e) => getComputedStyle(e).paddingTop),
            )
            .toBe('16px')
          expect(
            await page
              .locator('#button')
              .evaluate((e) => getComputedStyle(e).paddingTop),
          ).toMatchInlineSnapshot(`"16px"`)
          expect(
            await page
              .locator('#button')
              .evaluate((e) => getComputedStyle(e).borderRadius),
          ).toMatchInlineSnapshot(`"8px"`)
          expect(
            await page
              .locator('#explicit')
              .evaluate((e) => getComputedStyle(e).color),
          ).toMatchInlineSnapshot(`"rgb(0, 0, 255)"`)
          expect(
            await page
              .locator('#dynamic')
              .evaluate((e) => getComputedStyle(e).width),
          ).toMatchInlineSnapshot(`"20px"`)
          expect(
            await page
              .locator('#anonymous')
              .evaluate((e) => getComputedStyle(e).color),
          ).toMatchInlineSnapshot(`"rgb(128, 0, 128)"`)
          expect(
            await page
              .locator('#token')
              .evaluate((e) => getComputedStyle(e).color),
          ).toMatchInlineSnapshot(`"rgb(255, 0, 0)"`)
          await page
            .locator('#token')
            .evaluate((e) => e.classList.add('caller'))
          expect(
            await page
              .locator('#token')
              .evaluate((e) => getComputedStyle(e).color),
          ).toMatchInlineSnapshot(`"rgb(0, 128, 0)"`)
          await page
            .locator('#plain')
            .evaluate((e) => e.classList.add('caller'))
          await page.locator('#plain').hover()
          expect(
            await page
              .locator('#plain')
              .evaluate((e) => getComputedStyle(e).color),
          ).toMatchInlineSnapshot(`"rgb(0, 128, 0)"`)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    },
  )

  test('rejects packed default layer mismatches and unsupported schema versions', () => {
    const library = Graph.compile({
      modules: {
        'config.ts': `import {Config} from 'zyzz';export const {style}=Config.create({defaultLayer:'components'});`,
      },
    })
    const read = (contract: unknown) =>
      Graph.compile({
        contracts: { 'config.ts': JSON.stringify(contract) },
        imports: {
          'app.ts': { './config': 'config.ts' },
          'config.ts': { zyzz: null },
        },
        modules: {
          'app.ts': `import {style} from './config';export const button=style({color:'red'});`,
        },
      })
    const mismatched = JSON.parse(library.contracts['config.ts']!)
    mismatched.exports.style.options.defaultLayer = 'overrides'
    expect(() => read(mismatched)).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:0: Invalid library contract: Configuration default layer disagrees with linked theme metadata.]`,
    )

    const outdated = JSON.parse(library.contracts['config.ts']!)
    outdated.version = 26
    expect(() => read(outdated)).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:0: Invalid library contract: Default layers require contract version 27 or later.]`,
    )
  })

  test.each(['', 'bad name', 'initial', 'a.inherit'])(
    'rejects invalid default layer %s',
    (defaultLayer) => {
      expect(() =>
        PublicConfig.create({ defaultLayer } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Config.InvalidError: Layer names must be plain CSS identifiers, optionally dotted.]`,
      )
      expect(() =>
        Graph.compile({
          modules: {
            'config.ts': `import {Config} from 'zyzz';export const config=Config.create({defaultLayer:${JSON.stringify(defaultLayer)}});`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: config.ts:48: Layer names must be plain CSS identifiers, optionally dotted.]`,
      )
    },
  )

  test.each([false, null])(
    'rejects non-string default layer %s',
    (defaultLayer) => {
      expect(() =>
        PublicConfig.create({ defaultLayer } as never),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Config.InvalidError: defaultLayer must be a CSS layer name.]`,
      )
    },
  )

  test('rejects non-string default layers during extraction', () => {
    expect(() =>
      Graph.compile({
        modules: {
          'config.ts': `import {Config} from 'zyzz';export const config=Config.create({defaultLayer:false});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:48: defaultLayer must be a CSS layer name.]`,
    )
    expect(() =>
      Graph.compile({
        modules: {
          'config.ts': `import {Config} from 'zyzz';export const config=Config.create({defaultLayer:null});`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:48: defaultLayer must be a CSS layer name.]`,
    )
  })

  test('retains duplicate layer validation', () => {
    expect(() =>
      PublicConfig.create({ defaultLayer: 'base', layers: ['base', 'base'] }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Duplicate layer: base]`,
    )
    expect(() =>
      PublicConfig.create({ defaultLayer: 'components.buttons' }),
    ).not.toThrow()
  })

  test('suggests configured CSS values and theme tokens with property diagnostics', () => {
    const root = Path.resolve(import.meta.dirname, '..')
    const file = Path.join(root, '.fixture-config-editor.ts')
    let source = `import { Config } from 'zyzz'
import { tokens } from 'zyzz/default'
const { style } = Config.create({ vars: tokens })
const pane = style({ alignItems: 'center', fontFamily: 'sans', typography: 'copy.18' })
const dynamic = style((values: { width: \`\${number}px\` }) => ({
  width: \`\${values.width} !custom\`,
  alignItems: 'center',
}))
dynamic({ width: '12px' })
// A rejected declaration leaves this application without diagnostics.
pane()
`
    let version = 0
    const snapshots = new Map<string, Ts.IScriptSnapshot>()
    const options: Ts.CompilerOptions = {
      module: Ts.ModuleKind.ESNext,
      moduleResolution: Ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      paths: { zyzz: [Path.join(root, 'src/index.ts')] },
      skipLibCheck: true,
      strict: true,
      target: Ts.ScriptTarget.ESNext,
      types: [],
    }
    const service = Ts.createLanguageService({
      fileExists: (path) => path === file || Ts.sys.fileExists(path),
      getCompilationSettings: () => options,
      getCurrentDirectory: () => root,
      getDefaultLibFileName: Ts.getDefaultLibFilePath,
      getProjectVersion: () => String(version),
      getScriptFileNames: () => [file],
      getScriptSnapshot: (path) => {
        if (path === file) return Ts.ScriptSnapshot.fromString(source)

        const cached = snapshots.get(path)
        if (cached) return cached

        const text = Ts.sys.readFile(path)
        if (text === undefined) return undefined

        const snapshot = Ts.ScriptSnapshot.fromString(text)
        snapshots.set(path, snapshot)
        return snapshot
      },
      getScriptVersion: (path) => (path === file ? String(version) : '0'),
      readDirectory: Ts.sys.readDirectory,
      readFile: (path) => (path === file ? source : Ts.sys.readFile(path)),
    })

    function complete(property: string, original: string, value: string) {
      const previous = source
      source = source.replace(
        `${property}: '${original}'`,
        `${property}: '${value}'`,
      )
      version++
      try {
        const position =
          source.indexOf(`${property}: '${value}'`) +
          `${property}: '`.length +
          value.length
        return service
          .getCompletionsAtPosition(file, position, {})
          ?.entries.map((entry) => entry.name)
      } finally {
        source = previous
        version++
      }
    }

    function diagnose(before: string, after: string) {
      const previous = source
      source = source.replace(before, after)
      version++
      try {
        return service.getSemanticDiagnostics(file).map((diagnostic) => ({
          code: diagnostic.code,
          message: Ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            '\n',
          ),
          span: source.slice(
            diagnostic.start!,
            diagnostic.start! + diagnostic.length!,
          ),
        }))
      } finally {
        source = previous
        version++
      }
    }

    try {
      expect(
        service
          .getSemanticDiagnostics(file)
          .map((diagnostic) =>
            Ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
          ),
      ).toMatchInlineSnapshot(`[]`)
      expect(complete('typography', 'copy.18', '')).toMatchInlineSnapshot(`
        [
          "button.12",
          "button.14",
          "button.16",
          "copy.14",
          "copy.16",
          "copy.13",
          "copy.18",
          "copy.20",
          "copy.24",
          "copy.14.strong",
          "copy.16.strong",
          "copy.13.mono",
          "copy.18.strong",
          "copy.20.strong",
          "copy.24.strong",
          "heading.14",
          "heading.16",
          "heading.20",
          "heading.24",
          "heading.32",
          "heading.40",
          "heading.48",
          "heading.56",
          "heading.64",
          "heading.72",
          "heading.16.subtle",
          "heading.20.subtle",
          "heading.24.subtle",
          "heading.32.subtle",
          "label.12",
          "label.14",
          "label.16",
          "label.13",
          "label.18",
          "label.20",
          "label.14.strong",
          "label.16.strong",
          "label.13.mono",
          "label.12.mono",
          "label.12.strong",
          "label.14.mono",
          "label.13.strong",
        ]
      `)
      expect(complete('typography', 'copy.18', 'copy.')).toMatchInlineSnapshot(`
        [
          "button.12",
          "button.14",
          "button.16",
          "copy.14",
          "copy.16",
          "copy.13",
          "copy.18",
          "copy.20",
          "copy.24",
          "copy.14.strong",
          "copy.16.strong",
          "copy.13.mono",
          "copy.18.strong",
          "copy.20.strong",
          "copy.24.strong",
          "heading.14",
          "heading.16",
          "heading.20",
          "heading.24",
          "heading.32",
          "heading.40",
          "heading.48",
          "heading.56",
          "heading.64",
          "heading.72",
          "heading.16.subtle",
          "heading.20.subtle",
          "heading.24.subtle",
          "heading.32.subtle",
          "label.12",
          "label.14",
          "label.16",
          "label.13",
          "label.18",
          "label.20",
          "label.14.strong",
          "label.16.strong",
          "label.13.mono",
          "label.12.mono",
          "label.12.strong",
          "label.14.mono",
          "label.13.strong",
        ]
      `)
      expect(complete('alignItems', 'center', '')).toMatchInlineSnapshot(`
        [
          "normal",
          "baseline",
          "center",
          "end",
          "first baseline",
          "flex-end",
          "flex-start",
          "last baseline",
          "safe center",
          "safe end",
          "safe flex-end",
          "safe flex-start",
          "safe start",
          "start",
          "stretch",
          "unsafe center",
          "unsafe end",
          "unsafe flex-end",
          "unsafe flex-start",
          "unsafe start",
          "anchor-center",
          "safe self-end",
          "safe self-start",
          "self-end",
          "self-start",
          "unsafe self-end",
          "unsafe self-start",
          "inherit",
          "initial",
          "revert",
          "revert-layer",
          "unset",
        ]
      `)
      expect(complete('fontFamily', 'sans', '')).toMatchInlineSnapshot(`
        [
          "mono",
          "sans",
          "serif",
        ]
      `)
      expect(diagnose("fontFamily: 'sans'", "fontFamily: 'comic'"))
        .toMatchInlineSnapshot(`
          [
            {
              "code": 2322,
              "message": "Type '"comic"' is not assignable to type '"comic" & Expected<"mono" | "sans" | "serif" | \`\${string} !custom\`>'.
            Type 'string' is not assignable to type 'Expected<"mono" | "sans" | "serif" | \`\${string} !custom\`>'.",
              "span": "fontFamily",
            },
          ]
        `)
      expect(
        diagnose("alignItems: 'center'", "alignItems: 'invalid-alignment'"),
      ).toMatchInlineSnapshot(`
        [
          {
            "code": 2322,
            "message": "Type '"invalid-alignment"' is not assignable to type '("invalid-alignment" & Reference<"*">) | ("invalid-alignment" & readonly [Atom<\`\${string} !custom\` | Value<{ readonly kind: "enum"; readonly values: readonly ["anchor-center", "baseline", "center", "end", ... 22 more ..., "unsafe start"]; }> | Reference<...>>, ...Atom<...>[]])'.",
            "span": "alignItems",
          },
        ]
      `)
      expect(diagnose("fontFamily: 'sans'", "unknownProperty: 'sans'"))
        .toMatchInlineSnapshot(`
          [
            {
              "code": 2322,
              "message": "Type 'string' is not assignable to type 'never'.",
              "span": "unknownProperty",
            },
          ]
        `)
    } finally {
      service.dispose()
    }
  }, 120_000)

  test('uses the validated descriptor snapshot for configuration', () => {
    const options = new Proxy(
      { cssOutput: 'grouped' as const },
      {
        get(target, key, receiver) {
          if (key === 'cssOutput') throw new Error('Unexpected property read')
          return Reflect.get(target, key, receiver)
        },
      },
    )
    expect(Object.isFrozen(Config.create(options))).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('mixed named inputs share isolated scopes and retain the default fallback', () => {
    const base = Theme.define({
      color: { brand: '#06c' },
      spacing: { md: '8px' },
    })

    const zyzz = Config.create({
      defaultTheme: 'base',
      themes: {
        base,
        mint: {
          color: { brand: { light: '#175', dark: '#afa' } },
          spacing: { md: '12px' },
        },
      },
    })

    const output = Css.compile({
      styles: Style.define({
        card: {
          color: zyzz.themes.base.tokens.color.brand,
          padding: zyzz.themes.base.tokens.spacing.md,
        },
      }),
      vars: zyzz.themes,
    })

    expect(output.css).toMatchInlineSnapshot(`
      ".z0{--z0:#06c;--z1:8px;}
      .z1{--z0:light-dark(#175,#afa);--z1:12px;}
      .z_0{color:var(--z0,#06c);}
      .z_1{padding:var(--z1,8px);}"
    `)
    expect(Object.isFrozen(zyzz.themes)).toMatchInlineSnapshot(`true`)
    expect(zyzz.themes.base === base).toMatchInlineSnapshot(`false`)
    // The original definition cannot become a scope for the normalized contract.
    expect(
      Css.compile({
        styles: Style.define({
          card: { color: zyzz.themes.base.tokens.color.brand },
        }),
        vars: { original: base },
      }).css,
    ).toMatchInlineSnapshot(`".z_0{color:var(--z0,#06c);}"`)

    const other = Config.create({ theme: base })

    expect(
      Css.compile({
        styles: Style.define({
          card: { color: other.theme.tokens.color.brand },
        }),
        vars: zyzz.themes,
      }).css,
    ).toMatchInlineSnapshot(`".z_0{color:var(--z0,#06c);}"`)
  })

  test('normalized themes inherit and select schemes in Chromium', async () => {
    const zyzz = Config.create({
      defaultTheme: 'base',
      themes: {
        base: {
          color: { brand: { light: '#06c', dark: '#9cf' } },
          spacing: { md: '8px' },
        },
        mint: {
          color: { brand: { light: '#175', dark: '#afa' } },
          spacing: { md: '12px' },
        },
      },
    })

    const output = Css.compile({
      styles: Style.define({
        card: {
          color: zyzz.themes.base.tokens.color.brand,
          padding: zyzz.themes.base.tokens.spacing.md,
        },
      }),
      vars: zyzz.themes,
    })

    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${output.css}</style><main class="${output.vars.mint}"><div id="mint" class="${output.classes.card}"></div><section class="${output.vars.base}"><div id="base" class="${output.classes.card}"></div></section></main>`,
      )

      expect(
        await page
          .locator('#mint')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(17, 119, 85)"`)
      expect(
        await page
          .locator('#mint')
          .evaluate((element) => getComputedStyle(element).padding),
      ).toMatchInlineSnapshot(`"12px"`)
      expect(
        await page
          .locator('#base')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(0, 102, 204)"`)

      await page.evaluate(() => {
        document.documentElement.style.colorScheme = 'dark'
      })

      expect(
        await page
          .locator('#mint')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(170, 255, 170)"`)
      expect(
        await page
          .locator('#base')
          .evaluate((element) => getComputedStyle(element).color),
      ).toMatchInlineSnapshot(`"rgb(153, 204, 255)"`)
    } finally {
      await browser.close()
    }
  })

  test('single inline themes and reusable extensions retain validated values', () => {
    const base = Theme.define({ spacing: { md: '8px' } })
    const zyzz = Config.create({
      theme: Theme.extend(base, { spacing: { md: '12px' } }),
    })

    expect(
      Css.compile({
        styles: Style.define({ card: { padding: 'md' } }, { vars: zyzz.theme }),
        vars: { selected: zyzz.theme },
      }).css,
    ).toMatchInlineSnapshot(`
      ".z0{--z0:12px;}
      .z_0{padding:var(--z0,12px);}"
    `)

    const inline = Config.create({ theme: { spacing: { md: '1rem' } } })

    expect(
      Css.compile({
        styles: Style.define({
          card: { padding: inline.theme.tokens.spacing.md },
        }),
      }).css,
    ).toMatchInlineSnapshot(`".z_0{padding:var(--z0,1rem);}"`)
    expect(() =>
      zyzz.style({ padding: 'md' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Config.create requires an explicit id without the compiler plugin.]`,
    )
    expect(Config.create().style({ padding: '8px' })()).toMatchInlineSnapshot(`
      {
        "className": "z-content-_5b__5b__22_padding_22__2c__22_8px_22__2c_false_5d__5d_",
      }
    `)
  })

  test('rejects unknown default before CSS emission', () => {
    expect(() =>
      emit({
        defaultTheme: 'missing',
        themes: { base: { color: { brand: '#06c' } } },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: defaultTheme must name a theme in the catalog.]`,
    )
  })
  test('rejects incompatible paths before CSS emission', () => {
    expect(() =>
      emit({
        defaultTheme: 'base',
        themes: {
          base: { color: { brand: '#06c' } },
          mint: { color: { other: '#175' } },
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Theme "mint" must have the default theme's complete token paths and domains.]`,
    )
  })
  test('rejects mixed modes before CSS emission', () => {
    expect(() =>
      emit({ theme: {}, themes: {} }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Use either theme or themes, not both.]`,
    )
  })
  test('rejects default without catalog before CSS emission', () => {
    expect(() =>
      emit({ defaultTheme: 'base' }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: defaultTheme requires a named themes catalog.]`,
    )
  })
  test('rejects duplicate layers before CSS emission', () => {
    expect(() =>
      emit({ layers: ['base', 'base'] }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Duplicate layer: base]`,
    )
  })
  test('rejects reserved layers before CSS emission', () => {
    expect(() =>
      emit({ layers: ['base', 'initial'] }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Layer names must be plain CSS identifiers, optionally dotted.]`,
    )
  })
  test('rejects invalid layer names before CSS emission', () => {
    expect(() =>
      emit({ layers: ['base', 'bad name'] }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Layer names must be plain CSS identifiers, optionally dotted.]`,
    )
  })
})

function emit(input: unknown) {
  const config = Config.create(input as Config.create.Options)

  return Css.compile({
    styles: Style.define({ card: { color: '#06c' } }),
    vars: 'themes' in config ? config.themes : {},
  })
}

describe('defineConfig', () => {
  test.each(['defineConfig', 'defineConfig as configure'])(
    'compiles named config imports: %s',
    (specifier) => {
      const name = specifier.includes(' as ') ? 'configure' : 'defineConfig'
      const result = Graph.compile({
        imports: {
          'app.ts': { './config': 'config.ts' },
          'config.ts': { zyzz: null },
        },
        modules: {
          'config.ts': `import { ${specifier} } from 'zyzz'; export const {style,vars}= ${name}({vars:{color:{brand:'#123456'}}});`,
          'app.ts': `import {style} from './config'; export const card=style({color:'brand'});`,
        },
      })

      expect(defineConfig === PublicConfig.create).toMatchInlineSnapshot(`true`)
      expect(result.modules['app.ts']!.css).toMatchInlineSnapshot(`
        ".z-theme-theme{--z-color-brand:#123456;}
        .z_scheme-dark{color-scheme:dark;}
        .z_scheme-light{color-scheme:light;}
        .z_scheme-light-dark{color-scheme:light dark;}
        .z_Zf5JrJ0{color:var(--z-color-brand,#123456);}"
      `)
    },
  )

  test('rejects font weight tokens outside the fontWeight domain', () => {
    function compile(config: string, weight = `'medium'`) {
      return Graph.compile({
        imports: {
          'app.ts': { './config': 'config.ts' },
          'config.ts': { zyzz: null },
        },
        modules: {
          'config.ts': `import {defineConfig} from 'zyzz'; export const {style}=defineConfig(${config});`,
          'app.ts': `import {style} from './config'; export const label=style({fontWeight:${weight}});`,
        },
      })
    }

    expect(() =>
      compile(`{vars:{fontWeight:{regular:'400',medium:'500'}}}`),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:56: Font weight token fontWeight.regular must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )
    expect(() =>
      compile(
        `{mappings:{weight:['fontWeight']},vars:{weight:{medium:'500'}}}`,
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: config.ts:56: Font weight token weight.medium must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )
    expect(() =>
      defineConfig({
        id: 'weights',
        vars: { fontWeight: { regular: '400', medium: '500' } },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Font weight token fontWeight.regular must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )
    expect(() =>
      defineConfig({
        id: 'weights',
        mappings: { weight: ['fontWeight'] },
        vars: { weight: { medium: '500' } },
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: Font weight token weight.medium must be a number from 1 to 1000 or a fontWeight keyword, such as 500.]`,
    )

    const numeric = compile(
      `{vars:{fontWeight:{bold:'bold',medium:500,regular:400}}}`,
    )

    expect(numeric.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-fontWeight-medium:500;}
      .z_Zf5JrJ0{font-weight:var(--z-fontWeight-medium,500);}"
    `)
    expect(() =>
      compile(`{vars:{fontWeight:{medium:500}}}`, '600'),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: app.ts:69: Expected a configured token or a CSS value with the " !custom" suffix.]`,
    )
  })
})
