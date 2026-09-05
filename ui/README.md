# ui/ — Crew Ops Advisor frontend

Vite + React 18 + TypeScript + Tailwind 3. No component library: the interface
is three custom surfaces and a kit would have cost more setup than it saved.

```bash
cd ui
npm install
npm run dev          # http://localhost:5173
```

## Run it without a backend

```
http://localhost:5173/?fixture=1
```

`?fixture=1` renders `fixtures/verdict_s2.json` directly and makes **no
network calls at all**. That is the mode to use today, because the backend
does not serve `POST /ask` yet — `src/api.ts` exposes per-tool routes and a
`/chat` stub, neither of which returns a `Verdict`.

`vite.config.ts` aliases `@fixtures` to the repo-root `fixtures/` directory,
so the UI and any future harness read the *same* file. No copy to drift.

When a real endpoint exists, the dev server proxies `/api/*` to
`http://localhost:3000` (start it with `npm start` from the repo root), so
there is no CORS configuration anywhere.

## What it renders

| Surface | What it does |
|---|---|
| `Header` | the situation line, and "28 considered · 4 legal · 19 excluded" |
| `Rack` | one `Strip` per legal option, in engine rank order |
| `Certificate` | 7 rule chips per candidate; click one for the full trace |
| `ExclusionPanel` | the rejects, grouped by failing rule with counts |
| `ConversationRail` | message history and the composer |

The design deliberately borrows from ops-room paper flight strips — wide, short,
hairline-separated, with a colour-coded left edge — and renders the rule trace
as fixed-width machine output, because that is what it is.

**Keyboard:** `/` focus input · `j`/`k` move between strips · `Enter` expand ·
`Esc` collapse.

**Colour is never alone.** Every pass/fail carries a glyph (`✓` `✕` `!`) and a
word, so the interface does not depend on distinguishing red from green.

## The contract

`src/types.ts` describes the `Verdict` the engine must return. Nothing in
`src/` builds one yet — see the note at the top of that file. Today it matches
`fixtures/verdict_s2.json` exactly.

When `recommendCover()` lands, the engine's return type and `src/types.ts`
must move in the same commit. A UI reading a field the engine stopped sending
fails silently, which is the worst way for this to break.

## Known gaps in the fixture

`fixtures/verdict_s2.json` is a real worked answer, but two things still
differ from the dataset's own answer key, and the UI is built to tolerate
them:

- it carries 4 options where the key has 6 — the C-2210 DEL deadhead
  (₹41,200) and the cancellation fallback (`crew_id: null`, ₹1,500,000)
- `RuleVerdict.inputs` is empty on the excluded candidates, so only the four
  legal options have a per-date breakdown to expand

The RULE-DUTY-02 arithmetic **was** wrong on all four legal options — the
per-date values named the wrong dates and did not sum to `actual`. It is now
recomputed from `duty_daily_history` and internally consistent, so expanding
a certificate shows working that checks out.

`pool_size` is 28 while options + excluded is 23. That is deliberate, and the
trace says so: five captains are not evaluated (the sick crew member himself
and three on leave — plus C-2210, who belongs in `options`, see above).

`Certificate` shows an explicit amber note rather than an empty grid when
`inputs` is missing. Build against a legal option (C-3310, C-5566) when you
need a fully populated trace.
