// What the task screen keeps of an agent's streamed output, apart from the page so it is tested on its own.
// Exposes window.loadedEdge(items).
(function () {
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

  window.loadedEdge = loadedEdge;
})();
