/**
 * 临时诊断探针 —— **只记录，不改变任何行为**。
 *
 * 要回答的问题（全部只在真机复现、靠读注释/读码推不出来，故不再靠推断）：
 *   1. 页面到底有没有"自动刷新 / 自动重载"？是软导航还是整页重载？bfcache 命中了吗？
 *      ⇒ 靠每条的 `doc` / `to` 两个字段**直接判定**：
 *         同一个 `doc` + 同一个 `to` = 同一个文档（软导航）；
 *         换了 `doc` 或 `to`        = 文档被重建（整页重载）。
 *   2. 缓存通道（content ↔ background ↔ off-screen）什么时候断的？
 *   3. off-screen 文档有没有被**重建**过 —— 缓存是真丢了，还是数据还在、只是通道断了？
 *   4. 从第二层缓存取一张译图要多久？（`vault:materialize-ok` 的 `dur_ms`）
 *   5. MV3 service worker 什么时候被终止 / 重启？
 *
 * ## 出口（两个，互为兜底）
 *   ① **统一事件流**（主路径）：`kind:"probe"` 的事件经 `mt:event-log` 交给 background
 *      → POST 本机服务 `/log/events` → 落盘 `logs/events/YYYY-MM-DD.events.jsonl`。
 *      **直接看那个文件即可，不用开控制台。**
 *      background 这个 realm 由 `configureProbeRelay()` 直接注入出口 ——
 *      SW 不一定收得到自己发的 sendMessage，不能赌。
 *   ② **`chrome.storage.local` 环形缓冲**（兜底）：本机服务没跑 / 事件通道关闭 /
 *      扩展上下文已失效时，证据仍在。取数：
 *      ```
 *      chrome.storage.local.get(null, (r) => {
 *        for (const k of Object.keys(r)) if (k.startsWith('dmbProbeLog.')) console.log(k, r[k]);
 *      });
 *      ```
 *
 * ## 时间字段（三条，各有用途）
 *   · `t`  = ISO 墙上时钟（人读）
 *   · `ms` = `Date.now()`（**跨 realm 可比**，算 content↔offscreen 的往返用它）
 *   · `p`  = `performance.now()`（同 realm 内高精度）
 *   · `to` = `performance.timeOrigin`（判定"文档有没有被重建"）
 *   · `dur_ms` = 配对 `probe.mark()` / `probe.timed()` 得出的耗时
 *
 * ⚠️ 定位完成后，本文件与所有 `probe(...)` 调用点应一并删除。
 */

export type ProbeScope = 'content' | 'offscreen' | 'background';

export type ProbeData = Record<string, unknown>;

/** 统一事件流的事件形状（`DmbEventInput` 的最小子集，避免本模块 import 任何东西）。 */
export type ProbeEvent = {
  level: 'info' | 'warn' | 'error';
  kind: 'probe';
  where: { repo: 'extension'; module: string };
  what: Record<string, unknown>;
  dur_ms?: number;
};

export type Probe = {
  (event: string, data?: ProbeData): void;
  /** 计时起点（`Date.now()`，跨 realm 可比）。 */
  mark(): number;
  /** 打一条带 `dur_ms` 的事件（从 `startMs` 算起）。 */
  timed(event: string, startMs: number, data?: ProbeData): void;
  /** 本 realm 本次加载的文档 id：**换 id = 整页重载**。 */
  readonly docId: string;
  /** `performance.timeOrigin`：换值 = 整页重载（第二重证据）。 */
  readonly timeOrigin: number;
};

const PROBE_PREFIX = 'dmbProbeLog.';
/** 每个 realm 各留最近多少条。够覆盖一次"离开 → 回来 → 缓存没了"的完整周期。 */
const MAX_ENTRIES = 800;
/** 事件流投递的批量与窗口（探针是旁路，攒一批再发）。 */
const RELAY_BATCH = 16;
const RELAY_INTERVAL_MS = 250;
/** 事件流发不出去时最多攒多少条（本机服务没跑时兜底到 storage）。 */
const MAX_PENDING_RELAY = 200;

type GlobalProbeState = {
  docId?: string;
  timeOrigin?: number;
  armed?: Record<string, boolean>;
  pending?: ProbeEvent[];
  timer?: ReturnType<typeof setTimeout> | null;
};

function probeGlobal(): GlobalProbeState {
  const globalObject = globalThis as unknown as { __dmbProbe?: GlobalProbeState };
  if (!globalObject.__dmbProbe) globalObject.__dmbProbe = {};
  return globalObject.__dmbProbe;
}

function randomToken(): string {
  try {
    const cryptoObject = (globalThis as unknown as { crypto?: Crypto }).crypto;
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return cryptoObject.randomUUID().slice(0, 8);
    }
  } catch {
    // 无 crypto 的环境退到时间戳 + 随机数
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 同一 realm 内**共享**一个文档 id —— 多个 `createProbe` 不能各自造一个，否则判定失效。 */
function realmDocId(): string {
  const state = probeGlobal();
  if (!state.docId) state.docId = `doc-${randomToken()}`;
  return state.docId;
}

function realmTimeOrigin(): number {
  const state = probeGlobal();
  if (state.timeOrigin === undefined) {
    try {
      const perf = (globalThis as unknown as { performance?: Performance }).performance;
      state.timeOrigin = typeof perf?.timeOrigin === 'number'
        ? Math.round(perf.timeOrigin)
        : Date.now();
    } catch {
      state.timeOrigin = Date.now();
    }
  }
  return state.timeOrigin;
}

function nowMs(): number {
  return Date.now();
}

function monotonic(): number {
  try {
    const perf = (globalThis as unknown as { performance?: Performance }).performance;
    if (typeof perf?.now === 'function') return perf.now();
  } catch {
    // 忽略：退到墙上时钟的相对值
  }
  return Date.now() % 1_000_000;
}

/** 本次文档加载的导航类型（`reload` / `navigate` / `back_forward`）—— 重载的直接证据。 */
function navigationType(): string | undefined {
  try {
    const perf = (globalThis as unknown as { performance?: Performance }).performance;
    const entries = perf?.getEntriesByType?.('navigation') as
      | Array<{ type?: string }>
      | undefined;
    return entries?.[0]?.type;
  } catch {
    return undefined;
  }
}

// ── 出口 ①：统一事件流 ──────────────────────────────────────────────

export type ProbeRelay = (events: ProbeEvent[]) => void;

let relay: ProbeRelay | null = null;

/**
 * 注入直通出口（只有 background realm 需要）。
 *
 * 未注入时走默认路径：`runtime.sendMessage({type:'mt:event-log', events})` ——
 * content / offscreen 都适用（background 由本扩展自己的 router 收）。
 */
export function configureProbeRelay(next: ProbeRelay | null): void {
  relay = next;
  if (next && (probeGlobal().pending?.length ?? 0) > 0) flushRelay();
}

/**
 * 立刻把攒着的事件流投递出去。
 *
 * 页面/文档即将卸载时调一次 —— 批量窗口（250ms）内的那几条否则会随上下文一起消失。
 * 兜底那条 storage 通道不受影响（它每条都立即排队写）。
 */
export function flushProbeRelay(): void {
  flushRelay();
}

function defaultRelay(events: ProbeEvent[]): void {
  const globalObject = globalThis as unknown as {
    chrome?: { runtime?: { sendMessage?: unknown } };
    browser?: { runtime?: { sendMessage?: unknown } };
  };
  const runtime = globalObject.chrome?.runtime ?? globalObject.browser?.runtime;
  const send = runtime?.sendMessage;
  if (!runtime || typeof send !== 'function') return;
  try {
    // 必须以方法形式调用（脱离宿主对象会 Illegal invocation），且永不 await。
    const maybePromise = (send as (message: unknown) => unknown).call(runtime, {
      type: 'mt:event-log',
      events,
    });
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      (maybePromise as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // 上下文已失效：静默（证据仍在 storage 兜底里）。
  }
}

function flushRelay(): void {
  const state = probeGlobal();
  const pending = state.pending;
  if (!pending || pending.length === 0) return;
  const batch = pending.splice(0, RELAY_BATCH);
  const send = relay ?? defaultRelay;
  try {
    send(batch);
  } catch {
    // 出口抛错绝不影响主流程。
  }
  if (pending.length > 0) scheduleRelay();
}

function scheduleRelay(): void {
  const state = probeGlobal();
  if (state.timer) return;
  try {
    state.timer = setTimeout(() => {
      state.timer = null;
      flushRelay();
    }, RELAY_INTERVAL_MS);
  } catch {
    state.timer = null;
  }
}

function enqueueRelay(event: ProbeEvent): void {
  const state = probeGlobal();
  if (!state.pending) state.pending = [];
  state.pending.push(event);
  // 上限保护：发不出去时丢最旧的（丢事件可以，拖住主流程不行）。
  if (state.pending.length > MAX_PENDING_RELAY) {
    state.pending.splice(0, state.pending.length - MAX_PENDING_RELAY);
  }
  if (state.pending.length >= RELAY_BATCH) flushRelay();
  else scheduleRelay();
}

// ── 出口 ②：storage 环形缓冲（兜底） ────────────────────────────────

type MaybePromise<T> = T | Promise<T>;

type StorageLocal = {
  get: (keys: string) => MaybePromise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => MaybePromise<void>;
};

function storageLocal(): StorageLocal | undefined {
  const globalObject = globalThis as unknown as {
    chrome?: { storage?: { local?: StorageLocal } };
    browser?: { storage?: { local?: StorageLocal } };
  };
  return globalObject.chrome?.storage?.local ?? globalObject.browser?.storage?.local;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/** 同一 realm 内的写入串行化：探针是 read-modify-write，并发跑会丢记录。 */
let writeQueue: Promise<void> = Promise.resolve();

async function appendProbe(key: string, entry: Record<string, unknown>): Promise<void> {
  const area = storageLocal();
  if (!area) return;

  let previous: unknown;
  try {
    // 优先走 Promise 形式（MV3 Chrome / Firefox），失败才退回 callback 形式。
    const got = area.get(key);
    previous = isThenable(got) ? (await got)?.[key] : undefined;
  } catch {
    // 读失败就不写：宁可丢这一条，也不要覆盖掉别的记录。
    return;
  }

  const entries = Array.isArray(previous) ? (previous as unknown[]).slice() : [];
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
  try {
    const written = area.set({ [key]: entries });
    if (isThenable(written)) await written;
  } catch {
    // 探针自身失败必须静默：它只是观测者，不能影响被测对象。
  }
}

// ── 工厂 ────────────────────────────────────────────────────────────

/**
 * 造一个绑定到某个 realm 的探针。
 * 用法：模块顶层 `const probe = createProbe('content');`，之后
 * `probe('事件名', {…})`、`const t0 = probe.mark(); … probe.timed('事件名', t0, {…})`。
 */
export function createProbe(scope: ProbeScope): Probe {
  const storageKey = `${PROBE_PREFIX}${scope}`;
  const moduleName = `probe/${scope}`;

  function emit(event: string, data: ProbeData | undefined, durMs: number | undefined): void {
    const state = probeGlobal();
    if (!state.armed) state.armed = {};
    if (!state.armed[scope]) {
      state.armed[scope] = true;
      try {
        // 自检锚点：控制台看到这一行 = 探针被加载并执行了。
        console.info(`[dmb-probe] armed: ${scope} (doc=${realmDocId()})`);
      } catch {
        // 无 console 的环境忽略。
      }
      emitEntry('doc:armed', {
        scope,
        href: safeHref(),
        readyState: safeReadyState(),
        navType: navigationType(),
      }, undefined);
    }
    emitEntry(event, data, durMs);
  }

  function emitEntry(event: string, data: ProbeData | undefined, durMs: number | undefined): void {
    const entry: Record<string, unknown> = {
      t: new Date().toISOString(),
      ms: nowMs(),
      p: Math.round(monotonic() * 100) / 100,
      doc: realmDocId(),
      to: realmTimeOrigin(),
      ev: event,
      ...(data ?? {}),
    };
    if (durMs !== undefined) entry.dur_ms = Math.round(durMs);

    const probeEvent: ProbeEvent = {
      level: 'info',
      kind: 'probe',
      where: { repo: 'extension', module: moduleName },
      what: entry,
      ...(durMs !== undefined ? { dur_ms: Math.round(durMs) } : {}),
    };

    // 出口 ①：事件流（fire-and-forget，失败不影响主流程）。
    enqueueRelay(probeEvent);
    // 出口 ②：storage 兜底（本机服务没跑时仍留证据）。
    writeQueue = writeQueue.then(() => appendProbe(storageKey, entry)).catch(() => undefined);
  }

  const probe = ((event: string, data?: ProbeData): void => {
    emit(event, data, undefined);
  }) as Probe & { docId: string; timeOrigin: number };

  Object.defineProperty(probe, 'docId', { get: () => realmDocId(), enumerable: true });
  Object.defineProperty(probe, 'timeOrigin', { get: () => realmTimeOrigin(), enumerable: true });
  (probe as { mark?: () => number }).mark = () => nowMs();
  (probe as { timed?: (event: string, startMs: number, data?: ProbeData) => void }).timed =
    (event: string, startMs: number, data?: ProbeData): void => {
      emit(event, data, nowMs() - startMs);
    };

  return probe;
}

function safeHref(): string | undefined {
  try {
    const location = (globalThis as unknown as { location?: { href?: string } }).location;
    return typeof location?.href === 'string' ? location.href : undefined;
  } catch {
    return undefined;
  }
}

function safeReadyState(): string | undefined {
  try {
    const document = (globalThis as unknown as { document?: { readyState?: string } }).document;
    return typeof document?.readyState === 'string' ? document.readyState : undefined;
  } catch {
    return undefined;
  }
}
