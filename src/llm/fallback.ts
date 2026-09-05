/**
 * The deterministic parser. No network, no model.
 *
 * This exists so a missing API key or a dead venue network degrades the
 * system from conversational to command-style rather than killing it. It
 * covers the shapes the 38 example questions actually use — it will not
 * understand a paraphrase the way Sarvam does, and that is the whole trade.
 *
 * It is also the only parser whose output is bit-reproducible, so it is what
 * the harness should use when scoring the engine rather than the model.
 */
export interface ParsedCall { tool: string; args: Record<string, unknown> }

const CREW = /\b(C-\d{4})\b/i;
const PAIRING = /\b(P-\d{4})\b/i;
const TAIL = /\b(VT-[A-Z]{3})\b/i;
const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/;
const STATION = /\b(BLR|DEL|BOM|HYD|CCU|MAA|GOI|PNQ|AMD|COK)\b/;
const SNAPSHOT = '2026-09-14';

/** "the 15th", "15 Sep", "tomorrow" -> an ISO date in the dataset's week. */
function findDate(q: string): string | null {
    const iso = q.match(ISO_DATE);
    if (iso) return iso[1];

    if (/\btomorrow\b/i.test(q)) return '2026-09-15';
    if (/\btoday\b|\btonight\b/i.test(q)) return SNAPSHOT;

    const dayMonth = q.match(/\b(\d{1,2})\s*(?:st|nd|rd|th)?\s*(?:of\s+)?(sep|september)\b/i);
    if (dayMonth) return `2026-09-${dayMonth[1].padStart(2, '0')}`;

    const theNth = q.match(/\bthe\s+(\d{1,2})\s*(?:st|nd|rd|th)\b/i);
    if (theNth) {
        const d = Number(theNth[1]);
        if (d >= 14 && d <= 20) return `2026-09-${String(d).padStart(2, '0')}`;
    }
    return null;
}

function hours(q: string): number | null {
    const m = q.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hour|hours)\b/i);
    if (m) return Number(m[1]);
    const mins = q.match(/\b(\d+)\s*(?:min|minute|minutes)\b/i);
    return mins ? Number(mins[1]) / 60 : null;
}

export function parseDeterministic(question: string): ParsedCall | null {
    const q = question.trim();
    const crew = q.match(CREW)?.[1]?.toUpperCase() ?? null;
    const pairing = q.match(PAIRING)?.[1]?.toUpperCase() ?? null;
    const tail = q.match(TAIL)?.[1]?.toUpperCase() ?? null;
    const date = findDate(q);
    const station = q.match(STATION)?.[1]?.toUpperCase() ?? null;

    // Out of scope, checked first so "weather at DEL" is not read as a lookup.
    if (/\bweather|forecast|ticket price|fare|visa|hotel booking|menu\b/i.test(q)) return null;

    // ---- Tier 3 / multi-vacancy
    if (/\bboth\b.*\bsick\b|\btwo\b.*\bcaptains?\b.*\bsick\b|simultaneous/i.test(q)) {
        return null;   // needs two pairing ids; ask rather than guess
    }

    // ---- station closure
    if (/\bclos(?:ed|ure|es)\b/i.test(q) && station && date) {
        const window = q.match(/(\d{2}):(\d{2})\s*[-–—to]+\s*(\d{2}):(\d{2})/);
        if (window) {
            return {
                tool: 'assessStationClosure',
                args: {
                    station,
                    startUtc: `${date}T${window[1]}:${window[2]}:00Z`,
                    endUtc: `${date}T${window[3]}:${window[4]}:00Z`,
                },
            };
        }
    }

    // ---- delay
    if (/\bdelay(?:ed)?\b/i.test(q) && tail && date) {
        const h = hours(q);
        if (h !== null) return { tool: 'assessDelay', args: { aircraft: tail, date, delayHours: h } };
    }

    // ---- recommendation
    if (crew && (/\bwhat should i do\b|\branked\b|\boptions\b|\brecommend|\bcheapest\b|\bresolve\b|\bfix\b/i.test(q))) {
        if (pairing) return { tool: 'recommendCover', args: { pairingId: pairing, vacancyCrewId: crew } };
    }

    // ---- legality of a specific cover
    if (crew && pairing && /\bcover|\bassign|\bmove|\blegal|\bbreach/i.test(q)) {
        return { tool: 'assessCandidate', args: { crewId: crew, pairingId: pairing, vacancyCrewId: crew } };
    }

    // ---- vacancy impact
    if (crew && date && /\bsick\b|\bunavailable\b|\bcalls? in\b|\bout\b|\buncrewed\b|\bbreaks?\b/i.test(q)) {
        return { tool: 'assessVacancy', args: { crewId: crew, date } };
    }

    // ---- Tier 1
    if (/\breserve|standby|on-?call\b/i.test(q) && date) {
        return { tool: 'getReservePool', args: { date, ...(station ? { base: station } : {}) } };
    }
    if (/\brisk\b/i.test(q) && crew) return { tool: 'getRiskSignals', args: { crewId: crew } };
    if (/\bcertification|cert|expir/i.test(q) && date) {
        const within = q.match(/\b(\d+)\s*days?\b/i);
        const days = within ? Number(within[1]) : 30;
        const to = new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000)
            .toISOString().slice(0, 10);
        return { tool: 'getExpiringCertifications', args: { dateFrom: date, dateTo: to } };
    }
    if (/\bduty hours|headroom|accrued|how many hours\b/i.test(q) && crew) {
        return { tool: 'getDutyHours', args: { crewId: crew } };
    }
    if (/\b(\d+)\s*or more\b|\bat least\s*(\d+)\b/i.test(q) && date) {
        const n = Number(q.match(/\b(\d+)\s*or more\b/i)?.[1] ?? q.match(/\bat least\s*(\d+)\b/i)?.[1]);
        if (!Number.isNaN(n)) return { tool: 'getCrewAboveDutyThreshold', args: { onDate: date, atLeastHours: n } };
    }
    if (pairing) return { tool: 'getPairing', args: { pairingId: pairing } };
    if (tail && date) return { tool: 'getPairing', args: { aircraft: tail, date } };
    if (/\bhow many flights|longest|nonstop|stations\b/i.test(q)) {
        return {
            tool: 'getNetworkStats',
            args: { ...(date ? { date } : {}), ...(/\bfrom\s+BLR\b/i.test(q) ? { fromStation: 'BLR' } : {}) },
        };
    }
    if (/\bflights?\b/i.test(q) && date) {
        const dep = q.match(/\bfrom\s+([A-Z]{3})\b/)?.[1] ?? (/\bdepart/i.test(q) ? station : null);
        const arr = q.match(/\bto\s+([A-Z]{3})\b/)?.[1] ?? null;
        return { tool: 'getFlights', args: { date, ...(dep ? { depStation: dep } : {}), ...(arr ? { arrStation: arr } : {}) } };
    }
    if (crew) return { tool: 'getCrew', args: { crewId: crew } };

    return null;
}
