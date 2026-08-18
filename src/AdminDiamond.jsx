import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";

function friendlyError(e) {
  return e?.message || String(e || "Неизвестная ошибка");
}

// Админка Бриллиантовой лиги: создание матчей тура, пересчёт микробаттлов
// 1x1 (recalc_diamond_gameweek) и просмотр турнирной таблицы.
export function AdminDiamondInner({ user }) {
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);

  const [gameweeks, setGameweeks] = useState([]);
  const [gameweekId, setGameweekId] = useState(null);
  const [teams, setTeams] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [table, setTable] = useState([]);

  const [homeTeamId, setHomeTeamId] = useState("");
  const [awayTeamId, setAwayTeamId] = useState("");

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [gwRes, teamsRes] = await Promise.all([
          supabase.from("gameweeks").select("*").order("id"),
          supabase.from("teams").select("id,name").order("name"),
        ]);
        if (gwRes.error) throw gwRes.error;
        if (teamsRes.error) throw teamsRes.error;
        if (cancelled) return;
        setGameweeks(gwRes.data || []);
        setTeams(teamsRes.data || []);
        const active = (gwRes.data || []).find(g => g.status === "active") || (gwRes.data || [])[0];
        if (active) setGameweekId(active.id);
      } catch (e) {
        if (!cancelled) showToast(friendlyError(e), "error");
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  const loadFixtures = useCallback(async () => {
    if (!gameweekId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("fixtures")
        .select("id,status,home_score,away_score,home_team_id,away_team_id,teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name)")
        .eq("gameweek_number", gameweekId)
        .order("id");
      if (error) throw error;
      setFixtures(data || []);
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setLoading(false);
    }
  }, [gameweekId, showToast]);

  const loadTable = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("league_table")
        .select("team_id,played,wins,draws,losses,points,goals_for,goals_against,teams(name)")
        .order("points", { ascending: false });
      if (error) throw error;
      setTable(data || []);
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [showToast]);

  useEffect(() => { loadFixtures(); }, [loadFixtures]);
  useEffect(() => { loadTable(); }, [loadTable]);

  async function createFixture(e) {
    e.preventDefault();
    if (!gameweekId || !homeTeamId || !awayTeamId || homeTeamId === awayTeamId) {
      showToast("Выбери тур и двух разных команд", "error");
      return;
    }
    setCreateBusy(true);
    try {
      const { error } = await supabase.from("fixtures").insert({
        gameweek_number: gameweekId,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
      });
      if (error) throw error;
      showToast("✓ Матч добавлен в календарь");
      setHomeTeamId("");
      setAwayTeamId("");
      await loadFixtures();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setCreateBusy(false);
    }
  }

  async function recalc() {
    if (!gameweekId) return;
    setRecalcBusy(true);
    try {
      const { error } = await supabase.rpc("recalc_diamond_gameweek", { p_gameweek_number: gameweekId });
      if (error) throw error;
      showToast("✓ Тур пересчитан");
      await Promise.all([loadFixtures(), loadTable()]);
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setRecalcBusy(false);
    }
  }

  if (!ADMIN_EMAILS.includes(user.email)) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="text-center text-slate-400 max-w-sm">Эта страница только для админа.</div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">
        <div>
          <h1 className="text-xl font-extrabold mb-4">💎 Бриллиантовая лига · Админка</h1>
          <select
            value={gameweekId ?? ""}
            onChange={e => setGameweekId(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
          >
            {gameweeks.map(gw => (
              <option key={gw.id} value={gw.id}>Тур №{gw.id} · {gw.status}</option>
            ))}
          </select>
        </div>

        <section>
          <h2 className="font-bold mb-3">Добавить матч в тур</h2>
          <form onSubmit={createFixture} className="flex flex-wrap items-center gap-2">
            <select
              value={homeTeamId}
              onChange={e => setHomeTeamId(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            >
              <option value="">Команда (дома)</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <span className="text-slate-500">—</span>
            <select
              value={awayTeamId}
              onChange={e => setAwayTeamId(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            >
              <option value="">Команда (гости)</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              type="submit"
              disabled={createBusy}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:opacity-50 transition"
            >
              Добавить
            </button>
          </form>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">Матчи тура</h2>
            <button
              type="button"
              onClick={recalc}
              disabled={recalcBusy}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50 transition"
            >
              {recalcBusy ? "Считаю…" : "Пересчитать тур (микробаттлы 1×1)"}
            </button>
          </div>
          {loading ? (
            <div className="text-slate-400 text-sm">Загрузка…</div>
          ) : fixtures.length === 0 ? (
            <div className="text-slate-500 text-sm">В этом туре пока нет матчей.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {fixtures.map(fx => (
                <div key={fx.id} className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 flex items-center justify-between gap-3 text-sm">
                  <div className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{fx.teams?.name || fx.home_team_id}</span>
                    <span className="text-slate-500"> vs </span>
                    <span className="font-medium">{fx.away?.name || fx.away_team_id}</span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="font-bold">
                      {fx.status === "finished" ? `${fx.home_score} : ${fx.away_score}` : "—"}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${fx.status === "finished" ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700 text-slate-400"}`}>
                      {fx.status === "finished" ? "сыгран" : "запланирован"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="font-bold mb-3">Турнирная таблица</h2>
          {table.length === 0 ? (
            <div className="text-slate-500 text-sm">Пока нет сыгранных матчей.</div>
          ) : (
            <div className="rounded-2xl border border-slate-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                    <th className="text-left px-4 py-2">Команда</th>
                    <th className="px-2 py-2">И</th>
                    <th className="px-2 py-2">В</th>
                    <th className="px-2 py-2">Н</th>
                    <th className="px-2 py-2">П</th>
                    <th className="px-2 py-2">GF</th>
                    <th className="px-2 py-2">GA</th>
                    <th className="px-2 py-2">Очки</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((row, i) => (
                    <tr key={row.team_id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                      <td className="px-4 py-2 font-medium">{row.teams?.name || row.team_id}</td>
                      <td className="px-2 py-2 text-center">{row.played}</td>
                      <td className="px-2 py-2 text-center">{row.wins}</td>
                      <td className="px-2 py-2 text-center">{row.draws}</td>
                      <td className="px-2 py-2 text-center">{row.losses}</td>
                      <td className="px-2 py-2 text-center">{row.goals_for}</td>
                      <td className="px-2 py-2 text-center">{row.goals_against}</td>
                      <td className="px-2 py-2 text-center font-bold text-emerald-400">{row.points}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 max-w-sm rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${toast.kind === "error" ? "bg-red-600 text-white" : "bg-emerald-500 text-slate-900"}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
