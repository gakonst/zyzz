/**
 * Measures type instantiations contributed by public configuration modes.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Config: typeof Zyzz.Config
declare const Vars: typeof Zyzz.Vars

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  Config.create({ vars: { color: { base: '#000' } } }).style({ color: 'base' })
}

bench('create / token-free authoring', () => {
  const { script, style } = Config.create()

  style({ color: '#fff', padding: '8px' })
  script()
}).types([9888, 'instantiations'])

bench('create / inline theme with layers and shorthands', () => {
  const { style, vars: theme } = Config.create({
    layers: ['base', 'components'],
    shorthands: { px: ['paddingLeft', 'paddingRight'] },
    vars: {
      color: { brand: '#06c' },
      padding: { md: '8px' },
      spacing: { md: '8px' },
    },
  })

  style({
    '@layer components': { color: 'brand', px: 'md' },
    ':hover': { color: theme.color.brand },
    margin: 'md',
  })
}).types([42314, 'instantiations'])

bench('create / named theme catalog', () => {
  const base = Vars.define({
    color: { brand: '#06c' },
    spacing: { md: '8px' },
  })
  const { style, vars: themes } = Config.create({
    defaultVars: 'base',
    vars: {
      base,
      mint: {
        color: { brand: { dark: '#afa', light: '#175' } },
        spacing: { md: '12px' },
      },
    },
  })

  style({ color: 'brand', padding: 'md' })
  themes({ colorScheme: 'dark', set: 'mint' })
}).types([10165, 'instantiations'])

bench('create / html output', () => {
  const { style } = Config.create({ output: 'html' })
  const dynamic = style((values: { width: `${number}%` }) => ({
    width: values.width,
  }))

  void style({ padding: '8px' })().class
  void dynamic({ width: '25%' }).style
}).types([12602, 'instantiations'])
