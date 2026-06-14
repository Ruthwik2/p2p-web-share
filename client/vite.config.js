import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration. The dev server runs on 5173; the build outputs a static
// bundle (dist/) that can be deployed to any static host (Vercel, Netlify).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // expose on LAN so you can test across two physical devices
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
