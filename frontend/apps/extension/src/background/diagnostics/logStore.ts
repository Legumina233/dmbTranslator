import type { ExtensionSettings } from "../../shared/config";
import { getExtensionApi } from '../../shared/extensionRuntime';
import {
  createDiagnosticEvent,
  createDiagnosticId,
  formatDiagnosticTextLog,
  normalizeDiagnosticTimestamp,
} from '@dmb/diagnostics';
import { sanitizeExtensionSettings } from '../../shared/diagnosticSettings';
import type {
  DiagnosticLogEvent,
  DiagnosticLogEventInput,
  DiagnosticLogRun,
  DiagnosticLogTextExport,
} from '@dmb/diagnostics';
import { getSettings } from "../settings/settingsStore";
import {
  storageGet,
  storageRemove,
  storageSet,
} from "../storage/chromeStorage";
import { isRecord } from "../utils";

const diagnosticLogStorageKey = "mangaTranslate.diagnosticLog";
const diagnosticLogChunkKeyPrefix = "mangaTranslate.diagnosticLog.chunk.";
const backgroundDiagnosticSessionId = createDiagnosticId("background-session");
let diagnosticLogWriteQueue: Promise<void> = Promise.resolve();

type DiagnosticLogStore = {
  events: DiagnosticLogEvent[];
  truncated?: boolean;
  truncationReason?: string;
};

/**
 * 分片索引。**它自己必须很小** —— 追加事件时每次都要读写它，
 * 一旦把事件塞进来就又退化成「整包读改写」了。
 */
type DiagnosticLogIndex = {
  schema: 2;
  /** chunkId 列表，按时间升序（最后一个是可追加的那块）。 */
  chunks: string[];
  total: number;
  truncated?: boolean;
  truncationReason?: string;
};

const diagnosticLogMaxEvents = 2000;

/**
 * 每块多少条事件。追加一次的代价是 O(chunkSize) 而不是 O(总条数)：
 * 上限 2000 条时，这一改把单次追加的读写量从 2000 条降到 100 条。
 *
 * 为什么不再小：chunk 太碎会让导出要读的 key 变多、索引变长；
 * 100 是「单次追加足够轻」与「导出不至于读几百个 key」之间的折中。
 */
const diagnosticLogChunkSize = 100;

function normalizeStoredDiagnosticLogEvent(value: unknown): DiagnosticLogEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.level !== 'string' ||
    typeof value.category !== 'string' ||
    !isRecord(value.source) ||
    typeof value.source.context !== 'string' ||
    typeof value.message !== 'string'
  ) {
    return null;
  }

  const timestamp = normalizeDiagnosticTimestamp(value.timestamp, '');
  const normalized = createDiagnosticEvent({
    id: value.id,
    sessionId: value.sessionId,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    timestamp,
    level: value.level as DiagnosticLogEvent['level'],
    category: value.category as DiagnosticLogEvent['category'],
    source: {
      context: value.source.context as DiagnosticLogEvent['source']['context'],
      module: typeof value.source.module === 'string' ? value.source.module : undefined,
    },
    message: value.message,
    data: isRecord(value.data) ? value.data : undefined,
    error: isRecord(value.error) && typeof value.error.message === 'string'
      ? value.error as DiagnosticLogEvent['error']
      : undefined,
  }, value.sessionId);

  // Persisted legacy events may not have a timestamp. Keep the empty value so
  // the readable formatter can show "unknown-time" instead of inventing a new
  // timestamp that would move the event to the latest run.
  normalized.timestamp = timestamp;
  return normalized;
}

function appendTruncationReason(current: unknown, reason: string): string {
  return typeof current === 'string' && current.length > 0
    ? `${current}；${reason}`
    : reason;
}

function normalizeDiagnosticLogStore(value: unknown): DiagnosticLogStore {
  if (!isRecord(value) || !Array.isArray(value.events)) {
    return { events: [] };
  }

  const events: DiagnosticLogEvent[] = [];
  let invalidEventCount = 0;
  for (const candidate of value.events) {
    const event = normalizeStoredDiagnosticLogEvent(candidate);
    if (event) {
      events.push(event);
    } else {
      invalidEventCount += 1;
    }
  }

  const invalidEventReason = invalidEventCount > 0
    ? `持久化日志中有 ${invalidEventCount} 条事件格式无效，已忽略`
    : undefined;
  const truncationReason = invalidEventReason
    ? appendTruncationReason(value.truncationReason, invalidEventReason)
    : typeof value.truncationReason === 'string'
      ? value.truncationReason
      : undefined;

  return {
    events,
    truncated: value.truncated === true || invalidEventCount > 0,
    truncationReason,
  };
}

/** 读分片索引；库为空或是旧格式（单 key 大数组）时返回 null。 */
async function readDiagnosticLogIndex(): Promise<DiagnosticLogIndex | null> {
  const saved = await storageGet(diagnosticLogStorageKey);
  if (!isRecord(saved)) return null;
  // 旧格式：整包事件数组。交给 readDiagnosticLogStore 的旧路径，首次追加时再切片。
  if (Array.isArray(saved.events)) return null;
  if (saved.schema !== 2 || !Array.isArray(saved.chunks)) return null;
  return {
    schema: 2,
    chunks: saved.chunks.filter((id): id is string => typeof id === 'string'),
    total: typeof saved.total === "number" && Number.isFinite(saved.total) ? saved.total : 0,
    truncated: saved.truncated === true,
    truncationReason: typeof saved.truncationReason === "string" ? saved.truncationReason : undefined,
  };
}

async function writeDiagnosticLogIndex(index: DiagnosticLogIndex): Promise<void> {
  await storageSet(diagnosticLogStorageKey, index);
}

/** 读一块。顺手做一遍规范化，坏记录在这里就被丢掉，不流到导出。 */
async function readDiagnosticLogChunk(chunkId: string): Promise<DiagnosticLogEvent[]> {
  const raw = await storageGet(chunkId);
  if (!Array.isArray(raw)) return [];
  const events: DiagnosticLogEvent[] = [];
  for (const candidate of raw) {
    const event = normalizeStoredDiagnosticLogEvent(candidate);
    if (event) events.push(event);
  }
  return events;
}

/** 把一批事件切成若干块落盘，返回新索引。用于旧格式迁移。 */
async function writeShardedLog(
  events: DiagnosticLogEvent[],
  truncated?: boolean,
  reason?: string,
): Promise<DiagnosticLogIndex> {
  const kept = events.length > diagnosticLogMaxEvents
    ? events.slice(events.length - diagnosticLogMaxEvents)
    : events;
  const dropped = events.length - kept.length;
  const chunks: string[] = [];
  for (let offset = 0; offset < kept.length; offset += diagnosticLogChunkSize) {
    const chunkId = `${diagnosticLogChunkKeyPrefix}${createDiagnosticId("chunk")}`;
    await storageSet(chunkId, kept.slice(offset, offset + diagnosticLogChunkSize));
    chunks.push(chunkId);
  }
  const index: DiagnosticLogIndex = {
    schema: 2,
    chunks,
    total: kept.length,
    truncated: truncated === true || dropped > 0,
    truncationReason: dropped > 0
      ? appendTruncationReason(reason, `事件数量超过 ${diagnosticLogMaxEvents}，已丢弃最早的 ${dropped} 条`)
      : reason,
  };
  await writeDiagnosticLogIndex(index);
  return index;
}

/** 超出上限就整块整块地删最老的，避免任何「读全部再写全部」。 */
async function trimDiagnosticLogToLimit(): Promise<void> {
  const index = await readDiagnosticLogIndex();
  if (!index) return;
  let chunks = index.chunks;
  let total = index.total;
  let dropped = 0;
  while (total > diagnosticLogMaxEvents && chunks.length > 0) {
    const oldest = chunks[0];
    // 用块里真实条数修正 total：索引上的计数可能与磁盘不一致。
    const events = await readDiagnosticLogChunk(oldest);
    await storageRemove(oldest);
    chunks = chunks.slice(1);
    total -= events.length;
    dropped += events.length;
  }
  if (dropped === 0) return;
  await writeDiagnosticLogIndex({
    ...index,
    chunks,
    total: Math.max(0, total),
    truncated: true,
    truncationReason: appendTruncationReason(
      index.truncationReason,
      `事件数量超过 ${diagnosticLogMaxEvents}，已丢弃最早的 ${dropped} 条`,
    ),
  });
}

/** 读全库。**只在导出时调用** —— 追加路径上一律走分片。 */
async function readDiagnosticLogStore(): Promise<DiagnosticLogStore> {
  const saved = await storageGet(diagnosticLogStorageKey);
  if (isRecord(saved) && Array.isArray(saved.events)) {
    return normalizeDiagnosticLogStore(saved);
  }
  const index = await readDiagnosticLogIndex();
  if (!index) return { events: [] };
  const events: DiagnosticLogEvent[] = [];
  for (const chunkId of index.chunks) {
    events.push(...await readDiagnosticLogChunk(chunkId));
  }
  return {
    events,
    truncated: index.truncated,
    truncationReason: index.truncationReason,
  };
}

async function appendDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const normalized = createDiagnosticEvent(event, event.sessionId);
  let index = await readDiagnosticLogIndex();
  if (!index) {
    // 空库或旧格式：整包读一次并切片重排。**只发生一次**，之后永远走下面的增量分支。
    const legacy = normalizeDiagnosticLogStore(await storageGet(diagnosticLogStorageKey));
    index = await writeShardedLog(legacy.events, legacy.truncated, legacy.truncationReason);
  }

  const lastChunkId = index.chunks[index.chunks.length - 1];
  if (lastChunkId) {
    const chunk = await readDiagnosticLogChunk(lastChunkId);
    if (chunk.length < diagnosticLogChunkSize) {
      chunk.push(normalized);
      await storageSet(lastChunkId, chunk);
      await writeDiagnosticLogIndex({ ...index, total: index.total + 1 });
      return;
    }
  }
  const nextChunkId = `${diagnosticLogChunkKeyPrefix}${createDiagnosticId("chunk")}`;
  await storageSet(nextChunkId, [normalized]);
  await writeDiagnosticLogIndex({
    ...index,
    chunks: [...index.chunks, nextChunkId],
    total: index.total + 1,
  });
  await trimDiagnosticLogToLimit();
}

export function recordDiagnosticLogEvent(event: DiagnosticLogEvent): Promise<void> {
  const write = diagnosticLogWriteQueue.then(
    () => appendDiagnosticLogEvent(event),
    () => appendDiagnosticLogEvent(event),
  );
  diagnosticLogWriteQueue = write.catch(() => undefined);
  return write;
}

export function toImageTranslateDiagnosticData(image: { base64: string; contentType: string; filename: string }): Record<string, unknown> {
  return {
    contentType: image.contentType,
    filename: image.filename,
    base64Length: image.base64.length,
  };
}

export async function recordBackgroundDiagnosticLog(
  settings: ExtensionSettings,
  event: DiagnosticLogEventInput,
): Promise<void> {
  if (!settings.enableDebugLog || !event.runId) {
    return;
  }
  try {
    await recordDiagnosticLogEvent(createDiagnosticEvent(event, event.sessionId ?? backgroundDiagnosticSessionId));
  } catch {
    // Diagnostic writes are best-effort and must not affect API requests.
  }
}

export function deriveDiagnosticRuns(events: DiagnosticLogEvent[]): DiagnosticLogRun[] {
  const runs = new Map<string, DiagnosticLogRun>();
  for (const event of events) {
    if (!event.runId) continue;
    const timestamp = normalizeDiagnosticTimestamp(event.timestamp, '');
    const existing = runs.get(event.runId);
    if (!existing) {
      runs.set(event.runId, {
        runId: event.runId,
        startedAt: timestamp,
        status: 'running',
        label: typeof event.data?.label === 'string' ? event.data.label : undefined,
      });
      continue;
    }
    if (timestamp < existing.startedAt) {
      existing.startedAt = timestamp;
    }
    const runStatus = event.data?.runStatus;
    if (runStatus === 'success' || runStatus === 'failed') {
      existing.status = runStatus;
      existing.finishedAt = timestamp;
      existing.error = event.error?.message ?? (typeof event.data?.error === 'string' ? event.data.error : existing.error);
    }
  }
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function exportDiagnosticLog(): Promise<DiagnosticLogTextExport> {
  await diagnosticLogWriteQueue.catch(() => undefined);
  const store = await readDiagnosticLogStore();
  const settings = await getSettings();
  const chromeApi = getExtensionApi();
  const manifest = chromeApi?.runtime?.getManifest?.();
  const events = store.events;
  const exportedAt = new Date().toISOString();
  const extension = {
    version: manifest?.version,
    manifestVersion: manifest?.manifest_version,
  };
  const environment = {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    platform: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : undefined,
  };
  const activeSettings = sanitizeExtensionSettings(settings);
  const runs = deriveDiagnosticRuns(events);
  return {
    schemaVersion: 1,
    exportedAt,
    filenamePrefix: 'dmb-diagnostic-log',
    contentType: 'text/plain;charset=utf-8',
    eventCount: events.length,
    text: formatDiagnosticTextLog(events, {
      exportedAt,
      extension,
      environment,
      activeSettings,
      runs,
      truncated: store.truncated,
      truncationReason: store.truncationReason,
    }),
  };
}

export async function clearDiagnosticLog(): Promise<void> {
  // 分片后光删索引会把 chunk 全留在库里 —— 它们会变成永远读不到的垃圾，
  // 还白占配额。必须按索引把块一起删掉。
  const index = await readDiagnosticLogIndex();
  await storageRemove(index ? [...index.chunks, diagnosticLogStorageKey] : diagnosticLogStorageKey);
}
