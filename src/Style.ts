/**
 * Copies typed style declarations into immutable, ordered, target-independent data.
 * @module
 */
import type * as ClassName from './web/internal/ClassName.js'
import * as VariableSets from './internal/VariableSets.js'
import type * as Vars from './Vars.js'
import * as Condition from './internal/Condition.js'
import * as Query from './internal/Query.js'
import * as Binding from './internal/Binding.js'
import type * as Literal from './internal/Literal.js'
import * as Token from './internal/Token.js'
import * as Typography from './internal/Typography.js'
import * as Value from './internal/Value.js'
import type * as Theme from './internal/Theme.js'
import * as Targets from './internal/Targets.js'

/** Validates only authored keys, recursively retaining nested token inference. */
export type Accepted<
  style,
  tokens extends Theme.Tokens = {},
  literal extends boolean = false,
  targets extends boolean = true,
> = Record<
  Exclude<
    Exclude<Keys<style>, Reserved<tokens>>,
    Condition.Dynamic<Keys<style>>
  >,
  never
> &
  (style extends unknown
    ? {
        [key in keyof style]: key extends 'targets'
          ? targets extends true
            ? AcceptedTargets<style[key], tokens, literal>
            : never
          : key extends 'selectors'
            ? style[key] extends Record<string, unknown>
              ? {
                  [selector in keyof style[key]]: style[key][selector] extends Record<
                    string,
                    unknown
                  >
                    ? Accepted<style[key][selector], tokens, literal, targets>
                    : never
                }
              : never
            : key extends 'vars'
              ? style[key] extends Record<string, unknown>
                ? {
                    [name in keyof style[key]]: style[key][name] extends
                      | number
                      | string
                      ? Literal.Checked<style[key][name]>
                      : literal extends true
                        ? never
                        : style[key][name] extends Token.Reference
                          ? style[key][name]
                          : never
                  }
                : never
              : key extends 'typography'
                ? literal extends true
                  ? never
                  : style[key] extends Value.Atom<Typography.Names<tokens>>
                    ? style[key]
                    : // A disjoint literal would reduce the whole object to `never`, so the brand keeps the error on this property.
                      Value.Unmatched<Typography.Names<tokens>>
                : key extends keyof Literal.Properties
                  ? (literal extends true
                      ? LiteralDeclarations
                      : keyof tokens extends never
                        ? LiteralDeclarations
                        : DeclarationProperties<tokens>)[key] extends style[key]
                    ? style[key]
                    : // Naming the expected tokens avoids a `never` diagnostic and keeps completions to accepted values.
                      [Value.Tokens<style[key], tokens, key>] extends [never]
                      ? Value.Mismatch<tokens, key>
                      : Value.Accepted<
                          Pick<style, key>,
                          literal extends true
                            ? LiteralDeclarations
                            : DeclarationProperties<tokens>
                        >[key] &
                          Value.Checked<Pick<style, key>, tokens>[key] &
                          Value.Tokens<style[key], tokens, key>
                  : key extends Condition.Keys<tokens, key>
                    ? [style[key]] extends [undefined]
                      ? never
                      : NonNullable<style[key]> extends Record<string, unknown>
                        ?
                            | Accepted<
                                NonNullable<style[key]>,
                                tokens,
                                literal,
                                targets
                              >
                            | Extract<style[key], undefined>
                        : never
                    : never
      }
    : never)

type AcceptedTargets<
  input,
  tokens extends Theme.Tokens,
  literal extends boolean,
> = input extends undefined
  ? undefined
  : {
      [key in keyof input]: key extends 'web'
        ?
            | Accepted<NonNullable<input[key]>, tokens, literal, false>
            | Extract<input[key], undefined>
        : key extends 'android' | 'ios' | 'native'
          ? Targets.Declarations<input[key]>
          : never
    }

/** Explicit target declarations, applied after shared declarations. */
export type TargetBranches<tokens extends Theme.Tokens = {}> =
  Targets.NativeBranches & {
    /** Web declarations retain CSS semantics and conditions. */
    readonly web?: Properties<tokens, false> | undefined
  }

type Keys<value> = value extends unknown ? keyof value : never

// The conditional caches this union per token set. `Accepted` runs for every declaration,
// and the union holds every property name.
type Reserved<tokens extends Theme.Tokens> = [tokens] extends [unknown]
  ?
      | keyof Literal.Properties
      | Condition.Static<tokens>
      | 'selectors'
      | 'targets'
      | 'typography'
      | 'vars'
  : never

type Exact<
  styles extends Record<string, unknown>,
  tokens extends Theme.Tokens,
> = {
  [name in keyof styles]: Extract<
    styles[name],
    (...args: never[]) => unknown
  > extends never
    ? Properties<tokens> extends styles[name]
      ? styles[name] extends Properties<tokens>
        ? styles[name] &
            Record<Exclude<Keys<styles[name]>, keyof Properties<tokens>>, never>
        : never
      : DeclarationProperties<tokens> extends styles[name]
        ? styles[name] extends DeclarationProperties<tokens>
          ? styles[name] &
              Record<
                Exclude<
                  Keys<styles[name]>,
                  keyof DeclarationProperties<tokens>
                >,
                never
              >
          : never
        : Accepted<styles[name], tokens>
    : never
}

const targetBranch = Symbol('zyzz.target.branch')
const nesting = Symbol('zyzz.style.nesting')

/** A typed declaration; order is significant for future cascade processing. */
export type Declaration = {
  /** Whether this declaration overrides normal declarations in the cascade. */
  readonly important?: boolean | undefined
  /** Supported CSS property in camelCase. */
  readonly property: keyof Literal.Properties
  /** Validated primitive or immutable, domain-checked theme reference. */
  readonly value:
    | number
    | string
    | Token.Reference
    | Token.Expression
    | Binding.Reference
}

/**
 * Copies named literal and token styles into deeply frozen ordered data.
 * CSS values are checked by TypeScript only.
 * Preserves names, values, and JavaScript own-property enumeration order. Never
 * evaluates accessors, mutates input, generates CSS, or reads an environment.
 * Empty maps and empty styles are valid. See the literal subset documentation.
 * @param styles - Plain objects containing supported primitives or typed theme references.
 * @param options - Optional theme for shorthand names and caller-owned diagnostic source spans.
 * @returns Immutable definitions retaining the inferred style-name union.
 * @throws {InvalidError} If the input structure cannot represent ordered declarations.
 */
export function define<
  const values extends Vars.Values,
  const styles extends Record<string, unknown>,
>(
  styles: styles &
    NoInfer<Exact<styles, Vars.Mapped<values, {}>>> & {
      [key in keyof styles]: WithoutRelationships<styles[key]>
    },
  options: {
    readonly vars: Vars.Definition<values>
    readonly locations?: readonly SourceLocation[]
  },
): Definition<
  `${Extract<keyof styles, string | number>}`,
  Targets.Domains<styles>
>
export function define<
  const styles extends Record<string, unknown>,
  const tokens extends Theme.Tokens,
>(
  styles: styles &
    NoInfer<Exact<styles, tokens>> & {
      [key in keyof styles]: WithoutRelationships<styles[key]>
    },
  options: define.Options<tokens>,
): Definition<
  `${Extract<keyof styles, number | string>}`,
  Targets.Domains<styles>
>
export function define<const styles extends Record<string, unknown>>(
  styles: styles &
    NoInfer<Exact<styles, {}>> & {
      [key in keyof styles]: WithoutRelationships<styles[key]>
    },
  options?: define.Options,
): Definition<
  `${Extract<keyof styles, number | string>}`,
  Targets.Domains<styles>
>
export function define(
  styles: Record<string, unknown>,
  options: define.Options = {},
): Definition {
  const theme =
    options.vars &&
    (typeof Reflect.get(options.vars, 'style') === 'function'
      ? (options.vars as Theme.Definition)
      : VariableSets.theme(options.vars as Vars.Definition))
  if ((options[nesting] ?? 0) > 128)
    throw new InvalidError([
      {
        code: 'invalid_structure',
        path: [],
        message: 'Nested styles exceed the depth limit.',
      },
    ])

  const diagnostics: Diagnostic[] = []
  const output: NamedStyle[] = []
  // One definition owns one theme; only validated references are reused within this call.
  const references = new Map<
    keyof Literal.Properties,
    Map<string | number, Token.Reference>
  >()
  const validatedReferences = new WeakSet<object>()

  function isReference(value: unknown): value is Token.Reference {
    if (typeof value !== 'object' || value === null) return false
    if (validatedReferences.has(value)) return true
    if (!Token.is(value)) return false

    // Frozen references can reuse validation across declarations in this definition.
    validatedReferences.add(value)
    return true
  }

  function report(
    code: Diagnostic['code'],
    path: readonly string[],
    message: string,
  ) {
    const span = options.locations?.find(
      (location) =>
        location.path.length === path.length &&
        location.path.every((part, i) => part === path[i]),
    )

    const location = span
      ? Object.freeze({ ...span, path: Object.freeze([...span.path]) })
      : undefined

    diagnostics.push(
      Object.freeze({
        code,
        message,
        path: Object.freeze([...path]),
        ...(location ? { location } : {}),
      }),
    )
  }

  function entries(
    value: unknown,
    path: readonly string[],
  ): readonly (readonly [string, unknown])[] {
    const prototype: object | null | undefined =
      typeof value === 'object' && value !== null
        ? Object.getPrototypeOf(value)
        : undefined
    // Compare the native Object constructor across realms without reading getters.
    const constructor: unknown =
      prototype &&
      prototype !== Object.prototype &&
      Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value

    if (
      typeof value !== 'object' ||
      value === null ||
      (prototype !== null &&
        prototype !== Object.prototype &&
        (prototype === undefined ||
          Object.getPrototypeOf(prototype) !== null ||
          typeof constructor !== 'function' ||
          Function.prototype.toString.call(constructor) !==
            Function.prototype.toString.call(Object)))
    ) {
      report(
        'invalid_structure',
        path,
        'Expected a plain object with enumerable data properties.',
      )

      return []
    }

    const result: [string, unknown][] = []

    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)

      if (
        typeof key !== 'string' ||
        !descriptor?.enumerable ||
        !('value' in descriptor)
      ) {
        report(
          'invalid_structure',
          typeof key === 'string' ? [...path, key] : path,
          'Only enumerable string-keyed data properties are supported; accessors and symbols are not evaluated.',
        )
        continue
      }

      result.push([key, descriptor.value])
    }

    return result
  }

  for (const [name, style] of entries(styles, [])) {
    if (name.length === 0)
      report('invalid_structure', [name], 'Style names must not be empty.')

    const mappings = theme?.[Token.definition].contract.shorthands
    const authored = entries(style, [name]).filter(
      ([key, value]) => key !== 'targets' || value !== undefined,
    )
    const target = authored.find(([key]) => key === 'targets')
    if (target) {
      if (options[targetBranch]) {
        report(
          'invalid_structure',
          [name, 'targets'],
          'Target branches cannot contain nested target branches.',
        )
        continue
      }
      const targets: Record<string, unknown> = {}
      try {
        for (const [key, input] of entries(target[1], [name, 'targets'])) {
          if (!['android', 'ios', 'native', 'web'].includes(key)) {
            report(
              'invalid_structure',
              [name, 'targets', key],
              'Unknown style target.',
            )
            continue
          }
          if (input === undefined) continue
          if (key === 'web') {
            try {
              targets.web = define({ [name]: input } as never, {
                ...options,
                [nesting]: (options[nesting] ?? 0) + 1,
                [targetBranch]: true,
              }).styles[0]
            } catch (error) {
              if (!(error instanceof InvalidError)) throw error
              for (const diagnostic of error.diagnostics)
                report(
                  diagnostic.code,
                  [name, 'targets', 'web', ...diagnostic.path.slice(1)],
                  diagnostic.message,
                )
            }
          } else {
            entries(input, [name, 'targets', key])
            targets[key] = Targets.copy(input, [name, 'targets', key])
          }
        }
        const shared = define(
          {
            [name]: Object.fromEntries(
              authored.filter(([key]) => key !== 'targets'),
            ),
          } as never,
          { ...options, [nesting]: (options[nesting] ?? 0) + 1 },
        ).styles[0]!
        output.push(
          Object.freeze({ ...shared, targets: Object.freeze(targets) }),
        )
      } catch (error) {
        if (error instanceof InvalidError)
          diagnostics.push(...error.diagnostics)
        else
          report(
            'invalid_structure',
            [name, 'targets'],
            (error as Error).message,
          )
      }
      continue
    }

    const properties = authored.flatMap(
      ([property, input]): readonly (readonly [string, unknown, string])[] => {
        if (property !== 'typography')
          return (mappings?.[property] ?? [property]).map(
            (target) => [target, input, property] as const,
          )

        const parsed = Value.parse(input, 'fontFamily')
        if (parsed && 'invalid' in parsed) {
          report(
            'invalid_value',
            [name, property],
            'Value markers require " !custom" followed by optional " !important", or " !important" alone.',
          )
          return []
        }

        const path = parsed?.value ?? input
        const entries = Typography.entries(theme, path)
        if (!entries.length) {
          report(
            'invalid_value',
            [name, property],
            'Expected a named typography set from the bound theme.',
          )
          return []
        }

        // Explicit declarations in this block override the corresponding preset fields.
        const explicit = new Set(
          authored.flatMap(([property]) => mappings?.[property] ?? [property]),
        )
        return Typography.entries(theme, path, explicit, parsed?.important).map(
          ([field, value]) => [field, value, property] as const,
        )
      },
    )

    if (properties.some(([key]) => Condition.is(key))) {
      const rules: Rule[] = []

      const blocks = authored.flatMap(([key, input]) =>
        key === 'typography'
          ? properties
              .filter(([, , original]) => original === key)
              .map(([property, value]) => [property, value] as const)
          : [[key, input] as const],
      )

      for (const [key, input] of blocks) {
        try {
          const condition = Condition.is(key)
            ? Query.resolve(
                key,
                theme?.[Token.definition].queries ?? {
                  breakpoint: {},
                  container: {},
                  containerNames: [],
                },
              )
            : undefined

          if (condition !== undefined) Condition.normalize(condition)

          const nested = (
            define as (
              styles: Record<string, unknown>,
              options: define.Options,
            ) => Definition
          )(
            { [name]: condition === undefined ? { [key]: input } : input },
            {
              ...options,
              [nesting]: (options[nesting] ?? 0) + 1,
              locations: options.locations
                ?.filter(
                  (location) =>
                    condition === undefined || location.path[1] === key,
                )
                .map((location) =>
                  condition === undefined
                    ? location
                    : {
                        ...location,
                        path: location.path.filter((_, index) => index !== 1),
                      },
                ),
            },
          )

          rules.push(
            Object.freeze({
              ...(condition === undefined
                ? {}
                : {
                    condition: Condition.normalize(
                      condition.startsWith(':') && !Condition.nested(condition)
                        ? `&${condition}`
                        : condition,
                    ),
                  }),
              style: nested.styles[0]!,
            }),
          )
        } catch (error) {
          if (error instanceof InvalidError)
            diagnostics.push(
              ...error.diagnostics.map((diagnostic) =>
                Condition.is(key)
                  ? Object.freeze({
                      ...diagnostic,
                      path: Object.freeze([
                        name,
                        key,
                        ...diagnostic.path.slice(1),
                      ]),
                      ...(diagnostic.location
                        ? {
                            location: Object.freeze({
                              ...diagnostic.location,
                              path: Object.freeze([
                                name,
                                key,
                                ...diagnostic.location.path.slice(1),
                              ]),
                            }),
                          }
                        : {}),
                    })
                  : diagnostic,
              ),
            )
          else
            report('invalid_structure', [name, key], (error as Error).message)
        }
      }

      output.push(
        Object.freeze({
          name,
          declarations: Object.freeze([]),
          rules: Object.freeze(rules),
        }),
      )
      continue
    }

    const declarations: Declaration[] = []

    for (const [property, input, authoredProperty] of properties) {
      const key = property as keyof Literal.Properties
      const inputs: unknown[] = []

      if (Array.isArray(input)) {
        if (!input.length) {
          report(
            'invalid_value',
            [name, authoredProperty],
            'Fallback arrays must be nonempty.',
          )
          continue
        }

        for (let index = 0; index < input.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(
            input,
            String(index),
          )

          if (!descriptor || !('value' in descriptor)) {
            report(
              'invalid_structure',
              [name, authoredProperty, String(index)],
              'Fallback arrays require dense data entries without accessors.',
            )
            continue
          }

          inputs.push(descriptor.value)
        }

        if (inputs.length !== input.length) continue
      } else inputs.push(input)

      for (const entry of inputs) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          Object.getOwnPropertyDescriptor(entry, 'variable')?.value === true &&
          !Binding.is(entry)
        ) {
          report(
            'invalid_structure',
            [name, authoredProperty],
            'Invalid compiler binding reference.',
          )
          continue
        }

        const parsed = Value.parse(entry, key)
        if (parsed && 'invalid' in parsed) {
          report(
            'invalid_value',
            [name, authoredProperty],
            'Value markers require " !custom" followed by optional " !important", or " !important" alone.',
          )
          continue
        }
        const custom = parsed?.custom
        const scalar = parsed ? parsed.value : entry

        const resolved = (() => {
          if (!theme || custom) return scalar

          if (typeof scalar !== 'string' && typeof scalar !== 'number')
            return scalar

          const cached = references.get(key)?.get(scalar)
          if (cached) return cached

          const resolved = Token.resolve(scalar, {
            property: key,
            theme,
          })

          if (isReference(resolved)) {
            let values = references.get(key)

            if (!values) references.set(key, (values = new Map()))

            values.set(scalar, resolved)
          }

          return resolved
        })()

        const reference = isReference(resolved)

        if (
          reference &&
          resolved.contract.variableSet &&
          !Token.acceptsReference(resolved, key)
        ) {
          report(
            'invalid_value',
            [name, authoredProperty],
            'Variable value is incompatible with this property.',
          )
          continue
        }

        if (
          theme &&
          !custom &&
          !reference &&
          Token.mapped(theme, key) &&
          !(Binding.is(resolved) && !resolved[Binding.dynamic]) &&
          !(
            Token.isExpression(resolved) &&
            (resolved !== scalar ||
              resolved.parts.every((part) => Token.is(part) || part === ''))
          )
        ) {
          report(
            'invalid_value',
            [name, authoredProperty],
            'Expected a configured token or a CSS value with the " !custom" suffix.',
          )
          continue
        }

        const value = parsed && resolved === '0' ? 0 : resolved

        declarations.push(
          Object.freeze({
            ...(parsed?.important ? { important: true } : {}),
            property: key,
            value: value as
              | number
              | string
              | Token.Reference
              | Token.Expression
              | Binding.Reference,
          }),
        )
      }
    }

    output.push(
      Object.freeze({ declarations: Object.freeze(declarations), name }),
    )
  }

  if (diagnostics.length) throw new InvalidError(diagnostics)

  const defaultLayer = theme?.[Token.definition].contract.defaultLayer
  // Apply defaults after validation to retain authored diagnostic paths and explicit layer nesting.
  function layered(style: NamedStyle): NamedStyle {
    const { targets, ...body } = style
    const rules = (() => {
      if (style.rules)
        return style.rules.map((rule) =>
          rule.condition === '@layer' || rule.condition?.startsWith('@layer ')
            ? rule
            : Object.freeze({ ...rule, style: layered(rule.style) }),
        )

      if (!style.declarations.length) return []

      return [
        Object.freeze({
          condition: `@layer ${defaultLayer}`,
          style: Object.freeze(body),
        }),
      ]
    })()

    return Object.freeze({
      ...body,
      declarations: style.rules ? style.declarations : Object.freeze([]),
      rules: Object.freeze(rules),
      ...(targets
        ? {
            targets: Object.freeze({
              ...targets,
              ...(targets.web ? { web: layered(targets.web) } : {}),
            }),
          }
        : {}),
    })
  }

  // Validated names are precisely the input's enumerable string keys.
  return Object.freeze({
    styles: Object.freeze(
      defaultLayer && !options[nesting] ? output.map(layered) : output,
    ),
  })
}

/** Options for defining styles. */
export declare namespace define {
  /** Source locations are optional; pure in-memory callers need no source text. */
  type Options<tokens extends Theme.Tokens = never> = {
    /** Internal recursion budget, propagated only by structured authoring. */
    readonly [targetBranch]?: boolean | undefined
    readonly [nesting]?: number | undefined
    /** Caller-provided spans matched by complete diagnostic path. */
    readonly locations?: readonly SourceLocation[] | undefined
  } & ([tokens] extends [never]
    ? {
        /** Optional themes do not enable shorthand inference. */
        readonly vars?: Theme.Definition | Vars.Definition | undefined
      }
    : {
        /** Shorthand inference requires a defined token contract. */
        readonly vars: Theme.Definition<tokens>
      })
}

/** Immutable data passed from authoring to later target compilation. */
export type Definition<name extends string = string, input = unknown> = {
  /** Type-only declarations used to retain native component compatibility. */
  readonly [Targets.authored]?: input
  /** Internal source naming metadata retained through target compilation. */
  readonly [ClassName.labels]?: ClassName.Labels | undefined
  /** Named styles in own enumerable property order. */
  readonly styles: readonly NamedStyle<name>[]
}

/** A caller-visible validation failure at an exact input path. */
export type Diagnostic = {
  /** Stable machine-readable category. */
  readonly code: 'invalid_structure' | 'invalid_value'
  /** Source span when a caller supplied an exact matching path. */
  readonly location?: SourceLocation | undefined
  /** Explanation of the supported input contract. */
  readonly message: string
  /** Path components, without ambiguous dot concatenation. */
  readonly path: readonly string[]
}

/** Validation error containing all failures in deterministic input order. */
export class InvalidError extends Error {
  /** Creates an error from caller-visible validation diagnostics. */
  constructor(diagnostics: readonly Diagnostic[]) {
    super(
      diagnostics
        .map((item) => `${JSON.stringify(item.path)}: ${item.message}`)
        .join('\n'),
    )
    this.diagnostics = Object.freeze([...diagnostics])
  }
  /** Frozen diagnostics, ordered by style and declaration traversal. */
  readonly diagnostics: readonly Diagnostic[]
  /** Stable namespaced error identifier. */
  override name = 'Style.InvalidError'
}

type LiteralAtoms = {
  readonly [property in keyof Literal.Properties]-?: Value.Atom<
    | Exclude<Literal.Properties[property], undefined>
    | `${string} !custom`
    | Binding.Reference<'*'>
    | {
        [kind in Binding.Kind]: property extends Binding.Property<
          kind,
          property
        >
          ? Binding.Reference<kind>
          : never
      }[Binding.Kind]
  >
}

/** Supported primitive CSS declarations without theme references. */
export type LiteralDeclarations = {
  readonly [property in keyof Literal.Properties]: Value.Fallbacks<
    LiteralAtoms[property]
  >
}

/** A named group of ordered declarations. */
export type NamedStyle<name extends string = string> = {
  /** Compiler-owned composition mode inherited from the defining configuration. */
  readonly composition?: 'independent' | 'ordered' | undefined
  /** Compiler-owned web mode inherited from the defining configuration. */
  readonly cssOutput?: 'atomic' | 'grouped' | undefined
  /** Ordered nested blocks, when this style contains conditions. */
  readonly rules?: readonly Rule[] | undefined
  /** Declarations in own enumerable property order. */
  readonly declarations: readonly Declaration[]
  /** Authored style name, without generated target identifiers. */
  readonly name: name
  /** Target-neutral branches retained through source and packed compilation. */
  readonly targets?:
    | (Targets.NativeBranches & { readonly web?: NamedStyle | undefined })
    | undefined
}

/** Supported literal and token declarations. Unknown properties and undefined values are rejected. */
export type DeclarationProperties<tokens extends Theme.Tokens = {}> = {
  readonly [property in keyof Literal.Properties]: DeclarationValue<
    tokens,
    property
  >
}

// A named alias caches each property domain without expanding the full declaration map.
type DeclarationValue<
  tokens extends Theme.Tokens,
  property extends keyof Literal.Properties,
> = Value.Fallbacks<
  | (property extends `--${string}`
      ? LiteralAtoms[property]
      : [Token.Names<tokens, property>] extends [never]
        ? LiteralAtoms[property]
        :
            | Value.Atom<`${string} !custom`>
            | Extract<LiteralAtoms[property], Binding.Reference>)
  | Value.Atom<Token.Names<tokens, property>>
  | {
      [group in Token.Group]: property extends Token.Properties<group>
        ? Value.Atom<Token.Reference<group> | Token.Variable<group>>
        : never
    }[Token.Group]
>

/** Recursive theme-aware declaration and condition authoring. */
export type Properties<
  tokens extends Theme.Tokens = {},
  targets extends boolean = true,
> = DeclarationProperties<tokens> & {
  readonly [key in Condition.Keys<tokens>]?: Properties<tokens, targets>
} & {
  readonly targets?:
    | (targets extends true ? TargetBranches<tokens> : never)
    | undefined
  /** Applies a named typography set. Explicit fields in the same block take precedence. */
  readonly typography?: Value.Atom<Typography.Names<tokens>>
}

/** Nested literal declarations retain exact keys at every depth. */
export type LiteralProperties = LiteralDeclarations & {
  readonly [key in Condition.Keys]?: LiteralProperties
}

/** Ordered nested blocks; an absent condition represents a declaration segment. */
export type Rule = {
  /** Scoped selector or conditional at-rule; absent for a declaration segment. */
  readonly condition?: string | undefined
  /** Immutable nested declarations and ordered child rules. */
  readonly style: NamedStyle
}

/** A source span optionally attached to a diagnostic by a caller. */
export type SourceLocation = {
  /** Exclusive source offset. */
  readonly end: number
  /** Path from the style map root to the associated input. */
  readonly path: readonly string[]
  /** Caller-owned source identifier, independent of filesystem paths. */
  readonly source: string
  /** Inclusive source offset. */
  readonly start: number
}

/** Core definitions exclude compiler-owned web relationship keys. */
type WithoutRelationships<value> = value extends readonly unknown[]
  ? unknown
  : value extends object
    ? {
        [key in keyof value]: key extends symbol | 'selectors' | 'vars'
          ? never
          : key extends keyof Literal.Properties
            ? unknown
            : WithoutRelationships<value[key]>
      }
    : unknown
