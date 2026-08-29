#!/usr/bin/env python3
"""完了報告書テンプレート (xlsx) を配布用に加工する開発用スクリプト。

  python3 scripts/build_report_template.py [--src <原紙.xlsx>] [--out public/report/completion-report.xlsx]

やること:
  1. 非表示の2シート (点検予定履歴出力・3ヶ月点検チェックシート) とその付随パーツを削除し、
     「入力シート」「作業報告書　兼　完了報告書」「別紙」の3シート構成にする
  2. 個人情報 (作成者名・絶対パス・sheet2の例示データ) を除去する
  3. パッケージの参照整合と個人情報の不在を検査する

元ファイル (完了報告書_例/) は個人情報を含むためリポジトリにコミットしない。
出力だけをコミットする。テンプレを差し替えたらこのスクリプトを再実行する。
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "完了報告書_例" / "完了報告書（原紙）.xlsx"
DEFAULT_OUT = ROOT / "public" / "report" / "completion-report.xlsx"

# 削除するパーツ (点検予定履歴出力=sheet2、3ヶ月点検チェックシート=sheet5 とその図・画像・印刷設定)
DROP_PARTS = {
    "xl/worksheets/sheet2.xml",
    "xl/worksheets/sheet5.xml",
    "xl/worksheets/_rels/sheet5.xml.rels",
    "xl/drawings/drawing1.xml",
    "xl/drawings/_rels/drawing1.xml.rels",
    "xl/media/image1.jpg",
    "xl/printerSettings/printerSettings4.bin",  # sheet5 用
    "xl/calcChain.xml",  # 削除シートの数式を含む。無ければExcelが開くときに作り直す
    # SharePoint の管理情報 (ドキュメントライブラリの種類ID等)。報告書の様式には不要
    "customXml/item1.xml",
    "customXml/item2.xml",
    "customXml/item3.xml",
    "customXml/itemProps1.xml",
    "customXml/itemProps2.xml",
    "customXml/itemProps3.xml",
    "customXml/_rels/item1.xml.rels",
    "customXml/_rels/item2.xml.rels",
    "customXml/_rels/item3.xml.rels",
    "docProps/custom.xml",  # SharePoint のコンテンツタイプID だけが入っている
}
# 削除する rels の Id (rId2=sheet2, rId5=sheet5, rId10=calcChain, rId11〜13=customXml)
DROP_RELS = {"rId2", "rId5", "rId10", "rId11", "rId12", "rId13"}
# 空文字にする sharedStrings の index (sheet2 の例示データ: 社員名・日付・指摘文・契約番号)
BLANK_SI = [110, 111, 112, 113, 114]

# 出荷物に残ってはいけないもの。実名をこのファイルに書かないよう、
# 「特定の欄が空か」「長い数字列が無いか」という形で検査する
FORBIDDEN_TEXT_PATTERNS = [
    r"absPath",  # 作成者の個人フォルダパス
]
# 様式に元から入っている自社の連絡先 (個人情報ではない)。検査から除く
ALLOWED_TEXTS = ["03-6271-6209", "03-6271-6219"]
# 要素の中身 (セルの文字列など) に出てはいけないもの。属性値 (座標・GUID・余白の小数) は見ない
FORBIDDEN_CONTENT_PATTERNS = [
    r"\d{9,}",  # 契約番号などの長い数字列
    r"\d{2,4}-\d{2,4}-\d{3,4}",  # 電話番号
]
# 原紙にもともと入っている定型の値 (個人情報ではない)
FORM_DEFAULTS = {"①"}
# 空でなければならない要素 (作成者・最終更新者)
EMPTY_ELEMENTS = ["dc:creator", "cp:lastModifiedBy"]

# 残るシートの並び (0始まり) → definedName の localSheetId 付け替え
LOCAL_SHEET_ID_MAP = {"2": "1", "3": "2"}


class BuildError(RuntimeError):
    pass


def once(pattern: str, text: str, what: str) -> None:
    n = len(re.findall(pattern, text))
    if n != 1:
        raise BuildError(f"{what}: 期待1件だが{n}件見つかった (テンプレの構造が変わった?)")


def patch_workbook(xml: str) -> str:
    # 削除シートの <sheet> を除く
    for name in ("点検予定履歴出力", "3ヶ月点検チェックシート"):
        pat = r'<sheet name="' + re.escape(name) + r'"[^>]*/>'
        once(pat, xml, f"workbook.xml の <sheet {name}>")
        xml = re.sub(pat, "", xml)
    # 3ヶ月点検チェックシートの印刷範囲を削除
    pat = r'<definedName name="_xlnm\.Print_Area" localSheetId="4">[^<]*</definedName>'
    once(pat, xml, "workbook.xml の 3ヶ月点検チェックシート Print_Area")
    xml = re.sub(pat, "", xml)
    # 残った印刷範囲の localSheetId を新しい並び順に付け替える
    def renumber(m: re.Match[str]) -> str:
        old = m.group(1)
        new = LOCAL_SHEET_ID_MAP.get(old)
        if new is None:
            raise BuildError(f"想定外の localSheetId={old}")
        return f'localSheetId="{new}"'

    xml = re.sub(r'localSheetId="(\d+)"', renumber, xml)
    # 選択タブ (作業報告書) の位置を新しい並びに合わせる
    once(r'activeTab="2"', xml, "workbook.xml の activeTab")
    xml = xml.replace('activeTab="2"', 'activeTab="1"')
    # 作成者の個人フォルダパスを含む absPath を削除
    pat = r"<mc:AlternateContent[^>]*>.*?</mc:AlternateContent>"
    once(pat, xml, "workbook.xml の absPath ブロック")
    xml = re.sub(pat, "", xml, flags=re.DOTALL)
    if "absPath" in xml:
        raise BuildError("absPath が残っている")
    return xml


def patch_workbook_rels(xml: str) -> str:
    for rid in sorted(DROP_RELS):
        pat = r'<Relationship Id="' + rid + r'"[^>]*/>'
        once(pat, xml, f"workbook.xml.rels の {rid}")
        xml = re.sub(pat, "", xml)
    return xml


def patch_content_types(xml: str) -> str:
    for part in ("/xl/worksheets/sheet2.xml", "/xl/worksheets/sheet5.xml",
                 "/xl/drawings/drawing1.xml", "/xl/calcChain.xml",
                 "/customXml/itemProps1.xml", "/customXml/itemProps2.xml",
                 "/customXml/itemProps3.xml", "/docProps/custom.xml"):
        pat = r'<Override PartName="' + re.escape(part) + r'"[^>]*/>'
        once(pat, xml, f"[Content_Types].xml の {part}")
        xml = re.sub(pat, "", xml)
    # 画像が無くなるので既定の jpg も落とす
    pat = r'<Default Extension="jpg"[^>]*/>'
    once(pat, xml, "[Content_Types].xml の jpg Default")
    xml = re.sub(pat, "", xml)
    return xml


def patch_app(xml: str) -> str:
    # HeadingPairs: ワークシート 5→3、名前付き一覧 3→2
    for label, before, after in (("ワークシート", "5", "3"), ("名前付き一覧", "3", "2")):
        pat = (
            r"(<vt:lpstr>" + re.escape(label) + r"</vt:lpstr></vt:variant><vt:variant><vt:i4>)"
            + before
            + r"(</vt:i4>)"
        )
        once(pat, xml, f"app.xml の {label} 件数")
        xml = re.sub(pat, r"\g<1>" + after + r"\g<2>", xml)
    # TitlesOfParts: 削除したシート名とその印刷範囲を除く
    for name in ("点検予定履歴出力", "3ヶ月点検チェックシート", "'3ヶ月点検チェックシート'!Print_Area"):
        pat = r"<vt:lpstr>" + re.escape(name) + r"</vt:lpstr>"
        once(pat, xml, f"app.xml の {name}")
        xml = re.sub(pat, "", xml)
    once(r'<vt:vector size="8" baseType="lpstr">', xml, "app.xml の TitlesOfParts size")
    xml = xml.replace('<vt:vector size="8" baseType="lpstr">', '<vt:vector size="5" baseType="lpstr">')
    return xml


def patch_core(xml: str) -> str:
    xml = re.sub(r"<dc:creator>[^<]*</dc:creator>", "<dc:creator></dc:creator>", xml)
    xml = re.sub(r"<cp:lastModifiedBy>[^<]*</cp:lastModifiedBy>", "<cp:lastModifiedBy></cp:lastModifiedBy>", xml)
    xml = re.sub(r"<cp:lastPrinted>[^<]*</cp:lastPrinted>", "", xml)
    return xml


def patch_shared_strings(xml: str) -> str:
    items = re.findall(r"<si>.*?</si>", xml, flags=re.DOTALL)
    if not items:
        raise BuildError("sharedStrings.xml に <si> が無い")
    for i in BLANK_SI:
        if i >= len(items):
            raise BuildError(f"sharedStrings.xml に index {i} が無い (件数 {len(items)})")
        # index を変えないので削除ではなく空文字化する
        xml = xml.replace(items[i], "<si><t/></si>", 1)
    return xml


def patch_package_rels(xml: str) -> str:
    pat = r'<Relationship Id="rId4"[^>]*docProps/custom\.xml"/>'
    once(pat, xml, "_rels/.rels の docProps/custom.xml")
    return re.sub(pat, "", xml)


PATCHERS = {
    "_rels/.rels": patch_package_rels,
    "xl/workbook.xml": patch_workbook,
    "xl/_rels/workbook.xml.rels": patch_workbook_rels,
    "[Content_Types].xml": patch_content_types,
    "docProps/app.xml": patch_app,
    "docProps/core.xml": patch_core,
    "xl/sharedStrings.xml": patch_shared_strings,
}


def verify(path: Path) -> None:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        text = {n: z.read(n).decode("utf-8") for n in names if n.endswith((".xml", ".rels"))}

        # 1. シート構成
        wb = text["xl/workbook.xml"]
        sheets = re.findall(r'<sheet name="([^"]*)"[^>]*r:id="([^"]*)"', wb)
        expected = ["入力シート", "作業報告書　兼　完了報告書", "別紙"]
        if [s[0] for s in sheets] != expected:
            raise BuildError(f"シート構成が想定と違う: {[s[0] for s in sheets]}")
        if 'state="hidden"' in wb:
            raise BuildError("非表示シートが残っている")

        # 2. workbook の r:id が rels にある / rels の Target が存在する
        rels = text["xl/_rels/workbook.xml.rels"]
        rel_map = dict(re.findall(r'<Relationship Id="([^"]*)"[^>]*Target="([^"]*)"', rels))
        for name, rid in sheets:
            if rid not in rel_map:
                raise BuildError(f"シート {name} の {rid} が rels に無い")
        for rels_name, rels_xml in text.items():
            if not rels_name.endswith(".rels"):
                continue
            base = "" if rels_name == "_rels/.rels" else rels_name.rsplit("/_rels/", 1)[0]
            for target in re.findall(r'Target="([^"]*)"', rels_xml):
                if target.startswith(("http://", "https://", "/")):
                    continue
                parts: list[str] = []
                for seg in f"{base}/{target}".split("/"):
                    if seg in ("", "."):
                        continue
                    if seg == "..":
                        if parts:
                            parts.pop()
                    else:
                        parts.append(seg)
                resolved = "/".join(parts)
                if resolved not in names:
                    raise BuildError(f"{rels_name} が存在しないパーツを参照: {resolved}")

        # 3. Content_Types の Override が実在する / 拡張子の既定がある
        ct = text["[Content_Types].xml"]
        for part in re.findall(r'<Override PartName="/([^"]*)"', ct):
            if part not in names:
                raise BuildError(f"[Content_Types].xml が存在しないパーツを指している: {part}")
        defaults = set(re.findall(r'<Default Extension="([^"]*)"', ct))
        for n in names:
            ext = n.rsplit(".", 1)[-1].lower()
            if f"/{n}" not in ct and ext not in defaults:
                raise BuildError(f"{n} の ContentType が決まらない (Override も Default も無い)")

        # 4. 印刷範囲が本紙・別紙に残っている
        dn = dict(
            (m[1], m[0])
            for m in re.findall(r'<definedName name="_xlnm\.Print_Area" localSheetId="(\d+)">([^<]*)</definedName>', wb)
        )
        if set(dn.values()) != {"1", "2"}:
            raise BuildError(f"Print_Area の localSheetId が想定と違う: {dn}")

        # 5. 個人情報 (作成者名・絶対パス・例示データ)
        core = text["docProps/core.xml"]
        for element in EMPTY_ELEMENTS:
            m = re.search(rf"<{element}>([^<]*)</{element}>", core)
            if m is None or m.group(1).strip():
                raise BuildError(f"{element} が空になっていない")
        if "lastPrinted" in core:
            raise BuildError("lastPrinted が残っている")
        for name, xml in text.items():
            for pattern in FORBIDDEN_TEXT_PATTERNS:
                if re.search(pattern, xml):
                    raise BuildError(f"{name} に残してはいけない文字列がある ({pattern})")
            content = " ".join(re.findall(r">([^<]+)<", xml))
            for allowed in ALLOWED_TEXTS:
                content = content.replace(allowed, "")
            for pattern in FORBIDDEN_CONTENT_PATTERNS:
                hit = re.search(pattern, content)
                if hit:
                    raise BuildError(f"{name} の中身に値が残っている ({pattern}: {hit.group(0)})")
        shared = text["xl/sharedStrings.xml"]
        items = re.findall(r"<si>.*?</si>", shared, flags=re.DOTALL)
        for i in BLANK_SI:
            if items[i] != "<si><t/></si>":
                raise BuildError(f"sharedStrings の {i} 番が空になっていない")

        # 6. 入力欄に前のデータが残っていない (氏名など、数字を含まない個人情報の検出)
        s1 = text["xl/worksheets/sheet1.xml"]
        shared_texts = [re.sub(r"<[^>]+>", "", si) for si in items]
        for ref in ["C4", "C5", "C6", "C7", "C8", "C9", "C10", "C12", "C13"] + [
            f"{col}{row}" for row in range(17, 22) for col in ("B", "C")
        ]:
            cell = re.search(rf'<c r="{ref}"[^>]*?(?:/>|>.*?</c>)', s1, re.DOTALL)
            if cell is None:
                raise BuildError(f"入力シートに {ref} が無い")
            body = cell.group(0)
            value = ""
            if 't="s"' in body:
                index = re.search(r"<v>(\d+)</v>", body)
                if index:
                    value = shared_texts[int(index.group(1))]
            else:
                inline = re.search(r"<t[^>]*>([^<]*)</t>", body) or re.search(r"<v>([^<]*)</v>", body)
                value = inline.group(1) if inline else ""
            if value.strip() and value.strip() not in FORM_DEFAULTS:
                raise BuildError(f"入力シートの {ref} に値が残っている (原紙は空でなければならない)")

        # 7. 入力欄・チェックボックス・別紙の枠が生きている
        for ref in ("C4", "C5", "C6", "C7", "C8", "C9", "C10", "C12", "C13", "B17", "C17", "B21", "C21"):
            if f'<c r="{ref}"' not in s1:
                raise BuildError(f"入力シートに {ref} が無い")
        s3 = text["xl/worksheets/sheet3.xml"]
        for ref in ("D5", "O5", "D6", "D7", "D8", "D9", "O9", "D13", "M13", "B16", "C16", "B20", "C20", "B23", "B27"):
            if f'<c r="{ref}"' not in s3:
                raise BuildError(f"本紙に {ref} が無い")
        for ref in ("D11", "G11", "K11", "D12", "G12", "K12", "N12", "Q12"):
            if not re.search(r'<c r="' + ref + r'"[^>]*t="b"', s3):
                raise BuildError(f"本紙のチェックボックス {ref} が真偽値セルでない")
        s4 = text["xl/worksheets/sheet4.xml"]
        for ref in ["A1", "A2", "A3", "A4", "A5", "B5"] + [f"A{6 + 2 * k}" for k in range(12)]:
            if f'<c r="{ref}"' not in s4:
                raise BuildError(f"別紙に {ref} が無い")


def build(src: Path, out: Path) -> None:
    if not src.exists():
        raise BuildError(f"元テンプレートが見つからない: {src}")
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    seen: set[str] = set()
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename in DROP_PARTS:
                seen.add(info.filename)
                continue
            data = zin.read(info.filename)
            patcher = PATCHERS.get(info.filename)
            if patcher is not None:
                seen.add(info.filename)
                data = patcher(data.decode("utf-8")).encode("utf-8")
            # 圧縮方法・タイムスタンプは固定して差分を安定させる
            zi = zipfile.ZipInfo(info.filename, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_STORED if info.filename.endswith(".bin") else zipfile.ZIP_DEFLATED
            zi.external_attr = info.external_attr
            zout.writestr(zi, data)
    missing = (DROP_PARTS | set(PATCHERS)) - seen
    if missing:
        tmp.unlink(missing_ok=True)
        raise BuildError(f"元テンプレートに無いパーツがある: {sorted(missing)}")
    verify(tmp)
    shutil.move(str(tmp), str(out))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()
    try:
        build(args.src, args.out)
    except BuildError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    size = args.out.stat().st_size
    with zipfile.ZipFile(args.out) as z:
        parts = len(z.namelist())
    print(f"生成しました: {args.out} ({size / 1024:.1f} KB, {parts} パーツ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
