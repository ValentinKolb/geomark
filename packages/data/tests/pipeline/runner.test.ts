import { describe, test, expect } from "bun:test";
import { runStages, type Stage, type StageCtx } from "../../src/pipeline/runner";

const makeCtx = (): StageCtx & { logs: string[] } => {
  const logs: string[] = [];
  return {
    stagingDir: "/tmp/staging",
    outputDir: "/tmp/out",
    log: (msg) => logs.push(msg),
    logs,
  };
};

describe("runStages", () => {
  test("runs stages in order", async () => {
    const order: string[] = [];
    const stage = (id: string): Stage => ({
      id,
      isDone: async () => false,
      run: async () => {
        order.push(id);
      },
    });

    await runStages([stage("a"), stage("b"), stage("c")], makeCtx());
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("skips a stage when isDone() returns true", async () => {
    let aRan = false;
    let bRan = false;
    const stages: Stage[] = [
      { id: "a", isDone: async () => true, run: async () => { aRan = true; } },
      { id: "b", isDone: async () => false, run: async () => { bRan = true; } },
    ];

    const ctx = makeCtx();
    await runStages(stages, ctx);

    expect(aRan).toBe(false);
    expect(bRan).toBe(true);
    expect(ctx.logs.some((l) => l.includes("[a] skip"))).toBe(true);
    expect(ctx.logs.some((l) => l.includes("[b] start"))).toBe(true);
  });

  test("propagates errors from a stage and stops the run", async () => {
    const ran: string[] = [];
    const stages: Stage[] = [
      { id: "a", isDone: async () => false, run: async () => { ran.push("a"); } },
      {
        id: "b",
        isDone: async () => false,
        run: async () => {
          throw new Error("boom");
        },
      },
      { id: "c", isDone: async () => false, run: async () => { ran.push("c"); } },
    ];

    await expect(runStages(stages, makeCtx())).rejects.toThrow("boom");
    expect(ran).toEqual(["a"]); // c never ran
  });

  test("logs duration for each completed stage", async () => {
    const stages: Stage[] = [
      { id: "fast", isDone: async () => false, run: async () => {} },
    ];

    const ctx = makeCtx();
    await runStages(stages, ctx);

    expect(ctx.logs).toContain("[fast] start");
    expect(ctx.logs.some((l) => /\[fast\] done in [\d.]+s/.test(l))).toBe(true);
  });
});
