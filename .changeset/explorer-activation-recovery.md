---
'@odxjs/nuxt': patch
'@odxjs/explorer': patch
---

Start the repository Explorer when its DevTools tab is first opened. Fix root-host startup returning 404 despite a ready child process, preserve failed terminal diagnostics with explicit retry, and isolate each host's development build/cache. Prepare graph and Nuxt UI dependencies before client navigation to avoid discovery reloads and excessive development module requests. Installed packages continue to serve the prebuilt client directly.
