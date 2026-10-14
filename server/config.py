# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 全局配置与常量。

原则：这里只有【不可变配置】。任何请求级数据一律不许放这里（v1 的 P0-A 就是这么来的）。
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(BASE_DIR)

# ── 本地资源 ─────────────────────────────────────────────
MANGA_OCR_DIR = os.path.join(PROJECT_DIR, "manga-ocr")
# 本地权重优先；可用 DMB_MANGA_OCR_MODEL 指到别处（避免复制 400+MB）
LOCAL_MODEL_DIR = (os.environ.get("DMB_MANGA_OCR_MODEL")
                   or os.path.join(PROJECT_DIR, "models", "manga-ocr-base"))
HF_CACHE = os.path.join(PROJECT_DIR, ".cache", "hf")
LOG_ROOT = os.path.join(PROJECT_DIR, "logs")

# ── 服务 ────────────────────────────────────────────────
UPSTREAM = "http://127.0.0.1:11434"          # Ollama
LISTEN_HOST = "127.0.0.1"
DEFAULT_PORT = 11436

# ★ Ollama 与模型控制**独立成一个服务**（2026-10-04 用户拍板）。
# 目的：ollama 的启停 / 模型加载卸载 不再依赖 dmb_server（OCR + Sakura 规范化），
# 三者可以自由开关、互不牵连。详见 dev/docs/ARCHITECTURE.md §四（服务端）。
DEFAULT_OLLAMA_SERVICE_PORT = 11437

# ── 翻译 ────────────────────────────────────────────────
SAKURA_MODEL = "sakura-14b"
BATCH_TRANSLATE = True
SAKURA_PROMPT_FILE = os.path.join(BASE_DIR, "sakura_prompt.txt")
GLOSSARY_FILE = os.path.join(BASE_DIR, "sakura_dict.txt")

SAKURA_SYSTEM_V1_0 = (
    "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，"
    "并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。"
)
SAKURA_SYSTEM_V1_5 = (
    "你是一个日本二次元领域的日语翻译模型，可以流畅通顺地以日本轻小说/漫画/Galgame的风格"
    "将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。"
)

QWEN_LINES_SYSTEM = (
    "你是专业漫画本地化译者。下面按顺序给出若干条日文文本，请逐条译成简体中文，"
    "保持整页上下文的语气、称呼与情绪一致，按中文漫画台词习惯组织语序。"
    "只输出一个 JSON 数组，元素依次为各条译文，不要任何解释、前言、结尾或 markdown 代码块。"
)

# ── OCR ─────────────────────────────────────────────────
OCR_MAX_LENGTH = 300
OCR_ROTATE_VERTICAL = False          # 竖排旋转；manga-ocr 默认可读竖排，故关闭
OCR_LOW_CONF_LOG = 0.5
OCR_BATCH_SIZE = 12

# ── 调试 ────────────────────────────────────────────────
# 分阶段耗时追踪没有开关了：`.trace.jsonl` 已于 M4 下线，耗时并入事件流
# （`llm.call` / `failure` 的 `what.stages`），整体开关是 `DMB_EVENT_LOG`。
DEBUG_DUMP = os.environ.get("DMB_DEBUG", "0") == "1"

# ── 显存驻留策略 ────────────────────────────────────────────
# Ollama 默认在最后一次调用后静默 keep_alive=5min 卸载模型。v1 就是这样：
# 选完模型放着不动，5 分钟后被悄悄卸掉，下次翻译又要冷加载 3~6s，
# 而且"已加载/未加载"对用户完全不可见。
# v2 一度改成 -1 = 永不过期（卸载只由显式 /model/unload 触发）；
# 2026-10-06 用户拍板**恢复自动卸载**，TTL 取 15 分钟。
# 语义：最后一次调用起算，15 分钟没有新请求 → Ollama 自动卸载该模型；
# 之后再翻译**无需手动加载**，请求会触发 Ollama 自动冷加载（约 3~6s）。
# 想改时长：设 DMB_KEEP_ALIVE=5m / 300 / 0（立即卸）/ -1（永不过期）。
KEEP_ALIVE_RAW = os.environ.get("DMB_KEEP_ALIVE", "15m")


def keep_alive():
    """Ollama keep_alive 取值：数字（秒，-1=永久）或时长字符串（'5m'）。"""
    v = (KEEP_ALIVE_RAW or "").strip()
    try:
        return int(v)
    except ValueError:
        return v or "-1"


def model_base(name):
    """去掉 tag（:latest）只留基名，用于跨实例/跨接口比对。"""
    return (name or "").split(":")[0]
