import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";

const BUDGET = 100000000;
const POOL_SIZE = 5;
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

const TIERS = [
  { value: "all", label: "Все" },
  { value: "Tier 1", label: "Tier 1 (35 млн)" },
  { value: "Tier 2", label: "Tier 2 (25 млн)" },
  { value: "Tier 3", label: "Tier 3 (15 млн)" },
  { value: "Tier 4", label: "Tier 4 (10 млн)" },
];

const TIER_BADGE = {
  "Tier 1": "bg-amber-400 text-amber-950",
  "Tier 2": "bg-sky-400 text-sky-950",
  "Tier 3": "bg-emerald-400 text-emerald-950",
  "Tier 4": "bg-slate-400 text-slate-950",
};

function formatMoney(value) {
  const n = Number(value) || 0;
  return `${new Intl.NumberFormat("ru-RU").format(n)} €`;
}

function friendlyError(e) {
  const msg = e?.message || String(e || "Неизвестная ошибка");
  // Триггеры БД уже кидают понятные русские сообщения (RAISE EXCEPTION) —
  // Supabase присылает их как есть в error.message, просто показываем.
  return msg;
}

export default function PoolManagement({ teamId }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { text, kind }

  const [clubs, setClubs] = useState([]);
  const [gameweek, setGameweek] = useState(null);

  const [poolClubIds, setPoolClubIds] = useState([]);
  const [captainId, setCaptainId] = useState(null);
  const [initialClubIds, setInitialClubIds] = useState([]); // состав, сохранённый в БД на начало сессии
  const [savedCaptainId, setSavedCaptainId] = useState(null); // капитан, сохранённый в БД
  const [alreadyTransferred, setAlreadyTransferred] = useState(false); // есть запись в transfers_log за этот тур

  const [leagueFilter, setLeagueFilter] = useState("all");
  const [tierFilter, setTierFilter] = useState("all");
  const [sortBy, setSortBy] = useState("price_desc"); // price_desc | price_asc | name_asc

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 3500);
  }, []);

  // ── Загрузка данных ──
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const [clubsRes, activeGwRes] = await Promise.all([
          supabase.from("clubs").select("*").order("league").order("tier"),
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

        if (gw && teamId) {
          const [poolRes, transferRes] = await Promise.all([
            supabase.from("team_pools").select("*").eq("team_id", teamId).eq("gameweek_id", gw.id).maybeSingle(),
            supabase.from("transfers_log").select("id").eq("team_id", teamId).eq("gameweek_id", gw.id).limit(1),
          ]);
          if (cancelled) return;
          if (poolRes.error && poolRes.error.code !== "PGRST116") throw poolRes.error;
          if (transferRes.error) throw transferRes.error;

          const pool = poolRes.data;
          if (pool) {
            setPoolClubIds(pool.club_ids || []);
            setCaptainId(pool.captain_club_id || null);
            setInitialClubIds(pool.club_ids || []);
            setSavedCaptainId(pool.captain_club_id || null);
          } else {
            setPoolClubIds([]);
            setCaptainId(null);
            setInitialClubIds([]);
            setSavedCaptainId(null);
          }
          setAlreadyTransferred((transferRes.data || []).length > 0);
        }
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [teamId]);

  const clubsById = useMemo(() => {
    const map = new Map();
    clubs.forEach(c => map.set(c.id, c));
    return map;
  }, [clubs]);

  const poolClubs = useMemo(
    () => poolClubIds.map(id => clubsById.get(id)).filter(Boolean),
    [poolClubIds, clubsById]
  );

  const bankBalance = useMemo(
    () => BUDGET - poolClubs.reduce((sum, c) => sum + Number(c.price || 0), 0),
    [poolClubs]
  );

  // ── Лимит замен ──
  const isFirstSave = initialClubIds.length === 0;
  const maxAllowedSwaps = isFirstSave ? Infinity : (alreadyTransferred ? 0 : 1);
  const removedFromInitial = useMemo(
    () => initialClubIds.filter(id => !poolClubIds.includes(id)),
    [initialClubIds, poolClubIds]
  );
  const addedSinceInitial = useMemo(
    () => poolClubIds.filter(id => !initialClubIds.includes(id)),
    [initialClubIds, poolClubIds]
  );
  const swapRemoveLocked = !isFirstSave && removedFromInitial.length >= maxAllowedSwaps;
  const swapAddLocked = !isFirstSave && addedSinceInitial.length >= maxAllowedSwaps;

  const captainValid = !!captainId && poolClubIds.includes(captainId);
  const swapCountValid = removedFromInitial.length <= maxAllowedSwaps && addedSinceInitial.length <= maxAllowedSwaps;
  const canSave = !!gameweek && poolClubIds.length === POOL_SIZE && captainValid && bankBalance >= 0 && swapCountValid;

  // Не даём нажать "Сохранить" повторно, если состав и капитан не менялись
  // с последнего сохранения — иначе кнопка выглядит так, будто ничего не произошло.
  const isPoolSaved =
    poolClubIds.length === POOL_SIZE &&
    removedFromInitial.length === 0 &&
    addedSinceInitial.length === 0 &&
    captainId === savedCaptainId;

  // ── Каталог: фильтры + сортировка ──
  const filteredClubs = useMemo(() => {
    let list = clubs;
    if (leagueFilter !== "all") list = list.filter(c => c.league === leagueFilter);
    if (tierFilter !== "all") list = list.filter(c => c.tier === tierFilter);
    list = [...list];
    if (sortBy === "price_desc") list.sort((a, b) => b.price - a.price);
    else if (sortBy === "price_asc") list.sort((a, b) => a.price - b.price);
    else if (sortBy === "name_asc") list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return list;
  }, [clubs, leagueFilter, tierFilter, sortBy]);

  // ── Действия с пулом ──
  function addClub(clubId) {
    if (poolClubIds.length >= POOL_SIZE) return;
    if (poolClubIds.includes(clubId)) return;
    const isNewAddition = !initialClubIds.includes(clubId);
    if (isNewAddition && swapAddLocked) {
      showToast("Разрешена только 1 замена между турами!", "error");
      return;
    }
    setPoolClubIds(prev => [...prev, clubId]);
  }

  function removeClub(clubId) {
    const wasInitial = initialClubIds.includes(clubId);
    if (wasInitial && swapRemoveLocked) {
      showToast("Разрешена только 1 замена между турами!", "error");
      return;
    }
    setPoolClubIds(prev => prev.filter(id => id !== clubId));
    if (captainId === clubId) setCaptainId(null);
  }

  function toggleCaptain(clubId) {
    setCaptainId(prev => (prev === clubId ? null : clubId));
  }

  async function handleSave() {
    if (!canSave || !gameweek || !teamId) return;
    setSaving(true);
    try {
      const { error: upsertError } = await supabase
        .from("team_pools")
        .upsert(
          {
            team_id: teamId,
            gameweek_id: gameweek.id,
            club_ids: poolClubIds,
            captain_club_id: captainId,
          },
          { onConflict: "team_id,gameweek_id" }
        );
      if (upsertError) throw upsertError;

      // Если это не первая сборка пула в этом туре и состав реально поменялся —
      // фиксируем факт замены в transfers_log (ровно 1 клуб на 1 клуб).
      if (!isFirstSave && removedFromInitial.length === 1 && addedSinceInitial.length === 1) {
        const { error: transferError } = await supabase.from("transfers_log").insert({
          team_id: teamId,
          gameweek_id: gameweek.id,
          club_out_id: removedFromInitial[0],
          club_in_id: addedSinceInitial[0],
        });
        if (transferError) throw transferError;
        setAlreadyTransferred(true);
      }

      setInitialClubIds(poolClubIds);
      setSavedCaptainId(captainId);
      showToast("✓ Пул сохранён");
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // ── Рендер ──
  if (!teamId) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="text-center text-slate-400">Команда не выбрана — некуда сохранять пул.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Загружаю пул…</div>
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
        <div className="mb-6 flex items-center justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">⚽ Управление пулом</h1>
          <span className="text-sm text-slate-400">Тур №{gameweek.id} · {gameweek.status === "active" ? "идёт" : "предстоящий"}</span>
        </div>

        {!isFirstSave && (
          <div className={`mb-6 rounded-xl px-4 py-3 text-sm ${alreadyTransferred ? "bg-red-950/40 text-red-300 border border-red-500/30" : "bg-sky-950/40 text-sky-300 border border-sky-500/30"}`}>
            {alreadyTransferred
              ? "Бесплатная замена на этот тур уже использована — состав больше менять нельзя."
              : "Пул уже сохранён на этот тур — доступна ровно 1 бесплатная замена."}
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-6">
          {/* ── Левая колонка: Мой Пул ── */}
          <aside className="md:w-[35%] flex flex-col gap-4">
            <div className={`rounded-2xl p-5 border ${bankBalance < 0 ? "bg-red-950/40 border-red-500" : "bg-slate-800 border-emerald-500/30"}`}>
              <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Баланс</div>
              <div className={`text-3xl font-extrabold ${bankBalance < 0 ? "text-red-400" : "text-emerald-400"}`}>
                {formatMoney(bankBalance)}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {Array.from({ length: POOL_SIZE }).map((_, i) => {
                const club = poolClubs[i];
                if (!club) {
                  return (
                    <div key={`empty_${i}`} className="h-20 rounded-xl border-2 border-dashed border-slate-600 flex items-center justify-center text-slate-500 gap-2">
                      <span className="text-lg">＋</span>
                      <span>Слот пуст</span>
                    </div>
                  );
                }
                const isCaptain = captainId === club.id;
                const wasInitial = initialClubIds.includes(club.id);
                const removeDisabled = wasInitial && swapRemoveLocked;
                const crownVisibilityClass = isCaptain
                  ? "opacity-100"
                  : captainId
                    ? "opacity-0 group-hover:opacity-40 hover:!opacity-100"
                    : "opacity-30 hover:opacity-70";
                return (
                  <div key={club.id} className="group rounded-xl border border-slate-700 bg-slate-800 p-3 flex items-center gap-3">
                    <img src={club.logo_url || PLACEHOLDER_LOGO} alt="" className="w-10 h-10 object-contain flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{club.name}</div>
                      <div className="text-xs text-slate-400">{club.league} · {formatMoney(club.price)}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleCaptain(club.id)}
                      title={isCaptain ? "Убрать с капитанства" : "Назначить капитаном"}
                      className={`flex-shrink-0 transition ${isCaptain ? "text-amber-400" : "text-slate-400"} ${crownVisibilityClass}`}
                    >
                      <CrownIcon className="w-6 h-6" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeClub(club.id)}
                      disabled={removeDisabled}
                      title={removeDisabled ? "Лимит замен исчерпан" : "Убрать из пула"}
                      className="text-slate-500 hover:text-red-400 disabled:opacity-25 disabled:hover:text-slate-500 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving || isPoolSaved}
              className="w-full py-4 rounded-xl font-bold text-lg transition bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed"
            >
              {saving ? "Сохраняю…" : isPoolSaved ? "✓ Пул сохранён" : "Сохранить Пул"}
            </button>
            {!captainValid && poolClubIds.length === POOL_SIZE && (
              <div className="text-xs text-amber-400 text-center">Назначь капитана среди выбранных клубов</div>
            )}
          </aside>

          {/* ── Правая колонка: Каталог клубов ── */}
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
                {TIERS.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTierFilter(t.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      tierFilter === t.value ? "bg-sky-500 border-sky-500 text-slate-900" : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value)}
                  className="ml-auto bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-1.5 text-slate-200"
                >
                  <option value="price_desc">Сначала дороже</option>
                  <option value="price_asc">Сначала дешевле</option>
                  <option value="name_asc">По алфавиту</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {filteredClubs.map(club => {
                const inPool = poolClubIds.includes(club.id);
                const poolFull = poolClubIds.length >= POOL_SIZE;
                const isNewAddition = !initialClubIds.includes(club.id);
                const addLocked = !inPool && isNewAddition && swapAddLocked;
                const disabled = inPool || (poolFull && !inPool) || addLocked;
                let label = "Добавить";
                if (inPool) label = "В пуле";
                else if (poolFull) label = "Пул заполнен";
                else if (addLocked) label = "Лимит замен";

                return (
                  <div key={club.id} className="rounded-xl border border-slate-700 bg-slate-800 p-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <img src={club.logo_url || PLACEHOLDER_LOGO} alt="" className="w-8 h-8 object-contain" />
                      <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full ${TIER_BADGE[club.tier] || "bg-slate-500 text-slate-950"}`}>
                        {club.tier}
                      </span>
                    </div>
                    <div className="font-semibold truncate">{club.name}</div>
                    <div className="text-xs text-slate-400">{club.league}</div>
                    <div className="text-emerald-400 font-bold">{formatMoney(club.price)}</div>
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
