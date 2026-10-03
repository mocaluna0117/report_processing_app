#!/usr/bin/env python3
"""支出報告書のテンプレート (xlsx) を、利用者の見本から作る開発用スクリプト。

  python3 scripts/build_expense_template.py [--src <見本.xlsx>] [--out public/report/expense-report.xlsx]

やること:
  1. 「〇月度支出報告」シートの 1〜18 行目（合計欄・担当者別件数の表・1つ目の表の見出し）だけを残す。
     19 行目以降（お客様の物件の行）は消す。Folio が月ごとに組み立てて足す
  2. 残りのシート (Sheet2 = 2018年の残りもの・Sheet3 = 空) と、共有文字列・計算の順番・印刷設定を外す。
     ★共有文字列にはお客様の物件名が入っているので、残す文字はセルの中 (inlineStr) に移して表ごと消す
  3. 作成者名・Box のフォルダーの場所 (利用者の氏名を含む) を消す
  4. 担当者別件数の数字・合計欄の数式の結果は 0 にする。シート名は「支出報告」にしておく (Folio が月を入れる)
  5. お客様の名前が残っていないかを確かめる

元ファイル (支出報告書_例/) は個人情報を含むのでコミットしない。出力だけをコミットする。
見本を差し替えたら、このスクリプトをもう一度実行する。
"""

from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "支出報告書_例" / "2026年 8月度支出報告　【アフターメンテナンス課】.xlsx"
DEFAULT_OUT = ROOT / "public" / "report" / "expense-report.xlsx"
SHEET = "xl/worksheets/sheet1.xml"
PLACEHOLDER_SHEET_NAME = "支出報告"
KEEP_ROWS = 18

DROP_PARTS = {
    "xl/worksheets/sheet2.xml",
    "xl/worksheets/sheet3.xml",
    "xl/sharedStrings.xml",
    "xl/calcChain.xml",
    "xl/printerSettings/printerSettings1.bin",
    "xl/worksheets/_rels/sheet1.xml.rels",
}

# ZIP 内の更新日時を固定する（同じ見本からは同じバイト列になるように）
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def shared_strings(z: zipfile.ZipFile) -> list[str]:
    xml = z.read("xl/sharedStrings.xml").decode("utf-8")
    out = []
    for m in re.finditer(r"<si>(.*?)</si>", xml, re.S):
        body = re.sub(r"<rPh\b.*?</rPh>", "", m.group(1), flags=re.S)
        text = "".join(re.findall(r"<t[^>]*>(.*?)</t>", body, re.S))
        out.append(text)  # XML のエスケープは付いたまま
    return out


def build_sheet(xml: str, sst: list[str]) -> str:
    start = xml.index("<sheetData>") + len("<sheetData>")
    end = xml.index("</sheetData>")
    rows = []
    for m in re.finditer(r'<row r="(\d+)"[^>]*?(?:/>|>.*?</row>)', xml[start:end], re.S):
        if int(m.group(1)) <= KEEP_ROWS:
            rows.append(m.group(0))
    body = "".join(rows)

    # 共有文字列の参照 → セルの中の文字に
    def inline(m: re.Match) -> str:
        attrs, idx = m.group(1), int(m.group(2))
        attrs = attrs.replace(' t="s"', "")
        return f'<c{attrs} t="inlineStr"><is><t xml:space="preserve">{sst[idx]}</t></is></c>'

    body = re.sub(r'<c([^>]*? t="s"[^>]*)><v>(\d+)</v></c>', inline, body)
    # タイトル (A1) は空に。Folio が「〇年　〇月度…」を入れる
    body = re.sub(r'<c r="A1"([^>]*?) t="inlineStr"><is>.*?</is></c>', r'<c r="A1"\1 t="inlineStr"><is><t></t></is></c>', body)
    # 担当者別件数 (C7:E14) は 0、計の数式 (G7:G15, C15:E15) と合計欄 (N4:P4) の結果も 0
    body = re.sub(r'(<c r="[C-E](?:[7-9]|1[0-4])"[^>]*>)<v>[^<]*</v>', r"\g<1><v>0</v>", body)
    # 共有の数式は、Folio が書き換えやすいように1つずつの数式にする
    def unshare(m: re.Match) -> str:
        ref, attrs = m.group(1), m.group(2)
        row = re.match(r"G(\d+)", ref).group(1)
        return f'<c r="{ref}"{attrs}><f>SUM(C{row}:F{row})</f><v>0</v></c>'

    body = re.sub(r'<c r="(G\d+)"([^>]*)><f t="shared"[^>]*?(?:/>|>[^<]*</f>)<v>[^<]*</v></c>', unshare, body)
    body = re.sub(r"(<f>[^<]*</f>)<v>[^<]*</v>", r"\1<v>0</v>", body)

    head = xml[:start]
    tail = xml[end:]
    head = re.sub(r'<dimension ref="[^"]*"/>', '<dimension ref="A1:Q18"/>', head)
    head = re.sub(r'<selection [^>]*/>', '<selection activeCell="A1" sqref="A1"/>', head)
    # 結合は 18 行目までのものだけ
    merges = [r for r in re.findall(r'<mergeCell ref="([^"]+)"/>', tail) if all(int(n) <= KEEP_ROWS for n in re.findall(r"\d+", r))]
    tail = re.sub(
        r"<mergeCells[^>]*>.*?</mergeCells>",
        f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{r}"/>' for r in merges) + "</mergeCells>",
        tail,
        flags=re.S,
    )
    tail = re.sub(r' r:id="[^"]*"', "", tail)  # 印刷設定 (プリンター名を含む) を外した
    tail = re.sub(r"<rowBreaks.*?</rowBreaks>", "", tail, flags=re.S)
    return head + body + tail


def build_workbook(xml: str) -> str:
    xml = re.sub(r"<mc:AlternateContent.*?</mc:AlternateContent>", "", xml, flags=re.S)
    xml = re.sub(r"<sheets>.*?</sheets>", f'<sheets><sheet name="{PLACEHOLDER_SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets>', xml, flags=re.S)
    q = f"'{PLACEHOLDER_SHEET_NAME}'"
    xml = re.sub(
        r"<definedNames>.*?</definedNames>",
        "<definedNames>"
        f'<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">{q}!$A$18:$S$18</definedName>'
        f'<definedName name="_xlnm.Print_Area" localSheetId="0">{q}!$A$1:$Q$18</definedName>'
        f'<definedName name="_xlnm.Print_Titles" localSheetId="0">{q}!$17:$18</definedName>'
        "</definedNames>",
        xml,
        flags=re.S,
    )
    # 開いたときに必ず計算し直させる（Folio は結果も書くが、念のため）
    xml = re.sub(r'<calcPr calcId="(\d+)"/>', r'<calcPr calcId="\1" fullCalcOnLoad="1"/>', xml)
    xml = re.sub(r"<xr:revisionPtr [^>]*/>", "", xml)
    return xml


def build_rels(xml: str) -> str:
    keep = []
    for m in re.finditer(r"<Relationship [^>]*/>", xml):
        if re.search(r'Target="(worksheets/sheet1\.xml|styles\.xml|theme/theme1\.xml)"', m.group(0)):
            keep.append(m.group(0))
    head = xml[: xml.index("<Relationship ")]
    return head + "".join(keep) + "</Relationships>"


def build_content_types(xml: str) -> str:
    for part in ["/xl/worksheets/sheet2.xml", "/xl/worksheets/sheet3.xml", "/xl/sharedStrings.xml", "/xl/calcChain.xml"]:
        xml = re.sub(rf'<Override PartName="{re.escape(part)}"[^>]*/>', "", xml)
    xml = re.sub(r'<Default Extension="bin"[^>]*/>', "", xml)
    return xml


def build_app(xml: str) -> str:
    xml = re.sub(
        r"<HeadingPairs>.*?</HeadingPairs>",
        '<HeadingPairs><vt:vector size="4" baseType="variant"><vt:variant><vt:lpstr>ワークシート</vt:lpstr></vt:variant>'
        '<vt:variant><vt:i4>1</vt:i4></vt:variant><vt:variant><vt:lpstr>名前付き一覧</vt:lpstr></vt:variant>'
        "<vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs>",
        xml,
        flags=re.S,
    )
    q = f"'{PLACEHOLDER_SHEET_NAME}'"
    xml = re.sub(
        r"<TitlesOfParts>.*?</TitlesOfParts>",
        f'<TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>{PLACEHOLDER_SHEET_NAME}</vt:lpstr>'
        f"<vt:lpstr>{q}!Print_Area</vt:lpstr><vt:lpstr>{q}!Print_Titles</vt:lpstr></vt:vector></TitlesOfParts>",
        xml,
        flags=re.S,
    )
    xml = re.sub(r"<Company>.*?</Company>", "<Company></Company>", xml)
    return xml


def build_core(xml: str) -> str:
    xml = re.sub(r"<dc:creator>.*?</dc:creator>", "<dc:creator>Folio</dc:creator>", xml)
    xml = re.sub(r"<cp:lastModifiedBy>.*?</cp:lastModifiedBy>", "<cp:lastModifiedBy>Folio</cp:lastModifiedBy>", xml)
    xml = re.sub(r"<cp:lastPrinted>.*?</cp:lastPrinted>", "", xml)
    xml = re.sub(r"(<dcterms:(?:created|modified)[^>]*>)[^<]*", r"\g<1>2026-01-01T00:00:00Z", xml)
    return xml


def check(out: Path, sample_names: list[str]) -> None:
    with zipfile.ZipFile(out) as z:
        names = set(z.namelist())
        for part in DROP_PARTS:
            if part in names:
                sys.exit(f"消したはずのパーツが残っています: {part}")
        text = "".join(z.read(n).decode("utf-8", "replace") for n in names if n.endswith((".xml", ".rels")))
    for word in sample_names:
        if word and word in text:
            sys.exit(f"見本の文字がテンプレートに残っています: {word[:4]}…")
    if "Box" in text or "Users" in text:
        sys.exit("フォルダーの場所がテンプレートに残っています")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    if not args.src.exists():
        sys.exit(f"見本がありません: {args.src}")

    with zipfile.ZipFile(args.src) as z:
        sst = shared_strings(z)
        parts = {n: z.read(n) for n in z.namelist()}
    # 19行目以降で使われていた文字（物件名など）。テンプレートに残っていないことを確かめる
    xml = parts[SHEET].decode("utf-8")
    sheet_data = xml[xml.index("<sheetData>") : xml.index("</sheetData>")]
    used_below = set()
    for m in re.finditer(r'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', sheet_data, re.S):
        if int(m.group(1)) > KEEP_ROWS:
            for v in re.findall(r't="s"[^>]*><v>(\d+)</v>', m.group(2) or ""):
                used_below.add(sst[int(v)])
    kept = set()
    for m in re.finditer(r'<row r="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', sheet_data, re.S):
        if int(m.group(1)) <= KEEP_ROWS:
            for v in re.findall(r't="s"[^>]*><v>(\d+)</v>', m.group(2) or ""):
                kept.add(sst[int(v)])
    sample_names = sorted(w for w in used_below - kept if len(w) >= 3 and not re.fullmatch(r"[\x00-\x7f]+", w))

    out_parts: dict[str, bytes] = {}
    for name, data in parts.items():
        if name in DROP_PARTS:
            continue
        text = None
        if name == SHEET:
            text = build_sheet(data.decode("utf-8"), sst)
        elif name == "xl/workbook.xml":
            text = build_workbook(data.decode("utf-8"))
        elif name == "xl/_rels/workbook.xml.rels":
            text = build_rels(data.decode("utf-8"))
        elif name == "[Content_Types].xml":
            text = build_content_types(data.decode("utf-8"))
        elif name == "docProps/app.xml":
            text = build_app(data.decode("utf-8"))
        elif name == "docProps/core.xml":
            text = build_core(data.decode("utf-8"))
        out_parts[name] = text.encode("utf-8") if text is not None else data

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in out_parts.items():
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)
    check(args.out, sample_names)
    print(f"作成しました: {args.out.relative_to(ROOT)} ({args.out.stat().st_size} バイト)")


if __name__ == "__main__":
    main()
