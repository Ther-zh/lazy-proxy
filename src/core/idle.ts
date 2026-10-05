/** 空闲追踪：连接计数 + 空闲定时器。计数归零后触发 onIdle。 */
export class IdleTracker {
  private connections = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly idleMs: number,
    private readonly onIdle: () => void | Promise<void>,
  ) {}

  /** 新请求到来：清定时器 */
  increment(): void {
    this.connections++;
    this.clearTimer();
  }

  /** 请求结束：归零则排空闲定时器 */
  decrement(): void {
    if (this.connections > 0) this.connections--;
    if (this.connections === 0) this.schedule();
  }

  get active(): number {
    return this.connections;
  }

  dispose(): void {
    this.clearTimer();
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.onIdle();
    }, this.idleMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
