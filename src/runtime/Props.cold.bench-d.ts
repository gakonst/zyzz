/** Measures the first inline-override check without warming the property domain. @module */
import { bench } from '@ark/attest'
import type * as Runtime from 'zyzz/runtime'

declare const Dynamic: typeof Runtime.Dynamic
declare const Html: typeof Runtime.Html
declare const Props: typeof Runtime.Props

/** Keeps first-use property checking inside each measured body. */
export function baseline() {}

bench('create / first static override', () => {
  const button = Props.create({ className: 'button' })

  void button({ className: 'external', style: { paddingLeft: '2px' } })
    .className
}).types([3246, 'instantiations'])

bench('create / first html and dynamic bindings', () => {
  const card = Html.create({ className: 'card' })
  const bar = Dynamic.create({
    className: 'bar',
    slots: { width: { name: '--z-width', type: 'percentage' } },
  })

  void card({ style: { opacity: 0.5 } }).class
  void bar({ width: '50%' }).style
}).types([3524, 'instantiations'])
