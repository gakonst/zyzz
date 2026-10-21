---
'zyzz': patch
---

Fixed `zyzz/vite` development stylesheet updates that Vite 8.3 clients ignored, so a style edit now applies without a reload. Development compiles also read only each module's own import closure, batch modules that arrive together, and start import lookups concurrently, so an edit or a newly loaded module no longer recompiles and invalidates the whole project.
