// @ts-check
export class GardenClock {
  /** @param {number} elapsed @param {number} speed */
  constructor(elapsed, speed) {
    this.elapsed = elapsed;
    this.speed = speed;
    /** @type {number | null} */
    this.last = null;
  }

  /** @param {number} now */
  running(now) {
    return this.last !== null && now >= this.last;
  }

  /** @param {number} now */
  elapsedAt(now) {
    return this.last === null
      ? this.elapsed
      : this.elapsed + Math.max(0, now - this.last) * this.speed;
  }

  /** @param {number} now */
  advance(now) {
    if (this.running(now)) {
      this.elapsed = this.elapsedAt(now);
      this.last = now;
    }
  }

  /** @param {number} now @param {boolean} active */
  setRunning(now, active) {
    this.advance(now);
    if (!active) this.last = null;
    else if (this.last === null) this.last = now;
  }
}
