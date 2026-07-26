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
      <div className="min-h-screen bg-slate-900 text-slate-100 px-4 py-10 md:py-16">
        <div className="max-w-4xl mx-auto flex items-center gap-2 text-2xl font-extrabold mb-2">
          <img src="/logo.png" alt="" className="w-9 h-9 rounded-md" />
          FANTASYSTA
        </div>
        <div className="max-w-4xl mx-auto text-slate-400 mb-10">
          Собери пул из 5 реальных клубов, следи за турами и борись за первое место в таблице.
        </div>

        <div className="max-w-4xl mx-auto grid md:grid-cols-2 gap-8">
          <div className="flex flex-col gap-8">
            <section>
              <h2 className="font-bold text-lg mb-3">Как начисляются очки</h2>
              <ul className="text-sm text-slate-300 flex flex-col gap-1.5">
                <li className="flex justify-between border-b border-slate-800 pb-1.5"><span>Победа клуба</span><span className="font-semibold text-emerald-400">+3</span></li>
                <li className="flex justify-between border-b border-slate-800 pb-1.5"><span>Ничья</span><span className="font-semibold text-emerald-400">+1</span></li>
                <li className="flex justify-between border-b border-slate-800 pb-1.5"><span>Гол (за каждый)</span><span className="font-semibold text-emerald-400">+1</span></li>
                <li className="flex justify-between border-b border-slate-800 pb-1.5"><span>Сухой матч</span><span className="font-semibold text-emerald-400">+2</span></li>
                <li className="flex justify-between"><span>Капитан пула</span><span className="font-semibold text-amber-400">очки ×2</span></li>
              </ul>
              <div className="text-xs text-slate-500 mt-3">
                Бюджет 100 млн € на 5 клубов, 1 бесплатная замена за тур.
              </div>
            </section>

            <section>
              <h2 className="font-bold text-lg mb-3">Лиги</h2>
              <div className="flex flex-col gap-3">
                <div className="rounded-xl border border-slate-700 bg-slate-800 p-3">
                  <div className="font-semibold text-emerald-400 text-sm mb-1">Общая лига · бесплатно</div>
                  <div className="text-xs text-slate-400">Личный зачёт: сумма очков твоей команды за все туры, одна общая таблица всех игроков.</div>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-800 p-3">
                  <div className="font-semibold text-amber-300 text-sm mb-1">💎 Бриллиантовая лига · платно, скоро</div>
                  <div className="text-xs text-slate-400">Команда против команды: каждый тур — «матч» с соперником, победа/ничья/поражение по очкам тура, отдельная турнирная таблица.</div>
                </div>
              </div>
            </section>
          </div>

          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-800 p-6 h-fit">
            <div className="font-bold text-lg mb-1">Вход</div>
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
      </div>
    );
  }

  return children({ session, user, profile, signOut });
}
