import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import edgeone from '@edgeone/astro';

// 平台切换：环境变量 PLATFORM=edgeone 时构建 EdgeOne Pages 版，
// 否则默认构建 Cloudflare Pages 版。同一份代码双平台部署，
// 运行时差异收敛在 src/lib/platform.ts，业务代码不感知平台。
const adapter = process.env.PLATFORM === 'edgeone' ? edgeone() : cloudflare();

export default defineConfig({
  output: 'server',
  adapter,
  vite: {
    build: {
      // 页面脚本超过此大小才内联；调低让页面设置等小脚本也有独立文件（站点设置内嵌加载靠脚本文件定位）
      assetsInlineLimit: 1024,
    },
  },
});
