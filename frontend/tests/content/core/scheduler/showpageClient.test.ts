import { describe, expect, it, vi } from 'vitest';
import {
  createShowpageClient,
  deriveShowpageEndpoint,
  extractShowkeyFromScripts,
} from '../../../../apps/extension/src/content/core/scheduler/showpageClient';

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('extractShowkeyFromScripts · showkey 从内联脚本提取（真机实录内嵌 JSON 字面量）', () => {
  it('JSON 形态（api_call 的第二参，真机实录格式）', () => {
    const source = `api_call({}, '{"method":"showpage","gid":4218710,"page":5,"imgkey":"0b98c3ad02","showkey":"k67kmy7anu9"}', function(){load_image_dispatch()})`;
    expect(extractShowkeyFromScripts([source])).toBe('k67kmy7anu9');
  });
  it('赋值形态（var showkey = "…"）', () => {
    expect(extractShowkeyFromScripts(['var showkey = "abc123def0";'])).toBe('abc123def0');
  });
  it('多个脚本按顺序取第一个命中；全缺 → null', () => {
    expect(extractShowkeyFromScripts(['', 'no key here', 'x=1; showkey=\'deadbeef01\';'])).toBe('deadbeef01');
    expect(extractShowkeyFromScripts(['nothing', 'also nothing'])).toBeNull();
  });
});

describe('deriveShowpageEndpoint · 端点推导（口径 = 归档真机捕获同值）', () => {
  it('exhentai → s.exhentai.org/api.php', () => {
    expect(deriveShowpageEndpoint('exhentai.org')).toBe('https://s.exhentai.org/api.php');
  });
  it('e-hentai → api.e-hentai.org/api.php', () => {
    expect(deriveShowpageEndpoint('e-hentai.org')).toBe('https://api.e-hentai.org/api.php');
  });
  it('其它站点 → null（预取整体不参与）', () => {
    expect(deriveShowpageEndpoint('example.com')).toBeNull();
  });
});

describe('createShowpageClient · 直连执行器', () => {
  function createReadyClient(overrides: Partial<Parameters<typeof createShowpageClient>[0]> = {}) {
    const defaultFetch = vi.fn(async (): Promise<Response> => new Response(
      JSON.stringify({ p: 6, k: 'abcdef0123', i3: '<img id="img" src="https://x/6.webp">' }),
      { status: 200 },
    ));
    // overrides 里带了 fetchImpl 时，返回引用必须是**实际生效的那个**，否则断言看错对象
    const fetchImpl = (overrides.fetchImpl as typeof defaultFetch | undefined) ?? defaultFetch;
    const onJson = vi.fn();
    const onCircuitOpen = vi.fn();
    const client = createShowpageClient({
      getGid: () => 4218710,
      getShowkey: () => 'k67kmy7anu9',
      getEndpoint: () => 'https://s.exhentai.org/api.php',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onJson,
      onCircuitOpen,
      ...overrides,
    });
    return { client, fetchImpl, onJson, onCircuitOpen };
  }

  it('就绪时直接发起：POST + 带凭据 + JSON 体（归档真机同形态）', async () => {
    const { client, fetchImpl, onJson } = createReadyClient();
    client.dispatch({ page: 6, imgkey: 'abcdef0123' });
    await tick(); await tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://s.exhentai.org/api.php');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({
      method: 'showpage',
      gid: 4218710,
      page: 6,
      imgkey: 'abcdef0123',
      showkey: 'k67kmy7anu9',
    });
    // 响应的 p 字段决定 pageKey（不是请求参数）—— 站点回哪页就记哪页
    expect(onJson).toHaveBeenCalledWith('4218710-6', expect.stringContaining('"p":6'));
    expect(client.stats().ok).toBe(1);
    expect(client.stats().failStreak).toBe(0);
  });

  it('showkey/端点未就绪 → 排队不发包；notifyReady 后按序冲出', async () => {
    let showkey = '';
    const { client, fetchImpl } = createReadyClient({ getShowkey: () => showkey });
    client.dispatch({ page: 5, imgkey: 'aaaaaaa005' });
    client.dispatch({ page: 6, imgkey: 'aaaaaaa006' });
    await tick(); await tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.stats().pending).toBe(2);

    showkey = 'k67kmy7anu9';
    client.notifyReady();
    await tick(); await tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.stats().pending).toBe(0);
  });

  it('熔断：连续失败×3 且成功为 0 → 通知熔断且不再发包；成功过一次则永不熔断', async () => {
    const failing = createReadyClient({
      fetchImpl: vi.fn(async () => new Response('nope', { status: 500 })),
    });
    for (let i = 0; i < 3; i += 1) {
      failing.client.dispatch({ page: 6, imgkey: 'abcdef0123' });
      await tick(); await tick();
    }
    expect(failing.onCircuitOpen).toHaveBeenCalledTimes(1);
    expect(failing.client.stats().circuitOpen).toBe(true);
    failing.client.dispatch({ page: 7, imgkey: 'abcdef0124' });
    await tick(); await tick();
    expect(failing.fetchImpl).toHaveBeenCalledTimes(3); // 熔断后不再发

    const flaky = createReadyClient();
    (flaky.fetchImpl as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => new Response('bad', { status: 500 }));
    flaky.client.dispatch({ page: 6, imgkey: 'abcdef0123' }); // 失败一次
    await tick(); await tick();
    flaky.client.dispatch({ page: 6, imgkey: 'abcdef0123' }); // 成功
    await tick(); await tick();
    flaky.client.dispatch({ page: 6, imgkey: 'abcdef0123' }); // 再失败
    flaky.client.dispatch({ page: 6, imgkey: 'abcdef0123' }); // 又失败
    await tick(); await tick();
    expect(flaky.client.stats().circuitOpen).toBe(false); // 成功过 → 不熔断
  });

  it('响应非 JSON / 缺 p 字段 → 计失败，不回调 onJson', async () => {
    const { client, fetchImpl, onJson } = createReadyClient({
      fetchImpl: vi.fn(async () => new Response('<html>not json</html>', { status: 200 })),
    });
    client.dispatch({ page: 6, imgkey: 'abcdef0123' });
    await tick(); await tick();
    expect(onJson).not.toHaveBeenCalled();
    expect(client.stats().fail).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createShowpageClient · 失败上报与超时（链靠它补救，2026-10-04）', () => {
  function createWithFailureHook(overrides: Partial<Parameters<typeof createShowpageClient>[0]> = {}) {
    const onDispatchFailed = vi.fn();
    const fetchImpl = (overrides.fetchImpl as unknown as typeof fetch | undefined)
      ?? (async (): Promise<Response> => new Response(
        JSON.stringify({ p: 6, k: 'abcdef0123', i3: '<img id="img" src="https://x/6.webp">' }),
        { status: 200 },
      ));
    const client = createShowpageClient({
      getGid: () => 4218710,
      getShowkey: () => 'k67kmy7anu9',
      getEndpoint: () => 'https://s.exhentai.org/api.php',
      fetchImpl,
      onJson: vi.fn(),
      onCircuitOpen: vi.fn(),
      onDispatchFailed,
      ...overrides,
    });
    return { client, onDispatchFailed };
  }

  it('HTTP 500 → onDispatchFailed 带完整身份（gid 补齐），且计失败', async () => {
    const { client, onDispatchFailed } = createWithFailureHook({
      fetchImpl: vi.fn(async () => new Response('nope', { status: 500 })),
    });
    client.dispatch({ page: 6, imgkey: 'abcdef0123' });
    await tick(); await tick();
    expect(onDispatchFailed).toHaveBeenCalledTimes(1);
    expect(onDispatchFailed).toHaveBeenCalledWith({ page: 6, imgkey: 'abcdef0123', gid: 4218710 });
    expect(client.stats().fail).toBe(1);
  });

  it('成功路径不触发 onDispatchFailed（只报失败，不报成功）', async () => {
    const { client, onDispatchFailed } = createWithFailureHook();
    client.dispatch({ page: 6, imgkey: 'abcdef0123' });
    await tick(); await tick();
    expect(client.stats().ok).toBe(1);
    expect(onDispatchFailed).not.toHaveBeenCalled();
  });

  it('fetch 挂死后按失败处理（超时 signal），不给链留永远等不到的洞', async () => {
    const { client, onDispatchFailed } = createWithFailureHook({
      // AbortSignal.timeout 是原生定时器（fake 时钟推不动），走注入的 10ms 短超时。
      requestTimeoutMs: 10,
      fetchImpl: vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
      })),
    });
    client.dispatch({ page: 6, imgkey: 'abcdef0123' });
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    expect(onDispatchFailed).toHaveBeenCalledTimes(1);
    expect(client.stats().fail).toBe(1);
  });
});
