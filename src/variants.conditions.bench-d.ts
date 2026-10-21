/** Measures finite conditional recipe inference through public authoring. @module */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

declare const variants: typeof Zyzz.variants

/** Resolves shared authoring contracts before the measured workflow. */
export function baseline() {
  variants({ base: { display: 'block' } })
}

bench('variants / conditional selections and compounds', () => {
  const button = variants({
    conditions: {
      wide: '@media (width >= 600px)',
      grid: '@supports (display: grid)',
    },
    variants: {
      size: { sm: { padding: '4px' }, lg: { padding: '12px' } },
      loading: { true: { opacity: 0.5 }, false: {} },
    },
    defaultVariants: { size: 'sm' },
    compoundVariants: [
      { when: { size: 'lg', loading: true }, style: { color: 'red' } },
    ],
  })
  button({ conditions: { wide: { size: null }, grid: { loading: false } } })
}).types([27268, 'instantiations'])
