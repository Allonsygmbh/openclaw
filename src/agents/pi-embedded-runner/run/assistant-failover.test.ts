import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import { handleAssistantFailover } from "./assistant-failover.js";

type Overrides = Partial<Parameters<typeof handleAssistantFailover>[0]>;

function createParams(overrides: Overrides = {}): Parameters<typeof handleAssistantFailover>[0] {
  return {
    initialDecision: { action: "surface_error", reason: "timeout" },
    aborted: false,
    externalAbort: false,
    fallbackConfigured: false,
    failoverFailure: true,
    failoverReason: "timeout",
    timedOut: true,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    allowSameModelIdleTimeoutRetry: false,
    assistantProfileFailureReason: null,
    lastProfileId: "profile-abc",
    modelId: "sonnet-4.6",
    provider: "anthropic",
    activeErrorContext: { provider: "anthropic", model: "sonnet-4.6" },
    lastAssistant: undefined,
    config: undefined,
    sessionKey: "test-session",
    authFailure: false,
    rateLimitFailure: false,
    billingFailure: false,
    cloudCodeAssistFormatError: false,
    isProbeSession: false,
    overloadProfileRotations: 0,
    overloadProfileRotationLimit: 3,
    previousRetryFailoverReason: null,
    logAssistantFailoverDecision: vi.fn(),
    warn: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(async () => undefined),
    maybeEscalateRateLimitProfileFallback: vi.fn(),
    maybeBackoffBeforeOverloadFailover: vi.fn(async () => undefined),
    advanceAuthProfile: vi.fn(async () => false),
    ...overrides,
  };
}

describe("handleAssistantFailover — surface_error handling (regression: PR #64817)", () => {
  it("throws FailoverError with reason=timeout and status=408 when the assistant-stage LLM times out terminally", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "timeout" },
        failoverReason: "timeout",
        timedOut: true,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error).toBeInstanceOf(FailoverError);
    expect(outcome.error.reason).toBe("timeout");
    expect(outcome.error.status).toBe(408);
    expect(outcome.error.message).toBe("LLM request timed out.");
    expect(outcome.error.provider).toBe("anthropic");
    expect(outcome.error.model).toBe("sonnet-4.6");
    expect(outcome.error.profileId).toBe("profile-abc");
  });

  it("throws FailoverError with reason=billing and status=402 when surface_error is a billing failure", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "billing" },
        failoverReason: "billing",
        timedOut: false,
        billingFailure: true,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error.reason).toBe("billing");
    expect(outcome.error.status).toBe(402);
    expect(outcome.error.message.length).toBeGreaterThan(0);
  });

  it("throws FailoverError with reason=rate_limit and status=429 when surface_error is rate-limited", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "rate_limit" },
        failoverReason: "rate_limit",
        timedOut: false,
        rateLimitFailure: true,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error.reason).toBe("rate_limit");
    expect(outcome.error.status).toBe(429);
    expect(outcome.error.message).toBe("LLM request rate limited.");
  });

  it("throws FailoverError with reason=auth and status=401 when surface_error is an auth failure", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "auth" },
        failoverReason: "auth",
        timedOut: false,
        authFailure: true,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error.reason).toBe("auth");
    expect(outcome.error.status).toBe(401);
    expect(outcome.error.message).toBe("LLM request unauthorized.");
  });

  it("throws FailoverError with generic message when surface_error reason is unknown and no lastAssistant provided", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "unknown" },
        failoverReason: null,
        timedOut: false,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error.reason).toBe("unknown");
    expect(outcome.error.message).toBe("LLM request failed.");
  });

  it("logs the surface_error decision before throwing", async () => {
    const log = vi.fn();
    await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "timeout" },
        timedOut: true,
        logAssistantFailoverDecision: log,
      }),
    );

    expect(log).toHaveBeenCalledWith("surface_error");
  });

  // --- Regression guards: pre-existing behavior MUST be preserved ---

  it("preserves the idle-timeout retry path: if !externalAbort + idleTimedOut + allowSameModelIdleTimeoutRetry, returns retry (not throw)", async () => {
    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "surface_error", reason: "timeout" },
        externalAbort: false,
        idleTimedOut: true,
        allowSameModelIdleTimeoutRetry: true,
        timedOut: true,
      }),
    );

    expect(outcome.action).toBe("retry");
    if (outcome.action !== "retry") {
      return;
    }
    expect(outcome.retryKind).toBe("same_model_idle_timeout");
  });

  // --- fallback_model branch: pins the unified message precedence shared
  // with surface_error (type-specific failures win over upstream assistant text).

  it("fallback_model branch: canonical timeout message wins over lastAssistant.errorMessage when timedOut", async () => {
    const lastAssistant = {
      errorMessage: "Upstream provider returned an opaque 502 wrapper",
    } as unknown as AssistantMessage;

    const outcome = await handleAssistantFailover(
      createParams({
        initialDecision: { action: "fallback_model", reason: "timeout" },
        failoverReason: "timeout",
        timedOut: true,
        fallbackConfigured: true,
        lastAssistant,
      }),
    );

    expect(outcome.action).toBe("throw");
    if (outcome.action !== "throw") {
      return;
    }
    expect(outcome.error).toBeInstanceOf(FailoverError);
    expect(outcome.error.reason).toBe("timeout");
    expect(outcome.error.status).toBe(408);
    expect(outcome.error.message).toBe("LLM request timed out.");
  });

  it("returns continue_normal when decision is not surface_error/rotate_profile/fallback_model (happy path)", async () => {
    // No recovery needed — simulate a no-op passthrough by using a decision whose
    // action we don't specifically handle (`continue_normal` isn't a real decision
    // action, but the function returns `continue_normal` as its default fallthrough
    // when the decision doesn't match any branch). Cast to satisfy the discriminated
    // union; at runtime the branch simply falls through.
    const outcome = await handleAssistantFailover(
      createParams({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        initialDecision: { action: "no_action_needed" } as any,
        timedOut: false,
      }),
    );

    expect(outcome.action).toBe("continue_normal");
  });
});
