import type { ExtensionBrowserApi } from '../shared/extensionRuntime';
import { guardExtensionListener, guardRegistration } from '../shared/extensionRuntime';
import { readContentSessionIdFromPortName } from '../shared/contentSession';

export function registerContentSessionLifecycle(
  api: ExtensionBrowserApi,
  onSessionClosed: (contentSessionId: string, tabId?: number) => void,
): void {
  // 注册本身必须包在 guardRegistration 里：失效上下文连 `port.onDisconnect` 的属性访问都会抛，
  // 抛出点在 addListener 这一层 —— 回调内部的 try/catch 接不到（回调压根没注册上）。
  guardRegistration(() => api.runtime?.onConnect?.addListener(guardExtensionListener((port) => {
    const contentSessionId = readContentSessionIdFromPortName(port.name);
    if (!contentSessionId) return;

    let closed = false;
    guardRegistration(() => port.onDisconnect.addListener(() => {
      try {
        if (closed) return;
        closed = true;
        const tabId = port.sender?.tab?.id;
        if (typeof tabId === 'number') onSessionClosed(contentSessionId, tabId);
        else onSessionClosed(contentSessionId);
      } catch (error) {
        // 会话端（content script/标签页）消失时的清理是尽力而为：全部吞掉，
        // 否则 invalidated 会从断开回调里飞出去被 Chrome 记成 Error in event handler。
        void error;
      }
    }));
  })));
}
