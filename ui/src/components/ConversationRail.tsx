/**
 * Conversation rail — UI_DESIGN.md §3.5 and §4 (empty state).
 *
 * 320px fixed, --board. Message history plus the composer. Assistant turns
 * are one paragraph of prose, and the prose never contains a number that is
 * not also in the verdict object.
 */
import { useEffect, useRef } from "react";
import { Send } from "lucide-react";

export interface Message {
  role: "you" | "advisor";
  text: string;
}

/** Four real questions — one per tier plus one out of scope — so the
 *  controller learns the range in five seconds. Not a logo and a tagline. */
export const EXAMPLES = [
  "Who is on reserve at BLR on 2026-09-15?",
  "Check duty legality for C-2087 with newDutyHours 9.5 on 2026-09-15.",
  "C-1042 is unavailable on 2026-09-15. Simulate impact and recommend a fallback.",
  "Follow-up: compare the top option against one cheaper backup.",
];

export function ConversationRail({
  messages,
  loading,
  onAsk,
}: {
  messages: Message[];
  loading: boolean;
  onAsk: (q: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focused on load, and "/" refocuses it from anywhere.
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "/" && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = inputRef.current?.value.trim();
    if (!v || loading) return;
    onAsk(v);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <aside
      className="rail flex h-full flex-col"
      style={{ width: "var(--rail-w)", background: "var(--board)" }}
    >
      <div className="px-4 py-3" style={{ borderBottom: "1px solid #3d454b" }}>
        <div className="text-14 font-medium" style={{ color: "#e8ebed" }}>
          Crew Ops Advisor
        </div>
        <div className="text-13" style={{ color: "#8f989e" }}>
          dCortex Air · BLR · 14–20 Sep 2026
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <div>
            <div className="mb-2 text-13" style={{ color: "#8f989e" }}>
              Try one of these
            </div>
            {EXAMPLES.map((q, i) => (
              <button
                key={q}
                onClick={() => onAsk(q)}
                className="mb-1.5 block w-full px-3 py-2 text-left text-13"
                style={{
                  background: "#39424892",
                  color: "#dfe3e6",
                  border: "1px solid #4a545b",
                  borderRadius: 2,
                }}
              >
                {q}
                {i === EXAMPLES.length - 1 && (
                  <span className="block" style={{ color: "#8f989e" }}>
                    shows a clean refusal
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i}>
              <div className="text-13" style={{ color: "#8f989e" }}>
                {m.role}
              </div>
              <div className="text-14" style={{ color: "#e8ebed" }}>
                {m.text}
              </div>
            </div>
          ))
        )}
      </div>

      <form
        onSubmit={submit}
        className="flex gap-2 p-3"
        style={{ borderTop: "1px solid #3d454b" }}
      >
        <input
          ref={inputRef}
          type="text"
          placeholder="Ask…  ( / to focus )"
          disabled={loading}
          className="min-w-0 flex-1 px-2 py-1.5 text-14"
          style={{
            background: "#232a2f",
            color: "#e8ebed",
            border: "1px solid #4a545b",
            borderRadius: 2,
          }}
        />
        <button
          type="submit"
          disabled={loading}
          aria-label="Ask"
          className="px-2"
          style={{
            background: "#4a545b",
            color: "#e8ebed",
            borderRadius: 2,
          }}
        >
          <Send size={14} aria-hidden />
        </button>
      </form>
    </aside>
  );
}
