/**
 * App shell — UI_DESIGN.md §2 (layout) and §6 (component tree).
 *
 * Left rail for conversation, main area for the answer. Not three columns:
 * at 1440px three columns gives you three cramped ones, and the certificate
 * needs horizontal room for its date columns.
 */
import { ConversationRail } from "./components/ConversationRail";
import { TieredResponse } from "./components/TieredResponse";
import { useChat } from "./api";

export default function App() {
  const { messages, turns, loading, error, ask } = useChat();
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return (
    <div className="flex h-full">
      <ConversationRail
        messages={messages}
        loading={loading}
        onAsk={(q) => void ask(q)}
      />

      <main className="flex-1 overflow-y-auto px-8 py-6">
        {error && (
          <div style={{ color: "var(--breach)", maxWidth: "70ch" }}>
            <div className="font-medium">The request did not complete.</div>
            <div className="mt-1 text-14">{error}</div>
          </div>
        )}

        <TieredResponse
          turn={latestTurn}
          loading={loading}
          onFollowUp={(prompt) => void ask(prompt)}
        />
      </main>
    </div>
  );
}
