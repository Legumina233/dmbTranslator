export type ExtensionTarget = 'chromium' | 'firefox';

type Manifest = Record<string, unknown>;

/**
 * ★ Chromium 固定扩展 ID 用的公钥（base64 的 SubjectPublicKeyInfo DER）。
 *
 * 【为什么必须钉死它】
 *   Chrome 对「未打包扩展」在 manifest 里**没有** `key` 时，ID = SHA-256(加载目录绝对路径)。
 *   于是：目录一挪、换台机器、别人 clone 到别的路径 —— ID 全都不一样。后果是
 *   native messaging 宿主的 `allowed_origins`（run/native_host_manifest.json）立刻失效，
 *   报 `Access to the specified native messaging host is forbidden`，每换一台机器都要
 *   手工从 chrome://extensions 抄一遍 ID 再重注册。这是纯路径派生的坑，不是设计意图。
 *
 * 【加上 key 之后】
 *   ID = SHA-256(公钥 DER) 取前 16 字节 → 逐 hex 位映射 0-9a-f → a-p
 *   （Chromium: components/crx_file/id_util.cc，`kIdSize = 16`）。只与下面这把公钥有关，
 *   **与加载路径、与机器无关**。本 key 派生的 ID 恒为：
 *       nlfpkgiknddjehbagelkpblkgfcgpmhb
 *   于是 `scripts/install_native_host.py` 可以直接从构建产物的 manifest.json 里读出 `key`
 *   反推 ID 自动注册 —— 新克隆者零手工配置。
 *
 * 【密钥与安全】
 *   这里放的是**公钥**，公开无害，可以入库。
 *   **私钥绝不入库**：本地存在**仓库外**（路径因人而异，不入库）
 *   （用途：自签 .crx 做离线分发，或首次上架 CWS 时让商店采纳同一把 key、从而沿用同一个 ID）。
 *   私钥丢了不影响开发 —— unpacked 加载只需要公钥；只影响将来用同一 ID 自签发布。
 *
 * 【改这把 key 的后果】ID 会变，必须重新加载扩展并重跑 scripts/install_native_host.py。
 *
 * 【交叉验证】两条互相独立的实现给出同一个 ID：
 *   openssl rsa -in <私钥> -pubout -outform DER | sha256sum | head -c 32 | tr 0-9a-f a-p
 */
const CHROMIUM_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnTWxB2Jt+z6tr6QHIwrWfg5ZHOpYPI5RqY0lT3JiTfl7cdVMBbF4M3XUx5hCmVgH7T5lJyRbwRefklVxajN/9sObHoyV8SkUIFZf3k6xVrE7jOuZNLdynz2JidjXQQcFXg4hXWRGsZVWGDjXCSeMJs0qRPS772qjDfbR7BTje3h2VFQI1S1fWm5dI3tok6ztIJ7AlAFcBcR8JYcUzPldzgCVrNCh45AmNK1M/7qbPvXiC3VCXFDGE+tstmi6brEm13RKJkDDgNNBotljUR35E011DRUY4S53z5QTzY5HuxlBXYEQSrCnQ5aW6X8xHCeusPoYPsqE+18YjYsY0GJ4NQIDAQAB';

const COMMON_PERMISSIONS = [
  'storage',
  'contextMenus',
  'declarativeNetRequest',
  'webRequest',
  'cookies',
  /** 让扩展能通过 chrome.runtime.sendNativeMessage 拉起本机服务（起停 dmb_server / Ollama） */
  'nativeMessaging',
];

const EXTENSION_ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const TOOLBAR_ACTION = {
  default_title: 'dmbTranslator',
  default_popup: 'popup.html',
  default_icon: EXTENSION_ICONS,
};

const EXTENSION_PAGE_CSP = "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';";

type ContentScript = {
  matches: string[];
  js: string[];
  run_at: 'document_start' | 'document_idle';
  world?: 'MAIN' | 'ISOLATED';
};

const baseContentScripts: ContentScript[] = [
  { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' },
];

// ⚠️ 曾是「e-hentai 主世界观察尖刺」的声明（`ehentaiMainWorld.js`, world:'MAIN'）——
// 已随尖刺文件一并删除（奥卡姆审查：M0 时代的观察代码，其 postMessage 上报在正式扩展里
// **零消费者**；且它拖着 minimum_chrome_version 抬到 111）。e-hentai 的站点全局
// （load_image / apply_json_state）经真机证实是**函数声明**、不可重定义，主世界脚本
// 已无存在理由。恢复前请先看 dev/docs/ARCHITECTURE.md §3.1（主世界桥的历史决策与现状）
// 与 docs/UPSTREAM.md（复用与扩展说明）。

export function createExtensionManifest(target: ExtensionTarget, version: string): Manifest {
  const common: Manifest = {
    name: 'dmbTranslator',
    version,
    description: '用于 X / Pixiv 的漫画翻译器（支持谷歌翻译和大模型翻译）',
    icons: EXTENSION_ICONS,
    commands: {
      'start-screenshot-translate': {
        suggested_key: {
          default: 'Alt+Q',
        },
        description: '截图翻译',
      },
      'translate-hover-target': {
        suggested_key: {
          default: 'Alt+W',
        },
        description: '翻译悬停元素',
      },
    },
    content_scripts: baseContentScripts,
  };

  if (target === 'chromium') {
    return {
      ...common,
      // ★ 固定扩展 ID —— 详见文件顶部 CHROMIUM_EXTENSION_KEY 的完整说明。
      // Firefox 不需要：它用 browser_specific_settings.gecko.id（AMO 稳定 ID），与路径无关。
      key: CHROMIUM_EXTENSION_KEY,
      manifest_version: 3,
      action: TOOLBAR_ACTION,
      // 109：主世界脚本已删，不再需要 Chrome 111（MAIN world 的下限）。
      minimum_chrome_version: '109',
      // 两目标共用的 baseContentScripts —— firefox 不挂主世界（已删），故两目标一致。
      content_scripts: baseContentScripts,
      background: {
        service_worker: 'background-chromium.js',
        type: 'module',
      },
      permissions: [...COMMON_PERMISSIONS, 'offscreen'],
      host_permissions: ['<all_urls>'],
      web_accessible_resources: [
        {
          resources: ['fonts/*'],
          matches: ['<all_urls>'],
        },
      ],
      content_security_policy: {
        extension_pages: EXTENSION_PAGE_CSP,
      },
    };
  }

  return {
    ...common,
    manifest_version: 2,
    browser_action: TOOLBAR_ACTION,
    background: {
      page: 'background-firefox.html',
      persistent: true,
    },
    permissions: [...COMMON_PERMISSIONS, '<all_urls>'],
    web_accessible_resources: ['fonts/*'],
    content_security_policy: EXTENSION_PAGE_CSP,
    browser_specific_settings: {
      gecko: {
        id: 'dmb-translator@legumina233',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['websiteContent', 'authenticationInfo'],
        },
      },
    },
  };
}
