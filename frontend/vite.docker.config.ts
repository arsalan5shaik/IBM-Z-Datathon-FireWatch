import { mergeConfig } from 'vite';
import baseConfig from './vite.config';

// Lightning CSS has no locked s390x binary. Vite's PostCSS pipeline still
// processes CSS; only minification is disabled on a native IBM Z builder.
// Keep JavaScript minification and the application/development config intact.
export default mergeConfig(baseConfig, {
  base: '/',
  build: { cssMinify: process.arch === 's390x' ? false : 'lightningcss' },
});
