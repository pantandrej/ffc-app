import { useState, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient.js";
import { signInWithVK, handleVKCallback } from "./vkAuth.js";

// auth.users общий на весь Supabase-проект (тот же, что у старого прогнозиста).
// Триггер on_auth_user_created_fantasysta создаёт fantasysta_profiles только
// для НОВЫХ регистраций — у людей, которые завели аккаунт раньше (например,
// через старый прогнозист), профиля может не быть. Подстраховываемся здесь.
async function ensureProfile(user) {
  if (!user) return null;
  const { data: existing } = await supabase
    .from("fantasysta_profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();
  if (existing) return existing;

  const base = (user.email || "user").split("@")[0];
  const { data: created, error } = await supabase
    .from("fantasysta_profiles")
    .insert({ id: user.id, username: base })
    .select()
    .single();
  if (!error) return created;

  // username занят — добавляем короткий суффикс от id, как и триггер в БД.
  const { data: retried } = await supabase
    .from("fantasysta_profiles")
    .insert({ id: user.id, username: `${base}_${user.id.slice(0, 6)}` })
    .select()
    .single();
  return retried || null;
}

export function useFantasystaAuth() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [vkError, setVkError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function initFromSession(s) {
      setSession(s);
      if (s?.user) {
        const p = await ensureProfile(s.user);
        if (!cancelled) setProfile(p);
      } else if (!cancelled) {
        setProfile(null);
      }
      if (!cancelled) setLoading(false);
    }

    (async () => {
      // Если в адресе есть code от VK — сначала завершаем этот вход,
      // и только потом читаем сессию (verifyOtp внутри уже её создаст).
      const vkResult = await handleVKCallback();
      if (cancelled) return;
      if (vkResult.error) setVkError(vkResult.error);
      const { data } = await supabase.auth.getSession();
      if (!cancelled) await initFromSession(data.session);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      initFromSession(s);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signInWithEmail = useCallback(async (email) => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.href },
    });
    return { error };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return { session, user: session?.user || null, profile, loading, signInWithEmail, signInWithVK, vkError, signOut };
}
