/** Runs the integration and CLI API reference examples through real bundlers, Babel, and the published CLI. @module */
import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Module from 'node:module'
import * as Path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test'

const project = Path.resolve(import.meta.dirname, '../../../../../..')
const require = Module.createRequire(import.meta.url)
const expo = Module.createRequire(
  Module.createRequire(
    Path.join(project, 'examples/react-native/package.json'),
  ).resolve('expo/package.json'),
)
const babelPresetExpo = expo.resolve('babel-preset-expo')
const cli = Path.join(project, 'dist/cli/index.js')
let root = ''

/** Packages the examples import, linked from the workspace installations that provide them. */
const packages = {
  '@babel/core': Path.join(project, 'node_modules/@babel/core'),
  '@babel/preset-typescript': Path.dirname(
    Path.dirname(
      Module.createRequire(babelPresetExpo).resolve('@babel/preset-typescript'),
    ),
  ),
  '@types': Path.join(project, 'node_modules/@types'),
  '@vitejs/plugin-react': Path.join(
    project,
    'site/node_modules/@vitejs/plugin-react',
  ),
  'babel-preset-expo': Path.dirname(Path.dirname(babelPresetExpo)),
  esbuild: Path.join(project, 'node_modules/esbuild'),
  expo: Path.dirname(expo.resolve('expo/package.json')),
  next: Path.join(project, 'node_modules/next'),
  react: Path.join(project, 'node_modules/react'),
  'react-native': Path.join(project, 'node_modules/react-native'),
  rollup: Path.join(project, 'node_modules/rollup'),
  vite: Path.join(project, 'node_modules/vite'),
  webpack: Path.join(project, 'node_modules/webpack'),
  zyzz: project,
}

beforeAll(async () => {
  root = await Fs.mkdtemp(Path.join(project, '.fixture-integrations-api-'))
  for (const [name, target] of Object.entries(packages)) {
    await Fs.mkdir(Path.dirname(Path.join(root, 'node_modules', name)), {
      recursive: true,
    })
    await Fs.symlink(target, Path.join(root, 'node_modules', name), 'dir')
  }
})

afterAll(async () => {
  if (root) await Fs.rm(root, { force: true, recursive: true })
})

/** Reads a page's code blocks in order, optionally from one section. The first block of a page is its overview example. */
async function examples(page: string, heading?: string | undefined) {
  const document = await Fs.readFile(
    new URL(`../${page}.mdx`, import.meta.url),
    'utf8',
  )
  // `Returns > config` selects a subheading that a parameter also names.
  const [parent, child] = heading?.includes(' > ')
    ? heading.split(' > ')
    : [undefined, heading]
  const scope =
    parent === undefined
      ? document
      : document.split(/^## /m).find((entry) => entry.startsWith(`${parent}\n`))
  const section =
    child === undefined
      ? document
      : scope
          ?.split(/^#{2,3} /m)
          .find((entry) => entry.startsWith(`${child}\n`))
  if (section === undefined)
    throw new Error(`${page} has no ${heading} section.`)

  return Array.from(
    section.matchAll(/```(\w+)([^\n]*)\n([\s\S]*?)```/g),
    (match) => ({
      language: match[1]!,
      name: match[2]!.match(/title="([^"]+)"/)?.[1],
      source: match[3]!,
    }),
  )
}

/** Reads the one code block of a section. */
async function example(page: string, heading?: string | undefined) {
  const [first] = await examples(page, heading)
  if (!first) throw new Error(`${page} ${heading} has no example.`)
  return first
}

/** Creates an isolated project directory whose packages resolve through the shared fixture links. */
async function directory(name: string, files: Record<string, string> = {}) {
  const path = Path.join(root, name)
  await Fs.mkdir(path)
  for (const [file, source] of Object.entries(files)) {
    await Fs.mkdir(Path.dirname(Path.join(path, file)), { recursive: true })
    await Fs.writeFile(Path.join(path, file), source)
  }
  return path
}

/** Runs a module in a project directory with Node, which strips TypeScript types natively. */
function node(cwd: string, args: readonly string[]) {
  const result = ChildProcess.spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    },
  )
  return {
    status: result.status,
    stderr: result.stderr.replaceAll(cwd, '<root>'),
    stdout: result.stdout.replaceAll(cwd, '<root>'),
  }
}

/** Lists a directory's files recursively, relative to it. */
async function files(path: string) {
  return (await Fs.readdir(path, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) =>
      Path.relative(path, Path.join(entry.parentPath, entry.name)),
    )
    .sort()
}

/** Reads the CSS asset of a Vite build. */
async function viteCss(path: string) {
  const assets = await files(Path.join(path, 'dist/assets'))
  const css = assets.filter((file) => file.endsWith('.css'))
  return Promise.all(
    css.map((file) =>
      Fs.readFile(Path.join(path, 'dist/assets', file), 'utf8'),
    ),
  ).then((sources) => sources.join(''))
}

/** Vite application sources, with a module that applies a literal style. */
const viteApp = {
  'index.html':
    '<!doctype html><html><head><title>App</title></head><body><script type="module" src="/src/main.ts"></script></body></html>',
  'src/main.ts': `import { style } from 'zyzz'

const card = style({ color: 'red', padding: '8px' })
document.body.className = card().className
`,
}

/** A module that applies a theme colour, which compiles to light-dark(). */
const viteTheme = `import { Config, Vars } from 'zyzz'

const base = Vars.define({ color: { text: { dark: '#fff', light: '#000' } } })
const { style } = Config.create({ defaultVars: 'base', vars: { base } })
const card = style({ color: 'text' })
export const className = card().className
`

/** Builds a Vite project from a page's configuration example. */
async function vite(name: string, config: string, extra = {}) {
  const path = await directory(name, {
    ...viteApp,
    ...extra,
    'vite.config.ts': config,
  })
  const result = node(path, [
    '--input-type=module',
    '-e',
    "import { build } from 'vite'; await build({ logLevel: 'silent' })",
  ])
  return { path, result }
}

describe('Vite API page', () => {
  test('builds the overview configuration', async () => {
    const config = await example('vite')
    const { path, result } = await vite('vite-overview', config.source)

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z_EQz5kA0{color:red}.z_EQz5kA1{padding:8px}
      "
    `)
  })

  test('keeps authored calls without the compiler', async () => {
    const config = await example('vite', 'options.compiler')
    const { path, result } = await vite('vite-compiler', config.source)
    const javascript = (await files(Path.join(path, 'dist/assets'))).find(
      (file) => file.endsWith('.js'),
    )!

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z-content-_5b__5b__22_color_22__2c__22_red_22__2c_false_5d__2c__5b__22_padding_22__2c__22_8px_22__2c_false_5d__5d_{color:red;padding:8px}
      "
    `)
    expect(
      (
        await Fs.readFile(Path.join(path, 'dist/assets', javascript), 'utf8')
      ).includes('padding:`8px`'),
    ).toMatchInlineSnapshot(`true`)
  })

  test('leaves excluded modules uncompiled', async () => {
    const config = await example('vite', 'options.exclude')
    const { path, result } = await vite('vite-exclude', config.source, {
      // The server bundle does not exist until a server build writes it.
      'server.mjs': `import { createServer } from 'node:http'
import handler from './dist/server/index.js'

createServer(handler).listen(3000)
`,
      'src/Card.stories.ts': `import { global } from 'zyzz/web'

global({ body: { color: 'rebeccapurple' } })
`,
    })

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z_EQz5kA0{color:red}.z_EQz5kA1{padding:8px}
      "
    `)
  })

  test('compiles an included source directory', async () => {
    const config = await example('vite', 'options.include')
    const library = await directory('library', {
      'src/badge.ts': `import { style } from 'zyzz'

export const badge = style({ margin: '4px' })
`,
    })
    await Fs.mkdir(Path.join(library, 'node_modules'))
    await Fs.symlink(project, Path.join(library, 'node_modules/zyzz'), 'dir')
    const { path, result } = await vite('vite-include', config.source, {
      'src/main.ts': `import { badge } from '../../library/src/badge.js'

document.body.className = badge().className
`,
    })

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z_Svh2KD0{margin:4px}
      "
    `)
  })

  test('emits no CSS for native output', async () => {
    const config = await example('vite', 'options.native')
    const { path, result } = await vite('vite-native', config.source)

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "assets/index-ddoB3VUG.js",
        "index.html",
      ]
    `)
  })

  test('prepends the reset layer', async () => {
    const config = await example('vite', 'options.reset')
    const { path, result } = await vite('vite-reset', config.source)

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect((await viteCss(path)).slice(0, 40)).toMatchInlineSnapshot(
      `"@layer reset{*,:after,:before,::backdrop"`,
    )
  })

  test('injects initialization scripts unless disabled', async () => {
    const config = await example('vite', 'options.script')
    const app = {
      'src/main.ts': `import { appearance, style } from './zyzz.config.js'

const card = style({ color: 'ink' })
document.body.className = card().className
appearance.get()
`,
      'src/zyzz.config.ts': `import { defineConfig } from 'zyzz'

export const { appearance, style } = defineConfig({
  defaultVars: 'base',
  vars: { base: { color: { ink: 'black' } } },
})
`,
    }
    const enabled = await vite(
      'vite-script-enabled',
      (await example('vite')).source,
      app,
    )
    const disabled = await vite('vite-script-disabled', config.source, app)

    expect(enabled.result.status).toMatchInlineSnapshot(`0`)
    expect(
      (
        await Fs.readFile(Path.join(enabled.path, 'dist/index.html'), 'utf8')
      ).includes('<head>\n  <script>(()=>{try{'),
    ).toMatchInlineSnapshot(`true`)
    expect(disabled.result.status).toMatchInlineSnapshot(`0`)
    expect(
      (
        await Fs.readFile(Path.join(disabled.path, 'dist/index.html'), 'utf8')
      ).includes('localStorage'),
    ).toMatchInlineSnapshot(`false`)
  })

  test('runs before a framework plugin', async () => {
    const config = await example('vite', 'plugin')
    const { path, result } = await vite('vite-react', config.source, {
      'src/main.ts': `import { Card } from './Card.js'

console.log(Card)
`,
      'src/Card.tsx': `import { style } from 'zyzz'

export function Card() {
  return <article {...styles.card()} />
}

namespace styles {
  export const card = style({ borderRadius: '8px' })
}
`,
    })

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z_nhSIc30{border-radius:8px}
      "
    `)
  })

  test('lets plugins tell development scans from module imports', async () => {
    const config = await example('vite', 'Import Resolution')
    const path = await directory('vite-scan', {
      ...viteApp,
      'src/api.ts': `import { read } from './db.server'

export const load = () => read()
`,
      'src/db.server.ts': `export const read = () => 'row'
`,
      'src/main.ts': `${viteApp['src/main.ts']}
export { load } from './api.js'
`,
      'vite.config.ts': config.source,
    })
    const result = node(path, [
      '--input-type=module',
      '-e',
      `import { createServer } from 'vite'
const server = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } })
await server.listen()
for (const file of ['src/main.ts', 'src/api.ts'])
  console.log(file, (await fetch(server.resolvedUrls.local[0] + file)).status)
await server.close()
// Native handles can outlive the closed server and keep Node running.
process.exit()`,
    ])

    // Zyzz's scan through api.ts passes, and Vite's import analysis of api.ts is denied.
    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "src/main.ts 200
      src/api.ts 500
      "
    `)
  })

  test('accepts a lower CSS target without light-dark()', async () => {
    const config = await example('vite', 'Browser Targets')
    const { path, result } = await vite('vite-targets', config.source)

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await viteCss(path)).toMatchInlineSnapshot(`
      ".z_EQz5kA0{color:red}.z_EQz5kA1{padding:8px}
      "
    `)
  })

  test('builds a server entry with a node target', async () => {
    const config = await example('vite', 'Server Builds')
    const { path, result } = await vite('vite-server', config.source, {
      'src/server.ts': viteTheme,
    })

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "server.js",
      ]
    `)
  })

  test('pre-bundles the runtime in discovering environments', async () => {
    const config = await example('vite', 'Dependency Optimization')
    // The package scope keeps the repository's own package from resolving zyzz.
    const path = await directory('vite-optimize', {
      ...viteApp,
      'package.json': '{"private":true,"type":"module"}',
      'vite.config.ts': config.source,
    })
    // Installed copies resolve the runtime inside node_modules, unlike the shared fixture link.
    const installed = Path.join(path, 'node_modules/zyzz')
    const packed = ChildProcess.spawnSync(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--offline',
        '--json',
        '--pack-destination',
        path,
      ],
      { cwd: project, encoding: 'utf8' },
    )
    const archive = (JSON.parse(packed.stdout) as { filename: string }[])[0]!

    await Fs.mkdir(installed, { recursive: true })
    ChildProcess.spawnSync('tar', [
      '-xf',
      Path.join(path, archive.filename),
      '-C',
      installed,
      '--strip-components=1',
    ])

    const result = node(path, [
      '--input-type=module',
      '-e',
      "import { createServer } from 'vite'; const server = await createServer({ logLevel: 'silent' }); for (const [name, environment] of Object.entries(server.environments)) console.log(name, environment.config.optimizeDeps.include.join(',')); await server.close()",
    ])

    expect(result.status).toMatchInlineSnapshot(`0`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "client zyzz/runtime
      ssr zyzz/runtime
      "
    `)
  })

  test('rejects a target that lowers light-dark()', async () => {
    const config = await example('vite', 'Errors')
    const { result } = await vite('vite-errors', config.source, {
      'src/main.ts': viteTheme,
    })

    expect(result.status).toMatchInlineSnapshot(`1`)
    expect(
      result.stderr.match(/Zyzz keeps light-dark\(\)[^\n']*/)?.[0],
    ).toMatchInlineSnapshot(
      `"Zyzz keeps light-dark() native, which these CSS targets would lower. Set build.cssTarget and css.lightningcss.targets to Chrome/Edge 123+, Firefox 120+, or Safari/iOS 17.5+."`,
    )
  })
})

/** Loads a Next.js configuration module in a fresh project and summarizes the parts the integration owns. */
async function next(name: string, config: string, call = '') {
  const path = await directory(name, { 'next.config.ts': config })
  const result = node(path, [
    '--input-type=module',
    '-e',
    `import * as Url from 'node:url'
const module = await import(Url.pathToFileURL('next.config.ts').href)
let config = module.default
${call}
const webpack = config.webpack({ module: { rules: [] } }, {})
console.log(JSON.stringify({
  config: Object.fromEntries(Object.entries(config).filter((entry) => !['experimental', 'turbopack', 'webpack'].includes(entry[0]))),
  exclude: config.experimental.lightningCssFeatures.exclude,
  reset: config.turbopack.rules['*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'][0].loaders[0].options.reset,
  rules: Object.keys(config.turbopack.rules),
  webpack: webpack.module.rules.map((rule) => ({ enforce: rule.enforce, test: String(rule.test) })),
}, null, 2))`,
  ])
  return { path, result }
}

describe('Next.js API page', () => {
  test('wraps the overview configuration for both bundlers', async () => {
    const config = await example('next')
    const { path, result } = await next('next-overview', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "{
        "config": {
          "reactStrictMode": true
        },
        "exclude": [
          "light-dark"
        ],
        "reset": false,
        "rules": [
          "*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
          "**/.zyzz/next/style.css"
        ],
        "webpack": [
          {
            "enforce": "pre",
            "test": "/\\\\.[cm]?[jt]sx?$/"
          }
        ]
      }
      "
    `)
    expect(await files(Path.join(path, '.zyzz/next'))).toMatchInlineSnapshot(`
      [
        "package.json",
        "style.css",
      ]
    `)
  })

  test('resolves a factory before attaching the integration', async () => {
    const config = await example('next', 'nextConfig')
    const { result } = await next(
      'next-factory',
      config.source,
      "config = await config('phase-production-build', { defaultConfig: {} })",
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(JSON.parse(result.stdout).config).toMatchInlineSnapshot(`
      {
        "distDir": "build",
      }
    `)
  })

  test('passes the reset option to the loader', async () => {
    const config = await example('next', 'options.reset')
    const { result } = await next('next-reset', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(JSON.parse(result.stdout).reset).toMatchInlineSnapshot(`true`)
  })

  test('returns an object for an object configuration', async () => {
    const returned = await example('next', 'Returns > nextConfig')
    const { result } = await next('next-returns', returned.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(JSON.parse(result.stdout).config).toMatchInlineSnapshot(`
      {
        "reactStrictMode": true,
      }
    `)
  })

  test('creates the stylesheet directory while loading the configuration', async () => {
    const config = await example('next', 'Errors')
    const { path, result } = await next('next-errors', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(await files(Path.join(path, '.zyzz/next'))).toMatchInlineSnapshot(`
      [
        "package.json",
        "style.css",
      ]
    `)
  })
})

/** Loads a Metro configuration example and transforms one style module through its chained transformer. */
async function metro(
  name: string,
  config: string,
  styles = "{ padding: '2px' }",
) {
  const path = await directory(name, {
    // Metro resolves extensionless CommonJS subpaths, which Node's ESM loader does not.
    'metro.config.ts': config.replace(
      "'expo/metro-config'",
      "'expo/metro-config.js'",
    ),
    'package.json': JSON.stringify({ name, type: 'module' }),
    'Styles.ts': `import { style } from 'zyzz'

export const title = style(${styles})
`,
  })
  const result = node(path, [
    '--input-type=module',
    '-e',
    `import * as Fs from 'node:fs'
import * as Module from 'node:module'
import * as Url from 'node:url'
const config = (await import(Url.pathToFileURL('metro.config.ts').href)).default
const transformer = Module.createRequire(import.meta.url)(config.transformer.babelTransformerPath)
const output = transformer.transform({
  filename: 'Styles.ts',
  options: { dev: false, hot: false, minify: false, platform: 'ios', projectRoot: process.cwd(), publicPath: '/assets', type: 'module' },
  src: Fs.readFileSync('Styles.ts', 'utf8'),
})
const { code } = (await import('@babel/core')).transformFromAstSync(output.ast, undefined, { babelrc: false, configFile: false })
const table = JSON.parse(code.match(/Native\\.create\\(([\\s\\S]*?)\\)\\);/)[1])
console.log(JSON.stringify(table.styles))`,
  ])
  return { path, result }
}

describe('Metro API page', () => {
  test('chains native compilation before the Expo transformer', async () => {
    const config = await example('metro')
    const { path, result } = await metro('metro-overview', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "{"0":{"paddingTop":2,"paddingRight":2,"paddingBottom":2,"paddingLeft":2}}
      "
    `)
    expect(
      (await files(Path.join(path, '.zyzz/metro'))).map((file) =>
        file.replace(/^\w{64}/, '<hash>'),
      ),
    ).toMatchInlineSnapshot(`
      [
        "<hash>.cjs",
      ]
    `)
  })

  test('keeps the configured watch folders', async () => {
    const config = await example('metro', 'config')
    const { result } = await metro('metro-config', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "{"0":{"paddingTop":2,"paddingRight":2,"paddingBottom":2,"paddingLeft":2}}
      "
    `)
  })

  test('maps authored font families', async () => {
    const config = await example('metro', 'options.fonts')
    const { result } = await metro(
      'metro-fonts',
      config.source,
      "{ fontFamily: 'Pilat, Arial, sans-serif' }",
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "{"0":{"fontFamily":"Pilat"}}
      "
    `)
  })

  test('converts rem lengths', async () => {
    const config = await example('metro', 'options.units')
    const { result } = await metro(
      'metro-units',
      config.source,
      "{ fontSize: '1rem' }",
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout).toMatchInlineSnapshot(`
      "{"0":{"fontSize":16}}
      "
    `)
  })

  test('points the transformer at the generated entry', async () => {
    const config = await example('metro', 'Returns > config')
    const { result } = await metro('metro-returns', config.source)

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.stdout.replace(/\w{64}/, '<hash>')).toMatchInlineSnapshot(`
      "<root>/.zyzz/metro/<hash>.cjs
      {"0":{"paddingTop":2,"paddingRight":2,"paddingBottom":2,"paddingLeft":2}}
      "
    `)
  })

  test('rejects a missing transformer and a Metro color scheme', async () => {
    const path = await directory('metro-errors')
    const transformer = node(path, [
      '--input-type=module',
      '-e',
      "import { zyzz } from 'zyzz/metro'; zyzz({})",
    ])
    const scheme = node(path, [
      '--input-type=module',
      '-e',
      "import { zyzz } from 'zyzz/metro'; zyzz({ transformer: { babelTransformerPath: 'transformer.js' } }, { colorScheme: 'dark' })",
    ])

    expect(transformer.stderr.match(/Error: (.*)/)?.[1]).toMatchInlineSnapshot(
      `"Zyzz requires a configured Metro Babel transformer."`,
    )
    expect(scheme.stderr.match(/Error: (.*)/)?.[1]).toMatchInlineSnapshot(
      `"Select colorScheme through the React provider, not Metro configuration."`,
    )
  })
})

/** Sources for the bundler examples, whose entries are `src/main.ts` for esbuild and `src/main.js` otherwise. */
function bundlerApp(entry: 'main.js' | 'main.ts') {
  return {
    'package.json': JSON.stringify({ name: 'app', type: 'module' }),
    [`src/${entry}`]: `import { style } from 'zyzz'

export const card = style({ color: 'red', padding: '8px' })
`,
  }
}

/** Reads an emitted stylesheet without its source map comment. */
async function stylesheet(path: string) {
  return (await Fs.readFile(path, 'utf8')).replace(
    /\/\*# sourceMappingURL=.*\*\/\n/,
    '',
  )
}

/** Bundles `src` with the plugin that an option snippet exports. */
async function bundle(
  name: string,
  snippet: string,
  bundler: 'esbuild' | 'rollup' | 'webpack',
) {
  const path = await directory(name, {
    ...bundlerApp(bundler === 'esbuild' ? 'main.ts' : 'main.js'),
    'plugin.ts': `${snippet}\nexport { plugin }\n`,
  })
  const run = {
    esbuild:
      "await (await import('esbuild')).build({ bundle: true, entryPoints: ['src/main.ts'], format: 'esm', outdir: 'dist', plugins: [plugin] })",
    rollup:
      "const build = await (await import('rollup')).rollup({ external: ['zyzz/runtime'], input: 'src/main.js', plugins: [plugin] }); await build.write({ dir: 'dist', format: 'es' })",
    webpack:
      "const compiler = (await import('webpack')).default({ devtool: false, entry: './src/main.js', mode: 'development', plugins: [plugin] }); await new Promise((resolve, reject) => compiler.run((error, stats) => error || stats.hasErrors() ? reject(error ?? new Error(stats.toString('errors-only'))) : resolve()))",
  }[bundler]
  const result = node(path, [
    '--input-type=module',
    '-e',
    `import { plugin } from './plugin.ts'\n${run}`,
  ])
  return { path, result }
}

describe('Unplugin API page', () => {
  test('builds the overview with esbuild', async () => {
    const build = await example('unplugin')
    const path = await directory('unplugin-overview', {
      ...bundlerApp('main.ts'),
      'build.ts': build.source,
    })
    const result = node(path, ['build.ts'])

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "main.js",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
        ".z_YiE3S90 {
          color: red;
        }

        .z_YiE3S91 {
          padding: 8px;
        }

        "
      `)
  })

  test('keeps authored calls without the compiler', async () => {
    const snippet = await example('unplugin', 'options.compiler')
    const { path, result } = await bundle(
      'unplugin-compiler',
      snippet.source,
      'esbuild',
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(
      (await Fs.readFile(Path.join(path, 'dist/main.js'), 'utf8')).includes(
        'style({ color: "red", padding: "8px" })',
      ),
    ).toMatchInlineSnapshot(`true`)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
      ".z-content-_5b__5b__22_color_22__2c__22_red_22__2c_false_5d__2c__5b__22_padding_22__2c__22_8px_22__2c_false_5d__5d_ {
        color: red;
        padding: 8px;
      }

      "
    `)
  })

  test('prepends the reset layer with Rollup', async () => {
    const snippet = await example('unplugin', 'options.reset')
    const { path, result } = await bundle(
      'unplugin-reset',
      snippet.source,
      'rollup',
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(
      (await stylesheet(Path.join(path, 'dist/zyzz.css'))).slice(0, 13),
    ).toMatchInlineSnapshot(`"@layer reset "`)
  })

  test('compiles the configured root with Webpack', async () => {
    const snippet = await example('unplugin', 'options.root')
    const { path, result } = await bundle(
      'unplugin-root',
      snippet.source,
      'webpack',
    )

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
        ".z_kiE3Jn0 {
          color: red;
        }

        .z_kiE3Jn1 {
          padding: 8px;
        }

        "
      `)
  })

  test('builds the esbuild section', async () => {
    const build = await example('unplugin', 'esbuild')
    const path = await directory('unplugin-esbuild', {
      ...bundlerApp('main.ts'),
      'build.ts': build.source,
    })

    expect(node(path, ['build.ts']).stderr).toMatchInlineSnapshot(`""`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "main.js",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('builds the Rollup section', async () => {
    const config = await example('unplugin', 'Rollup')
    const path = await directory('unplugin-rollup', {
      ...bundlerApp('main.js'),
      'rollup.config.ts': config.source,
    })
    const result = node(path, [
      '--input-type=module',
      '-e',
      "import config from './rollup.config.ts'; const build = await (await import('rollup')).rollup({ ...config, external: ['zyzz/runtime'] }); await build.write(config.output)",
    ])

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "main.js",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('builds the Webpack section', async () => {
    const config = await example('unplugin', 'Webpack')
    const path = await directory('unplugin-webpack', {
      ...bundlerApp('main.js'),
      'webpack.config.ts': config.source,
    })
    const result = node(path, [
      '--input-type=module',
      '-e',
      "import config from './webpack.config.ts'; const compiler = (await import('webpack')).default({ ...config, devtool: false, mode: 'development' }); await new Promise((resolve, reject) => compiler.run((error, stats) => error || stats.hasErrors() ? reject(error ?? new Error(stats.toString('errors-only'))) : resolve()))",
    ])

    expect(result.stderr).toMatchInlineSnapshot(`""`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        "main.js",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
      ]
    `)
  })

  test('rejects an esbuild output file', async () => {
    const build = await example('unplugin', 'Errors')
    const path = await directory('unplugin-errors', {
      ...bundlerApp('main.ts'),
      'build.ts': build.source,
    })
    const result = node(path, ['build.ts'])

    expect(result.status).toMatchInlineSnapshot(`1`)
    expect(
      result.stderr.match(/Zyzz requires[^\n]*/)?.[0],
    ).toMatchInlineSnapshot(
      `"Zyzz requires esbuild outdir and write: true to emit CSS assets. [plugin zyzz]"`,
    )
  })
})

/** Runs a Babel example module and prints one binding it exports. */
function babel(path: string, name: string) {
  const result = node(path, [
    '--input-type=module',
    '-e',
    `const module = await import('./example.ts'); console.log(JSON.stringify(module.${name}))`,
  ])
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as unknown
}

/** Transforms a style module with the plugins that a parameter snippet declares. */
async function babelOption(heading: string, styles: string) {
  const snippet = await example('babel', heading)
  const path = await directory(`babel-${heading.replace('.', '-')}`, {
    'example.ts': `import { transformSync } from '@babel/core'
import { zyzz } from 'zyzz/babel'

${snippet.source}
const result = transformSync(${JSON.stringify(`import { style } from 'zyzz'\n\nexport const title = style(${styles})\n`)}, {
  babelrc: false,
  configFile: false,
  filename: 'src/styles.ts',
  plugins,
  presets: ['@babel/preset-typescript'],
})!
export const output = {
  code: result.code!.replace(/\\s+/g, ' '),
  metadata: result.metadata.zyzz ? { css: result.metadata.zyzz.css, moduleId: result.metadata.zyzz.moduleId } : null,
}
`,
  })
  return babel(path, 'output') as {
    code: string
    metadata: { css: string; moduleId: string } | null
  }
}

/** Reads the style table of compiled native code. */
function table(code: string) {
  return code.match(/"styles": ?(\{.*?\}\s*\})/)?.[1]
}

describe('Babel API page', () => {
  test('transforms the overview example', async () => {
    const overview = await example('babel')
    const path = await directory('babel-overview', {
      'example.ts': `${overview.source}\nexport const code = result?.code\nexport const css = result?.metadata?.zyzz?.css\n`,
    })

    expect(babel(path, 'code')).toMatchInlineSnapshot(`
      "import { Props as __zyzzProps } from 'zyzz/runtime';
      export const card = /*#__PURE__*/__zyzzProps.create({
        className: "z_-mSYb50 z-style--mSYb5-card"
      });"
    `)
    expect(babel(path, 'css')).toMatchInlineSnapshot(`".z_-mSYb50{color:red;}"`)
  })

  test('selects web compilation', async () => {
    const output = await babelOption('options.target', "{ color: 'red' }")

    expect(output.metadata).toMatchInlineSnapshot(`
      {
        "css": ".z_-mSYb50{color:red;}",
        "moduleId": "src/styles.ts",
      }
    `)
  })

  test('groups declarations', async () => {
    const output = await babelOption(
      'options.cssOutput',
      "{ color: 'red', padding: '8px' }",
    )

    expect(output.metadata?.css).toMatchInlineSnapshot(
      `".z_-mSYb50{color:red;padding:8px;}"`,
    )
  })

  test('names a module explicitly', async () => {
    const output = await babelOption('options.moduleId', "{ color: 'red' }")

    expect(output.metadata?.moduleId).toMatchInlineSnapshot(`"ui/Button.ts"`)
  })

  test('imports the reset', async () => {
    const output = await babelOption('options.reset', "{ color: 'red' }")

    expect(output.code.split(';')[0]).toMatchInlineSnapshot(
      `"import "zyzz/reset.css""`,
    )
  })

  test('compiles iOS tables', async () => {
    const output = await babelOption(
      'options.platform',
      "{ padding: '2px', targets: { ios: { padding: 4 } } }",
    )

    expect(output.metadata).toMatchInlineSnapshot(`null`)
    expect(table(output.code)).toMatchInlineSnapshot(
      `"{ "0": { "paddingTop": 2, "paddingRight": 2, "paddingBottom": 2, "paddingLeft": 2, "padding": 4 } }"`,
    )
  })

  test('fixes the color scheme', async () => {
    const output = await babelOption(
      'options.colorScheme',
      "{ padding: '2px' }",
    )

    expect(output.code.includes('NativeContext')).toMatchInlineSnapshot(`false`)
  })

  test('maps authored font families', async () => {
    const output = await babelOption(
      'options.fonts',
      "{ fontFamily: 'Pilat, Arial, sans-serif' }",
    )

    expect(table(output.code)).toMatchInlineSnapshot(
      `"{ "0": { "fontFamily": "Pilat" } }"`,
    )
  })

  test('converts rem lengths', async () => {
    const output = await babelOption('options.units', "{ fontSize: '1rem' }")

    expect(table(output.code)).toMatchInlineSnapshot(
      `"{ "0": { "fontSize": 16 } }"`,
    )
  })

  test('compiles a configuration read through the module graph', async () => {
    const graph = await example('babel', 'options.imports')
    const path = await directory('babel-graph', {
      'example.ts': `${graph.source}\nexport const code = result?.code?.replace(/\\s+/g, ' ')\n`,
    })

    expect(table(babel(path, 'code') as string)).toMatchInlineSnapshot(
      `"{ "0": { "paddingTop": 16, "paddingRight": 16, "paddingBottom": 16, "paddingLeft": 16 } }"`,
    )
  })

  test('returns stylesheet metadata', async () => {
    const metadata = await example('babel', 'metadata.zyzz')
    const path = await directory('babel-metadata', {
      'example.ts': `${metadata.source}\nexport { css }\n`,
    })

    expect(babel(path, 'css')).toMatchInlineSnapshot(`".z_-mSYb50{color:red;}"`)
  })

  test('rejects an exported configuration', async () => {
    const errors = await example('babel', 'Errors')
    const path = await directory('babel-errors', {
      'example.ts': errors.source,
    })
    const result = node(path, ['example.ts'])

    expect(result.status).toMatchInlineSnapshot(`1`)
    expect(
      result.stderr.match(/Define local themes[^\n]*/)?.[0],
    ).toMatchInlineSnapshot(
      `"Define local themes with a module-level const; exported themes require source linking."`,
    )
  })

  test('compiles native tables with Expo', async () => {
    const native = await example('babel', 'React Native')
    const path = await directory('babel-native', {
      'example.ts': `${native.source}\nexport const code = result?.code\nexport const metadata = result?.metadata?.zyzz ?? null\n`,
    })

    expect(babel(path, 'metadata')).toMatchInlineSnapshot(`null`)
    expect(table(babel(path, 'code') as string)).toMatchInlineSnapshot(
      `"{"0":{"fontSize":16}}"`,
    )
  })
})

/** Web source tree for CLI examples. The configuration exports `vars`, so the build emits `zyzz.js`. */
const cliApp = {
  'app/button.ts': `import { style } from 'zyzz'

export const button = style({ color: 'red' })
`,
  'package.json': JSON.stringify({ name: 'cli-app', type: 'module' }),
  'src/button.ts': `import { style } from './zyzz.config.js'

export const button = style({ color: 'brand', padding: '8px' })
`,
  'src/global.ts': `import { global } from 'zyzz/web'

global({ body: { margin: 0 } })
`,
  'src/zyzz.config.ts': `import { defineConfig } from 'zyzz'

export const { style, vars } = defineConfig({
  id: 'app',
  vars: { color: { brand: { dark: '#8cf', light: '#06c' } } },
})
`,
}

/** Native source tree for CLI examples. */
const cliNativeApp = {
  'package.json': JSON.stringify({ name: 'cli-native-app', type: 'module' }),
  'src/button.ts': `import { style } from 'zyzz'

export const button = style({ padding: '8px' })
`,
}

/** Native source tree with an iOS branch, which requires `--platform`. */
const cliPlatformApp = {
  ...cliNativeApp,
  'src/button.ts': `import { style } from 'zyzz'

export const button = style({ padding: '8px', targets: { ios: { padding: 12 } } })
`,
}

/** Reads the arguments of the `npx zyzz` command in a shell example. */
function command(source: string) {
  const line = source.split('\n').find((entry) => entry.startsWith('npx zyzz '))
  if (!line) throw new Error('The example runs no zyzz command.')
  return Array.from(
    line.slice('npx zyzz '.length).matchAll(/'([^']*)'|(\S+)/g),
    (match) => match[1] ?? match[2]!,
  )
}

/** Runs a shell example's command in a fresh project. Watchers stop after their first event. */
async function shell(
  name: string,
  source: string,
  tree: Record<string, string> = cliApp,
) {
  const path = await directory(name, tree)
  const args = command(source)

  if (args[0] !== 'dev') {
    const result = node(path, [cli, ...args])
    return {
      output: (result.stdout + result.stderr).trim(),
      path,
      status: result.status,
    }
  }

  const child = ChildProcess.spawn(process.execPath, [cli, ...args], {
    cwd: path,
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))

  // A stuck publication can hold shutdown open, so every stop is bounded.
  async function stop() {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try {
      return await exited
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const output = await new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(
        () => reject(new Error(`${args.join(' ')} produced no event.`)),
        30_000,
      )
      child.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        if (!text.includes('\n')) return
        clearTimeout(timer)
        resolve(text.split('\n')[0]!)
      })
    })

    return { output, path, status: await stop() }
  } catch (error) {
    await stop()
    throw error
  }
}

describe('CLI API page', () => {
  test('builds the overview command', async () => {
    const overview = await example('cli')
    const { path, status } = await shell('cli-overview', overview.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        ".zyzz.json",
        "button.ts",
        "button.ts.css",
        "button.ts.css.map",
        "button.ts.map",
        "button.ts.zyzz.json",
        "global.ts",
        "global.ts.css",
        "global.ts.css.map",
        "global.ts.map",
        "global.ts.zyzz.json",
        "zyzz.config.ts",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.config.ts.map",
        "zyzz.config.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
        "zyzz.shared.css",
        "zyzz.shared.css.map",
      ]
    `)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
        "body {
          margin: 0;
        }
        .z-theme-app-theme {
          --z-app-color-brand: light-dark(#06c, #8cf);
        }

        .z_scheme-dark {
          color-scheme: dark;
        }

        .z_scheme-light {
          color-scheme: light;
        }

        .z_scheme-light-dark {
          color-scheme: light dark;
        }
        .z-theme-app-theme {
          --z-app-color-brand: light-dark(#06c, #8cf);
        }

        .z_app-sJkhe-0 {
          color: var(--z-app-color-brand, light-dark(#06c, #8cf));
        }

        .z_app-sJkhe-1 {
          padding: 8px;
        }
        .z-theme-app-theme {
          --z-app-color-brand: light-dark(#06c, #8cf);
        }
        "
      `)
  })

  test('builds a source argument into an output directory', async () => {
    const snippet = await example('cli', 'build')
    const { path, status } = await shell('cli-build', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'build'))).toMatchInlineSnapshot(`
      [
        ".zyzz.json",
        "button.ts",
        "button.ts.css",
        "button.ts.css.map",
        "button.ts.map",
        "button.ts.zyzz.json",
        "zyzz.css",
        "zyzz.css.map",
      ]
    `)
  })

  test('reports the first watch build', async () => {
    const snippet = await example('cli', 'dev')
    const { output, status } = await shell('cli-dev', snippet.source)

    expect(output).toMatchInlineSnapshot(
      `"changed[20]: button.ts,button.ts.css,button.ts.css.map,button.ts.map,button.ts.zyzz.json,global.ts,global.ts.css,global.ts.css.map,global.ts.map,global.ts.zyzz.json,zyzz.config.ts,zyzz.config.ts.css,zyzz.config.ts.css.map,zyzz.config.ts.map,zyzz.config.ts.zyzz.json,zyzz.css,zyzz.css.map,zyzz.js,zyzz.shared.css,zyzz.shared.css.map"`,
    )
    expect(status).toMatchInlineSnapshot(`0`)
  })

  test('compiles the source argument', async () => {
    const snippet = await example('cli', 'src')
    const { path, status } = await shell('cli-src', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
        ".z_sJkhe-0 {
          color: red;
        }
        "
      `)
  })

  test('compiles a native color scheme', async () => {
    const snippet = await example('cli', '--color-scheme')
    const { path, status } = await shell(
      'cli-color-scheme',
      snippet.source,
      cliNativeApp,
    )

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        ".zyzz.json",
        "button.ts",
        "button.ts.map",
        "button.ts.zyzz.json",
      ]
    `)
  })

  test('emits only stylesheets', async () => {
    const snippet = await example('cli', '--css-only')
    const { path, status } = await shell('cli-css-only', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        ".zyzz.json",
        "button.ts.css",
        "button.ts.css.map",
        "global.ts.css",
        "global.ts.css.map",
        "zyzz.config.ts.css",
        "zyzz.config.ts.css.map",
        "zyzz.css",
        "zyzz.css.map",
        "zyzz.js",
        "zyzz.shared.css",
        "zyzz.shared.css.map",
      ]
    `)
  })

  test('leaves external imports unresolved', async () => {
    const snippet = await example('cli', '--external')
    const { path, status } = await shell('cli-external', snippet.source, {
      ...cliApp,
      'src/icon.ts': "import icon from '~icons/mdi/home'\n\nexport { icon }\n",
    })

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await Fs.readFile(Path.join(path, 'dist/icon.ts'), 'utf8'))
      .toMatchInlineSnapshot(`
      "import icon from '~icons/mdi/home'

      export { icon }
      "
    `)
  })

  test('minifies stylesheets', async () => {
    const snippet = await example('cli', '--minify')
    const { path, status } = await shell('cli-minify', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await stylesheet(Path.join(path, 'dist/zyzz.css')))
      .toMatchInlineSnapshot(`
        "body{margin:0}
        .z-theme-app-theme{--z-app-color-brand:light-dark(#06c,#8cf)}.z_scheme-dark{color-scheme:dark}.z_scheme-light{color-scheme:light}.z_scheme-light-dark{color-scheme:light dark}
        .z-theme-app-theme{--z-app-color-brand:light-dark(#06c,#8cf)}.z_app-sJkhe-0{color:var(--z-app-color-brand,light-dark(#06c,#8cf))}.z_app-sJkhe-1{padding:8px}
        .z-theme-app-theme{--z-app-color-brand:light-dark(#06c,#8cf)}
        "
      `)
  })

  test('writes to another output directory', async () => {
    const snippet = await example('cli', '--out-dir')
    const { path, status } = await shell('cli-out-dir', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect((await Fs.readdir(path)).includes('build')).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('names compiled modules with a package identity', async () => {
    const snippet = await example('cli', '--package-id')
    const { path, status } = await shell('cli-package-id', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(
      JSON.parse(
        await Fs.readFile(Path.join(path, 'dist/button.ts.map'), 'utf8'),
      ).sources,
    ).toMatchInlineSnapshot(`
      [
        "my-library/button.ts",
      ]
    `)
  })

  test('compiles a platform branch', async () => {
    const snippet = await example('cli', '--platform')
    const { path, status } = await shell(
      'cli-platform',
      snippet.source,
      cliPlatformApp,
    )

    expect(status).toMatchInlineSnapshot(`0`)
    expect(
      (await Fs.readFile(Path.join(path, 'dist/button.ts'), 'utf8')).match(
        /"padding":\d+/,
      )?.[0],
    ).toMatchInlineSnapshot(`""padding":12"`)
  })

  test('writes the initialization script to a public directory', async () => {
    const snippet = await example('cli', '--script')
    const { path, status } = await shell('cli-script', snippet.source)

    expect(status).toMatchInlineSnapshot(`0`)
    expect(
      (await Fs.readFile(Path.join(path, 'public/zyzz.js'), 'utf8')).split(
        '\n',
      )[0],
    ).toMatchInlineSnapshot(`"/* zyzz initialization */"`)
  })

  test('compiles native modules', async () => {
    const snippet = await example('cli', '--target')
    const { path, status } = await shell(
      'cli-target',
      snippet.source,
      cliNativeApp,
    )

    expect(status).toMatchInlineSnapshot(`0`)
    expect(await files(Path.join(path, 'dist'))).toMatchInlineSnapshot(`
      [
        ".zyzz.json",
        "button.ts",
        "button.ts.map",
        "button.ts.zyzz.json",
      ]
    `)
  })

  test('streams JSON line events', async () => {
    const snippet = await example('cli', 'Structured Output')
    const { output } = await shell('cli-jsonl', snippet.source)

    expect(JSON.parse(output).data.status).toMatchInlineSnapshot(`"built"`)
  })

  test('rejects a platform for web builds', async () => {
    const snippet = await example('cli', 'Errors')
    const { output, status } = await shell('cli-errors', snippet.source)

    expect(status).toMatchInlineSnapshot(`1`)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: "--platform, --color-scheme, --font, --px, and --rem require --target native.""
    `)
  })

  test('watches native output', async () => {
    const snippet = await example('cli', 'React Native')
    const { output, status } = await shell(
      'cli-native',
      snippet.source,
      cliNativeApp,
    )

    expect(output).toMatchInlineSnapshot(
      `"changed[3]: button.ts,button.ts.map,button.ts.zyzz.json"`,
    )
    expect(status).toMatchInlineSnapshot(`0`)
  })
})

describe('integration API examples', () => {
  test('type-check against the published declarations', async () => {
    const pages = await Promise.all(
      ['vite', 'next', 'metro', 'unplugin', 'babel'].map((page) =>
        examples(page),
      ),
    )
    const sources = pages.flat().filter(
      (entry) =>
        ['ts', 'tsx'].includes(entry.language) &&
        entry.source.includes('import ') &&
        // Twoslash blocks that declare expected errors are checked by the site build.
        !entry.source.includes('// @errors'),
    )
    const checked = await Promise.all(
      sources.map(async (entry, index) => {
        const path = Path.join(root, 'types', String(index))
        const file = Path.join(path, entry.name ?? 'Example.ts')
        await Fs.mkdir(Path.dirname(file), { recursive: true })
        await Fs.writeFile(file, entry.source)
        // Supplies the global styles module that the Next.js layout example imports.
        if (entry.source.includes("'./global.js'"))
          await Fs.writeFile(
            Path.join(Path.dirname(file), 'global.ts'),
            "import { global } from 'zyzz/web'\n\nglobal({ body: { margin: 0 } })\n",
          )
        return file
      }),
    )

    const result = ChildProcess.spawnSync(
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
        // Native examples import `zyzz/react-native` as Metro resolves it.
        '--customConditions',
        'react-native',
        '--target',
        'ESNext',
        '--types',
        'node',
        ...checked,
      ],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    )

    expect(checked.length).toMatchInlineSnapshot(`37`)
    expect(result.stdout + result.stderr).toMatchInlineSnapshot(`""`)
    expect(result.status).toMatchInlineSnapshot(`0`)
  }, 120_000)
})
