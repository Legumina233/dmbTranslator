# -*- coding: utf-8 -*-
"""模型解析与显存互斥。

硬约束（实测）：16 GB 显存装不下两个模型，换模型冷加载 3~6 s。
所以 **任何时刻只允许一个模型驻留** —— 翻译前必须卸载其余模型。
"""
import json
import time
import urllib.request

from config import SAKURA_MODEL, UPSTREAM, model_base
from logging_ import log

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _get_json(path, timeout):
    req = urllib.request.Request(UPSTREAM + path, method="GET")
    resp = _OPENER.open(req, timeout=timeout)
    return json.loads(resp.read().decode("utf-8", "replace"))


def local_model_names():
    """Ollama 已安装模型名（含 tag）。失败返回 []。"""
    try:
        return [m.get("name") for m in _get_json("/api/tags", 15).get("models", []) if m.get("name")]
    except Exception:
        return []


def loaded_models():
    """当前驻留显存的模型名（含 tag）。失败返回 []。"""
    try:
        return [m.get("name") for m in _get_json("/api/ps", 30).get("models", [])]
    except Exception:
        return []


def classify_backend(model):
    """sakura 系 / galtransl 系 → 'sakura'；其余 → 'generic'。"""
    name = (model or "").lower()
    return "sakura" if ("sakura" in name or "galtransl" in name) else "generic"


def resolve_model(name):
    """请求 model → (实际模型名, 后端)。精确 → 基名 → 回落 SAKURA_MODEL → 第一个。"""
    names = local_model_names()
    if not names:
        return SAKURA_MODEL, classify_backend(SAKURA_MODEL)
    n = (name or "").strip()
    if n in names:
        return n, classify_backend(n)
    base = model_base(n)
    for m in names:
        if model_base(m) == base:
            return m, classify_backend(m)
    for m in names:
        if model_base(m) == model_base(SAKURA_MODEL):
            return m, classify_backend(m)
    return names[0], classify_backend(names[0])


def loaded_detail():
    """驻留显存的模型明细（含 size_vram / expires_at），供 UI 展示。失败返回 []。"""
    try:
        return _get_json("/api/ps", 30).get("models", []) or []
    except Exception:
        return []


def load_model(name, keep=None):
    """**显式**把模型加载进显存（不再依赖"点开始翻译"顺带加载）。

    ★ 硬约束：16 GB 显存装不下两个模型。所以加载前**先卸载其它已驻留模型**，
      保证任何时刻只有一个模型在显存里 —— 否则会出现"加载了新模型但旧模型还占着
      8~9 GB，新模型只能部分 offload 到内存，速度暴跌甚至失败"。
      这一步与翻译路径的 `ensure_inactive_unloaded()` 是同一套规则。

    做法：发一个最小的 /api/chat，并带上长驻 keep_alive。
    返回 (ok, 耗时ms, 说明)；说明里会带上"顺带卸载了哪些"。返回的 detail 供 UI 显示。
    """
    from config import keep_alive
    ka = keep if keep is not None else keep_alive()

    # ① 先腾地方：卸载除目标之外的所有驻留模型
    target_base = model_base(name)
    unloaded = []
    try:
        for m in loaded_models():
            if model_base(m) != target_base:
                log("  加载前卸载其它模型 {}（保证单模型驻留）".format(m))
                unload_model(m)
                unloaded.append(m)
    except Exception as e:
        log("  （加载前卸载其它模型时忽略: {}）".format(e))

    # ② 再加载目标模型
    payload = {"model": name, "stream": False, "keep_alive": ka,
               "messages": [{"role": "user", "content": "hi"}],
               "options": {"num_predict": 1}}
    t0 = time.time()
    try:
        req = urllib.request.Request(UPSTREAM + "/api/chat",
                                     data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     method="POST")
        req.add_header("Content-Type", "application/json")
        resp = _OPENER.open(req, timeout=600)
        resp.read()   # 必须读完，Ollama 才真正应用 keep_alive
        ms = int(round((time.time() - t0) * 1000))
        tail = ("；已先卸载 " + "、".join(unloaded)) if unloaded else ""
        detail = "已加载 keep_alive={}{}".format(ka, tail)
        log("  显式加载模型 {} 完成（{} ms, keep_alive={}）{}".format(name, ms, ka, tail))
        return True, ms, detail, unloaded
    except Exception as e:
        ms = int(round((time.time() - t0) * 1000))
        log("!! 显式加载模型 {} 失败: {}".format(name, e))
        return False, ms, str(e), unloaded


# 注意：这里**刻意不再调用 nvidia-smi**。
# 之前为了在 UI 上显示整卡「占用 / 全部」而每次 /model/status 都跑一次 nvidia-smi，
# 而扩展每 3s 轮询一次 → 每 3s 起一个控制台进程（窗口闪烁）。
# UI 真正关心的是"模型加载后占了多大"，Ollama 的 /api/ps 本来就会返回 size_vram，
# 直接用它即可，不需要额外拉任何外部进程。


def model_status():
    """给 UI 用的完整模型状态：装了什么 / 驻留了什么 / 各自占多少显存。"""
    from config import keep_alive
    installed = local_model_names()
    detail = loaded_detail()
    loaded = []
    for m in detail:
        loaded.append({
            "name": m.get("name"),
            "size": m.get("size"),
            "size_vram": m.get("size_vram"),
            "expires_at": m.get("expires_at"),
        })
    loaded_names = {x["name"] for x in loaded}
    # 按基名判断"已加载"（/api/ps 返回带 tag，用户请求的 may 不带）
    loaded_bases = {model_base(n) for n in loaded_names}
    return {
        "keep_alive": keep_alive(),
        "auto_unload": keep_alive() not in (-1, "-1", "0"),
        # Ollama 是否在跑由管家直接探端口决定（唯一来源），这里不再重复报
        "installed": [{"name": n, "loaded": model_base(n) in loaded_bases} for n in installed],
        "loaded": loaded,
        "loaded_total_vram": sum(int(x.get("size_vram") or 0) for x in loaded),
    }


def unload_model(name):
    """keep_alive:0 卸载。必须读完响应体，Ollama 才会真正应用卸载。"""
    payload = {"model": name, "messages": [{"role": "user", "content": "hi"}],
               "keep_alive": 0, "stream": False}
    try:
        req = urllib.request.Request(
            UPSTREAM + "/api/chat",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST")
        req.add_header("Content-Type", "application/json")
        resp = _OPENER.open(req, timeout=60)
        try:
            resp.read()
        except Exception:
            pass
        log("  已请求卸载模型: {}".format(name))
    except Exception as e:
        log("  （卸载 {} 时忽略: {}）".format(name, e))


def ensure_inactive_unloaded(keep):
    """卸载除 keep 之外的全部驻留模型。按基名比对（/api/ps 返回带 tag）。"""
    keep_base = model_base(keep)
    for m in loaded_models():
        if model_base(m) != keep_base:
            log("  卸载其它模型 {} 以释放显存".format(m))
            unload_model(m)


def unload_all_models():
    """启动时清空显存，保证干净状态。"""
    loaded = loaded_models()
    if not loaded:
        log("  当前无模型驻留，无需卸载")
        return
    log("  启动即卸载显存内所有模型（{} 个）".format(len(loaded)))
    for m in loaded:
        log("    -> 卸载 {}".format(m))
        unload_model(m)
