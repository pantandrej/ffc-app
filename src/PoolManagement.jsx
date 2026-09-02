import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { friendlyError } from "./lib/friendlyError.js";

const POTS = [1, 2, 3, 4, 5];
const PER_POT = 2;
const POOL_SIZE = POTS.length * PER_POT;
const PLACEHOLDER_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='11' fill='%23334155'/%3E%3C/svg%3E";

function CrownIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M3 8l4 3 5-6 5 6 4-3-1.5 10h-15L3 8z" />
    </svg>
  );
}

const LEAGUES = [
  { value: "all", label: "Все" },
  { value: "EPL", label: "EPL" },
  { value: "LaLiga", label: "LaLiga" },
  { value: "SerieA", label: "SerieA" },
  { value: "Bundesliga", label: "Bundesliga" },
  { value: "Ligue1", label: "Ligue1" },
];

const POT_FILTERS = [
  { value: "all", label: "Все" },
  { value: 1, label: "Корзина 1" },
  { value: 2, label: "Корзина 2" },
  { value: 3, label: "Корзина 3" },
  { value: 4, label: "Корзина 4" },
  { value: 5, label: "Корзина 5" },
];

const POT_BADGE = {
  1: "bg-amber-400 text-amber-950",
  2: "bg-sky-400 text-sky-950",
  3: "bg-emerald-400 text-emerald-950",
  4: "bg-slate-400 text-slate-950",
  5: "bg-fuchsia-400 text-fuchsia-950",
};

const EURO_BADGE = {
  ucl: { label: "ЛЧ", title: "Лига чемпионов", bar: "bg-indigo-500", pill: "bg-indigo-500 text-white" },
  uel: { label: "ЛЕ", title: "Лига Европы", bar: "bg-orange-500", pill: "bg-orange-500 text-white" },
  uecl: { label: "ЛК", title: "Лига конференций", bar: "bg-teal-400", pill: "bg-teal-400 text-slate-900" },
};

function formatTourDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}

// Локальная (устройства игрока) дата в формате YYYY-MM-DD — starts_on
// хранится как чистая дата без времени, сравниваем календарными днями.
function todayLocalISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Единственный экран выбора клубов — пишет в user_lineups (личный сет на
// каждого игрока). Очки команды в Общей лиге = среднее по всем участникам
// (см. sql/fantasysta_module12_unified_lineup_scoring.sql); та же таблица
// станет основой для будущих дуэлей 1×1, когда включим Бриллиантовую лигу.
export default function PoolManagement({ user }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const [clubs, setClubs] = useState([]);
  const [gameweek, setGameweek] = useState(null);

  const [poolClubIds, setPoolClubIds] = useState([]);
  const [captainId, setCaptainId] = useState(null);
  const [savedClubIds, setSavedClubIds] = useState([]);
  const [savedCaptainId, setSavedCaptainId] = useState(null);

  const [leagueFilter, setLeagueFilter] = useState("all");
  const [potFilter, setPotFilter] = useState("all");
  const [sortBy, setSortBy] = useState("pot_asc");

  const [clubResults, setClubResults] = useState(new Map()); // club_id -> total_points

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [clubsRes, activeGwRes] = await Promise.all([
          supabase.from("clubs").select("*").order("pot").order("rank_in_pot"),
          supabase.from("gameweeks").select("*").eq("status", "active").order("id").limit(1).maybeSingle(),
        ]);
        if (clubsRes.error) throw clubsRes.error;
        if (activeGwRes.error) throw activeGwRes.error;
        if (cancelled) return;

        setClubs(clubsRes.data || []);

        let gw = activeGwRes.data || null;
        if (!gw) {
          const upcomingRes = await supabase.from("gameweeks").select("*").eq("status", "upcoming").order("id").limit(1).maybeSingle();
          if (upcomingRes.error) throw upcomingRes.error;
          gw = upcomingRes.data || null;
        }
        if (cancelled) return;
        setGameweek(gw);

        if (gw) {
          const lineupRes = await supabase
            .from("user_lineups")
            .select("club_id, is_club_captain")
            .eq("profile_id", user.id)
            .eq("gameweek_id", gw.id);
          if (cancelled) return;
          if (lineupRes.error) throw lineupRes.error;

          const rows = lineupRes.data || [];
          const ids = rows.map(r => r.club_id);
          const cap = rows.find(r => r.is_club_captain)?.club_id || null;
          setPoolClubIds(ids);
          setCaptainId(cap);
          setSavedClubIds(ids);
          setSavedCaptainId(cap);

          const resultsRes = await supabase.from("club_results").select("club_id, total_points").eq("gameweek_id", gw.id);
          if (cancelled) return;
          if (resultsRes.error) throw resultsRes.error;
          setClubResults(new Map((resultsRes.data || []).map(r => [r.club_id, r.total_points])));
        }
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [user.id]);

  const clubsById = useMemo(() => {
    const map = new Map();
    clubs.forEach(c => map.set(c.id, c));
    return map;
  }, [clubs]);

  const poolClubs = useMemo(
    () => poolClubIds.map(id => clubsById.get(id)).filter(Boolean),
    [poolClubIds, clubsById]
  );

  // Разбивка очков ЗАФИКСИРОВАННОГО (сохранённого) сета за этот тур — а не
  // текущего черновика, который игрок может ещё крутить до сохранения.
  const savedTourBreakdown = useMemo(
    () => savedClubIds.map(id => {
      const club = clubsById.get(id);
      const basePoints = clubResults.has(id) ? Number(clubResults.get(id)) : null;
      const isCaptain = id === savedCaptainId;
      return {
        club,
        basePoints,
        points: basePoints === null ? null : (isCaptain ? basePoints * 2 : basePoints),
        isCaptain,
      };
    }).filter(row => row.club),
    [savedClubIds, savedCaptainId, clubsById, clubResults]
  );
  const savedTourTotal = useMemo(
    () => savedTourBreakdown.some(r => r.points === null) ? null : savedTourBreakdown.reduce((s, r) => s + r.points, 0),
    [savedTourBreakdown]
  );

  // Сколько выбрано клубов по каждой корзине — сет валиден, только если
  // ровно PER_POT в каждой из POTS.
  const countByPot = useMemo(() => {
    const map = new Map();
    poolClubs.forEach(c => map.set(c.pot, (map.get(c.pot) || 0) + 1));
    return map;
  }, [poolClubs]);
  const potsComplete = POTS.every(p => (countByPot.get(p) || 0) === PER_POT);

  const tourStarted = !!gameweek?.starts_on && todayLocalISO() >= gameweek.starts_on;

  const captainValid = !!captainId && poolClubIds.includes(captainId);
  const canSave = !tourStarted && !!gameweek && poolClubIds.length === POOL_SIZE && potsComplete && captainValid;

  const isSaved =
    poolClubIds.length === savedClubIds.length &&
    poolClubIds.every(id => savedClubIds.includes(id)) &&
    captainId === savedCaptainId;

  const filteredClubs = useMemo(() => {
    let list = clubs;
    if (leagueFilter !== "all") list = list.filter(c => c.league === leagueFilter);
    if (potFilter !== "all") list = list.filter(c => c.pot === potFilter);
    list = [...list];
    if (sortBy === "pot_asc") list.sort((a, b) => a.pot - b.pot || a.rank_in_pot - b.rank_in_pot);
    else if (sortBy === "name_asc") list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return list;
  }, [clubs, leagueFilter, potFilter, sortBy]);

  function addClub(clubId) {
    if (tourStarted) return;
    if (poolClubIds.includes(clubId)) return;
    if (poolClubIds.length >= POOL_SIZE) return;
    const club = clubsById.get(clubId);
    if (!club) return;
    if ((countByPot.get(club.pot) || 0) >= PER_POT) return;
    setPoolClubIds(prev => [...prev, clubId]);
  }

  function removeClub(clubId) {
    if (tourStarted) return;
    setPoolClubIds(prev => prev.filter(id => id !== clubId));
    if (captainId === clubId) setCaptainId(null);
  }

  function toggleCaptain(clubId) {
    if (tourStarted) return;
    setCaptainId(prev => (prev === clubId ? null : clubId));
  }

  async function handleSave() {
    if (!canSave || !gameweek) return;
    setSaving(true);
    try {
      const { error: delError } = await supabase
        .from("user_lineups")
        .delete()
        .eq("profile_id", user.id)
        .eq("gameweek_id", gameweek.id);
      if (delError) throw delError;

      const rows = poolClubIds.map(clubId => ({
        profile_id: user.id,
        gameweek_id: gameweek.id,
        club_id: clubId,
        is_club_captain: clubId === captainId,
      }));
      const { error: insError } = await supabase.from("user_lineups").insert(rows);
      if (insError) throw insError;

      setSavedClubIds(poolClubIds);
      setSavedCaptainId(captainId);
      showToast("✓ Сет сохранён");
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Загружаю сет…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="text-center text-red-400 max-w-md">Ошибка загрузки: {loadError}</div>
      </div>
    );
  }

  if (!gameweek) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="text-center text-slate-400">Сейчас нет активного или предстоящего тура.</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-2 flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">⚽ Мой сет</h1>
          <span className="text-sm text-slate-400">
            Тур №{gameweek.id} · {gameweek.status === "active" ? "идёт" : "предстоящий"}
            {gameweek.starts_on && gameweek.ends_on && (
              <> · {formatTourDate(gameweek.starts_on)} — {formatTourDate(gameweek.ends_on)}</>
            )}
          </span>
        </div>
        <div className="text-sm text-slate-400 mb-4">
          Докажи, что ты лучший футбольный аналитик. Собери сет из 10 клубов — по 2 из каждой из 5 корзин — и возглавь рейтинг экспертов.
        </div>

        {tourStarted && (
          <div className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
            Тур уже начался — менять сет нельзя. Дождись следующего тура.
          </div>
        )}

        <div className="mb-6 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <span className="text-slate-500 font-semibold uppercase tracking-wide">Как начисляются баллы</span>
          <span className="text-slate-300">Победа <b className="text-emerald-400">+3</b></span>
          <span className="text-slate-300">Ничья <b className="text-emerald-400">+1</b></span>
          <span className="text-slate-300">Гол (за каждый) <b className="text-emerald-400">+1</b></span>
          <span className="text-slate-300">Сухой матч <b className="text-emerald-400">+2</b></span>
          <span className="text-slate-300">Джокер <b className="text-amber-400">очки ×2</b></span>
        </div>

        {savedTourBreakdown.length > 0 && (
          <div className="mb-6 rounded-xl border border-emerald-500/30 bg-slate-800/60 px-4 py-3">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
              <span className="text-slate-500 font-semibold uppercase tracking-wide text-xs">Очки твоего сета в этом туре</span>
              <span className="font-extrabold text-lg text-emerald-400">
                {savedTourTotal === null ? "тур не сыгран" : `${savedTourTotal} очков`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {savedTourBreakdown.map(row => (
                <span
                  key={row.club.id}
                  className={`px-2 py-1 rounded-lg text-xs ${row.isCaptain ? "bg-amber-400/10 text-amber-300 border border-amber-400/30 font-semibold" : "bg-slate-900 text-slate-300 border border-slate-700"}`}
                >
                  {row.isCaptain && "🃏 "}{row.club.name}: {row.points === null ? "—" : row.points}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-6">
          <aside className="md:w-[35%] flex flex-col gap-4">
            <div className={`rounded-2xl p-5 border ${potsComplete ? "bg-slate-800 border-emerald-500/30" : "bg-slate-800 border-slate-700"}`}>
              <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Собрано</div>
              <div className={`text-3xl font-extrabold ${potsComplete ? "text-emerald-400" : "text-slate-200"}`}>
                {poolClubIds.length}/{POOL_SIZE}
              </div>
              <div className="text-xs text-slate-500 mt-1">По 2 клуба из каждой из 5 корзин</div>
            </div>

            <div className="flex flex-col gap-4">
              {POTS.map(pot => {
                const potClubs = poolClubs.filter(c => c.pot === pot);
                const potDone = potClubs.length === PER_POT;
                return (
                  <div key={pot} className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-bold px-2 py-0.5 rounded-full ${POT_BADGE[pot]}`}>Корзина {pot}</span>
                      <span className={potDone ? "text-emerald-400" : "text-slate-500"}>{potClubs.length}/{PER_POT}</span>
                    </div>
                    {Array.from({ length: PER_POT }).map((_, i) => {
                      const club = potClubs[i];
                      if (!club) {
                        return (
                          <div key={`empty_${pot}_${i}`} className="h-16 rounded-xl border-2 border-dashed border-slate-600 flex items-center justify-center text-slate-500 gap-2 text-sm">
                            <span className="text-lg">＋</span>
                            <span>Слот пуст</span>
                          </div>
                        );
                      }
                      const isCaptain = captainId === club.id;
                      const crownVisibilityClass = isCaptain
                        ? "opacity-100"
                        : captainId
                          ? "opacity-0 group-hover:opacity-40 hover:!opacity-100"
                          : "opacity-30 hover:opacity-70";
                      const euro = EURO_BADGE[club.euro_competition];
                      return (
                        <div key={club.id} className="group relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-3 pl-4 flex items-center gap-3">
                          {euro && <div title={euro.title} className={`absolute left-0 top-0 bottom-0 w-1.5 ${euro.bar}`} />}
                          <img src={club.logo_url || PLACEHOLDER_LOGO} alt="" className="w-10 h-10 object-contain flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold truncate">{club.name}</div>
                            <div className="text-xs text-slate-400">{club.league}</div>
                          </div>
                          {!tourStarted && (
                            <>
                              <button
                                type="button"
                                onClick={() => toggleCaptain(club.id)}
                                title={isCaptain ? "Убрать джокера" : "Сделать джокером"}
                                className={`flex-shrink-0 transition ${isCaptain ? "text-amber-400" : "text-slate-400"} ${crownVisibilityClass}`}
                              >
                                <CrownIcon className="w-6 h-6" />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeClub(club.id)}
                                title="Убрать из сета"
                                className="text-slate-500 hover:text-red-400 flex-shrink-0"
                              >
                                ✕
                              </button>
                            </>
                          )}
                          {tourStarted && isCaptain && (
                            <CrownIcon className="w-6 h-6 text-amber-400 flex-shrink-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving || isSaved}
              className="w-full py-4 rounded-xl font-bold text-lg transition bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              {tourStarted ? "Тур начался — сет заблокирован" : saving ? "Сохраняю…" : isSaved ? "✓ Сет сохранён" : "Сохранить сет"}
            </button>
            {!tourStarted && !captainValid && poolClubIds.length === POOL_SIZE && (
              <div className="text-xs text-amber-400 text-center">Выбери Джокера среди выбранных клубов</div>
            )}
          </aside>

          <main className="md:w-[65%] flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {LEAGUES.map(l => (
                  <button
                    key={l.value}
                    type="button"
                    onClick={() => setLeagueFilter(l.value)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition ${
                      leagueFilter === l.value ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {POT_FILTERS.map(p => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPotFilter(p.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      potFilter === p.value ? "bg-sky-500 border-sky-500 text-slate-900" : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value)}
                  className="ml-auto bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-1.5 text-slate-200"
                >
                  <option value="pot_asc">По корзине</option>
                  <option value="name_asc">По алфавиту</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {filteredClubs.map(club => {
                const inPool = poolClubIds.includes(club.id);
                const potFull = (countByPot.get(club.pot) || 0) >= PER_POT;
                const disabled = tourStarted || inPool || (potFull && !inPool);
                let label = "Добавить";
                if (inPool) label = "В сете";
                else if (potFull) label = "Корзина заполнена";

                const euro = EURO_BADGE[club.euro_competition];
                return (
                  <div key={club.id} className="relative overflow-hidden rounded-xl border border-slate-700 bg-slate-800 p-4 pl-5 flex flex-col gap-2">
                    {euro && <div title={euro.title} className={`absolute left-0 top-0 bottom-0 w-1.5 ${euro.bar}`} />}
                    <div className="flex items-center gap-2">
                      <img src={club.logo_url || PLACEHOLDER_LOGO} alt="" className="w-8 h-8 object-contain" />
                      {euro && (
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${euro.pill}`}>{euro.label}</span>
                      )}
                      <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${POT_BADGE[club.pot] || "bg-slate-500 text-slate-950"}`}>
                        Корзина {club.pot}
                      </span>
                    </div>
                    <div className="font-semibold truncate">{club.name}</div>
                    <div className="text-xs text-slate-400">{club.league}</div>
                    <button
                      type="button"
                      onClick={() => addClub(club.id)}
                      disabled={disabled}
                      className="mt-1 py-1.5 rounded-lg text-sm font-semibold bg-emerald-500/90 hover:bg-emerald-400 text-slate-900 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed transition"
                    >
                      {label}
                    </button>
                  </div>
                );
              })}
              {filteredClubs.length === 0 && (
                <div className="col-span-full text-center text-slate-500 py-10">Клубов по этим фильтрам не найдено</div>
              )}
            </div>
          </main>
        </div>
      </div>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 max-w-sm rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${
            toast.kind === "error" ? "bg-red-600 text-white" : "bg-emerald-500 text-slate-900"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
