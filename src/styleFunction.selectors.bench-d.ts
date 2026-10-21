/** Measures type instantiations for selector templates and nested declarations. @module */
/* oxlint-disable typescript/restrict-template-expressions -- Selector references are resolved at compile time. */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

declare const style: typeof Zyzz.style

/** Warms shared authoring contracts before measuring selectors. */
export function baseline() {
  style({ selectors: { [`&:hover`]: { color: 'black' } } })
}

bench('selectors / style references', () => {
  const card = style({})
  style({
    selectors: {
      [`${card}:hover &`]: { color: 'blue' },
      [`${card} > &:nth-child(even)`]: { opacity: 0.5 },
    },
  })
}).types([3395, 'instantiations'])
