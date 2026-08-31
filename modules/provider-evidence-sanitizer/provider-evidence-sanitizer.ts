const credentialFieldName = (key: string): boolean => {
  const compatibleKey = key.normalize("NFKC")
  if (/[^\x20-\x7e]/.test(compatibleKey)) return true
  const normalized = compatibleKey.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^x/, "")
  if (["prompttokens", "completiontokens", "totaltokens", "cachedtokens", "reasoningtokens"].includes(normalized)) {
    return false
  }
  return /(?:api|access|private)key$/.test(normalized) ||
    /(?:secret|password|credential)(?:key|value)?$/.test(normalized) ||
    /authorization$/.test(normalized) ||
    /(?:sig|signature)$/.test(normalized) ||
    /credentials?$/.test(normalized) ||
    /^(?:auth|authentication|authorization)(?:data|header|info|token|value)?$/.test(normalized) ||
    /token$/.test(normalized) ||
    /cookie$/.test(normalized) ||
    /^(?:request|response)?headers$/.test(normalized) ||
    normalized === "credential"
}

const decodeField = (encoded: string): string | undefined => {
  if (!encoded.includes("\\")) return encoded
  try {
    const decoded = JSON.parse(`"${encoded}"`) as unknown
    return typeof decoded === "string" ? decoded : undefined
  } catch {
    return undefined
  }
}

const decodeDiagnosticSyntax = (source: string): string | undefined => {
  let current = source
  for (let pass = 0; pass < 4; pass += 1) {
    let invalidCodePoint = false
    const codePoint = (original: string, encoded: string): string => {
      const value = Number.parseInt(encoded, 16)
      if (!Number.isSafeInteger(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
        invalidCodePoint = true
        return original
      }
      return String.fromCodePoint(value)
    }
    let next = current
      .replace(/\\u\{([0-9a-f]{1,6})\}/giu, (original, encoded: string) => codePoint(original, encoded))
      .replace(/\\u([0-9a-f]{4})/giu, (original, encoded: string) => codePoint(original, encoded))
      .replace(/\\x([0-9a-f]{2})/giu, (original, encoded: string) => codePoint(original, encoded))
      .replace(/&#x([0-9a-f]{1,6});?/giu, (original, encoded: string) => codePoint(original, encoded))
      .replace(/&#([0-9]{1,7});?/gu, (original, encoded: string) => {
        const value = Number.parseInt(encoded, 10)
        if (!Number.isSafeInteger(value) || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
          invalidCodePoint = true
          return original
        }
        return String.fromCodePoint(value)
      })
      .replace(/&colon;/giu, ":")
      .replace(/&equals;/giu, "=")
    if (invalidCodePoint) return undefined
    if (/%[0-9a-f]{2}/iu.test(next)) {
      try {
        next = decodeURIComponent(next)
      } catch {
        return undefined
      }
    }
    if (next === current) return next
    current = next
  }
  return current
}

const stringHasCredentialField = (value: string): boolean => {
  const decodedValue = decodeDiagnosticSyntax(value)
  if (decodedValue === undefined) return true
  const compatibleValue = decodedValue.normalize("NFKC")
  let structuralStart = 0
  for (let cursor = 0; cursor < compatibleValue.length;) {
    const codePoint = compatibleValue.codePointAt(cursor)
    const character = codePoint === undefined ? "" : String.fromCodePoint(codePoint)
    if (
      /[^\x00-\x7f]/u.test(character) &&
      /[\p{P}\p{S}]/u.test(character) &&
      credentialFieldName(compatibleValue.slice(structuralStart, cursor))
    ) return true
    if (/[:=,;{}\n]/u.test(character)) structuralStart = cursor + character.length
    cursor += character.length || 1
  }
  for (const match of compatibleValue.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) {
    const decoded = decodeField(match[1] ?? "")
    if (decoded === undefined || credentialFieldName(decoded)) return true
  }
  for (const match of compatibleValue.matchAll(/'((?:\\.|[^'\\])*)'\s*[:=]/g)) {
    const decoded = decodeField(match[1] ?? "")
    if (decoded === undefined || credentialFieldName(decoded)) return true
  }
  const looseSegments = compatibleValue.split(/[:=]/u)
  for (const encoded of looseSegments.slice(0, -1)) {
    const decoded = decodeField(encoded)
    if (decoded === undefined || credentialFieldName(decoded)) return true
  }
  return false
}

export const hasDuplicateJsonKeys = (source: string): boolean => {
  let cursor = 0
  const whitespace = () => { while (/\s/.test(source[cursor] ?? "")) cursor += 1 }
  const string = (): string => {
    const start = cursor
    cursor += 1
    while (cursor < source.length) {
      if (source[cursor] === "\\") { cursor += 2; continue }
      if (source[cursor] === '"') {
        cursor += 1
        return JSON.parse(source.slice(start, cursor)) as string
      }
      cursor += 1
    }
    throw new Error("unterminated JSON string")
  }
  const value = (): boolean => {
    whitespace()
    if (source[cursor] === "{") return object()
    if (source[cursor] === "[") return array()
    if (source[cursor] === '"') { string(); return false }
    const start = cursor
    while (cursor < source.length && !/[\s,}\]]/.test(source[cursor]!)) cursor += 1
    if (cursor === start) throw new Error("missing JSON value")
    return false
  }
  const object = (): boolean => {
    cursor += 1
    whitespace()
    const keys = new Set<string>()
    if (source[cursor] === "}") { cursor += 1; return false }
    while (cursor < source.length) {
      whitespace()
      if (source[cursor] !== '"') throw new Error("missing JSON key")
      const key = string()
      if (keys.has(key)) return true
      keys.add(key)
      whitespace()
      if (source[cursor] !== ":") throw new Error("missing JSON colon")
      cursor += 1
      if (value()) return true
      whitespace()
      if (source[cursor] === "}") { cursor += 1; return false }
      if (source[cursor] !== ",") throw new Error("missing JSON object separator")
      cursor += 1
    }
    throw new Error("unterminated JSON object")
  }
  const array = (): boolean => {
    cursor += 1
    whitespace()
    if (source[cursor] === "]") { cursor += 1; return false }
    while (cursor < source.length) {
      if (value()) return true
      whitespace()
      if (source[cursor] === "]") { cursor += 1; return false }
      if (source[cursor] !== ",") throw new Error("missing JSON array separator")
      cursor += 1
    }
    throw new Error("unterminated JSON array")
  }
  try {
    const duplicate = value()
    whitespace()
    return duplicate
  } catch {
    return false
  }
}

export const hasProviderCredentialMaterial = (
  value: unknown,
  key?: string,
  embeddedDepth = 0,
): boolean => {
  if (key !== undefined && credentialFieldName(key)) return true
  if (typeof value === "string") {
    let credentialQuery = false
    try {
      const parsed = new URL(value, "https://provider-evidence.invalid")
      credentialQuery = [...parsed.searchParams.keys()].some(credentialFieldName)
    } catch {
      credentialQuery = /[?&](?:api[_-]?key|access[_-]?key|password|secret|authorization|(?:access|refresh|id)?[_-]?token)=/i.test(value)
    }
    if (
      credentialQuery ||
      /(?:sk-|gh[pousr]_|Bearer\s+)[A-Za-z0-9_-]{6,}/i.test(value) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
      /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(value) ||
      stringHasCredentialField(value)
    ) return true
    if (/^\s*[\[{]/.test(value)) {
      if (embeddedDepth >= 4) return true
      try {
        if (hasDuplicateJsonKeys(value)) return true
        if (hasProviderCredentialMaterial(JSON.parse(value), key, embeddedDepth + 1)) return true
      } catch {
        return true
      }
    }
    return false
  }
  if (Array.isArray(value)) {
    return value.some((child) => hasProviderCredentialMaterial(child, undefined, embeddedDepth))
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([childKey, child]) =>
      hasProviderCredentialMaterial(child, childKey, embeddedDepth))
  }
  return false
}

export type SanitizedProviderDocumentKind =
  | "qwen"
  | "seedance-submission"
  | "seedance-poll"

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): boolean => Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && Object.hasOwn(descriptor, "value")
})

const safeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

const safeTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const sanitizedQwenUsage = (value: unknown): boolean => {
  const usage = objectRecord(value)
  return usage !== undefined &&
    hasExactKeys(usage, ["prompt_tokens", "completion_tokens"]) &&
    safeTokenCount(usage.prompt_tokens) &&
    safeTokenCount(usage.completion_tokens)
}

const sanitizedQwenDocument = (document: Readonly<Record<string, unknown>>): boolean => {
  if (hasExactKeys(document, ["id", "status"])) {
    return safeIdentifier(document.id) && document.status === "completed"
  }
  if (hasExactKeys(document, ["request_id", "status"])) {
    return safeIdentifier(document.request_id) &&
      (document.status === "accepted" || document.status === "succeeded")
  }
  return hasExactKeys(document, ["usage"]) && sanitizedQwenUsage(document.usage)
}

const sanitizedSeedanceSubmission = (document: Readonly<Record<string, unknown>>): boolean =>
  hasExactKeys(document, ["job_id", "status"]) &&
  safeIdentifier(document.job_id) &&
  (document.status === "submitted" || document.status === "queued")

const sanitizedSeedanceCost = (value: unknown): boolean => {
  const cost = objectRecord(value)
  if (cost === undefined) return false
  if (cost.state === "actual") {
    return hasExactKeys(cost, ["state", "actual_cost_usd"]) &&
      typeof cost.actual_cost_usd === "string" && /^(?:0|[1-9]\d*)\.\d{2,6}$/.test(cost.actual_cost_usd)
  }
  return (cost.state === "estimated-only" || cost.state === "unknown") && hasExactKeys(cost, ["state"])
}

const sanitizedSeedanceOutput = (value: unknown): boolean => {
  const output = objectRecord(value)
  return output !== undefined &&
    hasExactKeys(output, ["application_path", "media_type", "sha256"]) &&
    typeof output.application_path === "string" &&
    /^outputs\/[a-z0-9][a-z0-9._-]*\.mp4$/.test(output.application_path) &&
    output.media_type === "video/mp4" &&
    typeof output.sha256 === "string" && /^[a-f0-9]{64}$/.test(output.sha256)
}

const denseClosedArray = (value: ReadonlyArray<unknown>): boolean => {
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false
  }
  return keys.every((key) => key === "length" || (
    typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) &&
    Number.isSafeInteger(Number(key)) && Number(key) < value.length
  ))
}

const exactUtcTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false
  }
  const epoch = Date.parse(value)
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value
}

const sanitizedSeedancePoll = (document: Readonly<Record<string, unknown>>): boolean => {
  if (!safeIdentifier(document.job_id)) return false
  if (document.status === "pending") return hasExactKeys(document, ["job_id", "status"])
  const completedKeys = Object.hasOwn(document, "polled_at")
    ? ["job_id", "status", "polled_at", "outputs", "completed_count", "cost"]
    : ["job_id", "status", "outputs", "completed_count", "cost"]
  if (
    document.status !== "completed" ||
    !hasExactKeys(document, completedKeys) ||
    (Object.hasOwn(document, "polled_at") && !exactUtcTimestamp(document.polled_at)) ||
    !Array.isArray(document.outputs) ||
    !denseClosedArray(document.outputs) ||
    typeof document.completed_count !== "number" ||
    !Number.isSafeInteger(document.completed_count) || document.completed_count < 1 ||
    document.outputs.length !== document.completed_count ||
    !sanitizedSeedanceCost(document.cost)
  ) return false
  for (let index = 0; index < document.outputs.length; index += 1) {
    if (!Object.hasOwn(document.outputs, index) || !sanitizedSeedanceOutput(document.outputs[index])) return false
  }
  return true
}

export const isSanitizedProviderDocument = (
  kind: SanitizedProviderDocumentKind,
  value: unknown,
): boolean => {
  try {
    const document = objectRecord(value)
    if (document === undefined) return false
    const schemaMatches = kind === "qwen"
      ? sanitizedQwenDocument(document)
      : kind === "seedance-submission"
        ? sanitizedSeedanceSubmission(document)
        : sanitizedSeedancePoll(document)
    return schemaMatches && !hasProviderCredentialMaterial(document)
  } catch {
    return false
  }
}
