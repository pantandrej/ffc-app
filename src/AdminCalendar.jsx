import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAIL } from "./AdminResults.jsx";

const LEAGUES = ["EPL", "LaLiga", "SerieA", "Bundesliga", "Ligue1"];

function friendlyError(e) {
  return e?.message || String(e || "Неизвестная ошибка");
}

// Админка тура: даты понедельник-воскресенье, календарь реальных матчей всех
// 5 чемпионатов на тур, и таблица популярности выбора клубов игроками.
export function AdminCalendarInner({ user }) {
  const [toast, setToast] = useState(null);
  const [savingDates, setSavingDates] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);

  const [gameweeks, setGameweeks] = useState([]);
  const [gameweekId, setGameweekId] = useState(null);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");

  const [clubs, setClubs] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [popularity, setPopularity] = useState([]);
  const [popularityScope, setPopularityScope] = useState("gameweek"); // "gameweek" | "all"

  const [league, setLeague] = useState(LEAGUES[0]);
  const [homeClubId, setHomeClubId] = useState("");
  const [awayClubId, setAwayClubId] = useState("");
  const [kickoffAt, setKickoffAt] = useState("");

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [gwRes, clubsRes] = await Promise.all([
          supabase.from("gameweeks").select("*").order("id"),
          supabase.from("clubs").select("id,name,league").order("league").order("name"),
        ]);
        if (gwRes.error) throw gwRes.error;
        if (clubsRes.error) throw clubsRes.error;
        if (cancelled) return;
        setGameweeks(gwRes.data || []);
        setClubs(clubsRes.data || []);
        const active = (gwRes.data || []).find(g => g.status === "active") || (gwRes.data || [])[0];
        if (active) setGameweekId(active.id);
      } catch (e) {
        if (!cancelled) showToast(friendlyError(e), "error");
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  useEffect(() => {
    const gw = gameweeks.find(g => g.id === gameweekId);
    setStartsOn(gw?.starts_on || "");
    setEndsOn(gw?.ends_on || "");
  }, [gameweekId, gameweeks]);

  const loadFixtures = useCallback(async () => {
    if (!gameweekId) return;
    try {
      const { data, error } = await supabase
        .from("club_fixtures")
        .select("id,league,kickoff_at,home_club_id,away_club_id,home:clubs!club_fixtures_home_club_id_fkey(name),away:clubs!club_fixtures_away_club_id_fkey(name)")
        .eq("gameweek_id", gameweekId)
        .order("league")
        .order("kickoff_at");
      if (error) throw error;
      setFixtures(data || []);
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [gameweekId, showToast]);

  const loadPopularity = useCallback(async () => {
    try {
      let query = supabase.from("club_pick_popularity").select("*");
      if (popularityScope === "gameweek" && gameweekId) query = query.eq("gameweek_id", gameweekId);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      if (popularityScope === "all") {
        const map = new Map();
        rows.forEach(r => {
          const cur = map.get(r.club_id) || { club_name: r.club_name, league: r.league, times_picked: 0 };
          cur.times_picked += r.times_picked;
          map.set(r.club_id, cur);
        });
        setPopularity([...map.values()].sort((a, b) => b.times_picked - a.times_picked));
      } else {
        setPopularity(rows.sort((a, b) => b.times_picked - a.times_picked));
      }
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [gameweekId, popularityScope, showToast]);

  useEffect(() => { loadFixtures(); }, [loadFixtures]);
  useEffect(() => { loadPopularity(); }, [loadPopularity]);

  async function saveDates() {
    if (!gameweekId) return;
    setSavingDates(true);
    try {
      const { error } = await supabase
        .from("gameweeks")
        .update({ starts_on: startsOn || null, ends_on: endsOn || null })
        .eq("id", gameweekId);
      if (error) throw error;
      setGameweeks(prev => prev.map(g => (g.id === gameweekId ? { ...g, starts_on: startsOn, ends_on: endsOn } : g)));
      showToast("✓ Даты тура сохранены");
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setSavingDates(false);
    }
  }

  const clubsInLeague = useMemo(() => clubs.filter(c => c.league === league), [clubs, league]);

  async function addFixture(e) {
    e.preventDefault();
    if (!gameweekId || !homeClubId || !awayClubId || homeClubId === awayClubId) {
      showToast("Выбери тур, лигу и двух разных клубов", "error");
      return;
    }
    setCreateBusy(true);
    try {
      const { error } = await supabase.from("club_fixtures").insert({
        gameweek_id: gameweekId,
        league,
        home_club_id: homeClubId,
        away_club_id: awayClubId,
        kickoff_at: kickoffAt || null,
      });
      if (error) throw error;
      showToast("✓ Матч добавлен");
      setHomeClubId("");
      setAwayClubId("");
      setKickoffAt("");
      await loadFixtures();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setCreateBusy(false);
    }
  }

  async function deleteFixture(id) {
    try {
      const { error } = await supabase.from("club_fixtures").delete().eq("id", id);
      if (error) throw error;
      await loadFixtures();
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }

  if (user.email !== ADMIN_EMAIL) {
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
          <h1 className="text-xl font-extrabold mb-4">📅 Календарь тура · Админка</h1>
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
          <h2 className="font-bold mb-3">Даты тура (понедельник – воскресенье)</h2>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={startsOn || ""}
              onChange={e => setStartsOn(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            />
            <span className="text-slate-500">—</span>
            <input
              type="date"
              value={endsOn || ""}
              onChange={e => setEndsOn(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            />
            <button
              type="button"
              onClick={saveDates}
              disabled={savingDates}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:opacity-50 transition"
            >
              Сохранить даты
            </button>
          </div>
        </section>

        <section>
          <h2 className="font-bold mb-3">Добавить матч в календарь</h2>
          <form onSubmit={addFixture} className="flex flex-wrap items-center gap-2">
            <select
              value={league}
              onChange={e => { setLeague(e.target.value); setHomeClubId(""); setAwayClubId(""); }}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            >
              {LEAGUES.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select
              value={homeClubId}
              onChange={e => setHomeClubId(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            >
              <option value="">Клуб (дома)</option>
              {clubsInLeague.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="text-slate-500">—</span>
            <select
              value={awayClubId}
              onChange={e => setAwayClubId(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            >
              <option value="">Клуб (гости)</option>
              {clubsInLeague.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input
              type="datetime-local"
              value={kickoffAt}
              onChange={e => setKickoffAt(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
            />
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
          <h2 className="font-bold mb-3">Матчи тура</h2>
          {fixtures.length === 0 ? (
            <div className="text-slate-500 text-sm">Матчей пока не добавлено.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {fixtures.map(fx => (
                <div key={fx.id} className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 flex items-center justify-between gap-3 text-sm">
                  <span className="text-xs text-slate-500 w-24 flex-shrink-0">{fx.league}</span>
                  <div className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{fx.home?.name}</span>
                    <span className="text-slate-500"> — </span>
                    <span className="font-medium">{fx.away?.name}</span>
                  </div>
                  <span className="text-xs text-slate-500 flex-shrink-0">
                    {fx.kickoff_at ? new Date(fx.kickoff_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                  </span>
                  <button type="button" onClick={() => deleteFixture(fx.id)} className="text-slate-500 hover:text-red-400 flex-shrink-0">✕</button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold">Популярность клубов у игроков</h2>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setPopularityScope("gameweek")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${popularityScope === "gameweek" ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300"}`}
              >
                Этот тур
              </button>
              <button
                type="button"
                onClick={() => setPopularityScope("all")}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${popularityScope === "all" ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300"}`}
              >
                За всё время
              </button>
            </div>
          </div>
          {popularity.length === 0 ? (
            <div className="text-slate-500 text-sm">Пока никто не выбрал клубы.</div>
          ) : (
            <div className="rounded-2xl border border-slate-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Клуб</th>
                    <th className="text-left px-4 py-2">Лига</th>
                    <th className="px-4 py-2">Выбран раз</th>
                  </tr>
                </thead>
                <tbody>
                  {popularity.map((row, i) => (
                    <tr key={row.club_id || row.club_name} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                      <td className="px-4 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-4 py-2 font-medium">{row.club_name}</td>
                      <td className="px-4 py-2 text-slate-400">{row.league}</td>
                      <td className="px-4 py-2 text-center font-bold text-emerald-400">{row.times_picked}</td>
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
