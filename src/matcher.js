const TRIBUTE_RE = /\btribute\b|\bcover\s*band\b|\bcelebrating\b|\bthe music of\b|\bsalute to\b|the\s+.+\s+story\b|the\s+.+\s+experience\b|\bstory songs\b|\bsongs of\b|\bsymphon|\bphilharmon|\bbook tour\b|\bmany more\b/i;

/** Returns true if the name looks like a tribute/cover act rather than the real artist. */
export function isTribute(name) {
  return TRIBUTE_RE.test(name);
}

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
    if (name && !isTribute(name)) seen.add(normalize(name));
    // also check aliases attached to artist object
    for (const alias of (show?.artist?.aliases ?? [])) {
      if (!isTribute(alias)) seen.add(normalize(alias));
    }
  }
  return seen;
}
