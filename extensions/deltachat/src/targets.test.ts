import { describe, it, expect } from "vitest";
import { looksLikeDeltaChatTargetId, parseDeltaChatTarget } from "./targets.js";

describe("looksLikeDeltaChatTargetId", () => {
  it("should recognize email addresses", () => {
    expect(looksLikeDeltaChatTargetId("user@example.com")).toBe(true);
    expect(looksLikeDeltaChatTargetId("test.user@domain.co.uk")).toBe(true);
  });

  it("should recognize numeric chat IDs", () => {
    expect(looksLikeDeltaChatTargetId("123")).toBe(true);
    expect(looksLikeDeltaChatTargetId("999999")).toBe(true);
  });

  it("should recognize group: prefix", () => {
    expect(looksLikeDeltaChatTargetId("group:13")).toBe(true);
    expect(looksLikeDeltaChatTargetId("group:12345")).toBe(true);
    expect(looksLikeDeltaChatTargetId("GROUP:13")).toBe(true);
  });

  it("should recognize chat_id: prefix", () => {
    expect(looksLikeDeltaChatTargetId("chat_id:13")).toBe(true);
    expect(looksLikeDeltaChatTargetId("chat_id:12345")).toBe(true);
    expect(looksLikeDeltaChatTargetId("CHAT_ID:13")).toBe(true);
  });

  it("should return false for invalid targets", () => {
    expect(looksLikeDeltaChatTargetId("")).toBe(false);
    expect(looksLikeDeltaChatTargetId("   ")).toBe(false);
    expect(looksLikeDeltaChatTargetId("not-an-email")).toBe(false);
    expect(looksLikeDeltaChatTargetId("group:abc")).toBe(false);
  });
});

describe("parseDeltaChatTarget", () => {
  it("should parse email addresses", () => {
    const result = parseDeltaChatTarget("user@example.com");
    expect(result).toEqual({ kind: "email", to: "user@example.com" });
  });

  it("should parse numeric chat IDs", () => {
    const result = parseDeltaChatTarget("123");
    expect(result).toEqual({ kind: "chat_id", to: "123" });
  });

  it("should parse group: prefix", () => {
    const result = parseDeltaChatTarget("group:13");
    expect(result).toEqual({ kind: "chat_id", to: "13" });
  });

  it("should parse chat_id: prefix", () => {
    const result = parseDeltaChatTarget("chat_id:13");
    expect(result).toEqual({ kind: "chat_id", to: "13" });
  });

  it("should parse email: prefix", () => {
    const result = parseDeltaChatTarget("email:user@example.com");
    expect(result).toEqual({ kind: "email", to: "user@example.com" });
  });

  it("should parse deltachat: prefix", () => {
    const result = parseDeltaChatTarget("deltachat:user@example.com");
    expect(result).toEqual({ kind: "email", to: "user@example.com" });
  });

  it("should parse nested prefixes", () => {
    const result = parseDeltaChatTarget("deltachat:group:13");
    expect(result).toEqual({ kind: "chat_id", to: "13" });
  });
});
