import { describe, expect, it } from "vitest";
import {
  extFromContentType,
  extOf,
  fixExtension,
  isMedia,
  looksLikeHtml,
  sniffExtension,
  withExt,
} from "@/lib/rakuraku/parse/sniff";

const bytes = (...xs: number[]) => new Uint8Array(xs);
const text = (s: string) => new TextEncoder().encode(s);

describe("中身から形式を見分ける", () => {
  it("PDF・JPEG・PNG", () => {
    expect(sniffExtension(text("%PDF-1.7\n"))).toBe(".pdf");
    expect(sniffExtension(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0))).toBe(".jpg");
    expect(sniffExtension(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(".png");
  });

  it("動画（拡張子が落ちても「飛ばす」判断ができるように）", () => {
    expect(sniffExtension(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32))).toBe(".mp4");
    expect(sniffExtension(text("RIFF\0\0\0\0AVI LIST"))).toBe(".avi");
    expect(sniffExtension(bytes(0x1a, 0x45, 0xdf, 0xa3, 0))).toBe(".mkv");
  });

  it("★判定できないものは null（推測しない）", () => {
    expect(sniffExtension(text("PK\x03\x04docx"))).toBeNull(); // Office は中身を見ない
    expect(sniffExtension(text("<html>"))).toBeNull();
    expect(sniffExtension(new Uint8Array())).toBeNull();
  });

  it("短すぎる中身でも落ちない", () => {
    expect(sniffExtension(bytes(0x25))).toBeNull();
    expect(sniffExtension(bytes(0, 0, 0, 0, 0x66))).toBeNull();
  });
});

describe("拡張子を実体に合わせる", () => {
  it("★PDFでないものに .pdf が付いていたら直す", () => {
    expect(fixExtension("本体.pdf", bytes(0xff, 0xd8, 0xff))).toBe("本体.jpg");
  });
  it("拡張子が無ければ足す", () => {
    expect(fixExtension("print", text("%PDF-1.4"))).toBe("print.pdf");
  });
  it("合っていればそのまま", () => {
    expect(fixExtension("写真.PNG", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("写真.PNG");
  });
  it(".jpeg は .jpg に書き換えない", () => {
    expect(fixExtension("写真.jpeg", bytes(0xff, 0xd8, 0xff))).toBe("写真.jpeg");
  });
  it("★判定できなければ名前を触らない（HTMLのエラーページは .pdf のまま残り、結合で明示的に止まる）", () => {
    expect(fixExtension("本体.pdf", text("<!DOCTYPE html>"))).toBe("本体.pdf");
  });
});

describe("HTMLに見えるか", () => {
  it("ログイン画面が保存されたものを見分ける", () => {
    expect(looksLikeHtml(text("<!DOCTYPE html><html>"))).toBe(true);
    expect(looksLikeHtml(text("\n\n  <HTML lang=ja>"))).toBe(true);
  });
  it("PDFはHTMLではない", () => {
    expect(looksLikeHtml(text("%PDF-1.7"))).toBe(false);
  });
  it("先頭200バイトより後ろは見ない", () => {
    expect(looksLikeHtml(text(`${"x".repeat(300)}<html>`))).toBe(false);
  });
});

describe("拡張子の扱い", () => {
  it("小文字・ドット付き", () => {
    expect(extOf("見積総覧（架空邸）.PDF")).toBe(".pdf");
    expect(extOf("archive.tar.gz")).toBe(".gz");
  });
  it("無ければ空文字。ドットで始まるだけの名前も拡張子なし", () => {
    expect(extOf("print")).toBe("");
    expect(extOf(".hidden")).toBe("");
  });
  it("付け替え・追加", () => {
    expect(withExt("a.bin", ".pdf")).toBe("a.pdf");
    expect(withExt("a", ".pdf")).toBe("a.pdf");
  });
  it("Content-Type から引く（charset は無視・pdf を含めば .pdf）", () => {
    expect(extFromContentType("application/pdf; charset=binary")).toBe(".pdf");
    expect(extFromContentType("image/JPEG")).toBe(".jpg");
    expect(extFromContentType("application/x-weird-pdf")).toBe(".pdf");
    expect(extFromContentType("application/octet-stream")).toBeNull();
    expect(extFromContentType(null)).toBeNull();
  });
  it("動画・音声は飛ばす対象", () => {
    expect(isMedia("現場.MOV")).toBe(true);
    expect(isMedia("録音.flac")).toBe(true);
    expect(isMedia("見積.pdf")).toBe(false);
  });
});
