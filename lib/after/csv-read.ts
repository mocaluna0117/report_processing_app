// CSV / TSV の読み取り (顧客データの取り込み用)。
// 業務システムからの書き出しは Shift_JIS のことがあるので、UTF-8 として不正なら CP932 で読み直す。

export interface DecodedCsv {
  text: string;
  encoding: "utf-8" | "shift_jis";
}

export function decodeCsvBytes(bytes: Uint8Array): DecodedCsv {
  // UTF-8 BOM は取り除く (先頭列のヘッダー名が一致しなくなるため)
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    // 不正なバイト列 = UTF-8 ではない。日本語の業務データはほぼ Shift_JIS (CP932)
    return { text: new TextDecoder("shift_jis").decode(body), encoding: "shift_jis" };
  }
}

/** 1行目の区切り文字を推定する (タブ区切りで書き出されることがある) */
export function detectDelimiter(text: string): "," | "\t" {
  const firstLine = text.slice(0, text.search(/\r?\n/) === -1 ? text.length : text.search(/\r?\n/));
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/** RFC4180 準拠の解析 (引用符内の区切り・改行、"" のエスケープ、CR/LF/CRLF) */
export function parseCsv(text: string, delimiter: "," | "\t" = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let hadContent = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    hadContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      hadContent = true;
    } else if (ch === delimiter) {
      endField();
      hadContent = true;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
      hadContent = true;
    }
  }
  // 末尾に改行が無い場合の最終行 (末尾改行だけの空行は落とす)
  if (field !== "" || row.length > 0 || hadContent) endRow();
  return rows;
}
