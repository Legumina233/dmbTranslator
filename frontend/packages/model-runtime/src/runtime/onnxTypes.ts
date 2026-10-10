import { toErrorMessage } from './errorMessage';

export type RuntimeProvider = "webnn" | "webgpu" | "wasm" | "cuda" | "cpu";
export type WebNnDeviceType = "gpu" | "cpu" | "default";

export function isContextLostError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("context is lost") || (lower.includes("mlgraphbuilder") && lower.includes("invalidstateerror"));
}

export function isContextLostRuntimeError(error: unknown): boolean {
  return isContextLostError(toErrorMessage(error));
}

export function isCreateTimeoutError(message: string): boolean {
  return message.includes("Session 创建超时");
}

/**
 * 判断一次**推理**失败是不是「会话已经废了」——而不是输入数据有问题。
 *
 * 区别在于处置方式：数据问题可以留着会话继续用；会话废了必须把它从缓存里剔掉，
 * 否则之后每一次推理都会命中这个坏会话，100% 失败（ORT WebGPU 在设备/上下文丢失后
 * 报的是 `A valid external Instance reference no longer exists.`，既不是 context lost
 * 也不是常规异常，很容易被漏判）。
 *
 * 已知会踩到的几种：
 * - `A valid external Instance reference no longer exists.`（ORT WebGPU 外部实例失效）
 * - `context is lost` / MLGraphBuilder InvalidStateError（WebNN）
 * - `device is lost` / `device lost`（WebGPU device 掉线）
 */
export function isDeadSessionError(message: string): boolean {
  if (isContextLostError(message)) return true;
  const lower = message.toLowerCase();
  return lower.includes("external instance reference no longer exists")
    || lower.includes("device is lost")
    || lower.includes("device lost");
}

export function isDeadSessionRuntimeError(error: unknown): boolean {
  return isDeadSessionError(toErrorMessage(error));
}

/**
 * ORT 会话日志级别（**C++ 侧**，0=verbose 1=info 2=warning 3=error 4=fatal）。
 *
 * 默认 2(warning) 时，每次建会话都会刷两条
 * `[W:onnxruntime:, session_state.cc:1367 VerifyEachNodeIsAssignedToAnEp] ...`
 * —— 那是 ORT 自己把 shape 类算子放 CPU 以提升性能的正常说明，不是故障，但刷满控制台。
 *
 * 注意：**`ort.env.logLevel` 只管 JS 侧日志，压不住这两条**，必须走会话选项的 logSeverityLevel。
 */
export const ORT_LOG_SEVERITY_LEVEL = 3;
