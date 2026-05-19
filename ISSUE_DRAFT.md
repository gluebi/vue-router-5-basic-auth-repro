# Issue draft — paste into https://github.com/vuejs/router/issues/new?template=bug_report.yml

**Title**

> `SecurityError` on initial `history.replaceState` when document URL contains userinfo (HTTP basic-auth in URL)

---

### Reproduction

Minimal, no external deps (no Nuxt, no Vuetify): **https://github.com/gluebi/vue-router-5-basic-auth-repro**

```bash
git clone https://github.com/gluebi/vue-router-5-basic-auth-repro.git
cd vue-router-5-basic-auth-repro
docker compose up --build
# wait for "start worker processes" from nginx
```

Then, in a **fresh** Chrome profile (cached basic-auth credentials defeat the repro), open `http://test:test@localhost:8090/`. The repro repo's README explains why a real 401-issuing proxy is required (StackBlitz / CodeSandbox cannot reproduce this — Chromium only retains userinfo in `document.URL` after a real `WWW-Authenticate` challenge, which their hosting proxy doesn't issue).

A second repo, [`gluebi/nuxt-44-basic-auth-repro`](https://github.com/gluebi/nuxt-44-basic-auth-repro), demonstrates the user-visible cascade (`Context conflict`, then `Cannot read properties of undefined (reading 'beforeEach')`) when this `SecurityError` is left unhandled inside a Nuxt boot.

### Steps to reproduce

1. `docker compose up --build` in the repro.
2. Open a fresh Chrome profile (`--user-data-dir=/tmp/repro`).
3. Navigate to `http://test:test@localhost:8090/` (note `test:test@` in the URL).
4. Open DevTools → Console.

### Expected behavior

vue-router's `createWebHistory()` boots cleanly. Console clean. `<RouterLink>` performs client-side navigation.

### Actual behavior

`createWebHistory`'s initial setup calls `history.replaceState(state, '', url)` where `url` is built by `createBaseLocation() + base + to` and `createBaseLocation()` is `location.protocol + '//' + location.host`. `location.host` is `hostname[:port]` and **does not** include userinfo. So the URL passed to `replaceState` looks like `http://localhost:8090/` while the document URL is `http://test:test@localhost:8090/`.

Chromium's `History.replaceState()` security check enforces userinfo equality between the new URL and the current document URL, not just origin equality. The call throws:

```
SecurityError: Failed to execute 'replaceState' on 'History':
  A history state object with URL 'http://localhost:8090/' cannot be
  created in a document with origin 'http://localhost:8090' and URL
  'http://test:test@localhost:8090/'.
```

The throw escapes `useHistoryStateNavigation`'s top-level `if (!historyState.value) { changeLocation(..., true) }` setup. In a plain SPA this leaves `useRouter()` undefined; in Nuxt it cascades into `Context conflict` and `TypeError: Cannot read properties of undefined (reading 'beforeEach')`.

The bug only fires on the **first** navigation that carries userinfo. Once Chrome caches credentials for the host, subsequent visits don't need a 401 → document URL no longer has userinfo → the call succeeds. This is why the bug is intermittent and easily missed during development but bites real users who follow a basic-auth link to a Vue/Nuxt app for the first time.

### Where the URL is built

[`packages/router/src/history/html5.ts`](https://github.com/vuejs/router/blob/v5.0.7/packages/router/src/history/html5.ts):

```ts
// helper
let createBaseLocation = () => location.protocol + '//' + location.host

// inside changeLocation
const url = hashIndex > -1
  ? (location.host && document.querySelector('base') ? base : base.slice(hashIndex)) + to
  : createBaseLocation() + base + to
history[replace ? 'replaceState' : 'pushState'](state, '', url)

// inside useHistoryStateNavigation (runs once at createWebHistory init)
if (!historyState.value) {
  changeLocation(
    currentLocation.value,
    { back: null, current: currentLocation.value, forward: null,
      position: history.length - 1, replaced: true, scroll: null },
    true  // replaceState
  )
}
```

`html5.ts` is byte-identical between `v4.6.4` and `v5.0.7`, but the user-visible regression (verified on the companion Nuxt repro) tracks the vue-router 4 → 5 jump: Nuxt 4.2.x (transitively pulls `vue-router@4.6.4`) does not crash; Nuxt 4.4.x (transitively pulls `vue-router@5.0.7`) does. Pinning `vue-router@5.0.7` back under Nuxt 4.2.2 brings the crash back. So while the offending call site is identical, **something** in the v5 surface area changes the timing or invocation in a way that fires the bug. Suspicion is around the merged `unplugin-vue-router` integration or scroll-position state setup — worth a look from maintainers.

### Additional context

**Suggested fix directions:**

1. **Preserve userinfo when building `url`.** In `createBaseLocation()` (or in `changeLocation`'s URL assembly), if the current document URL carries userinfo, prepend it. The call then no-ops on the userinfo-bearing first navigation.
2. **Wrap the initial-setup `changeLocation(...)` call in its own try/catch.** The existing try/catch inside `changeLocation` falls back to `location[replace ? 'replace' : 'assign'](url)`, but it's possible (per the cascade observed in Nuxt) that the throw is escaping the initial-setup call path — or that the `location.replace(url)` fallback fires a full-page navigation that the host framework can't handle gracefully. Either way, defensively short-circuiting the initial `replaceState` when it would mismatch on userinfo would prevent the cascade.

(1) is the principled fix; (2) hardens against future Chromium-side enforcement tightening.

**Browser scope:** Firefox sanitises userinfo from `document.URL` earlier so the `SecurityError` doesn't fire there — but the underlying logic (building an absolute URL without userinfo) is browser-independent. Chromium-based browsers (Chrome, Edge, Arc, Brave) all exhibit this.

**Prior art in this repo / sibling repo:**

- [`vuejs/router#495`](https://github.com/vuejs/router/issues/495) — closed — `Error with push/replace State DOMException in iframe with data:text/html` (different URL-mismatch trigger, same class of `replaceState` rejection).
- [`vuejs/vue-router#2593`](https://github.com/vuejs/vue-router/issues/2593) (Vue 2 repo) — closed — `replaceState Error when path starts with //`.
- [`vuejs/vue-router#564`](https://github.com/vuejs/vue-router/issues/564) (Vue 2 repo) — historical `pushState & DOM Exception 18`.

These show vue-router has had to guard against the same class of browser rejection before; the fix shape (skip / catch the mismatched `replaceState`, or build a URL the browser will accept) is already in the codebase's vocabulary.
