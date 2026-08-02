/**
 * Deterministic canonical JSON serialization used for manifests and idempotency
 * digests. The serialization rules are:
 *
 * - object keys sorted in Unicode code-point order (UTF-16 order matches
 *   code-point order for all characters in the BMP, which covers JSON syntax);
 * - no insignificant whitespace;
 * - ASCII JSON encoding with the four mandatory escapes: `"`, `\`, backspace,
 *   tab, newline, carriage return, form feed; and `\uXXXX` escapes for
 *   control characters below 0x20 and lone surrogates;
 * - `\uXXXX` escapes emitted in lowercase hexadecimal;
 * - numbers serialized by `JSON.stringify`, which guarantees round-trip
 *   fidelity (shortest decimal representation that parses back to the same
 *   value);
 * - `undefined` object values dropped, non-finite numbers rejected;
 * - NaN/Infinity rejected rather than serialized as invalid JSON.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return serializeString(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite number values are not supported');
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareKeys);
      const parts: string[] = [];
      for (const key of keys) {
        const item = record[key];
        if (item === undefined) continue;
        parts.push(`${serializeString(key)}:${serialize(item)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value type ${typeof value}`);
  }
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serializeString(value: string): string {
  let result = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x22:
        result += '\\"';
        break;
      case 0x5c:
        result += '\\\\';
        break;
      case 0x08:
        result += '\\b';
        break;
      case 0x09:
        result += '\\t';
        break;
      case 0x0a:
        result += '\\n';
        break;
      case 0x0c:
        result += '\\f';
        break;
      case 0x0d:
        result += '\\r';
        break;
      default:
        if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
          result += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          result += value[i];
        }
    }
  }
  return `${result}"`;
}
