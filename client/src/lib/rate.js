/**
 * Sliding-window throughput meter. Instantaneous byte deltas are jumpy; this
 * averages over a short trailing window so the speed and ETA readouts in the UI
 * stay readable instead of flickering.
 */
export class RateMeter {
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
    /** @type {{ t: number, bytes: number }[]} */
    this.samples = [];
    this.totalBytes = 0;
  }

  /** Record cumulative bytes transferred so far. */
  update(cumulativeBytes) {
    const now = performance.now();
    this.totalBytes = cumulativeBytes;
    this.samples.push({ t: now, bytes: cumulativeBytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  /** Bytes per second across the current window. */
  get bytesPerSecond() {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }

  /** Estimated milliseconds to move `remainingBytes` at the current rate. */
  etaMs(remainingBytes) {
    const rate = this.bytesPerSecond;
    if (rate <= 0) return Infinity;
    return (remainingBytes / rate) * 1000;
  }

  reset() {
    this.samples = [];
    this.totalBytes = 0;
  }
}
