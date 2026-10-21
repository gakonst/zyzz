---
'zyzz': patch
---

Production builds name contextual and shared atomic rules, grouped rules, recipe classes, and `cx` combinations with short module-scoped names, such as `z_X8T0-w3`, instead of readable paths. Development builds keep readable names. Vite and unplugin builds also add a style's `z-style-*` identity class only when a selector interpolates that style. Explicit style ids keep their identity classes.
