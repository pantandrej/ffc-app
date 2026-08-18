import React, { useState } from "react";
import AuthGate from "./lib/AuthGate.jsx";
import PoolManagement from "./PoolManagement.jsx";
import Calendar from "./Calendar.jsx";
import Leaderboard from "./Leaderboard.jsx";
import { TeamRegistrationInner } from "./TeamRegistration.jsx";
import { AdminResultsInner, ADMIN_EMAILS } from "./AdminResults.jsx";
import { AdminDiamondInner } from "./AdminDiamond.jsx";
import { AdminCalendarInner } from "./AdminCalendar.jsx";

const ADMIN_SECTIONS = [
  { id: "results", label: "Результаты" },
  { id: "diamond", label: "H2H" },
  { id: "calendar", label: "Тур" },
];

function AdminArea({ user, signOut }) {
  const [section, setSection] = useState("results");
  return (
    <div>
      <div className="px-4 md:px-8 pt-4 flex gap-1.5">
        {ADMIN_SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition ${
              section === s.id ? "bg-emerald-500 text-slate-900" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === "results" && <AdminResultsInner user={user} signOut={signOut} />}
      {section === "diamond" && <AdminDiamondInner user={user} />}
      {section === "calendar" && <AdminCalendarInner user={user} />}
    </div>
  );
}

function FantasystaShell({ user, profile, signOut }) {
  const [tab, setTab] = useState("pool"); // "pool" | "team" | "table" | "calendar" | "admin"

  const isAdmin = ADMIN_EMAILS.includes(user.email);

  const tabs = [
    { id: "pool", label: "⚽ Мой сет" },
    { id: "team", label: "👥 Команда" },
    { id: "table", label: "🏆 Таблица" },
    { id: "calendar", label: "📅 Календарь" },
    ...(isAdmin ? [{ id: "admin", label: "🛠 Админка" }] : []),
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
        {tab === "admin" && isAdmin && <AdminArea user={user} signOut={signOut} />}
      </main>
    </div>
  );
}

export default function FantasystaApp() {
  return <AuthGate>{({ user, profile, signOut }) => <FantasystaShell user={user} profile={profile} signOut={signOut} />}</AuthGate>;
}
