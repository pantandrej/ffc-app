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
      <div className="relative min-h-screen bg-slate-900 text-slate-100 overflow-hidden">
        {/* Затемнённая текстура поля — разметка + центральный круг, чисто декоративная */}
        <svg
          className="absolute inset-0 w-full h-full opacity-[0.12] text-emerald-500 pointer-events-none select-none"
          viewBox="0 0 800 600"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="20" y="20" width="760" height="560" />
          <line x1="400" y1="20" x2="400" y2="580" />
          <circle cx="400" cy="300" r="90" />
          <circle cx="400" cy="300" r="4" fill="currentColor" />
          <rect x="20" y="160" width="130" height="280" />
          <rect x="650" y="160" width="130" height="280" />
          <rect x="20" y="240" width="45" height="120" />
          <rect x="735" y="240" width="45" height="120" />
          <path d="M150 260 A50 50 0 0 1 150 340" />
          <path d="M650 260 A50 50 0 0 0 650 340" />
        </svg>

        <div className="relative z-10 px-4 py-10 md:py-16">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-2xl font-extrabold mb-8">
            <img src="/logo.png" alt="" className="w-9 h-9 rounded-md" />
            <span><span className="text-emerald-400">FANTASY</span>STA</span>
          </div>

          <div className="max-w-5xl mx-auto mb-12">
            <h1 className="font-extrabold uppercase tracking-tight leading-[0.95] text-4xl md:text-6xl mb-4">
              Собери состав.<br />
              <span className="text-emerald-400">Назначь капитана.</span><br />
              Разнеси соперника <span className="text-amber-400">1×1</span>.
            </h1>
            <p className="text-slate-400 text-base md:text-lg max-w-2xl">
              Никаких скучных прогнозов на диван — командный фэнтези-футбол с настоящими
              микробаттлами. Твой сет реальных клубов бьётся насмерть с сетом соперника,
              каждый тур — новая дуэль.
            </p>
          </div>

          <div className="max-w-5xl mx-auto grid md:grid-cols-3 gap-4 mb-12">
            <div className="rounded-2xl border border-emerald-500/20 bg-slate-800/80 backdrop-blur-sm p-5 shadow-[0_0_25px_-5px_rgba(16,185,129,0.35)]">
              <div className="text-xs font-bold text-emerald-400 uppercase tracking-wide mb-2">Шаг 1</div>
              <div className="font-bold text-lg mb-2">Собери сет — 100 млн €</div>
              <div className="text-sm text-slate-400 mb-3">5 реальных клубов, бюджет ограничен, 1 бесплатная замена за тур.</div>
              <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
                <span className="px-2 py-1 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30">Tier 1 · 35М</span>
                <span className="px-2 py-1 rounded-full bg-sky-400/10 text-sky-300 border border-sky-400/30">Tier 2 · 25М</span>
                <span className="px-2 py-1 rounded-full bg-emerald-400/10 text-emerald-300 border border-emerald-400/30">Tier 3 · 15М</span>
                <span className="px-2 py-1 rounded-full bg-slate-400/10 text-slate-300 border border-slate-400/30">Tier 4 · 10М</span>
              </div>
            </div>

            <div className="rounded-2xl border border-amber-500/20 bg-slate-800/80 backdrop-blur-sm p-5 shadow-[0_0_25px_-5px_rgba(245,158,11,0.35)]">
              <div className="text-xs font-bold text-amber-400 uppercase tracking-wide mb-2">Шаг 2</div>
              <div className="font-bold text-lg mb-2">Назначь капитана</div>
              <div className="text-sm text-slate-400 mb-3">Один клуб в сете — твой капитан. Всё, что он наберёт за тур, удваивается.</div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30 font-bold text-sm">
                👑 очки ×2
              </div>
            </div>

            <div className="rounded-2xl border border-blue-500/20 bg-slate-800/80 backdrop-blur-sm p-5 shadow-[0_0_25px_-5px_rgba(59,130,246,0.35)]">
              <div className="text-xs font-bold text-blue-400 uppercase tracking-wide mb-2">Шаг 3</div>
              <div className="font-bold text-lg mb-2">Дерись за очки тура</div>
              <div className="text-sm text-slate-400 mb-3">Клубы приносят баллы по факту своих матчей — реальный футбол решает исход.</div>
              <ul className="text-xs text-slate-300 flex flex-col gap-1">
                <li className="flex justify-between"><span>Победа</span><span className="font-bold text-blue-300">+3</span></li>
                <li className="flex justify-between"><span>Ничья</span><span className="font-bold text-blue-300">+1</span></li>
                <li className="flex justify-between"><span>Гол (за каждый)</span><span className="font-bold text-blue-300">+1</span></li>
                <li className="flex justify-between"><span>Сухой матч</span><span className="font-bold text-blue-300">+2</span></li>
              </ul>
            </div>
          </div>

          <div className="max-w-5xl mx-auto grid md:grid-cols-[1fr_auto] gap-8 items-start">
            <section>
              <h2 className="font-bold text-lg mb-3">Две лиги, два формата боя</h2>
              <div className="flex flex-col gap-3">
                <div className="rounded-xl border border-slate-700 bg-slate-800 p-3">
                  <div className="font-semibold text-emerald-400 text-sm mb-1">Общая лига · бесплатно</div>
                  <div className="text-xs text-slate-400">Личный зачёт: сумма очков твоей команды за все туры, одна общая таблица всех игроков.</div>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-800 p-3">
                  <div className="font-semibold text-amber-300 text-sm mb-1">💎 Бриллиантовая лига · платно, скоро</div>
                  <div className="text-xs text-slate-400">Команда против команды: каждый тур — три личные дуэли 1×1 по ролям (капитан/игрок1/игрок2), исход решает общий счёт матча.</div>
                </div>
              </div>
            </section>

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
      </div>
    );
  }

  return children({ session, user, profile, signOut });
}
