/** Measures native compiler and lookup inference through public types. @module */
import { bench } from '@ark/attest'
import type * as Zyzz from 'zyzz'
import type * as Native from 'zyzz/react-native'

declare const Style: typeof Zyzz.Style
declare const StyleSheet: typeof Native.StyleSheet
declare const styles: Zyzz.Style.Definition<'card' | 'label'>
declare const set: Zyzz.Vars.Definition

/** Warms the common native authoring and table contracts. */
export function baseline() {
  StyleSheet.compile({ styles })
  Style.define({ base: { targets: { native: { opacity: 1 } } } })
}

bench('native / compile and select named tables', () => {
  const output = StyleSheet.compile({
    styles,
    vars: { alternate: set, base: set },
  })
  StyleSheet.select(output.styles, { colorScheme: 'dark', set: 'alternate' })
}).types([341, 'instantiations'])

bench('native / compose compiled styles', () => {
  const output = StyleSheet.compile({ styles })
  StyleSheet.flatten(
    StyleSheet.compose(output.styles.default.dark.card, { opacity: 0.5 }),
  )
}).types([296, 'instantiations'])

bench('native / structured target authoring', () => {
  StyleSheet.compile({
    platform: 'ios',
    styles: Style.define({
      card: {
        opacity: 0.5,
        targets: {
          web: { display: 'grid' },
          native: {
            transform: [{ rotate: '45deg' }, { translateX: 12 }],
            fontVariant: ['tabular-nums'],
          },
          ios: { shadowOffset: { width: 1, height: 2 } },
          android: { elevation: 4 },
        },
      },
    }),
  })
}).types([20869, 'instantiations'])
