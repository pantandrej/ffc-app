import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { friendlyError } from "./lib/friendlyError.js";

// Календарь на ближайший месяц показываем с сегодня до этой даты — весь
// сезон расписан заранее на 2026/2027 год, но заводить реальные матчи в
// club_fixtures есть смысл только на обозримый горизонт.
const CALENDAR_HORIZON = "2026-10-31T23:59:59";

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}

function formatKickoff(d) {
  if (!d) return null;
  return new Date(d).toLocaleString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function groupByDay(fixtures) {
  const map = new Map();
  fixtures.forEach(fx => {
    const day = new Date(fx.kickoff_at).toDateString();
    const list = map.get(day) || [];
    list.push(fx);
    map.set(day, list);
  });
  return [...map.entries()];
}

// Пока матч не сыгран — показываем время; как только в club_fixtures занесён
// счёт (модуль 34), вместо времени показываем результат.
function FixtureRow({ fx }) {
  const played = fx.home_score !== null && fx.home_score !== undefined;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 flex items-center gap-3">
      <span className="text-[10px] text-slate-500 uppercase w-16 flex-shrink-0">{fx.league}</span>
      <span className="flex-1 min-w-0 truncate font-medium text-right">{fx.home?.name || fx.home_opponent_name}</span>
      <span className="text-slate-500 text-xs flex-shrink-0 px-2 flex flex-col items-center gap-1">
        {fx.status === "postponed" && (
          <span title={`Было: ${formatKickoff(fx.original_kickoff_at) || ""}`} className="px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/30 text-[10px]">
            перенесён
          </span>
        )}
        {played ? (
          <span className="text-sm font-extrabold text-emerald-400">{fx.home_score} : {fx.away_score}</span>
        ) : (
          formatKickoff(fx.kickoff_at) || "—"
        )}
      </span>
      <span className="flex-1 min-w-0 truncate font-medium">{fx.away?.name || fx.away_opponent_name}</span>
    </div>
  );
}

const FIXTURE_SELECT = "id,league,kickoff_at,status,original_kickoff_at,home_opponent_name,away_opponent_name,home_score,away_score,home:clubs!club_fixtures_home_club_id_fkey(name,logo_url),away:clubs!club_fixtures_away_club_id_fkey(name,logo_url)";

// Результаты сгруппированы по туру (не зависят от того, есть ли сейчас
// "открытый" тур) плюс отдельно — календарь на ближайший месяц по датам,
// независимо от границ туров (следующий тур ещё может быть не заведён).
function TourResults({ gw, fixtures, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const byDay = useMemo(() => groupByDay(fixtures), [fixtures]);
  const playedCount = fixtures.filter(fx => fx.home_score !== null && fx.home_score !== undefined).length;

  return (
    <div className="mb-4 rounded-xl border border-slate-700 bg-slate-800/60 px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between flex-wrap gap-2"
      >
        <span className="text-slate-200 font-bold flex items-center gap-1.5">
          <span className={`text-slate-500 transition-transform inline-block ${open ? "rotate-90" : ""}`}>▸</span>
          Тур №{gw.id}
          {(gw.starts_on || gw.ends_on) && (
            <span className="text-xs text-slate-500 font-normal">{formatDate(gw.starts_on)} — {formatDate(gw.ends_on)}</span>
          )}
        </span>
        <span className="text-xs text-slate-500">
          {fixtures.length === 0 ? "матчей пока нет" : `${playedCount} / ${fixtures.length} сыграно`}
        </span>
      </button>
      {open && (
        fixtures.length === 0 ? (
          <div className="text-slate-500 text-sm py-6 text-center">Календарь матчей на этот тур пока не добавлен.</div>
        ) : (
          <div className="flex flex-col gap-5 mt-3">
            {byDay.map(([day, list]) => (
              <section key={day}>
                <h3 className="font-bold text-xs text-slate-400 uppercase tracking-wide mb-2">
                  {new Date(list[0].kickoff_at).toLocaleDateString("ru-RU", { weekday: "long", day: "2-digit", month: "long" })}
                </h3>
                <div className="flex flex-col gap-2">
                  {list.map(fx => <FixtureRow key={fx.id} fx={fx} />)}
                </div>
              </section>
            ))}
          </div>
        )
      )}
    </div>
  );
}

export default function Calendar() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState("results"); // "results" | "month"
  const [gameweeks, setGameweeks] = useState([]);
  const [fixturesByGw, setFixturesByGw] = useState(new Map());
  const [monthFixtures, setMonthFixtures] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const gwRes = await supabase.from("gameweeks").select("*").order("id", { ascending: true });
        if (gwRes.error) throw gwRes.error;
        if (cancelled) return;
        const gws = gwRes.data || [];
        setGameweeks(gws);

        // Результаты по турам — независимо друг от друга, по датам каждого
        // тура (включительно), чтобы прошлые туры не зависели от того, кто
        // сейчас "открытый".
        if (gws.length > 0) {
          const results = await Promise.all(gws.map(gw => {
            if (!gw.starts_on || !gw.ends_on) return Promise.resolve({ id: gw.id, data: [] });
            return supabase
              .from("club_fixtures")
              .select(FIXTURE_SELECT)
              .gte("kickoff_at", gw.starts_on)
              .lte("kickoff_at", `${gw.ends_on}T23:59:59`)
              .order("kickoff_at")
              .order("league")
              .then(r => ({ id: gw.id, data: r.error ? [] : (r.data || []) }));
          }));
          if (cancelled) return;
          setFixturesByGw(new Map(results.map(r => [r.id, r.data])));
        }

        // Календарь на ближайший месяц — с сегодня и до фиксированного
        // горизонта, не завязан на границы туров (следующий тур мог быть
        // ещё не заведён админом).
        const monthRes = await supabase
          .from("club_fixtures")
          .select(FIXTURE_SELECT)
          .gte("kickoff_at", new Date().toISOString())
          .lte("kickoff_at", CALENDAR_HORIZON)
          .order("kickoff_at")
          .order("league");
        if (monthRes.error) throw monthRes.error;
        if (cancelled) return;
        setMonthFixtures(monthRes.data || []);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const monthByDay = useMemo(() => groupByDay(monthFixtures), [monthFixtures]);
  const latestGwId = gameweeks.length > 0 ? gameweeks[gameweeks.length - 1].id : null;

  if (loading) return <div className="text-slate-400 p-8">Загрузка…</div>;
  if (error) return <div className="text-red-400 p-8">{error}</div>;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8">
      <div className="mb-2 flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-extrabold">📅 Календарь и результаты</h1>
      </div>
      <div className="text-sm text-slate-400 mb-6">
        Результаты прошедших матчей по турам и расписание игр всех 5 чемпионатов и еврокубков на ближайший месяц.
      </div>

      <div className="mb-6 flex gap-1.5">
        <button
          type="button"
          onClick={() => setView("results")}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${view === "results" ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >
          Результаты по турам
        </button>
        <button
          type="button"
          onClick={() => setView("month")}
          className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${view === "month" ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >
          Календарь на месяц
        </button>
      </div>

      {view === "results" && (
        gameweeks.length === 0 ? (
          <div className="text-slate-500 text-center py-16">Туры ещё не заведены.</div>
        ) : (
          <div>
            {gameweeks.map(gw => (
              <TourResults key={gw.id} gw={gw} fixtures={fixturesByGw.get(gw.id) || []} defaultOpen={gw.id === latestGwId} />
            ))}
          </div>
        )
      )}

      {view === "month" && (
        monthByDay.length === 0 ? (
          <div className="text-slate-500 text-center py-16">На ближайший месяц матчи пока не занесены.</div>
        ) : (
          <div className="flex flex-col gap-6">
            {monthByDay.map(([day, list]) => (
              <section key={day}>
                <h2 className="font-bold text-sm text-slate-400 uppercase tracking-wide mb-3">
                  {new Date(list[0].kickoff_at).toLocaleDateString("ru-RU", { weekday: "long", day: "2-digit", month: "long" })}
                </h2>
                <div className="flex flex-col gap-2">
                  {list.map(fx => <FixtureRow key={fx.id} fx={fx} />)}
                </div>
              </section>
            ))}
          </div>
        )
      )}
    </div>
  );
}
