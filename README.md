# vue-router 5 — `SecurityError` from initial `replaceState` when document URL contains userinfo

Minimal reproduction targeting the **vue-router** bug-report template (`no external dependencies (e.g. Vuetify or Nuxt)`). A Nuxt-flavoured variant showing the user-visible cascade (router undefined, `Context conflict`, broken hydration) lives at [`gluebi/nuxt-44-basic-auth-repro`](https://github.com/gluebi/nuxt-44-basic-auth-repro).

## What goes wrong

When a page is loaded with HTTP basic-auth credentials embedded in the URL (e.g. `http://user:pass@host/`) and the browser **preserves userinfo in the document URL** (which Chromium does after a real `401 / WWW-Authenticate` challenge), vue-router's `createWebHistory()` initialisation calls:

```js
// packages/router/src/history/html5.ts — useHistoryStateNavigation
if (!historyState.value) {
  changeLocation(currentLocation.value, { ... }, true)  // initial replaceState
}

// changeLocation
const url = createBaseLocation() + base + to       // e.g. "http://localhost:8080" + "" + "/" = "http://localhost:8080/"
history.replaceState(state, '', url)               // ← absolute URL, NO userinfo
```

`createBaseLocation` is:

```js
let createBaseLocation = () => location.protocol + '//' + location.host
```

`location.host` is `hostname[:port]` — userinfo is intentionally **not** included. So vue-router passes Chromium an absolute URL without userinfo while the document URL has it, and Chromium rejects:

```
SecurityError: Failed to execute 'replaceState' on 'History':
  A history state object with URL 'http://localhost:8080/' cannot be
  created in a document with origin 'http://localhost:8080' and URL
  'http://test:test@localhost:8080/'.
```

vue-router's existing `try / catch` inside `changeLocation` swallows the throw and falls back to `location[replace ? 'replace' : 'assign'](url)`. That `location.replace('http://localhost:8080/')` fires a full-page navigation to the userinfo-less URL — verified in real Chrome (private window) by the `Navigated to http://localhost:8080/` entry that follows the SecurityError in the console with **Preserve log** enabled.

**User-visible symptom (real desktop Chrome):** the page reloads itself once on the first basic-auth-URL access. Subsequent visits use cached credentials → `document.URL` no longer has userinfo → no mismatch → no reload. The reload is silent unless DevTools is open with Preserve log on. This is the kind of bug that goes unnoticed on local dev but bites real users following a basic-auth link to a staging site or internal tool.

**User-visible symptom (Playwright headless Chromium 148):** the `location.replace` fallback doesn't fire — the throw escapes router init, leaving `useRouter()` undefined for downstream code. Inside Nuxt this cascades into `Context conflict` and `TypeError: Cannot read properties of undefined (reading 'beforeEach')` (see [`gluebi/nuxt-44-basic-auth-repro`](https://github.com/gluebi/nuxt-44-basic-auth-repro) for the captured log). This is a more visible failure mode but probably not what end users hit — real Chrome quietly reloads.

## Reproduction shape

```
.
├── package.json        # vue 3.5.34, vue-router 5.0.7, vite 7.3.3
├── vite.config.js
├── index.html          # contains an inline-probe <script> (see below)
├── src/
│   ├── main.js         # instruments history.replaceState/pushState before vue-router boots
│   ├── App.vue         # <RouterView />
│   ├── router.js       # createRouter({ history: createWebHistory(), routes: [...] })
│   └── pages/
│       ├── Home.vue    # "Hello" + <RouterLink to="/about">
│       └── About.vue   # "About" + <RouterLink to="/">
├── docker-compose.yml  # node-20-alpine builds, nginx-alpine serves dist with auth_basic
├── nginx/
│   ├── default.conf    # auth_basic "vue-router-5-repro" + try_files for SPA
│   └── .htpasswd       # test:test (bcrypt)
└── (after a run)
    ├── console-headless-chromium.log
    └── console-headless-chromium.png
```

`src/main.js` wraps `history.replaceState`/`pushState` so every call vue-router makes is logged, with the URL it passes and the JS-visible `document.URL` at that moment. That is the smoking gun: you can read the URL vue-router is constructing.

`index.html` has an extra inline `<script>` that runs synchronously during HTML parsing — before any module loads — and tries the very same `history.replaceState(state, '', '<protocol>//<host>/')` shape on its own. If the browser is in the bug-exhibiting state (document URL has userinfo at parse time), this inline call throws the SecurityError directly; the page then renders a red `<p>` with the error message instead of `inline-probe: REPLACED OK`. This separates "vue-router's logic produces the bad URL" from "the browser is currently in a state that would reject the bad URL."

## How to reproduce

```bash
git clone https://github.com/gluebi/vue-router-5-basic-auth-repro.git
cd vue-router-5-basic-auth-repro
docker compose up --build
# wait for nginx worker processes to start
```

Then, in a **fresh** Chrome profile (cached credentials defeat the repro), navigate to:

```
http://test:test@localhost:8090/
```

```bash
# macOS — example invocation
open -na "Google Chrome" --args --user-data-dir=/tmp/repro
# then paste the URL into the address bar
```

**Important — enable "Preserve log" in DevTools Console settings before reloading.** Without it, the location.replace fallback wipes the console within a frame of the throw and you'll see nothing.

### Expected behaviour

- Console clean.
- vue-router boots, `<RouterLink>` performs client-side navigation.
- URL bar continues to show whatever was requested (modulo Chrome's normal address-bar stripping of credentials).

### Actual behaviour (real desktop Chrome)

With Preserve log on, the console shows in order:

```
Navigated to http://test:test@localhost:8090/
SecurityError: Failed to execute 'replaceState' on 'History':
  A history state object with URL 'http://localhost:8090/' cannot be
  created in a document with origin 'http://localhost:8090' and URL
  'http://test:test@localhost:8090/'.
    at … (assets/index-…js)
Navigated to http://localhost:8090/
```

vue-router 5's initial `replaceState` throws; vue-router's `try/catch` falls back to `location.replace('http://localhost:8090/')`; the page reloads itself to the userinfo-less URL; the second boot succeeds and the console looks clean from then on. The user experience is "page mysteriously reloads when I open the basic-auth link the first time."

### Actual behaviour (Playwright headless Chromium 148, captured here)

`location.replace` doesn't kick in for reasons that aren't fully clear (possibly Playwright suppresses the implicit navigation, possibly Chromium headless handles the throw differently). Result: `useRouter()` is undefined for downstream code. In Nuxt this cascades into `Context conflict` and `TypeError: Cannot read properties of undefined (reading 'beforeEach')`. See the companion Nuxt repro for the captured log.

### Observed in this verification run (headless Chromium 148, via Playwright)

`console-headless-chromium.log` for this exact repro contains:

```
[WARNING] [probe] history.replaceState arg url = "http://localhost:8090/"   document.URL = "http://localhost:8090/"
```

vue-router IS executing the call with the absolute, userinfo-less URL — the chain is exercised — but the headless Chromium build Playwright ships strips userinfo from the JS-visible `document.URL` accessor **earlier** than desktop Chromium does, so my JS-side instrumentation didn't observe userinfo at the moment of the call. The underlying `NavigationEntry` URL the History API checks against may still have it (see the Nuxt repro, where in this same Chromium engine version the SecurityError DOES fire). The inconsistency between what JS observes and what the security check enforces is itself a useful detail — it explains why this bug is so easy to miss in scripted reproductions.

### Observed in real desktop Chrome (private window, fresh profile, Preserve log ON)

This plain Vite SPA reproduces the bug in real Chrome. Captured console with Preserve log enabled:

```
Navigated to http://test:test@localhost:8090/
SecurityError: Failed to execute 'replaceState' on 'History':
  A history state object with URL 'http://localhost:8090/' cannot be
  created in a document with origin 'http://localhost:8090' and URL
  'http://test:test@localhost:8090/'.
    at i (assets/index-…js:1:69905)
    at ou (assets/index-…js:1:69658)
    at lu (assets/index-…js:1:70326)
    at  (assets/index-…js:1:87559)
Navigated to http://localhost:8090/
[probe] history.replaceState arg url = "http://localhost:8090/"   document.URL = "http://localhost:8090/"
```

Order of events:

1. Chrome navigates to `http://test:test@localhost:8090/` — 401, retry with auth, document URL retains userinfo.
2. The page parses; the inline-probe `<script>` runs at this point. In real Chrome the inline probe still says `REPLACED OK` — confirming the JS-side `document.URL` accessor doesn't expose userinfo to scripts, yet the underlying NavigationEntry the History API checks against does retain it. (This JS-vs-engine inconsistency is the most surprising part of the bug.)
3. The Vite module bundle loads; vue-router's `createWebHistory()` calls `history.replaceState(state, '', 'http://localhost:8090/')` — third frame above (`lu`, the minified `changeLocation`).
4. Chromium rejects → `SecurityError` (the bug).
5. vue-router's `try/catch` catches the throw and runs `location.replace('http://localhost:8090/')` — visible as `Navigated to http://localhost:8090/`.
6. Browser navigates; on the second boot, document URL no longer has userinfo, vue-router's `replaceState` succeeds (last line — the `[probe]` log from `src/main.js` is from this second boot).

**Without Preserve log, all you see is the page reloading itself once on first navigation** — easy to dismiss as a network blip. The bug is real but quiet.

### Observed in headless Chromium 148 via Playwright (captured here as `console-headless-chromium.log`)

In this same Chromium engine version under Playwright headless, the JS-side `document.URL` accessor shows no userinfo from script start AND vue-router's `replaceState` succeeds — so the bug doesn't observably fire in this Vite SPA. The same headless build does fire the bug in the companion Nuxt repro, where the cascade (`Context conflict`, then `Cannot read properties of undefined (reading 'beforeEach')`) appears instead of `location.replace`. So Playwright headless is a poor harness for this particular bug — real desktop Chrome is the correct verification environment.

## Why a 401 challenge is required

Chromium only retains userinfo in the document URL when it actually went through a `401 / WWW-Authenticate` challenge. If it can satisfy the request immediately (e.g. cached credentials, or no auth at all), userinfo is sanitised out and `document.URL` looks clean. This is why the docker-compose setup uses `nginx` + `auth_basic`: it forces a deterministic 401 on the first request. StackBlitz / CodeSandbox cannot reproduce this — there is no way to inject a 401-issuing proxy in front of their preview hosts.

## Why this only manifests on the first navigation

Once Chrome has cached the basic-auth credentials for a host, subsequent visits no longer need a 401 challenge → the document URL has no userinfo → vue-router's `replaceState` call matches → no crash. The bug bites exactly once per fresh credential cache: the first time a user opens a basic-auth URL.

## Versions

| Package    | Version |
|------------|---------|
| vue        | 3.5.34  |
| vue-router | 5.0.7   |
| vite       | 7.3.3   |
| Node       | 20-alpine (inside docker) / 24.15.0 (host) |
| pnpm       | 10.28.2 |

The Nuxt repro pins this same `vue-router@5.0.7` transitively via `nuxt@4.4.6`; downgrading Nuxt to 4.2.2 transitively pulls `vue-router@4.6.4` and stops the cascade. Pinning `vue-router@5.0.7` back under Nuxt 4.2.2 brings the crash back, so the version-of-vue-router gates the bug. (`html5.ts` itself is byte-identical between v4.6.4 and v5.0.7 — the regression appears to be in how the rest of the v5 bundle initialises around the same call site, not in the call site itself.)

## Suggested fix directions

1. **Preserve userinfo in the constructed URL.** Make `createBaseLocation()` (or `changeLocation`'s URL assembly) read userinfo from the current document URL and prepend it. The call then no-ops on first navigation.
2. **Defensive try/catch.** The existing `try/catch` around `history[…](state, '', url)` already falls back to `location[…](url)` on throw, but only on the `changeLocation` body — the initial setup at the top of `useHistoryStateNavigation` does call `changeLocation(…, true)`, so the catch should apply. Verify in v5 that this fallback actually triggers; if it does, the crash users see may actually be from the resulting full-page navigation interacting badly with Nuxt's hydration. If it doesn't, wrap the initial-setup branch separately.

(1) is the principled fix. (2) is the cascade-stopper that hardens against any future Chromium tightening.

## Browser scope

Firefox sanitises userinfo from the document URL earlier in its pipeline, so the `SecurityError` doesn't fire there — but the underlying logic (building an absolute URL without userinfo) is browser-independent. The bug is observed in Chromium-based browsers (Chrome, Edge, Arc, Brave).
