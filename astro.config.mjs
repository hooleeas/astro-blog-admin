import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import edgeone from '@edgeone/astro';

// 平台识别（构建时）：两个平台的部署步骤与构建命令完全一致（npm run build），
// 靠构建环境自身的特征自动分流，不依赖任何平台专用环境变量：
// - 显式覆盖：PLATFORM=edgeone / =cloudflare（仅本地手动指定时用）
// - Cloudflare Pages 的构建环境自带 CF_PAGES=1（实测）
// - EdgeOne 构建环境自带 EO_MAKERS 标记，且沙箱 HOME / TMPDIR 都位于 /dev/shm 下（实测）
// 识别结果经 vite define 烧进产物，运行时 src/lib/platform.ts 直接读常量，
// 与运行时环境变量解耦；业务代码不感知平台。
function detectPlatform() {
  if (process.env.PLATFORM === 'edgeone') return 'edgeone';
  if (process.env.PLATFORM === 'cloudflare') return 'cloudflare';
  if (process.env.CF_PAGES) return 'cloudflare';
  if (process.env.EO_MAKERS) return 'edgeone';
  if (process.env.HOME === '/dev/shm/home' && process.env.TMPDIR === '/dev/shm/tmp')
    return 'edgeone';
  return 'cloudflare';
}
const platform = detectPlatform();
const adapter = platform === 'edgeone' ? edgeone() : cloudflare();

export default defineConfig({
  output: 'server',
  adapter,
  vite: {
    define: {
      __DEPLOY_PLATFORM__: JSON.stringify(platform),
    },
    // EdgeOne：pages-blob 必须外置——部署流水线会把 node_modules 里 SDK 的凭证占位符
    // 替换为真实凭证，打包内联的副本拿不到替换，运行时会报缺 deployCredential。
    ...(platform === 'edgeone' ? { ssr: { external: ['@edgeone/pages-blob'] } } : {}),
    build: {
      // 页面脚本超过此大小才内联；调低让页面设置等小脚本也有独立文件（站点设置内嵌加载靠脚本文件定位）
      assetsInlineLimit: 1024,
      ...(platform === 'edgeone'
        ? { rollupOptions: { external: ['@edgeone/pages-blob'] } }
        : {}),
    },
  },
});
