/** Converts absolute sRGB colors without consulting platform or inherited state. @module */
import * as Literal from '../../internal/Literal.js'

/** Portable native color literals, excluding inherited and wide-gamut colors. */
export type Value =
  | 'transparent'
  | `#${string}`
  | (typeof Literal.namedColors)[number]
  | `${'rgb' | 'rgba' | 'hsl' | 'hsla' | 'hwb'}(${string})`

/**
 * Normalizes functional colors to byte-accurate RGBA hex for native parsers.
 *
 * `color-mix(in srgb, color N%, transparent)` converts when `color` is a hex or functional color.
 */
export function parse(input: string): string | undefined {
  const value = input.trim().toLowerCase()
  if (value === 'transparent') return value
  if (
    /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/.test(value) ||
    (Literal.namedColors as readonly string[]).includes(value)
  )
    return value
  const mix =
    /^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d*)?|\.\d+)%\s*,\s*transparent\s*\)$/.exec(
      value,
    )
  if (mix) {
    const opacity = Number(mix[2])
    const color = parse(mix[1]!)
    if (opacity > 100 || !color) return undefined
    if (color === 'transparent') return color
    if (!color.startsWith('#')) return undefined
    const digits = color.slice(1)
    const full =
      digits.length <= 4
        ? [...digits].map((digit) => digit + digit).join('')
        : digits
    // Premultiplied mixing with `transparent` scales the alpha and keeps the channels.
    const alpha = Math.round(
      (parseInt(full.slice(6, 8) || 'ff', 16) * opacity) / 100,
    )
    return `#${full.slice(0, 6)}${alpha.toString(16).padStart(2, '0')}`
  }
  const match = /^(rgb|rgba|hsl|hsla|hwb)\(([^()]*)\)$/.exec(value)
  if (!match) return undefined
  const family = match[1]!
  const body = match[2]!.trim()
  const legacy = body.includes(',')
  if (legacy && (body.includes('/') || family === 'hwb')) return undefined
  const parts = legacy
    ? body.split(',').map((part) => part.trim())
    : body.split('/').map((part) => part.trim())
  if (
    (!legacy && parts.length > 2) ||
    (legacy && ![3, 4].includes(parts.length))
  )
    return undefined
  const channels = legacy ? parts.slice(0, 3) : parts[0]!.split(/\s+/)
  const alpha = legacy ? parts[3] : parts[1]
  if (channels.length !== 3) return undefined
  const number = (input: string, percentage = false): number | undefined => {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/.test(input))
      return undefined
    if (!percentage && input.endsWith('%')) return undefined
    const value = Number(input.replace(/%$/, ''))
    return Number.isFinite(value) ? value : undefined
  }
  const clamp = (value: number) => Math.max(0, Math.min(1, value))
  const opacity = alpha === undefined ? 1 : number(alpha, true)
  if (opacity === undefined) return undefined
  const a = clamp(opacity / (alpha?.endsWith('%') ? 100 : 1))
  let rgb: readonly number[]
  if (family.startsWith('rgb')) {
    if (
      legacy &&
      channels.some((part) => part.endsWith('%')) &&
      !channels.every((part) => part.endsWith('%'))
    )
      return undefined
    const values = channels.map((part) => number(part, true))
    if (values.some((value) => value === undefined)) return undefined
    rgb = values.map((value, index) =>
      clamp(value! / (channels[index]!.endsWith('%') ? 100 : 255)),
    )
  } else {
    const hue =
      /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(
        channels[0]!,
      )
    if (!hue || !channels[1]!.endsWith('%') || !channels[2]!.endsWith('%'))
      return undefined
    const degrees =
      Number(hue[1]) *
      (hue[2] === 'turn'
        ? 360
        : hue[2] === 'grad'
          ? 0.9
          : hue[2] === 'rad'
            ? 180 / Math.PI
            : 1)
    const second = number(channels[1]!, true)
    const third = number(channels[2]!, true)
    if (
      !Number.isFinite(degrees) ||
      second === undefined ||
      third === undefined
    )
      return undefined
    const h = ((degrees % 360) + 360) % 360
    const s = family === 'hwb' ? 1 : clamp(second / 100)
    const l = family === 'hwb' ? 0.5 : clamp(third / 100)
    const amplitude = s * Math.min(l, 1 - l)
    rgb = [0, 8, 4].map((n) => {
      const k = (n + h / 30) % 12
      return l - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    })
    if (family === 'hwb') {
      const white = clamp(second / 100)
      const black = clamp(third / 100)
      rgb = rgb.map((channel) =>
        white + black >= 1
          ? white / (white + black)
          : channel * (1 - white - black) + white,
      )
    }
  }
  return `#${[...rgb, a]
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}
