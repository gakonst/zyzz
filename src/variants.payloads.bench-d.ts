/** Measures public inference for scoped dynamic recipe payloads. @module */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

declare const variants: typeof Zyzz.variants

/** Warms the shared recipe contract outside the measured case. */
export function baseline() {
  variants({ base: { display: 'block' } })
}

bench('variants / dynamic payloads', () => {
  const button = variants({
    conditions: { wide: '@media (width >= 600px)' },
    variants: {
      size: {
        sm: { padding: '4px' },
        custom: (values: { padding: `${number}px` }) => ({
          padding: values.padding,
        }),
      },
    },
    defaultVariants: { size: { custom: { padding: '12px' } } },
    compoundVariants: [{ when: { size: 'custom' }, style: { color: 'red' } }],
  })
  button({
    size: { custom: { padding: '16px' } },
    conditions: { wide: { size: null } },
  })
}).types([24706, 'instantiations'])
