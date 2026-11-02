// Page flow: device gate -> consent -> instructions -> start (backend) -> trials -> finish -> Prolific.
(async function () {
  const S = window.STUDY;
  const q = new URLSearchParams(location.search);
  const dev = S.ALLOW_DEV && q.get("dev") === "1";
  if (S.ALLOW_DEV) {   // dev-only overrides for local testing; never honoured in the production build
    if (q.get("local") === "1") S.BACKEND = "local";
    if (q.get("worker")) { S.BACKEND = "worker"; S.WORKER_URL = q.get("worker"); }
    if (q.get("videos")) S.VIDEO_BASE_URL = q.get("videos");
    if (q.get("plbase")) S.PLAYLIST_BASE = q.get("plbase");
    if (q.get("set")) S.PLAYLIST_SET = q.get("set");
  }
  const root = document.getElementById("root");
  const esc = (x) => String(x == null ? "" : x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const message = (html) => { root.innerHTML = `<div class="page">${html}</div>`; };
  const page = (html, label) => new Promise((res) => {
    root.innerHTML = `<div class="page">${html}<div class="actions"><button class="primary" id="go">${esc(label)}</button></div></div>`;
    root.querySelector("#go").onclick = () => res();
  });

  let pid = q.get("PROLIFIC_PID") || (dev && S.BACKEND === "local" ? "dev_local" : "");
  const valid = /^[0-9a-f]{24}$/i.test(pid) || (dev && /^(dev|test)/i.test(pid));
  if (!valid) { message("<h2>Please open this study from Prolific.</h2><p>The link needs your Prolific ID, which is added automatically when you start the study there.</p>"); return; }
  if (window.innerWidth < S.MIN_WIDTH || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    message("<h2>Please open this study on a desktop or laptop computer with a larger window, then reopen it from Prolific.</h2>"); return;
  }

  const session = {
    pid, study_id: q.get("STUDY_ID") || "", session_id: q.get("SESSION_ID") || "",
    client: { ua: navigator.userAgent, screen: [screen.width, screen.height], dpr: window.devicePixelRatio, webdriver: !!navigator.webdriver }
  };
  const api = makeBackend(session); session.api = api;

  await page(`<h2>Information and consent</h2>
    <p><b>Purpose.</b> This is a research study on how people judge the quality of AI-edited videos. You will compare pairs of edited videos made from the same source video and an editing instruction, and choose which edit is better.</p>
    <p><b>What you will do.</b> Watch short video clips and answer a few simple questions for each comparison, on a desktop or laptop computer. The study takes roughly 15 minutes.</p>
    <p><b>Your data.</b> We record your Prolific ID, your answers, the time you take, and basic technical information about your browser and screen. We do not record audio, video or images of you. Your data is stored securely, used only for research, and your Prolific ID is removed or replaced by a code before any results are shared or published.</p>
    <p><b>Voluntary participation.</b> You must be 18 or older. Taking part is voluntary and you may stop at any time by closing this window; payment follows Prolific's rules for partial or incomplete submissions. There are no known risks beyond those of ordinary computer use. The videos are everyday scenes and are not intended to be disturbing.</p>
    <p><b>Questions.</b> Contact the research team through Prolific messaging.</p>
    <p>By clicking the button below you confirm that you are 18 or older, have read this information, and agree to take part.</p>`, "I agree and continue");
  await page(`<h2>Instructions</h2>
    <p>Each trial shows an original <b>source video</b>, an <b>editing instruction</b>, and two edited versions, <b>Video A</b> and <b>Video B</b>.
    The three videos start together and loop in sync. Watch them for a few seconds, then choose which edited video is better overall:
    it follows the instruction, keeps the rest of the source video intact, and looks natural and clean.</p>
    <ul><li>Use <b>Video size</b> to make the videos larger or smaller.</li>
    <li>The numbered buttons at the top let you go back to any earlier trial and change your answer before you submit.</li>
    <li>If your connection drops, your answers so far are kept: reopen the link from Prolific and you will continue where you stopped.</li>
    <li>Some trials check your attention; follow their on-screen instructions exactly.</li></ul>`, "Start");

  message("<p>Loading…</p>");
  let started;
  try { started = await api.start(); } catch (e) { message("<h3>Could not start the study (" + esc(e.message) + "). Please reload, or contact the researcher.</h3>"); return; }
  const done = (code, extra) => {
    const redirect = code && S.BACKEND === "worker" && !dev && S.PLAYLIST_SET === "main";
    const tail = redirect ? "<p>Returning you to Prolific…</p>"
      : dev || S.PLAYLIST_SET !== "main" ? "<p>(Dev/test run: no redirect to Prolific.)</p>"
      : "<p>Your answers were saved, but the completion code could not be issued automatically. Please message the researcher on Prolific.</p>";
    message(`<h2>Thank you!</h2><p>${extra || "Your answers have been saved."}</p>${tail}`);
    if (redirect) setTimeout(() => { window.location.href = "https://app.prolific.com/submissions/complete?cc=" + encodeURIComponent(code); }, 1500);
  };
  if (started.status === "finished") { done(started.code, "You have already completed this study."); return; }

  let list;
  try {
    const r = await fetch(S.PLAYLIST_BASE + started.playlist_id + ".json");
    if (!r.ok) throw new Error("playlist " + started.playlist_id + " HTTP " + r.status);
    list = await r.json();
  } catch (e) { message("<h3>Could not load the study (" + esc(e.message) + "). Please contact the researcher.</h3>"); return; }

  const trials = window.__orderTrials(list, pid + "|" + started.playlist_id);
  // test page only (dev tools on): ?n=<k> keeps the first k trials, and submit then counts as an early finish
  const nLimit = dev ? parseInt(q.get("n"), 10) : NaN;
  if (nLimit > 0 && nLimit < trials.length) {
    // not just the first k: take one of each kind first (attention, golden, a new pair with a content question, then a
    // repeat together with its original), then more new pairs; keep the shuffled order
    const kind = (k) => trials.filter((t) => t.kind === k);
    const pick = new Set();
    const group = (...ts) => { const ids = ts.filter(Boolean).map((t) => t.id).filter((id) => !pick.has(id));
      if (ids.length && pick.size + ids.length <= nLimit) ids.forEach((id) => pick.add(id)); };
    const news = kind("new"), rep = kind("repeat")[0];
    group(kind("attention")[0]); group(kind("golden")[0]);
    group(news.find((t) => (t.probes || []).some((p) => p.role === "known")) || news[0]);
    if (rep) group(trials.find((t) => t.id === rep.repeat_of), rep);
    news.forEach((t) => group(t));
    const sub = trials.filter((t) => pick.has(t.id));
    trials.splice(0, trials.length, ...sub);
  }
  session.answers = started.answers || {};
  root.innerHTML = "";
  window.startRunner({
    container: root, trials, api, session, dev, earlyOk: nLimit > 0 && nLimit < list.length, videoBase: S.VIDEO_BASE_URL,
    onFinished: (res, info) => done(res.code, info.early ? `Dev early submit: ${info.answered} of ${info.total} answered.` : ""),
  });
})();
