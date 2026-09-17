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

  private readonly canvas: HTMLCanvasElement;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      // Let the browser keep its own shortcuts when a modifier is down.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Tab' || e.code === 'F5' || e.code === 'F9') e.preventDefault();
      if (this.held.has(e.code)) return;
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
      if (!this.buttons.has(e.button)) this.buttonsPressed.add(e.button);
      this.buttons.add(e.button);
    });

    window.addEventListener('mouseup', (e) => {
      if (this.buttons.has(e.button)) this.buttonsReleased.add(e.button);
      this.buttons.delete(e.button);
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheelDelta += e.deltaY;
    }, { passive: false });

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
  }
}
