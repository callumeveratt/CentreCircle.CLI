# cc: an unofficial CentreCircle CLI

A command-line client for the CentreCircle referee-appointment portal. It calls the same REST/JSON API the portal's web app uses
(`api.centrecircleapp.com`), so you can script fixture lists, appointments, adverts and game-off changes instead of clicking
through the portal. Bun + TypeScript, single file, no dependencies.

> **Unofficial.** Not affiliated with or endorsed by CentreCircle. The API is undocumented and was worked out by observing the
> portal's own requests; it can change without notice. Use it only with your own account, for what your role permits, and in line
> with CentreCircle's terms and your organisation's rules. Write commands change real data and notify real people: read
> [Safety](#safety) first.

## Install

```sh
bun install -g .      # or: bun link   (from this folder)
cc config set league <your-league-code>
cc auth login         # prompts for email + password (hidden); stores only the token
```

Your league code is the `leagueCode=` value you can see in the portal's network requests (or ask your league secretary).
The token lasts about two weeks and is stored in `~/.config/cc/auth.json` (mode 600 where supported). For CI or one-offs set
`CC_TOKEN` instead. Your password is never stored.

## Commands

Every command accepts `--json`. Write commands are a **dry run unless you pass `--yes`**.

| Command | What it does |
|---|---|
| `cc fixtures --date D [--to D] [--no-ref] [--skip-midnight] [--status S]` | List fixtures. `--no-ref` = Normal games with no referee (advertised ones included, as in the portal). `--skip-midnight` drops placeholder 00:00 KOs. |
| `cc fixture <id>` | One fixture as JSON |
| `cc referees <id> [--search text]` | Suggested referees for a game (distance, games) |
| `cc appoint <id> --email E [--yes]` / `cc unappoint <id> [--yes]` | Set / clear the referee |
| `cc advertise <id> [--fee 22] [--auto] [--yes]` / `cc cancel-advert <id> [--yes]` | Advertise the referee role (notifies referees) / cancel it |
| `cc game-off <id> --note T [--reason R] [--yes]` / `cc game-on <id> [--yes]` | Postpone a game (visible to clubs) / restore it |
| `cc spare-games --date D` | Copy-ready "games needing a referee" email text |
| `cc coverage --from <Sunday> [--bands 12-14,15-17]` | Share of games with a referee for a 7-day week, per band (default: per age group) |
| `cc api <METHOD> <path> [-p k=v] [--body JSON]` | Raw call; add `--dry-run` to preview |
| `cc config path\|show\|set league <code>\|set ages <range\|none>` | Configuration |

Not supported yet: assistant referees (only the referee slot has been verified).

### Age filters

Nothing is hardcoded to an age range. The age group is the fixture's `ageCap`.

- `--age 12-17`, `--age 14` or `--all-ages` on any command that lists or counts fixtures (`fixtures`, `spare-games`, `coverage`).
- Or set a default: `cc config set ages 12-17` (`cc config set ages none` to clear). With no flag and no config, all ages are included.
- `coverage` groups by `--bands`, else `bands` in the config, else one row per age group. Bands group rows; they don't filter.

### Configuration

`~/.config/cc/config.json` (see [`config.example.json`](config.example.json); use `cc config path` to find it):

```json
{
  "league": "your-league-code",
  "ages": { "min": 12, "max": 17 },
  "bands": [{ "label": "U12-U14", "min": 12, "max": 14 }, { "label": "U15-U17", "min": 15, "max": 17 }],
  "spareGames": {
    "intro": ["Good morning all,", "", "We have some games still requiring a referee."],
    "contacts": ["U12-U14 Jane (07xxx xxxxxx)", "referee@example.org"],
    "cupNote": "all followed by kicks from the penalty mark",
    "cupExtraTime": [{ "min": 12, "max": 13, "text": "5 mins e/w extra time" }]
  }
}
```

Contact lines and cup rules are league-specific, so nothing ships by default. Cup games are flagged `(CUP)`; the extra-time line only
appears if you configure it. `CC_LEAGUE` overrides the league.

## Safety

- **Dry run by default.** Writes print a plan and stop unless `--yes`.
- **Guards.** Writes refuse risky states (game already advertised, slot already filled, game not Normal) unless `--force`.
- **Verify after.** The server often returns 200 for a request it then ignores, so every write re-reads the fixture and fails loudly if nothing changed.
- **Real effects.** Advertising notifies referees; Game Off is visible to clubs and shows in the activity feed; appointing does not update FA Fulltime (the portal says so too).
- Test on a game you control first. Cancelling an advert or reversing a Game Off still leaves entries in the activity feed.

## How it works (API notes)

All requests carry `Authorization: Bearer <JWT>` from `POST /authenticate {userId, password}`; `GET /renewAuthentication` refreshes it
(the CLI retries once on a 401).

| Thing | Call |
|---|---|
| List | `GET /league/fixtures/list?leagueCode&startDate&endDate&statuses=&order=asc&includeMatchAdverts=true&offset&limit=800` |
| One fixture | `GET /fixture/{id}` |
| Referee candidates | `GET /fixture/{id}/refereeSuggestions?ignoreTravelRadius&limit&offset` |
| Appoint / remove | `POST /fixture/{league}` `{fixtures:[{id, officials:[{role:"referee", position:1, name, email, userId:null, assignedBy, ...}], isReportSubmitted:false, documents:[]}]}`. Remove = `name:"none", email:""`. |
| Advertise | `POST /league/fixtures/adverts/{league}` `{matchAdvertRoles:{"<id>":[{fixtureId, role:"referee", fee:<pence>, autoAppoint, leagueCode:null}]}}` |
| Cancel advert | `DELETE /league/fixtures/adverts/{league}/{advertId}/referee` (advertId = `matchAdvert.id` from the list) |
| Game off / on | `POST /referee/gameOff`, multipart: `fixture_id`, `reason_code` (`Game Off - Waterlogged\|Icy\|Unsafe Surface\|Other` or `Game On`), `reason_message`, `submitter_email` |

Gotchas:
- `time` is a UTC instant; leagues run on UK time. A BST midnight placeholder arrives as `23:00Z` the day before, so the CLI converts to Europe/London.
- `endDate` is a midnight instant, not an inclusive day. `start=end=D` returns only the 00:00 placeholders. The CLI queries D-1 to D+1 and trims to UK local dates.
- The list caps at 800 rows; the CLI pages.
- The person to appoint is resolved from **name + email**. A body with only a `userId` returns 200 and is silently ignored.
- `GET /fixture/{id}` does not include `matchAdvert`; only the list does. Cancelling an advert leaves an empty `matchAdvert` object, so "advertised" means it has a `referee` role.
- Fee is in pence. Age group = `ageCap`. Referee = `officials[]` with `role=="referee" && position==1`.
- Git Bash rewrites leading-slash arguments (`/league/...`); use PowerShell or `MSYS_NO_PATHCONV=1` with `cc api`.

## Status

Exercised live against a real league: login, all read commands, and each write pair (appoint/unappoint, advertise/cancel-advert,
game-off/game-on) including the guards and idempotent re-runs. `cc auth renew` and the 401 auto-renew path are untested.
`spare-games` club short-names are a regex approximation (`Junior Football Club`/`J.F.C.` -> `JFC`, `Football Club`/`F.C.` -> `FC`,
sub-team suffixes dropped); always check them.

## Claude skill

[`SKILL.md`](SKILL.md) is a skill wrapper so an AI agent can drive the CLI with the dry-run/approval rules above.
