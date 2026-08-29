#!/usr/bin/env python3
"""完了報告書PDF用の日本語フォント (Noto Sans JP) を作る開発用スクリプト。

  python3 scripts/build_report_fonts.py [--cache <dir>] [--out public/report/fonts]

Google Fonts の可変フォント NotoSansJP[wght].ttf を取得し、
  1. wght=400 / 700 の静的TTFに固定 (instancer)
  2. 日本語業務文書に必要な文字だけに絞る (pyftsubset 相当)
  3. gzip して public/report/fonts/ に出力 (ブラウザは fetch 後に展開する)
ライセンスは OFL-1.1。OFL.txt も併せて出力する。

このフォントはPDFに「丸ごと」埋め込む (pdf-lib の subset:true は、CJKのような
大きなTrueTypeフォントで字形が欠落する不具合があり使えない。lib/report/pdf.ts のコメント参照)。
そのため、ここで文字数を絞ることがPDFの大きさに直結する。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import re
import sys
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
LICENSE_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/notosansjp/OFL.txt"

# 記号・かな・英数など、日本語の業務文書で使う範囲
BLOCKS = [
    (0x0020, 0x007E),  # ASCII
    (0x00A0, 0x00FF),  # ラテン1補助 (° × ÷ など)
    (0x2010, 0x206F),  # 一般句読点 (— ‐ “ ” ※の類)
    (0x2100, 0x214F),  # 文字様記号 (№ ℃)
    (0x2190, 0x21FF),  # 矢印
    (0x2200, 0x22FF),  # 数学記号
    (0x2460, 0x24FF),  # 囲み英数字 (①〜⑳)
    (0x2500, 0x257F),  # 罫線素片
    (0x25A0, 0x25FF),  # 幾何学模様 (■ □ ◎ ●)
    (0x2600, 0x26FF),  # その他の記号 (☐ ☑ ★)
    (0x3000, 0x303F),  # CJK記号・句読点 (全角スペース 、。〒〓)
    (0x3040, 0x30FF),  # ひらがな・カタカナ
    (0x31F0, 0x31FF),  # カタカナ拡張
    (0x3200, 0x33FF),  # 囲みCJK・CJK互換 (㈱ ㎡ ℡)
    (0xFE30, 0xFE4F),  # CJK互換形
    (0xFF01, 0xFFEF),  # 半角・全角形 (半角カナ、全角英数)
]
# 人名で出やすい異体字など、cp932 に無いもの
EXTRA_CHARS = "𠮷𡈽塚﨑德瀨髙禮曽渕籔"
# 収録されていないと困る文字 (検査用)
REQUIRED_CHARS = "髙﨑德瀨様①⑳№◎〓　ﾁｪｯｸ年ヶ月週日目点検是正項目別紙参照物件名施主住所連絡先受付者立会指示内容作業報告書兼完了"

# 太字を使う箇所は決まっているので、必要な文字だけに絞る
BOLD_TEXTS = [
    "作業報告書　兼　完了報告書",
    "（別　紙）",
    "点検是正項目",
    "年ヶ月週日目回目",
    "0123456789",
]

KEEP_NAME_IDS = "0,1,2,3,4,5,6,13,14"
# 使わない表は落とす (縦書き・OpenType機能・字形の代替など)。
# post は pdf-lib が italicAngle を読むので残す。
DROP_TABLES = ["DSIG", "GSUB", "GPOS", "BASE", "STAT", "gasp", "vhea", "vmtx"]
# 2026-01-01T00:00:00Z (Mac の 1904 起点秒)。出力を毎回同じバイト列にするため
FIXED_TIMESTAMP = 3849984000


def cp932_chars() -> set[int]:
    out: set[int] = set()
    for cp in range(0x20, 0x10000):
        ch = chr(cp)
        try:
            ch.encode("cp932")
        except UnicodeEncodeError:
            continue
        out.add(cp)
    return out


def build_charset(cmap: set[int]) -> set[int]:
    wanted = cp932_chars()
    for lo, hi in BLOCKS:
        wanted.update(range(lo, hi + 1))
    wanted.update(ord(c) for c in EXTRA_CHARS)
    return wanted & cmap


def fetch(url: str, dest: Path) -> bytes:
    if dest.exists():
        return dest.read_bytes()
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"ダウンロード: {url}")
    with urllib.request.urlopen(url, timeout=180) as res:  # noqa: S310 (固定URL)
        data = res.read()
    dest.write_bytes(data)
    return data


def subset_font(src: bytes, weight: float, unicodes: set[int], out: Path) -> tuple[int, int, str]:
    # recalcTimestamp=False: 保存時に更新日時を書き換えさせない (毎回同じバイト列にする)
    font = TTFont(io.BytesIO(src), recalcTimestamp=False)
    static = instancer.instantiateVariableFont(font, {"wght": weight}, inplace=True, updateFontNames=True)
    options = subset.Options()
    options.name_IDs = [int(x) for x in KEEP_NAME_IDS.split(",")]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.layout_features = []
    options.hinting = False
    options.desubroutinize = False
    options.drop_tables += DROP_TABLES
    options.notdef_outline = True
    options.recalc_bounds = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=sorted(unicodes))
    subsetter.subset(static)
    for table in DROP_TABLES:
        if table in static:
            del static[table]
    # 実行ごとにハッシュが変わらないよう、更新日時を固定する
    static["head"].created = FIXED_TIMESTAMP
    static["head"].modified = FIXED_TIMESTAMP
    buf = io.BytesIO()
    static.flavor = None
    static.save(buf)
    raw = buf.getvalue()
    kept = set(TTFont(io.BytesIO(raw)).getBestCmap())
    missing = [c for c in REQUIRED_CHARS if ord(c) in unicodes and ord(c) not in kept]
    if missing:
        raise RuntimeError(f"必須文字がサブセットから落ちた: {''.join(missing)}")
    gz = gzip.compress(raw, 9, mtime=0)
    digest = hashlib.sha256(gz).hexdigest()[:8]
    out.parent.mkdir(parents=True, exist_ok=True)
    for old in out.parent.glob(out.name.replace("HASH", "*")):
        old.unlink()
    final = out.with_name(out.name.replace("HASH", digest))
    final.write_bytes(gz)
    return len(raw), len(gz), final.name


def write_asset_names(regular: str, bold: str) -> None:
    """フォント名 (ハッシュ入り) をTSの定数として書き出す。クライアントはこれを import する。"""
    path = ROOT / "lib" / "report" / "asset-names.generated.ts"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "// scripts/build_report_fonts.py が生成する。手で編集しない。\n"
        "export const REPORT_TEMPLATE_URL = \"/report/completion-report.xlsx\";\n"
        f"export const REPORT_FONT_REGULAR_URL = \"/report/fonts/{regular}\";\n"
        f"export const REPORT_FONT_BOLD_URL = \"/report/fonts/{bold}\";\n",
        encoding="utf-8",
    )
    print(f"生成しました: {path.relative_to(ROOT)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", type=Path, default=ROOT / ".cache" / "fonts")
    ap.add_argument("--out", type=Path, default=ROOT / "public" / "report" / "fonts")
    args = ap.parse_args()

    src = fetch(FONT_URL, args.cache / "NotoSansJP[wght].ttf")
    license_text = fetch(LICENSE_URL, args.cache / "OFL.txt").decode("utf-8")
    # OFL の Reserved Font Name は「Source」(派生元の Source Han Sans) のみ。
    # 出力名 Noto Sans JP は予約名に当たらないが、将来変わったら気付けるよう検査する。
    rfn = re.findall(r"with Reserved Font Name ['\"]([^'\"]+)['\"]", license_text.splitlines()[0])
    if any(word.lower() in {"noto"} for word in rfn):
        raise RuntimeError(f"OFL の予約フォント名に Noto が含まれる: {rfn} → 出力フォント名を変えること")
    if rfn:
        print(f"OFL の予約フォント名: {rfn} (出力名 Noto Sans JP は該当しない)")

    cmap = set(TTFont(io.BytesIO(src)).getBestCmap())
    regular_set = build_charset(cmap)
    bold_set = {ord(c) for t in BOLD_TEXTS for c in t}
    bold_set |= set(range(0x20, 0x7F))
    bold_set |= set(range(0x3000, 0x3100))  # 全角スペース・かな
    bold_set |= {ord(c) for c in "点検是正項目別紙参照年月週日目回"}
    bold_set &= cmap

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "OFL.txt").write_text(license_text, encoding="utf-8")
    results = []
    for weight, name in ((400.0, "NotoSansJP-Regular.HASH.ttf.gz"), (700.0, "NotoSansJP-Bold.HASH.ttf.gz")):
        chars = regular_set if weight == 400.0 else bold_set
        raw, gz, final = subset_font(src, weight, chars, args.out / name)
        results.append((final, len(chars), raw, gz))
        print(f"{final}: {len(chars)} 文字, {raw / 1024:.0f} KB → gzip {gz / 1024:.0f} KB")
    total = sum(r[3] for r in results)
    write_asset_names(results[0][0], results[1][0])
    print(f"合計 gzip {total / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
