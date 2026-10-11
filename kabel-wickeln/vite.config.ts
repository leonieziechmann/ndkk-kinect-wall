import { defineConfig, type PluginOption } from 'vite';
import motionCanvasModule from '@motion-canvas/vite-plugin';
import ffmpegModule from '@motion-canvas/ffmpeg';

// both are CommonJS modules: in an ES module package their function sits on `.default`
type Factory = (config?: { project?: string | string[] }) => PluginOption;
const unwrap = (m: unknown) => ((m as { default?: Factory }).default ?? m) as Factory;
const motionCanvas = unwrap(motionCanvasModule);
const ffmpeg = unwrap(ffmpegModule);

export default defineConfig({
  // the video, and a test project with model sheets and render tests
  plugins: [motionCanvas({ project: ['./src/project.ts', './src/test.ts'] }), ffmpeg()],
});
