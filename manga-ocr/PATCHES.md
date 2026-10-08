# vendor/manga-ocr 本地改动记录

本目录是上游 [kha-white/manga-ocr](https://github.com/kha-white/manga-ocr)（MIT）的
vendored 副本。许可证原文见同目录 `LICENSE`。

保留本文件的目的：开源分发时，让读者能一眼看出**这份代码和上游相比动过什么**。

## 已发生的改动

### 1. 删除非运行时资源（18 个文件，约 5711 行）

本项目只用 `MangaOcr` 类做单行日文识别，**不走**上游的示例脚本、字体统计与分词表，
因此这些文件在入库时即被删除：

- `assets/examples/*.jpg`（14 个示例图，含 310 KB 的 `cc-100.jpg`、414 KB 的 `random.jpg`）
- `assets/fonts.csv`
- `assets/len_to_p.csv`
- `assets/lines_example.csv`
- `assets/vocab.csv`（5451 行，分词/字符表）

保留的是运行必需部分：`__init__.py`、`__main__.py`、`_version.py`、`ocr.py`、`run.py`
和 `assets/example.jpg`（`MangaOcr.__init__` 启动自检要读它，缺失会直接抛
`FileNotFoundError`）。

### 2. Python 源码：本项目 git 历史内**无改动**

用 `git diff <首版> HEAD -- 'manga-ocr/**/*.py'` 核对，结果为空。即 5 个 `.py` 文件
从入库到现在没有修改过。

## 一处来源未明的改动（待核实）

`manga_ocr/ocr.py` 第 18–20 行：

```python
# explicit tokenizer_type works around transformers>=5.13 misdetecting the tokenizer class
# for VisionEncoderDecoderModel configs and falling back to an incompatible fast-only backend
self.tokenizer = AutoTokenizer.from_pretrained(pretrained_model_name_or_path, tokenizer_type="bert-japanese")
```

从注释语气看，这是为了兼容 `transformers >= 5.13`（该版本会误判
VisionEncoderDecoderModel 的 tokenizer 类型并回退到不兼容的 fast-only 后端）而显式指定
`tokenizer_type="bert-japanese"`。

但这行**在本项目的首个提交里就已存在**，git 历史中没有对应的修改记录 —— 也就是无法
判断它来自上游某个版本，还是入库前手工改的。

**如果它确实是本地补丁**，合规做法应该是补一个 `patches/*.patch` 或在文件头标注。
目前按"来源未明"如实记录，待核实后再处置。
