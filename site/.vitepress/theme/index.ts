import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'

export default {
  extends: DefaultTheme,
  enhanceApp() {
    // Replaces the inline script the config strips: shows ⌘ instead of Ctrl in the search hint.
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('mac', /Mac|iPhone|iPod|iPad/i.test(navigator.platform))
    }
  },
} satisfies Theme
