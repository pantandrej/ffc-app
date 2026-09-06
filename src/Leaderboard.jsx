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

// Таблица "Общей лиги": вкладки — Личный (сумма очков за всё время) и
// Командный (средний командный зачёт, сумма за всё время).
export default function Leaderboard({ user }) {
  const [tab, setTab] = useState("points"); // "points" | "teams"
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
    <div className="max-w-2xl mx-auto p-4 md:p-8">
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
        </div>
      </div>

      {tab === "points" && <PointsTab user={user} />}
      {tab === "teams" && <TeamsTab user={user} myTeamId={myTeamId} />}
    </div>
  );
}
