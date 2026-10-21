/** Measures public recipe authoring and selection inference. @module */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

declare const variants: typeof Zyzz.variants

/** Warms shared recipe contracts without repeating the measured case. */
export function baseline() {
  variants({ base: { display: 'block' } })
}

bench('variants / defaults and compounds', () => {
  const button = variants({
    variants: {
      size: { sm: { padding: '4px' }, lg: { padding: '12px' } },
      loading: { true: { opacity: 0.5 }, false: {} },
    },
    defaultVariants: { size: 'sm' },
    compoundVariants: [
      { when: { size: 'lg', loading: true }, style: { color: 'red' } },
    ],
  })
  button({ loading: false, size: null })
}).types([22239, 'instantiations'])
