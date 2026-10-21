/**
 * Connects static Zyzz source compilation to Vite resolution and CSS delivery.
 * @module
 */
import * as Namespaces from '../compiler/internal/Namespaces.js'
import * as AtRules from '../compiler/internal/AtRules.js'
import * as Catalogs from '../compiler/internal/Catalogs.js'
import * as Results from '../compiler/internal/Results.js'
import * as Contracts from '../node/internal/Contracts.js'
import * as Mapping from '@jridgewell/gen-mapping'
import * as Lightning from 'lightningcss'
import * as Crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'
import * as Reset from '../node/Reset.js'
import * as Vlq from '../internal/Vlq.js'
import { createRequire, isBuiltin } from 'node:module'
import * as Parser from 'oxc-parser'
import * as Walker from 'oxc-walker'
import * as Snapshot from '../node/internal/Snapshot.js'
import * as Scope from '../compiler/internal/Scope.js'
import type {
  DevEnvironment,
  Environment,
  EnvironmentModuleNode,
  Plugin,
  Rollup,
  UserConfig,
  ViteDevServer,
} from 'vite'
import * as Graph from '../compiler/Graph.js'
import * as Source from '../compiler/Source.js'
import * as ClassName from '../web/internal/ClassName.js'
import * as ThemeRules from '../web/internal/Themes.js'

/**
 * Compiles physical project source without executing authoring code.
 * Vite owns resolution, transpilation, CSS processing, watching, and HMR.
 * @returns A Vite 8 plugin with isolated state for each environment.
 */
export function zyzz(options: zyzz.Options = {}): Plugin {
  const native = options.native
    ? Object.freeze({
        ...options.native,
        fonts:
          options.native.fonts && Object.freeze({ ...options.native.fonts }),
        vars: options.native.vars && Object.freeze({ ...options.native.vars }),
        units:
          options.native.units && Object.freeze({ ...options.native.units }),
      })
    : undefined
  if (native && options.reset)
    throw new Error('The CSS reset is only supported by web builds.')
  if (native && options.compiler === false)
    throw new Error('Native builds require source compilation.')

  const snapshots = new WeakMap<
    Environment,
    ReturnType<typeof Snapshot.create>
  >()
  const states = new WeakMap<Environment, Map<string, Entry>>()
  const removed = new WeakMap<Environment, Set<string>>()
  const reads = new WeakMap<Environment, Map<string, string>>()
  const lookups = new WeakMap<Environment, Lookups>()
  const compilers = new WeakMap<Environment, Graph.create.ReturnType>()
  const projects = new WeakMap<Environment, Project>()
  // The shared stylesheet each environment last loaded, which an edit compares against.
  const servedShared = new WeakMap<Environment, string>()
  // Watcher events advance an environment's generation, which scopes memoized whole-project work.
  const generations = new WeakMap<Environment, number>()
  // Modules whose last compile failed. A created file can satisfy one of their imports.
  const failures = new WeakMap<Environment, Set<string>>()
  let devServer: ViteDevServer | undefined
  const watching = new Set<string>()
  // Chokidar matches its ignore patterns on every add, and each compile watches its whole closure.
  const watched = new Set<string>()
  // Each compile reads the catalogs of every contract it saw, which rarely changes text.
  const catalogReads = new Map<string, readonly Catalogs.Catalog[]>()
  const dependencyChains = new Map<string, readonly (readonly unknown[])[]>()
  const edgeMemos = new WeakMap<
    Environment,
    { files: Map<string, Edges>; key: string }
  >()
  // A development entry's last output, reused until a watcher event or a recompile of its module.
  const outputs = new WeakMap<
    Entry,
    {
      allSources: boolean
      code: string | undefined
      generation: number
      output: Awaited<ReturnType<typeof compileEntry>>
      result: Graph.compile.ReturnType
    }
  >()
  const packages = Contracts.create()

  function compiler(environment: Environment) {
    let value = compilers.get(environment)
    if (!value) {
      value = Graph.create()
      compilers.set(environment, value)
    }
    return value
  }

  /**
   * Watches a compile input from a hook. Vite checks the filesystem each time a file outside its
   * root is watched, and every compile reads the same package files, so development watches
   * each of those once.
   */
  function watcher(context: { addWatchFile: (id: string) => void }) {
    return (file: string) => {
      if (devServer && !file.startsWith(`${devServer.config.root}/`)) {
        if (watching.has(file)) return

        watching.add(file)
      }

      context.addWatchFile(file)
    }
  }

  /**
   * The packed stylesheet dependency chains of a library contract. Every compile reads each
   * contract it reaches, and design system contracts are large, so each text parses once.
   */
  function stylesheetDependencies(id: string, contract: string) {
    let value = dependencyChains.get(contract)
    if (value) return value

    const metadata = (() => {
      try {
        return JSON.parse(contract)
      } catch (error) {
        Graph.compile({ modules: {}, contracts: { [id]: contract } })
        throw error
      }
    })()

    value = Array.isArray(metadata?.stylesheets)
      ? (metadata.stylesheets as readonly { dependency?: unknown }[])
          .map((section) => section?.dependency)
          .filter((dependency): dependency is readonly unknown[] =>
            Array.isArray(dependency),
          )
      : []
    // Rebuilt libraries leave their earlier texts behind, so the cache stays bounded.
    if (dependencyChains.size > 256) dependencyChains.clear()
    dependencyChains.set(contract, value)
    return value
  }

  /**
   * Each module's import edges in an environment, shared by every entry compile that walks the
   * module. Added and removed files and dependency optimization change resolutions, so either
   * starts over.
   */
  function importEdges(environment: Environment) {
    const metadata =
      environment.mode === 'dev'
        ? (environment as DevEnvironment).depsOptimizer?.metadata
        : undefined
    const key = `${metadata?.browserHash}:${Object.keys(metadata?.discovered ?? {}).length}`
    let value = edgeMemos.get(environment)

    if (value?.key !== key) {
      value = { files: new Map(), key }
      edgeMemos.set(environment, value)
    }

    return value.files
  }

  /** Adds a compile input to the development watcher once. */
  function watch(server: ViteDevServer, file: string) {
    if (watched.has(file)) return

    watched.add(file)
    server.watcher.add(file)
  }

  function read(contract: string) {
    let value = catalogReads.get(contract)

    if (!value) {
      if (catalogReads.size > 256) catalogReads.clear()

      value = Catalogs.read(contract)
      catalogReads.set(contract, value)
    }

    return value
  }

  function project(environment: Environment) {
    let value = projects.get(environment)
    if (!value) {
      value = {
        compiler: Graph.create(),
        contracts: Object.create(null),
        fallback: Graph.create(),
        imports: Object.create(null),
        modules: Object.create(null),
        outcome: undefined,
        pending: undefined,
        stale: false,
      }
      projects.set(environment, value)
    }
    return value
  }

  /**
   * Development merges every module a transform reaches into one graph per environment, so
   * modules compile once per change instead of once per importer. A module's output depends only
   * on its own import closure, so the merged graph returns the output a closure compile would.
   * Transforms that merge changes in one event loop turn share one compile. While some other
   * module fails, the requested closure compiles alone and reports only its own errors, as before.
   */
  async function compileProject(
    environment: Environment,
    input: Graph.compile.Options,
    id: string,
  ) {
    const value = project(environment)

    if (value.outcome === undefined) value.stale = true

    for (const [module, source] of Object.entries(input.modules))
      if (value.modules[module] !== source) {
        value.modules[module] = source
        value.stale = true
      }

    for (const [module, resolutions] of Object.entries(input.imports ?? {}))
      if (!same(value.imports[module], resolutions)) {
        value.imports[module] = resolutions
        value.stale = true
      }

    for (const [module, contract] of Object.entries(input.contracts ?? {}))
      if (value.contracts[module] !== contract) {
        value.contracts[module] = contract
        value.stale = true
      }

    if (value.stale)
      await (value.pending ??= new Promise<void>((resolve) =>
        setImmediate(() => {
          value.pending = undefined
          value.stale = false
          value.outcome = (() => {
            try {
              return {
                result: value.compiler.compile({
                  ...input,
                  contracts: value.contracts,
                  imports: value.imports,
                  modules: value.modules,
                }),
              }
            } catch (error) {
              return { error }
            }
          })()
          resolve()
        }),
      ))

    const outcome = value.outcome!

    if ('result' in outcome && Object.hasOwn(outcome.result.modules, id))
      return outcome.result

    return value.fallback.compile(input)
  }

  const discoveries = new WeakMap<Environment, Promise<Map<string, string>>>()
  // Sources compiled in every graph: stylesheet contributions, and in builds, selector
  // interpolations of style definitions.
  const contributionFiles = new WeakMap<Environment, Set<string>>()
  const assets = new Map<string, string>()
  const catalogs = new Map<string, Catalogs.Catalog>()
  const edges = new Map<string, ReadonlySet<string>>()
  const graphs = new Map<string, ReadonlySet<string>>()
  const initializers = new WeakMap<Environment, Entry>()
  const sourceEntrypoints = new Set<string>()
  const identities = new Map<string, string>()
  const exclusions = new Map<string, boolean>()
  // Every compile checks each import against the source directories.
  const roots = new Map<string, string | undefined>()
  const lazyImports = new WeakMap<Parser.ParseResult, string[]>()
  const nestedPackages = new Map<string, boolean>()
  const contributions = new Map<string, boolean>()
  let directories: readonly string[]
  // The directories discovery walks, and the include patterns that narrow it.
  let scopes: readonly string[]
  let scoped: ((id: unknown) => boolean) | undefined
  let filter: (id: unknown) => boolean
  let optimizeRuntime = false
  let root: string

  function snapshot(environment: Environment) {
    let value = snapshots.get(environment)
    if (!value) {
      value = Snapshot.create()
      snapshots.set(environment, value)
    }
    return value
  }

  function entries(environment: Environment) {
    let state = states.get(environment)

    if (!state) {
      state = new Map()
      states.set(environment, state)
    }

    return state
  }

  function sourceId(file: string) {
    let id = identities.get(file)
    if (!id) {
      const directory = sourceRoot(file) ?? root
      const namespace =
        directory === root
          ? 'app'
          : `include-${directories.indexOf(directory) - 1}`
      id = `${namespace}/${Path.relative(directory, file).split(Path.sep).join('/')}`
      identities.set(file, id)
    }
    return id
  }

  // Included directories have portable namespaces rather than traversal IDs.
  function sourceFile(id: string) {
    const offset = id.indexOf('/')
    const namespace = id.slice(0, offset)
    const directory = (() => {
      if (namespace === 'app') return root
      if (/^include-\d+$/.test(namespace))
        return directories[Number(namespace.slice(8)) + 1]
      return undefined
    })()

    return directory === undefined
      ? undefined
      : Path.join(directory, id.slice(offset + 1))
  }

  function resource(id: string) {
    const query = id.split('?')[1]?.split('#')[0]

    return (
      query !== undefined &&
      [...new URLSearchParams(query).keys()].some(
        // TanStack splits fresh physical source after pre-transforms, not the
        // transformed route. Compile these requests under the same source identity.
        (key) => !['import', 't', 'tsr-split', 'v'].includes(key),
      )
    )
  }

  function normalize(id: string) {
    return resource(id) ? id : id.split('?')[0]!
  }

  function eligible(id: string) {
    if (sourceEntrypoints.has(normalize(id))) return true
    // Ids carrying foreign queries are Vite resources such as inline-module proxies, not source.
    if (resource(id)) return false

    return (
      Path.isAbsolute(id) &&
      sourceRoot(id) !== undefined &&
      /\.[cm]?[jt]sx?$/.test(id) &&
      !/\.(?:d|test|test-d|bench|bench-d)\.[cm]?[jt]sx?$/.test(id) &&
      !excluded(id)
    )
  }

  /** Matches excluded files inside source directories. Package files never match, so packed contracts stay readable. */
  function excluded(id: string) {
    const file = id.split(/[?#]/)[0]!
    let value = exclusions.get(file)

    // Vite's filter recompiles each glob per call, and every compile checks each import.
    if (value === undefined) {
      value =
        Path.isAbsolute(file) && sourceRoot(file) !== undefined && !filter(file)
      exclusions.set(file, value)
    }

    return value
  }

  function sourceRoot(file: string) {
    if (roots.has(file)) return roots.get(file)

    const root = directories.find((directory) => contains(directory, file))

    roots.set(file, root)
    return root
  }

  function discover(environment: Environment, host: Host) {
    let pending = discoveries.get(environment)

    if (!pending) {
      pending = (async () => {
        const sources = new Map<string, string>()
        const eagerFiles = new Set<string>()
        const visited = new Set<string>()
        const files: string[] = []

        contributionFiles.set(environment, eagerFiles)

        // Discovery runs while the server transforms its first requests, so sibling directories
        // and file reads overlap. Files keep the walk's order, which orders the stylesheet's
        // contributions.
        async function collect(directory: string): Promise<readonly string[]> {
          if (visited.has(directory)) return []
          visited.add(directory)

          const items = await Fs.readdir(directory, { withFileTypes: true })
          const found = await Promise.all(
            items.map((item) => {
              if (skipped(item.name)) return []

              const file = Path.join(directory, item.name)

              if (item.isDirectory()) return nested(file) ? [] : collect(file)
              if (!item.isFile() || !eager(file, environment)) return []

              host.watch(file)
              return [file]
            }),
          )

          return found.flat()
        }

        for (const directory of scopes)
          files.push(...(await collect(directory)))

        // Reads stay in batches under low descriptor limits.
        const texts: string[] = []

        for (let start = 0; start < files.length; start += 64)
          texts.push(
            ...(await Promise.all(
              files
                .slice(start, start + 64)
                .map((file) => Fs.readFile(file, 'utf8')),
            )),
          )

        for (const [index, file] of files.entries()) {
          const source = texts[index]!

          sources.set(file, source)

          if (
            contributes(environment, file, source) ||
            (environment.mode === 'build' && interpolates(source))
          )
            eagerFiles.add(file)
        }

        return sources
      })()
      discoveries.set(environment, pending)
    }

    return pending
  }

  /**
   * Whether a directory below a source directory holds its own `package.json`. A nested package,
   * such as a workspace example, is a separate project with its own build, so discovery skips it.
   * Its sources still compile when the application imports them. With `include`, the patterns
   * alone decide.
   */
  function nested(directory: string) {
    let value = nestedPackages.get(directory)

    if (value === undefined) {
      value =
        scoped === undefined &&
        !scopes.includes(directory) &&
        !directories.includes(directory) &&
        existsSync(Path.join(directory, 'package.json'))
      nestedPackages.set(directory, value)
    }

    return value
  }

  function eager(file: string, environment: Environment) {
    // Watcher events reach files outside the scopes that discovery walked.
    if (!scopes.some((scope) => contains(scope, file))) return false
    if (scoped && !scoped(file)) return false

    const directory = sourceRoot(file)

    // Watcher events reach files below nested packages that discovery never visited.
    for (
      let parent = Path.dirname(file);
      directory !== undefined && parent !== directory;
      parent = Path.dirname(parent)
    )
      if (nested(parent)) return false

    return (
      eligible(file) &&
      file !== environment.config.configFile &&
      !environment.config.configFileDependencies.includes(file) &&
      // Server entrypoints must not contribute to the client stylesheet scan.
      !(
        environment.config.consumer === 'client' &&
        /\.server\.[cm]?[jt]sx?$/.test(file)
      ) &&
      !Path.relative(sourceRoot(file)!, file)
        .split(Path.sep)
        .some((part) =>
          ['test', 'tests', '__tests__', 'fixtures', '__fixtures__'].includes(
            part,
          ),
        )
    )
  }

  /**
   * Whether a discovered source calls a stylesheet contribution. Every environment discovers the
   * same sources, and the compile that visits one reuses the syntax parsed here.
   */
  function contributes(environment: Environment, file: string, source: string) {
    let value = contributions.get(source)

    if (value === undefined) {
      if (contributions.size > 4096) contributions.clear()

      value = scanContributions(
        snapshot(environment).parse({ moduleId: sourceId(file), source })
          .program,
      )
      contributions.set(source, value)
    }

    return value
  }

  function scanContributions(program: Parser.ParseResult['program']) {
    const imports = new Map<number, string>()

    for (const node of program.body) {
      if (node.type !== 'ImportDeclaration' || node.importKind === 'type')
        continue

      for (const specifier of node.specifiers) {
        if (
          specifier.type !== 'ImportSpecifier' ||
          specifier.importKind === 'type'
        )
          continue

        const name =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value

        if (
          node.source.value === 'zyzz/web'
            ? [
                'colorProfile',
                'counterStyle',
                'cssFunction',
                'customMedia',
                'fontFace',
                'fontFeatureValues',
                'fontPaletteValues',
                'global',
                'importCss',
                'keyframes',
                'layers',
                'namespace',
                'page',
                'positionTry',
                'viewTransition',
              ].includes(name)
            : name === 'Config' || node.source.value !== 'zyzz'
        )
          imports.set(specifier.start, name)
      }
    }
    // Local call imports are candidates; Graph follows their re-exports before emission.

    if (!imports.size) return false

    const scopeTracker = new Scope.Tracker({ preserveExitedScopes: true })

    Walker.walk(program, { scopeTracker })
    scopeTracker.freeze()

    let found = false

    Walker.walk(program, {
      scopeTracker,
      enter(node) {
        if (node.type !== 'CallExpression') return

        const callee = node.callee

        if (callee.type === 'Identifier') {
          const binding = scopeTracker.getDeclaration(callee.name)

          if (
            binding?.type === 'Import' &&
            imports.has(binding.node.start) &&
            imports.get(binding.node.start) !== 'Config'
          )
            found = true
        } else if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'create'
        ) {
          const binding = scopeTracker.getDeclaration(callee.object.name)
          const argument = node.arguments[0]

          if (
            binding?.type === 'Import' &&
            imports.get(binding.node.start) === 'Config' &&
            argument?.type === 'ObjectExpression' &&
            argument.properties.some(
              (property) =>
                property.type === 'Property' &&
                (property.key.type === 'Identifier'
                  ? property.key.name === 'layers'
                  : property.key.type === 'Literal' &&
                    property.key.value === 'layers'),
            )
          )
            found = true
        }
      },
    })

    return found
  }

  /**
   * Whether a source may interpolate a style definition into a selector key. Builds compile
   * these files in every graph, so each graph sees every selector that names a definition.
   */
  function interpolates(source: string) {
    if (!source.includes('${')) return false

    const { program } = Parser.parseSync('source.tsx', source, {
      sourceType: 'module',
    })
    let found = false

    Walker.walk(program, {
      enter(node) {
        if (
          node.type === 'Property' &&
          node.computed &&
          node.key.type === 'TemplateLiteral' &&
          node.key.expressions.length
        )
          found = true
      },
    })

    return found
  }

  async function updateDiscovery(
    environment: Environment,
    file: string,
    event: string,
  ) {
    reads.delete(environment)
    generations.set(environment, (generations.get(environment) ?? 0) + 1)

    const changed = entries(environment).get(file)

    if (changed) changed.source = undefined

    // An edit keeps every resolution. Adding or removing a file can change where a
    // specifier resolves, and a contract derives again only when a file it read changes.
    // Editors save through temporary files, which no specifier resolves to.
    const resolvable =
      event !== 'update' &&
      /\.(?:[cm]?[jt]sx?|json|css|svelte|vue)$|(?:^|[/\\])package\.json$/.test(
        file,
      )
    const cache = lookups.get(environment)

    // Import edges derive from resolutions and module text, which each memo compares.
    if (resolvable) edgeMemos.delete(environment)

    // A manifest added or removed moves a nested-package boundary for later watcher events.
    // Sources discovery already collected keep their status until the server restarts.
    if (event !== 'update' && Path.basename(file) === 'package.json')
      nestedPackages.clear()

    if (cache) {
      if (resolvable) cache.resolutions.clear()

      for (const [key, files] of cache.read)
        if (files.has(file)) {
          cache.contracts.delete(key)
          cache.read.delete(key)
        }
    }

    if (event === 'delete') {
      const value = projects.get(environment)
      const id = sourceId(file)

      if (value && Object.hasOwn(value.modules, id)) {
        delete value.modules[id]
        delete value.imports[id]
        value.outcome = undefined
      }
    }

    if (event === 'delete') {
      if (entries(environment).has(file)) {
        let files = removed.get(environment)
        if (!files) {
          files = new Set()
          removed.set(environment, files)
        }
        files.add(file)
      }
      entries(environment).delete(file)
      failures.get(environment)?.delete(file)
      snapshot(environment).delete(file, sourceId(file))
      identities.delete(file)
    }

    const pending = discoveries.get(environment)
    if (!pending || !eager(file, environment)) return

    const sources = await pending

    if (event === 'delete') sources.delete(file)
    else {
      const source = await Fs.readFile(file, 'utf8')

      sources.set(file, source)

      if (
        contributes(environment, file, source) ||
        (environment.mode === 'build' && interpolates(source))
      )
        contributionFiles.get(environment)?.add(file)
      else contributionFiles.get(environment)?.delete(file)
    }
  }

  async function compile(
    entry: Entry,
    host: Host,
    code?: string,
    allSources = false,
    everything = false,
  ) {
    const generation = generations.get(entry.environment) ?? 0
    const memo = outputs.get(entry)
    const current = projects.get(entry.environment)?.outcome

    // Without a watcher event the closure is unchanged, so a stylesheet load after its
    // transform reuses the output while the merged graph keeps the module's compiled output.
    // Merging other modules leaves it, unless one is code the module's own compile had read
    // from disk. The shared stylesheet reads every module merged so far, so it waits for an
    // unchanged graph.
    if (
      memo &&
      !everything &&
      memo.allSources === allSources &&
      memo.generation === generation &&
      (code === undefined || code === memo.code) &&
      current &&
      'result' in current &&
      (allSources
        ? current.result === memo.result
        : current.result.modules[sourceId(entry.file)] ===
          memo.result.modules[sourceId(entry.file)])
    ) {
      for (const file of entry.files) host.watch(file)
      return memo.output
    }

    let failed = failures.get(entry.environment)
    if (!failed) {
      failed = new Set()
      failures.set(entry.environment, failed)
    }

    const output = await compileEntry(
      entry,
      host,
      code,
      allSources,
      everything,
    ).catch((error: unknown) => {
      failed.add(entry.file)
      throw error
    })

    failed.delete(entry.file)

    const outcome = projects.get(entry.environment)?.outcome

    // A concurrent compile can replace the merged result while this one renders, so only an
    // output of the current result is kept.
    if (
      entry.environment.mode === 'dev' &&
      !everything &&
      outcome &&
      'result' in outcome &&
      outcome.result.modules === output.modules &&
      generation === (generations.get(entry.environment) ?? 0)
    )
      outputs.set(entry, {
        allSources,
        code,
        generation,
        output,
        result: outcome.result,
      })

    return output
  }

  async function compileEntry(
    entry: Entry,
    host: Host,
    code?: string,
    allSources = false,
    everything = false,
  ) {
    // Every compile visits the discovered project, so modules share lookups. Watcher events
    // drop the resolutions and contracts a change can affect. Full-project compiles look up
    // afresh, since a document must not trail the watcher.
    const cache = (() => {
      const fresh: Lookups = {
        contracts: new Map(),
        read: new Map(),
        resolutions: new Map(),
      }
      if (everything) return fresh

      let value = lookups.get(entry.environment)
      if (!value) {
        value = fresh
        lookups.set(entry.environment, value)
      }
      return value
    })()

    // Full-project compiles walk afresh, as they look up afresh.
    const memos = everything ? undefined : importEdges(entry.environment)

    async function resolve(source: string, importer: string) {
      if (isBuiltin(source)) return { id: source, external: true }

      const key = `${importer}\0${source}`
      let pending = cache.resolutions.get(key)
      if (!pending) {
        pending = host.resolve(source, importer)
        cache.resolutions.set(key, pending)
        pending.catch(() => cache.resolutions.delete(key))
      }

      const resolved = await pending
      if (!resolved) return resolved

      if (entry.environment.mode === 'dev') {
        const source = optimized().get(resolved.id.split('?')[0]!)
        if (source) return { ...resolved, id: source }
      }

      return { ...resolved, id: normalize(resolved.id) }
    }

    /**
     * Starts the lookups of a module's static imports, which an ordered walk then settles. A
     * lookup that fails leaves no cached result, so the walk reports it.
     */
    function prefetch(file: string, program: Parser.ParseResult['program']) {
      for (const node of program.body) {
        if (
          node.type !== 'ImportDeclaration' &&
          node.type !== 'ExportNamedDeclaration' &&
          node.type !== 'ExportAllDeclaration'
        )
          continue

        const specifier = node.source?.value

        if (
          specifier === undefined ||
          (node.type === 'ImportDeclaration'
            ? node.importKind
            : node.exportKind) === 'type' ||
          specifier === 'zyzz' ||
          specifier.startsWith('zyzz/')
        )
          continue

        resolve(specifier, file).catch(() => undefined)
      }
    }

    // Optimized dependency sources by bundled file, indexed once per compile rather than
    // searched for every resolution.
    let indexed: Map<string, string> | undefined

    function optimized() {
      if (indexed) return indexed

      indexed = new Map()

      const environment = entry.environment
      const metadata =
        environment.mode === 'dev'
          ? environment.depsOptimizer?.metadata
          : undefined

      // Discovered entries replace optimized ones of the same name, and the first entry
      // bundling a file wins, as a search of the merged record finds it.
      for (const item of Object.values({
        ...metadata?.optimized,
        ...metadata?.discovered,
      }))
        if (!indexed.has(item.file)) indexed.set(item.file, item.src ?? '')

      return indexed
    }

    const imports: Record<
      string,
      Record<string, string | null>
    > = Object.create(null)
    const contracts: Record<string, string> = Object.create(null)
    const lazy: Record<string, ReadonlySet<string>> = Object.create(null)
    const modules: Record<string, string> = Object.create(null)
    const files = new Set<string>()

    // A package contract derives from the files it reads and the resolutions
    // above. A cached contract still makes this compile watch those files.
    async function readContract(file: string, required = false) {
      const key = `${required}\0${file}`
      let pending = cache.contracts.get(key)
      if (!pending) {
        const read = new Set<string>()

        pending = packages
          .read(file, {
            read: async (path) => {
              const source = await snapshot(entry.environment).read(path)
              read.add(path)
              return source
            },
            required,
            resolve: async (specifier, importer) =>
              (await resolve(specifier, importer))?.id.split(/[?#]/)[0],
          })
          .then((contract) => {
            cache.read.set(key, read)
            return { contract, files: read }
          })
        cache.contracts.set(key, pending)
        pending.catch(() => cache.contracts.delete(key))
      }

      const derived = await pending

      for (const path of derived.files) {
        if (files.has(path)) continue

        files.add(path)
        host.watch(path)
      }

      return derived.contract
    }

    async function visit(file: string, source?: string) {
      if (files.has(file)) return

      files.add(file)
      host.watch(file)

      const id = sourceId(file)
      let cached = reads.get(entry.environment)
      if (!cached) {
        cached = new Map()
        reads.set(entry.environment, cached)
      }
      // Earlier plugins can rewrite a module before this one sees it, as router plugins drop
      // server routes from client route trees. Its importers read the code Vite transformed, so
      // every graph in the environment holds one version of each module.
      // Full-project compilation must not reuse reads from concurrent module transforms.
      const text =
        source ??
        (everything
          ? undefined
          : entries(entry.environment).get(file)?.source) ??
        (everything ? undefined : cached.get(file)) ??
        (await snapshot(entry.environment).read(file))
      if (!everything) cached.set(file, text)

      modules[id] = text

      const memo = memos?.get(file)

      // Replaying the edges keeps the order in which modules and contracts join the compile.
      if (memo?.text === text) {
        imports[id] = { ...memo.resolutions }

        for (const step of memo.steps) {
          if (typeof step === 'string') {
            await visit(step)
            continue
          }

          const contract = await readContract(step.physical)
          if (contract !== undefined) contracts[step.id] = contract
        }

        lazy[id] = memo.lazy
        return
      }

      const resolutions: Record<string, string | null> = Object.create(null)
      const steps: Edges['steps'][number][] = []

      imports[id] = resolutions

      const parsed = snapshot(entry.environment).parse({
        moduleId: id,
        source: text,
      })

      prefetch(file, parsed.program)

      for (const node of parsed.program.body) {
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

        // Zyzz authoring and runtime entrypoints are handled by the static transform.
        if (
          specifier === 'zyzz' ||
          (specifier.startsWith('zyzz/') && specifier !== 'zyzz/default')
        ) {
          resolutions[specifier] = null
          continue
        }

        const resolved = await resolve(specifier, file)
        if (!resolved) {
          // Framework transforms can remove server-only protocols from client code.
          // Resolve first so aliases and plugins can still supply analyzable source.
          if (
            !Path.isAbsolute(specifier) &&
            /^[a-z][a-z\d+.-]*:/i.test(specifier)
          ) {
            resolutions[specifier] = null
            continue
          }

          throw new Source.ExtractError([
            {
              code: 'unsupported_syntax',
              end: node.end,
              message: `Unable to resolve ${JSON.stringify(specifier)}`,
              source: file,
              start: node.start,
            },
          ])
        }

        if (resource(specifier) || resource(resolved.id)) {
          resolutions[specifier] = null
          continue
        }

        if (
          specifier === 'zyzz/default' &&
          /[/\\]src[/\\]default\.[cm]?ts$/.test(resolved.id)
        ) {
          sourceEntrypoints.add(normalize(resolved.id))
          resolutions[specifier] = sourceId(resolved.id)
          steps.push(resolved.id)
          await visit(resolved.id)
          continue
        }

        // An excluded source stays a runtime import instead of deriving a package contract.
        if (excluded(resolved.id)) {
          resolutions[specifier] = null
          continue
        }

        if (resolved.external || !eligible(resolved.id)) {
          const physical = resolved.id.split('?')[0]!.split('#')[0]!
          const readable =
            Path.isAbsolute(physical) && /\.[cm]?[jt]sx?$/.test(physical)

          if (readable) steps.push({ id: resolved.id, physical })

          const contract = readable ? await readContract(physical) : undefined

          if (contract !== undefined) {
            contracts[resolved.id] = contract
            resolutions[specifier] = resolved.id
            continue
          }

          resolutions[specifier] = null
          continue
        }

        resolutions[specifier] = sourceId(resolved.id)
        steps.push(resolved.id)
        await visit(resolved.id)
      }

      // Lazy imports stay outside this compile but scope the documents that load them.
      let specifiers = lazyImports.get(parsed)
      if (!specifiers) {
        specifiers = []
        const collected = specifiers
        Walker.walk(parsed.program, {
          enter(node) {
            if (
              node.type === 'ImportExpression' &&
              node.source.type === 'Literal' &&
              typeof node.source.value === 'string'
            )
              collected.push(node.source.value)
          },
        })
        lazyImports.set(parsed, specifiers)
      }

      const targets = new Set<string>()

      for (const specifier of specifiers) {
        if (specifier === 'zyzz' || specifier.startsWith('zyzz/')) continue

        const resolved = await resolve(specifier, file)
        if (!resolved || resource(specifier) || resource(resolved.id)) continue

        targets.add(eligible(resolved.id) ? sourceId(resolved.id) : resolved.id)
      }

      lazy[id] = targets
      memos?.set(file, { lazy: targets, resolutions, steps, text })
    }

    await visit(entry.file, code)

    const connected = new Set(files)
    const entryContracts = new Set(Object.keys(contracts))
    // The merged development graph keeps every module an earlier compile reached, and a module's
    // output depends only on its own closure. Contribution sources join through the shared
    // stylesheet's compile, so a module compile neither waits for discovery nor walks them.
    const merged = entry.environment.mode === 'dev' && !native && !everything
    const sources =
      merged && !allSources
        ? new Map<string, string>()
        : await discover(entry.environment, host)

    // The walk below visits discovered sources in order, so their lookups start together first.
    for (const [file, source] of sources)
      if (allSources || contributionFiles.get(entry.environment)?.has(file))
        prefetch(
          file,
          snapshot(entry.environment).parse({
            moduleId: sourceId(file),
            source,
          }).program,
        )

    for (const [file, source] of sources) {
      if (files.has(file) && !allSources) continue

      const selected = contributionFiles.get(entry.environment)?.has(file)

      if (allSources) {
        const { program } = snapshot(entry.environment).parse({
          moduleId: sourceId(file),
          source,
        })
        const dynamic: import('@oxc-project/types').ImportExpression[] = []

        Walker.walk(program, {
          enter(node) {
            if (
              node.type === 'ImportExpression' &&
              node.source.type === 'Literal' &&
              typeof node.source.value === 'string'
            )
              dynamic.push(node)
          },
        })

        for (const node of [...program.body, ...dynamic]) {
          if (
            (node.type !== 'ImportExpression' &&
              node.type !== 'ImportDeclaration' &&
              node.type !== 'ExportNamedDeclaration' &&
              node.type !== 'ExportAllDeclaration') ||
            !node.source
          )
            continue

          if (
            node.type === 'ImportExpression'
              ? false
              : node.type === 'ImportDeclaration'
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

          if (
            node.source.type !== 'Literal' ||
            typeof node.source.value !== 'string'
          )
            continue

          const specifier = node.source.value
          if (
            specifier === 'zyzz' ||
            (specifier.startsWith('zyzz/') && specifier !== 'zyzz/default')
          )
            continue

          const resolved = await resolve(specifier, file)
          if (
            !resolved ||
            (!resolved.external && eligible(resolved.id)) ||
            excluded(resolved.id)
          )
            continue

          if (resource(specifier) || resource(resolved.id)) continue

          const physical = resolved.id.split(/[?#]/)[0]!
          if (!Path.isAbsolute(physical) || !/\.[cm]?[jt]sx?$/.test(physical))
            continue

          const contract = await readContract(physical)
          if (contract === undefined) continue

          contracts[resolved.id] = contract

          // Discover the package contribution without compiling unrelated authoring
          // expressions in an otherwise unreachable source file.
          const discovery = `${sourceId(file)}.zyzz-discovery`

          modules[discovery] =
            (modules[discovery] ?? '') +
            `import ${JSON.stringify(specifier)};\n`
          ;(imports[discovery] ??= Object.create(null))[specifier] = resolved.id
        }
      }

      // A whole-project compile reads disk so the document never trails the watcher.
      if (everything) await visit(file)
      else if (selected) await visit(file, source)
    }

    const loaded = new Set<string>()

    async function dependencies(id: string): Promise<void> {
      if (loaded.has(id)) return

      loaded.add(id)

      for (const dependency of stylesheetDependencies(id, contracts[id]!)) {
        let owner = id

        for (const specifier of dependency) {
          if (
            typeof specifier !== 'string' ||
            !specifier ||
            specifier.includes('\0')
          )
            throw new Error('Invalid packed stylesheet dependency.')

          const target = await resolve(specifier, owner)
          if (!target || !Path.isAbsolute(target.id))
            throw new Error('Unable to resolve packed stylesheet dependency.')

          imports[owner] ??= Object.create(null)
          imports[owner]![specifier] = target.id

          contracts[target.id] ??= (await readContract(
            target.id.split(/[?#]/)[0]!,
            true,
          ))!

          await dependencies(target.id)
          owner = target.id
        }
      }
    }

    for (const id of Object.keys(contracts)) await dependencies(id)

    // The entry's authored import closure scopes document initialization in
    // builds, including packed contracts reached through other contracts.
    for (const id of entryContracts)
      for (const target of Object.values(imports[id] ?? {}))
        if (target !== null) entryContracts.add(target)

    // Static and lazy edges let a served document keep only the catalogs its scripts reach.
    const staged = new Map<string, ReadonlySet<string>>()

    for (const [id, resolutions] of Object.entries(imports))
      staged.set(
        id,
        new Set([
          ...Object.values(resolutions).filter(
            (target): target is string => target !== null,
          ),
          ...(lazy[id] ?? []),
        ]),
      )

    const input: Graph.compile.Options = {
      // Builds add every selector-interpolating source to each graph during discovery.
      [ClassName.references]: entry.environment.mode === 'build',
      [Results.lean]: true,
      [ThemeRules.shared]: native ? undefined : 'all',
      compiler: options.compiler,
      reset: options.reset ? Reset.read() : undefined,
      native,
      contracts,
      development: entry.environment.mode !== 'build',
      imports,
      modules,
    }
    const result = merged
      ? await compileProject(entry.environment, input, sourceId(entry.file))
      : entry.compiler.compile(input)

    if (native) {
      const output = result.modules[sourceId(entry.file)]!
      entry.files = files
      const map = Mapping.toEncodedMap(new Mapping.GenMapping())
      return {
        imports,
        modules: result.modules,
        code: output.code,
        contractIds: Object.keys(result.contracts),
        configurations: new Map<string, Catalogs.Catalog>(),
        connections: staged,
        css: '',
        graphSharedCss: '',
        sharedCss: '',
        cssMap: map,
        sharedCssMap: map,
        map: {
          ...output.map,
          sources: output.map.sources.map((source) =>
            source === null ? null : (sourceFile(source) ?? source),
          ),
        },
      }
    }

    // The graph publishes after the compile succeeds, so a broken edit keeps
    // scoping documents through the last good graph beside the kept catalogs.
    graphs.set(
      entry.file,
      new Set([...[...connected].map(sourceId), ...entryContracts]),
    )

    for (const [id, targets] of staged) edges.set(id, targets)

    // Packed dependencies contribute catalogs beside the modules compiled here.
    const compiled = { ...contracts, ...result.contracts }

    // A module owns its catalog keys; recompiling it replaces every
    // configuration it had, including a module that no longer emits a contract.
    for (const id of new Set([
      ...Object.keys(modules),
      ...Object.keys(compiled),
    ]))
      for (const key of catalogs.keys())
        if (key.startsWith(`${id}\0`)) catalogs.delete(key)

    const configurations = new Map<string, Catalogs.Catalog>()
    for (const [id, contract] of Object.entries(compiled))
      for (const configuration of read(contract)) {
        const key = `${id}\0${configuration.identity}`
        catalogs.set(key, configuration)
        configurations.set(key, configuration)
      }

    // Development renders the shared stylesheet for its own request only; transforms and module
    // stylesheets read module outputs.
    async function renderShared() {
      const owners = new Map<string, string>()

      for (const id of new Set(Object.values(result.sharedAssetOwners ?? {}))) {
        if (!Path.isAbsolute(id)) continue

        let directory = Path.dirname(id.split(/[?#]/)[0]!)

        for (;;) {
          try {
            await Fs.access(Path.join(directory, 'package.json'))
            owners.set(id, await Fs.realpath(directory))
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }

          const parent = Path.dirname(directory)
          if (parent === directory)
            throw new Error('Packed assets require an owning package.json.')

          directory = parent
        }
      }

      const assetUrls = new Map<string, string>()

      for (const [key, target] of Object.entries(result.sharedAssets ?? {})) {
        const raw = target.split(/[?#]/)[0]!

        const identity = result.sharedAssetOwners?.[key]
        const path =
          sourceFile(decodeURIComponent(raw)) ??
          (Path.isAbsolute(raw) ? decodeURIComponent(raw) : undefined)
        if (!path) throw new Error('Asset path escapes the Vite graph.')

        const asset = await (async () => {
          try {
            return { file: await Fs.realpath(path), package: false }
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
              !identity ||
              !sourceFile(identity)
            )
              throw error

            const importer = sourceFile(identity)!
            const specifier = Path.relative(Path.dirname(importer), path)
              .split(Path.sep)
              .join('/')
            if (specifier.startsWith('.') || Path.isAbsolute(specifier))
              throw error
            const resolved = await host.resolve(specifier, importer)
            if (!resolved || resolved.external) throw error
            return {
              file: await Fs.realpath(resolved.id.split('?')[0]!),
              package: true,
            }
          }
        })()
        const file = asset.file

        const owner =
          identity && sourceFile(identity)
            ? sourceRoot(sourceFile(identity)!)
            : identity
              ? owners.get(identity)
              : undefined

        const relative = owner ? Path.relative(owner, file) : '..'
        if (
          !asset.package &&
          (relative === '..' ||
            relative.startsWith(`..${Path.sep}`) ||
            Path.isAbsolute(relative))
        )
          throw new Error('Asset path escapes its owning package.')

        host.watch(file)
        files.add(file)

        let url: string

        if (asset.package || /[?#%]/.test(file)) {
          if (entry.environment.mode === 'build') {
            url = await host.asset(file)

            if (target.slice(raw.length))
              url += `$_${target.slice(raw.length)}__`
          } else {
            url = `/@zyzz/asset/${Crypto.hash('sha256', file)}/${encodeURIComponent(Path.basename(file))}`
            assets.set(url, file)
            url += target.slice(raw.length)
          }
        } else {
          // Vite reads `/@fs/` URLs with `decodeURI`, which keeps reserved escapes
          // such as `%40` in scoped package paths, so those characters stay raw.
          const pathname = encodeURI(file.replaceAll('\\', '/'))

          url = `/@fs/${pathname}${target.slice(raw.length)}`
        }

        assetUrls.set(target, url)
      }

      const shared = !Object.keys(result.sharedAssets ?? {}).length
        ? {
            code: new TextEncoder().encode(result.sharedCss ?? ''),
            map: new TextEncoder().encode(
              JSON.stringify(
                result.sharedCssMap ??
                  Mapping.toEncodedMap(new Mapping.GenMapping()),
              ),
            ),
          }
        : AtRules.transform({
            filename: 'zyzz.shared.css',
            code: new TextEncoder().encode(result.sharedCss ?? ''),
            sourceMap: true,
            inputSourceMap: JSON.stringify(
              result.sharedCssMap ??
                Mapping.toEncodedMap(new Mapping.GenMapping()),
            ),
            visitor: {
              Rule(rule) {
                if (rule.type !== 'import') return
                const target = result.sharedAssets?.[rule.value.url]
                if (target)
                  return AtRules.relocateImport(
                    rule.value,
                    assetUrls.get(target)!,
                  )
              },
              Url(url) {
                const target = result.sharedAssets?.[url.url]
                if (!target) return

                return { ...url, url: assetUrls.get(target)! }
              },
            },
          })

      const sharedMap = JSON.parse(
        new TextDecoder().decode(shared.map!),
      ) as Mapping.EncodedSourceMap

      sharedMap.sources = sharedMap.sources.map((source) =>
        source === null ? null : (sourceFile(source) ?? source),
      )

      return { css: new TextDecoder().decode(shared.code), map: sharedMap }
    }

    const sharedOutput =
      entry.environment.mode !== 'dev' || allSources
        ? await renderShared()
        : {
            css: '',
            map: Mapping.toEncodedMap(new Mapping.GenMapping()),
          }

    const output = result.modules[sourceId(entry.file)]!

    entry.files = files

    const value = {
      imports,
      modules: result.modules,
      code: output.code,
      contractIds: Object.keys(compiled),
      configurations,
      connections: staged,
      css: output.css,
      // Edits compare the graph's stylesheet, which precedes asset relocation.
      graphSharedCss: result.sharedCss ?? '',
      sharedCss: sharedOutput.css,
      sharedCssMap: sharedOutput.map,
      cssMap: {
        ...output.cssMap,
        sources: output.cssMap.sources.map((source) =>
          source === null ? null : (sourceFile(source) ?? source),
        ),
      },
      map: {
        ...output.map,
        sources: output.map.sources.map((source) =>
          source === null ? null : (sourceFile(source) ?? source),
        ),
      },
    }

    return value
  }

  /** Compiles every discovered source once so index.html can inline each configuration's script before modules load. */
  async function initializations(server: ViteDevServer) {
    const environment = server.environments.client
    reads.delete(environment)
    const host: Host = {
      asset: async (file) => file,
      resolve: resolver(environment),
      watch: (file) => watch(server, file),
    }
    const sources = await discover(environment, host)
    let entry = initializers.get(environment)

    // The seed only anchors the compile, which visits every discovered source.
    if (!entry || !sources.has(entry.file)) {
      const file = sources.keys().next().value
      if (file === undefined) return { catalogs: new Map(), edges: new Map() }

      // Whole-project compiles keep their own cache beside the transforms' merged graph.
      entry = {
        compiler: initializers.get(environment)?.compiler ?? Graph.create(),
        environment,
        file,
        files: new Set([file]),
      }
      initializers.set(environment, entry)
    }

    // A source error surfaces through that module's own transform and overlay.
    // The document keeps loading with the catalogs collected before the edit.
    const output = await compile(entry, host, undefined, true, true).catch(
      () => undefined,
    )

    // This compile saw the whole project, so contracts it no longer produces are gone.
    if (output)
      for (const key of catalogs.keys())
        if (!output.contractIds.some((id) => key.startsWith(`${id}\0`)))
          catalogs.delete(key)

    // Concurrent module transforms must not replace this request's compiled catalogs.
    return {
      catalogs: output?.configurations ?? new Map(catalogs),
      edges: output?.connections ?? new Map(edges),
    }
  }

  type DocumentState = {
    catalogs: ReadonlyMap<string, Catalogs.Catalog>
    edges: ReadonlyMap<string, ReadonlySet<string>>
  }

  /** Catalogs reachable from a served document's module scripts; every catalog when none resolve. */
  async function documentCatalogs(
    html: string,
    filename: string,
    resolve: Host['resolve'],
    { catalogs, edges }: DocumentState,
  ) {
    const reachable = new Set<string>()

    const add = (specifier: string) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(specifier)) return

      const path = specifier.split(/[?#]/)[0]!

      // Vite's inline-module proxies point back at the document itself.
      if (/\.html?$/i.test(path)) return

      reachable.add(
        sourceId(
          path.startsWith('/')
            ? Path.join(root, path)
            : Path.resolve(Path.dirname(filename), path),
        ),
      )
    }

    // Vite rewrites inline modules into proxy URLs before this hook runs, so
    // the document on disk supplies their imports beside the served markup.
    const original = await Fs.readFile(filename, 'utf8').catch(() => html)

    for (const document of new Set([html, original]))
      for (const [, attributes, content] of document.matchAll(
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
      )) {
        if (!/\btype\s*=\s*["']?module["']?/i.test(attributes!)) continue

        const source = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
          attributes!,
        )
        const src = source?.[1] ?? source?.[2] ?? source?.[3]

        if (src) {
          add(src)
          continue
        }

        // Inline modules import relative to the document, as Vite's HTML
        // proxy resolves them; aliases and packages resolve through Vite.
        for (const specifier of inlineImports(content!)) {
          if (/^\.{0,2}\//.test(specifier)) {
            add(specifier)
            continue
          }
          if (specifier === 'zyzz' || specifier.startsWith('zyzz/')) continue

          const resolved = await resolve(specifier, filename).catch(() => null)
          if (!resolved || resource(resolved.id)) continue

          reachable.add(
            eligible(resolved.id) ? sourceId(resolved.id) : resolved.id,
          )
        }
      }

    if (![...reachable].some((id) => edges.has(id)))
      return [...catalogs.values()]

    for (const id of reachable)
      for (const target of edges.get(id) ?? []) reachable.add(target)

    return [...catalogs]
      .filter(([key]) => reachable.has(key.split('\0')[0]!))
      .map(([, configuration]) => configuration)
  }

  /** Static and literal dynamic import specifiers of an inline module script; none when it fails to parse. */
  function inlineImports(content: string): readonly string[] {
    const specifiers: string[] = []

    try {
      const { program } = Parser.parseSync('inline.ts', content, {
        sourceType: 'module',
      })

      Walker.walk(program, {
        enter(node) {
          if (
            (node.type === 'ImportDeclaration' ||
              node.type === 'ExportNamedDeclaration' ||
              node.type === 'ExportAllDeclaration') &&
            node.source
          )
            specifiers.push(node.source.value)

          if (
            node.type === 'ImportExpression' &&
            node.source.type === 'Literal' &&
            typeof node.source.value === 'string'
          )
            specifiers.push(node.source.value)
        },
      })
    } catch {
      return []
    }

    return specifiers
  }

  /** Catalogs contributed by the modules an HTML entry bundles; every catalog without an entry chunk. */
  function entryCatalogs(
    bundle?: Rollup.OutputBundle,
    chunk?: Rollup.OutputChunk,
  ) {
    if (!bundle || !chunk) return [...catalogs.values()]

    const contracts = new Set<string>()
    const visited = new Set<string>()

    function collect(name: string) {
      if (visited.has(name)) return

      visited.add(name)

      const output = bundle![name]
      if (output?.type !== 'chunk') return

      // Source graphs follow authored imports, so a configuration compiled away
      // from the bundle still initializes the pages that authored it.
      for (const id of Object.keys(output.modules))
        for (const contract of graphs.get(normalize(id)) ?? [])
          contracts.add(contract)

      for (const imported of [...output.imports, ...output.dynamicImports])
        collect(imported)
    }

    collect(chunk.fileName)

    return [...catalogs]
      .filter(([key]) => contracts.has(key.split('\0')[0]!))
      .map(([, configuration]) => configuration)
  }

  /**
   * The modules an edit invalidates: those whose code or stylesheet differs from what Vite served.
   * A concurrent compile can already hold the edit, so outputs are not compared with each other.
   */
  async function changes(
    environment: DevEnvironment,
    after: Graph.compile.ReturnType,
    served: Served,
    modules: readonly EnvironmentModuleNode[],
    timestamp: number,
    edited: string,
    deleted: string | undefined,
  ) {
    // Portable build adapters share this module and do not require Vite.
    const { transformWithOxc, version } = await import('vite')
    const code = new Set<string>()
    const css = new Set<string>()

    for (const [
      entry,
      { code: current, css: stylesheet, imports },
    ] of served.entries) {
      const id = sourceId(entry.file)
      const next = after.modules[id]

      if (!next) continue

      // A stylesheet Vite never loaded has no module to invalidate.
      if (stylesheet !== undefined && stylesheet !== next.css)
        css.add(entry.file)

      // A stylesheet request can compile a module whose code was never transformed here.
      if (current === undefined) continue

      if (imports !== JSON.stringify(projects.get(environment)?.imports[id])) {
        code.add(entry.file)
        continue
      }

      if (current === next.code) continue

      // Generated type assertions can change without changing runtime bindings.
      const [left, right] = await Promise.all([
        transformWithOxc(current, entry.file, { sourcemap: false }),
        transformWithOxc(next.code, entry.file, { sourcemap: false }),
      ])

      if (left.code !== right.code) code.add(entry.file)
    }

    // An environment loads the announced outputs when it next requests each module, which a server
    // can postpone past later edits. Those edits compare against the announced outputs, so an
    // update the environment has not loaded yet is not announced again.
    for (const [entry, { code: current, css: stylesheet }] of served.entries) {
      const id = sourceId(entry.file)
      const next = after.modules[id]

      if (!next) continue

      if (stylesheet !== undefined && entry.css === stylesheet)
        entry.css = next.css

      if (current !== undefined && entry.code === current) {
        entry.code = next.code
        entry.imports = JSON.stringify(projects.get(environment)?.imports[id])
      }
    }

    const stylesheets = new Set<string>()

    if (deleted !== undefined) stylesheets.add(cssId(deleted))
    if (
      served.shared !== undefined &&
      served.shared !== (after.sharedCss ?? '')
    )
      stylesheets.add(sharedId)
    for (const file of css) stylesheets.add(cssId(file))

    // Compiled modules the edit left unchanged skip Vite's own update; other modules, such as
    // plain JavaScript or assets, keep it.
    const affected = new Set(
      modules.filter((module) => {
        if (!module.id) return module.type !== 'asset'

        const file = normalize(module.id)

        return Object.hasOwn(after.modules, sourceId(file))
          ? code.has(file)
          : true
      }),
    )

    for (const file of code) {
      const module = environment.moduleGraph.getModuleById(file)
      if (!module) continue

      environment.moduleGraph.invalidateModule(
        module,
        new Set(),
        timestamp,
        true,
      )
      affected.add(module)
    }

    const sheets: EnvironmentModuleNode[] = []

    // The edited module's stylesheet updates first, ahead of stylesheets other modules share.
    for (const id of [...stylesheets].sort(
      (left, right) =>
        Number(right === cssId(edited)) - Number(left === cssId(edited)),
    ))
      // A server-rendered link loads the sheet as a direct request, which the browser never imports.
      for (const variant of [id, `${id}?direct`]) {
        const module = environment.moduleGraph.getModuleById(variant)
        if (!module) continue

        environment.moduleGraph.invalidateModule(
          module,
          new Set(),
          timestamp,
          true,
        )

        // An imported stylesheet accepts its own updates once a request transforms it. One that
        // does not was never evaluated, as when a server renders without loading it, so the
        // invalidation is the whole update.
        if (module.type === 'js' && !module.isSelfAccepting) continue

        sheets.push(module)
      }

    // A stylesheet accepts its own updates and only its module imports it, so it is never within
    // an import cycle. Vite proves that by walking every importer of the importing module, which
    // costs each stylesheet of a shared edit the whole graph, so stylesheet-only edits send the
    // same update directly. Edits that also change code keep Vite's single batched update.
    if (
      !affected.size &&
      sheets.length &&
      sheets.every((module) => module.isSelfAccepting)
    ) {
      // The client matches a linked stylesheet by its URL and an imported one by its hot
      // context, ignoring updates that name neither. Vite 8.3 registers hot contexts under
      // module URLs, where earlier versions register the browser's `/@id/` URL.
      const [major = 0, minor = 0] = version.split('.').map(Number)
      const wrapped = major < 8 || (major === 8 && minor < 3)
      const updates = sheets.map((module) => {
        const path =
          (wrapped || module.type === 'css') &&
          !module.url.startsWith('/') &&
          !module.url.startsWith('.')
            ? `/@id/${module.url.replace('\0', '__x00__')}`
            : module.url

        return {
          acceptedPath: path,
          explicitImportRequired: false,
          isWithinCircularImport: false,
          path,
          timestamp,
          type:
            module.type === 'css'
              ? ('css-update' as const)
              : ('js-update' as const),
        }
      })

      environment.logger.info(
        `hmr update ${updates.map((update) => update.path).join(', ')}`,
        { timestamp: true },
      )
      environment.hot.send({ type: 'update', updates })
      return []
    }

    for (const module of sheets) affected.add(module)

    return [...affected]
  }

  return {
    buildStart() {
      edgeMemos.delete(this.environment)
      reads.delete(this.environment)
      lookups.delete(this.environment)
    },
    config: {
      order: 'post',
      handler(config, env) {
        // Ordered after other config hooks, so plugin-provided aliases are visible.
        optimizeRuntime =
          env.command === 'serve' &&
          options.compiler !== false &&
          installed(config)

        if (native) return
        // Inline color-scheme changes cannot initialize Lightning's lowered helpers.
        // A build target without browsers, such as `node20` or `es2022`, implies no
        // CSS target, so the browser CSS target falls back to native light-dark().
        const target = config.build?.target
        return {
          build: {
            cssTarget:
              config.build?.cssTarget ??
              (target &&
              (Array.isArray(target) ? target : [target]).some((value) =>
                browserTarget.test(value),
              )
                ? target
                : ['chrome123', 'edge123', 'firefox120', 'safari17.5']),
          },
          css: {
            lightningcss: {
              targets: config.css?.lightningcss?.targets ?? {
                chrome: 123 << 16,
                edge: 123 << 16,
                firefox: 120 << 16,
                safari: (17 << 16) | (5 << 8),
              },
              exclude:
                (config.css?.lightningcss?.exclude ?? 0) |
                Lightning.Features.LightDark,
            },
          },
        }
      },
    },
    configEnvironment: {
      // Plugins without enforce settle their environment options first.
      order: 'post',
      handler(name, config) {
        if (!optimizeRuntime) return

        const optimizeDeps = config.optimizeDeps ?? {}
        const consumer =
          config.consumer ?? (name === 'client' ? 'client' : 'server')

        // Vite defaults server environments to noDiscovery. An include list there
        // would create an explicit optimizer that otherwise never exists.
        if (optimizeDeps.noDiscovery ?? consumer === 'server') return
        if (
          optimizeDeps.include?.includes(runtime) ||
          optimizeDeps.exclude?.some((id) => id === 'zyzz' || id === runtime)
        )
          return

        // Vite scans authored source, so the runtime import that compilation
        // adds first appears while a request transforms a module. Discovering
        // it then re-runs the optimizer, and modules loaded before the re-run
        // can keep a separate copy of a shared dependency such as React.
        return { optimizeDeps: { include: [runtime] } }
      },
    },
    configureServer(server) {
      devServer = server

      // Directory watches belong to the server, not module import dependencies.
      server.watcher.add(directories.slice(1))

      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const file = assets.get(path)
        if (!file) return next()

        Fs.readFile(file).then((content) => {
          response.setHeader(
            'Content-Type',
            file.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream',
          )
          response.setHeader('Cache-Control', 'no-cache')
          response.end(content)
        }, next)
      })
    },
    async configResolved(config) {
      root = await Fs.realpath(config.root)

      const includes = await Promise.all(
        (options.include ?? []).map((value) => pattern({ root, value })),
      )
      const bases = [...new Set(includes.map((entry) => entry.base))]

      // The root keeps the `app` namespace, so only bases outside it add source directories.
      directories = [root, ...bases.filter((base) => !contains(root, base))]

      // Portable build adapters share this module and do not require Vite.
      const { createFilter } = await import('vite')
      const patterns = [...configFiles, ...(options.exclude ?? [])]

      filter = createFilter(null, patterns, { resolve: root })
      exclusions.clear()
      nestedPackages.clear()
      roots.clear()

      if (includes.length) {
        scopes = bases
        scoped = createFilter(
          includes.map((entry) => entry.glob),
          null,
          { resolve: false },
        )
      } else {
        scopes = [root]
        scoped = undefined

        // A `zyzz.config.*` module marks the application's source directory.
        const configured = await configDirectories({ nested, root })
        if (configured.length) scopes = configured
      }

      if (native) return
      const lightning = (config.css.lightningcss ??= {})
      lightning.include =
        (lightning.include ?? 0) & ~Lightning.Features.LightDark
      lightning.exclude =
        (lightning.exclude ?? 0) | Lightning.Features.LightDark
    },
    enforce: 'pre',
    generateBundle: {
      order: 'post',
      handler(_, bundle) {
        if (native) return

        // Server environments collect CSS without shipping it to browsers.
        const config = this.environment.config
        let unsupported: string | false | undefined =
          config.consumer === 'client' ? undefined : false

        for (const output of Object.values(bundle)) {
          if (output.type !== 'asset' || !output.fileName.endsWith('.css'))
            continue
          const css =
            typeof output.source === 'string'
              ? output.source
              : new TextDecoder().decode(output.source)

          // The light-dark() exclusion also affects imported application CSS.
          if (unsupported !== false && css.includes('light-dark(')) {
            unsupported ??= lightDark({
              cssTarget: config.build.cssTarget,
              targets: config.css.lightningcss?.targets,
            })
            if (unsupported)
              this.error(`${output.fileName} uses light-dark(). ${unsupported}`)
          }

          const external = bundle[`${output.fileName}.map`]
          const inline = css.match(
            /\/\*# sourceMappingURL=data:application\/json(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=]+)\s*\*\//,
          )
          const previous =
            external?.type === 'asset'
              ? (JSON.parse(
                  typeof external.source === 'string'
                    ? external.source
                    : new TextDecoder().decode(external.source),
                ) as Mapping.EncodedSourceMap)
              : inline
                ? (JSON.parse(
                    Buffer.from(inline[1]!, 'base64').toString(),
                  ) as Mapping.EncodedSourceMap)
                : undefined
          const result = Namespaces.bundle(css, previous)
          let restored = AtRules.rename(
            AtRules.rename(
              result.css,
              '-zyzz-ffv-000000000',
              'font-feature-values',
            ),
            '-zyzz-fpv-000000000',
            'font-palette-values',
          )
          if (result.map && external?.type === 'asset')
            external.source = JSON.stringify(result.map)
          if (result.map && inline)
            restored = restored.replace(
              inline[0],
              `/*# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(result.map)).toString('base64')} */`,
            )
          output.source = restored
        }
      },
    },
    async watchChange(file, change) {
      // A removed file leaves the watcher, so a later compile that reads it again adds it again.
      if (change.event === 'delete') watched.delete(file)

      await updateDiscovery(this.environment, file, change.event)
    },
    async hotUpdate({ file, modules, timestamp, type, server }) {
      const state = entries(this.environment)
      const before = projects.get(this.environment)?.outcome
      // Concurrent transforms update entries while this compiles, so the served output is read now.
      const served: Served = {
        entries: new Map(
          [...state.values()].map((entry) => [
            entry,
            { code: entry.code, css: entry.css, imports: entry.imports },
          ]),
        ),
        shared: servedShared.get(this.environment),
      }

      // The merged development graph compares module outputs before and after the edit, so
      // only modules whose code or stylesheet changed update.
      if (!native && before && 'result' in before) {
        await updateDiscovery(this.environment, file, type)

        // The edited module merges its new source through a compile of its own closure. A module
        // its importers compile away, such as a theme, and a contribution source no module
        // imports have no entry, so the compile anchors at the file. Other inputs, such as
        // package files, recompile a closure that reads them.
        const project = projects.get(this.environment)
        const first =
          state.get(file) ??
          (eligible(file) &&
          (Object.hasOwn(project?.modules ?? {}, sourceId(file)) ||
            eager(file, this.environment))
            ? {
                compiler: compiler(this.environment),
                environment: this.environment,
                file,
                files: new Set([file]),
              }
            : [...state.values()].find((entry) => entry.files.has(file)))
        if (!first && !removed.get(this.environment)?.has(file)) return modules

        // A new source merges like an edit, so only the outputs it changes update. It can also
        // satisfy an import that failed, which its own closure never reaches, so while a module
        // fails, every closure recompiles.
        const compiled =
          first &&
          (type === 'update' ||
            (type === 'create' && !failures.get(this.environment)?.size)) &&
          eligible(file)
            ? await compile(first, {
                resolve: resolver(this.environment),
                watch: (file) => watch(server, file),
                asset: async (file) => file,
              }).then(
                () => true,
                () => false,
              )
            : false
        const after = projects.get(this.environment)?.outcome

        if (compiled && after && 'result' in after)
          return await changes(
            this.environment,
            after.result,
            served,
            modules,
            timestamp,
            file,
            type === 'delete' ? file : undefined,
          )
      }

      const previous = [...state.values()].map((entry) => ({
        code: entry.code,
        file: entry.file,
        imports: entry.imports,
      }))

      await updateDiscovery(this.environment, file, type)
      const first = [...state.values()].find(
        (entry) => entry.files.has(file) || eager(file, this.environment),
      )
      if (!first && !removed.get(this.environment)?.has(file)) return modules

      // Failed edits retain normal invalidation so Vite reports errors on reload.
      const output =
        first && type === 'update' && eligible(file)
          ? await compile(
              first,
              {
                resolve: resolver(this.environment),
                watch: (file) => watch(server, file),
                asset: async (file) => file,
              },
              undefined,
              true,
              true,
            ).catch(() => undefined)
          : undefined
      const javascriptChanged = await (async () => {
        if (!output) return true

        // Portable build adapters share this module and do not require Vite.
        const { transformWithOxc } = await import('vite')
        const changed = await Promise.all(
          previous.map(async (entry) => {
            const code = output.modules[sourceId(entry.file)]?.code
            if (
              entry.imports !==
              JSON.stringify(output.imports[sourceId(entry.file)])
            )
              return true
            if (entry.code === code) return false
            if (entry.code === undefined || code === undefined) return true

            // Generated type assertions can change without changing runtime bindings.
            const [before, after] = await Promise.all([
              transformWithOxc(entry.code, entry.file, { sourcemap: false }),
              transformWithOxc(code, entry.file, { sourcemap: false }),
            ])
            return before.code !== after.code
          }),
        )
        return changed.some(Boolean)
      })()
      // Compiler-only inputs have watch edges, but their stylesheets update separately.
      const affected = new Set(
        modules.filter(
          (module) =>
            javascriptChanged ||
            (module.id
              ? !output?.modules[sourceId(module.id)]
              : module.type !== 'asset'),
        ),
      )
      const ids = new Set<string>()
      if (type === 'delete') ids.add(cssId(file))

      for (const entry of entries(this.environment).values()) {
        if (!entry.files.has(file) && !eager(file, this.environment)) continue

        // Theme scopes affect CSS even when Vite's JavaScript import was erased.
        // Rewritten importers can lose a source edge, so changed bindings must update together.
        if (javascriptChanged) ids.add(entry.file)
        for (const id of [cssId(entry.file), sharedId])
          ids.add(id).add(`${id}?direct`)
      }

      for (const id of ids) {
        const module = this.environment.moduleGraph.getModuleById(id)
        if (!module) continue

        this.environment.moduleGraph.invalidateModule(
          module,
          new Set(),
          timestamp,
          true,
        )
        affected.add(module)
      }

      return [...affected]
    },
    async load(id) {
      if (!id.startsWith(prefix)) return
      id = id.split('?', 1)[0]!

      const file =
        id === sharedId
          ? undefined
          : decodeURIComponent(id.slice(prefix.length, -4))
      let entry =
        file === undefined
          ? entries(this.environment).values().next().value
          : entries(this.environment).get(file)
      // A pruned JavaScript module can leave its stylesheet loaded in the browser.
      if (!entry && file && removed.get(this.environment)?.has(file)) return ''

      // Server rendering links the stylesheets of modules this environment has not transformed
      // yet, so a development request compiles the module where the browser loads it.
      if (!entry && this.environment.mode === 'dev') {
        const anchor =
          file ??
          (
            await discover(this.environment, {
              asset: async (file) => file,
              resolve: resolver(this.environment),
              watch: watcher(this),
            })
          )
            .keys()
            .next().value

        if (anchor !== undefined && eligible(anchor)) {
          entry = {
            compiler: compiler(this.environment),
            environment: this.environment,
            file: anchor,
            files: new Set([anchor]),
          }
          entries(this.environment).set(anchor, entry)
        }
      }

      if (!entry) throw new Error(`Unknown Zyzz stylesheet: ${file}`)

      const output = await compile(
        entry,
        {
          resolve:
            this.environment.mode === 'dev'
              ? resolver(this.environment)
              : (source, importer) => this.resolve(source, importer),
          watch: watcher(this),
          asset: async (file) => {
            const reference = this.emitFile({
              type: 'asset',
              name: Path.basename(file).replace(/[?#%]/g, '_'),
              source: await Fs.readFile(file),
            })

            // Vite's CSS asset placeholder preserves its configured base and output naming.
            return `__VITE_ASSET__${reference}__`
          },
        },
        undefined,
        id === sharedId,
      )

      const transport = (css: string) =>
        this.environment.config.command === 'build'
          ? AtRules.rename(
              AtRules.rename(
                Namespaces.protect(css),
                'font-feature-values',
                '-zyzz-ffv-000000000',
              ),
              'font-palette-values',
              '-zyzz-fpv-000000000',
            )
          : css
      if (id === sharedId) {
        servedShared.set(this.environment, output.graphSharedCss)
        return {
          code: transport(output.sharedCss),
          map: JSON.stringify(output.sharedCssMap),
        }
      }

      entry.css = output.css
      return {
        code: transport(output.css),
        map: JSON.stringify(output.cssMap),
      }
    },
    name: 'zyzz',
    resolveId(id) {
      if (id.startsWith(prefix)) return id
    },
    async transform(code, id) {
      const split = new URLSearchParams(id.split('?')[1]).has('tsr-split')
      id = normalize(id)

      if (!eligible(id)) return

      const state = entries(this.environment)
      let entry = state.get(id)

      if (!entry) {
        entry = {
          compiler: compiler(this.environment),
          environment: this.environment,
          file: id,
          files: new Set([id]),
        }
        state.set(id, entry)
        removed.get(this.environment)?.delete(id)
      }

      entry.source = code

      const output = await compile(
        entry,
        {
          resolve:
            this.environment.mode === 'dev'
              ? resolver(this.environment)
              : (source, importer) => this.resolve(source, importer),
          watch: watcher(this),
          asset: async (file) => {
            const reference = this.emitFile({
              type: 'asset',
              name: Path.basename(file).replace(/[?#%]/g, '_'),
              source: await Fs.readFile(file),
            })

            // Vite's CSS asset placeholder preserves its configured base and output naming.
            return `__VITE_ASSET__${reference}__`
          },
        },
        code,
      )

      entry.imports = JSON.stringify(output.imports[sourceId(entry.file)])
      entry.code = output.code

      if (native) return { code: output.code, map: JSON.stringify(output.map) }

      // Keep the CSS dependency even when the current graph has no live rules.
      // Later edits can introduce styles without changing this import boundary.
      const offset = prologue(output.code)
      const sharedImport = `\nimport ${JSON.stringify(sharedId)};\n`
      // The inserted dependency shifts only generated positions after the prologue.
      const before = output.code.slice(0, offset)
      const insertionLine = before.split('\n').length
      const insertionColumn = before.length - (before.lastIndexOf('\n') + 1)
      // A build compiles a fixed project, so an empty module sheet stays empty. Importing it
      // would link an empty stylesheet from every chunk that holds no styled module.
      const stylesheetImport =
        this.environment.mode === 'build' && !output.css.trim()
          ? ''
          : `\nimport ${JSON.stringify(cssId(id))};`

      const transformed = {
        code: `${before}${sharedImport}${output.code.slice(offset)}${stylesheetImport}`,
        map: JSON.stringify({
          ...output.map,
          mappings: insert(
            output.map.mappings,
            insertionLine - 1,
            insertionColumn,
          ),
        }),
      }

      if (split) {
        // TanStack's dead-code elimination does not track TypeScript namespace
        // bindings. Lower them before splitting, leaving JSX for the framework plugin.
        const { transformWithOxc } = await import('vite')
        return transformWithOxc(
          transformed.code,
          id,
          { jsx: 'preserve' },
          JSON.parse(transformed.map),
        )
      }

      return transformed
    },
    transformIndexHtml: {
      order: 'post',
      async handler(html, context) {
        if (native || options.script === false) return

        // Development compiles the whole project on request and keeps the
        // catalogs the document's scripts reach; a build scopes them to the
        // source graphs its entry chunk bundles.
        const configurations = await (async () => {
          if (!context.server)
            return entryCatalogs(context.bundle, context.chunk)

          const state = await initializations(context.server)

          const environment = context.server.environments.client

          return await documentCatalogs(
            html,
            context.filename,
            resolver(environment),
            state,
          )
        })()
        // Saved preferences apply before any other script or visible content.
        return Catalogs.scripts(configurations).map((children) => ({
          children,
          injectTo: 'head-prepend' as const,
          tag: 'script',
        }))
      },
    },
  }
}

/** One module's import edges: its resolutions and, in order, its visits and contract reads. */
type Edges = {
  lazy: ReadonlySet<string>
  resolutions: Readonly<Record<string, string | null>>
  steps: readonly (string | { id: string; physical: string })[]
  text: string
}

type Entry = {
  code?: string
  compiler: Graph.create.ReturnType
  /** The stylesheet Vite last loaded for this module. */
  css?: string | undefined
  environment: Environment
  file: string
  files: Set<string>
  imports?: string
  /** The code Vite last passed to the transform, until a watcher event changes the file. */
  source?: string | undefined
}

type Host = {
  asset: (file: string) => Promise<string>
  resolve: (
    source: string,
    importer: string,
  ) => Promise<{
    external?: boolean | 'absolute' | 'relative'
    id: string
  } | null>
  watch: (file: string) => void
}

type Lookups = {
  contracts: Map<
    string,
    Promise<{ contract: string | undefined; files: ReadonlySet<string> }>
  >
  /** Files each settled contract read, so an edit to one drops only its contracts. */
  read: Map<string, ReadonlySet<string>>
  resolutions: Map<string, ReturnType<Host['resolve']>>
}

/** One development environment's merged source graph and its last compilation. */
type Project = {
  compiler: Graph.create.ReturnType
  contracts: Record<string, string>
  /** Compiles a closure alone while the merged graph fails. */
  fallback: Graph.create.ReturnType
  imports: Record<string, Record<string, string | null>>
  modules: Record<string, string>
  outcome:
    | { readonly error: unknown }
    | { readonly result: Graph.compile.ReturnType }
    | undefined
  /** The scheduled compile that merged changes wait for. */
  pending: Promise<void> | undefined
  /** Whether merged changes await a compile. */
  stale: boolean
}

/** What an environment served when an edit arrived. */
type Served = {
  entries: ReadonlyMap<
    Entry,
    {
      code: string | undefined
      css: string | undefined
      imports: string | undefined
    }
  >
  shared: string | undefined
}

/** Matches build targets that name a browser version, as Vite's CSS target conversion does. */
const browserTarget = /^(chrome|edge|firefox|safari|ios|opera|ie)([0-9.]+)$/

/**
 * Checks that CSS targets keep native `light-dark()`, which inline color-scheme changes require.
 * @returns A reason when a target lowers `light-dark()` or cannot be verified, otherwise `false`.
 */
function lightDark(options: lightDark.Options): string | false {
  const target = options.cssTarget
  const browsers: string[] = []

  for (const value of Array.isArray(target) ? target : [target]) {
    const match = value ? browserTarget.exec(value) : null
    if (!match)
      return `Zyzz cannot verify light-dark() support for CSS target: ${value}. Set build.cssTarget to Chrome/Edge 123+, Firefox 120+, or Safari/iOS 17.5+.`
    browsers.push(`${match[1] === 'ios' ? 'ios_saf' : match[1]} ${match[2]}`)
  }

  for (const targets of [
    Lightning.browserslistToTargets(browsers),
    options.targets ?? {},
  ]) {
    const result = Lightning.transform({
      code: new TextEncoder().encode('.theme{color:light-dark(white,black)}'),
      filename: 'zyzz-theme-target.css',
      targets,
    })
    if (!new TextDecoder().decode(result.code).includes('light-dark('))
      return 'Zyzz keeps light-dark() native, which these CSS targets would lower. Set build.cssTarget and css.lightningcss.targets to Chrome/Edge 123+, Firefox 120+, or Safari/iOS 17.5+.'
  }

  return false
}

declare namespace lightDark {
  type Options = {
    cssTarget: string | readonly string[] | false | undefined
    targets: Lightning.Targets | undefined
  }
}

/** Whether discovery skips a directory entry: hidden entries, dependencies, build output, and tests. */
function skipped(name: string) {
  return (
    name.startsWith('.') ||
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
    ].includes(name)
  )
}

/** Whether `file` is `directory` or lies below it, outside any `node_modules`. */
function contains(directory: string, file: string) {
  const relative = Path.relative(directory, file)

  return (
    relative !== '..' &&
    !relative.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(relative) &&
    !relative.split(Path.sep).includes('node_modules')
  )
}

/**
 * Resolves an `include` entry against the Vite root. A glob splits at its first segment with
 * glob syntax into the physical directory discovery walks and an absolute pattern. A plain path
 * names one file, or every module below a directory.
 */
async function pattern(options: pattern.Options) {
  const { root, value } = options

  // Windows paths separate segments with either slash.
  const segments = value.split(Path.sep === '\\' ? /[\\/]/ : '/')
  const index = segments.findIndex((segment) => /[*?[\]{}()!]/.test(segment))
  const prefix = index === -1 ? value : segments.slice(0, index).join('/')
  const file = await Fs.realpath(Path.resolve(root, prefix || '.')).catch(
    () => {
      throw new Error(
        `Zyzz include patterns must start in an existing directory: ${value}`,
      )
    },
  )
  const posix = file.split(Path.sep).join('/')
  const directory = (await Fs.stat(file)).isDirectory()

  if (index !== -1) {
    if (!directory)
      throw new Error(
        `Zyzz include patterns must start in an existing directory: ${value}`,
      )

    return { base: file, glob: `${posix}/${segments.slice(index).join('/')}` }
  }

  return directory
    ? { base: file, glob: `${posix}/**` }
    : { base: Path.dirname(file), glob: posix }
}

/**
 * Finds the directories holding a `zyzz.config.*` module below the Vite root, by name alone.
 * The walk skips the directories discovery skips, including nested packages.
 */
async function configDirectories(options: configDirectories.Options) {
  const { nested, root } = options
  const found: string[] = []

  async function walk(directory: string): Promise<void> {
    for (const item of await Fs.readdir(directory, { withFileTypes: true })) {
      if (skipped(item.name)) continue

      const file = Path.join(directory, item.name)

      if (item.isDirectory()) {
        if (!nested(file)) await walk(file)
      } else if (
        item.isFile() &&
        /^zyzz\.config\.[cm]?[jt]sx?$/.test(item.name) &&
        !found.includes(directory)
      )
        found.push(directory)
    }
  }

  await walk(root)

  // A configuration directory inside another adds nothing to the outer directory's walk.
  return found.filter(
    (directory) =>
      !found.some((other) => other !== directory && contains(other, directory)),
  )
}

declare namespace configDirectories {
  type Options = {
    /** Whether discovery skips a directory as a nested package. */
    readonly nested: (directory: string) => boolean
    /** The physical Vite root. */
    readonly root: string
  }
}

declare namespace pattern {
  type Options = {
    /** The physical Vite root that relative entries resolve against. */
    readonly root: string
    /** The `include` entry: a glob, a file, or a directory. */
    readonly value: string
  }
}

/**
 * The end of a module's hashbang and directive prologue, where an added import keeps directives
 * first. Source without a leading string literal skips parsing.
 */
function prologue(code: string) {
  let index = code.startsWith('#!') ? code.indexOf('\n') + 1 : 0
  const start = index

  for (;;) {
    while (index < code.length && /\s/.test(code[index]!)) index++

    if (code.startsWith('//', index)) {
      const end = code.indexOf('\n', index)
      index = end === -1 ? code.length : end
    } else if (code.startsWith('/*', index)) {
      const end = code.indexOf('*/', index + 2)
      index = end === -1 ? code.length : end + 2
    } else break
  }

  if (code[index] !== "'" && code[index] !== '"') return start

  let offset = start
  const { program } = Parser.parseSync('source.tsx', code, {
    sourceType: 'module',
  })

  for (const node of program.body) {
    if (node.type !== 'ExpressionStatement' || !node.directive) break

    offset = node.end
  }

  return offset
}

/**
 * Moves encoded mappings for two lines inserted at a generated position. Segments at or past
 * `column` on `line` start the line after the insertion, and every later line moves down by two.
 * Other fields stay relative to the segment before them, which keeps its order.
 */
function insert(mappings: string, line: number, column: number) {
  const lines = mappings.split(';')
  const text = lines[line]

  if (text === undefined) return mappings

  let generated = 0
  let split = -1
  let position = 0
  const segments = text ? text.split(',') : []

  for (const [index, segment] of segments.entries()) {
    const [delta] = Vlq.decode(segment)

    generated += delta!

    if (generated >= column) {
      split = index
      position = generated
      break
    }
  }

  if (split === -1) {
    lines.splice(line + 1, 0, '', '')
    return lines.join(';')
  }

  const moved = segments.slice(split)
  const fields = Vlq.decode(moved[0]!)

  fields[0] = position - column
  moved[0] = Vlq.encode(fields)
  lines.splice(line, 1, segments.slice(0, split).join(','), '', moved.join(','))

  return lines.join(';')
}

/** Whether two import resolution records hold the same entries. */
function same(
  left: Readonly<Record<string, string | null>> | undefined,
  right: Readonly<Record<string, string | null>>,
) {
  if (!left) return false

  const keys = Object.keys(right)
  if (Object.keys(left).length !== keys.length) return false

  return keys.every((key) => left[key] === right[key])
}

/**
 * Whether `zyzz/runtime` resolves inside node_modules from the Vite root. Vite
 * optimizes a discovered import only there, so linked and aliased copies stay
 * source modules beside the other entrypoints.
 */
function installed(config: UserConfig) {
  const aliases = config.resolve?.alias ?? {}
  const entries = Array.isArray(aliases)
    ? aliases
    : Object.entries(aliases).map(([find, replacement]) => ({
        find,
        replacement,
      }))

  // Matches Vite's alias semantics: a string entry covers its subpaths.
  if (
    entries.some((entry) =>
      typeof entry.find === 'string'
        ? runtime === entry.find || runtime.startsWith(`${entry.find}/`)
        : entry.find.test(runtime),
    )
  )
    return false

  try {
    const require = createRequire(
      Path.join(Path.resolve(config.root ?? ''), 'package.json'),
    )

    // Vite keeps a symlinked package at its node_modules path, which Node dereferences.
    if (config.resolve?.preserveSymlinks)
      return (require.resolve.paths('zyzz') ?? []).some((directory) =>
        existsSync(Path.join(directory, 'zyzz/package.json')),
      )

    return require.resolve(runtime).split(Path.sep).includes('node_modules')
  } catch {
    return false
  }
}

// Vite forwards `scan` to `resolveId` hooks but leaves it out of its public types.
type ScanOptions = NonNullable<
  Parameters<DevEnvironment['pluginContainer']['resolveId']>[2]
> & { scan: boolean }

const scan: ScanOptions = { scan: true }

/**
 * Resolves imports read from source before other plugins transform their
 * importers. Marking them as scans, as Vite's dependency scanner does, keeps the
 * optimizer from discovering their dependencies and lets plugins tell them apart
 * from imports that reach the module graph.
 */
function resolver(environment: DevEnvironment): Host['resolve'] {
  return (source, importer) =>
    environment.pluginContainer.resolveId(source, importer, scan)
}

// Vite and Vitest load their own configuration modules, which application code never imports.
const configFiles = [
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
]
const prefix = '\0zyzz:'
const runtime = 'zyzz/runtime'
const sharedId = `${prefix}shared.css`

function cssId(file: string) {
  return `${prefix}${encodeURIComponent(file)}.css`
}

/** Vite integration configuration. */
export declare namespace zyzz {
  /** Source optimization and initialization injection remain enabled by default. */
  type Options = {
    /** False retains authored calls and requires explicit identities where needed. */
    readonly compiler?: boolean | undefined
    /**
     * Source modules left out of discovery and transforms. Globs resolve against the
     * Vite root unless they start with `**`, and regular expressions test absolute paths.
     * Imports of excluded modules stay runtime imports. Vite and Vitest configuration
     * modules are always excluded.
     */
    readonly exclude?: readonly (RegExp | string)[] | undefined
    /**
     * Globs, files, or directories that discovery scans, absolute or relative to the Vite root.
     * Setting them skips the `zyzz.config.*` search and nested-package skipping, and `exclude`
     * still applies. A pattern must start in an existing directory, and directories outside the
     * Vite root become source directories. Modules the application imports compile either way.
     */
    readonly include?: readonly string[] | undefined
    /** Native context captured at creation. Disables CSS delivery and initialization scripts. */
    readonly native?: Graph.compile.Options['native']
    /** Include the CSS reset. Defaults to false. */
    readonly reset?: boolean | undefined
    /**
     * Inline each configuration's `script()` at the start of index.html's head.
     * False skips injection for documents that inline the script themselves.
     */
    readonly script?: boolean | undefined
  }
}
