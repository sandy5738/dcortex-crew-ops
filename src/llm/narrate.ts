/**
 * The template narrator. No model.
 *
 * Always produced, even when Sarvam is available — it is the prose the caller
 * falls back to if narration fails, so it is never a cold path. Numbers are
 * read from the verdict, never recomputed, which is the same contract the LLM
 * narrator is held to.
 */
import type { UiVerdict } from '../verdict';

const inr = (n: number) => '₹' + n.toLocaleString('en-IN');

export function narrateTemplate(tool: string, v: UiVerdict): string {
    // ---- a ranked recommendation
    if (v.options.length > 0 && v.ranking_key) {
        const top = v.options[0];
        const cost = (top.cost as any)?.total_inr;
        const im = v.impact;

        const situation = im?.pairing_id
            ? `${im.pairing_id} is uncovered: ${im.uncovered_flights_day1.length} leg(s) on day one` +
              (im.passengers_at_risk_day1 ? ` with ${im.passengers_at_risk_day1} passengers at risk` : '') +
              (im.uncovered_flights_later.length ? `, and ${im.uncovered_flights_later.length} more at risk on later days` : '') + '. '
            : '';

        const pick = `Cheapest legal cover is ${top.rank} ${top.crew_id}` +
            (top.name ? ` (${top.name})` : '') +
            (cost !== undefined ? ` at ${inr(cost)}` : '') +
            ` — ${top.source} callout, ${top.coverage}. `;

        const search = `${v.pool_size} candidates considered, ${v.options.length} legal, ${v.excluded.length} excluded. `;

        const notable = v.excluded.find(e => /RULE-DUTY-02/.test(e.reasoning));
        const why = notable
            ? `${notable.crew_id} was rejected — ${notable.reasoning.replace(/\.$/, '')}.`
            : '';

        return (situation + pick + search + why).trim();
    }

    // ---- one candidate assessed
    if (v.intent_kind === 'LegalityCheck') {
        const c = v.options[0] ?? v.excluded[0];
        if (!c) return 'No assessment available.';
        if (c.legal) {
            const cost = (c.cost as any)?.total_inr;
            return `${c.rank} ${c.crew_id} can legally cover it — all seven rules pass` +
                (cost !== undefined ? `, at ${inr(cost)}` : '') + '.';
        }
        const failed = c.verdicts.filter(x => !x.passed);
        return `${c.rank} ${c.crew_id} cannot cover it. ` +
            failed.map(f => `${f.rule_id}: ${f.detail.replace(/^Violation\.\s*/, '')}`).join(' ');
    }

    // ---- a refusal-shaped empty result
    if (v.rows.length === 0) return 'No matching records.';

    // ---- tabular lookups
    const n = v.rows.length;
    const first = v.rows[0] as Record<string, unknown>;

    if (tool === 'assessDelay') {
        return v.rows.map((r: any) =>
            `${r.pairing_id}: duty runs ${r.fdp_after_delay}h after the delay against a ${r.fdp_limit}h limit ` +
            `(${r.sectors} sectors) — ${r.breach ? 'a RULE-FDP-01 breach' : 'still legal'}.`).join(' ');
    }

    if (tool === 'assessStationClosure') {
        const breaching = (first as any).breaching_pairings?.length ?? 0;
        const affected = (first as any).affected_flights?.length ?? 0;
        return `The closure blocks ${affected} flight(s) across ` +
            `${(first as any).pairings_affected?.length ?? 0} pairings. ` +
            `${breaching} pairing(s) exceed their FDP limit once the delay lands and need re-crewing or cancellation.`;
    }

    if (tool === 'planJointCover') {
        const o = (first as any).optimal;
        if (!o) return 'No assignment covers every vacancy.';
        return `Optimal joint plan costs ${inr(o.total_cost_inr)}: ` +
            o.assignments.map((a: any) => `${a.crew_id} on ${a.pairing_id} (${inr(a.cost_inr)})`).join(', ') + '.';
    }

    if (tool === 'assessVacancy') {
        const f = first as any;
        return f.error ? String(f.error)
            : `${f.disruption ?? 'Vacancy'} ${f.pairing_broken ? `Pairing ${f.pairing_broken} is broken.` : ''}`.trim();
    }

    if (tool === 'getEarliestNextReport') {
        return String((first as any).detail ?? '');
    }

    // Generic: name the columns rather than dumping the rows, since the UI
    // renders the table itself.
    const cols = Object.keys(first).slice(0, 4).join(', ');
    return `${n} record${n === 1 ? '' : 's'} found (${cols}).`;
}
