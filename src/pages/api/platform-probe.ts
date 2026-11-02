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

  // v7 未污染指纹：占位符字符串用字符码拼，源码里不出现连续原文，流水线改写不到它
  try {
    const fs2: any = await import('node:fs');
    const path2: any = await import('node:path');
    const crypto2: any = await import('node:crypto');
    const PH = String.fromCharCode(
      123, 123, 80, 65, 71, 69, 83, 95, 66, 76, 79, 66, 95, 68, 69, 80, 76, 79, 89, 95, 67, 82,
      69, 68, 69, 78, 84, 73, 65, 76, 125, 125,
    );
    const fingerprint = (file: string) => {
      try {
        const text = fs2.readFileSync(file, 'utf8');
        return {
          sha256: crypto2.createHash('sha256').update(text).digest('hex'),
          size: text.length,
          hasPlaceholder: text.includes(PH),
          hasPlaceholderCI: text.toLowerCase().includes(PH.toLowerCase()),
          hasSts: text.includes('blob-sts'),
        };
      } catch (e) {
        return { error: (e as Error)?.message };
      }
    };
    const files: Record<string, unknown> = {};
    files['self'] = { path: import.meta.url, ...fingerprint(new URL(import.meta.url).pathname) };
    try {
      const chunksDir = '/var/user/chunks';
      for (const name of fs2.readdirSync(chunksDir)) {
        if (!name.endsWith('.mjs')) continue;
        const full = path2.join(chunksDir, name);
        const text = fs2.readFileSync(full, 'utf8');
        if (text.includes('edgeoneBlobKv') || text.includes('getKVStore')) {
          files['platformChunk'] = { path: full, ...fingerprint(full) };
        }
      }
    } catch (e) {
      files['platformChunk'] = { error: (e as Error)?.message };
    }
    files['sdkNodeModules'] = {
      path: '/var/user/node_modules/@edgeone/pages-blob/dist/index.js',
      ...fingerprint('/var/user/node_modules/@edgeone/pages-blob/dist/index.js'),
    };
    out.fingerprints = files;
  } catch (e) {
    out.fingerprints = 'ERR ' + (e as Error)?.message;
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
