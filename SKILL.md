---
name: centrecircle-cli
description: Drive the CentreCircle referee portal through the `cc` CLI instead of clicking the Flutter canvas UI. Use for listing fixtures for a date, finding games with no referee, the weekly spare games email, referee coverage, and (with approval) appointing referees, advertising games and calling games off.
---

# cc: CentreCircle CLI

Run `cc <command>` (PowerShell; Git Bash mangles leading-slash paths). Add `--json` for raw output. Never print or log the token.
Age filters are not hardcoded: pass `--age 12-17` / `--age 14` / `--all-ages`, or rely on `cc config` defaults. Check `cc config show` first so you know the league and default ages.

Read-only:
- `cc fixtures --date D [--to D] [--no-ref] [--skip-midnight] [--status S]`: `--skip-midnight` drops 00:00 placeholder KOs.
- `cc spare-games --date D`: copy-ready email for games with no referee (real KO, cups flagged). Check the short club names.
- `cc coverage --from <Sunday> [--bands 12-14,15-17]`: coverage table from CentreCircle data only.
- `cc fixture <id>`, `cc referees <id> [--search t]`, `cc api GET <path> -p k=v`.

Writes (each prints a plan and does nothing without `--yes`; show the user the plan and get approval for that game first):
- `cc appoint <id> --email E` / `cc unappoint <id>`. Never use `--force` unasked (appointing on an advertised game consumes the advert).
- `cc advertise <id> [--fee 22]` / `cc cancel-advert <id>`: notifies real referees. Referee role only. Skip 00:00 placeholder games and report them.
- `cc game-off <id> --note T [--reason R]` / `cc game-on <id>`: visible to clubs.

Rules: only act on games the user explicitly approved. Report the verification line honestly; the server can return 200 and ignore a change. Do not use `cc api POST/PUT/DELETE` without approval of that exact call. Appointing does not update FA Fulltime, so say so. Assistants are not supported. If `cc` reports not logged in, ask the user to run `cc auth login` themselves; never ask for or handle their password.
