import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { friendlyError } from "./lib/friendlyError.js";

function formatDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}

function formatKickoff(d) {
  if (!d) return null;
  return new Date(d).toLocaleString("ru-RU", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// Календарь реальных матчей всех 5 чемпионатов на текущий тур — чтобы видеть,
// против кого играют клубы, прежде чем собирать сет.
export default function Calendar() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [gameweek, setGameweek] = useState(null);
  const [fixtures, setFixtures] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const activeRes = await supabase.from("gameweeks").select("*").eq("status", "active").order("id").limit(1).maybeSingle();
        if (activeRes.error) throw activeRes.error;
        let gw = activeRes.data;
        if (!gw) {
          const upcomingRes = await supabase.from("gameweeks").select("*").eq("status", "upcoming").order("id").limit(1).maybeSingle();
          if (upcomingRes.error) throw upcomingRes.error;
          gw = upcomingRes.data;
        }
        if (cancelled) return;
        setGameweek(gw || null);

        // Матчи выбираются по датам тура (включительно), а не по жёсткой
        // привязке к gameweek_id — так календарь, занесённый один раз на весь
        // сезон, сам "раскладывается" по турам.
        if (gw?.starts_on && gw?.ends_on) {
          const fxRes = await supabase
            .from("club_fixtures")
            .select("id,league,kickoff_at,status,original_kickoff_at,home:clubs!club_fixtures_home_club_id_fkey(name,logo_url),away:clubs!club_fixtures_away_club_id_fkey(name,logo_url)")
            .gte("kickoff_at", gw.starts_on)
            .lte("kickoff_at", `${gw.ends_on}T23:59:59`)
            .order("league")
            .order("kickoff_at");
          if (fxRes.error) throw fxRes.error;
          if (cancelled) return;
          setFixtures(fxRes.data || []);
        }
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const byLeague = useMemo(() => {
    const map = new Map();
    fixtures.forEach(fx => {
      const list = map.get(fx.league) || [];
      list.push(fx);
      map.set(fx.league, list);
    });
    return [...map.entries()];
  }, [fixtures]);

  if (loading) return <div className="text-slate-400 p-8">Загрузка…</div>;
  if (error) return <div className="text-red-400 p-8">{error}</div>;
  if (!gameweek) return <div className="text-slate-400 p-8 text-center">Сейчас нет активного или предстоящего тура.</div>;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-xl font-extrabold">📅 Календарь тура №{gameweek.id}</h1>
        {(gameweek.starts_on || gameweek.ends_on) && (
          <span className="text-sm text-slate-400">
            {formatDate(gameweek.starts_on)} — {formatDate(gameweek.ends_on)}
          </span>
        )}
      </div>

      {byLeague.length === 0 ? (
        <div className="text-slate-500 text-center py-16">Календарь матчей на этот тур пока не добавлен.</div>
      ) : (
        <div className="flex flex-col gap-8">
          {byLeague.map(([league, list]) => (
            <section key={league}>
              <h2 className="font-bold text-sm text-slate-400 uppercase tracking-wide mb-3">{league}</h2>
              <div className="flex flex-col gap-2">
                {list.map(fx => (
                  <div key={fx.id} className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 flex items-center gap-3">
                    <span className="flex-1 min-w-0 truncate font-medium text-right">{fx.home?.name}</span>
                    <span className="text-slate-500 text-xs flex-shrink-0 px-2 flex flex-col items-center gap-1">
                      {fx.status === "postponed" && (
                        <span title={`Было: ${formatKickoff(fx.original_kickoff_at) || ""}`} className="px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/30 text-[10px]">
                          перенесён
                        </span>
                      )}
                      {formatKickoff(fx.kickoff_at) || "—"}
                    </span>
                    <span className="flex-1 min-w-0 truncate font-medium">{fx.away?.name}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
