import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";
import { friendlyError } from "./lib/friendlyError.js";

function formatPoints(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

const PLACEHOLDER_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='11' fill='%23334155'/%3E%3C/svg%3E";

// Инфографика популярности клубов — горизонтальные полосы, длина
// пропорциональна максимуму, чтобы разница была видна с одного взгляда.
function PopularClubsChart({ rows, logoByClubId }) {
  const max = Math.max(1, ...rows.map(r => r.times_picked));
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">Самые популярные клубы тура</div>
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-3 flex flex-col gap-2">
        {rows.length === 0 ? (
          <div className="text-slate-500 text-sm px-1 py-2">Пока никто не выбрал клубы.</div>
        ) : (
          rows.map((r, i) => (
            <div key={r.club_id} className="flex items-center gap-2.5">
              <div className="w-4 text-slate-500 font-semibold flex-shrink-0 text-xs">{i + 1}</div>
              <img src={logoByClubId.get(r.club_id) || PLACEHOLDER_LOGO} alt="" className="w-6 h-6 object-contain flex-shrink-0" />
              <div className="w-32 flex-shrink-0 truncate text-sm font-medium">{r.club_name}</div>
              <div className="flex-1 h-4 rounded bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded bg-gradient-to-r from-emerald-500 to-emerald-400"
                  style={{ width: `${Math.max(6, (r.times_picked / max) * 100)}%` }}
                />
              </div>
              <div className="w-6 flex-shrink-0 text-right font-bold text-sm">{r.times_picked}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Личный зачёт с колонкой на каждый тур — как в обычной "Таблице", только
// без подсветки "это я" (тут смотрит админ, а не конкретный игрок) и с более
// плотной вёрсткой для скриншота.
function PersonalByTourTable({ rows, byTourRows, gameweekIds }) {
  const pointsByProfile = new Map();
  byTourRows.forEach(r => {
    const m = pointsByProfile.get(r.profile_id) || new Map();
    m.set(r.gameweek_id, r.points);
    pointsByProfile.set(r.profile_id, m);
  });

  return (
    <div>
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">Личный зачёт</div>
      <div className="rounded-xl border border-slate-700 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
              <th className="text-left px-3 py-1.5">#</th>
              <th className="text-left px-3 py-1.5">Игрок</th>
              {gameweekIds.map(id => (
                <th key={id} className="px-3 py-1.5 text-center whitespace-nowrap">Тур {id}</th>
              ))}
              <th className="px-3 py-1.5 text-center">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={gameweekIds.length + 3} className="text-slate-500 text-sm px-4 py-3">Пока пусто.</td></tr>
            ) : (
              rows.map((r, i) => {
                const tourPoints = pointsByProfile.get(r.profile_id);
                return (
                  <tr key={r.profile_id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                    <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                    <td className="px-3 py-1.5 font-medium truncate">{r.username}</td>
                    {gameweekIds.map(id => (
                      <td key={id} className="px-3 py-1.5 text-center text-slate-300">
                        {tourPoints?.has(id) ? formatPoints(tourPoints.get(id)) : "—"}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-center font-bold">{formatPoints(r.total_points)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Компактная страница только для скриншота в пост — личная и командная
// таблицы рядом, с брендингом сверху, без лишних UI-элементов (вкладок,
// подписей "N тур сыграно" и т.п.), чтобы влезло побольше строк.
function CompactTable({ title, rows, nameKey, subtitle, badge }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">{title}</div>
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        {rows.length === 0 ? (
          <div className="text-slate-500 text-sm px-4 py-3">Пока пусто.</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r[nameKey] + i}
              className={`px-3 py-1.5 text-sm ${i > 0 ? "border-t border-slate-800" : ""} ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-5 text-slate-500 font-semibold flex-shrink-0 text-xs">{i + 1}</div>
                <div className="flex-1 min-w-0 truncate font-medium">{r[nameKey]}</div>
                {badge && <div className="flex-shrink-0">{badge(r)}</div>}
                <div className="font-bold flex-shrink-0">{formatPoints(r.total_points)}</div>
              </div>
              {subtitle && (
                <div className="pl-8 text-[11px] text-slate-500 truncate">{subtitle(r)}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const GROUP_LABELS = ["A", "B"];

// Компактная таблица одной группы плей-офф — для скриншота, без подсветки
// "это я" (тут смотрит админ). Результат матча считается на лету по очкам
// обоих игроков за тот тур (byTourRows), как и на вкладке "Таблица".
function GroupTable({ label, members, fixtures, pointsByTour }) {
  function getPoints(profileId, gwId) {
    return pointsByTour.get(profileId)?.get(gwId);
  }

  const nameByProfile = new Map(members.map(m => [m.profile_id, m.fantasysta_profiles?.username || "?"]));
  const standings = new Map(members.map(m => [m.profile_id, { played: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0, gpts: 0 }]));
  fixtures.forEach(f => {
    const p1 = getPoints(f.profile_id_1, f.gameweek_id);
    const p2 = getPoints(f.profile_id_2, f.gameweek_id);
    if (p1 === undefined || p2 === undefined) return;
    const s1 = standings.get(f.profile_id_1);
    const s2 = standings.get(f.profile_id_2);
    s1.played++; s2.played++;
    s1.pf += p1; s1.pa += p2;
    s2.pf += p2; s2.pa += p1;
    if (p1 > p2) { s1.w++; s2.l++; s1.gpts += 3; }
    else if (p1 < p2) { s2.w++; s1.l++; s2.gpts += 3; }
    else { s1.d++; s2.d++; s1.gpts += 1; s2.gpts += 1; }
  });
  const table = members
    .map(m => ({ profileId: m.profile_id, name: nameByProfile.get(m.profile_id), ...standings.get(m.profile_id) }))
    .sort((a, b) => b.gpts - a.gpts || (b.pf - b.pa) - (a.pf - a.pa));

  const byRound = new Map();
  fixtures.forEach(f => {
    const list = byRound.get(f.round) || [];
    list.push(f);
    byRound.set(f.round, list);
  });

  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">Группа {label}</div>
      <div className="rounded-xl border border-slate-700 overflow-hidden mb-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
              <th className="text-left px-3 py-1.5">#</th>
              <th className="text-left px-3 py-1.5">Игрок</th>
              <th className="px-2 py-1.5 text-center">И</th>
              <th className="px-2 py-1.5 text-center">В</th>
              <th className="px-2 py-1.5 text-center">Н</th>
              <th className="px-2 py-1.5 text-center">П</th>
              <th className="px-3 py-1.5 text-center">О</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r, i) => (
              <tr key={r.profileId} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                <td className="px-3 py-1.5 font-medium truncate">{r.name}</td>
                <td className="px-2 py-1.5 text-center text-slate-300">{r.played}</td>
                <td className="px-2 py-1.5 text-center text-slate-300">{r.w}</td>
                <td className="px-2 py-1.5 text-center text-slate-300">{r.d}</td>
                <td className="px-2 py-1.5 text-center text-slate-300">{r.l}</td>
                <td className="px-3 py-1.5 text-center font-bold">{r.gpts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1">
        {[1, 2, 3, 4, 5].map(round => {
          const list = byRound.get(round) || [];
          if (list.length === 0) return null;
          return (
            <div key={round} className="text-xs text-slate-400 flex flex-wrap gap-x-3 gap-y-0.5">
              <span className="text-slate-500 font-semibold flex-shrink-0">Тур {round + 3}:</span>
              {list.map((f, idx) => {
                const p1 = getPoints(f.profile_id_1, f.gameweek_id);
                const p2 = getPoints(f.profile_id_2, f.gameweek_id);
                const played = p1 !== undefined && p2 !== undefined;
                return (
                  <span key={idx}>
                    {nameByProfile.get(f.profile_id_1)} {played ? `${p1}:${p2}` : "—"} {nameByProfile.get(f.profile_id_2)}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AdminScreenshotInner({ user }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [personal, setPersonal] = useState([]);
  const [byTourRows, setByTourRows] = useState([]);
  const [gameweekIds, setGameweekIds] = useState([]);
  const [teams, setTeams] = useState([]);
  const [membersByTeam, setMembersByTeam] = useState(new Map());
  const [popularClubs, setPopularClubs] = useState([]);
  const [logoByClubId, setLogoByClubId] = useState(new Map());
  const [groupMembers, setGroupMembers] = useState([]);
  const [groupFixtures, setGroupFixtures] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [pRes, byTourRes, tRes, mRes, allGwRes, gmRes, gfRes] = await Promise.all([
          supabase.from("leaderboard_solo").select("*").order("total_points", { ascending: false }),
          supabase.from("leaderboard_solo_by_tour").select("*"),
          supabase.from("leaderboard_teams").select("*").order("total_points", { ascending: false }),
          supabase.from("team_members").select("team_id, fantasysta_profiles(username)"),
          supabase.from("gameweeks").select("id").order("id", { ascending: true }),
          supabase.from("solo_group_members").select("group_label, seed, profile_id, fantasysta_profiles(username)").order("group_label").order("seed"),
          supabase.from("solo_group_fixtures").select("group_label, round, gameweek_id, profile_id_1, profile_id_2").order("group_label").order("round"),
        ]);
        if (pRes.error) throw pRes.error;
        if (byTourRes.error) throw byTourRes.error;
        if (tRes.error) throw tRes.error;
        if (mRes.error) throw mRes.error;
        if (allGwRes.error) throw allGwRes.error;
        if (gmRes.error) throw gmRes.error;
        if (gfRes.error) throw gfRes.error;
        if (cancelled) return;
        setPersonal(pRes.data || []);
        setByTourRows(byTourRes.data || []);
        setTeams(tRes.data || []);
        setGroupMembers(gmRes.data || []);
        setGroupFixtures(gfRes.data || []);
        const allGwIds = (allGwRes.data || []).map(g => g.id);
        setGameweekIds(allGwIds);

        const map = new Map();
        (mRes.data || []).forEach(m => {
          const list = map.get(m.team_id) || [];
          list.push(m.fantasysta_profiles?.username || m.team_id);
          map.set(m.team_id, list);
        });
        setMembersByTeam(map);

        const latestGwId = allGwIds.length > 0 ? allGwIds[allGwIds.length - 1] : null;
        if (latestGwId != null) {
          const [popRes, clubsRes] = await Promise.all([
            supabase.from("club_pick_popularity").select("*").eq("gameweek_id", latestGwId).order("times_picked", { ascending: false }).limit(12),
            supabase.from("clubs").select("id, logo_url"),
          ]);
          if (cancelled) return;
          if (popRes.error) throw popRes.error;
          if (clubsRes.error) throw clubsRes.error;
          setPopularClubs(popRes.data || []);
          setLogoByClubId(new Map((clubsRes.data || []).map(c => [c.id, c.logo_url])));
        }
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pointsByTourMap = useMemo(() => {
    const map = new Map();
    byTourRows.forEach(r => {
      const m = map.get(r.profile_id) || new Map();
      m.set(r.gameweek_id, Number(r.points));
      map.set(r.profile_id, m);
    });
    return map;
  }, [byTourRows]);

  if (!ADMIN_EMAILS.includes(user.email)) {
    return <div className="p-10 text-center text-slate-400">Эта страница только для админа.</div>;
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <img src="/logo.png" alt="" className="w-9 h-9 rounded-md" />
          <span><span className="text-emerald-400">FANTASY</span>STA</span>
        </div>

        {loading ? (
          <div className="text-slate-400 py-8 text-center">Загрузка…</div>
        ) : error ? (
          <div className="text-red-400 py-8 text-center">{error}</div>
        ) : (
          <>
            <PersonalByTourTable rows={personal} byTourRows={byTourRows} gameweekIds={gameweekIds} />
            <div className="flex flex-col md:flex-row gap-6">
              <CompactTable
                title="Командный зачёт"
                rows={teams}
                nameKey="team_name"
                subtitle={r => `В зачёте: ${(membersByTeam.get(r.team_id) || []).join(", ") || "—"}`}
              />
              <PopularClubsChart rows={popularClubs} logoByClubId={logoByClubId} />
            </div>
            {groupMembers.length > 0 && (
              <div className="flex flex-col md:flex-row gap-6">
                {GROUP_LABELS.map(label => (
                  <GroupTable
                    key={label}
                    label={label}
                    members={groupMembers.filter(m => m.group_label === label)}
                    fixtures={groupFixtures.filter(f => f.group_label === label)}
                    pointsByTour={pointsByTourMap}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
