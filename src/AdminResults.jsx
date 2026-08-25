import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import AuthGate from "./lib/AuthGate.jsx";
import { friendlyError } from "./lib/friendlyError.js";

export const ADMIN_EMAILS = ["mysliklub@gmail.com", "vk3950760@fantasysta.app"];
export const ADMIN_EMAIL = ADMIN_EMAILS[0]; // старое имя оставлено — используется в паре мест как единичное значение

const LEAGUES = ["Все", "EPL", "LaLiga", "SerieA", "Bundesliga", "Ligue1"];
const EMPTY_ROW = { is_win: false, is_draw: false, goals_scored: 0, clean_sheet: false };

function computePoints(row) {
  if (!row) return 0;
  return (row.is_win ? 3 : 0) + (row.is_draw ? 1 : 0) + (Number(row.goals_scored) || 0) + (row.clean_sheet ? 2 : 0);
}

export function AdminResultsInner({ user, signOut }) {
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const [gameweeks, setGameweeks] = useState([]);
  const [gameweekId, setGameweekId] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [rows, setRows] = useState({}); // clubId -> { is_win, is_draw, goals_scored, clean_sheet }
  const [savingIds, setSavingIds] = useState(() => new Set());
  const [pickCounts, setPickCounts] = useState(new Map()); // clubId -> times_picked
  const [onlyPicked, setOnlyPicked] = useState(true);

  const [leagueFilter, setLeagueFilter] = useState("Все");
  const [search, setSearch] = useState("");

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Загрузка справочников (один раз) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [gwRes, clubsRes] = await Promise.all([
          supabase.from("gameweeks").select("*").order("id"),
          supabase.from("clubs").select("*").order("league").order("name"),
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

  // ── Загрузка результатов для выбранного тура ──
  useEffect(() => {
    if (!gameweekId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase.from("club_results").select("*").eq("gameweek_id", gameweekId);
        if (error) throw error;
        if (cancelled) return;
        const map = {};
        (data || []).forEach(r => {
          map[r.club_id] = { is_win: r.is_win, is_draw: r.is_draw, goals_scored: r.goals_scored, clean_sheet: r.clean_sheet };
        });
        setRows(map);
      } catch (e) {
        if (!cancelled) showToast(friendlyError(e), "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [gameweekId, showToast]);

  // ── Сколько раз каждый клуб выбрали игроки в этом туре ──
  useEffect(() => {
    if (!gameweekId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.from("club_pick_popularity").select("club_id, times_picked").eq("gameweek_id", gameweekId);
        if (error) throw error;
        if (cancelled) return;
        setPickCounts(new Map((data || []).map(r => [r.club_id, r.times_picked])));
      } catch (e) {
        if (!cancelled) showToast(friendlyError(e), "error");
      }
    })();
    return () => { cancelled = true; };
  }, [gameweekId, showToast]);

  async function saveRow(clubId, row) {
    setSavingIds(prev => new Set(prev).add(clubId));
    try {
      const { error } = await supabase.from("club_results").upsert(
        {
          gameweek_id: gameweekId,
          club_id: clubId,
          is_win: row.is_win,
          is_draw: row.is_draw,
          goals_scored: row.goals_scored,
          clean_sheet: row.clean_sheet,
        },
        { onConflict: "gameweek_id,club_id" }
      );
      if (error) throw error;
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setSavingIds(prev => {
        const next = new Set(prev);
        next.delete(clubId);
        return next;
      });
    }
  }

  function updateAndSave(clubId, patch) {
    const current = rows[clubId] || EMPTY_ROW;
    const next = { ...current, ...patch };
    setRows(prev => ({ ...prev, [clubId]: next }));
    saveRow(clubId, next);
  }

  const filteredClubs = useMemo(() => {
    let list = clubs;
    if (onlyPicked) list = list.filter(c => pickCounts.has(c.id));
    if (leagueFilter !== "Все") list = list.filter(c => c.league === leagueFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => (pickCounts.get(b.id) || 0) - (pickCounts.get(a.id) || 0));
  }, [clubs, leagueFilter, search, onlyPicked, pickCounts]);

  if (!ADMIN_EMAILS.includes(user.email)) {
    return (
      <div className="flex items-center justify-center p-10">
        <div className="text-center text-slate-400 max-w-sm">
          Эта страница только для админа. Вошли как {user.email}.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            value={gameweekId ?? ""}
            onChange={e => setGameweekId(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2"
          >
            {gameweeks.map(gw => (
              <option key={gw.id} value={gw.id}>
                Тур №{gw.id} · {gw.status}
              </option>
            ))}
          </select>

          <div className="flex flex-wrap gap-1.5">
            {LEAGUES.map(l => (
              <button
                key={l}
                type="button"
                onClick={() => setLeagueFilter(l)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                  leagueFilter === l ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300 hover:border-slate-500"
                }`}
              >
                {l}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setOnlyPicked(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
              onlyPicked ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300 hover:border-slate-500"
            }`}
          >
            {onlyPicked ? "Только выбранные игроками" : "Показаны все клубы"}
          </button>

          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск клуба…"
            className="ml-auto bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2 focus:outline-none focus:border-emerald-500"
          />
        </div>

        {loading ? (
          <div className="text-slate-400">Загрузка…</div>
        ) : (
          <div className="rounded-2xl border border-slate-700 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                  <th className="text-left px-4 py-2">Клуб</th>
                  <th className="px-3 py-2">Выбран</th>
                  <th className="px-3 py-2">Победа</th>
                  <th className="px-3 py-2">Ничья</th>
                  <th className="px-3 py-2">Голы</th>
                  <th className="px-3 py-2">Сухой матч</th>
                  <th className="px-3 py-2">Очки</th>
                </tr>
              </thead>
              <tbody>
                {filteredClubs.map((club, i) => {
                  const row = rows[club.id] || EMPTY_ROW;
                  const points = computePoints(row);
                  const isSaving = savingIds.has(club.id);
                  return (
                    <tr key={club.id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                      <td className="px-4 py-2">
                        <div className="font-medium">{club.name}</div>
                        <div className="text-xs text-slate-500">{club.league} · {club.tier}</div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-sky-400/10 text-sky-300 border border-sky-400/30">
                          {pickCounts.get(club.id) || 0}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => updateAndSave(club.id, { is_win: !row.is_win, is_draw: row.is_draw && row.is_win ? row.is_draw : false })}
                          className={`w-9 h-9 rounded-lg font-bold transition ${row.is_win ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-slate-500 hover:bg-slate-700"}`}
                        >
                          П
                        </button>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => updateAndSave(club.id, { is_draw: !row.is_draw, is_win: false })}
                          className={`w-9 h-9 rounded-lg font-bold transition ${row.is_draw ? "bg-amber-400 text-amber-950" : "bg-slate-800 text-slate-500 hover:bg-slate-700"}`}
                        >
                          Н
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => updateAndSave(club.id, { goals_scored: Math.max(0, (Number(row.goals_scored) || 0) - 1) })}
                            className="w-7 h-7 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300"
                          >
                            −
                          </button>
                          <span className="w-6 text-center font-semibold">{row.goals_scored || 0}</span>
                          <button
                            type="button"
                            onClick={() => updateAndSave(club.id, { goals_scored: (Number(row.goals_scored) || 0) + 1 })}
                            className="w-7 h-7 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300"
                          >
                            +
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => updateAndSave(club.id, { clean_sheet: !row.clean_sheet })}
                          className={`w-9 h-9 rounded-lg font-bold transition ${row.clean_sheet ? "bg-sky-400 text-sky-950" : "bg-slate-800 text-slate-500 hover:bg-slate-700"}`}
                        >
                          🧤
                        </button>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="font-bold text-emerald-400">{points}</span>
                        {isSaving && <span className="ml-1.5 text-[10px] text-slate-500">сохраняю…</span>}
                      </td>
                    </tr>
                  );
                })}
                {filteredClubs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-slate-500 py-8">
                      {onlyPicked ? "Ни один клуб ещё не выбран игроками на этот тур." : "Клубов не найдено"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 max-w-sm rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${toast.kind === "error" ? "bg-red-600 text-white" : "bg-emerald-500 text-slate-900"}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

export default function AdminResults() {
  return <AuthGate>{({ user, signOut }) => <AdminResultsInner user={user} signOut={signOut} />}</AuthGate>;
}
