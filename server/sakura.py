# -*- coding: utf-8 -*-
"""Sakura 适配层 —— 把通用翻译请求规范成 Sakura **官方训练格式**。

为什么必须有这一层
------------------
Sakura 是按官方语料训练的**专用**翻译模型：把通用指令（"你是专业译者…请输出 JSON"）
直接喂给它，会幻觉甚至崩坏。v1 的 `_legacy/sakura_adapter.py` 开头那段注释就是为这个写的：

    ShinobuTranslator 自定义供应商会发"复杂指令 + 要求输出结构化 JSON"的 prompt，
    而 Sakura 是专用翻译模型，只认官方那套格式，直接喂会幻觉/崩坏。

所以调 Sakura 之前必须做三件规范化：

  1. **消息只留两条**：`system` = 官方提示词；`user` = 官方模板文本。
     Shinobu 带来的任何其它 system/指令一律**丢弃**。
  2. **user 文本按官方模板拼**：有术语表用术语表版（`原文->译文` 行 + 官方固定尾句），
     没有则用简版固定句式。**句式一个字都不能改**。
  3. **生成参数用官方推荐值**：`temperature=0.1 / top_p=0.3 / repeat_penalty=1.0`。
     不传这些参数模型输出会飘（v1 legacy 适配器也正是这么传的）。

另外还有两条"防崩"守则：
  * **上下文上限**：整页行数多时必须切块，绝不能把整页一口气塞进去。
  * **不可译文本不送模型**：纯 ASCII/符号/数字直接原样返回，别让模型去"翻译"它。
"""
import re

from config import SAKURA_SYSTEM_V1_0, SAKURA_SYSTEM_V1_5
from glossary import build_user_prompt

# ── 官方推荐生成参数（来自 SakuraLLM 官方用法 / v1 legacy 适配器实测配置）──
OFFICIAL_OPTIONS = {
    "temperature": 0.1,
    "top_p": 0.3,
    "repeat_penalty": 1.0,
}

# 停止串：sakura 系列基于 qwen / llama 系，聊天模板的结束标记必须显式停
STOP_TOKENS = ["<|im_end|>", "<|endoftext|>"]

# 单次请求输入的字符上限。整页多行会被切成若干块，避免超上下文导致崩坏。
MAX_INPUT_CHARS = 1200

_ZERO_WIDTH = re.compile(u"[\u200b-\u200f\u202a-\u202e\ufeff]")
_MULTI_BLANK = re.compile(r"\n{3,}")


def system_prompt(model):
    """官方 system 提示词。v1.5 系（含 v1.5/qwen3/galtransl）与 v1.0 系不同。"""
    name = (model or "").lower()
    if "v1.5" in name or "v15" in name or "qwen3" in name or "galtransl" in name:
        return SAKURA_SYSTEM_V1_5
    return SAKURA_SYSTEM_V1_0


def normalize_japanese(text):
    """最小化规范化：去零宽字符、逐行 strip、去掉多余空行。

    刻意**不做**全角/半角转换（NFKC）：日文里的全角标点是正文的一部分，
    改掉反而偏离训练分布。只清掉一定属于噪声的东西。
    """
    if not text:
        return ""
    s = _ZERO_WIDTH.sub("", str(text))
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    lines = [ln.strip() for ln in s.split("\n")]
    lines = [ln for ln in lines if ln]
    return _MULTI_BLANK.sub("\n\n", "\n".join(lines)).strip()


def has_translatable(text):
    """是否含日文（假名或汉字）。纯 ASCII/数字/符号 → 没有可译内容。"""
    for c in text or "":
        if ("\u3040" <= c <= "\u30ff") or ("\u4e00" <= c <= "\u9fff"):
            return True
    return False


def build_user_text(japanese):
    """官方 user 模板。有术语表 → 术语表版；无 → 简版。句式固定，勿改。"""
    return build_user_prompt(normalize_japanese(japanese))


def build_messages(model, japanese):
    """官方两条消息。**只这两条**，其余一律不带。"""
    return [
        {"role": "system", "content": system_prompt(model)},
        {"role": "user", "content": build_user_text(japanese)},
    ]


def chunk_lines(lines, max_chars=MAX_INPUT_CHARS):
    """把多行按字符数切成若干块，尽量少切块。"""
    chunks, cur, cur_len = [], [], 0
    for ln in lines:
        add = len(ln) + 1
        if cur and cur_len + add > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
        cur.append(ln)
        cur_len += add
    if cur:
        chunks.append(cur)
    return chunks


def batchable(lines):
    """能否整页批量：每行都必须是单行、非空。含内换行会破坏"行数对齐"，直接逐条。"""
    return len(lines) > 1 and all(ln and "\n" not in ln for ln in lines)
