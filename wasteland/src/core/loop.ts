/**
 * Fixed-timestep game loop with interpolated rendering.
 *
 * Simulation runs at a constant rate so physics and AI stay deterministic and
 * frame-rate independent; rendering happens once per animation frame.
 */
export class GameLoop {
  readonly step: number;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private readonly maxSubSteps: number;

  /** Smoothed frames-per-second, for the debug overlay. */
  fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(
    private update: (dt: number) => void,
    private render: (alpha: number) => void,
    tickRate = 60,
    maxSubSteps = 5,
  ) {
    this.step = 1 / tickRate;
    this.maxSubSteps = maxSubSteps;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    // Clamp large gaps (tab was backgrounded) so we don't simulate minutes at once.
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameTime > 0.25) frameTime = 0.25;

    this.fpsAccum += frameTime;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    this.accumulator += frameTime;
    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSubSteps) {
      this.update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    // Bail out of a death spiral rather than falling further behind.
    if (steps === this.maxSubSteps) this.accumulator = 0;

    this.render(this.accumulator / this.step);
  };
}
