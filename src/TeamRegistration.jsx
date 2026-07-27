import React, { useState, useEffect, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import AuthGate from "./lib/AuthGate.jsx";

const LEAGUE_LABEL = { free: "Общая лига", superleague: "Бриллиантовая лига" };
const ROLE_LABEL = { captain: "Капитан", player_1: "Игрок 1", player_2: "Игрок 2" };

function friendlyError(e) {
  return e?.message || String(e || "Неизвестная ошибка");
}

// Контент вкладки "Команда" — без своей шапки/логина, встраивается в FantasystaApp.
// onTeamChange вызывается после создания/вступления/выхода, чтобы каркас мог
// обновить teamId для вкладки "Мой пул".
export function TeamRegistrationInner({ user, onTeamChange }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const [myTeam, setMyTeam] = useState(null); // { id, name, league }
  const [myTeammates, setMyTeammates] = useState([]);
  const [openTeams, setOpenTeams] = useState([]);
  const [newTeamName, setNewTeamName] = useState("");

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const membershipRes = await supabase
        .from("team_members")
        .select("team_id, teams(id,name,league)")
        .eq("profile_id", user.id)
        .maybeSingle();
      if (membershipRes.error && membershipRes.error.code !== "PGRST116") throw membershipRes.error;

      const membership = membershipRes.data;
      if (membership?.teams) {
        setMyTeam(membership.teams);
        const membersRes = await supabase
          .from("team_members")
          .select("profile_id, role_in_team, fantasysta_profiles(username)")
          .eq("team_id", membership.teams.id);
        if (membersRes.error) throw membersRes.error;
        setMyTeammates(membersRes.data || []);
        setOpenTeams([]);
      } else {
        setMyTeam(null);
        setMyTeammates([]);
        const teamsRes = await supabase.from("teams").select("id,name,league,team_members(count)");
        if (teamsRes.error) throw teamsRes.error;
        const open = (teamsRes.data || []).filter(t => (t.team_members?.[0]?.count ?? 0) < 3);
        setOpenTeams(open);
      }
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setLoading(false);
    }
  }, [user.id, showToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function createTeam(e) {
    e.preventDefault();
    const name = newTeamName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const { data: team, error } = await supabase
        .from("teams")
        .insert({ name, created_by: user.id })
        .select()
        .single();
      if (error) throw error;
      const { error: memberError } = await supabase
        .from("team_members")
        .insert({ team_id: team.id, profile_id: user.id });
      if (memberError) throw memberError;
      showToast("✓ Команда создана");
      setNewTeamName("");
      await loadAll();
      onTeamChange?.();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function joinTeam(teamId) {
    setBusy(true);
    try {
      const { error } = await supabase.from("team_members").insert({ team_id: teamId, profile_id: user.id });
      if (error) throw error;
      showToast("✓ Вы вступили в команду");
      await loadAll();
      onTeamChange?.();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function setMyRole(role) {
    if (!myTeam) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("team_members")
        .update({ role_in_team: role || null })
        .eq("team_id", myTeam.id)
        .eq("profile_id", user.id);
      if (error) throw error;
      showToast("✓ Роль сохранена");
      await loadAll();
    } catch (e) {
      showToast(
        e?.code === "23505" ? "Эта роль уже занята другим участником" : friendlyError(e),
        "error"
      );
    } finally {
      setBusy(false);
    }
  }

  async function leaveTeam() {
    if (!myTeam) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("team_members")
        .delete()
        .eq("team_id", myTeam.id)
        .eq("profile_id", user.id);
      if (error) throw error;
      showToast("Вы вышли из команды");
      await loadAll();
      onTeamChange?.();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="text-slate-400 p-4 md:p-8">Загрузка…</div>;

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        {myTeam ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-slate-800 p-6">
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">{LEAGUE_LABEL[myTeam.league] || myTeam.league}</div>
            <div className="text-2xl font-extrabold mb-4">{myTeam.name}</div>
            <div className="text-sm text-slate-400 mb-2">Состав ({myTeammates.length}/3):</div>
            <ul className="flex flex-col gap-2 mb-3">
              {myTeammates.map(m => (
                <li key={m.profile_id} className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm flex items-center justify-between gap-3">
                  <span>
                    {m.fantasysta_profiles?.username || m.profile_id}
                    {m.profile_id === user.id && <span className="text-slate-500"> (ты)</span>}
                  </span>
                  {m.profile_id === user.id ? (
                    <select
                      value={m.role_in_team || ""}
                      onChange={e => setMyRole(e.target.value)}
                      disabled={busy}
                      className="bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1 text-slate-200 disabled:opacity-50"
                    >
                      <option value="">Роль не выбрана</option>
                      <option value="captain">Капитан</option>
                      <option value="player_1">Игрок 1</option>
                      <option value="player_2">Игрок 2</option>
                    </select>
                  ) : (
                    <span className="text-xs text-slate-500">{ROLE_LABEL[m.role_in_team] || "роль не выбрана"}</span>
                  )}
                </li>
              ))}
            </ul>
            <div className="text-xs text-slate-500 mb-6">
              Роль (Капитан / Игрок 1 / Игрок 2) определяет твоего соперника 1×1 в Бриллиантовой лиге — у каждой роли должен быть свой личный состав из 5 клубов.
            </div>
            <button
              type="button"
              onClick={leaveTeam}
              disabled={busy}
              className="text-sm text-red-400 hover:text-red-300 disabled:opacity-50 transition"
            >
              Покинуть команду
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-slate-700 bg-slate-800 p-6">
              <div className="text-lg font-bold mb-3">Создать команду</div>
              <form onSubmit={createTeam} className="flex gap-2">
                <input
                  type="text"
                  required
                  value={newTeamName}
                  onChange={e => setNewTeamName(e.target.value)}
                  placeholder="Название команды"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="px-5 py-2 rounded-lg font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
                >
                  Создать
                </button>
              </form>
            </div>

            <div>
              <div className="text-lg font-bold mb-3">Или найди команду и вступи</div>
              {openTeams.length === 0 ? (
                <div className="text-slate-500 text-sm">Пока нет открытых команд со свободными местами.</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {openTeams.map(t => {
                    const count = t.team_members?.[0]?.count ?? 0;
                    return (
                      <div key={t.id} className="rounded-xl border border-slate-700 bg-slate-800 p-4 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold truncate">{t.name}</div>
                          <div className="text-xs text-slate-400">{LEAGUE_LABEL[t.league] || t.league} · {count}/3 человек</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => joinTeam(t.id)}
                          disabled={busy}
                          className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-sky-500 hover:bg-sky-400 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
                        >
                          Вступить
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 max-w-sm rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${toast.kind === "error" ? "bg-red-600 text-white" : "bg-emerald-500 text-slate-900"}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}

// Отдельная самостоятельная страница (со своим логином) — оставлена для
// прямого захода по ?test=team.
export default function TeamRegistration() {
  return <AuthGate>{({ user }) => <TeamRegistrationInner user={user} />}</AuthGate>;
}
