/**
 * Measures type instantiations contributed by named descriptor rules.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'
import type * as Web from 'zyzz/web'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const counterStyle: typeof Web.counterStyle
declare const style: typeof Zyzz.style
declare const fontFeatureValues: typeof Web.fontFeatureValues
declare const fontPaletteValues: typeof Web.fontPaletteValues
declare const page: typeof Web.page
declare const positionTry: typeof Web.positionTry
declare const viewTransition: typeof Web.viewTransition

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  style({ listStyleType: counterStyle({ symbols: '"-"' }) })
}

bench('counterStyle / descriptor inventory and identity', () => {
  const dots = counterStyle({
    additiveSymbols: '10 "X", 1 "I"',
    fallback: 'decimal',
    negative: '"(" ")"',
    pad: '2 "0"',
    range: '1 99',
    suffix: '"]"',
    symbols: '"I"',
    system: 'additive',
  })

  style({ listStyleType: dots })
}).types([1300, 'instantiations'])

bench('fontPaletteValues and positionTry / identities', () => {
  const palette = fontPaletteValues({
    basePalette: 'light',
    fontFamily: 'Evidence',
    overrideColors: '0 red, 1 blue',
  })
  const below = positionTry({
    alignSelf: 'center',
    margin: '2px',
    positionAnchor: '--target',
    positionArea: 'bottom',
  })

  style({ fontPalette: palette, positionTryFallbacks: below })
}).types([155976, 'instantiations'])

bench('page / margin boxes', () => {
  page({
    descriptors: {
      '@bottom-center': { content: 'counter(page)' },
      '@top-center': { content: '"Page"' },
      bleed: '3mm',
      margin: '1cm',
      marks: 'crop cross',
      size: 'A4 landscape',
    },
    selector: ':first, :left',
  })
}).types([400134, 'instantiations'])

bench('fontFeatureValues and viewTransition / descriptors', () => {
  fontFeatureValues({
    families: ['Evidence', 'Fallback'],
    features: {
      '@character-variant': { a: [1, 2] },
      '@styleset': { editorial: [1, 3] },
      '@swash': { flow: 1 },
    },
    fontDisplay: 'swap',
  })
  viewTransition({ navigation: 'auto', types: 'slide forwards' })
}).types([3240, 'instantiations'])
