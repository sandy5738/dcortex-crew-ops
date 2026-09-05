/**
 * The rack — UI_DESIGN.md §3.2.
 *
 * One strip per legal option, in the engine's ranked order. Under it, the
 * ranking key printed verbatim: nobody else shows their tiebreak, so we do.
 *
 * Keyboard: j/k move between strips, Enter expands, Esc collapses. A
 * controller under pressure does not reach for a mouse.
 */
import { useEffect, useRef, useState } from "react";
import { Strip, StripHeader } from "./Strip";
import type { Candidate } from "../types";

export function Rack({
  options,
  rankingKey,
  onChoose,
}: {
  options: Candidate[];
  rankingKey: string;
  onChoose?: (c: Candidate) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (options.length === 0) return;

      if (e.key === "j") {
        setCursor((c) => Math.min(c + 1, options.length - 1));
      } else if (e.key === "k") {
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === "Enter") {
        const c = options[cursor];
        if (c) toggle(c);
      } else if (e.key === "Escape") {
        setOpenId(null);
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [options, cursor]);

  function toggle(c: Candidate) {
    const next = openId === c.crew_id ? null : c.crew_id;
    setOpenId(next);
    // Expanding a strip is the controller expressing a preference. That is
    // exactly what the ledger wants to know (SPEC.md §6.6).
    if (next && onChoose) onChoose(c);
  }

  if (options.length === 0) {
    return (
      <div
        className="px-4 py-6 text-14"
        style={{ background: "var(--board)", color: "#c8cdd1" }}
      >
        No legal option found. Every candidate of this rank breached at least
        one rule — open the exclusion panel to see which.
      </div>
    );
  }

  return (
    <div ref={ref}>
      <div className="pt-3" style={{ background: "var(--board)" }}>
        <StripHeader />
        <div className="px-1.5 pb-1.5">
          {options.map((c, i) => (
            <Strip
              key={c.crew_id}
              candidate={c}
              open={openId === c.crew_id}
              cursor={i === cursor}
              onToggle={() => {
                setCursor(i);
                toggle(c);
              }}
            />
          ))}
        </div>
      </div>

      {/* The sentence no other team can say. */}
      <div className="mt-2 text-13" style={{ color: "var(--ink-2)" }}>
        {rankingKey}
      </div>
    </div>
  );
}
