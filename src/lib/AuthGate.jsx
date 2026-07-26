import React, { useState } from "react";
import { useFantasystaAuth } from "./useFantasystaAuth.js";

// Общий "затвор" для FANTASYSTA-экранов: пока нет сессии — форма логина
// (VK ID или ссылка на почту). Как только юзер залогинен — рендерит children,
// прокидывая { session, user, profile, signOut }.
export default function AuthGate({ children }) {
  const { session, user, profile, loading, signInWithEmail, signInWithVK, vkError, signOut } = useFantasystaAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [vkLoading, setVkLoading] = useState(false);

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

  async function handleVKClick() {
    setVkLoading(true);
    await signInWithVK();
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
          <div className="text-2xl font-extrabold mb-1">⚽ FANTASYSTA</div>
          <div className="text-sm text-slate-400 mb-5">Войди через VK или по ссылке на почту.</div>

          {vkError && <div className="text-red-400 text-xs mb-3">{vkError}</div>}

          <button
            type="button"
            onClick={handleVKClick}
            disabled={vkLoading}
            className="w-full py-2.5 rounded-lg font-semibold bg-[#0077FF] hover:bg-[#0066DD] text-white disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
          >
            {vkLoading ? "Переходим в VK…" : "Войти через VK"}
          </button>

          <div className="flex items-center gap-3 my-4">
            <div className="h-px bg-slate-700 flex-1" />
            <div className="text-xs text-slate-500">или</div>
            <div className="h-px bg-slate-700 flex-1" />
          </div>

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
