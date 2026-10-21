/** Runs the Node API reference examples as host scripts and type-checks them against the published declarations. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import * as Url from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'
import { Source } from 'zyzz/compiler'
import { Host } from 'zyzz/node'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
let count = 0
let root = ''

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-node-api-'))
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

/** Reads a page's TypeScript examples in order, optionally from one section. */
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
    section.matchAll(/```(ts|sh)([^\n]*)\n([\s\S]*?)```/g),
    (match) => ({
      language: match[1]!,
      name: match[2]!.match(/title="([^"]+)"/)?.[1],
      source: match[3]!,
    }),
  )
}

/** Web sources, including files the host scan skips. */
const web = {
  'src/Button.test.ts': `export const skipped = true\n`,
  'src/Button.tsx': `import { style } from './zyzz.config.js'

export function Button() {
  return <button {...styles.button()} />
}

export namespace styles {
  export const button = style({
    '@media (width >= 40rem)': { padding: 24 },
    color: 'ink',
    padding: 16,
    userSelect: 'none',
  })
}
`,
  'src/fixtures/Data.ts': `export const skipped = true\n`,
  'src/types.d.ts': `export type Skipped = true\n`,
  'src/zyzz.config.ts': `import { defineConfig } from 'zyzz'

export const { style, vars } = defineConfig({
  vars: { color: { ink: { dark: '#eeeeee', light: '#111111' } } },
})
`,
}

/** A native source that reads a token, a font family, a rem length, and platform branches. */
const native = {
  'src/Label.ts': `import { style } from './zyzz.config.js'

export const label = style({
  color: 'ink',
  fontFamily: 'Inter, sans-serif',
  padding: '1rem',
  targets: { android: { marginTop: 2 }, ios: { marginTop: 8 } },
})
`,
  'src/zyzz.config.ts': web['src/zyzz.config.ts'],
}

/** A native source that reads only a token, for examples without font or unit mappings. */
const token = {
  'src/Label.ts': `import { style } from './zyzz.config.js'

export const label = style({ color: 'ink' })
`,
  'src/zyzz.config.ts': web['src/zyzz.config.ts'],
}

/** Writes a project directory and returns readers for its output. */
async function fixture(
  files: Readonly<Record<string, string>> = web,
  outDir = 'dist',
) {
  const directory = Path.join(root, String(count++))
  for (const [name, source] of Object.entries(files)) {
    await Fs.mkdir(Path.dirname(Path.join(directory, name)), {
      recursive: true,
    })
    await Fs.writeFile(Path.join(directory, name), source)
  }

  return {
    directory,
    /** Lists output files relative to the output directory, without the control files that build results omit. */
    async files() {
      const entries = await Fs.readdir(Path.join(directory, outDir), {
        recursive: true,
        withFileTypes: true,
      })
      return entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.zyzz'))
        .map((entry) =>
          Path.relative(
            Path.join(directory, outDir),
            Path.join(entry.parentPath, entry.name),
          ),
        )
        .sort()
    },
    read(file: string) {
      return Fs.readFile(Path.join(directory, outDir, file), 'utf8')
    },
  }
}

/**
 * Runs a host script inside a project. Relative `root`, `outDir`, and
 * `script` paths resolve in the project, which the working directory cannot
 * do for scripts imported by the test runner.
 */
async function run(directory: string, source: string) {
  const resolved = source.replace(
    /\b(outDir|root|script): '([^']+)'/g,
    (_, key: string, path: string) =>
      `${key}: ${JSON.stringify(Path.join(directory, path))}`,
  )
  const file = Path.join(directory, `script-${count++}.ts`)
  await Fs.writeFile(
    file,
    resolved.includes('outDir:')
      ? resolved
      : resolved.replace(
          'Host.create({',
          `Host.create({ outDir: ${JSON.stringify(Path.join(directory, 'dist'))},`,
        ),
  )

  return import(/* @vite-ignore */ Url.pathToFileURL(file).href)
}

/** Wraps a one-line `Host.create` call, or the options fragment of one, in a complete build script. */
function script(snippet: string) {
  const code = snippet
    .split('\n')
    .filter((line) => line && !line.startsWith('//'))
    .join('\n')
  const call = code.startsWith('Host.create(')
    ? code
    : `Host.create({ ${code}, packageId: 'my-app', root: 'src' })`

  return `import { defineVars } from 'zyzz'
import { Host } from 'zyzz/node'

const brand = defineVars({ color: { ink: { dark: '#a8c7fa', light: '#0b57d0' } } })

await using host = await ${call}

await host.build()
`
}

/** Polls an observable condition until it holds or the bound elapses. */
async function until<value>(
  read: () => Promise<value | undefined>,
  timeout = 10_000,
) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the watched output.')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('Host.create API page', () => {
  test('builds the overview example and releases the lock', async () => {
    const [overview] = await examples('create')
    const project = await fixture()

    await run(project.directory, overview!.source)

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
    expect(
      (await Fs.readdir(Path.join(project.directory, 'dist'))).includes(
        '.zyzz-lock',
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('lists the documented output layout', async () => {
    const [layout] = await examples('create', 'Output Layout')
    const project = await fixture()

    await run(
      project.directory,
      script(`Host.create({ packageId: 'my-app', root: 'src' })`),
    )

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
    expect(
      layout!.source
        .split('\n')
        .filter((line) => line.startsWith('dist/'))
        .map((line) => line.slice('dist/'.length)),
    ).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('scans the root and records the package ID', async () => {
    const [scan] = await examples('create', 'options.root')
    const [identity] = await examples('create', 'options.packageId')
    const scanned = await fixture()
    const identified = await fixture()

    await run(scanned.directory, script(scan!.source))
    await run(identified.directory, script(identity!.source))

    expect(
      (await scanned.files()).filter((file) => /Data|test|types/.test(file)),
    ).toMatchInlineSnapshot(`[]`)
    expect(
      JSON.parse(await identified.read('.zyzz.json')).packageId,
    ).toMatchInlineSnapshot(`"my-app"`)
    await expect(
      run(
        identified.directory,
        script(`Host.create({ packageId: 'other-app', root: 'src' })`),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Invalid output ownership manifest.]`,
    )
  })

  test('publishes to a custom output directory', async () => {
    const [outDir] = await examples('create', 'options.outDir')
    const project = await fixture(web, 'out')

    await run(project.directory, script(outDir!.source))

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('processes stylesheets with Lightning CSS options', async () => {
    const [disabled] = await examples('create', 'options.css')
    const [minify] = await examples('create', 'options.css.minify')
    const [targets] = await examples('create', 'options.css.targets')
    const intermediate = await fixture()
    const minified = await fixture()
    const targeted = await fixture()

    await run(intermediate.directory, script(disabled!.source))
    await run(minified.directory, minify!.source)
    await run(targeted.directory, targets!.source)

    expect(await intermediate.read('Button.tsx.css')).toMatchInlineSnapshot(`
      ".z-theme-theme{--z-color-ink:light-dark(#111111,#eeeeee);}
      .z_scheme-dark{color-scheme:dark;}
      .z_scheme-light{color-scheme:light;}
      .z_scheme-light-dark{color-scheme:light dark;}
      @media (width >= 40rem){.z_KzKfXR0{padding:24;}}
      .z_KzKfXR1{color:var(--z-color-ink,light-dark(#111111,#eeeeee));}
      .z_KzKfXR2{padding:16;}
      .z_KzKfXR3{user-select:none;}"
    `)
    expect(await minified.read('Button.tsx.css')).toMatchInlineSnapshot(
      `".z-theme-theme{--z-color-ink:light-dark(#111,#eee)}.z_scheme-dark{color-scheme:dark}.z_scheme-light{color-scheme:light}.z_scheme-light-dark{color-scheme:light dark}@media (width>=40rem){.z_KzKfXR0{padding:24px}}.z_KzKfXR1{color:var(--z-color-ink,light-dark(#111,#eee))}.z_KzKfXR2{padding:16px}.z_KzKfXR3{user-select:none}"`,
    )
    expect(await targeted.read('Button.tsx.css')).toMatchInlineSnapshot(`
      ".z-theme-theme {
        --z-color-ink: var(--lightningcss-light, #111) var(--lightningcss-dark, #eee);
      }

      .z_scheme-dark {
        --lightningcss-light: ;
        --lightningcss-dark: initial;
        color-scheme: dark;
      }

      .z_scheme-light {
        --lightningcss-light: initial;
        --lightningcss-dark: ;
        color-scheme: light;
      }

      .z_scheme-light-dark {
        --lightningcss-light: initial;
        --lightningcss-dark: ;
        color-scheme: light dark;
      }

      @media (prefers-color-scheme: dark) {
        .z_scheme-light-dark {
          --lightningcss-light: ;
          --lightningcss-dark: initial;
        }
      }

      @media (min-width: 40rem) {
        .z_KzKfXR0 {
          padding: 24px;
        }
      }

      .z_KzKfXR1 {
        color: var(--z-color-ink, var(--lightningcss-light, #111) var(--lightningcss-dark, #eee));
      }

      .z_KzKfXR2 {
        padding: 16px;
      }

      .z_KzKfXR3 {
        -webkit-user-select: none;
        user-select: none;
      }
      "
    `)
  })

  test('leaves external imports for downstream tooling', async () => {
    const [external] = await examples('create', 'options.external')
    const files = {
      'src/Icon.ts': `import icon from '~icons/lucide/eye'\n\nexport const eye = icon\n`,
    }
    const unresolved = await fixture(files)
    const kept = await fixture(files)

    const unresolvedError = await run(
      unresolved.directory,
      script(`Host.create({ packageId: 'my-app', root: 'src' })`),
    ).catch((error: Error) =>
      error.message.replace(unresolved.directory, '<project>'),
    )

    expect(unresolvedError).toMatchInlineSnapshot(
      `"my-app/Icon.ts:0: Unable to resolve "~icons/lucide/eye" from <project>/src/Icon.ts: Cannot find module '~icons/lucide/eye'"`,
    )

    await run(kept.directory, external!.source)

    const builtin = await fixture({
      'src/Files.ts': `import * as Fs from 'fs'\n\nexport const read = Fs.readFileSync\n`,
    })
    await run(
      builtin.directory,
      script(`Host.create({ packageId: 'my-app', root: 'src' })`),
    )

    expect(await builtin.read('Files.ts')).toMatchInlineSnapshot(`
      "import * as Fs from 'fs'

      export const read = Fs.readFileSync
      "
    `)

    expect(await kept.read('Icon.ts')).toMatchInlineSnapshot(`
      "import icon from '~icons/lucide/eye'

      export const eye = icon
      "
    `)
  })

  test('writes the initialization script outside the output', async () => {
    const [public_] = await examples('create', 'options.script')
    const project = await fixture()
    const foreign = await fixture()
    await Fs.mkdir(Path.join(foreign.directory, 'public'))
    await Fs.writeFile(
      Path.join(foreign.directory, 'public/zyzz.js'),
      'console.log(1)\n',
    )

    await run(project.directory, public_!.source)

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
      ]
    `)
    expect(
      (
        await Fs.readFile(
          Path.join(project.directory, 'public/zyzz.js'),
          'utf8',
        )
      ).split('\n')[0],
    ).toMatchInlineSnapshot(`"/* zyzz initialization */"`)
    const refused = await run(foreign.directory, public_!.source).catch(
      (error: Error) => error.message.replace(foreign.directory, '<project>'),
    )

    expect(refused).toMatchInlineSnapshot(
      `"Refusing to replace a foreign script: <project>/public/zyzz.js"`,
    )
  })

  test('publishes unchanged modules or stylesheets alone', async () => {
    const [compiler] = await examples('create', 'options.compiler')
    const [modules] = await examples('create', 'options.modules')
    const named = {
      'src/Button.tsx': web['src/Button.tsx'],
      'src/zyzz.config.ts': web['src/zyzz.config.ts'].replace(
        'defineConfig({',
        "defineConfig({\n  id: 'app',",
      ),
    }
    const unchanged = await fixture(named)
    const stylesheets = await fixture(named)
    const unnamed = await fixture()

    await run(unchanged.directory, script(compiler!.source))
    await run(stylesheets.directory, script(modules!.source))

    expect(await unchanged.read('Button.tsx')).toMatchInlineSnapshot(`
      "import { style } from './zyzz.config.js'

      export function Button() {
        return <button {...styles.button()} />
      }

      export namespace styles {
        export const button = style({
          '@media (width >= 40rem)': { padding: 24 },
          color: 'ink',
          padding: 16,
          userSelect: 'none',
        })
      }
      "
    `)
    expect(await stylesheets.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx.css",
        "Button.tsx.css.map",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
        "zyzz.shared.css",
        "zyzz.shared.css.map",
      ]
    `)
    await expect(
      run(unnamed.directory, script(compiler!.source)),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: CSS-only themes require an explicit id on Config.create or Vars.define.]`,
    )

    const keyframes = await fixture({
      'src/Fade.ts': `import { keyframes } from 'zyzz/web'\n\nexport const fade = keyframes({ from: { opacity: 0 }, to: { opacity: 1 } })\n`,
    })

    await expect(
      run(keyframes.directory, script(compiler!.source)),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: CSS-only named stylesheet declarations require an explicit id.]`,
    )
  })

  test('compiles native tables for the selected context', async () => {
    const [context] = await examples('create', 'options.native')
    const [sets] = await examples('create', 'options.native.vars')
    const [scheme] = await examples('create', 'options.native.colorScheme')
    const [platform] = await examples('create', 'options.native.platform')
    const [contextual] = await examples('create', 'options.native.contextual')
    const ios = await fixture(native, 'dist-native')

    await run(ios.directory, context!.source)

    expect(await ios.files()).toMatchInlineSnapshot(`
      [
        "Label.ts",
        "Label.ts.map",
        "Label.ts.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
      ]
    `)
    expect(
      (await ios.read('Label.ts')).match(
        /__zyzzNative\.create\((\{.*\})\)/,
      )![1],
    ).toMatchInlineSnapshot(
      `"{"axes":{},"defaults":{},"styles":{"0":{"color":"#eeeeee","fontFamily":"Inter-Regular","paddingTop":16,"paddingRight":16,"paddingBottom":16,"paddingLeft":16,"marginTop":8}}}"`,
    )

    const brand = await fixture(token, 'dist-native')
    await run(brand.directory, sets!.source)

    expect(
      (await brand.read('Label.ts')).match(
        /__zyzzNative\.create\((\{.*\})\)/,
      )![1],
    ).toMatchInlineSnapshot(
      `"{"axes":{},"defaults":{},"styles":{"0":{"color":"#111111"}}}"`,
    )

    const light = await fixture(token)
    await run(light.directory, script(scheme!.source))

    expect(
      (await light.read('Label.ts')).match(/"color":"[^"]+"/)![0],
    ).toMatchInlineSnapshot(`""color":"#111111""`)

    const android = await fixture({
      ...token,
      'src/Label.ts': `import { style } from './zyzz.config.js'\n\nexport const label = style({ targets: { android: { marginTop: 2 }, ios: { marginTop: 8 } } })\n`,
    })
    await run(android.directory, script(platform!.source))

    expect(
      (await android.read('Label.ts')).match(/"marginTop":\d+/)![0],
    ).toMatchInlineSnapshot(`""marginTop":2"`)

    const provided = await fixture(token)
    await run(provided.directory, script(contextual!.source))

    expect(
      (await provided.read('Label.ts')).match(/^import .*$/m)![0],
    ).toMatchInlineSnapshot(
      `"import {Native as __zyzzNative,NativeContext as __zyzzNativeContext} from 'zyzz/runtime';"`,
    )
  })

  test('maps native fonts and units, and selects sets', async () => {
    const [fonts] = await examples('create', 'options.native.fonts')
    const [units] = await examples('create', 'options.native.units')
    const [set] = await examples('create', 'options.native.set')
    const family = await fixture({
      ...token,
      'src/Label.ts': `import { style } from './zyzz.config.js'\n\nexport const label = style({ fontFamily: 'Inter, sans-serif' })\n`,
    })
    const length = await fixture({
      ...token,
      'src/Label.ts': `import { style } from './zyzz.config.js'\n\nexport const label = style({ marginTop: '1rem' })\n`,
    })
    const selected = await fixture(token)

    await run(family.directory, script(fonts!.source))
    await run(length.directory, script(units!.source))
    await run(selected.directory, script(set!.source))

    expect(
      (await family.read('Label.ts')).match(/"fontFamily":"[^"]+"/)![0],
    ).toMatchInlineSnapshot(`""fontFamily":"Inter-Regular""`)
    expect(
      (await length.read('Label.ts')).match(/"marginTop":\d+/)![0],
    ).toMatchInlineSnapshot(`""marginTop":16"`)
    expect(
      (await selected.read('Label.ts')).match(/"color":"[^"]+"/)![0],
    ).toMatchInlineSnapshot(`""color":"#111111""`)
    await expect(
      run(
        selected.directory,
        script(`native: { colorScheme: 'light', set: 'missing' }`),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[StyleSheet.SelectionError: Select an existing set label and light or dark colorScheme.]`,
    )

    const contextual = await fixture(token)
    await run(
      contextual.directory,
      script(
        `native: { colorScheme: 'light', contextual: true, set: 'missing' }`,
      ),
    )

    expect(
      (await contextual.read('Label.ts')).match(/\}\},"[^"]+"\)/)![0],
    ).toMatchInlineSnapshot(`"}},"missing")"`)
  })

  test('reads installed package metadata beside its entry', async () => {
    const [layout] = await examples('create', 'Package Imports')
    const library = await fixture({
      'src/theme.ts': `import { defineConfig } from 'zyzz'\n\nexport const { style } = defineConfig({ id: 'lib', vars: { color: { brand: '#06c' } } })\n`,
    })
    await run(
      library.directory,
      script(`Host.create({ packageId: 'my-library', root: 'src' })`),
    )

    const application = await fixture({
      'src/Badge.ts': `import { style } from 'my-library'\n\nexport const badge = style({ color: 'brand' })\n`,
    })
    const modules = Path.join(application.directory, 'node_modules/my-library')
    await Fs.mkdir(modules, { recursive: true })
    await Fs.writeFile(
      Path.join(modules, 'package.json'),
      JSON.stringify({
        exports: './theme.js',
        name: 'my-library',
        type: 'module',
      }),
    )
    await Fs.writeFile(
      Path.join(modules, 'theme.js'),
      'export const style = () => ({})\n',
    )
    await Fs.copyFile(
      Path.join(library.directory, 'dist/theme.ts.zyzz.json'),
      Path.join(modules, 'theme.js.zyzz.json'),
    )

    await run(
      application.directory,
      script(`Host.create({ packageId: 'my-app', root: 'src' })`),
    )

    expect(
      layout!.source
        .split('\n')
        .filter((line) => line.startsWith('node_modules/')),
    ).toMatchInlineSnapshot(`
      [
        "node_modules/my-library/theme.js",
        "node_modules/my-library/theme.js.zyzz.json",
      ]
    `)
    expect(await application.read('Badge.ts.css')).toMatchInlineSnapshot(`
      ".z-theme-lib-theme {
        --z-lib-color-brand: #06c;
      }

      .z_lib-1T9aMu0 {
        color: var(--z-lib-color-brand, #06c);
      }
      "
    `)
  })

  test('rejects invalid options at creation', async () => {
    const project = await fixture()
    const create = (options: Partial<Host.create.Options>) =>
      Host.create({
        outDir: Path.join(project.directory, 'dist'),
        packageId: 'my-app',
        root: Path.join(project.directory, 'src'),
        ...options,
      })

    await expect(
      create({ outDir: project.directory }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Output must not contain the source directory.]`,
    )
    await expect(
      create({ script: Path.join(project.directory, 'src/zyzz.js') }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: The script path must not be inside the source directory.]`,
    )
    await expect(
      create({ external: ['~icons/*/svg'] }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: External imports require exact names or a trailing * prefix.]`,
    )
    await expect(
      create({ modules: false, native: { colorScheme: 'light' } }),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Native builds require rewritten module output.]`,
    )

    await using host = await create({})

    const locked = await create({}).catch((error: Error) =>
      error.message.replace(project.directory, '<project>'),
    )

    expect(locked).toMatchInlineSnapshot(
      `"EEXIST: file already exists, open '<project>/dist/.zyzz-lock'"`,
    )
    expect(host.close === host[Symbol.asyncDispose]).toMatchInlineSnapshot(
      `true`,
    )
  })
})

describe('build API page', () => {
  test('builds the overview example', async () => {
    const [overview] = await examples('create/build')
    const project = await fixture()

    await run(project.directory, overview!.source)

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('reports changed files and removes outputs of deleted modules', async () => {
    const project = await fixture()
    await using host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })
    await host.build()

    expect((await host.build()).changed).toMatchInlineSnapshot(`[]`)

    await Fs.writeFile(
      Path.join(project.directory, 'src/Badge.ts'),
      `import { style } from 'zyzz'\n\nexport const badge = style({ margin: 4 })\n`,
    )
    expect((await host.build()).changed).toMatchInlineSnapshot(`
      [
        "Badge.ts",
        "Badge.ts.css",
        "Badge.ts.css.map",
        "Badge.ts.map",
        "Badge.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
      ]
    `)

    await Fs.rm(Path.join(project.directory, 'src/Badge.ts'))
    const removed = await host.build()

    expect(removed.changed).toMatchInlineSnapshot(`
      [
        "Badge.ts",
        "Badge.ts.css",
        "Badge.ts.css.map",
        "Badge.ts.map",
        "Badge.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
      ]
    `)
    expect(removed.files).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('keeps the previous output after a failed build', async () => {
    const project = await fixture()
    await using host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })
    await host.build()
    const before = await project.read('Button.tsx.css')

    await Fs.writeFile(
      Path.join(project.directory, 'src/Button.tsx'),
      `import { style } from 'zyzz'\n\nexport const button = style({ padding: size })\n`,
    )
    const error = await host.build().catch((error: unknown) => error)

    expect(error instanceof Source.ExtractError).toMatchInlineSnapshot(`true`)
    expect(error).toMatchInlineSnapshot(
      `[Source.ExtractError: my-app/Button.tsx:69: Expected a literal string or number; expressions are not evaluated.]`,
    )
    expect(
      (await project.read('Button.tsx.css')) === before,
    ).toMatchInlineSnapshot(`true`)
  })

  test('refuses to replace edited output', async () => {
    const [edit] = await examples('create/build', 'Ownership')
    const project = await fixture()
    await run(
      project.directory,
      script(`Host.create({ packageId: 'my-app', root: 'src' })`),
    )

    expect(edit!.source).toMatchInlineSnapshot(`
      "# An edited output blocks the next build until it is restored or deleted
      echo '/* edited */' > dist/Button.tsx.css
      "
    `)

    await Fs.writeFile(
      Path.join(project.directory, 'dist/Button.tsx.css'),
      '/* edited */\n',
    )
    await Fs.writeFile(
      Path.join(project.directory, 'src/Button.tsx'),
      web['src/Button.tsx'].replace('padding: 16', 'padding: 20'),
    )

    await expect(
      run(
        project.directory,
        script(`Host.create({ packageId: 'my-app', root: 'src' })`),
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Refusing to replace an unowned or modified output: Button.tsx.css]`,
    )
    expect(
      Object.keys(JSON.parse(await project.read('.zyzz.json')).files).sort(),
    ).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })
})

describe('watch API page', () => {
  test('rebuilds the overview example until SIGINT', async () => {
    const [overview] = await examples('create/watch')
    const [added] = await examples('create/watch', 'Watched Paths')
    const project = await fixture()

    const running = run(project.directory, overview!.source)
    try {
      const initial = await until(() => project.read('Button.tsx.css'))

      await Fs.writeFile(
        Path.join(project.directory, 'src/Button.tsx'),
        web['src/Button.tsx'].replace('padding: 16', 'padding: 20'),
      )
      const rebuilt = await until(async () => {
        const css = await project.read('Button.tsx.css')
        return css === initial ? undefined : css
      })

      expect(rebuilt.match(/padding: \d+px/g)).toMatchInlineSnapshot(`
        [
          "padding: 24px",
          "padding: 20px",
        ]
      `)

      expect(added!.source).toMatchInlineSnapshot(`
        "# Adding a module triggers a build that publishes its output
        mkdir src/forms && echo "export const id = 'field'" > src/forms/Field.ts
        "
      `)
      await Fs.mkdir(Path.join(project.directory, 'src/forms'))
      await Fs.writeFile(
        Path.join(project.directory, 'src/forms/Field.ts'),
        `export const id = 'field'\n`,
      )

      expect(await until(() => project.read('forms/Field.ts')))
        .toMatchInlineSnapshot(`
        "export const id = 'field'
        "
      `)
    } finally {
      // Stops the example's watchers and releases its lock even after a failure.
      process.emit('SIGINT')
      await running
    }

    expect(
      (await Fs.readdir(Path.join(project.directory, 'dist'))).includes(
        '.zyzz-lock',
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('reports failures and recovers after a corrected source', async () => {
    const project = await fixture()
    const events: Host.Event[] = []
    await using host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })
    host.watch({ onResult: (event) => events.push(event) })
    await until(async () => (events.length ? true : undefined))

    // An editor's atomic save replaces the file, so no build reads it half written.
    const draft = Path.join(project.directory, 'Button.tsx.draft')
    await Fs.writeFile(
      draft,
      `import { style } from 'zyzz'\n\nexport const button = style({ padding: size })\n`,
    )
    await Fs.rename(draft, Path.join(project.directory, 'src/Button.tsx'))
    const failure = await until(async () =>
      events.find((event) => 'error' in event),
    )

    expect(failure).toMatchInlineSnapshot(`
      {
        "error": [Source.ExtractError: my-app/Button.tsx:69: Expected a literal string or number; expressions are not evaluated.],
      }
    `)
    expect((await project.read('Button.tsx.css')).match(/padding: \d+px/g))
      .toMatchInlineSnapshot(`
      [
        "padding: 24px",
        "padding: 16px",
      ]
    `)

    await Fs.writeFile(
      Path.join(project.directory, 'src/Button.tsx'),
      web['src/Button.tsx'].replace('padding: 16', 'padding: 20'),
    )

    expect(
      await until(async () => {
        const css = await project.read('Button.tsx.css')
        return css.includes('padding: 20px') ? 'recovered' : undefined
      }),
    ).toMatchInlineSnapshot(`"recovered"`)
  })

  test('fails when installed metadata disappears and recovers when restored', async () => {
    const project = await fixture({
      'src/Badge.ts': `import { style } from 'my-library'\n\nexport const badge = style({ color: 'brand' })\n`,
    })
    const library = await fixture({
      'src/theme.ts': `import { defineConfig } from 'zyzz'\n\nexport const { style } = defineConfig({ id: 'lib', vars: { color: { brand: '#06c' } } })\n`,
    })
    await run(
      library.directory,
      script(`Host.create({ packageId: 'my-library', root: 'src' })`),
    )
    const modules = Path.join(project.directory, 'node_modules/my-library')
    const metadata = Path.join(modules, 'theme.js.zyzz.json')
    await Fs.mkdir(modules, { recursive: true })
    await Fs.writeFile(
      Path.join(modules, 'package.json'),
      JSON.stringify({
        exports: './theme.js',
        name: 'my-library',
        type: 'module',
      }),
    )
    await Fs.writeFile(
      Path.join(modules, 'theme.js'),
      'export const style = () => ({})\n',
    )
    await Fs.copyFile(
      Path.join(library.directory, 'dist/theme.ts.zyzz.json'),
      metadata,
    )

    const events: Host.Event[] = []
    await using host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })
    host.watch({ onResult: (event) => events.push(event) })
    await until(async () => (events.length ? true : undefined))
    const contract = await Fs.readFile(metadata, 'utf8')

    await Fs.rm(metadata)
    const failure = await until(async () =>
      events.find((event) => 'error' in event),
    )

    expect(
      (failure as { error: Error }).error.message.replace(
        project.directory,
        '<project>',
      ),
    ).toMatchInlineSnapshot(
      `"my-app/Badge.ts:0: ENOENT: no such file or directory, stat '<project>/node_modules/my-library/theme.js.zyzz.json'"`,
    )

    const failed = events.length
    await Fs.writeFile(metadata, contract)

    expect(
      await until(async () =>
        events.slice(failed).some((event) => 'result' in event)
          ? 'recovered'
          : undefined,
      ),
    ).toMatchInlineSnapshot(`"recovered"`)
  })

  test('rejects a second watch and watching after close', async () => {
    const project = await fixture()
    const host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })
    host.watch({ onResult() {} })

    expect(() =>
      host.watch({ onResult() {} }),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: Host is already watching.]`)

    await host.close()

    expect(() =>
      host.watch({ onResult() {} }),
    ).toThrowErrorMatchingInlineSnapshot(`[Error: Host is closed.]`)
  })
})

describe('close API page', () => {
  test('releases the lock after the overview and disposal examples', async () => {
    const [overview] = await examples('create/close')
    const [disposal] = await examples('create/close', 'Disposal')
    const closed = await fixture()
    const disposed = await fixture()

    await run(closed.directory, overview!.source)
    await run(disposed.directory, disposal!.source)

    expect(
      (await Fs.readdir(Path.join(closed.directory, 'dist'))).includes(
        '.zyzz-lock',
      ),
    ).toMatchInlineSnapshot(`false`)
    expect(
      (await Fs.readdir(Path.join(disposed.directory, 'dist'))).includes(
        '.zyzz-lock',
      ),
    ).toMatchInlineSnapshot(`false`)
  })

  test('publishes queued builds before closing', async () => {
    const project = await fixture()
    const host = await Host.create({
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    })

    void host.build()
    const closing = host.close()

    expect(host.close() === closing).toMatchInlineSnapshot(`true`)

    await closing

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
    await expect(host.build()).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: Host is closed.]`,
    )
  })

  test('keeps output for the same package ID and leaves a stale lock blocking', async () => {
    const project = await fixture()
    const options = {
      outDir: Path.join(project.directory, 'dist'),
      packageId: 'my-app',
      root: Path.join(project.directory, 'src'),
    }
    {
      await using host = await Host.create(options)
      await host.build()
    }
    {
      await using host = await Host.create(options)

      expect((await host.build()).changed).toMatchInlineSnapshot(`[]`)
    }

    await Fs.writeFile(Path.join(project.directory, 'dist/.zyzz-lock'), '')

    const stale = await Host.create(options).catch((error: Error) =>
      error.message.replace(project.directory, '<project>'),
    )

    expect(stale).toMatchInlineSnapshot(
      `"EEXIST: file already exists, open '<project>/dist/.zyzz-lock'"`,
    )
  })
})

describe('Host API page', () => {
  test('builds the overview example', async () => {
    const [overview] = await examples('namespaces/Host')
    const project = await fixture()

    await run(project.directory, overview!.source)

    expect(await project.files()).toMatchInlineSnapshot(`
      [
        "Button.tsx",
        "Button.tsx.css",
        "Button.tsx.css.map",
        "Button.tsx.map",
        "Button.tsx.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('passes native compiler errors through', async () => {
    const reject = (
      files: Readonly<Record<string, string>>,
      options: Host.create.Options['native'],
    ) =>
      fixture(files).then(async (project) => {
        await using host = await Host.create({
          native: options,
          outDir: Path.join(project.directory, 'dist'),
          packageId: 'my-app',
          root: Path.join(project.directory, 'src'),
        })
        return host.build().catch((error: Error) => error.name)
      })

    expect(
      await reject(
        {
          'src/Label.ts': `import { global } from 'zyzz/web'\n\nexport const base = global({ body: { margin: 0 } })\n`,
        },
        { colorScheme: 'light' },
      ),
    ).toMatchInlineSnapshot(`"Native.CompileError"`)
    expect(
      await reject(
        {
          'src/Label.ts': `import { style } from 'zyzz'\n\nexport const label = style({ marginTop: '1rem' })\n`,
        },
        { colorScheme: 'light' },
      ),
    ).toMatchInlineSnapshot(`"StyleSheet.CompileError"`)
    expect(
      await reject(token, { colorScheme: 'light', set: 'missing' }),
    ).toMatchInlineSnapshot(`"StyleSheet.SelectionError"`)
  })
})

describe('node API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      [
        'create',
        'create/build',
        'create/watch',
        'create/close',
        'namespaces/Host',
      ].map((page) => examples(page)),
    )
    const files = await Promise.all(
      pages
        .flat()
        // Twoslash blocks that declare expected errors are checked by the site build.
        .filter(
          (example) =>
            example.language === 'ts' &&
            example.source.includes('import ') &&
            !example.source.includes('// @errors'),
        )
        .map(async (example, index) => {
          const directory = Path.join(root, 'types', String(index))
          const file = Path.join(directory, example.name ?? 'example.ts')
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
        '--module',
        'preserve',
        '--moduleResolution',
        'bundler',
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        '--types',
        'node',
        ...files,
      ],
      { cwd: root, encoding: 'utf8', timeout: 30000 },
    )

    expect(files.length).toMatchInlineSnapshot(`18`)
    expect(checked.stdout + checked.stderr).toMatchInlineSnapshot(`""`)
    expect(checked.status).toMatchInlineSnapshot(`0`)
  }, 60_000)
})
