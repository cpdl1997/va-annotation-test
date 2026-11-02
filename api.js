// Backend clients. Both expose the same interface:
//   start(ctx)  -> {playlist_id, answers:{trial_id:{choice}}, status:"active"|"finished", code?}
//   answer(rec) -> queued; resolves immediately, delivery is retried in the background
//   pending()   -> number of unsent answers;  onStatus(cb) -> cb({pending, online})
//   finish(opts)-> {ok, code?, missing?}
// "worker" talks to the Cloudflare Worker (production). "local" keeps everything in the browser (dev only).
(function () {
  const S = window.STUDY;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked: memory only */ } };
  const cid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  async function postJson(path, body, timeoutMs = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(S.WORKER_URL + path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: ctl.signal
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; e.body = j; throw e; }
      return j;
    } finally { clearTimeout(t); }
  }

  // retry on network errors, 429 and 5xx; give up immediately on other 4xx
  async function withRetry(fn, tries = 6) {
    let delay = 600;
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        const retriable = !e.status || e.status === 429 || e.status >= 500;
        if (!retriable || i >= tries - 1) throw e;
        await sleep(delay + Math.random() * 300);
        delay = Math.min(delay * 2, 8000);
      }
    }
  }

  // Unsent answers survive a reload (localStorage) and are flushed in order with backoff.
  class Queue {
    constructor(key, send) {
      this.key = key; this.send = send; this.items = lsGet(key) || [];
      this.cbs = []; this.online = true; this.running = false;
    }
    onStatus(cb) { this.cbs.push(cb); cb(this.status()); }
    status() { return { pending: this.items.length, online: this.online }; }
    emit() { this.cbs.forEach((cb) => cb(this.status())); }
    push(item) { this.items.push(item); lsSet(this.key, this.items); this.emit(); this.run(); }
    async run() {
      if (this.running) return;
      this.running = true;
      let delay = 800;
      while (this.items.length) {
        try {
          await this.send(this.items[0]);
          this.items.shift(); lsSet(this.key, this.items);
          this.online = true; delay = 800; this.emit();
        } catch (e) {
          if (e.status === 425) {   // server: answered too early, retry after the stated wait (not an outage)
            await sleep(Math.min(Number(e.body && e.body.wait_ms) || 1000, 8000) + 250); continue;
          }
          if (e.status && e.status !== 429 && e.status < 500) {   // permanent rejection: drop it, keep going
            console.warn("answer rejected", e.status, e.message);
            this.items.shift(); lsSet(this.key, this.items); this.emit(); continue;
          }
          this.online = false; this.emit();
          await sleep(delay); delay = Math.min(delay * 2, 10000);
        }
      }
      this.running = false; this.emit();
    }
    async drain(timeoutMs = 60000) {
      const t0 = Date.now();
      this.run();
      while (this.items.length && Date.now() - t0 < timeoutMs) await sleep(250);
      return this.items.length === 0;
    }
  }

  // ---------------------------------------------------------------- worker
  function workerBackend(session) {
    let token = null;
    const q = new Queue("pq_" + session.pid, async (it) => {
      try { return await postJson("/answer", { token, ...it }); } catch (e) {
        if (e.status === 409 && /not shown/.test(e.message)) {   // the earlier /shown never arrived: report it now, then wait out the gate
          await postJson("/shown", { token, trial_id: it.trial_id });
          const w = new Error("too early"); w.status = 425; w.body = { wait_ms: 7000 }; throw w;
        }
        throw e;
      }
    });
    return {
      onStatus: (cb) => q.onStatus(cb),
      pending: () => q.items.length,
      async start() {
        const r = await withRetry(() => postJson("/start", {
          pid: session.pid, study_id: session.study_id, session_id: session.session_id,
          set: S.PLAYLIST_SET, client: session.client
        }));
        token = r.token; q.run();
        return r;
      },
      answer(rec) { q.push({ cid: cid(), ...rec }); },
      shown(trial_id) { if (token) withRetry(() => postJson("/shown", { token, trial_id }, 8000), 4).catch(() => {}); },   // best effort; /answer repairs a miss
      heartbeat() { if (token) postJson("/heartbeat", { token }, 8000).catch(() => {}); },
      async finish(opts = {}) {
        if (!(await q.drain())) return { ok: false, error: "unsent answers", missing: [] };
        try { return await withRetry(() => postJson("/finish", { token, early: !!opts.early })); }
        catch (e) { return { ok: false, error: e.message, missing: (e.body && e.body.missing) || [] }; }
      }
    };
  }

  // ----------------------------------------------------------------- local (dev)
  function localBackend(session) {
    const q = new URLSearchParams(location.search);
    const playlist_id = Number(q.get("playlist") || 100);
    const key = "local_" + session.pid + "_" + playlist_id;
    let st = lsGet(key) || { events: [] };
    const answers = () => {
      const a = {};
      st.events.forEach((e) => { a[e.trial_id] = { choice: e.choice }; });
      return a;
    };
    const cbs = [];
    return {
      onStatus: (cb) => { cbs.push(cb); cb({ pending: 0, online: true }); },
      pending: () => 0,
      async start() { return { token: "local", playlist_id, status: "active", answers: answers() }; },
      answer(rec) { st.events.push({ cid: cid(), t: Date.now(), ...rec }); lsSet(key, st); },
      shown() {},
      heartbeat() {},
      async finish(opts = {}) {
        console.log("LOCAL FINISH", { early: !!opts.early, events: st.events.length });
        window.__localResult = st;
        return { ok: true, code: "LOCAL", early: !!opts.early };
      }
    };
  }

  window.makeBackend = (session) => (S.BACKEND === "worker" ? workerBackend(session) : localBackend(session));
})();
