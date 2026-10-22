/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Relative base so the build works on GitHub Pages under any repo name.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-180.png', 'icon-512.png'],
      manifest: {
        name: 'Block H PM Split Test',
        short_name: 'PM Test',
        description: 'Data collection and analysis for the Block H preventive maintenance split test.',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f9f9f7',
        theme_color: '#1a1a19',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-180.png', sizes: '180x180', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg}'],
      },
    }),
  ],
  test: {
    environment: 'node',
  },
});
