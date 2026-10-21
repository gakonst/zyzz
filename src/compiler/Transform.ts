/**
 * Rewrites extracted style calls into executable modules with CSS and source maps.
 * The Rust compiler performs the rewrite through the native addon.
 * @module
 */
import * as Edits from './internal/Edits.js'
import type * as Css from '../web/Css.js'
import * as ClassName from '../web/internal/ClassName.js'
import type * as Mapping from '@jridgewell/gen-mapping'
import * as Results from './internal/Results.js'
import type * as Source from './Source.js'
import * as ThemeRules from '../web/internal/Themes.js'

/**
 * Rewrites literal web styles and local themes without evaluation or file access.
 * Direct no-argument applications become props; other definitions become callables.
 * CSS retains ordered composition and receives module-scoped class identities.
 * @param options - Source text and a stable package-relative module identity.
 * @returns Rewritten TypeScript/JSX and CSS with separate version-three maps.
 * @throws {Source.ExtractError} If the source is outside the supported literal subset.
 * @throws {Css.CompileError} If literal CSS compilation fails.
 */
export function compile(options: compile.Options): compile.ReturnType {
  const input = {
    compiler: options.compiler,
    composition: options.composition,
    cssOutput: options.cssOutput,
    development: options.development,
    moduleId: options.moduleId,
    schemes: options.schemes,
    shared: options[ThemeRules.shared],
    target: options.target,
  }

  // Untyped callers can pass other values, which the engine reads from JSON as before.
  if (typeof options.source !== 'string')
    return Results.transform({ ...input, source: options.source })

  return Results.transform(input, options.source)
}

/** Source transform contracts. */
export declare namespace compile {
  /** Public failures from extraction and target compilation. */
  type ErrorType = Css.CompileError | Source.ExtractError
  /** Supplied module identity and source; no file loading occurs. */
  type Options = Source.extract.Options & {
    /** Separates generated token definitions for independently loaded modules. */
    readonly [ThemeRules.shared]?: 'all' | 'defaults' | undefined
    /** Names shared independent atomic rules, with one name table across a graph's modules. */
    readonly [ClassName.units]?: ClassName.Units | undefined
    /** Disable source rewriting while emitting CSS for runtime authoring. Defaults to true. */
    readonly compiler?: boolean | undefined
    /** Whether compiled applications can be combined with one another. */
    readonly composition?: Css.compile.Options['composition']
    /** Default CSS representation for definitions without an explicit mode. */
    readonly cssOutput?: Css.compile.Options['cssOutput']
    /** Retains live definitions for development updates, and renders wrapper components without folding them. */
    readonly development?: boolean | undefined
    /**
     * Emit the `color-scheme` selection classes beside the theme scopes.
     * Defaults to this module's own selector, root, and script references.
     */
    readonly schemes?: boolean | undefined
  }

  /** Executable module and stylesheet artifacts; TypeScript/JSX lowering belongs to the host. */
  type ReturnType = {
    /** Internal native node replacements, when supplied by the graph adapter. */
    readonly [Edits.key]?: readonly Edits.Edit[] | undefined
    /** Generated token resources delivered alongside this module's CSS. */
    readonly [ThemeRules.shared]?: readonly ThemeRules.Resource[] | undefined
    /** Module-scoped class lists keyed by extracted definition identity. */
    readonly classes: Readonly<Record<string, string>>
    /** Rewritten source with imports for surviving props callables. */
    readonly code: string
    /** Exact emitted rules retained for collision diagnostics. */
    readonly [ClassName.rules]: Readonly<Record<string, string>>
    /** Shared rule names chosen by this module, for graph cache validation. */
    readonly [ClassName.units]?: ClassName.Units['used'] | undefined
    /** Ordered, unminified stylesheet text. */
    readonly css: string
    /** Standard stylesheet map with authored selector/declaration locations. */
    readonly cssMap: Mapping.EncodedSourceMap
    /** Standard rewritten-module map, including original source content. */
    readonly map: Mapping.EncodedSourceMap
    /** Stable scope classes keyed by local module/binding identity. */
    readonly vars: Readonly<Record<string, string>>
  }
}
