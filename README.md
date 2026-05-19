# vue-router 5 — `SecurityError` from initial `replaceState` when document URL contains userinfo

Minimal reproduction: a page loaded with HTTP basic-auth credentials embedded in the URL (`http://user:pass@host/`) crashes `createWebHistory()`'s initial `history.replaceState` call with a `SecurityError`.

## Run

```bash
docker compose up --build
# wait for the nginx worker processes to start
```

In DevTools → Console settings, **enable Preserve log** before navigating. Without it, vue-router's `try/catch` falls back to `location.replace` and wipes the console within a frame — you'll only see the page reload itself.

Then open `http://test:test@localhost:8090/`.

## Expected

vue-router's `createWebHistory()` boots cleanly. Console clean. `<RouterLink>` performs client-side navigation.

## Actual

Console (with Preserve log enabled):

```
Navigated to http://test:test@localhost:8090/
SecurityError: Failed to execute 'replaceState' on 'History':
  A history state object with URL 'http://localhost:8090/' cannot be
  created in a document with origin 'http://localhost:8090' and URL
  'http://test:test@localhost:8090/'.
    at i (assets/index-…js)
    at ou (assets/index-…js)
    at lu (assets/index-…js)            ← changeLocation
    at  (assets/index-…js)               ← useHistoryStateNavigation initial setup
Navigated to http://localhost:8090/
```

vue-router calls `history.replaceState(state, '', createBaseLocation() + base + to)` where `createBaseLocation()` returns `location.protocol + '//' + location.host` — no userinfo. The document URL has userinfo. Chromium rejects the mismatch. vue-router's own `try/catch` then runs `location.replace(url)`, navigating the page to the userinfo-less URL — the `Navigated to http://localhost:8090/` line.

**User-visible symptom without Preserve log:** the page silently reloads itself once on first basic-auth-URL access. Any pre-reload client-side state is lost. Subsequent visits use cached credentials → no 401 → document URL has no userinfo → no mismatch → no reload.

## Repo shape

```
.
├── package.json        # vue 3.5.34, vue-router 5.0.7, vite 7.3.3
├── vite.config.js
├── index.html          # inline-probe <script> in <body>
├── src/
│   ├── main.js         # instruments history.replaceState/pushState
│   ├── App.vue         # <RouterView />
│   ├── router.js       # createRouter({ history: createWebHistory(), routes: [...] })
│   └── pages/
│       ├── Home.vue
│       └── About.vue
├── docker-compose.yml  # node-20-alpine builds, nginx-alpine serves dist
└── nginx/
    ├── default.conf    # auth_basic + try_files for SPA
    └── .htpasswd       # test:test (bcrypt)
```

## Why docker-compose + nginx and not StackBlitz

Chromium only retains userinfo in the navigation URL after a real `401 / WWW-Authenticate` challenge from the server. StackBlitz / CodeSandbox preview proxies cannot be configured to issue one, so the bug doesn't reproduce there — a real basic-auth server in front is required.

## Browser scope

Firefox sanitises userinfo from the document URL earlier in its pipeline, so the `SecurityError` doesn't fire there. The bug is observed in Chromium-based browsers (Chrome, Edge, Arc, Brave).
