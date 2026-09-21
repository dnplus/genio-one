import { expect, test } from "bun:test"
import { executableStep, MAX_SAFETY_CHECKS, presidioDetectorValid, processSteps, safetyCheckConfigurationValid } from "./policy-process-draft"

test("editing a regex processing rule preserves the remaining patterns and token lifetime", () => {
  const original = {
    step_id: "redact",
    hooks: {
      request: {
        action: "REDACT" as const,
        config: {
          patterns: [
            { name: "EMAIL", expression: "old", flags: "g" },
            { name: "PHONE", expression: "keep", flags: "g" },
          ],
          token_ttl_seconds: 123,
        },
      },
    },
  }
  const source = { chain: { steps: [{ kind: "PROCESS" as const, ...original }] } }
  const draft = processSteps(source)[0]!

  expect(executableStep(draft)).toEqual(original)

  const edited = executableStep({ ...draft, changed: true, dataProtectionChanged: true, expression: "new" })
  expect(edited.hooks.request?.config).toEqual({
    patterns: [
      { name: "EMAIL", expression: "new", flags: "g" },
      { name: "PHONE", expression: "keep", flags: "g" },
    ],
    token_ttl_seconds: 123,
  })
})

test("editing request safety checks preserves a separate response regex hook", () => {
  const original = {
    step_id: "mixed",
    hooks: {
      request: {
        action: "SAFETY_CHECK" as const,
        config: {
          schema_version: 1,
          adapter_id: "jev-primary",
          checks: [
            { id: "secrets", instructions: "Block secrets", threshold: 0.7 },
            { id: "abuse", instructions: "Block abusive requests", threshold: 0.8 },
          ],
          timeout_ms: 5000,
        },
      },
      response: {
        action: "REDACT" as const,
        config: {
          patterns: [{ name: "EMAIL", expression: "[\\w.-]+@[\\w.-]+", flags: "g" }],
          token_ttl_seconds: 600,
        },
      },
    },
  }
  const draft = processSteps({ chain: { steps: [{ kind: "PROCESS" as const, ...original }] } })[0]!

  expect(executableStep(draft)).toEqual(original)

  const edited = executableStep({
    ...draft,
    changed: true,
    requestSafetyChanged: true,
    requestSafety: {
      ...draft.requestSafety,
      checks: [
        { id: "secrets", instructions: "Block confidential secrets", threshold: 0.75 },
        draft.requestSafety.checks[1]!,
      ],
    },
  })

  expect(edited.hooks.request?.config).toEqual({
    schema_version: 1,
    adapter_id: "jev-primary",
    checks: [
      { id: "secrets", instructions: "Block confidential secrets", threshold: 0.75 },
      { id: "abuse", instructions: "Block abusive requests", threshold: 0.8 },
    ],
    timeout_ms: 5000,
  })
  expect(edited.hooks.response).toEqual(original.hooks.response)
})

test("editing a response detector preserves asymmetric request and response regex hooks", () => {
  const original = {
    step_id: "asymmetric",
    hooks: {
      request: {
        action: "REDACT" as const,
        config: {
          patterns: [{ name: "EMAIL", expression: "request-email", flags: "g" }],
          token_ttl_seconds: 120,
        },
      },
      response: {
        action: "REDACT" as const,
        config: {
          patterns: [
            { name: "PHONE", expression: "response-phone", flags: "m" },
            { name: "IP_ADDRESS", expression: "response-ip", flags: "i" },
          ],
          token_ttl_seconds: 900,
        },
      },
    },
  }
  const draft = processSteps({ chain: { steps: [{ kind: "PROCESS" as const, ...original }] } })[0]!

  expect(draft.expression).toBe("request-email")

  const edited = executableStep({
    ...draft,
    changed: true,
    responseDetectorChanged: true,
    responseDetector: {
      adapterId: "presidio-primary",
      language: "en",
      entities: "PHONE_NUMBER",
      scoreThreshold: 0.6,
    },
  })

  expect(edited.hooks.request).toEqual(original.hooks.request)
  expect(edited.hooks.response).toEqual({
    action: "REDACT",
    config: {
      patterns: [
        { name: "PHONE", expression: "response-phone", flags: "m" },
        { name: "IP_ADDRESS", expression: "response-ip", flags: "i" },
      ],
      token_ttl_seconds: 900,
      detector: {
        adapter_id: "presidio-primary",
        language: "en",
        entities: ["PHONE_NUMBER"],
        score_threshold: 0.6,
      },
    },
  })
})

test("adding a detector to a configless builtin hook creates an executable config", () => {
  const original = {
    step_id: "configless-response",
    hooks: {
      response: {
        action: "REDACT" as const,
      },
    },
  }
  const draft = processSteps({ chain: { steps: [{ kind: "PROCESS" as const, ...original }] } })[0]!

  const edited = executableStep({
    ...draft,
    changed: true,
    responseDetectorChanged: true,
    responseDetector: {
      adapterId: "presidio-primary",
      language: "en",
      entities: "EMAIL_ADDRESS",
      scoreThreshold: 0.5,
    },
  })

  expect(edited.hooks.response).toEqual({
    action: "REDACT",
    config: {
      patterns: [],
      token_ttl_seconds: 600,
      detector: {
        adapter_id: "presidio-primary",
        language: "en",
        entities: ["EMAIL_ADDRESS"],
        score_threshold: 0.5,
      },
    },
  })
})

test("switching between safety, regex, Presidio, and tokenize restore uses each executable config family", () => {
  const safetyDraft = processSteps({
    chain: {
      steps: [{
        kind: "PROCESS" as const,
        step_id: "safety",
        hooks: {
          request: {
            action: "SAFETY_CHECK" as const,
            config: {
              schema_version: 1,
              adapter_id: "http-guardrail",
              checks: [{ id: "guardrail", instructions: "Reject unsafe input", threshold: 0.5 }],
              timeout_ms: 5000,
            },
          },
        },
      }],
    },
  })[0]!
  const regex = executableStep({
    ...safetyDraft,
    changed: true,
    dataProtectionChanged: true,
    requestAction: "REDACT",
    expression: "secret",
    patternName: "CREDENTIAL",
  })

  expect(regex.hooks.request).toEqual({
    action: "REDACT",
    config: {
      patterns: [{ name: "CREDENTIAL", expression: "secret", flags: "i" }],
      token_ttl_seconds: 600,
    },
  })

  const classifier = executableStep({
    ...processSteps({ chain: { steps: [{ kind: "PROCESS" as const, ...regex }] } })[0]!,
    changed: true,
    requestAction: "MODEL_CLASSIFIER",
    classifierChanged: true,
    classifierKeywords: "support, billing",
    classifierModel: "classifier-model",
    classifierFallback: "fallback-model",
  })

  expect(classifier.hooks.request).toEqual({
    action: "MODEL_CLASSIFIER",
    effect: "SORT_ENTITLEMENT_CANDIDATES",
    config: {
      schema_version: 1,
      strategy: "KEYWORD",
      rules: [{ keywords: ["support", "billing"], public_model_name: "classifier-model" }],
      fallback_public_model_name: "fallback-model",
    },
  })

  const regexDraft = processSteps({ chain: { steps: [{ kind: "PROCESS" as const, ...regex }] } })[0]!
  const presidio = executableStep({
    ...regexDraft,
    changed: true,
    requestDetectorChanged: true,
    requestDetector: {
      adapterId: "presidio-primary",
      language: "en",
      entities: "EMAIL_ADDRESS, PHONE_NUMBER",
      scoreThreshold: 0.6,
    },
  })

  expect(presidio.hooks.request?.config).toEqual({
    patterns: [{ name: "CREDENTIAL", expression: "secret", flags: "i" }],
    token_ttl_seconds: 600,
    detector: {
      adapter_id: "presidio-primary",
      language: "en",
      entities: ["EMAIL_ADDRESS", "PHONE_NUMBER"],
      score_threshold: 0.6,
    },
  })

  const presidioOnly = executableStep({
    ...regexDraft,
    changed: true,
    dataProtectionChanged: true,
    requestDetectorChanged: true,
    expression: "",
    requestDetector: {
      adapterId: "presidio-primary",
      language: "en",
      entities: "EMAIL_ADDRESS",
      scoreThreshold: 0.5,
    },
  })

  expect(presidioOnly.hooks.request?.config).toEqual({
    patterns: [],
    token_ttl_seconds: 600,
    detector: {
      adapter_id: "presidio-primary",
      language: "en",
      entities: ["EMAIL_ADDRESS"],
      score_threshold: 0.5,
    },
  })

  const tokenize = executableStep({
    ...regexDraft,
    changed: true,
    requestAction: "TOKENIZE",
    responseAction: "RESTORE",
    requestDetectorChanged: true,
    requestDetector: {
      adapterId: "presidio-primary",
      language: "en",
      entities: "EMAIL_ADDRESS",
      scoreThreshold: 0.5,
    },
  })

  expect(tokenize.hooks.request?.config).toEqual({
    patterns: [{ name: "CREDENTIAL", expression: "secret", flags: "i" }],
    token_ttl_seconds: 600,
    detector: {
      adapter_id: "presidio-primary",
      language: "en",
      entities: ["EMAIL_ADDRESS"],
      score_threshold: 0.5,
    },
  })
  expect(tokenize.hooks.response).toEqual({
    action: "RESTORE",
    config: {
      patterns: [],
      token_ttl_seconds: 600,
    },
  })
})

test("the editor rejects invalid safety and Presidio configuration before saving", () => {
  expect(safetyCheckConfigurationValid({
    adapterId: "jev-primary",
    timeoutMs: 5000,
    checks: [
      { id: "duplicate", instructions: "one", threshold: 0.4 },
      { id: "duplicate", instructions: "two", threshold: 0.6 },
    ],
  })).toBeFalse()
  expect(safetyCheckConfigurationValid({
    adapterId: "jev-primary",
    timeoutMs: 99,
    checks: [{ id: "guardrail", instructions: "Reject unsafe input", threshold: 0.5 }],
  })).toBeFalse()
  expect(presidioDetectorValid({
    adapterId: "presidio-primary",
    language: "",
    entities: "EMAIL_ADDRESS",
    scoreThreshold: 0.5,
  })).toBeFalse()
})

test("safety configuration accepts 64 checks and rejects 65", () => {
  const checks = Array.from({ length: MAX_SAFETY_CHECKS }, (_, index) => ({
    id: `check-${index + 1}`,
    instructions: `Reject risk ${index + 1}`,
    threshold: 0.5,
  }))
  const configuration = {
    adapterId: "jev-primary",
    timeoutMs: 5000,
    checks,
  }

  expect(safetyCheckConfigurationValid(configuration)).toBeTrue()
  expect(safetyCheckConfigurationValid({
    ...configuration,
    checks: [...checks, { id: "check-65", instructions: "Reject risk 65", threshold: 0.5 }],
  })).toBeFalse()
})
