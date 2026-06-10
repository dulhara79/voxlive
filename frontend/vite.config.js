import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The frontend connects directly to VITE_WS_URL (ws://localhost:8080 in dev).
  // No proxy needed — configure the URL via .env instead.
});
