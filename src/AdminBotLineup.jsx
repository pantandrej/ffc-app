import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";
import { friendlyError } from "./lib/friendlyError.js";

const BUDGET = 100000000;
const POOL_SIZE = 5;
const ROLE_LABEL = { captain: "Капитан", player_1: "Игрок 1", player_2: "Игрок 2" };

function formatMoney(value) {
  return `${new Intl.NumberFormat("ru-RU").format(Number(value) || 0)} €`;
}

// Проставление сета за игрока, который сам не может зайти на сайт (боты вроде
// ChatGPT/Claude, тестовые аккаунты) — те же правила (5 клубов, 100 млн,
// 1 Джокер), только пишет от имени выбранного профиля (нужны права админа
// на user_lineups, см. sql/fantasysta_module20).
export function AdminBotLineupInner({ user }) {
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState("");
  const [gameweeks, setGameweeks] = useState([]);
  const [gameweekId, setGameweekId] = useState(null);
  const [clubs, setClubs] = useState([]);

  const [poolClubIds, setPoolClubIds] = useState([]);
  const [captainId, setCaptainId] = useState(null);

  const [teams, setTeams] = useState([]);
  const [addTeamId, setAddTeamId] = useState("");
  const [addProfileId, setAddProfileId] = useState("");
  const [addRole, setAddRole] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const [members, setMembers] = useState([]); // [{profileId, username, teamName, role}]
  const [lineupsByProfile, setLineupsByProfile] = useState(new Map()); // profileId -> [{name, isCaptain}]
  const [overviewView, setOverviewView] = useState("members"); // "members" | "clubs"
  const [clubPopularity, setClubPopularity] = useState([]); // [{club_id, club_name, league, times_picked}]

  const [editingProfileId, setEditingProfileId] = useState(null);
  const [editUsername, setEditUsername] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);

  const showToast = useCallback((text, kind = "success") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [profRes, gwRes, clubsRes, teamsRes] = await Promise.all([
          supabase.from("fantasysta_profiles").select("id,username").order("username"),
          supabase.from("gameweeks").select("*").order("id"),
          supabase.from("clubs").select("*").order("league").order("name"),
          supabase.from("teams").select("id,name").order("name"),
        ]);
        if (profRes.error) throw profRes.error;
        if (gwRes.error) throw gwRes.error;
        if (clubsRes.error) throw clubsRes.error;
        if (teamsRes.error) throw teamsRes.error;
        if (cancelled) return;
        setProfiles(profRes.data || []);
        setGameweeks(gwRes.data || []);
        setClubs(clubsRes.data || []);
        setTeams(teamsRes.data || []);
        const active = (gwRes.data || []).find(g => g.status === "active") || (gwRes.data || [])[0];
        if (active) setGameweekId(active.id);
      } catch (e) {
        if (!cancelled) showToast(friendlyError(e), "error");
      }
    })();
    return () => { cancelled = true; };
  }, [showToast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!profileId || !gameweekId) { setPoolClubIds([]); setCaptainId(null); return; }
      const { data, error } = await supabase
        .from("user_lineups")
        .select("club_id, is_club_captain")
        .eq("profile_id", profileId)
        .eq("gameweek_id", gameweekId);
      if (cancelled) return;
      if (error) { showToast(friendlyError(error), "error"); return; }
      const rows = data || [];
      setPoolClubIds(rows.map(r => r.club_id));
      setCaptainId(rows.find(r => r.is_club_captain)?.club_id || null);
    })();
    return () => { cancelled = true; };
  }, [profileId, gameweekId, showToast]);

  const loadOverview = useCallback(async () => {
    if (!gameweekId) { setMembers([]); setLineupsByProfile(new Map()); return; }
    try {
      const [membersRes, lineupsRes] = await Promise.all([
        supabase
          .from("team_members")
          .select("profile_id, role_in_team, fantasysta_profiles(username), teams(name)"),
        supabase
          .from("user_lineups")
          .select("profile_id, is_club_captain, clubs(name), fantasysta_profiles(username)")
          .eq("gameweek_id", gameweekId),
      ]);
      if (membersRes.error) throw membersRes.error;
      if (lineupsRes.error) throw lineupsRes.error;

      // Участник — это либо член какой-то команды, либо просто игрок с
      // собранным сетом на этот тур (сольный формат не требует команды,
      // поэтому одних team_members недостаточно — иначе такие игроки
      // невидимы для админа).
      const byProfile = new Map();
      (membersRes.data || []).forEach(m => {
        byProfile.set(m.profile_id, {
          profileId: m.profile_id,
          username: m.fantasysta_profiles?.username || m.profile_id,
          teamName: m.teams?.name || "—",
          role: m.role_in_team,
        });
      });

      const map = new Map();
      (lineupsRes.data || []).forEach(row => {
        const list = map.get(row.profile_id) || [];
        list.push({ name: row.clubs?.name || "—", isCaptain: row.is_club_captain });
        map.set(row.profile_id, list);
        if (!byProfile.has(row.profile_id)) {
          byProfile.set(row.profile_id, {
            profileId: row.profile_id,
            username: row.fantasysta_profiles?.username || row.profile_id,
            teamName: "—",
            role: null,
          });
        }
      });
      setLineupsByProfile(map);
      setMembers([...byProfile.values()].sort((a, b) => a.username.localeCompare(b.username, "ru")));
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [gameweekId, showToast]);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadClubPopularity = useCallback(async () => {
    if (!gameweekId) { setClubPopularity([]); return; }
    try {
      const { data, error } = await supabase.from("club_pick_popularity").select("*").eq("gameweek_id", gameweekId);
      if (error) throw error;
      setClubPopularity((data || []).sort((a, b) => b.times_picked - a.times_picked));
    } catch (e) {
      showToast(friendlyError(e), "error");
    }
  }, [gameweekId, showToast]);

  useEffect(() => { loadClubPopularity(); }, [loadClubPopularity]);

  const clubsById = useMemo(() => new Map(clubs.map(c => [c.id, c])), [clubs]);
  const poolClubs = useMemo(() => poolClubIds.map(id => clubsById.get(id)).filter(Boolean), [poolClubIds, clubsById]);
  const bankBalance = useMemo(() => BUDGET - poolClubs.reduce((s, c) => s + Number(c.price || 0), 0), [poolClubs]);
  const captainValid = !!captainId && poolClubIds.includes(captainId);
  const canSave = !!profileId && !!gameweekId && poolClubIds.length === POOL_SIZE && captainValid && bankBalance >= 0;

  function toggleClub(clubId) {
    setPoolClubIds(prev => {
      if (prev.includes(clubId)) {
        if (captainId === clubId) setCaptainId(null);
        return prev.filter(id => id !== clubId);
      }
      if (prev.length >= POOL_SIZE) return prev;
      return [...prev, clubId];
    });
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const { error: delErr } = await supabase.from("user_lineups").delete().eq("profile_id", profileId).eq("gameweek_id", gameweekId);
      if (delErr) throw delErr;
      const rows = poolClubIds.map(clubId => ({
        profile_id: profileId,
        gameweek_id: gameweekId,
        club_id: clubId,
        is_club_captain: clubId === captainId,
      }));
      const { error: insErr } = await supabase.from("user_lineups").insert(rows);
      if (insErr) throw insErr;
      showToast("✓ Сет сохранён");
      await loadOverview();
    } catch (e) {
      showToast(friendlyError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function addMember(e) {
    e.preventDefault();
    if (!addTeamId || !addProfileId) {
      showToast("Выбери команду и игрока", "error");
      return;
    }
    setAddBusy(true);
    try {
      const { error } = await supabase.from("team_members").insert({
        team_id: addTeamId,
        profile_id: addProfileId,
        role_in_team: addRole || null,
      });
      if (error) throw error;
      showToast("✓ Игрок добавлен в команду");
      setAddProfileId("");
      setAddRole("");
      await loadOverview();
    } catch (e) {
      showToast(
        e?.code === "23505" ? "Эта роль в команде уже занята" : friendlyError(e),
        "error"
      );
    } finally {
      setAddBusy(false);
    }
  }

  function startRename(m) {
    setEditingProfileId(m.profileId);
    setEditUsername(m.username);
  }

  async function saveRename(profileIdToRename) {
    const name = editUsername.trim();
    if (!name) return;
    setRenameBusy(true);
    try {
      const { error } = await supabase.from("fantasysta_profiles").update({ username: name }).eq("id", profileIdToRename);
      if (error) throw error;
      setMembers(prev => prev.map(m => (m.profileId === profileIdToRename ? { ...m, username: name } : m)));
      setProfiles(prev => prev.map(p => (p.id === profileIdToRename ? { ...p, username: name } : p)));
      setEditingProfileId(null);
      showToast("✓ Имя сохранено");
    } catch (e) {
      showToast(e?.code === "23505" ? "Это имя уже занято" : friendlyError(e), "error");
    } finally {
      setRenameBusy(false);
    }
  }

  const postListText = useMemo(
    () => members.map((m, i) => `${i + 1}) ${m.username} (${m.teamName})`).join("\n"),
    [members]
  );

  async function copyPostList() {
    try {
      await navigator.clipboard.writeText(postListText);
      showToast("✓ Список скопирован");
    } catch {
      showToast("Не удалось скопировать — выдели текст вручную", "error");
    }
  }

  if (!ADMIN_EMAILS.includes(user.email)) {
    return <div className="p-10 text-center text-slate-400">Эта страница только для админа.</div>;
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-3xl mx-auto flex flex-col gap-6">
        <h1 className="text-xl font-extrabold">🤖 Управление участниками и сетами за игроков</h1>

        <section>
          <h2 className="font-bold mb-3">Добавить игрока в команду</h2>
          <form onSubmit={addMember} className="flex flex-wrap items-center gap-2">
            <select value={addTeamId} onChange={e => setAddTeamId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2">
              <option value="">Команда…</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select value={addProfileId} onChange={e => setAddProfileId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2">
              <option value="">Игрок…</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.username}</option>)}
            </select>
            <select value={addRole} onChange={e => setAddRole(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2">
              <option value="">Роль не выбрана</option>
              <option value="captain">Капитан</option>
              <option value="player_1">Игрок 1</option>
              <option value="player_2">Игрок 2</option>
            </select>
            <button type="submit" disabled={addBusy} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:opacity-50 transition">
              Добавить
            </button>
          </form>
          <div className="text-xs text-slate-500 mt-2">Если игрок уже в другой команде — вставка не пройдёт (человек может состоять только в одной команде).</div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold">Участники и их сеты</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setOverviewView("members")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${overviewView === "members" ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300"}`}
                >
                  Участники
                </button>
                <button
                  type="button"
                  onClick={() => setOverviewView("clubs")}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${overviewView === "clubs" ? "bg-emerald-500 border-emerald-500 text-slate-900" : "border-slate-700 text-slate-300"}`}
                >
                  Выбранные клубы
                </button>
              </div>
              <select value={gameweekId ?? ""} onChange={e => setGameweekId(Number(e.target.value))} className="bg-slate-800 border border-slate-700 rounded-lg text-xs px-2 py-1.5">
                {gameweeks.map(gw => <option key={gw.id} value={gw.id}>Тур №{gw.id} · {gw.status}</option>)}
              </select>
            </div>
          </div>

          {overviewView === "members" ? (
            members.length === 0 ? (
              <div className="text-slate-500 text-sm">Пока ни одного участника.</div>
            ) : (
              <div className="rounded-2xl border border-slate-700 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                      <th className="text-left px-4 py-2">Участник</th>
                      <th className="text-left px-4 py-2">Команда</th>
                      <th className="text-left px-4 py-2">Сет</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m, i) => {
                      const lineup = lineupsByProfile.get(m.profileId);
                      return (
                        <tr key={m.profileId} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                          <td className="px-4 py-2">
                            {editingProfileId === m.profileId ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="text"
                                  value={editUsername}
                                  onChange={e => setEditUsername(e.target.value)}
                                  autoFocus
                                  className="bg-slate-900 border border-slate-700 rounded-lg text-sm px-2 py-1 w-32"
                                />
                                <button type="button" disabled={renameBusy} onClick={() => saveRename(m.profileId)} className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold">✓</button>
                                <button type="button" onClick={() => setEditingProfileId(null)} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <div className="font-medium">{m.username}</div>
                                <button type="button" onClick={() => startRename(m)} title="Переименовать" className="text-slate-600 hover:text-sky-400 text-xs">✎</button>
                              </div>
                            )}
                            {m.role && <div className="text-[10px] text-slate-500">{ROLE_LABEL[m.role] || m.role}</div>}
                          </td>
                          <td className="px-4 py-2 text-slate-400">{m.teamName}</td>
                          <td className="px-4 py-2">
                            {lineup ? (
                              <div className="flex flex-wrap gap-1.5">
                                {lineup.map((c, j) => (
                                  <span
                                    key={j}
                                    className={`px-1.5 py-0.5 rounded text-[10px] ${c.isCaptain ? "bg-amber-400/10 text-amber-300 border border-amber-400/30" : "bg-slate-800 text-slate-300 border border-slate-700"}`}
                                  >
                                    {c.isCaptain && "🃏 "}{c.name}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setProfileId(m.profileId)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-300 border border-amber-400/30 hover:bg-amber-400/20 transition"
                              >
                                не выбрал — заполнить
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : clubPopularity.length === 0 ? (
            <div className="text-slate-500 text-sm">Пока никто не выбрал клубы на этот тур.</div>
          ) : (
            <div className="rounded-2xl border border-slate-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-slate-400 text-xs uppercase">
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Клуб</th>
                    <th className="text-left px-4 py-2">Лига</th>
                    <th className="px-4 py-2">Выбран раз</th>
                  </tr>
                </thead>
                <tbody>
                  {clubPopularity.map((row, i) => (
                    <tr key={row.club_id} className={`border-t border-slate-800 ${i % 2 === 0 ? "bg-slate-900" : "bg-slate-900/60"}`}>
                      <td className="px-4 py-2 text-slate-500">{i + 1}</td>
                      <td className="px-4 py-2 font-medium">{row.club_name}</td>
                      <td className="px-4 py-2 text-slate-400">{row.league}</td>
                      <td className="px-4 py-2 text-center font-bold text-emerald-400">{row.times_picked}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bold">Список для поста</h2>
            <button
              type="button"
              onClick={copyPostList}
              disabled={members.length === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-700 text-slate-300 hover:border-emerald-500 hover:text-emerald-400 disabled:opacity-50 transition"
            >
              Скопировать
            </button>
          </div>
          <textarea
            readOnly
            value={postListText}
            placeholder="Пока некому — добавь участников выше."
            rows={Math.max(4, members.length)}
            onFocus={e => e.target.select()}
            className="w-full bg-slate-900 border border-slate-700 rounded-xl text-sm px-3 py-2 font-mono text-slate-300"
          />
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="font-bold">Сет за игрока (боты и подставные аккаунты)</h2>

        <div className="flex flex-wrap gap-2">
          <select value={profileId} onChange={e => setProfileId(e.target.value)} className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2">
            <option value="">Выбери игрока…</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.username}</option>)}
          </select>
          <select value={gameweekId ?? ""} onChange={e => setGameweekId(Number(e.target.value))} className="bg-slate-800 border border-slate-700 rounded-lg text-sm px-3 py-2">
            {gameweeks.map(gw => <option key={gw.id} value={gw.id}>Тур №{gw.id} · {gw.status}</option>)}
          </select>
        </div>

        {profileId && (
          <>
            <div className={`rounded-2xl p-4 border ${bankBalance < 0 ? "bg-red-950/40 border-red-500" : "bg-slate-800 border-emerald-500/30"}`}>
              <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Баланс</div>
              <div className={`text-2xl font-extrabold ${bankBalance < 0 ? "text-red-400" : "text-emerald-400"}`}>{formatMoney(bankBalance)}</div>
              <div className="text-xs text-slate-500 mt-1">{poolClubIds.length}/5 клубов выбрано</div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {clubs.map(c => {
                const selected = poolClubIds.includes(c.id);
                const isCaptain = captainId === c.id;
                return (
                  <div key={c.id} className={`rounded-lg border px-3 py-2 text-sm flex items-center justify-between gap-2 ${selected ? "border-emerald-500 bg-emerald-500/10" : "border-slate-700 bg-slate-800"}`}>
                    <button type="button" onClick={() => toggleClub(c.id)} className="flex-1 min-w-0 text-left truncate">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="text-xs text-slate-500">{c.league} · {formatMoney(c.price)}</div>
                    </button>
                    {selected && (
                      <button
                        type="button"
                        onClick={() => setCaptainId(isCaptain ? null : c.id)}
                        title="Джокер"
                        className={`flex-shrink-0 text-lg ${isCaptain ? "" : "opacity-30"}`}
                      >
                        🃏
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={save}
              disabled={!canSave || saving}
              className="w-full py-3 rounded-xl font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:bg-slate-700 disabled:text-slate-500 transition"
            >
              {saving ? "Сохраняю…" : "Сохранить сет за игрока"}
            </button>
            {!captainValid && poolClubIds.length === POOL_SIZE && (
              <div className="text-xs text-amber-400 text-center -mt-3">Выбери Джокера (🃏) среди выбранных клубов</div>
            )}
          </>
        )}
        </section>
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 max-w-sm rounded-xl px-4 py-3 shadow-lg text-sm font-medium ${toast.kind === "error" ? "bg-red-600 text-white" : "bg-emerald-500 text-slate-900"}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
