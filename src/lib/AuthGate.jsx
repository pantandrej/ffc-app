import React, { useState } from "react";
import { useFantasystaAuth } from "./useFantasystaAuth.js";

// Общий "затвор" для FANTASYСТА-экранов: пока нет сессии — форма логина
// по magic-link (без паролей). Как только юзер залогинен — рендерит children,
// прокидывая { session, user, profile, signOut }.
export default function AuthGate({ children }) {
  const { session, user, profile, loading, signInWithEmail, signOut } = useFantasystaAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    setError("");
    const { error: err } = await signInWithEmail(email.trim());
    setSending(false);
    if (err) setError(err.message || "Не удалось отправить ссылку");
    else setSent(true);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center">
        <div className="text-slate-400">Загрузка…</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-800 p-6">
          <div className="text-2xl font-extrabold mb-1">⚽ FANTASYСТА</div>
          <div className="text-sm text-slate-400 mb-5">Вход по ссылке на почту — без пароля.</div>
          {sent ? (
            <div className="text-emerald-400 text-sm">
              Проверь почту {email} — там ссылка для входа.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
              />
              {error && <div className="text-red-400 text-xs">{error}</div>}
              <button
                type="submit"
                disabled={sending}
                className="py-2.5 rounded-lg font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {sending ? "Отправляю…" : "Получить ссылку для входа"}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  return children({ session, user, profile, signOut });
}
