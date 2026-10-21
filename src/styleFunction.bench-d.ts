/**
 * Measures type instantiations contributed by public root style authoring.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Config: typeof Zyzz.Config
declare const style: typeof Zyzz.style
declare const Vars: typeof Zyzz.Vars

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  style({ color: '#000' })
  const vars = Vars.define({ color: { base: '#000' } })
  Config.create({ vars }).style({ color: 'base' })
}

bench('style / literal declarations', () => {
  style({
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: '8px',
    color: '#111',
    display: 'flex',
    gap: '12px',
    padding: '1rem 2rem',
    width: 'calc(100% - 16px)',
  })
}).types([28571, 'instantiations'])

bench('style / fallbacks, importance, and templates', () => {
  style({
    color: ['#111', 'oklch(0.5 0.1 200) !important'],
    padding: `${8}px`,
    position: 'sticky !important',
    width: `calc(100% - ${16}px)`,
  })
}).types([18522, 'instantiations'])

bench('style / nested conditions', () => {
  style({
    ':hover': { color: '#222' },
    '&[data-active]': { opacity: 0.5 },
    '@container (width > 400px)': { display: 'grid' },
    '@media (width >= 800px)': { ':focus-visible': { outline: '2px solid' } },
    '@supports (display: grid)': { display: 'grid' },
  })
}).types([21972, 'instantiations'])

bench('style / dynamic callback', () => {
  const bar = style((values: { alpha: number; amount: `${number}%` }) => ({
    display: 'block',
    opacity: values.alpha,
    width: values.amount,
  }))

  bar({ alpha: 0.5, amount: '50%', className: 'external' })
}).types([9585, 'instantiations'])

bench('style / applied overrides', () => {
  const card = style({ color: '#fff', padding: '1rem' })

  card({ className: 'external', style: { opacity: 0.5 } })
  card()
}).types([7308, 'instantiations'])

bench('style / bound theme tokens', () => {
  const theme = Vars.define({
    color: { brand: '#06c', ink: { dark: '#fff', light: '#000' } },
    spacing: { 4: '1rem', md: '8px' },
  })
  const themeConfig = Config.create({ vars: theme })

  themeConfig.style({
    ':hover': { color: 'brand' },
    color: 'ink',
    padding: ['md', '2px !custom !important'],
    width: theme.spacing[4],
  })
}).types([19119, 'instantiations'])
