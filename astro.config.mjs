import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import edgeone from '@edgeone/astro';
import { writeFileSync } from 'node:fs';

// 平台识别（构建时）：两个平台的部署步骤与构建命令完全一致（npm run build），
// 靠构建环境自身的特征自动分流，不依赖任何平台专用环境变量：
// - 显式覆盖：PLATFORM=edgeone / =cloudflare（仅本地手动指定时用）
// - Cloudflare Pages 的构建环境自带 CF_PAGES 变量
// - EdgeOne 构建沙箱的 HOME / TMPDIR 都位于 /dev/shm 下
// 识别结果经 vite define 烧进产物，运行时 src/lib/platform.ts 直接读常量，
// 与运行时环境变量解耦；业务代码不感知平台。
function detectPlatform() {
  if (process.env.PLATFORM === 'edgeone') return { name: 'edgeone', via: 'env-override' };
  if (process.env.PLATFORM === 'cloudflare') return { name: 'cloudflare', via: 'env-override' };
  if (process.env.CF_PAGES) return { name: 'cloudflare', via: 'cf-pages' };
  if (process.env.HOME === '/dev/shm/home' && process.env.TMPDIR === '/dev/shm/tmp')
    return { name: 'edgeone', via: 'signature' };
  return { name: 'cloudflare', via: 'default' };
}
const detected = detectPlatform();
const adapter = detected.name === 'edgeone' ? edgeone() : cloudflare();

// 临时探针（验证完成后删除）：把构建环境特征写入产物，部署后访问核对识别依据
try {
  writeFileSync(
    'public/__platform_probe.json',
    JSON.stringify(
      {
        chosen: detected.name,
        via: detected.via,
        cfPages: process.env.CF_PAGES ?? null,
        home: process.env.HOME ?? null,
        tmpdir: process.env.TMPDIR ?? null,
        keys: Object.keys(process.env).sort(),
      },
      null,
      2,
    ),
  );
} catch {}

export default defineConfig({
  output: 'server',
  adapter,
  vite: {
    define: {
      __DEPLOY_PLATFORM__: JSON.stringify(detected.name),
    },
    build: {
      // 页面脚本超过此大小才内联；调低让页面设置等小脚本也有独立文件（站点设置内嵌加载靠脚本文件定位）
      assetsInlineLimit: 1024,
    },
  },
});
