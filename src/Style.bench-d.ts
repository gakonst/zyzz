/**
 * Measures type instantiations contributed by public Style definitions.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Style: typeof Zyzz.Style
declare const Vars: typeof Zyzz.Vars

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  Style.define({ base: { color: '#000' } })
  Vars.define({ color: { base: '#000' } })
}

bench('define / literal named styles', () => {
  Style.define({
    card: {
      backgroundColor: '#fff',
      borderRadius: '8px',
      display: 'flex',
      padding: '1rem',
    },
    hidden: { display: 'none' },
    label: { color: '#111', fontSize: '14px', lineHeight: 1.5 },
  })
}).types([17028, 'instantiations'])

bench('define / nested conditions', () => {
  Style.define({
    button: {
      ':hover': { backgroundColor: '#eee' },
      '&[aria-pressed=true]': { color: '#fff' },
      '@media (width >= 800px)': { padding: '1rem 2rem' },
      color: '#111',
      padding: '0.5rem 1rem',
    },
  })
}).types([7656, 'instantiations'])

bench('define / compound declarations', () => {
  Style.define({
    surface: {
      background: 'url(image.png) center / cover no-repeat red',
      boxShadow: 'inset 0 0 2px red, 2px 3px 4px blue',
      font: 'italic 16px/1.5 sans-serif',
      grid: '100px / 1fr 2fr',
      transition: 'opacity 200ms ease-in',
    },
  })
}).types([119930, 'instantiations'])

bench('define / theme shorthand names', () => {
  const theme = Vars.define({
    color: { brand: '#06c', ink: '#111' },
    spacing: { 4: '1rem', md: '8px' },
  })

  Style.define(
    {
      card: { color: 'brand', padding: 4 },
      label: { color: theme.color.ink, margin: 'md' },
    },
    { vars: theme },
  )
}).types([66909, 'instantiations'])
