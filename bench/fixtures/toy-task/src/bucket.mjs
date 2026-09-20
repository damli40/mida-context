// Token bucket — steps 1–3 are done. Steps 4–5 were decided in the earlier
// session's brief and live only there.

export class TokenBucket {
  constructor(ratePerSecond, burst) {
    this.rate = ratePerSecond
    this.capacity = burst
    this.tokens = burst
    this.last = Date.now()
  }

  refill() {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate)
    this.last = now
  }

  take(n = 1) {
    this.refill()
    if (this.tokens >= n) {
      this.tokens -= n
      return true
    }
    return false
  }
}
