/**
 * 平台适配层：把「运行时环境变量 / KV 存储 / 图片对象存储 / 平台绑定对象」的
 * 获取方式从业务代码收拢到一处，屏蔽 Cloudflare Pages 与 EdgeOne Pages 的差异。
 * 业务代码只认这里，不直接碰任何平台对象。
 *
 * - Cloudflare Pages：绑定经 locals.runtime.env 注入（@astrojs/cloudflare），
 *   本层原样透传，行为与适配前一致；图片走 R2 绑定或 S3 兼容接口。
 * - EdgeOne Pages（Makers）：SSR 跑在 Node 云函数里（@edgeone/astro 生成
 *   cloud-functions/ssr-node 的 Node HTTP 服务），控制台环境变量走 process.env。
 *   存储统一用 EdgeOne Blob（@edgeone/pages-blob，官方 Node SDK）：
 *   getStore 首次调用自动创建命名空间，无需控制台申请/绑定——
 *   配置 JSON 存一个 store，图片文件存另一个 store。
 *   （官方 KV 当前仅支持 Edge Functions、且需控制台开通绑定，Node 云函数不保证可用，
 *   故 EdgeOne 侧不依赖 KV；仅保留「绑定全局变量 ADMIN_KV」作最后兜底。）
 *   注意：Blob SDK 的部署凭证由 EdgeOne 构建/部署流水线在打包时注入，
 *   因此 Blob 能力只能在经 EdgeOne 部署后生效，本地运行会优雅降级为「未配置」。
 * - 本地开发：process.env（astro dev 时 CF 适配器仍会提供 locals.runtime）。
 */

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

/** 图片对象存储接口（EdgeOne Blob 实现；与 image-store 的 R2 绑定接口同形） */
export interface ImageBlobLike {
  put(key: string, data: ArrayBuffer): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<Array<{ key: string; size: number; lastmod: string }>>;
  delete(key: string): Promise<void>;
}

/** 可能以「绑定」形式出现的变量名（除普通字符串环境变量外） */
const BINDING_NAMES = ['ADMIN_KV', 'IMGS_R2'];

/**
 * EdgeOne KV 的 key 只允许数字、字母及下划线（官方文档），
 * 把应用层 key（如 webdav:config）映射成合法形式；Cloudflare KV 无此限制，不映射。
 * Blob 的 key 无此限制，但配置 key 在两条 EdgeOne 路径间保持一致更省心，统一映射。
 */
function edgeoneKey(key: string): string {
  return key.replace(/[^0-9A-Za-z_]/g, '_');
}

function processEnv(): Record<string, any> {
  return typeof process !== 'undefined' && process.env
    ? (process.env as unknown as Record<string, any>)
    : {};
}

/**
 * 合成运行时 env：
 * - 有 locals.runtime.env（Cloudflare）时原样返回，CF 行为不变；
 * - 否则以 process.env 为底，再把 globalThis 上的同名绑定对象
 *   （EdgeOne 把 KV 绑定暴露为全局变量）并进来。
 */
export function resolveRuntimeEnv(locals: unknown): Record<string, any> {
  const runtimeEnv = (locals as any)?.runtime?.env;
  if (runtimeEnv) return runtimeEnv as Record<string, any>;
  const env: Record<string, any> = { ...processEnv() };
  for (const name of BINDING_NAMES) {
    const g = (globalThis as any)[name];
    if (g !== undefined && env[name] === undefined) env[name] = g;
  }
  return env;
}

declare const __DEPLOY_PLATFORM__: string | undefined;

/** 构建时烧进产物的平台标记（astro.config 的 vite define 注入）；未打包环境下不存在 */
function bakedPlatform(): string | null {
  try {
    const v = typeof __DEPLOY_PLATFORM__ !== 'undefined' ? __DEPLOY_PLATFORM__ : null;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * 是否 EdgeOne 运行时。平台在构建时已由 astro.config 自动识别并烧进产物，
 * 这里优先读构建标记；没有标记时兜底推断：显式 PLATFORM 变量 >
 * 有 CF 运行时（locals.runtime.env）即 CF > 无 ADMIN_KV 绑定的 Node 形态按 EdgeOne。
 */
export function isEdgeOne(locals: unknown): boolean {
  try {
    const baked = bakedPlatform();
    if (baked) return baked === 'edgeone';
    const env = resolveRuntimeEnv(locals);
    if (env?.PLATFORM) return env.PLATFORM === 'edgeone';
    if ((locals as any)?.runtime?.env) return false;
    return getBinding(locals, 'ADMIN_KV') === null;
  } catch {
    return false;
  }
}

/** 取平台绑定对象（如 KV 的 ADMIN_KV、R2 桶的 IMGS_R2）；没有或不是对象返回 null */
export function getBinding(locals: unknown, name: string): any | null {
  try {
    const fromEnv = resolveRuntimeEnv(locals)?.[name];
    if (fromEnv !== null && typeof fromEnv === 'object') return fromEnv;
    const g = (globalThis as any)[name];
    if (g !== null && typeof g === 'object') return g;
  } catch {}
  return null;
}

/* ---------------- EdgeOne Blob 基础设施 ---------------- */

let blobModulePromise: Promise<any | null> | null = null;

/** 动态加载 @edgeone/pages-blob（只在 EdgeOne 路径上执行；加载失败返回 null 优雅降级） */
function loadBlobModule(): Promise<any | null> {
  if (!blobModulePromise) {
    blobModulePromise = (async () => {
      try {
        return await import('@edgeone/pages-blob');
      } catch {
        return null;
      }
    })();
  }
  return blobModulePromise;
}

/** 取一个 Blob store（强一致：配置与图片都要求刚写完就读到，个人站点量级下延迟可接受） */
async function blobStore(name: string): Promise<any | null> {
  const mod = await loadBlobModule();
  if (!mod?.getStore) return null;
  try {
    return mod.getStore({ name, consistency: 'strong' });
  } catch {
    return null;
  }
}

/* ---------------- 临时诊断（Blob 问题定位后删除） ---------------- */

/** 不吞错地复现 Blob 加载链：模块形状、getStore 位置、建 store 与读写往返的原始报错 */
export async function debugBlobPlatform(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const mod: any = await import('@edgeone/pages-blob');
  out.moduleKeys = mod ? Object.keys(mod) : null;
  out.getStoreOnModule = typeof mod?.getStore;
  out.getStoreOnDefault = typeof mod?.default?.getStore;
  const getStore = mod?.getStore ?? mod?.default?.getStore;
  if (typeof getStore !== 'function') {
    out.stage = 'no-getStore';
    return out;
  }
  try {
    const store = getStore({ name: 'admin-config', consistency: 'strong' });
    out.storeCreated = !!store;
    await store.set('__debug__', 'ok');
    out.set = 'ok';
    out.get = await store.get('__debug__', { type: 'text', consistency: 'strong' });
    await store.delete('__debug__');
  } catch (e) {
    out.storeError = (e as Error)?.message ?? String(e);
  }
  return out;
}

/* ---------------- KV 存储（应用配置） ---------------- */

let blobKvPromise: Promise<KvLike | null> | null = null;

/** 配置用的 Blob KV：配置 JSON 按 key 存进专用 store（默认 admin-config，可用 EDGEONE_BLOB_STORE 覆盖） */
function edgeoneBlobKv(): Promise<KvLike | null> {
  if (!blobKvPromise) {
    blobKvPromise = (async () => {
      const store = await blobStore(processEnv().EDGEONE_BLOB_STORE || 'admin-config');
      if (!store) return null;
      return {
        async get(key: string) {
          const v = await store.get(edgeoneKey(key), { type: 'text', consistency: 'strong' });
          return typeof v === 'string' ? v : null;
        },
        async put(key: string, value: string) {
          await store.set(edgeoneKey(key), value);
        },
        async delete(key: string) {
          await store.delete(edgeoneKey(key));
        },
      } as KvLike;
    })().catch(() => null);
  }
  return blobKvPromise;
}

/**
 * 取 KV 存储，按优先级：
 * - EdgeOne：Blob 配置 store 为主；Blob 不可用时回退到绑定全局变量 ADMIN_KV（做了 key 映射）；
 * - 其他平台（Cloudflare / 本地）：绑定 ADMIN_KV（Cloudflare KV 绑定），没有则返回 null，
 *   由调用方给友好报错（行为与适配前一致）。
 */
export async function getKVStore(locals: unknown): Promise<KvLike | null> {
  const bound = getBinding(locals, 'ADMIN_KV');
  const boundKv: KvLike | null =
    bound && typeof bound.get === 'function' && typeof bound.put === 'function'
      ? isEdgeOne(locals)
        ? {
            get: (key: string) => bound.get(edgeoneKey(key)),
            put: (key: string, value: string) => bound.put(edgeoneKey(key), value),
            delete:
              typeof bound.delete === 'function'
                ? (key: string) => bound.delete(edgeoneKey(key))
                : undefined,
          }
        : (bound as KvLike)
      : null;
  if (isEdgeOne(locals)) {
    const blob = await edgeoneBlobKv();
    return blob ?? boundKv;
  }
  return boundKv;
}

/* ---------------- 图片对象存储（EdgeOne Blob） ---------------- */

let imageBlobPromise: Promise<ImageBlobLike | null> | null = null;

/**
 * EdgeOne 上的图片存储（Blob，默认 store 名 admin-images，可用 EDGEONE_IMAGE_BLOB_STORE 覆盖）。
 * 非 EdgeOne 运行时直接返回 null，调用方走原有 R2 绑定 / S3 / WebDAV 路径。
 * list 需要 size 与修改时间：Blob 的 list 只给 key/etag，逐个用 getMetadata（HEAD，
 * 不下载正文）从响应头补 content-length 与 last-modified。
 */
export function getImageBlobStore(locals: unknown): Promise<ImageBlobLike | null> {
  if (!isEdgeOne(locals)) return Promise.resolve(null);
  if (!imageBlobPromise) {
    imageBlobPromise = (async () => {
      const store = await blobStore(processEnv().EDGEONE_IMAGE_BLOB_STORE || 'admin-images');
      if (!store) return null;
      return {
        async put(key: string, data: ArrayBuffer) {
          await store.set(key, data);
        },
        async get(key: string) {
          const v = await store.get(key, { type: 'arrayBuffer', consistency: 'strong' });
          return (v as ArrayBuffer | null) ?? null;
        },
        async exists(key: string) {
          try {
            return (await store.getMetadata(key, { consistency: 'strong' })) !== null;
          } catch {
            return false;
          }
        },
        async list(prefix: string) {
          const res = await store.list({ prefix, consistency: 'strong' });
          const out: Array<{ key: string; size: number; lastmod: string }> = [];
          for (const b of res?.blobs ?? []) {
            let size = 0;
            let lastmod = '';
            try {
              const meta = await store.getMetadata(b.key, { consistency: 'strong' });
              const headers = (meta?.headers ?? {}) as Record<string, string>;
              size = Number(headers['content-length'] ?? 0) || 0;
              const lm = headers['last-modified'];
              if (lm) {
                const d = new Date(lm);
                if (!Number.isNaN(d.getTime())) lastmod = d.toISOString();
              }
            } catch {}
            out.push({ key: b.key, size, lastmod });
          }
          return out;
        },
        async delete(key: string) {
          await store.delete(key);
        },
      } as ImageBlobLike;
    })().catch(() => null);
  }
  return imageBlobPromise;
}
