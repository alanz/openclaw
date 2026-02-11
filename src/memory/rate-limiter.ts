import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

/**
 * Configuration for a token bucket rate limiter.
 */
export type RateLimitConfig = {
  /** Requests per minute limit (undefined = no limit) */
  rpmLimit?: number;
  /** Requests per day limit (undefined = no limit) */
  rpdLimit?: number;
  /** Account identifier for this rate limiter instance */
  accountKey: string;
  /** Cool-down period in milliseconds after a 429 error (default: 5000ms) */
  coolDownMs?: number;
};

/**
 * Token bucket rate limiter implementing dual rate limits (RPM and RPD).
 * Uses time-based token refill to enforce configurable request quotas.
 */
export class TokenBucketRateLimiter {
  private readonly accountKey: string;
  private readonly rpmLimit?: number;
  private readonly rpdLimit?: number;
  private readonly coolDownMs: number;

  // Minute bucket state
  private rpmTokens: number;
  private rpmLastRefill: number;

  // Day bucket state
  private rpdTokens: number;
  private rpdLastRefill: number;

  // Cool-down state
  private coolDownUntil: number = 0;

  constructor(config: RateLimitConfig) {
    this.accountKey = config.accountKey;
    this.rpmLimit = config.rpmLimit;
    this.rpdLimit = config.rpdLimit;
    this.coolDownMs = config.coolDownMs ?? 5000;

    // Initialize tokens to full capacity
    this.rpmTokens = config.rpmLimit ?? 0;
    this.rpmLastRefill = Date.now();

    this.rpdTokens = config.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();

    log.info("rate limiter created", {
      accountKey: config.accountKey,
      rpmLimit: config.rpmLimit,
      rpdLimit: config.rpdLimit,
    });
  }

  /**
   * Acquire permission to make N requests.
   * Blocks until sufficient tokens are available in both buckets.
   * Throws an error if wait time would exceed maxWaitMs.
   *
   * @param requestCount - Number of requests to acquire permits for
   * @param maxWaitMs - Maximum time to wait in milliseconds (default: 10 minutes)
   */
  async acquirePermit(requestCount: number, maxWaitMs = 600_000): Promise<void> {
    if (requestCount <= 0) {
      return;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();

      // Check if we're in a cool-down period after a 429 error
      if (this.coolDownUntil > now) {
        const waitMs = this.coolDownUntil - now;
        log.warn("rate limiter: in cool-down after 429 error", {
          accountKey: this.accountKey,
          waitMs: Math.round(waitMs),
          availableAt: new Date(this.coolDownUntil).toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // Clear cool-down after waiting
        this.coolDownUntil = 0;
        continue;
      }

      // Refill minute bucket based on elapsed time
      if (this.rpmLimit !== undefined) {
        const elapsedMs = now - this.rpmLastRefill;
        const tokensToAdd = (elapsedMs / 60_000) * this.rpmLimit;
        this.rpmTokens = Math.min(this.rpmLimit, this.rpmTokens + tokensToAdd);
        this.rpmLastRefill = now;
      }

      // Refill day bucket based on elapsed time
      if (this.rpdLimit !== undefined) {
        const elapsedMs = now - this.rpdLastRefill;
        const tokensToAdd = (elapsedMs / 86_400_000) * this.rpdLimit;
        this.rpdTokens = Math.min(this.rpdLimit, this.rpdTokens + tokensToAdd);
        this.rpdLastRefill = now;
      }

      // Check if we have enough tokens in both buckets
      const rpmAvailable = this.rpmLimit === undefined || this.rpmTokens >= requestCount;
      const rpdAvailable = this.rpdLimit === undefined || this.rpdTokens >= requestCount;

      if (rpmAvailable && rpdAvailable) {
        // Deduct tokens from both buckets
        if (this.rpmLimit !== undefined) {
          this.rpmTokens -= requestCount;
        }
        if (this.rpdLimit !== undefined) {
          this.rpdTokens -= requestCount;
        }

        log.debug("rate limiter: permits acquired", {
          accountKey: this.accountKey,
          requestCount,
          rpmRemaining: this.rpmLimit !== undefined ? Math.floor(this.rpmTokens) : null,
          rpdRemaining: this.rpdLimit !== undefined ? Math.floor(this.rpdTokens) : null,
        });

        return;
      }

      // Calculate wait time for next available token
      let waitMs = 0;
      let limitType: "rpm" | "rpd" | null = null;

      if (!rpmAvailable && this.rpmLimit !== undefined) {
        const tokensNeeded = requestCount - this.rpmTokens;
        const msPerToken = 60_000 / this.rpmLimit;
        const rpmWait = tokensNeeded * msPerToken;
        if (rpmWait > waitMs) {
          waitMs = rpmWait;
          limitType = "rpm";
        }
      }

      if (!rpdAvailable && this.rpdLimit !== undefined) {
        const tokensNeeded = requestCount - this.rpdTokens;
        const msPerToken = 86_400_000 / this.rpdLimit;
        const rpdWait = tokensNeeded * msPerToken;
        if (rpdWait > waitMs) {
          waitMs = rpdWait;
          limitType = "rpd";
        }
      }

      // Add small buffer to avoid tight loops
      waitMs = Math.max(100, waitMs);

      // Check if wait time exceeds maximum allowed
      if (waitMs > maxWaitMs) {
        const waitMinutes = Math.ceil(waitMs / 60_000);
        const availableAt = new Date(now + waitMs);
        const limitName = limitType === "rpm" ? "per-minute" : "per-day";
        const limitValue = limitType === "rpm" ? this.rpmLimit : this.rpdLimit;

        log.warn("rate limiter: quota exhausted, wait exceeds maximum", {
          accountKey: this.accountKey,
          requestCount,
          waitMs: Math.round(waitMs),
          maxWaitMs,
          limitType,
          availableAt: availableAt.toISOString(),
        });

        throw new Error(
          `Rate limit ${limitName} quota exhausted (${limitValue} requests). ` +
            `Would need to wait ${waitMinutes} minutes (until ${availableAt.toLocaleTimeString()}). ` +
            `This exceeds the maximum wait time of ${Math.ceil(maxWaitMs / 60_000)} minutes. ` +
            `Please try again later.`,
        );
      }

      // Format human-readable wait time
      const waitSeconds = Math.round(waitMs / 1000);
      let waitDescription: string;
      if (waitSeconds < 60) {
        waitDescription = `${waitSeconds}s`;
      } else if (waitSeconds < 3600) {
        const minutes = Math.ceil(waitSeconds / 60);
        waitDescription = `${minutes}m`;
      } else {
        const hours = Math.floor(waitSeconds / 3600);
        const minutes = Math.ceil((waitSeconds % 3600) / 60);
        waitDescription = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
      }

      const limitName = limitType === "rpm" ? "per-minute (RPM)" : "per-day (RPD)";
      const availableAt = new Date(now + waitMs).toLocaleTimeString();

      // Calculate what percentage of each quota is available
      const rpmPercent =
        this.rpmLimit !== undefined ? Math.round((this.rpmTokens / this.rpmLimit) * 100) : null;
      const rpdPercent =
        this.rpdLimit !== undefined ? Math.round((this.rpdTokens / this.rpdLimit) * 100) : null;

      log.warn("rate limiter: quota exhausted, waiting", {
        accountKey: this.accountKey,
        limitingBucket: limitType,
        limitName,
        reason:
          limitType === "rpm"
            ? `Per-minute quota exhausted (${Math.floor(this.rpmTokens)}/${this.rpmLimit} available)`
            : `Per-day quota exhausted (${Math.floor(this.rpdTokens)}/${this.rpdLimit} available)`,
        requestCount,
        waitTime: waitDescription,
        availableAt,
        rpm:
          this.rpmLimit !== undefined
            ? `${Math.floor(this.rpmTokens)}/${this.rpmLimit} (${rpmPercent}%)`
            : null,
        rpd:
          this.rpdLimit !== undefined
            ? `${Math.floor(this.rpdTokens)}/${this.rpdLimit} (${rpdPercent}%)`
            : null,
      });

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Get current rate limiter status.
   */
  getStatus(): {
    availableRpm: number | null;
    availableRpd: number | null;
    inCoolDown: boolean;
    coolDownRemainingMs: number | null;
  } {
    const now = Date.now();

    // Refill tokens based on current time (without mutating state)
    let rpmAvailable: number | null = null;
    if (this.rpmLimit !== undefined) {
      const elapsedMs = now - this.rpmLastRefill;
      const tokensToAdd = (elapsedMs / 60_000) * this.rpmLimit;
      rpmAvailable = Math.floor(Math.min(this.rpmLimit, this.rpmTokens + tokensToAdd));
    }

    let rpdAvailable: number | null = null;
    if (this.rpdLimit !== undefined) {
      const elapsedMs = now - this.rpdLastRefill;
      const tokensToAdd = (elapsedMs / 86_400_000) * this.rpdLimit;
      rpdAvailable = Math.floor(Math.min(this.rpdLimit, this.rpdTokens + tokensToAdd));
    }

    // Check cool-down status
    const inCoolDown = this.coolDownUntil > now;
    const coolDownRemainingMs = inCoolDown ? this.coolDownUntil - now : null;

    return {
      availableRpm: rpmAvailable,
      availableRpd: rpdAvailable,
      inCoolDown,
      coolDownRemainingMs,
    };
  }

  /**
   * Reset token buckets to full capacity.
   */
  reset(): void {
    this.rpmTokens = this.rpmLimit ?? 0;
    this.rpmLastRefill = Date.now();
    this.rpdTokens = this.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();
    this.coolDownUntil = 0;
    log.debug("rate limiter reset", { accountKey: this.accountKey });
  }

  /**
   * Check if the rate limiter is currently in a cool-down period.
   */
  isInCoolDown(): boolean {
    return this.coolDownUntil > Date.now();
  }

  /**
   * Get the remaining cool-down time in milliseconds.
   */
  getCoolDownRemainingMs(): number | null {
    const now = Date.now();
    if (this.coolDownUntil > now) {
      return this.coolDownUntil - now;
    }
    return null;
  }

  /**
   * Deplete quota to indicate API rate limit was hit.
   * Sets token buckets to 0 and enters a cool-down period.
   * Delegates to depleteQuotaForType("unknown") for backward compatibility.
   */
  depleteQuota(): void {
    this.depleteQuotaForType("unknown");
  }

  /**
   * Deplete quota for a specific quota type after a 429 error.
   *
   * - "rpm": only zeros the per-minute bucket
   * - "rpd": only zeros the per-day bucket (longer default cool-down)
   * - "unknown": zeros both buckets (legacy behavior)
   *
   * @param quotaType - Which quota was exhausted
   * @param coolDownOverrideMs - Optional cool-down from the API response (e.g. retryDelay)
   */
  depleteQuotaForType(
    quotaType: "rpm" | "rpd" | "unknown",
    coolDownOverrideMs?: number | null,
  ): void {
    const hadRpmTokens = Math.floor(this.rpmTokens);
    const hadRpdTokens = Math.floor(this.rpdTokens);

    // Zero the appropriate bucket(s)
    if (quotaType === "rpm" || quotaType === "unknown") {
      this.rpmTokens = 0;
    }
    if (quotaType === "rpd" || quotaType === "unknown") {
      this.rpdTokens = 0;
    }

    // Determine base cool-down: use API-provided override, or type-specific default
    const baseCoolDownMs =
      coolDownOverrideMs != null && coolDownOverrideMs > 0
        ? coolDownOverrideMs
        : quotaType === "rpd"
          ? 60_000
          : this.coolDownMs;

    // Add random jitter to the cool-down period (±20%)
    const jitter = 0.8 + Math.random() * 0.4; // 0.8 to 1.2
    const coolDownWithJitter = Math.round(baseCoolDownMs * jitter);
    this.coolDownUntil = Date.now() + coolDownWithJitter;

    log.warn("rate limiter: quota depleted due to 429 error, entering cool-down", {
      accountKey: this.accountKey,
      quotaType,
      rpmLimit: this.rpmLimit,
      rpdLimit: this.rpdLimit,
      hadRpmTokens,
      hadRpdTokens,
      baseCoolDownMs,
      coolDownWithJitter,
      coolDownOverrideMs: coolDownOverrideMs ?? null,
      availableAt: new Date(this.coolDownUntil).toISOString(),
      message: `${quotaType} quota exhausted, entering cool-down before retry`,
    });
  }
}

/**
 * Global cache of rate limiters keyed by provider account.
 * Shared across all MemoryIndexManager instances using the same provider account.
 */
const RATE_LIMITER_CACHE = new Map<string, TokenBucketRateLimiter>();

/**
 * Extract account key for Gemini provider.
 * Uses the x-goog-api-key header to identify the account.
 */
function getGeminiAccountKey(gemini: GeminiEmbeddingClient): string {
  const apiKey = gemini.headers["x-goog-api-key"];
  if (!apiKey) {
    throw new Error("Gemini client missing x-goog-api-key header");
  }
  return hashText(`gemini:${apiKey}`);
}

/**
 * Extract account key for OpenAI provider.
 * Uses the Authorization header to identify the account.
 */
function getOpenAiAccountKey(openai: OpenAiEmbeddingClient): string {
  const apiKey = openai.headers["Authorization"]?.replace(/^Bearer\s+/, "");
  if (!apiKey) {
    throw new Error("OpenAI client missing Authorization header");
  }
  return hashText(`openai:${apiKey}`);
}

/**
 * Extract account key for Voyage provider.
 * Uses the Authorization header to identify the account.
 */
function getVoyageAccountKey(voyage: VoyageEmbeddingClient): string {
  const apiKey = voyage.headers["Authorization"]?.replace(/^Bearer\s+/, "");
  if (!apiKey) {
    throw new Error("Voyage client missing Authorization header");
  }
  return hashText(`voyage:${apiKey}`);
}

/**
 * Get or create a rate limiter for a provider account.
 * Returns null if no rate limits are configured.
 * Shares rate limiter instances across all MemoryIndexManager instances using the same account.
 */
export function getOrCreateRateLimiter(
  provider: "gemini" | "openai" | "voyage",
  client: GeminiEmbeddingClient | OpenAiEmbeddingClient | VoyageEmbeddingClient,
  config: { rpmLimit?: number; rpdLimit?: number },
): TokenBucketRateLimiter | null {
  // If no limits configured, return null (no rate limiting)
  if (!config.rpmLimit && !config.rpdLimit) {
    return null;
  }

  // Get provider-specific account key
  const accountKey =
    provider === "gemini"
      ? getGeminiAccountKey(client as GeminiEmbeddingClient)
      : provider === "openai"
        ? getOpenAiAccountKey(client as OpenAiEmbeddingClient)
        : getVoyageAccountKey(client as VoyageEmbeddingClient);

  // Check cache
  let limiter = RATE_LIMITER_CACHE.get(accountKey);
  if (!limiter) {
    limiter = new TokenBucketRateLimiter({
      rpmLimit: config.rpmLimit,
      rpdLimit: config.rpdLimit,
      accountKey,
    });
    RATE_LIMITER_CACHE.set(accountKey, limiter);
  }

  return limiter;
}
