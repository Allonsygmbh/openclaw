import { describe, expect, it } from "vitest";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTrialExpiredErrorMessage,
} from "./failover-matches.js";

describe("Z.ai vendor error codes (#48988)", () => {
  describe("error 1311 — model not included in subscription plan", () => {
    it("classifies Z.ai 1311 JSON body as billing", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1311 with spaces as billing", () => {
      const raw = '{"code": 1311, "message": "model not on plan"}';
      expect(isBillingErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1311 as rate_limit", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1311 as auth", () => {
      const raw =
        '{"code":1311,"message":"The model you requested is not available in your current plan"}';
      expect(isAuthErrorMessage(raw)).toBe(false);
    });

    it("classifies long Z.ai 1311 payloads as billing", () => {
      const raw = JSON.stringify({
        code: 1311,
        message: "The model you requested is not available in your current plan",
        details: "x".repeat(700),
      });
      expect(raw.length).toBeGreaterThan(512);
      expect(isBillingErrorMessage(raw)).toBe(true);
    });
  });

  describe("error 1113 — wrong endpoint or invalid credentials", () => {
    it("classifies Z.ai 1113 JSON body as auth", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("classifies Z.ai 1113 with spaces as auth", () => {
      const raw = '{"code": 1113, "message": "invalid api endpoint or credentials"}';
      expect(isAuthErrorMessage(raw)).toBe(true);
    });

    it("does not misclassify 1113 as rate_limit", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isRateLimitErrorMessage(raw)).toBe(false);
    });

    it("does not misclassify 1113 as billing", () => {
      const raw = '{"code":1113,"message":"invalid api endpoint or credentials"}';
      expect(isBillingErrorMessage(raw)).toBe(false);
    });
  });

  describe("existing patterns are unaffected", () => {
    it("rate limit still classified correctly", () => {
      expect(isRateLimitErrorMessage("rate limit exceeded")).toBe(true);
    });

    it("trial-expired still classified correctly", () => {
      expect(
        isTrialExpiredErrorMessage("Your trial has expired. Subscribe to resume your clawy."),
      ).toBe(true);
    });

    it("OpenAI model-capacity text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage("Selected model is at capacity. Please try a different model."),
      ).toBe(true);
    });

    it("OpenRouter high-load text is classified as overloaded", () => {
      expect(
        isOverloadedErrorMessage(
          "The service is currently experiencing high load and cannot process your request.",
        ),
      ).toBe(true);
    });

    it("billing still classified correctly", () => {
      expect(isBillingErrorMessage("insufficient credits")).toBe(true);
    });

    it("auth still classified correctly", () => {
      expect(isAuthErrorMessage("invalid api key provided")).toBe(true);
    });
  });
});

describe("Clawy trial-expired (403) detection", () => {
  const BACKEND_MESSAGE = "Your trial has expired. Subscribe to resume your clawy.";

  it("classifies the backend trial-expired message", () => {
    expect(isTrialExpiredErrorMessage(BACKEND_MESSAGE)).toBe(true);
  });

  it("classifies the FailoverError-wrapped form seen in gateway logs", () => {
    expect(
      isTrialExpiredErrorMessage(`FailoverError: ${BACKEND_MESSAGE}`),
    ).toBe(true);
  });

  it("classifies the structured trial_expired error type from the AI proxy", () => {
    const raw = JSON.stringify({
      error: {
        message: BACKEND_MESSAGE,
        type: "trial_expired",
        subscribe_url: "https://clawy.io/subscribe",
      },
    });
    expect(isTrialExpiredErrorMessage(raw)).toBe(true);
  });

  it("does not misclassify a lapsed trial as provider billing (402)", () => {
    // The whole point: a 403 trial block must not be swallowed by the 402
    // billing patterns, and vice versa.
    expect(isBillingErrorMessage(BACKEND_MESSAGE)).toBe(false);
  });

  it("does not misclassify trial-expired as rate_limit or auth", () => {
    expect(isRateLimitErrorMessage(BACKEND_MESSAGE)).toBe(false);
    expect(isAuthErrorMessage(BACKEND_MESSAGE)).toBe(false);
  });

  it("does not flag unrelated provider-billing text as trial-expired", () => {
    expect(isTrialExpiredErrorMessage("insufficient credits")).toBe(false);
    expect(isTrialExpiredErrorMessage("HTTP 402 payment required")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isTrialExpiredErrorMessage("")).toBe(false);
  });
});
