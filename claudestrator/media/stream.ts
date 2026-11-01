// What the task screen keeps of an agent's streamed output, apart from the page so it is tested on its own.
// Exposes window.liveTexts() and window.loadedEdge(items).
(function () {
  /**
   * The text of the message each step's agent is writing, from the pieces the page got. The page knows a message from
   * its start only after an item that ends one (its whole text, a tool call or result, the end of a turn) or starts one
   * (thinking). Pieces before that belong to a message it missed the start of (it came to the task, or was reloaded,
   * while the agent wrote): `null`, a placeholder until the message's whole text arrives, not a fragment.
   */
  function liveTexts(): LiveTexts {
    const texts = new Map<string, string | null>();
    const followed = new Set<string>();
    return {
      take(key, item) {
        if (item.type === 'text_delta') {
          const so = texts.get(key);
          if (typeof so === 'string') texts.set(key, so + item.text);
          else if (so === undefined) texts.set(key, followed.has(key) ? item.text : null);
        } else if (item.type === 'thinking') {
          followed.add(key);
          texts.set(key, '');
        } else if (item.type !== 'usage' && item.type !== 'user') {
          // What you send it while it writes (`user`) leaves its message going on.
          followed.add(key);
          texts.delete(key);
        }
      },
      writing: (key) => texts.get(key),
    };
  }

  /**
   * Which pushed items a transcript just loaded holds already. The host posts streamed items in batches, so one written
   * just before the transcript was read may arrive after it. An item written before the transcript's last one is in it;
   * of those written in the same millisecond as the last, only the ones it holds (compared whole): another item can be
   * written in that millisecond after the read. Pieces of text and thinking never go to a transcript.
   */
  function loadedEdge(items: TranscriptItem[]): LoadedEdge {
    const until = items.reduce((t, i) => Math.max(t, i.t ?? 0), 0);
    const last = items.filter((i) => i.t === until).map((i) => JSON.stringify(i));
    return {
      has(item) {
        if (item.t === undefined || item.t > until || item.type === 'text_delta' || item.type === 'thinking' || item.type === 'usage') return false;
        if (item.t < until) return true;
        const i = last.indexOf(JSON.stringify(item));
        if (i === -1) return false;
        last.splice(i, 1);
        return true;
      },
    };
  }

  window.liveTexts = liveTexts;
  window.loadedEdge = loadedEdge;
})();
