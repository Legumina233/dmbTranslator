#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 纯函数单测（零依赖，stdlib unittest）。

把服务端的"不变量"固化成断言，不需要浏览器、不需要 GPU、不需要 Ollama。
直接跑：  python scripts/test_pure.py
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))


class TestSplitSegments(unittest.TestCase):
    def test_no_split_when_n_le_1(self):
        from translate import split_segments
        self.assertEqual(split_segments("你好世界", 1), ["你好世界"])
        self.assertEqual(split_segments("你好世界", 0), ["你好世界"])

    def test_split_by_newline(self):
        from translate import split_segments
        self.assertEqual(split_segments("甲\n乙\n丙", 3), ["甲", "乙", "丙"])

    def test_split_by_punctuation_when_no_newline(self):
        from translate import split_segments
        out = split_segments("你好。世界！", 2)
        self.assertEqual(len(out), 2)

    def test_never_exceed_n(self):
        from translate import split_segments
        for n in (2, 3, 4):
            self.assertLessEqual(len(split_segments("一。二。三。四。五。", n)), n)


class TestInputExtraction(unittest.TestCase):
    def test_regions(self):
        from translate import classify_input, extract_items
        import json
        regions = [{"id": "a", "sourceText": {"plainText": "猫"}},
                   {"id": "b", "sourceText": {"textWithBreaks": "犬"}}]
        msgs = [{"role": "user", "content": "输入数据：" + json.dumps(regions, ensure_ascii=False)}]
        shape, payload = classify_input(msgs)
        self.assertEqual(shape, "regions")
        self.assertEqual([jp for _, jp in extract_items(payload)], ["猫", "犬"])

    def test_plain_shinobu(self):
        from translate import classify_input
        msgs = [{"role": "user", "content": "随便什么前言\n原文：猫が庭で寝ている"}]
        self.assertEqual(classify_input(msgs), ("plain", "猫が庭で寝ている"))

    def test_plain_already_sakura_format_is_unwrapped(self):
        """Shinobu 若已发官方句式，必须剥掉前缀，否则会被二次包装。"""
        from translate import classify_input
        msgs = [{"role": "user", "content": "将下面的日文文本翻译成中文：猫が庭で寝ている"}]
        self.assertEqual(classify_input(msgs), ("plain", "猫が庭で寝ている"))

    def test_plain_glossary_variant(self):
        from translate import classify_input
        msgs = [{"role": "user", "content":
                 "根据以下术语表（可以为空）：\n猫->猫\n将下面的日文文本根据对应关系和备注翻译成中文：犬"}]
        self.assertEqual(classify_input(msgs), ("plain", "犬"))

    def test_native_when_nothing_matches(self):
        from translate import classify_input
        self.assertEqual(classify_input([{"role": "user", "content": "你好"}])[0], "native")


class TestSakuraAdapter(unittest.TestCase):
    def test_official_options(self):
        import sakura
        self.assertEqual(sakura.OFFICIAL_OPTIONS,
                         {"temperature": 0.1, "top_p": 0.3, "repeat_penalty": 1.0})

    def test_messages_are_exactly_two_official_ones(self):
        """只能是两条消息，user 必须是官方两种句式之一（有无术语表各一种）。"""
        import sakura
        OFFICIAL_HEADS = ("将下面的日文文本翻译成中文：",
                          "根据以下术语表（可以为空）：")
        msgs = sakura.build_messages("sakura-14b", "猫")
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        self.assertTrue(msgs[1]["content"].startswith(OFFICIAL_HEADS),
                        f"非官方句式: {msgs[1]['content'][:40]}")
        self.assertTrue(msgs[1]["content"].rstrip().endswith("猫"))
        # 术语表版本必须以官方固定尾句收口
        if msgs[1]["content"].startswith("根据以下术语表"):
            self.assertIn("将下面的日文文本根据对应关系和备注翻译成中文：", msgs[1]["content"])

    def test_v15_system_differs_from_v10(self):
        import sakura
        self.assertNotEqual(sakura.system_prompt("sakura-14b"),
                            sakura.system_prompt("sakura-14b-qwen3-v1.5"))

    def test_normalize_strips_zero_width_and_blank(self):
        import sakura
        self.assertEqual(sakura.normalize_japanese("  猫\u200b  \n\n\n  犬  "), "猫\n犬")

    def test_batchable_rejects_multiline(self):
        import sakura
        self.assertFalse(sakura.batchable(["a\nb", "c"]))
        self.assertTrue(sakura.batchable(["a", "b"]))

    def test_chunk_lines_respects_limit(self):
        import sakura
        chunks = sakura.chunk_lines(["あ" * 400] * 4, max_chars=1200)
        self.assertGreater(len(chunks), 1)
        for ch in chunks:
            self.assertLessEqual(sum(len(x) for x in ch), 1200)

    def test_non_translatable(self):
        import sakura
        self.assertFalse(sakura.has_translatable("12.3 !!"))
        self.assertTrue(sakura.has_translatable("猫"))


class TestOcrConfidence(unittest.TestCase):
    """OCR 置信度口径（2026-10-04）：长度无关、单调，且与调用方 0.3 阈值可比。

    背景：原实现用"每 token 概率的几何平均"，长度敏感且天生偏低 ——
    真机实录：完全正确的 16 字文本只给 0.0257，于是每一行都被调用方当成"可疑"。
    """

    def test_bounds_and_monotonic(self):
        from ocr import confidence_from_logprobs
        good = confidence_from_logprobs([-0.1] * 20)      # 每 token 概率 ~0.90
        mid = confidence_from_logprobs([-1.0] * 20)       # ~0.37
        bad = confidence_from_logprobs([-3.66] * 20)      # 真机那段正确但"不尖"的文本
        terrible = confidence_from_logprobs([-9.0] * 20)
        self.assertGreater(good, mid)
        self.assertGreater(mid, bad)
        self.assertGreater(bad, terrible)
        self.assertTrue(0.0 <= terrible and good <= 1.0)
        self.assertAlmostEqual(mid, 0.5, places=2)

    def test_length_independent(self):
        """同样的每 token 质量，长行与短行应当给出同一个置信度（原实现会崩）。"""
        from ocr import confidence_from_logprobs
        short = confidence_from_logprobs([-1.0] * 3)
        long = confidence_from_logprobs([-1.0] * 40)
        self.assertAlmostEqual(short, long, places=6)

    def test_matches_real_machine_value(self):
        """真机实测：正确文本的平均 logprob ≈ -3.66 → 落在 0.2 档（不再是无意义的 0）。"""
        from ocr import confidence_from_logprobs
        conf = confidence_from_logprobs([-3.66] * 16)
        self.assertGreater(conf, 0.15)
        self.assertLess(conf, 0.3)

    def test_empty_or_garbage_is_zero(self):
        from ocr import confidence_from_logprobs
        self.assertEqual(confidence_from_logprobs([]), 0.0)
        self.assertEqual(confidence_from_logprobs([float("nan")]), 0.0)

    # ── beam search 路径（真机实测 num_beams=4 / length_penalty=2.0）──────────
    # `scores` 在 beam search 下是「batch × beams」条分布、**无法按行归属**，
    # 所以置信度改用 HF 的 sequences_scores（返回序列自身的分数）反推。
    def test_sequence_score_denormalizes_length_penalty(self):
        """sequences_scores = sum(logprob) / len**penalty → 反推平均 NLL 与乘除无关。"""
        from ocr import confidence_from_sequence_score, confidence_from_logprobs
        length, penalty = 19, 2.0
        # sum(logprob) = -length（即平均 NLL=1）→ sequences_scores = sum / len**penalty
        score = (-1.0 * length) / (length ** penalty)
        conf = confidence_from_sequence_score(score, length, penalty)
        self.assertAlmostEqual(conf, confidence_from_logprobs([-1.0] * length), places=6)

    def test_sequence_score_real_machine_value(self):
        """真机实录：cc-100 样例 score≈-0.079、len=19、penalty=2 → ≈0.40（原来恒为 0）。"""
        from ocr import confidence_from_sequence_score
        conf = confidence_from_sequence_score(-0.079, 19, 2.0)
        self.assertGreater(conf, 0.35)
        self.assertLess(conf, 0.45)

    def test_sequence_score_bounds(self):
        from ocr import confidence_from_sequence_score
        self.assertEqual(confidence_from_sequence_score(float("nan"), 10, 1.0), 0.0)
        self.assertLessEqual(confidence_from_sequence_score(-50.0, 10, 1.0), 1.0)
        self.assertGreaterEqual(confidence_from_sequence_score(-50.0, 10, 1.0), 0.0)


class TestForcedUnload(unittest.TestCase):
    """卸载语义（2026-10-04 用户拍板）：**绝不被"进程正在跑"卡住**。

    不变量：
      · 温和路径（keep_alive:0 之后模型真的从 /api/ps 消失）→ 成功且**不**杀进程；
      · 宽限期（1s）内没消失 → 结束 runner 进程，再确认，报告"强制"；
      · 杀了 runner 仍未退 → 如实返回失败（不假装成功）。
    """

    def setUp(self):
        from unittest import mock
        import vram
        self.vram = vram
        self.mock = mock

    def _patches(self, loaded_fn, kill_fn=None):
        patches = [
            self.mock.patch.object(self.vram, "loaded_models", side_effect=loaded_fn),
            self.mock.patch.object(self.vram, "unload_model", return_value=None),
            self.mock.patch.object(self.vram, "kill_model_runners",
                                   side_effect=kill_fn or (lambda: ["llama-server.exe"])),
            self.mock.patch.object(self.vram.time, "sleep", return_value=None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_released_by_api_reports_success_without_killing(self):
        calls = {"n": 0}

        def loaded():
            calls["n"] += 1
            return ["sakura-14b"] if calls["n"] == 1 else []

        self._patches(loaded)
        ok, detail = self.vram.unload_model_forced("sakura-14b")
        self.assertTrue(ok)
        self.assertNotIn("强制", detail)
        self.vram.kill_model_runners.assert_not_called()

    def test_busy_model_gets_runner_killed_instead_of_waiting(self):
        state = {"killed": False}

        def loaded():
            return [] if state["killed"] else ["sakura-14b"]

        def kill():
            state["killed"] = True
            return ["llama-server.exe"]

        self._patches(loaded, kill)
        ok, detail = self.vram.unload_model_forced("sakura-14b")
        self.assertTrue(ok)
        self.assertIn("强制", detail)
        self.vram.kill_model_runners.assert_called()

    def test_runner_refusing_to_exit_reports_failure(self):
        self._patches(lambda: ["sakura-14b"])
        ok, _detail = self.vram.unload_model_forced("sakura-14b")
        self.assertFalse(ok)

    def test_unload_all_reports_partial_failure(self):
        self._patches(lambda: ["sakura-14b"])
        ok, detail, _unloaded = self.vram.unload_all_models_forced()
        self.assertFalse(ok)
        self.assertIn("未能卸载", detail)


if __name__ == "__main__":
    unittest.main(verbosity=2)
