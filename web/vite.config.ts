import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.BACKEND_URL ?? 'http://localhost:3000',
      '/health': process.env.BACKEND_URL ?? 'http://localhost:3000',
      '/presets': process.env.BACKEND_URL ?? 'http://localhost:3000',
    },
  },
});
