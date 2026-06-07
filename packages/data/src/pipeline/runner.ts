export type StageCtx = {
  stagingDir: string;
  outputDir: string;
  log: (msg: string) => void;
  /** Optional cancellation signal — long-running stages should pass this
   *  to fetch/spawn so SIGTERM during a multi-hour build aborts cleanly. */
  signal?: AbortSignal;
};

export type Stage = {
  id: string;
  isDone: (ctx: StageCtx) => Promise<boolean>;
  run: (ctx: StageCtx) => Promise<void>;
};

/**
 * Run stages sequentially. A stage is skipped when its `isDone(ctx)` returns
 * true. Errors abort the whole run.
 */
export const runStages = async (stages: Stage[], ctx: StageCtx): Promise<void> => {
  for (const stage of stages) {
    const done = await stage.isDone(ctx);
    if (done) {
      ctx.log(`[${stage.id}] skip — already done`);
      continue;
    }
    ctx.log(`[${stage.id}] start`);
    const t0 = Date.now();
    await stage.run(ctx);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    ctx.log(`[${stage.id}] done in ${seconds}s`);
  }
};
