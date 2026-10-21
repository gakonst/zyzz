/**
 * Normalizes explicit configuration into isolated typed authoring contracts.
 * @module
 */
import * as Appearance from '../runtime/Appearance.js'
import * as Authoring from './Authoring.js'
import * as Html from '../runtime/CompositionHtml.js'
import * as Identity from './Identity.js'
import type * as Binding from './Binding.js'
import type * as Condition from './Condition.js'
import * as Literal from './Literal.js'
import type { style } from '../styleFunction.js'
import { variants } from '../variants.js'
import * as Scheme from './Scheme.js'
import * as Shorthands from './Shorthands.js'
import type * as Style from '../Style.js'
import * as Theme from './Theme.js'
import * as VariableSets from './VariableSets.js'
import * as Vars from '../Vars.js'
import * as Selection from '../runtime/Selection.js'
import * as Token from './Token.js'
import type * as Value from './Value.js'
import type * as Completion from './Completion.js'

/** Creates token-free authoring without a configuration file or global state. */
export function create(): create.ReturnType<{}>
/**
 * Binds inline or reusable themes to an isolated configuration contract.
 * Named themes require an explicit default and identical token paths/domains.
 * Bound helpers reference extracted CSS; this factory emits no CSS rules.
 * @throws {InvalidError} If options, themes, defaults, or layer names are invalid.
 */
export function create<const options extends create.Options | VariableOptions>(
  options: options &
    NoInfer<
      options extends VariableOptions
        ? VariableValidation<options>
        : Validated<options>
    >,
): options extends VariableOptions
  ? VariableConfig<options>
  : options extends create.Options
    ? create.ReturnType<options>
    : never
export function create(
  options: create.Options | VariableOptions = {},
): unknown {
  let input = record(options)
  const variableMode = input.vars !== undefined
  const variableCatalog = variableMode && input.defaultVars !== undefined
  const variableMappings = VariableSets.mappings(input.mappings)
  if (variableMode) {
    if (
      input.theme !== undefined ||
      input.themes !== undefined ||
      input.defaultTheme !== undefined
    )
      throw new InvalidError('Use vars without theme options.')
    const normalize = (value: unknown) => {
      const definition =
        value &&
        (typeof value === 'object' || typeof value === 'function') &&
        Object.getOwnPropertyDescriptor(value, Token.definition)?.value
          ? (value as Vars.Definition)
          : Vars.define(value as Vars.Values)
      const theme = VariableSets.theme(definition, variableMappings)
      // Tokens are ambiguous only through an explicit mapping, so skip the property scan without one.
      if (!variableMappings) return theme
      const metadata = theme[Token.definition]
      const names = new Map<string, string>()
      for (const path of Object.keys(metadata.values)) {
        const [category, ...parts] = path.split('.')
        const targets =
          variableMappings?.[category!] ??
          Object.keys(Literal.rules).filter((property) =>
            Token.accepts(
              category as Token.Group,
              property as keyof Literal.Properties,
            ),
          )
        for (const property of targets) {
          const key = `${property}:${parts.join('.')}`
          if (
            names.has(key) &&
            (variableMappings?.[category!] ||
              variableMappings?.[names.get(key)!.split('.')[0]!])
          )
            throw new InvalidError(
              `Ambiguous variable token ${parts.join('.')} for ${property}.`,
            )
          names.set(key, path)
        }
      }
      return theme
    }
    const { vars, defaultVars, mappings: _mappings, ...rest } = input
    input = variableCatalog
      ? {
          ...rest,
          defaultTheme: defaultVars,
          themes: Object.fromEntries(
            Object.entries(record(vars)).map(([name, value]) => [
              name,
              normalize(value),
            ]),
          ),
        }
      : { ...rest, theme: normalize(vars) }
  } else if (input.mappings !== undefined || input.defaultVars !== undefined) {
    throw new InvalidError('mappings and defaultVars require vars.')
  }
  function finish(result: Record<string, unknown>) {
    if (!variableMode) return Object.freeze(result)
    const theme = result.theme as Theme.Definition
    const catalog = result.themes as
      | Record<string, Theme.Definition>
      | undefined
    const entries = () =>
      catalog
        ? Object.entries(catalog).map(
            ([name, value]) => [name, value.className] as const,
          )
        : [['default', theme.className] as const]
    let select: ReturnType<typeof Selection.create> | undefined
    const vars = (
      options: {
        set?: string | undefined
        colorScheme?: string | undefined
      } = {},
    ) =>
      (select ??= Selection.create(
        entries(),
        input.output === 'html',
        'set',
        variableCatalog ? String(input.defaultTheme) : 'default',
      ))(options)
    return Object.freeze({
      appearance: result.appearance,
      script: result.script,
      style: result.style,
      // The default set's metadata lets Vars.extend grow configured vars.
      vars: Object.freeze(
        Object.defineProperties(vars, {
          ...Object.getOwnPropertyDescriptors(theme.tokens),
          [Token.definition]: { value: theme[Token.definition] },
        }),
      ),
      variants: result.variants,
    })
  }

  for (const key of Object.keys(input))
    if (
      ![
        'composition',
        'cssOutput',
        'id',
        'defaultLayer',
        'defaultTheme',
        'layers',
        'output',
        'shorthands',
        'storageKey',
        'theme',
        'themes',
      ].includes(key)
    )
      throw new InvalidError(`Unknown configuration option: ${key}`)

  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id))
    throw new InvalidError('id must be a nonempty string.')

  if (
    input.storageKey !== undefined &&
    (typeof input.storageKey !== 'string' || !input.storageKey)
  )
    throw new InvalidError('storageKey must be a nonempty string.')

  // Validated above; the record type erases the literal narrowing.
  const storageKey = input.storageKey as string | undefined

  if (
    input.output !== undefined &&
    input.output !== 'html' &&
    input.output !== 'react'
  )
    throw new InvalidError('output must be html or react.')

  if (
    input.cssOutput !== undefined &&
    input.cssOutput !== 'atomic' &&
    input.cssOutput !== 'grouped'
  )
    throw new InvalidError('cssOutput must be atomic or grouped.')

  if (
    input.composition !== undefined &&
    input.composition !== 'independent' &&
    input.composition !== 'ordered'
  )
    throw new InvalidError('composition must be independent or ordered.')

  if (input.theme !== undefined && input.themes !== undefined)
    throw new InvalidError('Use either theme or themes, not both.')

  if (
    input.defaultLayer !== undefined &&
    typeof input.defaultLayer !== 'string'
  )
    throw new InvalidError('defaultLayer must be a CSS layer name.')

  if (input.layers !== undefined || input.defaultLayer !== undefined) {
    if (input.layers !== undefined && !Array.isArray(input.layers))
      throw new InvalidError('layers must be an array.')

    const layers = (input.layers ?? []) as readonly unknown[]
    const seen = new Set<string>()

    for (const layer of [
      ...layers,
      ...(input.defaultLayer === undefined ||
      layers.includes(input.defaultLayer)
        ? []
        : [input.defaultLayer]),
    ]) {
      if (
        typeof layer !== 'string' ||
        !/^(?:--|-?[_a-zA-Z])[\w-]*(?:\.(?:--|-?[_a-zA-Z])[\w-]*)*$/.test(
          layer,
        ) ||
        layer
          .split('.')
          .some((part) =>
            [
              'default',
              'inherit',
              'initial',
              'revert',
              'revert-layer',
              'unset',
            ].includes(part.toLowerCase()),
          )
      )
        throw new InvalidError(
          'Layer names must be plain CSS identifiers, optionally dotted.',
        )

      if (seen.has(layer)) throw new InvalidError(`Duplicate layer: ${layer}`)

      seen.add(layer)
    }
  }

  const shorthands = (() => {
    if (input.shorthands === undefined) return undefined

    try {
      return Shorthands.read(input.shorthands)
    } catch (error) {
      throw new InvalidError((error as Error).message)
    }
  })()

  const contract = Object.freeze({
    ...(variableMode ? { variableSet: true, mappings: variableMappings } : {}),
    ...(input.composition !== undefined
      ? { composition: input.composition as 'independent' | 'ordered' }
      : {}),
    ...(input.defaultLayer !== undefined
      ? { defaultLayer: input.defaultLayer as string }
      : {}),
    cssOutput:
      (input.cssOutput as 'atomic' | 'grouped' | undefined) ?? 'atomic',
    ...(shorthands ? { shorthands } : {}),
    ...(typeof input.id === 'string'
      ? {
          [Token.identity]: Identity.requireId(input.id, 'Config.create'),
          [Token.complete]: true,
        }
      : {}),
  })
  function boundStyle(theme?: Theme.Definition) {
    return (styles?: unknown, options: style.DefinitionOptions = {}) => {
      if (
        theme &&
        Object.keys(theme[Token.definition].values).length &&
        !contract[Token.identity]
      )
        Identity.requireId(undefined, 'Config.create')
      return Authoring.create(styles, {
        ...options,
        theme,
        output: input.output as style.Output | undefined,
      })
    }
  }
  function boundVariants(theme?: Theme.Definition) {
    return (
      definition: Record<string, unknown>,
      options: style.DefinitionOptions = {},
    ) =>
      Authoring.variants(definition, {
        ...options,
        output: input.output as style.Output | undefined,
        theme,
      })
  }
  function handle(theme: Theme.Definition, name: string) {
    const original = Token.bind(theme, contract)
    const className = () =>
      `z-theme-${Identity.requireId(typeof input.id === 'string' ? input.id : undefined, 'Config.create').slice(3)}-${Identity.name(name)}`
    const select = (options: { colorScheme?: string } = {}) => {
      const scheme = options.colorScheme
      const selection =
        scheme !== undefined && Object.hasOwn(Scheme.classes, scheme)
          ? ` ${Scheme.classes[scheme as Scheme.Name]}`
          : ''
      const result = {
        className: `${className()}${selection}`,
        ...(scheme ? { style: { colorScheme: scheme } } : {}),
      }
      return input.output === 'html' ? Html.from(result) : result
    }
    const descriptors = Object.getOwnPropertyDescriptors(original)
    delete (descriptors as Record<string, unknown>).className
    delete (descriptors as Record<string, unknown>).style
    delete (descriptors as Record<string, unknown>).variants
    Object.defineProperties(select, descriptors)
    Object.defineProperty(select, 'className', {
      get: className,
      configurable: true,
    })
    Object.assign(select, {
      style: boundStyle(original),
      variants: boundVariants(original),
    })
    return select
  }

  if (input.themes !== undefined) {
    const catalog = record(input.themes)
    if (
      typeof input.defaultTheme !== 'string' ||
      !Object.hasOwn(catalog, input.defaultTheme)
    )
      throw new InvalidError('defaultTheme must name a theme in the catalog.')

    const defaultTheme = input.defaultTheme
    const definitions = Object.fromEntries(
      Object.entries(catalog).map(([name, value]) => {
        if (!name) throw new InvalidError('Theme names must be nonempty.')

        return [name, definition(value)]
      }),
    )

    const base = definitions[input.defaultTheme]!
    const paths = Object.keys(base[Token.definition].values).sort()

    function queries(theme: Theme.Definition) {
      const data = theme[Token.definition].queries

      return JSON.stringify({
        breakpoint: Object.keys(data?.breakpoint ?? {}).sort(),
        container: Object.keys(data?.container ?? {}).sort(),
        containerNames: [...(data?.containerNames ?? [])].sort(),
      })
    }

    for (const [name, value] of Object.entries(definitions)) {
      const candidate = Object.keys(value[Token.definition].values).sort()
      if (
        queries(base) !== queries(value) ||
        paths.length !== candidate.length ||
        paths.some(
          (path, index) =>
            path !== candidate[index] ||
            (variableMode &&
              VariableSets.domain(base[Token.definition].values[path]!) !==
                VariableSets.domain(value[Token.definition].values[path]!)),
        )
      )
        throw new InvalidError(
          `Theme ${JSON.stringify(name)} must have the default theme's complete token paths and domains.`,
        )
    }

    const bound = Object.fromEntries(
      Object.entries(definitions).map(([name, value]) => [
        name,
        handle(value, name),
      ]),
    )

    const select = (options: { theme: string; colorScheme?: string }) =>
      (bound[options.theme] as (options: { colorScheme?: string }) => unknown)(
        options,
      )

    Object.defineProperties(select, Object.getOwnPropertyDescriptors(bound))

    const entries = () =>
      Object.entries(bound).map(([name, value]): readonly [string, string] => [
        name,
        (value as unknown as Theme.Definition).className,
      ])

    // Class names require an identity, so the compiler's collection pass must
    // not read them; root controls resolve their entries on first use.
    const appearance = ((): Appearance.Root<string> => {
      let root: Appearance.Root<string> | undefined
      const resolve = () =>
        (root ??= Appearance.root(entries(), {
          defaultVars: defaultTheme,
          storageKey,
        }))

      return {
        get: () => resolve().get(),
        set: (selection) => resolve().set(selection),
      }
    })()

    return finish({
      appearance,
      script: () => Appearance.create(entries(), { storageKey })(),
      style: boundStyle(
        bound[input.defaultTheme] as unknown as Theme.Definition,
      ),
      theme: bound[input.defaultTheme],
      themes: Object.freeze(select),
      variants: boundVariants(
        bound[input.defaultTheme] as unknown as Theme.Definition,
      ),
    })
  }

  if (input.defaultTheme !== undefined)
    throw new InvalidError('defaultTheme requires a named themes catalog.')

  if (input.theme !== undefined) {
    const theme = handle(definition(input.theme), 'theme')
    return finish({
      appearance: Appearance.root([], { storageKey }),
      script: Appearance.create([], { storageKey }),
      style: boundStyle(theme as unknown as Theme.Definition),
      theme,
      variants: boundVariants(theme as unknown as Theme.Definition),
    })
  }

  const theme =
    shorthands || input.defaultLayer !== undefined || input.id !== undefined
      ? Token.bind(Theme.define({}), contract)
      : undefined
  return finish({
    appearance: Appearance.root([], { storageKey }),
    script: Appearance.create([], { storageKey }),
    style: boundStyle(theme),
    variants: boundVariants(theme),
  })
}

/** Configuration inputs and inferred results. */
export declare namespace create {
  /** Optional layer names and mutually exclusive theme modes. */
  type Options = {
    /**
     * Whether bound styles' class lists may combine. Independent atomic styles
     * share rules for repeated declarations, so combine them only with `cx`.
     */
    readonly composition?: 'independent' | 'ordered' | undefined
    /** CSS representation inherited by bound helpers; atomic by default. */
    readonly cssOutput?: 'atomic' | 'grouped' | undefined
    /** Fallback CSS layer for bound styles and variants; unlayered when omitted. */
    readonly defaultLayer?: string | undefined
    /** Consumer-owned namespace; required for uncompiled variable configs. */
    readonly id?: string | undefined
    /** Explicit ordered property aliases; none are installed by default. */
    readonly shorthands?: Shorthands.Map | undefined
    /** Renderer props format; React is the default. */
    readonly output?: style.Output | undefined
    /** Ordered plain or dotted CSS layer names; emission follows source integration. */
    readonly layers?: readonly string[] | undefined
    /** localStorage key shared by `script()` and `appearance`; zyzz by default. */
    readonly storageKey?: string | undefined
  } & (
    | {
        /** Single inline or reusable theme. */ readonly theme: Input
        /** Named mode is excluded. */ readonly themes?: never
        /** Only named catalogs use defaults. */ readonly defaultTheme?: never
      }
    | {
        /** Explicit catalog key. */ readonly defaultTheme: string
        /** Single mode is excluded. */ readonly theme?: never
        /** Complete named theme alternatives. */ readonly themes: Readonly<
          Record<string, Input>
        >
      }
    | {
        /** Only named catalogs use defaults. */ readonly defaultTheme?: never
        /** Omit themes for token-free authoring. */ readonly theme?: never
        /** Omit themes for token-free authoring. */ readonly themes?: never
      }
  )

  /** Bound authoring and the handles corresponding to the selected theme mode. */
  type ReturnType<options extends Options = Options> = {
    /** Reads and persists the root theme and scheme selection on the document element. */
    readonly appearance: Appearance.Root<
      options extends { themes: infer catalog } ? keyof catalog & string : never
    >
    /** Generates synchronous HTML-safe root preference restoration. */
    readonly script: () => string
    /** Inferred callable authoring; execution requires a source transform. */
    readonly style: StyleFactory<
      Tokens<options>,
      options extends { layers: readonly (infer name extends string)[] }
        ? name
        : never,
      options extends { output: infer output extends style.Output }
        ? output
        : 'react',
      Mappings<options>
    >
    /** Theme-, layer-, and mapping-aware recipe authoring. */
    readonly variants: variants.Bound<
      Tokens<options>,
      options extends { output: infer output extends style.Output }
        ? output
        : 'react',
      options extends { layers: readonly (infer name extends string)[] }
        ? name
        : never,
      Mappings<options>
    >
  } & (options extends { theme: infer input }
    ? {
        /** Isolated single-theme contract. */ readonly theme: Handle<
          ExtractTokens<input>,
          Mappings<options>,
          options extends { output: infer output extends style.Output }
            ? output
            : 'react'
        >
      }
    : options extends { themes: infer catalog }
      ? {
          /** Shared default token and variable contract. */ readonly theme: Handle<
            Tokens<options>,
            Mappings<options>,
            options extends { output: infer output extends style.Output }
              ? output
              : 'react'
          >
          /** Selects a compiled named scope; catalog members retain compatibility. */ readonly themes: (<
            const selection extends {
              readonly colorScheme?: 'dark' | 'light' | 'light dark' | undefined
              readonly theme: keyof catalog & string
            },
          >(
            options: selection &
              Record<Exclude<keyof selection, 'theme' | 'colorScheme'>, never>,
          ) => style.Props<
            options extends { output: infer output extends style.Output }
              ? output
              : 'react'
          >) & {
            readonly [name in keyof catalog]: Handle<
              ExtractTokens<catalog[name]>,
              Mappings<options>,
              options extends { output: infer output extends style.Output }
                ? output
                : 'react'
            >
          }
        }
      : {})
}

type Mappings<options> = options extends {
  shorthands: infer map extends Shorthands.Map
}
  ? string extends keyof map
    ? {}
    : map
  : {}

/** Theme handle retaining configured shorthands and renderer output in emitted declarations. */
export type Handle<
  tokens extends Theme.Tokens,
  mappings extends Shorthands.Map,
  output extends style.Output,
> = Omit<Theme.Definition<tokens>, 'style' | 'variants'> & {
  /** Style factory bound to this handle. */
  readonly style: StyleFactory<tokens, never, output, mappings>
  /** Variant factory bound to this handle. */
  readonly variants: variants.Bound<tokens, output, never, mappings>
}

/** Configured style factory with a portable name for library declaration emission. */
export type StyleFactory<
  tokens extends Theme.Tokens,
  layers extends string,
  output extends style.Output,
  mappings extends Shorthands.Map,
> = {
  (): style.ReturnType<output>
  <
    const values extends Record<string, string | number>,
    const styles extends Record<string, unknown>,
    const callback extends (...args: never[]) => unknown,
  >(
    styles: callback &
      ((
        values: values,
      ) => styles &
        NoInfer<
          Body<styles, tokens, layers, mappings> &
            Binding.Checked<styles> &
            Binding.TokenSlots<styles, values, tokens, mappings>
        >) &
      Completion.Properties<tokens, NoInfer<styles>>,
    ...options: Parameters<callback> extends [Record<string, string | number>]
      ? values extends Binding.Inputs<values>
        ? [options?: style.DefinitionOptions]
        : [invalid: never, unavailable: never]
      : [invalid: never, unavailable: never]
    // TypeScript types a call that matches no overload with this signature. Other
    // inputs leave `callback` at its constraint, so their definitions stay static.
  ): ((...args: never[]) => unknown) extends callback
    ? style.ReturnType<output>
    : style.Dynamic<values, output>
  <const styles extends Record<string, unknown>>(
    styles: styles &
      NoInfer<Body<styles, tokens, layers, mappings>> &
      Completion.Properties<tokens>,
    options?: style.DefinitionOptions,
  ): style.ReturnType<output>
  <const entries>(
    styles: entries & Entries<entries, tokens, layers, mappings>,
    ...options: entries extends readonly unknown[]
      ? [options?: style.DefinitionOptions]
      : [invalid: never, unavailable: never]
  ): style.ReturnType<output>
}

// Composition entries are static definitions or checked literal objects.
type Entries<
  entries,
  tokens extends Theme.Tokens,
  layers extends string,
  mappings extends Shorthands.Map,
> = {
  readonly [index in keyof entries]: Entry<
    entries[index],
    tokens,
    layers,
    mappings
  >
}

// Distributes over mixed element unions so each member keeps its own contract.
type Entry<
  entry,
  tokens extends Theme.Tokens,
  layers extends string,
  mappings extends Shorthands.Map,
> = entry extends (...args: never) => unknown
  ? style.Composable<entry>
  : entry &
      NoInfer<Body<entry, tokens, layers, mappings>> &
      Completion.Properties<tokens>

type Keys<styles> = styles extends unknown ? keyof styles : never

/**
 * Returns `key` when it names a condition or an allowed `@layer` block, otherwise `never`.
 * Testing the key against the cached `Condition.Static` union avoids building a union per key.
 */
export type Nested<
  tokens extends Theme.Tokens,
  key extends PropertyKey,
  layers extends string,
> = key extends `@layer${string}`
  ? key extends '@layer' | `@layer ${layers}`
    ? key
    : key extends Exclude<Condition.Static<tokens>, `@layer${string}`>
      ? key
      : never
  : key extends Condition.Static<tokens>
    ? key
    : key extends Condition.Dynamic<key>
      ? key
      : never

// The conditional caches this union per configuration. `Body` runs for every style, and the
// union holds every property name.
type Reserved<
  tokens extends Theme.Tokens,
  layers extends string,
  mappings extends Shorthands.Map,
> = [tokens, layers, mappings] extends [unknown, unknown, unknown]
  ?
      | keyof mappings
      | 'selectors'
      | 'targets'
      | 'typography'
      | 'vars'
      | keyof Style.DeclarationProperties
      | Exclude<Condition.Static<tokens>, `@layer${string}`>
      | '@layer'
      | `@layer ${layers}`
  : never

/** Checked declaration body shared by configured styles and recipe choices. */
export type Body<
  styles,
  tokens extends Theme.Tokens,
  layers extends string,
  mappings extends Shorthands.Map,
  targets extends boolean = true,
> = Record<
  Exclude<
    Exclude<Keys<styles>, Reserved<tokens, layers, mappings>>,
    Exclude<Condition.Dynamic<Keys<styles>>, `@layer${string}`>
  >,
  never
> &
  (styles extends unknown
    ? {
        [key in keyof styles]: key extends 'targets'
          ? targets extends false
            ? never
            : styles[key] extends undefined
              ? undefined
              : {
                  [target in keyof styles[key]]: target extends 'web'
                    ?
                        | Body<
                            NonNullable<styles[key][target]>,
                            tokens,
                            layers,
                            mappings,
                            false
                          >
                        | Extract<styles[key][target], undefined>
                    : Style.Accepted<
                        { targets: Pick<styles[key], target> },
                        tokens
                      >['targets'][target]
                }
          : key extends 'selectors'
            ? styles[key] extends Record<string, unknown>
              ? {
                  [selector in keyof styles[key]]: styles[key][selector] extends Record<
                    string,
                    unknown
                  >
                    ? Body<
                        styles[key][selector],
                        tokens,
                        layers,
                        mappings,
                        targets
                      >
                    : never
                }
              : never
            : key extends Nested<tokens, key, layers>
              ? styles[key] extends Record<string, unknown>
                ? Body<styles[key], tokens, layers, mappings, targets>
                : never
              : key extends keyof mappings
                ? {
                    [target in mappings[key][number]]: styles[key] extends Style.Accepted<
                      Record<target, styles[key]>,
                      tokens
                    >[target] &
                      Binding.Checked<Record<target, styles[key]>>[target]
                      ? never
                      : target
                  }[mappings[key][number]] extends never
                  ? styles[key]
                  : [Token.Names<tokens, mappings[key][number]>] extends [never]
                    ? never
                    : Value.Mismatch<tokens, mappings[key][number]>
                : Style.Accepted<Pick<styles, key>, tokens>[key]
      }
    : never)

function definition(value: unknown): Theme.Definition {
  try {
    if (
      value &&
      typeof value === 'object' &&
      Object.getOwnPropertyDescriptor(value, Token.definition)?.value
    )
      return value as Theme.Definition

    return Theme.define(record(value) as Theme.Tokens)
  } catch (error) {
    if (error instanceof InvalidError) throw error

    throw new InvalidError((error as Error).message)
  }
}

type ExtractTokens<input> =
  input extends Theme.Definition<infer tokens>
    ? tokens
    : input extends Theme.Tokens
      ? input
      : never

type Input = Theme.Definition | Theme.Tokens

/** Invalid options or incompatible named themes. */
export class InvalidError extends Error {
  /** Creates a configuration diagnostic without generating styles. */
  constructor(message: string) {
    super(message)
  }
  /** Stable namespaced error identifier. */
  override name = 'Config.InvalidError'
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw new InvalidError('Expected a plain configuration record.')

  const result: Record<string, unknown> = Object.create(null)

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!('value' in descriptor))
      throw new InvalidError('Configuration records cannot contain accessors.')

    result[key] = descriptor.value
  }

  return result
}

type Tokens<options> = options extends { theme: infer input }
  ? ExtractTokens<input>
  : options extends { themes: infer catalog; defaultTheme: infer key }
    ? key extends keyof catalog
      ? ExtractTokens<catalog[key]>
      : never
    : {}

type ValidInput<input> = input extends Theme.Definition
  ? input
  : input extends Theme.Tokens
    ? Parameters<typeof Theme.define<input>>[0]
    : never

type Match<input, base> = base extends
  | string
  | number
  | { light: string; dark: string }
  ? input
  : {
      [key in keyof input | keyof base]: key extends keyof input
        ? key extends keyof base
          ? key extends 'containerNames'
            ? input[key] extends readonly string[]
              ? base[key] extends readonly string[]
                ?
                    | Exclude<input[key][number], base[key][number]>
                    | Exclude<
                        base[key][number],
                        input[key][number]
                      > extends never
                  ? input[key]
                  : never
                : never
              : never
            : Match<input[key], base[key]>
          : never
        : never
    }

type Validated<options> = Record<
  Exclude<keyof options, keyof create.Options>,
  never
> &
  (options extends { shorthands: infer mappings extends Shorthands.Map }
    ? { shorthands: Shorthands.Validated<mappings> }
    : {}) &
  (options extends { theme: infer input }
    ? { theme: ValidInput<input> }
    : options extends { themes: infer catalog; defaultTheme: infer key }
      ? {
          defaultTheme: keyof catalog
          themes: {
            [name in keyof catalog]: ValidInput<catalog[name]> &
              (key extends keyof catalog
                ? catalog[name] extends Theme.Definition
                  ? Theme.Definition<
                      ExtractTokens<catalog[name]> &
                        Match<
                          ExtractTokens<catalog[name]>,
                          ExtractTokens<catalog[key]>
                        >
                    >
                  : Match<
                      ExtractTokens<catalog[name]>,
                      ExtractTokens<catalog[key]>
                    >
                : never)
          }
        }
      : {})

/** Vars, optional named alternatives, and category-to-property mappings. */
export type VariableOptions = {
  /**
   * Whether bound styles' class lists may combine. Independent atomic styles
   * share rules for repeated declarations, so combine them only with `cx`.
   */
  readonly composition?: 'independent' | 'ordered' | undefined
  /** CSS representation inherited by bound helpers; atomic by default. */
  readonly cssOutput?: 'atomic' | 'grouped' | undefined
  /** Fallback CSS layer for bound styles and variants; unlayered when omitted. */
  readonly defaultLayer?: string | undefined
  /** Required default key when vars contains named sets. */
  readonly defaultVars?: string | undefined
  /** Consumer-owned namespace; required for uncompiled variable configs. */
  readonly id?: string | undefined
  /** Ordered CSS layer names. */
  readonly layers?: readonly string[] | undefined
  /** Category mappings; false enables full paths in every compatible property. */
  readonly mappings?: Vars.Mappings | false | undefined
  /** Styling props format; React by default. */
  readonly output?: style.Output | undefined
  /** Explicit local property aliases. */
  readonly shorthands?: Shorthands.Map | undefined
  /** Preference storage key; zyzz by default. */
  readonly storageKey?: string | undefined
  /** One inline or reusable set, or a catalog with defaultVars. */
  readonly vars:
    | Vars.Values
    | Vars.Definition
    | Readonly<Record<string, Vars.Definition | Vars.Values>>
}

type VariableValues<options extends VariableOptions> = options extends {
  defaultVars: infer key
}
  ? key extends keyof options['vars']
    ? Vars.Extract<options['vars'][key]>
    : never
  : Vars.Extract<options['vars']>

type VariableTokens<options extends VariableOptions> = Vars.Mapped<
  VariableValues<options>,
  options extends { mappings: infer mappings } ? mappings : {}
>

type VariableInput<input> = input extends {
  readonly [Token.definition]: Token.Metadata
}
  ? input
  : input extends Vars.Values
    ? Parameters<typeof Vars.define<input>>[0]
    : never

type VariableMatch<input, base> = base extends readonly string[]
  ? input extends readonly string[]
    ?
        | Exclude<input[number], base[number]>
        | Exclude<base[number], input[number]> extends never
      ? input
      : never
    : never
  : base extends Vars.Value
    ? input extends Vars.Value
      ? Vars.Domain<Vars.Scalar<input>> extends Vars.Domain<Vars.Scalar<base>>
        ? input
        : never
      : never
    : {
        readonly [key in keyof input | keyof base]: key extends keyof base
          ? key extends keyof input
            ? VariableMatch<input[key], base[key]>
            : never
          : never
      }

export type VariableValidation<options extends VariableOptions> =
  VariableOptions extends options
    ? unknown
    : Record<Exclude<keyof options, keyof VariableOptions>, never> &
        (options extends { shorthands: infer map extends Shorthands.Map }
          ? { shorthands: Shorthands.Validated<map> }
          : {}) &
        (options extends { defaultVars: infer selected }
          ? {
              readonly defaultVars: keyof options['vars']
              readonly vars: {
                readonly [key in keyof options['vars']]: VariableInput<
                  options['vars'][key]
                > &
                  (selected extends keyof options['vars']
                    ? Vars.Extract<options['vars'][key]> extends VariableMatch<
                        Vars.Extract<options['vars'][key]>,
                        Vars.Extract<options['vars'][selected]>
                      >
                      ? unknown
                      : never
                    : never)
              }
            }
          : { readonly vars: VariableInput<options['vars']> })

/** Configured authoring, portable references, and scoped set selection. */
export type VariableConfig<options extends VariableOptions> = {
  /** Reads and persists the root set and color scheme. */
  readonly appearance: Appearance.Root<
    options extends { defaultVars: unknown }
      ? keyof options['vars'] & string
      : never
  >
  /** Generates the root preference restoration script. */
  readonly script: () => string
  /** Authors styles with configured tokens and property aliases. */
  readonly style: StyleFactory<
    VariableTokens<options>,
    options extends { layers: readonly (infer layer extends string)[] }
      ? layer
      : never,
    options extends { output: infer output extends style.Output }
      ? output
      : 'react',
    Mappings<options>
  >
  /** Authors recipes with the same variable and mapping contract. */
  readonly variants: variants.Bound<
    VariableTokens<options>,
    options extends { output: infer output extends style.Output }
      ? output
      : 'react',
    options extends { layers: readonly (infer layer extends string)[] }
      ? layer
      : never,
    Mappings<options>
  >
  /** Explicit portable references, independent of shorthand mappings. */
  /** Applies a named or default set and optional color scheme to a scope. */
  readonly vars: VariableScope<options>
}

/** References and scoped selection inferred from a configuration. */
export type VariableScope<options extends VariableOptions> = Vars.Bound<
  VariableValues<options> extends Vars.Values ? VariableValues<options> : {},
  options extends { defaultVars: unknown }
    ? keyof options['vars'] & string
    : never,
  options extends { output: infer output extends style.Output }
    ? output
    : 'react'
>
