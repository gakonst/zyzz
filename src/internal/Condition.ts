/** Typed nested selector and condition keys without a general string index. @module */
import type * as Theme from './Theme.js'

/** Concrete suggestions supplement open selector and query patterns. */
export type Suggestions =
  | '::after'
  | '::backdrop'
  | '::before'
  | '::first-letter'
  | '::first-line'
  | '::marker'
  | '::placeholder'
  | '::selection'
  | ':active'
  | ':checked'
  | ':disabled'
  | ':empty'
  | ':enabled'
  | ':first-child'
  | ':focus'
  | ':focus-visible'
  | ':focus-within'
  | ':hover'
  | ':last-child'
  | ':only-child'
  | ':visited'
  | '@container'
  | '@layer'
  | '@media'
  | '@scope'
  | '@starting-style'
  | '@supports'

type Case<text extends string> = text extends `${infer first}${infer rest}`
  ? `${Lowercase<first> | Uppercase<first>}${Case<rest>}`
  : ''

type Media = Case<'all' | 'print' | 'screen'>

/** Explicit scoped selectors and standard conditional rule forms. */
export type Raw =
  | `@${'media' | 'supports' | 'container' | 'scope' | 'layer'}${'\t' | '\n' | '\r' | '\f' | '(' | `/*${string}*/`}${string}`
  | `${string}&${string}`
  | `:${string}`
  | `@document ${string}`
  | '@starting-style'
  | '@scope'
  | '@layer'
  | `@scope (${string}`
  | `@scope to (${string}`
  | `@layer ${string}`
  | `@container scroll-state(${string}`
  | `@container ${string} scroll-state(${string}`
  | `@container not ${string}`
  | `@supports selector(${string}`
  | `@supports ${string}(${string}`
  | `@media (${string}`
  | `@media ${Media}`
  | `@media ${Media} ${string}`
  | `@media ${Media},${string}`
  | `@media ${Case<'only' | 'not'>} ${string}`
  | `@container style(${string}`
  | `@container ${string} style(${string}`
  | `@container (${string}`
  | `@container ${string} (${string}`

type Names<tokens, group extends PropertyKey> = group extends keyof tokens
  ? `${Extract<keyof NonNullable<tokens[group]>, string | number>}`
  : never

type Alias<name extends string> =
  | name
  | `>=${name}`
  | `<${name}`
  | `${name}..${name}`

type Containers<tokens> = tokens extends {
  containerNames: readonly (infer name extends string)[]
}
  ? name
  : never
declare const query: unique symbol
/** Opaque grouping key emitted by a custom-media declaration. */
export type Query = symbol & { readonly [query]: true }

declare const relationship: unique symbol
/** Opaque key returned only by typed relationship authoring helpers. */
export type Relationship = symbol & { readonly [relationship]: true }

/** Keys inferred from the bound theme's own threshold groups. */
export type Keys<
  tokens extends Theme.Tokens = {},
  key extends PropertyKey = never,
> = [key] extends [never]
  ? Static<tokens>
  : symbol extends key
    ? Static<tokens, symbol>
    : Static<tokens, Relationship | Query>

/** The part of `Keys` that depends on the authored keys. */
export type Dynamic<key extends PropertyKey> = [key] extends [never]
  ? never
  : symbol extends key
    ? symbol
    : Relationship | Query

/**
 * The part of `Keys` that depends only on the bound tokens, plus `extra`.
 * The wrapping conditional caches the union by its arguments. A bare union alias is reduced
 * again on every instantiation, which compares each literal against each pattern.
 */
export type Static<tokens extends Theme.Tokens, extra = never> = [
  tokens,
  extra,
] extends [unknown, unknown]
  ?
      | extra
      | Raw
      | `@media ${Alias<Names<tokens, 'breakpoint'>>}`
      | `@container ${Alias<Names<tokens, 'container'>>}`
      | `@container ${Containers<tokens>} ${Alias<Names<tokens, 'container'>>}`
  : never

/** Recognizes structured rule keys before declaration parsing. */
export function is(key: string): boolean {
  if (key.startsWith('--')) return false

  return (
    nested(key) ||
    key.startsWith(':') ||
    ['@starting-style', '@scope', '@layer'].includes(key) ||
    /^@(media|supports|container|scope|layer|document)(?=[\t\n\r\f (]|\/\*)/.test(
      key,
    )
  )
}

/** Detects nesting tokens outside quoted data, comments, and escapes. */
export function nested(key: string): boolean {
  let quote = ''

  for (let index = 0; index < key.length; index++) {
    const char = key[index]!

    if (char === '\\') {
      index++
      continue
    }

    if (quote) {
      if (char === quote) quote = ''

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === '/' && key[index + 1] === '*') {
      const end = key.indexOf('*/', index + 2)
      if (end === -1) return false

      index = end + 1
    } else if (char === '&') return true
  }

  return false
}

/** Normalizes rule whitespace and rejects unbalanced delimiters and unscoped selector lists. */
export function normalize(key: string): string {
  const stack: string[] = []
  let quote = ''
  let output = ''
  let scoped = false
  let list = false

  for (let index = 0; index < key.length; index++) {
    const char = key[index]!

    if (!quote && char === '/' && key[index + 1] === '*') {
      const end = key.indexOf('*/', index + 2)
      if (end === -1) throw new Error('Unterminated condition comment.')

      output += key.slice(index, end + 2).replace(/[\n\r\f]/g, ' ')
      index = end + 1
      continue
    }

    if (char === '\\') {
      const next = key[++index]
      if (next === undefined) throw new Error('Incomplete condition escape.')

      if (next !== '\n' && next !== '\r' && next !== '\f') output += char + next
      else if (next === '\r' && key[index + 1] === '\n') index++

      continue
    }

    if (quote) {
      output += char

      if (char === quote) quote = ''

      continue
    }

    if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') stack.push(char === '(' ? ')' : ']')
    else if (char === ')' || char === ']') {
      if (stack.pop() !== char)
        throw new Error('Unbalanced condition delimiters.')
    } else if (char === '{' || char === '}')
      throw new Error('Unexpected condition block delimiter.')
    else if (char === '&') scoped = true
    else if (char === ',' && !stack.length && !key.startsWith('@')) {
      if (!scoped)
        throw new Error('Selector lists require explicit & selectors.')

      scoped = false
      list = true
    }

    output += /[\n\r\f]/.test(char) ? ' ' : char
  }

  if (quote || stack.length) throw new Error('Unbalanced condition delimiters.')

  if (list && !scoped)
    throw new Error('Selector lists require explicit & selectors.')

  return output
}

/** Identifies conservative same-element selectors for private inline callback variables. */
export function local(key: string): boolean {
  if (key.startsWith('@')) return true

  let nesting = 0
  let quoted = ''

  for (let index = 0; index < key.length; index++) {
    const char = key[index]!

    if (!quoted && char === '/' && key[index + 1] === '*') {
      const end = key.indexOf('*/', index + 2)
      if (end < 0) return false

      index = end + 1
      continue
    }

    if (char === '\\') {
      index++
      continue
    }

    if (quoted) {
      if (char === quoted) quoted = ''

      continue
    }

    if (char === '"' || char === "'") quoted = char
    else if (char === '(' || char === '[') nesting++
    else if (char === ')' || char === ']') nesting--
    else if (char === ',' && !nesting)
      return (
        local(key.slice(0, index).trim()) && local(key.slice(index + 1).trim())
      )
  }

  if (!key.startsWith('&') && (!key.startsWith(':') || nested(key)))
    return false

  let depth = 0
  let quote = ''

  for (let index = 0; index < key.length; index++) {
    const char = key[index]!

    if (!quote && char === '/' && key[index + 1] === '*') {
      const end = key.indexOf('*/', index + 2)
      if (end < 0) return false

      index = end + 1
      continue
    }

    if (char === '\\') {
      index++
      continue
    }

    if (quote) {
      if (char === quote) quote = ''

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (!depth && char === ':' && key[index + 1] === ':') {
      const name = /^::([a-z-]+)/i.exec(key.slice(index))?.[1]?.toLowerCase()
      if (
        !name ||
        ![
          'before',
          'after',
          'first-letter',
          'first-line',
          'marker',
          'placeholder',
          'selection',
        ].includes(name)
      )
        return false
    }

    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth--
    else if (!depth && (/[\s+~>,]/.test(char) || (char === '&' && index !== 0)))
      return false
  }

  return true
}
