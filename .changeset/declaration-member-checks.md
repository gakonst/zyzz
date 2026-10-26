---
'zyzz': patch
---

Improved type-checking performance of `style` and `variants`. Declarations are now checked per key and value, so TypeScript reuses each check across styles: about 25% fewer instantiations, 4x fewer types and a third less memory on a large app. Accepted inputs and diagnostics are unchanged.
