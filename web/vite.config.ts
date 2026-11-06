import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  envDir: '..', // 루트 .env 의 VITE_KAKAO_JS_KEY 사용
  build: { rollupOptions: { input: { main: path.resolve(__dirname, 'index.html'), kernel: path.resolve(__dirname, 'kernel.html') } } },
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: {
    port: 5173,
    host: '0.0.0.0', // Tailscale 등 다른 기기에서 접속 가능하도록 모든 인터페이스에 바인딩
    allowedHosts: ['.ts.net', 'home.sgb.kr'], // Tailscale MagicDNS 이름(*.ts.net)과 개인 도메인으로 접속 허용
    proxy: { '/api': 'http://localhost:4000' },
  },
});
