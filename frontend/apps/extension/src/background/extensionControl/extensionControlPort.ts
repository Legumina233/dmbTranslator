import type { ExtensionBrowserApi, ExtensionPort } from '../../shared/extensionRuntime';
import { guardExtensionListener, guardRegistration } from '../../shared/extensionRuntime';
import {
  extensionControlChangedEventType,
  extensionControlPortName,
  type ExtensionControlChangedEvent,
} from '../../shared/extensionControlTransport';
import type { ExtensionControlModule } from './extensionControl';

export function registerExtensionControlPort(
  api: ExtensionBrowserApi,
  module: ExtensionControlModule,
): void {
  guardRegistration(() => api.runtime?.onConnect?.addListener(guardExtensionListener((port: ExtensionPort) => {
    if (port.name !== extensionControlPortName) return;
    let connected = true;
    let unsubscribe: (() => void) | undefined;
    const disconnect = () => {
      if (!connected) return;
      connected = false;
      unsubscribe?.();
    };
    const post = (projection: ExtensionControlChangedEvent['projection']) => {
      if (!connected) return;
      try {
        port.postMessage({
          type: extensionControlChangedEventType,
          projection,
        } satisfies ExtensionControlChangedEvent);
      } catch {
        // The physical port can close before onDisconnect is dispatched.
        disconnect();
      }
    };
    unsubscribe = module.subscribe(post);
    guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(disconnect)));
  })));
}
