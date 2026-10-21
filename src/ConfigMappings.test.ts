/** Exercises property aliases and dedicated spacing tokens through packed compilation and browser rendering. @module */
import * as Vm from 'node:vm'
import * as Packed from '../test/fixtures/Packed.js'
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'
import { Config, Style } from 'zyzz'
import * as Configuration from './internal/Configuration.js'

describe('create', () => {
  test('renders Tailwind category precedence through a packed configuration', async () => {
    const library = Graph.compile({
      modules: {
        'config.ts': `import {Config} from 'zyzz';
        export const {style, vars} = Config.create({vars: {
          color: {brand: '#112233'}, textColor: {brand: '#445566'},
          backgroundColor: {brand: '#778899'}, borderColor: {brand: '#aabbcc'},
          spacing: {shared: '16px', compact: '24px'},
          container: {wide: '640px', compact: '320px'},
          width: {compact: '120px'}, minHeight: {compact: '48px'}, height: {compact: '64px'},
          margin: {compact: '4px'}, padding: {compact: '8px'}, gap: {compact: '12px'},
          radius: {round: '10px'}, shadow: {soft: '0 2px 4px #0003'},
          blur: {soft: '2px'}, aspect: {video: '16 / 9'}, ease: {out: 'cubic-bezier(0, 0, 0.2, 1)'},
        }});`,
      },
    })
    const app = Graph.compile({
      contracts: { 'library.js': library.contracts['config.ts']! },
      imports: { 'app.ts': { library: 'library.js', zyzz: null } },
      modules: {
        'app.ts': `import {style,vars} from 'library';
        export const scope = vars();
        export const card = style({color:'brand',backgroundColor:'brand',borderColor:'brand',width:'compact',minHeight:'compact',maxHeight:'compact',padding:'compact',margin:'compact',gap:'compact',borderRadius:'round',boxShadow:'soft',aspectRatio:'video',transitionTimingFunction:'out',filter:\`blur(\${vars.blur.soft})\`})();
        export const spaced = style({width:'shared',height:'shared',borderSpacing:'shared',scrollMarginTop:'shared',scrollPaddingTop:'shared',translate:'shared',textIndent:'shared'})();
        export const sized = style({width:'wide',minWidth:'wide',maxWidth:'wide',flexBasis:'wide',inlineSize:'wide',columns:'wide','@container >=wide':{opacity:0.5}})();`,
      },
    })
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': app.modules['app.ts']!.code },
      packages: { library: { 'index.ts': library.modules['config.ts']!.code } },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const css = (app.sharedCss ?? '') + app.modules['app.ts']!.css
    expect(css.includes('@container (width >= 640px)')).toMatchInlineSnapshot(
      `true`,
    )
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${css}</style><main class="${fixture.scope.className}"><div id="card" class="${fixture.card.className}"></div><div id="spaced" class="${fixture.spaced.className}"></div><div id="sized" class="${fixture.sized.className}"></div></main>`,
      )
      expect(
        await page.locator('#card').evaluate((element) => {
          const style = getComputedStyle(element)
          return [
            style.color,
            style.backgroundColor,
            style.borderTopColor,
            style.width,
            style.minHeight,
            style.maxHeight,
            style.padding,
            style.margin,
            style.gap,
            style.borderRadius,
            style.boxShadow,
            style.aspectRatio,
            style.transitionTimingFunction,
            style.filter,
          ]
        }),
      ).toMatchInlineSnapshot(`
        [
          "rgb(68, 85, 102)",
          "rgb(119, 136, 153)",
          "rgb(170, 187, 204)",
          "120px",
          "48px",
          "64px",
          "8px",
          "4px",
          "12px",
          "10px",
          "rgba(0, 0, 0, 0.2) 0px 2px 4px 0px",
          "16 / 9",
          "cubic-bezier(0, 0, 0.2, 1)",
          "blur(2px)",
        ]
      `)
      expect(
        await page.locator('#spaced').evaluate((element) => {
          const style = getComputedStyle(element)
          return [
            style.width,
            style.height,
            style.borderSpacing,
            style.scrollMarginTop,
            style.scrollPaddingTop,
            style.translate,
            style.textIndent,
          ]
        }),
      ).toMatchInlineSnapshot(`
        [
          "16px",
          "16px",
          "16px",
          "16px",
          "16px",
          "16px",
          "16px",
        ]
      `)
      expect(
        await page.locator('#sized').evaluate((element) => {
          const style = getComputedStyle(element)
          return [
            style.width,
            style.minWidth,
            style.maxWidth,
            style.flexBasis,
            style.inlineSize,
            style.columnWidth,
          ]
        }),
      ).toMatchInlineSnapshot(`
        [
          "640px",
          "640px",
          "640px",
          "640px",
          "640px",
          "640px",
        ]
      `)
    } finally {
      await browser.close()
    }
  })
  test('renders numeric and compound values from non-font categories', async () => {
    const result = Graph.compile({
      modules: {
        'app.ts': `import {Config} from 'zyzz';
      const {style}=Config.create({vars:{gridColumn:{pair:'span 2'},gridColumnStart:{second:2},columns:{pair:2},scale:{large:1.25},strokeWidth:{bold:2},listStyleType:{named:'custom-counter'},transitionProperty:{fade:'opacity'},gridTemplateColumns:{split:'20px 1fr'},backgroundPosition:{offset:'10px'},objectPosition:{offset:'10px'},transformOrigin:{offset:'10px'},perspectiveOrigin:{offset:'10px'}}});
      export const box=style({gridColumn:'pair',columns:'pair',scale:'large',strokeWidth:'bold',listStyleType:'named',transitionProperty:'fade',gridTemplateColumns:'split',backgroundPosition:'offset',objectPosition:'offset',transformOrigin:'offset',perspectiveOrigin:'offset'})();
      export const start=style({gridColumnStart:'second'})();`,
      },
    })
    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': result.modules['app.ts']!.code },
    })
    const fixture = Vm.runInNewContext(`${code};Fixture;`)
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(
        `<style>${result.modules['app.ts']!.css}</style><div id="box" style="width:100px;height:100px" class="${fixture.box.className}"></div><div id="start" class="${fixture.start.className}"></div>`,
      )
      expect(
        await page.locator('#box').evaluate((element) => {
          const style = getComputedStyle(element)
          return [
            style.gridColumn,
            style.columnCount,
            style.scale,
            style.strokeWidth,
            style.listStyleType,
            style.transitionProperty,
            style.gridTemplateColumns,
            style.backgroundPosition,
            style.objectPosition,
            style.transformOrigin,
            style.perspectiveOrigin,
          ]
        }),
      ).toMatchInlineSnapshot(`
        [
          "span 2",
          "2",
          "1.25",
          "2px",
          "custom-counter",
          "opacity",
          "20px 1fr",
          "10px 50%",
          "10px 50%",
          "10px 50px",
          "10px 50px",
        ]
      `)
      expect(
        await page
          .locator('#start')
          .evaluate((element) => getComputedStyle(element).gridColumnStart),
      ).toMatchInlineSnapshot(`"2"`)
    } finally {
      await browser.close()
    }
  })
  test.each(['-4px', '50%'])(
    'rejects invalid column width token %s',
    (value) => {
      try {
        Graph.compile({
          modules: {
            'app.ts': `import {Config} from 'zyzz';const {style}=Config.create({vars:{columns:{invalid:${JSON.stringify(value)}}}});export const box=style({columns:'invalid'})();`,
          },
        })
        throw new Error('Expected an invalid column width')
      } catch (error) {
        expect(
          (error as { diagnostics?: { message: string }[] }).diagnostics?.map(
            (diagnostic) => diagnostic.message,
          ),
        ).toMatchInlineSnapshot(`
        [
          "Variable value is incompatible with this property.",
        ]
      `)
      }
    },
  )
  test('retains alias source paths in structural diagnostics', () => {
    const { theme } = Configuration.create({
      theme: {},
      shorthands: { px: ['paddingLeft', 'paddingRight'] },
    })

    try {
      Style.define(
        // @ts-expect-error exercise unchecked invalid fallback input
        { card: { px: [] } },
        {
          vars: theme,
          locations: [
            { path: ['card', 'px'], source: 'app.ts', start: 10, end: 12 },
          ],
        },
      )
      throw new Error('Expected invalid fallback')
    } catch (error) {
      expect((error as Style.InvalidError).diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "invalid_value",
          "location": {
            "end": 12,
            "path": [
              "card",
              "px",
            ],
            "source": "app.ts",
            "start": 10,
          },
          "message": "Fallback arrays must be nonempty.",
          "path": [
            "card",
            "px",
          ],
        },
        {
          "code": "invalid_value",
          "location": {
            "end": 12,
            "path": [
              "card",
              "px",
            ],
            "source": "app.ts",
            "start": 10,
          },
          "message": "Fallback arrays must be nonempty.",
          "path": [
            "card",
            "px",
          ],
        },
      ]
    `)
    }
  })

  test('writes version five for dedicated spacing groups without aliases', () => {
    const result = Graph.compile({
      modules: {
        'config.ts':
          "import {Config} from 'zyzz';export const {vars:theme}=Config.create({vars:{margin:{gap:'-4px'},padding:{gap:'4px'}}});",
      },
    })

    expect(
      JSON.parse(result.contracts['config.ts']!).version,
    ).toMatchInlineSnapshot(`31`)
  })
  test('preserves mapped HTML theme handles through source and packed aliases', async () => {
    const library = Graph.compile({
      modules: {
        'index.ts':
          "import {Config} from 'zyzz';export const config=Config.create({id:'library',output:'html',vars:{padding:{sm:'4px'}},shorthands:{px:['paddingLeft','paddingRight']}});export const theme=config.vars;export const bound=config.style;export const staticStyle=bound({px:'sm'});",
      },
    })

    const app = Graph.compile({
      contracts: { 'library/index.js': library.contracts['index.ts']! },
      imports: { 'app.ts': { library: 'library/index.js', zyzz: null } },
      modules: {
        'app.ts':
          "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz';import {config,theme,staticStyle} from 'library';const extended=Vars.extend(theme,{padding:{sm:'12px'}}); const extendedConfig=Config.create({id:'app',vars:extended,output:'html',shorthands:{px:['paddingLeft','paddingRight']}});export const extension=extendedConfig.style({px:'sm'})();const {style}=config;export const destructured=style({px:'sm'})();const bound=config.style;export const dynamic=bound((values:{width:'4px'|'8px'})=>({px:`${values.width} !custom`}))({width:'8px'});export const direct=config.style({px:'sm'})();export const source=staticStyle();",
      },
    })

    const code = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': app.modules['app.ts']!.code },
      packages: { library: { 'index.ts': library.modules['index.ts']!.code } },
    })

    const result = Vm.runInNewContext(`${code};Fixture;`)

    for (const props of [
      result.direct,
      result.source,
      result.dynamic,
      result.extension,
      result.destructured,
    ]) {
      expect(typeof props.class).toMatchInlineSnapshot('"string"')
      expect(props.className).toMatchInlineSnapshot('undefined')
    }

    expect(typeof result.dynamic.style).toMatchInlineSnapshot('"string"')
    expect(result.direct).toMatchInlineSnapshot(`
      {
        "class": "z_library-Zf5JrJ6 z_library-Zf5JrJ7",
      }
    `)
    expect(result.source).toMatchInlineSnapshot(`
      {
        "class": "z_library-r-SNdO0 z_library-r-SNdO1 z-style-library-r-SNdO-staticStyle",
      }
    `)
    expect(result.dynamic).toMatchInlineSnapshot(`
      {
        "class": "z_library-Zf5JrJ4 z_library-Zf5JrJ5",
        "style": "--z-library-Zf5JrJ-dynamic-width:8px",
      }
    `)
  })

  const config =
    "import {Config} from 'zyzz';export const {style,vars:theme}=Config.create({shorthands:{px:['paddingLeft','paddingRight'],paddingX:['paddingLeft','paddingRight'],space:['marginLeft','paddingLeft']},vars:{spacing:{sm:'4px'},margin:{sm:'-8px'},padding:{sm:'12px'}}});"
  const source = `import {style,theme} from 'library';export namespace styles {
  export const card = style({px:'sm',paddingLeft:'2px !custom',':hover':{paddingX:'sm !important'}})

  export const mixed = style({space:'sm'})

  export const handle = theme.style({px:'sm'})

  export const dynamic = style((values:{width:'10px'|'20px'})=>({px:\`\${values.width} !custom\`}))
}`

  function compile() {
    const library = Graph.compile({
      modules: {
        'config.ts': config,
        'index.ts': `export {style,theme} from './config.js';`,
      },
    })

    const app = Graph.compile({
      contracts: { 'library/index.js': library.contracts['index.ts']! },
      imports: { 'app.ts': { library: 'library/index.js' } },
      modules: { 'app.ts': source },
    })

    return { app, library }
  }

  test('rejects non-record shorthand container', () => {
    expect(() =>
      Config.create({
        shorthands: new Map([['px', ['paddingLeft']]]),
      } as never),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Config.InvalidError: shorthands must be a property mapping record.]`,
    )
  })
  test('accepts reordered alias keys with identical target tuples', () => {
    const { library } = compile()
    const first = JSON.parse(library.contracts['config.ts']!)
    const second = JSON.parse(library.contracts['config.ts']!)

    for (const theme of Object.values(second.themes) as {
      shorthands: Record<string, string[]>
    }[])
      theme.shorthands = Object.fromEntries(
        Object.entries(theme.shorthands).reverse(),
      )

    const output = Graph.compile({
      contracts: {
        'a.js': JSON.stringify(first),
        'b.js': JSON.stringify(second),
      },
      imports: { 'app.ts': { a: 'a.js', b: 'b.js' } },
      modules: {
        'app.ts': `import {style as a} from 'a';import {style as b} from 'b';export const card=a({px:'sm'})`,
      },
    })

    expect(
      output.modules['app.ts']!.css.includes('padding-left'),
    ).toMatchInlineSnapshot('true')
  })
  test('rejects conflicting packed mappings before reusing theme identities', () => {
    const { library } = compile()
    const original = library.contracts['config.ts']!
    const changed = JSON.parse(original)

    expect(changed.version).toMatchInlineSnapshot(`31`)

    for (const value of Object.values(changed.themes) as {
      shorthands: Record<string, string[]>
    }[])
      value.shorthands.px = ['marginLeft', 'marginRight']

    expect(() =>
      Graph.compile({
        contracts: { 'a.js': original, 'b.js': JSON.stringify(changed) },
        imports: { 'app.ts': { a: 'a.js', b: 'b.js' } },
        modules: {
          'app.ts': `import {style as a} from 'a';import {style as b} from 'b';export namespace styles {export const first=a({px:'sm'});export const second=b({px:'sm'});}`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: b.js:0: Invalid library contract: Conflicting packed shorthand mappings for one theme identity.]`,
    )
  })
  test('retains mapped extension annotations through packed exports', () => {
    const library = Graph.compile({
      modules: {
        'theme.ts':
          "import {Config,Vars} from 'zyzz';const {vars:theme}=Config.create({id:'library',shorthands:{px:['paddingLeft','paddingRight']},vars:{spacing:{sm:'4px'}}});export const extended=Vars.extend(theme,{spacing:{sm:'8px'}});",
      },
    })

    expect(
      library.modules['theme.ts']!.code.includes('shorthands:'),
    ).toMatchInlineSnapshot('true')

    const consumer = Graph.compile({
      contracts: { 'lib.js': library.contracts['theme.ts']! },
      imports: { 'app.ts': { lib: 'lib.js', zyzz: null } },
      modules: {
        'app.ts':
          "import {Config} from 'zyzz';\nimport {Vars} from 'zyzz';import {extended} from 'lib';export const next=Vars.extend(extended,{spacing:{sm:'12px'}}); const nextConfig=Config.create({id:'app',vars:next,shorthands:{px:['paddingLeft','paddingRight']}});export const card=nextConfig.style({px:'sm'});",
      },
    })

    expect(
      consumer.modules['app.ts']!.code.includes('shorthands:'),
    ).toMatchInlineSnapshot('true')
    expect(consumer.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-library-theme{--z-library-spacing-sm:4px;}
      .z-theme-library-extended{--z-library-spacing-sm:8px;}
      .z-theme-library-next{--z-library-spacing-sm:12px;}
      .z-theme-app-theme{--z-app-spacing-sm:12px;}
      .z_app-Zf5JrJ0{padding-left:var(--z-app-spacing-sm,12px);}
      .z_app-Zf5JrJ1{padding-right:var(--z-app-spacing-sm,12px);}"
    `)
  })
  test('accepts quoted aliases and independently validates numeric targets', () => {
    const graph = Graph.compile({
      modules: {
        'app.ts':
          "import {Config,Vars} from 'zyzz';const {style,vars:theme}=Config.create({shorthands:{'padding-x':['paddingLeft','paddingRight'],mixed:['scale','order']},vars:{spacing:{sm:'4px'}}});const extended=Vars.extend(theme,{spacing:{sm:'8px'}}); const extendedConfig=Config.create({vars:extended,shorthands:{'padding-x':['paddingLeft','paddingRight']}});export namespace styles {\n  export const card = extendedConfig.style({'padding-x':'sm'})\n\n  export const dynamic = style((values:{n:1|2})=>({mixed:values.n}))\n}",
      },
    })

    expect(graph.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-spacing-sm:8px;}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      .z_Zf5JrJ0{padding-left:var(--z-spacing-sm,8px);}
      .z_Zf5JrJ1{padding-right:var(--z-spacing-sm,8px);}
      .z_Zf5JrJ2{scale:var(--z-Zf5JrJ-styles-dynamic-n);}
      .z_Zf5JrJ3{order:var(--z-Zf5JrJ-styles-dynamic-n);}"
    `)
  })
  test('preserves ordered targets and spacing precedence across packed imports', () => {
    const { app } = compile()

    expect(app.modules['app.ts']!.css).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-margin-sm:-8px;--z-padding-sm:12px;--z-spacing-sm:4px;}
      .z_Zf5JrJ0{padding-left:var(--z-padding-sm,12px);}
      .z_Zf5JrJ1{padding-right:var(--z-padding-sm,12px);}
      .z_Zf5JrJ2{padding-left:2px;}
      .z_Zf5JrJ3{&:hover{padding-left:var(--z-padding-sm,12px)!important;}}
      .z_Zf5JrJ4{&:hover{padding-right:var(--z-padding-sm,12px)!important;}}
      .z_Zf5JrJ5{margin-left:var(--z-margin-sm,-8px);}
      .z_Zf5JrJ6{padding-left:var(--z-padding-sm,12px);}
      .z_Zf5JrJ7{padding-left:var(--z-padding-sm,12px);}
      .z_Zf5JrJ8{padding-right:var(--z-padding-sm,12px);}
      .z_Zf5JrJ9{padding-left:var(--z-Zf5JrJ-styles-dynamic-width);}
      .z_Zf5JrJa{padding-right:var(--z-Zf5JrJ-styles-dynamic-width);}"
    `)
    expect(app.modules['app.ts']!.code.includes('px:')).toMatchInlineSnapshot(
      'false',
    )
  })
  test('rebuilds consumers after a mapping edit', () => {
    const graph = Graph.create()
    const modules = {
      'config.ts': config,
      'app.ts': `import {style} from './config.js';export const card=style({px:'sm'});`,
    }
    const before = graph.compile({ modules })

    const after = graph.compile({
      modules: {
        ...modules,
        'config.ts': config.replace(
          "px:['paddingLeft','paddingRight']",
          "px:['paddingTop','paddingBottom']",
        ),
      },
    })

    expect(
      before.modules['app.ts']!.css.includes('padding-left:'),
    ).toMatchInlineSnapshot('true')
    expect(
      after.modules['app.ts']!.css.includes('padding-left:'),
    ).toMatchInlineSnapshot('false')
    expect(
      after.modules['app.ts']!.css.includes('padding-top:'),
    ).toMatchInlineSnapshot('true')
  })
  test('rejects packed option mappings that disagree with the linked theme', () => {
    const { library } = compile()
    const contract = JSON.parse(library.contracts['config.ts']!)

    contract.exports.style.options.shorthands = {
      mx: ['marginLeft', 'marginRight'],
    }

    expect(() =>
      Graph.compile({
        contracts: { 'lib.js': JSON.stringify(contract) },
        imports: { 'app.ts': { lib: 'lib.js' } },
        modules: {
          'app.ts': `import {style} from 'lib';export const card=style({mx:'sm'})`,
        },
      }),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Source.ExtractError: lib.js:0: Invalid library contract: Configuration mappings disagree with linked theme metadata.]`,
    )
  })
  test('rejects present falsy packed mappings', () => {
    const { library } = compile()

    for (const value of [null, false, 0, '']) {
      const contract = JSON.parse(library.contracts['config.ts']!)

      for (const theme of Object.values(contract.themes) as {
        shorthands: unknown
      }[])
        theme.shorthands = value

      expect(() =>
        Graph.compile({
          contracts: { 'lib.js': JSON.stringify(contract) },
          imports: { 'app.ts': { lib: 'lib.js' } },
          modules: {
            'app.ts': `import {style} from 'lib';export const card=style({color:'red'})`,
          },
        }),
      ).toThrowErrorMatchingInlineSnapshot(
        `[Source.ExtractError: lib.js:0: Invalid library contract: shorthands must be a property mapping record.]`,
      )
    }
  })
  test('rejects invalid mappings', () => {
    const invalid = [
      '{px:[]}',
      "{px:['paddingLeft','paddingLeft']}",
      "{px:['notAProperty']}",
      "{padding:['paddingLeft']}",
      "{px:['paddingX'],paddingX:['paddingLeft']}",
    ]

    const errors = invalid.map((shorthands) => {
      try {
        Graph.compile({
          modules: {
            'config.ts': `import {Config} from 'zyzz';export const config=Config.create({shorthands:${shorthands}});`,
          },
        })

        return 'accepted'
      } catch (error) {
        return (error as Error).message
      }
    })

    expect(errors).toMatchInlineSnapshot(`
      [
        "config.ts:48: Shorthand px requires a nonempty property tuple.",
        "config.ts:48: Shorthand px requires unique standard properties.",
        "config.ts:48: Shorthand px requires unique standard properties.",
        "config.ts:48: Invalid shorthand name: padding",
        "config.ts:48: Shorthand px requires unique standard properties.",
      ]
    `)
  })
  test('renders alias order, nested importance, and dynamic slots in Chromium', async () => {
    const { app, library } = compile()

    const bundle = await Packed.bundle({
      entry: 'app.ts',
      modules: { 'app.ts': app.modules['app.ts']!.code },
      packages: { library: { 'index.ts': library.modules['config.ts']!.code } },
    })

    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent(
        `<style>${app.modules['app.ts']!.css}</style><div id="card">Card</div><div id="mixed"></div><div id="dynamic"></div>`,
      )
      await page.addScriptTag({ content: bundle })
      await page.evaluate(
        `for(const id of ['card','mixed','dynamic']){const props=Fixture.styles[id](id==='dynamic'?{width:'20px'}:{});const el=document.getElementById(id);el.className=props.className;for(const [key,value]of Object.entries(props.style??{})){if(key.startsWith('--'))el.style.setProperty(key,String(value));else el.style[key]=value}}`,
      )

      expect(
        await page
          .locator('#card')
          .evaluate((el) => getComputedStyle(el).paddingLeft),
      ).toMatchInlineSnapshot('"2px"')
      expect(
        await page
          .locator('#card')
          .evaluate((el) => getComputedStyle(el).paddingRight),
      ).toMatchInlineSnapshot('"12px"')
      expect(
        await page
          .locator('#mixed')
          .evaluate((el) => getComputedStyle(el).marginLeft),
      ).toMatchInlineSnapshot('"-8px"')
      expect(
        await page
          .locator('#mixed')
          .evaluate((el) => getComputedStyle(el).paddingLeft),
      ).toMatchInlineSnapshot('"12px"')
      expect(
        await page
          .locator('#dynamic')
          .evaluate((el) => getComputedStyle(el).paddingRight),
      ).toMatchInlineSnapshot('"20px"')

      await page.locator('#card').hover()

      expect(
        await page
          .locator('#card')
          .evaluate((el) => getComputedStyle(el).paddingLeft),
      ).toMatchInlineSnapshot('"12px"')
    } finally {
      await browser.close()
    }
  })
})
