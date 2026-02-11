import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingRateLimitError } from "./embedding-errors.js";
import { TokenBucketRateLimiter } from "./rate-limiter.js";

describe("TokenBucketRateLimiter.depleteQuotaForType", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new TokenBucketRateLimiter({
      rpmLimit: 100,
      rpdLimit: 1000,
      tpmLimit: 28000,
      accountKey: "test-key",
      coolDownMs: 5000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"rpm" only drains the RPM bucket, leaves RPD and TPM intact', () => {
    limiter.depleteQuotaForType("rpm");

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(1000);
    expect(status.availableTpm).toBe(28000);
    expect(status.inCoolDown).toBe(true);
  });

  it('"rpd" only drains the RPD bucket, leaves RPM and TPM intact', () => {
    limiter.depleteQuotaForType("rpd");

    const status = limiter.getStatus();
    // RPM starts at half capacity (50/100) to avoid startup burst compounding
    expect(status.availableRpm).toBe(50);
    expect(status.availableRpd).toBe(0);
    expect(status.availableTpm).toBe(28000);
    expect(status.inCoolDown).toBe(true);
  });

  it('"tpm" only drains the TPM bucket, leaves RPM and RPD intact', () => {
    limiter.depleteQuotaForType("tpm");

    const status = limiter.getStatus();
    // RPM starts at half capacity (50/100) to avoid startup burst compounding
    expect(status.availableRpm).toBe(50);
    expect(status.availableRpd).toBe(1000);
    expect(status.availableTpm).toBe(0);
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

  it('"unknown" drains only RPM — treats unidentified 429s as load-based, not quota exhaustion', () => {
    limiter.depleteQuotaForType("unknown");

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(1000); // RPD preserved
    expect(status.availableTpm).toBe(28000); // TPM preserved — draining it causes multi-minute waits
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

  it("depleteQuota() delegates to depleteQuotaForType('unknown'), drains only RPM", () => {
    limiter.depleteQuota();

    const status = limiter.getStatus();
    expect(status.availableRpm).toBe(0);
    expect(status.availableRpd).toBe(1000);
    expect(status.availableTpm).toBe(28000);
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

describe("TokenBucketRateLimiter.rpdSessionBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws EmbeddingRateLimitError(rpd) once session budget is reached", async () => {
    const limiter = new TokenBucketRateLimiter({
      rpdSessionBudget: 3,
      accountKey: "test-session-budget",
    });

    // First 3 permits should succeed
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);

    // 4th should throw immediately as an RPD rate limit error
    await expect(limiter.acquirePermit(1)).rejects.toSatisfy(
      (err: unknown) => err instanceof EmbeddingRateLimitError && err.quotaType === "rpd",
    );
  });

  it("getStatus() reflects session budget and used counts", async () => {
    const limiter = new TokenBucketRateLimiter({
      rpdSessionBudget: 5,
      accountKey: "test-session-status",
    });

    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);

    const status = limiter.getStatus();
    expect(status.rpdSessionBudget).toBe(5);
    expect(status.rpdSessionUsed).toBe(2);
    expect(status.rpdSessionRemaining).toBe(3);
  });

  it("session budget stop is immediate — does not wait for RPD bucket refill", async () => {
    // Set a normal rpdLimit too; session budget should fire first without sleeping
    const limiter = new TokenBucketRateLimiter({
      rpdLimit: 1000,
      rpdSessionBudget: 2,
      accountKey: "test-session-no-wait",
    });

    await limiter.acquirePermit(1);
    await limiter.acquirePermit(1);

    const start = Date.now();
    await expect(limiter.acquirePermit(1)).rejects.toBeInstanceOf(EmbeddingRateLimitError);
    // Should throw synchronously (within a single tick), not sleep for 86s
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("getStatus() returns null session fields when no budget is configured", () => {
    const limiter = new TokenBucketRateLimiter({
      rpdLimit: 1000,
      accountKey: "test-no-session-budget",
    });

    const status = limiter.getStatus();
    expect(status.rpdSessionBudget).toBeNull();
    expect(status.rpdSessionUsed).toBeNull();
    expect(status.rpdSessionRemaining).toBeNull();
  });
});
