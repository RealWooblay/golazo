/**
 * COUNTRY FLAGS — turn a national-team name into a flag emoji, asset-free.
 *
 * The lobby's default slate is the World Cup, where every team is a country, so
 * we attach a flag to each team's crest. Emoji keeps us asset-free (in keeping
 * with the gradient Crest) — no image bundle, no network logos.
 *
 * Approach: normalise the team name (lowercase, strip accents/punctuation), look
 * up an ISO 3166-1 alpha-2 code, then convert that to a 🇫🇷-style regional-
 * indicator emoji. The four UK home nations have their own flag emoji (tag
 * sequences, not ISO), so they're stored as literals. Unknown names (e.g. club
 * teams like "Man City") return undefined and simply render without a flag.
 *
 * Rendering note: flag emoji render as flags on iOS, macOS and most Android, but
 * Windows/Chrome shows the two letters instead — acceptable since the primary
 * target is iOS.
 */

/** Convert an ISO 3166-1 alpha-2 code ("fr") into a flag emoji ("🇫🇷"). */
export function isoToFlag(iso: string): string {
  const cc = iso.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  const BASE = 0x1f1e6; // 🇦 regional indicator A
  return String.fromCodePoint(
    BASE + cc.charCodeAt(0) - 65,
    BASE + cc.charCodeAt(1) - 65,
  );
}

/** Strip accents + punctuation and lowercase, so "Côte d'Ivoire" → "cote divoire". */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalised country name → ISO alpha-2 (or a literal flag emoji for the UK home
 * nations, which have no ISO code). Includes the common ESPN name variants
 * ("usa"/"united states", "korea republic"/"south korea", "ir iran"/"iran").
 */
const COUNTRY: Record<string, string> = {
  // — UEFA —
  england: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  scotland: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  wales: "🏴󠁧󠁢󠁷󠁬󠁳󠁿",
  "northern ireland": "gb",
  france: "fr",
  spain: "es",
  germany: "de",
  portugal: "pt",
  netherlands: "nl",
  holland: "nl",
  belgium: "be",
  italy: "it",
  croatia: "hr",
  switzerland: "ch",
  poland: "pl",
  denmark: "dk",
  serbia: "rs",
  austria: "at",
  ukraine: "ua",
  sweden: "se",
  "czech republic": "cz",
  czechia: "cz",
  turkey: "tr",
  turkiye: "tr",
  norway: "no",
  greece: "gr",
  ireland: "ie",
  "republic of ireland": "ie",
  russia: "ru",
  romania: "ro",
  hungary: "hu",
  iceland: "is",
  finland: "fi",
  slovakia: "sk",
  slovenia: "si",
  // — CONMEBOL —
  argentina: "ar",
  brazil: "br",
  uruguay: "uy",
  colombia: "co",
  chile: "cl",
  peru: "pe",
  ecuador: "ec",
  paraguay: "py",
  bolivia: "bo",
  venezuela: "ve",
  // — CONCACAF —
  usa: "us",
  "united states": "us",
  "united states of america": "us",
  mexico: "mx",
  canada: "ca",
  "costa rica": "cr",
  panama: "pa",
  honduras: "hn",
  jamaica: "jm",
  haiti: "ht",
  // — CAF —
  morocco: "ma",
  senegal: "sn",
  tunisia: "tn",
  cameroon: "cm",
  ghana: "gh",
  nigeria: "ng",
  algeria: "dz",
  egypt: "eg",
  "ivory coast": "ci",
  "cote divoire": "ci",
  "south africa": "za",
  mali: "ml",
  "cape verde": "cv",
  "cape verde islands": "cv",
  // — AFC —
  japan: "jp",
  "south korea": "kr",
  "korea republic": "kr",
  korea: "kr",
  australia: "au",
  "saudi arabia": "sa",
  iran: "ir",
  "ir iran": "ir",
  qatar: "qa",
  iraq: "iq",
  "united arab emirates": "ae",
  uae: "ae",
  uzbekistan: "uz",
  jordan: "jo",
  // — OFC —
  "new zealand": "nz",
};

/**
 * Flag emoji for a country/team name, or undefined when it isn't a country we
 * know (club teams, unknowns). Pass the team's display name.
 */
export function flagFor(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const v = COUNTRY[normalize(name)];
  if (!v) return undefined;
  // Stored either as an ISO alpha-2 ("fr") or a literal emoji (UK home nations).
  return /^[a-z]{2}$/.test(v) ? isoToFlag(v) : v;
}
