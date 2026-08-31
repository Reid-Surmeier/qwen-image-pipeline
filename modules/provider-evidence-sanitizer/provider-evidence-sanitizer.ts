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

const stringHasCredentialField = (value: string): boolean => {
  for (const match of value.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)) {
    const decoded = decodeField(match[1] ?? "")
    if (decoded === undefined || credentialFieldName(decoded)) return true
  }
  for (const match of value.matchAll(/'((?:\\.|[^'\\])*)'\s*[:=]/g)) {
    const decoded = decodeField(match[1] ?? "")
    if (decoded === undefined || credentialFieldName(decoded)) return true
  }
  const looseSegments = value.split(/[:=]/u)
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
