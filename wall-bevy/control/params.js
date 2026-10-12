// params.js — a scene's params as the output declares them (catalog: [{ key, value, label, min, max,
// step, options }], in their order): their kinds, and which values they accept.

const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** The params with their kind ('number', 'boolean', 'color', 'select', 'string'). */
export function normalizeParams(defs) {
  const list = [];
  const entries = Array.isArray(defs) ? defs.map((d) => [d?.key, d]) : Object.entries(defs ?? {});
  for (const [key, raw] of entries) {
    if (typeof key !== 'string') continue;
    const spec = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { value: raw };
    const v = spec.value;
    let kind = null;
    if (spec.options !== undefined) kind = 'select';
    else if (typeof v === 'number' && Number.isFinite(v)) kind = 'number';
    else if (typeof v === 'boolean') kind = 'boolean';
    else if (typeof v === 'string' && COLOR_RE.test(v)) kind = 'color';
    else if (typeof v === 'string') kind = 'string';
    if (!kind) continue;
    list.push({ ...spec, key, kind, label: spec.label ?? key });
  }
  return list;
}

export const optionValues = (options) => (Array.isArray(options) ? options : Object.values(options ?? {}));

export function acceptsParam(p, v) {
  switch (p.kind) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v);
    case 'select':
      return optionValues(p.options).includes(v);
    case 'string':
      return typeof v === 'string';
    default:
      return false;
  }
}
