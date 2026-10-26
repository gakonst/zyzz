/**
 * Describes declaration fallbacks and separates importance from scalar values.
 * @module
 */
import type * as Binding from './Binding.js'
import type * as FunctionValue from './FunctionValue.js'
import type * as RuleReference from './RuleReference.js'
import type * as Grid from './Grid.js'
import * as Lexical from './Lexical.js'
import * as Literal from './Literal.js'
import type * as Numeric from './Numeric.js'
import * as Token from './Token.js'

/** Scalar declarations optionally carrying a trailing importance marker. */
export type Atom<value> =
  | value
  | `${Extract<value, string | number>} !important`

/**
 * Accepts canonical and case-insensitive CSS literals without folding token names or emitted data.
 * Checks authored properties and retains validated input types to avoid expanding whole-property fallback unions.
 */
export type Accepted<style, properties> = {
  [property in keyof style]: AcceptedValue<
    style[property],
    property,
    properties
  >
}

type AcceptedValue<value, property extends PropertyKey, properties> =
  Extract<
    value,
    `${string} !custom` | `${string} !custom !important`
  > extends never
    ? AcceptedMember<Record<property, value>, properties>[property]
    : value extends unknown
      ? AcceptedMember<Record<property, value>, properties>[property]
      : never

type AcceptedMember<style, properties> = {
  [property in keyof style]: property extends keyof properties
    ? style[property] extends
        | `${infer value} !custom`
        | `${infer value} !custom !important`
      ? ScalarValue<value, property> extends LiteralAccepted<
          Record<property, ScalarValue<value, property>>,
          Literal.Properties
        >[property]
        ? style[property]
        : never
      : style[property] extends readonly [unknown, ...unknown[]]
        ? AcceptedArray<style[property], property, properties>
        : LiteralAccepted<Pick<style, property>, properties>[property]
    : never
}

type ScalarValue<value, property> =
  value extends `${infer numeric extends number}`
    ? property extends keyof Literal.Properties
      ? number extends Literal.Properties[property]
        ? numeric
        : value
      : value
    : value

type AcceptedArray<values, property extends PropertyKey, properties> = {
  [index in keyof values]: values[index] extends readonly unknown[]
    ? never
    : Accepted<Record<property, values[index]>, properties>[property]
}

type LiteralAccepted<style, properties> = {
  [property in keyof style]: property extends keyof properties
    ? style[property] extends { readonly [Token.scalar]: infer scalar }
      ? property extends keyof Literal.Properties
        ? [scalar] extends [Literal.Properties[property]]
          ? style[property] & Checked<Record<property, scalar>>[property]
          : never
        : never
      : References<style[property], Exclude<properties[property], undefined>> &
          (style[property] extends Binding.Reference
            ? Binding.Reference<style[property]['type']> extends Exclude<
                properties[property],
                undefined
              >
              ? style[property]
              : never
            : FunctionValue.Is<style[property]> extends true
              ? FunctionValue.Accepted<
                  style[property],
                  Exclude<properties[property], undefined>,
                  property
                >
              : Exclude<style[property], undefined> extends Exclude<
                    properties[property],
                    undefined
                  >
                ? Exclude<style[property], undefined>
                : property extends keyof Literal.Properties
                  ? style[property] extends
                      | string
                      | readonly (number | string)[]
                    ? Fold<style[property]> extends Input<
                        | Lowercase<
                            Extract<Literal.Properties[property], string>
                          >
                        | Extract<Literal.Properties[property], number>
                      >
                      ? style[property]
                      : Exclude<properties[property], undefined>
                    : Exclude<properties[property], undefined>
                  : Exclude<properties[property], undefined>)
    : never
}

type References<value, allowed> = value extends Token.Reference
  ? value extends Extract<allowed, Token.Reference>
    ? unknown
    : never
  : value extends readonly unknown[]
    ? { [key in keyof value]: References<value[key], allowed> }
    : unknown

type Fold<value> = value extends string
  ? Lexical.Fold<Canonical<Spaces<Normalized<Lexical.Normalized<value>>>>>
  : value extends readonly unknown[]
    ? { [key in keyof value]: Fold<value[key]> }
    : value

/** Refines concrete scalar spellings; already-broad property contracts need no literal refinement. */
export type Checked<style, tokens = {}> = {
  [property in keyof style]: style[property] extends
    | `${infer value} !custom`
    | `${infer value} !custom !important`
    ? value extends `${string} !${'custom' | 'important'}`
      ? never
      : LiteralChecked<Record<property, ScalarValue<value, property>>>[property]
    : style[property] extends readonly [unknown, ...unknown[]]
      ? CheckedArray<style[property], property, tokens>
      : LiteralChecked<Record<property, style[property]>, tokens>[property]
}

type LiteralChecked<style, tokens = {}> = {
  [property in keyof style]: style[property] extends string & Binding.Reference
    ? style[property] extends Binding.Reference<'*'>
      ? unknown
      : Checked<
          { [key in property]: Binding.Reference<style[property]['type']> },
          tokens
        >[property]
    : Literal.Properties extends style
      ? unknown
      : Importance<style[property]> &
          RuleReference.Check<style[property], property> &
          (property extends keyof typeof Literal.rules
            ? style[property] extends (property extends
                | 'gridArea'
                | 'gridColumn'
                | 'gridColumnEnd'
                | 'gridColumnStart'
                | 'gridRow'
                | 'gridRowEnd'
                | 'gridRowStart'
                ? Fold<style[property]> extends Grid.Checked<
                    Fold<style[property]>,
                    property extends 'gridArea'
                      ? 4
                      : property extends 'gridColumn' | 'gridRow'
                        ? 2
                        : 1
                  >
                  ? unknown
                  : never
                : unknown) &
                Check<
                  style[property],
                  Token.Names<tokens, property>,
                  (typeof Literal.rules)[property]
                >
              ? unknown
              : never
            : unknown)
}

type CheckedArray<values, property extends PropertyKey, tokens> = {
  [index in keyof values]: Checked<
    Record<property, values[index]>,
    tokens
  >[property]
}

/** Lists the values a token-constrained property accepts, so mismatch diagnostics name them. */
export type Mismatch<tokens, property extends keyof Literal.Properties> =
  // Resolving through a conditional prints the expected values instead of this alias's arguments.
  tokens extends unknown
    ? Expected<
        | Extract<Token.Names<tokens, property>, string>
        | NumericNames<Token.Names<tokens, property>>
        | `${string} !custom`
      >
    : never

/** Lists the named sets a property accepts, so mismatch diagnostics name them. */
export type Unmatched<names> =
  // Without configured names the property is unknown, and `never` reports it as such.
  [names] extends [never] ? never : Expected<names>

// An object brand never reduces with a string literal, so the diagnostic keeps the expected values.
type Expected<values> = { readonly [expected]: values }

declare const expected: unique symbol

type NumericNames<names> = names extends `${infer value extends number}`
  ? value
  : never

/** Requires tokens for properties with configured values. */
export type Tokens<
  value,
  tokens,
  property extends keyof Literal.Properties,
> = property extends `--${string}`
  ? unknown
  : [Token.Names<tokens, property>] extends [never]
    ? unknown
    : value extends readonly unknown[]
      ? { [index in keyof value]: Tokens<value[index], tokens, property> }
      : value extends
            | Binding.Reference
            | Token.Reference
            | Token.Variable
            | `${Token.Variable} !important`
            | `${string} !custom`
            | `${string} !custom !important`
        ? unknown
        : value extends Atom<Token.Names<tokens, property>>
          ? unknown
          : value extends number
            ? `${value}` extends Token.Names<tokens, property>
              ? unknown
              : never
            : never

type Importance<value> = value extends readonly unknown[]
  ? { [key in keyof value]: Importance<value[key]> }
  : value extends `${infer body}!${infer suffix}`
    ? body extends `${string}\\`
      ? unknown
      : Lowercase<TrimStart<Trim<Lexical.Normalized<suffix>>>> extends
            | ''
            | 'important'
        ? value extends `${string} !important`
          ? unknown
          : never
        : unknown
    : unknown

type Check<input, names, rule> =
  FunctionValue.Is<input> extends true
    ? input
    : input extends readonly unknown[]
      ? { [key in keyof input]: Check<input[key], names, rule> }
      : input extends names
        ? input
        : input extends string
          ? Plain<input> extends names
            ? input
            : Literal.Checked<
                  Lexical.Fold<Plain<Normalized<Lexical.Normalized<input>>>>
                > extends never
              ? never
              : Scalar<
                    Lexical.Fold<Plain<Normalized<Lexical.Normalized<input>>>>,
                    rule
                  > extends never
                ? never
                : input
          : Scalar<input, rule>

type Scalar<input, rule> = number extends input
  ? input
  : input extends number | `${number}`
    ? Numeric.Checked<
        input,
        rule extends { integer: true } ? true : false
      > extends never
      ? never
      : Range<input, rule>
    : input extends `${infer amount}${Literal.Unit | 'ms' | 's'}`
      ? Range<amount, rule> extends never
        ? never
        : input
      : input

type Range<input, rule> = rule extends
  | { kind: 'number' | 'percentage'; min: 0 | 1 }
  | { negative: false }
  ? input extends number | string
    ? `${input}` extends `-${string}`
      ? Numeric.Zero<input> extends true
        ? rule extends { kind: 'number'; min: 1 }
          ? never
          : input
        : never
      : rule extends { kind: 'number'; min: 1 }
        ? Numeric.Zero<input> extends true
          ? never
          : input
        : input
    : input
  : input

type Canonical<value extends string> = value extends `${infer body}!important`
  ? `${Zeros<body>}!important`
  : Zeros<value>

type Zeros<value extends string> =
  value extends `${infer before} ${infer after}`
    ? `${Zeros<before>} ${Zeros<after>}`
    : value extends `${infer before}/${infer after}`
      ? `${Zeros<before>}/${Zeros<after>}`
      : value extends `${infer before},${infer after}`
        ? `${Zeros<before>},${Zeros<after>}`
        : Zero<value>

type Zero<value extends string> = [Numeric.Checked<value>] extends [never]
  ? value
  : Numeric.Zero<value> extends true
    ? '0'
    : value

type Replace<
  value extends string,
  character extends string,
  output extends string = '',
> = value extends `${infer before}${character}${infer after}`
  ? Replace<after, character, `${output}${before} `>
  : `${output}${value}`

type Collapse<value extends string> =
  value extends `${infer before}  ${infer after}`
    ? Collapse<`${before} ${after}`>
    : value

type Spaces<value extends string> = Collapse<
  Replace<Replace<Replace<Replace<value, '\t'>, '\r'>, '\n'>, '\f'>
>

type Normalized<value extends string> =
  TrimStart<Trim<value>> extends infer text extends string
    ? text extends `${infer body}!${infer suffix}`
      ? Lowercase<TrimStart<Trim<suffix>>> extends '' | 'important'
        ? `${Trim<body>} !important`
        : `${body}!${Normalized<suffix>}`
      : text
    : never

type TrimStart<value extends string> =
  value extends `${' ' | '\n' | '\r' | '\t' | '\f'}${infer body}`
    ? TrimStart<body>
    : value

type Plain<value extends string> = value extends `${infer body}!${infer suffix}`
  ? Lowercase<suffix> extends '' | 'important'
    ? Trim<body>
    : `${body}!${Plain<suffix>}`
  : value

type Trim<value extends string> =
  value extends `${infer body}${' ' | '\n' | '\r' | '\t' | '\f'}`
    ? Trim<body>
    : value

/** One atom or a nonempty ordered sequence of declaration fallback atoms. */
export type Fallbacks<atom> = atom | readonly [atom, ...atom[]]

/** One declaration or a nonempty ordered sequence of declaration fallbacks. */
export type Input<value> = Fallbacks<Atom<Exclude<value, undefined>>>

/** Splits trailing custom and importance markers without interpreting quoted or escaped text. */
export function parse(
  input: unknown,
  property: keyof Literal.Properties,
):
  | { invalid: true }
  | {
      custom?: true
      important: boolean
      value: number | string | Token.Expression
    }
  | undefined {
  if (Token.isExpression(input)) {
    const text = input.parts
      .map((part) => (typeof part === 'string' ? part : 'var(--z)'))
      .join('')
    const parsed = parse(text, property)
    if (!parsed || 'invalid' in parsed) return parsed
    if (typeof parsed.value === 'object') return undefined

    const parts = [...input.parts]
    let remaining = text.length - String(parsed.value).length

    for (let index = parts.length - 1; remaining > 0 && index >= 0; index--) {
      const part = parts[index]
      if (typeof part !== 'string') return undefined

      const count = Math.min(remaining, part.length)

      parts[index] = part.slice(0, part.length - count)
      remaining -= count
    }

    return {
      ...(parsed.custom ? { custom: true } : {}),
      important: parsed.important,
      value: Token.compose(parts.filter((part) => part !== '')),
    }
  }

  if (typeof input !== 'string') return undefined

  const valueText = input

  function escaped(index: number): boolean {
    let count = 0

    while (index > 0 && valueText[index - 1] === '\\') {
      count++
      index--
    }

    return count % 2 === 1
  }

  let marker = input.lastIndexOf('!')

  while (marker >= 0) {
    const suffix = Lexical.normalize(input.slice(marker + 1)).replace(
      /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g,
      '',
    )

    if (
      !escaped(marker) &&
      (suffix === '' || suffix === 'important' || suffix === 'custom')
    )
      break

    marker = marker === 0 ? -1 : input.lastIndexOf('!', marker - 1)
  }

  if (marker < 0) return undefined
  const suffix = input.slice(marker - 1)
  if (
    (suffix !== ' !important' && suffix !== ' !custom') ||
    escaped(marker - 1)
  )
    return { invalid: true }

  let end = marker
  while (end > 0 && /[ \t\n\r\f]/.test(input[end - 1]!) && !escaped(end - 1))
    end--

  const body = input.slice(0, end)
  if (!body) return { invalid: true }
  const nested = parse(body, property)
  if (nested && 'invalid' in nested) return nested
  const custom = suffix === ' !custom'
  if (nested && (custom || nested.important)) return { invalid: true }

  return {
    ...(custom || nested?.custom ? { custom: true } : {}),
    important: !custom,
    value: nested?.value ?? scalar(body),
  }

  function scalar(text: string): number | string {
    const numeric =
      Literal.rule(property)?.kind === 'number' ||
      Literal.rule(property)?.kind === 'grid-line'
    return numeric && /^[+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(text)
      ? Number(text)
      : text
  }
}
