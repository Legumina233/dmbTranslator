import { resolve } from 'node:path';
import { createNodeModelRuntime } from '@dmb/model-runtime/node';

const modelRoot = resolve(process.cwd(), 'public', 'models');

export const benchmarkModelRuntime = createNodeModelRuntime({
  manifestRoot: modelRoot,
  modelRoot,
});
