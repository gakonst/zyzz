/**
 * Measures type instantiations contributed by literal stylesheet contributions.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'
import type * as Web from 'zyzz/web'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const fontFace: typeof Web.fontFace
declare const global: typeof Web.global
declare const keyframes: typeof Web.keyframes
declare const layers: typeof Web.layers
declare const Vars: typeof Zyzz.Vars

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  global({ html: { color: '#000' } })
  keyframes({ from: { color: '#000' } })
  fontFace({ fontFamily: 'Base', src: 'url(/base.woff2)' })
}

bench('global / selectors and grouping rules', () => {
  const theme = Vars.define({ color: { ink: '#111' } })

  global({
    '@layer reset': { '*': { boxSizing: 'border-box', margin: 0 } },
    '@media (prefers-reduced-motion: reduce)': {
      '*': { animationDuration: '0.01ms !important' },
    },
    body: { color: theme.color.ink, padding: '2px' },
    'h1, h2': { fontWeight: 700, lineHeight: 1.2 },
  })
  layers(['reset', 'base', 'components'])
}).types([29124, 'instantiations'])

bench('keyframes / stop positions', () => {
  keyframes({
    '50%': { opacity: 0.5, transform: 'scale(1.05)' },
    from: { opacity: 0 },
    to: { opacity: 1 },
  })
  keyframes({ 'entry 0%': { opacity: 0 }, 'exit 100%': { opacity: 1 } })
}).types([5714, 'instantiations'])

bench('fontFace / descriptor inventory', () => {
  fontFace({
    '@layer': {
      '@media screen': {
        ascentOverride: '90%',
        fontDisplay: 'swap',
        fontFamily: 'Evidence',
        fontFeatureSettings: '"kern"',
        fontStyle: 'italic',
        fontWeight: '400 700',
        src: 'url(/font.ttf)',
        unicodeRange: 'U+0000-00FF',
      },
    },
  })
}).types([1133, 'instantiations'])
