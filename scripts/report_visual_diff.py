#!/usr/bin/env python3
"""開発用: 生成した完了報告書PDFと見本PDFの見た目を比べる。

  npx tsx scripts/dump-report.mts .cache/report --items 1
  npx tsx scripts/dump-report.mts .cache/report --items 6
  python3 scripts/report_visual_diff.py

罫線 (黒い横棒・縦棒) の位置がずれていないかを数値で出し、
並べた画像と差分画像を .cache/report/ に書き出す。文字はフォントが違う (游ゴシック→Noto Sans JP)
ので必ず差が出る。ここで見たいのは「枠の位置が合っているか」。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DPI = 150
PAIRS = [
    ("本紙", ROOT / "完了報告書_例" / "完了報告書（別紙あり）.pdf", 1, ROOT / ".cache" / "report" / "report-appendix.pdf", 1),
    ("別紙", ROOT / "完了報告書_例" / "完了報告書（別紙あり）.pdf", 2, ROOT / ".cache" / "report" / "report-appendix.pdf", 2),
]


def render(pdf: Path, page: int, out_prefix: Path) -> Image.Image:
    subprocess.run(
        ["pdftoppm", "-r", str(DPI), "-png", "-f", str(page), "-l", str(page), str(pdf), str(out_prefix)],
        check=True,
        capture_output=True,
    )
    files = sorted(out_prefix.parent.glob(f"{out_prefix.name}-*.png"))
    if not files:
        raise RuntimeError(f"{pdf} のページ{page}を画像にできなかった")
    return Image.open(files[-1]).convert("L")


def line_positions(img: Image.Image, axis: int, threshold: float = 0.35) -> list[int]:
    """行 (または列) の3割以上に色が乗っているところを罫線とみなす。
    極細線 (hair, 0.12pt) は薄い灰色になるので、しきい値は「真っ黒」ではなく「白でない」で見る。"""
    ink = np.asarray(img) < 210
    ratio = ink.mean(axis=axis)
    hits = np.where(ratio > threshold)[0]
    groups: list[list[int]] = []
    for v in hits:
        if groups and v - groups[-1][-1] <= 1:
            groups[-1].append(int(v))
        else:
            groups.append([int(v)])
    return [int(round(sum(g) / len(g))) for g in groups]


def compare(label: str, ref: Image.Image, gen: Image.Image, out: Path) -> bool:
    # ページの実寸は同じでも、丸めで1px違うことがあるので小さい方に揃える
    width = min(ref.width, gen.width)
    height = min(ref.height, gen.height)
    ref = ref.crop((0, 0, width, height))
    gen = gen.crop((0, 0, width, height))
    ok = True
    for axis, name in ((1, "横罫線"), (0, "縦罫線")):
        a = line_positions(ref, axis)
        b = line_positions(gen, axis)
        # 極細線は画素の丸めで検出できたりできなかったりするので、本数ではなく
        # 「見本の各線に対応する線が生成側にあるか」で見る
        unmatched: list[int] = []
        worst = 0
        for x in a:
            near = min(b, key=lambda y: abs(y - x)) if b else None
            if near is None or abs(near - x) > 2:
                unmatched.append(x)
            else:
                worst = max(worst, abs(near - x))
        px = 72 / DPI
        print(
            f"  {label} {name}: 見本{len(a)}本 / 生成{len(b)}本 "
            f"最大ずれ {worst}px ({worst * px:.2f}pt) 未対応 {len(unmatched)}本"
            + (f" {unmatched}" if unmatched else "")
        )
        if unmatched or worst > 2:
            ok = False

    ref_a = np.asarray(ref).astype(int)
    gen_a = np.asarray(gen).astype(int)
    diff = np.abs(ref_a - gen_a).astype(np.uint8)
    changed = float((diff > 64).mean()) * 100
    print(f"  {label} 画素の差: {changed:.2f}% (文字のフォント差を含む)")
    side = Image.new("L", (ref.width * 2 + 20, ref.height), 255)
    side.paste(ref, (0, 0))
    side.paste(gen, (ref.width + 20, 0))
    side.save(out.with_name(f"{out.name}-side.png"))
    Image.fromarray(255 - diff).save(out.with_name(f"{out.name}-diff.png"))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=ROOT / ".cache" / "report")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    all_ok = True
    for label, ref_pdf, ref_page, gen_pdf, gen_page in PAIRS:
        if not ref_pdf.exists() or not gen_pdf.exists():
            print(f"{label}: PDFが無いので飛ばす ({ref_pdf.name} / {gen_pdf.name})")
            continue
        print(f"{label}: {ref_pdf.name} p{ref_page} ↔ {gen_pdf.name} p{gen_page}")
        ref = render(ref_pdf, ref_page, args.out / f"diff-ref-{label}")
        gen = render(gen_pdf, gen_page, args.out / f"diff-gen-{label}")
        all_ok &= compare(label, ref, gen, args.out / f"diff-{label}")
    print("罫線の位置は一致しています" if all_ok else "ずれがあります (上の出力を確認)")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
