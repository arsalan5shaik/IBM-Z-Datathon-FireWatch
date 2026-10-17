/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApi } from './mock-api/plugin';

// `base: './'` keeps the build relocatable: it works on GitHub Pages
// (/IBM-Z-Datathon-FireWatch/) and when the Python backend serves frontend/dist at /.
export default defineConfig({
  base: './',
  plugins: [react(), mockApi()],
  server: {
    // During local development, point /api at a running backend:
    //   FIREWATCH_API_PROXY=http://localhost:8000 npm run dev   (+ VITE_API_BASE_URL=/api/v1)
    proxy: process.env.FIREWATCH_API_PROXY ? { '/api': process.env.FIREWATCH_API_PROXY } : undefined,
  },
  build: {
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('maplibre-gl') ? 'maplibre' : undefined),
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
