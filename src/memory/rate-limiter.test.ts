import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "./rate-limiter.js";

describe("TokenBucketRateLimiter.depleteQuotaForType", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      rpdLimit: 1000,
      accountKey: "test-key",
      coolDownMs: 5000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"rpm" only drains the RPM bucket, leaves RPD intact', () => {
    limiter.depleteQuotaForType("rpm");

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(1000);
    expect(status.inCoolDown).toBe(true);
  });

  it('"rpd" only drains the RPD bucket, leaves RPM intact', () => {
    limiter.depleteQuotaForType("rpd");

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(100);
    expect(status.availableRpd).toBe(0);
    expect(status.inCoolDown).toBe(true);
  });

  it('"rpd" uses a longer default cool-down (~60s) than RPM (~5s)', () => {
    // Seed Math.random to get predictable jitter
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0

    limiter.depleteQuotaForType("rpd");
    const rpdCoolDown = limiter.getCoolDownRemainingMs();

    limiter.reset();

    limiter.depleteQuotaForType("rpm");
    const rpmCoolDown = limiter.getCoolDownRemainingMs();

    expect(rpdCoolDown).toBeGreaterThan(rpmCoolDown!);
    // RPD default is 60s, RPM default is 5s (coolDownMs)
    expect(rpdCoolDown).toBe(60_000);
    expect(rpmCoolDown).toBe(5000);

    randomSpy.mockRestore();
  });

  it('"unknown" drains both buckets (backward compat)', () => {
    limiter.depleteQuotaForType("unknown");

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(0);
    expect(status.inCoolDown).toBe(true);
  });

  it("coolDownOverrideMs from API response is respected", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0

    limiter.depleteQuotaForType("rpm", 31_000);
    const coolDown = limiter.getCoolDownRemainingMs();

    // With jitter factor 1.0, cool-down should be exactly the override
    expect(coolDown).toBe(31_000);

    randomSpy.mockRestore();
  });

  it("depleteQuota() delegates to depleteQuotaForType('unknown')", () => {
    limiter.depleteQuota();

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(0);
    expect(status.inCoolDown).toBe(true);
  });

  it("null coolDownOverrideMs falls back to type-specific default", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0

    limiter.depleteQuotaForType("rpd", null);
    const coolDown = limiter.getCoolDownRemainingMs();

    // Should use RPD default of 60s
    expect(coolDown).toBe(60_000);

    randomSpy.mockRestore();
  });
});
