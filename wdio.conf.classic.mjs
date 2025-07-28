// @ts-check
import { defineConfig } from '@wdio/config';
import { config as baseConfig} from './wdio.conf.mjs';

export const config = defineConfig({
  ...baseConfig,
  capabilities: baseConfig.capabilities.map(c => ({...c, 'wdio:enforceWebDriverClassic': true })),
});

