#!/usr/bin/env python3
"""見本の完了報告書PDFから「罫線の座標」と「固定ラベルの位置」だけを抽出して
tests/report-geometry.json を作る開発用スクリプト (PDFレイアウトの回帰テスト用)。

  python3 scripts/extract_report_geometry.py

出力には個人情報を入れない。抽出するのは
  - 罫線 (塗り矩形) の座標と太さ
  - あらかじめ決めた固定ラベル (「PJコード」「指示内容」など) の位置
  - チェックボックス字形の位置
だけで、施主名・物件名・住所・電話番号・指摘内容といった値は一切含めない。
座標は「左上原点・y下向き・pt」に変換する (lib/report/metrics.ts と同じ向き)。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from pdfminer.high_level import extract_pages
from pdfminer.layout import LAParams, LTChar, LTLine, LTRect

ROOT = Path(__file__).resolve().parent.parent
# 2ページある見本 (本紙+別紙) を使う。1ページ目=本紙、2ページ目=別紙。
# もう一方の見本 (1項目版) はフォントの埋め込み方が違い字形の外形寸法がずれるため、
# 罫線の一致確認だけに使う (--cross-check)。
SOURCE = ROOT / "完了報告書_例" / "完了報告書（別紙あり）.pdf"
CROSS_CHECK = ROOT / "完了報告書_例" / "完了報告書.pdf"
DEFAULT_OUT = ROOT / "tests" / "report-geometry.json"

# 抽出してよい固定ラベル (これ以外の文字は座標も含めて出力しない)
FIXED_LABELS = [
    "作業報告書　兼　完了報告書",
    "タカマツビルド　株式会社",
    "アフターメンテナンス課",
    "PJコード",
    "引渡日",
    "物件名",
    "施主名",
    "住所",
    "連絡先①",
    "連絡先②",
    "立会",
    "施主ご家族",
    "施主",
    "その他（",
    "）",
    "受付項目",
    "点検",
    "アフター",
    "有償工事",
    "直収対応",
    "無償対応",
    "受付日",
    "受付者",
    "指示内容",
    "別紙参照",
    "作業内容・是正内容",
    "完了ﾁｪｯｸ",
    "会社名：",
    "作業者：",
    "◎上記作業内容もしくは是正工事が完了したことを確認しました。",
    "お客様ご署名",
    "印",
    "年",
    "月",
    "日",
    # 別紙
    "（別　紙）",
    "2/2",
    "物件名：",
    "施主名：",
    "1年目点検是正項目",
    "項　　　目",
    "チェック欄",
    "対応結果：",
]
# 値と紛れないよう、行頭のラベルだけを見る指定 (行の途中に出たら無視する)
LINE_START_ONLY = {"物件名：", "施主名：", "1年目点検是正項目"}
# 直前の文字とこれ以上離れていれば「別の語の始まり」と見なす (値の中の一致を弾く)
TOKEN_GAP_PT = 2.0
# チェックボックスは Calibri の私用領域字形で描かれている
CHECKBOX_FONT_RE = re.compile(r"Calibri|CIDFont\+F2")


def top_down(page_height: float, y0: float, y1: float) -> tuple[float, float]:
    """PDFの下原点座標を上原点 (y下向き) に直す。返り値は (上端, 下端)"""
    return (page_height - y1, page_height - y0)


def collect(page) -> tuple[list, list]:
    rects: list[tuple[float, float, float, float]] = []
    chars: list[LTChar] = []

    def walk(obj) -> None:
        for el in obj:
            if isinstance(el, (LTRect, LTLine)):
                rects.append((el.x0, el.y0, el.x1, el.y1))
            elif isinstance(el, LTChar):
                chars.append(el)
            if hasattr(el, "__iter__") and not isinstance(el, LTChar):
                walk(el)

    walk(page)
    return rects, chars


def group_lines(chars: list[LTChar], tol: float = 2.0) -> list[list[LTChar]]:
    lines: list[list[LTChar]] = []
    for ch in sorted(chars, key=lambda c: (-c.y0, c.x0)):
        for line in lines:
            if abs(line[0].y0 - ch.y0) <= tol:
                line.append(ch)
                break
        else:
            lines.append([ch])
    return [sorted(line, key=lambda c: c.x0) for line in lines]


def extract_labels(chars: list[LTChar], page_height: float) -> list[dict]:
    """固定ラベルの位置を取る。値の一部にたまたま一致するのを避けるため、
    語の先頭 (行頭、または直前の文字から離れている) だけを拾う。"""
    out: list[dict] = []
    for line in group_lines(chars):
        visible = [c for c in line if not CHECKBOX_FONT_RE.search(c.fontname)]
        # 空白 (字形が出ないこともある) を無視して突き合わせる
        compact = [c for c in visible if c.get_text().strip()]
        text = "".join(c.get_text() for c in compact)
        consumed: set[int] = set()
        for label in sorted(FIXED_LABELS, key=len, reverse=True):
            needle = "".join(ch for ch in label if ch.strip())
            if not needle:
                continue
            start = 0
            while True:
                i = text.find(needle, start)
                if i < 0:
                    break
                start = i + 1
                span = compact[i : i + len(needle)]
                if len(span) != len(needle) or any(j in consumed for j in range(i, i + len(needle))):
                    continue
                if label in LINE_START_ONLY and i != 0:
                    continue
                if i > 0 and span[0].x0 - compact[i - 1].x1 < TOKEN_GAP_PT:
                    continue  # 値の途中に埋まっている一致
                consumed.update(range(i, i + len(needle)))
                top, bottom = top_down(page_height, min(c.y0 for c in span), max(c.y1 for c in span))
                out.append(
                    {
                        "text": label,
                        "x0": round(min(c.x0 for c in span), 2),
                        "x1": round(max(c.x1 for c in span), 2),
                        "top": round(top, 2),
                        "bottom": round(bottom, 2),
                        # 描画に使う基準線 (pdf-lib の drawText の y に対応)
                        "baseline": round(page_height - span[0].matrix[5], 2),
                        "size": round(span[0].size, 2),
                        "bold": "Bold" in span[0].fontname or span[0].fontname.endswith("F1"),
                    }
                )
    uniq = {(d["text"], d["x0"], d["top"]): d for d in out}
    return sorted(uniq.values(), key=lambda d: (d["top"], d["x0"]))


def extract_checkboxes(chars: list[LTChar], page_height: float) -> list[dict]:
    out = []
    for ch in chars:
        if not CHECKBOX_FONT_RE.search(ch.fontname):
            continue
        top, bottom = top_down(page_height, ch.y0, ch.y1)
        out.append(
            {
                "codepoint": f"U+{ord(ch.get_text()):04X}",
                "x0": round(ch.x0, 2),
                "x1": round(ch.x1, 2),
                "top": round(top, 2),
                "bottom": round(bottom, 2),
                "size": round(ch.size, 2),
                "baseline": round(page_height - ch.matrix[5], 2),
            }
        )
    return sorted(out, key=lambda d: (d["top"], d["x0"]))


def extract_rects(rects: list, page_height: float) -> list[dict]:
    out = []
    for x0, y0, x1, y1 in rects:
        w, h = x1 - x0, y1 - y0
        if w <= 0 or h <= 0:
            continue
        top, bottom = top_down(page_height, y0, y1)
        out.append(
            {
                "x0": round(x0, 2),
                "x1": round(x1, 2),
                "top": round(top, 2),
                "bottom": round(bottom, 2),
                "width": round(w, 2),
                "height": round(h, 2),
                "orientation": "h" if w >= h else "v",
            }
        )
    return sorted(out, key=lambda d: (d["top"], d["x0"]))


def grid(rects: list[dict], tol: float = 0.3) -> dict:
    """罫線から縦線・横線の中心座標を割り出す (太さの中心。lib/report/metrics.ts と同じ規約)"""
    def centers(items: list[float]) -> list[float]:
        out: list[float] = []
        for v in sorted(items):
            if not out or abs(v - out[-1]) > tol:
                out.append(v)
            else:
                out[-1] = (out[-1] + v) / 2
        return [round(v, 2) for v in out]

    verticals = [r for r in rects if r["orientation"] == "v"]
    horizontals = [r for r in rects if r["orientation"] == "h"]
    return {
        "verticalCenters": centers([(r["x0"] + r["x1"]) / 2 for r in verticals]),
        "horizontalCenters": centers([(r["top"] + r["bottom"]) / 2 for r in horizontals]),
    }


def page_geometry(page, name: str) -> dict:
    page_height = page.bbox[3]
    rects, chars = collect(page)
    r = extract_rects(rects, page_height)
    return {
        "pageWidth": round(page.bbox[2], 2),
        "pageHeight": round(page_height, 2),
        "rects": r,
        "grid": grid(r),
        "labels": extract_labels(chars, page_height),
        "checkboxes": extract_checkboxes(chars, page_height),
    }


def cross_check(doc: dict) -> None:
    """もう一方の見本 (1項目版) と罫線が一致することを確かめる (出力には入れない)"""
    if not CROSS_CHECK.exists():
        return
    pages = list(extract_pages(CROSS_CHECK, laparams=LAParams(char_margin=2.0, line_margin=0.3)))
    other = page_geometry(pages[0], "main")
    a = doc["pages"]["main"]["grid"]
    b = other["grid"]
    for key in ("verticalCenters", "horizontalCenters"):
        mismatches = [
            (x, y)
            for x, y in zip(a[key], b[key])
            if abs(x - y) > 0.5
        ]
        status = "一致" if not mismatches and len(a[key]) == len(b[key]) else f"差異 {mismatches[:3]}"
        print(f"  cross-check {key}: {len(a[key])} vs {len(b[key])} 本 → {status}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    if not SOURCE.exists():
        print(f"見本PDFが見つからない: {SOURCE}", file=sys.stderr)
        return 1
    pages = list(extract_pages(SOURCE, laparams=LAParams(char_margin=2.0, line_margin=0.3)))
    if len(pages) < 2:
        print(f"{SOURCE.name} は2ページある見本 (本紙+別紙) である必要がある", file=sys.stderr)
        return 1
    doc: dict = {
        "note": "見本PDFから抽出した罫線と固定ラベルの位置 (個人情報は含めない)。"
        "scripts/extract_report_geometry.py が生成する",
        "unit": "pt",
        "origin": "top-left, y down",
        "pages": {
            "main": page_geometry(pages[0], "main"),
            "appendix": page_geometry(pages[1], "appendix"),
        },
    }
    # 値 (氏名・住所・電話番号・指摘内容) が混ざっていないことを確認する。
    # ラベルは FIXED_LABELS のものだけ、数字は「2/2」やタイトルの1桁までしか出ないはず。
    labels = {l["text"] for page in doc["pages"].values() for l in page["labels"]}
    unexpected = labels - set(FIXED_LABELS)
    if unexpected:
        print(f"想定外のラベルが混ざっている: {sorted(unexpected)}", file=sys.stderr)
        return 1
    # 座標以外の文字列 (ラベル) に値が混ざっていないか
    texts = " ".join(sorted(labels))
    for pat in (r"\d{2,4}-\d{2,4}-\d{3,4}", r"\d{3,}"):
        hit = re.search(pat, texts)
        if hit:
            print(f"抽出結果に値が混ざっている疑い: {pat} ({hit.group(0)})", file=sys.stderr)
            return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for name, page in doc["pages"].items():
        print(
            f"{name}: 罫線 {len(page['rects'])} / ラベル {len(page['labels'])} / "
            f"チェック {len(page['checkboxes'])} / 縦線 {len(page['grid']['verticalCenters'])} / "
            f"横線 {len(page['grid']['horizontalCenters'])}"
        )
    cross_check(doc)
    print(f"生成しました: {args.out.relative_to(ROOT)} ({args.out.stat().st_size / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
