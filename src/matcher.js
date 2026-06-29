/** Normalize an artist name for fuzzy matching (mirrors analyze.py logic). */
export function normalize(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/\p{Mn}/gu, '')   // strip accents
    .replace(/&/g, 'and')
    .replace(/\s+(feat|ft|with|versus|vs)\.?\s+.*/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a Set of normalized seen-artist names from raw setlist.fm show objects. */
export function buildSeenSet(shows) {
  const seen = new Set();
  for (const show of shows) {
    const name = show?.artist?.name;
    if (name) seen.add(normalize(name));
    // also check aliases attached to artist object
    for (const alias of (show?.artist?.aliases ?? [])) {
      seen.add(normalize(alias));
    }
  }
  return seen;
}
