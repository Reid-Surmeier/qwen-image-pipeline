export const EMBEDDED_PROVIDER_SECRET_CASES = [
  ["nested-json-secret", '{"debug":"{\\"api_key\\":\\"actual-private-value\\"}","status":"accepted"}'],
  ["nested-json-duplicate-secret", '{"debug":"{\\"note\\":\\"sk-private-value-123456\\",\\"note\\":\\"redacted\\"}","status":"accepted"}'],
] as const
