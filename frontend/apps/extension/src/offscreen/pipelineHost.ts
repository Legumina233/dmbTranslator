import {
  ImagePipelineCancelledError,
  createImagePipeline,
  probeTextDetection,
  type ImagePipeline,
  type PipelineConfig,
  type PipelineCancellationReason,
  type PipelinePlatform,
  type PrecomputedTextDetection,
  configureServerOcr,
} from '@dmb/image-pipeline';

import { createEventLog, createRequestId } from '../shared/eventLog';
import { createHttpEventLogSink, resolveEventLogBase } from '../shared/eventLogSink';
import {
  summarizeStages,
  toLines,
} from './pipelineTelemetry';
import type {
  PageLogLine,
  ServerLlmTiming,
  ServerOcrTiming,
  StageTrailEntry,
} from './pipelineTelemetry';
import type { ExtensionPort } from '../shared/extensionRuntime';
import { isExtensionContextInvalidated } from '../shared/extensionRuntime';
import { base64ToBlob, blobToBase64 } from '@dmb/image-pipeline/protocol';
import {
  RuntimePipelineHostTransport,
  type PipelineHostTransport,
} from '../shared/pipelineHostTransport';
import {
  emitDiagnosticLog,
  emitDiagnosticLogAsync,
  type DiagnosticLogEmitter,
} from '../shared/diagnosticLogClient';
import {
  Base64ChunkAssembler,
  LOCAL_PIPELINE_IDLE_TIMEOUT_MS,
  LOCAL_PIPELINE_HOST_PORT,
  createCancelledError,
  createProtocolError,
  isLocalPipelineClientMessage,
  serializePipelineError,
  splitBase64Chunks,
  summarizePipelineArtifacts,
  type LocalPipelineArtifactMeta,
  type LocalPipelineClientMessage,
  type LocalPipelineFileMeta,
  type LocalPipelineHostMessage,
} from '@dmb/image-pipeline/protocol';
import { setPerfTraceSink, type PerfTraceRuntimeEvent, type PerfTraceWorkerCall } from '@dmb/diagnostics';
import type { ModelRuntime } from '@dmb/model-runtime';
import {
  extensionTextTranslationTransport,
} from '../shared/textTranslationTransport';
import {
  createTextTranslator,
  type TextTranslationRegion,
  type TextTranslationRequest,
  type TextTranslationTransport,
  type TextTranslator,
} from '@dmb/text-translation';

/**
 * 取出错误自报的失败阶段（`runOperation` 抛 `ImagePipelineExecutionError` 时会挂 stage）。
 * 拿不到就返回 undefined，由调用方决定兜底 —— 这里不猜。
 */
function stageOfError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const stage = (error as { stage?: unknown }).stage;
  return typeof stage === 'string' && stage.length > 0 ? stage : undefined;
}

/**
 * 失败的**完整原因**：沿 `cause` 链拼成一行（最多 4 层，去重）。
 *
 * 为什么需要它：最外层 `ImagePipelineExecutionError.message` 只是 messageKey
 * （`pipeline.failure.stage`），**真因在 cause 链上** —— `PipelineStageError.message`
 * 形如 `"<阶段>失败: <detail>"`，再往内是 provider 抛的原话（例如
 * `"OCR 服务返回 503：manga-ocr 不可用: RuntimeError: CUDA error: out of memory"`）。
 * 只记最外层，等于支持包里只剩一个 messageKey：用户发来"翻译失败：pipeline.failure.stage"
 * 时完全无法定位（2026-10-05 真机事故的教训）。
 */
export function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const text = current instanceof Error ? current.message : String(current);
    if (text && !parts.includes(text)) parts.push(text);
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(' ← ');
}

type RuntimeAggregate = {
  model: string;
  provider?: string;
  calls: number;
  totalDurationMs: number;
  maxDurationMs: number;
  inputBytes: number;
  outputBytes: number;
  failures: number;
};

export type PipelineHostDependencies = {
  translationTransport?: TextTranslationTransport;
  diagnostics?: DiagnosticLogEmitter;
  modelRuntime: ModelRuntime;
  platform: PipelinePlatform;
  fontSource?: (path: string) => string;
  hostInstanceId?: string;
  idleTimeoutMs?: number;
  /**
   * 空闲时**是否必须留着这个文档**。
   *
   * ★ 2026-10-10 起：译图缓存已落到 **IndexedDB**（`translatedImageCacheStore`），
   * 文档关掉也不会丢数据 —— 这条闸门因此不再是"保缓存"的正确性依赖，
   * 只用来减少文档重建（少一次 ONNX 冷启动）。缓存非空时仍不放行关闭。
   * 不传 = 恒定 false = 与加这条闸门之前的行为完全一致。
   */
  keepAliveWhenIdle?: () => boolean;
};

const extensionPipelineHostDiagnostics: DiagnosticLogEmitter = {
  emit: emitDiagnosticLog,
  emitAsync: emitDiagnosticLogAsync,
};

type PipelineJob = {
  id: string;
  diagnosticRunId?: string;
  fileMeta?: LocalPipelineFileMeta;
  config?: PipelineConfig;
  operation?: 'pipeline' | 'detection-probe';
  precomputedDetection?: PrecomputedTextDetection;
  input?: Base64ChunkAssembler;
  file?: File;
  abortController: AbortController;
  cancellationReason?: PipelineCancellationReason;
  state: 'prepared' | 'receiving' | 'queued' | 'active' | 'finished';
};

type PipelineTerminalMessage = Extract<
  LocalPipelineHostMessage,
  { type: 'complete' | 'error' }
>;

function safelyPost(port: ExtensionPort | null, message: LocalPipelineHostMessage): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function toArtifactMeta(contentType: string, chunks: string[], totalChars: number): LocalPipelineArtifactMeta {
  return {
    contentType,
    chunkCount: chunks.length,
    totalChars,
  };
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'TASK_CANCELLED');
}

function getMessageJobId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

function createHostInstanceId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `pipeline-host-${crypto.randomUUID()}`
    : `pipeline-host-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * M0 · 事件流的会话 ID：一个 offscreen 文档生命周期内恒定（`sessionId` 的口径）。
 * 与 `runId`（一次翻译任务）、`requestId`（一次跨进程请求）分工不同，别混用。
 */
const eventSessionId = createRequestId('s');

export class PipelineHost {  private port: ExtensionPort | null = null;
  private readonly jobs = new Map<string, PipelineJob>();
  private readonly queue: PipelineJob[] = [];
  private activeJob: PipelineJob | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReleasePromise: Promise<void> | null = null;
  private idleGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly imageRuntime: ImagePipeline;
  private readonly platform: PipelinePlatform;
  private readonly modelRuntime: ModelRuntime;
  private readonly translationTransport: TextTranslationTransport;
  private readonly diagnostics: DiagnosticLogEmitter;
  private readonly hostInstanceId: string;
  private readonly idleTimeoutMs: number;
  private readonly keepAliveWhenIdle: () => boolean;

  constructor(
    private readonly transport: PipelineHostTransport = new RuntimePipelineHostTransport(),
    dependencies: PipelineHostDependencies,
  ) {
    this.translationTransport = dependencies.translationTransport
      ?? extensionTextTranslationTransport;
    this.diagnostics = dependencies.diagnostics
      ?? extensionPipelineHostDiagnostics;
    this.modelRuntime = dependencies.modelRuntime;
    this.platform = dependencies.platform;
    this.hostInstanceId = dependencies.hostInstanceId ?? createHostInstanceId();
    this.idleTimeoutMs = dependencies.idleTimeoutMs ?? LOCAL_PIPELINE_IDLE_TIMEOUT_MS;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 0) {
      throw new RangeError('PipelineHost idleTimeoutMs 必须是非负有限数值');
    }
    this.keepAliveWhenIdle = dependencies.keepAliveWhenIdle ?? (() => false);
    this.imageRuntime = createImagePipeline({
      platform: dependencies.platform,
      modelRuntime: this.modelRuntime,
      detectionFallbackStrategy: { kind: 'heuristic-only' },
      fontSource: dependencies.fontSource,
      observer: this.diagnostics,
    });
    this.emitLifecycleEvent('host-created', '流水线宿主已创建');
  }

  private emitLifecycleEvent(
    lifecycleEvent: 'host-created' | 'host-ready' | 'idle-close-requested' | 'host-disposed',
    message: string,
  ): void {
    this.diagnostics.emit({
      level: 'info',
      category: 'runtime.message',
      source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
      message,
      data: {
        lifecycleEvent,
        hostInstanceId: this.hostInstanceId,
      },
    });
  }

  connect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      const port = this.transport.connect(LOCAL_PIPELINE_HOST_PORT);
      this.port = port;
      port.onMessage.addListener((message) => {
        void this.handleMessage(message);
      });
      port.onDisconnect.addListener(() => {
        this.handleDisconnect(port);
      });
      safelyPost(port, { type: 'host-ready', hostInstanceId: this.hostInstanceId });
      this.emitLifecycleEvent('host-ready', '流水线宿主已连接');
      this.scheduleIdleClose();
    } catch (error) {
      // 扩展被重载/更新后，残留的旧 offscreen 文档连不上新实例 —— 每次自动重连
      // 都会抛 "Extension context invalidated."。正确行为是静默退场：不再重连、
      // 不把控制台刷成错误海（新实例自己会建新宿主）。
      if (isExtensionContextInvalidated(error)) {
        this.disposed = true;
        return;
      }
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.emitLifecycleEvent('host-disposed', '流水线宿主已关闭');
    this.clearIdleClose();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const cancellation = createCancelledError('流水线宿主已关闭');
    if (this.activeJob) {
      this.activeJob.cancellationReason = {
        code: 'runtime-disposed',
        messageKey: 'pipeline.cancelled.runtimeDisposed',
        diagnosticSummary: cancellation.message,
      };
    }
    this.activeJob?.abortController.abort(cancellation);
    for (const job of this.jobs.values()) {
      if (job !== this.activeJob) job.abortController.abort(cancellation);
    }
    this.queue.length = 0;
    this.jobs.clear();
    void this.imageRuntime.dispose({
      code: 'runtime-disposed',
      messageKey: 'pipeline.cancelled.runtimeDisposed',
      diagnosticSummary: cancellation.message,
    });
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isLocalPipelineClientMessage(value)) {
      const jobId = getMessageJobId(value);
      if (jobId) this.failJobId(jobId, createProtocolError('流水线宿主收到无效消息'));
      return;
    }
    this.clearIdleClose();
    try {
      switch (value.type) {
        case 'prepare':
          this.prepare(value);
          break;
        case 'start':
        case 'start-detection-probe':
          this.startTransfer(value);
          break;
        case 'input-chunk':
          this.receiveChunk(value);
          break;
        case 'input-complete':
          this.completeTransfer(value);
          break;
        case 'cancel':
          this.cancel(value.jobId, value.reason);
          break;
      }
    } catch (error) {
      this.failJobId(value.jobId, error);
    }
  }

  private prepare(message: Extract<LocalPipelineClientMessage, { type: 'prepare' }>): void {
    if (this.jobs.has(message.jobId)) {
      throw createProtocolError(`任务 ID 已存在: ${message.jobId}`);
    }
    if (this.jobs.size > 0 || this.activeJob) {
      const error = new Error('流水线宿主正在处理另一张图片') as Error & {
        code: 'RUNTIME_BUSY';
      };
      error.name = 'ImagePipelineAdmissionError';
      error.code = 'RUNTIME_BUSY';
      throw error;
    }
    this.jobs.set(message.jobId, {
      id: message.jobId,
      diagnosticRunId: message.diagnosticRunId,
      abortController: new AbortController(),
      state: 'prepared',
    });
    safelyPost(this.port, { type: 'ready', jobId: message.jobId });
  }

  private startTransfer(message: Extract<
    LocalPipelineClientMessage,
    { type: 'start' | 'start-detection-probe' }
  >): void {
    const job = this.requireJob(message.jobId, 'prepared');
    job.fileMeta = message.file;
    job.operation = message.type === 'start' ? 'pipeline' : 'detection-probe';
    if (message.type === 'start') {
      job.config = message.config;
      if (message.detection) {
        job.precomputedDetection = {
          width: message.detection.width,
          height: message.detection.height,
          packedMask: base64ToBlob(
            message.detection.packedMaskBase64,
            'application/octet-stream',
          ),
          regions: message.detection.regions,
        };
      }
    }
    job.input = new Base64ChunkAssembler(message.input);
    job.state = 'receiving';
  }

  private receiveChunk(message: Extract<LocalPipelineClientMessage, { type: 'input-chunk' }>): void {
    const job = this.requireJob(message.jobId, 'receiving');
    job.input?.add(message.index, message.data);
  }

  private completeTransfer(message: Extract<LocalPipelineClientMessage, { type: 'input-complete' }>): void {
    const job = this.requireJob(message.jobId, 'receiving');
    if (
      !job.input
      || !job.fileMeta
      || !job.operation
      || (job.operation === 'pipeline' && !job.config)
    ) {
      throw createProtocolError('输入传输尚未初始化');
    }
    const base64 = job.input.complete();
    const blob = base64ToBlob(base64, job.fileMeta.type);
    if (blob.size !== job.fileMeta.size) {
      throw createProtocolError(`输入图片大小不符: 期望 ${job.fileMeta.size}, 实际 ${blob.size}`);
    }
    job.file = new File([blob], job.fileMeta.name, {
      type: job.fileMeta.type,
      lastModified: job.fileMeta.lastModified,
    });
    job.state = 'queued';
    this.queue.push(job);
    this.postQueuePositions();
    void this.pump();
  }

  private cancel(
    jobId: string,
    reason?: PipelineCancellationReason | string,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job || job.state === 'finished') return;
    const cancellationReason: PipelineCancellationReason = (
      reason
      && typeof reason === 'object'
    ) ? reason : {
      code: typeof reason === 'string' ? 'user-requested' : 'unknown',
      messageKey: typeof reason === 'string'
        ? 'pipeline.cancelled.userRequested'
        : 'pipeline.cancelled.unknown',
      diagnosticSummary: reason || '本地流水线任务已取消',
    };
    const cancellation = new ImagePipelineCancelledError(cancellationReason);
    if (job === this.activeJob) {
      job.cancellationReason = cancellationReason;
      job.abortController.abort(cancellation);
      return;
    }
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    this.failJob(job, cancellation);
    this.postQueuePositions();
    this.scheduleIdleClose();
  }

  private requireJob(jobId: string, state: PipelineJob['state']): PipelineJob {
    const job = this.jobs.get(jobId);
    if (!job) throw createProtocolError(`未知任务: ${jobId}`);
    if (job.state !== state) {
      throw createProtocolError(`任务 ${jobId} 状态错误: 期望 ${state}, 实际 ${job.state}`);
    }
    return job;
  }

  private async pump(): Promise<void> {
    if (this.activeJob) return;
    if (this.idleReleasePromise) {
      await this.idleReleasePromise.catch(() => undefined);
      if (this.activeJob) return;
    }
    const job = this.queue.shift();
    if (!job) {
      this.scheduleIdleClose();
      return;
    }
    this.activeJob = job;
    job.state = 'active';
    this.postQueuePositions();
    let terminalMessage: PipelineTerminalMessage;
    try {
      terminalMessage = await this.execute(job);
    } catch (error) {
      terminalMessage = this.finishJob(job, error);
    }
    this.activeJob = null;
    this.postQueuePositions();
    const deliveryPort = this.port;
    if (!safelyPost(deliveryPort, terminalMessage) && deliveryPort) {
      this.handleDisconnect(deliveryPort);
    }
    void this.pump();
  }

  private async execute(job: PipelineJob): Promise<PipelineTerminalMessage> {
    if (!job.file || !job.operation || (job.operation === 'pipeline' && !job.config)) {
      return this.finishJob(job, createProtocolError('任务缺少图片或流水线配置'));
    }

    if (job.operation === 'detection-probe') {
      return this.executeDetectionProbe(job);
    }
    const config = job.config;
    if (!config) return this.finishJob(job, createProtocolError('任务缺少流水线配置'));

    const aggregates = new Map<string, RuntimeAggregate>();
    const removePerfSink = setPerfTraceSink({
      recordWorkerCall: (call) => this.aggregateWorkerCall(aggregates, call),
      recordRuntimeEvent: (event) => this.recordRuntimeEvent(job, event),
    });
    const startedAt = performance.now();
    await this.diagnostics.emitAsync({
      runId: job.diagnosticRunId,
      level: 'info',
      category: 'pipeline.stage',
      source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
      message: '本地流水线宿主开始执行',
      data: {
        jobId: job.id,
        queueDepth: this.queue.length,
        file: {
          name: job.file.name,
          type: job.file.type,
          size: job.file.size,
        },
      },
    });

    let stopProgress = (): void => undefined;
    let stopCancellation = (): void => undefined;
    let serverOcrTiming: ServerOcrTiming | undefined;
    let serverLlmTiming: ServerLlmTiming | undefined;
    // 原文/译文闸门（弹窗「记录原文 / 译文」）：只有显式 true 才采集逐行内容。
    // **关闭时下面每个采集器都退化成 no-op**，主路径与"压根没有这套探针"一致 ——
    // 探针绝不能因为"反正很小"就在关闭时还占着 CPU/内存。
    const recordSourceText = config.recordSourceText === true;
    /**
     * M0 · 统一事件流（日志体系重构的唯一出口）。
     *
     * 出口：批量 POST 到本机服务 `/log/events`，`keepalive` + fire-and-forget，
     * **永不 await**（约束：不影响翻译任务的速度）。地址推导收敛在 shared
     * （`resolveEventLogBase`：优先 OCR 服务地址，没有就退回翻译服务同源地址，
     * 且**只接受 loopback**；不与"用户换没换 OCR 引擎"挂钩 —— 踩过）。
     */
    const eventBase = resolveEventLogBase({
      ocrServerBaseUrl: config.ocrServerBaseUrl,
      llmBaseUrl: config.llmBaseUrl,
    });
    /**
     * 事件流是否可用（有本机服务地址）。**这才是采集点该看的闸门**：
     * `page.completed.stages` 是 L0 数据，不能挂在 L1（`recordSourceText`）上 ——
     * 否则用户关掉"日志含原文"，阶段耗时就跟着一起没了，而那本来是最常看的东西。
     */
    /**
     * 通道 A 的总闸门 = **本机服务在线** 且 **用户没关掉「本机事件日志」**。
     * 两个条件缺一，整条事件流（含阶段轨迹、总结事件）都是 no-op。
     */
    const eventLogEnabled = eventBase !== undefined && config.eventLogEnabled !== false;
    const eventLog = createEventLog({
      sessionId: eventSessionId,
      enabled: eventLogEnabled,
      // 详细层 = 逐行原文/译文。注意它**不等于**"事件流是否可用"：
      // 事件照写，只是不写用户在看的那几行日文和译文。
      verbose: recordSourceText,
      // M2：sink 也走 shared，与 background 侧同一个实现（地址拼装/吞错规则不分叉）。
      sink: createHttpEventLogSink(eventBase),
    });
    /**
     * 整页日志：实时阶段轨迹。
     *
     * 为什么需要它：pipeline 成功时阶段耗时在 summary 里，但一旦失败就抛异常，
     * orchestrator 的局部 stageTimings 随之丢失 —— 于是"出错之前的阶段"一条都不剩。
     * orchestrator 每进入一个阶段都会 report(stage)，那是它自己声明的阶段流，
     * 用相邻两次进入的时间差即可还原各阶段耗时（含出错的那一站）。
     * `done` 是"某组阶段结束"的收尾标记，不是阶段本身，不入轨迹。
     */
    const stageTrail: StageTrailEntry[] = [];
    let trailStage: string | undefined;
    let trailLabel = '';
    let trailT0 = performance.now();
    /**
     * 整页日志：逐行原文/译文。
     *
     * 为什么要在这一层摘：`PipelineRecord.translations` 取的是 `order` 阶段（translate **之前**）
     * 的快照，它的 `translatedText` 恒为空串 —— 直接用它记日志会得到一整列空译文。
     * 真正的译文随 `translateRegions` 的返回值回来，那就在这儿顺手接住。
     */
    let capturedLines: PageLogLine[] = [];
    const markStage = (stage: string | undefined, label: string): void => {
      // M4：采集闸门从 L1（recordSourceText）改为**事件流闸门** —— 阶段轨迹是 L0 数据，
      // 事件流关掉时仍然整体 no-op（用户要求"开关关闭时必须退化成 no-op"依旧成立）。
      if (!eventLogEnabled || !stage || stage === 'done' || stage === trailStage) return;
      const now = performance.now();
      if (trailStage) {
        stageTrail.push({ stage: trailStage, label: trailLabel, ms: Math.round(now - trailT0) });
      }
      trailStage = stage;
      trailLabel = label;
      trailT0 = now;
    };
    // 收口：把正在跑的最后一站（即出错/取消所在站）按"到此刻为止"封上
    const closeStageTrail = (): StageTrailEntry[] => (
      trailStage
        ? [...stageTrail, { stage: trailStage, label: trailLabel, ms: Math.round(performance.now() - trailT0) }]
        : stageTrail
    );
    try {
      // OCR 引擎 = 本机服务版 manga-ocr 时，把服务地址注入 provider
      // （provider 自己不做 settings 读取：它只认注入进来的地址）。
      // 整页日志（旁路）：本次运行采集服务端侧耗时（声明在 try 外，catch 里也要用）
      configureServerOcr(
        config.ocrEngine === 'manga_ocr_server' && config.ocrServerBaseUrl
          ? {
              baseUrl: config.ocrServerBaseUrl,
              onTiming: (timing) => {
                serverOcrTiming = timing;
              },
            }
          : null,
      );
      const runTranslate = createTextTranslator({
        // ★ 摘下服务端自报的 dmb_timing（其余原样透传，语义不变）。
        // **无条件包这一层**：它是 L0 数据（服务端 load/prefill/generate 耗时），与
        // "要不要写逐行原文"（L1）无关。原先这里挂 `recordSourceText` 条件，结果是
        // OCR 侧耗时无条件采集、LLM 侧耗时只在 L1 打开时才有 —— 用户没开详细层就
        // 只看到一半，与上面"L0 不能挂在 L1 上"的口径自相矛盾（2026-10-05 审计修复）。
        transport: {
          requestChatCompletion: async (request) => {
            const response = await this.translationTransport.requestChatCompletion(request);
            const timing = (response as { dmb_timing?: ServerLlmTiming } | null | undefined)?.dmb_timing;
            if (timing) serverLlmTiming = timing;
            return response;
          },
        },
        observer: this.diagnostics,
      });
      // 薄薄包一层：只为把译文抄一份给 L1（逐行原文/译文），其余行为与返回值原样透传。
      // L1 关闭时**原样交出原翻译器** —— 连这层调用与那次 map 都不产生。
      const textTranslator: TextTranslator = recordSourceText
        ? {
            translateRegions: async <T extends TextTranslationRegion>(
              request: TextTranslationRequest<T>,
            ) => {
              const result = await runTranslate.translateRegions(request);
              capturedLines = (result?.regions ?? []).map((region, index) => ({
                id: region.id,
                jp: region.sourceText,
                zh: region.translatedText,
                order: index,
                ...(region.direction ? { direction: region.direction } : {}),
              }));
              return result;
            },
          }
        : runTranslate;

      const task = this.imageRuntime.run({
        source: job.file,
        config,
        workingCopy: { strategy: 'source-native' },
        precomputedDetection: job.precomputedDetection,
      }, {
        textTranslator,
      });
      stopProgress = task.progress((progress) => {
        // 整页日志：进一站记一站（失败时这些就是"出错之前的阶段"）
        markStage(progress.stage, progress.detail ?? progress.operation);
        safelyPost(this.port, {
          type: 'progress',
          jobId: job.id,
          progress: {
            ...progress,
            detail: progress.detail ?? progress.operation,
          },
        });
      });
      const cancel = (): void => task.cancel(
        job.cancellationReason ?? {
          code: 'unknown',
          messageKey: 'pipeline.cancelled.unknown',
          diagnosticSummary: job.abortController.signal.reason instanceof Error
            ? job.abortController.signal.reason.message
            : String(job.abortController.signal.reason ?? ''),
        },
      );
      job.abortController.signal.addEventListener('abort', cancel, { once: true });
      stopCancellation = () => {
        job.abortController.signal.removeEventListener('abort', cancel);
      };
      if (job.abortController.signal.aborted) cancel();

      const throwIfJobCancelled = (): void => {
        if (!job.abortController.signal.aborted) return;
        throw new ImagePipelineCancelledError(
          job.cancellationReason ?? {
            code: 'unknown',
            messageKey: 'pipeline.cancelled.unknown',
            diagnosticSummary: job.abortController.signal.reason instanceof Error
              ? job.abortController.signal.reason.message
              : String(job.abortController.signal.reason ?? ''),
          },
        );
      };
      const pipelineResult = await task.result;
      throwIfJobCancelled();
      const summary = pipelineResult.diagnostics?.summary as ReturnType<
        typeof summarizePipelineArtifacts
      >;
      // M4：整页日志（独立系统 + `POST /log/page`）**已下线** —— 它的记录口径原样搬到
      // 下面这条 `page.completed` 事件里（`summarizeStages` 就是原来 `buildPageLogRecord`
      // 里那段：total_ms 只在 parallel 在场时跳过子阶段，否则 Translate 会被算两遍）。
      // ★ 2026-10-06 修：成功路径**不能**把 `trail` 一起传下去。
      // `summarizeStages` 的契约是"给了轨迹就以轨迹为准"（失败路径显式带轨迹、
      // 不许回退到 summary —— 见 tests/offscreen/pipelineTelemetry.test.ts），
      // 而健康路径上 `trail` 同样非空（每次 `report` 都会记一条），于是权威的
      // `summaryTimings` 被整个丢掉。偏偏 `parallel` 的三个子阶段
      // （`translate` / `mask_refine` / `inpaint`）的耗时**只存在于 summaryTimings**：
      // trail 里只有 progress 事件，`translate` 那条紧挨着下一条 report，恒算出 0ms。
      // 症状就是 `page.completed` 里 translate 永远是 0ms、去字两站从不出现，
      // "并行段那十几秒到底花在哪里"完全不可观测。
      // 只有 summary 缺失（pipeline 没吐出诊断）时才退回轨迹。
      const completed = summarizeStages({
        summaryTimings: summary?.stageTimings,
        ...(summary?.stageTimings?.length ? {} : { trail: closeStageTrail() }),
      });
      eventLog.emit({
        level: 'info',
        kind: 'page.completed',
        runId: job.diagnosticRunId,
        pageKey: config.pageKey,
        where: { repo: 'extension', module: 'pipelineHost', fn: 'runJob' },
        what: {
          status: 'ok',
          // 设计 §7：`stages[]` 是 L0 的固定字段（含 label、逐站耗时；出错站会带 failed）。
          stages: completed.stages,
          stageCount: completed.stages.length,
          regionCount: capturedLines.length,
          // M1：服务端为 /ocr 与 /v1 各生成一个贯穿 ID 随响应回到这里，
          // 记下它就能和 logs/events/*.events.jsonl 里服务端那两条事件按 ID 对齐。
          requestIds: {
            ocr: serverOcrTiming?.requestId,
            llm: serverLlmTiming?.requestId,
          },
          ocr: serverOcrTiming ?? null,
          llm: serverLlmTiming ?? null,
          // 设计 §7：**只有 L1（详细层）才含逐行原文/译文**。
          // 默认不含原文是对用户的承诺，用户才敢把日志发出去。
          ...(recordSourceText ? { lines: toLines(capturedLines, pipelineResult.record) } : {}),
        },
        // 原样沿用整页日志那份口径（parallel 在场时不吃子阶段的重复计数）。
        dur_ms: completed.totalMs,
      });
      eventLog.flush();
      const resultBlob = pipelineResult.image;
      const debugBlob = pipelineResult.debug;
      const resultBase64 = await blobToBase64(resultBlob);
      throwIfJobCancelled();
      const resultChunks = splitBase64Chunks(resultBase64);
      const debugBase64 = debugBlob ? await blobToBase64(debugBlob) : undefined;
      throwIfJobCancelled();
      const debugChunks = debugBase64 === undefined ? undefined : splitBase64Chunks(debugBase64);

      const deliveryPort = this.port;
      let delivered = safelyPost(deliveryPort, {
        type: 'result-meta',
        jobId: job.id,
        status: pipelineResult.status,
        result: toArtifactMeta(resultBlob.type || 'image/png', resultChunks, resultBase64.length),
        debug: debugBlob && debugBase64 !== undefined && debugChunks
          ? toArtifactMeta(debugBlob.type || 'image/png', debugChunks, debugBase64.length)
          : undefined,
        summary,
        record: pipelineResult.record,
      });
      throwIfJobCancelled();
      delivered = delivered && this.postArtifactChunks(job.id, 'result', resultChunks);
      throwIfJobCancelled();
      delivered = delivered
        && (!debugChunks || this.postArtifactChunks(job.id, 'debug', debugChunks));
      throwIfJobCancelled();
      if (!delivered) {
        if (deliveryPort) this.handleDisconnect(deliveryPort);
        throw createProtocolError('流水线宿主结果传输失败');
      }
      job.state = 'finished';
      this.jobs.delete(job.id);

      await this.diagnostics.emitAsync({
        runId: job.diagnosticRunId,
        level: 'info',
        category: 'pipeline.stage',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '本地流水线宿主执行完成',
        data: {
          jobId: job.id,
          durationMs: performance.now() - startedAt,
          resultBytes: resultBlob.size,
          debugBytes: debugBlob?.size,
          runtimeInference: [...aggregates.values()],
        },
      });
      return { type: 'complete', jobId: job.id };
    } catch (error) {
      const finalError = job.abortController.signal.aborted && !isAbortError(error)
        ? job.abortController.signal.reason ?? createCancelledError()
        : error;
      const terminalMessage = this.finishJob(job, finalError);
      // 出错阶段：优先用错误自带的值（runOperation 抛错时会挂 stage，是权威来源）；
      // 取不到才退回"最后进入过的阶段"——顺序执行下错误只会来自当前这一站。
      const failureStage = stageOfError(finalError) ?? trailStage;
      // M4：整页日志已下线，它的口径（含"出错那一站就地标 failed"）搬到这里。
      const failed = summarizeStages({
        trail: closeStageTrail(),
        errorStage: failureStage,
      });
      // M0 · 统一事件流：失败/取消也记（设计 §8「失败是第一公民」——
      // pipeline 之外就抛的错将来也必须发 failure，这里是第一个落点）
      eventLog.emit({
        level: job.abortController.signal.aborted ? 'info' : 'error',
        kind: 'failure',
        runId: job.diagnosticRunId,
        pageKey: config?.pageKey,
        where: { repo: 'extension', module: 'pipelineHost', fn: 'runJob' },
        what: {
          stage: failureStage,
          cancelled: job.abortController.signal.aborted === true,
          // ★ 归因（2026-10-10）：取消原因原来只活在内存里，事件流里只剩一个
          //   `pipeline.cancelled.userRequested` —— 于是「用户点了终止翻译」与
          //   「页面被销毁 → 翻译核心停止 → 任务被取消」在日志里**长得一模一样**，
          //   而后者正是"无操作时任务/缓存被清掉"这类问题的指纹，无法计数就无法定位。
          //   现在把原因一并落盘：`cancelSummary` 是原文（如"图片翻译控制器已停止"），
          //   `cancelCode` 是分类（user-requested / transport-disconnected / ...）。
          ...(job.cancellationReason
            ? {
                cancelCode: job.cancellationReason.code,
                cancelSummary: job.cancellationReason.diagnosticSummary,
              }
            : {}),
          // 设计 §7：出错前走过的阶段也要带走 —— 失败时 orchestrator 的局部 stageTimings
          // 随异常丢失，这里这份实时轨迹是唯一还原（含出错那一站的耗时）。
          stages: failed.stages,
          // 失败时没有 `pipelineResult`（拿不到 record 补 box），与原整页日志一致：
          // 有多少行就记多少行，不硬凑。
          ...(recordSourceText ? { lines: toLines(capturedLines, undefined) } : {}),
        },
        err: {
          type: finalError instanceof Error ? finalError.name : typeof finalError,
          // 带上 cause 链：messageKey 之外的真因（阶段失败详情 / provider 原话）都在那里。
          message: describeErrorChain(finalError),
        },
        dur_ms: Math.round(performance.now() - startedAt),
      });
      eventLog.flush();
      await this.diagnostics.emitAsync({
        runId: job.diagnosticRunId,
        level: 'error',
        category: 'error',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: `本地流水线宿主失败：${describeErrorChain(finalError)}`,
        data: {
          jobId: job.id,
          durationMs: performance.now() - startedAt,
          runtimeInference: [...aggregates.values()],
        },
        error: serializePipelineError(finalError, isAbortError(finalError) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED'),
      });
      return terminalMessage;
    } finally {
      stopCancellation();
      stopProgress();
      await this.imageRuntime.whenIdle();
      removePerfSink();
    }
  }

  private async executeDetectionProbe(job: PipelineJob): Promise<PipelineTerminalMessage> {
    if (!job.file) return this.finishJob(job, createProtocolError('检测任务缺少图片'));
    try {
      const result = await probeTextDetection(job.file, {
        platform: this.platform,
        modelRuntime: this.modelRuntime,
        detectionFallbackStrategy: { kind: 'heuristic-only' },
        signal: job.abortController.signal,
      });
      if (job.abortController.signal.aborted) throw job.abortController.signal.reason;
      const packedMaskBase64 = await blobToBase64(result.detection.packedMask);
      if (job.abortController.signal.aborted) throw job.abortController.signal.reason;
      if (!safelyPost(this.port, {
        type: 'detection-result',
        jobId: job.id,
        detection: {
          width: result.detection.width,
          height: result.detection.height,
          packedMaskBase64,
          regions: result.detection.regions,
        },
        detectorSignature: result.detectorSignature,
        topTouches: result.topTouches,
        bottomTouches: result.bottomTouches,
        topStrength: result.topStrength,
        bottomStrength: result.bottomStrength,
      })) {
        throw createProtocolError('检测预检结果传输失败');
      }
      job.state = 'finished';
      this.jobs.delete(job.id);
      return { type: 'complete', jobId: job.id };
    } catch (error) {
      return this.finishJob(job, error);
    }
  }

  private aggregateWorkerCall(aggregates: Map<string, RuntimeAggregate>, call: PerfTraceWorkerCall): void {
    if (call.kind !== 'runInference' && call.kind !== 'runDetectWithGpuPreprocess') return;
    const model = call.model ?? 'unknown';
    const current = aggregates.get(model) ?? {
      model,
      provider: call.provider,
      calls: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      failures: 0,
    };
    current.provider = call.provider ?? current.provider;
    current.calls += 1;
    current.totalDurationMs += call.durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, call.durationMs);
    current.inputBytes += call.inputBytes ?? 0;
    current.outputBytes += call.outputBytes ?? 0;
    if (call.error) current.failures += 1;
    aggregates.set(model, current);
  }

  private recordRuntimeEvent(job: PipelineJob, event: PerfTraceRuntimeEvent): void {
    this.diagnostics.emit({
      runId: job.diagnosticRunId,
      level: event.error === undefined ? 'info' : 'error',
      category: 'model.runtime',
      source: { context: 'pipeline-host', module: 'onnxWorkerBridge.ts' },
      message: event.message,
      data: {
        kind: event.kind,
        model: event.model,
        provider: event.provider,
        ...event.data,
      },
      error: event.error === undefined ? undefined : serializePipelineError(event.error, 'WORKER_BOOTSTRAP_FAILED'),
    });
  }

  private postArtifactChunks(jobId: string, artifact: 'result' | 'debug', chunks: string[]): boolean {
    return chunks.every((data, index) =>
      safelyPost(this.port, {
        type: 'result-chunk',
        jobId,
        artifact,
        index,
        data,
      }));
  }

  private postQueuePositions(): void {
    if (this.activeJob) {
      safelyPost(this.port, { type: 'queued', jobId: this.activeJob.id, position: 0 });
    }
    this.queue.forEach((job, index) => {
      safelyPost(this.port, {
        type: 'queued',
        jobId: job.id,
        position: index + (this.activeJob ? 1 : 0),
      });
    });
  }

  private failJobId(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.failJob(job, error);
      return;
    }
    safelyPost(this.port, {
      type: 'error',
      jobId,
      error: serializePipelineError(error, 'TRANSFER_PROTOCOL_ERROR'),
    });
  }

  private failJob(job: PipelineJob, error: unknown): void {
    const terminalMessage = this.finishJob(job, error);
    const port = this.port;
    if (!safelyPost(port, terminalMessage) && port) {
      this.handleDisconnect(port);
    }
  }

  private finishJob(job: PipelineJob, error: unknown): PipelineTerminalMessage {
    job.state = 'finished';
    this.jobs.delete(job.id);
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    return {
      type: 'error',
      jobId: job.id,
      error: serializePipelineError(error, isAbortError(error) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED'),
    };
  }

  private handleDisconnect(port: ExtensionPort): void {
    if (this.port !== port) return;
    this.port = null;
    if (this.activeJob) {
      const cancellation = createCancelledError('流水线宿主连接已断开');
      this.activeJob.cancellationReason = {
        code: 'transport-disconnected',
        messageKey: 'pipeline.cancelled.transportDisconnected',
        diagnosticSummary: cancellation.message,
      };
      this.activeJob.abortController.abort(cancellation);
    }
    for (const job of [...this.queue]) {
      job.abortController.abort(createCancelledError('流水线宿主连接已断开'));
      job.state = 'finished';
      this.jobs.delete(job.id);
    }
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      if (job !== this.activeJob) {
        job.state = 'finished';
      }
    }
    for (const [jobId, job] of this.jobs) {
      if (job !== this.activeJob) this.jobs.delete(jobId);
    }
    if (!this.disposed && this.transport.reconnectOnDisconnect) {
      this.reconnectTimer = setTimeout(() => this.connect(), 250);
    }
  }

  private clearIdleClose(): void {
    this.idleGeneration += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleClose(): void {
    this.clearIdleClose();
    if (this.disposed || this.activeJob || this.queue.length > 0 || this.jobs.size > 0) return;
    const generation = this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      void this.releaseIdleResources(generation);
    }, this.idleTimeoutMs);
  }

  private async releaseIdleResources(generation: number): Promise<void> {
    if (generation !== this.idleGeneration || this.activeJob || this.jobs.size > 0) return;
    const releasePromise = this.modelRuntime.dispose();
    this.idleReleasePromise = releasePromise;
    try {
      await releasePromise;
      void this.diagnostics.emitAsync({
        level: 'info',
        category: 'model.runtime',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '流水线宿主空闲 TTL 到期，已释放模型 Session 与 Worker',
        data: {
          lifecycleEvent: 'idle-dispose-complete',
          hostInstanceId: this.hostInstanceId,
          idleTimeoutMs: this.idleTimeoutMs,
        },
      }).catch(() => false);
    } catch (error) {
      this.diagnostics.emit({
        level: 'warn',
        category: 'model.runtime',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '流水线宿主空闲资源释放失败',
        error: serializePipelineError(error),
      });
    } finally {
      if (this.idleReleasePromise === releasePromise) {
        this.idleReleasePromise = null;
      }
    }
    if (generation === this.idleGeneration && !this.activeJob && this.jobs.size === 0) {
      this.requestIdleClose(generation);
    }
  }

  /**
   * 空闲关闭闸门（唯一出口）。
   *
   * 译图缓存非空时**不请求关闭**，改成一个同样长度的"以后再问"定时器 ——
   * 关掉文档 = 连带把内存里的译图全扔掉，那正是这次改造要修的问题。
   * 注意上面模型 Session / Worker 已经释放过了，这里留住的只是装着译图的 JS 堆；
   * 缓存被清空后，下一个空闲周期就会放行。
   *
   * 定时器**不递增 `idleGeneration`**：它代表"同一轮空闲还在继续"，
   * 任何新消息都会经 `clearIdleClose()` 把它连同这轮空闲一起取消。
   */
  private requestIdleClose(generation: number): void {
    if (generation !== this.idleGeneration || this.activeJob || this.jobs.size > 0) return;
    if (this.keepAliveWhenIdle()) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        this.requestIdleClose(generation);
      }, this.idleTimeoutMs);
      return;
    }
    this.emitLifecycleEvent('idle-close-requested', '流水线宿主请求关闭空闲宿主');
    safelyPost(this.port, {
      type: 'idle-close',
      hostInstanceId: this.hostInstanceId,
    });
  }
}
