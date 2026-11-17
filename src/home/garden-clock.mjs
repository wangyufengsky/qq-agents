// @ts-check
/** The owning runtime supplies only accepted desktop connection observations. */
export class GardenClock {
  /** @param {number} elapsed @param {number} speed */
  constructor(elapsed, speed) {
    this.elapsed = elapsed;
    this.speed = speed;
    /** @type {{at: number, lease: number} | null} */
    this.last = null;
  }

  /** @param {number} now */
  running(now) {
    return (
      this.last !== null &&
      now >= this.last.at &&
      now - this.last.at < this.last.lease
    );
  }

  /** @param {number} now @param {number} lease */
  observe(now, lease) {
    if (this.last && now < this.last.at) return;
    this.advance(now);
    this.last = { at: now, lease };
  }

  /** @param {number} now */
  elapsedAt(now) {
    return this.last && this.running(now)
      ? this.elapsed + (now - this.last.at) * this.speed
      : this.elapsed;
  }

  /** @param {number} now */
  advance(now) {
    if (this.last && this.running(now)) {
      this.elapsed = this.elapsedAt(now);
      this.last.at = now;
    }
  }

  /** @param {number} now */
  stop(now) {
    this.advance(now);
    this.last = null;
  }
}
