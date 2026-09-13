import { describe, expect, it } from "vitest";
import { sendFile } from "@/lib/rakuraku/file-frames";
import { FILE_CHUNK_BYTES, FileAssembler, type RakurakuEvent, type ReceivedFile, readNdjson } from "@/lib/rakuraku/protocol";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

function bytesOf(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) % 256;
  return out;
}

async function collect(file: { bytes: Uint8Array; ext?: string }): Promise<RakurakuEvent[]> {
  const events: RakurakuEvent[] = [];
  await sendFile(async (e) => void events.push(e), { role: "attachment", index: 2, name: "現場写真.jpg", ext: file.ext ?? ".png", bytes: file.bytes });
  return events;
}

async function assemble(events: RakurakuEvent[]): Promise<ReceivedFile[]> {
  const assembler = new FileAssembler();
  const files: ReceivedFile[] = [];
  for (const event of events) await assembler.accept(event, (f) => void files.push(f));
  expect(assembler.pending).toBe(0);
  return files;
}

describe("ファイルを行に分けて送り、受け取った側で組み立てる", () => {
  it("★大きなファイルは複数のかたまりに分かれ、組み立てると元に戻る", async () => {
    const bytes = bytesOf(FILE_CHUNK_BYTES * 2 + 123);
    const events = await collect({ bytes });
    expect(events.map((e) => e.type)).toEqual(["file.begin", "file.chunk", "file.chunk", "file.chunk", "file.end"]);
    const [file] = await assemble(events);
    expect(file).toMatchObject({ role: "attachment", index: 2, name: "現場写真.jpg", ext: ".png" });
    expect(file.bytes).toEqual(bytes);
  });

  it("空のファイルも送れる", async () => {
    const [file] = await assemble(await collect({ bytes: new Uint8Array(0) }));
    expect(file.bytes.length).toBe(0);
  });

  it("★行ごとの JSON の応答を通しても、日本語の名前と中身が壊れない", async () => {
    const bytes = bytesOf(FILE_CHUNK_BYTES + 5);
    const response = ndjsonResponse(
      new Request("http://localhost/api/rakuraku/fetch", { method: "POST" }),
      async (sink) => {
        await sendFile(sink.send, { role: "body", index: 0, name: "本体", ext: ".pdf", bytes });
      },
      { stage: "detail" },
    );
    const assembler = new FileAssembler();
    const files: ReceivedFile[] = [];
    const rest: RakurakuEvent[] = [];
    for await (const event of readNdjson(response.body!)) {
      if (!(await assembler.accept(event, (f) => void files.push(f)))) rest.push(event);
    }
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("本体");
    expect(files[0].bytes).toEqual(bytes);
    expect(rest.filter((e) => e.type !== "ping")).toEqual([{ type: "done" }]);
  });

  it("★途中のかたまりが抜けていたら受け取らない", async () => {
    const events = await collect({ bytes: bytesOf(FILE_CHUNK_BYTES * 2) });
    const broken = events.filter((e) => !(e.type === "file.chunk" && e.seq === 0));
    await expect(assemble(broken)).rejects.toThrow("一部が抜けています");
  });

  it("★最後のかたまりが抜けていたら（数が合わなければ）受け取らない", async () => {
    const events = await collect({ bytes: bytesOf(FILE_CHUNK_BYTES * 2) });
    const lastChunk = events.findLastIndex((e) => e.type === "file.chunk");
    await expect(assemble(events.filter((_, i) => i !== lastChunk))).rejects.toThrow("一部が抜けています");
  });

  it("★中身が書き換わっていたら受け取らない（sha256 が合わない）", async () => {
    const events = await collect({ bytes: bytesOf(1000) });
    const tampered = events.map((e) => {
      if (e.type !== "file.chunk") return e;
      const bytes = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
      bytes[10] ^= 0xff;
      return { ...e, data: btoa(String.fromCharCode(...bytes)) };
    });
    await expect(assemble(tampered)).rejects.toThrow("一致しません");
  });

  it("始まっていないファイルの続きや終わりは受け付けない", async () => {
    const events = await collect({ bytes: bytesOf(10) });
    await expect(assemble(events.slice(1))).rejects.toThrow("始まっていない");
  });

  it("ファイルでない行は触らずに返す", async () => {
    const assembler = new FileAssembler();
    expect(await assembler.accept({ type: "log", line: "x" }, () => undefined)).toBe(false);
  });

  it("★終わりが届かないまま応答が終わったら、組み上がっていないファイルが残ったと分かる", async () => {
    const events = await collect({ bytes: bytesOf(10) });
    const assembler = new FileAssembler();
    for (const event of events.slice(0, -1)) await assembler.accept(event, () => undefined);
    expect(assembler.pending).toBe(1);
  });
});
