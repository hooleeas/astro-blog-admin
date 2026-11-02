import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  vite: {
    build: {
      // 页面脚本超过此大小才内联；调低让页面设置等小脚本也有独立文件（站点设置内嵌加载靠脚本文件定位）
      assetsInlineLimit: 1024,
    },
  },
});
