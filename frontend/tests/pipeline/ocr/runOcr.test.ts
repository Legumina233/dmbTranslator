import { describe, expect, it, vi } from 'vitest';
import type { ModelRuntime } from '@dmb/model-runtime';
import type {
  PipelineImage,
  PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import { runOcr } from '../../../packages/image-pipeline/src/pipeline/ocr';
import { registerOcrProvider } from '../../../packages/image-pipeline/src/pipeline/ocr/provider';

describe('runOcr', () => {
  it('returns a valid empty result when the provider rejects every candidate', async () => {
    registerOcrProvider({
      name: 'empty-result-fixture',
      recognize: vi.fn().mockResolvedValue({
        results: [],
        provider: 'webgpu',
      }),
    });
    const image = {
      src: 'fixture.png',
      naturalWidth: 100,
      naturalHeight: 200,
      onload: null,
      onerror: null,
    } as PipelineImage;
    const detectedRegions: TextRegion[] = [{
      id: 'region-1',
      box: { x: 10, y: 20, width: 30, height: 80 },
      direction: 'v',
      sourceText: '',
      translatedText: '',
    }];

    const result = await runOcr(
      image,
      detectedRegions,
      'empty-result-fixture',
      {} as PlatformProvider,
      undefined,
      {} as ModelRuntime,
    );

    expect(result).toMatchObject({
      regions: [],
      actualProvider: 'webgpu',
      debug: {
        candidateCount: 0,
        preparedCount: 0,
      },
    });
  });
});

describe('服务端 OCR（manga-ocr provider）', () => {
  /** 只实现 OCR 用得到的那几个方法的假 platform。 */
  function fakePlatform(): PlatformProvider {
    return {
      createCanvas: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toDataURL: () => 'data:image/png;base64,AAAA',
      }),
    } as unknown as PlatformProvider;
  }

  const image = { src: 'fixture.png', naturalWidth: 100, naturalHeight: 200 } as PipelineImage;
  const regions: TextRegion[] = [
    {
      id: 'r1',
      box: { x: 10, y: 20, width: 30, height: 80 },
      quad: [
        { x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 100 }, { x: 10, y: 100 },
      ],
      direction: 'v',
      sourceText: '',
      translatedText: '',
    },
  ];

  it('未配置服务地址 → 显式抛错（绝不静默回退本地 ONNX）', async () => {
    const { configureServerOcr, mangaOcrServerProvider } =
      await import('../../../packages/image-pipeline/src/pipeline/ocr/serverMangaOcrProvider');
    configureServerOcr(null);
    await expect(
      mangaOcrServerProvider.recognize(image, regions, fakePlatform()),
    ).rejects.toThrow(/服务地址未配置/);
  });

  it('把整行 crop 发到 /ocr，并按 id 把结果映射回原区域', async () => {
    const { configureServerOcr, mangaOcrServerProvider } =
      await import('../../../packages/image-pipeline/src/pipeline/ocr/serverMangaOcrProvider');
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify([{ id: 'r1', text: 'こんにちは', confidence: 0.93 }]),
      { status: 200 },
    ));
    configureServerOcr({ baseUrl: 'http://127.0.0.1:11436/', fetchImpl: fetchImpl as unknown as typeof fetch });

    const output = await mangaOcrServerProvider.recognize(image, regions, fakePlatform());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:11436/ocr');
    const body = JSON.parse(String(init.body)) as { images: Array<{ id: string; data: string; direction: string }> };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatchObject({ id: 'r1', data: 'data:image/png;base64,AAAA', direction: 'v' });

    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toMatchObject({ regionId: 'r1', text: 'こんにちは', confidence: 0.93 });
    expect(output.results[0]!.quad).toEqual(regions[0]!.quad);
    configureServerOcr(null);
  });

  it('服务返回 5xx → 抛出（带状态码），不吞不假装成功', async () => {
    const { configureServerOcr, mangaOcrServerProvider } =
      await import('../../../packages/image-pipeline/src/pipeline/ocr/serverMangaOcrProvider');
    configureServerOcr({
      baseUrl: 'http://127.0.0.1:11436',
      fetchImpl: (async () => new Response('manga-ocr 不可用', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(
      mangaOcrServerProvider.recognize(image, regions, fakePlatform()),
    ).rejects.toThrow(/503/);
    configureServerOcr(null);
  });

  it('服务少返回了一行 → 抛错（宁可失败，不可错位贴错文本）', async () => {
    const { configureServerOcr, mangaOcrServerProvider } =
      await import('../../../packages/image-pipeline/src/pipeline/ocr/serverMangaOcrProvider');
    configureServerOcr({
      baseUrl: 'http://127.0.0.1:11436',
      fetchImpl: (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch,
    });
    await expect(
      mangaOcrServerProvider.recognize(image, regions, fakePlatform()),
    ).rejects.toThrow(/缺少该行/);
    configureServerOcr(null);
  });
});
