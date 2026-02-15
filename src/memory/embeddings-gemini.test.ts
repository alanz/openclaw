import { describe, expect, it } from "vitest";
import { parseGemini429 } from "./embeddings-gemini.js";

describe("parseGemini429", () => {
  it("should parse actual RPD quota exhaustion error with detailed structure", () => {
    // Actual error body from production Gemini API when hitting daily quota
    const errorBody = JSON.stringify({
      error: {
        code: 429,
        message:
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/embed_content_free_tier_requests, limit: 1000, model: gemini-embedding-1.0\nPlease retry in 18.412144672s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [
              {
                description: "Learn more about Gemini API quotas",
                url: "https://ai.google.dev/gemini-api/docs/rate-limits",
              },
            ],
          },
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/embed_content_free_tier_requests",
                quotaId: "EmbedContentRequestsPerDayPerUserPerProjectPerModel-FreeTier",
                quotaDimensions: {
                  location: "global",
                  model: "gemini-embedding-1.0",
                },
                quotaValue: "1000",
              },
            ],
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "18s",
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe("rpd"); // Should detect "PerDay" in quotaId
    expect(result.retryDelayMs).toBe(18000); // Should parse "18s" -> 18000ms
  });

  it("should parse RPM quota error", () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaId: "RequestsPerMinutePerUser",
              },
            ],
          },
          {
            retryDelay: "31s",
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe("rpm");
    expect(result.retryDelayMs).toBe(31000);
  });

  it("should handle unknown quota type", () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            violations: [
              {
                quotaId: "SomeOtherQuotaType",
              },
            ],
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe("unknown");
    expect(result.retryDelayMs).toBe(null);
  });

  it("should handle malformed JSON gracefully", () => {
    const result = parseGemini429("not valid json");

    expect(result.quotaType).toBe("unknown");
    expect(result.retryDelayMs).toBe(null);
  });

  it("should handle missing details field", () => {
    const errorBody = JSON.stringify({
      error: {
        code: 429,
        message: "Rate limit exceeded",
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.quotaType).toBe("unknown");
    expect(result.retryDelayMs).toBe(null);
  });

  it("should parse fractional retry delay", () => {
    const errorBody = JSON.stringify({
      error: {
        details: [
          {
            retryDelay: "18.412144672s",
          },
        ],
      },
    });

    const result = parseGemini429(errorBody);

    expect(result.retryDelayMs).toBe(18412); // Rounded to nearest ms
  });
});
