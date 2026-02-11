import { createSubsystemLogger } from "../logging/subsystem.js";
import { EmbeddingRateLimitError } from "./embedding-errors.js";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
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
  /** Tokens per minute limit (undefined = no limit) */
  tpmLimit?: number;
  /**
   * Per-session RPD budget: stop (do not wait) once this many requests have
   * been issued in the current process. Useful for incremental daily indexing
   * where you want to consume a fixed quota and exit cleanly instead of hitting
   * the provider's hard daily limit.
   *
   * When reached, throws EmbeddingRateLimitError with quotaType "rpd", which
   * is caught by the indexing loop and stops further processing.
   *
   * Example: set rpdSessionBudget: 900 with rpdLimit: 1000 to leave a 100-request
   * safety margin and stop automatically each day.
   */
  rpdSessionBudget?: number;
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
  private readonly tpmLimit?: number;
  private readonly rpdSessionBudget?: number;
  private readonly coolDownMs: number;

  // Minute bucket state
  private rpmTokens: number;
  private rpmLastRefill: number;

  // Day bucket state
  private rpdTokens: number;
  private rpdLastRefill: number;

  // Tokens per minute bucket state
  private tpmTokens: number;
  private tpmLastRefill: number;

  // Session budget state: counts requests issued this process lifetime
  private rpdSessionUsed: number = 0;

  // Cool-down state
  private coolDownUntil: number = 0;

  constructor(config: RateLimitConfig) {
    this.accountKey = config.accountKey;
    this.rpmLimit = config.rpmLimit;
    this.rpdLimit = config.rpdLimit;
    this.tpmLimit = config.tpmLimit;
    this.rpdSessionBudget = config.rpdSessionBudget;
    this.coolDownMs = config.coolDownMs ?? 5000;

    // Initialize RPM to half capacity so startup doesn't compound with the
    // provider's own burst window (e.g. Gemini peaks at ~91 RPM before
    // settling to the sustained limit). Half-fill lets the bucket ramp up
    // gradually rather than firing a full minute's worth of requests at once.
    this.rpmTokens = (config.rpmLimit ?? 0) / 2;
    this.rpmLastRefill = Date.now();

    this.rpdTokens = config.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();

    this.tpmTokens = config.tpmLimit ?? 0;
    this.tpmLastRefill = Date.now();

    log.info("rate limiter created", {
      accountKey: config.accountKey,
      rpmLimit: config.rpmLimit,
      rpdLimit: config.rpdLimit,
      tpmLimit: config.tpmLimit,
      rpdSessionBudget: config.rpdSessionBudget,
    });
  }

  /**
   * Acquire permission to make N requests.
   * Blocks until sufficient tokens are available in all buckets (RPM, RPD, TPM).
   * Throws an error if wait time would exceed maxWaitMs.
   *
   * @param requestCount - Number of requests to acquire permits for
   * @param maxWaitMs - Maximum time to wait in milliseconds (default: 10 minutes)
   * @param tokenCount - Number of tokens to consume from TPM bucket (optional, defaults to 0)
   */
  async acquirePermit(requestCount: number, maxWaitMs = 600_000, tokenCount = 0): Promise<void> {
    if (requestCount <= 0 && tokenCount <= 0) {
      return;
    }

    // Throttle repetitive log messages: log immediately on first occurrence, then at most
    // once every LOG_THROTTLE_MS to avoid flooding the terminal during long waits.
    const LOG_THROTTLE_MS = 30_000;
    let lastCoolDownLogAt = 0;
    let lastQuotaLogAt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();

      // Check session budget: stop immediately (no waiting) if this run has
      // already consumed its daily allowance. Throws EmbeddingRateLimitError
      // so the indexing loop treats it the same as a real RPD 429 — it stops
      // cleanly rather than waiting for the bucket to refill.
      if (this.rpdSessionBudget !== undefined && this.rpdSessionUsed >= this.rpdSessionBudget) {
        log.warn("rate limiter: RPD session budget exhausted, stopping", {
          accountKey: this.accountKey,
          rpdSessionBudget: this.rpdSessionBudget,
          rpdSessionUsed: this.rpdSessionUsed,
        });
        throw new EmbeddingRateLimitError(
          `RPD session budget of ${this.rpdSessionBudget} requests exhausted ` +
            `(${this.rpdSessionUsed} used this run). ` +
            `Run \`openclaw memory index\` again tomorrow to continue.`,
          "rpd",
          null,
        );
      }

      // Check if we're in a cool-down period after a 429 error
      if (this.coolDownUntil > now) {
        const waitMs = this.coolDownUntil - now;
        if (now - lastCoolDownLogAt >= LOG_THROTTLE_MS) {
          log.warn("rate limiter: in cool-down after 429 error", {
            accountKey: this.accountKey,
            waitMs: Math.round(waitMs),
            availableAt: new Date(this.coolDownUntil).toISOString(),
          });
          lastCoolDownLogAt = now;
        }
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

      // Refill TPM bucket based on elapsed time
      if (this.tpmLimit !== undefined) {
        const elapsedMs = now - this.tpmLastRefill;
        const tokensToAdd = (elapsedMs / 60_000) * this.tpmLimit;
        this.tpmTokens = Math.min(this.tpmLimit, this.tpmTokens + tokensToAdd);
        this.tpmLastRefill = now;
      }

      // Check if we have enough tokens in all buckets
      const rpmAvailable = this.rpmLimit === undefined || this.rpmTokens >= requestCount;
      const rpdAvailable = this.rpdLimit === undefined || this.rpdTokens >= requestCount;
      const tpmAvailable = this.tpmLimit === undefined || this.tpmTokens >= tokenCount;

      if (rpmAvailable && rpdAvailable && tpmAvailable) {
        // Deduct tokens from all buckets
        if (this.rpmLimit !== undefined) {
          this.rpmTokens -= requestCount;
        }
        if (this.rpdLimit !== undefined) {
          this.rpdTokens -= requestCount;
        }
        if (this.tpmLimit !== undefined) {
          this.tpmTokens -= tokenCount;
        }

        // Track session usage for budget enforcement
        if (this.rpdSessionBudget !== undefined) {
          this.rpdSessionUsed += requestCount;
        }

        log.debug("rate limiter: permits acquired", {
          accountKey: this.accountKey,
          requestCount,
          tokenCount,
          rpmRemaining: this.rpmLimit !== undefined ? Math.floor(this.rpmTokens) : null,
          rpdRemaining: this.rpdLimit !== undefined ? Math.floor(this.rpdTokens) : null,
          tpmRemaining: this.tpmLimit !== undefined ? Math.floor(this.tpmTokens) : null,
          rpdSessionRemaining:
            this.rpdSessionBudget !== undefined
              ? this.rpdSessionBudget - this.rpdSessionUsed
              : null,
        });

        return;
      }

      // Calculate wait time for next available token
      let waitMs = 0;
      let limitType: "rpm" | "rpd" | "tpm" | null = null;

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

      if (!tpmAvailable && this.tpmLimit !== undefined) {
        const tokensNeeded = tokenCount - this.tpmTokens;
        const msPerToken = 60_000 / this.tpmLimit;
        const tpmWait = tokensNeeded * msPerToken;
        if (tpmWait > waitMs) {
          waitMs = tpmWait;
          limitType = "tpm";
        }
      }

      // Add small buffer to avoid tight loops
      waitMs = Math.max(100, waitMs);

      // Check if wait time exceeds maximum allowed
      if (waitMs > maxWaitMs) {
        const waitMinutes = Math.ceil(waitMs / 60_000);
        const availableAt = new Date(now + waitMs);
        const limitName =
          limitType === "rpm"
            ? "per-minute (RPM)"
            : limitType === "tpm"
              ? "tokens-per-minute (TPM)"
              : "per-day (RPD)";
        const limitValue =
          limitType === "rpm" ? this.rpmLimit : limitType === "tpm" ? this.tpmLimit : this.rpdLimit;

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

      const limitName =
        limitType === "rpm"
          ? "per-minute (RPM)"
          : limitType === "tpm"
            ? "tokens-per-minute (TPM)"
            : "per-day (RPD)";
      const availableAt = new Date(now + waitMs).toLocaleTimeString();

      // Calculate what percentage of each quota is available
      const rpmPercent =
        this.rpmLimit !== undefined ? Math.round((this.rpmTokens / this.rpmLimit) * 100) : null;
      const rpdPercent =
        this.rpdLimit !== undefined ? Math.round((this.rpdTokens / this.rpdLimit) * 100) : null;
      const tpmPercent =
        this.tpmLimit !== undefined ? Math.round((this.tpmTokens / this.tpmLimit) * 100) : null;

      if (now - lastQuotaLogAt >= LOG_THROTTLE_MS) {
        log.warn(`rate limiter: ${limitType?.toUpperCase()} quota exhausted, waiting`, {
          accountKey: this.accountKey,
          limitingBucket: limitType,
          limitName,
          reason:
            limitType === "rpm"
              ? `Per-minute quota exhausted (${Math.floor(this.rpmTokens)}/${this.rpmLimit} available)`
              : limitType === "tpm"
                ? `Tokens-per-minute quota exhausted (${Math.floor(this.tpmTokens)}/${this.tpmLimit} available)`
                : `Per-day quota exhausted (${Math.floor(this.rpdTokens)}/${this.rpdLimit} available)`,
          requestCount,
          tokenCount,
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
          tpm:
            this.tpmLimit !== undefined
              ? `${Math.floor(this.tpmTokens)}/${this.tpmLimit} (${tpmPercent}%)`
              : null,
        });
        lastQuotaLogAt = now;
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Get current rate limiter status.
   */
  getStatus(): {
    availableRpm: number | null;
    availableRpd: number | null;
    availableTpm: number | null;
    inCoolDown: boolean;
    coolDownRemainingMs: number | null;
    rpdSessionBudget: number | null;
    rpdSessionUsed: number | null;
    rpdSessionRemaining: number | null;
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

    let tpmAvailable: number | null = null;
    if (this.tpmLimit !== undefined) {
      const elapsedMs = now - this.tpmLastRefill;
      const tokensToAdd = (elapsedMs / 60_000) * this.tpmLimit;
      tpmAvailable = Math.floor(Math.min(this.tpmLimit, this.tpmTokens + tokensToAdd));
    }

    // Check cool-down status
    const inCoolDown = this.coolDownUntil > now;
    const coolDownRemainingMs = inCoolDown ? this.coolDownUntil - now : null;

    const rpdSessionRemaining =
      this.rpdSessionBudget !== undefined
        ? Math.max(0, this.rpdSessionBudget - this.rpdSessionUsed)
        : null;

    return {
      availableRpm: rpmAvailable,
      availableRpd: rpdAvailable,
      availableTpm: tpmAvailable,
      inCoolDown,
      coolDownRemainingMs,
      rpdSessionBudget: this.rpdSessionBudget ?? null,
      rpdSessionUsed: this.rpdSessionBudget !== undefined ? this.rpdSessionUsed : null,
      rpdSessionRemaining,
    };
  }

  /**
   * Reset token buckets. RPM starts at half capacity to avoid burst compounding;
   * RPD and TPM reset to full.
   */
  reset(): void {
    this.rpmTokens = (this.rpmLimit ?? 0) / 2;
    this.rpmLastRefill = Date.now();
    this.rpdTokens = this.rpdLimit ?? 0;
    this.rpdLastRefill = Date.now();
    this.tpmTokens = this.tpmLimit ?? 0;
    this.tpmLastRefill = Date.now();
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
   * Deplete quota to indicate API rate limit was hit when quota type is unknown.
   * Zeroes only the RPM bucket (brief cool-down), preserving TPM and RPD.
   * Delegates to depleteQuotaForType("unknown").
   */
  depleteQuota(): void {
    this.depleteQuotaForType("unknown");
  }

  /**
   * Deplete quota for a specific quota type after a 429 error.
   *
   * - "rpm": only zeros the per-minute bucket
   * - "rpd": only zeros the per-day bucket (longer default cool-down)
   * - "tpm": only zeros the tokens-per-minute bucket
   * - "unknown": zeros all buckets (legacy behavior)
   *
   * @param quotaType - Which quota was exhausted
   * @param coolDownOverrideMs - Optional cool-down from the API response (e.g. retryDelay)
   */
  depleteQuotaForType(
    quotaType: "rpm" | "rpd" | "tpm" | "unknown",
    coolDownOverrideMs?: number | null,
  ): void {
    const hadRpmTokens = Math.floor(this.rpmTokens);
    const hadRpdTokens = Math.floor(this.rpdTokens);
    const hadTpmTokens = Math.floor(this.tpmTokens);

    // Zero the appropriate bucket(s).
    // "unknown" → treat as RPM: back off briefly but don't drain TPM or RPD.
    // Unidentified 429s are often load-based, not real quota exhaustion;
    // draining TPM causes multi-minute waits, draining RPD causes ~86s-per-token cascades.
    if (quotaType === "rpm" || quotaType === "unknown") {
      this.rpmTokens = 0;
    }
    if (quotaType === "rpd") {
      this.rpdTokens = 0;
    }
    if (quotaType === "tpm") {
      this.tpmTokens = 0;
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
      tpmLimit: this.tpmLimit,
      hadRpmTokens,
      hadRpdTokens,
      hadTpmTokens,
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
 * Uses apiKeys[0] since auth headers are built dynamically per-request
 * via parseGeminiAuth() and are not stored in client.headers.
 */
function getGeminiAccountKey(gemini: GeminiEmbeddingClient): string {
  const apiKey = gemini.apiKeys[0];
  if (!apiKey) {
    throw new Error("Gemini client missing API key");
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
  config: { rpmLimit?: number; rpdLimit?: number; tpmLimit?: number; rpdSessionBudget?: number },
): TokenBucketRateLimiter | null {
  // If no limits configured, return null (no rate limiting)
  if (!config.rpmLimit && !config.rpdLimit && !config.tpmLimit && !config.rpdSessionBudget) {
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
      tpmLimit: config.tpmLimit,
      rpdSessionBudget: config.rpdSessionBudget,
      accountKey,
    });
    RATE_LIMITER_CACHE.set(accountKey, limiter);
  }

  return limiter;
}
