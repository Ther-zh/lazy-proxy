import { describe, expect, it } from "vitest";
import { IdleTracker } from "../../src/core/idle";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("IdleTracker", () => {
  it("tracks active connections", () => {
    const t = new IdleTracker(1000, () => {});
    expect(t.active).toBe(0);
    t.increment();
    t.increment();
    expect(t.active).toBe(2);
    t.decrement();
    expect(t.active).toBe(1);
    t.dispose();
  });

  it("fires onIdle after idle window when connections hit zero", async () => {
    let fired = 0;
    const t = new IdleTracker(30, () => {
      fired++;
    });
    t.increment();
    t.decrement();
    expect(fired).toBe(0);
    await sleep(80);
    expect(fired).toBe(1);
    t.dispose();
  });

  it("increment during idle window cancels the timer", async () => {
    let fired = 0;
    const t = new IdleTracker(30, () => {
      fired++;
    });
    t.increment();
    t.decrement();
    await sleep(15);
    t.increment(); // cancels pending timer
    await sleep(15);
    t.decrement(); // restarts window
    await sleep(15);
    expect(fired).toBe(0);
    await sleep(50);
    expect(fired).toBe(1);
    t.dispose();
  });

  it("decrement below zero is harmless", () => {
    const t = new IdleTracker(1000, () => {});
    t.decrement();
    expect(t.active).toBe(0);
    t.dispose();
  });
});
