/**
 * Carries portable theme references and enforces their property domains.
 * @module
 */
import * as Binding from './Binding.js'
import type * as Query from './Query.js'
import type * as Shorthands from './Shorthands.js'
import type * as Theme from './Theme.js'
import type * as ValueSyntax from './Value.js'
import type * as VariableSets from '../Vars.js'
import * as Literal from './Literal.js'
import * as VariableData from './VariableSets.js'

/** Ordered category fallbacks shared by runtime lookup and inferred token names. */
export const propertyGroups = {
  accentColor: ['accentColor', 'color'],
  animation: ['animate'],
  aspectRatio: ['aspect'],
  backgroundColor: ['backgroundColor', 'color'],
  backgroundImage: ['backgroundImage'],
  backgroundPosition: ['backgroundPosition'],
  backgroundSize: ['backgroundSize'],
  blockSize: ['spacing'],
  borderBlockColor: ['borderColor', 'color'],
  borderBlockEndColor: ['borderColor', 'color'],
  borderBlockEndWidth: ['borderWidth'],
  borderBlockStartColor: ['borderColor', 'color'],
  borderBlockStartWidth: ['borderWidth'],
  borderBlockWidth: ['borderWidth'],
  borderBottomColor: ['borderColor', 'color'],
  borderBottomLeftRadius: ['radius'],
  borderBottomRightRadius: ['radius'],
  borderBottomWidth: ['borderWidth'],
  borderColor: ['borderColor', 'color'],
  borderEndEndRadius: ['radius'],
  borderEndStartRadius: ['radius'],
  borderInlineColor: ['borderColor', 'color'],
  borderInlineEndColor: ['borderColor', 'color'],
  borderInlineEndWidth: ['borderWidth'],
  borderInlineStartColor: ['borderColor', 'color'],
  borderInlineStartWidth: ['borderWidth'],
  borderInlineWidth: ['borderWidth'],
  borderLeftColor: ['borderColor', 'color'],
  borderLeftWidth: ['borderWidth'],
  borderRadius: ['radius'],
  borderRightColor: ['borderColor', 'color'],
  borderRightWidth: ['borderWidth'],
  borderSpacing: ['borderSpacing', 'spacing'],
  borderStartEndRadius: ['radius'],
  borderStartStartRadius: ['radius'],
  borderTopColor: ['borderColor', 'color'],
  borderTopLeftRadius: ['radius'],
  borderTopRightRadius: ['radius'],
  borderTopWidth: ['borderWidth'],
  borderWidth: ['borderWidth'],
  bottom: ['inset', 'spacing'],
  boxShadow: ['shadow'],
  caretColor: ['caretColor', 'color'],
  color: ['textColor', 'color'],
  columnGap: ['gap', 'spacing'],
  columnRuleColor: ['color'],
  columns: ['columns', 'container'],
  content: ['content'],
  cursor: ['cursor'],
  fill: ['fill', 'color'],
  flexBasis: ['flexBasis', 'spacing', 'container'],
  floodColor: ['color'],
  fontFamily: ['fontFamily'],
  fontSize: ['fontSize'],
  fontWeight: ['fontWeight'],
  gap: ['gap', 'spacing'],
  gridAutoColumns: ['gridAutoColumns'],
  gridAutoRows: ['gridAutoRows'],
  gridColumn: ['gridColumn'],
  gridColumnEnd: ['gridColumnEnd'],
  gridColumnStart: ['gridColumnStart'],
  gridRow: ['gridRow'],
  gridRowEnd: ['gridRowEnd'],
  gridRowStart: ['gridRowStart'],
  gridTemplateColumns: ['gridTemplateColumns'],
  gridTemplateRows: ['gridTemplateRows'],
  height: ['height', 'spacing'],
  inlineSize: ['spacing', 'container'],
  inset: ['inset', 'spacing'],
  insetBlock: ['inset', 'spacing'],
  insetBlockEnd: ['inset', 'spacing'],
  insetBlockStart: ['inset', 'spacing'],
  insetInline: ['inset', 'spacing'],
  insetInlineEnd: ['inset', 'spacing'],
  insetInlineStart: ['inset', 'spacing'],
  left: ['inset', 'spacing'],
  letterSpacing: ['letterSpacing'],
  lightingColor: ['color'],
  lineClamp: ['lineClamp'],
  lineHeight: ['lineHeight'],
  listStyleImage: ['listStyleImage'],
  listStyleType: ['listStyleType'],
  margin: ['margin', 'spacing'],
  marginBlock: ['margin', 'spacing'],
  marginBlockEnd: ['margin', 'spacing'],
  marginBlockStart: ['margin', 'spacing'],
  marginBottom: ['margin', 'spacing'],
  marginInline: ['margin', 'spacing'],
  marginInlineEnd: ['margin', 'spacing'],
  marginInlineStart: ['margin', 'spacing'],
  marginLeft: ['margin', 'spacing'],
  marginRight: ['margin', 'spacing'],
  marginTop: ['margin', 'spacing'],
  maxBlockSize: ['spacing'],
  maxHeight: ['maxHeight', 'height', 'spacing'],
  maxInlineSize: ['spacing', 'container'],
  maxWidth: ['maxWidth', 'spacing', 'container'],
  minBlockSize: ['spacing'],
  minHeight: ['minHeight', 'height', 'spacing'],
  minInlineSize: ['spacing', 'container'],
  minWidth: ['minWidth', 'spacing', 'container'],
  MsScrollbar3dlightColor: ['color'],
  MsScrollbarArrowColor: ['color'],
  MsScrollbarBaseColor: ['color'],
  MsScrollbarDarkshadowColor: ['color'],
  MsScrollbarFaceColor: ['color'],
  MsScrollbarHighlightColor: ['color'],
  MsScrollbarShadowColor: ['color'],
  MsScrollbarTrackColor: ['color'],
  objectPosition: ['objectPosition'],
  opacity: ['opacity'],
  order: ['order'],
  outlineColor: ['outlineColor', 'color'],
  outlineOffset: ['outlineOffset'],
  outlineWidth: ['outlineWidth'],
  padding: ['padding', 'spacing'],
  paddingBlock: ['padding', 'spacing'],
  paddingBlockEnd: ['padding', 'spacing'],
  paddingBlockStart: ['padding', 'spacing'],
  paddingBottom: ['padding', 'spacing'],
  paddingInline: ['padding', 'spacing'],
  paddingInlineEnd: ['padding', 'spacing'],
  paddingInlineStart: ['padding', 'spacing'],
  paddingLeft: ['padding', 'spacing'],
  paddingRight: ['padding', 'spacing'],
  paddingTop: ['padding', 'spacing'],
  perspective: ['perspective'],
  perspectiveOrigin: ['perspectiveOrigin'],
  right: ['inset', 'spacing'],
  rotate: ['rotate'],
  rowGap: ['gap', 'spacing'],
  scale: ['scale'],
  scrollMargin: ['scrollMargin', 'spacing'],
  scrollMarginBlock: ['scrollMargin', 'spacing'],
  scrollMarginBlockEnd: ['scrollMargin', 'spacing'],
  scrollMarginBlockStart: ['scrollMargin', 'spacing'],
  scrollMarginBottom: ['scrollMargin', 'spacing'],
  scrollMarginInline: ['scrollMargin', 'spacing'],
  scrollMarginInlineEnd: ['scrollMargin', 'spacing'],
  scrollMarginInlineStart: ['scrollMargin', 'spacing'],
  scrollMarginLeft: ['scrollMargin', 'spacing'],
  scrollMarginRight: ['scrollMargin', 'spacing'],
  scrollMarginTop: ['scrollMargin', 'spacing'],
  scrollPadding: ['scrollPadding', 'spacing'],
  scrollPaddingBlock: ['scrollPadding', 'spacing'],
  scrollPaddingBlockEnd: ['scrollPadding', 'spacing'],
  scrollPaddingBlockStart: ['scrollPadding', 'spacing'],
  scrollPaddingBottom: ['scrollPadding', 'spacing'],
  scrollPaddingInline: ['scrollPadding', 'spacing'],
  scrollPaddingInlineEnd: ['scrollPadding', 'spacing'],
  scrollPaddingInlineStart: ['scrollPadding', 'spacing'],
  scrollPaddingLeft: ['scrollPadding', 'spacing'],
  scrollPaddingRight: ['scrollPadding', 'spacing'],
  scrollPaddingTop: ['scrollPadding', 'spacing'],
  stopColor: ['color'],
  stroke: ['stroke', 'color'],
  strokeColor: ['color'],
  strokeWidth: ['strokeWidth'],
  textDecorationColor: ['textDecorationColor', 'color'],
  textDecorationThickness: ['textDecorationThickness'],
  textEmphasisColor: ['color'],
  textIndent: ['textIndent', 'spacing'],
  textShadow: ['textShadow'],
  textUnderlineOffset: ['textUnderlineOffset'],
  top: ['inset', 'spacing'],
  transformOrigin: ['transformOrigin'],
  transitionDelay: ['transitionDelay'],
  transitionDuration: ['transitionDuration'],
  transitionProperty: ['transitionProperty'],
  transitionTimingFunction: ['ease'],
  translate: ['translate', 'spacing'],
  WebkitBorderAfterColor: ['color'],
  WebkitBorderBeforeColor: ['color'],
  WebkitBorderEndColor: ['color'],
  WebkitBorderStartColor: ['color'],
  WebkitLineClamp: ['lineClamp'],
  WebkitTapHighlightColor: ['color'],
  WebkitTextFillColor: ['color'],
  WebkitTextStrokeColor: ['color'],
  width: ['width', 'spacing', 'container'],
  zIndex: ['zIndex'],
} as const satisfies Partial<
  Record<keyof Literal.Properties, readonly string[]>
>

/** Checks a reference's property domain. */
export function accepts(
  group: Group,
  property: keyof Literal.Properties,
): boolean {
  if (property.startsWith('--')) return true
  if (group === 'number' || group === 'string') return false
  if (group === 'color') return Literal.rule(property)?.kind === 'color'
  if (group === 'borderColor') return /^border.*Color$/.test(property)
  if (group === 'borderWidth')
    return /^border(?:Block|Inline)?(?:Start|End|Top|Right|Bottom|Left)?Width$/.test(
      property,
    )
  if (group === 'borderRadius') return /^border.*Radius$/.test(property)
  if (group === 'textColor') return property === 'color'

  if (group === 'margin')
    return property.startsWith('margin') && property !== 'marginTrim'

  if (group === 'padding') return property.startsWith('padding')
  if (group === 'spacing' && property === 'marginTrim') return false

  if (group === 'spacing')
    return (
      /^(padding|margin|inset|scrollPadding)/.test(property) ||
      [
        'blockSize',
        'bottom',
        'columnGap',
        'flexBasis',
        'gap',
        'height',
        'inlineSize',
        'left',
        'maxBlockSize',
        'maxHeight',
        'maxInlineSize',
        'maxWidth',
        'minBlockSize',
        'minHeight',
        'minInlineSize',
        'minWidth',
        'right',
        'rowGap',
        'textDecorationThickness',
        'textIndent',
        'textUnderlineOffset',
        'top',
        'width',
      ].includes(property)
    )

  return group === property
}

/** Checks explicit variable values independently of shorthand category mappings. */
export function acceptsReference(
  reference: Reference,
  property: keyof Literal.Properties,
): boolean {
  if (!reference.contract.variableSet) return accepts(reference.group, property)
  if (property.startsWith('--')) return true
  function check(value: Value): boolean {
    if (is(value)) return acceptsReference(value, property)
    if (isExpression(value))
      return Binding.accepts(
        value.group === 'color' ? 'color' : 'length',
        property,
      )
    if (typeof value === 'object') return Object.values(value).every(check)
    if (typeof value === 'number') {
      const rule = Literal.rule(property)
      if (rule?.kind === 'number')
        return (
          value >= rule.min &&
          value <= rule.max &&
          (!rule.integer || Number.isInteger(value))
        )
      if (rule?.kind === 'grid-line')
        return Number.isInteger(value) && value !== 0
      if (property === 'columns') return Number.isInteger(value) && value > 0
      if (rule?.kind === 'ratio') return value >= 0
      if (rule && 'numeric' in rule && rule.numeric)
        return ('negative' in rule && rule.negative === true) || value >= 0
      return (
        Binding.accepts('number', property) ||
        (value === 0 && Binding.accepts('length', property))
      )
    }
    if (reference.group === 'color') return Binding.accepts('color', property)
    if (reference.group === 'spacing')
      return (
        (Literal.rule(property)?.kind === 'compound' &&
          (accepts('spacing', property) ||
            (property === 'columns' &&
              !value.endsWith('%') &&
              !value.startsWith('-')) ||
            [
              'backgroundPosition',
              'objectPosition',
              'perspectiveOrigin',
              'transformOrigin',
            ].includes(property))) ||
        Binding.accepts(
          value.endsWith('%')
            ? value.startsWith('-')
              ? 'signedPercentage'
              : 'percentage'
            : value.startsWith('-')
              ? 'signedLength'
              : 'length',
          property,
        )
      )
    return (
      Literal.isLiteral(property, value) ||
      Literal.rule(property)?.kind === 'compound' ||
      [
        'ratio',
        'grid-line',
        'grid-tracks',
        'identifier',
        'rotate',
        'scale',
        'translate',
      ].includes(Literal.rule(property)?.kind ?? '')
    )
  }
  return check(reference.value)
}

/** Rebinds validated scalar references to a explicitly owned contract identity. */
export function bind<tokens extends Theme.Tokens>(
  original: Theme.Definition<tokens>,
  contract: Contract,
  cssName?: string,
): Theme.Definition<tokens> {
  type Tree = { [key: string]: Reference | Tree }

  const metadata = original[definition]
  const values = VariableData.rebind(metadata, contract)

  function rebind(tree: Theme.References<Theme.Tokens>): Tree {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(tree).map(([key, value]) => [
          key,
          is(value)
            ? create({
                contract,
                group: value.group,
                path: value.path,
                value: values[value.path]!,
              })
            : rebind(value as Theme.References<Theme.Tokens>),
        ]),
      ),
    )
  }

  const tokens = rebind(original.tokens)

  return Object.freeze(
    Object.defineProperty(
      {
        get className() {
          return original.className
        },
        style: original.style,
        tokens,
        variants: original.variants,
        vars: variables(tokens),
      },
      definition,
      {
        value: Object.freeze({
          ...metadata,
          ...(cssName !== undefined ? { cssName } : {}),
          contract,
          values,
        }),
      },
    ),
  ) as Theme.Definition<tokens>
}

/** Retains full scopes when styles may have been compiled in another graph. */
export const complete = Symbol('zyzz.contract.complete')

/** Opaque data shared by a definition and its compatible extensions. */
export type Contract = {
  /** Whether values belong to independent variables rather than fixed theme categories. */
  readonly variableSet?: boolean | undefined
  /** Configuration-local category-to-property mappings. */
  readonly mappings?: VariableSets.Mappings | false | undefined
  /** Whether bound styles' class lists combine, retained by configuration-bound handles. */
  readonly composition?: 'independent' | 'ordered' | undefined
  /** Web emission mode retained by configuration-bound theme handles. */
  readonly cssOutput?: 'atomic' | 'grouped' | undefined
  /** Fallback layer for declarations without an explicit layer. */
  readonly defaultLayer?: string | undefined
  /** Configuration-local property aliases, inherited by bound handles. */
  readonly shorthands?: Shorthands.Map | undefined
  readonly [complete]?: boolean | undefined
  readonly [identity]?: string | undefined
}

/** Constructs a frozen reference without registering global state. */
export function create(options: Omit<Reference, typeof reference>): Reference {
  return Object.freeze({ ...options, [reference]: true as const })
}

/** Ordered web expression segments retain live references until CSS emission. */
export type Expression = {
  /** Structured expression discriminator. */
  readonly [expression]: true
  /** Cooked text and live scalar theme references in authored order. */
  readonly parts: readonly (string | Reference | Binding.Reference)[]
}

/** A composed variable value with an explicit scalar domain. */
export type Composition<
  group extends 'color' | 'spacing' = 'color' | 'spacing',
> = {
  /** Structured expression discriminator. */
  readonly [expression]: true
  /** Domain retained by variable references and compatible overrides. */
  readonly group: group
  /** CSS text and references to portable variable values. */
  readonly parts: readonly (string | Reference)[]
}

/** Identifies structured web expressions independently of literal CSS text. */
export const expression = Symbol('zyzz.expression')

/** Recognizes compiler-owned expression data without invoking getters. */
export function isExpression(value: unknown): value is Expression {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.getOwnPropertyDescriptor(value, expression)?.value === true
  )
}

/** Builds an immutable expression from statically extracted segments. */
export function compose(
  parts: readonly (string | Reference | Binding.Reference)[],
): Expression {
  return Object.freeze({
    [expression]: true as const,
    parts: Object.freeze([...parts]),
  })
}

/** Marks web-only references distinctly from portable tokens. */
export const web = Symbol('zyzz.web.variable')

/** Web reference with the original token domain. */
export type Variable<group extends Group = Group> = `var(--${string})` &
  Reference<group> & {
    readonly [web]: true
  }

/** Replaces portable scalar leaves with web-only references. */
export type Vars<tree> =
  tree extends Reference<infer group>
    ? Variable<group>
    : { readonly [key in keyof tree]: Vars<tree[key]> }

/** Creates web-only reference leaves without changing contract identities. */
export function variables<tree>(tree: tree): Vars<tree> {
  if (is(tree))
    return Object.freeze({
      ...tree,
      [web]: true as const,
    }) as unknown as Vars<tree>

  return Object.freeze(
    Object.fromEntries(
      Object.entries(tree as object).map(([key, value]) => [
        key,
        variables(value),
      ]),
    ),
  ) as Vars<tree>
}

/** Internal definition metadata; never enumerable consumer output. */
export const definition = Symbol('zyzz.theme')

/** Supported scalar token groups. */
export type Group =
  | 'number'
  | 'string'
  | 'backgroundColor'
  | 'borderColor'
  | 'borderRadius'
  | 'borderWidth'
  | 'color'
  | 'margin'
  | 'padding'
  | 'spacing'
  | 'fontFamily'
  | 'fontSize'
  | 'fontWeight'
  | 'letterSpacing'
  | 'lineHeight'
  | 'textColor'

/** Stable package/module/binding identity supplied by source adapters. */
export const identity = Symbol('zyzz.contract.identity')

/** Recognizes references without invoking getters on untrusted style values. */
export function is(value: unknown): value is Reference {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getOwnPropertyDescriptor(value, reference)?.value !== true
  )
    return false

  if (!Object.isFrozen(value)) return false

  const fields = Object.getOwnPropertyDescriptors(value)

  return ['contract', 'group', 'path', 'value'].every(
    (key) => fields[key] && 'value' in fields[key]!,
  )
}

/** Immutable theme data carried directly by each definition. */
export type Metadata = {
  /** Authored scope name, independent of private graph ownership. */
  readonly cssName?: string | undefined
  /** Original segments for paths with dotted keys or typography conditions. */
  readonly paths?: Readonly<Record<string, readonly string[]>> | undefined
  readonly queries?: Query.Metadata | undefined
  readonly contract: Contract
  readonly values: Readonly<Record<string, Value>>
}

/** Literal domain carried by explicit variable references during type checking. */
export const scalar = Symbol('zyzz.variable.scalar')

/** Inferred shorthand names whose leaves belong to a property domain, with `name/opacity` on color properties. */
export type Names<tokens, property extends keyof Literal.Properties> = Opacity<
  BaseNames<tokens, property>,
  property
>

type Opacity<names, property extends keyof Literal.Properties> = [
  names,
] extends [never]
  ? never
  : property extends Property<'color'>
    ? names | `${Extract<names, string | number>}/${number}`
    : names

type BaseNames<
  tokens,
  property extends keyof Literal.Properties,
> = tokens extends {
  readonly '~vars': { values: infer values; mappings: infer mappings }
}
  ? mappings extends false
    ? Paths<Omit<values, 'breakpoint' | 'containerNames'>, property>
    : {
        [category in keyof values]: category extends keyof mappings
          ? mappings[category] extends readonly unknown[]
            ? property extends mappings[category][number]
              ? Paths<values[category], property>
              : never
            : never
          : category extends (
                property extends keyof typeof propertyGroups
                  ? (typeof propertyGroups)[property][number]
                  : never
              )
            ? Paths<values[category], property>
            : never
      }[keyof values]
  : {
      [group in Extract<
        keyof tokens,
        Group
      >]: property extends Properties<group>
        ? Paths<NonNullable<tokens[group]>>
        : never
    }[Extract<keyof tokens, Group>]

type Paths<tree, property extends keyof Literal.Properties = never> = [
  tree,
] extends [never]
  ? never
  : string extends keyof tree
    ? string
    : {
        [key in Extract<keyof tree, number | string>]: NonNullable<
          tree[key]
        > extends Value
          ? [property] extends [never]
            ? PathKey<key>
            : Literal.Color extends VariableSets.Scalar<NonNullable<tree[key]>>
              ? property extends Properties<'color'>
                ? PathKey<key>
                : never
              : Literal.Length extends VariableSets.Scalar<
                    NonNullable<tree[key]>
                  >
                ? Binding.Property<'length', property> extends never
                  ? never
                  : PathKey<key>
                : VariableSets.Scalar<
                      NonNullable<tree[key]>
                    > extends Literal.Properties[property] &
                      ValueSyntax.Checked<
                        Record<
                          property,
                          VariableSets.Scalar<NonNullable<tree[key]>>
                        >
                      >[property]
                  ? PathKey<key>
                  : never
          : `${key}.${Paths<NonNullable<tree[key]>, property>}`
      }[Extract<keyof tree, number | string>]

type PathKey<key extends number | string> =
  | key
  | `${key}`
  | (key extends `${infer numericKey extends number}`
      ? `${numericKey}` extends key
        ? numericKey
        : never
      : never)

/** Property domains accepted by each token group. */
export type Properties<group extends Group> = `--${string}` | Property<group>

type Property<group extends Group> = group extends 'number' | 'string'
  ? never
  : group extends 'margin' | 'padding'
    ? Exclude<
        Extract<keyof Literal.Properties, `${group}${string}`>,
        'marginTrim'
      >
    : group extends 'spacing'
      ? Extract<
          keyof Literal.Properties,
          | `blockSize`
          | `bottom`
          | `columnGap`
          | `flexBasis`
          | `gap`
          | `height`
          | `inlineSize`
          | `inset${string}`
          | `left`
          | Exclude<
              Extract<keyof Literal.Properties, `margin${string}`>,
              'marginTrim'
            >
          | `maxBlockSize`
          | `maxHeight`
          | `maxInlineSize`
          | `maxWidth`
          | `minBlockSize`
          | `minHeight`
          | `minInlineSize`
          | `minWidth`
          | `padding${string}`
          | `right`
          | `rowGap`
          | `scrollPadding${string}`
          | `textDecorationThickness`
          | `textIndent`
          | `textUnderlineOffset`
          | `top`
          | `width`
        >
      : group extends 'textColor'
        ? 'color'
        : group extends 'color'
          ? {
              [property in keyof typeof Literal.rules]: (typeof Literal.rules)[property] extends {
                kind: 'color'
              }
                ? property
                : never
            }[keyof typeof Literal.rules]
          : group extends 'borderColor'
            ? Extract<keyof Literal.Properties, `border${string}Color`>
            : group extends 'borderWidth'
              ? Exclude<
                  Extract<keyof Literal.Properties, `border${string}Width`>,
                  'borderImageWidth'
                >
              : group extends 'borderRadius'
                ? Extract<keyof Literal.Properties, `border${string}Radius`>
                : group

/** Immutable portable reference retaining its defining fallback. */
export type Reference<group extends Group = Group> = {
  readonly [reference]: true
  readonly contract: Contract
  readonly group: group
  readonly path: string
  readonly value: Value
}

const reference = Symbol('zyzz.token')

/**
 * Resolves configured token names, with specific color groups first.
 *
 * On color properties, an unmatched `name/opacity` value resolves `name` and mixes the color
 * with `transparent`, where `opacity` is a percentage from 0 to 100.
 */
export function resolve(value: unknown, options: resolve.Options): unknown {
  const resolved = lookup(value, options)
  if (resolved !== value || typeof value !== 'string') return resolved

  const match = /^(.+)\/(\d+(?:\.\d*)?|\.\d+)$/.exec(value)
  if (!match || !accepts('color', options.property)) return value

  const opacity = Number(match[2])
  if (opacity > 100) return value

  const base = lookup(match[1], options)
  if (
    !is(base) ||
    (base.group !== 'color' && !base.group.endsWith('Color')) ||
    (base.contract.variableSet && !acceptsReference(base, options.property))
  )
    return value

  // Premultiplied mixing with `transparent` scales the alpha and keeps the channels.
  return compose(['color-mix(in srgb, ', base, ` ${opacity}%, transparent)`])
}

function lookup(value: unknown, options: resolve.Options): unknown {
  if (
    options.property.startsWith('--') ||
    (typeof value !== 'string' && typeof value !== 'number')
  )
    return value

  const data = Object.getOwnPropertyDescriptor(options.theme, definition)
    ?.value as Metadata | undefined
  if (!data) throw new Error('Expected a theme definition.')

  const groups: readonly string[] =
    propertyGroups[options.property as keyof typeof propertyGroups] ?? []

  if (data.contract.variableSet) {
    for (const [path, entry] of Object.entries(data.values).sort(
      ([left], [right]) =>
        groups.indexOf(left.split('.')[0]!) -
        groups.indexOf(right.split('.')[0]!),
    )) {
      const [category, ...parts] = path.split('.')
      const mappings = data.contract.mappings
      const mapped = mappings === false ? undefined : mappings?.[category!]
      if (
        mappings === false
          ? path !== String(value)
          : parts.join('.') !== String(value) ||
            !(mapped
              ? mapped.includes(options.property)
              : groups.includes(category!))
      )
        continue
      return create({
        contract: data.contract,
        group: (() => {
          let leaf: unknown = Object.getOwnPropertyDescriptor(
            options.theme,
            'tokens',
          )?.value
          for (const key of data.paths?.[path] ?? path.split('.'))
            leaf =
              leaf && typeof leaf === 'object'
                ? Object.getOwnPropertyDescriptor(leaf, key)?.value
                : undefined
          return is(leaf) ? leaf.group : (category as Group)
        })(),
        path,
        value: entry,
      })
    }
    return value
  }

  const legacyGroups = [
    'backgroundColor',
    'borderColor',
    'borderRadius',
    'borderWidth',
    'margin',
    'padding',
    'spacing',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'letterSpacing',
    'lineHeight',
    'textColor',
    'color',
  ] as const
  for (const group of legacyGroups) {
    if (!accepts(group, options.property)) continue

    const path = `${group}.${value}`
    if (Object.hasOwn(data.values, path))
      return create({
        contract: data.contract,
        group,
        path,
        value: data.values[path]!,
      })
  }

  return value
}

/** Whether the configured catalog supplies tokens for a property. */
export function mapped(
  theme: object,
  property: keyof Literal.Properties,
): boolean {
  if (property.startsWith('--')) return false
  const data = Object.getOwnPropertyDescriptor(theme, definition)
    ?.value as Metadata
  return Object.keys(data.values).some((path) => {
    const category = path.split('.')[0]!
    const targets =
      data.contract.mappings === false
        ? undefined
        : data.contract.mappings?.[category]
    if (
      data.contract.mappings !== false &&
      !(targets
        ? targets.includes(property)
        : data.contract.variableSet
          ? (
              propertyGroups[property as keyof typeof propertyGroups] as
                | readonly string[]
                | undefined
            )?.includes(category)
          : accepts(category as Group, property))
    )
      return false
    let leaf: unknown = Object.getOwnPropertyDescriptor(theme, 'tokens')?.value
    for (const key of data.paths?.[path] ?? path.split('.'))
      leaf =
        leaf && typeof leaf === 'object'
          ? Object.getOwnPropertyDescriptor(leaf, key)?.value
          : undefined
    return is(leaf) && acceptsReference(leaf, property)
  })
}

/** Input contract for theme token resolution. */
export declare namespace resolve {
  /** Property domain and immutable theme metadata supplied by style validation. */
  type Options = {
    readonly property: keyof Literal.Properties
    readonly theme: object
  }
}

/** Scalar values retained for each rendering target. */
export type Value =
  | number
  | string
  | Reference
  | Composition
  | { readonly dark: Value; readonly light: Value }
  | Conditions

/** Ordered conditional values with an unconditional fallback. */
export type Conditions = {
  readonly default: Value
  readonly [query: `@media ${string}`]: Value
}
