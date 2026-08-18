import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";

const LEAGUES = ["EPL", "LaLiga", "SerieA", "Bundesliga", "Ligue1"];

function friendlyError(e) {
  return e?.message || String(e || "Неизвестная ошибка");
}

function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Округляет конец дня для запроса "матчи по датам тура включительно".
function endOfDayIso(dateStr) {
  return `${dateStr}T23:59:59`;
}

// Админка тура: даты понедельник-воскресенье, календарь матчей (по датам, не
// привязан жёстко к туру — какой тур матч попадает, решают даты), таблица
// популярности выбора клубов игроками.
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
  const [pickedClubIds, setPickedClubIds] = useState(new Set());
  const [onlyPicked, setOnlyPicked] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editKickoff, setEditKickoff] = useState("");

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

  // Матчи показываем по датам тура (starts_on..ends_on включительно), а не по
  // жёсткой привязке к gameweek_id — так один раз занесённый календарь сам
  // "раскладывается" по турам.
  const loadFixtures = useCallback(async () => {
    if (!startsOn || !endsOn) {
      setFixtures([]);
      return;
    }
    try {
      const { data, error } = await supabase
        .from("club_fixtures")
        .select("id,league,kickoff_at,status,original_kickoff_at,home_club_id,away_club_id,home:clubs!club_fixtures_home_club_id_fkey(name),away:clubs!club_fixtures_away_club_id_fkey(name)")
        .gte("kickoff_at", startsOn)
        .lte("kickoff_at", endOfDayIso(endsOn))
        .order("league")
        .order("kickoff_at");
      if (error) throw error;
      setFixtures(data || []);
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [startsOn, endsOn, showToast]);

  const loadPickedClubs = useCallback(async () => {
    if (!gameweekId) { setPickedClubIds(new Set()); return; }
    try {
      const { data, error } = await supabase.from("club_pick_popularity").select("club_id").eq("gameweek_id", gameweekId);
      if (error) throw error;
      setPickedClubIds(new Set((data || []).map(r => r.club_id)));
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
  useEffect(() => { loadPickedClubs(); }, [loadPickedClubs]);
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

  const visibleFixtures = useMemo(
    () => onlyPicked ? fixtures.filter(fx => pickedClubIds.has(fx.home_club_id) || pickedClubIds.has(fx.away_club_id)) : fixtures,
    [fixtures, onlyPicked, pickedClubIds]
  );

  async function addFixture(e) {
    e.preventDefault();
    if (!homeClubId || !awayClubId || homeClubId === awayClubId || !kickoffAt) {
      showToast("Выбери лигу, дату и двух разных клубов", "error");
      return;
    }
    setCreateBusy(true);
    try {
      const { error } = await supabase.from("club_fixtures").insert({
        league,
        home_club_id: homeClubId,
        away_club_id: awayClubId,
        kickoff_at: kickoffAt,
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

  function startEdit(fx) {
    setEditingId(fx.id);
    setEditKickoff(fx.kickoff_at ? fx.kickoff_at.slice(0, 16) : "");
  }

  async function savePostpone(id) {
    if (!editKickoff) return;
    try {
      const { error } = await supabase.from("club_fixtures").update({ kickoff_at: editKickoff }).eq("id", id);
      if (error) throw error;
      showToast("✓ Дата матча обновлена — помечен как перенесённый");
      setEditingId(null);
      await loadFixtures();
    } catch (e) {
      showToast(friendlyError(e), "error");
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
          <div className="text-xs text-slate-500 mt-2">
            Матчи ниже показываются по этим датам, а не по жёсткой привязке к туру — календарь можно занести один раз на весь сезон,
            он сам "разложится" по турам, когда проставишь даты.
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
              required
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
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold">Матчи тура {startsOn && endsOn ? `(${startsOn} — ${endsOn})` : ""}</h2>
            <button
              type="button"
              onClick={() => setOnlyPicked(v => !v)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${onlyPicked ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300"}`}
            >
              {onlyPicked ? "Только выбранные игроками клубы" : "Показаны все матчи"}
            </button>
          </div>
          {!startsOn || !endsOn ? (
            <div className="text-slate-500 text-sm">Сначала задай даты тура выше.</div>
          ) : visibleFixtures.length === 0 ? (
            <div className="text-slate-500 text-sm">
              {fixtures.length === 0 ? "Матчей на эти даты пока не добавлено." : "Нет матчей с выбранными игроками клубами — попробуй выключить фильтр."}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {visibleFixtures.map(fx => (
                <div key={fx.id} className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 flex items-center justify-between gap-3 text-sm flex-wrap">
                  <span className="text-xs text-slate-500 w-20 flex-shrink-0">{fx.league}</span>
                  <div className="flex-1 min-w-0 truncate">
                    <span className="font-medium">{fx.home?.name}</span>
                    <span className="text-slate-500"> — </span>
                    <span className="font-medium">{fx.away?.name}</span>
                  </div>

                  {editingId === fx.id ? (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <input
                        type="datetime-local"
                        value={editKickoff}
                        onChange={e => setEditKickoff(e.target.value)}
                        className="bg-slate-900 border border-slate-700 rounded-lg text-xs px-2 py-1"
                      />
                      <button type="button" onClick={() => savePostpone(fx.id)} className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold">Сохранить</button>
                      <button type="button" onClick={() => setEditingId(null)} className="text-slate-500 hover:text-slate-300 text-xs">Отмена</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => startEdit(fx)} className="text-xs text-slate-400 hover:text-sky-400 flex-shrink-0 flex items-center gap-1.5">
                      {fx.status === "postponed" && (
                        <span title={`Было: ${fmtDateTime(fx.original_kickoff_at)}`} className="px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/30">перенесён</span>
                      )}
                      {fmtDateTime(fx.kickoff_at)}
                    </button>
                  )}

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
