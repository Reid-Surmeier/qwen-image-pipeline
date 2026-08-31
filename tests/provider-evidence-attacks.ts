export const EMBEDDED_PROVIDER_SECRET_CASES = [
  ["full-width-credential-key", JSON.stringify({
    "ａｐｉ＿ｋｅｙ": "opaque-private-value",
    status: "accepted",
  })],
  ["mixed-script-credential-key", JSON.stringify({
    "аpi_key": "opaque-private-value",
    status: "accepted",
  })],
  ["prefixed-serialized-unicode-key", JSON.stringify({
    debug: 'provider diagnostic: {"\\u0061pi_key":"opaque-private-value"}',
    status: "accepted",
  })],
  ["prefixed-serialized-mixed-script-key", JSON.stringify({
    debug: 'provider diagnostic: {"аpi_key":"opaque-private-value"}',
    status: "accepted",
  })],
  ["single-quoted-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: {'api_key':'opaque-private-value'}",
    status: "accepted",
  })],
  ["unquoted-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: {api_key:'opaque-private-value'}",
    status: "accepted",
  })],
  ["assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key=opaque-private-value",
    status: "accepted",
  })],
  ["dotted-assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api.key=opaque-private-value",
    status: "accepted",
  })],
  ["spaced-assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api key=opaque-private-value",
    status: "accepted",
  })],
  ["bracketed-assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: [api_key]=opaque-private-value",
    status: "accepted",
  })],
  ["multiline-assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api\nkey=opaque-private-value",
    status: "accepted",
  })],
  ["slash-qualified-assignment-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api/key=opaque-private-value",
    status: "accepted",
  })],
  ["fullwidth-colon-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key：opaque-private-value",
    status: "accepted",
  })],
  ["fullwidth-equals-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key＝opaque-private-value",
    status: "accepted",
  })],
  ["small-colon-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key﹕opaque-private-value",
    status: "accepted",
  })],
  ["ratio-colon-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key∶opaque-private-value",
    status: "accepted",
  })],
  ["modifier-colon-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key꞉opaque-private-value",
    status: "accepted",
  })],
  ["escaped-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key\\u003dopaque-private-value",
    status: "accepted",
  })],
  ["escaped-key-and-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: \\u0061pi_key\\u003dopaque-private-value",
    status: "accepted",
  })],
  ["hex-escaped-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key\\x3dopaque-private-value",
    status: "accepted",
  })],
  ["code-point-escaped-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key\\u{3d}opaque-private-value",
    status: "accepted",
  })],
  ["percent-escaped-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key%3Dopaque-private-value",
    status: "accepted",
  })],
  ["entity-escaped-separator-diagnostic-field", JSON.stringify({
    debug: "provider diagnostic: api_key&#61;opaque-private-value",
    status: "accepted",
  })],
  ["nested-json-secret", '{"debug":"{\\"api_key\\":\\"actual-private-value\\"}","status":"accepted"}'],
  ["nested-json-duplicate-secret", '{"debug":"{\\"note\\":\\"sk-private-value-123456\\",\\"note\\":\\"redacted\\"}","status":"accepted"}'],
  ["deeply-nested-json-secret", JSON.stringify({
    debug: JSON.stringify({
      debug: JSON.stringify({
        debug: JSON.stringify({
          debug: JSON.stringify({
            debug: JSON.stringify({ api_key: "actual-private-value" }),
          }),
        }),
      }),
    }),
    status: "accepted",
  })],
  ["deeply-nested-unicode-secret", JSON.stringify({
    debug: JSON.stringify({
      debug: JSON.stringify({
        debug: JSON.stringify({
          debug: JSON.stringify({
            debug: '{"\\u0061pi_key":"actual-private-value"}',
          }),
        }),
      }),
    }),
    status: "accepted",
  })],
  ["malformed-unicode-secret", JSON.stringify({
    debug: '{"\\u0061pi_key":"actual-private-value"',
    status: "accepted",
  })],
] as const
