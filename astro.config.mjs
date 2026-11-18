import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  output: 'static',
  site: 'https://html-to-epub-converter.pages.dev',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
