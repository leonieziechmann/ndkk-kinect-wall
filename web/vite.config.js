import { defineConfig } from 'vite';
import kinect from './tools/vite-plugin-kinect.js';

export default defineConfig({
  appType: 'mpa',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false, // every worktree runs its own dev server: the next free port is taken
    watch: { ignored: ['**/.cache/**'] },
  },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500, // three.js alone is ~900 kB

    rollupOptions: { input: { index: 'index.html', scene: 'scene.html' } },
  },
  optimizeDeps: {
    // scenes are loaded at runtime: name them so new dependencies do not trigger a reload later
    entries: ['index.html', 'scene.html', 'scenes/*/main.{js,ts}'],
    include: ['lil-gui', 'three', 'three/webgpu', 'three/tsl'],
    // ONNX Runtime (person tracking, lib/persons-pose.js) is one self-contained ES module that loads
    // its WebAssembly itself: served as is, never pre-bundled
    exclude: ['onnxruntime-web'],
  },
  plugins: [kinect()],
});
