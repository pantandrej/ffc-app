# Fixtures 13 Oct - 30 Nov 2026 (season 2026/27)

`fixtures_oct13_nov30_2026.json` - 415 real fixtures, one object per match:

```json
{"league": "EPL", "round": "9", "date": "2026-11-01", "time": "16:30", "tz": "UTC", "home": "Ливерпуль", "away": "Арсенал", "tbc": false}
```

- `league`: `Bundesliga | EPL | LaLiga | SerieA | Ligue1 | UCL | UEL | UECL`
- `round`: domestic tour number as plain string (`"9"`); eurocups `"MD<n>"` (sports.ru numbering, see notes).
- `date` / `time`: **UTC** (the UTC date, so a 21:00 CET match is 20:00 UTC same day).
- `home` / `away`: roster short names exactly as in the brief. Non-roster eurocup opponents keep the sports.ru Russian name.
- `tbc`: `true` when the real date/time has not been set by the league yet (see below).
- Sorted by date, time, league (EPL, Bundesliga, LaLiga, SerieA, Ligue1, UCL, UEL, UECL).

Range: matches whose **UTC date** is 2026-10-13 .. 2026-11-30 inclusive.

## Sources

1. **Primary - sports.ru calendar pages** (`/football/tournament/{premier-league,bundesliga,la-liga,seria-a,ligue-1,ucl,uel}/calendar/`, and `/uecl/calendar/?s=1572821&m=10|11` for the Conference League). The new-style pages carry the kick-off as a machine-readable UTC timestamp (`<time datetime="...Z">`), so no timezone guessing was needed (the visible time is MSK = UTC+3). The old-style Conference League page only shows MSK, converted to UTC by -3h.
2. **Second source - ESPN public scoreboard API** (`site.api.espn.com/apis/site/v2/sports/soccer/{eng.1,ger.1,esp.1,ita.1,fra.1,uefa.champions,uefa.europa,uefa.europa.conf}/scoreboard?dates=YYYYMMDD`). All 415 fixtures were compared automatically (date, UTC time, home/away; for eurocups the roster side + date/time + home/away order). 384 matched exactly.
3. Tie-breakers: bundesliga.com matchday-11 page and t-online live ticker (Hoffenheim - Augsburg), laliga.com match pages (LaLiga R12-R14 dates).

## Uncertainties

- **30 tbc matches - LaLiga rounds 12, 13, 14** (all 10 matches each). The league has not set days/times yet (LaLiga normally confirms 15-20 days before the round). sports.ru and laliga.com both list the Sunday of the round (2026-11-08, 2026-11-22, 2026-11-29) as a placeholder; real matches will be spread Fri-Mon. `time` is `"00:00"` (sports.ru's placeholder; ESPN uses 20:00 UTC) - treat it as meaningless when `tbc` is true.
- **Hoffenheim - Augsburg (Bundesliga R11)**: sports.ru and bundesliga.com = Sun 2026-11-29 16:30 UTC (t-online: 17:30 CET, same); ESPN shows Sat 28 Nov 20:00 UTC but flags it as TBD (placeholder). 29 Nov 16:30 UTC used, `tbc: false`.
- Times for rounds that are not yet 2-3 weeks away can still be moved by TV selection (esp. EPL/Serie A/Ligue 1 later rounds, Bundesliga R10-R11); the data reflects what the sources published on 2026-10-09.
- **Conference League matchday numbers**: sports.ru numbers the 2026/27 league phase MD1 = 15 Oct, MD2 = 22 Oct, MD3 = 5 Nov, MD4 = 26 Nov; ESPN agrees on every date/time. Labels follow sports.ru. (UEL/UCL labels also follow sports.ru: UCL MD2-MD5, UEL MD2-MD5.)
- LaLiga round 6: only one match (Levante - Athletic, 2026-10-21 18:00 UTC) is still unplayed/postponed on sports.ru, so that round is "partial" by design - it is the only LaLiga match of that round in range.
- Eurocup rows are included only if at least one side is a roster club (UCL 60, UEL 38, UECL 18). Eurocup matches between two non-roster clubs are skipped.

Full sanity-check output is in the PR description.
