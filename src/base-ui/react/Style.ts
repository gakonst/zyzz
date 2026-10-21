/** Component-aware static declarations layered over ordinary style overloads. @module */
import type * as Completion from '../../internal/Completion.js'
import type * as Condition from '../../internal/Condition.js'
import type * as Configuration from '../../internal/Configuration.js'
import type * as Shorthands from '../../internal/Shorthands.js'
import type * as Theme from '../../internal/Theme.js'
import type * as Types from './internal/Types.generated.js'
import * as Authoring from './internal/Authoring.js'
import { style as rootStyle } from '../../styleFunction.js'

type MarkerKeys<marker> = {
  [key in keyof marker]-?: true extends marker[key] ? key : never
}[keyof marker]

type Keys<input> = input extends { readonly [Types.part]?: infer marker }
  ? MarkerKeys<marker>
  : never

type Identity<component> = component extends (props: infer props) => unknown
  ? Extract<Keys<component> | Keys<props>, keyof Types.Parts>
  : never

type Hints<
  part extends keyof Types.Parts,
  tokens extends Theme.Tokens,
> = Completion.Properties<tokens> & {
  readonly selectors?: {
    readonly [selector in keyof Types.Selectors[part]]?: Hints<part, tokens>
  } & Readonly<Record<string, Hints<part, tokens>>>
  readonly states?: Types.States<Hints<part, tokens>>[part]
} & {
  readonly [key in Condition.Keys<tokens> | Condition.Suggestions]?: Hints<
    part,
    tokens
  >
}

type Body<
  input,
  part extends keyof Types.Parts,
  tokens extends Theme.Tokens,
  layers extends string,
  mappings extends Shorthands.Map,
> = {
  readonly [key in keyof input]: key extends 'states'
    ? {
        readonly [name in keyof input[key]]: name extends keyof Types.States<true>[part]
          ? NonNullable<Types.States<true>[part][name]> extends true
            ? Body<input[key][name], part, tokens, layers, mappings>
            : {
                readonly [value in keyof input[key][name]]: value extends keyof NonNullable<
                  Types.States<true>[part][name]
                >
                  ? Body<
                      input[key][name][value],
                      part,
                      tokens,
                      layers,
                      mappings
                    >
                  : never
              }
          : never
      }
    : key extends 'selectors'
      ? {
          readonly [selector in keyof input[key]]: Body<
            input[key][selector],
            part,
            tokens,
            layers,
            mappings
          >
        }
      : key extends Configuration.Nested<tokens, key, layers>
        ? Body<input[key], part, tokens, layers, mappings>
        : Configuration.Body<Pick<input, key>, tokens, layers, mappings>[key]
}

/** Component-first static overload. Ordinary style overloads remain available. */
export type Factory<
  tokens extends Theme.Tokens = {},
  layers extends string = never,
  mappings extends Shorthands.Map = {},
> = {
  <const component, const input extends Record<string, unknown>>(
    component: component &
      ([Identity<NoInfer<component>>] extends [never] ? never : unknown),
    styles: input &
      NoInfer<Body<input, Identity<component>, tokens, layers, mappings>> &
      Hints<Identity<NoInfer<component>>, tokens>,
    options?: rootStyle.DefinitionOptions,
  ): rootStyle.ReturnType
}

/**
 * Declares styles for an imported Base UI part, or ordinary token-free styles.
 * Component-first calls accept static objects. `states` checks documented attributes,
 * while `selectors` suggests those attributes and accepts arbitrary CSS selectors.
 * Compilation resolves component imports and emits CSS ahead of time. No component
 * wrapper, registration, or runtime CSS insertion is required.
 * @see https://base-ui.com/react/handbook/styling
 */
export const style: typeof rootStyle & Factory = Authoring.bind(
  rootStyle as Authoring.bind.Factory,
) as typeof rootStyle & Factory
