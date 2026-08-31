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
