// Lightweight probe: every history.replaceState/pushState call is logged so a
// reader can see exactly what vue-router passes as the URL. This is what
// trips Chromium when the document URL contains userinfo (basic-auth creds).
const origReplace = history.replaceState.bind(history)
const origPush = history.pushState.bind(history)
history.replaceState = function (state, title, url) {
  console.warn('[probe] history.replaceState arg url =', JSON.stringify(url),
    '  document.URL =', JSON.stringify(document.URL))
  return origReplace(state, title, url)
}
history.pushState = function (state, title, url) {
  console.warn('[probe] history.pushState arg url =', JSON.stringify(url),
    '  document.URL =', JSON.stringify(document.URL))
  return origPush(state, title, url)
}

import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'

createApp(App).use(router).mount('#app')
