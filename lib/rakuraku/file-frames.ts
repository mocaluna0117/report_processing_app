import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { FILE_CHUNK_BYTES, type FileRole, type RakurakuEvent } from "./protocol";

/**
 * ファイルを `file.begin` → `file.chunk`… → `file.end` の行に分けて送る。
 * 受け取る側は `protocol.ts` の FileAssembler。
 *
 * ★1かたまりずつ送り、送り終わるのを待ってから次を送る（相手が読むより速く溜め込まない）。
 * ★中身は Vercel のログには出さない（送るだけ）。
 */
export interface OutgoingFile {
  role: FileRole;
  index: number;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export async function sendFile(send: (event: RakurakuEvent) => Promise<void>, file: OutgoingFile): Promise<void> {
  const id = randomUUID();
  const bytes = Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  await send({ type: "file.begin", id, role: file.role, index: file.index, name: file.name, ext: file.ext, bytes: bytes.length });
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
    await send({ type: "file.chunk", id, seq, data: bytes.subarray(offset, offset + FILE_CHUNK_BYTES).toString("base64") });
    seq += 1;
  }
  await send({ type: "file.end", id, chunks: seq, sha256: createHash("sha256").update(bytes).digest("hex") });
}
