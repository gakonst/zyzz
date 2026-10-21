/** Measures public composition inference for applied static styles. @module */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

declare const style: typeof Zyzz.style
declare const cx: typeof Zyzz.cx

/** Warms static style inference outside the measured composition. */
export function baseline() {
  style({ display: 'block' })
}

bench('cx / ordered static props', () => {
  const a = style({ padding: '8px', color: 'red' })
  const b = style({ paddingLeft: '12px', color: 'blue' })
  cx(a(), false, null, undefined, b(), a())
}).types([19276, 'instantiations'])
