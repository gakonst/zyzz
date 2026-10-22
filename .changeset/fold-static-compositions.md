---
'zyzz': patch
---

Wrapper folding now covers wrappers that spread a `cx` of unconditional styles, and production modules drop local wrappers whose every use folded, together with any style namespace only they read.
