---
'zyzz': patch
---

Production builds fold wrapper components that apply one style, forward `children`, and pass at most the caller's `className`. A use site that passes only `children`, `className`, and `key` renders the host element with the merged class list, through local and imported source modules.
