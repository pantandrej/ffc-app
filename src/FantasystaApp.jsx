import React, { useState } from "react";
import AuthGate from "./lib/AuthGate.jsx";
import PoolManagement from "./PoolManagement.jsx";
import Calendar from "./Calendar.jsx";
import Leaderboard from "./Leaderboard.jsx";
import { TeamRegistrationInner } from "./TeamRegistration.jsx";
import { AdminResultsInner, ADMIN_EMAILS } from "./AdminResults.jsx";
import { AdminDiamondInner } from "./AdminDiamond.jsx";
import { AdminCalendarInner } from "./AdminCalendar.jsx";

function FantasystaShell({ user, profile, signOut }) {
  const [tab, setTab] = useState("pool"); // "pool" | "team" | "table" | "calendar" | "admin" | "admin-diamond" | "admin-calendar"

  const isAdmin = ADMIN_EMAILS.includes(user.email);

  const tabs = [
    { id: "pool", label: "⚽ Мой сет" },
    { id: "team", label: "👥 Команда" },
    { id: "table", label: "🏆 Таблица" },
    { id: "calendar", label: "📅 Календарь" },
    ...(isAdmin ? [
      { id: "admin", label: "🧮 Админка" },
      { id: "admin-diamond", label: "💎 Админка H2H" },
      { id: "admin-calendar", label: "📅 Админка тура" },
    ] : []),
  ];

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100">
      <header className="border-b border-slate-800 px-4 md:px-8 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <img src="/logo.png" alt="" className="w-7 h-7 rounded-md" />
          <span><span className="text-emerald-400">FANTASY</span>STA</span>
        </div>
        <nav className="flex gap-1.5 flex-wrap">
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
        {tab === "pool" && <PoolManagement user={user} />}
        {tab === "team" && <TeamRegistrationInner user={user} />}
        {tab === "table" && <Leaderboard user={user} />}
        {tab === "calendar" && <Calendar />}
        {tab === "admin" && isAdmin && <AdminResultsInner user={user} signOut={signOut} />}
        {tab === "admin-diamond" && isAdmin && <AdminDiamondInner user={user} />}
        {tab === "admin-calendar" && isAdmin && <AdminCalendarInner user={user} />}
      </main>
    </div>
  );
}

export default function FantasystaApp() {
  return <AuthGate>{({ user, profile, signOut }) => <FantasystaShell user={user} profile={profile} signOut={signOut} />}</AuthGate>;
}
