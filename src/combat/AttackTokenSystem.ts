/**
 * Manages the global attack token system for flying enemies.
 * Only [2] flyers can actively wind up or attack at the same millisecond.
 */
export class AttackTokenSystem {
  private static instance: AttackTokenSystem;
  private windupOrAttackCount = 0;
  private readonly maxTokens = 2;

  private constructor() {}

  public static getInstance(): AttackTokenSystem {
    if (!AttackTokenSystem.instance) {
      AttackTokenSystem.instance = new AttackTokenSystem();
    }
    return AttackTokenSystem.instance;
  }

  /**
   * Request a token for winding up or attacking.
   * @returns true if token granted, false if max tokens reached
   */
  public requestToken(): boolean {
    if (this.windupOrAttackCount < this.maxTokens) {
      this.windupOrAttackCount++;
      return true;
    }
    return false;
  }

  /**
   * Release a token when winding up or attacking ends.
   */
  public releaseToken(): void {
    if (this.windupOrAttackCount > 0) {
      this.windupOrAttackCount--;
    }
  }

  /**
   * Get the current number of tokens in use.
   */
  public getTokenCount(): number {
    return this.windupOrAttackCount;
  }

  /**
   * Reset the system (e.g., on level restart)
   */
  public reset(): void {
    this.windupOrAttackCount = 0;
  }
}

export default AttackTokenSystem.getInstance();