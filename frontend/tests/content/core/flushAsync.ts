/**
 * 等所有微任务链跑完。
 *
 * `setTimeout(0)` 排在宏任务队列末尾，此时本拍产生的微任务（Promise 续体）必然都已执行完 ——
 * 用来在断言前把 `void someAsyncWork()` 这类"发射后不管"的调用推到终态。
 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}
