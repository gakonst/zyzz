/** Exercises shared projects through the full Wasm compiler and native graph boundary. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import LZString from 'lz-string'
import { beforeAll, describe, expect, test } from 'vite-plus/test'
import { Graph } from 'zyzz/compiler'
import * as Compiler from './Compiler.js'
import * as Project from './Project.js'

let compiler: ReturnType<typeof Compiler.create>

beforeAll(() => {
  ChildProcess.execFileSync('node', ['scripts/build-playground.ts'], {
    cwd: new URL('../..', import.meta.url),
    stdio: 'pipe',
  })
  compiler = Compiler.create(
    Fs.readFileSync(new URL('../../../binding/compiler.wasm', import.meta.url)),
  )
}, 300_000)

describe('create', () => {
  test('compiles shared multi-file projects with native output parity', () => {
    for (const name of Object.keys(Project.examples)) {
      const project = Project.create(name)
      const restored = Project.decode(Project.encode(project))
      expect(
        JSON.stringify(restored) === JSON.stringify(project),
      ).toMatchInlineSnapshot('true')
      const browser = compiler.compile(restored.files)
      const native = Graph.compile({ modules: project.files })
      for (const [path, module] of Object.entries(native.modules))
        expect(browser.files[path] === module.code).toMatchInlineSnapshot(
          'true',
        )
      expect(
        browser.css.includes('light-dark(#0072f5,#52a8ff)'),
      ).toMatchInlineSnapshot('true')
      expect(browser.css.includes('background-color:')).toMatchInlineSnapshot(
        'true',
      )
    }
  })

  test('compiles added files after sharing reordered tabs and restores legacy links', () => {
    const project = Project.addFile(Project.create('Styles'), 'Badge.tsx')
    project.files['Badge.tsx'] =
      `import { style } from './zyzz.config.js'; const badge = style({ paddingLeft: '13px !custom' }); export default function Badge() { return <span {...badge()}>Added file</span> }`
    project.files['App.tsx'] =
      `import Badge from './Badge.js'; export default function App() { return <Badge /> }`
    const original = compiler.compile(project.files)
    project.order = ['Badge.tsx', 'App.tsx', 'Logo.tsx', 'zyzz.config.ts']
    const restored = Project.decode(Project.encode(project))
    expect(restored.framework).toMatchInlineSnapshot('"react"')
    expect(restored.order).toMatchInlineSnapshot(`
      [
        "Badge.tsx",
        "App.tsx",
        "Logo.tsx",
        "zyzz.config.ts",
      ]
    `)
    expect(
      compiler.compile(restored.files).css === original.css,
    ).toMatchInlineSnapshot('true')
    expect(original.css.includes('padding-left:13px')).toMatchInlineSnapshot(
      'true',
    )
    expect(
      compiler
        .compile(restored.files)
        .files['Badge.tsx']?.includes('Added file'),
    ).toMatchInlineSnapshot('true')
    expect(() =>
      Project.addFile(restored, 'Badge.tsx'),
    ).toThrowErrorMatchingInlineSnapshot('[Error: That file already exists.]')
    expect(() =>
      Project.addFile(restored, 'index.tsx'),
    ).toThrowErrorMatchingInlineSnapshot(
      '[Error: Use a top-level .ts, .tsx, .js, or .jsx filename. index.* is reserved.]',
    )

    const legacy = Project.decode(
      LZString.compressToEncodedURIComponent(
        JSON.stringify({ version: 1, files: Project.examples.Styles!.files }),
      ),
    )
    expect(legacy.framework).toMatchInlineSnapshot('"react"')
    expect(
      compiler.compile(legacy.files).css.includes('#0072f5'),
    ).toMatchInlineSnapshot('true')
  })

  test('reports invalid source and recovers on the next edited project', () => {
    const files = { 'App.tsx': 'export default function App( {' }
    expect(() =>
      compiler.compile(
        Project.decode(
          Project.encode({ files, framework: 'react', order: ['App.tsx'] }),
        ).files,
      ),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Compiler.CompileError: Source.ExtractError: App.tsx:30: Expected \`}\` but found \`EOF\`]`,
    )
    const fixed = compiler.compile({
      'App.tsx': `import { style } from 'zyzz'; export const box = style({ paddingTop: '7px', paddingLeft: '13px' }); export default function App() { return <div {...box()}>修正 ✓</div> }`,
    })
    expect(fixed.css).toMatchInlineSnapshot(`
      ".z_l0kPgl0{padding-top:7px;}
      .z_l0kPgl1{padding-left:13px;}"
    `)
    expect(fixed.files['App.tsx']?.includes('修正 ✓')).toMatchInlineSnapshot(
      'true',
    )
  })

  test('preserves located Base UI diagnostics across files and Unicode source', () => {
    const source = `// 😀
import { Select } from '@base-ui/react/select'
import { style } from 'zyzz/base-ui/react'
export const popup = style(Select.Popup, {
  states: { side: { botom: { color: 'red' } } },
})`
    const files = {
      'App.tsx': "export { popup } from './Popup.js'",
      'Popup.tsx': source,
    }
    const diagnostics = (() => {
      try {
        compiler.compile(files)
      } catch (error) {
        if (error instanceof Compiler.CompileError) return error.diagnostics
        throw error
      }
      return []
    })()

    expect(diagnostics).toMatchInlineSnapshot(`
      [
        {
          "code": "unsupported_syntax",
          "end": 182,
          "message": "Unknown Base UI state value: side.botom.",
          "source": "Popup.tsx",
          "start": 159,
        },
      ]
    `)

    const fixed = compiler.compile({
      ...files,
      'Popup.tsx': source.replace('botom', 'bottom'),
    })
    expect(fixed.css).toMatchInlineSnapshot(
      `".z_NIbkau0{&[data-side="bottom"]{color:red;}}"`,
    )
  })
})
