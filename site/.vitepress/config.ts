import { defineConfig } from 'vitepress'

// Served by the app's own server at /docs/, on the same origin as the app.
// The app's CSP allows no inline scripts, so nothing here may emit one:
// `appearance: false` drops the dark-mode script (the dark class is added to
// the static HTML instead), `metaChunk` moves the site data out of the HTML,
// and the theme's always-on macOS check moves into theme/index.ts. A server
// test checks the built pages.
export default defineConfig({
  title: '0xChat Docs',
  description: 'How to use 0xChat: burner identities, expiring messages, backups and privacy.',
  base: '/docs/',
  outDir: '../dist/docs',
  cleanUrls: false,
  appearance: false,
  metaChunk: true,
  lang: 'en',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }]],
  transformHtml: (html) => html
    .replace('<html ', '<html class="dark" ')
    .replace(/<script id="check-mac-os">.*?<\/script>/, ''),
  themeConfig: {
    siteTitle: '0xChat Docs',
    nav: [{ text: 'Open 0xChat', link: '/chat', target: '_self' }],
    search: { provider: 'local' },
    notFound: { quote: "That page doesn't exist.", linkText: 'Docs home' },
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'What is 0xChat?', link: '/' },
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Messages and lifetimes', link: '/messages' },
          { text: 'Your key', link: '/your-key' },
          { text: 'Notifications', link: '/notifications' },
          { text: 'Install the app', link: '/install' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Privacy and security', link: '/privacy' },
          { text: 'FAQ', link: '/faq' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/endziu/0xchat' }],
  },
})
