#!/usr/bin/env bun
// cc: CentreCircle CLI. Wraps api.centrecircleapp.com (the API the portal itself uses).
// Read commands are verified against the live API. Write commands go through `cc api`
// until their endpoints have been captured (see README).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.CC_API ?? "https://api.centrecircleapp.com";
const DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cc");
const AUTH_FILE = join(DIR, "auth.json");
const CONFIG_FILE = join(DIR, "config.json");

// ---------- config (~/.config/cc/config.json; see config.example.json) ----------
type Band = { label?: string; min: number; max: number };
type Config = {
  league?: string;
  ages?: { min?: number; max?: number };
  bands?: Band[];
  spareGames?: { intro?: string[]; contacts?: string[]; cupNote?: string; cupExtraTime?: { min: number; max: number; text: string }[] };
};
let CONFIG: Config = {};
try { if (existsSync(CONFIG_FILE)) CONFIG = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); }
catch (e) { console.error(`cc: could not read ${CONFIG_FILE}: ${(e as Error).message}`); process.exit(1); }
const LEAGUE = process.env.CC_LEAGUE ?? CONFIG.league ?? "";
const league = (): string => LEAGUE || die("no league set: run `cc config set league <code>` or set CC_LEAGUE (the code is in the portal's API calls, e.g. leagueCode=...)");

// ---------- tiny arg parser ----------
type Args = { _: string[]; flags: Record<string, string | boolean>; params: string[] };
function parse(argv: string[]): Args {
  const a: Args = { _: [], flags: {}, params: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-p" || x === "--param") a.params.push(argv[++i]);
    else if (x.startsWith("--")) {
      const [k, v] = x.slice(2).split("=");
      if (v !== undefined) a.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) a.flags[k] = argv[++i];
      else a.flags[k] = true;
    } else a._.push(x);
  }
  return a;
}
const die = (m: string): never => { console.error(`cc: ${m}`); process.exit(1); };

// ---------- auth ----------
type Auth = { token: string; user?: string };
const loadAuth = (): Auth | null => {
  if (process.env.CC_TOKEN) return { token: process.env.CC_TOKEN };
  return existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : null;
};
function saveAuth(a: Auth) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(a));
  try { chmodSync(AUTH_FILE, 0o600); } catch {}
}
const bearer = (t: string) => (t.startsWith("Bearer ") ? t : `Bearer ${t}`);
const pickToken = (j: any): string | undefined =>
  typeof j === "string" ? j : j?.token ?? j?.accessToken ?? j?.jwt ?? j?.authToken;

async function login(userId: string, password: string) {
  const r = await fetch(`${BASE}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  if (!r.ok) die(`login failed (${r.status})`);
  const txt = await r.text();
  let j: any = txt;
  try { j = JSON.parse(txt); } catch {}
  const token = pickToken(j);
  if (!token) die("login succeeded but no token found in response; run with CC_DEBUG=1 to inspect the shape");
  if (process.env.CC_DEBUG) console.error("response keys:", typeof j === "object" ? Object.keys(j) : "string");
  saveAuth({ token: token!, user: userId });
}

async function renew(): Promise<boolean> {
  const a = loadAuth();
  if (!a) return false;
  const r = await fetch(`${BASE}/renewAuthentication`, { headers: { Authorization: bearer(a.token) } });
  if (!r.ok) return false;
  const txt = await r.text();
  let j: any = txt;
  try { j = JSON.parse(txt); } catch {}
  const t = pickToken(j);
  if (!t) return false;
  saveAuth({ ...a, token: t });
  return true;
}

// ---------- http ----------
async function api(method: string, path: string, query: Record<string, string | number | boolean | undefined> = {}, body?: unknown, retry = true): Promise<any> {
  const a = loadAuth() ?? die("not logged in: run `cc auth login` (or set CC_TOKEN)");
  const url = new URL(path.startsWith("http") ? path : BASE + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  const init: RequestInit = {
    method,
    headers: { Authorization: bearer(a!.token), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  if (process.env.CC_DRY_RUN || dry) {
    console.log(`${method} ${url.pathname}${url.search}`);
    if (body !== undefined) console.log(JSON.stringify(body, null, 2));
    return null;
  }
  const r = await fetch(url, init);
  if (r.status === 401 && retry && (await renew())) return api(method, path, query, body, false);
  const txt = await r.text();
  if (!r.ok) die(`${method} ${url.pathname} -> ${r.status} ${txt.slice(0, 300)}`);
  try { return JSON.parse(txt); } catch { return txt; }
}
let dry = false;

// ---------- domain helpers ----------
type Official = { name: string; role: string; position: number; accepted?: boolean };
type Fixture = {
  id: string; competitionName: string | null; time: string; club1Name: string; club2Name: string;
  status: string; ageCap: number; venuePostcode?: string; venueAddress?: string; venueSurface?: string | null;
  officials?: Official[]; matchAdvert?: unknown;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };

async function fixtures(from: string, to: string, statuses = ""): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (let offset = 0; ; offset += 800) {
    const page: Fixture[] = (await api("GET", "/league/fixtures/list", {
      // endDate is a midnight instant, not an inclusive day: to include day `to`, send the day after.
      leagueCode: league(), startDate: addDays(from, -1), endDate: addDays(to, 1), statuses, order: "asc", includeMatchAdverts: true, offset, limit: 800,
    })) ?? [];
    out.push(...page);
    if (page.length < 800) break;
  }
  // Bounds are UTC midnights but the league runs on UK time: in BST the local-midnight placeholders spill into the
  // neighbouring day, so trim to the requested UK local dates.
  // Cancelling an advert leaves an empty `matchAdvert` shell behind (no roles). "Advertised" means it still has a referee role.
  for (const f of out) {
    const roles: any[] = (f.matchAdvert as any)?.matchAdvertRoles ?? [];
    if (!roles.some((r) => r.advertiseRole === "referee")) f.matchAdvert = undefined;
  }
  return out.filter((f) => localDate(f) >= from && localDate(f) <= to);
}
const hasReferee = (f: Fixture) => (f.officials ?? []).some((o) => o.role === "referee" && o.position === 1);
// API `time` is a true UTC instant; the league runs on UK local time (a BST 00:00 placeholder arrives as 23:00Z).
const LONDON = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false });
const koTime = (f: Fixture) => LONDON.format(new Date(f.time)).replace(/^24:/, "00:");
const localDate = (f: Fixture) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(f.time));
// Age filter: `--age 12-17` / `--age 14`, `--all-ages`, else config.ages, else no filter. Set once in main().
let ageRange: { min: number; max: number } | null = null;
function parseRange(s: string): { min: number; max: number } {
  const m = s.match(/^U?(\d{1,2})(?:\s*-\s*U?(\d{1,2}))?$/i);
  if (!m) die(`bad age range "${s}": use e.g. 12-17 or 14`);
  const lo = Number(m![1]), hi = m![2] === undefined ? lo : Number(m![2]);
  if (lo > hi) die(`bad age range "${s}": min is above max`);
  return { min: lo, max: hi };
}
function resolveAge(a: Args) {
  if (a.flags["all-ages"]) return null;
  if (typeof a.flags.age === "string") return parseRange(a.flags.age);
  const c = CONFIG.ages;
  return c && (c.min !== undefined || c.max !== undefined) ? { min: c.min ?? 0, max: c.max ?? 99 } : null;
}
const inScope = (f: Fixture) => !ageRange || (f.ageCap >= ageRange.min && f.ageCap <= ageRange.max);
const isCup = (f: Fixture) => /cup/i.test(f.competitionName ?? "");

const out = (a: Args, data: unknown, text: () => string) =>
  a.flags.json ? console.log(JSON.stringify(data, null, 2)) : console.log(text());

// ---------- commands ----------
async function cmdFixtures(a: Args) {
  const from = String(a.flags.date ?? a.flags.from ?? die("--date YYYY-MM-DD (or --from/--to) required"));
  const to = String(a.flags.to ?? from);
  let fx = await fixtures(from, to, a.flags.status ? String(a.flags.status) : "");
  fx = fx.filter(inScope);
  if (a.flags["no-ref"]) fx = fx.filter((f) => f.status === "Normal" && !hasReferee(f));
  if (a.flags["skip-midnight"]) fx = fx.filter((f) => koTime(f) !== "00:00");
  out(a, fx, () =>
    fx.map((f) => `${f.id}  ${localDate(f)} ${koTime(f)}  U${f.ageCap}  ${f.club1Name} v ${f.club2Name}  [${f.status}${f.matchAdvert ? ", advertised" : ""}]  ref: ${(f.officials ?? []).find((o) => o.role === "referee")?.name ?? "-"}`).join("\n") +
    `\n${fx.length} fixtures`);
}

async function cmdFixture(a: Args) {
  const id = a._[1] ?? die("usage: cc fixture <id>");
  const f = await api("GET", `/fixture/${id}`);
  console.log(JSON.stringify(f, null, 2));
}

// Short club names for the spare games email. Mirrors the skill's rules; unknown names fall through unchanged and get flagged.
function shortName(raw: string, age: number): string {
  let n = raw.replace(/\s+/g, " ").trim();
  n = n.replace(/\b(?:U|Under)\s*\d{1,2}\b.*$/i, "").trim(); // drop age and everything after
  n = n.replace(/Junior Football Club|J\.?F\.?C\.?/gi, "JFC").replace(/Football Club|F\.?C\.?/gi, "FC");
  n = n.replace(/\s+(JFC|FC)\b.*$/i, " $1"); // drop sub-team words after club suffix
  return `${n.trim()} U${age}`;
}
// Cup extra-time wording is league-specific, so it comes from config.spareGames.cupExtraTime (none by default).
const extraTime = (age: number) => CONFIG.spareGames?.cupExtraTime?.find((r) => age >= r.min && age <= r.max)?.text;

async function cmdSpare(a: Args) {
  const date = String(a.flags.date ?? die("--date required"));
  const fx = (await fixtures(date, date)).filter((f) => inScope(f) && f.status === "Normal" && !hasReferee(f) && koTime(f) !== "00:00");
  const groups = new Map<string, Fixture[]>();
  for (const f of fx) { const k = koTime(f); groups.set(k, [...(groups.get(k) ?? []), f]); }
  const cups = fx.filter(isCup);
  const cupAges = [...new Set(cups.map((f) => f.ageCap))].sort();
  const sg = CONFIG.spareGames ?? {};
  const lines = [...(sg.intro ?? ["Good morning all,", "", "We have some games still requiring a referee, please let us know if you can help."])];
  const rules = cupAges.filter((x) => extraTime(x)).map((x) => `U${x} ${extraTime(x)}`);
  if (cups.length && rules.length) lines.push(`Cups${sg.cupNote ? `, ${sg.cupNote}` : ""}: ${rules.join("; ")}.`);
  if (sg.contacts?.length) lines.push("", ...sg.contacts);
  lines.push("", `Available Games (${date.slice(8)}/${date.slice(5, 7)}):`);
  for (const [ko, g] of [...groups].sort()) {
    lines.push("", `${ko} KO:`);
    g.sort((x, y) => shortName(x.club1Name, x.ageCap).localeCompare(shortName(y.club1Name, y.ageCap)))
      .forEach((f) => lines.push(`${shortName(f.club1Name, f.ageCap)} v ${shortName(f.club2Name, f.ageCap)} (${f.venuePostcode ?? "?"})${isCup(f) ? " (CUP)" : ""}`));
  }
  out(a, fx, () => lines.join("\n") + `\n\n# ${fx.length} games. Check the short club names before sending.`);
}

async function cmdCoverage(a: Args) {
  const from = String(a.flags.from ?? die("--from <Sunday YYYY-MM-DD> required"));
  const fx = (await fixtures(from, addDays(from, 6))).filter((f) => inScope(f) && f.status === "Normal" && koTime(f) !== "00:00");
  // Bands: `--bands 12-14,15-17`, else config.bands, else one row per age group present.
  const lbl = (lo: number, hi: number) => (lo === hi ? `U${lo}` : `U${lo}-U${hi}`);
  const bands: Band[] = typeof a.flags.bands === "string"
    ? a.flags.bands.split(",").map((p) => { const r = parseRange(p.trim()); return { ...r, label: lbl(r.min, r.max) }; })
    : CONFIG.bands?.map((b) => ({ ...b, label: b.label ?? lbl(b.min, b.max) }))
      ?? [...new Set(fx.map((f) => f.ageCap))].sort((x, y) => x - y).map((x) => ({ min: x, max: x, label: lbl(x, x) }));
  const rows = bands.map((b) => {
    const g = fx.filter((f) => f.ageCap >= b.min && f.ageCap <= b.max); const w = g.filter(hasReferee).length;
    return { band: b.label!, games: g.length, withReferee: w, coverage: g.length ? Math.round((w / g.length) * 1000) / 10 : 0 };
  });
  const tg = rows.reduce((s, r) => s + r.games, 0), tw = rows.reduce((s, r) => s + r.withReferee, 0);
  rows.push({ band: "Total", games: tg, withReferee: tw, coverage: tg ? Math.round((tw / tg) * 1000) / 10 : 0 });
  out(a, rows, () => ["| | Games | With referee | Coverage |", "|---|---|---|---|", ...rows.map((r) => `| ${r.band} | ${r.games} | ${r.withReferee} | ${r.coverage.toFixed(1)}% |`)].join("\n") +
    "\n\n# CentreCircle data only: games with a referee / games. Cross-check other systems yourself.");
}

// ---------- referees & appointments (captured live 25 Nov 2026) ----------
// Save endpoint: POST /fixture/{leagueCode} {fixtures:[{id, officials:[...], isReportSubmitted:false, documents:[]}]}.
// The server resolves the person from name+email (userId may be null). An unrecognised/minimal official is accepted
// with 200 but silently ignored, so ALWAYS verify by re-reading the fixture (done below).
// Only referee/position 1 has been verified; assistants are deliberately not supported yet.
const officialBody = (o: { name: string; email: string } | null, assignedBy: string) => ({
  userId: null, fixtureId: null, role: "referee", name: o?.name ?? "none", email: o?.email ?? "",
  homePhone: null, workPhone: null, mobilePhone: "", accepted: null, confirmationTime: null, position: 1,
  assignedBy, isMinor: false, dbsExpiryAt: null, matchAdvertResponse: null, matchAdvertResponseId: null,
  rejectionReason: null, sourcingMethod: null, sourcingComments: null,
});
const saveOfficials = (id: string, official: unknown) =>
  api("POST", `/fixture/${league()}`, {}, { fixtures: [{ id, officials: [official], isReportSubmitted: false, documents: [] }] });
const refOf = (f: any) => (f.officials ?? []).find((o: any) => o.role === "referee" && o.position === 1 && o.name && o.name.toLowerCase() !== "none");
const assignedBy = () => loadAuth()?.user ?? process.env.CC_USER ?? "cc-cli";

async function cmdReferees(a: Args) {
  const id = a._[1] ?? die("usage: cc referees <fixtureId> [--search text]");
  const list: any[] = (await api("GET", `/fixture/${id}/refereeSuggestions`, { ignoreTravelRadius: true, limit: 100, offset: 0 })) ?? [];
  const q = String(a.flags.search ?? "").toLowerCase();
  const rows = list.map((x) => ({
    name: `${x.referee.firstName} ${x.referee.lastName}`, email: x.referee.email, age: x.suggestionInfo?.ageAtFixtureTime,
    distanceMiles: x.suggestionInfo?.distanceMiles, games: x.referee.futureGames, excludedTeams: x.suggestionInfo?.excludedTeams ?? [],
  })).filter((r) => !q || (r.name + r.email).toLowerCase().includes(q));
  out(a, rows, () => rows.map((r) => `${r.name.padEnd(28)} ${(typeof r.distanceMiles === "number" ? r.distanceMiles.toFixed(1) : "?").padEnd(6)}mi  games:${r.games ?? "?"}${r.excludedTeams.length ? "  EXCLUDED-TEAMS" : ""}`).join("\n") + `\n${rows.length} referees (email is in --json)`);
}

async function cmdAppoint(a: Args) {
  const id = a._[1] ?? die("usage: cc appoint <fixtureId> --email E [--name N] [--yes] [--force]");
  const email = String(a.flags.email ?? die("--email required (the server resolves the person by name+email)"));
  const f: any = await getFixture(id);
  if (refOf(f) && !a.flags.force) die(`already has referee ${refOf(f).name}; use \`cc unappoint\` first (or --force to replace)`);
  const list: any[] = (await api("GET", `/fixture/${id}/refereeSuggestions`, { ignoreTravelRadius: true, limit: 100, offset: 0 })) ?? [];
  const hit = list.find((x) => x.referee.email?.toLowerCase() === email.toLowerCase());
  const name = String(a.flags.name ?? (hit ? `${hit.referee.firstName} ${hit.referee.lastName}` : die("referee not in this fixture's suggestions; pass --name")));
  const problems: string[] = [];
  if (f.status !== "Normal") problems.push(`fixture status is ${f.status}`);
  if (refOf(f)) problems.push(`already has referee ${refOf(f).name}`);
  if (f.matchAdvert) problems.push("fixture is ADVERTISED: appointing consumes the advert and removing does not restore it");
  if (hit?.suggestionInfo?.excludedTeams?.length) problems.push("referee is excluded from one of these teams");
  console.log(`PLAN: appoint ${name} as referee on ${id} (${f.club1Name} v ${f.club2Name}, ${new Date(f.time).toISOString()})`);
  problems.forEach((p) => console.log(`  ! ${p}`));
  if (problems.length && !a.flags.force) die("refusing; pass --force to override");
  if (!a.flags.yes) return console.log("dry run: pass --yes to apply");
  await saveOfficials(id, officialBody({ name, email }, assignedBy()));
  const after = refOf(await api("GET", `/fixture/${id}`));
  if (after?.email?.toLowerCase() !== email.toLowerCase()) die("save returned 200 but the referee was NOT applied (server ignored it); nothing changed");
  console.log(`verified: ${after.name} is now referee on ${id}. Fulltime still needs updating (Pending Assignments).`);
}

async function cmdUnappoint(a: Args) {
  const id = a._[1] ?? die("usage: cc unappoint <fixtureId> [--yes]");
  const f: any = await api("GET", `/fixture/${id}`);
  const cur = refOf(f);
  if (!cur) return console.log("no referee on this fixture; nothing to do");
  console.log(`PLAN: remove referee ${cur.name} from ${id} (${f.club1Name} v ${f.club2Name})`);
  if (!a.flags.yes) return console.log("dry run: pass --yes to apply");
  await saveOfficials(id, officialBody(null, assignedBy()));
  if (refOf(await api("GET", `/fixture/${id}`))) die("save returned 200 but the referee is still there");
  console.log(`verified: referee slot on ${id} is now vacant. Fulltime may need updating.`);
}

// ---------- adverts & game off (captured live 25 Nov 2026) ----------
// Advertise: POST /league/fixtures/adverts/{league} {matchAdvertRoles:{<id>:[{fixtureId,role:"referee",fee:<pence>,autoAppoint,leagueCode:null}]}}
// Cancel advert: DELETE /league/fixtures/adverts/{league}/{advertId}/referee  (advertId = createdIds[0] = fixture.matchAdvert.id; inferred, verified by re-read)
// Game off/on: POST /referee/gameOff, multipart form: fixture_id, reason_code, reason_message, submitter_email
const GAME_OFF_REASONS = ["Game Off - Waterlogged", "Game Off - Icy", "Game Off - Unsafe Surface", "Game Off - Other"];
// NOTE: GET /fixture/{id} does NOT include `matchAdvert`; only the list endpoint does. So getFixture() merges the
// advert in from the list entry for the fixture's UK local date.
const getFixture = async (id: string): Promise<any> => {
  const r = await api("GET", `/fixture/${id}`);
  const f = r?.data ?? r;
  if (f?.time) {
    const day = localDate(f as Fixture);
    const listed = (await fixtures(day, day)).find((x) => x.id === id);
    f.matchAdvert = listed?.matchAdvert ?? null;
  }
  return f;
};
const need = (ok: boolean, msg: string, a: Args, problems: string[]) => { if (!ok) problems.push(msg); };
function gate(problems: string[], a: Args) {
  problems.forEach((p) => console.log(`  ! ${p}`));
  if (problems.length && !a.flags.force) die("refusing; pass --force to override");
  if (!a.flags.yes) { console.log("dry run: pass --yes to apply"); return false; }
  return true;
}

async function cmdAdvertise(a: Args) {
  const id = a._[1] ?? die("usage: cc advertise <fixtureId> [--fee 22] [--auto] [--yes]");
  const fee = Number(a.flags.fee ?? 22);
  if (!Number.isFinite(fee) || fee <= 0) die("--fee must be pounds, e.g. 22");
  const f = await getFixture(id);
  const p: string[] = [];
  need(f.status === "Normal", `fixture status is ${f.status}`, a, p);
  need(!f.matchAdvert, "already advertised", a, p);
  need(!refOf(f), `already has referee ${refOf(f)?.name}`, a, p);
  console.log(`PLAN: advertise referee on ${id} (${f.club1Name} v ${f.club2Name}) at £${fee}${a.flags.auto ? ", AUTO-appoint" : ", manual"}. This notifies available referees.`);
  if (!gate(p, a)) return;
  await api("POST", `/league/fixtures/adverts/${league()}`, {}, { matchAdvertRoles: { [id]: [{ fixtureId: id, role: "referee", fee: Math.round(fee * 100), autoAppoint: !!a.flags.auto, leagueCode: null }] } });
  if (!(await getFixture(id)).matchAdvert) die("save returned 200 but no advert is present");
  console.log(`verified: ${id} is advertised at £${fee}.`);
}

async function cmdCancelAdvert(a: Args) {
  const id = a._[1] ?? die("usage: cc cancel-advert <fixtureId> [--yes]");
  const f = await getFixture(id);
  if (!f.matchAdvert) return console.log("not advertised; nothing to do");
  console.log(`PLAN: cancel referee advert ${f.matchAdvert.id} on ${id} (${f.club1Name} v ${f.club2Name})`);
  if (!gate([], a)) return;
  await api("DELETE", `/league/fixtures/adverts/${league()}/${f.matchAdvert.id}/referee`);
  if ((await getFixture(id)).matchAdvert) die("delete returned 200 but the advert is still there (advert id may differ from matchAdvert.id; check the portal)");
  console.log(`verified: advert on ${id} cancelled.`);
}

async function postGameOff(id: string, reasonCode: string, message: string) {
  const form = new FormData();
  form.set("fixture_id", id); form.set("reason_code", reasonCode); form.set("reason_message", message); form.set("submitter_email", assignedBy());
  const a2 = loadAuth() ?? die("not logged in");
  const r = await fetch(`${BASE}/referee/gameOff`, { method: "POST", headers: { Authorization: bearer(a2!.token) }, body: form });
  if (!r.ok) die(`POST /referee/gameOff -> ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function cmdGameOff(a: Args) {
  const id = a._[1] ?? die(`usage: cc game-off <fixtureId> --reason "${GAME_OFF_REASONS[3]}" --note "text" [--yes]`);
  const reason = String(a.flags.reason ?? "Game Off - Other");
  if (!GAME_OFF_REASONS.includes(reason)) die(`--reason must be one of: ${GAME_OFF_REASONS.join(" | ")}`);
  const note = String(a.flags.note ?? die("--note required (reason text, visible in the activity feed)"));
  const f = await getFixture(id);
  const p: string[] = [];
  need(f.status === "Normal", `fixture status is ${f.status}`, a, p);
  need(!refOf(f), `has referee ${refOf(f)?.name}; they will be affected`, a, p);
  need(!f.matchAdvert, "fixture is advertised", a, p);
  console.log(`PLAN: call ${reason} on ${id} (${f.club1Name} v ${f.club2Name}), note: ${note}. Visible to clubs; reverse with \`cc game-on\`.`);
  if (!gate(p, a)) return;
  await postGameOff(id, reason, note);
  const s = (await getFixture(id)).status;
  if (s === "Normal") die("200 but the fixture is still Normal");
  console.log(`verified: ${id} is now ${s}.`);
}

async function cmdGameOn(a: Args) {
  const id = a._[1] ?? die("usage: cc game-on <fixtureId> [--yes]");
  const f = await getFixture(id);
  if (f.status === "Normal") return console.log("already Normal; nothing to do");
  console.log(`PLAN: set ${id} (${f.club1Name} v ${f.club2Name}) back to Game On (was ${f.status})`);
  if (!gate([], a)) return;
  await postGameOff(id, "Game On", "");
  const s = (await getFixture(id)).status;
  if (s !== "Normal") die(`200 but status is ${s}`);
  console.log(`verified: ${id} is Normal.`);
}

async function cmdApi(a: Args) {
  const [, method, path] = a._;
  if (!method || !path) die("usage: cc api <METHOD> <path> [-p k=v] [--body '{json}'] [--dry-run]");
  const q = Object.fromEntries(a.params.map((p) => p.split(/=(.*)/s).slice(0, 2) as [string, string]));
  const body = a.flags.body ? JSON.parse(String(a.flags.body)) : undefined;
  console.log(JSON.stringify(await api(method.toUpperCase(), path, q, body), null, 2));
}

// Reads a line from a TTY without echoing it. Needs an interactive terminal.
async function askHidden(q: string): Promise<string | null> {
  if (!process.stdin.isTTY) die("password prompt needs an interactive terminal (or set CC_PASSWORD for this one command)");
  process.stdout.write(q);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((res) => {
    let s = "";
    const on = (d: Buffer) => {
      for (const c of d.toString("utf8")) {
        if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", on); process.stdout.write("\n"); return res(s || null); }
        if (c === "\u0003") { process.stdin.setRawMode(false); process.exit(130); }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1); else s += c;
      }
    };
    process.stdin.on("data", on);
  });
}

function cmdConfig(a: Args) {
  const sub = a._[1];
  const save = () => { mkdirSync(DIR, { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2) + "\n"); };
  if (sub === "path") console.log(CONFIG_FILE);
  else if (sub === "show") console.log(JSON.stringify(CONFIG, null, 2));
  else if (sub === "set") {
    const [, , key, ...rest] = a._; const val = rest.join(" ");
    if (!key || !val) die("usage: cc config set league <code> | ages <12-17|14|none>");
    if (key === "league") CONFIG.league = val;
    else if (key === "ages") { if (val === "none") delete CONFIG.ages; else { const r = parseRange(val); CONFIG.ages = r; } }
    else die(`unknown key "${key}" (league, ages). Edit ${CONFIG_FILE} for bands and spareGames; see config.example.json`);
    save(); console.log(`saved to ${CONFIG_FILE}`);
  } else die("usage: cc config path|show|set <key> <value>");
}

async function cmdAuth(a: Args) {
  const sub = a._[1];
  if (sub === "login") {
    const user = process.env.CC_USER ?? (prompt("Email: ") || die("email required"));
    const pw = process.env.CC_PASSWORD ?? (await askHidden("Password: ")) ?? die("password required");
    await login(user, pw);
    console.log("logged in");
  } else if (sub === "set-token") {
    const t = (await Bun.stdin.text()).trim();
    if (!t) die("pipe the token on stdin");
    saveAuth({ token: t });
    console.log("token saved");
  } else if (sub === "status") {
    const a2 = loadAuth();
    if (!a2) return console.log("not logged in");
    try {
      const p = JSON.parse(Buffer.from(a2.token.replace(/^Bearer /, "").split(".")[1], "base64url").toString());
      console.log(`token present, expires ${p.exp ? new Date(p.exp * 1000).toISOString() : "(no exp)"}`);
    } catch { console.log("token present (could not decode expiry)"); }
  } else if (sub === "renew") console.log((await renew()) ? "renewed" : "renew failed");
  else die("usage: cc auth login|set-token|status|renew");
}

const HELP = `cc: CentreCircle CLI (league ${LEAGUE || "NOT SET: run `cc config set league <code>`"})

  cc config path|show|set league <code> | set ages <12-17|14|none>
  cc auth login|set-token|status|renew
  cc fixtures --date D [--to D] [--no-ref] [--skip-midnight] [--status S] [--json]
  cc fixture <id>
  cc referees <fixtureId> [--search t]         suggested referees for a game
  cc appoint <fixtureId> --email E [--yes]     appoint referee (dry run unless --yes; refuses advertised/filled/non-Normal unless --force)
  cc unappoint <fixtureId> [--yes]             vacate the referee slot
  cc advertise <fixtureId> [--fee 22] [--auto] [--yes]   advertise the referee role (notifies referees)
  cc cancel-advert <fixtureId> [--yes]
  cc game-off <fixtureId> --note T [--reason R] [--yes]; cc game-on <fixtureId> [--yes]
  (all writes: dry run unless --yes; refuse risky states unless --force; verify by re-reading)
  cc spare-games --date D           copy-ready spare games email
  cc coverage --from <Sunday> [--bands 12-14,15-17]   referee coverage per band (default: per age) (CC data only)
  cc api <METHOD> <path> [-p k=v] [--body JSON]   raw call; add --dry-run to preview
Global: --json, --dry-run, --age 12-17 | --age 14 | --all-ages (default: config ages, else all). Env: CC_TOKEN, CC_USER, CC_PASSWORD, CC_LEAGUE`;

const args = parse(process.argv.slice(2));
dry = !!args.flags["dry-run"];
ageRange = resolveAge(args);
const cmd = args._[0];
const table: Record<string, (a: Args) => Promise<void>> = {
  auth: cmdAuth, config: async (a) => cmdConfig(a), referees: cmdReferees, appoint: cmdAppoint, unappoint: cmdUnappoint, advertise: cmdAdvertise, "cancel-advert": cmdCancelAdvert, "game-off": cmdGameOff, "game-on": cmdGameOn, fixtures: cmdFixtures, fixture: cmdFixture, "spare-games": cmdSpare, coverage: cmdCoverage, api: cmdApi,
};
if (!cmd || !table[cmd]) console.log(HELP);
else await table[cmd](args);
