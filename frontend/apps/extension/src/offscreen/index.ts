import { getExtensionRuntime } from '../shared/extensionRuntime';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createExtensionModelRuntime } from '../shared/extensionModelRuntime';
import { PipelineHost } from './pipelineHost';
import { ImageVaultHost } from './imageVaultHost';
import { createTranslatedImageCache } from './translatedImageCacheStore';
import { createProbe } from '../shared/probe';

/** 临时诊断探针（见 `shared/probe.ts`）。 */
const probe = createProbe('offscreen');

/**
 * 译图缓存：**落在扩展源的 IndexedDB 里**（方案 B：普通缓存语义）。
 *
 * 与上一版的根本区别：数据不再活在本文档的 JS 堆里。
 * 本文档随 MV3 service worker 一起被回收（真机日志：`vault-list size=5` → SW 重启 → `size=0`），
 * 而 IndexedDB 不随任何文档生灭 —— 本文档只是"读写代理"，什么时候死都不影响数据。
 *
 * 所以它必须由本文档内**所有**相关方共享同一实例：
 * - `ImageVaultHost` 用它读写；
 * - `PipelineHost` 用它的条数决定空闲时要不要拒绝关闭（见 `keepAliveWhenIdle`）。
 */
const vault = createTranslatedImageCache({
  extensionVersion: getExtensionRuntime()?.getVersion(),
});

// 探针：本文档每被加载一次就留一条 —— "缓存到底是被重建搞丢的，
// 还是只是通道断了"，看这条出现几次即可分辨。
probe('offscreen:document-loaded', { url: location.href });

const runtime = getExtensionRuntime();
const getAssetUrl = runtime ? runtime.getURL.bind(runtime) : undefined;
const host = new PipelineHost(undefined, {
  modelRuntime: createExtensionModelRuntime(),
  platform: browserPipelinePlatform,
  fontSource: getAssetUrl,
  keepAliveWhenIdle: () => vault.size() > 0,
});
host.connect();
new ImageVaultHost(vault).connect();
