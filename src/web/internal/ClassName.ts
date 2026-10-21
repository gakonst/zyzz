/** Escapes class tokens and shares unit names across a graph's compilations. @module */

/** Escapes a generated class token for use as a CSS selector. */
export function selector(value: string): string {
  return value.replace(
    /[^a-zA-Z0-9_-]/gu,
    (character) => `\\${character.codePointAt(0)!.toString(16)} `,
  )
}

/** Carries exact emitted rule bodies for graph-wide collision checks. */
export const rules = Symbol('zyzz.css.rules')

/** Carries a compilation's unit naming scope in, and its naming decisions out. */
export const units = Symbol('zyzz.css.units')

/**
 * Marks a graph compiled once with every module, whose stylesheets load together.
 * Only its modules may reuse names that unrelated modules introduce.
 */
export const complete = Symbol('zyzz.css.complete')

/**
 * Marks an application graph holding every module that may interpolate a style definition into
 * a selector, whose contracts no consumer reads. Production class lists then omit identity
 * classes that no selector references.
 */
export const references = Symbol('zyzz.css.references')

/** One compilation's unit names. */
export type Units = {
  /** Names a declaration unit, reusing a visible earlier name for an equal body. */
  readonly name: (body: string, namespace: string | undefined) => string
  /** Shared table access for compilers outside this JavaScript realm. */
  readonly [state]?: State | undefined
  /** Names chosen so far, keyed by namespace and body, and whether each was reused. */
  readonly used: ReadonlyMap<string, Decision>
}

/** Exposes a scope's shared name table to compilers outside this JavaScript realm. */
export const state = Symbol('zyzz.css.units.state')

/** Reads and updates one scope's shared name table without naming units. */
export type State = {
  /** Snapshots every registered name, this scope's identity, and the owners it may borrow from. */
  readonly read: () => Snapshot
  /** Applies decisions made outside this realm, as if this scope had named each unit. */
  readonly record: (used: ReadonlyMap<string, Decision>) => void
}

/** A scope's view of the shared name table. */
export type Snapshot = {
  /** Registered names as `[key, name, owner]`, in registration order. */
  readonly names: readonly (readonly [string, string, string])[]
  /** Compilation identity recorded on the names it introduces. */
  readonly owner: string
  /** Fixed prefix distinguishing this compilation's new names. */
  readonly qualifier: string
  /** Owners whose names this scope may reuse, or `undefined` for every owner. */
  readonly visible: readonly string[] | undefined
}

/** A naming decision recorded so cached output can be validated against a later build. */
export type Decision = {
  /** Whether the name was introduced by an earlier compilation. */
  readonly borrowed: boolean
  /** Emitted class name. */
  readonly name: string
}

/** Shares unit names across the compilations of one graph. */
export function registry(): registry.ReturnType {
  const names = new Map<string, { name: string; owner: string }>()

  // A borrowed name stays tied to its first owner, so later modules can resolve it.
  function borrow(key: string, visible?: (owner: string) => boolean) {
    const previous = names.get(key)
    if (previous && (visible?.(previous.owner) ?? true)) return previous.name
    return undefined
  }

  return {
    restore(options) {
      for (const [key, decision] of options.used) {
        const name = borrow(key, options.visible)
        if ((name !== undefined) !== decision.borrowed) return false
        if (name !== undefined && name !== decision.name) return false
      }

      for (const [key, decision] of options.used)
        if (!names.has(key))
          names.set(key, { name: decision.name, owner: options.owner })

      return true
    },
    scope(options) {
      const local = new Map<string, number>()
      const used = new Map<string, Decision>()

      return {
        name(body, namespace) {
          const key = `${namespace ?? ''}\n${body}`

          // Every distinct body consumes a slot, so own names never depend on reuse.
          let index = local.get(key)
          if (index === undefined) {
            index = local.size
            local.set(key, index)
          }

          const borrowed = borrow(key, options.visible)
          // The underscore keeps unit names apart from readable names and anonymous scopes.
          const name =
            borrowed ??
            `z_${namespace ? `${namespace}-` : ''}${options.qualifier}${index.toString(36)}`

          if (!names.has(key)) names.set(key, { name, owner: options.owner })
          used.set(key, { borrowed: borrowed !== undefined, name })

          return name
        },
        [state]: {
          read() {
            const owners = new Set([
              options.owner,
              ...[...names.values()].map((entry) => entry.owner),
            ])

            return {
              names: [...names].map(
                ([key, entry]) => [key, entry.name, entry.owner] as const,
              ),
              owner: options.owner,
              qualifier: options.qualifier,
              visible: options.visible
                ? [...owners].filter(options.visible)
                : undefined,
            }
          },
          record(decisions) {
            for (const [key, decision] of decisions) {
              if (!names.has(key))
                names.set(key, { name: decision.name, owner: options.owner })
              used.set(key, decision)
            }
          },
        },
        used,
      }
    },
  }
}

/** Graph-wide unit naming contracts. */
export declare namespace registry {
  /** Visibility and identity of one compilation in the shared name table. */
  type Options = {
    /** Compilation identity recorded on the names it introduces. */
    readonly owner: string
    /** Limits reuse to names introduced by these owners. Defaults to every owner. */
    readonly visible?: ((owner: string) => boolean) | undefined
  }

  /** Creates per-compilation naming scopes over one shared name table. */
  type ReturnType = {
    /**
     * Registers a cached compilation's names. Returns false, registering nothing,
     * when compiling it now would choose different names.
     */
    readonly restore: (
      options: Options & {
        /** Decisions recorded by the cached compilation. */
        readonly used: ReadonlyMap<string, Decision>
      },
    ) => boolean
    /** Names units for one compilation, whose qualifier keeps new names distinct. */
    readonly scope: (
      options: Options & {
        /** Fixed prefix distinguishing this compilation's new names. */
        readonly qualifier: string
      },
    ) => Units
  }
}

/** Carries authored names between source extraction and CSS emission. */
export const labels = Symbol('zyzz.css.labels')

/** Authored names retained on extracted style data. */
export type Labels = Readonly<
  Record<
    string,
    { readonly name: string; readonly namespace?: string | undefined }
  >
>
