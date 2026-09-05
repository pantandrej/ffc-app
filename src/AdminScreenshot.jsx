import React, { useState, useEffect } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";
import { friendlyError } from "./lib/friendlyError.js";

function formatPoints(n) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
}

const PLACEHOLDER_LOGO = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='12' cy='12' r='11' fill='%23334155'/%3E%3C/svg%3E";

// Инфографика популярности клубов — горизонтальные полосы, длина
// пропорциональна максимуму, чтобы разница была видна с одного взгляда.
function PopularClubsChart({ rows, logoByClubId }) {
  const max = Math.max(1, ...rows.map(r => r.times_picked));
  return (
    <div className="flex-1 min-w-0">
      <div className="text-sm font-bold uppercase tracking-wide text-slate-400 mb-2">Самые популярные клубы тура</div>
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-3 flex flex-col gap-2">
        {rows.length === 0 ? (
          <div className="text-slate-500 text-sm px-1 py-2">Пока никто не выбрал клубы.</div>
        ) : (
          rows.map((r, i) => (
            <div key={r.club_id} className="flex items-center gap-2.5">
              <div className="w-4 text-slate-500 font-semibold flex-shrink-0 text-xs">{i + 1}</div>
              <img src={logoByClubId.get(r.club_id) || PLACEHOLDER_LOGO} alt="" className="w-6 h-6 object-contain flex-shrink-0" />
              <div className="w-32 flex-shrink-0 truncate text-sm font-medium">{r.club_name}</div>
              <div className="flex-1 h-4 rounded bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded bg-gradient-to-r from-emerald-500 to-emerald-400"
                  style={{ width: `${Math.max(6, (r.times_picked / max) * 100)}%` }}
                />
              </div>
              <div className="w-6 flex-shrink-0 text-right font-bold text-sm">{r.times_picked}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Компактная страница только для скриншота в пост — личная и командная
// таблицы рядом, с брендингом сверху, без лишних UI-элементов (вкладок,
// подписей "N тур сыграно" и т.п.), чтобы влезло побольше строк.
function CompactTable({ title, rows, nameKey, subtitle, badge }) {
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
                {badge && <div className="flex-shrink-0">{badge(r)}</div>}
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
  const [latestGameweek, setLatestGameweek] = useState(null);
  const [submittedProfiles, setSubmittedProfiles] = useState(new Set());
  const [popularClubs, setPopularClubs] = useState([]);
  const [logoByClubId, setLogoByClubId] = useState(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [pRes, tRes, mRes, gwRes] = await Promise.all([
          supabase.from("leaderboard_solo").select("*").order("total_points", { ascending: false }),
          supabase.from("leaderboard_teams").select("*").order("total_points", { ascending: false }),
          supabase.from("team_members").select("team_id, fantasysta_profiles(username)"),
          supabase.from("gameweeks").select("id").order("id", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (pRes.error) throw pRes.error;
        if (tRes.error) throw tRes.error;
        if (mRes.error) throw mRes.error;
        if (gwRes.error) throw gwRes.error;
        if (cancelled) return;
        setPersonal(pRes.data || []);
        setTeams(tRes.data || []);
        setLatestGameweek(gwRes.data?.id ?? null);

        const map = new Map();
        (mRes.data || []).forEach(m => {
          const list = map.get(m.team_id) || [];
          list.push(m.fantasysta_profiles?.username || m.team_id);
          map.set(m.team_id, list);
        });
        setMembersByTeam(map);

        if (gwRes.data?.id != null) {
          const [subRes, popRes, clubsRes] = await Promise.all([
            supabase.from("user_lineups").select("profile_id").eq("gameweek_id", gwRes.data.id),
            supabase.from("club_pick_popularity").select("*").eq("gameweek_id", gwRes.data.id).order("times_picked", { ascending: false }).limit(12),
            supabase.from("clubs").select("id, logo_url"),
          ]);
          if (cancelled) return;
          if (subRes.error) throw subRes.error;
          if (popRes.error) throw popRes.error;
          if (clubsRes.error) throw clubsRes.error;
          setSubmittedProfiles(new Set((subRes.data || []).map(r => r.profile_id)));
          setPopularClubs(popRes.data || []);
          setLogoByClubId(new Map((clubsRes.data || []).map(c => [c.id, c.logo_url])));
        }
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
          <>
            <div className="flex flex-col md:flex-row gap-6">
              <CompactTable
                title={`Личный зачёт${latestGameweek != null ? ` · прислал тур №${latestGameweek}` : ""}`}
                rows={personal}
                nameKey="username"
                badge={r => (
                  submittedProfiles.has(r.profile_id)
                    ? <span className="text-emerald-400 text-xs" title={`Прислал тур №${latestGameweek}`}>✓</span>
                    : <span className="text-slate-600 text-xs" title="Не прислал">—</span>
                )}
              />
              <CompactTable
                title="Командный зачёт"
                rows={teams}
                nameKey="team_name"
                subtitle={r => `В зачёте: ${(membersByTeam.get(r.team_id) || []).join(", ") || "—"}`}
              />
            </div>
            <PopularClubsChart rows={popularClubs} logoByClubId={logoByClubId} />
          </>
        )}
      </div>
    </div>
  );
}
