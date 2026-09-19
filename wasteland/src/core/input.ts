/**
 * Keyboard + mouse state tracker.
 *
 * Distinguishes "held" (continuous) from "pressed" (edge this frame). Call
 * `endFrame()` once per update to clear edge state.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  /** Mouse position in CSS pixels relative to the canvas. */
  mouseX = 0;
  mouseY = 0;
  wheel = 0;

  mouseHeld = [false, false, false];
  private mousePressed = [false, false, false];
  private mouseReleased = [false, false, false];

  /** Set while a text field or modal owns the keyboard. */
  textCaptured = false;

  private el: HTMLElement;
  private blurHandler = () => this.clear();

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.blurHandler);
    el.addEventListener('mousemove', this.onMouseMove);
    el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Keys the browser would otherwise hijack while playing.
    if (['Tab', 'Space', 'F1', 'F3'].includes(e.code) && !this.textCaptured) e.preventDefault();
    if (e.repeat) return;
    const code = e.code;
    this.held.add(code);
    this.pressed.add(code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.held.delete(e.code);
    this.released.add(e.code);
  };

  private onMouseMove = (e: MouseEvent) => {
    const r = this.el.getBoundingClientRect();
    this.mouseX = e.clientX - r.left;
    this.mouseY = e.clientY - r.top;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button > 2) return;
    e.preventDefault();
    this.mouseHeld[e.button] = true;
    this.mousePressed[e.button] = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    if (e.button > 2) return;
    this.mouseHeld[e.button] = false;
    this.mouseReleased[e.button] = true;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  down(code: string): boolean { return !this.textCaptured && this.held.has(code); }
  justPressed(code: string): boolean { return !this.textCaptured && this.pressed.has(code); }
  justReleased(code: string): boolean { return this.released.has(code); }

  anyDown(...codes: string[]): boolean { return codes.some((c) => this.down(c)); }

  mouseDown(button = 0): boolean { return this.mouseHeld[button]; }
  mouseJustPressed(button = 0): boolean { return this.mousePressed[button]; }
  mouseJustReleased(button = 0): boolean { return this.mouseReleased[button]; }

  /** Consume a key press so later handlers in the same frame don't also see it. */
  consume(code: string): void { this.pressed.delete(code); }

  /** Digit row 1..9 -> returns index (0-based) or -1. */
  digitPressed(): number {
    for (let i = 1; i <= 9; i++) if (this.justPressed('Digit' + i)) return i - 1;
    return -1;
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed[0] = this.mousePressed[1] = this.mousePressed[2] = false;
    this.mouseReleased[0] = this.mouseReleased[1] = this.mouseReleased[2] = false;
    this.wheel = 0;
  }

  clear(): void {
    this.held.clear();
    this.pressed.clear();
    this.mouseHeld = [false, false, false];
  }
}
