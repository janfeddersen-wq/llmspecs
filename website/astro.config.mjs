import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://janfeddersen-wq.github.io',
  base: '/llmspecs',
  integrations: [tailwind()],
  build: {
    assets: '_assets'
  }
});
