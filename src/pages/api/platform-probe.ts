export const prerender = false;

// 临时运行时探针：定位 EdgeOne 上平台识别 / Blob 可用性问题，诊断完即删。
import { isEdgeOne, getKVStore, resolveRuntimeEnv, getBinding } from '../../lib/platform';

declare const __DEPLOY_PLATFORM__: string | undefined;

export async function GET({ locals }: { locals: unknown }) {
  const out: Record<string, unknown> = {};
  try {
    out.baked = typeof __DEPLOY_PLATFORM__ !== 'undefined' ? __DEPLOY_PLATFORM__ : '(undefined)';
  } catch (e) {
    out.baked = 'ERR ' + String(e);
  }
  try {
    out.isEdgeOne = isEdgeOne(locals);
  } catch (e) {
    out.isEdgeOne = 'ERR ' + String(e);
  }
  out.hasRuntime = !!(locals as any)?.runtime;
  out.hasRuntimeEnv = !!(locals as any)?.runtime?.env;
  try {
    out.envKeys = Object.keys(resolveRuntimeEnv(locals)).sort();
  } catch (e) {
    out.envKeys = 'ERR ' + String(e);
  }
  out.adminKvBinding = getBinding(locals, 'ADMIN_KV') ? 'object' : null;
  // 平台层 Blob 链路原始诊断（不吞错）
  try {
    const { debugBlobPlatform } = await import('../../lib/platform');
    out.blobDebug = await debugBlobPlatform();
  } catch (e) {
    out.blobDebug = 'ERR ' + (e as Error)?.message;
  }
  try {
    const { getImageBlobStore } = await import('../../lib/platform');
    const img = await getImageBlobStore(locals);
    out.imageStore = img ? 'object' : null;
    if (img) {
      const data = new TextEncoder().encode('probe').buffer as ArrayBuffer;
      await img.put('__probe__.txt', data);
      const back = await img.get('__probe__.txt');
      out.imageRoundtrip = back ? new TextDecoder().decode(back) : null;
      await img.delete('__probe__.txt');
    }
  } catch (e) {
    out.imageStore = 'ERR ' + (e as Error)?.message;
  }
  // 文件系统取证：部署流水线是否把 SDK 里的凭证占位符替换掉了（只报布尔/长度，绝不回值）
  try {
    const fs: any = await import('node:fs');
    const path: any = await import('node:path');
    const roots = [process.env.USER_CODE_ROOT, process.env.PWD, process.cwd()].filter(Boolean) as string[];
    out.fsRoots = roots;
    const hits: Array<Record<string, unknown>> = [];
    const scan = (dir: string, depth: number) => {
      if (depth < 0 || hits.length >= 12) return;
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (hits.length >= 12) return;
        const full = path.join(dir, name);
        let st: any;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (name === 'node_modules') {
            const sdk = path.join(full, '@edgeone', 'pages-blob', 'dist', 'index.js');
            try {
              const text = fs.readFileSync(sdk, 'utf8');
              hits.push({
                file: sdk,
                placeholderIntact: text.includes('{{PAGES_BLOB_DEPLOY_CREDENTIAL}}'),
                size: text.length,
                hasSts: text.includes('blob-sts'),
              });
            } catch {}
            continue;
          }
          if (depth > 0 && !name.startsWith('.git')) scan(full, depth - 1);
        } else if (/\.(mjs|js|cjs)$/.test(name) && st.size < 8_000_000) {
          try {
            const text = fs.readFileSync(full, 'utf8');
            if (text.includes('blob-sts')) {
              hits.push({
                file: full,
                placeholderIntact: text.includes('{{PAGES_BLOB_DEPLOY_CREDENTIAL}}'),
                hasSts: true,
              });
            }
          } catch {}
        }
      }
    };
    for (const r of roots) scan(r, 4);
    out.sdkFiles = hits;
    out.globalKeys = Object.keys(globalThis).filter((k) => /blob|pages|credential/i.test(k));
  } catch (e) {
    out.fsProbe = 'ERR ' + (e as Error)?.message;
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
