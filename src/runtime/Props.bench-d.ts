/**
 * Measures type instantiations contributed by compiled props bindings.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Runtime from 'zyzz/runtime'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Dynamic: typeof Runtime.Dynamic
declare const Html: typeof Runtime.Html
declare const Props: typeof Runtime.Props

/** Warms override property checking; first-use costs are measured separately. */
export function baseline() {
  Props.create({ className: 'base' })({ style: {} })
}

bench('create / static overrides', () => {
  const button = Props.create({ className: 'button' })

  void button({ className: 'external', style: { paddingLeft: '2px' } })
    .className
}).types([25, 'instantiations'])

bench('create / html and dynamic bindings', () => {
  const card = Html.create({ className: 'card' })
  const bar = Dynamic.create({
    className: 'bar',
    slots: { width: { name: '--z-width', type: 'percentage' } },
  })

  void card({ style: { opacity: 0.5 } }).class
  void bar({ width: '50%' }).style
}).types([384, 'instantiations'])
