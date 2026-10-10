import {
  createBrowserModelRuntime,
  createExtensionModelAssetSource,
} from '@dmb/model-runtime/browser';
import {
  recordPerfRuntimeEvent,
  recordPerfWorkerCall,
} from '@dmb/diagnostics';
import { requireExtensionRuntime } from './extensionRuntime';

export function createExtensionModelRuntime() {
  const runtime = requireExtensionRuntime();
  const getAssetUrl = runtime.getURL.bind(runtime);
  return createBrowserModelRuntime({
    workerUrl: getAssetUrl('onnxWorker.js'),
    ortPath: getAssetUrl('ort/'),
    modelSource: createExtensionModelAssetSource(getAssetUrl),
    workerPolicy: 'direct-only',
    performanceObserver: {
      recordWorkerCall: recordPerfWorkerCall,
      recordRuntimeEvent: recordPerfRuntimeEvent,
    },
  });
}
