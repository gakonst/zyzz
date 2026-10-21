/**
 * Exercises the public Props workflow through real collaborating modules.
 * @module
 */
import * as Esbuild from 'esbuild'
import * as Path from 'node:path'
import type { CSSProperties } from 'react'
import { describe, expect, test } from 'vite-plus/test'
import { Transform } from 'zyzz/compiler'
import { Props } from 'zyzz/runtime'

const root = Path.resolve(import.meta.dirname, '../..')

describe('create', () => {
  test('omits absent inline styles from returned props', async () => {
    const result = Transform.compile({
      moduleId: 'button.ts',
      source: `import { style } from 'zyzz';
export const button = style({ color: '#f00' });`,
    })
    const bundle = await Esbuild.build({
      alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
      bundle: true,
      format: 'esm',
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })
    const consumer = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
    )

    expect(consumer.button()).toMatchInlineSnapshot(`
      {
        "className": "z_zaclPW0 z-style-zaclPW-button",
      }
    `)
    expect(consumer.button({ style: undefined })).toMatchInlineSnapshot(`
      {
        "className": "z_zaclPW0 z-style-zaclPW-button",
      }
    `)
    expect(consumer.button({ className: 'external', style: undefined }))
      .toMatchInlineSnapshot(`
        {
          "className": "z_zaclPW0 z-style-zaclPW-button external",
        }
      `)
  })

  test('merges variable assignments in static, dynamic and HTML calls', async () => {
    const result = Transform.compile({
      moduleId: 'usage.ts',
      source: `
      import { Config, style, variable } from 'zyzz';
      const accent=variable();
      const {style: htmlStyle}=Config.create({output:'html'});
      const label=style({color:accent});
      const dynamic=style((input:{opacity:number})=>({color:accent,opacity:input.opacity}));
      const html=htmlStyle({color:accent});
      const vars=Object.freeze({[accent]:'red'});
      const inline=Object.freeze({[accent]:'blue',padding:'2px'});
      export const staticProps=label({vars,style:inline,className:'external'});
      export const dynamicProps=dynamic({opacity:0.5,vars,style:inline});
      export const htmlProps=html({vars});
      export const originals={vars,style:inline};
      export const variablesOnly=dynamic({opacity:0.5,vars});
      const htmlDynamic=htmlStyle((input:{opacity:number})=>({color:accent,opacity:input.opacity}));
      export const htmlDynamicProps=htmlDynamic({opacity:0.25,vars});
    `,
    })
    const bundle = await Esbuild.build({
      alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
      bundle: true,
      format: 'esm',
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })
    const consumer = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
    )

    expect(consumer.staticProps).toMatchInlineSnapshot(`
      {
        "className": "z_e2Ey6F0 external",
        "style": {
          "--z-accent": "blue",
          "padding": "2px",
        },
      }
    `)
    expect(consumer.dynamicProps).toMatchInlineSnapshot(`
      {
        "className": "z_e2Ey6F0 z_e2Ey6F1",
        "style": {
          "--z-accent": "blue",
          "--z-e2Ey6F-dynamic-opacity": 0.5,
          "padding": "2px",
        },
      }
    `)
    expect(consumer.htmlProps).toMatchInlineSnapshot(`
      {
        "class": "z_e2Ey6F0",
        "style": "--z-accent:red",
      }
    `)
    expect(consumer.variablesOnly).toMatchInlineSnapshot(`
      {
        "className": "z_e2Ey6F0 z_e2Ey6F1",
        "style": {
          "--z-accent": "red",
          "--z-e2Ey6F-dynamic-opacity": 0.5,
        },
      }
    `)
    expect(consumer.htmlDynamicProps).toMatchInlineSnapshot(`
      {
        "class": "z_e2Ey6F0 z_e2Ey6F2",
        "style": "--z-accent:red;--z-e2Ey6F-htmlDynamic-opacity:0.25",
      }
    `)
    expect(consumer.originals).toMatchInlineSnapshot(`
      {
        "style": {
          "--z-accent": "blue",
          "padding": "2px",
        },
        "vars": {
          "--z-accent": "red",
        },
      }
    `)
  })

  test('rewritten exports execute with overrides without runtime validation', async () => {
    const source = `import { style } from 'zyzz';
export const button = style({ color: '#f00', padding: '8px' });
export const inline = style({ color: '#fff' })();
export const text = '🎉';`
    const result = Transform.compile({ moduleId: 'example/button.ts', source })

    const bundle = await Esbuild.build({
      alias: { 'zyzz/runtime': Path.join(root, 'src/runtime/index.ts') },
      bundle: true,
      format: 'esm',
      metafile: true,
      stdin: { contents: result.code, loader: 'ts', resolveDir: root },
      write: false,
    })

    const consumer = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString('base64')}`
    )

    const bind = Props.create({ className: Object.values(result.classes)[0]! })
    const style = { color: '#000', paddingLeft: '2px' } as const

    expect(consumer.button()).toMatchInlineSnapshot(`
      {
        "className": "z_CVE4-Z0 z_CVE4-Z1 z-style-CVE4-Z-button",
      }
    `)

    expect(consumer.inline).toMatchInlineSnapshot(`
      {
        "className": "z_CVE4-Z2",
      }
    `)

    expect(
      !Object.keys(bundle.metafile!.inputs).some((name) =>
        /oxc|compiler|web\/Css/.test(name),
      ),
    ).toMatchInlineSnapshot(`true`)

    expect(consumer.button({ className: 'external', style }))
      .toMatchInlineSnapshot(`
        {
          "className": "z_CVE4-Z0 z_CVE4-Z1 z-style-CVE4-Z-button external",
          "style": {
            "color": "#000",
            "paddingLeft": "2px",
          },
        }
      `)

    expect(
      JSON.stringify(consumer.button({ className: 'external', style })) ===
        JSON.stringify(bind({ className: 'external', style })),
    ).toMatchInlineSnapshot(`true`)

    expect(
      JSON.stringify(result) ===
        JSON.stringify(
          Transform.compile({ moduleId: 'example/button.ts', source }),
        ),
    ).toMatchInlineSnapshot(`true`)

    expect(style).toMatchInlineSnapshot(`
    {
      "color": "#000",
      "paddingLeft": "2px",
    }
  `)

    expect(consumer.text).toMatchInlineSnapshot(`"🎉"`)

    const inline: CSSProperties = Object.freeze({
      opacity: undefined,
      padding: 12,
    })

    expect(bind({ style: inline }).style).toBe(inline)
    expect(consumer.button({ style: inline }).style).toEqual({
      opacity: undefined,
      padding: 12,
    })
    expect(consumer.button({ style: { padding: 'md' } }).style).toEqual({
      padding: 'md',
    })
  })
})
