import React, { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ADMIN_EMAILS } from "./AdminResults.jsx";

const BUDGET = 100000000;
const POOL_SIZE = 5;

function friendlyError(e) {
  return e?.message || String(e || "Неизвестная ошибка");
}

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
    } catch (e) {
      showToast(
        e?.code === "23505" ? "Эта роль в команде уже занята" : friendlyError(e),
        "error"
      );
    } finally {
      setAddBusy(false);
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
