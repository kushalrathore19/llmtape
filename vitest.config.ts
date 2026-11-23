import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  configFile: false,
  test: {
    globals: true,
    environment: 'node',
  },
  css: {
    postcss: {},
  },
});
