/**
 * Links a closed graph of source modules without executing code or reading files.
 * @module
 */
import type * as Mapping from '@jridgewell/gen-mapping'
import * as Addon from '../internal/Addon.js'
import type * as Css from '../web/Css.js'
import * as ClassName from '../web/internal/ClassName.js'
import * as ThemeRules from '../web/internal/Themes.js'
import type * as Native from './Native.js'
import type * as Source from './Source.js'
import type * as Transform from './Transform.js'
import type * as Context from './internal/Context.js'
import * as Results from './internal/Results.js'
import * as Stylesheets from './internal/Stylesheets.js'

/** Compiles supplied modules with shared theme contracts and dependency metadata. */
export function compile(options: compile.Options): compile.ReturnType {
  return Results.graph(
    Results.call<Results.Output>('graph.compile', encode(options)),
  )
}

/** The engine's answer when a snapshot names a source it no longer holds. */
const stale = '{"stale":true}'

/** Names each source equal to the one `previous` held as `0`. */
function unchanged(
  sources: Readonly<Record<string, string>> | undefined,
  previous: Readonly<Record<string, string>> | undefined,
) {
  if (!sources || !previous) return sources

  const output: Record<string, string | 0> = {}

  for (const [id, source] of Object.entries(sources))
    output[id] = previous[id] === source ? 0 : source

  return output
}

/** The engine's graph input. */
function encode(options: compile.Options) {
  return {
    complete: options[ClassName.complete],
    compiler: options.compiler,
    composition: options.composition,
    contracts: options.contracts,
    cssOutput: options.cssOutput,
    development: options.development,
    entry: options[Stylesheets.entry],
    imports: options.imports,
    lean: options[Results.lean],
    modules: options.modules,
    native: options.native && Results.native(options.native),
    references: options[ClassName.references],
    reset: options.reset,
    shared: options[ThemeRules.shared],
  }
}

/** Input and output of graph compilation. */
export declare namespace compile {
  /** Errors raised while extracting or compiling a source graph. */
  type ErrorType =
    | Native.compile.ErrorType
    | Source.ExtractError
    | Transform.compile.ErrorType

  /** Source modules available for relative import resolution. */
  type Options = {
    /** CSS-only hosts publish variable scopes once with shared rules. */
    readonly [ThemeRules.shared]?: 'all' | 'defaults' | undefined
    /** Host entrypoints emit owned stylesheet effects without packed contracts. */
    readonly [Stylesheets.entry]?: string | undefined
    /** Lets modules reuse shared rule names from unrelated modules of this one graph. */
    readonly [ClassName.complete]?: boolean | undefined
    /** Holds every module whose selectors may interpolate a style definition. */
    readonly [ClassName.references]?: boolean | undefined
    /** Leaves out per-module records and publishes only configuration catalogs as contracts. */
    readonly [Results.lean]?: boolean | undefined
    /** Rewrite authoring calls. False emits CSS for unchanged source. */
    readonly compiler?: boolean | undefined
    /** Whether compiled applications can be combined with one another. */
    readonly composition?: Css.compile.Options['composition']
    /** Default CSS representation for definitions without an explicit mode. */
    readonly cssOutput?: Css.compile.Options['cssOutput']
    /** Serialized library contracts keyed by host-resolved module identity. Runtime modules stay external to this graph. */
    readonly contracts?: Readonly<Record<string, string>> | undefined
    /** Stable declaration names for CSS-only development updates. */
    readonly development?: boolean | undefined
    /** Host-resolved static runtime imports keyed by module ID and source specifier; null marks externals. The host owns dynamic imports when supplied. Omit for closed relative-graph resolution. */
    readonly imports?:
      | Readonly<Record<string, Readonly<Record<string, string | null>>>>
      | undefined
    /** Native output context. Omit to compile web modules and CSS. */
    readonly native?:
      | Omit<Native.compile.Options, 'moduleId' | 'source' | typeof Context.key>
      | undefined
    /** Complete source graph keyed by stable package-relative module identities. */
    readonly modules: Readonly<Record<string, string>>
    /** Optional reset stylesheet supplied by the host, ordered before authored layers. */
    readonly reset?: string | undefined
  }

  /** Compiled modules and their direct source dependencies. */
  type ReturnType = {
    /** Packed resources deduplicated by the host across scoped source outputs. */
    readonly [Stylesheets.packed]?: readonly Stylesheets.Resource[]
    /** Independently loaded reset for module-based hosts. */
    readonly [Stylesheets.reset]?: Stylesheets.Resource | undefined
    /** Versioned compiler-only JSON, including static literal exports. Publish beside the compiled entrypoint as <entry>.zyzz.json. */
    readonly contracts: Readonly<Record<string, string>>
    /** Direct static runtime source and library-contract dependencies, keyed by module identity. */
    readonly dependencies: Readonly<Record<string, readonly string[]>>
    /** Shared contributions and responsive token defaults. Load before module CSS. */
    readonly sharedCss?: string | undefined
    /** Source map for source-owned and packed global contributions. */
    readonly sharedCssMap?: Mapping.EncodedSourceMap | undefined
    /** Trusted source or contract owner for each shared asset placeholder. */
    readonly sharedAssetOwners?: Readonly<Record<string, string>> | undefined
    /** Portable asset targets keyed by emitted compiler URL placeholders. */
    readonly sharedAssets?: Readonly<Record<string, string>> | undefined
    /** Rewritten modules and their stylesheets/maps. Load the CSS for the graph together. */
    readonly modules: Readonly<Record<string, Transform.compile.ReturnType>>
  }
}

/** Creates an isolated compiler with bounded extraction reuse across source graphs. */
export function create(): create.ReturnType {
  const decoded = new Map<string, Transform.compile.ReturnType>()
  // The engine compiler owns the caches, and collecting this object releases them.
  let engine: InstanceType<Addon.Exports['Graph']> | undefined
  let result: compile.ReturnType | undefined
  // The engine holds the sources of its last decoded snapshot, so a source equal to the one sent
  // last crosses the boundary as `0`. A failed call leaves nothing sent, which resends every source.
  let sent: Pick<ReturnType<typeof encode>, 'contracts' | 'modules'> | undefined

  return Object.freeze({
    compile(options: compile.Options): compile.ReturnType {
      engine ??= new (Addon.load().Graph)()

      const input = encode(options)
      const previous = sent

      sent = undefined

      const text = (() => {
        if (!previous) return engine.compile(JSON.stringify(input))

        const output = engine.compile(
          JSON.stringify({
            ...input,
            contracts: unchanged(input.contracts, previous.contracts),
            modules: unchanged(input.modules, previous.modules),
          }),
        )

        return output === stale ? engine.compile(JSON.stringify(input)) : output
      })()

      result = Results.graph(
        Results.decode<Results.Output>(text),
        result,
        decoded,
      )
      // Hosts may update their records in place, so the sent text is copied.
      sent = {
        contracts: input.contracts && { ...input.contracts },
        modules: { ...input.modules },
      }

      return result
    },
  })
}

/** Incremental graph compiler contracts. */
export declare namespace create {
  /** Explicitly owned compilation state; dropping the compiler releases its cache. */
  type ReturnType = {
    /** Compiles a complete source snapshot, reusing unaffected work across calls. */
    readonly compile: typeof compile
  }
}
