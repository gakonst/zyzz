/**
 * Measures type instantiations contributed by public source extraction.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Compiler from 'zyzz/compiler'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const Source: typeof Compiler.Source

/** Resolves the shared extraction contract before any bench body is measured. */
export function baseline() {
  Source.extract({ moduleId: 'base.ts', source: '' })
}

bench('extract / styles, calls, and themes', () => {
  const result = Source.extract({
    moduleId: 'example/card.ts',
    source: "import { style } from 'zyzz'",
  })

  void result.calls[0]?.name
  void result.styles.styles[0]?.declarations
  void result.vars.base?.className
}).types([42, 'instantiations'])
