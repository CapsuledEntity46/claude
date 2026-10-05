/**
 * Keyboard/mouse state with pointer-lock mouse look.
 *
 * Exposes both "is held" polling (for movement) and edge-triggered queries
 * (for one-shot actions), so the game loop never has to track previous state.
 */
export class Input {
  private held = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private releasedThisFrame = new Set<string>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;

  /** Mouse buttons: 0 = left, 1 = middle, 2 = right. */
  private buttons = new Set<number>();
  private buttonsPressed = new Set<number>();
  private buttonsReleased = new Set<number>();

  sensitivity = 0.0022;
  locked = false;

  /**
   * Set when something else has claimed this frame's mouse movement.
   *
   * Melee is driven by mouse gestures, and the same deltas would otherwise also turn
   * the camera — so every attack would spin the view. The combat system claims the
   * movement while a gesture is being captured and the player skips its look update.
   * Cleared every frame, so forgetting to re-enable it is impossible.
   */
  private lookClaimed = false;

  /** Raw event tallies, for diagnosing "did the click even arrive?". */
  readonly counters = { mouseDowns: 0, mouseUps: 0, keyDowns: 0 };

  private readonly canvas: HTMLCanvasElement;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      // Let the browser keep its own shortcuts when a modifier is down.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Tab' || e.code === 'F5' || e.code === 'F9') e.preventDefault();
      if (this.held.has(e.code)) return;
      this.counters.keyDowns++;
      this.held.add(e.code);
      this.pressedThisFrame.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      this.releasedThisFrame.add(e.code);
    });

    // Losing focus must clear held keys, or the player keeps sprinting forever.
    window.addEventListener('blur', () => {
      this.held.clear();
      this.buttons.clear();
    });

    // Note: deliberately not gated on pointer lock. Some embedded browsers deny
    // the lock request, and gating clicks here would make the game unplayable
    // rather than merely awkward. The Game decides whether input applies.
    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.counters.mouseDowns++;
      if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttons.add(e.button);
    });

    window.addEventListener('mouseup', (e) => {
      this.counters.mouseUps++;
      if (this.buttons.has(e.button)) this.buttonsReleased.add(e.button);
      this.buttons.delete(e.button);
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    /**
     * The wheel belongs to the hotbar while playing and to the page otherwise.
     *
     * This used to call `preventDefault` unconditionally on `window`, which is to
     * say it swallowed *every* scroll in the document — so the character sheet,
     * whose panels are taller than the viewport and scroll by design, could not be
     * scrolled with the wheel at all. Gating on the pointer lock is exactly the
     * right test: the lock is held while playing and released by every menu, so
     * the wheel cycles the hotbar in play and scrolls the DOM in the UI, with no
     * list of element ids to keep in step.
     */
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked) return;
        e.preventDefault();
        this.wheelDelta += e.deltaY;
      },
      { passive: false },
    );

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        this.held.clear();
        this.buttons.clear();
      }
    });
  }

  /**
   * Adds mouse movement as though the browser had reported it.
   *
   * Exists for the tests. Synthetic `mousemove` events under pointer lock report
   * movement deltas computed against the absolute cursor position rather than the
   * previous event — observed as cancelling pairs like (640, 360) then (-640, -360) —
   * so a gesture driven that way sums to nothing and never commits. Injecting here
   * enters the pipeline at exactly the point a real event would, leaving every line of
   * gesture accumulation, look suppression and attack resolution under test.
   */
  debugFeedMouseDelta(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  requestLock(): void {
    void this.canvas.requestPointerLock();
  }

  releaseLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Suspends mouse-look without dropping pointer lock (used by overlays). */
  setLookEnabled(on: boolean): void {
    this.enabled = on;
  }

  /**
   * Claims this frame's mouse movement for something other than looking around.
   *
   * Lasts one frame only. Must be called before the player consumes the deltas, which
   * it is: the combat system updates first.
   */
  claimLook(): void {
    this.lookClaimed = true;
  }

  get lookAvailable(): boolean {
    return !this.lookClaimed;
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.buttons.has(button);
  }

  mousePressed(button: number): boolean {
    return this.buttonsPressed.has(button);
  }

  mouseReleased(button: number): boolean {
    return this.buttonsReleased.has(button);
  }

  /** Digit keys 1-8 -> 0-7, or -1 when none were pressed this frame. */
  hotbarPressed(): number {
    for (let i = 1; i <= 8; i++) {
      if (this.pressedThisFrame.has(`Digit${i}`)) return i - 1;
    }
    return -1;
  }

  /** Clears per-frame edges and accumulated deltas. Call at the end of each frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.buttonsPressed.clear();
    this.buttonsReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.lookClaimed = false;
  }
}
