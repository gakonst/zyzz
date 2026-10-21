/**
 * Exercises the public Source workflow through real collaborating modules.
 * @module
 */
import { chromium } from 'playwright'
import { describe, expect, test } from 'vite-plus/test'
import { Source } from 'zyzz/compiler'
import { Css } from 'zyzz/web'
import { StyleSheet } from 'zyzz/react-native'

describe('extract', () => {
  test.each(['native', 'ios', 'android'] as const)(
    'compiles %s-only styles with a default layer',
    (target) => {
      const result = Source.extract({
        moduleId: 'native.ts',
        source: `import {Config} from 'zyzz';
const {style} = Config.create({defaultLayer: 'components'});
export const card = style({targets: {${target}: {opacity: 0.5}, web: {color: 'red'}}});`,
      })
      const output = StyleSheet.compile({
        styles: result.styles,
        platform: target === 'android' ? 'android' : 'ios',
      })

      expect(Object.values(output.styles.default.light)).toMatchInlineSnapshot(`
        [
          {
            "opacity": 0.5,
          },
        ]
      `)
      expect(result.styles.styles[0]!.rules).toMatchInlineSnapshot(`[]`)
    },
  )

  test('keeps synthesized default layer rules immutable after extraction', () => {
    const result = Source.extract({
      moduleId: 'layer.ts',
      source: `import {Config} from 'zyzz';
const {style} = Config.create({defaultLayer: 'components'});
export const card = style({color: 'red'});`,
    })
    const rule = result.styles.styles[0]!.rules![0]!
    const before = Css.compile({ styles: result.styles }).css

    expect(
      Reflect.set(rule, 'condition', '@layer overrides'),
    ).toMatchInlineSnapshot(`false`)
    expect(
      Css.compile({ styles: result.styles }).css === before,
    ).toMatchInlineSnapshot(`true`)
  })

  test('retains ordered static recipe alternatives for native compilation', () => {
    const result = Source.extract({
      moduleId: 'recipe.ts',
      source: `import {variants} from 'zyzz';
export const card = variants({
  base: {opacity: 0.2},
  variants: {tone: {quiet: {opacity: 0.4}, loud: {targets: {native: {opacity: 0.6}, ios: {opacity: 0.7}}}}},
  defaultVariants: {tone: 'quiet'},
  compoundVariants: [
    {when: {tone: ['quiet', 'loud']}, style: {opacity: 0.8}},
    {when: {tone: 'loud'}, style: {opacity: 1}},
  ],
});`,
    })
    const recipe = result.calls[0]!.staticRecipe!
    expect(recipe.axes).toMatchInlineSnapshot(`
      {
        "tone": [
          "quiet",
          "loud",
        ],
      }
    `)
    expect(recipe.defaults).toMatchInlineSnapshot(`
      {
        "tone": "quiet",
      }
    `)
    expect(recipe.rules.map(({ matches }) => matches)).toMatchInlineSnapshot(`
      [
        [],
        [
          [
            "tone",
            [
              "quiet",
            ],
          ],
        ],
        [
          [
            "tone",
            [
              "loud",
            ],
          ],
        ],
        [
          [
            "tone",
            [
              "quiet",
              "loud",
            ],
          ],
        ],
        [
          [
            "tone",
            [
              "loud",
            ],
          ],
        ],
      ]
    `)
    expect(
      recipe.rules.map(
        ({ value }) =>
          Object.values(
            StyleSheet.compile({ styles: value, platform: 'ios' }).styles
              .default.light,
          )[0]!.opacity,
      ),
    ).toMatchInlineSnapshot(`
      [
        0.2,
        0.4,
        0.7,
        0.8,
        1,
      ]
    `)
    expect(
      Css.compile({ styles: result.styles }).css.includes('data-tone'),
    ).toMatchInlineSnapshot('true')
  })

  test('does not label dynamic or conditional recipes as static native data', () => {
    for (const body of [
      `{variants:{size:{custom:(value:{opacity:number})=>({opacity:value.opacity})}}}`,
      `{conditions:{wide:'@media (min-width: 600px)'},variants:{tone:{quiet:{opacity:0.5}}}}`,
    ]) {
      const result = Source.extract({
        moduleId: 'recipe.ts',
        source: `import {variants} from 'zyzz';export const card=variants(${body});`,
      })
      expect(result.calls[0]!.staticRecipe).toMatchInlineSnapshot('undefined')
    }
  })

  test('rejects malformed web target conditions at their source location', () => {
    const source = `import {style} from 'zyzz';export const card=style({targets:{web:{'@supports display:grid':{color:'red'}}}});`
    try {
      Source.extract({ moduleId: 'card.ts', source })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(Source.ExtractError)
      const diagnostics = (error as Source.ExtractError).diagnostics
      expect(diagnostics.map(({ start, end }) => source.slice(start, end)))
        .toMatchInlineSnapshot(`
        [
          "'@supports display:grid'",
        ]
      `)
    }
  })

  test('omits explicit undefined native fields in inline target data', () => {
    const output = Source.extract({
      moduleId: 'card.ts',
      source: `import {style} from 'zyzz';export const card=style({targets:{native:{opacity:undefined,lineHeight:24}}});`,
    })

    expect(output.styles.styles[0]?.targets?.native).toMatchInlineSnapshot(`
      {
        "lineHeight": 24,
      }
    `)
  })

  test('does not omit shadowed undefined target data', () => {
    expect(() =>
      Source.extract({
        moduleId: 'card.ts',
        source: `import {style} from 'zyzz';const undefined=unknown;export const card=style({targets:{native:{opacity:undefined}}});`,
      }),
    ).toThrow()
  })

  test('parameter initializers preserve imports across body hoisting and nested closures', () => {
    const source = `import { style } from 'zyzz';
const text = '🎉';
function button(other = style({ color: '#f00' })) { var style; }
function closure(other = () => style({ color: '#f00' })) { if (true) { var style; } }
const arrow = (other = style({ color: '#f00' })) => { var style; };
const named = function style(other = style({ color: unknown })) { var style; };
function parameter(style, other = style({ color: unknown })) { var style; }
function later(other = style({ color: unknown }), style) {}
function destructured({ style }, other = style({ color: unknown })) {}
function body() { style({ color: unknown }); if (true) { var style; } }
function local() { style({ color: unknown }); const style = unknown; }
type Signature = <T>(value: T) => T;
export type { style };
export { type style as StyleFunction };
export { style as external } from 'another-package';
function afterType(other = style({ color: '#f00' })) { var style; }
`

    const result = Source.extract({ moduleId: 'example/parameters.ts', source })
    const output = Css.compile({ styles: result.styles })

    expect({
      calls: result.calls.map((call) => source.slice(call.start, call.end)),
      css: output.css,
    }).toMatchInlineSnapshot(`
      {
        "calls": [
          "style({ color: '#f00' })",
          "style({ color: '#f00' })",
          "style({ color: '#f00' })",
          "style({ color: '#f00' })",
        ],
        "css": ".z_0{color:#f00;}",
      }
    `)
  })

  test('imported assignments and indirect references fail before CSS emission', () => {
    const source = `import { style } from 'zyzz';
import { style as Css } from 'zyzz';
({ style } = values);
[style] = values;
style++;
for (style of values) {}
export { style };
const object = { style };
const element = <Css />;
`

    try {
      const result = Source.extract({ moduleId: 'example/writes.ts', source })

      Css.compile({ styles: result.styles })
      throw new Error('Expected extraction failure')
    } catch (error) {
      if (!(error instanceof Source.ExtractError)) throw error

      expect(
        error.diagnostics.map((item) => ({
          code: item.code,
          message: item.message,
          text: source.slice(item.start, item.end),
        })),
      ).toMatchInlineSnapshot(`
        [
          {
            "code": "unsupported_syntax",
            "message": "Imported style bindings cannot be reassigned.",
            "text": "{ style } = values",
          },
          {
            "code": "unsupported_syntax",
            "message": "Imported style bindings cannot be reassigned.",
            "text": "[style] = values",
          },
          {
            "code": "unsupported_syntax",
            "message": "Imported style bindings cannot be reassigned.",
            "text": "style++",
          },
          {
            "code": "unsupported_syntax",
            "message": "Imported style bindings cannot be reassigned.",
            "text": "for (style of values) {}",
          },
          {
            "code": "unsupported_syntax",
            "message": "Use a direct style call; aliases, re-exports, and indirect references are not supported yet.",
            "text": "style",
          },
          {
            "code": "unsupported_syntax",
            "message": "Use a direct style call; aliases, re-exports, and indirect references are not supported yet.",
            "text": "style",
          },
          {
            "code": "unsupported_syntax",
            "message": "Use a direct style call; aliases, re-exports, and indirect references are not supported yet.",
            "text": "Css",
          },
        ]
      `)
    }
  })

  test('source bindings extract ordered literals without executing application code', () => {
    const source = `import { style as define } from 'zyzz';
throw new Error('Application source must never execute');
export const card = define({ padding: '8px', paddingLeft: 0 });
function nested(define) { return define({ padding: unknown }); }
function style(value) { return value; }
style({ color: unknown });
export const view = <div {...define({ color: '#fff', opacity: +0.5 })()} />;
type Definition = ReturnType<typeof define>;
`

    const result = Source.extract({ moduleId: 'example/card.tsx', source })
    const output = Css.compile({ styles: result.styles })

    expect({
      calls: result.calls.map((call) => source.slice(call.start, call.end)),
      declarations: result.styles.styles.map((style) => style.declarations),
      frozen:
        Object.isFrozen(result) &&
        Object.isFrozen(result.calls) &&
        Object.isFrozen(result.styles.styles),
      repeated: Source.extract({ moduleId: 'example/card.tsx', source }),
      rules: output.css,
    }).toMatchInlineSnapshot(`
      {
        "calls": [
          "define({ padding: '8px', paddingLeft: 0 })",
          "define({ color: '#fff', opacity: +0.5 })",
        ],
        "declarations": [
          [
            {
              "property": "padding",
              "value": "8px",
            },
            {
              "property": "paddingLeft",
              "value": 0,
            },
          ],
          [
            {
              "property": "color",
              "value": "#fff",
            },
            {
              "property": "opacity",
              "value": 0.5,
            },
          ],
        ],
        "frozen": true,
        "repeated": {
          "calls": [
            {
              "cssName": "BHk_aD-card",
              "cssNamespace": undefined,
              "end": 160,
              "identity": "z-style-BHk_aD-card",
              "name": "style-16i62vd1bo8k8l-118",
              "start": 118,
            },
            {
              "cssName": "BHk_aD-view",
              "cssNamespace": undefined,
              "end": 363,
              "name": "style-16i62vd1bo8k8l-323",
              "start": 323,
            },
          ],
          "namespaces": [],
          "styles": {
            "styles": [
              {
                "declarations": [
                  {
                    "property": "padding",
                    "value": "8px",
                  },
                  {
                    "property": "paddingLeft",
                    "value": 0,
                  },
                ],
                "name": "style-16i62vd1bo8k8l-118",
              },
              {
                "declarations": [
                  {
                    "property": "color",
                    "value": "#fff",
                  },
                  {
                    "property": "opacity",
                    "value": 0.5,
                  },
                ],
                "name": "style-16i62vd1bo8k8l-323",
              },
            ],
          },
          "themeAliases": [],
          "themeCalls": [],
          "themeReferences": [],
          "vars": {},
        },
        "rules": ".z_0{padding:8px;}
      .z_1{padding-left:0;}
      .z_2{color:#fff;}
      .z_3{opacity:0.5;}",
      }
    `)
  })

  test('renamed imports retain source order and isolate portable module identities', () => {
    const source = `import { style as second } from 'zyzz'; import { style as first } from 'zyzz';
const a = first({ marginTop: '-2px' } as const); const b = second({ lineHeight: 1.5 } satisfies {});`
    const first = Source.extract({ moduleId: '@example/ui/card.ts', source })
    const second = Source.extract({ moduleId: '@example/ui/other.ts', source })

    expect({
      calls: first.calls.map((call) => source.slice(call.start, call.end)),
      distinct: first.calls.every(
        (call, index) => call.name !== second.calls[index]?.name,
      ),
      styles: first.styles.styles.map((style) => style.declarations),
    }).toMatchInlineSnapshot(`
    {
      "calls": [
        "first({ marginTop: '-2px' } as const)",
        "second({ lineHeight: 1.5 } satisfies {})",
      ],
      "distinct": true,
      "styles": [
        [
          {
            "property": "marginTop",
            "value": "-2px",
          },
        ],
        [
          {
            "property": "lineHeight",
            "value": 1.5,
          },
        ],
      ],
    }
  `)
    expect(
      Source.extract({
        moduleId: 'example/empty.ts',
        source: 'const css = (x) => x; style({ anything: unknown });',
      }),
    ).toMatchInlineSnapshot(`
      {
        "calls": [],
        "namespaces": [],
        "styles": {
          "styles": [],
        },
        "themeAliases": [],
        "themeCalls": [],
        "themeReferences": [],
        "vars": {},
      }
    `)
  })

  test('unsupported source produces located diagnostics without partial artifacts', () => {
    const source = `import { style } from 'zyzz';
style({ padding: 4 });
style({ ...defaults });
style(() => ({ color: '#fff' }));
style(external);
style({ color: execute() });
style({ get color() { throw new Error('never execute') } });
style({ padding: 0, padding: '1px' });
const alias = css;
css?.({ padding: 0 });
style({ padding });
style({ ['color']: '#fff' });
css = unknown;
import * as Zyzz from 'zyzz';
Zyzz.style({ padding: 0 });
`

    try {
      Source.extract({ moduleId: 'example/errors.ts', source })
      throw new Error('Expected extraction failure')
    } catch (error) {
      if (!(error instanceof Source.ExtractError)) throw error

      expect({
        diagnostics: error.diagnostics.map((item) => ({
          ...item,
          text: source.slice(item.start, item.end),
        })),
        frozen:
          Object.isFrozen(error.diagnostics) &&
          error.diagnostics.every(Object.isFrozen),
        name: error.name,
      }).toMatchInlineSnapshot(`
        {
          "diagnostics": [
            {
              "code": "unsupported_syntax",
              "end": 404,
              "message": "Import style by name; namespace authoring calls are not supported yet.",
              "source": "example/errors.ts",
              "start": 394,
              "text": "Zyzz.style",
            },
          ],
          "frozen": true,
          "name": "Source.ExtractError",
        }
      `)
    }
  })

  test.each([0, 65_536])(
    'retains syntax diagnostics after %i Unicode comment characters',
    (length) => {
      const prefix = `/*${'😀'.repeat(length / 2)}*/`

      try {
        Source.extract({
          moduleId: 'broken.ts',
          source: `${prefix}export const =`,
        })
        throw new Error('Expected parse failure')
      } catch (error) {
        if (!(error instanceof Source.ExtractError)) throw error

        expect(
          error.diagnostics.map((diagnostic) => ({
            ...diagnostic,
            start: diagnostic.start - prefix.length,
            end: diagnostic.end - prefix.length,
          })),
        ).toMatchInlineSnapshot(`
        [
          {
            "code": "syntax_error",
            "end": 14,
            "message": "Unexpected token",
            "source": "broken.ts",
            "start": 13,
          },
        ]
      `)
      }
    },
  )

  test('syntax and module identity failures remain source owned', () => {
    const errors = [
      '/absolute.ts',
      'C:\\file.ts',
      'example/../file.ts',
      '',
    ].map((moduleId) => {
      try {
        Source.extract({ moduleId, source: '' })
        throw new Error('Expected invalid module ID')
      } catch (error) {
        if (!(error instanceof Source.ExtractError)) throw error

        return error.diagnostics
      }
    })

    expect(errors).toMatchInlineSnapshot(`
    [
      [
        {
          "code": "invalid_module",
          "end": 0,
          "message": "Expected a portable package-relative module ID without absolute paths, backslashes, or traversal segments.",
          "source": "/absolute.ts",
          "start": 0,
        },
      ],
      [
        {
          "code": "invalid_module",
          "end": 0,
          "message": "Expected a portable package-relative module ID without absolute paths, backslashes, or traversal segments.",
          "source": "C:\\file.ts",
          "start": 0,
        },
      ],
      [
        {
          "code": "invalid_module",
          "end": 0,
          "message": "Expected a portable package-relative module ID without absolute paths, backslashes, or traversal segments.",
          "source": "example/../file.ts",
          "start": 0,
        },
      ],
      [
        {
          "code": "invalid_module",
          "end": 0,
          "message": "Expected a portable package-relative module ID without absolute paths, backslashes, or traversal segments.",
          "source": "",
          "start": 0,
        },
      ],
    ]
  `)

    try {
      Source.extract({
        moduleId: 'example/broken.ts',
        source: 'export const =',
      })
      throw new Error('Expected parse failure')
    } catch (error) {
      if (!(error instanceof Source.ExtractError)) throw error

      expect(error.diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "syntax_error",
          "end": 14,
          "message": "Unexpected token",
          "source": "example/broken.ts",
          "start": 13,
        },
      ]
    `)
    }
  })

  test('extracted definitions render authored shorthand and override order in Chromium', async () => {
    const extracted = Source.extract({
      moduleId: 'example/cascade.tsx',
      source: `import { style } from 'zyzz';
const first = style({ color: '#000', padding: '8px', paddingLeft: 0 });
const middle = style({ color: '#fff', paddingLeft: '3px' });
const last = style({ color: '#000', padding: '8px', paddingLeft: 0 });`,
    })

    const output = Css.compile({ styles: extracted.styles })
    const classes = extracted.calls.map((call) => output.classes[call.name]!)
    const browser = await chromium.launch()

    try {
      const page = await browser.newPage()

      await page.setContent('<!doctype html><body></body>')
      await page.addStyleTag({ content: output.css })

      const result = await page.evaluate(
        (classes) =>
          [`${classes[1]} ${classes[0]}`, `${classes[2]} ${classes[1]}`].map(
            (className) => {
              const element = document.createElement('div')

              element.className = className
              document.body.append(element)

              const computed = getComputedStyle(element)

              return { color: computed.color, padding: computed.padding }
            },
          ),
        classes,
      )

      expect(result).toMatchInlineSnapshot(`
      [
        {
          "color": "rgb(255, 255, 255)",
          "padding": "8px 8px 8px 3px",
        },
        {
          "color": "rgb(0, 0, 0)",
          "padding": "8px 8px 8px 0px",
        },
      ]
    `)
    } finally {
      await browser.close()
    }
  })
})
