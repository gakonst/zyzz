/**
 * Verifies configuration modes, token domains, and exact layer-key inference.
 * @module
 */
import { describe, expectTypeOf, test } from 'vite-plus/test'
import {
  Config as PublicConfig,
  defineConfig,
  defineVars,
  extendVars,
  Style,
} from 'zyzz'
import * as Theme from './internal/Theme.js'
import * as Config from './internal/Configuration.js'

describe('create', () => {
  test('preserves custom suffix unions and reusable property annotations', () => {
    const flag = Boolean(Math.random())
    const config = PublicConfig.create({ vars: { spacing: { md: '8px' } } })
    config.style({ padding: flag ? 'md' : '7px !custom' })
    config.style({ padding: [flag ? 'md' : '7px !custom', '2px !custom'] })
    PublicConfig.create().style({ color: flag ? 'red' : 'blue !custom' })
    const literal: Style.Properties = { width: '7px !custom' }
    const declarations: Style.LiteralProperties = { width: '7px !custom' }
    const tokens = { spacing: { md: '8px' } } as const
    const themed = { padding: '7px !custom' } satisfies Style.Properties<
      typeof tokens
    >
    const properties: Style.DeclarationProperties<typeof tokens> = {
      padding: 'md',
    }
    config.style(themed)
    void properties
    void literal
    void declarations
    // @ts-expect-error Annotations require escapes for configured properties.
    const raw: Style.Properties<typeof tokens> = { padding: '7px' }
    // @ts-expect-error A union cannot hide an invalid arbitrary value.
    config.style({ padding: flag ? 'md' : 'invalid !custom' })
    // @ts-expect-error Dynamic slots cannot resolve token names.
    config.style((values: { padding: 'md' }) => ({ padding: values.padding }))
    config.variants({
      variants: {
        size: {
          // @ts-expect-error Dynamic recipe slots cannot resolve token names.
          custom: (values: { padding: 'md' }) => ({ padding: values.padding }),
        },
      },
    })
    void raw
    const incompatible = PublicConfig.create({
      vars: { color: { gap: '8px' } },
    })
    incompatible.style({ color: 'red' })
  })

  test('requires tokens or CSS with `!custom` when values exist', () => {
    const { style, variants, vars } = PublicConfig.create({
      shorthands: { px: ['paddingLeft', 'paddingRight'] },
      vars: { color: { brand: 'red' }, spacing: { md: '8px' } },
    })
    style({
      padding: 'md',
      marginTop: '7px !custom',
      color: '#123456 !custom',
      width: 'calc(100% - 2rem) !custom',
    })
    style({
      color: vars.color.brand,
      padding: ['md', '7px !custom'],
      px: '7px !custom',
    })
    style({
      color: 'red !custom !important',
      display: 'flex',
      ':hover': { padding: '2px !custom' },
    })
    style((values: { padding: '7px' }) => ({
      padding: `${values.padding} !custom`,
    }))
    style({ opacity: '0.5 !custom' })
    style({ opacity: 0.5 })
    // @ts-expect-error Bracket escapes have been removed.
    style({ padding: '[7px]' })
    // @ts-expect-error Custom markers cannot be repeated.
    style({ padding: '7px !custom !custom' })
    // @ts-expect-error Importance must follow the custom marker.
    style({ padding: '7px !important !custom' })
    // @ts-expect-error Custom markers require a separating space.
    style({ padding: '7px!custom' })
    // @ts-expect-error Custom markers use their canonical spelling.
    style({ padding: '7px !CUSTOM' })
    // @ts-expect-error Custom values retain CSS syntax validation.
    style({ padding: '[7px] !custom' })
    // @ts-expect-error Empty escapes are not CSS values.
    style({ padding: ' !custom' })
    // @ts-expect-error Arbitrary mapped values require !custom.
    style({ padding: '7px' })
    // @ts-expect-error Every fallback is checked.
    style({ padding: ['md', '7px'] })
    // @ts-expect-error Custom suffixes preserve CSS validation.
    style({ padding: 'invalid !custom' })
    // @ts-expect-error Malformed CSS remains invalid.
    style({ color: '#oops !custom' })
    // @ts-expect-error The object escape was removed.
    style({ padding: { custom: '7px' } })
    // @ts-expect-error Nested styles retain token enforcement.
    style({ ':hover': { padding: '7px' } })
    // @ts-expect-error Variants retain token enforcement.
    variants({ variants: { size: { large: { padding: '7px' } } } })
    variants({
      base: { padding: 'md' },
      variants: { size: { large: { padding: '7px !custom' } } },
    })
    // @ts-expect-error Arbitrary callback values require !custom.
    style((values: { padding: '7px' }) => ({ padding: values.padding }))
    // @ts-expect-error Shorthands retain token enforcement.
    style({ px: '7px' })
    // @ts-expect-error Compound variants retain token enforcement.
    variants({ compoundVariants: [{ when: {}, style: { padding: '7px' } }] })
    // @ts-expect-error Fallbacks remain nonempty.
    style({ padding: [] })
    PublicConfig.create({
      mappings: { ink: ['color'] },
      vars: { ink: { brand: 'red' } },
    }).style({ color: 'brand', backgroundColor: 'blue' })
    const full = PublicConfig.create({
      mappings: false,
      vars: { color: { brand: 'red' } },
    })
    full.style({ color: 'color.brand' })
    // @ts-expect-error Full paths require the complete token name.
    full.style({ color: 'red' })
    PublicConfig.create().style({ padding: '7px', color: 'red !custom' })
    PublicConfig.create({ vars: {} }).style({
      padding: '7px !custom',
      color: 'red',
    })
    // @ts-expect-error The strict option was removed.
    PublicConfig.create({ strict: true })
  })

  test('accepts defaultLayer with and without variable sets', () => {
    const { style, variants } = PublicConfig.create({
      defaultLayer: 'components',
      layers: ['components', 'overrides'],
      mappings: false,
      vars: { color: { brand: 'red' } },
    })
    expectTypeOf(
      style({
        color: 'color.brand',
        '@layer overrides': { color: 'blue !custom' },
      })().className,
    ).toEqualTypeOf<string>()
    expectTypeOf(
      variants({ base: { color: 'color.brand' } })().className,
    ).toEqualTypeOf<string>()
    PublicConfig.create({ defaultLayer: 'components.buttons' }).style({
      color: 'red',
    })
    // @ts-expect-error Default layers require a name.
    PublicConfig.create({ defaultLayer: false })
    // @ts-expect-error Unknown layers remain invalid explicit overrides.
    style({ '@layer unknown': { color: 'red' } })
  })

  test('infers style helpers with either CSS output mode', () => {
    const { style, variants } = Config.create({ cssOutput: 'grouped' })
    expectTypeOf(style({ color: 'red' })().className).toEqualTypeOf<string>()
    expectTypeOf(
      variants({ variants: { size: { large: { padding: '8px' } } } })({
        size: 'large',
      }).className,
    ).toEqualTypeOf<string>()
    Config.create({ cssOutput: 'atomic', output: 'html' })
    // @ts-expect-error Unsupported CSS representation.
    Config.create({ cssOutput: 'automatic' })
  })

  test('accepts ordered or independent composition', () => {
    const { style } = Config.create({ composition: 'independent' })
    expectTypeOf(style({ color: 'red' })().className).toEqualTypeOf<string>()
    Config.create({ composition: 'ordered', cssOutput: 'grouped' })
    // @ts-expect-error Unsupported composition mode.
    Config.create({ composition: 'shared' })
  })

  test('checks configured callback domains', () => {
    const { style } = Config.create()

    // @ts-expect-error Configured callbacks cannot use broad numbers for integer slots.
    style((values: { order: number }) => ({ order: values.order }))
    // @ts-expect-error Reserved styling fields cannot be callback slots.
    style((values: { style: string }) => ({ color: values.style }))
    style((values: { alpha: number }) => ({ opacity: values.alpha }))
  })

  test('composes configured definitions with variable sets and shorthands', () => {
    const base = defineVars({
      color: { content: { primary: { dark: '#fff', light: '#000' } } },
      spacing: { none: '0px', sm: '4px' },
    })
    const inverse = extendVars(base, {
      color: { content: { primary: { dark: '#000', light: '#fff' } } },
    })
    const { style } = PublicConfig.create({
      cssOutput: 'atomic',
      defaultVars: 'base',
      id: 'composition',
      shorthands: { paddingHorizontal: ['paddingLeft', 'paddingRight'] },
      vars: { base, inverse },
    })
    const label = style({ color: 'content.primary', paddingHorizontal: 'sm' })
    const composed = style([label, { margin: 'none' }])
    const nested = style([composed, label, { paddingHorizontal: 'none' }])

    expectTypeOf(composed()).toEqualTypeOf(label())
    expectTypeOf(nested({ className: 'external' })).toEqualTypeOf(label())
    // @ts-expect-error Literal entries accept only configured tokens.
    style([label, { margin: '7px' }])
    // @ts-expect-error Configured shorthands keep their token domains.
    style([label, { paddingHorizontal: 'missing' }])
  })

  test('types rejected definitions as static styles', () => {
    const { style } = PublicConfig.create({ vars: { spacing: { md: '8px' } } })
    const card = style({
      // @ts-expect-error The diagnostic stays on the untokenized declaration.
      padding: '7px',
    })
    const dynamic = style((values: { width: `${number}px` }) => ({
      width: `${values.width} !custom`,
    }))

    expectTypeOf(card()).toEqualTypeOf(style({ padding: 'md' })())
    expectTypeOf(dynamic({ width: '8px' })).toEqualTypeOf(card())
    // @ts-expect-error Valid callbacks still require their values.
    dynamic()
  })

  test('preserves token domains in grouped styles from destructured helpers', () => {
    const { style, theme } = Config.create({
      theme: { color: { brand: '#06c' }, spacing: { md: '8px' } },
    })
    const card = style({ padding: 'md' })
    const label = style({ color: theme.tokens.color.brand })

    expectTypeOf(card).toEqualTypeOf<typeof label>()

    // @ts-expect-error Token names remain constrained after destructuring.
    style({ padding: 'missing' })
    // @ts-expect-error References retain their property domains.
    style({ padding: theme.tokens.color.brand })
  })

  test('keeps unthemed configuration token-free', () => {
    const empty = Config.create()

    empty.style({ color: '#fff', padding: '8px' })
    // @ts-expect-error Root config has no tokens.
    empty.style({ padding: 'md' })
    // @ts-expect-error Token-free config has no theme handle.
    void empty.theme
  })

  test('infers a single theme and exact layer keys', () => {
    const base = Theme.define({
      color: { brand: '#06c' },
      spacing: { md: '8px' },
    })
    const single = Config.create({
      layers: ['base', 'components'],
      theme: base,
    })

    single.style({ color: 'brand', padding: single.theme.tokens.spacing.md })
    single.style({
      '@layer components': { color: 'brand', '@layer base': { padding: 'md' } },
    })
    // @ts-expect-error Misspelled layer.
    single.style({ '@layer component': { color: 'brand' } })
    // @ts-expect-error Layer bodies retain token checking.
    single.style({ '@layer components': { color: 'missing' } })
    const reference = single.theme.tokens.color.brand
    // @ts-expect-error References retain property domains inside layers.
    single.style({ '@layer base': { padding: reference } })
    // @ts-expect-error Unknown style keys through variables remain invalid.
    single.style({ colour: '#06c' } as const)
    // @ts-expect-error Single-theme config has no catalog.
    void single.themes

    // Scoped selectors retain the same bound token inference.
    single.style({ ':hover': { color: 'brand' } })
  })

  test('validates named themes and configuration modes', () => {
    const base = Theme.define({
      color: { brand: '#06c' },
      spacing: { md: '8px' },
    })

    const named = Config.create({
      defaultTheme: 'base',
      themes: {
        base,
        mint: {
          color: { brand: { light: '#175', dark: '#afa' } },
          spacing: { md: '12px' },
        },
      },
    })

    named.style({ color: 'brand', padding: 'md' })

    expectTypeOf(named.themes.mint.tokens.color.brand).toEqualTypeOf<
      Theme.Reference<'color'>
    >()

    // @ts-expect-error Missing default.
    Config.create({ themes: { base } })
    // @ts-expect-error Unknown default.
    Config.create({ defaultTheme: 'missing', themes: { base } })
    // @ts-expect-error Modes are mutually exclusive.
    Config.create({ theme: base, themes: { base }, defaultTheme: 'base' })
    // @ts-expect-error Default requires a catalog.
    Config.create({ theme: base, defaultTheme: 'base' })
    Config.create({
      defaultTheme: 'base',
      // @ts-expect-error Complete alternatives must include spacing.
      themes: { base, mint: { color: { brand: '#175' } } },
    })
    Config.create({
      defaultTheme: 'base',
      themes: {
        base,
        mint: {
          // @ts-expect-error Extra tokens are incompatible.
          color: { brand: '#175', extra: '#000' },
          spacing: { md: '8px' },
        },
      },
    })

    const incomplete = Theme.define({ color: { brand: '#175' } })

    // @ts-expect-error Reusable definitions must also have complete paths.
    Config.create({ defaultTheme: 'base', themes: { base, incomplete } })
    // @ts-expect-error Wrong inline token group.
    Config.create({ theme: { colors: { brand: '#fff' } } })
    // @ts-expect-error Incomplete color pair.
    Config.create({ theme: { color: { brand: { light: '#fff' } } } })
    Config.create({
      theme: {
        // @ts-expect-error Color pairs cannot carry extra properties.
        color: { brand: { light: '#fff', dark: '#000', extra: '#fff' } },
      },
    })
    // @ts-expect-error Unknown options are rejected through variables.
    Config.create({ theme: base, unknown: true } as const)
  })
})

describe('create', () => {
  test('binds root appearance controls to the catalog', () => {
    const named = Config.create({
      defaultTheme: 'base',
      storageKey: 'app',
      themes: {
        base: { color: { brand: '#06c' } },
        mint: { color: { brand: '#175' } },
      },
    })

    expectTypeOf(named.appearance.get()).toEqualTypeOf<{
      readonly colorScheme?: 'dark' | 'light' | 'light dark' | undefined
      readonly set: 'base' | 'mint'
    }>()
    named.appearance.set({ colorScheme: 'dark' })
    named.appearance.set({ set: 'mint' })
    // @ts-expect-error Unknown catalog names are rejected.
    named.appearance.set({ set: 'ocean' })

    const single = Config.create({ theme: { color: { brand: '#06c' } } })

    expectTypeOf(single.appearance.get()).toEqualTypeOf<{
      readonly colorScheme?: 'dark' | 'light' | 'light dark' | undefined
    }>()
    // @ts-expect-error Single themes select only a scheme.
    single.appearance.set({ set: 'base' })
    // @ts-expect-error Storage keys are strings.
    Config.create({ storageKey: 42 })
  })
})

describe('create', () => {
  test('rejects invalid union branches and empty callbacks', () => {
    const { style } = Config.create()
    const styles = {} as { color: '#fff' } | { ':hover': { colour: '#fff' } }

    // @ts-expect-error Each disjoint branch must contain valid nested properties.
    style(styles)
    // @ts-expect-error Callbacks require one scalar input parameter.
    style(() => ({ color: '#fff' }))
  })
})

describe('create', () => {
  test('rejects undeclared layer names with CSS separators', () => {
    const { style } = Config.create({ layers: ['base'] })
    // @ts-expect-error undeclared tab-separated layer
    style({ '@layer\tunknown': { color: 'red' } })
    // @ts-expect-error undeclared comment-separated layer
    style({ '@layer/**/unknown': { color: 'red' } })
    style({ '@layer': { color: 'red' }, '@layer base': { color: 'blue' } })
  })
})

test('keeps property groups internal', () => {
  Config.create({
    vars: { spacing: { small: '4px' } },
    // @ts-expect-error Token fallback groups are not configurable.
    propertyGroups: { width: ['spacing'] },
  })
})

describe('defineConfig', () => {
  test('preserves the config factory and its namespace types', () => {
    expectTypeOf(defineConfig).toEqualTypeOf(PublicConfig.create)
    expectTypeOf<defineConfig.Options>().toEqualTypeOf<PublicConfig.create.Options>()
    const config = defineConfig({ vars: { color: { brand: '#123456' } } })
    config.style({ color: 'brand' })
    // @ts-expect-error Configured color names retain their literal domain.
    config.style({ color: 'missing' })
    // @ts-expect-error Unknown configuration options remain rejected.
    defineConfig({ unknown: true })
  })

  test('accepts fractional numeric variable keys', () => {
    const { style, vars } = defineConfig({
      vars: { spacing: { 0: '0px', 0.5: '2px', 2.5: '10px' } },
    })

    style({ gap: 0.5, margin: '2.5', padding: vars.spacing[0.5] })
    // @ts-expect-error Unknown spacing tokens remain rejected.
    style({ gap: 1.5 })
  })

  test('accepts color tokens with an opacity on color properties', () => {
    const { style } = defineConfig({
      vars: {
        color: { blue: { 500: '#00f' }, ink: { dark: '#fff', light: '#000' } },
        spacing: { md: '8px' },
      },
    })

    style({
      backgroundColor: 'ink/40',
      borderColor: 'blue.500/12.5',
      color: 'ink/100 !important',
      outlineColor: 'blue.500',
    })
    // @ts-expect-error Unknown color names remain rejected.
    style({ color: 'missing/40' })
    // @ts-expect-error An opacity requires a number.
    style({ color: 'ink/half' })
    // @ts-expect-error Non-color properties accept no opacity.
    style({ padding: 'md/40' })
  })

  test('rejects font weight tokens outside the fontWeight domain', () => {
    const config = defineConfig({
      vars: { fontWeight: { bold: 'bold', medium: 500, regular: 400 } },
    })

    config.style({ fontWeight: 'medium' })
    config.style({ fontWeight: 'bold' })
    // @ts-expect-error Weights outside the configured scale remain rejected.
    config.style({ fontWeight: 600 })
    defineConfig({
      mappings: { fontWeight: [] },
      vars: { fontWeight: { medium: '500' } },
    })
    // @ts-expect-error Numeric strings are not fontWeight values.
    defineConfig({ vars: { fontWeight: { medium: '500' } } })
    defineConfig({
      mappings: { weight: ['fontWeight'] },
      // @ts-expect-error Mapped categories check their weights too.
      vars: { weight: { medium: '500' } },
    })
    defineConfig({
      defaultVars: 'base',
      // @ts-expect-error Each catalog set checks its weights.
      vars: { base: { fontWeight: { medium: '500' } } },
    })
    // @ts-expect-error Reusable sets check their weights when configured.
    defineConfig({ vars: defineVars({ fontWeight: { medium: '500' } }) })
  })
})
