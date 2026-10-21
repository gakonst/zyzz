---
'zyzz': patch
---

Compiled applications are cheaper. `styles.card()` spread into JSX becomes a `className` attribute, and `styles.card({ className })` joins classes without allocating a props callable. Unconditional recipes compile to an inline selector, so React bundles no longer include the `Recipe` and `Html` runtime helpers. Unused definitions are marked pure and tree-shake.
