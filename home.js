// Home: one game per page (Tic Tac Cube · Word Cube · Cube Pop), like the iOS carousel.
// Each page: a live 3-D preview, the name, then the same stack of options:
// size → playing alone → [Invite | Same device] → small links. "Your games" lists every
// game with a friend from this browser, with whose turn it is.
import { createPreview } from "./preview.js";
import { hexOf, PALETTE, SIZES, sortEvents, resolveColors, fold, roleOf as tttRole } from "./game.js";
import { makeBook, progressKey } from "./wordcube.js";
import { foldMatch, boardIndex, roleOf as wordRole } from "./wordmatch.js";
import { foldPop, roleOf as popRole } from "./popmatch.js";
import { dayIndex } from "./popgame.js";
import { cloudSetup, queryGame, saveEvent } from "./cloud.js";

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const newGameId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const sizeOf = (key) => { const n = Number(store.get(key)); return SIZES.includes(n) ? n : 4; };
const other = (r) => (r === "X" ? "O" : "X");
const PAGES = ["ttt", "words", "pop"];
const SIZE_KEY = { ttt: "ttc.size", words: "ttc.wsize", pop: "ttc.psize" };

/* ── word book (lazy: only for the Word Cube preview, today's progress, and Word games) ── */
let bookPromise = null;
const loadBook = () => (bookPromise ??= fetch("puzzles.json").then((r) => r.json()).then(makeBook).catch(() => null));

export function initHome({ sound, setSoundOn, onPieces, pieceOptions, pieceStyle }) {
  $("home").hidden = false;
  document.documentElement.style.setProperty("--me", hexOf(store.get("ttc.color") || "coral"));

  /* ── previews ── */
  const color = () => store.get("ttc.color") || "coral";
  const previews = {};
  document.querySelectorAll(".hc-page").forEach((page) => {
    const game = page.dataset.game;
    previews[game] = createPreview(page.querySelector(".hc-canvas"), game, {
      color: color(),
      getWordPuzzle: async (n) => { const b = await loadBook(); return b?.puzzle({ size: n, index: 0 }); },
    });
    previews[game].setSize(sizeOf(SIZE_KEY[game]));
  });

  /* ── per-page options ── */
  function segPicker(fieldset, name, options, selected, onChange) {
    fieldset.querySelector(".seg-track")?.remove();
    const track = document.createElement("div");
    track.className = "seg-track";
    fieldset.append(track);
    for (const [value, text] of options) {
      const label = document.createElement("label");
      label.className = "seg-opt";
      const input = document.createElement("input");
      input.type = "radio"; input.name = name; input.value = value; input.checked = String(value) === String(selected);
      input.addEventListener("change", () => onChange(value));
      const span = document.createElement("span");
      span.textContent = text;
      label.append(input, span);
      track.append(label);
    }
  }
  const TAG = { 3: "Three", 4: "Four", 5: "Five" };
  function syncLinks() {
    const t = sizeOf("ttc.size"), w = sizeOf("ttc.wsize"), p = sizeOf("ttc.psize");
    $("tttTag").textContent = `${TAG[t]} in a row, in any direction.`;
    $("wPractice").href = `words.html?b=p${w}-${Math.max(0, Number.parseInt(store.get(`ttc.wc-pi${w}`) || "0", 10) || 0)}`;
    $("wLocal").href = `words.html?w=local&size=${w}`;
    $("pMoves").href = `pop.html?m=moves&size=${p}`;
    $("pLocal").href = `pop.html?p=local&size=${p}`;
    $("pZen").href = `pop.html?m=zen&size=${p}`;
    const best = Number(store.get(`ttc.popbest.d${dayIndex()}`) || 0);
    $("pDailyDetail").textContent = best > 0 ? `Best ${best}` : "4×4×4 · daily";
  }
  document.querySelectorAll(".hc-size").forEach((fs) => {
    const game = fs.dataset.sizeFor;
    segPicker(fs, `size-${game}`, SIZES.map((n) => [n, `${n}×${n}×${n}`]), sizeOf(SIZE_KEY[game]), (n) => {
      store.set(SIZE_KEY[game], n);
      previews[game].setSize(n);
      syncLinks();
      sound.tick?.();
    });
  });
  syncLinks();
  loadBook().then((book) => {
    if (!book) return;
    const day = book.today();
    let prog = null;
    try { prog = JSON.parse(store.get(progressKey({ daily: day })) || "null"); } catch {}
    const total = book.puzzle({ daily: day })?.wordCount ?? 0;
    if (prog?.found?.length) $("wDailyDetail").textContent = `${prog.found.length}/${total} words`;
  });
  $("tttInvite").addEventListener("click", () => { location.href = `?g=${newGameId()}&host=${sizeOf("ttc.size")}`; });
  $("wInvite").addEventListener("click", () => { location.href = `words.html?w=${newGameId()}&host=${sizeOf("ttc.wsize")}`; });
  $("pInvite").addEventListener("click", () => { location.href = `pop.html?p=${newGameId()}&host=${sizeOf("ttc.psize")}`; });

  /* ── carousel ── */
  const track = $("hcTrack");
  const dots = [...document.querySelectorAll(".hc-dots button")];
  const params = new URLSearchParams(location.search);
  const wanted = PAGES.indexOf(params.get("page") ?? "");
  let current = wanted >= 0 ? wanted : Math.min(2, Math.max(0, Number(store.get("ttc.homePage")) || 0));
  if (wanted >= 0) history.replaceState(null, "", location.pathname);
  const pageW = () => track.clientWidth || innerWidth;
  function setCurrent(i, fromScroll = false) {
    i = Math.max(0, Math.min(PAGES.length - 1, i));
    if (!fromScroll) {
      const left = i * pageW();
      track.scrollTo({ left, behavior: reduceMotion ? "auto" : "smooth" });
      // Smooth scrolling can be skipped (background tabs, some browsers): make sure we land.
      setTimeout(() => { if (Math.abs(track.scrollLeft - left) > 2) track.scrollTo({ left, behavior: "auto" }); }, 450);
    }
    if (i === current && fromScroll) return;
    current = i;
    store.set("ttc.homePage", i);
    dots.forEach((d, k) => { d.setAttribute("aria-current", String(k === i)); });
    PAGES.forEach((g, k) => previews[g].setActive(k === i));
    document.querySelectorAll(".hc-page").forEach((p, k) => p.inert = k !== i);
    if (fromScroll) { sound.tick?.(); try { navigator.vibrate?.(4); } catch {} }
  }
  requestAnimationFrame(() => {
    track.scrollTo({ left: current * pageW(), behavior: "auto" });
    dots.forEach((d, k) => d.setAttribute("aria-current", String(k === current)));
    PAGES.forEach((g, k) => previews[g].setActive(k === current));
    document.querySelectorAll(".hc-page").forEach((p, k) => p.inert = k !== current);
  });
  let st = 0;
  track.addEventListener("scroll", () => {
    clearTimeout(st);
    st = setTimeout(() => setCurrent(Math.round(track.scrollLeft / pageW()), true), 60);
  }, { passive: true });
  dots.forEach((d, k) => d.addEventListener("click", () => setCurrent(k)));
  addEventListener("keydown", (e) => {
    if ($("settingsDialog").open || !$("gamesSheet").hidden) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") { e.preventDefault(); setCurrent(current + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setCurrent(current - 1); }
  });
  addEventListener("resize", () => track.scrollTo({ left: current * pageW(), behavior: "auto" }));

  /* ── sound + settings ── */
  const setToggle = (id, on) => $(id).setAttribute("aria-pressed", String(on));
  const soundOn = () => store.get("ttc.sound") !== "0";
  setToggle("hcSound", soundOn());
  $("hcSound").addEventListener("click", () => {
    const v = !soundOn(); store.set("ttc.sound", v ? "1" : "0"); setSoundOn(v);
    setToggle("hcSound", v); setToggle("homeSound", v);
    $("hcSound").setAttribute("aria-label", v ? "Sound on" : "Sound off");
  });
  function swatchPicker(fieldset, name, selected, onChange) {
    fieldset.querySelectorAll("label").forEach((l) => l.remove());
    for (const [key, hex] of PALETTE) {
      const label = document.createElement("label");
      label.className = "swatch";
      label.style.setProperty("--sw", hex);
      label.title = key[0].toUpperCase() + key.slice(1);
      const input = document.createElement("input");
      input.type = "radio"; input.name = name; input.value = key; input.checked = key === selected;
      input.setAttribute("aria-label", label.title);
      input.addEventListener("change", () => onChange(key));
      label.append(input);
      fieldset.append(label);
    }
  }
  const color2 = () => { const c = store.get("ttc.color2"); return c && c !== color() ? c : resolveColors(color(), "teal").O; };
  const paint2 = () => {
    for (const input of $("homeSwatches2").querySelectorAll("input")) {
      input.checked = input.value === color2();
      input.disabled = input.value === color();
      input.closest(".swatch").style.opacity = input.disabled ? 0.3 : "";
    }
  };
  $("hcSettingsBtn").addEventListener("click", () => {
    $("homeName").value = store.get("ttc.name") || "";
    $("homeName2").value = store.get("ttc.name2") || "";
    swatchPicker($("homeSwatches"), "homeColor", color(), (c) => {
      store.set("ttc.color", c);
      document.documentElement.style.setProperty("--me", hexOf(c));
      previews.ttt.setColor(c);
      paint2();
    });
    swatchPicker($("homeSwatches2"), "homeColor2", color2(), (c) => store.set("ttc.color2", c));
    paint2();
    segPicker($("homePieces"), "homePiecesPick", pieceOptions, pieceStyle(), (v) => onPieces(v));
    setToggle("homeSound", soundOn());
    setToggle("homeThreats", store.get("ttc.threats") === "1");
    $("settingsDialog").showModal();
  });
  $("homeName").addEventListener("input", (e) => store.set("ttc.name", e.target.value.trim().slice(0, 24)));
  $("homeName2").addEventListener("input", (e) => store.set("ttc.name2", e.target.value.trim().slice(0, 24)));
  $("homeSound").addEventListener("click", () => $("hcSound").click());
  $("homeThreats").addEventListener("click", () => {
    const v = store.get("ttc.threats") !== "1";
    store.set("ttc.threats", v ? "1" : "0"); setToggle("homeThreats", v);
  });
  $("settingsDialog").addEventListener("click", (e) => { if (e.target === $("settingsDialog")) $("settingsDialog").close(); });
  $("get-app-home").addEventListener("click", (e) => e.preventDefault());

  initGames();
}

/* ───────────────────────────── Your games ───────────────────────────── */

const LISTS = {
  ttt: { key: "ttc.games", href: (id) => `?g=${id}`, name: "Tic Tac Cube" },
  words: { key: "ttc.wgames", href: (id) => `words.html?w=${id}`, name: "Word Cube" },
  pop: { key: "ttc.pgames", href: (id) => `pop.html?p=${id}`, name: "Cube Pop" },
};
const LABEL = { mine: "Your move", theirs: "Their move", waiting: "Waiting for them to join", rematch: "Wants a rematch", over: "Game over", ended: "Ended" };
const readList = (key) => { try { return JSON.parse(store.get(key) || "[]"); } catch { return []; } };
const writeList = (key, list) => store.set(key, JSON.stringify(list.slice(0, 40)));
function patch(game, id, change) {
  const { key } = LISTS[game];
  const list = readList(key);
  const g = list.find((x) => x.id === id);
  if (!g) return;
  Object.assign(g, change);
  if (change.closed) g.archived = true;
  writeList(key, list);
}
const allGames = () => Object.keys(LISTS).flatMap((game) => readList(LISTS[game].key).map((g) => ({ ...g, game })));

function initGames() {
  const summaries = new Map();
  let auth = null;
  const urgent = (g) => ["mine", "rematch"].includes(summaries.get(g.game + g.id)?.status);
  const sheet = $("gamesSheet");

  function render() {
    const all = allGames();
    const active = all.filter((g) => !g.archived), archived = all.filter((g) => g.archived);
    active.sort((a, b) => (urgent(b) - urgent(a)) || ((b.t ?? 0) - (a.t ?? 0)));
    const waiting = active.filter(urgent).length;
    $("gamesBtn").hidden = !all.length;
    $("gamesCount").textContent = active.length;
    $("gamesTurn").hidden = !waiting;
    $("gamesTurn").textContent = `${waiting} your turn`;
    $("gamesBtn").classList.toggle("urgent", waiting > 0);
    $("gamesBadge").hidden = !waiting;
    $("gamesBadge").textContent = `${waiting} waiting on you`;
    $("gamesList").replaceChildren(...active.map((g) => row(g, false)));
    if (!active.length) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.textContent = "No open games. Start one with Invite on any game’s page.";
      $("gamesList").append(li);
    }
    $("gamesArchivedBtn").hidden = !archived.length;
    $("gamesArchivedBtn").textContent = `${$("gamesArchived").hidden ? "Show" : "Hide"} archived (${archived.length})`;
    $("gamesArchived").replaceChildren(...archived.map((g) => row(g, true)));
  }

  function row(g, isArchived) {
    const sum = summaries.get(g.game + g.id);
    const li = document.createElement("li");
    li.className = "game-row" + (urgent(g) ? " mine" : "");
    const a = document.createElement("a");
    a.href = LISTS[g.game].href(g.id);
    const title = document.createElement("span");
    title.className = "g-title";
    const opp = sum?.opp || g.opp;
    title.textContent = opp ? `vs ${opp}` : "Invite sent";
    const sub = document.createElement("span");
    sub.className = "g-sub";
    sub.textContent = [sum ? LABEL[sum.status] : g.closed ? "Ended" : "", `${LISTS[g.game].name}${sum ? ` ${sum.size}³` : ""}`].filter(Boolean).join(" · ");
    a.append(title, sub);
    const score = document.createElement("span");
    score.className = "g-score";
    if (sum && sum.status !== "waiting") score.textContent = `${sum.mine}–${sum.theirs}`;
    const actions = document.createElement("span");
    actions.className = "g-actions";
    const icon = (label, path, onClick) => {
      const b = document.createElement("button");
      b.className = "icon-btn"; b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.addEventListener("click", onClick);
      return b;
    };
    if (isArchived) {
      if (!g.closed) actions.append(icon("Restore", "M4 12a8 8 0 1 0 3-6.2M4 4v4h4", () => { patch(g.game, g.id, { archived: false }); render(); }));
      actions.append(icon("Remove", "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12", () => { writeList(LISTS[g.game].key, readList(LISTS[g.game].key).filter((x) => x.id !== g.id)); render(); }));
    } else {
      actions.append(icon("Archive", "M4 6h16v4H4zM6 10v9h12v-9M10 14h4", () => { patch(g.game, g.id, { archived: true }); render(); }));
      if (auth?.signedIn) {
        const waitingForThem = sum?.status === "waiting";
        actions.append(icon(waitingForThem ? "Cancel invite" : "End game", "M6 6l12 12M18 6L6 18", () => {
          if (li.querySelector(".g-confirm")) return;
          const c = document.createElement("div");
          c.className = "g-confirm";
          const q = document.createElement("span");
          q.className = "muted small";
          q.textContent = waitingForThem ? "Cancel the invite?" : "End it for both of you?";
          const yes = document.createElement("button");
          yes.className = "btn small danger"; yes.type = "button"; yes.textContent = waitingForThem ? "Cancel invite" : "End game";
          const no = document.createElement("button");
          no.className = "btn small"; no.type = "button"; no.textContent = "Keep";
          no.addEventListener("click", () => c.remove());
          yes.addEventListener("click", async () => {
            yes.disabled = true;
            try {
              const { db } = await cloudSetup(() => {});
              await saveEvent(db, g.id, { kind: "close", author: auth.me, authorName: store.get("ttc.name") || "Player" });
              patch(g.game, g.id, { closed: true });
              summaries.set(g.game + g.id, { ...(sum || { size: 4, mine: 0, theirs: 0 }), status: "ended" });
            } catch (err) { console.warn(err); yes.disabled = false; q.textContent = "Couldn’t reach iCloud — try again."; return; }
            render();
          });
          c.append(q, yes, no);
          li.append(c);
          no.focus({ preventScroll: true });
        }));
      }
    }
    li.append(a, score, actions);
    return li;
  }

  /** Whose turn it is in each game, from CloudKit (needs Apple sign-in). */
  async function refresh() {
    if (!auth?.signedIn) return;
    const { db } = await cloudSetup(() => {});
    const me = auth.me;
    const games = allGames().filter((g) => !g.archived);
    const book = games.some((g) => g.game === "words") ? await loadBook() : null;
    await Promise.all(games.map(async (g) => {
      try {
        const events = sortEvents(await queryGame(db, g.id));
        let status, sum;
        if (g.game === "ttt") {
          const s = fold(events), role = tttRole(s, me);
          if (!role) return;
          const opp = other(role);
          if (s.closedBy) status = "ended";
          else if (!s.players.O) status = "waiting";
          else if (s.winner) status = s.ready[opp] && !s.ready[role] ? "rematch" : "over";
          else status = s.turn === role ? "mine" : "theirs";
          sum = { status, size: s.size, mine: s.score[role], theirs: s.score[opp], opp: s.players[opp]?.name || "" };
          if (s.closedBy) patch(g.game, g.id, { closed: true });
        } else {
          let s;
          if (g.game === "words") {
            if (!book) return;
            s = foldMatch(events, g.id, (n, r) => book.puzzle({ size: n, index: boardIndex(g.id, r, book.practiceCount(n)) }));
          } else s = foldPop(events, g.id);
          const role = (g.game === "words" ? wordRole : popRole)(s, me);
          if (!role) return;
          const opp = other(role);
          if (s.closedBy) status = "ended";
          else if (s.over) status = s.ready[opp] && !s.ready[role] ? "rematch" : "over";
          else if (s.turn === role && (s.players.O || role === "X")) status = "mine";
          else if (!s.players.O) status = "waiting";
          else status = "theirs";
          sum = { status, size: s.size, mine: s.score[role], theirs: s.score[opp], opp: s.players[opp]?.name || "" };
          if (s.closedBy) patch(g.game, g.id, { closed: true });
        }
        summaries.set(g.game + g.id, sum);
      } catch (err) { console.warn(err); }
    }));
    render();
  }

  function open() {
    sheet.hidden = false; void sheet.offsetWidth; sheet.classList.add("open");
    $("gamesDone").focus({ preventScroll: true });
  }
  function close() {
    sheet.classList.remove("open");
    setTimeout(() => { if (!sheet.classList.contains("open")) sheet.hidden = true; }, reduceMotion ? 0 : 300);
    $("gamesBtn").focus({ preventScroll: true });
  }
  $("gamesBtn").addEventListener("click", open);
  $("gamesDone").addEventListener("click", close);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) close(); });
  $("gamesArchivedBtn").addEventListener("click", () => { $("gamesArchived").hidden = !$("gamesArchived").hidden; render(); });
  render();

  if (allGames().length) {
    cloudSetup((a) => {
      auth = a;
      $("gamesSignin").hidden = a.signedIn || !!a.authError;
      render();
      refresh();
    }).catch((err) => console.warn(err));
    setInterval(() => { if (!document.hidden) refresh(); }, 20000);
  }
}
