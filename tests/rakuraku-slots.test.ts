import { describe, expect, it } from "vitest";
import { SlotTimeoutError, createSlots } from "@/lib/rakuraku/slots";

describe("ブラウザの順番待ち", () => {
  it("上限までは待たずに使える", async () => {
    const slots = createSlots(2);
    await slots.acquire(10);
    await slots.acquire(10);
    expect(slots.inUse).toBe(2);
  });

  it("★上限を超えた分は、空いたら順番に使える", async () => {
    const slots = createSlots(1);
    const releaseA = await slots.acquire(1_000);
    const order: string[] = [];
    const b = slots.acquire(1_000).then((release) => {
      order.push("B");
      return release;
    });
    const c = slots.acquire(1_000).then((release) => {
      order.push("C");
      return release;
    });
    expect(slots.waiting).toBe(2);
    releaseA();
    (await b)();
    (await c)();
    expect(order).toEqual(["B", "C"]);
    expect(slots.inUse).toBe(0);
  });

  it("★待っても空かなければ、待つのをやめて失敗にする（列からも外れる）", async () => {
    const slots = createSlots(1);
    const release = await slots.acquire(10);
    await expect(slots.acquire(30)).rejects.toBeInstanceOf(SlotTimeoutError);
    expect(slots.waiting).toBe(0);
    release();
    expect(slots.inUse).toBe(0);
    await slots.acquire(10); // また使える
  });

  it("★返すのを2回呼んでも、1回分しか返さない（数がずれない）", async () => {
    const slots = createSlots(1);
    const release = await slots.acquire(10);
    release();
    release();
    expect(slots.inUse).toBe(0);
    await slots.acquire(10);
    expect(slots.inUse).toBe(1);
  });
});
