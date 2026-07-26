import React, { useState, useEffect } from "react";
import { supabase } from "./lib/supabaseClient.js";

function formatPoints(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

// Личная таблица "Общей лиги" — очки командные, но зачёт по людям: у всех
// участников одной команды одна и та же сумма (см. sql/fantasysta_module4).
export default function Leaderboard({ user }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from("leaderboard_personal")
        .select("*")
        .order("total_points", { ascending: false });
      if (cancelled) return;
      if (err) setError(err.message);
      else setRows(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="text-slate-400 p-8">Загрузка…</div>;
  if (error) return <div className="text-red-400 p-8">{error}</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8">
      <h1 className="text-xl font-extrabold mb-4">Общая лига</h1>
      {rows.length === 0 ? (
        <div className="text-slate-400 text-center py-16">Пока никто не набрал очков.</div>
      ) : (
        <div className="rounded-xl border border-slate-700 overflow-hidden">
          {rows.map((r, i) => {
            const isMe = r.profile_id === user.id;
            return (
              <div
                key={r.profile_id}
                className={`flex items-center gap-3 px-4 py-3 ${i > 0 ? "border-t border-slate-800" : ""} ${isMe ? "bg-emerald-500/10" : "bg-slate-800"}`}
              >
                <div className="w-7 text-slate-400 font-semibold flex-shrink-0">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className={`font-semibold truncate ${isMe ? "text-emerald-400" : ""}`}>{r.username}</div>
                  <div className="text-xs text-slate-500 truncate">{r.team_name}</div>
                </div>
                <div className="font-bold text-lg flex-shrink-0">{formatPoints(r.total_points)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
