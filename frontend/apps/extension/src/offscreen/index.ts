import { getExtensionRuntime } from '../shared/extensionRuntime';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createExtensionModelRuntime } from '../shared/extensionModelRuntime';
import { PipelineHost } from './pipelineHost';
import { ImageVaultHost } from './imageVaultHost';
import { TranslatedImageMemoryVault } from './translatedImageMemoryVault';

/**
 * 译图缓存：**活在本文档的 JS 堆里**（不落盘），靠"本文档不随页面导航生灭"跨文档存活。
 *
 * 所以它必须由本文档内**所有**相关方共享同一实例：
 * - `ImageVaultHost` 用它读写；
 * - `PipelineHost` 用它的条数决定空闲时要不要拒绝关闭（见 `keepAliveWhenIdle`）。
 */
const vault = new TranslatedImageMemoryVault();

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
