// CloudKit plumbing shared by Tic Tac Cube (app.js) and Word Cube (words.js): Apple sign-in,
// and each game as an append-only log of `Event` records (see PROTOCOL.md).
import { CONFIG } from "./config.js";

// `&seat=2` (testing): play the other seat with the same Apple Account.
const SEAT2 = new URLSearchParams(location.search).get("seat") === "2";

export function whenCloudKit(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (window.CloudKit) return resolve(window.CloudKit);
    const t = setTimeout(() => reject(new Error("CloudKit JS failed to load")), timeout);
    window.addEventListener("cloudkitloaded", () => { clearTimeout(t); resolve(window.CloudKit); }, { once: true });
    const iv = setInterval(() => { if (window.CloudKit) { clearInterval(iv); clearTimeout(t); resolve(window.CloudKit); } }, 200);
  });
}

export function toEvent(r) {
  const f = r.fields || {};
  const v = (k, d) => (f[k] && f[k].value != null ? f[k].value : d);
  return {
    recordName: r.recordName, kind: v("kind", ""), round: Number(v("round", 0)), cell: Number(v("cell", -1)),
    text: v("text", ""), author: v("author", ""), authorName: v("authorName", ""), color: v("color", ""),
    ts: Number(v("ts", 0)),
  };
}

let ckSetup = null;
/** Configure CloudKit once; `auth` tracks the signed-in player. */
export function cloudSetup(onAuthChange) {
  if (ckSetup) return ckSetup;
  ckSetup = (async () => {
  if (!CONFIG.apiToken || CONFIG.apiToken.startsWith("REPLACE")) {
    throw new Error("This game server isn't set up yet (missing CloudKit API token).");
  }
  const CK = await whenCloudKit();
  CK.configure({
    containers: [{
      containerIdentifier: CONFIG.containerIdentifier,
      apiTokenAuth: {
        apiToken: CONFIG.apiToken, persist: true,
        signInButton: { id: "apple-sign-in-button", theme: "white-with-outline" },
        signOutButton: { id: "apple-sign-out-button", theme: "black" },
      },
      environment: CONFIG.environment,
    }],
  });
  const container = CK.getDefaultContainer();
  const db = container.publicCloudDatabase;
  const be = { signedIn: false, me: null };

  const handleIdentity = (identity) => {
    if (identity) {
      // `&seat=2` (testing): play the other seat with the same Apple Account.
      be.signedIn = true; be.me = identity.userRecordName + (SEAT2 ? "~2" : ""); onAuthChange(be);
      container.whenUserSignsOut().then(() => { be.signedIn = false; be.me = null; onAuthChange(be); container.whenUserSignsIn().then(handleIdentity); });
    } else {
      be.signedIn = false; be.me = null; onAuthChange(be);
      container.whenUserSignsIn().then(handleIdentity);
    }
  };
  be.ready = container.setUpAuth().then(handleIdentity).catch((err) => {
    console.warn("auth", err);
    be.authError = true; // e.g. Apple sign-in unavailable on this domain or blocked by the browser
    onAuthChange(be);
  });
  return { container, db, auth: be };
  })();
  return ckSetup;
}

export async function queryGame(db, gameId, since = 0) {
  const out = [];
  let res = await db.performQuery({
    recordType: "Event",
    filterBy: [
      { fieldName: "game", comparator: "EQUALS", fieldValue: { value: gameId } },
      { fieldName: "ts", comparator: "GREATER_THAN_OR_EQUALS", fieldValue: { value: Math.max(0, since) } },
    ],
    sortBy: [{ fieldName: "ts", ascending: true }],
  }, { resultsLimit: 200 });
  for (;;) {
    if (res.hasErrors) throw res.errors[0];
    out.push(...res.records.map(toEvent));
    if (!res.moreRecordsComing) break;
    res = await db.performQuery(res);
  }
  return out;
}

export async function saveEvent(db, gameId, f) {
  const res = await db.saveRecords([{
    recordType: "Event",
    fields: {
      game: { value: gameId }, kind: { value: f.kind }, round: { value: f.round ?? 0 },
      cell: { value: f.cell ?? -1 }, text: { value: f.text ?? "" }, author: { value: f.author },
      authorName: { value: f.authorName ?? "" }, color: { value: f.color ?? "" }, ts: { value: Date.now() },
    },
  }]);
  if (res.hasErrors) throw res.errors[0];
  return toEvent(res.records[0]);
}

/** One game's event log: polls every few seconds; `save` appends an event. */
export async function cloudGame(gameId, onAuthChange) {
  const { db, auth: be } = await cloudSetup(onAuthChange);
  const seen = new Map();
  let since = 0;
  async function fetchNew() {
    // Overlap window absorbs small clock skew between players; dedupe by recordName.
    let added = false;
    for (const e of await queryGame(db, gameId, since - 120000)) {
      if (seen.has(e.recordName)) continue;
      seen.set(e.recordName, e);
      since = Math.max(since, e.ts);
      added = true;
    }
    return added;
  }

  be.start = (onEvents, onError) => {
    let first = true;
    const tick = async () => {
      // Always report the first successful fetch, even an empty game, so the page stops "loading".
      try { if ((await fetchNew()) || first) onEvents([...seen.values()]); first = false; }
      catch (err) { onError(err); }
      setTimeout(tick, document.hidden ? 8000 : 3000);
    };
    tick();
  };
  be.save = async (f) => {
    const e = await saveEvent(db, gameId, f);
    seen.set(e.recordName, e);
    since = Math.max(since, e.ts);
    return { event: e, all: [...seen.values()] };
  };
  return be;
}
