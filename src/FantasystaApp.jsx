import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import AuthGate from "./lib/AuthGate.jsx";
import PoolManagement from "./PoolManagement.jsx";
import { TeamRegistrationInner } from "./TeamRegistration.jsx";
import { AdminResultsInner, ADMIN_EMAIL } from "./AdminResults.jsx";

function FantasystaShell({ user, profile, signOut }) {
  const [tab, setTab] = useState("pool"); // "pool" | "team" | "admin"
  const [teamId, setTeamId] = useState(null);
  const [loadingTeam, setLoadingTeam] = useState(true);

  const isAdmin = user.email === ADMIN_EMAIL;

  const loadTeam = useCallback(async () => {
    setLoadingTeam(true);
    const { data } = await supabase
      .from("team_members")
      .select("team_id")
      .eq("profile_id", user.id)
      .maybeSingle();
    setTeamId(data?.team_id || null);
    setLoadingTeam(false);
  }, [user.id]);

  useEffect(() => { loadTeam(); }, [loadTeam]);

  const tabs = [
    { id: "pool", label: "⚽ Мой пул" },
    { id: "team", label: "👥 Команда" },
    ...(isAdmin ? [{ id: "admin", label: "🧮 Админка" }] : []),
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="border-b border-slate-800 px-4 md:px-8 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <img src="/logo.png" alt="" className="w-7 h-7 rounded-md" />
          FANTASYSTA
        </div>
        <nav className="flex gap-1.5">
          {tabs.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${
                tab === t.id ? "bg-emerald-500 text-slate-900" : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="hidden sm:inline">{profile?.username || user.email}</span>
          <button type="button" onClick={signOut} className="hover:text-red-400 transition">Выйти</button>
        </div>
      </header>

      <main>
        {tab === "pool" && (
          loadingTeam ? (
            <div className="text-slate-400 p-8">Загрузка…</div>
          ) : teamId ? (
            <PoolManagement teamId={teamId} />
          ) : (
            <div className="flex flex-col items-center justify-center gap-4 p-16 text-center">
              <div className="text-slate-400 max-w-sm">Сначала нужна команда — создай свою или вступи в открытую.</div>
              <button
                type="button"
                onClick={() => setTab("team")}
                className="px-5 py-2 rounded-lg font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 transition"
              >
                Перейти к команде
              </button>
            </div>
          )
        )}
        {tab === "team" && <TeamRegistrationInner user={user} onTeamChange={loadTeam} />}
        {tab === "admin" && isAdmin && <AdminResultsInner user={user} signOut={signOut} />}
      </main>
    </div>
  );
}

export default function FantasystaApp() {
  return <AuthGate>{({ user, profile, signOut }) => <FantasystaShell user={user} profile={profile} signOut={signOut} />}</AuthGate>;
}
