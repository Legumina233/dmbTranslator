#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""行序号（`序号|`）补救档的单元测试。

不碰 Ollama，把 `SakuraBackend._one` 换成假实现，只验证**解析与判定**逻辑：

  T1 纯函数 tag_lines / untag_lines 的基本行为
  T2 tagged=False 的行为与改动前**一字不差**（回归护栏）
  T3 tagged=True 正常返回 → 剥离序号后的译文按顺序对齐
  T4 缺行 → None，且日志点名缺的是第几行（这是本方案的核心价值）
  T5 重复序号 / 未带序号 / 乱序 / 空译文 → 一律 None（绝不粉饰成对上）
  T6 translate_lines 端到端：plain 失配 → 自动带序号重跑 → 成功

用法:  python scripts/test_line_id.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import backends  # noqa: E402
import sakura  # noqa: E402

_fail = []
_logs = []


def check(cond, msg):
    if cond:
        print("  OK   " + msg)
    else:
        print("  FAIL " + msg)
        _fail.append(msg)


class Ctx:
    model = "sakura-14b-qwen3-v1.5:latest"
    backend = "sakura"


class FakeBackend(backends.SakuraBackend):
    """把 `_one` 换成按脚本返回，同时记录每次收到的正文。"""

    def __init__(self, script):
        self.script = list(script)
        self.sent = []

    def _one(self, japanese, ctx):
        self.sent.append(japanese)
        if not self.script:
            raise AssertionError("_one 被调用次数超出脚本")
        return self.script.pop(0)


def install_log_capture():
    def fake_log(msg, model=None):
        _logs.append(msg)
    backends.log = fake_log


# ── T1 纯函数 ────────────────────────────────────────────
print("T1 纯函数 tag_lines / untag_lines")
tagged = sakura.tag_lines(["あ", "い", "う"])
check(tagged == ["1|あ", "2|い", "3|う"], "tag_lines 从 1 开始编号: %r" % tagged)

ids, texts, unparsed = sakura.untag_lines(["1|譯一", "2|譯二", "3|譯三"])
check(ids == [1, 2, 3] and texts == ["譯一", "譯二", "譯三"] and unparsed == [],
      "untag_lines 正常拆解")

ids, texts, unparsed = sakura.untag_lines(["1|甲", "沒序號", "3|丙"])
check(ids == [1, 3] and unparsed == ["沒序號"],
      "未带序号的行被单列出来（不混入 texts）: ids=%r unparsed=%r" % (ids, unparsed))

ids, texts, unparsed = sakura.untag_lines(["1|甲", "", "3|丙"])
check(ids == [1, 3] and unparsed == [],
      "空行跳过，靠行数检查兜住: ids=%r" % ids)

print()

# ── T2 tagged=False 行为不变 ──────────────────────────────
print("T2 tagged=False 与改动前一字不差")
install_log_capture()
b = FakeBackend(["譯一\n譯二\n譯三"])
got = b._try_batch(["あ", "い", "う"], Ctx())
check(got == ["譯一", "譯二", "譯三"], "正常批量返回译文")
check(b.sent == ["あ\nい\nう"], "正文不加任何序号: %r" % b.sent)

b = FakeBackend(["譯一\n譯二"])          # 少一行
check(b._try_batch(["あ", "い", "う"], Ctx()) is None, "行数不符 → None")
check(b.sent == ["あ\nい\nう"], "失败时正文同样不带序号")

b = FakeBackend(["譯一\n\n譯三"])         # 有空行
check(b._try_batch(["あ", "い", "う"], Ctx()) is None, "有空行 → None")
print()

# ── T3 tagged=True 正常 ──────────────────────────────────
print("T3 tagged=True 正常解析")
# 注意：FakeBackend 的每个 script 元素是**一次完整的返回文本**（内部用 \n 换行）
b = FakeBackend(["1|譯一\n2|譯二\n3|譯三"])
got = b._try_batch(["あ", "い", "う"], Ctx(), tagged=True)
check(got == ["譯一", "譯二", "譯三"], "剥离序号后按序对齐")
check(b.sent == ["1|あ\n2|い\n3|う"], "正文带序号: %r" % b.sent)
print()

# ── T4 缺行要点名 ────────────────────────────────────────
print("T4 缺行 → None 且日志点名缺第几行（核心价值）")
_logs.clear()
b = FakeBackend(["2|譯二\n3|譯三"])     # 缺第 1 行
r = b._try_batch(["あ", "い", "う"], Ctx(), tagged=True)
check(r is None, "缺行 → None")
check(any("缺行 [1]" in x for x in _logs),
      "日志点名缺第 1 行: %r" % [x for x in _logs if "缺行" in x])
print()

# ── T5 各种对不上都必须 None ──────────────────────────────
print("T5 重复 / 未带序号 / 乱序 / 空译文 → 一律 None")
b = FakeBackend(["1|甲\n2|乙\n2|丙"])   # 序号重复
check(b._try_batch(["あ", "い", "う"], Ctx(), tagged=True) is None, "重复序号 → None")

b = FakeBackend(["1|甲\n乙\n3|丙"])     # 有一行没带序号
check(b._try_batch(["あ", "い", "う"], Ctx(), tagged=True) is None, "未带序号 → None")

b = FakeBackend(["1|甲\n3|丙\n2|乙"])   # 乱序
check(b._try_batch(["あ", "い", "う"], Ctx(), tagged=True) is None, "乱序 → None")

b = FakeBackend(["1|甲\n2|\n3|丙"])     # 空译文
check(b._try_batch(["あ", "い", "う"], Ctx(), tagged=True) is None, "空译文 → None")
print()

# ── T6 端到端：plain 失配 → 带序号重跑 → 成功 ───────────────
print("T6 translate_lines: plain 失配 → 自动带序号重跑 → 成功")
_logs.clear()
# 第一次（plain）少一行；第二次（带序号）补全。
# 后面多备 3 条是为了兜底路径：若带序号重跑被去掉，会一路落到逐条，
# 那样断言会明确 FAIL（"调用了 4 次"），而不是把脚本耗尽后崩溃。
b = FakeBackend(["譯二\n譯三",
                 "1|譯一\n2|譯二\n3|譯三",
                 "譯一", "譯二", "譯三"])
out = b.translate_lines(["あ", "い", "う"], Ctx())
check(out == ["譯一", "譯二", "譯三"],
      "失配后靠带序号重跑补齐: %r" % out)
check(len(b.sent) == 2 and "|" in b.sent[1],
      "第二次请求才带序号: %r" % [s.replace("\n", "\\n") for s in b.sent])
check(any("批量返回行数不符" in x for x in _logs), "记下了 plain 失配")
check(any("带序号重跑成功" in x for x in _logs), "记下了补救成功")
print()

# ── T7 平时不该付代价 ────────────────────────────────────
print("T7 第一次就成功时，绝不带序号（平时零开销）")
b = FakeBackend(["譯一\n譯二\n譯三"])
out = b.translate_lines(["あ", "い", "う"], Ctx())
check(out == ["譯一", "譯二", "譯三"], "一次成功")
check(len(b.sent) == 1 and "|" not in b.sent[0],
      "只调 1 次且不带序号: %r" % b.sent)
print()

# ── T8 带序号也失败 → 沿用 shinobu 逐行兜底（切块已删）────────
print("T8 带序号也失败 → 沿用 shinobu 原本的逐行请求兜底（不再切块）")
_logs.clear()
b = FakeBackend(["譯二\n譯三",      # plain 失配（只回 2 行）
                 "1|譯一",           # 带序号也只回 1 行
                 "譯一", "譯二", "譯三"])  # 落回逐行：3 条各调一次 _one
out = b.translate_lines(["あ", "い", "う"], Ctx())
check(out == ["譯一", "譯二", "譯三"], "最终仍拿到 3 条译文: %r" % out)
check(len(b.sent) == 5,
      "plain(1)+带序号(1)+逐行(3) 共 5 次 _one 调用: %r" % b.sent)
check(not any("降级" in x or "分块" in x for x in _logs),
      "切块/分块批量已被删除，日志里不应出现: %r"
      % [x for x in _logs if "降级" in x or "分块" in x])
print()

if _fail:
    print("=" * 60)
    print("失败 %d 项:" % len(_fail))
    for f in _fail:
        print("  - " + f)
    sys.exit(1)
print("全部通过")
