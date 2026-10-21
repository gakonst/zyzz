/** Compiles, runs, and type-checks the web API reference examples through public compiler entrypoints. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import * as Url from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { Style } from 'zyzz'
import { Graph } from 'zyzz/compiler'
import { Host } from 'zyzz/node'
import {
  colorProfile,
  counterStyle,
  Css,
  cssFunction,
  customMedia,
  fontPaletteValues,
  keyframes,
  positionTry,
} from 'zyzz/web'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
let root = ''

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-web-api-'))
  await Fs.mkdir(Path.join(root, 'node_modules'))
  await Fs.symlink(project, Path.join(root, 'node_modules/zyzz'), 'dir')
  await Fs.symlink(
    Path.join(project, 'node_modules/@types'),
    Path.join(root, 'node_modules/@types'),
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

/** Compiles one example as a source graph module, returning its shared and module stylesheets. */
function compile(example: { name?: string | undefined; source: string }) {
  const id = example.name ?? 'Example.tsx'
  const output = Graph.compile({ modules: { [id]: example.source } })

  return { css: output.modules[id]?.css, shared: output.sharedCss }
}

/** Runs one example module and returns its exports. */
async function run(name: string, source: string) {
  const file = Path.join(root, 'run', `${name}.ts`)
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(
    file,
    source.replace(/^const output/m, 'export const output'),
  )

  return (await import(Url.pathToFileURL(file).href)) as {
    output: Css.compile.ReturnType
  }
}

describe('global API page', () => {
  test('emits selector rules into the shared stylesheet', async () => {
    const [overview] = await examples('global')
    const [nested, constants] = await examples('global', 'styles')

    expect(compile(overview!).shared).toMatchInlineSnapshot(`
      "body{margin:0;}
      a:hover{text-decoration:underline;}"
    `)
    expect(compile(nested!).shared).toMatchInlineSnapshot(
      `"a{color:blue;&:hover{color:navy;}}"`,
    )
    expect(compile(constants!).shared).toMatchInlineSnapshot(
      `"body{font-family:Inter, sans-serif;}"`,
    )
  })

  test('groups selectors under at-rule keys', async () => {
    const [grouped] = await examples('global', 'styles[atRule]')

    expect(compile(grouped!).shared).toMatchInlineSnapshot(`
      "@layer base{body{margin:0;}}
      @media print{nav{display:none;}}"
    `)
  })

  test('rejects calls outside module scope', async () => {
    const [nested] = await examples('at-rules', 'Static Compilation')

    expect(() => compile(nested!)).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: Example.tsx:155: Stylesheet contributions require direct module-level calls and constant named stylesheet bindings.]`,
    )
  })
})

describe('layers API page', () => {
  test('merges layer order across modules', async () => {
    const [overview] = await examples('layers')
    const [components] = await examples('layers', 'names')
    const output = Graph.compile({
      modules: {
        [overview!.name!]: overview!.source,
        [components!.name!]: components!.source,
      },
    })

    expect(output.sharedCss).toMatchInlineSnapshot(
      `"@layer reset,base,components,utilities;"`,
    )
  })

  test('rejects conflicting orders', async () => {
    const [conflict] = await examples('layers', 'Errors')

    expect(() => compile(conflict!)).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: Example.tsx:35: ["contributions"]: Conflicting layer order constraints.]`,
    )
  })
})

describe('fontFace API page', () => {
  test('emits descriptors in authored order', async () => {
    const [overview] = await examples('fontFace')
    const [variable] = await examples('fontFace', 'descriptors')
    const [types] = await examples('fontFace', 'Types')

    expect(compile(overview!).shared).toMatchInlineSnapshot(
      `"@font-face{font-display:swap;font-family:App Sans;src:url("/app.woff2") format("woff2");}"`,
    )
    expect(compile(variable!).shared).toMatchInlineSnapshot(
      `"@font-face{font-family:Inter;font-variation-settings:"opsz" 32;font-weight:100 900;src:url("/inter.woff2") format("woff2");}"`,
    )
    expect(compile(types!).shared).toMatchInlineSnapshot(
      `"@font-face{font-family:Inter;src:url("/inter.woff2");}"`,
    )
  })

  test('publishes relative sources as assets', async () => {
    const [relative] = await examples('fontFace', 'descriptors.src')
    const output = Graph.compile({
      modules: { 'src/fonts.ts': relative!.source },
    })

    expect(output.sharedCss).toMatchInlineSnapshot(`
      "@font-face {
        font-family: Body;
        src: url("zyzz-asset:src%2Fbody.woff2") format("woff2");
      }"
    `)
    expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:src%2Fbody.woff2": "src/body.woff2",
      }
    `)
  })

  test('emits enclosing groups outermost first', async () => {
    const [grouped] = await examples('fontFace', 'descriptors[atRule]')

    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer fonts{@supports font-tech(variations){@font-face{font-family:Body;src:url("/body.woff2");}}}"`,
    )
  })
})

describe('keyframes API page', () => {
  test('emits frames and references the generated name', async () => {
    const [overview] = await examples('keyframes')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@keyframes z-k-enter{from{opacity:0;}to{opacity:1;}}"`,
    )
    expect(output.css).toMatchInlineSnapshot(`
      ".z_3PBZzK0{animation-name:z-k-enter;}
      .z_3PBZzK1{animation-duration:200ms;}"
    `)
  })

  test('emits stop lists, timeline ranges, and groups', async () => {
    const [list, ranges] = await examples('keyframes', 'frames')
    const [grouped] = await examples('keyframes', 'frames[atRule]')

    expect(compile(list!).shared).toMatchInlineSnapshot(
      `"@keyframes z-k-pulse{0%, 100%{opacity:1;}50%{opacity:0.5;}}"`,
    )
    expect(compile(ranges!).shared).toMatchInlineSnapshot(
      `"@keyframes z-k-reveal{entry 0%{opacity:0;}entry 100%{opacity:1;}}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer animations{@keyframes z-k-fade{from{opacity:0;}to{opacity:1;}}}"`,
    )
  })

  test('returns a fixed name without a compiler transform', () => {
    expect(
      keyframes({ from: { opacity: 0 } }, { id: 'fade' }),
    ).toMatchInlineSnapshot(`"z-kid-fade"`)
    expect(() =>
      keyframes({ from: { opacity: 0 } }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: keyframes requires an explicit id without the compiler plugin.]`,
    )
  })

  test('omits definitions that are neither exported nor referenced', () => {
    const output = compile({
      source: `import { keyframes } from 'zyzz/web'\n\nconst unused = keyframes({ from: { opacity: 0 } })\n`,
    })

    expect(output.shared).toMatchInlineSnapshot(`undefined`)
  })
})

describe('importCss API page', () => {
  test('emits imports with layers and conditions', async () => {
    const [overview] = await examples('importCss')
    const [anonymous] = await examples('importCss', 'options.layer')
    const [supports] = await examples('importCss', 'options.supports')
    const output = Graph.compile({
      modules: { [overview!.name!]: overview!.source },
    })

    expect(output.sharedCss).toMatchInlineSnapshot(
      `"@import "zyzz-asset:src%2Fnormalize.css" layer(reset);"`,
    )
    expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:src%2Fnormalize.css": "src/normalize.css",
      }
    `)
    expect(compile(anonymous!).shared).toMatchInlineSnapshot(
      `"@import url("https://example.com/vendor.css") layer;"`,
    )
    expect(compile(supports!).shared).toMatchInlineSnapshot(
      `"@import url("https://example.com/grid.css") supports(display: grid);"`,
    )
  })
})

describe('page API page', () => {
  test('emits page descriptors, margin boxes, and groups', async () => {
    const [overview] = await examples('page')
    const [descriptors, margins] = await examples('page', 'options.descriptors')
    const [grouped] = await examples('page', 'options[atRule]')

    expect(compile(overview!).shared).toMatchInlineSnapshot(
      `"@page{margin:2cm;size:A4;@bottom-center{content:counter(page);}}"`,
    )
    expect(compile(descriptors!).shared).toMatchInlineSnapshot(
      `"@page{size:A4 landscape;marks:crop cross;margin:1cm;}"`,
    )
    expect(compile(margins!).shared).toMatchInlineSnapshot(
      `"@page{@top-right{content:"Draft";}}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer print{@page{margin:2cm;}}"`,
    )
  })

  test('rejects invalid descriptor values', () => {
    expect(() =>
      compile({
        source: `import { page } from 'zyzz/web'\n\npage({ descriptors: { size: '50%' } })\n`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [Source.ExtractError: Example.tsx:33: Invalid @page size: Mismatch
        syntax: <length [0,∞]>{1,2} | auto | [ <page-size> || [ portrait | landscape ] ]
         value: 50%
        --------^]
    `)
  })
})

describe('viewTransition API page', () => {
  test('emits navigation and type descriptors', async () => {
    const [overview] = await examples('viewTransition')
    const [types] = await examples('viewTransition', 'descriptors.types')
    const [grouped] = await examples('viewTransition', 'descriptors[atRule]')

    expect(compile(overview!).shared).toMatchInlineSnapshot(
      `"@view-transition{navigation:auto;}"`,
    )
    expect(compile(types!).shared).toMatchInlineSnapshot(
      `"@view-transition{navigation:auto;types:slide forward;}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto;}}"`,
    )
  })
})

describe('positionTry API page', () => {
  test('emits a fallback and references its name', async () => {
    const [overview] = await examples('positionTry')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@position-try --z-positiontry-above{margin-bottom:0.5rem;position-area:top;}"`,
    )
    expect(output.css).toMatchInlineSnapshot(`
      ".z_A9MjQ10{position:absolute;}
      .z_A9MjQ11{position-anchor:--trigger;}
      .z_A9MjQ12{position-area:bottom;}
      .z_A9MjQ13{position-try-fallbacks:--z-positiontry-above;}"
    `)
  })

  test('emits declarations and groups', async () => {
    const [end] = await examples('positionTry', 'declarations')
    const [grouped] = await examples('positionTry', 'declarations[atRule]')

    expect(compile(end!).shared).toMatchInlineSnapshot(
      `"@position-try --z-positiontry-end{position-area:right;max-width:240px;}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer overlays{@position-try --z-positiontry-above{position-area:top;}}"`,
    )
  })

  test('returns a fixed name without a compiler transform', () => {
    expect(
      positionTry({ positionArea: 'top' }, { id: 'above' }),
    ).toMatchInlineSnapshot(`"--z-positiontryid-above"`)
  })
})

describe('counterStyle API page', () => {
  test('emits a counter style and references its name', async () => {
    const [overview] = await examples('counterStyle')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@counter-style z-counterstyle-circled{suffix:" ";symbols:"①" "②" "③";system:fixed;}"`,
    )
    expect(output.css).toMatchInlineSnapshot(
      `".z_QvnI2l0{list-style-type:z-counterstyle-circled;}"`,
    )
  })

  test('emits each system and groups', async () => {
    const [cyclic] = await examples('counterStyle', 'descriptors')
    const [extended] = await examples('counterStyle', 'descriptors.system')
    const [grouped] = await examples('counterStyle', 'descriptors[atRule]')

    expect(compile(cyclic!).shared).toMatchInlineSnapshot(
      `"@counter-style z-counterstyle-thumbs{system:cyclic;symbols:"👍";suffix:" ";}"`,
    )
    expect(compile(extended!).shared).toMatchInlineSnapshot(
      `"@counter-style z-counterstyle-parenthesized{system:extends decimal;suffix:") ";}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer lists{@counter-style z-counterstyle-stars{system:cyclic;symbols:"*";}}"`,
    )
  })

  test('returns a fixed name without a compiler transform', () => {
    expect(
      counterStyle({ system: 'cyclic', symbols: '"*"' }, { id: 'stars' }),
    ).toMatchInlineSnapshot(`"z-counterstyleid-stars"`)
  })
})

describe('customMedia API page', () => {
  test('emits a named query and groups declarations under it', async () => {
    const [overview] = await examples('customMedia')
    const [combined] = await examples('customMedia', 'query')
    const [nested] = await examples('customMedia', 'reference')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@custom-media --z-custommedia-compact (width < 40rem);"`,
    )
    expect(output.css).toMatchInlineSnapshot(`
      ".z_oRwC0_0{display:block;}
      @media (--z-custommedia-compact){.z_oRwC0_1{display:none;}}"
    `)
    expect(compile(combined!).shared).toMatchInlineSnapshot(
      `"@custom-media --z-custommedia-wideHover (width >= 64rem) and (hover: hover);"`,
    )
    expect(compile(nested!).css).toMatchInlineSnapshot(`
      ".z_3oDDjY0{color:blue;}
      @media (--z-custommedia-print){.z_3oDDjY1{&:hover{text-decoration:none;}}}"
    `)
  })

  test('returns a fixed key without a compiler transform', () => {
    expect(
      customMedia('(width < 40rem)', { id: 'compact' }),
    ).toMatchInlineSnapshot(`"@media (--z-custommediaid-compact)"`)
  })
})

describe('property API page', () => {
  test('emits registrations with each descriptor', async () => {
    const [overview] = await examples('property')
    const [syntax] = await examples('property', 'options.syntax')
    const [universal] = await examples('property', 'options.initialValue')
    const [grouped] = await examples('property', 'options[atRule]')

    expect(compile(overview!).shared).toMatchInlineSnapshot(
      `"@property --angle{syntax:"<angle>";inherits:false;initial-value:0deg;}"`,
    )
    expect(compile(syntax!).shared).toMatchInlineSnapshot(
      `"@property --spacing{syntax:"<length>+ | auto";inherits:false;initial-value:4px 8px;}"`,
    )
    expect(compile(universal!).shared).toMatchInlineSnapshot(
      `"@property --payload{syntax:"*";inherits:true;}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer defaults{@property --gap{syntax:"<length>";inherits:false;initial-value:0px;}}"`,
    )
  })

  test('rejects computationally dependent initial values', () => {
    expect(() =>
      compile({
        source: `import { property } from 'zyzz/web'\n\nproperty({ inherits: false, initialValue: '1em', name: '--gap', syntax: '<length>' })\n`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: Example.tsx:37: Registered initial values must be computationally independent.]`,
    )
  })
})

describe('fontFeatureValues API page', () => {
  test('emits feature blocks for each family form', async () => {
    const [overview] = await examples('fontFeatureValues')
    const [families] = await examples('fontFeatureValues', 'options.families')
    const [variant] = await examples('fontFeatureValues', 'options.features')
    const [grouped] = await examples('fontFeatureValues', 'options[atRule]')

    expect(compile(overview!).shared).toMatchInlineSnapshot(
      `"@font-feature-values "Example Font"{@styleset{editorial:1 3;}@swash{decorative:2;}}"`,
    )
    expect(compile(families!).shared).toMatchInlineSnapshot(
      `"@font-feature-values "Inter","Inter Display"{@stylistic{alternate:1;}}"`,
    )
    expect(compile(variant!).shared).toMatchInlineSnapshot(
      `"@font-feature-values "Example Font"{@character-variant{singleStorey:2 1;}}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer fonts{@font-feature-values "Example Font"{@swash{decorative:2;}}}"`,
    )
  })
})

describe('fontPaletteValues API page', () => {
  test('emits a palette and references its name', async () => {
    const [overview] = await examples('fontPaletteValues')
    const [accent] = await examples(
      'fontPaletteValues',
      'descriptors.overrideColors',
    )
    const [grouped] = await examples('fontPaletteValues', 'descriptors[atRule]')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@font-palette-values --z-fontpalettevalues-brand{base-palette:0;font-family:"Brand Icons";override-colors:0 #ff5500, 1 #111111;}"`,
    )
    expect(output.css).toMatchInlineSnapshot(`
      ".z_AfPZ6v0{font-family:"Brand Icons";}
      .z_AfPZ6v1{font-palette:--z-fontpalettevalues-brand;}"
    `)
    expect(compile(accent!).shared).toMatchInlineSnapshot(
      `"@font-palette-values --z-fontpalettevalues-accent{font-family:"Brand Icons";override-colors:0 crimson;}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer fonts{@font-palette-values --z-fontpalettevalues-night{base-palette:dark;font-family:"Brand Icons";}}"`,
    )
  })

  test('returns a fixed name without a compiler transform', () => {
    expect(
      fontPaletteValues({ fontFamily: '"Brand Icons"' }, { id: 'brand' }),
    ).toMatchInlineSnapshot(`"--z-fontpalettevaluesid-brand"`)
  })
})

describe('cssFunction API page', () => {
  test('emits a function and formats calls to it', async () => {
    const [overview] = await examples('cssFunction')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(
      `"@function --z-cssfunction-double(--size <length>) returns <length>{result:calc(var(--size) * 2);}"`,
    )
    expect(output.css).toMatchInlineSnapshot(
      `".z_emUaHx0{width:--z-cssfunction-double(2rem);}"`,
    )
  })

  test('emits defaults, return syntax, bodies, and groups', async () => {
    const [fluid] = await examples('cssFunction', 'options.parameters')
    const [tint] = await examples('cssFunction', 'options.returns')
    const [gutter] = await examples('cssFunction', 'options.body')
    const [grouped] = await examples('cssFunction', 'options[atRule]')

    expect(compile(fluid!).shared).toMatchInlineSnapshot(
      `"@function --z-cssfunction-fluid(--min <length>,--max <length>: 3rem) returns <length>{result:clamp(var(--min), 4vw, var(--max));}"`,
    )
    expect(compile(tint!).shared).toMatchInlineSnapshot(
      `"@function --z-cssfunction-tint(--color <color>) returns <color>{result:color-mix(in srgb, var(--color), white 20%);}"`,
    )
    expect(compile(gutter!).shared).toMatchInlineSnapshot(
      `"@function --z-cssfunction-gutter(--size <length>) returns <length>{--base:var(--size);result:var(--base);@media (width >= 48rem){result:calc(var(--base) * 2);}}"`,
    )
    expect(compile(grouped!).shared).toMatchInlineSnapshot(
      `"@layer functions{@function --z-cssfunction-half(--size <length>){result:calc(var(--size) / 2);}}"`,
    )
  })

  test('formats calls without a compiler transform', () => {
    const double = cssFunction(
      { body: { result: '0px' }, parameters: [] },
      { id: 'double' },
    )

    expect(double()).toMatchInlineSnapshot(`"--z-cssfunctionid-double()"`)
    expect(
      cssFunction(
        { body: { result: 'var(--list)' }, parameters: [{ name: '--list' }] },
        { id: 'first' },
      )('1px, 2px'),
    ).toMatchInlineSnapshot(`"--z-cssfunctionid-first({1px, 2px})"`)
  })

  test('rejects branches with different signatures', () => {
    expect(() =>
      compile({
        source: `import { cssFunction } from 'zyzz/web'\n\nexport const size = cssFunction({\n  '@media print': { body: { result: '1px' }, parameters: [{ name: '--a', syntax: '<length>' }] },\n  '@media screen': { body: { result: '1px' }, parameters: [{ name: '--b', syntax: '<length>' }] },\n})\n`,
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: Example.tsx:60: Grouped CSS function definitions must use the same parameters and return syntax.]`,
    )
  })
})

describe('colorProfile API page', () => {
  test('emits a profile and references it inside color()', async () => {
    const [overview] = await examples('colorProfile')
    const output = Graph.compile({
      modules: { [overview!.name!]: overview!.source },
    })

    expect(output.sharedCss).toMatchInlineSnapshot(`
      "@color-profile --z-colorprofile-swop {
        src:url("zyzz-asset:src%2Fswop.icc");
      }"
    `)
    expect(output.sharedAssets).toMatchInlineSnapshot(`
      {
        "zyzz-asset:src%2Fswop.icc": "src/swop.icc",
      }
    `)
    expect(output.modules[overview!.name!]?.css).toMatchInlineSnapshot(
      `".z_gW2-fM0{color:color(--z-colorprofile-swop 0 0.5 1 0);}"`,
    )
  })

  test('emits intents, components, and groups', async () => {
    const [intent] = await examples(
      'colorProfile',
      'descriptors.renderingIntent',
    )
    const [components] = await examples(
      'colorProfile',
      'descriptors.components',
    )
    const [grouped] = await examples('colorProfile', 'descriptors[atRule]')

    expect(compile(intent!).shared).toMatchInlineSnapshot(`
      "@color-profile --z-colorprofile-photo {
        rendering-intent:perceptual;src:url("zyzz-asset:photo.icc");
      }"
    `)
    expect(compile(components!).shared).toMatchInlineSnapshot(`
      "@color-profile --z-colorprofile-cmyk {
        components:cyan, magenta, yellow, black;src:url("zyzz-asset:cmyk.icc");
      }"
    `)
    expect(compile(grouped!).shared).toMatchInlineSnapshot(`
      "@media print {
        @color-profile --z-colorprofile-press {
          src:url("zyzz-asset:press.icc");
        }
      }"
    `)
  })

  test('returns a fixed name without a compiler transform', () => {
    expect(
      colorProfile({ src: 'url("./swop.icc")' }, { id: 'swop' }),
    ).toMatchInlineSnapshot(`"--z-colorprofileid-swop"`)
  })
})

describe('namespace API page', () => {
  test('isolates prefixes to the declaring module', async () => {
    const [overview] = await examples('namespace')
    const [mathml] = await examples('namespace', 'options.prefix')

    expect(compile(overview!).shared).toMatchInlineSnapshot(`
      "@namespace z-n72f2z71coq7qd-2z "http://www.w3.org/2000/svg";
      z-n72f2z71coq7qd-2z|a {
        color: #00f;
      }"
    `)
    expect(compile(mathml!).shared).toMatchInlineSnapshot(`
      "@namespace z-n1y3ivww1ikxfmi-2r "http://www.w3.org/1998/Math/MathML";
      z-n1y3ivww1ikxfmi-2r|math {
        font-size: 1.125rem;
      }"
    `)
  })
})

describe('Css API page', () => {
  test('compiles styles in each output mode', async () => {
    const [overview] = await examples('namespaces/Css')
    const [grouped] = await examples('namespaces/Css', 'options.cssOutput')
    const [independent] = await examples(
      'namespaces/Css',
      'options.composition',
    )
    const [names] = await examples('namespaces/Css', 'options.names')
    const [scope] = await examples('namespaces/Css', 'options.scope')

    expect((await run('overview', overview!.source)).output)
      .toMatchInlineSnapshot(`
        {
          "classes": {
            "card": "z_0 z_1",
          },
          "css": ".z_0{color:black;}
        .z_1{padding:1rem;}",
          "vars": {},
        }
      `)
    expect((await run('grouped', grouped!.source)).output)
      .toMatchInlineSnapshot(`
        {
          "classes": {
            "card": "z_0",
          },
          "css": ".z_0{color:black;padding:1rem;}",
          "vars": {},
        }
      `)
    expect((await run('independent', independent!.source)).output)
      .toMatchInlineSnapshot(`
        {
          "classes": {
            "card": "z_0 z_1",
            "title": "z_0 z_2",
          },
          "css": ".z_0{padding:1rem;}
        .z_1{color:black;}
        .z_2{font-size:2rem;}",
          "vars": {},
        }
      `)
    expect((await run('names', names!.source)).output).toMatchInlineSnapshot(`
      {
        "classes": {
          "card": "card",
        },
        "css": ".card{padding:1rem;}",
        "vars": {},
      }
    `)
    expect((await run('scope', scope!.source)).output).toMatchInlineSnapshot(`
      {
        "classes": {
          "card": "z_card-0",
        },
        "css": ".z_card-0{padding:1rem;}",
        "vars": {},
      }
    `)
  })

  test('splits contributions from scoped rules', async () => {
    const [contributions] = await examples(
      'namespaces/Css',
      'options.contributions',
    )

    expect((await run('contributions', contributions!.source)).output)
      .toMatchInlineSnapshot(`
        {
          "classes": {
            "card": "z_0",
          },
          "contributionCss": "@layer reset,base;",
          "css": "@layer reset,base;
        .z_0{padding:1rem;}",
          "scopedCss": ".z_0{padding:1rem;}",
          "vars": {},
        }
      `)
  })

  test('emits a scope class for each variable set', async () => {
    const [vars] = await examples('namespaces/Css', 'options.vars')

    expect((await run('vars', vars!.source)).output).toMatchInlineSnapshot(`
      {
        "classes": {
          "card": "z_0",
        },
        "css": ".z0{--z0:#171717;}
      .z_0{color:var(--z0,#171717);}",
        "vars": {
          "base": "z0",
        },
      }
    `)
  })

  test('emits color-scheme classes and empty styles', () => {
    const styles = Style.define({ card: {} })

    expect(Css.compile({ schemes: true, styles })).toMatchInlineSnapshot(`
      {
        "classes": {
          "card": "",
        },
        "css": ".z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}",
        "vars": {},
      }
    `)
  })

  test('reports identity collisions without partial output', () => {
    const error = (() => {
      try {
        Css.compile({
          names: { body: 'text', title: 'text' },
          styles: Style.define({
            body: { color: 'black' },
            title: { color: 'red' },
          }),
        })
      } catch (error) {
        return error
      }
    })()

    expect(error instanceof Css.CompileError).toMatchInlineSnapshot(`true`)
    expect((error as Css.CompileError).diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "identity_collision",
          "message": "An explicit id is used for different styles.",
          "path": [
            "title",
          ],
        },
      ]
    `)
  })
})

describe('At-Rule Contract page', () => {
  test('keeps descriptor rules apart from grouping keys', async () => {
    const [overview] = await examples('at-rules')
    const output = compile(overview!)

    expect(output.shared).toMatchInlineSnapshot(`
      "@page{margin:2cm;}
      @media print{nav{display:none;}}"
    `)
    expect(output.css).toMatchInlineSnapshot(
      `"@media print{.z_acI-je0{box-shadow:none;}}"`,
    )
  })

  test('nests grouping keys in style bodies', async () => {
    const [card] = await examples('at-rules', 'Grouping Keys')

    expect(compile(card!).css).toMatchInlineSnapshot(`
      ".z_3oDDjY0{@scope (&) to (.boundary){& h2{color:red;}}}
      .z_3oDDjY1{@container scroll-state(stuck: top){box-shadow:0 2px 8px #0002;}}
      .z_3oDDjY2{@starting-style{opacity:0;}}"
    `)
  })

  test('orders the shared stylesheet', async () => {
    const [named] = await examples('at-rules', 'Named References')
    const [ordered] = await examples('at-rules', 'Stylesheet Order')
    const output = Graph.compile({
      modules: { [ordered!.name!]: ordered!.source },
    })

    expect(compile(named!).shared).toMatchInlineSnapshot(`
      "@counter-style z-counterstyle-circled{system:fixed;symbols:"①" "②" "③";}
      @position-try --z-positiontry-above{position-area:top;}"
    `)
    expect(output.sharedCss).toMatchInlineSnapshot(`
      "@layer reset,base;
      @import "zyzz-asset:src%2Fnormalize.css" layer(reset);
      body{margin:0;}"
    `)
  })

  test('rejects web helpers in native builds', async () => {
    const [web] = await examples('at-rules', 'React Native')
    const directory = Path.join(root, 'native')
    await Fs.mkdir(Path.join(directory, 'src'), { recursive: true })
    await Fs.writeFile(Path.join(directory, web!.name!), web!.source)

    await using host = await Host.create({
      native: { colorScheme: 'light', platform: 'ios' },
      outDir: Path.join(directory, 'dist'),
      packageId: 'web-api',
      root: directory,
    })

    await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Native.CompileError: Native static modules do not support CSS contributions, variables, or web set controls.]`,
    )
  })
})

describe('web API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      [
        'global',
        'layers',
        'fontFace',
        'keyframes',
        'importCss',
        'page',
        'viewTransition',
        'positionTry',
        'counterStyle',
        'customMedia',
        'property',
        'fontFeatureValues',
        'fontPaletteValues',
        'cssFunction',
        'colorProfile',
        'namespace',
        'namespaces/Css',
        'at-rules',
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
          await Fs.mkdir(Path.dirname(file), { recursive: true })
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
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        ...files,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60000 },
    )

    expect(files.length).toMatchInlineSnapshot(`84`)
    expect(checked.status, checked.stdout + checked.stderr).toBe(0)
  }, 90_000)
})
