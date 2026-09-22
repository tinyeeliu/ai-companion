type JsonValue = unknown;

function printable(value: JsonValue, seen: WeakSet<object>): JsonValue {
  if (typeof value === 'bigint') return `${value}n`;
  if (value instanceof Uint8Array) return `[Uint8Array ${value.byteLength} bytes]`;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => printable(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, printable(item, seen)]),
  );
}

export function jsonForLog(value: JsonValue): string {
  try {
    return JSON.stringify(printable(value, new WeakSet()), null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

export function logJson(
  direction: 'incoming' | 'outgoing',
  transport: 'http' | 'websocket',
  event: string,
  value: JsonValue,
): void {
  console.log(`[companion][${transport}][${direction}] ${event} ${jsonForLog(value)}`);
}
