const attackNames = [
  'fetch',
  'xhr',
  'websocket',
  'eventsource',
  'beacon',
  'image',
  'css',
  'script',
  'frame',
  'form',
  'download',
  'popup',
  'custom',
  'navigation',
];

function parseFields(value) {
  const entries = value.split(',');
  if (entries.length !== 4) return undefined;
  const fields = Object.create(null);
  for (const entry of entries) {
    const match = entry.match(/^([a-z]+):(.*)$/);
    if (!match || Object.hasOwn(fields, match[1])) return undefined;
    fields[match[1]] = match[2];
  }
  if (!['complete', 'ipc', 'origin', 'attacks'].every((name) => Object.hasOwn(fields, name))) return undefined;
  return fields;
}

function parseAttacks(value) {
  const entries = value.split('|');
  if (entries.length !== attackNames.length) return undefined;
  const attacks = Object.create(null);
  for (const [index, entry] of entries.entries()) {
    const match = entry.match(/^([a-z]+)-([01])$/);
    if (!match || match[1] !== attackNames[index] || Object.hasOwn(attacks, match[1])) return undefined;
    attacks[match[1]] = match[2] === '1';
  }
  return { ...attacks };
}

/** Parse one complete Rust probe line; malformed fields are never partially accepted. */
export function parseProbeReport(line) {
  const match = line.match(/^desktop-probe:(settings|secrets):(\d+):(\d+,\d+,\d+,\d+,\d+):(.*)$/);
  if (!match) return undefined;
  const fields = parseFields(match[4]);
  if (!fields || !/^[01]$/.test(fields.complete) || !/^[01]$/.test(fields.ipc) || !/^[01]$/.test(fields.origin)) {
    return undefined;
  }
  const attacks = parseAttacks(fields.attacks);
  if (!attacks) return undefined;
  return {
    label: match[1],
    windows: Number(match[2]),
    counters: match[3].split(',').map(Number),
    complete: fields.complete === '1',
    ipc: fields.ipc === '1',
    origin: fields.origin === '1',
    attacks,
  };
}
