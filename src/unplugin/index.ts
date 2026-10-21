/** Connects the static compiler to portable bundler hooks and the Vite adapter. @module */
import * as Mapping from '@jridgewell/gen-mapping'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Reset from '../node/Reset.js'
import * as Snapshot from '../node/internal/Snapshot.js'
import { createUnplugin } from 'unplugin'
import type { UnpluginBuildContext } from 'unplugin'
import * as Graph from '../compiler/Graph.js'
import * as AtRules from '../compiler/internal/AtRules.js'
import * as Catalogs from '../compiler/internal/Catalogs.js'
import * as ClassName from '../web/internal/ClassName.js'
import * as Contracts from '../node/internal/Contracts.js'
import * as Results from '../compiler/internal/Results.js'
import * as Vite from '../vite/index.js'
import * as ThemeRules from '../web/internal/Themes.js'

/** Portable build configuration. Vite uses the options from `zyzz/vite` instead. */
export type Options = {
  /** Rewrite authoring calls. Defaults to true. */
  readonly compiler?: boolean | undefined
  /** Include the CSS reset. Defaults to false. */
  readonly reset?: boolean | undefined
  /** Source directory scanned for modules and global contributions. Defaults to the working directory. */
  readonly root?: string | undefined
}

const excludedPattern = /\.(?:d|test|test-d|bench|bench-d)\.[cm]?[jt]sx?$/
const sourcePattern = /\.[cm]?[jt]sx?$/

const portable = createUnplugin<Options | undefined, false>(
  (options = {}, meta) => {
    const root = Path.resolve(options.root ?? process.cwd())
    const compiler = Graph.create()
    const packages = Contracts.create()
    const snapshot = Snapshot.create()
    let graph: Graph.compile.ReturnType | undefined
    let pending: Promise<void> | undefined
    let files = new Set<string>()
    let directories = new Set<string>()
    let sources = new Map<string, string>()
    let assets = new Map<string, Uint8Array>()
    let css = ''
    let cssMap = ''
    let script = ''

    function identity(file: string) {
      return `app/${Path.relative(root, file).split(Path.sep).join('/')}`
    }

    function emit(context: UnpluginBuildContext) {
      if (!graph) return
      for (const [fileName, source] of assets)
        context.emitFile({
          type: 'asset',
          fileName,
          source: Uint8Array.from(source),
        })
      context.emitFile({
        type: 'asset',
        fileName: 'zyzz.css',
        source: `${css}/*# sourceMappingURL=zyzz.css.map */\n`,
      })
      context.emitFile({
        type: 'asset',
        fileName: 'zyzz.css.map',
        source: cssMap,
      })
      context.emitFile({
        type: 'asset',
        fileName: 'zyzz.js',
        source: script || '/* No saved theme selections. */\n',
      })
    }

    function transform(code: string, id: string) {
      const output = graph?.modules[identity(id)]
      if (!output) return
      if (code !== sources.get(id))
        throw new Error(`Zyzz must run before source transforms: ${id}`)
      return {
        code: output.code,
        map: JSON.stringify({
          ...output.map,
          sources: output.map.sources.map((source) =>
            source?.startsWith('app/')
              ? Path.join(root, source.slice(4))
              : source,
          ),
        }),
      }
    }

    return {
      buildEnd:
        meta.framework === 'webpack'
          ? undefined
          : function () {
              emit(this)
            },
      async buildStart() {
        pending = (async () => {
          graph = undefined
          files = new Set()
          directories = new Set()
          sources = new Map()
          assets = new Map()
          const modules: Record<string, string> = Object.create(null)
          const imports: Record<
            string,
            Record<string, string | null>
          > = Object.create(null)
          const contracts: Record<string, string> = Object.create(null)

          async function scan(directory: string): Promise<void> {
            directories.add(directory)
            const entries = await Fs.readdir(directory, { withFileTypes: true })

            for (const entry of entries.sort((a, b) =>
              a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
            )) {
              if (
                entry.name.startsWith('.') ||
                [
                  'node_modules',
                  'dist',
                  'build',
                  'coverage',
                  'test',
                  'tests',
                  '__tests__',
                  'fixtures',
                  '__fixtures__',
                ].includes(entry.name)
              )
                continue
              const file = Path.join(directory, entry.name)

              if (entry.isDirectory()) await scan(file)
              else if (
                entry.isFile() &&
                sourcePattern.test(file) &&
                !excludedPattern.test(file)
              ) {
                const source = await snapshot.read(file)

                files.add(file)
                sources.set(file, source)
                modules[identity(file)] = source
              }
            }
          }

          const resolve = async (specifier: string, importer: string) => {
            if ('resolve' in this && typeof this.resolve === 'function') {
              const result = await (
                this as UnpluginBuildContext & {
                  resolve: (
                    id: string,
                    importer: string,
                  ) => Promise<{
                    id: string
                    external?: boolean | 'absolute' | 'relative'
                  } | null>
                }
              ).resolve(specifier, importer)
              return result && !result.external ? result.id : undefined
            }

            const native = this.getNativeBuildContext?.()
            if (native?.framework === 'esbuild') {
              const result = await native.build.resolve(specifier, {
                importer,
                kind: 'import-statement',
                resolveDir: Path.dirname(importer),
              })
              if (result.errors.length)
                throw new Error(
                  result.errors.map((error) => error.text).join('\n'),
                )
              return result.external ? undefined : result.path
            }
            if (native?.framework === 'webpack') {
              const resolver = native.compiler.resolverFactory.get('normal', {
                dependencyType: 'esm',
              })
              return new Promise<string | undefined>((accept, reject) => {
                resolver.resolve(
                  {},
                  Path.dirname(importer),
                  specifier,
                  {},
                  (error, result) => {
                    if (error) reject(error)
                    else accept(result || undefined)
                  },
                )
              })
            }
            throw new Error('The bundler does not expose module resolution.')
          }

          async function contract(
            file: string,
            required = false,
          ): Promise<boolean> {
            if (Object.hasOwn(contracts, file)) return true

            const source = await packages.read(file, {
              read(path) {
                files.add(path)
                return snapshot.read(path)
              },
              required,
              resolve,
            })
            if (source === undefined) return false
            contracts[file] = source
            for (const dependency of Results.dependencies(
              contracts[file]!,
              file,
            )) {
              let owner = file
              for (const specifier of dependency) {
                const target = await resolve(specifier, owner)
                if (!target)
                  throw new Error(
                    `Unable to resolve packed stylesheet dependency: ${specifier}`,
                  )
                ;(imports[owner] ??= Object.create(null))[specifier] = target
                await contract(target, true)
                owner = target
              }
            }
            return true
          }

          await scan(root)
          for (const [file, source] of sources) {
            const links = (imports[identity(file)] = Object.create(null))
            for (const node of snapshot.parse({
              moduleId: identity(file),
              source,
            }).program.body) {
              if (
                (node.type !== 'ImportDeclaration' &&
                  node.type !== 'ExportNamedDeclaration' &&
                  node.type !== 'ExportAllDeclaration') ||
                !node.source
              )
                continue
              if (
                node.type === 'ImportDeclaration'
                  ? node.importKind === 'type'
                  : node.exportKind === 'type'
              )
                continue
              if (
                'specifiers' in node &&
                node.specifiers.length &&
                node.specifiers.every((specifier) =>
                  specifier.type === 'ImportSpecifier'
                    ? specifier.importKind === 'type'
                    : specifier.type === 'ExportSpecifier' &&
                      specifier.exportKind === 'type',
                )
              )
                continue

              const specifier = node.source.value
              links[specifier] = null
              if (
                specifier === 'zyzz' ||
                (specifier.startsWith('zyzz/') &&
                  specifier !== 'zyzz/default') ||
                /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(specifier) ||
                specifier.includes('?')
              )
                continue
              const target = await resolve(specifier, file)
              if (!target || !sourcePattern.test(target)) continue
              files.add(target)
              if (sources.has(target)) links[specifier] = identity(target)
              else if (await contract(target)) links[specifier] = target
            }
          }

          // Only the combined stylesheet is emitted, so generated theme rules are shared once.
          const result = compiler.compile({
            [ClassName.complete]: true,
            // Only this application's sources reference its definitions.
            [ClassName.references]: true,
            [ThemeRules.shared]: 'all',
            compiler: options.compiler,
            reset: options.reset ? Reset.read() : undefined,
            contracts,
            imports,
            modules,
          })
          const copied = new Map<string, string>()
          const owners = new Map<string, string>()

          async function owner(id: string): Promise<string> {
            if (id.startsWith('app/')) return Fs.realpath(root)
            const cached = owners.get(id)
            if (cached) return cached

            let directory = Path.dirname(id)
            for (;;) {
              try {
                await Fs.access(Path.join(directory, 'package.json'))
                const real = await Fs.realpath(directory)
                owners.set(id, real)
                return real
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                  throw error
                const parent = Path.dirname(directory)
                if (parent === directory)
                  throw new Error(
                    'Packed assets require an owning package.json.',
                  )
                directory = parent
              }
            }
          }

          async function copy(file: string, boundary: string): Promise<string> {
            const real = await Fs.realpath(file)
            if (!inside(boundary, real))
              throw new Error('Asset path escapes its owning package.')
            files.add(real)
            const cached = copied.get(real)
            if (cached) return cached

            const content = await Fs.readFile(real)
            const name = `zyzz-assets/${Crypto.hash('sha256', real + '\0' + content.toString('base64')).slice(0, 16)}${Path.extname(real)}`
            copied.set(real, name)
            if (real.endsWith('.css')) {
              const processed = await stylesheet(
                content.toString(),
                undefined,
                real,
                boundary,
                Path.posix.dirname(name),
              )
              assets.set(name, processed.code)
            } else assets.set(name, content)
            return name
          }

          async function stylesheet(
            source: string,
            map: string | undefined,
            file: string,
            boundary: string,
            outputDirectory = '.',
            targets?: Readonly<Record<string, string>>,
            emitted: ReadonlySet<string> = new Set(),
          ) {
            const urls = new Set<string>()
            AtRules.transform({
              code: Buffer.from(source),
              filename: file,
              visitor: {
                Rule(rule) {
                  if (rule.type === 'import') urls.add(rule.value.url)
                },
                Url(url) {
                  urls.add(url.url)
                },
              },
            })
            const replacements = new Map<string, string>()
            for (const url of urls) {
              const target = targets?.[url]
              if (
                !target &&
                (!url || /^(?:[a-z][a-z\d+.-]*:|[/?#])/i.test(url))
              )
                continue
              const raw = (target ?? url).split(/[?#]/)[0]!
              const path = (() => {
                if (!target)
                  return Path.resolve(
                    Path.dirname(file),
                    decodeURIComponent(raw),
                  )
                if (raw.startsWith('app/'))
                  return Path.join(root, decodeURIComponent(raw.slice(4)))
                return decodeURIComponent(raw)
              })()
              const assetOwner = target
                ? await owner(result.sharedAssetOwners?.[url] ?? 'app/')
                : boundary
              const name = await copy(path, assetOwner)
              replacements.set(
                url,
                Path.posix.relative(outputDirectory, name) +
                  (target ?? url).slice(raw.length),
              )
            }
            return AtRules.transform({
              code: Buffer.from(source),
              filename: file,
              ...(map === undefined
                ? {}
                : { inputSourceMap: map, sourceMap: true }),
              visitor: {
                Rule(rule) {
                  // Shared rules repeat in each module that uses them, so keep the first.
                  if (rule.type === 'style') {
                    const [selector, ...others] = rule.value.selectors
                    const [component, ...rest] = selector ?? []
                    if (
                      !others.length &&
                      !rest.length &&
                      component?.type === 'class' &&
                      emitted.has(component.name)
                    )
                      return []
                  }
                  if (rule.type !== 'import') return
                  const url = replacements.get(rule.value.url)
                  if (url) return AtRules.relocateImport(rule.value, url)
                },
                Url(url) {
                  const target = replacements.get(url.url)
                  if (target) return { ...url, url: target }
                },
              },
            })
          }

          const shared = await stylesheet(
            result.sharedCss ?? '',
            JSON.stringify(
              result.sharedCssMap ??
                Mapping.toEncodedMap(new Mapping.GenMapping()),
            ),
            Path.join(root, 'zyzz.css'),
            await Fs.realpath(root),
            '.',
            result.sharedAssets,
          )
          const chunks = [
            {
              code: Buffer.from(shared.code).toString(),
              map: Buffer.from(shared.map!).toString(),
            },
          ]
          const seen = new Set<string>()
          const units = new Set<string>()
          async function visit(id: string): Promise<void> {
            if (seen.has(id)) return
            seen.add(id)
            for (const dependency of result.dependencies[id] ?? [])
              await visit(dependency)
            const output = result.modules[id]
            if (output) {
              const names = [...(output[ClassName.units]?.values() ?? [])].map(
                (decision) => decision.name,
              )
              const processed = await stylesheet(
                output.css,
                JSON.stringify(output.cssMap),
                Path.join(root, id.slice(4)),
                await Fs.realpath(root),
                '.',
                undefined,
                new Set(names.filter((name) => units.has(name))),
              )
              for (const name of names) units.add(name)
              chunks.push({
                code: Buffer.from(processed.code).toString(),
                map: Buffer.from(processed.map!).toString(),
              })
            }
          }
          const ids = Object.keys(result.modules)
          const imported = new Set(Object.values(result.dependencies).flat())
          for (const id of ids) if (!imported.has(id)) await visit(id)
          for (const id of ids) await visit(id)

          const map = new Mapping.GenMapping({ file: 'zyzz.css' })
          let line = 0
          css = ''
          for (const chunk of chunks) {
            if (!chunk.code.trim()) continue
            const traced = Mapping.fromMap(chunk.map)
            for (const mapping of Mapping.allMappings(traced)) {
              const generated = {
                line: mapping.generated.line + line,
                column: mapping.generated.column,
              }
              if (
                mapping.source !== undefined &&
                mapping.original !== undefined
              ) {
                const location = {
                  generated,
                  original: mapping.original,
                  source: mapping.source.startsWith('app/')
                    ? Path.join(root, mapping.source.slice(4))
                    : mapping.source,
                }
                if (mapping.name === undefined)
                  Mapping.addMapping(map, location)
                else
                  Mapping.addMapping(map, { ...location, name: mapping.name })
              } else Mapping.addMapping(map, { generated })
            }
            const encoded = Mapping.toEncodedMap(traced)
            encoded.sources.forEach((source, index) => {
              if (source !== null)
                Mapping.setSourceContent(
                  map,
                  source.startsWith('app/')
                    ? Path.join(root, source.slice(4))
                    : source,
                  encoded.sourcesContent?.[index] ?? null,
                )
            })
            css += chunk.code + '\n'
            line += chunk.code.split('\n').length
          }
          cssMap = JSON.stringify(Mapping.toEncodedMap(map))
          script = Catalogs.scripts(
            Object.values({ ...contracts, ...result.contracts }).flatMap(
              Catalogs.read,
            ),
          ).join('\n')
          snapshot.retain(files, modules)
          graph = result
          if (meta.framework === 'webpack') emit(this)
          if (meta.framework === 'rollup')
            for (const file of [...files, ...directories])
              this.addWatchFile(file)
        })()
        await pending
      },
      enforce: 'pre',
      esbuild: {
        config(options) {
          if (!options.outdir || options.write === false)
            throw new Error(
              'Zyzz requires esbuild outdir and write: true to emit CSS assets.',
            )
          options.outdir = Path.resolve(
            options.absWorkingDir ?? process.cwd(),
            options.outdir,
          )
        },
        setup(build) {
          // Unplugin forwards watchFiles but not watchDirs from its transform hook.
          build.onLoad({ filter: sourcePattern }, async ({ path }) => {
            await pending
            if (!sources.has(path)) return
            const output = transform(await Fs.readFile(path, 'utf8'), path)
            if (!output) return
            return {
              contents: `${output.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(output.map).toString('base64')}`,
              loader: (() => {
                if (path.endsWith('.tsx')) return 'tsx'
                if (path.endsWith('.jsx')) return 'jsx'
                if (/\.[cm]?ts$/.test(path)) return 'ts'
                return 'js'
              })(),
              resolveDir: Path.dirname(path),
              watchDirs: [...directories],
              watchFiles: [...files],
            }
          })
        },
      },
      name: 'zyzz',
      rollup: {
        shouldTransformCachedModule() {
          return true
        },
      },
      transform: {
        filter: {
          id: {
            include: sourcePattern,
            exclude:
              /(?:^|[/\\])node_modules[/\\]|\.(?:d|test|test-d|bench|bench-d)\.[cm]?[jt]sx?$/,
          },
        },
        async handler(code, id) {
          await pending
          const output = transform(code, id)
          if (!output) return
          for (const file of files) this.addWatchFile(file)
          const native = this.getNativeBuildContext?.()
          for (const directory of directories) {
            if (native?.framework === 'webpack')
              native.loaderContext?.addContextDependency(directory)
            else if (meta.framework === 'rollup') this.addWatchFile(directory)
          }
          return output
        },
      },
      webpack(compiler) {
        compiler.hooks.compilation.tap('zyzz', (compilation) => {
          compiler.webpack.NormalModule.getCompilationHooks(compilation)
            .readResource.for(undefined)
            .tapAsync({ name: 'zyzz', stage: -1 }, (context, callback) => {
              void Promise.resolve(pending).then(() => {
                const source = sources.get(context.resourcePath)
                if (source === undefined) return callback()

                // Loaders and CSS compilation must consume the same source version.
                context.addDependency(context.resourcePath)
                callback(null, source)
              }, callback)
            })
        })
        compiler.hooks.watchRun.tap('zyzz', () => {
          // The graph rereads every source, including files absent from Webpack's invalidation batch.
          for (const file of files) compiler.inputFileSystem?.purge?.(file)
        })
      },
    }
  },
)

/** Bundler factories. Vite retains its native CSS delivery and environment-specific HMR. */
export const zyzz = {
  /** Creates an esbuild plugin that emits stylesheets and watches source directories. */
  esbuild: portable.esbuild,
  /** Creates a Rollup plugin with dependency-aware cached transforms. */
  rollup: portable.rollup,
  /** Creates the existing Vite plugin with automatic CSS delivery and HMR. */
  vite: Vite.zyzz,
  /** Creates a Webpack plugin that compiles before language loaders. */
  webpack: portable.webpack,
}

function inside(parent: string, child: string) {
  const relative = Path.relative(parent, child)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${Path.sep}`) &&
      !Path.isAbsolute(relative))
  )
}
