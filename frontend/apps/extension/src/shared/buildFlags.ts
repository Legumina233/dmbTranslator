declare const __DMB_LIFECYCLE_TEST__: boolean;
declare const __DMB_LIFECYCLE_TEST_IDLE_TIMEOUT_MS__: number;
declare const __DMB_LIFECYCLE_TEST_REPORT_URL__: string;

export function isPipelineLifecycleTestBuild(): boolean {
  return typeof __DMB_LIFECYCLE_TEST__ !== 'undefined'
    && __DMB_LIFECYCLE_TEST__;
}

export function getPipelineLifecycleTestIdleTimeoutMs(): number {
  return isPipelineLifecycleTestBuild()
    ? __DMB_LIFECYCLE_TEST_IDLE_TIMEOUT_MS__
    : 5 * 60 * 1000;
}

export function getPipelineLifecycleTestReportUrl(): string {
  return isPipelineLifecycleTestBuild()
    ? __DMB_LIFECYCLE_TEST_REPORT_URL__
    : '';
}
