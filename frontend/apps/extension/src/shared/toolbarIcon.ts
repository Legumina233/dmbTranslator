import { getExtensionApi } from './extensionRuntime';

/**
 * 工具栏图标按「本地服务是否在跑」切换：
 *   开 → icon*-on.png（来自 D:\C.ico 转换）
 *   关 → 扩展原图标 icon*.png
 *
 * Chrome 的 action 图标不接受 .ico，所以 on 态这四个 PNG 是预先转好的，
 * 放在仓库根的 public/icons/（vite 会把 public/ 原样拷进产物）。
 */

const ON_ICONS: Record<string, string> = {
  '16': 'icons/icon16-on.png',
  '32': 'icons/icon32-on.png',
  '48': 'icons/icon48-on.png',
  '128': 'icons/icon128-on.png',
};

const OFF_ICONS: Record<string, string> = {
  '16': 'icons/icon16.png',
  '32': 'icons/icon32.png',
  '48': 'icons/icon48.png',
  '128': 'icons/icon128.png',
};

export function toolbarIconPath(localServiceRunning: boolean): Record<string, string> {
  return localServiceRunning ? ON_ICONS : OFF_ICONS;
}

/** 切换工具栏图标；环境不支持 action 时静默跳过。 */
export function applyToolbarIcon(localServiceRunning: boolean): void {
  const action = getExtensionApi()?.action;
  if (!action?.setIcon) return;
  void action.setIcon({ path: toolbarIconPath(localServiceRunning) });
}
