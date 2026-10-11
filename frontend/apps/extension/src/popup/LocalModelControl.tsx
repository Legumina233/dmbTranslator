import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ollamaServiceBase,
  readLocalServices,
  setServiceEnabled,
  type LocalServiceResult,
  type LocalServicesState,
  type ServiceKind,
} from '../shared/localServiceClient';
import { applyToolbarIcon } from '../shared/toolbarIcon';
import {
  defaultPrefetchDepth,
  maxPrefetchDepth,
  maxTranslationCacheLimit,
  minPrefetchDepth,
  minTranslationCacheLimit,
} from '../shared/config';
import { sendRuntimeMessage } from '../shared/messages';
import { SelectControl } from './SelectControl';

/**
 * 本地模型控制块。
 *
 * 设计分工（避免职责混乱 + 状态来源不唯一）：
 *   · 服务「启停 + 在不在跑」 → useLocalServices 钩子独占（服务端状态的唯一真相源）。
 *     组件不再自己维护一套 running，只从钩子读。
 *   · 模型「列表 / 驻留 / 显存 / 加载卸载」 → useModelStatus 钩子（走 dmb_server 的 HTTP，
 *     与服务启停是两条独立链路）。轮询逻辑只在钩子里写一处，组件不碰 fetch。
 *   · 「用户意图」(intent) → 组件内的 UI 展示变量：开关点了立刻翻，不等服务真起来。
 *     它与真实 running 是两件不同的事（点了 vs 真的跑起来了），所以分两处，不是重复状态。
 *
 * 为什么服务探活走 HTTP 而不是 Native Messaging：
 *   之前状态也走 NM，结果扩展每 3s 轮询 = Chrome 每 3s 拉起一次宿主 = 每 3s 弹一个终端又关掉
 *   （详见 localServiceClient.ts 顶部注释）。所以"在不在跑"只用 HTTP 探活，
 *   NM 只在用户点开关时调用一次。
 */

type ModelStatus = {
  keep_alive: number | string;
  auto_unload: boolean;
  loaded: Array<{ name: string; size_vram?: number }>;
  /** 已驻留模型占用的显存总量（来自 Ollama /api/ps，不需要额外拉 nvidia-smi） */
  loaded_total_vram: number;
};

type ModelAction = 'load' | 'unload';

type Feedback = {
  kind: 'saving' | 'success' | 'error';
  text: string;
};

export type LocalModelControlProps = {
  /** 当前 custom 的 Base URL，例如 http://127.0.0.1:11436/v1 */
  baseUrl: string;
  /** 当前选中的模型名；空串表示尚未选择 */
  model: string;
  onPickModel: (model: string) => void;
  /** 译图缓存条数上限（settings 里的值）。 */
  cacheLimit: number;
  onCacheLimitChange: (limit: number) => void;
  /** 向后预载页数（settings 里的值，**0 = 关闭预载**）。 */
  prefetchDepth: number;
  onPrefetchDepthChange: (depth: number) => void;
  /** 进入阅读页是否自动翻译当前页（**只**管当前页，与预载深度是正交的两个旋钮）。 */
  autoTranslateOnEnter: boolean;
  onAutoTranslateOnEnterChange: (enabled: boolean) => void;
};

export const LOCAL_DEFAULT_BASE = 'http://127.0.0.1:11436/v1';
/** 本地服务不需要真实 Key，但存储/请求里得有值，统一传这个占位符。 */
export const LOCAL_API_KEY_PLACEHOLDER = 'local';

const PLACEHOLDER_VALUE = '';
const REFRESH_INTERVAL_MS = 3000;

/** 把 `/v1` 后缀去掉，得到服务根地址。 */
export function toServiceBase(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/\/v1$/, '');
}

/** 只有指向本机的地址才算本地服务。 */
export function isLocalBase(baseUrl: string): boolean {
  const base = toServiceBase(baseUrl);
  if (!base) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(base);
}

function baseName(name: string): string {
  return name.split(':')[0];
}

/** 带超时的 fetch —— 服务没起时不要卡住整个弹窗。模型状态查询用，与服务启停无关。 */
async function fetchJson(url: string, init?: RequestInit, timeoutMs = 6000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body?.error === 'string' && body.error) detail = body.error;
      } catch {
        /* 响应体不是 JSON，用状态码即可 */
      }
      throw new Error(detail);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── 业务钩子：服务启停 + 在不在跑（唯一真相源） ──────────────────────────

/**
 * 本机服务的「在不在跑 + 启停」控制。
 *
 * 这是服务状态的唯一真相源：组件里所有"服务是否运行"的展示都从这里读，
 * 不再各自维护一份 running。内部负责：
 *   · 每 3s HTTP 探活两个服务（纯 HTTP，不弹窗口）；
 *   · 用户点开关 → 调 NM 启停 → 用宿主回的权威状态立刻刷新（不必等下一次轮询）；
 *   · 标记哪个服务正在切换（busy），供 UI 禁用开关。
 */
function useLocalServices(serviceBase: string | undefined) {
  const [services, setServices] = useState<LocalServicesState | null>(null);
  const [probing, setProbing] = useState(true);
  // 用**集合**而不是单值：两个服务的启停是各自独立的进程，可以同时进行。
  // 单值会让后开始的操作覆盖前一个，且先结束的会把另一个的"操作中"清掉
  // （表现为"还在跑但按钮已可点"）。
  const [busyKinds, setBusyKinds] = useState<ReadonlySet<ServiceKind>>(() => new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // 探活走 HTTP（不弹窗口）；serverBase 为空时探活默认 11436。
    const next = await readLocalServices(serviceBase || undefined);
    if (mountedRef.current) {
      setServices(next);
      setProbing(false);
    }
  }, [serviceBase]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggle = useCallback(
    async (kind: ServiceKind, enabled: boolean): Promise<LocalServiceResult> => {
      setBusyKinds((prev) => new Set(prev).add(kind));
      try {
        const result = await setServiceEnabled(kind, enabled);
        if (!mountedRef.current) return result;
        // 宿主回的是两个服务的真实状态——直接当作权威更新，圆点立刻反映，
        // 不必等下一次 3s 轮询。
        if (result.state) setServices(result.state);
        if (!result.error) void refresh();
        return result;
      } finally {
        if (mountedRef.current) {
          setBusyKinds((prev) => {
            const next = new Set(prev);
            next.delete(kind);
            return next;
          });
        }
      }
    },
    [refresh],
  );

  return { services, probing, busyKinds, toggle };
}

// ── 业务钩子：模型状态（列表 / 驻留 / 显存） ──────────────────────────────
/**
 * 模型状态（走 dmb_server 的 HTTP，与服务启停是两条独立链路）。
 * 轮询逻辑只写在这里一处；组件通过 refresh() 在加载/卸载后复用，不再复制 fetch。
 *
 * `ollamaBase` 为空时不查，状态置空。模型状态只从 **ollama 独立服务**（11437）来。
 */
function useModelStatus(ollamaBase: string | undefined) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!ollamaBase) {
      if (mountedRef.current) {
        setStatus(null);
        setModels([]);
        setModelError(null);
      }
      return;
    }
    try {
      const [nextStatus, list] = await Promise.all([
        fetchJson(`${ollamaBase}/model/status`),
        fetchJson(`${ollamaBase}/v1/models`),
      ]);
      if (!mountedRef.current) return;
      setStatus(nextStatus as ModelStatus);
      const data = (list as { data?: Array<{ id?: string }> })?.data ?? [];
      setModels(data.map((item) => String(item?.id ?? '')).filter(Boolean));
      setModelError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setStatus(null);
      setModels([]);
      setModelError(e instanceof Error ? e.message : String(e));
    }
  }, [ollamaBase]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { status, models, modelError, refresh };
}

// ── 纯展示：单个服务开关 ────────────────────────────────────────────────
type ServiceSwitchProps = {
  kind: ServiceKind;
  label: string;
  running: boolean;
  checked: boolean;
  probing: boolean;
  busy: boolean;
  onToggle: (kind: ServiceKind, enabled: boolean) => void;
};

function serviceStatusText(probing: boolean, running: boolean, busy: boolean): string {
  // 启停可能很久（关闭 ollama = 先卸全部模型再停引擎，真机上限到 180s），
  // 所以"这一路正在操作"要显式说出来，不能只靠按钮变灰。
  if (busy) return '操作中…';
  if (probing) return '正在连接…';
  return running ? '运行中' : '未运行';
}

function ServiceSwitch({ kind, label, running, checked, probing, busy, onToggle }: ServiceSwitchProps) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="local-row">
        <button
          type="button"
          className={`local-toggle${checked ? ' local-toggle-on' : ''}`}
          role="switch"
          aria-checked={checked}
          aria-label={`${label}开关`}
          onClick={() => onToggle(kind, !checked)}
          disabled={busy}
        >
          <span className="local-toggle-knob" />
        </button>
        <span className={`local-dot${running ? ' local-dot-ok' : ''}`} />
        <span className="local-row-text">{serviceStatusText(probing, running, busy)}</span>
      </div>
    </div>
  );
}

// ── 业务钩子：译图缓存（条数上限 + 清空） ────────────────────────────────
/**
 * 译图缓存的维护。缓存分**两层** —— 内容脚本内存（`PhotoStateStore`）与
 * off-screen 文档内存（`TranslatedImageMemoryVault`）；后者跨页面重载存活。
 *
 * 弹窗读不到也删不掉别的进程的内存，所以"改上限 / 清空 / 读现状"一律发消息给 background，
 * 由它转发到**当前标签页**的内容脚本，再由内容脚本**两层一起**操作
 * （上限以内存层算出的生效值为准，再原样交给 off-screen 那层）。
 *
 * 三条必须守住的口径：
 * - `reached === false` 表示**没连上那个页面的内容脚本**（停在 chrome:// 扩展页 / 不是目标站点），
 *   此时数字无意义 → 显示"未连接"，**不许显示 0 把"没采到"伪装成"缓存是空的"**。
 * - 显示"有几张"读的是 **`vaultSize`**（off-screen 那层），不是 `size`（内容脚本那层）——
 *   后者的条数随页面文档生灭，刷新一次就归零，拿它显示会让用户以为缓存被清空了。
 * - 上限改完**必须立刻裁一次**：淘汰只发生在写入时，不裁的话把 15 改成 3，
 *   内存里仍然躺着 15 条，要等译满第 4 张才开始缩 —— 那不是用户要的效果。
 */
function useTranslationCache(limit: number) {
  const [info, setInfo] = useState<
    { size: number; vaultSize: number; limit: number; reached: boolean } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const send = useCallback(
    async (action: 'status' | 'clear' | 'limit', nextLimit?: number) => {
      const response = await sendRuntimeMessage(
        nextLimit === undefined
          ? { type: 'mt:memory-cache', action }
          : { type: 'mt:memory-cache', action, limit: nextLimit },
      );
      if (!response.ok || response.type !== 'mt:memory-cache') {
        throw new Error(response.ok ? '译图缓存操作返回了意外的结果' : response.error);
      }
      return response.cache;
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const result = await send('status');
      if (mountedRef.current) {
        setInfo({ size: result.size, vaultSize: result.vaultSize, limit: result.limit, reached: result.reached });
      }
    } catch {
      if (mountedRef.current) setInfo(null);
    }
  }, [send]);

  // 打开弹窗时**先把设置里的上限推给当前页面**再读现状：
  // 内容脚本拿不到 settings，新开的页面用的是默认上限，不推一次两边数字会对不上。
  useEffect(() => {
    void (async () => {
      try {
        await send('limit', limitRef.current);
      } catch {
        // 页面没注入内容脚本 → 跳过，下面 refresh 会显示"未连接"
      }
      await refresh();
    })();
  }, [send, refresh]);

  const applyLimit = useCallback(
    async (nextLimit: number) => {
      setBusy(true);
      try {
        const result = await send('limit', nextLimit);
        if (!mountedRef.current) return;
        setInfo({ size: result.size, vaultSize: result.vaultSize, limit: result.limit, reached: result.reached });
        setNote(
          result.reached
            ? `上限已设为 ${result.limit} 张（现存 ${result.size} 张）`
            : '上限已保存（当前页面没有活动的译图缓存）',
        );
      } catch (error) {
        if (mountedRef.current) {
          setNote(`设置失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [send],
  );

  const clearAll = useCallback(async () => {
    setBusy(true);
    try {
      const result = await send('clear');
      if (!mountedRef.current) return;
      setInfo({ size: result.size, vaultSize: result.vaultSize, limit: result.limit, reached: result.reached });
      setNote(
        result.reached
          ? `已删除全部译图缓存（${result.cleared} 张）`
          : '当前页面没有活动的译图缓存',
      );
    } catch (error) {
      if (mountedRef.current) {
        setNote(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [send]);

  return { info, busy, note, applyLimit, clearAll, refresh };
}

/**
 * 把预取设置（预载页数 + 进入自动翻译）**推给当前标签页的内容脚本**。
 *
 * 内容脚本拿不到 settings（只有背景/弹窗有），所以每次弹窗打开时推一次，
 * 之后用户改动即推 —— 否则改完设置要等下次刷新页面才生效，用户会以为"改了没用"。
 * 推送失败（页面没注入内容脚本）静默忽略：设置本身已存进 storage，页面下次打开会带上。
 */
function usePrefetchConfigSync(
  prefetchDepth: number,
  autoTranslateOnEnter: boolean,
) {
  useEffect(() => {
    // 两个字段**一次全推**：缺哪个，内容脚本会落回默认值（比如刚关掉的预载被悄悄打开）。
    void sendRuntimeMessage({
      type: 'mt:prefetch-config',
      prefetchDepth,
      autoTranslateOnEnter,
    }).catch(() => {
      // 页面没有内容脚本（chrome:// / 非目标站点）→ 忽略；设置已落 storage。
    });
  }, [prefetchDepth, autoTranslateOnEnter]);
}

/**
 * 译图缓存行：上限输入 + 现存条数 + 删除全部。
 *
 * 缓存**只在内存里**（落盘已关闭）：浏览器会话结束即失，这是刻意的 ——
 * 最初要的只是"翻回去不用重译"，不是"重启浏览器后还在"。
 * （但**页面重载不丢**：译图另有一份活在不随页面导航销毁的 off-screen 文档里。）
 *
 * 输入用**草稿态**：敲的过程中不落库（否则每敲一个字符就改一次设置、裁一次缓存），
 * 失焦或回车才提交，非法值贴回合法边界。
 */
function TranslationCacheControl({
  limit,
  onLimitChange,
}: {
  limit: number;
  onLimitChange: (limit: number) => void;
}) {
  const { info, busy, note, applyLimit, clearAll } = useTranslationCache(limit);
  const [draft, setDraft] = useState(String(limit));

  useEffect(() => {
    setDraft(String(limit));
  }, [limit]);

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isInteger(parsed)
      ? Math.min(maxTranslationCacheLimit, Math.max(minTranslationCacheLimit, parsed))
      : limit;
    setDraft(String(next));
    if (next === limit) return;
    onLimitChange(next);
    void applyLimit(next);
  }, [draft, limit, onLimitChange, applyLimit]);

  return (
    <>
      <div className="field">
        <span className="field-label">译图缓存</span>
        <div className="local-row">
          <input
            className="cache-limit-input"
            type="number"
            inputMode="numeric"
            min={minTranslationCacheLimit}
            max={maxTranslationCacheLimit}
            aria-label="内存译图缓存条数上限"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
            }}
          />
          <span className="cache-limit-unit">张</span>
          <span className="local-row-text">
            {info === null ? '—' : info.reached ? `${info.vaultSize} / ${info.limit} 张` : '未连接'}
          </span>
          <button
            className="cache-clear-button"
            type="button"
            onClick={() => void clearAll()}
            disabled={busy}
            aria-label="删除全部内存译图缓存"
          >
            {busy ? '处理中…' : '删除全部'}
          </button>
        </div>
      </div>

      {note ? <div className="local-feedback status-saving">{note}</div> : null}
    </>
  );
}

// ── 纯 UI：向后预载行（开关 + 页数）──────────────────────────────────────────
/**
 * 「向后预载」行：**要不要预载**（药丸开关）+ **预载几页**（0–10 输入）。
 * 看第 N 页时后台预翻译 N+1…N+depth。
 *
 * ★ 2026-10-09 二次修订：本行必须是一个**独立开关**，与下面的「进入自动翻译」并列。
 *
 * 当天早些时候按「删掉冗余字段 `prefetchEnabled`」精简时，连着把这里的药丸开关一起删了 ——
 * 结果弹窗里只剩「进入自动翻译」一个开关，"预载"退化成一个纯数字，两个功能不再各有一个开关。
 * 用户两次反馈（"预载按钮没了" / "又变成耦合的了"）。而用户 2026-10-05 的原始约定是
 * **预载 / 自动翻译 双开关**（`docs/CHANGELOG.md` v0.5.2），功能各自的边界是：
 * 预载管窗口**上界**（后页 N+1…N+depth），自动翻译管窗口**下界**（当前页 N）。恢复。
 *
 * 恢复方式**不是**把 `prefetchEnabled` 字段加回来 —— 那个字段与 `depth = 0` 数学等价
 * （见 `dmbTranslatorV2-开关冗余度评估与精简方案.md` 的 6 场景穷举），加回来就要重新面对
 * "开关显示开、深度却是 0"两处状态打架的老问题。这里让开关**派生自 `prefetchDepth`**：
 *   · 显示：`depth > 0` = 开，`depth === 0` = 关 —— 唯一真相源，不可能自相矛盾；
 *   · 关 → `0`；开 → 回到 `lastNonZeroPrefetchDepth`（**设置里的字段**）。
 *
 * ★ 2026-10-10 修订：那个"记忆"从**组件内 `useRef`** 提升成了设置字段。
 *   原来的分工是"设置页有记忆、页面右下角按钮固定恢复默认深度"，理由是"快捷按钮看不见数值"——
 *   但这让**同一个动作有两套规则**，用户无法预期（在弹窗里调成 8，右下角关一下再开变回 4）。
 *   现在两处 UI 读同一个字段，规则只剩一条：开 = 回到最近一次设过的非零深度。
 *
 * 与译图缓存行同一套交互口径：输入用**草稿态**，失焦/回车才提交；`0` 是合法值 = 关闭预载。
 */
function PrefetchControl({
  depth,
  onDepthChange,
}: {
  depth: number;
  onDepthChange: (depth: number) => void;
}) {
  const [draft, setDraft] = useState(String(depth));

  /**
   * 开关"开"时回到的页数。
   *
   * 说明（2026-10-11 回退）：这里一度改成读设置里的 `lastNonZeroPrefetchDepth`，
   * 但那次改动让弹窗在切到「本地模型」时崩掉（用户当场反馈），所以先整体回退到
   * "组件内记忆"这条既有实现；等有测试护着再重做那半边。
   */
  const lastNonZeroDepth = useRef(defaultPrefetchDepth > 0 ? defaultPrefetchDepth : 1);

  useEffect(() => {
    setDraft(String(depth));
    // 记下最近一个非零深度 —— 开关"关→开"时回到它，而不是把用户刚设的页数丢掉。
    if (depth > 0) lastNonZeroDepth.current = depth;
  }, [depth]);

  const enabled = depth > 0;

  const commit = useCallback(() => {
    const parsed = Number.parseInt(draft, 10);
    const next = Number.isInteger(parsed)
      ? Math.min(maxPrefetchDepth, Math.max(minPrefetchDepth, parsed))
      : depth;
    setDraft(String(next));
    if (next === depth) return;
    onDepthChange(next);
  }, [draft, depth, onDepthChange]);

  return (
    <div className="field">
      <span className="field-label">向后预载</span>
      <div className="local-row">
        <button
          type="button"
          className={`local-toggle${enabled ? ' local-toggle-on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="向后预载开关"
          onClick={() => onDepthChange(enabled ? 0 : lastNonZeroDepth.current)}
        >
          <span className="local-toggle-knob" />
        </button>
        <input
          className="cache-limit-input"
          type="number"
          inputMode="numeric"
          min={minPrefetchDepth}
          max={maxPrefetchDepth}
          aria-label="向后预载页数"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
        <span className="cache-limit-unit">页</span>
        <span className="local-row-text">
          {enabled ? `向后预译 ${depth} 页` : '已关闭预载'}
        </span>
      </div>
    </div>
  );
}

// ── 纯 UI：进入自动翻译开关 ───────────────────────────────────────────────
/**
 * 「进入自动翻译」药丸开关：开启后进入阅读页即自动翻译**当前页**。
 *
 * 复用服务开关那套药丸样式（`.local-toggle`），保证与「本地服务 / Ollama」视觉一致；
 * 右侧文案说清当前状态（开 = 到达即译当前页，关 = 点按钮才译）。
 *
 * ★ 文案里**不再提"预载"** —— 那是 2026-10-05 拆开关之前的语义（当时这一个开关顶着两件事）。
 * 现在"要不要预载、预载几页"由上面那一行的「向后预载」开关 + 页数输入表达，两者正交、互不携带：
 * 本开关只管窗口**下界**（当前页 N），上面那个只管窗口**上界**（后页 N+1…N+depth）。
 */
function AutoTranslateToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">进入自动翻译</span>
      <div className="local-row">
        <button
          type="button"
          className={`local-toggle${enabled ? ' local-toggle-on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="进入阅读页自动翻译开关"
          onClick={() => onChange(!enabled)}
        >
          <span className="local-toggle-knob" />
        </button>
        <span className="local-row-text">
          {enabled ? '进入即翻译当前页' : '点按钮才翻译'}
        </span>
      </div>
    </div>
  );
}

// ── 容器组件：组合两个钩子 + 纯派生 + 渲染 ───────────────────────────────
export function LocalModelControl({
  baseUrl,
  model,
  onPickModel,
  cacheLimit,
  onCacheLimitChange,
  prefetchDepth,
  onPrefetchDepthChange,
  autoTranslateOnEnter,
  onAutoTranslateOnEnterChange,
}: LocalModelControlProps) {
  const serviceBase = useMemo(() => toServiceBase(baseUrl), [baseUrl]);
  // ★ 模型与 ollama 的控制全部走**独立的 ollama 服务**（11437），
  //   不再依赖 dmb_server（OCR/翻译）在不在跑 —— 两个服务各自开关、互不牵连。
  const ollamaBase = useMemo(() => ollamaServiceBase(serviceBase || undefined), [serviceBase]);

  // 服务启停 + 在不在跑：唯一真相源在钩子里。
  const { services, probing, busyKinds: busyServiceKinds, toggle } = useLocalServices(serviceBase);
  // 模型状态：另一条链路的唯一真相源（ollama 服务）。
  const { status, models, modelError, refresh: refreshModel } = useModelStatus(ollamaBase);

  // 预取设置随时推给当前标签页（打开弹窗推一次 + 每次改动即推）。
  usePrefetchConfigSync(prefetchDepth, autoTranslateOnEnter);

  // 模型加载/卸载的忙碌态与操作反馈（纯 UI）。
  const [busyAction, setBusyAction] = useState<ModelAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // 用户意图：开关点了立刻翻；圆点才表达真实状态。首次真实探活回来时初始化一次。
  const [intent, setIntent] = useState<Record<ServiceKind, boolean> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const serverRunning = services?.server.running === true;
  const ollamaRunning = services?.ollama.running === true;
  const busy = busyAction !== null;

  // 首轮探活回来后，用"真实状态"初始化一次意图；此后意图只由点击改变。
  // 这样即使服务后来自己挂了，开关仍停在用户的选择上，由圆点把"没跑起来"表达出来。
  useEffect(() => {
    if (intent !== null || probing || !services) return;
    setIntent({ server: services.server.running, ollama: services.ollama.running });
  }, [intent, probing, services]);

  const runAction = useCallback(
    async (action: ModelAction) => {
      if (!ollamaBase || !model) return;
      const verb = action === 'load' ? '加载' : '卸载';
      setBusyAction(action);
      setFeedback({ kind: 'saving', text: `${verb}中：${model} …` });
      const startedAt = Date.now();
      try {
        const result = (await fetchJson(
          `${ollamaBase}/model/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
          },
          action === 'load' ? 300000 : 60000,
        )) as { detail?: string };
        if (!mountedRef.current) return;
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        setFeedback({
          kind: 'success',
          text: `已${verb}（${seconds}s）${result?.detail ? ` · ${result.detail}` : ''}`,
        });
      } catch (e) {
        if (!mountedRef.current) return;
        setFeedback({
          kind: 'error',
          text: `${verb}失败：${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        if (mountedRef.current) setBusyAction(null);
        // 复用钩子的 refresh，不再复制一份 fetch 逻辑。
        void refreshModel();
      }
    },
    [model, ollamaBase, refreshModel],
  );

  const onToggleService = useCallback(
    async (kind: ServiceKind, enabled: boolean) => {
      // 先翻开关（意图），再由圆点表达"到底起来没有"
      setIntent((prev) => ({
        server: prev?.server ?? serverRunning,
        ollama: prev?.ollama ?? ollamaRunning,
        [kind]: enabled,
      }));
      setFeedback(null);
      const result = await toggle(kind, enabled);
      if (!mountedRef.current) return;
      if (result.error) {
        // 启动/停止失败 → 开关弹回原状，并把原因亮出来
        setIntent((prev) => (prev ? { ...prev, [kind]: !enabled } : prev));
        setFeedback({ kind: 'error', text: result.error });
      }
    },
    [ollamaRunning, serverRunning, toggle],
  );

  // 图标跟着 dmb_server 在不在跑走（开=icon*-on.png，关=扩展原图标）
  useEffect(() => {
    applyToolbarIcon(serverRunning);
  }, [serverRunning]);

  const loadedBases = new Set((status?.loaded ?? []).map((item) => baseName(String(item.name))));
  const modelLoaded = Boolean(model) && loadedBases.has(baseName(model));
  const known = models.includes(model) ? models : model ? [model, ...models] : models;
  const selectOptions = [
    { value: PLACEHOLDER_VALUE, label: '请选择模型' },
    ...known.map((name) => ({
      value: name,
      label: loadedBases.has(baseName(name)) ? `${name} · 已加载` : name,
    })),
  ];

  // 只讲加载与否，不含显存。
  // 分三层：没选模型 → 服务没跑（这种情况最该说清楚，而不是显示个"—"）→ 真的读失败
  const modelText = !model
    ? '尚未选择模型'
    : !serverRunning
      ? '本地服务未运行'
      : modelError
        ? `读取失败（${modelError}）`
        : modelLoaded
          ? '已加载'
          : '未加载';

  // 显存占用 = 模型加载后实际占的显存（不是整卡用量）。
  // 没有驻留模型时显示 —，避免让人误以为"可用显存为 0"。
  const vramText = status && status.loaded_total_vram > 0
    ? `${Math.round(status.loaded_total_vram / 1048576)} MB`
    : '—';

  return (
    <>
      {/* ★ busy 必须**按路**给：两个服务是各自独立的进程，启停互不依赖。
          之前两边都吃同一个 `busyService !== null`，于是"任一路在启停"就把另一个
          开关也一起 disable —— 关闭 ollama 最慢（先卸模型再停引擎），体感就成了
          "必须等它跑完才能开另一个"。 */}
      <ServiceSwitch
        kind="server"
        label="本地服务"
        running={serverRunning}
        checked={intent?.server ?? serverRunning}
        probing={probing}
        busy={busyServiceKinds.has('server')}
        onToggle={onToggleService}
      />
      <ServiceSwitch
        kind="ollama"
        label="Ollama"
        running={ollamaRunning}
        checked={intent?.ollama ?? ollamaRunning}
        probing={probing}
        busy={busyServiceKinds.has('ollama')}
        onToggle={onToggleService}
      />

      <div className="field">
        <span className="field-label">本地模型</span>
        <SelectControl
          ariaLabel="本地模型"
          options={selectOptions}
          value={model || PLACEHOLDER_VALUE}
          onChange={onPickModel}
          disabled={busy || selectOptions.length <= 1}
        />
      </div>

      <div className="field">
        <span className="field-label">模型状态</span>
        <span className="local-row-text">{modelText}</span>
      </div>

      <div className="field">
        <span className="field-label">显存占用</span>
        <span className="local-row-text">{vramText}</span>
      </div>

      <div className="local-actions">
        <button
          className="oauth-action"
          type="button"
          onClick={() => void runAction('load')}
          disabled={busy || !model || modelLoaded}
        >
          {busyAction === 'load' ? '加载中…' : '加载模型'}
        </button>
        <button
          className="oauth-action"
          type="button"
          onClick={() => void runAction('unload')}
          disabled={busy || !model || !modelLoaded}
        >
          {busyAction === 'unload' ? '卸载中…' : '卸载模型'}
        </button>
      </div>

      <TranslationCacheControl limit={cacheLimit} onLimitChange={onCacheLimitChange} />

      <PrefetchControl depth={prefetchDepth} onDepthChange={onPrefetchDepthChange} />

      <AutoTranslateToggle enabled={autoTranslateOnEnter} onChange={onAutoTranslateOnEnterChange} />

      {feedback ? (
        <div className={`local-feedback status-${feedback.kind}`}>{feedback.text}</div>
      ) : null}
    </>
  );
}
