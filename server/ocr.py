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


def _end_token_ids(mocr):
    """eos / pad 集合。见模块 docstring：必须把 generation_config 上的 eos 也算进来。"""
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


def _conf_from_scores(scores, seq, row, end_ids):
    """伪置信度：对每步被选中 token 取对数概率，再几何平均。"""
    import torch
    from backends import ppl_geomean
    logprobs = []
    try:
        n = len(scores)
        if n == len(seq) - 1:
            for t in range(n):
                tid = seq[t + 1].item()
                if tid in end_ids:
                    break
                logprobs.append(torch.log_softmax(scores[t][row], dim=-1)[tid].item())
        else:
            for t in range(1, min(len(seq), n)):
                tid = seq[t].item()
                if tid in end_ids:
                    break
                logprobs.append(torch.log_softmax(scores[t][row], dim=-1)[tid].item())
    except Exception as e:
        log("  伪置信度计算失败（不影响文本）: {}".format(e))
        return 1.0
    return ppl_geomean(logprobs) if logprobs else 0.0


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
    conf = _conf_from_scores(out.scores, seq, 0, _end_token_ids(mocr))
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
        results = []
        for i in range(seqs.shape[0]):
            seq = seqs[i]
            text = mocr.tokenizer.decode(seq, skip_special_tokens=True)
            conf = _conf_from_scores(out.scores, seq, i, end_ids)
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
