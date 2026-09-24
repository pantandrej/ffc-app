import React, { useState, useEffect } from "react";
import { supabase } from "./lib/supabaseClient.js";

function formatPoints(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

// Личный зачёт "все против всех" — никакой зависимости от команд: сумма
// очков по собственным сетам игрока за все туры, с разбивкой по турам
// (см. leaderboard_solo / leaderboard_solo_by_tour).
function PointsTab({ user }) {
  const [rows, setRows] = useState([]);
  const [byTourRows, setByTourRows] = useState([]);
  const [gameweekIds, setGameweekIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [totalsRes, byTourRes, gwRes] = await Promise.all([
        supabase.from("leaderboard_solo").select("*").order("total_points", { ascending: false }),
        supabase.from("leaderboard_solo_by_tour").select("*"),
        supabase.from("gameweeks").select("id").order("id", { ascending: true }),
      ]);
      if (cancelled) return;
      if (totalsRes.error) setError(totalsRes.error.message);
      else if (byTourRes.error) setError(byTourRes.error.message);
      else if (gwRes.error) setError(gwRes.error.message);
      else {
        setRows(totalsRes.data || []);
        setByTourRows(byTourRes.data || []);
        setGameweekIds((gwRes.data || []).map(g => g.id));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="text-slate-400 py-8 text-center">Загрузка…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (rows.length === 0) return <div className="text-slate-400 text-center py-16">Пока никто не набрал очков.</div>;

  const pointsByProfile = new Map();
  byTourRows.forEach(r => {
    const m = pointsByProfile.get(r.profile_id) || new Map();
    m.set(r.gameweek_id, r.points);
    pointsByProfile.set(r.profile_id, m);
  });

  return (
    <div className="rounded-xl border border-slate-700 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
            <th className="text-left px-3 py-2">#</th>
            <th className="text-left px-3 py-2">Игрок</th>
            {gameweekIds.map(id => (
              <th key={id} className="px-3 py-2 text-center whitespace-nowrap">Тур {id}</th>
            ))}
            <th className="px-3 py-2 text-center">Сумма</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isMe = r.profile_id === user.id;
            const tourPoints = pointsByProfile.get(r.profile_id);
            return (
              <tr
                key={r.profile_id}
                className={`border-t border-slate-800 ${isMe ? "bg-emerald-500/10" : i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}
              >
                <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                <td className={`px-3 py-2 font-semibold truncate ${isMe ? "text-emerald-400" : ""}`}>{r.username}</td>
                {gameweekIds.map(id => (
                  <td key={id} className="px-3 py-2 text-center text-slate-300">
                    {tourPoints?.has(id) ? formatPoints(tourPoints.get(id)) : "—"}
                  </td>
                ))}
                <td className="px-3 py-2 text-center font-bold text-base">{formatPoints(r.total_points)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Командный зачёт — среднее очков участников за тур (team_results, module 12),
// просуммированное по всем сыгранным турам. Информационно: Бриллиантовая лига
// (сама борьба команд) ещё не запущена, но игрокам интересно видеть зачёт своей
// команды уже сейчас.
function TeamsTab({ user, myTeamId }) {
  const [rows, setRows] = useState([]);
  const [membersByTeam, setMembersByTeam] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [teamsRes, membersRes] = await Promise.all([
        supabase.from("leaderboard_teams").select("*").order("total_points", { ascending: false }),
        supabase.from("team_members").select("team_id, fantasysta_profiles(username)"),
      ]);
      if (cancelled) return;
      if (teamsRes.error) { setError(teamsRes.error.message); setLoading(false); return; }
      if (membersRes.error) { setError(membersRes.error.message); setLoading(false); return; }

      const map = new Map();
      (membersRes.data || []).forEach(m => {
        const list = map.get(m.team_id) || [];
        list.push(m.fantasysta_profiles?.username || m.team_id);
        map.set(m.team_id, list);
      });
      setMembersByTeam(map);
      setRows(teamsRes.data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="text-slate-400 py-8 text-center">Загрузка…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (rows.length === 0) return <div className="text-slate-400 text-center py-16">Пока нет команд с результатами.</div>;

  return (
    <div className="rounded-xl border border-slate-700 overflow-hidden">
      {rows.map((r, i) => {
        const isMyTeam = r.team_id === myTeamId;
        return (
          <div
            key={r.team_id}
            className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-slate-800" : ""} ${isMyTeam ? "bg-emerald-500/10" : "bg-slate-800"}`}
          >
            <div className="w-7 text-slate-400 font-semibold flex-shrink-0">{i + 1}</div>
            <div className="flex-1 min-w-0">
              <div className={`font-semibold truncate ${isMyTeam ? "text-emerald-400" : ""}`}>{r.team_name}</div>
              <div className="text-xs text-slate-500 truncate">{r.gameweeks_played} {r.gameweeks_played === 1 ? "тур" : "тура"} сыграно · среднее по составу</div>
              <div className="text-xs text-slate-500 truncate">В зачёте: {(membersByTeam.get(r.team_id) || []).join(", ") || "—"}</div>
            </div>
            <div className="font-bold text-lg flex-shrink-0">{formatPoints(r.total_points)}</div>
          </div>
        );
      })}
    </div>
  );
}

const GROUP_LABELS = ["A", "B"];

// Группы плей-офф личного зачёта — топ-12 разбиты змейкой на 2 группы по 6,
// внутри группы круговой турнир (5 туров = 5 соперников). Результат каждого
// матча группы считается на лету: сравниваем очки обоих игроков за тот
// реальный тур (leaderboard_solo_by_tour) — больше очков выиграл матч.
function GroupsTab({ user }) {
  const [members, setMembers] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [pointsByTour, setPointsByTour] = useState(new Map()); // profile_id -> Map(gw_id -> points)
  const [gwsWithResults, setGwsWithResults] = useState(new Set()); // туры, где реально есть club_results
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [membersRes, fixturesRes, byTourRes, resultsRes] = await Promise.all([
        supabase.from("solo_group_members").select("group_label, seed, profile_id, fantasysta_profiles(username)").order("group_label").order("seed"),
        supabase.from("solo_group_fixtures").select("group_label, round, gameweek_id, profile_id_1, profile_id_2").order("group_label").order("round"),
        supabase.from("leaderboard_solo_by_tour").select("profile_id, gameweek_id, points"),
        supabase.from("club_results").select("gameweek_id"),
      ]);
      if (cancelled) return;
      if (membersRes.error) setError(membersRes.error.message);
      else if (fixturesRes.error) setError(fixturesRes.error.message);
      else if (byTourRes.error) setError(byTourRes.error.message);
      else if (resultsRes.error) setError(resultsRes.error.message);
      else {
        setMembers(membersRes.data || []);
        setFixtures(fixturesRes.data || []);
        const map = new Map();
        (byTourRes.data || []).forEach(r => {
          const m = map.get(r.profile_id) || new Map();
          m.set(r.gameweek_id, Number(r.points));
          map.set(r.profile_id, m);
        });
        setPointsByTour(map);
        setGwsWithResults(new Set((resultsRes.data || []).map(r => r.gameweek_id)));
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="text-slate-400 py-8 text-center">Загрузка…</div>;
  if (error) return <div className="text-red-400 py-8 text-center">{error}</div>;
  if (members.length === 0) return <div className="text-slate-400 text-center py-16">Группы ещё не сформированы.</div>;

  const nameByProfile = new Map(members.map(m => [m.profile_id, m.fantasysta_profiles?.username || "?"]));

  // leaderboard_solo_by_tour отдаёт 0 очков и для ещё не сыгранного тура
  // (просто нет строк club_results, чтобы просуммировать) — поэтому матч
  // группы считаем решённым, только если по туру реально есть результаты.
  function getPoints(profileId, gwId) {
    if (!gwsWithResults.has(gwId)) return undefined;
    return pointsByTour.get(profileId)?.get(gwId);
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="text-xs text-sky-200 bg-sky-500/5 border border-sky-500/30 rounded-xl px-4 py-3">
        Топ-12 личного зачёта по итогам тура 3 разбит на 2 группы по 6 (места 1,4,5,8,9,12 — группа A; 2,3,6,7,10,11 — группа B).
        Внутри группы — круговой турнир: тур 4 = 1-й тур группы, ... тур 8 = 5-й (финальный) тур группы. Тур 9 — финал, пара определится по итогам групп.
      </div>

      {GROUP_LABELS.map(label => {
        const groupMembers = members.filter(m => m.group_label === label);
        const groupFixtures = fixtures.filter(f => f.group_label === label);

        // Считаем таблицу группы по сыгранным матчам.
        const standings = new Map(groupMembers.map(m => [m.profile_id, { played: 0, w: 0, d: 0, l: 0, pf: 0, pa: 0, gpts: 0 }]));
        groupFixtures.forEach(f => {
          const p1 = getPoints(f.profile_id_1, f.gameweek_id);
          const p2 = getPoints(f.profile_id_2, f.gameweek_id);
          if (p1 === undefined || p2 === undefined) return; // тур ещё не сыгран
          const s1 = standings.get(f.profile_id_1);
          const s2 = standings.get(f.profile_id_2);
          s1.played++; s2.played++;
          s1.pf += p1; s1.pa += p2;
          s2.pf += p2; s2.pa += p1;
          if (p1 > p2) { s1.w++; s2.l++; s1.gpts += 3; }
          else if (p1 < p2) { s2.w++; s1.l++; s2.gpts += 3; }
          else { s1.d++; s2.d++; s1.gpts += 1; s2.gpts += 1; }
        });
        const table = groupMembers
          .map(m => ({ profileId: m.profile_id, name: nameByProfile.get(m.profile_id), ...standings.get(m.profile_id) }))
          .sort((a, b) => b.gpts - a.gpts || b.pf - a.pf || (b.pf - b.pa) - (a.pf - a.pa));

        const byRound = new Map();
        groupFixtures.forEach(f => {
          const list = byRound.get(f.round) || [];
          list.push(f);
          byRound.set(f.round, list);
        });

        return (
          <div key={label}>
            <h2 className="font-extrabold text-lg mb-3">Группа {label}</h2>
            <div className="rounded-xl border border-slate-700 overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                    <th className="text-left px-3 py-2">#</th>
                    <th className="text-left px-3 py-2">Игрок</th>
                    <th className="px-2 py-2 text-center">И</th>
                    <th className="px-2 py-2 text-center">В</th>
                    <th className="px-2 py-2 text-center">Н</th>
                    <th className="px-2 py-2 text-center">П</th>
                    <th className="px-2 py-2 text-center">Очки+/-</th>
                    <th className="px-3 py-2 text-center">О</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((r, i) => {
                    const isMe = r.profileId === user.id;
                    return (
                      <tr key={r.profileId} className={`border-t border-slate-800 ${isMe ? "bg-emerald-500/10" : i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className={`px-3 py-2 font-semibold truncate ${isMe ? "text-emerald-400" : ""}`}>{r.name}</td>
                        <td className="px-2 py-2 text-center text-slate-300">{r.played}</td>
                        <td className="px-2 py-2 text-center text-slate-300">{r.w}</td>
                        <td className="px-2 py-2 text-center text-slate-300">{r.d}</td>
                        <td className="px-2 py-2 text-center text-slate-300">{r.l}</td>
                        <td className="px-2 py-2 text-center text-slate-400 text-xs">{r.pf}:{r.pa}</td>
                        <td className="px-3 py-2 text-center font-bold">{r.gpts}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
              {[1, 2, 3, 4, 5].map(round => {
                const list = byRound.get(round) || [];
                return (
                  <div key={round} className="rounded-lg border border-slate-700 bg-slate-800/60 p-2.5">
                    <div className="text-[10px] text-slate-500 uppercase font-semibold mb-1.5">Тур {round + 3} · {round}-й тур группы</div>
                    <div className="flex flex-col gap-1.5">
                      {list.map((f, idx) => {
                        const p1 = getPoints(f.profile_id_1, f.gameweek_id);
                        const p2 = getPoints(f.profile_id_2, f.gameweek_id);
                        const played = p1 !== undefined && p2 !== undefined;
                        return (
                          <div key={idx} className="text-xs flex items-center justify-between gap-1">
                            <span className="truncate flex-1">{nameByProfile.get(f.profile_id_1)}</span>
                            <span className={`font-bold flex-shrink-0 px-1 ${played ? "text-emerald-400" : "text-slate-600"}`}>
                              {played ? `${p1}:${p2}` : "—"}
                            </span>
                            <span className="truncate flex-1 text-right">{nameByProfile.get(f.profile_id_2)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="text-xs text-slate-500 text-center py-2">🏆 Тур 9 — финал групп (пара определится по итогам)</div>
    </div>
  );
}

// Таблица "Общей лиги": вкладки — Личный (сумма очков за всё время),
// Командный (средний командный зачёт, сумма за всё время) и Группы (плей-офф
// топ-12).
export default function Leaderboard({ user }) {
  const [tab, setTab] = useState("points"); // "points" | "teams" | "groups"
  const [myTeamId, setMyTeamId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("team_members").select("team_id").eq("profile_id", user.id).maybeSingle();
      if (!cancelled) setMyTeamId(data?.team_id || null);
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h1 className="text-xl font-extrabold">🏆 Рейтинг экспертов</h1>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setTab("points")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${tab === "points" ? "bg-emerald-500 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}
          >
            Личный
          </button>
          <button
            type="button"
            onClick={() => setTab("teams")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${tab === "teams" ? "bg-emerald-500 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}
          >
            Командный
          </button>
          <button
            type="button"
            onClick={() => setTab("groups")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${tab === "groups" ? "bg-emerald-500 text-slate-900" : "text-slate-300 hover:bg-slate-800"}`}
          >
            Группы
          </button>
        </div>
      </div>

      {tab === "points" && <PointsTab user={user} />}
      {tab === "teams" && <TeamsTab user={user} myTeamId={myTeamId} />}
      {tab === "groups" && <GroupsTab user={user} />}
    </div>
  );
}
