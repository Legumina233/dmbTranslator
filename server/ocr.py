# -*- coding: utf-8 -*-
"""manga-ocr 本地识别。

被实测验证过的两件事，原样保留：
  * **批量推理更快**：6 行 1735 ms → 919 ms（1.9x），且结果与逐行一致 → 走批量接口。
  * **eos 挂在 model.generation_config 上**：tokenizer 没设 eos，只认 tokenizer 会让
    批量模式把 padding 段算进置信度 → conf 趋近 0 → 这些行被后处理误杀。
"""
import base64
import io
import math
import os
import sys
import threading
import time

from config import (
    HF_CACHE,
    MANGA_OCR_DIR,
    OCR_BATCH_SIZE,
    OCR_LOW_CONF_LOG,
    OCR_MAX_LENGTH,
    OCR_ROTATE_VERTICAL,
)
from logging_ import log
from pages import PAGES

# vendor 的 manga-ocr 靠 sys.path 挂载（未 pip 安装）；放在最前，优先于任何已安装版本
if os.path.isdir(MANGA_OCR_DIR) and MANGA_OCR_DIR not in sys.path:
    sys.path.insert(0, MANGA_OCR_DIR)

# 模型缓存与镜像（可在环境变量里关掉镜像：DMB_HF_MIRROR=0）
os.environ.setdefault("HF_HOME", HF_CACHE)
if os.environ.get("DMB_HF_MIRROR", "1") != "0":
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

_ocr_lock = threading.Lock()
_ocr = None
_ocr_error = None


def get_ocr():
    """懒加载 manga-ocr（首次会加载约 400 MB 模型）。返回 (mocr, error)。"""
    global _ocr, _ocr_error
    if _ocr is not None or _ocr_error is not None:
        return _ocr, _ocr_error
    with _ocr_lock:
        if _ocr is not None or _ocr_error is not None:
            return _ocr, _ocr_error
        try:
            from manga_ocr import MangaOcr
            from config import LOCAL_MODEL_DIR
            model_path = LOCAL_MODEL_DIR if os.path.isdir(LOCAL_MODEL_DIR) else "kha-white/manga-ocr-base"
            log("正在加载 manga-ocr（模型: {}）...".format(model_path))
            t0 = time.time()
            _ocr = MangaOcr(pretrained_model_name_or_path=model_path)
            log("manga-ocr 就绪，耗时 {:.1f}s".format(time.time() - t0))
        except Exception as e:
            _ocr_error = "{}: {}".format(type(e).__name__, e)
            log("!! manga-ocr 加载失败: {}".format(_ocr_error))
    return _ocr, _ocr_error


def decode_base64_image(data):
    """支持 `data:image/xxx;base64,....` 或纯 base64。返回 PIL.Image。"""
    from PIL import Image
    s = data
    if s.strip().startswith("data:") and "," in s[:64]:
        s = s.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(s)))


def _pad_token_id(mocr):
    """padding token id（-1 = 没有）。**必须与 eos 分开**：
    置信度对齐要"去掉行尾 padding"，而 eos 是真实结束符，剥掉它会把对齐判错一位。"""
    value = getattr(mocr.tokenizer, "pad_token_id", None)
    return value if value is not None else -1


def _pad_token_id(mocr):
    """padding token id（-1 = 没有）。**必须与 eos 分开**：
    置信度对齐要"去掉行尾 padding"，而 eos 是真实结束符 —— 把它也剥掉会把对齐整体判错一位。"""
    value = getattr(mocr.tokenizer, "pad_token_id", None)
    return value if value is not None else -1


def _end_token_ids(mocr):
    """eos / pad 集合（用于"遇到结束符就停"）。见模块 docstring：必须把 generation_config 上的 eos 也算进来。"""
    ids = set()
    for value in (getattr(mocr.tokenizer, "eos_token_id", None),
                  getattr(getattr(mocr.model, "generation_config", None), "eos_token_id", None)):
        if value is not None:
            ids.update(value if isinstance(value, (list, tuple)) else [value])
    pad = getattr(mocr.tokenizer, "pad_token_id", None)
    if pad is not None:
        ids.add(pad)
    return ids


def _post_process(text):
    try:
        from manga_ocr.ocr import post_process
        return post_process(text)
    except Exception as e:
        log("  后处理未应用（manga_ocr 导入失败）: {}".format(e))
        return text


def confidence_from_logprobs(logprobs):
    """(每 token 对数概率) → 0~1 的**长度无关**置信度。

    为什么不用"概率的几何平均"（原实现）：那是**长度敏感**的悲观值 ——
    manga-ocr 词表 6144 且分布不尖，单 token 概率常在 1e-2 量级，16 个 token 一乘
    就掉到 1e-10；真机实录：一段完全正确的 16 字文本给出 0.0257，
    而调用方（扩展的图像管线）拿 0.3 当"可疑"阈值 → **每一行都白吃一个可疑信号**。

    改法：用平均每 token 负对数似然（NLL，与长度无关）做一个单调映射
    `1 / (1 + NLL)`：
      · NLL=0.1（每 token 概率 ~0.90）→ 0.91
      · NLL=1.0（~0.37）              → 0.50
      · NLL=3.66（~0.026，真机那段正确文本）→ 0.21
      · NLL 越大越接近 0（越可疑）
    这样"识别得好的行"落在 0.2~0.9、"明显崩坏的行"趋近 0，与本地引擎的阈值口径可比。

    纯函数（不依赖 torch），可离线单测。
    """
    import math
    if not logprobs:
        return 0.0
    try:
        mean_nll = -sum(float(v) for v in logprobs) / len(logprobs)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(mean_nll) or mean_nll < 0:
        return 0.0
    return 1.0 / (1.0 + mean_nll)


def confidence_from_sequence_score(score, seq_len, length_penalty):
    """HF `sequences_scores` → 0~1 置信度（**beam search 下唯一可归属的算法**）。

    背景（2026-10-04 真机实测）：manga-ocr 的 generation_config 是
    `num_beams=4 / length_penalty=2.0`。beam search 时 `generate()` 返回的
    `scores` 是「batch × beams」条分布，**无法按行归属** —— 拿 scores[row] 去算，
    取到的是别人的 beam（实测：同一张图单独跑 0.2144、混在批量里变 0.0/0.0985，
    8 个候选里根本找不到真值）。

    `sequences_scores` 则天然是"**返回的那条序列**"的分数：
        sequences_scores[i] = sum(logprob of 该序列) / len ** length_penalty
    反推回平均每 token 对数概率：mean_logprob = score * len ** (penalty - 1)
    再用 `1 / (1 + mean_nll)` 归一到 0~1（与 confidence_from_logprobs 同一口径）。

    纯函数，零依赖，可离线单测。
    """
    import math
    try:
        score = float(score)
        length = max(1, int(seq_len))
        penalty = float(length_penalty)
        if not math.isfinite(score) or not math.isfinite(penalty):
            return 0.0
        mean_logprob = score * (length ** (penalty - 1))
        mean_nll = -mean_logprob
        if mean_nll < 0:
            return 1.0
        return 1.0 / (1.0 + mean_nll)
    except Exception:
        return 0.0


def _length_penalty(mocr):
    """生成配置里的 length_penalty（sequences_scores 的归一化指数）。取不到按 1.0。"""
    value = getattr(getattr(mocr.model, "generation_config", None), "length_penalty", None)
    try:
        return float(value) if value is not None else 1.0
    except Exception:
        return 1.0


def confidence_for_row(out, seq, row, end_ids, pad_id, length_penalty=1.0):
    """优先用 sequences_scores（beam search 下唯一可归属该行的算法）；没有才退回逐 token 对齐。"""
    seq_len = len(seq) if hasattr(seq, "__len__") else 0
    scores_seq = getattr(out, "sequences_scores", None)
    if scores_seq is not None and row < len(scores_seq):
        return confidence_from_sequence_score(float(scores_seq[row]), seq_len, length_penalty)
    return _conf_from_scores(out.scores, seq, row, end_ids, pad_id)


def _conf_from_scores(scores, seq, row, end_ids, pad_id=-1):
    """伪置信度：对每步被选中 token 取对数概率 → 交给 confidence_from_logprobs 归一到 0~1。

    ★ 对齐必须**逐行**判（2026-10-04 修）：批量生成时每行尾部带 padding，
    原来按"整行长度 vs 步数"选对齐方式，padding 一多就选错 → 取到 padding 位置的
    概率，整行置信度直接归 0（真机现象：批量请求里某几行恒为 0）。
    现在先把该行尾部的 eos/pad 去掉，再判 `len(该行) == 步数 + 1`（有无 decoder start），
    逐行对齐、逐行判。
    """
    import torch
    try:
        tokens = seq.tolist() if hasattr(seq, "tolist") else list(seq)
    except Exception:
        tokens = []
    while tokens and tokens[-1] == pad_id:       # 只去尾部 **padding**（eos 是真实结束符，留下）
        tokens.pop()
    if not tokens:
        return 0.0

    n = len(scores)
    # 对齐：生成步 t ↔ tokens[t + offset]。带 decoder start 时 offset=1（真机实测两种布局都有），
    # 判据用"去掉尾部 padding 后的长度 vs 步数"——对 padding 免疫。
    offset = 1 if len(tokens) == n + 1 else 0
    logprobs = []
    try:
        for t in range(n):
            index = t + offset
            if index >= len(tokens):
                break
            tid = tokens[index]
            if tid in end_ids:
                break
            logprobs.append(torch.log_softmax(scores[t][row], dim=-1)[tid].item())
    except Exception as e:
        log("  伪置信度计算失败（不影响文本）: {}".format(e))
        return 1.0
    return confidence_from_logprobs(logprobs)


def ocr_one(mocr, img, direction):
    """单张识别 → (text, confidence)。自调 generate 以拿到 output_scores。"""
    from PIL import Image as PILImage
    if OCR_ROTATE_VERTICAL and direction == "v":
        img = img.transpose(PILImage.ROTATE_270)
    x = mocr.processor(images=img.convert("L").convert("RGB"), return_tensors="pt").pixel_values
    x = x.to(mocr.model.device)
    out = mocr.model.generate(x, max_length=OCR_MAX_LENGTH,
                              output_scores=True, return_dict_in_generate=True)
    seq = out.sequences[0]
    text = mocr.tokenizer.decode(seq, skip_special_tokens=True)
    conf = confidence_for_row(out, seq, 0, _end_token_ids(mocr), _pad_token_id(mocr), _length_penalty(mocr))
    return _post_process(text).strip(), conf


def ocr_batch(mocr, items):
    """批量识别：items = [(rid, img, direction)] → [(text, conf)]。

    一次 generate 跑整批；形状不一致或任何异常都退化为逐张，保证结果不丢。
    """
    import torch
    from PIL import Image as PILImage

    xs = []
    for _rid, img, direction in items:
        if OCR_ROTATE_VERTICAL and direction == "v":
            img = img.transpose(PILImage.ROTATE_270)
        t = mocr.processor(images=img.convert("L").convert("RGB"), return_tensors="pt").pixel_values
        xs.append(t.to(mocr.model.device))

    def fallback():
        return [ocr_one(mocr, img, direction) for (_rid, img, direction) in items]

    try:
        if any(tuple(x.shape[1:]) != tuple(xs[0].shape[1:]) for x in xs):
            return fallback()
        xb = torch.cat(xs, dim=0)
    except Exception as e:
        log("  批量拼 batch 失败（回退逐张）: {}".format(e))
        return fallback()

    try:
        out = mocr.model.generate(xb, max_length=OCR_MAX_LENGTH,
                                  output_scores=True, return_dict_in_generate=True)
        seqs = out.sequences
        end_ids = _end_token_ids(mocr)
        pad_id = _pad_token_id(mocr)
        results = []
        for i in range(seqs.shape[0]):
            seq = seqs[i]
            text = mocr.tokenizer.decode(seq, skip_special_tokens=True)
            conf = confidence_for_row(out, seqs[i], i, end_ids, pad_id, _length_penalty(mocr))
            results.append((_post_process(text).strip(), conf))
        return results
    except Exception as e:
        log("  批量识别失败（回退逐张）: {}".format(e))
        return fallback()


def handle_ocr(body):
    """POST /ocr → (status, obj)。records 先入 PAGES（按 pageKey 配对），再返回。"""
    import json
    try:
        obj = json.loads(body.decode("utf-8", "replace"))
    except Exception as e:
        return 400, {"error": "JSON 解析失败: {}".format(e)}

    images = obj.get("images") or []
    if not images:
        return 400, {"error": "缺少 images 字段"}
    page_key = obj.get("pageKey")

    mocr, err = get_ocr()
    if err:
        return 503, {"error": "manga-ocr 不可用: {}".format(err)}

    results = []
    prepared = []
    t0 = time.time()
    for item in images:
        rid = item.get("id")
        try:
            img = decode_base64_image(item.get("data", ""))
            prepared.append((rid, img, item.get("direction", "h")))
        except Exception as e:
            log("!! 图片解码失败 id={}: {}".format(rid, e))
            results.append({"id": rid, "text": "", "confidence": 0.0, "error": str(e)})

    infer_total = 0.0
    for start in range(0, len(prepared), OCR_BATCH_SIZE):
        chunk = prepared[start:start + OCR_BATCH_SIZE]
        ti = time.time()
        try:
            pairs = ocr_batch(mocr, chunk)
        except Exception as e:
            log("!! 批量识别异常（回退逐张）: {}".format(e))
            pairs = [ocr_one(mocr, img, d) for (_rid, img, d) in chunk]
        infer_total += time.time() - ti
        for (rid, _img, _d), (text, conf) in zip(chunk, pairs):
            if conf < OCR_LOW_CONF_LOG:
                log("  [低置信 {:.2f}] id={} text={}".format(conf, rid, text))
            else:
                log("  id={} conf={:.2f} text={}".format(rid, conf, text))
            results.append({"id": rid, "text": text, "confidence": round(conf, 4)})

    total_ms = int(round((time.time() - t0) * 1000))
    # 先入账（可能触发整页配对落盘），后返回
    PAGES.attach_ocr(page_key, {
        "kind": "ocr",
        "pageKey": page_key,
        "model": None,
        "ocr_total_ms": total_ms,
        "ocr_infer_ms": int(round(infer_total * 1000)),
        "ocr_lines": len(prepared),
        "lines": [{"id": r.get("id"), "text": r.get("text"),
                   "confidence": r.get("confidence")} for r in results],
    })
    return 200, results
