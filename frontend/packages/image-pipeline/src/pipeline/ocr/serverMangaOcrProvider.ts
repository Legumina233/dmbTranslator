/**
 * 本机服务版 OCR（manga-ocr）—— 把整行 crop 交给 `server/`（默认 11436）的 `/ocr` 识别。
 *
 * **为什么要它**（2026-10-04 用户拍板，也是 README 里早就写明的目标架构）：
 *   「检测/去字/排版跑在浏览器，**OCR 与翻译跑在本地服务**（manga-ocr + Ollama）」。
 *   manga-ocr 是漫画专用识别模型，只在 Python 侧有（server/ocr.py，本地 GPU）；
 *   浏览器里那套 PaddleOCR v6（ONNX）不再是默认引擎 —— `settings.ocrEngine` 默认改为
 *   `manga_ocr_server`。本地 provider 代码保留，想切回去仍然可用。
 *
 * **失败口径（用户拍板）：显式报错，绝不静默回退本地 ONNX。**
 *   服务没起 / 返回非 200 / 缺条目 → 直接抛错，让管线把这一页判失败并说清原因。
 *   静默换引擎会把"OCR 服务没开"伪装成"翻译质量变差"，是最难查的一类问题。
 *
 * **零依赖注入**：服务地址与 fetch 通过 `configureServerOcr()` 注入，
 *   由宿主（扩展的 offscreen 流水线宿主）在每次运行前按 settings 设置。
 */
import type { QuadPoint, TextDirection, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import type { ModelRuntime } from '@dmb/model-runtime';
import { inferDirectionFromQuad, makeRegionQuad } from "./provider";
import type { OcrProvider, OcrRecognizeOutput, OcrRecognizeResult } from "./provider";

/** provider 名 = `settings.ocrEngine` 的取值之一（`runOcr` 直接按名字取 provider）。 */
export const mangaOcrServerProviderName = "manga_ocr_server";

export type ServerOcrConfig = {
  /** 本机服务地址，形如 `http://127.0.0.1:11436`（不带 /v1、不带尾斜杠）。 */
  baseUrl: string;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（毫秒）。整页几十行 crop 一次过去，给足时间。 */
  timeoutMs?: number;
  /**
   * 服务端自报耗时（响应头 `X-DMB-Timing`）。宿主注入它来收集"整页日志"用的服务端侧数字，
   * **不改变识别结果**；回调抛错也不影响主流程。
   */
  onTiming?: (timing: { total_ms?: number; infer_ms?: number; lines?: number }) => void;
};

const DEFAULT_TIMEOUT_MS = 120_000;

let serverOcrConfig: ServerOcrConfig | null = null;

/** 注入/清除服务地址（宿主在每次流水线运行前调用；null = 未配置）。 */
export function configureServerOcr(next: ServerOcrConfig | null): void {
  serverOcrConfig = next;
}

export function getServerOcrConfig(): ServerOcrConfig | null {
  return serverOcrConfig;
}

type ServerOcrLine = {
  id?: unknown;
  text?: unknown;
  confidence?: unknown;
  error?: unknown;
};

function cropRegionToDataUrl(
  image: PipelineImage,
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
  platform: PlatformProvider,
): string | null {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const width = Math.ceil(Math.max(...xs)) - minX;
  const height = Math.ceil(Math.max(...ys)) - minY;
  if (width <= 0 || height <= 0) return null;
  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, minX, minY, width, height, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

/**
 * 识别一批文本行。**任何异常都抛出**（不吞、不回退）。
 * `modelRuntime` 刻意不用：OCR 在本机服务上跑，浏览器侧不需要任何 ONNX 会话。
 */
export const mangaOcrServerProvider: OcrProvider = {
  name: mangaOcrServerProviderName,
  // 推理在本机服务上：不建任何浏览器 ONNX 会话
  requiresModelRuntime: false,

  async recognize(
    image: PipelineImage,
    regions: TextRegion[],
    platform?: PlatformProvider,
    _modelRuntime?: ModelRuntime,
  ): Promise<OcrRecognizeOutput> {
    const config = serverOcrConfig;
    if (!config?.baseUrl) {
      throw new Error("本机 OCR 服务地址未配置（OCR 引擎 = manga_ocr_server，需要 dmb_server 在跑）");
    }
    if (!platform) throw new Error("OCR 需要 PlatformProvider");
    if (regions.length === 0) return { results: [], provider: "cpu" };

    const ids: string[] = [];
    const items: Array<{ id: string; data: string; direction: TextDirection }> = [];
    for (const [index, region] of regions.entries()) {
      const id = region.id ?? `region-${index}`;
      ids.push(id);
      const quad = makeRegionQuad(region);
      const data = cropRegionToDataUrl(image, quad, platform);
      if (!data) {
        throw new Error(`OCR 服务：第 ${index + 1} 行裁剪失败（区域尺寸非法）`);
      }
      items.push({
        id,
        data,
        direction: region.direction ?? inferDirectionFromQuad(quad),
      });
    }

    const fetchImpl = config.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const url = `${config.baseUrl.replace(/\/+$/, "")}/ocr`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: items }),
        signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`OCR 服务不可达（${url}）：${reason}`);
    }
    const timingHeader = response.headers.get("X-DMB-Timing");
    if (timingHeader) {
      try {
        serverOcrConfig?.onTiming?.(JSON.parse(timingHeader) as {
          total_ms?: number; infer_ms?: number; lines?: number;
        });
      } catch {
        // 计时不是主流程：解析失败就算了
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`OCR 服务返回 ${response.status}${detail ? `：${detail.slice(0, 300)}` : ""}`);
    }

    const payload = (await response.json().catch(() => null)) as ServerOcrLine[] | null;
    if (!Array.isArray(payload)) {
      throw new Error("OCR 服务返回格式非法（期望 JSON 数组）");
    }
    const byId = new Map<string, ServerOcrLine>();
    for (const line of payload) {
      if (line && typeof line.id === "string") byId.set(line.id, line);
    }

    const results: OcrRecognizeResult[] = regions.map((region, index) => {
      const id = ids[index]!;
      const line = byId.get(id);
      if (!line) throw new Error(`OCR 服务返回缺少该行（id=${id}）`);
      if (typeof line.error === "string" && line.error) {
        throw new Error(`OCR 服务识别失败（id=${id}）：${line.error}`);
      }
      return {
        regionId: region.id,
        text: typeof line.text === "string" ? line.text : "",
        confidence: typeof line.confidence === "number" ? line.confidence : 0,
        quad: makeRegionQuad(region),
        direction: region.direction ?? inferDirectionFromQuad(makeRegionQuad(region)),
      };
    });

    // provider 字段报 "cpu"：这一站的推理发生在**本机服务**（不占用浏览器运行时）。
    // 它不是"回退"——orchestrator 用同样的值作为预期值，因此不会误报"已回退"。
    return { results, provider: "cpu" };
  },
};
