/**
 * Measures type instantiations contributed by public Theme contracts.
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
  const vars = Vars.define({ color: { base: '#000' } })
  Config.create({ vars }).style({ color: 'base' })
}

bench('define / scalar and scheme tokens', () => {
  Vars.define({
    backgroundColor: { surface: { dark: '#000', light: '#fff' } },
    radius: { round: '1rem', sm: '4px' },
    color: { blue: { 500: '#06c', 700: '#036' }, brand: '#06c' },
    fontSize: { body: '1rem', heading: '2rem' },
    fontWeight: { medium: 500 },
    spacing: { 4: '1rem', 8: '2rem', md: '8px' },
    textColor: { foreground: '#000' },
  })
}).types([3456, 'instantiations'])

bench('define / query aliases', () => {
  const theme = Vars.define({
    breakpoint: { desktop: '64rem', tablet: '48rem' },
    containerNames: ['sidebar'],
    container: { card: '24rem' },
    spacing: { gap: '4px' },
  })
  const themeConfig = Config.create({ vars: theme })

  themeConfig.style({
    '@container sidebar >=card': { display: 'grid' },
    '@media tablet..desktop': { ':hover': { padding: 'gap' } },
  })
}).types([15849, 'instantiations'])

bench('extend / overrides', () => {
  const theme = Vars.define({
    backgroundColor: { surface: { dark: '#000', light: '#fff' } },
    color: { blue: { 500: '#06c' } },
    spacing: { md: '1rem' },
  })

  Vars.extend(theme, {
    backgroundColor: { surface: '#fff' },
    spacing: { md: '2rem' },
  })
}).types([13165, 'instantiations'])

bench('style / token names and references', () => {
  const theme = Vars.define({
    color: { blue: { 500: '#06c' }, brand: '#06c' },
    spacing: { 4: '1rem', md: '2rem' },
  })
  const themeConfig = Config.create({ vars: theme })

  themeConfig.style({
    color: 'blue.500',
    margin: theme.spacing.md,
    padding: 4,
    width: theme.spacing[4],
  })
}).types([18258, 'instantiations'])
