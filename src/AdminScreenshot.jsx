import React, { useState, useEffect } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";
import { friendlyError } from "./lib/friendlyError.js";

function formatPoints(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

// Компактная страница только для скриншота в пост — личная и командная
// таблицы рядом, с брендингом сверху, без лишних UI-элементов (вкладок,
// подписей "N тур сыграно" и т.п.), чтобы влезло побольше строк.
function CompactTable({ title, rows, nameKey, subtitle }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">{title}</div>
      <div className="rounded-xl border border-slate-700 overflow-hidden">
        {rows.length === 0 ? (
          <div className="text-slate-500 text-sm px-4 py-3">Пока пусто.</div>
        ) : (
          rows.map((r, i) => (
            <div
              key={r[nameKey] + i}
              className={`px-3 py-1.5 text-sm ${i > 0 ? "border-t border-slate-800" : ""} ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-5 text-slate-500 font-semibold flex-shrink-0 text-xs">{i + 1}</div>
                <div className="flex-1 min-w-0 truncate font-medium">{r[nameKey]}</div>
                <div className="font-bold flex-shrink-0">{formatPoints(r.total_points)}</div>
              </div>
              {subtitle && (
                <div className="pl-8 text-[11px] text-slate-500 truncate">{subtitle(r)}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function AdminScreenshotInner({ user }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [personal, setPersonal] = useState([]);
  const [teams, setTeams] = useState([]);
  const [membersByTeam, setMembersByTeam] = useState(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [pRes, tRes, mRes] = await Promise.all([
          supabase.from("leaderboard_solo").select("*").order("total_points", { ascending: false }),
          supabase.from("leaderboard_teams").select("*").order("total_points", { ascending: false }),
          supabase.from("team_members").select("team_id, fantasysta_profiles(username)"),
        ]);
        if (pRes.error) throw pRes.error;
        if (tRes.error) throw tRes.error;
        if (mRes.error) throw mRes.error;
        if (cancelled) return;
        setPersonal(pRes.data || []);
        setTeams(tRes.data || []);

        const map = new Map();
        (mRes.data || []).forEach(m => {
          const list = map.get(m.team_id) || [];
          list.push(m.fantasysta_profiles?.username || m.team_id);
          map.set(m.team_id, list);
        });
        setMembersByTeam(map);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!ADMIN_EMAILS.includes(user.email)) {
    return <div className="p-10 text-center text-slate-400">Эта страница только для админа.</div>;
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-4xl mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-2 text-2xl font-extrabold tracking-tight">
          <img src="/logo.png" alt="" className="w-9 h-9 rounded-md" />
          <span><span className="text-emerald-400">FANTASY</span>STA</span>
        </div>

        {loading ? (
          <div className="text-slate-400 py-8 text-center">Загрузка…</div>
        ) : error ? (
          <div className="text-red-400 py-8 text-center">{error}</div>
        ) : (
          <div className="flex flex-col md:flex-row gap-6">
            <CompactTable title="Личный зачёт" rows={personal} nameKey="username" />
            <CompactTable
              title="Командный зачёт"
              rows={teams}
              nameKey="team_name"
              subtitle={r => `В зачёте: ${(membersByTeam.get(r.team_id) || []).join(", ") || "—"}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}
