---
'zyzz': patch
---

Added an opacity suffix to color token names. On a color property, `'accent/40'` mixes the `accent` token with `transparent` at 40%, as `color-mix(in srgb, var(--z-color-accent) 40%, transparent)`, so the color follows the active set and scheme. TypeScript checks the token name before the suffix. React Native converts `color-mix(in srgb, color N%, transparent)` to an RGBA hex color for each scheme when `color` is a hex or functional sRGB color.
