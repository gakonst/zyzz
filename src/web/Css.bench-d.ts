/**
 * Measures type instantiations contributed by the public web compiler contract.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'
import type * as Web from 'zyzz/web'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Css: typeof Web.Css
declare const Style: typeof Zyzz.Style
declare const Vars: typeof Zyzz.Vars

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  Css.compile({ styles: Style.define({ base: { color: '#000' } }) })
}

bench('compile / literal styles', () => {
  const result = Css.compile({
    styles: Style.define({
      card: { display: 'flex', padding: '1rem' },
      label: { color: '#111' },
    }),
  })

  void result.classes.card.length
  void result.css.length
}).types([6241, 'instantiations'])

bench('compile / independent composition', () => {
  Css.compile({
    composition: 'independent',
    styles: Style.define({ card: { ':hover': { color: '#222' }, padding: 0 } }),
  })
}).types([3985, 'instantiations'])

bench('compile / theme scopes', () => {
  const base = Vars.define({
    color: { brand: '#06c' },
    spacing: { md: '8px' },
  })
  const alternate = Vars.extend(base, { spacing: { md: '12px' } })
  const result = Css.compile({
    styles: Style.define(
      { card: { color: 'brand', padding: 'md' } },
      { vars: base },
    ),
    vars: { alternate, base },
  })

  void result.vars.alternate
}).types([73124, 'instantiations'])
