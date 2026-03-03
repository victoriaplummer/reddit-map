import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';

export default defineConfig({
  plugins: [vue()],
  base: '',
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.vue'],
  },
  optimizeDeps: {
    include: [
      'ngraph.graph',
      'ngraph.events',
      'ngraph.forcelayout',
      'ngraph.random',
      'ngraph.kruskal',
      'panzoom',
      'simplesvg',
      'query-state',
      'splaytree',
    ],
  },
});
