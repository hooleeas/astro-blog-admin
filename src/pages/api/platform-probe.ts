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
  try {
    const mod: any = await import('@edgeone/pages-blob');
    out.blobExports = mod ? Object.keys(mod) : null;
    try {
      const store = mod.getStore({ name: 'admin-config', consistency: 'strong' });
      out.storeCreated = !!store;
      try {
        await store.set('__probe__', 'ok');
        out.blobSet = 'ok';
      } catch (e) {
        out.blobSet = 'ERR ' + (e as Error)?.message;
      }
      try {
        out.blobGet = await store.get('__probe__', { type: 'text', consistency: 'strong' });
      } catch (e) {
        out.blobGet = 'ERR ' + (e as Error)?.message;
      }
      try {
        await store.delete('__probe__');
      } catch {}
    } catch (e) {
      out.storeCreated = 'ERR ' + (e as Error)?.message;
    }
  } catch (e) {
    out.blobExports = 'IMPORT ERR ' + (e as Error)?.message;
  }
  try {
    const kv = await getKVStore(locals);
    out.kvStore = kv ? 'object' : null;
  } catch (e) {
    out.kvStore = 'ERR ' + (e as Error)?.message;
  }
  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
