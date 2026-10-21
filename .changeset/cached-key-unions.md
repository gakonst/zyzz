---
'zyzz': patch
---

Improved type-checking performance of `style` and `variants`. Reserved-key and condition-key unions are now cached per token set instead of being rebuilt for every declaration, so repeated calls against a configured theme check several times faster. Accepted inputs and diagnostics are unchanged.
