# ui/ — Crew Ops Advisor · Crew Control deck

Vite + React 18 + TypeScript + Tailwind 3, one dark aerospace ops-room theme.
No component library: every surface is a strip, because controllers read strips.

```bash
# repo root — start the deterministic + agent backend (port 3000)
npm start

# here — start the deck (port 5173)
npm install
npm run dev          # http://localhost:5173
```

The Vite dev server proxies `/api/*` → `http://localhost:3000`, so there is
no CORS configuration anywhere.

## The two surfaces

| Surface | What it does | Backend |
|---|---|---|
| **OpsDeck** (left) | Situation wall: 7-day date bar, flights board with per-flight crew, reserve pool with on-call windows, duty-clock watchlist with 75%/90% bands, disruption-risk board, certification alerts | `GET /api/ops/snapshot` — pure SQL, no LLM |
| **ChatPanel** (right) | The advisor: plain-language questions, markdown answers with tables, ranked Tier-3 option cards, collapsible reasoning trail per tool call, six worked disruption scenarios | `POST /api/chat` |

They are one workflow: **clicking any deck row injects a grounded prompt into
the chat** (a flight strip, a risky crew member, a duty-clock row, a reserve,
a cert alert). The deck answers "what is happening"; the advisor answers
"what should I do about it".

## The chat, specifically

- Answers render as markdown — headings, bold, bullets, and the pipe tables
  the model emits for lookups, rendered by a hand-written parser
  (`src/markdown.tsx`, zero new dependencies).
- **Reasoning trail is first-class.** Every assistant turn lists its tool
  calls, tiered (1 = lookup, 2 = legality, 3 = impact), each expandable to
  the exact arguments and the deterministic result. Explainability is a
  hackathon requirement, so it is never hidden behind a debug drawer.
- Tier-3 replacement answers arrive as JSON options and render as ranked
  cards: action, legal status, cost (₹), coverage, rule chips.
- **Drill scenarios** button loads the dataset's six worked disruptions
  (S1–S6, sick calls, station closure, delay cascade, cert lapse,
  simultaneous sick calls) as one-click prompts.
- Multi-turn: history (last 20 messages) is sent with each request.

## Design rules

- Colour is a verdict, never decoration: green pass / amber marginal /
  red breach — and every state also carries a glyph (✓ ! ✕) and a word.
- Depth by tone, not shadow. Nothing in this app casts one.
- Numbers use tabular figures, so columns align on the decimal point.
- `/` focuses the composer from anywhere.

## Legacy note

`src/api.ts`, `src/types.ts` and the verdict-mode components
(`Strip`, `Rack`, `Certificate`, `ExclusionPanel`, `Header`,
`ConversationRail`, `TieredResponse`) belong to the earlier fixture-driven
prototype and are unused by this deck. They are kept for their history and
removed from the bundle automatically — nothing imports them.
