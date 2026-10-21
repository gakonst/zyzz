/**
 * Measures type instantiations contributed by compiled theme selection.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Runtime from 'zyzz/runtime'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Selection: typeof Runtime.Selection

/** Resolves the shared selection contract before any bench body is measured. */
export function baseline() {
  Selection.create([['base', 'scope']])
}

bench('create / react catalog selection', () => {
  const select = Selection.create([
    ['mint', 'z-mint'],
    ['ocean', 'z-ocean'],
    ['slate', 'z-slate'],
  ])

  void select({ colorScheme: 'dark', set: 'mint' }).className
  void select({ set: 'ocean' }).className
}).types([151, 'instantiations'])

bench('create / html catalog selection', () => {
  const select = Selection.create(
    [
      ['mint', 'z-mint'],
      ['ocean', 'z-ocean'],
    ],
    true,
  )

  void select({ set: 'ocean' }).class
}).types([121, 'instantiations'])
