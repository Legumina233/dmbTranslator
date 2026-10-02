# -*- coding: utf-8 -*-
"""术语表热重载 + Sakura user prompt 拼装。"""
import os
import threading

from config import (
    GLOSSARY_FILE,
    SAKURA_PROMPT_FILE,
    SAKURA_SYSTEM_V1_0,
    SAKURA_SYSTEM_V1_5,
)
from logging_ import log

_lock = threading.Lock()
_glossary_cache = {"mtime": None, "lines": []}


def load_glossary():
    """读术语表：原文->译文 #注释。# / // 开头为注释行。改文件即热重载。"""
    try:
        mtime = os.path.getmtime(GLOSSARY_FILE)
    except Exception:
        return []
    with _lock:
        if mtime == _glossary_cache["mtime"]:
            return _glossary_cache["lines"]
        lines = []
        try:
            with open(GLOSSARY_FILE, encoding="utf-8") as f:
                for raw in f:
                    s = raw.strip()
                    if not s or s.startswith("//") or s.startswith("#"):
                        continue
                    lines.append(s)
        except Exception:
            lines = []
        _glossary_cache["mtime"] = mtime
        _glossary_cache["lines"] = lines
    log("术语表已加载: {} 条".format(len(lines)))
    return lines


def default_sakura_system(model):
    """按模型名推断该用哪版官方提示词。识别不了退回 v1.0。"""
    name = (model or "").lower()
    if "v1.5" in name or "v15" in name or "qwen3" in name or "galtransl" in name:
        return SAKURA_SYSTEM_V1_5
    return SAKURA_SYSTEM_V1_0


def load_sakura_system(model):
    """优先读 server/sakura_prompt.txt（只含注释则视为空）；否则按模型版本自动选。"""
    try:
        with open(SAKURA_PROMPT_FILE, "r", encoding="utf-8") as f:
            lines = [ln.rstrip("\n") for ln in f if not ln.lstrip().startswith(("//", "#"))]
        text = "\n".join(lines).strip()
        if text:
            return text
    except FileNotFoundError:
        pass
    except Exception as e:
        log("（读取 {} 失败，用内置提示词: {}）".format(SAKURA_PROMPT_FILE, e))
    return default_sakura_system(model)


def build_user_prompt(japanese):
    """Sakura 官方格式：有术语表用术语表版，无则用简版。"""
    g = load_glossary()
    if g:
        return ("根据以下术语表（可以为空）：\n"
                + "\n".join(g)
                + "\n将下面的日文文本根据对应关系和备注翻译成中文："
                + japanese)
    return "将下面的日文文本翻译成中文：" + japanese
