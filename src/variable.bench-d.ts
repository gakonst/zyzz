/**
 * Measures type instantiations contributed by public variable contracts.
 * @module
 */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'

// Type-only imports keep the fixture free of runtime module loading; attest
// analyzes bench bodies without executing them.
declare const style: typeof Zyzz.style
declare const variable: typeof Zyzz.variable

/** Resolves the shared authoring contracts before any bench body is measured. */
export function baseline() {
  void { ...{ base: variable('length') }['base'].set('1px') }
}

bench('define / shorthand kinds', () => {
  const slots = {
    amount: variable('percentage'),
    count: variable('number'),
    signed: variable('signedLength'),
    size: variable('length'),
  }

  void {
    ...slots['amount'].set('50%'),
    ...slots['signed'].set('-12px'),
    ...slots['size'].set('12px'),
  }
}).types([2653, 'instantiations'])

bench('define / registered descriptors', () => {
  void {
    amount: variable('percentage', { inherits: false, initialValue: '0%' }),
    gap: variable('length', { inherits: true, initialValue: '4px' }),
    offset: variable('signedLength', { inherits: false, initialValue: '-1px' }),
  }
}).types([29399, 'instantiations'])

bench('define / declaration references', () => {
  const slots = {
    count: variable('number'),
    signed: variable('signedLength'),
    size: variable('length'),
  }

  style({ marginLeft: slots.signed, opacity: slots.count, padding: slots.size })
}).types([44260, 'instantiations'])

bench('define / untyped references', () => {
  const value = variable()

  style({ display: value, boxShadow: value, zIndex: value })
  value.set('inline-flex')
  value.set(42)
}).types([115569, 'instantiations'])
