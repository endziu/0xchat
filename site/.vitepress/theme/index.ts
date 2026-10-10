import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'

export default {
  extends: DefaultTheme,
  // A plain <a>: VitePress rewrites nav links under the /docs/ base, which
  // turns /chat into /docs/chat.html. `target` keeps its client router from
  // intercepting the click as a docs page.
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-content-after': () => h('a', { class: 'app-link', href: '/chat', target: '_self' }, 'Open 0xChat'),
  }),
  enhanceApp() {
    // Replaces the inline script the config strips: shows ⌘ instead of Ctrl in the search hint.
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('mac', /Mac|iPhone|iPod|iPad/i.test(navigator.platform))
    }
  },
} satisfies Theme
