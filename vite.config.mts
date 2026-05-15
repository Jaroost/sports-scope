import { defineConfig } from 'vite'
import RubyPlugin from 'vite-plugin-ruby'
import vue from '@vitejs/plugin-vue'

const publicHost = process.env.VITE_PUBLIC_HOST || 'localhost'

export default defineConfig({
  plugins: [
    RubyPlugin(),
    vue(),
  ],
  server: {
    host: '0.0.0.0',
    port: 3036,
    strictPort: true,
    allowedHosts: [publicHost, 'localhost'],
    origin: `https://${publicHost}`,
    hmr: {
      host: publicHost,
      clientPort: 443,
      protocol: 'wss',
    },
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
})
