// FFC App v6 — Football Fight Club / Прогнозиста ЧМ-2026
// Меню: ТОЛЬКО "Отправить прогноз" | "Таблица лидеров" | "Админ" (для admin)
// Вкладки groups/playoff/questions/table/thirds/ffc/plans УДАЛЕНЫ.
// Плей-офф, бонусы, третьи места — секции внутри "Отправить прогноз".
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gcuxixbldjrztnqsdqcs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjdXhpeGJsZGpyenRucXNkcWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDU1ODMsImV4cCI6MjA5NTM4MTU4M30.f6LGTZyW1qDyZ0urE0atzABmyAjQ9p8gAkinyu7j5h8";

// supabase-js клиент — только для auth (OAuth, session, signOut)
// Для DB-запросов используется supa() ниже
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// Для Google OAuth:
// Supabase → Authentication → Providers → Google → Enable
// Google Cloud → OAuth 2.0 → Redirect URI:
//   https://gcuxixbldjrztnqsdqcs.supabase.co/auth/v1/callback
// Supabase → Auth → URL Configuration → Site URL:
//   https://ffc-app.vercel.app

// VK OAuth планируется — реализация будет добавлена отдельно через Supabase Custom OAuth2

const supa = (path, opts = {}) => {
  const { token, headers: extraHeaders, prefer, ...fetchOpts } = opts;
  // Только настоящий Supabase JWT используем как Bearer; иначе — anon key
  const looksLikeJwt = typeof token === "string" && token.split(".").length === 3;
  const authToken = (token && looksLikeJwt) ? token : SUPABASE_KEY;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...fetchOpts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
      Prefer: prefer || extraHeaders?.Prefer || "return=representation",
      ...extraHeaders,
    },
  });
};

// Получить свежий Supabase access_token.
// Принимает опциональный onSessionRestored(sessObj) для обновления React state.
// НЕ возвращает anon key — только настоящий пользовательский JWT.
async function getFreshToken(onSessionRestored) {
  // 1. supabaseClient.auth.getSession() — самый надёжный способ
  //    supabase-js умеет автоматически обновлять токен через refresh_token
  try {
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.access_token) {
      const fresh = {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        user:          data.session.user,
      };
      // Обновляем ffc_session и React state если токен изменился
      const stored = localStorage.getItem("ffc_session");
      let old = null;
      try { old = JSON.parse(stored || "{}"); } catch {}
      if (old?.access_token !== fresh.access_token) {
        localStorage.setItem("ffc_session", JSON.stringify(fresh));
        if (onSessionRestored) onSessionRestored(fresh);
      }
      return fresh.access_token;
    }
  } catch (e) {
    console.warn("getFreshToken: getSession failed", e);
  }

  // 2. Попробовать setSession с refresh_token из ffc_session
  try {
    const stored = localStorage.getItem("ffc_session");
    if (stored) {
      const s = JSON.parse(stored);
      if (s?.refresh_token) {
        const { data: restored } = await supabaseClient.auth.setSession({
          access_token:  s.access_token  || "",
          refresh_token: s.refresh_token,
        });
        if (restored?.session?.access_token) {
          const fresh = {
            access_token:  restored.session.access_token,
            refresh_token: restored.session.refresh_token,
            user:          restored.session.user,
          };
          localStorage.setItem("ffc_session", JSON.stringify(fresh));
          if (onSessionRestored) onSessionRestored(fresh);
          return fresh.access_token;
        }
      }
    }
  } catch (e) {
    console.warn("getFreshToken: setSession fallback failed", e);
  }

  // 3. Попробовать sb-...-auth-token из Supabase-js localStorage
  try {
    const authKey = Object.keys(localStorage).find(k => k.startsWith("sb-") && k.endsWith("-auth-token"));
    if (authKey) {
      const raw = JSON.parse(localStorage.getItem(authKey) || "{}");
      const t = raw?.access_token || raw?.currentSession?.access_token;
      if (t && typeof t === "string" && t.split(".").length === 3) return t;
    }
  } catch (e) {}

  return null; // Не возвращаем anon key
}

const supaAuth = (path, body, method = "POST") =>
  fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// ── УРОВНИ ДОСТУПА ──
const ACCESS = {
  DEMO: "DEMO",
  PROGNOSTISTA: "PROGNOSTISTA_PAID",
  FULL: "FULL_ACCESS",
  ADMIN: "ADMIN",
};

// ── ДЕДЛАЙН ТУРНИРА ──
// Дедлайн ЧМ-2026: старт первого матча — 11 июня 2026, 15:00 Mexico City (UTC-6) = 21:00 UTC
const WORLD_CUP_DEADLINE = "2026-06-11T21:00:00Z";
const TOURNAMENT_DEADLINE = new Date(WORLD_CUP_DEADLINE);
const isBefore = (dt) => new Date() < new Date(dt);
const isOpen = () => isBefore(TOURNAMENT_DEADLINE);

// ── ТАРИФЫ ──
// Активные тарифы для новых покупок
const PLANS = [
  { id: "prognostista", label: "Битва прогнозистов", price: 500, desc: "Большой турнир прогнозов на весь ЧМ-2026: группы, плей-офф, бонусные вопросы, командный зачёт.", access: ACCESS.PROGNOSTISTA },
];
// Legacy тарифы — только для старых заявок в админке
const LEGACY_PLANS = [
  { id: "friend",  label: "С другом (legacy)",               price: 800 },
  { id: "full",    label: "Битва прогнозистов+Лига (legacy)",  price: 800 },
  { id: "ffc_add", label: "Битва клубов доп. (legacy)",     price: 300 },
];

const PAYMENT_INFO = {
  card: "2200 0000 0000 0000",
  name: "Организатор ФФК",
  phone: "+7 (___) ___-__-__",
  comment: "ФФК ЧМ-2026 + ваше имя",
};

// ── FIFA RANKING (апрель 2026) ──
const FIFA_RANKINGS = {
  updatedAt: "2026-04-01",
  rankings: {
    "Франция": 2, "Испания": 3, "Аргентина": 1, "Англия": 4,
    "Бразилия": 5, "Португалия": 6, "Нидерланды": 7, "Германия": 12,
    "Бельгия": 9, "Хорватия": 10, "Уругвай": 20, "Мексика": 14,
    "США": 11, "Япония": 15, "Марокко": 13, "Сенегал": 18,
    "Колумбия": 17, "Австрия": 22, "Дания": 21, "Швейцария": 19,
    "Канада": 40, "Эквадор": 35, "Норвегия": 25, "Австралия": 23,
    "Турция": 28, "Иран": 24, "Египет": 33, "Корея": 26,
    "Парагвай": 45, "Алжир": 30, "Катар": 55, "ЮАР": 60,
    "Кот-д'Ивуар": 50, "Гана": 58, "Тунис": 32, "Швеция": 27,
    "Узбекистан": 65, "Сауд.Аравия": 54, "Ирак": 62, "Иордания": 70,
    "Нов.Зеландия": 90, "Кюрасао": 98, "Гаити": 95, "Панама": 75,
    "Шотландия": 38, "Кабо-Верде": 85, "Босния": 56, "Чехия": 37,
    "ДР Конго": 88,
  },
};

function getFifaRank(team) {
  return FIFA_RANKINGS.rankings[team] || 999;
}

// ── FAIR PLAY ──
// teamDiscipline: { "Команда": { yellow, secondYellowRed, directRed, yellowAndDirectRed } }
// TODO: admin can update these values
const DEFAULT_DISCIPLINE = {};

function calcFairPlay(team, discipline) {
  const d = (discipline || {})[team] || {};
  return (
    (d.yellow || 0) * -1 +
    (d.secondYellowRed || 0) * -3 +
    (d.directRed || 0) * -4 +
    (d.yellowAndDirectRed || 0) * -5
  );
}

// ── ГРУППЫ ──
const GROUPS = {
  A: ["Мексика", "Корея", "ЮАР", "Чехия"],
  B: ["Канада", "Швейцария", "Катар", "Босния"],
  C: ["Бразилия", "Марокко", "Гаити", "Шотландия"],
  D: ["США", "Парагвай", "Австралия", "Турция"],
  E: ["Германия", "Эквадор", "Кот-д'Ивуар", "Кюрасао"],
  F: ["Нидерланды", "Япония", "Тунис", "Швеция"],
  G: ["Бельгия", "Египет", "Иран", "Нов.Зеландия"],
  H: ["Испания", "Уругвай", "Сауд.Аравия", "Кабо-Верде"],
  I: ["Франция", "Сенегал", "Норвегия", "Ирак"],
  J: ["Аргентина", "Австрия", "Алжир", "Иордания"],
  K: ["Португалия", "Колумбия", "Узбекистан", "ДР Конго"],
  L: ["Англия", "Хорватия", "Панама", "Гана"],
};
const ALL_GROUPS = Object.keys(GROUPS);

// ── РАСПИСАНИЕ МАТЧЕЙ (kickoff_at в UTC) ──
// TODO: заменить на реальные kickoff_at для каждого матча
const KICKOFF_BASE = "2026-06-11T18:00:00Z"; // заглушка — старт первого матча

const GROUP_MATCHES = {};
ALL_GROUPS.forEach((g) => {
  const [a, b, c, d] = GROUPS[g];
  GROUP_MATCHES[g] = [
    { id: `${g}1`, home: a, away: b, kickoff_at: KICKOFF_BASE },
    { id: `${g}2`, home: c, away: d, kickoff_at: KICKOFF_BASE },
    { id: `${g}3`, home: a, away: c, kickoff_at: KICKOFF_BASE },
    { id: `${g}4`, home: b, away: d, kickoff_at: KICKOFF_BASE },
    { id: `${g}5`, home: a, away: d, kickoff_at: KICKOFF_BASE },
    { id: `${g}6`, home: b, away: c, kickoff_at: KICKOFF_BASE },
  ];
});

// All group matches flat
const ALL_GROUP_MATCH_IDS = new Set(
  ALL_GROUPS.flatMap((g) => GROUP_MATCHES[g].map((m) => m.id))
);

// Будет заполнен после объявления R16/R8/QF/SF/THIRD_MATCH/FINAL_MATCH
// (используется в loadMyData и syncDB через замыкание)
const ALL_PLAYOFF_MATCH_IDS = new Set([
  "m73","m74","m75","m76","m77","m78","m79","m80",
  "m81","m82","m83","m84","m85","m86","m87","m88",
  "m89","m90","m91","m92","m93","m94","m95","m96",
  "m97","m98","m99","m100",
  "m101","m102","m103","m104",
]);

// ── СЕГОДНЯ ИГРАЮТ (МСК) ──
function getMoscowDateKey(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function getTodayMatches() {
  const todayKey = getMoscowDateKey(new Date());
  const result = [];
  ALL_GROUPS.forEach((g) => {
    GROUP_MATCHES[g].forEach((m) => {
      if (!m.kickoff_at) return;
      const dt = new Date(m.kickoff_at);
      const mKey = getMoscowDateKey(dt);
      if (mKey === todayKey) {
        const time = new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit",
        }).format(dt);
        result.push({ ...m, group: g, timeMsk: time, dtObj: dt });
      }
    });
  });
  result.sort((a, b) => a.dtObj - b.dtObj);
  return result;
}

// ── 1/16 СЕТКА FIFA ──
const R16 = [
  { id: "m73", label: "Матч №73", date: "28 июня", city: "Инглвуд", home_key: "2A", away_key: "2B" },
  { id: "m74", label: "Матч №74", date: "29 июня", city: "Фоксборо", home_key: "1E", away_key: "3ABCDF" },
  { id: "m75", label: "Матч №75", date: "29 июня", city: "Монтеррей", home_key: "1F", away_key: "2C" },
  { id: "m76", label: "Матч №76", date: "29 июня", city: "Хьюстон", home_key: "1C", away_key: "2F" },
  { id: "m77", label: "Матч №77", date: "30 июня", city: "Ист-Ратерфорд", home_key: "1I", away_key: "3CDFGH" },
  { id: "m78", label: "Матч №78", date: "30 июня", city: "Даллас", home_key: "2E", away_key: "2I" },
  { id: "m79", label: "Матч №79", date: "30 июня", city: "Мехико", home_key: "1A", away_key: "3CEFHI" },
  { id: "m80", label: "Матч №80", date: "1 июля", city: "Атланта", home_key: "1L", away_key: "3EHIJK" },
  { id: "m81", label: "Матч №81", date: "1 июля", city: "Санта-Клара", home_key: "1D", away_key: "3BEFIJ" },
  { id: "m82", label: "Матч №82", date: "1 июля", city: "Сиэтл", home_key: "1G", away_key: "3AEHIJ" },
  { id: "m83", label: "Матч №83", date: "2 июля", city: "Торонто", home_key: "2K", away_key: "2L" },
  { id: "m84", label: "Матч №84", date: "2 июля", city: "Арлингтон", home_key: "1H", away_key: "2J" },
  { id: "m85", label: "Матч №85", date: "2 июля", city: "Ванкувер", home_key: "1B", away_key: "3EFGIJ" },
  { id: "m86", label: "Матч №86", date: "3 июля", city: "Майами", home_key: "1J", away_key: "2H" },
  { id: "m87", label: "Матч №87", date: "3 июля", city: "Канзас-Сити", home_key: "1K", away_key: "3DEIJL" },
  { id: "m88", label: "Матч №88", date: "3 июля", city: "Даллас", home_key: "2D", away_key: "2G" },
];

const R8 = [
  { id: "m89", label: "Матч №89", date: "4 июля", city: "Филадельфия", home_from: "m74", away_from: "m77" },
  { id: "m90", label: "Матч №90", date: "4 июля", city: "Хьюстон", home_from: "m73", away_from: "m75" },
  { id: "m91", label: "Матч №91", date: "5 июля", city: "Ист-Ратерфорд", home_from: "m76", away_from: "m78" },
  { id: "m92", label: "Матч №92", date: "5 июля", city: "Мехико", home_from: "m79", away_from: "m80" },
  { id: "m93", label: "Матч №93", date: "6 июля", city: "Даллас", home_from: "m83", away_from: "m84" },
  { id: "m94", label: "Матч №94", date: "6 июля", city: "Сиэтл", home_from: "m81", away_from: "m82" },
  { id: "m95", label: "Матч №95", date: "7 июля", city: "Атланта", home_from: "m86", away_from: "m88" },
  { id: "m96", label: "Матч №96", date: "7 июля", city: "Ванкувер", home_from: "m85", away_from: "m87" },
];

const QF = [
  { id: "m97", label: "Матч №97", date: "9 июля", city: "Фоксборо", home_from: "m89", away_from: "m90" },
  { id: "m98", label: "Матч №98", date: "10 июля", city: "Инглвуд", home_from: "m93", away_from: "m94" },
  { id: "m99", label: "Матч №99", date: "11 июля", city: "Майами", home_from: "m91", away_from: "m92" },
  { id: "m100", label: "Матч №100", date: "11 июля", city: "Канзас-Сити", home_from: "m95", away_from: "m96" },
];

const SF = [
  { id: "m101", label: "Полуфинал 1", date: "14 июля", city: "Арлингтон", home_from: "m97", away_from: "m98" },
  { id: "m102", label: "Полуфинал 2", date: "15 июля", city: "Атланта", home_from: "m99", away_from: "m100" },
];
const THIRD_MATCH = { id: "m103", label: "За 3-е место", date: "18 июля", city: "Майами", home_from: "m101_loser", away_from: "m102_loser" };
const FINAL_MATCH = { id: "m104", label: "Финал", date: "19 июля", city: "Ист-Ратерфорд", home_from: "m101", away_from: "m102" };

// ── THIRD PLACE MAPPING — все 495 комбинаций FIFA ──
// Источник: Wikipedia/2026_FIFA_World_Cup_knockout_stage
// Ключ: 8 прошедших групп в алфавитном порядке. Значение: matchId → "3X" (группа третьего места)
// Слоты: m79=1A, m85=1B, m81=1D, m74=1E, m82=1G, m77=1I, m87=1K, m80=1L
const THIRD_PLACE_MAPPING = {
  "ABCDEFGH":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDEFGI":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3I"},
  "ABCDEFGJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3J"},
  "ABCDEFGK":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDEFGL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3E"},
  "ABCDEFHI":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3I",m80:"3H"},
  "ABCDEFHJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3H"},
  "ABCDEFHK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDEFHL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDEFIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3I",m80:"3J"},
  "ABCDEFIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3I",m80:"3K"},
  "ABCDEFIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3I"},
  "ABCDEFJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3K"},
  "ABCDEFJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDEFKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDEGHI":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDEGHJ":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDEGHK":{m79:"3E",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDEGHL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDEGIJ":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3J"},
  "ABCDEGIK":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDEGIL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3I"},
  "ABCDEGJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDEGJL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDEGKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDEHIJ":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3H"},
  "ABCDEHIK":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDEHIL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDEHJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDEHJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDEHKL":{m79:"3C",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABCDEIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3K"},
  "ABCDEIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDEIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDEJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDFGHI":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDFGHJ":{m79:"3F",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDFGHK":{m79:"3F",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDFGHL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDFGIJ":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3J"},
  "ABCDFGIK":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDFGIL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3I"},
  "ABCDFGJK":{m79:"3F",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDFGJL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDFGKL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDFHIJ":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3H"},
  "ABCDFHIK":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDFHIL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDFHJK":{m79:"3F",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDFHJL":{m79:"3F",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDFHKL":{m79:"3C",m85:"3F",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABCDFIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3K"},
  "ABCDFIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDFIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDFJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDGHIJ":{m79:"3I",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ABCDGHIK":{m79:"3I",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDGHIL":{m79:"3I",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDGHJK":{m79:"3C",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDGHJL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCDGHKL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABCDGIJK":{m79:"3I",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ABCDGIJL":{m79:"3I",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ABCDGIKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDGJKL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCDHIJK":{m79:"3I",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ABCDHIJL":{m79:"3I",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ABCDHIKL":{m79:"3H",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDHJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCDIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEFGHI":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3I",m80:"3H"},
  "ABCEFGHJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABCEFGHK":{m79:"3F",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3E",m80:"3K"},
  "ABCEFGHL":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCEFGIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3I",m80:"3J"},
  "ABCEFGIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3I",m80:"3K"},
  "ABCEFGIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3I"},
  "ABCEFGJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABCEFGJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABCEFGKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCEFHIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3C",m87:"3J",m80:"3H"},
  "ABCEFHIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3I",m80:"3K"},
  "ABCEFHIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3C",m87:"3L",m80:"3H"},
  "ABCEFHJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCEFHJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3J"},
  "ABCEFHKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEFIJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3C",m87:"3J",m80:"3K"},
  "ABCEFIJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3C",m87:"3L",m80:"3J"},
  "ABCEFIKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEFJKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEGHIJ":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABCEGHIK":{m79:"3E",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3I",m80:"3K"},
  "ABCEGHIL":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCEGHJK":{m79:"3E",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCEGHJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCEGHKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEGIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABCEGIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABCEGIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCEGJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCEHIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCEHIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3J"},
  "ABCEHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCEIJKL":{m79:"3I",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3C",m87:"3L",m80:"3K"},
  "ABCFGHIJ":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABCFGHIK":{m79:"3F",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3I",m80:"3K"},
  "ABCFGHIL":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCFGHJK":{m79:"3F",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCFGHJL":{m79:"3F",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCFGHKL":{m79:"3F",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCFGIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABCFGIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABCFGIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCFGJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCFHIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCFHIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3J"},
  "ABCFHIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCFHJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCFIJKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3J",m77:"3C",m87:"3L",m80:"3K"},
  "ABCGHIJK":{m79:"3I",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ABCGHIJL":{m79:"3I",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABCGHIKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABCGHJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCGIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABCHIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ABDEFGHI":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3I",m80:"3H"},
  "ABDEFGHJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABDEFGHK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDEFGHL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDEFGIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3I",m80:"3J"},
  "ABDEFGIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3I",m80:"3K"},
  "ABDEFGIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3I"},
  "ABDEFGJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABDEFGJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABDEFGKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDEFHIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3I",m80:"3J"},
  "ABDEFHIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3I",m80:"3K"},
  "ABDEFHIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3I"},
  "ABDEFHJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3J",m80:"3K"},
  "ABDEFHJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3J"},
  "ABDEFHKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDEFIJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3D",m87:"3J",m80:"3K"},
  "ABDEFIJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3D",m87:"3L",m80:"3J"},
  "ABDEFIKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3D",m87:"3L",m80:"3K"},
  "ABDEFJKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "ABDEGHIJ":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABDEGHIK":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDEGHIL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDEGHJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDEGHJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDEGHKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDEGIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABDEGIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABDEGIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDEGJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDEHIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3J",m80:"3K"},
  "ABDEHIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3J"},
  "ABDEHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDEHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDEIJKL":{m79:"3I",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "ABDFGHIJ":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ABDFGHIK":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDFGHIL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDFGHJK":{m79:"3F",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDFGHJL":{m79:"3F",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDFGHKL":{m79:"3F",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDFGIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ABDFGIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ABDFGIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDFGJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDFHIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3J",m80:"3K"},
  "ABDFHIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3J"},
  "ABDFHIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDFHJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDFIJKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "ABDGHIJK":{m79:"3I",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ABDGHIJL":{m79:"3I",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ABDGHIKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABDGHJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDGIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ABDHIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ABEFGHIJ":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3G",m87:"3J",m80:"3H"},
  "ABEFGHIK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3I",m80:"3K"},
  "ABEFGHIL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3G",m87:"3L",m80:"3H"},
  "ABEFGHJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3J",m80:"3K"},
  "ABEFGHJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3J"},
  "ABEFGHKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ABEFGIJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3G",m87:"3J",m80:"3K"},
  "ABEFGIJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3G",m87:"3L",m80:"3J"},
  "ABEFGIKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "ABEFGJKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3G",m87:"3L",m80:"3K"},
  "ABEFHIJK":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3H",m87:"3J",m80:"3K"},
  "ABEFHIJL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3H",m87:"3L",m80:"3J"},
  "ABEFHIKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "ABEFHJKL":{m79:"3F",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3H",m87:"3L",m80:"3K"},
  "ABEFIJKL":{m79:"3I",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "ABEGHIJK":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3J",m80:"3K"},
  "ABEGHIJL":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3J"},
  "ABEGHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ABEGHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ABEGIJKL":{m79:"3I",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3G",m87:"3L",m80:"3K"},
  "ABEHIJKL":{m79:"3I",m85:"3E",m81:"3B",m74:"3A",m82:"3J",m77:"3H",m87:"3L",m80:"3K"},
  "ABFGHIJK":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3J",m80:"3K"},
  "ABFGHIJL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3J"},
  "ABFGHIKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ABFGHJKL":{m79:"3F",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ABFGIJKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3J",m77:"3G",m87:"3L",m80:"3K"},
  "ABFHIJKL":{m79:"3F",m85:"3I",m81:"3B",m74:"3A",m82:"3J",m77:"3H",m87:"3L",m80:"3K"},
  "ABGHIJKL":{m79:"3I",m85:"3J",m81:"3B",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "ACDEFGHI":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ACDEFGHJ":{m79:"3F",m85:"3E",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ACDEFGHK":{m79:"3F",m85:"3G",m81:"3E",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEFGHL":{m79:"3F",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEFGIJ":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3J"},
  "ACDEFGIK":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ACDEFGIL":{m79:"3F",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3I"},
  "ACDEFGJK":{m79:"3F",m85:"3E",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ACDEFGJL":{m79:"3F",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ACDEFGKL":{m79:"3F",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEFHIJ":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3H"},
  "ACDEFHIK":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEFHIL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEFHJK":{m79:"3F",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEFHJL":{m79:"3F",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEFHKL":{m79:"3C",m85:"3F",m81:"3E",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ACDEFIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3J",m80:"3K"},
  "ACDEFIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ACDEFIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEFJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEGHIJ":{m79:"3E",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ACDEGHIK":{m79:"3E",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEGHIL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEGHJK":{m79:"3E",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEGHJL":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEGHKL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ACDEGIJK":{m79:"3E",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ACDEGIJL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ACDEGIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEGJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEHIJK":{m79:"3E",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDEHIJL":{m79:"3E",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDEHIKL":{m79:"3H",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEHJKL":{m79:"3H",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDEIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDFGHIJ":{m79:"3F",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3H"},
  "ACDFGHIK":{m79:"3F",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDFGHIL":{m79:"3F",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDFGHJK":{m79:"3F",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDFGHJL":{m79:"3F",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDFGHKL":{m79:"3C",m85:"3G",m81:"3F",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ACDFGIJK":{m79:"3F",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3D",m80:"3K"},
  "ACDFGIJL":{m79:"3F",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3J"},
  "ACDFGIKL":{m79:"3F",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDFGJKL":{m79:"3F",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDFHIJK":{m79:"3F",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDFHIJL":{m79:"3F",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDFHIKL":{m79:"3H",m85:"3F",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDFHJKL":{m79:"3H",m85:"3F",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDFIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDGHIJK":{m79:"3I",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3D",m80:"3K"},
  "ACDGHIJL":{m79:"3I",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3H"},
  "ACDGHIKL":{m79:"3H",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDGHJKL":{m79:"3H",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDGIJKL":{m79:"3I",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACDHIJKL":{m79:"3H",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3C",m87:"3L",m80:"3K"},
  "ACEFGHIJ":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ACEFGHIK":{m79:"3F",m85:"3G",m81:"3E",m74:"3A",m82:"3H",m77:"3C",m87:"3I",m80:"3K"},
  "ACEFGHIL":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ACEFGHJK":{m79:"3F",m85:"3G",m81:"3E",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ACEFGHJL":{m79:"3F",m85:"3E",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ACEFGHKL":{m79:"3F",m85:"3G",m81:"3E",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACEFGIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ACEFGIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ACEFGIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ACEFGJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ACEFHIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ACEFHIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3J"},
  "ACEFHIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACEFHJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACEFIJKL":{m79:"3F",m85:"3I",m81:"3E",m74:"3A",m82:"3J",m77:"3C",m87:"3L",m80:"3K"},
  "ACEGHIJK":{m79:"3E",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ACEGHIJL":{m79:"3E",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ACEGHIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACEGHJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACEGIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ACEHIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACFGHIJK":{m79:"3F",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3J",m80:"3K"},
  "ACFGHIJL":{m79:"3F",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ACFGHIKL":{m79:"3F",m85:"3G",m81:"3I",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACFGHJKL":{m79:"3F",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACFGIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3C",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ACFHIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ACGHIJKL":{m79:"3I",m85:"3G",m81:"3J",m74:"3A",m82:"3H",m77:"3C",m87:"3L",m80:"3K"},
  "ADEFGHIJ":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3H"},
  "ADEFGHIK":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ADEFGHIL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ADEFGHJK":{m79:"3F",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ADEFGHJL":{m79:"3F",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ADEFGHKL":{m79:"3F",m85:"3G",m81:"3E",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADEFGIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3G",m87:"3J",m80:"3K"},
  "ADEFGIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3J"},
  "ADEFGIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ADEFGJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ADEFHIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3H",m87:"3J",m80:"3K"},
  "ADEFHIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3J"},
  "ADEFHIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADEFHJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADEFIJKL":{m79:"3F",m85:"3I",m81:"3E",m74:"3A",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "ADEGHIJK":{m79:"3E",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ADEGHIJL":{m79:"3E",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ADEGHIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADEGHJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADEGIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ADEHIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADFGHIJK":{m79:"3F",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3D",m80:"3K"},
  "ADFGHIJL":{m79:"3F",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3H"},
  "ADFGHIKL":{m79:"3F",m85:"3G",m81:"3I",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADFGHJKL":{m79:"3F",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADFGIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3G",m87:"3L",m80:"3K"},
  "ADFHIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "ADGHIJKL":{m79:"3I",m85:"3G",m81:"3J",m74:"3D",m82:"3A",m77:"3H",m87:"3L",m80:"3K"},
  "AEFGHIJK":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3G",m87:"3J",m80:"3K"},
  "AEFGHIJL":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3J"},
  "AEFGHIKL":{m79:"3F",m85:"3E",m81:"3I",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "AEFGHJKL":{m79:"3F",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "AEFGIJKL":{m79:"3F",m85:"3I",m81:"3E",m74:"3A",m82:"3J",m77:"3G",m87:"3L",m80:"3K"},
  "AEFHIJKL":{m79:"3F",m85:"3I",m81:"3E",m74:"3A",m82:"3J",m77:"3H",m87:"3L",m80:"3K"},
  "AEGHIJKL":{m79:"3I",m85:"3E",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "AFGHIJKL":{m79:"3F",m85:"3I",m81:"3J",m74:"3A",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "BCDEFGHI":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3F",m87:"3D",m80:"3E"},
  "BCDEFGHJ":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3D",m80:"3E"},
  "BCDEFGHK":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3E",m80:"3K"},
  "BCDEFGHL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3E"},
  "BCDEFGIJ":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3E",m80:"3I"},
  "BCDEFGIK":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3I",m80:"3K"},
  "BCDEFGIL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3L",m80:"3I"},
  "BCDEFGJK":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3E",m80:"3K"},
  "BCDEFGJL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3E"},
  "BCDEFGKL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3L",m80:"3K"},
  "BCDEFHIJ":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3E",m80:"3I"},
  "BCDEFHIK":{m79:"3C",m85:"3E",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BCDEFHIL":{m79:"3C",m85:"3E",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BCDEFHJK":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3E",m80:"3K"},
  "BCDEFHJL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3E"},
  "BCDEFHKL":{m79:"3C",m85:"3E",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCDEFIJK":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3I",m80:"3K"},
  "BCDEFIJL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3L",m80:"3I"},
  "BCDEFIKL":{m79:"3C",m85:"3E",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCDEFJKL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3E",m77:"3F",m87:"3L",m80:"3K"},
  "BCDEGHIJ":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3E",m80:"3I"},
  "BCDEGHIK":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3I",m80:"3K"},
  "BCDEGHIL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3I"},
  "BCDEGHJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3E",m80:"3K"},
  "BCDEGHJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3E"},
  "BCDEGHKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "BCDEGIJK":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3I",m80:"3K"},
  "BCDEGIJL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3I"},
  "BCDEGIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3D",m87:"3L",m80:"3K"},
  "BCDEGJKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "BCDEHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3I",m80:"3K"},
  "BCDEHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3I"},
  "BCDEHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "BCDEHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "BCDEIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3D",m87:"3L",m80:"3K"},
  "BCDFGHIJ":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3D",m80:"3I"},
  "BCDFGHIK":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BCDFGHIL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BCDFGHJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3D",m80:"3K"},
  "BCDFGHJL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3J"},
  "BCDFGHKL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCDFGIJK":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "BCDFGIJL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "BCDFGIKL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCDFGJKL":{m79:"3C",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BCDFHIJK":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BCDFHIJL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BCDFHIKL":{m79:"3C",m85:"3I",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCDFHJKL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCDFIJKL":{m79:"3C",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCDGHIJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3I",m80:"3K"},
  "BCDGHIJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3I"},
  "BCDGHIKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3D",m87:"3L",m80:"3K"},
  "BCDGHJKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "BCDGIJKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "BCDHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3D",m87:"3L",m80:"3K"},
  "BCEFGHIJ":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3E",m80:"3I"},
  "BCEFGHIK":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BCEFGHIL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BCEFGHJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3E",m80:"3K"},
  "BCEFGHJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3E"},
  "BCEFGHKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCEFGIJK":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "BCEFGIJL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "BCEFGIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCEFGJKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BCEFHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BCEFHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BCEFHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCEFHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BCEFIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCEGHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3G",m87:"3I",m80:"3K"},
  "BCEGHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3G",m87:"3L",m80:"3I"},
  "BCEGHIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BCEGHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "BCEGIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "BCEHIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BCFGHIJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "BCFGHIJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "BCFGHIKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCFGHJKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BCFGIJKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BCFHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BCGHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3C",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "BDEFGHIJ":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3E",m80:"3I"},
  "BDEFGHIK":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BDEFGHIL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BDEFGHJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3E",m80:"3K"},
  "BDEFGHJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3E"},
  "BDEFGHKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BDEFGIJK":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "BDEFGIJL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "BDEFGIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BDEFGJKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BDEFHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "BDEFHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "BDEFHIKL":{m79:"3E",m85:"3I",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BDEFHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "BDEFIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BDEGHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3G",m87:"3I",m80:"3K"},
  "BDEGHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3G",m87:"3L",m80:"3I"},
  "BDEGHIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3D",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BDEGHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "BDEGIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "BDEHIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BDFGHIJK":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "BDFGHIJL":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "BDFGHIKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BDFGHJKL":{m79:"3H",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BDFGIJKL":{m79:"3I",m85:"3G",m81:"3B",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "BDFHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "BDGHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3D",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "BEFGHIJK":{m79:"3E",m85:"3J",m81:"3B",m74:"3F",m82:"3H",m77:"3G",m87:"3I",m80:"3K"},
  "BEFGHIJL":{m79:"3E",m85:"3J",m81:"3B",m74:"3F",m82:"3H",m77:"3G",m87:"3L",m80:"3I"},
  "BEFGHIKL":{m79:"3E",m85:"3G",m81:"3B",m74:"3F",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BEFGHJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3F",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "BEFGIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3F",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "BEFHIJKL":{m79:"3E",m85:"3J",m81:"3B",m74:"3F",m82:"3I",m77:"3H",m87:"3L",m80:"3K"},
  "BEGHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3B",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "BFGHIJKL":{m79:"3H",m85:"3J",m81:"3B",m74:"3F",m82:"3I",m77:"3G",m87:"3L",m80:"3K"},
  "CDEFGHIJ":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3E",m80:"3I"},
  "CDEFGHIK":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "CDEFGHIL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "CDEFGHJK":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3E",m80:"3K"},
  "CDEFGHJL":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3E"},
  "CDEFGHKL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDEFGIJK":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3J",m77:"3F",m87:"3I",m80:"3K"},
  "CDEFGIJL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3I"},
  "CDEFGIKL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "CDEFGJKL":{m79:"3C",m85:"3G",m81:"3E",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "CDEFHIJK":{m79:"3C",m85:"3J",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "CDEFHIJL":{m79:"3C",m85:"3J",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "CDEFHIKL":{m79:"3C",m85:"3E",m81:"3I",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDEFHJKL":{m79:"3C",m85:"3J",m81:"3E",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDEFIJKL":{m79:"3C",m85:"3J",m81:"3E",m74:"3D",m82:"3I",m77:"3F",m87:"3L",m80:"3K"},
  "CDEGHIJK":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3D",m87:"3I",m80:"3K"},
  "CDEGHIJL":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3I"},
  "CDEGHIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "CDEGHJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "CDEGIJKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "CDEHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3C",m82:"3H",m77:"3D",m87:"3L",m80:"3K"},
  "CDFGHIJK":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "CDFGHIJL":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "CDFGHIKL":{m79:"3C",m85:"3G",m81:"3I",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDFGHJKL":{m79:"3C",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDFGIJKL":{m79:"3C",m85:"3G",m81:"3I",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "CDFHIJKL":{m79:"3C",m85:"3J",m81:"3I",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CDGHIJKL":{m79:"3H",m85:"3G",m81:"3I",m74:"3C",m82:"3J",m77:"3D",m87:"3L",m80:"3K"},
  "CEFGHIJK":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "CEFGHIJL":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "CEFGHIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CEFGHJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CEFGIJKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "CEFHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3C",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "CEGHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3C",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "CFGHIJKL":{m79:"3H",m85:"3G",m81:"3I",m74:"3C",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "DEFGHIJK":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3I",m80:"3K"},
  "DEFGHIJL":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3I"},
  "DEFGHIKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "DEFGHJKL":{m79:"3E",m85:"3G",m81:"3J",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "DEFGIJKL":{m79:"3E",m85:"3G",m81:"3I",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "DEFHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3D",m82:"3H",m77:"3F",m87:"3L",m80:"3K"},
  "DEGHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3D",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
  "DFGHIJKL":{m79:"3H",m85:"3G",m81:"3I",m74:"3D",m82:"3J",m77:"3F",m87:"3L",m80:"3K"},
  "EFGHIJKL":{m79:"3E",m85:"3J",m81:"3I",m74:"3F",m82:"3H",m77:"3G",m87:"3L",m80:"3K"},
};

function getThirdPlaceKey(thirdRanking) {
  return thirdRanking.slice(0, 8).map((x) => x.group).sort().join("");
}

function getThirdPlaceMapping(thirdRanking) {
  const key = getThirdPlaceKey(thirdRanking);
  return THIRD_PLACE_MAPPING[key] || null;
}

// ── ОЧКИ ──
function calculateMatchPredictionPoints(ph, pa, rh, ra) {
  if ([ph, pa, rh, ra].some(v => v === "" || v === null || v === undefined || Number.isNaN(+v))) return null;
  ph = +ph; pa = +pa; rh = +rh; ra = +ra;

  const outcome = (h, a) => h > a ? "home" : h < a ? "away" : "draw";
  const predOutcome = outcome(ph, pa);
  const realOutcome = outcome(rh, ra);
  const sameOutcome = predOutcome === realOutcome;
  const oneTeamGoals = ph === rh || pa === ra;
  const sameDiff = (ph - pa) === (rh - ra);
  const exact = ph === rh && pa === ra;

  if (exact) {
    let pts = 8;
    if (Math.abs(rh - ra) >= 3) pts += 1;   // разгром
    if (rh + ra >= 5) pts += 1;              // голевой матч
    return pts;
  }
  if (sameOutcome && sameDiff) return 5;
  if (sameOutcome && oneTeamGoals) return 3;
  if (sameOutcome) return 2;
  if (oneTeamGoals) return 1;
  return 0;
}

// Алиас для обратной совместимости
const calcPts = calculateMatchPredictionPoints;

// Self-test в dev-режиме
if (typeof window !== "undefined") {
  const _tests = [
    [4,1,4,1,10],[3,2,3,2,9],[3,0,3,0,9],[2,1,2,1,8],
    [1,0,2,1,5],[2,0,2,1,3],[3,0,2,1,2],[0,1,2,1,1],[0,0,2,1,0],
  ];
  _tests.forEach(([ph,pa,rh,ra,exp]) => {
    const got = calculateMatchPredictionPoints(ph,pa,rh,ra);
    if (got !== exp) console.warn(`calcPts test FAIL: ${ph}:${pa} vs ${rh}:${ra} → got ${got}, expected ${exp}`);
  });
}

// ── ТАБЛИЦА ГРУППЫ (тай-брейки по регламенту FIFA 2026) ──
function calcGroupTable(g, scores, discipline) {
  const teams = GROUPS[g];
  const t = {};
  teams.forEach((tm) => { t[tm] = { pts: 0, gf: 0, ga: 0, gd: 0, played: 0, w: 0, d: 0, l: 0 }; });

  const matchResults = {};
  GROUP_MATCHES[g].forEach((m) => {
    const s = scores[m.id];
    if (!s || s.h === "" || s.h === undefined || s.a === "" || s.a === undefined) return;
    const h = +s.h, a = +s.a;
    matchResults[m.home + "_" + m.away] = { hg: h, ag: a };
    t[m.home].gf += h; t[m.home].ga += a; t[m.home].gd += h - a; t[m.home].played++;
    t[m.away].gf += a; t[m.away].ga += h; t[m.away].gd += a - h; t[m.away].played++;
    if (h > a) { t[m.home].pts += 3; t[m.home].w++; t[m.away].l++; }
    else if (h < a) { t[m.away].pts += 3; t[m.away].w++; t[m.home].l++; }
    else { t[m.home].pts += 1; t[m.away].pts += 1; t[m.home].d++; t[m.away].d++; }
  });

  function h2hStats(group) {
    const h = {};
    group.forEach((tm) => { h[tm] = { pts: 0, gf: 0, ga: 0, gd: 0 }; });
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const r = matchResults[a + "_" + b] || matchResults[b + "_" + a];
        if (!r) continue;
        const isAB = !!(matchResults[a + "_" + b]);
        const ag = isAB ? r.hg : r.ag, bg = isAB ? r.ag : r.hg;
        h[a].gf += ag; h[a].ga += bg; h[a].gd += ag - bg;
        h[b].gf += bg; h[b].ga += ag; h[b].gd += bg - ag;
        if (ag > bg) { h[a].pts += 3; } else if (ag < bg) { h[b].pts += 3; } else { h[a].pts += 1; h[b].pts += 1; }
      }
    }
    return h;
  }

  const rows = teams.map((tm) => ({ team: tm, group: g, ...t[tm] }));

  rows.sort((a, b) => {
    // 1. Очки
    if (b.pts !== a.pts) return b.pts - a.pts;
    // 2. Разница голов (общая)
    if (b.gd !== a.gd) return b.gd - a.gd;
    // 3. Забитые голы (общие)
    if (b.gf !== a.gf) return b.gf - a.gf;
    // 4-6. H2H — только среди команд, равных по pts И gd И gf
    const sameGroup = rows
      .filter((r) => r.pts === a.pts && r.gd === a.gd && r.gf === a.gf)
      .map((r) => r.team);
    if (sameGroup.length > 1 && sameGroup.length < teams.length) {
      const h = h2hStats(sameGroup);
      if (h[b.team] && h[a.team]) {
        if (h[b.team].pts !== h[a.team].pts) return h[b.team].pts - h[a.team].pts;
        if (h[b.team].gd !== h[a.team].gd) return h[b.team].gd - h[a.team].gd;
        if (h[b.team].gf !== h[a.team].gf) return h[b.team].gf - h[a.team].gf;
        // TODO: recursive tie-break for partially separated head-to-head groups
      }
    }
    // 7. Fair Play
    const fpA = calcFairPlay(a.team, discipline);
    const fpB = calcFairPlay(b.team, discipline);
    if (fpB !== fpA) return fpB - fpA;
    // 8. Жребий FIFA — TODO: manual admin resolution
    // console.warn("Полное равенство — по регламенту нужен жребий ФИФА. Порядок временный.");
    return a.team.localeCompare(b.team);
  });

  return rows;
}

// ── РЕЙТИНГ ТРЕТЬИХ МЕСТ ──
function getThirdRanking(allTables, discipline) {
  return ALL_GROUPS
    .map((g) => { const tbl = allTables[g]; const row = tbl && tbl[2]; return row ? { ...row, group: g } : null; })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd !== a.gd) return b.gd - a.gd;
      if (b.gf !== a.gf) return b.gf - a.gf;
      const fpA = calcFairPlay(a.team, discipline);
      const fpB = calcFairPlay(b.team, discipline);
      if (fpB !== fpA) return fpB - fpA;
      // FIFA Ranking: меньше = лучше
      const rA = getFifaRank(a.team);
      const rB = getFifaRank(b.team);
      if (rA !== rB) return rA - rB;
      return a.group.localeCompare(b.group);
    });
}

// ── ВАЛИДНЫЙ resolveKey (строгий — без fallback) ──
function resolveKey(key, allTables, thirdRanking, matchId) {
  if (!key || key === "?") return { team: "?", tbd: true };
  const pos = parseInt(key[0]);
  const rest = key.slice(1);

  if (pos === 1 || pos === 2) {
    const tbl = allTables[rest];
    const row = tbl && tbl[pos - 1];
    if (!row || row.played === 0) return { team: `${pos}-е гр.${rest}`, tbd: true };
    const incomplete = row.played < 3;
    return { team: row.team, tbd: false, incomplete, sourceSlot: key, groupId: rest, place: pos };
  }

  if (pos === 3) {
    const groupLetters = rest.split("");
    const label = `3-е из ${groupLetters.join("/")}`;

    if (matchId) {
      const mapping = getThirdPlaceMapping(thirdRanking);
      if (mapping && mapping[matchId]) {
        const resolvedKey = mapping[matchId]; // e.g. "3C"
        const groupId = resolvedKey[1];
        const tbl = allTables[groupId];
        const row = tbl && tbl[2]; // строго третье место

        if (row && row.played > 0) {
          // Проверка: команда должна быть именно на 3-м месте
          const actualPlace = (allTables[groupId] || []).findIndex((r) => r.team === row.team);
          if (actualPlace !== 2) {
            console.error(`Ошибка сетки: ${row.team} из слота ${resolvedKey} не является 3-м местом группы ${groupId} (фактически: ${actualPlace + 1}-е)`);
            return { team: label, tbd: true, placeholder: true };
          }
          const rank = thirdRanking.findIndex((x) => x.group === groupId);
          const qualifies = rank >= 0 && rank < 8;
          return { team: row.played >= 3 ? row.team : `3-е гр.${groupId}*`, tbd: row.played < 3, sourceSlot: resolvedKey, groupId, place: 3, qualifies };
        }
      }
    }
    return { team: label, tbd: true, placeholder: true };
  }
  return { team: "?", tbd: true };
}

// ── ПОБЕДИТЕЛЬ МАТЧА ПЛЕЙ-ОФФ ──
function getWinner(matchId, pScores, pPens) {
  const s = pScores[matchId];
  if (!s || s.h === "" || s.h === undefined || s.a === "" || s.a === undefined) return null;
  const h = +s.h, a = +s.a;
  if (h > a) return "home";
  if (h < a) return "away";
  const pen = pPens[matchId];
  if (pen === "1") return "home";
  if (pen === "2") return "away";
  return null;
}

// ── ВАЛИДАЦИЯ СЕТКИ 1/16 ──
function validateRoundOf32(r16Matches, allTables, thirdRanking) {
  const errors = [];
  const teams = [];
  const teamSources = {};
  const placeCount = { 1: 0, 2: 0, 3: 0, 4: 0 };

  r16Matches.forEach((m) => {
    const home = resolveKey(m.home_key, allTables, thirdRanking, m.id);
    const away = resolveKey(m.away_key, allTables, thirdRanking, m.id);

    [{ info: home, slot: m.home_key }, { info: away, slot: m.away_key }].forEach(({ info, slot }) => {
      if (!info.tbd && info.team !== "?") {
        // Дубли
        if (teamSources[info.team]) {
          errors.push(`Ошибка сетки: ${info.team} попал в плей-офф дважды (${teamSources[info.team]} и ${m.id}/${slot})`);
        }
        teamSources[info.team] = `${m.id}/${slot}`;
        teams.push(info.team);

        // Считаем по местам
        if (info.place) placeCount[info.place] = (placeCount[info.place] || 0) + 1;

        // Проверка соответствия слота и реального места
        if (info.place && info.groupId) {
          const realPlace = (allTables[info.groupId] || []).findIndex((r) => r.team === info.team);
          if (realPlace !== -1 && realPlace + 1 !== info.place) {
            errors.push(`Ошибка: ${info.team} пришёл из слота ${info.sourceSlot}, но в группе ${info.groupId} занимает ${realPlace + 1}-е место`);
          }
        }

        // Ни одна команда с 4-го места не должна попасть
        if (info.place === 4) {
          errors.push(`Ошибка: ${info.team} из группы ${info.groupId} (4-е место) попал в сетку плей-офф`);
        }
      }
    });
  });

  const uniqueTeams = new Set(teams);

  // Проверки количества команд (только если групповой этап полностью заполнен)
  const allGroupsFilled = Object.values(allTables).every((tbl) => tbl.every((r) => r.played >= 3));
  if (allGroupsFilled) {
    if (teams.length !== 32) {
      errors.push(`Ошибка: в сетке 1/16 ${teams.length} команд вместо 32`);
    }
    if (uniqueTeams.size !== teams.length) {
      errors.push(`Дубли команд в сетке: ${teams.length - uniqueTeams.size} повторений`);
    }
    if (placeCount[1] !== 12) {
      errors.push(`Ошибка: в сетке ${placeCount[1] || 0} победителей групп вместо 12`);
    }
    if (placeCount[2] !== 12) {
      errors.push(`Ошибка: в сетке ${placeCount[2] || 0} вторых мест вместо 12`);
    }
    if ((placeCount[3] || 0) !== 8) {
      errors.push(`Ошибка: в сетке ${placeCount[3] || 0} третьих мест вместо 8`);
    }
  } else if (uniqueTeams.size < teams.length) {
    // Дубли видны даже при незаполненных группах
    errors.push(`Дубли команд в сетке: ${teams.length - uniqueTeams.size} повторений`);
  }

  return errors;
}

// ── ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ──
function ini(n) { return (n || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase(); }
const AVC = [
  ["rgba(185,28,28,.2)", "#FCA5A5"], ["rgba(22,163,74,.2)", "#86EFAC"],
  ["rgba(245,158,11,.18)", "#FDE68A"], ["rgba(96,165,250,.18)", "#BFDBFE"],
  ["rgba(167,139,250,.18)", "#DDD6FE"], ["rgba(251,146,60,.18)", "#FED7AA"],
];
function avc(n) { return AVC[(n || "X").charCodeAt(0) % AVC.length]; }

// ── БОНУСНЫЕ ВОПРОСЫ ──
const POPULAR_SCORERS = ["Килиан Мбаппе","Эрлинг Хааланд","Винисиус Жр.","Лаутаро Мартинес","Джуд Беллингем","Гарри Кейн","Педри"];
const POPULAR_MVP = ["Килиан Мбаппе","Лионель Месси","Винисиус Жр.","Джуд Беллингем","Эрлинг Хааланд","Педри","Лаутаро Мартинес"];
const POPULAR_ASSIST = ["Лионель Месси","Кевин Де Брёйне","Бруну Фернандеш","Джуд Беллингем","Педри","Антуан Гризманн","Винисиус Жр."];
const POPULAR_TEAMS = ["Аргентина","Франция","Бразилия","Англия","Испания","Германия","Португалия"];
const POPULAR_WEAK = ["Гаити","Кюрасао","Кабо-Верде","Иордания","Узбекистан","Новая Зеландия","ЮАР"];

const BONUS_QS = [
  { id:"top_scorers",              answerType:"player_multi", count:3, pts:8, pts_breakdown:"8/5/3", text:"Топ-3 бомбардира чемпионата", popularOptions:POPULAR_SCORERS, help:"Выбери 3 игроков. Порядок не имеет значения. Очки: 8 за 1-е место, 5 за 2-е, 3 за 3-е." },
  { id:"mvp",                      answerType:"player",  pts:8,  text:"Лучший игрок турнира (MVP)", popularOptions:POPULAR_MVP },
  { id:"top_assistant",            answerType:"player",  pts:5,  text:"Лучший ассистент (больше всех голевых пасов)", popularOptions:POPULAR_ASSIST },
  { id:"best_young_player",        answerType:"player",  pts:5,  text:"Лучший молодой игрок турнира", popularOptions:POPULAR_SCORERS },
  { id:"least_goals_conceded_group", answerType:"team", pts:3,  text:"Команда, которая меньше всех пропустит на групповом этапе", popularOptions:POPULAR_TEAMS },
  { id:"most_goals_conceded_group",  answerType:"team", pts:3,  text:"Команда, которая больше всех пропустит на групповом этапе", popularOptions:POPULAR_WEAK },
  { id:"least_goals_scored_group",   answerType:"team", pts:3,  text:"Команда, которая меньше всех забьёт на групповом этапе", popularOptions:POPULAR_WEAK },
  { id:"most_goals_scored_group",    answerType:"team", pts:3,  text:"Команда, которая больше всех забьёт на групповом этапе", popularOptions:POPULAR_TEAMS },
  { id:"team_wins_all_group_matches",answerType:"team", pts:3,  text:"Команда, которая выиграет все 3 матча в группе", popularOptions:POPULAR_TEAMS },
  { id:"team_draws_all_group_matches",answerType:"team",pts:3,  text:"Команда, которая сыграет 3 ничьи в группе", popularOptions:[...POPULAR_TEAMS] },
  { id:"team_zero_points_group",     answerType:"team", pts:3,  text:"Команда, которая не наберёт ни 1 очка в группе", popularOptions:POPULAR_WEAK },
  { id:"most_common_group_score",    answerType:"score", pts:3, text:"Самый частый счёт на групповом этапе", placeholder:"например, 2:1" },
  { id:"penalty_shootout_count",     answerType:"number",pts:3, text:"Сколько раз за весь чемпионат будет серия пенальти?", help:"Серии пенальти бывают только в плей-офф." },
  { id:"total_goals_full_tens",      answerType:"number",pts:3, text:"Сколько полных десятков голов будет забито за весь чемпионат?", help:"Например, 105 голов → ответ 10, 63 → ответ 6." },
  { id:"team_no_loss_regular_time",  answerType:"team", pts:3,  text:"Команда, которая ни разу не проиграет в игровое время", popularOptions:POPULAR_TEAMS, help:"Поражение по пенальти не считается." },
  { id:"team_wins_extra_time",       answerType:"team", pts:3,  text:"Команда, которая победит в дополнительное время", popularOptions:POPULAR_TEAMS },
  { id:"team_plays_shootout",        answerType:"team", pts:3,  text:"Команда, которая будет бить послематчевые пенальти", popularOptions:POPULAR_TEAMS },
  { id:"team_scores_first_5_min",    answerType:"team", pts:3,  text:"Команда, которая забьёт гол в первые 5 минут", popularOptions:POPULAR_TEAMS },
  { id:"player_scores_header",       answerType:"player",pts:3, text:"Игрок, который забьёт гол головой", popularOptions:POPULAR_SCORERS },
  { id:"player_scores_as_sub",       answerType:"player",pts:3, text:"Игрок, который забьёт, выйдя на замену", popularOptions:POPULAR_SCORERS },
  { id:"player_scores_free_kick",    answerType:"player",pts:3, text:"Игрок, который забьёт со штрафного", popularOptions:[...POPULAR_ASSIST] },
  { id:"goalkeeper_saves_penalty",   answerType:"player",pts:3, text:"Вратарь, который отразит пенальти", popularOptions:["Тибо Куртуа","Эмилиано Мартинес","Дамир Ливакович","Яссин Буну","Джордан Пикфорд","Мэтт Тёрнер","Диого Кошта"] },
  { id:"player_misses_penalty",      answerType:"player",pts:3, text:"Игрок, который не забьёт пенальти", popularOptions:POPULAR_SCORERS },
  { id:"player_scores_own_goal",     answerType:"player",pts:5, text:"Игрок, который забьёт в свои ворота", popularOptions:POPULAR_SCORERS },
  { id:"player_gets_yellow_card",    answerType:"player",pts:3, text:"Игрок, который получит жёлтую карточку", popularOptions:POPULAR_SCORERS },
  { id:"player_sent_off",            answerType:"player",pts:5, text:"Игрок, который будет удалён", popularOptions:POPULAR_SCORERS },
  { id:"player_scores_hat_trick",    answerType:"player",pts:5, text:"Игрок, который сделает хет-трик", popularOptions:POPULAR_SCORERS },
  { id:"top_scorer_goal_count",      answerType:"number",pts:3, text:"Число голов, забитых лучшим бомбардиром" },
  { id:"max_goals_in_one_match",     answerType:"number",pts:3, text:"Максимальное количество голов в 1 матче", help:"Голы в серии пенальти не считаются." },
  { id:"final_match_score",          answerType:"score", pts:3, text:"Счёт финального матча", placeholder:"например, 2:1" },
];

// ── CSS ──
const S = `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=Barlow+Condensed:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0A1208}
.app{font-family:'Barlow Condensed',sans-serif;background:#0A1208;min-height:100vh;color:#F0EDE6}
.hdr{background:#060E05;border-bottom:3px solid #B91C1C;position:sticky;top:0;z-index:50}
.hdr-in{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:8px 16px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px;flex-shrink:0;cursor:default}
.la{font-family:'Oswald',sans-serif;font-size:17px;font-weight:700;color:#F59E0B;letter-spacing:1px}
.lb{font-size:10px;color:rgba(240,237,230,.35);letter-spacing:1.5px}
.nav{display:flex;gap:2px;flex:1;flex-wrap:wrap}
.nb{background:transparent;border:none;color:rgba(240,237,230,.45);font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:6px 9px;border-radius:4px;cursor:pointer;transition:.15s}
.nb:hover{color:#F0EDE6;background:rgba(255,255,255,.05)}
.nb.on{color:#F59E0B;border-bottom:2px solid #F59E0B}
.main{max-width:1100px;margin:0 auto;padding:20px 16px 120px}
.panel{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;overflow:hidden;margin-bottom:14px}
.ph{background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.07);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.pt{font-family:'Oswald',sans-serif;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:rgba(240,237,230,.55)}
.tag{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:3px;white-space:nowrap}
.tg{color:#86EFAC;background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.25)}
.tr{color:#FCA5A5;background:rgba(185,28,28,.15);border:1px solid rgba(185,28,28,.3)}
.ty{color:#FDE68A;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25)}
.mr{padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.04);display:flex;align-items:center;gap:8px;transition:.15s}
.mr:hover{background:rgba(255,255,255,.02)}
.mr:last-child{border-bottom:none}
.sin{width:30px;height:28px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:4px;color:#F59E0B;font-family:'Oswald',sans-serif;font-size:15px;font-weight:600;text-align:center;outline:none;transition:.15s}
.sin:focus{border-color:#B91C1C;background:rgba(185,28,28,.1)}
.ssep{color:rgba(240,237,230,.2);font-size:13px}
.tbl{width:100%;border-collapse:collapse;font-size:12px}
.tbl th{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:rgba(240,237,230,.3);font-weight:600;padding:5px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06)}
.tbl td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.04)}
.tbl tr:last-child td{border-bottom:none}
.pos{display:inline-block;width:16px;height:16px;border-radius:50%;font-size:10px;font-weight:700;text-align:center;line-height:16px}
.bp{background:#B91C1C;color:#fff;border:none;font-family:'Oswald',sans-serif;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:10px 20px;border-radius:4px;cursor:pointer;transition:.15s}
.bp:hover{background:#DC2626}
.bp:disabled{opacity:.4;cursor:default}
.sb{background:#14532D;color:#fff;border:none;font-family:'Oswald',sans-serif;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:6px 12px;border-radius:4px;cursor:pointer;transition:.15s}
.sb:hover{background:#16A34A}
.inp{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#F0EDE6;font-family:'Barlow Condensed',sans-serif;font-size:15px;padding:10px 12px;outline:none;margin-bottom:8px;transition:.15s}
.inp:focus{border-color:#B91C1C}
.inp::placeholder{color:rgba(240,237,230,.25)}
.err{background:rgba(185,28,28,.15);border:1px solid rgba(185,28,28,.35);border-radius:5px;padding:7px 12px;font-size:12px;color:#FCA5A5;margin-bottom:8px}
.ok{background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.3);border-radius:5px;padding:7px 12px;font-size:12px;color:#86EFAC;margin-bottom:8px}
.toast{position:fixed;bottom:20px;right:20px;background:#14532D;color:#fff;font-family:'Oswald',sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;padding:9px 18px;border-radius:6px;text-transform:uppercase;z-index:999;animation:su .2s ease}
@keyframes su{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
.qcard{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-left:3px solid rgba(255,255,255,.06);border-radius:8px;padding:12px;margin-bottom:8px}
.qcard.done{border-left-color:#16A34A}
.opts{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.opt{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.55);font-family:'Barlow Condensed',sans-serif;font-size:12px;padding:4px 9px;border-radius:4px;cursor:pointer;transition:.15s}
.opt:hover{background:rgba(255,255,255,.09)}
.opt.on{background:rgba(185,28,28,.2);border-color:#B91C1C;color:#F0EDE6}
.opt.multi.on{background:rgba(22,163,74,.15);border-color:#16A34A;color:#F0EDE6}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto}
.modal{background:#0D1A0F;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 24px;max-width:400px;width:100%;margin:auto}
.pm{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.pmt{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pmt-team{flex:1;font-size:13px;font-weight:500;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.07);text-align:center}
.pmt-team.win{background:rgba(22,163,74,.15);border-color:rgba(22,163,74,.35);color:#86EFAC;font-weight:600}
.pmt-team.tbd{color:rgba(240,237,230,.35);font-size:10px;line-height:1.2;padding:4px 6px}
.pen-btn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.5);font-size:11px;font-family:'Barlow Condensed',sans-serif;padding:3px 8px;border-radius:3px;cursor:pointer;transition:.15s}
.pen-btn.on{background:rgba(245,158,11,.2);border-color:#F59E0B;color:#FDE68A;font-weight:600}
.lr{padding:9px 14px;border-bottom:1px solid rgba(255,255,255,.04);display:flex;align-items:center;gap:10px;transition:.15s}
.lr:hover{background:rgba(255,255,255,.02)}
.lr:last-child{border-bottom:none}
.rk{font-family:'Oswald',sans-serif;font-size:17px;font-weight:700;width:24px;text-align:center;flex-shrink:0}
.av{border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-size:11px;font-weight:700;flex-shrink:0}
.pp{font-family:'Oswald',sans-serif;font-size:19px;font-weight:700;color:#F59E0B}
.third-ok{font-size:10px;font-weight:700;color:#86EFAC;background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.3);padding:1px 6px;border-radius:3px;white-space:nowrap}
.third-no{font-size:10px;font-weight:700;color:#FCA5A5;background:rgba(185,28,28,.12);border:1px solid rgba(185,28,28,.3);padding:1px 6px;border-radius:3px;white-space:nowrap}
.paywall-modal{background:#0D1A0F;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:28px 24px;max-width:480px;width:100%;margin:auto}
.plan-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px;cursor:pointer;transition:.15s;position:relative}
.plan-card:hover{border-color:rgba(245,158,11,.4);background:rgba(255,255,255,.06)}
.plan-card.featured{border-color:#B91C1C;background:rgba(185,28,28,.08)}
.plan-card .price{font-family:'Oswald',sans-serif;font-size:28px;font-weight:700;color:#F59E0B}
.plan-card .plan-name{font-family:'Oswald',sans-serif;font-size:15px;font-weight:600;color:#F0EDE6;margin-bottom:4px}
.admin-table{width:100%;border-collapse:collapse;font-size:12px}
.admin-table th{font-size:10px;text-transform:uppercase;color:rgba(240,237,230,.3);padding:6px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
.admin-table td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
.admin-table tr:last-child td{border-bottom:none}
.mini-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.7);font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;padding:3px 8px;border-radius:3px;cursor:pointer;transition:.15s;white-space:nowrap}
.mini-btn:hover{background:rgba(255,255,255,.12)}
.mini-btn.green{background:rgba(22,163,74,.2);border-color:rgba(22,163,74,.4);color:#86EFAC}
.mini-btn.red{background:rgba(185,28,28,.2);border-color:rgba(185,28,28,.4);color:#FCA5A5}
.tabs{display:flex;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:3px;margin-bottom:14px;flex-wrap:wrap;gap:2px}
.tab{flex:1;min-width:34px;background:transparent;border:none;color:rgba(240,237,230,.4);font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;padding:6px 3px;border-radius:4px;cursor:pointer;transition:.15s}
.tab.on{background:#B91C1C;color:#fff}
.anchor-bar{display:flex;gap:3px;flex-wrap:wrap;position:sticky;top:52px;z-index:40;background:#0A1208;padding:6px 0 6px;margin-bottom:10px}
.anch-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.6);font-family:'Oswald',sans-serif;font-size:12px;font-weight:600;padding:4px 9px;border-radius:4px;cursor:pointer;transition:.15s;min-width:32px;text-align:center}
.anch-btn.done{background:rgba(22,163,74,.2);border-color:rgba(22,163,74,.3);color:#86EFAC}
.section-hdr{font-family:'Oswald',sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(240,237,230,.7);margin-bottom:14px;display:flex;align-items:center;gap:10px}
.section-hdr-bar{width:3px;height:20px;border-radius:2px;display:inline-block;flex-shrink:0}
.group-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:24px}
.po-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.access-badge{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border-radius:10px}
.badge-demo{background:rgba(255,255,255,.07);color:rgba(240,237,230,.45);border:1px solid rgba(255,255,255,.1)}
.badge-paid{background:rgba(22,163,74,.15);color:#86EFAC;border:1px solid rgba(22,163,74,.3)}
.badge-full{background:rgba(245,158,11,.15);color:#FDE68A;border:1px solid rgba(245,158,11,.3)}
.badge-admin{background:rgba(185,28,28,.2);color:#FCA5A5;border:1px solid rgba(185,28,28,.35)}
.debug-panel{background:rgba(245,158,11,.04);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:14px;margin-bottom:14px;font-size:11px}
@media(max-width:680px){.group-grid,.po-grid{grid-template-columns:1fr}}
@media(max-width:600px){.anch-btn{padding:3px 6px!important;font-size:11px!important;min-width:26px!important}.sin{width:34px!important;height:36px!important}}
.auth-divider{display:flex;align-items:center;gap:10px;margin:14px 0;color:rgba(240,237,230,.25);font-size:11px}.auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}
.google-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;border:none;border-radius:6px;color:#1f1f1f;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:600;padding:11px 16px;cursor:pointer;transition:.15s;margin-bottom:8px}
.google-btn:hover{background:#f0f0f0;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.vk-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#0077FF;border:none;border-radius:6px;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:600;padding:11px 16px;cursor:pointer;transition:.15s;margin-bottom:4px}
.vk-btn:hover{background:#0060d0}
.vk-btn:disabled{background:#334;cursor:default;opacity:.5}
.auth-hint{font-size:10px;color:rgba(240,237,230,.25);text-align:center;margin-bottom:10px;line-height:1.4}
.fcoins-badge{display:flex;align-items:center;gap:4px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25);border-radius:12px;padding:2px 8px;font-family:'Oswald',sans-serif;font-size:12px;font-weight:600;color:#FDE68A;cursor:default;white-space:nowrap}
.mode-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:24px 20px;cursor:pointer;transition:.2s;position:relative;overflow:hidden}
.mode-card:hover{border-color:rgba(245,158,11,.35);background:rgba(255,255,255,.05)}
.mode-card.champ{border-left:4px solid #B91C1C}
.mode-card.clubs{border-left:4px solid #1d4ed8}
.mode-card-title{font-family:'Oswald',sans-serif;font-size:22px;font-weight:700;color:#F0EDE6;margin-bottom:8px}
.mode-card-desc{font-size:13px;color:rgba(240,237,230,.5);line-height:1.6;margin-bottom:16px}
.mode-card-price{font-family:'Oswald',sans-serif;font-size:28px;font-weight:700;color:#F59E0B;margin-bottom:14px}
.club-create-wrap{max-width:480px;margin:0 auto;padding:20px 0}
.club-inp{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#F0EDE6;font-family:'Barlow Condensed',sans-serif;font-size:15px;padding:10px 12px;outline:none;margin-bottom:10px;transition:.15s}
.club-inp:focus{border-color:#1d4ed8}
.color-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.color-swatch{width:28px;height:28px;border-radius:50%;cursor:pointer;border:2px solid transparent;transition:.15s;flex-shrink:0}
.color-swatch.on{border-color:#fff;transform:scale(1.15)}
.fcoins-history{width:100%;border-collapse:collapse;font-size:12px}
.fcoins-history th{font-size:10px;text-transform:uppercase;color:rgba(240,237,230,.3);padding:6px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06)}
.fcoins-history td{padding:7px 10px;border-bottom:1px solid rgba(255,255,255,.04)}
.fcoins-history tr:last-child td{border-bottom:none}
`;

// ── SHIELD LOGO ──
function Shield() {
  return (
    <svg width="34" height="38" viewBox="0 0 34 38" fill="none">
      <path d="M17 1L2 7v12c0 9 6 16 15 18C26 35 32 28 32 19V7L17 1z" fill="#B91C1C" />
      <path d="M17 1L2 7v12c0 9 6 16 15 18V1z" fill="#991B1B" />
      <path d="M17 4L4 9v10c0 7.5 5 13 13 15 8-2 13-7.5 13-15V9L17 4z" fill="#14532D" />
      <text x="17" y="23" textAnchor="middle" fontFamily="Oswald,sans-serif" fontWeight="700" fontSize="10" fill="#F59E0B">FFC</text>
    </svg>
  );
}

// ── OTP AUTH MODAL ──
function AuthModal({ onClose, onAuth, onSocialAuth }) {
  const [step, setStep] = useState("email"); // "email" | "otp"
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState(null); // "google" | "vk" | null

  async function sendOtp() {
    setErr(""); setInfo("");
    if (!email || !email.includes("@")) { setErr("Введи корректный email"); return; }
    setBusy(true);
    // Явно передаём shouldCreateUser и НЕ передаём redirectTo
    // чтобы Supabase отправил OTP-код, а не magic link
    const r = await supaAuth("otp", {
      email,
      create_user: true,
      data: name.trim() ? { name: name.trim() } : undefined,
      // НЕ указываем redirect_to — иначе Supabase отправит magic link
    });
    setBusy(false);
    if (r.error) { setErr(r.error.message || "Ошибка отправки кода"); return; }
    setInfo("Мы отправили код на почту. Введи код из письма.");
    setStep("otp");
  }

  async function verifyOtp() {
    setErr("");
    if (!code || code.length < 4) { setErr("Введи код из письма"); return; }
    setBusy(true);
    // type: "email" — для OTP-кода (не magic link)
    const r = await supaAuth("verify", { type: "email", email, token: code });
    setBusy(false);
    if (r.error) { setErr("Код неверный или истёк. Попробуй снова."); return; }
    if (r.access_token) {
      onAuth(r);
    } else {
      setErr("Не удалось получить сессию. Попробуй ещё раз.");
    }
  }

  async function signInWithGoogle() {
    setSocialBusy("google");
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setSocialBusy(null);
      setErr("Ошибка входа через Google: " + error.message);
    }
    // При успехе — редирект на Google, onAuthStateChange подхватит после возврата
  }

  // VK вход — будет реализован отдельно (см. план в документации проекта)

  const isAnySocialBusy = socialBusy !== null;

  return (
    <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && onClose()}>
      <div className="modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 19, fontWeight: 700, color: "#F59E0B" }}>
            {step === "email" ? "Войти в турнир" : "Введи код из письма"}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {err && <div className="err">{err}</div>}
        {info && <div className="ok">{info}</div>}

        {/* Кнопки соцсетей — показываем только на шаге email */}
        {step === "email" && (
          <>
            <button className="google-btn" disabled={isAnySocialBusy} onClick={signInWithGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              {socialBusy === "google" ? "Перехожу..." : "Войти через Google"}
            </button>

            {/* VK временно скрыт — проблема с OAuth на стороне VK ID, разбираемся */}
            {/* <button className="vk-btn" ...>Войти через VK</button> */}

            <div className="auth-divider">или войди по email-коду</div>

            <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 12, lineHeight: 1.5 }}>
              Пароль не нужен — пришлём код на почту.
            </div>
            <input className="inp" placeholder="Твоё имя (в таблице лидеров)" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="inp" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendOtp()} />
            <button className="bp" style={{ width: "100%", marginTop: 4 }} disabled={busy || isAnySocialBusy} onClick={sendOtp}>
              {busy ? "Отправляю..." : "Получить код →"}
            </button>
            <div className="auth-hint" style={{ marginTop: 10 }}>Продолжая, вы соглашаетесь с правилами турнира.</div>
          </>
        )}

        {step === "otp" && (
          <>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", marginBottom: 12, lineHeight: 1.5 }}>
              Код отправлен на <strong style={{ color: "#F0EDE6" }}>{email}</strong>.<br />
              Проверь папку «Спам», если письма нет.
            </div>
            <input className="inp" type="text" inputMode="numeric" placeholder="Код из письма" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && verifyOtp()} style={{ letterSpacing: 4, fontSize: 20, textAlign: "center" }} />
            <button className="bp" style={{ width: "100%", marginTop: 4 }} disabled={busy} onClick={verifyOtp}>
              {busy ? "Проверяю..." : "Войти →"}
            </button>
            <button onClick={() => { setStep("email"); setCode(""); setErr(""); setInfo(""); }} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.35)", fontSize: 12, cursor: "pointer", marginTop: 10, width: "100%" }}>
              ← Изменить email
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── PAYWALL MODAL ──
function PaywallModal({ onClose, onSelectPlan }) {
  return (
    <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && onClose()}>
      <div className="paywall-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#F59E0B", marginBottom: 4 }}>Битва прогнозистов</div>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)" }}>Заполни прогнозы бесплатно — оплата нужна для участия в турнире и командном зачёте.</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer", flexShrink: 0 }}>×</button>
        </div>
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>🏆 Битва прогнозистов</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F59E0B", marginBottom: 10 }}>500 ₽</div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.7, marginBottom: 14 }}>
            Большой турнир прогнозов на весь ЧМ-2026: группы, плей-офф и бонусные вопросы.
          </div>
          {["Прогнозы на все матчи", "Бонусные вопросы", "Общая таблица прогнозистов", "Командный зачёт"].map(f => (
            <div key={f} style={{ fontSize: 12, color: "rgba(240,237,230,.6)", marginBottom: 4, display: "flex", gap: 6 }}>
              <span style={{ color: "#15803d" }}>✓</span>{f}
            </div>
          ))}
          <button className="bp" style={{ width: "100%", padding: "10px", fontSize: 14, marginTop: 14 }}
            onClick={() => onSelectPlan(PLANS[0])}>
            Участвовать за 500 ₽
          </button>
        </div>
        <div style={{ textAlign: "center", fontSize: 11, color: "rgba(240,237,230,.3)" }}>Оплата подтверждается организатором вручную · Обычно в течение нескольких часов</div>
        <button onClick={onClose} style={{ width: "100%", marginTop: 12, background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.4)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 13, padding: "8px", borderRadius: 4, cursor: "pointer" }}>Закрыть</button>
      </div>
    </div>
  );
}

// ── PAYMENT MODAL ──
function PaymentModal({ plan, onClose, onSubmit }) {
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    if (busy) return;
    setBusy(true);
    await onSubmit(plan, comment);
    setSubmitted(true);
    setBusy(false);
  }

  if (submitted) return (
    <div className="modal-bg">
      <div className="modal" style={{ textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#86EFAC", marginBottom: 8 }}>Заявка отправлена!</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.6, marginBottom: 20 }}>
          Организатор получит уведомление и подтвердит оплату.<br />
          Оплата ожидает подтверждения организатором.<br />
          После подтверждения прогноз будет зафиксирован.
        </div>
        <button className="sb" style={{ width: "100%" }} onClick={onClose}>Закрыть</button>
      </div>
    </div>
  );

  return (
    <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && onClose()}>
      <div className="modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 19, fontWeight: 700, color: "#F59E0B" }}>{plan.label}</div>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)" }}>Участие в турнире FFC · ЧМ-2026</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 11, color: "rgba(240,237,230,.45)", marginBottom: 14, lineHeight: 1.5, background: "rgba(22,163,74,.07)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 6, padding: "8px 12px" }}>
          Заполнение прогноза бесплатно. Оплата нужна, чтобы отправить прогноз в турнир, попасть в таблицу лидеров и участвовать в призовом фонде.
        </div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F59E0B", marginBottom: 4 }}>{plan.price} ₽</div>
        <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 14, margin: "12px 0" }}>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>Реквизиты для перевода</div>
          {[["Карта", PAYMENT_INFO.card], ["Получатель", PAYMENT_INFO.name], ["Телефон", PAYMENT_INFO.phone], ["Комментарий", PAYMENT_INFO.comment]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,.05)", fontSize: 12 }}>
              <span style={{ color: "rgba(240,237,230,.4)" }}>{k}</span>
              <span style={{ color: "#F0EDE6", fontWeight: 500 }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", marginBottom: 10 }}>Комментарий к платежу (необязательно):</div>
        <input className="inp" placeholder="Например: перевёл с Тинькофф" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginBottom: 12 }} />
        <button className="bp" style={{ width: "100%" }} onClick={handleSubmit} disabled={busy}>
          {busy ? "Отправляю..." : "Я оплатил — отправить заявку"}
        </button>
      </div>
    </div>
  );
}

// ── DRAFT MODAL ──
function DraftModal({ onTransfer, onKeep }) {
  return (
    <div className="modal-bg">
      <div className="modal" style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>Найден черновик прогнозов</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)", marginBottom: 20, lineHeight: 1.5 }}>На этом устройстве сохранён черновик. Перенести его в аккаунт?</div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="bp" style={{ flex: 1 }} onClick={onTransfer}>Да, перенести</button>
          <button onClick={onKeep} style={{ flex: 1, background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(240,237,230,.6)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 13, padding: "10px", borderRadius: 4, cursor: "pointer" }}>Нет, оставить</button>
        </div>
      </div>
    </div>
  );
}


// ══════════════════════════════════════════════
// FFC UTILITY FUNCTIONS
// ══════════════════════════════════════════════

function calculatePlayerFantasyPoints(position, stats) {
  if (!stats) return 0;
  let pts = 0;
  const s = stats;

  if (position === "coach") {
    if (s.team_win) pts += 5;
    else if (s.team_draw) pts += 2;
    if (s.team_advanced) pts += 5;
    if ((s.goals || 0) >= 3) pts += 2; // команда забила 3+
    if (s.red_cards > 0) pts -= 2;
  } else if (position === "goalkeeper") {
    if (s.started) pts += 2;
    if (s.clean_sheet) pts += 6;
    if (s.team_win) pts += 3;
    pts += (s.penalty_saved || 0) * 8;
    pts -= (s.goals_conceded || 0);
    pts -= (s.yellow_cards || 0);
    pts -= (s.red_cards || 0) * 4;
    // Серия пенальти
    if (s.shootout_won) pts += 4;
    const savedInShootout = Math.min(s.shootout_penalties_saved || 0, 2);
    pts += savedInShootout * 3;
    if (s.shootout_decisive_save) pts += 2;
    // Вратарь как пенальтист
    pts += (s.shootout_penalties_scored || 0) * 2;
    if (s.shootout_decisive_penalty_scored) pts += 2;
    pts -= (s.shootout_penalties_missed || 0);
  } else if (position === "defender") {
    if (s.started) pts += 2;
    if (s.clean_sheet) pts += 5;
    pts += (s.goals || 0) * 8;
    pts += (s.assists || 0) * 5;
    if (s.team_win) pts += 2;
    pts -= (s.yellow_cards || 0);
    pts -= (s.red_cards || 0) * 4;
    pts += (s.shootout_penalties_scored || 0) * 2;
    if (s.shootout_decisive_penalty_scored) pts += 2;
    pts -= (s.shootout_penalties_missed || 0);
  } else if (position === "midfielder") {
    if (s.started) pts += 2;
    pts += (s.goals || 0) * 6;
    pts += (s.assists || 0) * 5;
    if (s.team_win) pts += 2;
    pts -= (s.yellow_cards || 0);
    pts -= (s.red_cards || 0) * 4;
    pts += (s.shootout_penalties_scored || 0) * 2;
    if (s.shootout_decisive_penalty_scored) pts += 2;
    pts -= (s.shootout_penalties_missed || 0);
  } else if (position === "forward") {
    if (s.started) pts += 2;
    const g = s.goals || 0;
    pts += g * 5;
    if (g >= 2) pts += 3;
    if (g >= 3) pts += 6;
    pts += (s.assists || 0) * 4;
    pts -= (s.penalty_missed || 0) * 3;
    pts -= (s.yellow_cards || 0);
    pts -= (s.red_cards || 0) * 4;
    pts += (s.shootout_penalties_scored || 0) * 2;
    if (s.shootout_decisive_penalty_scored) pts += 2;
    pts -= (s.shootout_penalties_missed || 0);
  }
  return pts;
}

function calculateLineupScore(lineup, statsMap, playersMap) {
  if (!lineup) return { total: 0, scores: {}, dropped: null, captainId: null };
  const roles = [
    "coach_id", "goalkeeper_id",
    "defender_id", "defender2_id",
    "midfielder_id", "midfielder2_id",
    "forward_id", "forward2_id",
  ];
  const positionOf = {
    coach_id: "coach", goalkeeper_id: "goalkeeper",
    defender_id: "defender", defender2_id: "defender",
    midfielder_id: "midfielder", midfielder2_id: "midfielder",
    forward_id: "forward", forward2_id: "forward",
  };
  const captainId = lineup.captain_player_id || null;

  const scores = {};
  roles.forEach((role) => {
    const pid = lineup[role];
    if (!pid) return;
    const player = playersMap[pid];
    const stats = statsMap[pid];
    if (!player) return;
    let pts = calculatePlayerFantasyPoints(positionOf[role], stats);
    const isCaptain = pid === captainId && role !== "coach_id";
    if (isCaptain) pts = Math.round(pts * 1.5);
    scores[pid] = { role, position: positionOf[role], pts, name: player.name, isCaptain, isBench: false };
  });

  // Запасной
  let dropped = null;
  if (lineup.bench_player_id) {
    const pid = lineup.bench_player_id;
    const player = playersMap[pid];
    const stats = statsMap[pid];
    if (player) {
      const benchPts = calculatePlayerFantasyPoints(player.position, stats);
      scores[pid] = { role: "bench", position: player.position, pts: benchPts, name: player.name, isCaptain: false, isBench: true };
      // Найти минимального из 8 основных
      const mainEntries = Object.entries(scores)
        .filter(([, v]) => !v.isBench)
        .sort((a, b) => a[1].pts - b[1].pts);
      if (mainEntries.length > 0 && benchPts > mainEntries[0][1].pts) {
        dropped = { pid: mainEntries[0][0], ...mainEntries[0][1] };
      }
    }
  }

  const total = Object.entries(scores)
    .filter(([pid]) => !dropped || pid !== dropped.pid)
    .reduce((sum, [, v]) => sum + v.pts, 0);

  return { total, scores, dropped, captainId };
}

// ══════════════════════════════════════════════
// FFC LINEUP VIEW
// ══════════════════════════════════════════════

function FfcLineupView({ session, profile, showToast, activeRound, isAdmin, setTab, activeRoundError, allRounds }) {
  const [players, setPlayers] = useState([]);
  const [lineup, setLineup] = useState(null);           // состав текущего тура (рабочая копия)
  const [savedLineup, setSavedLineup] = useState(null); // сохранённый в БД состав текущего тура
  const [prevLineup, setPrevLineup] = useState(null);   // состав предыдущего тура
  const [allPlayersMap, setAllPlayersMap] = useState({}); // все игроки включая неактивных
  const [posFilter, setPosFilter] = useState("all");
  const [activeSlot, setActiveSlot] = useState(null); // ключ из ROLES.key — куда идёт следующий выбор
  const [teamFilter, setTeamFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [starsOnly, setStarsOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasBench, setHasBench] = useState(false);
  const [extraTransfers, setExtraTransfers] = useState(0);
  const [autoCarryMsg, setAutoCarryMsg] = useState(false);
  const [statsMap, setStatsMap] = useState({});
  const [playersLoadError, setPlayersLoadError] = useState(null);
  const token = session?.access_token;
  const uid = session?.user?.id;

  // Шаблон безопасного пустого состава — все поля всегда присутствуют
  const EMPTY_LINEUP = {
    coach_id: null, goalkeeper_id: null,
    defender_id: null, defender2_id: null,
    midfielder_id: null, midfielder2_id: null,
    forward_id: null, forward2_id: null,
    bench_player_id: null, captain_player_id: null,
  };

  function safeLineup(src) {
    return { ...EMPTY_LINEUP, ...src };
  }

  const ROLES = [
    { key: "coach_id",       label: "Тренер",           pos: "coach",        emoji: "🧑‍💼" },
    { key: "goalkeeper_id",  label: "Вратарь",           pos: "goalkeeper",   emoji: "🧤" },
    { key: "defender_id",    label: "Защитник 1",        pos: "defender",     emoji: "🛡" },
    { key: "defender2_id",   label: "Защитник 2",        pos: "defender",     emoji: "🛡" },
    { key: "midfielder_id",  label: "Полузащитник 1",    pos: "midfielder",   emoji: "⚡" },
    { key: "midfielder2_id", label: "Полузащитник 2",    pos: "midfielder",   emoji: "⚡" },
    { key: "forward_id",     label: "Нападающий 1",      pos: "forward",      emoji: "⚽" },
    { key: "forward2_id",    label: "Нападающий 2",      pos: "forward",      emoji: "⚽" },
  ];
  const TRANSFER_FIELDS = ["coach_id","goalkeeper_id","defender_id","defender2_id","midfielder_id","midfielder2_id","forward_id","forward2_id","bench_player_id"];

  // Сколько замен сделано между prevLineup и текущей рабочей копией lineup
  function countLineupChanges(prev, current) {
    if (!prev) return 0;
    return TRANSFER_FIELDS.filter(f => (prev[f] || null) !== (current[f] || null)).length;
  }

  useEffect(() => {
    if (!session || !activeRound) return;
    loadAll();
  }, [session, activeRound]);

  async function loadAll() {
    await Promise.all([loadPlayers(), loadLineupData(), checkBench(), loadExtraTransfers()]);
  }

  async function loadPlayers() {
    setPlayersLoadError(null);
    try {
      // ffc_players — публичный справочник, token не нужен
      const r = await supa("ffc_players?select=*&is_active=eq.true&order=national_team.asc,name.asc");
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("Load FFC players failed:", r.status, text);
        setPlayersLoadError(`HTTP ${r.status}: ${text.slice(0, 200)}`);
        setPlayers([]);
      } else {
        const rows = await r.json();
        console.log("FFC players loaded:", rows.length, rows.slice(0, 3).map(p => p.name));
        setPlayers(rows || []);
        setPlayersLoadError(null);
      }
    } catch (e) {
      console.error("Load FFC players exception:", e);
      setPlayersLoadError(String(e?.message || e));
      setPlayers([]);
    }

    // allPlayersMap — тоже без token
    try {
      const ra = await supa("ffc_players?select=*");
      if (ra.ok) {
        const all = await ra.json();
        setAllPlayersMap(Object.fromEntries(all.map(p => [p.id, p])));
      }
    } catch {}
  }

  async function loadLineupData() {
    if (!activeRound) return;

    // Статистика тура
    const sr = await supa(`ffc_player_stats?round_id=eq.${activeRound.id}&select=*`, { token });
    if (sr.ok) {
      const sd = await sr.json();
      setStatsMap(Object.fromEntries(sd.map(s => [s.player_id, s])));
    }

    // Состав текущего тура
    const cr = await supa(`ffc_lineups?round_id=eq.${activeRound.id}&user_id=eq.${uid}&select=*`, { token });
    const currentArr = cr.ok ? await cr.json() : [];
    const currentSaved = currentArr[0] || null;
    setSavedLineup(currentSaved);

    if (currentSaved) {
      setLineup(safeLineup(currentSaved));
      setAutoCarryMsg(false);
    } else {
      const pr = await supa(
        `ffc_lineups?user_id=eq.${uid}&select=*&order=created_at.desc&limit=1`,
        { token }
      );
      const prevArr = pr.ok ? await pr.json() : [];
      const prev = prevArr[0] && prevArr[0].round_id !== activeRound.id ? prevArr[0] : null;
      setPrevLineup(prev);
      if (prev) {
        setLineup(safeLineup({ ...prev, id: undefined, round_id: activeRound.id }));
        setAutoCarryMsg(true);
      } else {
        setLineup({ ...EMPTY_LINEUP, round_id: activeRound.id });
      }
    }
  }

  async function checkBench() {
    if (!activeRound) return;
    const r = await supa(`ffc_shop_purchases?user_id=eq.${uid}&item_type=eq.bench_player&round_id=eq.${activeRound.id}&select=id`, { token });
    if (r.ok) { const d = await r.json(); setHasBench(d.length > 0); }
  }

  async function loadExtraTransfers() {
    if (!activeRound) return;
    const r = await supa(`ffc_shop_purchases?user_id=eq.${uid}&item_type=eq.extra_transfer&round_id=eq.${activeRound.id}&select=id`, { token });
    if (r.ok) { const d = await r.json(); setExtraTransfers(d.length); }
  }

  const isPastDeadline = activeRound?.deadline
    ? new Date() >= new Date(activeRound.deadline)
    : activeRound?.status !== "lineup_open";
  const isBeforeOpen = activeRound?.opens_at
    ? new Date() < new Date(activeRound.opens_at)
    : false;
  const canEdit = activeRound && !isPastDeadline && !isBeforeOpen && activeRound.status !== "finished";

  // Разрешённое количество замен
  const FREE_TRANSFERS_PER_ROUND = 2;
  const allowedTransfers = prevLineup ? FREE_TRANSFERS_PER_ROUND + extraTransfers : Infinity;
  const changesCount = prevLineup ? countLineupChanges(prevLineup, lineup || {}) : 0;
  const transfersLeft = allowedTransfers === Infinity ? null : allowedTransfers - changesCount;

  // Валидация
  function validateLineup() {
    if (isPastDeadline) return "Дедлайн выбора состава уже прошёл.";

    const pm = allPlayersMap;

    if (!lineup.coach_id) return "Выберите тренера.";
    if (!lineup.goalkeeper_id) return "Выберите вратаря.";
    if (!lineup.defender_id || !lineup.defender2_id) return "Выберите двух защитников.";
    if (!lineup.midfielder_id || !lineup.midfielder2_id) return "Выберите двух полузащитников.";
    if (!lineup.forward_id || !lineup.forward2_id) return "Выберите двух нападающих.";
    if (!lineup.captain_player_id) return "Выберите капитана.";

    // Капитан — только из 7 игроков, не тренер
    const playerIds = [
      lineup.goalkeeper_id, lineup.defender_id, lineup.defender2_id,
      lineup.midfielder_id, lineup.midfielder2_id, lineup.forward_id, lineup.forward2_id,
    ].filter(Boolean);
    if (lineup.captain_player_id === lineup.coach_id) return "Капитаном может быть только игрок, не тренер.";
    if (!playerIds.includes(lineup.captain_player_id)) return "Капитан должен быть одним из семи игроков.";

    // Запасной не может быть капитаном
    if (hasBench && lineup.bench_player_id && lineup.bench_player_id === lineup.captain_player_id) {
      return "Запасной не может быть капитаном.";
    }

    // Все выбранные (тренер + 7 + запасной)
    const allFieldIds = [
      lineup.coach_id, lineup.goalkeeper_id,
      lineup.defender_id, lineup.defender2_id,
      lineup.midfielder_id, lineup.midfielder2_id,
      lineup.forward_id, lineup.forward2_id,
      ...(hasBench && lineup.bench_player_id ? [lineup.bench_player_id] : []),
    ].filter(Boolean);

    // Нельзя выбрать одного игрока дважды
    const idSet = new Set(allFieldIds);
    if (idSet.size !== allFieldIds.length) return "Нельзя выбрать одного игрока дважды.";

    const allSelected = allFieldIds.map(id => pm[id]).filter(Boolean);

    // Лимит сборной: максимум 2
    const teamCounts = {};
    for (const p of allSelected) teamCounts[p.national_team] = (teamCounts[p.national_team] || 0) + 1;
    for (const [team, count] of Object.entries(teamCounts)) {
      if (count > 2) return `В составе может быть максимум 2 представителя одной сборной (${team}).`;
    }

    // Лимит звёзд: максимум 1
    const starCount = allSelected.filter(p => p.tier === "star").length;
    if (starCount > 1) return "В составе может быть максимум 1 звёздный игрок.";

    // Лимит замен
    if (prevLineup && changesCount > allowedTransfers) {
      return `Вы сделали ${changesCount} замен, доступно ${allowedTransfers}. Купите дополнительную замену в магазине F-Coins.`;
    }

    return null;
  }

  async function saveLineup() {
    if (!canEdit) { showToast("Состав нельзя изменить — тур закрыт"); return; }
    const error = validateLineup();
    if (error) { showToast("⚠ " + error); return; }

    setSaving(true);
    const payload = {
      round_id: activeRound.id,
      user_id: uid,
      coach_id:          lineup.coach_id        || null,
      goalkeeper_id:     lineup.goalkeeper_id   || null,
      defender_id:       lineup.defender_id     || null,
      defender2_id:      lineup.defender2_id    || null,
      midfielder_id:     lineup.midfielder_id   || null,
      midfielder2_id:    lineup.midfielder2_id  || null,
      forward_id:        lineup.forward_id      || null,
      forward2_id:       lineup.forward2_id     || null,
      bench_player_id:   lineup.bench_player_id || null,
      captain_player_id: lineup.captain_player_id || null,
      updated_at:        new Date().toISOString(),
    };

    let ok = false;
    let errText = "";
    if (savedLineup?.id) {
      const res = await supa(`ffc_lineups?id=eq.${savedLineup.id}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify(payload),
      });
      ok = res.ok;
      if (!ok) {
        errText = await res.text().catch(() => "");
        console.error("saveLineup PATCH error:", res.status, errText);
      }
      if (ok) setSavedLineup(prev => ({ ...prev, ...payload }));
    } else {
      const res = await supa("ffc_lineups", {
        method: "POST", token,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      ok = res.ok;
      if (ok) {
        const created = await res.json();
        setSavedLineup(created[0] || payload);
      } else {
        errText = await res.text().catch(() => "");
        console.error("saveLineup POST error:", res.status, errText);
      }
    }

    setSaving(false);
    if (ok) {
      setAutoCarryMsg(false);
      showToast("✓ Состав сохранён");
    } else {
      const short = errText.slice(0, 200);
      showToast(`⚠ Не удалось сохранить состав: ${short || "нет ответа от сервера"}`);
    }
  }

  const playersMap = Object.fromEntries(players.map(p => [p.id, p]));
  const teams = [...new Set(players.map(p => p.national_team))].sort();

  const filteredPlayers = players.filter(p => {
    if (posFilter !== "all" && p.position !== posFilter) return false;
    if (teamFilter && p.national_team !== teamFilter) return false;
    if (nameFilter && !p.name.toLowerCase().includes(nameFilter.toLowerCase())) return false;
    if (starsOnly && p.tier !== "star") return false;
    return true;
  });

  // ── Пустые состояния
  if (!activeRound) {
    return (
      <div style={{ padding: "24px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, color: "#F0EDE6", marginBottom: 8 }}>Нет открытого тура</div>
          {isAdmin ? (
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)", lineHeight: 1.8, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 8, padding: "14px 16px", textAlign: "left" }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 8 }}>🔧 Чтобы протестировать составы:</div>
              <div>1. Открой <strong>Игроки</strong> → Добавь демо-игроков</div>
              <div>2. Открой <strong>Туры</strong> → Создай тур со статусом <code style={{ background: "rgba(255,255,255,.08)", padding: "1px 4px", borderRadius: 3 }}>lineup_open</code></div>
              <div>3. Укажи дедлайн в будущем</div>
              {activeRoundError && (
                <div style={{ marginTop: 10, padding: "8px 10px", background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.2)", borderRadius: 6, fontSize: 11, color: "#FCA5A5", fontFamily: "monospace" }}>
                  <strong>Ошибка загрузки туров:</strong> {activeRoundError}
                </div>
              )}
              {allRounds.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: "rgba(240,237,230,.5)" }}>
                  <strong>Загружено туров:</strong> {allRounds.length} — статусы: {allRounds.map(r => `${r.name}(${r.status})`).join(", ")}
                </div>
              )}
              {allRounds.length === 0 && !activeRoundError && (
                <div style={{ marginTop: 10, fontSize: 11, color: "rgba(240,237,230,.4)" }}>
                  Туров в базе не найдено. Создай тур в Админ → FFC → Туры.
                </div>
              )}
              <button className="sb" style={{ marginTop: 12, fontSize: 11 }} onClick={() => setTab("admin")}>
                Открыть Админ → FFC
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.4)" }}>Состав можно будет выбрать, когда организатор откроет тур.</div>
          )}
        </div>
      </div>
    );
  }

  if (players.length === 0) {
    return (
      <div style={{ padding: "24px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>{playersLoadError ? "⚠️" : "👤"}</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, color: "#F0EDE6", marginBottom: 8 }}>
            {playersLoadError ? "Не удалось загрузить игроков" : "Игроки ещё не добавлены"}
          </div>
          <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", lineHeight: 1.6 }}>
            {playersLoadError
              ? "Приложение не смогло прочитать список игроков из базы данных."
              : "Администратору нужно открыть Админ → FFC → Игроки и добавить игроков."}
          </div>
        </div>
        {isAdmin && (
          <div style={{ background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.2)", borderRadius: 10, padding: "14px 16px", fontSize: 11, lineHeight: 1.8 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 700, color: "#FCA5A5", marginBottom: 10 }}>🔍 Диагностика (только для админа)</div>
            <div style={{ color: "rgba(240,237,230,.6)", marginBottom: 4 }}>
              <strong>activeRound:</strong> {activeRound ? `✓ ${activeRound.name} (${activeRound.status})` : "✗ не найден"}
            </div>
            <div style={{ color: "rgba(240,237,230,.6)", marginBottom: 4 }}>
              <strong>players.length:</strong> {players.length}
            </div>
            {playersLoadError && (
              <div style={{ color: "#FCA5A5", marginBottom: 8 }}>
                <strong>Ошибка загрузки:</strong> {playersLoadError}
              </div>
            )}
            <div style={{ background: "rgba(0,0,0,.3)", borderRadius: 6, padding: "10px 12px", fontFamily: "monospace", fontSize: 10, color: "#86EFAC", marginTop: 8, lineHeight: 1.9 }}>
              <div style={{ color: "rgba(240,237,230,.4)", marginBottom: 2 }}>-- Проверь в Supabase SQL Editor:</div>
              <div>SELECT COUNT(*) FROM public.ffc_players;</div>
              <div>SELECT position, COUNT(*) FROM public.ffc_players WHERE is_active = true GROUP BY position;</div>
              <div style={{ marginTop: 4 }}>SELECT * FROM pg_policies WHERE tablename = 'ffc_players';</div>
            </div>
            <button className="sb" style={{ marginTop: 10, fontSize: 11 }} onClick={() => setTab("admin")}>
              Открыть Админ → FFC
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── assignPlayerToLineup ── вынесена из map, чтобы не пересоздавалась при каждом рендере
  function assignPlayerToLineup(player) {
    // Все ID сейчас в составе
    const getSelectedIds = (l) => [
      l?.coach_id, l?.goalkeeper_id,
      l?.defender_id, l?.defender2_id,
      l?.midfielder_id, l?.midfielder2_id,
      l?.forward_id, l?.forward2_id,
      l?.bench_player_id,
    ].filter(Boolean);

    const currentIds = getSelectedIds(lineup);
    if (currentIds.includes(player.id)) { showToast("⚠ Этот игрок уже выбран."); return; }

    // Целевой слот
    let targetKey = null;
    if (activeSlot && activeSlot !== "bench_player_id") {
      const posMap = { coach_id:"coach", goalkeeper_id:"goalkeeper", defender_id:"defender", defender2_id:"defender", midfielder_id:"midfielder", midfielder2_id:"midfielder", forward_id:"forward", forward2_id:"forward" };
      if (posMap[activeSlot] && player.position !== posMap[activeSlot]) {
        showToast(`Слот «${ROLES.find(r=>r.key===activeSlot)?.label}» — для «${posMap[activeSlot]}», а игрок — «${player.position}».`);
        return;
      }
      targetKey = activeSlot;
    } else if (!activeSlot) {
      if (player.position === "coach")      targetKey = "coach_id";
      if (player.position === "goalkeeper") targetKey = "goalkeeper_id";
      if (player.position === "defender")   targetKey = !lineup?.defender_id  ? "defender_id"  : !lineup?.defender2_id  ? "defender2_id"  : "defender_id";
      if (player.position === "midfielder") targetKey = !lineup?.midfielder_id ? "midfielder_id" : !lineup?.midfielder2_id ? "midfielder2_id" : "midfielder_id";
      if (player.position === "forward")    targetKey = !lineup?.forward_id    ? "forward_id"    : !lineup?.forward2_id    ? "forward2_id"    : "forward_id";
    }
    if (!targetKey) return;

    // Лимит сборной
    const idsWithout = currentIds.filter(id => id !== lineup?.[targetKey]);
    const teamCount = idsWithout.filter(id => allPlayersMap[id]?.national_team === player.national_team).length;
    if (teamCount >= 2) { showToast("В составе может быть максимум 2 представителя одной сборной."); return; }
    // Лимит звёзд
    if (player.tier === "star") {
      const starCount = idsWithout.filter(id => allPlayersMap[id]?.tier === "star").length;
      if (starCount >= 1) { showToast("В составе может быть максимум 1 звёздный игрок."); return; }
    }

    setLineup(prev => {
      const next = { ...(prev || {}) };
      // Если меняем игрока который был капитаном — сбрасываем
      if (next.captain_player_id && next.captain_player_id === next[targetKey]) {
        next.captain_player_id = null;
      }
      next[targetKey] = player.id;
      return next;
    });

    // Переходим к следующему пустому слоту
    const nextLineup = { ...(lineup || {}), [targetKey]: player.id };
    const nextEmpty = ROLES.find(r => !nextLineup[r.key]);
    if (nextEmpty) { setActiveSlot(nextEmpty.key); setPosFilter(nextEmpty.pos); }
    else { setActiveSlot(null); setPosFilter("all"); }
  }

  const scoreResult = savedLineup && Object.keys(statsMap).length > 0
    ? calculateLineupScore(savedLineup, statsMap, allPlayersMap)
    : null;

  return (
    <div>
      {/* DEBUG-блок только для админа */}
      {isAdmin && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 10, color: "rgba(240,237,230,.3)", cursor: "pointer", userSelect: "none" }}>🔍 Debug (только для админа)</summary>
          <div style={{ background: "rgba(0,0,0,.3)", borderRadius: 6, padding: "10px 12px", fontFamily: "monospace", fontSize: 10, color: "#86EFAC", lineHeight: 1.9, marginTop: 6 }}>
            <div>activeRound: {activeRound ? `✓ ${activeRound.name} (${activeRound.status})` : "✗ не найден"}</div>
            <div>players.length: {players.length}</div>
            <div>playersLoadError: {playersLoadError || "нет"}</div>
            <div>activeRoundError: {activeRoundError || "нет"}</div>
            {(allRounds || []).length > 0 && <div>все туры: {(allRounds || []).map(r => `${r.name}(${r.status})`).join(", ")}</div>}
            <div>hasBench: {String(hasBench)} · extraTransfers: {extraTransfers} · session: {session?.user?.id?.slice(0, 8) || "нет"}</div>
          </div>
        </details>
      )}

      {/* Заголовок тура */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6" }}>📋 Состав на тур</span>
        <span style={{ fontSize: 12, color: "#FDE68A", background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 4, padding: "2px 8px" }}>{activeRound.name}</span>
        <span style={{ fontSize: 11, color: activeRound.status === "lineup_open" ? "#86EFAC" : "#FCA5A5" }}>
          {activeRound.status === "lineup_open" ? "🟢 Открыт" : activeRound.status === "locked" ? "🔒 Закрыт" : activeRound.status === "scoring" ? "⚡ Подсчёт" : "✅ Завершён"}
        </span>
        {activeRound.deadline && (
          <span style={{ fontSize: 11, color: isPastDeadline ? "#FCA5A5" : "rgba(240,237,230,.4)" }}>
            {isPastDeadline ? "⛔ Дедлайн прошёл" : `🗓 Дедлайн: ${new Date(activeRound.deadline).toLocaleString("ru", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`}
          </span>
        )}
      </div>

      {/* Баннер авто-переноса */}
      {autoCarryMsg && canEdit && (
        <div style={{ background: "rgba(29,78,216,.08)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
          🔄 Мы перенесли состав прошлого тура. Перед дедлайном можно сделать <strong>2 бесплатные замены</strong>.
          {extraTransfers > 0 && <span> (+{extraTransfers} куплено)</span>}
          {" "}Дополнительные замены доступны в магазине F-Coins.
        </div>
      )}

      {/* Дедлайн / статус */}
      {isPastDeadline && (
        <div style={{ background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#FCA5A5" }}>
          🔒 Дедлайн прошёл — {new Date(activeRound.deadline).toLocaleString("ru")}. Редактирование недоступно.
        </div>
      )}

      {/* Счётчик замен */}
      {canEdit && prevLineup && (
        <div style={{ background: transfersLeft >= 0 ? "rgba(22,163,74,.06)" : "rgba(185,28,28,.08)", border: `1px solid ${transfersLeft >= 0 ? "rgba(22,163,74,.2)" : "rgba(185,28,28,.25)"}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 11, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: transfersLeft >= 0 ? "#86EFAC" : "#FCA5A5" }}>
            🔄 Замены: {changesCount}/{allowedTransfers} использовано
          </span>
          {transfersLeft < 0 && (
            <span style={{ color: "#FCA5A5" }}>· Купи доп. замену в магазине</span>
          )}
        </div>
      )}

      {/* Правила */}
      <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 11, color: "rgba(240,237,230,.55)", lineHeight: 1.7 }}>
        <strong style={{ color: "#93C5FD" }}>Состав:</strong> 1 тренер + 1 вратарь + 2 защитника + 2 полузащитника + 2 нападающих · макс. 2 из одной сборной · макс. 1 звезда · капитан среди игроков (не тренер) — ×1.5 очков<br />
        <span style={{ color: "rgba(240,237,230,.35)" }}>Мы не гарантируем выход игрока на поле. Травмы, дисквалификации и ротацию участники отслеживают сами.</span>
      </div>

      {/* Очки */}
      {scoreResult && (
        <div style={{ background: "rgba(29,78,216,.08)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
          <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#93C5FD" }}>{scoreResult.total} очков</span>
          {scoreResult.dropped && <span style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginLeft: 10 }}>Выпал: {scoreResult.dropped.name} ({scoreResult.dropped.pts} оч.)</span>}
          {scoreResult.captainId && scoreResult.scores[scoreResult.captainId] && (
            <span style={{ fontSize: 11, color: "#FDE68A", marginLeft: 10 }}>🏅 Капитан: {scoreResult.scores[scoreResult.captainId].name} (×1.5)</span>
          )}
        </div>
      )}

      {/* Карточки состава */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        {ROLES.map((role) => {
          const selectedId = lineup?.[role.key];
          const player = selectedId ? (allPlayersMap[selectedId] || null) : null;
          const isCaptain = selectedId && selectedId === lineup?.captain_player_id;
          const isInactive = player && !player.is_active;
          const isActive = activeSlot === role.key;
          return (
            <div key={role.key}
              onClick={() => { if (!canEdit) return; setActiveSlot(role.key); setPosFilter(role.pos); }}
              style={{
                background: isActive ? "rgba(29,78,216,.22)" : player ? "rgba(29,78,216,.1)" : "rgba(255,255,255,.04)",
                border: `2px solid ${isActive ? "rgba(99,102,241,.85)" : isCaptain ? "rgba(245,158,11,.65)" : player ? "rgba(99,102,241,.35)" : "rgba(255,255,255,.1)"}`,
                borderRadius: 10, padding: "14px 16px",
                display: "flex", alignItems: "center", gap: 10,
                cursor: canEdit ? "pointer" : "default",
                transition: "border .15s, background .15s",
                boxShadow: isActive ? "0 0 0 3px rgba(99,102,241,.2)" : "none",
              }}>
              <span style={{ fontSize: 22, flexShrink: 0 }}>{role.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: isActive ? "#a5b4fc" : "rgba(240,237,230,.45)", marginBottom: 3, fontWeight: isActive ? 700 : 500, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {role.label}{isActive && !player ? " ← выбери ниже" : ""}
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: isActive && !player ? "#a5b4fc" : "#F0EDE6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.2 }}>
                  {player
                    ? <span>{player.tier === "star" ? "⭐ " : ""}{player.name}</span>
                    : <span style={{ color: isActive ? "#a5b4fc" : "rgba(240,237,230,.25)", fontWeight: 400, fontSize: 14 }}>Не выбран</span>}
                </div>
                {player && (
                  <div style={{ fontSize: 13, color: isInactive ? "#FCA5A5" : "rgba(240,237,230,.55)", marginTop: 3, display: "flex", alignItems: "center", gap: 6 }}>
                    {player.national_team}
                    {isCaptain && <span style={{ fontSize: 12, fontWeight: 700, color: "#F59E0B", background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.4)", borderRadius: 4, padding: "1px 6px" }}>🏅 Капитан</span>}
                    {isInactive && <span style={{ fontSize: 11, color: "#FCA5A5" }}>⚠ Неактивен</span>}
                  </div>
                )}
              </div>
              {scoreResult?.scores[selectedId] && (
                <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: isCaptain ? "#FDE68A" : "#93C5FD", flexShrink: 0 }}>
                  {scoreResult.scores[selectedId].pts}
                </span>
              )}
              {canEdit && player && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  {role.pos !== "coach" && !isCaptain && (
                    <button onClick={() => setLineup(l => ({ ...l, captain_player_id: selectedId }))} title="Назначить капитаном"
                      style={{ background: "rgba(245,158,11,.18)", border: "1px solid rgba(245,158,11,.4)", color: "#FDE68A", cursor: "pointer", fontSize: 14, padding: "3px 6px", borderRadius: 5, lineHeight: 1 }}>🏅</button>
                  )}
                  <button onClick={() => { setLineup(l => ({ ...l, [role.key]: null, captain_player_id: l.captain_player_id === selectedId ? null : l.captain_player_id })); setActiveSlot(role.key); }}
                    style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.12)", color: "rgba(240,237,230,.5)", cursor: "pointer", fontSize: 16, padding: "2px 6px", borderRadius: 5, lineHeight: 1 }}>×</button>
                </div>
              )}
            </div>
          );
        })}

        {/* Запасной */}
        {hasBench && (
          <div
            onClick={() => { if (canEdit) { setActiveSlot("bench_player_id"); setPosFilter("all"); } }}
            style={{
              background: lineup?.bench_player_id ? "rgba(245,158,11,.1)" : "rgba(255,255,255,.03)",
              border: `2px solid ${activeSlot === "bench_player_id" ? "rgba(245,158,11,.7)" : lineup?.bench_player_id ? "rgba(245,158,11,.35)" : "rgba(255,255,255,.1)"}`,
              borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10,
              cursor: canEdit ? "pointer" : "default",
              boxShadow: activeSlot === "bench_player_id" ? "0 0 0 3px rgba(245,158,11,.18)" : "none",
            }}>
            <span style={{ fontSize: 22, flexShrink: 0 }}>🪑</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.45)", marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>
                Запасной <span style={{ color: "rgba(240,237,230,.25)", fontWeight: 400 }}>(8 лучших из 9)</span>
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#F0EDE6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {lineup?.bench_player_id
                  ? (allPlayersMap[lineup.bench_player_id]?.name || "?")
                  : <span style={{ color: "rgba(240,237,230,.25)", fontWeight: 400, fontSize: 14 }}>Не выбран</span>}
              </div>
              {lineup?.bench_player_id && !allPlayersMap[lineup.bench_player_id]?.is_active && (
                <div style={{ fontSize: 12, color: "#FCA5A5", marginTop: 3 }}>⚠ Неактивен в пуле</div>
              )}
            </div>
            {canEdit && lineup?.bench_player_id && (
              <button onClick={e => { e.stopPropagation(); setLineup(l => ({ ...l, bench_player_id: null })); }}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.12)", color: "rgba(240,237,230,.5)", cursor: "pointer", fontSize: 16, padding: "2px 6px", borderRadius: 5, flexShrink: 0 }}>×</button>
            )}
          </div>
        )}
      </div>

      {/* Статус капитана */}
      {canEdit && (
        <div style={{ fontSize: 14, marginBottom: 12, padding: "10px 14px", background: "rgba(245,158,11,.07)", borderRadius: 8, border: "1px solid rgba(245,158,11,.2)" }}>
          {lineup?.captain_player_id && allPlayersMap[lineup.captain_player_id]
            ? <span style={{ color: "#FDE68A", fontWeight: 600 }}>🏅 Капитан: <strong>{allPlayersMap[lineup.captain_player_id].name}</strong> — ×1.5 очков</span>
            : <span style={{ color: "#FCA5A5", fontWeight: 600 }}>⚠ Капитан не выбран — нажми 🏅 рядом с игроком</span>}
        </div>
      )}

      {canEdit && (
        <button className="bp" style={{ width: "100%", marginBottom: 20, opacity: saving ? 0.7 : 1 }} onClick={saveLineup} disabled={saving}>
          {saving ? "Сохраняю..." : "💾 Сохранить состав"}
        </button>
      )}

      {/* Список для выбора */}
      {canEdit && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10, color: "rgba(240,237,230,.4)" }}>Выбор игрока</div>

          {/* Фильтры */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            <input className="inp" placeholder="🔍 Имя" value={nameFilter} onChange={e => setNameFilter(e.target.value)}
              style={{ fontSize: 12, padding: "6px 10px", marginBottom: 0 }} />
            <select value={teamFilter} onChange={e => setTeamFilter(e.target.value)}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 6, color: "#F0EDE6", padding: "6px 8px", fontSize: 12, outline: "none" }}>
              <option value="">Все сборные</option>
              {teams.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 5, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
            {[["all","Все"],["coach","Тренеры"],["goalkeeper","Вратари"],["defender","Защитники"],["midfielder","Полузащ."],["forward","Нападающие"]].map(([v,l]) => (
              <button key={v} onClick={() => { setPosFilter(v); if (v !== "all") setActiveSlot(null); }}
                style={{ background: posFilter===v ? "rgba(29,78,216,.3)" : "rgba(255,255,255,.04)", border:`1px solid ${posFilter===v ? "rgba(29,78,216,.5)" : "rgba(255,255,255,.07)"}`, color: posFilter===v ? "#93C5FD" : "rgba(240,237,230,.5)", fontFamily:"Barlow Condensed,sans-serif", fontSize:11, fontWeight:600, padding:"4px 8px", borderRadius:4, cursor:"pointer" }}>
                {l}
              </button>
            ))}
            <button onClick={() => setStarsOnly(s => !s)}
              style={{ background: starsOnly?"rgba(245,158,11,.2)":"rgba(255,255,255,.04)", border:`1px solid ${starsOnly?"rgba(245,158,11,.4)":"rgba(255,255,255,.07)"}`, color: starsOnly?"#FDE68A":"rgba(240,237,230,.5)", fontFamily:"Barlow Condensed,sans-serif", fontSize:11, fontWeight:600, padding:"4px 8px", borderRadius:4, cursor:"pointer" }}>
              ⭐ Звёзды
            </button>
            <span style={{ fontSize:10, color:"rgba(240,237,230,.25)" }}>{filteredPlayers.length} игр.</span>
          </div>

          {/* Подсказка активного слота */}
          {canEdit && (
            <div style={{ fontSize: 11, marginBottom: 8, padding: "5px 8px", background: activeSlot ? "rgba(29,78,216,.08)" : "rgba(255,255,255,.02)", borderRadius: 5, color: activeSlot ? "#93C5FD" : "rgba(240,237,230,.3)" }}>
              {activeSlot
                ? `▶ Выбираем: ${ROLES.find(r => r.key === activeSlot)?.label} — нажми игрока ниже`
                : "Нажми на слот в карточке состава, чтобы выбрать куда вставить игрока"}
            </div>
          )}

          <div style={{ maxHeight: 360, overflowY: "auto", display: "grid", gap: 3 }}>
            {filteredPlayers.length === 0 && (
              <div style={{ fontSize:12, color:"rgba(240,237,230,.3)", padding:16, textAlign:"center" }}>Нет игроков по фильтру</div>
            )}
            {filteredPlayers.map((p) => {
              // Слоты где уже стоит этот игрок
              const usedInKeys = ROLES.filter(r => lineup?.[r.key] === p.id).map(r => r.key);
              const isBenchSel = lineup?.bench_player_id === p.id;
              const isAnySel = usedInKeys.length > 0 || isBenchSel;
              const isCaptain = lineup?.captain_player_id === p.id;
              const emoji = ROLES.find(r => r.pos === p.position)?.emoji || "👤";
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, background: isAnySel ? "rgba(29,78,216,.12)" : "rgba(255,255,255,.04)", border:`2px solid ${isAnySel ? "rgba(99,102,241,.35)" : "rgba(255,255,255,.07)"}`, borderRadius:8, padding:"11px 12px" }}>
                  <span style={{ fontSize:20, flexShrink:0 }}>{emoji}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:16, fontWeight:700, color:"#F0EDE6", lineHeight:1.2 }}>
                      {p.tier==="star" ? "⭐ " : ""}{p.name}{isCaptain ? " 🏅" : ""}
                    </div>
                    <div style={{ fontSize:13, color:"rgba(240,237,230,.5)", marginTop:3, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                      <span>{p.national_team}</span>
                      <span style={{ background:"rgba(255,255,255,.08)", borderRadius:3, padding:"1px 5px", fontSize:11, color:"rgba(240,237,230,.4)" }}>{p.position}</span>
                      {p.tier==="star" && <span style={{ background:"rgba(245,158,11,.15)", border:"1px solid rgba(245,158,11,.3)", borderRadius:3, padding:"1px 5px", fontSize:11, color:"#FDE68A" }}>Звезда</span>}
                    </div>
                  </div>
                  {isAnySel ? (
                    <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap", justifyContent:"flex-end" }}>
                      {usedInKeys.map(k => (
                        <span key={k} style={{ fontSize:10, color:"#86EFAC", background:"rgba(22,163,74,.12)", border:"1px solid rgba(22,163,74,.25)", borderRadius:4, padding:"2px 6px" }}>
                          {ROLES.find(r => r.key === k)?.label}
                        </span>
                      ))}
                      {isBenchSel && <span style={{ fontSize:10, color:"#FDE68A" }}>Запасной</span>}
                      {usedInKeys.some(k => ROLES.find(r => r.key === k)?.pos !== "coach") && !isCaptain && (
                        <button onClick={() => setLineup(l => ({ ...l, captain_player_id: p.id }))}
                          style={{ background:"rgba(245,158,11,.15)", border:"1px solid rgba(245,158,11,.3)", color:"#FDE68A", fontSize:14, padding:"3px 6px", borderRadius:5, cursor:"pointer" }}>🏅</button>
                      )}
                      {isCaptain && <span style={{ fontSize:11, color:"#FDE68A", fontWeight:700 }}>Капитан</span>}
                    </div>
                  ) : (
                    <div style={{ display:"flex", gap:4, flexShrink:0 }}>
                      <button className="sb" style={{ fontSize:13, padding:"6px 14px", fontWeight:700 }}
                        onClick={() => assignPlayerToLineup(p)}>
                        {activeSlot && ROLES.find(r => r.key === activeSlot)?.pos === p.position ? "→ Сюда" : "Выбрать"}
                      </button>
                      {hasBench && !isBenchSel && (
                        <button onClick={() => {
                          if (usedInKeys.length > 0) { showToast("Нельзя выбрать одного игрока дважды."); return; }
                          setLineup(l => ({ ...l, bench_player_id: p.id }));
                        }}
                          style={{ background:"rgba(245,158,11,.12)", border:"1px solid rgba(245,158,11,.25)", color:"#FDE68A", fontFamily:"Barlow Condensed,sans-serif", fontSize:14, fontWeight:700, padding:"4px 8px", borderRadius:5, cursor:"pointer" }}>🪑</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
// FFC CUP VIEW
// ══════════════════════════════════════════════

function FfcCupView({ session, profile, showToast, activeRound, isAdmin, onJoin }) {
  const [entries, setEntries] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [myEntry, setMyEntry] = useState(null);
  const [loading, setLoading] = useState(false);
  const token = session?.access_token;
  const uid = session?.user?.id;

  useEffect(() => { if (session) { loadEntries(); loadFixtures(); } }, [session, activeRound]);

  async function loadEntries() {
    const r = await supa("ffc_cup_entries?select=*,profiles(name,club_name)", { token });
    if (r.ok) {
      const d = await r.json();
      setEntries(d);
      setMyEntry(d.find(e => e.user_id === uid) || null);
    }
  }

  async function loadFixtures() {
    if (!activeRound) return;
    const r = await supa(`ffc_fixtures?round_id=eq.${activeRound.id}&mode=eq.cup&select=*`, { token });
    if (r.ok) setFixtures(await r.json());
  }

  async function joinCup() {
    if (!session) { showToast("Войди в аккаунт"); return; }
    setLoading(true);
    await supa("ffc_cup_entries", {
      method: "POST", token,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, round_id: activeRound?.id || null, status: "active" }),
    });
    await loadEntries();
    setLoading(false);
    showToast("✓ Ты в Битве клубов!");
    onJoin?.();
  }

  async function generatePairs() {
    const active = entries.filter(e => e.status === "active");
    if (active.length < 2) { showToast("Нужно минимум 2 участника"); return; }
    const shuffled = [...active].sort(() => Math.random() - 0.5);
    const pairs = [];
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      pairs.push({ round_id: activeRound.id, mode: "cup", user_a_id: shuffled[i].user_id, user_b_id: shuffled[i + 1].user_id, status: "scheduled" });
    }
    if (shuffled.length % 2 !== 0) {
      const bye = shuffled[shuffled.length - 1];
      showToast(`⚡ Нечётное число — ${bye.profiles?.name || "участник"} проходит автоматически (bye)`);
      // Mark as bye winner
      await supa(`ffc_cup_entries?user_id=eq.${bye.user_id}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "active" }),
      });
    }
    for (const p of pairs) {
      await supa("ffc_fixtures", { method: "POST", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(p) });
    }
    await loadFixtures();
    showToast(`✓ Пары тура сгенерированы: ${pairs.length} матчей`);
  }

  const myFixture = fixtures.find(f => f.user_a_id === uid || f.user_b_id === uid);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>⚔ Пары тура</span>
        <span style={{ fontSize: 12, color: "rgba(240,237,230,.4)" }}>{entries.filter(e => e.status === "active").length} участников</span>
      </div>

      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 8 }}>Вознаграждение</div>
        <div style={{ fontSize: 13, color: "#FDE68A" }}>🪙 +50 F-Coins за победу в матче</div>
        <div style={{ fontSize: 13, color: "#FDE68A" }}>🪙 +100 F-Coins за проход раунда</div>
      </div>

      {!myEntry && session && (
        <button className="bp" style={{ width: "100%", marginBottom: 16 }} onClick={joinCup} disabled={loading}>
          {loading ? "..." : "⚽ Участвовать в Битве клубов (бесплатно)"}
        </button>
      )}
      {myEntry && (
        <div style={{ background: myEntry.status === "active" ? "rgba(22,163,74,.08)" : "rgba(185,28,28,.08)", border: `1px solid ${myEntry.status === "active" ? "rgba(22,163,74,.2)" : "rgba(185,28,28,.2)"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {myEntry.status === "active" ? "✅ Ты участвуешь в Битве клубов" : myEntry.status === "eliminated" ? "❌ Ты выбыл" : "🏆 Победитель"}
        </div>
      )}

      {myFixture && (
        <div style={{ background: "rgba(29,78,216,.08)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 10, padding: "14px", marginBottom: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#93C5FD", marginBottom: 8 }}>Твой матч</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14 }}>
            <span style={{ fontWeight: 600, color: myFixture.user_a_id === uid ? "#86EFAC" : "#F0EDE6" }}>Ты</span>
            {myFixture.status === "finished" ? (
              <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700 }}>{myFixture.score_a} : {myFixture.score_b}</span>
            ) : (
              <span style={{ color: "rgba(240,237,230,.3)" }}>vs</span>
            )}
            <span style={{ color: "rgba(240,237,230,.6)" }}>Соперник</span>
          </div>
          {myFixture.status === "finished" && myFixture.winner_id && (
            <div style={{ marginTop: 8, fontSize: 12, color: myFixture.winner_id === uid ? "#86EFAC" : "#FCA5A5" }}>
              {myFixture.winner_id === uid ? "🎉 Победа!" : "Поражение"}
            </div>
          )}
        </div>
      )}

      {/* Список участников */}
      <div className="panel">
        <div className="ph"><span className="pt">Участники</span></div>
        {entries.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: "rgba(240,237,230,.3)" }}>Участников пока нет</div>
        ) : (
          entries.map((e, i) => (
            <div key={e.id} className="lr">
              <span className="rk">{i + 1}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13 }}>{e.profiles?.name || e.user_id?.slice(0, 8)}</div>
                {e.profiles?.club_name && <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{e.profiles.club_name}</div>}
              </div>
              <span style={{ fontSize: 11, color: e.status === "active" ? "#86EFAC" : e.status === "winner" ? "#FDE68A" : "#FCA5A5" }}>
                {e.status === "active" ? "✅ Активен" : e.status === "eliminated" ? "❌ Выбыл" : "🏆"}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Матчи тура */}
      {fixtures.length > 0 && activeRound && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="ph"><span className="pt">Матчи · {activeRound.name}</span></div>
          {fixtures.map((f) => (
            <div key={f.id} className="mr" style={{ padding: "10px 14px" }}>
              <div style={{ flex: 1, fontSize: 13 }}>
                <span style={{ color: "#F0EDE6" }}>{f.user_a_id?.slice(0, 8)}</span>
                <span style={{ margin: "0 8px", color: "rgba(240,237,230,.3)" }}>vs</span>
                <span style={{ color: "rgba(240,237,230,.65)" }}>{f.user_b_id?.slice(0, 8)}</span>
              </div>
              {f.status === "finished" ? (
                <span style={{ fontFamily: "Oswald,sans-serif", color: "#FDE68A" }}>{f.score_a} : {f.score_b}</span>
              ) : (
                <span style={{ fontSize: 11, color: "rgba(240,237,230,.3)" }}>⏳ {f.status}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
// FFC LEAGUE VIEW
// ══════════════════════════════════════════════

function FfcLeagueView({ session, profile, showToast, activeRound, isAdmin, accessLevel, hasLeagueAccess, onJoin }) {
  const [entries, setEntries] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [myEntry, setMyEntry] = useState(null);
  const [loading, setLoading] = useState(false);
  const token = session?.access_token;
  const uid = session?.user?.id;
  // hasLeagueAccess передаётся снаружи (ffc_league_access || FULL || ADMIN)

  useEffect(() => { if (session) { loadEntries(); loadFixtures(); } }, [session, activeRound]);

  async function loadEntries() {
    const r = await supa("ffc_league_entries?select=*,profiles(name,club_name)&order=points.desc,goals_for.desc", { token });
    if (r.ok) {
      const d = await r.json();
      setEntries(d);
      setMyEntry(d.find(e => e.user_id === uid) || null);
    }
  }

  async function loadFixtures() {
    if (!activeRound) return;
    const r = await supa(`ffc_fixtures?round_id=eq.${activeRound.id}&mode=eq.league&select=*`, { token });
    if (r.ok) setFixtures(await r.json());
  }

  async function joinLeague() {
    if (!hasLeagueAccess) {
      // Битва клубов теперь бесплатны — hasLeagueAccess=true для всех авторизованных
    }
    setLoading(true);
    await supa("ffc_league_entries", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, league_name: "FFC Лига 2026", points: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0 }),
    });
    await loadEntries();
    setLoading(false);
    showToast("✓ Ты в таблице клубов!");
    onJoin?.();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>📊 Таблица клубов</span>
        <span style={{ fontSize: 12, color: "rgba(240,237,230,.4)" }}>{entries.length} участников</span>
      </div>

      {/* Таблица клубов — доступна всем */}
      {!myEntry && (
        <button className="bp" style={{ width: "100%", marginBottom: 16 }} onClick={joinLeague} disabled={loading}>
          {loading ? "..." : "📊 Добавиться в таблицу клубов"}
        </button>
      )}
      {myEntry && (
        <div style={{ background: "rgba(22,163,74,.08)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "#86EFAC" }}>✅ Ты в таблице клубов</div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginTop: 4 }}>Очки: {myEntry.points} · И/В/Н/П: {myEntry.wins + myEntry.draws + myEntry.losses}/{myEntry.wins}/{myEntry.draws}/{myEntry.losses}</div>
        </div>
      )}

      {/* Таблица лиги */}
      <div className="panel">
        <div className="ph"><span className="pt">Таблица клубов</span></div>
        {entries.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: "rgba(240,237,230,.3)" }}>Участников пока нет</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ minWidth: 320 }}>
              <thead>
                <tr><th>#</th><th>Клуб</th><th>И</th><th>В</th><th>Н</th><th>П</th><th>Г±</th><th>О</th></tr>
              </thead>
              <tbody>
                {entries.map((e, i) => {
                  const isMe = e.user_id === uid;
                  return (
                    <tr key={e.id} style={{ background: isMe ? "rgba(245,158,11,.05)" : "" }}>
                      <td style={{ fontFamily: "Oswald,sans-serif", color: i === 0 ? "#F59E0B" : i < 3 ? "#86EFAC" : "rgba(240,237,230,.3)" }}>{i + 1}</td>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: isMe ? 700 : 400 }}>{e.profiles?.name || e.user_id?.slice(0, 8)}</div>
                        {e.profiles?.club_name && <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{e.profiles.club_name}</div>}
                      </td>
                      <td>{e.wins + e.draws + e.losses}</td>
                      <td style={{ color: "#86EFAC" }}>{e.wins}</td>
                      <td style={{ color: "#FDE68A" }}>{e.draws}</td>
                      <td style={{ color: "#FCA5A5" }}>{e.losses}</td>
                      <td style={{ fontSize: 11 }}>{e.goals_for}:{e.goals_against}</td>
                      <td style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, color: "#F59E0B" }}>{e.points}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Матчи тура */}
      {fixtures.length > 0 && activeRound && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="ph"><span className="pt">Матчи · {activeRound.name}</span></div>
          {fixtures.map((f) => (
            <div key={f.id} className="mr" style={{ padding: "10px 14px" }}>
              <div style={{ flex: 1, fontSize: 13 }}>
                <span style={{ color: "#F0EDE6" }}>{f.user_a_id?.slice(0, 8)}</span>
                <span style={{ margin: "0 8px", color: "rgba(240,237,230,.3)" }}>vs</span>
                <span style={{ color: "rgba(240,237,230,.65)" }}>{f.user_b_id?.slice(0, 8)}</span>
              </div>
              {f.status === "finished" ? (
                <span style={{ fontFamily: "Oswald,sans-serif", color: "#FDE68A" }}>{f.score_a} : {f.score_b}</span>
              ) : (
                <span style={{ fontSize: 11, color: "rgba(240,237,230,.3)" }}>⏳ scheduled</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════
// FFC SHOP VIEW
// ══════════════════════════════════════════════

function FfcShopView({ session, profile, showToast, activeRound, onProfileUpdated, onClubUpdated }) {
  const [fcoinsHistory, setFcoinsHistory] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [busy, setBusy] = useState(null);
  const [cosmeticEdit, setCosmeticEdit] = useState(null); // null | "club_rename" | "club_city_change" | "club_color_change"
  const [cosmeticValue, setCosmeticValue] = useState("");
  const [savingCosmetic, setSavingCosmetic] = useState(false);
  const token = session?.access_token;
  const uid = session?.user?.id;

  // Only game-relevant items for purchase; cosmetics handled separately
  const SHOP_ITEMS = [
    { id: "bench_player",    icon: "🪑", name: "Скамейка запасных",     price: 500, desc: "Добавь запасного на тур (в зачёт 8 лучших из 9)", needsRound: true },
    { id: "extra_transfer",  icon: "🔄", name: "Доп. замена состава",    price: 300, desc: "Ещё одна замена игрока перед текущим туром",   needsRound: true },
    { id: "scout",           icon: "🔍", name: "Скаут",                  price: 300, desc: "Посмотри популярные выборы игроков этого тура", needsRound: true },
    { id: "hide_lineup",     icon: "🙈", name: "Скрыть состав",          price: 200, desc: "Состав скрыт от соперника до дедлайна",         needsRound: true },
  ];

  const COSMETIC_ITEMS = [
    { id: "club_rename", icon: "✏️", name: "Новое название клуба", price: 200, field: "club_name", placeholder: "Новое название", label: "Название клуба" },
    { id: "club_city_change", icon: "📍", name: "Новый город", price: 100, field: "club_city", placeholder: "Новый город", label: "Город клуба" },
    { id: "club_color_change", icon: "🎨", name: "Новый цвет", price: 150, field: "club_color", placeholder: "#B91C1C", label: "Цвет клуба (hex)" },
  ];

  useEffect(() => {
    if (session) { loadHistory(); loadPurchases(); }
  }, [session]);

  async function loadHistory() {
    const r = await supa(`fcoin_transactions?user_id=eq.${uid}&select=*&order=created_at.desc&limit=30`, { token });
    if (r.ok) setFcoinsHistory(await r.json());
  }

  async function loadPurchases() {
    const r = await supa(`ffc_shop_purchases?user_id=eq.${uid}&select=*&order=created_at.desc`, { token });
    if (r.ok) setPurchases(await r.json());
  }

  async function buyItem(item) {
    if (!session) { showToast("Войди в аккаунт"); return; }
    const balance = profile?.fcoins_balance || 0;
    if (balance < item.price) { showToast(`Не хватает F-Coins. Нужно ${item.price}, у тебя ${balance}`); return; }
    if (item.needsRound && !activeRound) { showToast("Нет активного тура для этой покупки"); return; }

    setBusy(item.id);
    const newBalance = balance - item.price;

    await supa(`profiles?id=eq.${uid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ fcoins_balance: newBalance }),
    });
    await supa("fcoin_transactions", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, amount: item.price, type: "spend", reason: `Покупка: ${item.name}` }),
    });
    await supa("ffc_shop_purchases", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, item_type: item.id, round_id: item.needsRound ? (activeRound?.id || null) : null, price: item.price }),
    });

    await loadHistory();
    await loadPurchases();
    if (onProfileUpdated) onProfileUpdated(newBalance);
    setBusy(null);
    showToast(`✓ Куплено: ${item.name} · -${item.price} 🪙`);
  }

  async function buyAndEditCosmetic(item) {
    if (!session) { showToast("Войди в аккаунт"); return; }
    const balance = profile?.fcoins_balance || 0;
    if (balance < item.price) { showToast(`Не хватает F-Coins. Нужно ${item.price}, у тебя ${balance}`); return; }

    setBusy(item.id);
    const newBalance = balance - item.price;

    await supa(`profiles?id=eq.${uid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ fcoins_balance: newBalance }),
    });
    await supa("fcoin_transactions", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, amount: item.price, type: "spend", reason: `Покупка: ${item.name}` }),
    });
    await supa("ffc_shop_purchases", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, item_type: item.id, round_id: null, price: item.price }),
    });

    await loadHistory();
    await loadPurchases();
    if (onProfileUpdated) onProfileUpdated(newBalance);
    setBusy(null);
    // Open cosmetic edit form immediately after purchase
    setCosmeticValue(profile?.[item.field] || "");
    setCosmeticEdit(item.id);
    showToast(`✓ Куплено! Теперь введи новое значение`);
  }

  async function applyCosmetic(item) {
    if (!cosmeticValue.trim()) { showToast("Введи новое значение"); return; }
    setSavingCosmetic(true);
    const update = { [item.field]: cosmeticValue.trim() };
    await supa(`profiles?id=eq.${uid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify(update),
    });
    if (onClubUpdated) onClubUpdated(update);
    setSavingCosmetic(false);
    setCosmeticEdit(null);
    showToast(`✓ ${item.label} обновлён`);
  }

  const purchasedThisRound = new Set(
    purchases.filter(p => !p.round_id || p.round_id === activeRound?.id).map(p => p.item_type)
  );
  // Cosmetics: last purchase of each type (no round restriction)
  const purchasedCosmetics = new Set(purchases.map(p => p.item_type));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Магазин F-Coins</span>
        <div className="fcoins-badge" style={{ fontSize: 14 }}>🪙 {profile?.fcoins_balance || 0}</div>
      </div>

      {!activeRound && (
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: "rgba(240,237,230,.5)" }}>
          ℹ️ Нет активного тура — товары для тура недоступны. Косметика доступна всегда.
        </div>
      )}

      {/* Игровые товары тура */}
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "rgba(240,237,230,.4)", textTransform: "uppercase", marginBottom: 10 }}>Игровые товары тура</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
        {SHOP_ITEMS.map((item) => {
          const alreadyBought = purchasedThisRound.has(item.id);
          const canAfford = (profile?.fcoins_balance || 0) >= item.price;
          const blocked = item.needsRound && !activeRound;
          return (
            <div key={item.id} style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${alreadyBought ? "rgba(22,163,74,.3)" : "rgba(255,255,255,.08)"}`, borderRadius: 10, padding: "14px 12px", display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>{item.icon}</div>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#F0EDE6", marginBottom: 4 }}>{item.name}</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", flex: 1, marginBottom: 10 }}>{item.desc}</div>
              {alreadyBought ? (
                <div style={{ fontSize: 11, color: "#86EFAC", fontWeight: 600 }}>✓ Куплено на этот тур</div>
              ) : blocked ? (
                <div style={{ fontSize: 11, color: "rgba(240,237,230,.25)" }}>Нет активного тура</div>
              ) : (
                <button disabled={!canAfford || busy === item.id}
                  style={{ background: canAfford ? "rgba(245,158,11,.15)" : "rgba(255,255,255,.05)", border: `1px solid ${canAfford ? "rgba(245,158,11,.3)" : "rgba(255,255,255,.1)"}`, color: canAfford ? "#FDE68A" : "rgba(240,237,230,.3)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, fontWeight: 600, padding: "6px", borderRadius: 4, cursor: canAfford ? "pointer" : "not-allowed" }}
                  onClick={() => buyItem(item)}>
                  {busy === item.id ? "..." : `🪙 ${item.price}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Косметика клуба */}
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 11, fontWeight: 600, letterSpacing: 1, color: "rgba(240,237,230,.4)", textTransform: "uppercase", marginBottom: 10 }}>Кастомизация клуба</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 24 }}>
        {COSMETIC_ITEMS.map((item) => {
          const canAfford = (profile?.fcoins_balance || 0) >= item.price;
          const isEditing = cosmeticEdit === item.id;
          return (
            <div key={item.id} style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${isEditing ? "rgba(29,78,216,.4)" : "rgba(255,255,255,.08)"}`, borderRadius: 10, padding: "14px 12px", display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 24, marginBottom: 6 }}>{item.icon}</div>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#F0EDE6", marginBottom: 4 }}>{item.name}</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", flex: 1, marginBottom: 10 }}>{item.label}: <span style={{ color: "#F0EDE6" }}>{profile?.[item.field] || "—"}</span></div>
              {isEditing ? (
                <div>
                  {item.field === "club_color" ? (
                    <input type="color" value={cosmeticValue || "#B91C1C"} onChange={e => setCosmeticValue(e.target.value)}
                      style={{ width: "100%", height: 32, borderRadius: 4, border: "none", cursor: "pointer", marginBottom: 6 }} />
                  ) : (
                    <input className="inp" placeholder={item.placeholder} value={cosmeticValue} onChange={e => setCosmeticValue(e.target.value)}
                      style={{ marginBottom: 6, fontSize: 12, padding: "6px 8px" }} />
                  )}
                  <div style={{ display: "flex", gap: 4 }}>
                    <button className="bp" style={{ flex: 1, fontSize: 11, padding: "5px" }} onClick={() => applyCosmetic(item)} disabled={savingCosmetic}>
                      {savingCosmetic ? "..." : "Применить"}
                    </button>
                    <button onClick={() => setCosmeticEdit(null)} style={{ background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.4)", borderRadius: 4, padding: "5px 8px", fontSize: 11, cursor: "pointer" }}>✕</button>
                  </div>
                </div>
              ) : (
                <button disabled={!canAfford || busy === item.id}
                  style={{ background: canAfford ? "rgba(245,158,11,.15)" : "rgba(255,255,255,.05)", border: `1px solid ${canAfford ? "rgba(245,158,11,.3)" : "rgba(255,255,255,.1)"}`, color: canAfford ? "#FDE68A" : "rgba(240,237,230,.3)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, fontWeight: 600, padding: "6px", borderRadius: 4, cursor: canAfford ? "pointer" : "not-allowed" }}
                  onClick={() => buyAndEditCosmetic(item)}>
                  {busy === item.id ? "..." : `🪙 ${item.price} · Изменить`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* История транзакций */}
      <div className="panel">
        <div className="ph" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="pt">История F-Coins</span>
          <button className="sb" style={{ fontSize: 11 }} onClick={loadHistory}>Обновить</button>
        </div>
        {fcoinsHistory.length === 0 ? (
          <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: "rgba(240,237,230,.3)" }}>Транзакций пока нет</div>
        ) : (
          <table className="fcoins-history">
            <thead><tr><th>Дата</th><th>За что</th><th>Сумма</th></tr></thead>
            <tbody>
              {fcoinsHistory.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontSize: 10, color: "rgba(240,237,230,.3)", whiteSpace: "nowrap" }}>{new Date(t.created_at).toLocaleDateString("ru")}</td>
                  <td style={{ fontSize: 12, color: "#F0EDE6" }}>{t.reason}</td>
                  <td style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, color: t.type === "spend" ? "#FCA5A5" : "#86EFAC", whiteSpace: "nowrap" }}>
                    {t.type === "spend" ? "−" : "+"}{Math.abs(t.amount)} 🪙
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// ADMIN FFC PANEL
// ══════════════════════════════════════════════

function AdminFfcPanel({ session, showToast, onRoundCreated }) {
  const [ffcTab, setFfcTab] = useState("players");
  const [players, setPlayers] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [cupEntries, setCupEntries] = useState([]);
  const [leagueEntries, setLeagueEntries] = useState([]);
  const [fixtures, setFixtures] = useState([]);
  const [selectedRound, setSelectedRound] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [statsInput, setStatsInput] = useState({});
  const [newPlayer, setNewPlayer] = useState({ name: "", national_team: "", position: "forward", tier: "regular", is_active: true });
  const [csvImport, setCsvImport] = useState({ text: "", preview: [], importing: false });
  const [newRound, setNewRound] = useState({
    name: "", round_no: "", opens_at: "", deadline: "2026-06-11T21:00", status: "upcoming"
  });
  const [busy, setBusy] = useState(false);
  const token = session?.access_token;

  const STAT_FIELDS = [
    ["started", "Вышел в старте", "checkbox"],
    ["goals", "Голы", "number"],
    ["assists", "Ассисты", "number"],
    ["yellow_cards", "Жёлтые", "number"],
    ["red_cards", "Красные", "number"],
    ["clean_sheet", "Сухой матч", "checkbox"],
    ["team_win", "Победа команды", "checkbox"],
    ["team_draw", "Ничья", "checkbox"],
    ["team_advanced", "Прошли дальше", "checkbox"],
    ["penalty_saved", "Отбитые пенальти (осн.вр.)", "number"],
    ["penalty_missed", "Незабитые пенальти (осн.вр.)", "number"],
    ["goals_conceded", "Пропущенные голы", "number"],
    ["shootout_won", "Серия пен: победа", "checkbox"],
    ["shootout_penalties_saved", "Пен. отбито в серии", "number"],
    ["shootout_decisive_save", "Решающий сейв", "checkbox"],
    ["shootout_penalties_scored", "Пен. забито в серии", "number"],
    ["shootout_decisive_penalty_scored", "Решающий забитый", "checkbox"],
    ["shootout_penalties_missed", "Пен. промахи в серии", "number"],
  ];

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    const [pr, ro, ce, le] = await Promise.all([
      supa("ffc_players?select=*&order=name.asc", { token }),
      supa("ffc_rounds?select=*&order=created_at.desc", { token }),
      supa("ffc_cup_entries?select=*,profiles(name)&order=created_at.desc", { token }),
      supa("ffc_league_entries?select=*,profiles(name)&order=points.desc", { token }),
    ]);
    if (pr.ok) setPlayers(await pr.json());
    if (ro.ok) setRounds(await ro.json());
    if (ce.ok) setCupEntries(await ce.json());
    if (le.ok) setLeagueEntries(await le.json());
  }

  async function loadFixturesForRound(rid) {
    if (!rid) return;
    const r = await supa(`ffc_fixtures?round_id=eq.${rid}&select=*&order=created_at.asc`, { token });
    if (r.ok) setFixtures(await r.json());
  }

  async function addPlayer() {
    if (!newPlayer.name) { showToast("Введи имя"); return; }
    await supa("ffc_players?on_conflict=name,national_team,position", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(newPlayer),
    });
    await loadAll();
    setNewPlayer({ name: "", national_team: "", position: "forward", tier: "regular", is_active: true });
    showToast("✓ Игрок добавлен");
  }

  async function togglePlayer(id, active) {
    await supa(`ffc_players?id=eq.${id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ is_active: !active }) });
    await loadAll();
  }

  // CSV-импорт игроков
  // Формат: name,national_team,position,tier,is_active
  function parseCsvPlayers(text) {
    const VALID_POS = new Set(["coach", "goalkeeper", "defender", "midfielder", "forward"]);
    const VALID_TIER = new Set(["regular", "star"]);
    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    const rows = [];
    const errors = [];
    lines.forEach((line, idx) => {
      // Пропускаем заголовок
      if (idx === 0 && line.toLowerCase().startsWith("name")) return;
      if (!line) return;
      const parts = line.split(",").map(s => s.trim());
      const [name, national_team, position, tier_raw, is_active_raw] = parts;
      if (!name) return;
      const position_clean = (position || "").toLowerCase();
      if (!VALID_POS.has(position_clean)) {
        errors.push(`Строка ${idx + 1}: неверная позиция "${position}" (${name})`);
        return;
      }
      const tier = VALID_TIER.has((tier_raw || "").toLowerCase()) ? tier_raw.toLowerCase() : "regular";
      const is_active = is_active_raw?.toLowerCase() !== "false";
      rows.push({ name, national_team: national_team || "", position: position_clean, tier, is_active });
    });
    return { rows, errors };
  }

  async function importCsvPlayers() {
    const { rows, errors } = parseCsvPlayers(csvImport.text);
    if (errors.length > 0) {
      showToast("⚠ Ошибки CSV: " + errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} ещё)` : ""));
      return;
    }
    if (rows.length === 0) { showToast("Нет валидных строк для импорта"); return; }
    setCsvImport(s => ({ ...s, importing: true }));
    // Upsert по уникальному индексу (name, national_team, position)
    await supa("ffc_players?on_conflict=name,national_team,position", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    await loadAll();
    setCsvImport({ text: "", preview: [], importing: false });
    showToast(`✓ Импортировано ${rows.length} игроков`);
  }

  async function addRound() {
    if (!newRound.name || !newRound.deadline) { showToast("Введи название и дедлайн"); return; }
    const roundPayload = {
      name: newRound.name,
      deadline: new Date(newRound.deadline).toISOString(),
      status: newRound.status,
      ...(newRound.opens_at ? { opens_at: new Date(newRound.opens_at).toISOString() } : {}),
      ...(newRound.round_no ? { round_no: Number(newRound.round_no) } : {}),
    };
    const res = await supa("ffc_rounds", {
      method: "POST", token,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(roundPayload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("Create FFC round failed:", res.status, text);
      showToast(`Не удалось создать тур (${res.status}): ${text.slice(0, 150)}`);
      return;
    }
    await loadAll();
    setNewRound({ name: "", deadline: "", status: "upcoming" });
    showToast("✓ Тур создан");
    // Обновляем activeRound в основном приложении
    await onRoundCreated?.();
  }

  async function updateRoundStatus(id, status) {
    await supa(`ffc_rounds?id=eq.${id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status }) });
    await loadAll();
    showToast("✓ Статус тура обновлён");
  }

  async function generateCupPairs(rid) {
    const active = cupEntries.filter(e => e.status === "active");
    if (active.length < 2) { showToast("Нужно минимум 2 участника"); return; }
    // Защита от дублей: проверить, есть ли уже пары
    const existCheck = await supa(`ffc_fixtures?round_id=eq.${rid}&mode=eq.cup&select=id&limit=1`, { token });
    if (existCheck.ok && (await existCheck.json()).length > 0) {
      showToast("⚠ Пары для этого тура уже созданы."); return;
    }
    setBusy(true);
    const shuffled = [...active].sort(() => Math.random() - 0.5);
    // Bye: нечётное число — последний проходит без пары
    let byeUser = null;
    if (shuffled.length % 2 !== 0) {
      byeUser = shuffled[shuffled.length - 1];
    }
    const paired = byeUser ? shuffled.slice(0, -1) : shuffled;
    for (let i = 0; i < paired.length - 1; i += 2) {
      await supa("ffc_fixtures", {
        method: "POST", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ round_id: rid, mode: "cup", user_a_id: paired[i].user_id, user_b_id: paired[i + 1].user_id, status: "scheduled" }),
      });
    }
    await loadFixturesForRound(rid);
    setBusy(false);
    const byeMsg = byeUser ? ` · ${byeUser.profiles?.name || byeUser.profiles?.club_name || byeUser.user_id?.slice(0,8)} проходит автоматически (bye)` : "";
    showToast(`✓ Пары Кубка сгенерированы: ${paired.length / 2} матчей${byeMsg}`);
  }

  async function generateLeaguePairs(rid) {
    if (leagueEntries.length < 2) { showToast("Нужно минимум 2 участника"); return; }
    // Защита от дублей
    const existCheck = await supa(`ffc_fixtures?round_id=eq.${rid}&mode=eq.league&select=id&limit=1`, { token });
    if (existCheck.ok && (await existCheck.json()).length > 0) {
      showToast("⚠ Пары Лиги для этого тура уже созданы."); return;
    }
    setBusy(true);
    const shuffled = [...leagueEntries].sort(() => Math.random() - 0.5);
    for (let i = 0; i < shuffled.length - 1; i += 2) {
      await supa("ffc_fixtures", {
        method: "POST", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ round_id: rid, mode: "league", user_a_id: shuffled[i].user_id, user_b_id: shuffled[i + 1].user_id, status: "scheduled" }),
      });
    }
    await loadFixturesForRound(rid);
    setBusy(false);
    showToast(`✓ Пары Лиги сгенерированы`);
  }

  // Пересчёт таблицы Лиги заново из всех finished матчей (идемпотентно)
  async function recalcLeagueStandings(roundId) {
    const fr = await supa(`ffc_fixtures?round_id=eq.${roundId}&mode=eq.league&status=eq.finished&select=*`, { token });
    if (!fr.ok) return;
    const matches = await fr.json();
    const standings = {};
    const ensure = (uid) => { if (!standings[uid]) standings[uid] = { user_id: uid, points: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0 }; };
    for (const m of matches) {
      ensure(m.user_a_id); ensure(m.user_b_id);
      const a = standings[m.user_a_id]; const b = standings[m.user_b_id];
      a.goals_for += m.score_a || 0; a.goals_against += m.score_b || 0;
      b.goals_for += m.score_b || 0; b.goals_against += m.score_a || 0;
      if (m.winner_id === m.user_a_id) { a.wins++; a.points += 3; b.losses++; }
      else if (m.winner_id === m.user_b_id) { b.wins++; b.points += 3; a.losses++; }
      else { a.draws++; a.points++; b.draws++; b.points++; }
    }
    for (const row of Object.values(standings)) {
      await supa(`ffc_league_entries?user_id=eq.${row.user_id}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ points: row.points, wins: row.wins, draws: row.draws, losses: row.losses, goals_for: row.goals_for, goals_against: row.goals_against }),
      });
    }
  }

  async function recalcFixture(fid) {
    setBusy(true);
    try {
      const fr = await supa(`ffc_fixtures?id=eq.${fid}&select=*`, { token });
      if (!fr.ok) { showToast("Ошибка загрузки матча"); setBusy(false); return; }
      const [fixture] = await fr.json();
      if (!fixture) { showToast("Матч не найден"); setBusy(false); return; }

      // ── ИДЕМПОТЕНТНОСТЬ: блокируем повторные награды если уже finished
      if (fixture.status === "finished") {
        showToast("⚠ Матч уже рассчитан. Повторный пересчёт не начисляет награды.");
        setBusy(false);
        return;
      }

      // Load lineups for both users
      const [la, lb] = await Promise.all([
        supa(`ffc_lineups?round_id=eq.${fixture.round_id}&user_id=eq.${fixture.user_a_id}&select=*`, { token }),
        supa(`ffc_lineups?round_id=eq.${fixture.round_id}&user_id=eq.${fixture.user_b_id}&select=*`, { token }),
      ]);
      const lineupA = la.ok ? (await la.json())[0] : null;
      const lineupB = lb.ok ? (await lb.json())[0] : null;

      const sr = await supa(`ffc_player_stats?round_id=eq.${fixture.round_id}&select=*`, { token });
      const statsArr = sr.ok ? await sr.json() : [];
      const statsMap = Object.fromEntries(statsArr.map(s => [s.player_id, s]));

      const pr = await supa("ffc_players?select=*", { token });
      const playersArr = pr.ok ? await pr.json() : [];
      const playersMap = Object.fromEntries(playersArr.map(p => [p.id, p]));

      const scoreA = lineupA ? calculateLineupScore(lineupA, statsMap, playersMap).total : 0;
      const scoreB = lineupB ? calculateLineupScore(lineupB, statsMap, playersMap).total : 0;

      let winnerId = null;
      let fixtureStatus = "finished";
      if (scoreA > scoreB) winnerId = fixture.user_a_id;
      else if (scoreB > scoreA) winnerId = fixture.user_b_id;
      else {
        const benchA = lineupA?.bench_player_id ? calculatePlayerFantasyPoints(playersMap[lineupA.bench_player_id]?.position, statsMap[lineupA.bench_player_id]) : 0;
        const benchB = lineupB?.bench_player_id ? calculatePlayerFantasyPoints(playersMap[lineupB.bench_player_id]?.position, statsMap[lineupB.bench_player_id]) : 0;
        if (benchA > benchB) winnerId = fixture.user_a_id;
        else if (benchB > benchA) winnerId = fixture.user_b_id;
        else fixtureStatus = "needs_admin_decision";
      }

      // Update score + status
      await supa(`ffc_fixtures?id=eq.${fid}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ score_a: scoreA, score_b: scoreB, winner_id: winnerId, status: fixtureStatus }),
      });

      // Награды и таблица — только при завершении
      if (fixtureStatus === "finished") {
        if (fixture.mode === "cup") {
          const loserId = winnerId === fixture.user_a_id ? fixture.user_b_id : fixture.user_a_id;
          await supa(`ffc_cup_entries?user_id=eq.${loserId}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "eliminated" }) });
          if (winnerId) {
            await awardFcoinsAdmin(winnerId, 50,  "Победа в Кубке FFC",      token, fid);
            await awardFcoinsAdmin(winnerId, 100, "Проход раунда Кубка FFC", token, fid);
          }
        } else if (fixture.mode === "league") {
          // Пересчёт таблицы ЗАНОВО (не прибавляем поверх — идемпотентно)
          await recalcLeagueStandings(fixture.round_id);
          if (winnerId) await awardFcoinsAdmin(winnerId, 75, "Победа в Лиге FFC", token, fid);
        }
      }

      await loadFixturesForRound(fixture.round_id);
      showToast(`✓ Матч пересчитан: ${scoreA}:${scoreB}${fixtureStatus === "needs_admin_decision" ? " (ничья — нужно решение)" : ""}`);
    } catch (e) {
      showToast("Ошибка: " + e.message);
    }
    setBusy(false);
  }

  // awardFcoinsAdmin — с дедупом по related_fixture_id
  async function awardFcoinsAdmin(userId, amount, reason, token, fixtureId = null) {
    // Проверяем: не начислялось ли уже за этот матч
    if (fixtureId) {
      const dup = await supa(
        `fcoin_transactions?user_id=eq.${userId}&related_fixture_id=eq.${fixtureId}&reason=eq.${encodeURIComponent(reason)}&select=id&limit=1`,
        { token }
      );
      if (dup.ok && (await dup.json()).length > 0) return; // уже начислено
    }
    const pr = await supa(`profiles?id=eq.${userId}&select=fcoins_balance`, { token });
    if (!pr.ok) return;
    const d = await pr.json();
    const cur = d[0]?.fcoins_balance || 0;
    await supa(`profiles?id=eq.${userId}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ fcoins_balance: cur + amount }) });
    await supa("fcoin_transactions", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: userId, amount, type: "earn", reason, related_fixture_id: fixtureId }),
    });
  }

  async function saveStats() {
    if (!selectedRound || !selectedPlayer) { showToast("Выбери тур и игрока"); return; }
    const payload = { round_id: selectedRound, player_id: selectedPlayer, ...statsInput, updated_at: new Date().toISOString() };
    await supa("ffc_player_stats", {
      method: "POST", token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });
    showToast("✓ Статистика сохранена");
  }

  async function addDemoPlayers() {
    const demo = [
      { name: "Didier Deschamps",  national_team: "Франция",    position: "coach",      tier: "regular", is_active: true },
      { name: "Kylian Mbappe",     national_team: "Франция",    position: "forward",    tier: "star",    is_active: true },
      { name: "Lionel Scaloni",    national_team: "Аргентина",  position: "coach",      tier: "regular", is_active: true },
      { name: "Emiliano Martinez", national_team: "Аргентина",  position: "goalkeeper", tier: "star",    is_active: true },
      { name: "Lionel Messi",      national_team: "Аргентина",  position: "forward",    tier: "star",    is_active: true },
      { name: "Jude Bellingham",   national_team: "Англия",     position: "midfielder", tier: "star",    is_active: true },
      { name: "Harry Kane",        national_team: "Англия",     position: "forward",    tier: "star",    is_active: true },
      { name: "Virgil van Dijk",   national_team: "Нидерланды", position: "defender",   tier: "star",    is_active: true },
      { name: "Alisson",           national_team: "Бразилия",   position: "goalkeeper", tier: "star",    is_active: true },
      { name: "Vinicius Junior",   national_team: "Бразилия",   position: "forward",    tier: "star",    is_active: true },
    ];
    await supa("ffc_players?on_conflict=name,national_team,position", {
      method: "POST", token,
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(demo),
    });
    await loadAll();
    showToast("✓ Демо-игроки добавлены (10 игроков, 5 звёзд)");
  }

  return (
    <div>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 600, color: "#93C5FD", marginBottom: 12 }}>FFC — Football Fight Club</div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        {[["players", "Игроки"], ["rounds", "Туры"], ["entries", "Участники"], ["matches", "Матчи"], ["stats", "Статистика"]].map(([k, l]) => (
          <button key={k} className={`tab${ffcTab === k ? " on" : ""}`} style={{ fontSize: 12 }} onClick={() => setFfcTab(k)}>{l}</button>
        ))}
      </div>

      {/* ИГРОКИ */}
      {ffcTab === "players" && (
        <div>
          {/* Форма добавления игрока */}
          <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, marginBottom: 10, color: "#FDE68A" }}>Добавить игрока</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input className="inp" placeholder="Имя" value={newPlayer.name} onChange={e => setNewPlayer(p => ({ ...p, name: e.target.value }))} />
              <input className="inp" placeholder="Сборная" value={newPlayer.national_team} onChange={e => setNewPlayer(p => ({ ...p, national_team: e.target.value }))} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <select value={newPlayer.position} onChange={e => setNewPlayer(p => ({ ...p, position: e.target.value }))}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "8px 10px", outline: "none" }}>
                {[["coach", "Тренер"], ["goalkeeper", "Вратарь"], ["defender", "Защитник"], ["midfielder", "Полузащитник"], ["forward", "Нападающий"]].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <select value={newPlayer.tier || "regular"} onChange={e => setNewPlayer(p => ({ ...p, tier: e.target.value }))}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "8px 10px", outline: "none" }}>
                <option value="regular">Обычный</option>
                <option value="star">⭐ Звезда</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="bp" style={{ flex: 1, fontSize: 12 }} onClick={addPlayer}>Добавить</button>
              <button className="sb" style={{ fontSize: 12 }} onClick={addDemoPlayers}>⚡ Демо-игроки</button>
            </div>
          </div>

          {/* Пояснение is_active */}
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 6, padding: "8px 12px", marginBottom: 14, lineHeight: 1.6 }}>
            <strong style={{ color: "rgba(240,237,230,.5)" }}>is_active</strong> = игрок доступен в игровом пуле. Это не гарантия, что он выйдет в стартовом составе. Травмы, дисквалификации и ротацию участники отслеживают сами.
          </div>

          {/* CSV-импорт */}
          <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, marginBottom: 6, color: "#FDE68A" }}>📥 Массовый импорт игроков (CSV)</div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginBottom: 8, lineHeight: 1.6 }}>
              Формат: <code style={{ background: "rgba(255,255,255,.08)", padding: "1px 4px", borderRadius: 2 }}>name,national_team,position,tier,is_active</code><br />
              Позиция: coach / goalkeeper / defender / midfielder / forward · Tier: regular / star<br />
              Пример: <code style={{ background: "rgba(255,255,255,.08)", padding: "1px 4px", borderRadius: 2 }}>Kylian Mbappe,France,forward,star,true</code>
            </div>
            <textarea value={csvImport.text} onChange={e => setCsvImport(s => ({ ...s, text: e.target.value }))}
              placeholder={"name,national_team,position,tier,is_active\nKylian Mbappe,France,forward,star,true\nMike Maignan,France,goalkeeper,regular,true"}
              style={{ width: "100%", minHeight: 100, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: "8px 10px", outline: "none", resize: "vertical", boxSizing: "border-box", marginBottom: 8 }} />
            <button className="bp" style={{ width: "100%", fontSize: 12 }}
              disabled={!csvImport.text.trim() || csvImport.importing}
              onClick={importCsvPlayers}>
              {csvImport.importing ? "Импортирую..." : "Импортировать"}
            </button>
          </div>

          {/* Список игроков */}
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 8 }}>{players.length} игроков в базе</div>
          <div style={{ display: "grid", gap: 4 }}>
            {players.map((p) => (
              <div key={p.id} className="mr">
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: p.is_active ? "#F0EDE6" : "rgba(240,237,230,.3)" }}>
                    {p.tier === "star" ? "⭐ " : ""}{p.name}
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>
                    {p.national_team} · {p.position} · {p.tier === "star" ? "Звезда" : "Обычный"}
                  </div>
                </div>
                <button onClick={() => togglePlayer(p.id, p.is_active)}
                  style={{ fontSize: 11, background: p.is_active ? "rgba(22,163,74,.15)" : "rgba(255,255,255,.06)", border: `1px solid ${p.is_active ? "rgba(22,163,74,.3)" : "rgba(255,255,255,.1)"}`, color: p.is_active ? "#86EFAC" : "rgba(240,237,230,.4)", borderRadius: 4, padding: "3px 10px", cursor: "pointer" }}>
                  {p.is_active ? "Активен" : "Скрыт"}
                </button>
              </div>
            ))}
            {players.length === 0 && (
              <div style={{ textAlign: "center", padding: 24, color: "rgba(240,237,230,.3)", fontSize: 13 }}>
                Игроков пока нет — добавь вручную или нажми «⚡ Демо-игроки»
              </div>
            )}
          </div>
        </div>
      )}

      {/* ТУРЫ */}
      {ffcTab === "rounds" && (
        <div>
          <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, marginBottom: 10, color: "#FDE68A" }}>Создать тур</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
              <input className="inp" placeholder="Название (Тур 1 — Группы)" value={newRound.name} onChange={e => setNewRound(p => ({ ...p, name: e.target.value }))} style={{ marginBottom: 0 }} />
              <input className="inp" type="number" placeholder="№ тура (1, 2, 3…)" value={newRound.round_no} onChange={e => setNewRound(p => ({ ...p, round_no: e.target.value }))} style={{ marginBottom: 0 }} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
              <div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 2 }}>Открывается (opens_at)</div>
                <input className="inp" type="datetime-local" value={newRound.opens_at} onChange={e => setNewRound(p => ({ ...p, opens_at: e.target.value }))} style={{ marginBottom: 0 }} />
              </div>
              <div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 2 }}>Дедлайн</div>
                <input className="inp" type="datetime-local" value={newRound.deadline} onChange={e => setNewRound(p => ({ ...p, deadline: e.target.value }))} style={{ marginBottom: 0 }} />
              </div>
            </div>
            <select value={newRound.status} onChange={e => setNewRound(p => ({ ...p, status: e.target.value }))}
              style={{ width: "100%", background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "8px 10px", marginBottom: 8, outline: "none" }}>
              {[["upcoming","Ожидается"],["lineup_open","Открыт для составов"],["locked","Закрыт для выбора"],["scoring","Идёт подсчёт"],["finished","Завершён"]].map(([v,l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginBottom: 8 }}>
              💡 Чтобы пользователи могли выбирать состав — статус должен быть «Открыт для составов» и дедлайн в будущем.
            </div>
            <button className="bp" style={{ width: "100%", fontSize: 12 }} onClick={addRound}>Создать тур</button>
          </div>

          {/* Список туров */}
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, color: "rgba(240,237,230,.4)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Туры</div>
          {rounds.length === 0 ? (
            <div style={{ color: "rgba(240,237,230,.3)", fontSize: 12, padding: "16px", textAlign: "center", background: "rgba(255,255,255,.02)", borderRadius: 8 }}>
              Туры ещё не созданы.
            </div>
          ) : rounds.map((r) => (
            <div key={r.id} className="mr" style={{ marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#F0EDE6" }}>{r.name}</span>
                  {r.status === "lineup_open" && (
                    <span style={{ fontSize: 10, background: "rgba(22,163,74,.2)", border: "1px solid rgba(22,163,74,.4)", borderRadius: 4, padding: "1px 6px", color: "#86EFAC", fontWeight: 700 }}>ОТКРЫТ</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginTop: 2 }}>
                  Дедлайн: {r.deadline ? new Date(r.deadline).toLocaleString("ru") : "—"} · Создан: {r.created_at ? new Date(r.created_at).toLocaleDateString("ru") : "—"}
                </div>
              </div>
              <select value={r.status} onChange={e => updateRoundStatus(r.id, e.target.value)}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#FDE68A", padding: "4px 8px", fontSize: 11, outline: "none", flexShrink: 0 }}>
                {[["upcoming","Ожидается"],["lineup_open","Открыт"],["locked","Закрыт"],["scoring","Подсчёт"],["finished","Завершён"]].map(([v,l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* УЧАСТНИКИ */}
      {ffcTab === "entries" && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 8 }}>Участники Битвы клубов ({cupEntries.length})</div>
          {cupEntries.length > 0 && cupEntries.length % 2 !== 0 && (
            <div style={{ fontSize: 11, color: "#FDE68A", background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 6, padding: "6px 10px", marginBottom: 8 }}>
              ⚠ Нечётное количество участников ({cupEntries.length}) — одному игроку нужен bye (автопроход).
            </div>
          )}
          {cupEntries.map((e) => (
            <div key={e.id} className="mr">
              <div style={{ flex: 1, fontSize: 12 }}>{e.profiles?.name || e.user_id?.slice(0, 8)}</div>
              <span style={{ fontSize: 11, color: e.status === "active" ? "#86EFAC" : "#FCA5A5" }}>{e.status}</span>
            </div>
          ))}
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", margin: "16px 0 8px" }}>Таблица клубов ({leagueEntries.length})</div>
          {leagueEntries.map((e) => (
            <div key={e.id} className="mr">
              <div style={{ flex: 1, fontSize: 12 }}>{e.profiles?.name || e.user_id?.slice(0, 8)}</div>
              <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, color: "#F59E0B" }}>{e.points} оч.</span>
            </div>
          ))}
        </div>
      )}

      {/* МАТЧИ */}
      {ffcTab === "matches" && (
        <div>
          <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select value={selectedRound} onChange={e => { setSelectedRound(e.target.value); loadFixturesForRound(e.target.value); }}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "6px 10px", fontSize: 12, outline: "none" }}>
              <option value="">Выбери тур</option>
              {rounds.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {selectedRound && (
              <>
                <button className="sb" style={{ fontSize: 11 }} disabled={busy} onClick={() => generateCupPairs(selectedRound)}>Пары Кубка</button>
                <button className="sb" style={{ fontSize: 11 }} disabled={busy} onClick={() => generateLeaguePairs(selectedRound)}>Пары Лиги</button>
              </>
            )}
          </div>
          {fixtures.map((f) => (
            <div key={f.id} className="mr" style={{ marginBottom: 4 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: "#F0EDE6" }}>{f.user_a_id?.slice(0, 8)}</span>
                  <span style={{ color: "rgba(240,237,230,.3)", margin: "0 6px" }}>vs</span>
                  <span style={{ color: "rgba(240,237,230,.65)" }}>{f.user_b_id?.slice(0, 8)}</span>
                </div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{f.mode} · {f.status}{f.status === "finished" ? ` · ${f.score_a}:${f.score_b}` : ""}</div>
              </div>
              <button className="mini-btn green" style={{ fontSize: 11 }} disabled={busy} onClick={() => recalcFixture(f.id)}>Пересчитать</button>
            </div>
          ))}
          {fixtures.length === 0 && selectedRound && (
            <div style={{ color: "rgba(240,237,230,.3)", fontSize: 12, padding: 16 }}>Матчей нет — сгенерируй пары</div>
          )}
        </div>
      )}

      {/* СТАТИСТИКА */}
      {ffcTab === "stats" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <select value={selectedRound} onChange={e => setSelectedRound(e.target.value)}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "6px 10px", fontSize: 12, outline: "none" }}>
              <option value="">Тур</option>
              {rounds.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <select value={selectedPlayer} onChange={e => setSelectedPlayer(e.target.value)}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", padding: "6px 10px", fontSize: 12, outline: "none" }}>
              <option value="">Игрок</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name} ({p.position})</option>)}
            </select>
          </div>
          {selectedPlayer && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 12 }}>
              {STAT_FIELDS.map(([key, label, type]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,.03)", borderRadius: 4, padding: "6px 10px" }}>
                  <label style={{ fontSize: 11, color: "rgba(240,237,230,.5)", flex: 1 }}>{label}</label>
                  {type === "checkbox" ? (
                    <input type="checkbox" checked={!!statsInput[key]} onChange={e => setStatsInput(s => ({ ...s, [key]: e.target.checked }))} />
                  ) : (
                    <input type="number" min="0" value={statsInput[key] || 0} onChange={e => setStatsInput(s => ({ ...s, [key]: +e.target.value }))}
                      style={{ width: 48, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#86EFAC", textAlign: "center", padding: "3px 4px", fontSize: 12, outline: "none" }} />
                  )}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="bp" style={{ fontSize: 12 }} onClick={saveStats} disabled={!selectedRound || !selectedPlayer}>Сохранить</button>
            {selectedRound && (
              <button className="sb" style={{ fontSize: 12 }} disabled={busy} onClick={async () => {
                setBusy(true);
                const fr = await supa(`ffc_fixtures?round_id=eq.${selectedRound}&select=*`, { token });
                if (fr.ok) {
                  const fxs = await fr.json();
                  for (const fx of fxs) { await recalcFixture(fx.id); }
                  showToast(`✓ Пересчитано ${fxs.length} матчей`);
                }
                setBusy(false);
              }}>Пересчитать все матчи тура</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ADMIN PANEL ──
function AdminPanel({ session, showToast, discipline, setDiscipline, onLeaderboardRecalc, onToggleLocked, onTogglePublic, predictionsLocked, predictionsPublic, onRejectPayment, onRoundCreated }) {
  const [adminTab, setAdminTab] = useState("payments");
  const [users, setUsers] = useState([]);
  const [payments, setPayments] = useState([]);
  const [officialResults, setOfficialResults] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ffc_official_results") || "{}"); } catch { return {}; }
  });
  // predictionsLocked и predictionsPublic теперь приходят из App через props
  const [resultInputs, setResultInputs] = useState({});
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState(null);
  const [disciplineInputs, setDisciplineInputs] = useState({});
  const token = session?.access_token;

  useEffect(() => { loadUsers(); loadPayments(); }, []);

  async function loadUsers() {
    const r = await supa("profiles?select=*&order=created_at.asc", { token });
    if (r.ok) { const d = await r.json(); setUsers(d); }
  }
  async function loadPayments() {
    const r = await supa("payment_requests?select=*&order=created_at.desc", { token });
    if (r.ok) { const d = await r.json(); setPayments(d); }
  }

  async function confirmPayment(pid, uid, plan) {
    // ── ЗАЩИТА: проверить что оплата ещё не подтверждена ──
    const payCheck = await supa(`payment_requests?id=eq.${pid}&select=status`, { token });
    if (payCheck.ok) {
      const pd = await payCheck.json();
      if (pd[0]?.status === "confirmed") {
        showToast("⚠ Оплата уже подтверждена. F-Coins не начислены повторно."); return;
      }
    }

    let level = ACCESS.PROGNOSTISTA;
    let note = "";
    let friendSlotNote = null;
    let fcoinsAmount = 0;

    if (plan === "prognostista") {
      level = ACCESS.PROGNOSTISTA; fcoinsAmount = 500;
    } else if (plan === "full") {
      // legacy — даём полный доступ и лигу
      level = ACCESS.FULL; fcoinsAmount = 800;
    } else if (plan === "friend") {
      level = ACCESS.PROGNOSTISTA;
      friendSlotNote = "friend_pack:1_of_2";
      note = "Пакет на 2 участия — активировано 1 из 2. Активируй второго участника вручную.";
      fcoinsAmount = 500;
    } else if (plan === "ffc_add") {
      // Дополнительный режим — независимый доступ, не требует Полного ЧМ
      fcoinsAmount = 300;
      // level не меняем через access_level — ставим ffc_league_access отдельно ниже
    }

    await supa(`payment_requests?id=eq.${pid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "confirmed", ...(friendSlotNote ? { comment: friendSlotNote } : {}) }),
    });

    // Обновляем профиль: дополнительный режим — отдельное поле, Полный ЧМ — access_level
    const profilePatch = plan === "ffc_add"
      ? { ffc_league_access: true }
      : { access_level: level, is_paid: true, prediction_status: "submitted" };

    await supa(`profiles?id=eq.${uid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify(profilePatch),
    });

    if (fcoinsAmount > 0) {
      // ── ДЕДУП: проверить, не было ли уже начисления за этот payment_id ──
      const dupCheck = await supa(
        `fcoin_transactions?payment_id=eq.${pid}&type=eq.earn&select=id&limit=1`,
        { token }
      );
      const alreadyAwarded = dupCheck.ok && (await dupCheck.json()).length > 0;

      if (!alreadyAwarded) {
        // Записываем транзакцию с payment_id для дедупа
        await supa("fcoin_transactions", {
          method: "POST", token, headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ user_id: uid, amount: fcoinsAmount, type: "earn", reason: `Покупка тарифа ${plan}`, payment_id: pid }),
        });
        const profResp = await supa(`profiles?id=eq.${uid}&select=fcoins_balance`, { token });
        if (profResp.ok) {
          const current = (await profResp.json())[0]?.fcoins_balance || 0;
          await supa(`profiles?id=eq.${uid}`, {
            method: "PATCH", token, headers: { Prefer: "return=minimal" },
            body: JSON.stringify({ fcoins_balance: current + fcoinsAmount }),
          });
        }
      }

      // Реферальный бонус — только после оплаты, только один раз
      const refResp = await supa(`profiles?id=eq.${uid}&select=referred_by`, { token });
      if (refResp.ok) {
        const referrerId = (await refResp.json())[0]?.referred_by;
        if (referrerId && referrerId !== uid) {
          const dupRef = await supa(
            `fcoin_transactions?user_id=eq.${referrerId}&related_user_id=eq.${uid}&type=eq.earn&reason=like.Реферальный бонус*&select=id&limit=1`,
            { token }
          );
          const alreadyRef = dupRef.ok && (await dupRef.json()).length > 0;
          if (!alreadyRef) {
            const refBonus = plan === "full" ? 600 : 300;
            const refProf = await supa(`profiles?id=eq.${referrerId}&select=fcoins_balance`, { token });
            if (refProf.ok) {
              const refCur = (await refProf.json())[0]?.fcoins_balance || 0;
              await supa(`profiles?id=eq.${referrerId}`, {
                method: "PATCH", token, headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ fcoins_balance: refCur + refBonus }),
              });
              await supa("fcoin_transactions", {
                method: "POST", token, headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ user_id: referrerId, amount: refBonus, type: "earn", reason: "Реферальный бонус: друг оплатил турнир", related_user_id: uid }),
              });
            }
          }
        }
      }
    }

    await loadUsers(); await loadPayments();
    showToast("✓ Оплата подтверждена" + (fcoinsAmount > 0 ? ` · +${fcoinsAmount} F-Coins` : "") + (note ? ` · ${note}` : ""));
  }

  async function rejectPayment(pid, uid) {
    await supa(`payment_requests?id=eq.${pid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "rejected" }) });
    // Возвращаем prediction_status в draft в БД
    if (uid) {
      await supa(`profiles?id=eq.${uid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ prediction_status: "draft" }) });
    }
    await loadPayments();
    // Если отклонили оплату текущего пользователя — сбросить predStatus в App
    if (onRejectPayment) onRejectPayment(uid);
    showToast("Заявка отклонена — прогноз снова доступен для редактирования");
  }

  async function saveOfficial(matchId, status = "draft") {
    const inp = resultInputs[matchId];
    if (!inp || inp.h === undefined || inp.a === undefined) { showToast("Введи счёт"); return; }
    const row = {
      match_id: matchId,
      home_score: +inp.h,
      away_score: +inp.a,
      penalty_winner: inp.pen || null,
      status,
      source: "manual",
      updated_at: new Date().toISOString(),
    };
    // Обновляем локальный state + localStorage как fallback
    const updated = { ...officialResults, [matchId]: row };
    setOfficialResults(updated);
    localStorage.setItem("ffc_official_results", JSON.stringify(updated));
    // Сохраняем в Supabase official_results (доступно всем после сохранения)
    // Таблица: official_results (match_id PK, home_score, away_score, penalty_winner, status, source, updated_at)
    await supa("official_results", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    showToast(status === "confirmed" ? "✓ Результат подтверждён и сохранён" : "Сохранено как черновик");
  }

  function parseCSV() {
    const lines = csvText.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const header = lines[0].split(",").map((h) => h.trim());
    const rows = [];
    const notFound = [];
    lines.slice(1).forEach((line) => {
      const vals = line.split(",").map((v) => v.trim());
      const obj = {};
      header.forEach((h, i) => { obj[h] = vals[i] || ""; });
      const mid = obj.match_id;
      if (!mid) return;
      const inGroup = ALL_GROUP_MATCH_IDS.has(mid);
      const inPlayoff = [...R16, ...R8, ...QF, ...SF, THIRD_MATCH, FINAL_MATCH].find((m) => m.id === mid);
      if (!inGroup && !inPlayoff) { notFound.push(mid); return; }
      rows.push(obj);
    });
    setCsvPreview({ rows, notFound });
  }

  function importCSV(confirm = false) {
    if (!csvPreview) return;
    const updated = { ...officialResults };
    csvPreview.rows.forEach((row) => {
      updated[row.match_id] = {
        home_score: row.home_score !== "" ? +row.home_score : undefined,
        away_score: row.away_score !== "" ? +row.away_score : undefined,
        penalty_winner: row.penalty_winner || null,
        status: confirm ? "confirmed" : (row.status || "draft"),
        source: "import",
        updated_at: new Date().toISOString(),
      };
    });
    setOfficialResults(updated);
    localStorage.setItem("ffc_official_results", JSON.stringify(updated));
    showToast(`✓ Импортировано ${csvPreview.rows.length} результатов${confirm ? " и подтверждено" : ""}`);
    setCsvPreview(null); setCsvText("");
  }

  // Локальный пересчёт лидерборда по officialResults.confirmed
  // Очки за проходы по стадиям
  function scoreStageAdvancement(userPScores, officialResults) {
    // userPScores — это pScores (playoff scores keyed by bracket id)
    // Нам нужен пересчёт по данным официальных результатов
    // В текущей архитектуре используем счёт из playoff predictions
    return 0; // TODO: полная реализация когда есть playoff official_results
  }

  // Подсчёт бонусных очков для одного пользователя
  function calculateBonusPoints(userBonusAnswers, officialBonusAnswers) {
    if (!officialBonusAnswers || !userBonusAnswers) return { total: 0, breakdown: [] };
    let total = 0;
    const breakdown = [];
    BONUS_QS.forEach(q => {
      const official = officialBonusAnswers[q.id];
      if (!official || official.status !== "confirmed") return;
      const user = userBonusAnswers[q.id];
      if (!user) return;
      const officialAns = official.answer;
      let pts = 0, matched = false;

      if (q.id === "top_scorers") {
        // player_multi: очки по месту официального игрока
        const offArr = Array.isArray(officialAns) ? officialAns : [];
        const userArr = Array.isArray(user) ? user.filter(Boolean) : [];
        const rankPts = [q.pts, 5, 3]; // 8/5/3
        offArr.forEach((name, idx) => {
          if (userArr.some(u => u?.toLowerCase() === name?.toLowerCase())) {
            pts += rankPts[idx] || 0;
          }
        });
        matched = pts > 0;
      } else if (q.answerType === "score") {
        const normalize = v => {
          if (typeof v === "string") { const p = v.split(":"); return {h: p[0]?.trim(), a: p[1]?.trim()}; }
          return v;
        };
        const u = normalize(user); const o = normalize(officialAns);
        if (u?.h === o?.h && u?.a === o?.a) { pts = q.pts; matched = true; }
      } else if (q.answerType === "number") {
        if (String(user).trim() === String(officialAns).trim()) { pts = q.pts; matched = true; }
      } else {
        // player, team: строковое сравнение без учёта регистра
        if (String(user || "").toLowerCase().trim() === String(officialAns || "").toLowerCase().trim()) {
          pts = q.pts; matched = true;
        }
      }
      total += pts;
      breakdown.push({ questionId: q.id, points: pts, userAnswer: user, officialAnswer: officialAns, matched });
    });
    return { total, breakdown };
  }

  async function recalcLeaderboard() {
    const confirmedResults = Object.entries(officialResults)
      .filter(([, r]) => r.status === "confirmed")
      .reduce((acc, [mid, r]) => { acc[mid] = r; return acc; }, {});

    if (Object.keys(confirmedResults).length === 0) {
      showToast("Нет подтверждённых результатов для пересчёта");
      return;
    }

    // Загружаем прогнозы
    const pr = await supa("predictions?select=*", { token });
    if (!pr.ok) { showToast("Ошибка загрузки прогнозов"); return; }
    const allPredictions = await pr.json();

    // Загружаем бонусные ответы пользователей
    const br = await supa("bonus_answers?select=*", { token });
    const allBonusAnswers = br.ok ? await br.json() : [];

    // Загружаем официальные бонусные ответы (если таблица существует)
    let officialBonusAnswersMap = {};
    try {
      const obr = await supa("bonus_official_answers?select=*&status=eq.confirmed", { token });
      if (obr.ok) {
        const obData = await obr.json();
        obData.forEach(row => { officialBonusAnswersMap[row.question_id] = row; });
      }
    } catch {}

    // Загружаем профили
    const usersResp = await supa("profiles?select=id,name,prediction_status&order=created_at.asc", { token });
    const userProfiles = usersResp.ok ? await usersResp.json() : [];
    const profileMap = Object.fromEntries(userProfiles.map(u => [u.id, u]));

    // Группируем predictions по user_id
    const byUser = {};
    allPredictions.forEach(p => {
      if (!byUser[p.user_id]) byUser[p.user_id] = {};
      byUser[p.user_id][p.match_id] = { h: p.home_score, a: p.away_score };
    });

    // Группируем bonus_answers по user_id
    const bonusByUser = {};
    allBonusAnswers.forEach(b => {
      if (!bonusByUser[b.user_id]) bonusByUser[b.user_id] = {};
      try {
        bonusByUser[b.user_id][b.question_id] = typeof b.answer === "string" ? JSON.parse(b.answer) : b.answer;
      } catch { bonusByUser[b.user_id][b.question_id] = b.answer; }
    });

    // Считаем очки для submitted пользователей
    const newLeaderboard = Object.entries(byUser)
      .filter(([uid]) => profileMap[uid]?.prediction_status === "submitted")
      .map(([uid, preds]) => {
        let matchPts = 0;
        Object.entries(confirmedResults).forEach(([mid, official]) => {
          const pred = preds[mid];
          if (!pred) return;
          const p = calculateMatchPredictionPoints(pred.h, pred.a, official.home_score, official.away_score);
          if (p !== null) matchPts += p;
        });
        const bonusResult = calculateBonusPoints(bonusByUser[uid] || {}, officialBonusAnswersMap);
        const total = matchPts + bonusResult.total;
        return {
          id: uid,
          name: profileMap[uid]?.name || uid.slice(0, 8),
          total_points: total,
          match_points: matchPts,
          group_match_points: matchPts, // TODO: разделить если нужно
          bonus_points: bonusResult.total,
        };
      })
      .sort((a, b) => b.total_points - a.total_points);

    if (onLeaderboardRecalc) onLeaderboardRecalc(newLeaderboard);

    const lbRows = newLeaderboard.map(row => ({
      id: row.id,
      name: row.name,
      total_points: row.total_points,
      match_points: row.match_points,
      group_match_points: row.group_match_points,
      bonus_points: row.bonus_points,
    }));
    if (lbRows.length) {
      await supa("leaderboard", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(lbRows),
      });
    }
    showToast(`✓ Лидерборд пересчитан: ${newLeaderboard.length} участников`);
  }

  // Настройки с реальными localStorage-флагами, синхронизованными через App state
  function toggleLocked(locked) {
    localStorage.setItem("ffc_predictions_locked", String(locked));
    if (onToggleLocked) onToggleLocked(locked);
    showToast(locked ? "🔒 Приём прогнозов закрыт" : "✓ Приём прогнозов открыт");
  }

  function togglePublic(pub) {
    localStorage.setItem("ffc_predictions_public", String(pub));
    if (onTogglePublic) onTogglePublic(pub);
    showToast(pub ? "✓ Прогнозы участников открыты публично" : "Прогнозы скрыты");
  }

  const settingsButtons = [
    [predictionsLocked ? "✓ Приём закрыт (открыть)" : "Закрыть приём прогнозов 🔒", () => toggleLocked(!predictionsLocked)],
    [predictionsPublic ? "✓ Прогнозы публичны (скрыть)" : "Открыть прогнозы участников", () => togglePublic(!predictionsPublic)],
    ["Пересчитать лидерборд", recalcLeaderboard],
  ];
  const planLabel = { prognostista: "Битва прогнозистов 500₽", ffc_add: "Клуб. битвы (legacy) 300₽", friend: "С другом 800₽ (legacy)", full: "Путь+Лига 800₽ (legacy)" };
  const accessLabel = { [ACCESS.DEMO]: "Черновик", [ACCESS.PROGNOSTISTA]: "Прогнозиста", [ACCESS.FULL]: "Полный", [ACCESS.ADMIN]: "Админ" };
  const accessBadge = { [ACCESS.DEMO]: "badge-demo", [ACCESS.PROGNOSTISTA]: "badge-paid", [ACCESS.FULL]: "badge-full", [ACCESS.ADMIN]: "badge-admin" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Админка</span>
        <span className="tag tr">Только для организатора</span>
      </div>
      <div className="tabs">
        {[["payments", "Заявки"], ["users", "Участники"], ["results", "Результаты"], ["fairplay", "Fair Play"], ["ffc", "⚽ FFC"], ["quiz", "🧠 Квизы"], ["settings", "Настройки"]].map(([k, l]) => (
          <button key={k} className={`tab${adminTab === k ? " on" : ""}`} style={{ minWidth: 80 }} onClick={() => setAdminTab(k)}>{l}</button>
        ))}
      </div>

      {/* ЗАЯВКИ */}
      {adminTab === "payments" && (
        <div className="panel">
          <div className="ph"><span className="pt">Заявки на оплату</span><span className="tag ty">{payments.filter((p) => p.status === "pending").length} ожидают</span></div>
          {payments.length === 0 && <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: "rgba(240,237,230,.3)" }}>Заявок пока нет</div>}
          <table className="admin-table">
            <thead><tr><th>Участник</th><th>Тариф</th><th>Сумма</th><th>Комментарий</th><th>Дата</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontSize: 12, color: "#F0EDE6" }}>{p.user_email || p.user_id?.slice(0, 8)}</td>
                  <td style={{ fontSize: 11 }}>{planLabel[p.plan] || p.plan}{p.plan === "friend" && <span style={{ display: "block", fontSize: 9, color: "#FDE68A", marginTop: 2 }}>📦 Пакет 2 участия</span>}</td>
                  <td style={{ fontFamily: "Oswald,sans-serif", color: "#F59E0B" }}>{p.amount}₽</td>
                  <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.comment === "friend_pack:1_of_2"
                      ? <span style={{ color: "#FDE68A", fontWeight: 600 }}>📦 1 из 2 активировано</span>
                      : p.comment || "—"}
                  </td>
                  <td style={{ fontSize: 10, color: "rgba(240,237,230,.3)" }}>{p.created_at ? new Date(p.created_at).toLocaleDateString("ru") : ""}</td>
                  <td><span style={{ fontSize: 11, fontWeight: 600, color: p.status === "pending" ? "#FDE68A" : p.status === "confirmed" ? "#86EFAC" : "#FCA5A5" }}>{p.status === "pending" ? "⏳ ожидает" : p.status === "confirmed" ? "✓ подтверждён" : "✗ отклонён"}</span></td>
                  <td>
                    {p.status === "pending" && (
                      <div style={{ display: "flex", gap: 4 }}>
                        <button className="mini-btn green" onClick={() => confirmPayment(p.id, p.user_id, p.plan)}>✓ Подтвердить</button>
                        <button className="mini-btn red" onClick={() => rejectPayment(p.id, p.user_id)}>✗</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* УЧАСТНИКИ */}
      {adminTab === "users" && (
        <div className="panel">
          <div className="ph"><span className="pt">Участники</span><span className="tag tg">{users.length} всего</span></div>
          <table className="admin-table">
            <thead><tr><th>Имя</th><th>Email</th><th>Доступ</th><th>Статус прогноза</th><th>Управление</th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontSize: 13, fontWeight: 500, color: "#F0EDE6" }}>{u.name || "—"}</td>
                  <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{u.email}</td>
                  <td><span className={`access-badge ${accessBadge[u.access_level || ACCESS.DEMO]}`}>{accessLabel[u.access_level || ACCESS.DEMO]}</span></td>
                  <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{u.prediction_status || "draft"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="mini-btn green" onClick={async () => {
                        await supa(`profiles?id=eq.${u.id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ access_level: ACCESS.PROGNOSTISTA, is_paid: true, prediction_status: "submitted" }) });
                        await loadUsers(); showToast("✓ Прогнозиста");
                      }}>500₽</button>
                      <button className="mini-btn" style={{ color: "#FDE68A", borderColor: "rgba(245,158,11,.3)" }} onClick={async () => {
                        await supa(`profiles?id=eq.${u.id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ access_level: ACCESS.FULL, is_paid: true }) });
                        await loadUsers(); showToast("✓ Полный");
                      }}>800₽</button>
                      <button className="mini-btn red" onClick={async () => {
                        await supa(`profiles?id=eq.${u.id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ access_level: ACCESS.DEMO, is_paid: false, prediction_status: "draft" }) });
                        await loadUsers(); showToast("Сброс");
                      }}>Сброс</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* РЕЗУЛЬТАТЫ */}
      {adminTab === "results" && (
        <div>
          <div style={{ marginBottom: 14, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: 14 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 600, marginBottom: 10, color: "#FDE68A" }}>Импорт результатов из CSV</div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 8 }}>Формат: match_id,home_score,away_score,penalty_winner,status</div>
            <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)}
              style={{ width: "100%", height: 80, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: 8, outline: "none", resize: "vertical" }}
              placeholder={"match_id,home_score,away_score,penalty_winner,status\nA1,2,1,,confirmed\nA2,0,0,,confirmed"} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="sb" onClick={parseCSV}>Распарсить</button>
              {csvPreview && <><button className="sb" onClick={() => importCSV(false)}>Импорт как черновик</button><button className="bp" style={{ fontSize: 11 }} onClick={() => importCSV(true)}>Импортировать и подтвердить</button></>}
            </div>
            {csvPreview && (
              <div style={{ marginTop: 10, fontSize: 11, color: "rgba(240,237,230,.6)" }}>
                Найдено: {csvPreview.rows.length} матчей.{csvPreview.notFound.length > 0 && <span style={{ color: "#FCA5A5" }}> Не найдены: {csvPreview.notFound.join(", ")}</span>}
              </div>
            )}
          </div>

          {ALL_GROUPS.map((g) => (
            <div key={g} className="panel">
              <div className="ph"><span className="pt">Группа {g}</span></div>
              {GROUP_MATCHES[g].map((m) => {
                const inp = resultInputs[m.id] || {};
                const official = officialResults[m.id];
                return (
                  <div key={m.id} className="mr">
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <span style={{ color: "#F0EDE6" }}>{m.home}</span>
                      <span style={{ color: "rgba(240,237,230,.25)", margin: "0 4px" }}>vs</span>
                      <span style={{ color: "rgba(240,237,230,.65)" }}>{m.away}</span>
                    </div>
                    {official && <span style={{ fontSize: 10, color: official.status === "confirmed" ? "#86EFAC" : "#FDE68A", marginRight: 6 }}>{official.status === "confirmed" ? "✓" : "✏"} {official.home_score}:{official.away_score}</span>}
                    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <input style={{ width: 36, height: 28, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#86EFAC", fontFamily: "Oswald,sans-serif", fontSize: 15, textAlign: "center", outline: "none" }}
                        type="number" min="0" max="20" placeholder="–" defaultValue={inp.h}
                        onChange={(e) => setResultInputs((p) => ({ ...p, [m.id]: { ...p[m.id], h: e.target.value } }))} />
                      <span className="ssep">:</span>
                      <input style={{ width: 36, height: 28, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#86EFAC", fontFamily: "Oswald,sans-serif", fontSize: 15, textAlign: "center", outline: "none" }}
                        type="number" min="0" max="20" placeholder="–" defaultValue={inp.a}
                        onChange={(e) => setResultInputs((p) => ({ ...p, [m.id]: { ...p[m.id], a: e.target.value } }))} />
                      <button className="mini-btn" onClick={() => saveOfficial(m.id, "draft")}>Черн.</button>
                      <button className="mini-btn green" onClick={() => saveOfficial(m.id, "confirmed")}>✓ OK</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {/* ОФИЦИАЛЬНЫЕ ОТВЕТЫ НА БОНУСНЫЕ ВОПРОСЫ */}
          <AdminBonusOfficialAnswers token={token} showToast={showToast} />
        </div>
      )}

      {/* FAIR PLAY */}
      {adminTab === "fairplay" && (
        <div>
          <div style={{ marginBottom: 14, fontSize: 12, color: "rgba(240,237,230,.45)", lineHeight: 1.6 }}>
            Fair Play: желтая (-1) · две желтых/красная (-3) · прямая красная (-4) · желтая+красная (-5)<br />
            Рейтинг FIFA обновлён: {FIFA_RANKINGS.updatedAt}
          </div>
          {ALL_GROUPS.flatMap((g) => GROUPS[g]).map((team) => {
            const d = discipline[team] || {};
            const fp = calcFairPlay(team, discipline);
            return (
              <div key={team} className="mr" style={{ background: "rgba(255,255,255,.02)", marginBottom: 4, borderRadius: 6 }}>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{team}</div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginRight: 8 }}>FIFA: {getFifaRank(team) === 999 ? "?" : getFifaRank(team)}</div>
                <div style={{ fontSize: 11, color: fp < 0 ? "#FCA5A5" : "#86EFAC", marginRight: 10 }}>FP: {fp}</div>
                {[["yellow", "🟡", 1], ["directRed", "🔴", 1], ["secondYellowRed", "2🟡🔴", 1]].map(([key, icon, step]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 3, marginRight: 8 }}>
                    <span style={{ fontSize: 11 }}>{icon}</span>
                    <input type="number" min="0" max="20" value={d[key] || 0}
                      onChange={(e) => {
                        const updated = { ...discipline, [team]: { ...d, [key]: +e.target.value } };
                        setDiscipline(updated);
                        localStorage.setItem("ffc_discipline", JSON.stringify(updated));
                      }}
                      style={{ width: 34, height: 24, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center", fontSize: 12, outline: "none" }} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* FFC */}
      {adminTab === "ffc" && (
        <AdminFfcPanel session={session} showToast={showToast} onRoundCreated={onRoundCreated} />
      )}

      {/* НАСТРОЙКИ */}
      {adminTab === "quiz" && (
        <ErrorBoundary isAdmin={true}>
          <AdminDailyQuizImport token={token} showToast={showToast} isAdmin={true} />
        </ErrorBoundary>
      )}

      {adminTab === "settings" && (
        <div className="panel">
          <div className="ph"><span className="pt">Управление турниром</span></div>
          <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            {settingsButtons.map(([label, fn]) => (
              <button key={label} onClick={fn} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "rgba(240,237,230,.7)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 13, fontWeight: 600, padding: "10px 16px", borderRadius: 4, cursor: "pointer", textAlign: "left" }}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ГЛАВНЫЙ КОМПОНЕНТ ──
// ── FOOTBALL DAILY QUESTION BANK (300 вопросов) ──
// TODO: Позже вынести проверку ответов на сервер/Supabase RPC, чтобы correct_answer не уходил на клиент до завершения.
const FOOTBALL_DAILY_QUESTION_BANK = [{"id":"fb_001","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: каталонский клуб, связанный с Ла Масией и сине-гранатовыми цветами.","options":["Реал Мадрид","Барселона"],"correct_answer":"Барселона","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_002","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: аргентинский №10, легенда Барселоны, чемпион мира-2022.","options":["Криштиану Роналду","Лионель Месси"],"correct_answer":"Лионель Месси","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_003","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: норвежский нападающий, мощный бомбардир Манчестер Сити.","options":["Лионель Месси","Эрлинг Холанд"],"correct_answer":"Эрлинг Холанд","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_004","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: мадридский клуб в белой форме, рекордсмен Лиги чемпионов.","options":["Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_005","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Что получает игрок за вторую жёлтую карточку в одном матче?","options":["Красную карточку","Устное предупреждение"],"correct_answer":"Красную карточку","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_006","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется четыре гола одного игрока в матче?","options":["Хет-трик","Покер"],"correct_answer":"Покер","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_007","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: испанский дирижёр полузащиты Барселоны и сборной Испании.","options":["Лионель Месси","Хави"],"correct_answer":"Хави","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_008","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: туринская Старая синьора.","options":["Реал Мадрид","Ювентус"],"correct_answer":"Ювентус","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_009","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Можно ли забить гол прямо с углового удара?","options":["Да","Нет"],"correct_answer":"Да","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_010","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2006 году?","options":["Италия","Аргентина"],"correct_answer":"Италия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_011","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: амстердамский клуб с сильной академией.","options":["Реал Мадрид","Аякс"],"correct_answer":"Аякс","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_012","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: египетский вингер, звезда Ливерпуля.","options":["Лионель Месси","Мохамед Салах"],"correct_answer":"Мохамед Салах","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_013","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: главный парижский клуб, играет на Парк де Пренс.","options":["ПСЖ","Реал Мадрид"],"correct_answer":"ПСЖ","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_014","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: португальская суперзвезда, играл за МЮ, Реал и Ювентус.","options":["Криштиану Роналду","Лионель Месси"],"correct_answer":"Криштиану Роналду","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_015","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что такое аренда игрока?","options":["Временный переход в другой клуб","Покупка навсегда"],"correct_answer":"Временный переход в другой клуб","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_016","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2022 году?","options":["Аргентина","Бразилия"],"correct_answer":"Аргентина","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_017","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что такое трансфер в футболе?","options":["Замена во время матча","Переход игрока в другой клуб"],"correct_answer":"Переход игрока в другой клуб","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_018","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что означает clean sheet в футболе?","options":["Матч без карточек","Матч без пропущенных голов"],"correct_answer":"Матч без пропущенных голов","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_019","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: уругвайский форвард, играл за Аякс, Ливерпуль и Барселону.","options":["Лионель Месси","Луис Суарес"],"correct_answer":"Луис Суарес","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_020","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: французский форвард, много лет был важным игроком Реала.","options":["Лионель Месси","Карим Бензема"],"correct_answer":"Карим Бензема","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_021","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: хорватский полузащитник, обладатель Золотого мяча-2018.","options":["Лионель Месси","Лука Модрич"],"correct_answer":"Лука Модрич","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_022","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: клуб с Энфилдом и гимном You’ll Never Walk Alone.","options":["Ливерпуль","Реал Мадрид"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_023","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: немецкий клуб с Жёлтой стеной.","options":["Реал Мадрид","Боруссия Дортмунд"],"correct_answer":"Боруссия Дортмунд","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_024","category":"Клубы и страны","question_type":"Клуб → страна","options_count":2,"question":"В какой стране играет клуб Марсель?","options":["Франция","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_025","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: южнокорейский форвард, капитан Тоттенхэма.","options":["Сон Хын Мин","Лионель Месси"],"correct_answer":"Сон Хын Мин","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_026","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: испанский полузащитник, забил победный гол в финале ЧМ-2010.","options":["Андрес Иньеста","Лионель Месси"],"correct_answer":"Андрес Иньеста","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_027","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется три гола одного игрока в матче?","options":["Хет-трик","Дубль"],"correct_answer":"Хет-трик","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_028","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется положение вне игры?","options":["Офсайд","Фол"],"correct_answer":"Офсайд","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_029","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: ивуарийский форвард, герой финала ЛЧ-2012 для Челси.","options":["Лионель Месси","Дидье Дрогба"],"correct_answer":"Дидье Дрогба","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_030","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2010 году?","options":["Аргентина","Испания"],"correct_answer":"Испания","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_031","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что означает ассист?","options":["Удар в створ","Голевая передача"],"correct_answer":"Голевая передача","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_032","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: французский форвард, чемпион мира-2018, известен скоростью.","options":["Лионель Месси","Килиан Мбаппе"],"correct_answer":"Килиан Мбаппе","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_033","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: бельгийский плеймейкер, ключевой игрок Манчестер Сити.","options":["Кевин Де Брёйне","Лионель Месси"],"correct_answer":"Кевин Де Брёйне","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_034","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: польский бомбардир, звезда Боруссии, Баварии и Барселоны.","options":["Лионель Месси","Роберт Левандовский"],"correct_answer":"Роберт Левандовский","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_035","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: португальский клуб со стадионом Драгау.","options":["Реал Мадрид","Порту"],"correct_answer":"Порту","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_036","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: шведский нападающий, играл за Аякс, Интер, Барселону, Милан и ПСЖ.","options":["Лионель Месси","Златан Ибрагимович"],"correct_answer":"Златан Ибрагимович","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_037","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: нерадзурри, один из двух больших клубов Сан-Сиро.","options":["Интер","Реал Мадрид"],"correct_answer":"Интер","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_038","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Какой удар выполняется из угла поля?","options":["Угловой","Пенальти"],"correct_answer":"Угловой","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_039","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Что происходит, если мяч полностью пересёк боковую линию?","options":["Пенальти","Вбрасывание аута"],"correct_answer":"Вбрасывание аута","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_040","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется система видеопомощи арбитрам?","options":["GPS","VAR"],"correct_answer":"VAR","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_041","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется удар с 11-метровой отметки?","options":["Пенальти","Угловой"],"correct_answer":"Пенальти","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_042","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: шотландский клуб, участник дерби Олд Фирм.","options":["Реал Мадрид","Селтик"],"correct_answer":"Селтик","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_043","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: лиссабонский клуб, играет на Да Луж.","options":["Реал Мадрид","Бенфика"],"correct_answer":"Бенфика","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_044","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: бразилец, перешёл из Сантоса в Барселону, затем в ПСЖ.","options":["Лионель Месси","Неймар"],"correct_answer":"Неймар","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_045","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1994 году?","options":["Бразилия","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_046","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1990 году?","options":["Аргентина","Германия"],"correct_answer":"Германия","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_047","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: россонери, один из двух больших клубов Сан-Сиро.","options":["Милан","Реал Мадрид"],"correct_answer":"Милан","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_048","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется матч между принципиальными соперниками из одного города или региона?","options":["Финал","Дерби"],"correct_answer":"Дерби","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_049","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: итальянский реджиста, мастер длинных передач и штрафных.","options":["Андреа Пирло","Лионель Месси"],"correct_answer":"Андреа Пирло","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_050","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: мюнхенский гранд, играет на Альянц Арене.","options":["Бавария","Реал Мадрид"],"correct_answer":"Бавария","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_051","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: нидерландский центральный защитник, лидер обороны Ливерпуля.","options":["Лионель Месси","Вирджил ван Дейк"],"correct_answer":"Вирджил ван Дейк","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_052","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1998 году?","options":["Аргентина","Франция"],"correct_answer":"Франция","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_053","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2014 году?","options":["Аргентина","Германия"],"correct_answer":"Германия","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_054","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Сколько игроков одной команды обычно находится на поле в футболе?","options":["11","10"],"correct_answer":"11","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_055","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1986 году?","options":["Бразилия","Аргентина"],"correct_answer":"Аргентина","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_056","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: английский нападающий, много лет был лидером Тоттенхэма.","options":["Лионель Месси","Гарри Кейн"],"correct_answer":"Гарри Кейн","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_057","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: английский клуб с прозвищем Красные дьяволы.","options":["Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_058","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2002 году?","options":["Бразилия","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_059","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2018 году?","options":["Франция","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_060","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: сенегальский вингер, выигрывал ЛЧ с Ливерпулем.","options":["Садио Мане","Лионель Месси"],"correct_answer":"Садио Мане","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_061","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: камерунский форвард, выигрывал ЛЧ с Барселоной и Интером.","options":["Лионель Месси","Криштиану Роналду","Самуэль Это’О"],"correct_answer":"Самуэль Это’О","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_062","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Палмейрас?","options":["Бразилия","Франция","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_063","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: немецкий атакующий игрок, символ Баварии.","options":["Томас Мюллер","Лионель Месси","Криштиану Роналду"],"correct_answer":"Томас Мюллер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_064","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: итальянский вратарь, чемпион мира-2006.","options":["Джанлуиджи Буффон","Криштиану Роналду","Лионель Месси"],"correct_answer":"Джанлуиджи Буффон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_065","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Фенербахче?","options":["Аргентина","Бразилия","Турция"],"correct_answer":"Турция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_066","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: французский плеймейкер, забил два гола в финале ЧМ-1998.","options":["Лионель Месси","Зинедин Зидан","Криштиану Роналду"],"correct_answer":"Зинедин Зидан","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_067","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2011 году?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_068","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: бразильский волшебник мяча, звезда Барселоны и Милана.","options":["Лионель Месси","Роналдиньо","Криштиану Роналду"],"correct_answer":"Роналдиньо","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_069","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Камп Ноу”?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_070","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":3,"question":"Угадай клуб по подсказке: шотландский клуб, соперник Селтика в Олд Фирм.","options":["Барселона","Рейнджерс","Реал Мадрид"],"correct_answer":"Рейнджерс","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_071","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":3,"question":"Угадай клуб по подсказке: нерадзурри, один из двух больших клубов Сан-Сиро.","options":["Реал Мадрид","Интер","Барселона"],"correct_answer":"Интер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_072","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Аль-Наср?","options":["Аргентина","Саудовская Аравия","Бразилия"],"correct_answer":"Саудовская Аравия","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_073","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: немецкий вратарь, чемпион мира-2014 и мастер игры ногами.","options":["Лионель Месси","Мануэль Нойер","Криштиану Роналду"],"correct_answer":"Мануэль Нойер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_074","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: американский атакующий игрок, выступал в АПЛ.","options":["Клинт Демпси","Лионель Месси","Криштиану Роналду"],"correct_answer":"Клинт Демпси","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_075","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: итальянский защитник, символ Милана.","options":["Криштиану Роналду","Паоло Мальдини","Лионель Месси"],"correct_answer":"Паоло Мальдини","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_076","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Аль-Хиляль?","options":["Аргентина","Бразилия","Саудовская Аравия"],"correct_answer":"Саудовская Аравия","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_077","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: бразильский форвард, чемпион мира-2002, известен как Феномен.","options":["Криштиану Роналду","Лионель Месси","Роналдо Назарио"],"correct_answer":"Роналдо Назарио","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_078","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2010 году?","options":["Интер","Реал Мадрид","Барселона"],"correct_answer":"Интер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_079","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сан-Сиро”?","options":["Реал Мадрид","Милан и Интер","Барселона"],"correct_answer":"Милан и Интер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_080","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: нидерландский нападающий, автор великого гола в финале Евро-1988.","options":["Марко ван Бастен","Криштиану Роналду","Лионель Месси"],"correct_answer":"Марко ван Бастен","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_081","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Шахтёр Донецк?","options":["Аргентина","Украина","Бразилия"],"correct_answer":"Украина","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_082","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2017 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_083","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Бока Хуниорс?","options":["Бразилия","Аргентина","Франция"],"correct_answer":"Аргентина","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_084","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Альянц Арена”?","options":["Бавария","Реал Мадрид","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_085","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Динамо Киев?","options":["Украина","Аргентина","Бразилия"],"correct_answer":"Украина","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_086","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2024 году?","options":["Манчестер Юнайтед","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_087","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Эмирейтс”?","options":["Арсенал","Реал Мадрид","Барселона"],"correct_answer":"Арсенал","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_088","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Ривер Плейт?","options":["Франция","Бразилия","Аргентина"],"correct_answer":"Аргентина","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_089","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Энфилд”?","options":["Барселона","Ливерпуль","Реал Мадрид"],"correct_answer":"Ливерпуль","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_090","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Олимпиакос?","options":["Греция","Бразилия","Аргентина"],"correct_answer":"Греция","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_091","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2015 году?","options":["Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_092","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: французский форвард, легенда Арсенала.","options":["Лионель Месси","Тьерри Анри","Криштиану Роналду"],"correct_answer":"Тьерри Анри","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_093","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2014 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_094","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: турецкий нападающий, легенда Галатасарая и сборной Турции.","options":["Хакан Шюкюр","Лионель Месси","Криштиану Роналду"],"correct_answer":"Хакан Шюкюр","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_095","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сантьяго Бернабеу”?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_096","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: мексиканский защитник, играл за Барселону.","options":["Лионель Месси","Рафаэль Маркес","Криштиану Роналду"],"correct_answer":"Рафаэль Маркес","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_097","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: либерийский нападающий, обладатель Золотого мяча-1995.","options":["Лионель Месси","Криштиану Роналду","Джордж Веа"],"correct_answer":"Джордж Веа","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_098","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2012 году?","options":["Реал Мадрид","Челси","Барселона"],"correct_answer":"Челси","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_099","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: испанский вратарь, капитан чемпионов мира-2010.","options":["Икер Касильяс","Лионель Месси","Криштиану Роналду"],"correct_answer":"Икер Касильяс","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_100","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: хорватский форвард, лучший бомбардир ЧМ-1998.","options":["Давор Шукер","Криштиану Роналду","Лионель Месси"],"correct_answer":"Давор Шукер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_101","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: корейский полузащитник, выигрывал АПЛ с Манчестер Юнайтед.","options":["Пак Чи Сон","Криштиану Роналду","Лионель Месси"],"correct_answer":"Пак Чи Сон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_102","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Лос-Анджелес Гэлакси?","options":["США","Аргентина","Бразилия"],"correct_answer":"США","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_103","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2023 году?","options":["Барселона","Манчестер Сити","Реал Мадрид"],"correct_answer":"Манчестер Сити","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_104","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2018 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_105","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Галатасарай?","options":["Аргентина","Бразилия","Турция"],"correct_answer":"Турция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_106","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Стэмфорд Бридж”?","options":["Барселона","Реал Мадрид","Челси"],"correct_answer":"Челси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_107","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Панатинаикос?","options":["Бразилия","Аргентина","Греция"],"correct_answer":"Греция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_108","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2016 году?","options":["Манчестер Юнайтед","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_109","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":3,"question":"Какую сборную представлял Предраг Миятович?","options":["Бразилия","Аргентина","Черногория"],"correct_answer":"Черногория","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_110","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сигнал Идуна Парк”?","options":["Боруссия Дортмунд","Барселона","Реал Мадрид"],"correct_answer":"Боруссия Дортмунд","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_111","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2013 году?","options":["Бавария","Реал Мадрид","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_112","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: японский фланговый защитник, играл за Интер.","options":["Криштиану Роналду","Юто Нагатомо","Лионель Месси"],"correct_answer":"Юто Нагатомо","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_113","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Парк де Пренс”?","options":["Реал Мадрид","Барселона","ПСЖ"],"correct_answer":"ПСЖ","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_114","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: английский полузащитник, знаменит штрафными и передачами.","options":["Дэвид Бекхэм","Лионель Месси","Криштиану Роналду"],"correct_answer":"Дэвид Бекхэм","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_115","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Олд Траффорд”?","options":["Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_116","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2022 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_117","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2019 году?","options":["Реал Мадрид","Ливерпуль","Барселона"],"correct_answer":"Ливерпуль","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_118","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2021 году?","options":["Барселона","Реал Мадрид","Челси"],"correct_answer":"Челси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_119","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Фламенго?","options":["Аргентина","Франция","Бразилия"],"correct_answer":"Бразилия","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_120","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2020 году?","options":["Реал Мадрид","Бавария","Барселона"],"correct_answer":"Бавария","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_121","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2018 году?","options":["Карим Бензема","Криштиану Роналду","Лука Модрич","Лионель Месси"],"correct_answer":"Лука Модрич","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_122","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2010 году?","options":["Карим Бензема","Лука Модрич","Лионель Месси","Криштиану Роналду"],"correct_answer":"Лионель Месси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_123","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2002 года?","options":["США","Франция","Япония и Южная Корея","Германия"],"correct_answer":"Япония и Южная Корея","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_124","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Петр Чех?","options":["защитник","вратарь","нападающий","полузащитник"],"correct_answer":"вратарь","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_125","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “канонирами”?","options":["Арсенал","Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Арсенал","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_126","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: польский бомбардир, звезда Боруссии, Баварии и Барселоны.","options":["Криштиану Роналду","Роберт Левандовский","Неймар","Лионель Месси"],"correct_answer":"Роберт Левандовский","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_127","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2007 году?","options":["Криштиану Роналду","Кака","Лука Модрич","Лионель Месси"],"correct_answer":"Кака","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_128","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский полузащитник, забил победный гол в финале ЧМ-2010.","options":["Криштиану Роналду","Андрес Иньеста","Лионель Месси","Неймар"],"correct_answer":"Андрес Иньеста","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_129","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “нерадзурри”?","options":["Интер","Барселона","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Интер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_130","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский вратарь, капитан чемпионов мира-2010.","options":["Криштиану Роналду","Икер Касильяс","Лионель Месси","Неймар"],"correct_answer":"Икер Касильяс","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_131","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2005 году?","options":["Роналдиньо","Лионель Месси","Криштиану Роналду","Лука Модрич"],"correct_answer":"Роналдиньо","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_132","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский дирижёр полузащиты Барселоны и сборной Испании.","options":["Криштиану Роналду","Неймар","Хави","Лионель Месси"],"correct_answer":"Хави","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_133","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “россонери”?","options":["Реал Мадрид","Милан","Манчестер Юнайтед","Барселона"],"correct_answer":"Милан","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_134","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2022 году?","options":["Криштиану Роналду","Карим Бензема","Лука Модрич","Лионель Месси"],"correct_answer":"Карим Бензема","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_135","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “сливочными”?","options":["Реал Мадрид","Манчестер Сити","Манчестер Юнайтед","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_136","category":"Культура","question_type":"Фанатская культура","options_count":4,"question":"Какой клуб связан с фразой “You’ll Never Walk Alone”?","options":["Ливерпуль","Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_137","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2023 году?","options":["Карим Бензема","Криштиану Роналду","Лука Модрич","Лионель Месси"],"correct_answer":"Лионель Месси","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_138","category":"Тренеры","question_type":"Тренерский факт","options_count":4,"question":"Кто из тренеров выиграл Лигу чемпионов три раза подряд с Реалом?","options":["Зинедин Зидан","Жозе Моуринью","Пеп Гвардиола","Карло Анчелотти"],"correct_answer":"Зинедин Зидан","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_139","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Лев Яшин?","options":["полузащитник","защитник","вратарь","нападающий"],"correct_answer":"вратарь","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_140","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2013 году?","options":["Лионель Месси","Лука Модрич","Карим Бензема","Криштиану Роналду"],"correct_answer":"Криштиану Роналду","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_141","category":"Тренеры","question_type":"Тренерский факт","options_count":4,"question":"Кто тренировал Манчестер Юнайтед во время эпохи многих титулов АПЛ?","options":["Жозе Моуринью","Алекс Фергюсон","Арсен Венгер","Пеп Гвардиола"],"correct_answer":"Алекс Фергюсон","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_142","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский вратарь, чемпион мира-2006.","options":["Джанлуиджи Буффон","Неймар","Лионель Месси","Криштиану Роналду"],"correct_answer":"Джанлуиджи Буффон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_143","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2009 году?","options":["Лука Модрич","Криштиану Роналду","Лионель Месси","Карим Бензема"],"correct_answer":"Лионель Месси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_144","category":"Рекорды клубов","question_type":"Рекорд","options_count":4,"question":"Какой клуб выиграл АПЛ без поражений в сезоне 2003/04?","options":["Реал Мадрид","Манчестер Юнайтед","Барселона","Арсенал"],"correct_answer":"Арсенал","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_145","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2014 года?","options":["Бразилия","Германия","Франция","США"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_146","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Алан Ширер?","options":["вратарь","защитник","полузащитник","нападающий"],"correct_answer":"нападающий","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_147","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский защитник, символ Милана.","options":["Криштиану Роналду","Неймар","Паоло Мальдини","Лионель Месси"],"correct_answer":"Паоло Мальдини","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_148","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":4,"question":"Какая сборная выиграла ЧМ-2010?","options":["Нидерланды","Бразилия","Испания","Германия"],"correct_answer":"Испания","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_149","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2008 году?","options":["Лука Модрич","Карим Бензема","Лионель Месси","Криштиану Роналду"],"correct_answer":"Криштиану Роналду","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_150","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: бразильский форвард, чемпион мира-2002, известен как Феномен.","options":["Лионель Месси","Криштиану Роналду","Неймар","Роналдо Назарио"],"correct_answer":"Роналдо Назарио","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_151","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Марсело?","options":["защитник","вратарь","полузащитник","нападающий"],"correct_answer":"защитник","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_152","category":"Евро","question_type":"Победитель Евро","options_count":4,"question":"Какая сборная выиграла Евро-2004?","options":["Франция","Португалия","Испания","Греция"],"correct_answer":"Греция","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_153","category":"Термины","question_type":"Термин","options_count":4,"question":"Что означает “финт”?","options":["Только вратарский сейв","Технический обманный приём","Удар от ворот","Вид карточки"],"correct_answer":"Технический обманный приём","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_154","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Франц Беккенбауэр?","options":["полузащитник","защитник","нападающий","вратарь"],"correct_answer":"защитник","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_155","category":"Тактика","question_type":"Тактический термин","options_count":4,"question":"Что такое “прессинг”?","options":["Жеребьёвка групп","Давление на соперника без мяча","Удар с угла поля","Перерыв между таймами"],"correct_answer":"Давление на соперника без мяча","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_156","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: бельгийский плеймейкер, ключевой игрок Манчестер Сити.","options":["Криштиану Роналду","Кевин Де Брёйне","Лионель Месси","Неймар"],"correct_answer":"Кевин Де Брёйне","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_157","category":"Тактика","question_type":"Тактический термин","options_count":4,"question":"Что такое “ложная девятка”?","options":["Нападающий, который часто уходит вглубь поля","Защитник на линии ворот","Второй судья","Запасной вратарь"],"correct_answer":"Нападающий, который часто уходит вглубь поля","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_158","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2006 году?","options":["Лука Модрич","Фабио Каннаваро","Криштиану Роналду","Лионель Месси"],"correct_answer":"Фабио Каннаваро","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_159","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Габриэль Батистута?","options":["нападающий","вратарь","полузащитник","защитник"],"correct_answer":"нападающий","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_160","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2006 года?","options":["Германия","Бразилия","США","Франция"],"correct_answer":"Германия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_161","category":"Тактика","question_type":"Роль игрока","options_count":4,"question":"Что обычно делает опорный полузащитник?","options":["Помогает обороне и начинает атаки","Только подаёт угловые","Только стоит в воротах","Всегда играет последнего защитника"],"correct_answer":"Помогает обороне и начинает атаки","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_162","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: хорватский полузащитник, обладатель Золотого мяча-2018.","options":["Лука Модрич","Лионель Месси","Неймар","Криштиану Роналду"],"correct_answer":"Лука Модрич","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_163","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: немецкий вратарь, чемпион мира-2014 и мастер игры ногами.","options":["Неймар","Лионель Месси","Мануэль Нойер","Криштиану Роналду"],"correct_answer":"Мануэль Нойер","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_164","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2010 года?","options":["Германия","Франция","США","ЮАР"],"correct_answer":"ЮАР","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_165","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2022 года?","options":["Германия","Франция","Катар","США"],"correct_answer":"Катар","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_166","category":"Амплуа","question_type":"Роль игрока","options_count":4,"question":"Что такое “вингер”?","options":["Центральный защитник","Вратарская перчатка","Главный арбитр","Фланговый атакующий игрок"],"correct_answer":"Фланговый атакующий игрок","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_167","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2018 года?","options":["Германия","США","Франция","Россия"],"correct_answer":"Россия","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_168","category":"Термины","question_type":"Термин","options_count":4,"question":"Как называется гол, забитый своей команде?","options":["Сейв","Автогол","Ассист","Дубль"],"correct_answer":"Автогол","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_169","category":"Турниры и термины","question_type":"Термин","options_count":4,"question":"Что означает формат “плей-офф”?","options":["Турнир без финала","Круговая группа","Только товарищеские матчи","Раунд на выбывание"],"correct_answer":"Раунд на выбывание","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_170","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2026 года?","options":["США, Канада и Мексика","США","Германия","Франция"],"correct_answer":"США, Канада и Мексика","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_171","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Серхио Рамос?","options":["полузащитник","нападающий","вратарь","защитник"],"correct_answer":"защитник","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_172","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 1994 года?","options":["Бразилия","Германия","США","Франция"],"correct_answer":"США","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_173","category":"Термины","question_type":"Термин","options_count":4,"question":"Как называется серия без пропущенных мячей у вратаря/команды?","options":["Хет-трик","Сухая серия","Покер","Трансферная сага"],"correct_answer":"Сухая серия","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_174","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Какой турнир выигрывают клубы Южной Америки?","options":["Кубок Либертадорес","Лига Европы","Кубок Азии","Лига чемпионов"],"correct_answer":"Кубок Либертадорес","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_175","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Какой турнир проводят для сборных Южной Америки?","options":["Евро","Кубок Азии","Копа Америка","Золотой кубок КОНКАКАФ"],"correct_answer":"Копа Америка","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_176","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский реджиста, мастер длинных передач и штрафных.","options":["Криштиану Роналду","Неймар","Андреа Пирло","Лионель Месси"],"correct_answer":"Андреа Пирло","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_177","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Фабио Каннаваро?","options":["защитник","полузащитник","вратарь","нападающий"],"correct_answer":"защитник","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_178","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Как называется главный турнир сборных Европы?","options":["Евро","Кубок Азии","Лига чемпионов","Копа Америка"],"correct_answer":"Евро","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_179","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: французский форвард, легенда Арсенала.","options":["Лионель Месси","Криштиану Роналду","Неймар","Тьерри Анри"],"correct_answer":"Тьерри Анри","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_180","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 1998 года?","options":["США","Германия","Бразилия","Франция"],"correct_answer":"Франция","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_181","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: уругвайский форвард, играл за Аякс, Ливерпуль и Барселону.","options":["Луис Суарес","Неймар","Криштиану Роналду","Лионель Месси","Килиан Мбаппе"],"correct_answer":"Луис Суарес","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_182","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Камп Ноу” связан с кем?","options":["Барселона","Ливерпуль","Манчестер Сити","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_183","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Да Луж” связан с кем?","options":["Реал Мадрид","Бенфика","Манчестер Сити","Барселона","Манчестер Юнайтед"],"correct_answer":"Бенфика","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_184","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: хорватский форвард, лучший бомбардир ЧМ-1998.","options":["Килиан Мбаппе","Давор Шукер","Неймар","Криштиану Роналду","Лионель Месси"],"correct_answer":"Давор Шукер","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_185","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Сливочные”?","options":["Реал Мадрид","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_186","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: южнокорейский форвард, капитан Тоттенхэма.","options":["Сон Хын Мин","Килиан Мбаппе","Неймар","Криштиану Роналду","Лионель Месси"],"correct_answer":"Сон Хын Мин","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_187","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: бразилец, перешёл из Сантоса в Барселону, затем в ПСЖ.","options":["Килиан Мбаппе","Криштиану Роналду","Неймар","Лионель Месси","Лука Модрич"],"correct_answer":"Неймар","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_188","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сантьяго Бернабеу” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Ливерпуль","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_189","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Олд Траффорд” связан с кем?","options":["Реал Мадрид","Ливерпуль","Манчестер Юнайтед","Барселона","Манчестер Сити"],"correct_answer":"Манчестер Юнайтед","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_190","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Икер Касильяс.","options":["Аргентина","Бразилия","Германия","Испания","Франция"],"correct_answer":"Испания","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_191","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роналдиньо.","options":["Бразилия","Франция","Германия","Аргентина","Испания"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_192","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роберт Левандовский.","options":["Польша","Франция","Бразилия","Аргентина","Германия"],"correct_answer":"Польша","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_193","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Тьерри Анри.","options":["Франция","Аргентина","Германия","Испания","Бразилия"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_194","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Лука Модрич.","options":["Аргентина","Хорватия","Бразилия","Германия","Франция"],"correct_answer":"Хорватия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_195","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Энфилд” связан с кем?","options":["Ливерпуль","Реал Мадрид","Барселона","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_196","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Самуэль Это’О.","options":["Аргентина","Бразилия","Камерун","Франция","Германия"],"correct_answer":"Камерун","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_197","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сан-Сиро” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Барселона","Милан и Интер","Реал Мадрид"],"correct_answer":"Милан и Интер","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_198","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Карим Бензема.","options":["Аргентина","Франция","Испания","Германия","Бразилия"],"correct_answer":"Франция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_199","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Джанлуиджи Буффон.","options":["Италия","Аргентина","Бразилия","Германия","Франция"],"correct_answer":"Италия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_200","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Хави.","options":["Германия","Аргентина","Испания","Франция","Бразилия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_201","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Эрлинг Холанд.","options":["Норвегия","Аргентина","Франция","Бразилия","Германия"],"correct_answer":"Норвегия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_202","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Кевин Де Брёйне.","options":["Бельгия","Франция","Германия","Аргентина","Бразилия"],"correct_answer":"Бельгия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_203","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Стэмфорд Бридж” связан с кем?","options":["Манчестер Сити","Челси","Барселона","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Челси","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_204","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Клинт Демпси.","options":["Германия","Франция","Бразилия","Аргентина","США"],"correct_answer":"США","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_205","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Олимпико” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Реал Мадрид","Рома и Лацио","Барселона"],"correct_answer":"Рома и Лацио","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_206","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Килиан Мбаппе.","options":["Германия","Бразилия","Аргентина","Испания","Франция"],"correct_answer":"Франция","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_207","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Зинедин Зидан.","options":["Франция","Бразилия","Испания","Германия","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_208","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Хакан Шюкюр.","options":["Аргентина","Германия","Бразилия","Турция","Франция"],"correct_answer":"Турция","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_209","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Марко ван Бастен.","options":["Франция","Аргентина","Бразилия","Германия","Нидерланды"],"correct_answer":"Нидерланды","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_210","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Йохан Кройф Арена” связан с кем?","options":["Манчестер Сити","Аякс","Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Аякс","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_211","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Криштиану Роналду.","options":["Германия","Бразилия","Франция","Аргентина","Португалия"],"correct_answer":"Португалия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_212","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Андрес Иньеста.","options":["Испания","Франция","Германия","Бразилия","Аргентина"],"correct_answer":"Испания","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_213","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Жозе Алваладе” связан с кем?","options":["Спортинг","Барселона","Манчестер Сити","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Спортинг","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_214","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Вирджил ван Дейк.","options":["Нидерланды","Германия","Бразилия","Франция","Аргентина"],"correct_answer":"Нидерланды","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_215","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Златан Ибрагимович.","options":["Германия","Швеция","Франция","Аргентина","Бразилия"],"correct_answer":"Швеция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_216","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роналдо Назарио.","options":["Бразилия","Испания","Франция","Аргентина","Германия"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_217","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Паоло Мальдини.","options":["Бразилия","Франция","Германия","Италия","Аргентина"],"correct_answer":"Италия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_218","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Юто Нагатомо.","options":["Бразилия","Аргентина","Германия","Франция","Япония"],"correct_answer":"Япония","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_219","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Предраг Миятович.","options":["Германия","Черногория","Франция","Бразилия","Аргентина"],"correct_answer":"Черногория","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_220","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Альянц Арена” связан с кем?","options":["Манчестер Юнайтед","Барселона","Бавария","Реал Мадрид","Манчестер Сити"],"correct_answer":"Бавария","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_221","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сигнал Идуна Парк” связан с кем?","options":["Барселона","Реал Мадрид","Боруссия Дортмунд","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Боруссия Дортмунд","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_222","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Пак Чи Сон.","options":["Бразилия","Франция","Южная Корея","Аргентина","Германия"],"correct_answer":"Южная Корея","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_223","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Драгау” связан с кем?","options":["Реал Мадрид","Манчестер Сити","Барселона","Манчестер Юнайтед","Порту"],"correct_answer":"Порту","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_224","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Садио Мане.","options":["Германия","Сенегал","Франция","Аргентина","Бразилия"],"correct_answer":"Сенегал","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_225","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Парк де Пренс” связан с кем?","options":["ПСЖ","Реал Мадрид","Барселона","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"ПСЖ","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_226","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Старая синьора”?","options":["Барселона","Реал Мадрид","Ювентус","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"Ювентус","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_227","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Гарри Кейн.","options":["Бразилия","Англия","Аргентина","Франция","Германия"],"correct_answer":"Англия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_228","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Андреа Пирло.","options":["Франция","Аргентина","Бразилия","Германия","Италия"],"correct_answer":"Италия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_229","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Джордж Веа.","options":["Бразилия","Франция","Либерия","Аргентина","Германия"],"correct_answer":"Либерия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_230","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Мануэль Нойер.","options":["Бразилия","Испания","Германия","Франция","Аргентина"],"correct_answer":"Германия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_231","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Эмирейтс” связан с кем?","options":["Манчестер Сити","Реал Мадрид","Арсенал","Барселона","Манчестер Юнайтед"],"correct_answer":"Арсенал","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_232","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Дэвид Бекхэм.","options":["Франция","Англия","Бразилия","Аргентина","Германия"],"correct_answer":"Англия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_233","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Дидье Дрогба.","options":["Бразилия","Кот-д’Ивуар","Франция","Германия","Аргентина"],"correct_answer":"Кот-д’Ивуар","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_234","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Лионель Месси.","options":["Аргентина","Франция","Испания","Бразилия","Германия"],"correct_answer":"Аргентина","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_235","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Мохамед Салах.","options":["Франция","Бразилия","Египет","Аргентина","Германия"],"correct_answer":"Египет","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_236","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Этихад” связан с кем?","options":["Манчестер Сити","Ливерпуль","Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Манчестер Сити","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_237","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Сине-гранатовые”?","options":["Ливерпуль","Манчестер Юнайтед","Манчестер Сити","Барселона","Реал Мадрид"],"correct_answer":"Барселона","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_238","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Рафаэль Маркес.","options":["Аргентина","Бразилия","Германия","Франция","Мексика"],"correct_answer":"Мексика","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_239","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Томас Мюллер.","options":["Франция","Бразилия","Испания","Аргентина","Германия"],"correct_answer":"Германия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_240","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Красные дьяволы”?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Манчестер Сити","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_241","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Миланское дерби”.","options":["Ливерпуль и Эвертон","Милан и Интер","Манчестер Юнайтед и Манчестер Сити","Реал Мадрид и Барселона","Арсенал и Тоттенхэм","Рома и Лацио"],"correct_answer":"Милан и Интер","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_242","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2006 года.","options":["Испания","Франция","Германия","Бразилия","Аргентина","Италия"],"correct_answer":"Италия","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_243","category":"Правила","question_type":"Ситуация","options_count":6,"question":"В финале после 120 минут счёт равный. Что обычно происходит дальше?","options":["Жеребьёвка","Победа хозяев","Золотой гол автоматически","Серия пенальти","Дополнительная группа","Переигровка через неделю"],"correct_answer":"Серия пенальти","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_244","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2022 года.","options":["Франция","Германия","Испания","Аргентина","Бразилия","Италия"],"correct_answer":"Аргентина","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_245","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2013?","options":["Бавария","Манчестер Юнайтед","Ливерпуль","Реал Мадрид","Манчестер Сити","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_246","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2020?","options":["Испания","Италия","Бразилия","Германия","Аргентина","Франция"],"correct_answer":"Италия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_247","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2021?","options":["Барселона","Манчестер Юнайтед","Челси","Ливерпуль","Манчестер Сити","Реал Мадрид"],"correct_answer":"Челси","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_248","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2008?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Реал Мадрид","Челси","Манчестер Сити"],"correct_answer":"Манчестер Юнайтед","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_249","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2010 года.","options":["Италия","Франция","Испания","Бразилия","Аргентина","Германия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_250","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2002 года.","options":["Бразилия","Франция","Испания","Италия","Аргентина","Германия"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_251","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Вратарь не пропустил ни одного гола за матч. Как это называют?","options":["Дерби","Трансфер","Требл","Сухой матч","Покер","Хет-трик"],"correct_answer":"Сухой матч","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_252","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2019?","options":["Реал Мадрид","Челси","Барселона","Ливерпуль","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"Ливерпуль","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_253","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Игрок отдал пас, после которого партнёр сразу забил гол. Что записывают игроку?","options":["Офсайд","Сейв","Аут","Автогол","Ассист","Пенальти"],"correct_answer":"Ассист","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_254","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-1992?","options":["Франция","Дания","Германия","Бразилия","Испания","Аргентина"],"correct_answer":"Дания","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_255","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1986 года.","options":["Бразилия","Германия","Аргентина","Испания","Франция","Италия"],"correct_answer":"Аргентина","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_256","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2009?","options":["Манчестер Юнайтед","Барселона","Манчестер Сити","Реал Мадрид","Ливерпуль","Челси"],"correct_answer":"Барселона","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_257","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2014?","options":["Манчестер Юнайтед","Манчестер Сити","Реал Мадрид","Барселона","Челси","Ливерпуль"],"correct_answer":"Реал Мадрид","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_258","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2011?","options":["Манчестер Юнайтед","Ливерпуль","Барселона","Манчестер Сити","Реал Мадрид","Челси"],"correct_answer":"Барселона","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_259","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Римское дерби”.","options":["Реал Мадрид и Барселона","Милан и Интер","Арсенал и Тоттенхэм","Ливерпуль и Эвертон","Манчестер Юнайтед и Манчестер Сити","Рома и Лацио"],"correct_answer":"Рома и Лацио","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_260","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2022?","options":["Манчестер Юнайтед","Манчестер Сити","Челси","Реал Мадрид","Ливерпуль","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_261","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2015?","options":["Манчестер Сити","Барселона","Реал Мадрид","Манчестер Юнайтед","Ливерпуль","Челси"],"correct_answer":"Барселона","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_262","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2005?","options":["Челси","Манчестер Сити","Манчестер Юнайтед","Барселона","Реал Мадрид","Ливерпуль"],"correct_answer":"Ливерпуль","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_263","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Манчестерское дерби”.","options":["Реал Мадрид и Барселона","Арсенал и Тоттенхэм","Рома и Лацио","Манчестер Юнайтед и Манчестер Сити","Милан и Интер","Ливерпуль и Эвертон"],"correct_answer":"Манчестер Юнайтед и Манчестер Сити","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_264","category":"Правила","question_type":"Ситуация","options_count":6,"question":"Игрок находится ближе к воротам соперника, чем мяч и предпоследний защитник в момент передачи. О чём речь?","options":["Аут","Голевой удар","Офсайд","Дроп-бол","Угловой","Пенальти"],"correct_answer":"Офсайд","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_265","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1978 года.","options":["Бразилия","Испания","Германия","Италия","Аргентина","Франция"],"correct_answer":"Аргентина","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_266","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Эль-Класико”.","options":["Милан и Интер","Арсенал и Тоттенхэм","Реал Мадрид и Барселона","Рома и Лацио","Манчестер Юнайтед и Манчестер Сити","Ливерпуль и Эвертон"],"correct_answer":"Реал Мадрид и Барселона","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_267","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Форвард забил 2 гола в одном матче. Как это называют?","options":["Ассист","Клиншит","Сухарь","Дубль","Покер","Хет-трик"],"correct_answer":"Дубль","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_268","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-1996?","options":["Италия","Франция","Аргентина","Германия","Бразилия","Испания"],"correct_answer":"Германия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_269","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1930 года.","options":["Уругвай","Франция","Бразилия","Аргентина","Испания","Германия"],"correct_answer":"Уругвай","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_270","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2007?","options":["Барселона","Манчестер Сити","Ливерпуль","Реал Мадрид","Манчестер Юнайтед","Милан"],"correct_answer":"Милан","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_271","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Команда проигрывала 0:2, но выиграла 3:2. Как называют такой поворот?","options":["Камбэк","Офсайд","Дубль","Сухой матч","Ротация","Трансфер"],"correct_answer":"Камбэк","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_272","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2020?","options":["Реал Мадрид","Бавария","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Бавария","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_273","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2014 года.","options":["Франция","Испания","Бразилия","Аргентина","Италия","Германия"],"correct_answer":"Германия","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_274","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2018?","options":["Ливерпуль","Реал Мадрид","Манчестер Юнайтед","Барселона","Челси","Манчестер Сити"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_275","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2017?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Челси","Манчестер Сити","Реал Мадрид"],"correct_answer":"Реал Мадрид","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_276","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2010?","options":["Манчестер Сити","Манчестер Юнайтед","Ливерпуль","Барселона","Реал Мадрид","Интер"],"correct_answer":"Интер","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_277","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1958 года.","options":["Испания","Франция","Бразилия","Германия","Аргентина","Италия"],"correct_answer":"Бразилия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_278","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Защитник случайно отправил мяч в свои ворота. Как называется такой гол?","options":["Сухарь","Офсайд","Требл","Дубль","Автогол","Ассист"],"correct_answer":"Автогол","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_279","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2024?","options":["Манчестер Сити","Ливерпуль","Челси","Реал Мадрид","Манчестер Юнайтед","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_280","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1994 года.","options":["Аргентина","Германия","Испания","Бразилия","Франция","Италия"],"correct_answer":"Бразилия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_281","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2008?","options":["Германия","Франция","Испания","Аргентина","Бразилия","Италия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_282","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1982 года.","options":["Франция","Бразилия","Испания","Италия","Германия","Аргентина"],"correct_answer":"Италия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_283","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1998 года.","options":["Франция","Италия","Испания","Аргентина","Бразилия","Германия"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_284","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2012?","options":["Манчестер Юнайтед","Ливерпуль","Челси","Реал Мадрид","Манчестер Сити","Барселона"],"correct_answer":"Челси","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_285","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2004?","options":["Франция","Германия","Аргентина","Греция","Испания","Бразилия"],"correct_answer":"Греция","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_286","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2000?","options":["Италия","Франция","Бразилия","Аргентина","Испания","Германия"],"correct_answer":"Франция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_287","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2018 года.","options":["Италия","Бразилия","Испания","Германия","Франция","Аргентина"],"correct_answer":"Франция","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_288","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2016?","options":["Бразилия","Франция","Аргентина","Португалия","Испания","Германия"],"correct_answer":"Португалия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_289","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1966 года.","options":["Аргентина","Испания","Англия","Германия","Франция","Бразилия"],"correct_answer":"Англия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_290","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Команда выиграла национальный чемпионат, национальный кубок и Лигу чемпионов за один сезон. Как это называют?","options":["Плей-мейкер","Золотой гол","Требл","Покер","Дубль","Сухарь"],"correct_answer":"Требл","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_291","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1990 года.","options":["Аргентина","Испания","Италия","Бразилия","Германия","Франция"],"correct_answer":"Германия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_292","category":"Ситуации","question_type":"Ситуация","options_count":6,"question":"Вратарь отбил удар, мяч не покинул поле и нападающий добил его в ворота. Что засчитывают?","options":["Всегда офсайд","Угловой без гола","Свободный удар защите","Гол, если не было нарушения","Автоматический пенальти","Жёлтую карточку вратарю"],"correct_answer":"Гол, если не было нарушения","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_293","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Мерсисайдское дерби”.","options":["Ливерпуль и Эвертон","Милан и Интер","Арсенал и Тоттенхэм","Реал Мадрид и Барселона","Манчестер Юнайтед и Манчестер Сити","Рома и Лацио"],"correct_answer":"Ливерпуль и Эвертон","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_294","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2023?","options":["Ливерпуль","Барселона","Челси","Реал Мадрид","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Манчестер Сити","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_295","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2024?","options":["Испания","Германия","Аргентина","Италия","Бразилия","Франция"],"correct_answer":"Испания","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_296","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2006?","options":["Реал Мадрид","Челси","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Барселона","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_297","category":"Турниры","question_type":"Ситуация","options_count":6,"question":"Команда забила больше голов за два матча плей-офф, чем соперник. Что это обычно значит?","options":["Она проходит дальше","Играется третий матч","Матч отменяется","Она получает один бонусный гол","Победителя выбирает капитан","Проходит команда с меньшим рейтингом"],"correct_answer":"Она проходит дальше","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_298","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2012?","options":["Франция","Италия","Бразилия","Испания","Германия","Аргентина"],"correct_answer":"Испания","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_299","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Северолондонское дерби”.","options":["Манчестер Юнайтед и Манчестер Сити","Рома и Лацио","Ливерпуль и Эвертон","Милан и Интер","Реал Мадрид и Барселона","Арсенал и Тоттенхэм"],"correct_answer":"Арсенал и Тоттенхэм","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_300","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2016?","options":["Манчестер Юнайтед","Ливерпуль","Манчестер Сити","Барселона","Челси","Реал Мадрид"],"correct_answer":"Реал Мадрид","correct_key":"6","difficulty":"hard","media_required":false}];

// Простой seeded PRNG (mulberry32)
function seededRandom(seed) {
  let s = seed | 0;
  return function() {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 0xffffffff;
  };
}

// Выбрать n случайных из массива используя seeded rng
function sampleN(arr, n, rng) {
  const pool = [...arr];
  const result = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const idx = Math.floor(rng() * (pool.length - i));
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

// Детерминированно выбрать 10 вопросов дня: 2+2+2+2+2 по options_count
function getDailyFootballQuestions(bank, userId, dateMsk) {
  const seedStr = dateMsk + (userId || "guest");
  let seedNum = 0;
  for (let i = 0; i < seedStr.length; i++) {
    seedNum = (Math.imul(31, seedNum) + seedStr.charCodeAt(i)) | 0;
  }
  const rng = seededRandom(seedNum);
  const result = [];
  for (const cnt of [2, 3, 4, 5, 6]) {
    const pool = bank.filter(q => q.options_count === cnt);
    result.push(...sampleN(pool, 2, rng));
  }
  return result;
}

// ── DailyQuizBlock — ежедневный футбольный квиз из встроенного банка ──
function DailyQuizBlock({ session, showToast }) {
  const [questions, setQuestions] = React.useState([]);
  const [attempt, setAttempt] = React.useState(null);
  const [answers, setAnswers] = React.useState({});
  const [current, setCurrent] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [score, setScore] = React.useState(0);
  const [neurons, setNeurons] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const token = session?.access_token;
  const uid = session?.user?.id;

  // Дата по МСК (UTC+3)
  const dateMsk = React.useMemo(() => {
    return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  }, []);

  React.useEffect(() => { loadState(); }, [session]);

  async function loadState() {
    setLoading(true);
    // 1. Детерминированно генерируем вопросы дня
    const qs = getDailyFootballQuestions(FOOTBALL_DAILY_QUESTION_BANK, uid, dateMsk);
    setQuestions(qs);

    // 2. Проверяем попытку в Supabase (если авторизован)
    if (uid && token) {
      try {
        const ar = await supa(
          `daily_text_quiz_attempts?user_id=eq.${uid}&quiz_date=eq.${dateMsk}&mode=eq.football_bank&select=*&limit=1`,
          { token }
        );
        if (ar.ok) {
          const attData = await ar.json();
          if (attData && attData[0]) {
            const att = attData[0];
            setAttempt(att);
            setScore(att.score);
            setNeurons(att.neurons_earned);
            setDone(true);
          }
        }
      } catch (e) { console.warn("DailyQuizBlock: attempt check failed", e); }
    }
    setLoading(false);
  }

  async function finish() {
    setSaving(true);
    const totalQ = questions.length;
    let correct = 0;
    questions.forEach(q => {
      if (answers[q.id] === q.correct_answer) correct++;
    });
    const bonus = correct === totalQ ? 5 : 0;
    const neuronsEarned = Math.min(correct * 2 + bonus, 25);
    setScore(correct);
    setNeurons(neuronsEarned);

    // Сохранить попытку в Supabase
    if (uid && token) {
      try {
        const body = {
          user_id: uid,
          quiz_date: dateMsk,
          mode: "football_bank",
          question_ids: questions.map(q => q.id),
          answers,
          score: correct,
          neurons_earned: neuronsEarned,
        };
        const r = await supa("daily_text_quiz_attempts", {
          method: "POST", token,
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const saved = await r.json().catch(() => null);
          if (saved && saved[0]) setAttempt(saved[0]);
          // TODO: addNeurons(uid, neuronsEarned, "daily_football_quiz", quiz_date)
          showToast(`⚽ Квиз завершён! +${neuronsEarned} нейронов`);
        } else {
          // Если таблица ещё не создана — показываем результат без ошибки
          showToast(`⚽ Квиз завершён! Результат: ${correct}/${totalQ}`);
        }
      } catch (e) {
        console.warn("DailyQuizBlock: save attempt failed", e);
        showToast(`⚽ Результат: ${correct}/${totalQ}`);
      }
    } else {
      showToast(`⚽ Результат: ${correct}/${totalQ} (войди, чтобы сохранить нейроны)`);
    }
    setDone(true);
    setSaving(false);
  }

  if (loading) return null;

  const totalQ = questions.length;
  const isGuest = !uid;

  // ── Компактный блок-анонс (до нажатия "Играть") ──
  if (!started && !done) {
    return (
      <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.18)", borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span style={{ fontSize: 26, flexShrink: 0 }}>⚽</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#93C5FD", marginBottom: 3 }}>
              Ежедневный футбольный квиз
            </div>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginBottom: 12, lineHeight: 1.5 }}>
              10 вопросов каждый день. От простых 2 вариантов до сложных 6 вариантов. Зарабатывай нейроны.
            </div>
            <button
              className="bp"
              style={{ fontSize: 13, padding: "9px 18px" }}
              onClick={() => { if (isGuest) { showToast("Войди, чтобы сохранить нейроны"); } setStarted(true); }}
            >
              Играть сегодня →
            </button>
            {isGuest && (
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginTop: 6 }}>
                Нейроны начисляются только авторизованным игрокам
              </div>
            )}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#FDE68A" }}>max 25</div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>нейронов</div>
          </div>
        </div>
      </div>
    );
  }

  // ── Результат (квиз уже пройден) ──
  if (done) {
    return (
      <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.18)", borderRadius: 12, padding: "20px 18px", marginBottom: 16, textAlign: "center" }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#93C5FD", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>
          ⚽ Ежедневный футбольный квиз
        </div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 42, fontWeight: 700, color: "#FDE68A", lineHeight: 1 }}>{score}/{totalQ}</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.6)", marginTop: 6, marginBottom: 10 }}>
          {score === totalQ ? "🎉 Идеально! +5 бонусных нейронов" : score >= 7 ? "Отличный результат!" : score >= 5 ? "Неплохо!" : "Попробуй завтра!"}
        </div>
        <div style={{ fontSize: 13, color: "#86EFAC", fontWeight: 600, marginBottom: 4 }}>
          +{neurons} нейронов заработано
        </div>
        <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)" }}>Следующий квиз завтра</div>
      </div>
    );
  }

  // ── Прохождение квиза ──
  const curQ = questions[current];

  return (
    <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.18)", borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
      {/* Заголовок */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>⚽</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#93C5FD" }}>Ежедневный футбольный квиз</div>
          <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>10 вопросов · за нейроны</div>
        </div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, color: "rgba(240,237,230,.4)" }}>
          {current + 1}/{totalQ}
        </div>
      </div>

      {/* Прогресс-бар */}
      <div style={{ height: 3, background: "rgba(255,255,255,.08)", borderRadius: 3, marginBottom: 14 }}>
        <div style={{ height: "100%", width: `${((current + 1) / totalQ) * 100}%`, background: "#3B82F6", borderRadius: 3, transition: "width .2s" }} />
      </div>

      {/* Категория */}
      <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {curQ.category} · {curQ.options_count} вариантов
      </div>

      {/* Вопрос */}
      <div style={{ fontSize: 14, fontWeight: 600, color: "#F0EDE6", marginBottom: 14, lineHeight: 1.5 }}>
        {curQ.question}
      </div>

      {/* Варианты */}
      <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
        {curQ.options.map((opt, i) => {
          const selected = answers[curQ.id] === opt;
          return (
            <button
              key={i}
              onClick={() => setAnswers(a => ({ ...a, [curQ.id]: opt }))}
              style={{
                background: selected ? "rgba(59,130,246,.25)" : "rgba(255,255,255,.05)",
                border: `1px solid ${selected ? "rgba(59,130,246,.7)" : "rgba(255,255,255,.1)"}`,
                color: selected ? "#93C5FD" : "#F0EDE6",
                fontFamily: "Barlow Condensed,sans-serif",
                fontSize: 14, fontWeight: selected ? 700 : 500,
                padding: "10px 14px", borderRadius: 8,
                cursor: "pointer", textAlign: "left", transition: "all .12s",
              }}
            >
              {opt}
            </button>
          );
        })}
      </div>

      {/* Навигация */}
      <div style={{ display: "flex", gap: 8 }}>
        {current > 0 && (
          <button className="sb" style={{ fontSize: 12 }} onClick={() => setCurrent(c => c - 1)}>← Назад</button>
        )}
        {current < totalQ - 1 ? (
          <button
            className="bp"
            style={{ flex: 1, fontSize: 13 }}
            disabled={!answers[curQ.id]}
            onClick={() => setCurrent(c => c + 1)}
          >
            Далее →
          </button>
        ) : (
          <button
            className="bp"
            style={{ flex: 1, fontSize: 13 }}
            disabled={saving || Object.keys(answers).length < totalQ}
            onClick={finish}
          >
            {saving ? "Сохраняю…" : `Завершить (${Object.keys(answers).length}/${totalQ})`}
          </button>
        )}
      </div>
      {Object.keys(answers).length < totalQ && current === totalQ - 1 && (
        <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginTop: 8, textAlign: "center" }}>
          Ответь на все вопросы, чтобы завершить
        </div>
      )}
    </div>
  );
}

// ── PredictorTeamBlock — Командный зачёт внутри Битве прогнозистов ──
function PredictorTeamBlock({ session, profile, isPaid, showToast }) {
  const [myTeam, setMyTeam] = useState(null);
  const [members, setMembers] = useState([]);
  const [allTeams, setAllTeams] = useState([]);
  const [teamName, setTeamName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const token = session?.access_token;
  const uid = session?.user?.id;
  const isPastDeadline = new Date() > TOURNAMENT_DEADLINE;

  useEffect(() => { if (session) load(); }, [session]);

  async function load() {
    setLoaded(false); setError(null);
    try {
      const mr = await supa(`predictor_team_members?user_id=eq.${uid}&select=*,predictor_teams(*)`, { token });
      if (!mr.ok) {
        const txt = await mr.text().catch(() => "");
        if (txt.includes("does not exist") || txt.includes("relation") || mr.status === 404) {
          setError("SQL_NOT_SETUP");
        } else {
          setError(txt.slice(0, 200));
        }
        setLoaded(true); return;
      }
      const mdata = await mr.json();
      if (Array.isArray(mdata) && mdata[0]?.predictor_teams) {
        setMyTeam(mdata[0].predictor_teams);
        const memr = await supa(`predictor_team_members?team_id=eq.${mdata[0].team_id}&select=*,profiles(name,club_name)`, { token });
        if (memr.ok) setMembers(await memr.json());
      } else {
        setMyTeam(null); setMembers([]);
      }
      const tr = await supa("predictor_team_members?select=team_id,predictor_teams(id,name,code),profiles(name,club_name)", { token });
      if (tr.ok) {
        const tdata = await tr.json();
        const teamMap = {};
        for (const row of (Array.isArray(tdata) ? tdata : [])) {
          const t = row.predictor_teams;
          if (!t) continue;
          if (!teamMap[t.id]) teamMap[t.id] = { ...t, memberCount: 0 };
          teamMap[t.id].memberCount++;
        }
        setAllTeams(Object.values(teamMap).sort((a, b) => b.memberCount - a.memberCount));
      }
    } catch (e) {
      setError(String(e?.message || e));
    }
    setLoaded(true);
  }

  function generateCode() {
    return Math.random().toString(36).toUpperCase().slice(2, 8).replace(/[^A-Z0-9]/g, "X").slice(0, 6);
  }

  async function createTeam() {
    if (!teamName.trim()) { showToast("Введи название команды"); return; }
    setLoading(true);
    const code = generateCode();
    const res = await supa("predictor_teams", {
      method: "POST", token,
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name: teamName.trim(), code, owner_id: uid }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      showToast("Не удалось создать команду: " + txt.slice(0, 100));
      setLoading(false); return;
    }
    const [team] = await res.json();
    // Автовступление
    await supa("predictor_team_members", {
      method: "POST", token,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ team_id: team.id, user_id: uid }),
    });
    setTeamName(""); setLoading(false);
    await load();
    showToast("✓ Команда создана!");
  }

  async function joinTeam() {
    const code = joinCode.trim().toUpperCase();
    if (!code) { showToast("Введи код команды"); return; }
    setLoading(true);
    try {
      const tr = await supa(`predictor_teams?code=eq.${code}&select=id,name`, { token });
      if (!tr.ok) {
        const txt = await tr.text().catch(() => "");
        if (txt.includes("does not exist") || txt.includes("relation")) {
          showToast("Командный зачёт пока не настроен. Нужен SQL в Supabase.");
        } else {
          showToast("Ошибка поиска команды: " + txt.slice(0, 80));
        }
        setLoading(false); return;
      }
      const teams = await tr.json();
      if (!teams[0]) { showToast("Команда с таким кодом не найдена"); setLoading(false); return; }
      const team = teams[0];
      const res = await supa("predictor_team_members", {
        method: "POST", token,
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ team_id: team.id, user_id: uid }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        showToast("Не удалось вступить: " + txt.slice(0, 100));
        setLoading(false); return;
      }
      setJoinCode(""); setLoading(false);
      await load();
      showToast(`✓ Ты вступил в команду «${team.name}»!`);
    } catch (e) {
      showToast("Ошибка: " + String(e?.message || e).slice(0, 80));
      setLoading(false);
    }
  }

  async function leaveTeam() {
    if (!window.confirm("Выйти из команды?")) return;
    setLoading(true);
    await supa(`predictor_team_members?user_id=eq.${uid}`, {
      method: "DELETE", token, headers: { Prefer: "return=minimal" },
    });
    setLoading(false);
    await load();
    showToast("Вы вышли из команды");
  }

  if (!isPaid) {
    return (
      <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>🤝 Командный зачёт</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)", marginBottom: 12 }}>Командный зачёт доступен участникам Битве прогнозистов. Соберите команду от 2 человек — в зачёт идёт средний балл участников.</div>
        <button className="bp" style={{ padding: "8px 20px", fontSize: 13 }} onClick={() => {}}>
          Участвовать за 500 ₽
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 10 }}>🤝 Командный зачёт</div>
      <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 12 }}>
        Команды от 2 человек. Рейтинг по среднему баллу участников в Битве прогнозистов.
        Очки появятся после подсчёта прогнозов.
      </div>

      {error === "SQL_NOT_SETUP" && (
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", padding: "10px 14px", background: "rgba(255,255,255,.03)", borderRadius: 8, marginBottom: 12 }}>
          🔧 Командный зачёт пока не настроен. Нужен SQL в Supabase — создать таблицы <code>predictor_teams</code> и <code>predictor_team_members</code>.
        </div>
      )}
      {error && error !== "SQL_NOT_SETUP" && <div style={{ fontSize: 11, color: "#FCA5A5", marginBottom: 8 }}>Ошибка загрузки: {error}</div>}

      {loaded && !myTeam && !isPastDeadline && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#F0EDE6", marginBottom: 8 }}>Создать команду</div>
            <input className="inp" placeholder="Название команды" value={teamName}
              onChange={e => setTeamName(e.target.value)} style={{ marginBottom: 8, fontSize: 12 }} />
            <button className="bp" style={{ width: "100%", fontSize: 12, padding: "7px" }}
              onClick={createTeam} disabled={loading}>{loading ? "..." : "Создать команду"}</button>
          </div>
          <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#F0EDE6", marginBottom: 8 }}>Вступить по коду</div>
            <input className="inp" placeholder="Код команды (6 букв)" value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase().slice(0, 6))} style={{ marginBottom: 8, fontSize: 12 }} />
            <button className="sb" style={{ width: "100%", fontSize: 12, padding: "7px" }}
              onClick={joinTeam} disabled={loading}>{loading ? "..." : "Вступить"}</button>
          </div>
        </div>
      )}

      {isPastDeadline && !myTeam && (
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 12, padding: "8px 12px", background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.15)", borderRadius: 6 }}>
          🔒 Дедлайн прошёл. Командные заявки закрыты.
        </div>
      )}

      {myTeam && (
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6" }}>🤝 {myTeam.name}</div>
            <button onClick={leaveTeam} style={{ background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.3)", fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer" }}>Выйти</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>Код команды</div>
              <div style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#FDE68A", letterSpacing: 2 }}>{myTeam.code}</div>
            </div>
            <button onClick={() => { navigator.clipboard?.writeText(myTeam.code); showToast("Код скопирован!"); }}
              style={{ background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.3)", color: "#FDE68A", fontSize: 11, padding: "4px 10px", borderRadius: 5, cursor: "pointer" }}>
              📋 Скопировать
            </button>
          </div>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 8 }}>Скопируйте код и отправьте друзьям.</div>
          {members.length < 2 && (
            <div style={{ fontSize: 11, color: "#FCA5A5", marginBottom: 6 }}>⚠ Нужно минимум 2 участника для командного зачёта.</div>
          )}
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>Участников: {members.length}</div>
          {members.map(m => (
            <div key={m.id} style={{ fontSize: 11, color: "rgba(240,237,230,.55)", marginTop: 3 }}>
              {m.profiles?.club_name || m.profiles?.name || m.user_id?.slice(0, 8)}
              {m.user_id === uid ? " (вы)" : ""}
            </div>
          ))}
        </div>
      )}

      {/* Таблица команд */}
      {allTeams.length > 0 && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, color: "rgba(240,237,230,.4)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>Таблица команд</div>
          {allTeams.map((t, i) => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: myTeam?.id === t.id ? "rgba(245,158,11,.08)" : "rgba(255,255,255,.03)", border: `1px solid ${myTeam?.id === t.id ? "rgba(245,158,11,.25)" : "rgba(255,255,255,.05)"}`, borderRadius: 6, marginBottom: 4 }}>
              <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "rgba(240,237,230,.3)", minWidth: 20 }}>{i + 1}</span>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#F0EDE6" }}>{t.name}</span>
                <span style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginLeft: 8 }}>{t.memberCount} уч.</span>
              </div>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: t.avgScore > 0 ? "#93C5FD" : "rgba(240,237,230,.25)" }}>
                {t.avgScore > 0 ? `${t.avgScore} оч.` : "—"}
              </div>
            </div>
          ))}
        </div>
      )}
      {loaded && allTeams.length === 0 && (
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.3)", textAlign: "center", padding: "12px" }}>
          Пока нет команд. Создайте первую и пригласите друзей.
        </div>
      )}
    </div>
  );
}

// ── AdminBonusOfficialAnswers — ввод официальных ответов на бонусные вопросы ──
function AdminBonusOfficialAnswers({ token, showToast }) {
  const [answers, setAnswers] = React.useState({});
  const [inputs, setInputs] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [sqlMissing, setSqlMissing] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const r = await supa("bonus_official_answers?select=*", { token });
        if (!r.ok) {
          const txt = await r.text();
          if (txt.includes("does not exist") || r.status === 404) setSqlMissing(true);
          setLoading(false); return;
        }
        const data = await r.json();
        const map = {};
        data.forEach(row => { map[row.question_id] = row; });
        setAnswers(map);
        // Инициализируем inputs из сохранённых данных
        const inp = {};
        data.forEach(row => {
          const ans = row.answer;
          if (Array.isArray(ans)) inp[row.question_id] = ans.join(", ");
          else if (typeof ans === "object" && ans !== null) inp[row.question_id] = JSON.stringify(ans);
          else inp[row.question_id] = String(ans ?? "");
        });
        setInputs(inp);
      } catch { setSqlMissing(true); }
      setLoading(false);
    })();
  }, []);

  async function saveAnswer(qid, status) {
    const rawVal = inputs[qid] ?? "";
    const q = BONUS_QS.find(x => x.id === qid);
    let answer;
    if (q?.answerType === "player_multi") {
      answer = rawVal.split(",").map(x => x.trim()).filter(Boolean);
    } else if (q?.answerType === "number") {
      answer = Number(rawVal) || 0;
    } else {
      answer = rawVal.trim();
    }
    const row = { question_id: qid, answer, status, updated_at: new Date().toISOString() };
    const res = await supa("bonus_official_answers", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    if (res.ok) {
      setAnswers(p => ({ ...p, [qid]: row }));
      showToast(status === "confirmed" ? "✓ Подтверждено" : "✓ Сохранено как черновик");
    } else {
      const txt = await res.text();
      if (txt.includes("does not exist")) { setSqlMissing(true); showToast("Нужен SQL для bonus_official_answers"); }
      else showToast("Ошибка: " + txt.slice(0, 80));
    }
  }

  if (loading) return <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", padding: 12 }}>Загрузка…</div>;

  if (sqlMissing) return (
    <div style={{ background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.15)", borderRadius: 8, padding: 14, marginTop: 12 }}>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#FCA5A5", marginBottom: 8 }}>🔧 Нужен SQL</div>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: "#86EFAC", lineHeight: 1.9 }}>
        CREATE TABLE IF NOT EXISTS public.bonus_official_answers (<br />
        &nbsp;&nbsp;question_id TEXT PRIMARY KEY,<br />
        &nbsp;&nbsp;answer JSONB,<br />
        &nbsp;&nbsp;status TEXT DEFAULT 'draft',<br />
        &nbsp;&nbsp;updated_at TIMESTAMPTZ DEFAULT NOW()<br />
        );<br />
        ALTER TABLE public.bonus_official_answers ENABLE ROW LEVEL SECURITY;<br />
        CREATE POLICY "boa_select" ON public.bonus_official_answers FOR SELECT TO authenticated USING (true);<br />
        CREATE POLICY "boa_insert" ON public.bonus_official_answers FOR INSERT TO authenticated WITH CHECK (true);<br />
        CREATE POLICY "boa_update" ON public.bonus_official_answers FOR UPDATE TO authenticated USING (true);
      </div>
    </div>
  );

  return (
    <div style={{ marginTop: 16 }}>
      <div className="panel">
        <div className="ph"><span className="pt">Официальные ответы на бонусные вопросы</span></div>
        <div style={{ padding: 8 }}>
          {BONUS_QS.map((q) => {
            const saved = answers[q.id];
            const isConfirmed = saved?.status === "confirmed";
            return (
              <div key={q.id} style={{ padding: "10px 6px", borderBottom: "1px solid rgba(255,255,255,.05)", display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: isConfirmed ? "#86EFAC" : "#F0EDE6", marginBottom: 4 }}>
                    {isConfirmed ? "✓ " : ""}{q.text}
                    <span style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginLeft: 6 }}>{q.answerType}</span>
                  </div>
                  {saved && <div style={{ fontSize: 10, color: isConfirmed ? "#86EFAC" : "#FDE68A" }}>
                    {isConfirmed ? "Подтверждено" : "Черновик"}: {Array.isArray(saved.answer) ? saved.answer.join(", ") : String(saved.answer)}
                  </div>}
                </div>
                <div style={{ display: "flex", gap: 5, alignItems: "center", flexShrink: 0 }}>
                  <input
                    value={inputs[q.id] ?? ""}
                    onChange={e => setInputs(p => ({ ...p, [q.id]: e.target.value }))}
                    placeholder={q.answerType === "player_multi" ? "Игрок1, Игрок2, Игрок3" : q.answerType === "score" ? "2:1" : "Ответ"}
                    style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 12, padding: "4px 8px", outline: "none", width: 180 }} />
                  <button className="mini-btn" onClick={() => saveAnswer(q.id, "draft")}>Черн.</button>
                  <button className="mini-btn green" onClick={() => saveAnswer(q.id, "confirmed")}>✓ OK</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── PlayerSearchModal — поиск игрока вместо prompt() ──
function PlayerSearchModal({ onSelect, onClose, excludeNames = [] }) {
  const [query, setQuery] = React.useState("");
  const [players, setPlayers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [manualName, setManualName] = React.useState("");

  React.useEffect(() => {
    (async () => {
      try {
        const r = await supa("ffc_players?select=id,name,national_team,position&is_active=eq.true&order=name.asc");
        if (r.ok) setPlayers(await r.json());
      } catch {}
      setLoading(false);
    })();
  }, []);

  const filtered = query.length > 1
    ? players.filter(p => p.name.toLowerCase().includes(query.toLowerCase()) && !excludeNames.includes(p.name))
    : [];

  return (
    <div className="modal-bg" onClick={e => e.target.className === "modal-bg" && onClose()}>
      <div style={{ background: "#0D2416", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 20, width: "min(480px, 95vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6" }}>Выбрать игрока</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <input autoFocus className="inp" placeholder="Поиск по имени…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ marginBottom: 0, fontSize: 13 }} />
        <div style={{ overflowY: "auto", flex: 1, maxHeight: 340 }}>
          {loading && <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", padding: 8 }}>Загрузка игроков…</div>}
          {!loading && players.length === 0 && (
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 10 }}>
              База игроков не загружена. Введите имя вручную:
            </div>
          )}
          {query.length > 1 && filtered.length === 0 && !loading && (
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", padding: 8 }}>Нет результатов</div>
          )}
          {filtered.map(p => (
            <div key={p.id} onClick={() => { onSelect(p.name); onClose(); }}
              style={{ padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,.05)", cursor: "pointer", borderRadius: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.06)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontSize: 13, color: "#F0EDE6" }}>{p.name}</span>
              <span style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{p.national_team} · {p.position}</span>
            </div>
          ))}
        </div>
        {/* Ручной ввод */}
        <div style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 10 }}>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 6 }}>Или введите вручную:</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="inp" placeholder="Имя игрока" value={manualName}
              onChange={e => setManualName(e.target.value)} style={{ flex: 1, marginBottom: 0, fontSize: 12 }}
              onKeyDown={e => { if (e.key === "Enter" && manualName.trim()) { onSelect(manualName.trim()); onClose(); } }} />
            <button className="bp" style={{ padding: "8px 14px", fontSize: 11 }}
              onClick={() => { if (manualName.trim()) { onSelect(manualName.trim()); onClose(); } }}>
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TeamPickerModal — выбор сборной вместо prompt() ──
function TeamPickerModal({ onSelect, onClose }) {
  const [query, setQuery] = React.useState("");
  const allTeams = ["Аргентина","Франция","Бразилия","Англия","Испания","Германия","Португалия","Нидерланды","Бельгия","Хорватия","Марокко","Сенегал","Япония","США","Мексика","Канада","Австралия","Южная Корея","Швейцария","Норвегия","Австрия","Уругвай","Колумбия","Эквадор","Парагвай","Кот-д'Ивуар","Саудовская Аравия","Катар","Гаити","Шотландия","Кюрасао","Ирландия","Греция","Гана","ЮАР","Кабо-Верде","Алжир","Египет","Тунис","Иран","Иордания","Чехия","Босния и Герцеговина","Ирак","Турция","Новая Зеландия","Узбекистан","Швеция"].sort();
  const filtered = query ? allTeams.filter(t => t.toLowerCase().includes(query.toLowerCase())) : allTeams;
  return (
    <div className="modal-bg" onClick={e => e.target.className === "modal-bg" && onClose()}>
      <div style={{ background: "#0D2416", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 20, width: "min(420px, 95vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6" }}>Выбрать сборную</div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <input autoFocus className="inp" placeholder="Поиск сборной…" value={query}
          onChange={e => setQuery(e.target.value)} style={{ marginBottom: 0, fontSize: 13 }} />
        <div style={{ overflowY: "auto", flex: 1, maxHeight: 380, display: "flex", flexWrap: "wrap", gap: 5 }}>
          {filtered.map(t => (
            <button key={t} className="opt" onClick={() => { onSelect(t); onClose(); }}
              style={{ fontSize: 12 }}>{t}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════
// PPTX QUIZ PARSER
// ══════════════════════════════════════════════════════

// Определение правильного ответа по оранжевому цвету текста
// Наши презентации используют ~#E46C0A и близкие оттенки
function isOrangeColor(colorHex) {
  if (!colorHex) return false;
  const h = colorHex.replace("#", "").toUpperCase();
  if (h.length !== 6) return false;
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  // Оранжевый: высокий R, средний G, низкий B
  return r >= 180 && g >= 80 && g <= 160 && b <= 60 && r > g * 1.4;
}

// Извлечь текстовые блоки из XML слайда с учётом цвета
function extractTextsFromSlideXml(xmlStr) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, "text/xml");
  const paragraphs = doc.querySelectorAll("p");
  const texts = [];
  paragraphs.forEach(para => {
    const runs = para.querySelectorAll("r");
    let paraText = "";
    let paraColor = null;
    runs.forEach(run => {
      const t = run.querySelector("t");
      if (!t) return;
      const txt = t.textContent || "";
      if (!txt.trim()) return;
      // Получить цвет из solidFill/srgbClr
      const srgb = run.querySelector("solidFill srgbClr") || run.querySelector("srgbClr");
      if (srgb && !paraColor) {
        paraColor = srgb.getAttribute("val") || srgb.getAttribute("lastClr");
      }
      paraText += txt;
    });
    if (paraText.trim()) {
      texts.push({ text: paraText.trim(), color: paraColor });
    }
  });
  return texts;
}

// Извлечь варианты ответа из списка текстов
function parseOptions(texts) {
  const optPattern = /^(\d+)[.)]\s*(.+)/;
  const opts = [];
  texts.forEach(({ text, color }) => {
    const m = text.match(optPattern);
    if (m) {
      opts.push({ key: m[1], text: m[2].trim(), color: color || null });
    }
  });
  return opts;
}

// Найти самую большую картинку на слайде
function findMainImageRel(xmlStr, relsXml) {
  // Из XML слайда найти pic элементы
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlStr, "text/xml");
  const pics = doc.querySelectorAll("pic");
  if (!pics.length) return null;

  // Из rels найти файлы картинок
  const relsDoc = relsXml ? parser.parseFromString(relsXml, "text/xml") : null;
  const relMap = {};
  if (relsDoc) {
    relsDoc.querySelectorAll("Relationship").forEach(rel => {
      const type = rel.getAttribute("Type") || "";
      if (type.includes("image")) {
        relMap[rel.getAttribute("Id")] = rel.getAttribute("Target");
      }
    });
  }

  // Найти pic с наибольшей площадью (ext: cx*cy)
  let bestRid = null, bestArea = 0;
  pics.forEach(pic => {
    const blip = pic.querySelector("blip");
    const rid = blip ? (blip.getAttribute("r:embed") || blip.getAttribute("embed")) : null;
    if (!rid) return;
    const xfrm = pic.querySelector("xfrm");
    if (xfrm) {
      const ext = xfrm.querySelector("ext");
      const off = xfrm.querySelector("off");
      const cx = ext ? parseInt(ext.getAttribute("cx") || "0") : 0;
      const cy = ext ? parseInt(ext.getAttribute("cy") || "0") : 0;
      // Игнорируем картинки далеко за пределами слайда (x/y > 10M EMU)
      const x = off ? parseInt(off.getAttribute("x") || "0") : 0;
      const y = off ? parseInt(off.getAttribute("y") || "0") : 0;
      if (Math.abs(x) > 10000000 || Math.abs(y) > 10000000) return;
      const area = cx * cy;
      if (area > bestArea) { bestArea = area; bestRid = rid; }
    } else {
      if (!bestRid) bestRid = rid;
    }
  });

  return bestRid ? relMap[bestRid] : null;
}

async function parsePptxFile(file) {
  const JSZip = (await import("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js").then(m => m.default || window.JSZip).catch(() => window.JSZip));
  if (!JSZip) throw new Error("JSZip не загружен. Подключите через CDN.");

  const zip = await JSZip.loadAsync(file);

  // Получить список слайдов по порядку
  const slideKeys = Object.keys(zip.files)
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)/)[1]);
      const nb = parseInt(b.match(/slide(\d+)/)[1]);
      return na - nb;
    });

  const totalSlides = slideKeys.length;
  const questions = [];

  // Идём по парам: slide1+slide2 = вопрос 1, slide3+slide4 = вопрос 2, ...
  for (let i = 0; i + 1 < totalSlides; i += 2) {
    const qSlideKey = slideKeys[i];
    const aSlideKey = slideKeys[i + 1];
    const qSlideNo = parseInt(qSlideKey.match(/slide(\d+)/)[1]);
    const aSlideNo = parseInt(aSlideKey.match(/slide(\d+)/)[1]);
    const orderNo = Math.floor(i / 2) + 1;

    const warnings = [];
    let status = "ok";

    // Читаем XML слайдов
    const qXml = await zip.files[qSlideKey].async("string");
    const aXml = await zip.files[aSlideKey].async("string");

    // Rels для картинок
    const qRelsKey = `ppt/slides/_rels/slide${qSlideNo}.xml.rels`;
    const aRelsKey = `ppt/slides/_rels/slide${aSlideNo}.xml.rels`;
    const qRelsXml = zip.files[qRelsKey] ? await zip.files[qRelsKey].async("string") : null;

    // Тексты из вопросного слайда
    const qTexts = extractTextsFromSlideXml(qXml);
    // Тексты из ответного слайда
    const aTexts = extractTextsFromSlideXml(aXml);

    // Вопрос — обычно "Назовите футболиста" или похожий текст
    const nonOptionTexts = qTexts.filter(t => !t.text.match(/^\d+[.)]/));
    const question_text = nonOptionTexts.length > 0 ? nonOptionTexts[0].text : "Назовите футболиста";

    // Варианты — берём из ответного слайда (там тот же список + правильный подсвечен)
    const aOptions = parseOptions(aTexts);
    // Если на ответном нет вариантов — берём из вопросного
    const qOptions = parseOptions(qTexts);
    const options = aOptions.length >= 2 ? aOptions : qOptions;

    if (options.length < 2) {
      warnings.push("Меньше 2 вариантов ответа");
      status = "needs_review";
    }

    // Правильный ответ — вариант с оранжевым цветом на ответном слайде
    const orangeOpt = options.find(o => isOrangeColor(o.color));
    let correct_key = orangeOpt ? orangeOpt.key : null;
    let correct_answer = orangeOpt ? orangeOpt.text : null;

    if (!correct_key) {
      warnings.push("Правильный ответ не определён по цвету — нужна проверка");
      status = "needs_review";
    }

    // Картинка — из вопросного слайда
    let imagePreview = null;
    let imagePath = null;
    const imgRel = findMainImageRel(qXml, qRelsXml);
    if (imgRel) {
      // Нормализуем путь
      const normalizedPath = imgRel.startsWith("../")
        ? `ppt/${imgRel.slice(3)}`
        : `ppt/slides/${imgRel}`;
      const imgKey = Object.keys(zip.files).find(k =>
        k.toLowerCase() === normalizedPath.toLowerCase() ||
        k.toLowerCase().endsWith(imgRel.replace("../", "").toLowerCase())
      );
      if (imgKey && zip.files[imgKey]) {
        const imgData = await zip.files[imgKey].async("uint8array");
        const ext = imgKey.split(".").pop().toLowerCase();
        const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpeg";
        const blob = new Blob([imgData], { type: mime });
        imagePreview = URL.createObjectURL(blob);
        imagePath = imgKey;
      }
    }

    if (!imagePreview) {
      warnings.push("Картинка не найдена");
      status = "needs_review";
    }

    questions.push({
      order_no: orderNo,
      source_question_slide: qSlideNo,
      source_answer_slide: aSlideNo,
      question_text,
      options: options.map(o => ({ key: o.key, text: o.text })),
      correct_key,
      correct_answer,
      imagePreview,
      imagePath,
      image_url: null,
      status,
      warnings,
    });
  }

  return questions;
}

// ── AdminDailyQuizImport — импорт квизов из PPTX ──
function AdminDailyQuizImport({ token, showToast, isAdmin }) {
  const [quizDate, setQuizDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [quizTitle, setQuizTitle] = React.useState("");
  const [questionsPerGame, setQuestionsPerGame] = React.useState(10);
  const [file, setFile] = React.useState(null);
  const [parsing, setParsing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [questions, setQuestions] = React.useState([]);
  const [editIdx, setEditIdx] = React.useState(null);
  const [parseError, setParseError] = React.useState(null);
  const [savedQuizzes, setSavedQuizzes] = React.useState([]);
  const [loadingList, setLoadingList] = React.useState(false);

  React.useEffect(() => { loadQuizList(); }, []);

  async function loadQuizList() {
    setLoadingList(true);
    try {
      const r = await supa("daily_quizzes?select=id,quiz_date,title,status,questions_per_game,source_file_name&order=quiz_date.desc&limit=20", { token });
      if (r.ok) setSavedQuizzes(await r.json());
    } catch {}
    setLoadingList(false);
  }

  async function handleParse() {
    if (!file) { showToast("Выбери PPTX файл"); return; }
    setParsing(true); setParseError(null); setQuestions([]);
    try {
      const parsed = await parsePptxFile(file);
      setQuestions(parsed);
      if (!quizTitle) setQuizTitle(`Квиз ${quizDate}`);
      showToast(`✓ Распарсено ${parsed.length} вопросов из ${parsed.length * 2} слайдов`);
    } catch (e) {
      console.error("PPTX parse error:", e);
      setParseError(e.message || String(e));
      showToast("Ошибка парсинга: " + (e.message || "").slice(0, 80));
    }
    setParsing(false);
  }

  async function handleSave() {
    if (!questions.length) { showToast("Нет вопросов для сохранения"); return; }
    if (!quizDate || !quizTitle) { showToast("Заполни дату и название"); return; }
    setSaving(true);
    try {
      // 1. Upsert daily_quizzes
      const quizRes = await supa("daily_quizzes", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ quiz_date: quizDate, title: quizTitle, status: "draft", questions_per_game: questionsPerGame, source_file_name: file?.name || null }),
      });
      if (!quizRes.ok) { const t = await quizRes.text(); showToast("Ошибка создания квиза: " + t.slice(0, 80)); setSaving(false); return; }
      const [quiz] = await quizRes.json();
      const quizId = quiz.id;

      // 2. Удалить старые вопросы
      await supa(`daily_quiz_questions?quiz_id=eq.${quizId}`, { method: "DELETE", token, headers: { Prefer: "return=minimal" } });

      // 3. Загрузить картинки и сохранить вопросы
      let saved = 0;
      for (const q of questions) {
        let imageUrl = q.image_url;
        if (!imageUrl && q.imagePreview && q.imagePath) {
          try {
            // Загрузить в Supabase Storage bucket daily-quiz-images
            const ext = q.imagePath.split(".").pop().toLowerCase() || "jpg";
            const storagePath = `daily-quizzes/${quizDate}/q-${q.order_no}.${ext}`;
            const blob = await fetch(q.imagePreview).then(r => r.blob());
            const upRes = await fetch(
              `${SUPABASE_URL}/storage/v1/object/daily-quiz-images/${storagePath}`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, "Content-Type": blob.type, "x-upsert": "true" },
                body: blob,
              }
            );
            if (upRes.ok) {
              imageUrl = `${SUPABASE_URL}/storage/v1/object/public/daily-quiz-images/${storagePath}`;
            }
          } catch (imgErr) {
            console.warn("Image upload failed for q", q.order_no, imgErr);
          }
        }

        const qRow = {
          quiz_id: quizId,
          order_no: q.order_no,
          question_text: q.question_text,
          image_url: imageUrl || null,
          options: q.options,
          correct_key: q.correct_key || null,
          correct_answer: q.correct_answer || q.options[0]?.text || "",
          source_question_slide: q.source_question_slide,
          source_answer_slide: q.source_answer_slide,
        };
        const qRes = await supa("daily_quiz_questions", {
          method: "POST", token,
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(qRow),
        });
        if (qRes.ok) saved++;
      }
      showToast(`✓ Сохранено ${saved}/${questions.length} вопросов`);
      loadQuizList();
    } catch (e) {
      showToast("Ошибка сохранения: " + (e.message || "").slice(0, 80));
    }
    setSaving(false);
  }

  async function publishQuiz(quizId) {
    await supa(`daily_quizzes?id=eq.${quizId}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "published" }) });
    showToast("✓ Квиз опубликован");
    loadQuizList();
  }

  const editQ = editIdx !== null ? questions[editIdx] : null;

  return (
    <div>
      {/* Список существующих квизов */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph"><span className="pt">Существующие квизы</span></div>
        {loadingList && <div style={{ padding: 12, fontSize: 12, color: "rgba(240,237,230,.4)" }}>Загрузка…</div>}
        {savedQuizzes.length === 0 && !loadingList && <div style={{ padding: 12, fontSize: 12, color: "rgba(240,237,230,.3)" }}>Нет квизов</div>}
        {savedQuizzes.map(q => (
          <div key={q.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,.05)" }}>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 13, color: "#F0EDE6" }}>{q.quiz_date} — {q.title}</span>
              <span style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginLeft: 8 }}>{q.questions_per_game} вопр./игру</span>
            </div>
            <span style={{ fontSize: 11, color: q.status === "published" ? "#86EFAC" : "#FDE68A", border: `1px solid ${q.status === "published" ? "rgba(22,163,74,.3)" : "rgba(245,158,11,.3)"}`, borderRadius: 4, padding: "2px 6px" }}>
              {q.status === "published" ? "✓ Опубликован" : "Черновик"}
            </span>
            {q.status !== "published" && (
              <button className="mini-btn green" onClick={() => publishQuiz(q.id)}>Опубликовать</button>
            )}
          </div>
        ))}
      </div>

      {/* Форма импорта */}
      <div className="panel">
        <div className="ph"><span className="pt">Импорт из PPTX</span></div>
        <div style={{ padding: "12px 0" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 8, marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 3 }}>Дата квиза</div>
              <input type="date" className="inp" value={quizDate} onChange={e => setQuizDate(e.target.value)} style={{ marginBottom: 0 }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 3 }}>Название</div>
              <input className="inp" placeholder="Квиз #1 — Вратари" value={quizTitle} onChange={e => setQuizTitle(e.target.value)} style={{ marginBottom: 0 }} />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 3 }}>Вопр./игру</div>
              <input type="number" min="1" max="29" className="inp" value={questionsPerGame} onChange={e => setQuestionsPerGame(+e.target.value)} style={{ marginBottom: 0 }} />
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 3 }}>PPTX файл</div>
            <input type="file" accept=".pptx" onChange={e => setFile(e.target.files[0] || null)}
              style={{ fontSize: 12, color: "rgba(240,237,230,.7)" }} />
            {file && <span style={{ fontSize: 10, color: "#86EFAC", marginLeft: 8 }}>{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="bp" style={{ fontSize: 12, padding: "8px 18px" }} disabled={!file || parsing} onClick={handleParse}>
              {parsing ? "Парсю…" : "Распарсить презентацию"}
            </button>
            {questions.length > 0 && (
              <button className="sb" style={{ fontSize: 12, padding: "8px 18px" }} disabled={saving} onClick={handleSave}>
                {saving ? "Сохраняю…" : `Сохранить ${questions.length} вопросов`}
              </button>
            )}
          </div>
          {parseError && (
            <div style={{ marginTop: 10, fontSize: 11, color: "#FCA5A5", background: "rgba(185,28,28,.08)", border: "1px solid rgba(185,28,28,.2)", borderRadius: 6, padding: "8px 12px" }}>
              ⚠ {parseError}
            </div>
          )}
        </div>
      </div>

      {/* Предпросмотр */}
      {questions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#FDE68A", marginBottom: 10 }}>
            Предпросмотр: {questions.length} вопросов
            <span style={{ fontSize: 11, fontWeight: 400, color: "rgba(240,237,230,.35)", marginLeft: 10 }}>
              ✓ {questions.filter(q => q.status === "ok").length} ок · ⚠ {questions.filter(q => q.status === "needs_review").length} нужна проверка
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "rgba(255,255,255,.05)" }}>
                  {["№","Слайды","Фото","Вопрос","Вар.1","Вар.2","Вар.3","Правильный","Статус","Действия"].map(h => (
                    <th key={h} style={{ padding: "6px 8px", textAlign: "left", color: "rgba(240,237,230,.4)", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {questions.map((q, idx) => (
                  <tr key={idx} style={{ borderBottom: "1px solid rgba(255,255,255,.04)", background: q.status === "needs_review" ? "rgba(245,158,11,.04)" : "transparent" }}>
                    <td style={{ padding: "6px 8px", color: "rgba(240,237,230,.5)" }}>{q.order_no}</td>
                    <td style={{ padding: "6px 8px", color: "rgba(240,237,230,.3)", whiteSpace: "nowrap" }}>{q.source_question_slide}–{q.source_answer_slide}</td>
                    <td style={{ padding: "6px 8px" }}>
                      {q.imagePreview
                        ? <img src={q.imagePreview} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 4, border: "1px solid rgba(255,255,255,.1)" }} />
                        : <span style={{ fontSize: 10, color: "#FCA5A5" }}>—</span>}
                    </td>
                    <td style={{ padding: "6px 8px", maxWidth: 160, color: "#F0EDE6" }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.question_text}</div>
                    </td>
                    {[0,1,2].map(oi => (
                      <td key={oi} style={{ padding: "6px 8px", color: q.options[oi] ? (q.options[oi].key === q.correct_key ? "#86EFAC" : "rgba(240,237,230,.6)") : "rgba(240,237,230,.15)" }}>
                        {q.options[oi] ? q.options[oi].text : "—"}
                      </td>
                    ))}
                    <td style={{ padding: "6px 8px", color: "#86EFAC", fontWeight: 600 }}>{q.correct_answer || "?"}</td>
                    <td style={{ padding: "6px 8px" }}>
                      <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: q.status === "ok" ? "rgba(22,163,74,.15)" : "rgba(245,158,11,.15)", color: q.status === "ok" ? "#86EFAC" : "#FDE68A", border: `1px solid ${q.status === "ok" ? "rgba(22,163,74,.3)" : "rgba(245,158,11,.3)"}` }}>
                        {q.status === "ok" ? "✓ OK" : "⚠ Проверить"}
                      </span>
                      {q.warnings.length > 0 && (
                        <div style={{ fontSize: 9, color: "#FCA5A5", marginTop: 2 }}>{q.warnings[0]}</div>
                      )}
                    </td>
                    <td style={{ padding: "6px 8px" }}>
                      <button className="mini-btn" onClick={() => setEditIdx(idx)}>Ред.</button>
                      <button className="mini-btn red" style={{ marginLeft: 4 }} onClick={() => setQuestions(qs => qs.filter((_, i) => i !== idx).map((q, i) => ({ ...q, order_no: i + 1 })))}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Редактор вопроса */}
      {editQ && (
        <div className="modal-bg" onClick={e => e.target.className === "modal-bg" && setEditIdx(null)}>
          <div style={{ background: "#0D2416", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 20, width: "min(520px, 95vw)", maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A" }}>Редактировать вопрос #{editQ.order_no}</div>
              <button onClick={() => setEditIdx(null)} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
            </div>
            {editQ.imagePreview && <img src={editQ.imagePreview} alt="" style={{ width: "100%", maxHeight: 160, objectFit: "cover", borderRadius: 8, marginBottom: 12 }} />}
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 4 }}>Текст вопроса</div>
              <input className="inp" value={editQ.question_text}
                onChange={e => setQuestions(qs => qs.map((q,i) => i === editIdx ? { ...q, question_text: e.target.value } : q))}
                style={{ marginBottom: 0 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 6 }}>Варианты ответа</div>
              {editQ.options.map((opt, oi) => (
                <div key={oi} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: "rgba(240,237,230,.4)", minWidth: 20 }}>{opt.key}.</span>
                  <input className="inp" value={opt.text}
                    onChange={e => setQuestions(qs => qs.map((q,i) => i === editIdx ? { ...q, options: q.options.map((o,j) => j === oi ? { ...o, text: e.target.value } : o) } : q))}
                    style={{ flex: 1, marginBottom: 0 }} />
                  <button onClick={() => setQuestions(qs => qs.map((q,i) => i === editIdx ? { ...q, correct_key: opt.key, correct_answer: opt.text, status: "ok", warnings: [] } : q))}
                    style={{ background: editQ.correct_key === opt.key ? "rgba(22,163,74,.3)" : "rgba(255,255,255,.06)", border: `1px solid ${editQ.correct_key === opt.key ? "rgba(22,163,74,.6)" : "rgba(255,255,255,.1)"}`, color: editQ.correct_key === opt.key ? "#86EFAC" : "rgba(240,237,230,.4)", fontSize: 11, padding: "4px 8px", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }}>
                    {editQ.correct_key === opt.key ? "✓ Правильный" : "Сделать правильным"}
                  </button>
                </div>
              ))}
            </div>
            <button className="bp" style={{ width: "100%", fontSize: 13 }} onClick={() => setEditIdx(null)}>Готово</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── ErrorBoundary — ловит runtime ошибки в дочерних компонентах ──
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error("ErrorBoundary caught:", error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      const isAdmin = this.props.isAdmin;
      return (
        <div style={{ padding: 24, background: "rgba(185,28,28,.08)", border: "1px solid rgba(185,28,28,.25)", borderRadius: 10, margin: 12 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FCA5A5", marginBottom: 8 }}>
            ⚠ Ошибка в разделе
          </div>
          <div style={{ fontSize: 13, color: "rgba(240,237,230,.6)", marginBottom: 12 }}>
            Открой DevTools → Console и пришли текст ошибки.
          </div>
          {isAdmin && (
            <div style={{ background: "rgba(0,0,0,.3)", borderRadius: 6, padding: "10px 12px", fontFamily: "monospace", fontSize: 11, color: "#FCA5A5", lineHeight: 1.8, wordBreak: "break-all" }}>
              <div><strong>Error:</strong> {this.state.error?.message}</div>
              {this.state.info?.componentStack && (
                <div style={{ marginTop: 8, color: "rgba(240,237,230,.3)", fontSize: 10 }}>
                  {this.state.info.componentStack.slice(0, 400)}
                </div>
              )}
            </div>
          )}
          <button onClick={() => this.setState({ error: null, info: null })}
            style={{ marginTop: 12, background: "rgba(185,28,28,.2)", border: "1px solid rgba(185,28,28,.4)", color: "#FCA5A5", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontFamily: "Barlow Condensed,sans-serif" }}>
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── LandingPage — публичный лендинг для неавторизованных пользователей ──
function LandingPage({ onLogin }) {
  const S = {
    page: { minHeight: "100vh", background: "#0B1E12", color: "#F0EDE6", fontFamily: "Barlow Condensed, sans-serif" },
    // Header
    hdr: { background: "rgba(0,0,0,.35)", borderBottom: "1px solid rgba(245,158,11,.15)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 100 },
    hdrIn: { maxWidth: 900, margin: "0 auto", padding: "0 16px", display: "flex", alignItems: "center", gap: 16, height: 56 },
    hdrNav: { display: "flex", gap: 2, flex: 1, justifyContent: "center" },
    hdrA: { background: "transparent", border: "none", color: "rgba(240,237,230,.55)", fontSize: 13, fontWeight: 600, fontFamily: "Barlow Condensed, sans-serif", padding: "6px 12px", borderRadius: 6, cursor: "pointer", letterSpacing: 0.5, textTransform: "uppercase" },
    // Sections
    section: { maxWidth: 860, margin: "0 auto", padding: "56px 16px" },
    label: { fontFamily: "Oswald, sans-serif", fontSize: 12, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: "#F59E0B", marginBottom: 16, textAlign: "center" },
    h2: { fontFamily: "Oswald, sans-serif", fontSize: 26, fontWeight: 700, color: "#F0EDE6", textAlign: "center", marginBottom: 10 },
    card: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "20px 18px" },
    divider: { border: "none", borderTop: "1px solid rgba(255,255,255,.06)", margin: "0" },
  };

  const scrollTo = (id) => { document.getElementById("land-" + id)?.scrollIntoView({ behavior: "smooth" }); };

  return (
    <div style={S.page}>

      {/* HEADER */}
      <header style={S.hdr}>
        <div style={S.hdrIn}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <Logo size="xs" />
            <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6", letterSpacing: 0.5 }}>Football Fight Club</span>
          </div>
          <nav style={S.hdrNav}>
            {[["howto","Как играть"],["tournaments","Турниры"],["fcoins","F-Coins"],["faq","FAQ"]].map(([id, label]) => (
              <button key={id} style={S.hdrA} onClick={() => scrollTo(id)}>{label}</button>
            ))}
          </nav>
          <button className="bp" style={{ padding: "7px 18px", fontSize: 13, flexShrink: 0 }} onClick={onLogin}>Войти</button>
        </div>
      </header>

      {/* HERO */}
      <section style={{ ...S.section, paddingTop: 80, paddingBottom: 72, textAlign: "center" }}>
        <Logo size="xl" style={{ margin: "0 auto 28px" }} />
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: "#F59E0B", marginBottom: 12 }}>Главный турнир</div>
        <h1 style={{ fontFamily: "Oswald, sans-serif", fontSize: 38, fontWeight: 700, color: "#F0EDE6", lineHeight: 1.1, marginBottom: 16, letterSpacing: 0.3 }}>
          Football Fight Club —<br />Битва прогнозистов ЧМ-2026
        </h1>
        <p style={{ fontSize: 16, color: "rgba(240,237,230,.6)", lineHeight: 1.75, maxWidth: 560, margin: "0 auto 32px" }}>
          Прогнозируй матчи, плей-офф и бонусные вопросы. Соревнуйся в общей таблице, командном зачёте и борись за победу весь чемпионат.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 16 }}>
          <button className="bp" style={{ padding: "15px 36px", fontSize: 16, fontWeight: 700 }} onClick={onLogin}>
            Участвовать за 500 ₽
          </button>
          <button className="sb" style={{ padding: "15px 28px", fontSize: 15 }}
            onClick={() => document.getElementById("land-howto")?.scrollIntoView({ behavior: "smooth" })}>
            Как играть
          </button>
        </div>
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.35)", marginBottom: 48 }}>
          Бесплатная Битва клубов доступна всем пользователям
        </div>
        {/* Превью только Битвы прогнозистов */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, maxWidth: 520, margin: "0 auto" }}>
          {[
            { icon: "📋", label: "Матчи групп\n+ плей-офф" },
            { icon: "❓", label: "30 бонусных\nвопросов" },
            { icon: "🤝", label: "Командный\nзачёт" },
          ].map(t => (
            <div key={t.label} style={{ ...S.card, textAlign: "center", background: "rgba(185,28,28,.08)", border: "1px solid rgba(185,28,28,.2)" }}>
              <div style={{ fontSize: 22, marginBottom: 6 }}>{t.icon}</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.6)", lineHeight: 1.4, whiteSpace: "pre-line" }}>{t.label}</div>
            </div>
          ))}
        </div>
      </section>

      <hr style={S.divider} />

      {/* КАК РАБОТАЕТ */}
      <section id="land-howto" style={S.section}>
        <div style={S.label}>Как работает Битва прогнозистов</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[
            { n: "1", icon: "👤", t: "Создай аккаунт и участвуй за 500 ₽" },
            { n: "2", icon: "📋", t: "Делай прогнозы на все матчи группового этапа" },
            { n: "3", icon: "⚽", t: "Прогнозируй сетку плей-офф и отвечай на 30 бонусных вопросов" },
            { n: "4", icon: "🏆", t: "Набирай очки и соревнуйся в общей таблице и командном зачёте" },
          ].map(s => (
            <div key={s.n} style={{ ...S.card, display: "flex", gap: 14, alignItems: "flex-start" }}>
              <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 28, color: "#F59E0B", fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>{s.n}</span>
              <div>
                <div style={{ fontSize: 22, marginBottom: 4 }}>{s.icon}</div>
                <div style={{ fontSize: 14, color: "rgba(240,237,230,.75)", lineHeight: 1.5 }}>{s.t}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <hr style={S.divider} />

      {/* ЧТО ВХОДИТ В 500₽ */}
      <section id="land-tournaments" style={S.section}>
        <div style={S.label}>Что входит в 500 ₽</div>
        <div style={{ ...S.card, borderTop: "3px solid #B91C1C", marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 20, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>🏆 Битва прогнозистов</div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 28, fontWeight: 700, color: "#F59E0B" }}>500 ₽</div>
            </div>
            <button className="bp" style={{ padding: "10px 24px", fontSize: 14 }} onClick={onLogin}>Участвовать за 500 ₽</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[
              "📋 Прогнозы на все 104 матча ЧМ-2026",
              "⚽ Сетка плей-офф (1/8, 1/4, полуфиналы, финал)",
              "❓ 30 бонусных вопросов",
              "📊 Общая таблица прогнозистов",
              "🤝 Командный зачёт (от 2 человек)",
              "🪙 500 F-Coins на старте",
            ].map(f => (
              <div key={f} style={{ fontSize: 13, color: "rgba(240,237,230,.7)", display: "flex", gap: 6 }}>
                <span>{f}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Командный зачёт */}
        <div style={{ ...S.card, background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.2)", marginBottom: 12 }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 16, fontWeight: 700, color: "#93C5FD", marginBottom: 8 }}>🤝 Командный зачёт</div>
          <div style={{ fontSize: 13, color: "rgba(240,237,230,.65)", lineHeight: 1.7, marginBottom: 8 }}>
            Собери команду от 2 человек с другими участниками Битвы прогнозистов. Командный рейтинг = средний балл участников. Команды разного размера соревнуются на равных.
          </div>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)" }}>Создать или вступить в команду можно до старта турнира (11 июня).</div>
        </div>

        {/* Дедлайн */}
        <div style={{ ...S.card, background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.2)", textAlign: "center" }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 15, fontWeight: 700, color: "#FCA5A5", marginBottom: 6 }}>⏰ Дедлайн прогнозов</div>
          <div style={{ fontSize: 14, color: "rgba(240,237,230,.7)" }}>11 июня 2026 — старт первого матча ЧМ</div>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginTop: 6 }}>После старта нельзя изменить прогнозы группового этапа</div>
        </div>
      </section>

      <hr style={S.divider} />

      {/* БЕСПЛАТНАЯ ДОБАВКА: БИТВА КЛУБОВ */}
      <section style={{ ...S.section, paddingTop: 48, paddingBottom: 48 }}>
        <div style={{ background: "rgba(22,163,74,.05)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 14, padding: "24px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 22 }}>⚽</span>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", color: "#86EFAC" }}>Бесплатная добавка</div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 20, fontWeight: 700, color: "#F0EDE6" }}>Битва клубов</div>
            </div>
            <div style={{ marginLeft: "auto", fontFamily: "Oswald, sans-serif", fontSize: 18, fontWeight: 700, color: "#86EFAC" }}>Бесплатно</div>
          </div>
          <p style={{ fontSize: 14, color: "rgba(240,237,230,.65)", lineHeight: 1.75, marginBottom: 16 }}>
            Создай клуб, выбери fantasy-состав из игроков ЧМ, назначь капитана и играй каждый тур против соперника. Бесплатный режим для всех пользователей Football Fight Club.
          </p>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 16, fontStyle: "italic" }}>
            Главный турнир — Битва прогнозистов. Битва клубов — дополнительная бесплатная игра для вовлечения во время ЧМ.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["1 тренер + 7 игроков","Капитан ×1.5 очков","Макс. 2 из сборной","Макс. 1 звезда","Бесплатно"].map(f => (
              <span key={f} style={{ fontSize: 12, color: "#86EFAC", background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 4, padding: "3px 8px" }}>{f}</span>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <button className="sb" style={{ fontSize: 13, padding: "8px 20px", borderColor: "rgba(22,163,74,.4)", color: "#86EFAC" }} onClick={onLogin}>
              Попробовать Битву клубов бесплатно →
            </button>
          </div>
        </div>
      </section>

      {/* КАК СЧИТАЮТСЯ ОЧКИ В БИТВЕ КЛУБОВ */}
      <section style={{ ...S.section, paddingTop: 0, paddingBottom: 48 }}>
        <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 16, fontWeight: 700, color: "#86EFAC", textTransform: "uppercase", letterSpacing: 2, marginBottom: 16 }}>
          Как начисляются очки в Битве клубов
        </div>
        <p style={{ fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.7, marginBottom: 20 }}>
          Каждый тур ты выбираешь состав: 1 тренер + 7 игроков. Очки начисляются за реальные действия футболистов на матчах ЧМ. Капитан получает ×1.5. Если куплен запасной, в зачёт идут 8 лучших из 9.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[
            { title: "🥅 Вратарь", color: "#60A5FA", rows: [
              ["Сухой матч (ноль пропущенных)", "+6"],
              ["Победа команды", "+3"],
              ["Вышел в стартовом составе", "+2"],
              ["Отбитый пенальти", "+8"],
              ["Пропущенный гол", "−1 каждый"],
              ["Жёлтая карточка", "−1"],
              ["Красная карточка", "−4"],
            ]},
            { title: "🛡 Защитник", color: "#818CF8", rows: [
              ["Сухой матч", "+5"],
              ["Гол", "+8"],
              ["Голевая передача", "+5"],
              ["Победа команды", "+2"],
              ["Вышел в стартовом составе", "+2"],
              ["Жёлтая карточка", "−1"],
              ["Красная карточка", "−4"],
            ]},
            { title: "⚡ Полузащитник", color: "#F59E0B", rows: [
              ["Гол", "+6"],
              ["Голевая передача", "+5"],
              ["Победа команды", "+2"],
              ["Вышел в стартовом составе", "+2"],
              ["Жёлтая карточка", "−1"],
              ["Красная карточка", "−4"],
            ]},
            { title: "⚽ Нападающий", color: "#F97316", rows: [
              ["Гол", "+5 (+3 за 2-й, +6 за хет-трик)"],
              ["Голевая передача", "+4"],
              ["Вышел в стартовом составе", "+2"],
              ["Нереализованный пенальти", "−3"],
              ["Жёлтая карточка", "−1"],
              ["Красная карточка", "−4"],
            ]},
            { title: "🧑‍💼 Тренер", color: "#A78BFA", rows: [
              ["Победа команды", "+5"],
              ["Ничья команды", "+2"],
              ["Команда забила 3+ голов", "+2"],
              ["Красная карточка в команде", "−2"],
            ]},
            { title: "🏅 Капитан", color: "#F59E0B", rows: [
              ["Все очки × 1.5", ""],
              ["Не может быть тренер", ""],
              ["Выбирается из 7 игроков", ""],
            ]},
          ].map(group => (
            <div key={group.title} style={{ ...S.card, padding: "14px 16px" }}>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 700, color: group.color, marginBottom: 10 }}>{group.title}</div>
              {group.rows.map(([label, pts]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "rgba(240,237,230,.65)", marginBottom: 5 }}>
                  <span>{label}</span>
                  {pts && <span style={{ fontFamily: "Oswald, sans-serif", fontWeight: 700, color: pts.startsWith("−") || pts.startsWith("-") ? "#FCA5A5" : "#86EFAC", flexShrink: 0, marginLeft: 8 }}>{pts}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <hr style={S.divider} />

      {/* F-COINS */}
      <section id="land-fcoins" style={S.section}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "center" }}>
          <div>
            <div style={S.label}>F-Coins</div>
            <h2 style={{ ...S.h2, textAlign: "left", marginBottom: 14 }}>Внутриигровая валюта</h2>
            <p style={{ fontSize: 14, color: "rgba(240,237,230,.65)", lineHeight: 1.8, marginBottom: 14 }}>
              F-Coins нельзя вывести в деньги, но можно тратить на игровые бонусы: дополнительную замену, запасного игрока, скаута и другие улучшения.
            </p>
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", lineHeight: 2 }}>
              <div>Заработать: оплата Полного ЧМ (+500) · победы в Кубке (+50) · раунды (+100)</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[
              ["🔄", "Доп. замена", "300 🪙"],
              ["🪑", "Запасной", "500 🪙"],
              ["🔍", "Скаут", "300 🪙"],
              ["🫥", "Скрыть состав", "200 🪙"],
            ].map(([icon, name, cost]) => (
              <div key={name} style={{ ...S.card, textAlign: "center", background: "rgba(245,158,11,.05)", border: "1px solid rgba(245,158,11,.12)" }}>
                <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", marginBottom: 4 }}>{name}</div>
                <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>{cost}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <hr style={S.divider} />

      {/* FAQ */}
      <section id="land-faq" style={S.section}>
        <div style={S.label}>Частые вопросы</div>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          {[
            { q: "Что главное в Football Fight Club?", a: "Главный турнир — Битва прогнозистов. Ты прогнозируешь матчи, плей-офф и бонусные вопросы, набираешь очки и соревнуешься в общей таблице." },
            { q: "Можно ли играть бесплатно?", a: "Да. Бесплатно доступна Битва клубов — fantasy-режим, где ты собираешь клуб из игроков ЧМ. Но главный платный турнир — Битва прогнозистов." },
            { q: "Как начисляются очки в Битве клубов?", a: "Футболисты получают очки за голы, передачи, сухие матчи, сейвы и победы команды. Карточки, автоголы и незабитые пенальти дают штрафы. Капитан ×1.5." },
            { q: "Что такое запасной игрок?", a: "Запасной — бонус из магазина. Если куплен, можно выбрать 9-го игрока, а в зачёт идут 8 лучших результатов из 9." },
            { q: "Что такое Командный зачёт?", a: "Часть Битвы прогнозистов. Команда от 2 человек, рейтинг считается по среднему баллу участников." },
          ].map((f, i, arr) => (
            <div key={f.q} style={{ padding: "16px 0", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,.06)" : "none" }}>
              <div style={{ fontFamily: "Barlow Condensed, sans-serif", fontSize: 15, fontWeight: 600, color: "#FDE68A", marginBottom: 6 }}>{f.q}</div>
              <div style={{ fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.7 }}>{f.a}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ ...S.section, paddingTop: 48, paddingBottom: 80 }}>
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 16, padding: "40px 24px", textAlign: "center" }}>
          <Logo size="md" style={{ margin: "0 auto 20px" }} />
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 28, fontWeight: 700, color: "#F0EDE6", marginBottom: 10 }}>Участвуй в Битве прогнозистов</div>
          <div style={{ fontSize: 14, color: "rgba(240,237,230,.45)", marginBottom: 28 }}>Главный турнир на весь ЧМ-2026. Битва клубов — бесплатная добавка.</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button className="bp" style={{ padding: "13px 32px", fontSize: 15, fontWeight: 700 }} onClick={onLogin}>Участвовать за 500 ₽</button>
            <button className="sb" style={{ padding: "13px 32px", fontSize: 13 }} onClick={onLogin}>Попробовать Битву клубов бесплатно</button>
          </div>
        </div>
      </section>

    </div>
  );
}

// ── Logo — единый CSS-логотип FFC ──
const LOGO_SIZES = {
  xs:  { outer: 28,  font: 9,  border: 1.5, shadow: "0 1px 4px rgba(0,0,0,.4)" },
  sm:  { outer: 38,  font: 12, border: 2,   shadow: "0 2px 8px rgba(0,0,0,.4)" },
  md:  { outer: 56,  font: 16, border: 2.5, shadow: "0 4px 14px rgba(0,0,0,.5)" },
  lg:  { outer: 80,  font: 22, border: 3,   shadow: "0 6px 20px rgba(0,0,0,.6)" },
  xl:  { outer: 112, font: 30, border: 4,   shadow: "0 8px 28px rgba(0,0,0,.6)" },
};
function Logo({ size = "sm", style: extraStyle = {} }) {
  const s = LOGO_SIZES[size] || LOGO_SIZES.sm;
  return (
    <div style={{
      width: s.outer, height: s.outer,
      borderRadius: "50%",
      background: "linear-gradient(135deg, #0a1a0e 0%, #B91C1C 45%, #15803d 100%)",
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
      border: `${s.border}px solid rgba(245,158,11,.65)`,
      boxShadow: `${s.shadow}, inset 0 1px 0 rgba(245,158,11,.2)`,
      position: "relative",
      overflow: "hidden",
      ...extraStyle,
    }}>
      {/* Внутренняя полоска */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 35% 35%, rgba(245,158,11,.12) 0%, transparent 60%)", pointerEvents: "none" }} />
      <span style={{ fontFamily: "Oswald,sans-serif", fontSize: s.font, fontWeight: 700, color: "#F59E0B", letterSpacing: s.font > 16 ? 1 : 0.5, position: "relative" }}>FFC</span>
    </div>
  );
}

// ── ProfileMenu — компонент профиля в хедере ──
function ProfileMenu({ profile, isAdmin, isPaid, onNavigate, onLogout }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  // Закрывать дропдаун при клике вне
  React.useEffect(() => {
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const [bg, fg] = avc(profile.name || "X");
  const displayName = profile.club_name || profile.name || profile.email?.split("@")[0] || "Профиль";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {/* Кнопка профиля */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 7, background: open ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 10px 5px 6px", cursor: "pointer", transition: "background 0.15s" }}
      >
        {/* Аватар */}
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
          {ini(profile.name || "?")}
        </div>
        {/* Имя */}
        <span style={{ fontSize: 12, color: "rgba(240,237,230,.75)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayName}
        </span>
        {/* F-Coins */}
        {profile.fcoins_balance != null && (
          <span style={{ fontSize: 11, color: "#F59E0B", background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 4, padding: "1px 5px", flexShrink: 0 }}>
            🪙 {profile.fcoins_balance}
          </span>
        )}
        {/* Статус */}
        <span className={`access-badge ${isAdmin ? "badge-admin" : isPaid ? "badge-paid" : "badge-demo"}`} style={{ fontSize: 9 }}>
          {isAdmin ? "Админ" : isPaid ? "✓" : "Draft"}
        </span>
        <span style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginLeft: 2 }}>{open ? "▲" : "▼"}</span>
      </button>

      {/* Dropdown */}
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 190, background: "#0D2416", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,.5)", zIndex: 999, overflow: "hidden" }}>
          {/* Шапка дропдауна */}
          <div style={{ padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,.07)", background: "rgba(255,255,255,.03)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#F0EDE6", marginBottom: 2 }}>{displayName}</div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{profile.email || ""}</div>
            {profile.fcoins_balance != null && (
              <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 4 }}>🪙 {profile.fcoins_balance} F-Coins</div>
            )}
          </div>

          {/* Пункты меню */}
          {[
            ["👤 Мой профиль", "predict"],
            [profile.club_name ? `🏟 ${profile.club_name}` : "🏟 Мой клуб", "clubs"],
            ["💳 Мои оплаты", "payments"],
            isAdmin && ["⚙ Панель администратора", "admin"],
          ].filter(Boolean).map(([label, target]) => (
            <button key={target} onClick={() => { onNavigate(target); setOpen(false); }}
              style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", borderBottom: "1px solid rgba(255,255,255,.05)", color: "rgba(240,237,230,.75)", fontSize: 13, padding: "10px 14px", cursor: "pointer", fontFamily: "Barlow Condensed,sans-serif", fontWeight: 500, transition: "background 0.1s" }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.05)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {label}
            </button>
          ))}

          {/* Выйти */}
          <button onClick={() => { onLogout(); setOpen(false); }}
            style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", color: "#FCA5A5", fontSize: 13, padding: "10px 14px", cursor: "pointer", fontFamily: "Barlow Condensed,sans-serif", fontWeight: 600 }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(185,28,28,.1)"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            🚪 Выйти
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary isAdmin={false}>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState("predict");

  // Прогнозы пользователя
  const [scores, setScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_scores") || "{}"); } catch { return {}; } });
  const [pScores, setPScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_scores") || "{}"); } catch { return {}; } });
  const [pPens, setPPens] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_pens") || "{}"); } catch { return {}; } });
  const [bonus, setBonus] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_bonus") || "{}"); } catch { return {}; } });
  const [bonusPickerOpen, setBonusPickerOpen] = useState(null); // {qid, type, slotIdx, excludeNames}

  // Дисциплина (Fair Play)
  const [discipline, setDiscipline] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_discipline") || "{}"); } catch { return {}; } });

  // Официальные результаты (для симуляции и админки)
  // officialResults управляется в AdminPanel напрямую через localStorage

  // Личные результаты участника для симуляции
  // userSim и simMode — будут реализованы в следующей версии

  const [leaderboard, setLeaderboard] = useState([]);
  const [showAuth, setShowAuth] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [showPayment, setShowPayment] = useState(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [pendingSession, setPendingSession] = useState(null);
  const [toast, setToast] = useState("");
  const [saving, setSaving] = useState(false);
  const [predStatus, setPredStatus] = useState("draft"); // всегда стартуем с draft, берём из профиля
  const [pendingPlanAfterAuth, setPendingPlanAfterAuth] = useState(null);
  const [predictionsLocked, setPredictionsLocked] = useState(() => localStorage.getItem("ffc_predictions_locked") === "true");
  const [predictionsPublic, setPredictionsPublic] = useState(() => localStorage.getItem("ffc_predictions_public") === "true");

  // ── Битва клубов + F-Coins ──
  const [clubsSubTab, setClubsSubTab] = useState("home"); // "home"|"myclub"|"cup"|"league"|"shop"
  const [clubForm, setClubForm] = useState({ name: "", city: "", color: "#B91C1C" });
  const [clubSaving, setClubSaving] = useState(false);
  const [fcoinsHistory, setFcoinsHistory] = useState([]);
  // ── FFC ──
  const [activeRound, setActiveRound] = useState(null);
  const [activeRoundError, setActiveRoundError] = useState(null);
  const [allRounds, setAllRounds] = useState([]);
  const [cupCount, setCupCount] = useState(null);   // число участников Кубка FFC
  const [leagueCount, setLeagueCount] = useState(null); // число участников Лиги FFC
  const isSubmitted = predStatus === "submitted" || predStatus === "locked";
  const isPending = predStatus === "payment_pending";
  const tournamentOpen = isOpen() && !predictionsLocked;
  const isEditable = !isSubmitted && !isPending && tournamentOpen;
  const isGuest = !session;

  const accessLevel = useMemo(() => {
    if (!profile) return ACCESS.DEMO;
    return profile.access_level || ACCESS.DEMO;
  }, [profile]);
  const isAdmin = accessLevel === ACCESS.ADMIN || profile?.is_admin;
  const isPaid = [ACCESS.PROGNOSTISTA, ACCESS.FULL, ACCESS.ADMIN].includes(accessLevel);
  // Битва клубов бесплатны — hasLeagueAccess true для всех авторизованных
  const hasLeagueAccess = !!session;

  // Синк localStorage
  useEffect(() => { localStorage.setItem("ffc_guest_scores", JSON.stringify(scores)); }, [scores]);
  useEffect(() => { localStorage.setItem("ffc_guest_playoff_scores", JSON.stringify(pScores)); }, [pScores]);
  useEffect(() => { localStorage.setItem("ffc_guest_playoff_pens", JSON.stringify(pPens)); }, [pPens]);
  useEffect(() => { localStorage.setItem("ffc_guest_bonus", JSON.stringify(bonus)); }, [bonus]);
  // predStatus хранится только для авторизованных (user-specific), гость всегда draft
  useEffect(() => {
    if (session?.user?.id) {
      localStorage.setItem(`ffc_pred_status_${session.user.id}`, predStatus);
    }
  }, [predStatus, session]);
  // ffc_user_result_simulation sync — будет добавлен при реализации симуляции

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };

  // ── ЕДИНЫЙ ОБРАБОТЧИК ПОСЛЕ УСПЕШНОГО ВХОДА ──
  // Используется для email OTP, Google и VK — не дублируем логику
  const afterSuccessfulAuth = useCallback(async (rawSess) => {
    // rawSess может быть объектом { access_token, refresh_token, user, ... } (OTP/VK)
    // или объектом Session из supabase-js (OAuth Google)
    const token = rawSess.access_token;
    const refreshToken = rawSess.refresh_token || null;
    const user = rawSess.user || rawSess;
    if (!token || !user?.id) return;

    const sessObj = { access_token: token, refresh_token: refreshToken, user };
    localStorage.setItem("ffc_session", JSON.stringify(sessObj));
    setSession(sessObj);

    // Восстанавливаем сессию в supabase-js клиенте — нужно для getFreshToken()
    if (token && refreshToken) {
      try {
        await supabaseClient.auth.setSession({ access_token: token, refresh_token: refreshToken });
      } catch (e) {
        console.warn("afterSuccessfulAuth: setSession failed", e);
      }
    }

    // Загрузить или создать профиль
    const pr = await supa(`profiles?id=eq.${user.id}&select=*`, { token });
    let prof = null;
    if (pr.ok) {
      const d = await pr.json();
      prof = d[0] || null;
    }
    if (!prof) {
      // Создаём профиль для нового пользователя (Google/VK/email)
      const meta = user.user_metadata || {};
      const newProf = {
        id: user.id,
        email: user.email || null,
        name: meta.full_name || meta.name || user.email || "Игрок",
        avatar_url: meta.avatar_url || meta.picture || null,
        provider: user.app_metadata?.provider || "email",
        prediction_status: "draft",
        access_level: ACCESS.DEMO,
      };
      const cr = await supa("profiles", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(newProf),
      });
      prof = newProf;
    }
    setProfile(prof);
    const dbStatus = prof.prediction_status;
    const localStatus = localStorage.getItem(`ffc_pred_status_${user.id}`);
    setPredStatus(dbStatus || localStatus || "draft");

    // Перенести guest draft если есть и прогноз ещё не submitted
    const guestScores = localStorage.getItem("ffc_guest_scores");
    let hasDraft = false;
    try { hasDraft = guestScores && Object.keys(JSON.parse(guestScores)).length > 0; } catch { }
    if (hasDraft && prof.prediction_status !== "submitted") {
      setPendingSession(sessObj);
      setShowDraftModal(true);
    } else {
      await loadMyData(sessObj);
      showToast("✓ Вход выполнен!");
    }

    await loadLeaderboard();
    setShowAuth(false);

    // Если до входа нажимали "Отправить прогноз" — открыть оплату
    if (pendingPlanAfterAuth) {
      setShowPayment(pendingPlanAfterAuth);
      setPendingPlanAfterAuth(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlanAfterAuth]);

  // Загрузка сессии при старте + подписка на OAuth-редирект
  useEffect(() => {
    // Проверить query — VK может вернуть ошибку в ?vk_error= (на случай старого редиректа)
    const qParams = new URLSearchParams(window.location.search);
    const vkError = qParams.get("vk_error");
    if (vkError) {
      window.history.replaceState(null, "", window.location.pathname);
      setToast(`Ошибка VK: ${vkError}`);
    }

    // 1. Восстановить сессию из localStorage
    const stored = localStorage.getItem("ffc_session");
    if (stored) {
      try {
        const s = JSON.parse(stored);
        if (!s?.access_token) throw new Error("no token");

        if (s.refresh_token) {
          // Восстанавливаем в supabase-js — он обновит токен если нужно
          supabaseClient.auth.setSession({
            access_token:  s.access_token,
            refresh_token: s.refresh_token,
          }).then(({ data: sd }) => {
            if (sd?.session?.access_token) {
              const fresh = {
                access_token:  sd.session.access_token,
                refresh_token: sd.session.refresh_token,
                user:          sd.session.user,
              };
              localStorage.setItem("ffc_session", JSON.stringify(fresh));
              setSession(fresh);
            }
          }).catch(() => {});
        } else {
          // Нет refresh_token — старая сессия, просим войти заново
          localStorage.removeItem("ffc_session");
          setSession(null);
          setToast("Сессия устарела. Войдите заново.");
          return; // не грузим данные со старым токеном
        }

        setSession(s);
        loadProfile(s);
        loadMyData(s);
        loadLeaderboard();
        loadActiveRound();
        loadEntryCounters();
      } catch { localStorage.removeItem("ffc_session"); }
    }

    // 2. Подхватить OAuth-сессию после редиректа с Google
    supabaseClient.auth.getSession().then(({ data }) => {
      if (data?.session?.user) {
        const alreadyHave = localStorage.getItem("ffc_session");
        if (!alreadyHave) {
          afterSuccessfulAuth(data.session);
        }
      }
    });

    // 3. Слушать SIGNED_IN (возврат после Google OAuth)
    const { data: sub } = supabaseClient.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_IN" && s?.user) {
        const alreadyHave = localStorage.getItem("ffc_session");
        if (!alreadyHave) {
          afterSuccessfulAuth(s);
        }
      }
    });

    return () => sub?.subscription?.unsubscribe?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadProfile(s) {
    const r = await supa(`profiles?id=eq.${s.user.id}&select=*`, { token: s.access_token });
    if (r.ok) {
      const d = await r.json();
      if (d[0]) {
        setProfile(d[0]);
        // Статус берём из profiles БД, fallback — user-specific localStorage
        const dbStatus = d[0].prediction_status;
        const localStatus = localStorage.getItem(`ffc_pred_status_${s.user.id}`);
        setPredStatus(dbStatus || localStatus || "draft");
      }
    }
  }

  async function loadMyData(s) {
    const pr = await supa(`predictions?user_id=eq.${s.user.id}&select=*`, { token: s.access_token });
    if (pr.ok) {
      const d = await pr.json();
      const groupMap = {};
      const playoffMap = {};
      const pensMap = {};
      d.forEach((p) => {
        if (ALL_GROUP_MATCH_IDS.has(p.match_id)) {
          // Групповой этап
          groupMap[p.match_id] = { h: p.home_score ?? "", a: p.away_score ?? "" };
        } else if (ALL_PLAYOFF_MATCH_IDS.has(p.match_id)) {
          // Плей-офф
          playoffMap[p.match_id] = { h: p.home_score ?? "", a: p.away_score ?? "" };
          if (p.penalty_winner) pensMap[p.match_id] = p.penalty_winner;
        }
      });
      if (Object.keys(groupMap).length > 0) setScores(groupMap);
      if (Object.keys(playoffMap).length > 0) setPScores(playoffMap);
      if (Object.keys(pensMap).length > 0) setPPens(pensMap);
    }
    const ba = await supa(`bonus_answers?user_id=eq.${s.user.id}&select=*`, { token: s.access_token });
    if (ba.ok) {
      const d = await ba.json();
      const m = {};
      d.forEach((b) => { try { m[b.question_id] = JSON.parse(b.answer); } catch { m[b.question_id] = b.answer; } });
      if (Object.keys(m).length > 0) setBonus(m);
    }
  }

  async function loadLeaderboard() {
    const r = await supa("leaderboard?select=*");
    if (r.ok) { const d = await r.json(); setLeaderboard(d); }
  }

  async function loadFcoinsHistory() {
    if (!session) return;
    const r = await supa(
      `fcoin_transactions?user_id=eq.${session.user.id}&select=*&order=created_at.desc&limit=30`,
      { token: session.access_token }
    );
    if (r.ok) { const d = await r.json(); setFcoinsHistory(d); }
  }

  async function loadEntryCounters() {
    try {
      const [cr, lr] = await Promise.all([
        supa("ffc_cup_entries?select=id"),
        supa("ffc_league_entries?select=id"),
      ]);
      if (cr.ok) { const d = await cr.json(); setCupCount(Array.isArray(d) ? d.length : 0); }
      if (lr.ok) { const d = await lr.json(); setLeagueCount(Array.isArray(d) ? d.length : 0); }
    } catch (e) {
      console.warn("loadEntryCounters failed:", e);
    }
  }

  async function loadActiveRound() {
    try {
      // Грузим с token если есть (для RLS), без фильтров — фильтруем на клиенте
      const res = await supa("ffc_rounds?select=*&order=round_no.asc,created_at.desc&limit=20",
        session?.access_token ? { token: session.access_token } : {}
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("loadActiveRound failed:", res.status, text);
        setActiveRound(null);
        setActiveRoundError(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        setAllRounds([]);
        return;
      }

      const rounds = await res.json();
      setAllRounds(rounds);
      const now = new Date();

      // Приоритет выбора тура:
      // 1) тур где opens_at <= now < deadline (активен по датам)
      // 2) тур со статусом lineup_open (ручное управление без opens_at)
      // 3) ближайший будущий тур (opens_at > now)
      // 4) тур со статусом locked/scoring
      // 5) последний тур вообще

      const byDates = rounds.find(r => {
        const opens = r.opens_at ? new Date(r.opens_at) : null;
        const dl = r.deadline ? new Date(r.deadline) : null;
        if (opens && dl) return opens <= now && now < dl;
        return false;
      });

      const byStatus = rounds.find(r => r.status === "lineup_open");

      const upcoming = rounds
        .filter(r => r.opens_at && new Date(r.opens_at) > now)
        .sort((a, b) => new Date(a.opens_at) - new Date(b.opens_at))[0] || null;

      const fallback =
        rounds.find(r => r.status === "locked") ||
        rounds.find(r => r.status === "scoring") ||
        rounds[0] || null;

      const picked = byDates || byStatus || upcoming || fallback || null;

      console.log("loadActiveRound picked:", picked ? `${picked.name} (${picked.status}, opens_at=${picked.opens_at}, deadline=${picked.deadline})` : "none");
      setActiveRound(picked);
      setActiveRoundError(null);
    } catch (e) {
      console.error("loadActiveRound exception:", e);
      setActiveRound(null);
      setActiveRoundError(String(e?.message || e));
      setAllRounds([]);
    }
  }

  // awardFcoins была удалена — использовала строку вместо числа в PATCH.
  // Для начисления F-Coins используй awardFcoinsAdmin (в AdminFfcPanel)
  // который читает текущий баланс → прибавляет числом → пишет PATCH.

  async function saveClub() {
    if (!session?.user?.id) { showToast("Войди в аккаунт"); return; }
    if (!clubForm.name.trim()) { showToast("Введи название клуба"); return; }
    if (!clubForm.city.trim()) { showToast("Введи город клуба"); return; }

    setClubSaving(true);

    // Получаем свежий токен — supabase-js обновит если истёк
    const token = await getFreshToken(setSession);

    // Проверяем что токен валидный Supabase JWT
    const tokenIsJwt = typeof token === "string" && token.split(".").length === 3;
    const hasRefreshToken = !!(JSON.parse(localStorage.getItem("ffc_session") || "{}").refresh_token);

    console.log("saveClub auth debug", {
      hasUser:         !!session?.user?.id,
      userId:          session?.user?.id,
      hasToken:        !!token,
      tokenIsJwt,
      hasRefreshToken,
    });

    if (!token || !tokenIsJwt) {
      setClubSaving(false);
      console.error("saveClub: invalid token, not a JWT", { token: token ? token.slice(0, 20) + "..." : null });
      showToast("Сессия истекла. Выйдите и войдите заново.");
      return;
    }

    const payload = {
      club_name:  clubForm.name.trim(),
      club_city:  clubForm.city.trim(),
      club_color: clubForm.color || "#B91C1C",
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}`, {
      method: "PATCH",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer:         "return=representation",
      },
      body: JSON.stringify(payload),
    });

    setClubSaving(false);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("saveClub PATCH failed:", {
        status: res.status,
        body: text.slice(0, 200),
        tokenIsJwt,
        hasRefreshToken,
      });
      showToast(`Не удалось сохранить клуб (${res.status}): ${text.slice(0, 150)}`);
      return;
    }

    // return=representation → получаем обновлённую строку из БД
    let updatedProfile = null;
    try {
      const data = await res.json();
      updatedProfile = Array.isArray(data) ? data[0] : data;
    } catch {}

    if (updatedProfile) {
      setProfile(updatedProfile);
    } else {
      // Fallback: перезагрузить профиль
      const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${session.user.id}&select=*`, {
        headers: {
          apikey:         SUPABASE_KEY,
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      if (profRes.ok) {
        const profData = await profRes.json();
        if (profData[0]) setProfile(profData[0]);
        else setProfile(p => p ? { ...p, ...payload } : payload);
      } else {
        setProfile(p => p ? { ...p, ...payload } : payload);
      }
    }

    showToast("✓ Клуб создан!");
    setClubsSubTab("myclub");
  }
  async function handleAuth(sess) {
    await afterSuccessfulAuth(sess);
  }

  // finishAuth — вызывается из DraftModal (перенести или нет черновик)
  async function finishAuth(sess, transfer) {
    setSession(sess);
    await loadProfile(sess);
    if (transfer) { await syncDB(sess); } else { await loadMyData(sess); }
    await loadLeaderboard();
    setPendingSession(null);
    showToast(transfer ? "✓ Черновик перенесён в аккаунт!" : "✓ Вход выполнен!");
    if (pendingPlanAfterAuth) {
      setShowPayment(pendingPlanAfterAuth);
      setPendingPlanAfterAuth(null);
    }
  }

  async function submitPayment(plan, comment) {
    if (!session) return;
    const row = { user_id: session.user.id, user_email: session.user.email, plan: plan.id, amount: plan.price, comment, status: "pending" };
    await supa("payment_requests", { method: "POST", token: session.access_token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    // Обновляем prediction_status в БД
    await supa(`profiles?id=eq.${session.user.id}`, { method: "PATCH", token: session.access_token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ prediction_status: "payment_pending" }) });
    setPredStatus("payment_pending");
  }

  async function syncDB(sess) {
    setSaving(true);
    const uid = sess.user.id, token = sess.access_token;

    // Группы — строгий фильтр, только матчи из ALL_GROUP_MATCH_IDS
    const groupRows = Object.entries(scores)
      .filter(([mid, s]) =>
        ALL_GROUP_MATCH_IDS.has(mid) &&
        s.h !== "" && s.h !== undefined && s.h !== null &&
        s.a !== "" && s.a !== undefined && s.a !== null
      )
      .map(([mid, s]) => ({ user_id: uid, match_id: mid, home_score: +s.h, away_score: +s.a }));
    if (groupRows.length) await supa("predictions", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(groupRows),
    });

    // Плей-офф — только валидные матчи, с penalty_winner
    const validPlayoffRows = allPlayoffBrackets
      .filter((b) => isPlayoffMatchValid(b))
      .map((b) => {
        const s = pScores[b.id];
        const isDraw = +s.h === +s.a;
        const penaltyWinner = isDraw ? (pPens[b.id] || null) : null;
        return { user_id: uid, match_id: b.id, home_score: +s.h, away_score: +s.a, penalty_winner: penaltyWinner };
      });
    if (validPlayoffRows.length) await supa("predictions", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(validPlayoffRows),
    });

    // Бонусы
    const brows = Object.entries(bonus).map(([qid, ans]) => ({ user_id: uid, question_id: qid, answer: JSON.stringify(ans) }));
    if (brows.length) await supa("bonus_answers", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(brows),
    });
    setSaving(false);
  }

  async function save() {
    localStorage.setItem("ffc_guest_updated_at", new Date().toISOString());
    if (isGuest) { showToast("✓ Черновик сохранён на этом устройстве"); return; }
    await syncDB(session);
    await loadLeaderboard();
    showToast("✓ Черновик сохранён");
  }

  // ── ВЫЧИСЛЕНИЯ ──
  const allTables = useMemo(() => {
    const t = {};
    ALL_GROUPS.forEach((g) => { t[g] = calcGroupTable(g, scores, discipline); });
    return t;
  }, [scores, discipline]);

  const thirdRanking = useMemo(() => getThirdRanking(allTables, discipline), [allTables, discipline]);
  const qualifiedThirds = useMemo(() => new Set(thirdRanking.slice(0, 8).map((x) => x.group)), [thirdRanking]);

  const allBrackets = useMemo(() => [...R16, ...R8, ...QF, ...SF, THIRD_MATCH, FINAL_MATCH], []);

  const groupCompleteness = useMemo(() => {
    const c = {};
    ALL_GROUPS.forEach((g) => {
      const filled = GROUP_MATCHES[g].filter((m) => scores[m.id]?.h !== "" && scores[m.id]?.h !== undefined && scores[m.id]?.a !== "" && scores[m.id]?.a !== undefined).length;
      c[g] = { filled, complete: filled === 6 };
    });
    return c;
  }, [scores]);

  const allGroupsComplete = useMemo(() => Object.values(groupCompleteness).every((c) => c.complete), [groupCompleteness]);

  const filledGroupCount = useMemo(() => Object.entries(scores).filter(([mid, s]) => s?.h !== "" && s?.h !== undefined && s?.a !== "" && s?.a !== undefined && ALL_GROUP_MATCH_IDS.has(mid)).length, [scores]);

  // Функция валидации одного матча плей-офф:
  // - команды известны (не tbd/placeholder)
  // - счёт заполнен
  // - если ничья — выбран победитель по пенальти
  function isPlayoffMatchValid(bracket) {
    const { home, away } = getMatchTeams(bracket);
    if (home.tbd || away.tbd) return false;
    const s = pScores[bracket.id];
    if (!s || s.h === "" || s.h === undefined || s.a === "" || s.a === undefined) return false;
    if (+s.h === +s.a && !pPens[bracket.id]) return false;
    return true;
  }

  const allPlayoffBrackets = useMemo(() => [...R16, ...R8, ...QF, ...SF, THIRD_MATCH, FINAL_MATCH], []);

  const filledPlayoffCount = useMemo(() => {
    return allPlayoffBrackets.filter((b) => isPlayoffMatchValid(b)).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pScores, pPens, allTables, thirdRanking, allPlayoffBrackets]);

  // Бонус multi4 засчитывается только при ровно 4 выбранных
  const filledBonusCount = useMemo(() => {
    return BONUS_QS.filter((q) => {
      const ans = bonus[q.id];
      if (q.answerType === "player_multi") return Array.isArray(ans) && ans.filter(Boolean).length >= (q.count || 1);
      if (q.answerType === "score") {
        if (typeof ans === "string") return ans.includes(":") && ans.replace(":","").trim() !== "";
        if (ans && ans.h !== undefined) return ans.h !== "" && ans.a !== "";
        return false;
      }
      if (q.answerType === "number") return ans !== "" && ans !== null && ans !== undefined && String(ans).trim() !== "";
      if (q.type === "multi4") return Array.isArray(ans) && ans.length === 4;
      return !!ans;
    }).length;
  }, [bonus]);

  // Валидация сетки плей-офф (должна быть до allReady)
  const bracketErrors = useMemo(() => {
    if (!allGroupsComplete) return [];
    return validateRoundOf32(R16, allTables, thirdRanking);
  }, [allTables, thirdRanking, allGroupsComplete]);

  const allReady = filledGroupCount >= 72 && filledPlayoffCount >= 32 && filledBonusCount >= BONUS_QS.length && bracketErrors.length === 0;

  const setScore = (id, side, v) => {
    const n = v === "" ? "" : Math.min(20, Math.max(0, parseInt(v) || 0));
    setScores((p) => ({ ...p, [id]: { ...p[id], [side]: n } }));
  };
  const setPS = (id, side, v) => {
    const n = v === "" ? "" : Math.min(20, Math.max(0, parseInt(v) || 0));
    setPScores((p) => ({ ...p, [id]: { ...p[id], [side]: n } }));
  };
  const setPen = (id, val) => setPPens((p) => ({ ...p, [id]: p[id] === val ? "" : val }));

  // Резолв команды из предыдущего матча
  function resolveTeam(fromId, side) {
    const winner = getWinner(fromId, pScores, pPens);
    if (!winner) return { team: `Пр.${fromId}`, tbd: true };
    const bracket = allBrackets.find((b) => b.id === fromId);
    if (!bracket) return { team: "?", tbd: true };
    let home, away;
    if (bracket.home_key) {
      home = resolveKey(bracket.home_key, allTables, thirdRanking, bracket.id);
      away = resolveKey(bracket.away_key, allTables, thirdRanking, bracket.id);
    } else {
      home = resolveTeam(bracket.home_from.replace("_loser", ""), bracket.home_from.includes("_loser") ? "loser" : "win");
      away = resolveTeam(bracket.away_from.replace("_loser", ""), bracket.away_from.includes("_loser") ? "loser" : "win");
    }
    if (side === "loser") return winner === "home" ? away : home;
    return winner === "home" ? home : away;
  }

  function getMatchTeams(bracket) {
    if (bracket.home_key) {
      return {
        home: resolveKey(bracket.home_key, allTables, thirdRanking, bracket.id),
        away: resolveKey(bracket.away_key, allTables, thirdRanking, bracket.id),
      };
    }
    const hFrom = bracket.home_from.replace("_loser", "");
    const aFrom = bracket.away_from.replace("_loser", "");
    const hSide = bracket.home_from.includes("_loser") ? "loser" : "win";
    const aSide = bracket.away_from.includes("_loser") ? "loser" : "win";
    return { home: resolveTeam(hFrom, hSide), away: resolveTeam(aFrom, aSide) };
  }

  // ── PLAYOFF CARD ──
  function PlayoffCard({ bracket, isLocked = false }) {
    const { home, away } = getMatchTeams(bracket);
    const s = pScores[bracket.id] || {};
    const pen = pPens[bracket.id];
    const filled = s.h !== "" && s.h !== undefined && s.a !== "" && s.a !== undefined;
    const isDraw = filled && +s.h === +s.a;
    const homeWin = isDraw ? pen === "1" : filled && +s.h > +s.a;
    const awayWin = isDraw ? pen === "2" : filled && +s.a > +s.h;
    // Блокируем ввод если команды ещё не известны (tbd/placeholder)
    const teamsUnknown = home.tbd || away.tbd;
    const inputDisabled = isLocked || teamsUnknown;

    return (
      <div className="pm">
        <div style={{ fontSize: 9, color: "rgba(240,237,230,.3)", marginBottom: 6, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>
          {bracket.label}{bracket.date && <span style={{ fontWeight: 400, marginLeft: 6 }}>{bracket.date}{bracket.city && ` · ${bracket.city}`}</span>}
        </div>
        {(home.incomplete || away.incomplete) && (
          <div style={{ fontSize: 9, color: "rgba(245,158,11,.6)", marginBottom: 4 }}>* место может измениться</div>
        )}
        {teamsUnknown && (
          <div style={{ fontSize: 9, color: "rgba(245,158,11,.5)", marginBottom: 4 }}>⏳ Сначала заполни предыдущий раунд</div>
        )}
        <div className="pmt">
          <div className={`pmt-team${homeWin ? " win" : home.tbd ? " tbd" : ""}`}>{home.team}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <input className="sin" type="number" inputMode="numeric" min="0" max="20" placeholder="–" value={s.h ?? ""} disabled={inputDisabled} onChange={(e) => setPS(bracket.id, "h", e.target.value)} />
            <span className="ssep">:</span>
            <input className="sin" type="number" inputMode="numeric" min="0" max="20" placeholder="–" value={s.a ?? ""} disabled={inputDisabled} onChange={(e) => setPS(bracket.id, "a", e.target.value)} />
          </div>
          <div className={`pmt-team${awayWin ? " win" : away.tbd ? " tbd" : ""}`}>{away.team}</div>
        </div>
        {isDraw && !isLocked && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "rgba(240,237,230,.4)" }}>
            <span>Проходит:</span>
            <button className={`pen-btn${pen === "1" ? " on" : ""}`} disabled={isLocked} onClick={() => setPen(bracket.id, "1")}>{home.team.split(" ")[0]}</button>
            <button className={`pen-btn${pen === "2" ? " on" : ""}`} disabled={isLocked} onClick={() => setPen(bracket.id, "2")}>{away.team.split(" ")[0]}</button>
          </div>
        )}
        {isDraw && isLocked && pen && (
          <div style={{ fontSize: 10, color: "#86EFAC" }}>Проходит: {pen === "1" ? home.team : away.team}</div>
        )}
      </div>
    );
  }

  // ── TODAY MATCHES BLOCK ──
  const todayMatches = useMemo(() => getTodayMatches(), []);

  // ── RENDER ──
  return (
    <>
      <style>{S}</style>
      {/* ══ ЛЕНДИНГ ДЛЯ ГОСТЕЙ ══ */}
      {isGuest && (
        <>
          <LandingPage onLogin={() => setShowAuth(true)} />
          {showAuth && <AuthModal onClose={() => setShowAuth(false)} onAuth={afterSuccessfulAuth} />}
          {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
        </>
      )}
      {/* ══ ОСНОВНОЕ ПРИЛОЖЕНИЕ ══ */}
      {!isGuest && (
      <div className="app">
        {/* HEADER */}
        <header className="hdr">
          <div className="hdr-in">
            <div className="logo">
              <Logo size="sm" />
              <div><div className="la">Football Fight Club</div><div className="lb">ЧМ 2026 · Прогнозы</div></div>
            </div>
            <nav className="nav">
              <button className={`nb${tab === "predict" ? " on" : ""}`} onClick={() => setTab("predict")}>
                {isSubmitted ? "✅ Битва прогнозистов" : "Битва прогнозистов"}
              </button>
              <button className={`nb${tab === "clubs" ? " on" : ""}`} onClick={() => { setTab("clubs"); setClubsSubTab("home"); }}>⚽ Битва клубов</button>
              <button className={`nb${tab === "leaders" ? " on" : ""}`} onClick={() => setTab("leaders")}>Таблицы</button>
              {isAdmin && <button className={`nb${tab === "admin" ? " on" : ""}`} style={{ color: "#FCA5A5" }} onClick={() => setTab("admin")}>⚙ Админ</button>}
            </nav>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, position: "relative" }}>
              {!isGuest && (
                <ProfileMenu
                  profile={profile || { name: session?.user?.email?.split("@")[0] || "Профиль", fcoins_balance: null }}
                  isAdmin={isAdmin}
                  isPaid={isPaid}
                  onNavigate={(target) => {
                    if (target === "predict") setTab("predict");
                    else if (target === "clubs") { setTab("clubs"); setClubsSubTab("myclub"); }
                    else if (target === "payments") { setTab("clubs"); setClubsSubTab("home"); }
                    else if (target === "admin") setTab("admin");
                  }}
                  onLogout={async () => {
                    const keep = window.confirm("Оставить черновик прогнозов на этом устройстве?");
                    await supabaseClient.auth.signOut();
                    localStorage.removeItem("ffc_session");
                    if (!keep) {
                      localStorage.removeItem("ffc_guest_scores"); localStorage.removeItem("ffc_guest_playoff_scores");
                      localStorage.removeItem("ffc_guest_playoff_pens"); localStorage.removeItem("ffc_guest_bonus");
                      setScores({}); setPScores({}); setPPens({}); setBonus({});
                    }
                    setSession(null); setProfile(null); setPredStatus("draft");
                    showToast("Вы вышли из аккаунта");
                  }}
                />
              )}
              {isGuest && (
                <button className="bp" style={{ padding: "7px 16px", fontSize: 12 }} onClick={() => setShowAuth(true)}>
                  Войти
                </button>
              )}
            </div>
          </div>
        </header>

        {/* ══════════ ЛЕНДИНГ ДЛЯ ГОСТЕЙ ══════════ */}
        {isGuest && tab === "predict" && (
          <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 12px 120px" }}>

            {/* ── HERO ── */}
            <div style={{ textAlign: "center", padding: "52px 16px 40px" }}>
              <Logo size="xl" style={{ margin: "0 auto 24px" }} />
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F0EDE6", lineHeight: 1.15, marginBottom: 14, letterSpacing: 0.5 }}>
                Футбольные прогнозы<br />и клубные битвы на ЧМ 2026
              </div>
              <div style={{ fontSize: 15, color: "rgba(240,237,230,.55)", lineHeight: 1.75, marginBottom: 32, maxWidth: 520, margin: "0 auto 32px" }}>
                Делай прогнозы на матчи, собирай fantasy-состав, играй в Кубке FFC и Лиге FFC, зарабатывай F-Coins и соревнуйся с друзьями.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="bp" style={{ padding: "13px 28px", fontSize: 14 }} onClick={() => setShowAuth(true)}>
                  Войти и играть
                </button>
                <button className="sb" style={{ padding: "13px 28px", fontSize: 14 }} onClick={() => setShowAuth(true)}>
                  Создать клуб бесплатно
                </button>
              </div>
            </div>

            {/* ── КАК ЭТО РАБОТАЕТ ── */}
            <div style={{ marginBottom: 36 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 2.5, textAlign: "center", marginBottom: 20 }}>Как это работает</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { n: "1", icon: "👤", t: "Создай аккаунт" },
                  { n: "2", icon: "🛒", t: "Участвуй в Битве прогнозистов или создай клуб бесплатно" },
                  { n: "3", icon: "📋", t: "Делай прогнозы и собирай fantasy-состав" },
                  { n: "4", icon: "🪙", t: "Играй, набирай очки и зарабатывай F-Coins" },
                ].map((s) => (
                  <div key={s.n} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "16px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, color: "#F59E0B", fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>{s.n}</span>
                    <div>
                      <div style={{ fontSize: 20, marginBottom: 4 }}>{s.icon}</div>
                      <div style={{ fontSize: 13, color: "rgba(240,237,230,.7)", lineHeight: 1.5 }}>{s.t}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── ТУРНИРЫ ── */}
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 2.5, textAlign: "center", marginBottom: 16 }}>Турниры</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 36 }}>
              {[
                { icon: "🏆", name: "Битва прогнозистов", price: "500 ₽", desc: "Прогнозы на все матчи ЧМ-2026, матчи дня, таблица прогнозистов.", color: "#B91C1C" },
                { icon: "⚽", name: "Битва клубов", price: "Бесплатно", desc: "Fantasy-режим: 1 тренер + 7 игроков, капитан, очки за реальные матчи ЧМ.", color: "#15803d" },
                { icon: "🤝", name: "Командный зачёт", price: "от 2 чел.", desc: "Внутри Битве прогнозистов. Рейтинг по среднему баллу участников.", color: "#1d4ed8" },
              ].map((c) => (
                <div key={c.name} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderTop: `3px solid ${c.color}`, borderRadius: 10, padding: "16px 14px" }}>
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{c.icon}</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>{c.name}</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>{c.price}</div>
                  <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", lineHeight: 1.65 }}>{c.desc}</div>
                </div>
              ))}
            </div>

            {/* ── КЛУБНЫЕ БИТВЫ ── */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "20px", marginBottom: 16 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 10 }}>⚔️ Битва клубов</div>
              <div style={{ fontSize: 13, color: "rgba(240,237,230,.65)", lineHeight: 1.75, marginBottom: 12 }}>
                Собери состав: <strong style={{ color: "#FDE68A" }}>1 тренер, 1 вратарь, 2 защитника, 2 полузащитника, 2 нападающих</strong>. Назначь капитана среди 7 игроков, соблюдай лимиты и следи за реальным футболом.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  "максимум 2 игрока из одной сборной",
                  "максимум 1 звёздный игрок",
                  "капитан получает ×1.5 очков",
                  "тренер не может быть капитаном",
                  "2 бесплатные замены со второго тура",
                  "дополнительные замены за F-Coins",
                ].map((f) => (
                  <div key={f} style={{ fontSize: 12, color: "rgba(240,237,230,.55)", padding: "5px 0", display: "flex", gap: 6 }}>
                    <span style={{ color: "#15803d", flexShrink: 0 }}>✓</span>{f}
                  </div>
                ))}
              </div>
            </div>

            {/* ── F-COINS ── */}
            <div style={{ background: "rgba(245,158,11,.05)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 10, padding: "20px", marginBottom: 16 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 8 }}>🪙 F-Coins</div>
              <div style={{ fontSize: 13, color: "rgba(240,237,230,.65)", lineHeight: 1.75 }}>
                F-Coins — внутриигровая валюта. Её нельзя вывести в деньги, но можно тратить на игровые бонусы: дополнительную замену (300 🪙), запасного (500 🪙), скаута (300 🪙) и другие улучшения.
              </div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginTop: 10 }}>
                Как заработать: оплата Полного ЧМ (+500) · победы в Кубке FFC (+50) · проход раундов (+100)
              </div>
            </div>

            {/* ── FAQ ── */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "20px", marginBottom: 28 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 16 }}>❓ Частые вопросы</div>
              {[
                { q: "Как начисляются очки?", a: "За правильный прогноз на победителя или счёт матча. Капитан fantasy-состава получает ×1.5 очков за свои результаты." },
                { q: "Что такое F-Coins?", a: "Внутриигровая валюта. Нельзя вывести в деньги. Тратится на запасного, дополнительную замену, скаута и другие бонусы." },
                { q: "Можно ли играть бесплатно?", a: "Да. Бесплатно доступна Битва клубов: создай клуб и выбери fantasy-состав." },
                { q: "Что такое Командный зачёт?", a: "Команда от 2 человек. Рейтинг по среднему баллу участников в Битве прогнозистов. Доступно участникам Битве прогнозистов." },
                { q: "Как работает fantasy-состав?", a: "1 тренер + 1 вратарь + 2 защитника + 2 полузащитника + 2 нападающих. Назначь капитана среди 7 игроков — он получает ×1.5 очков. Макс. 2 из одной сборной, макс. 1 звезда." },
              ].map((faq, i, arr) => (
                <div key={faq.q} style={{ marginBottom: i < arr.length - 1 ? 14 : 0, paddingBottom: i < arr.length - 1 ? 14 : 0, borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
                  <div style={{ fontFamily: "Barlow Condensed,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 4 }}>{faq.q}</div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.65 }}>{faq.a}</div>
                </div>
              ))}
            </div>

            {/* ── CTA ФИНАЛЬНЫЙ ── */}
            <div style={{ textAlign: "center", background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 12, padding: "32px 20px" }}>
              <Logo size="md" style={{ margin: "0 auto 16px" }} />
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>Готов собрать свой клуб?</div>
              <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", marginBottom: 20 }}>Регистрация бесплатна. Битва клубов — бесплатно. Битва прогнозистов — 500 ₽.</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="bp" style={{ padding: "12px 28px", fontSize: 14 }} onClick={() => setShowAuth(true)}>Войти</button>
                <button className="sb" style={{ padding: "12px 28px", fontSize: 14 }} onClick={() => setShowAuth(true)}>Создать клуб бесплатно</button>
              </div>
            </div>

          </div>
        )}

        {/* ══════════ ВКЛАДКА: ОТПРАВИТЬ ПРОГНОЗ ══════════ */}
        {!isGuest && tab === "predict" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "14px 12px 140px" }}>

            {/* СТАТУС */}
            {isSubmitted && (
              <div style={{ background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.3)", borderRadius: 10, padding: "16px 20px", marginBottom: 16, textAlign: "center" }}>
                <div style={{ fontSize: 24, marginBottom: 4 }}>✅</div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#86EFAC", marginBottom: 4 }}>Прогноз отправлен и зафиксирован 🔒</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)" }}>Твой прогноз участвует в таблице лидеров. Редактирование недоступно.</div>
              </div>
            )}
            {isPending && (
              <div style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A", marginBottom: 4 }}>⏳ Оплата ожидает подтверждения организатором</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", lineHeight: 1.5 }}>После подтверждения прогноз будет зафиксирован. Обычно в течение нескольких часов.</div>
              </div>
            )}
            {!tournamentOpen && (
              <div style={{ background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.3)", borderRadius: 10, padding: "14px 18px", marginBottom: 16, textAlign: "center" }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FCA5A5" }}>🔒 Дедлайн прошёл. Прогнозы закрыты.</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginTop: 4 }}>Битва прогнозистов · Дедлайн: 11 июня 2026</div>
              </div>
            )}
            {tournamentOpen && (
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", textAlign: "center", marginBottom: 12 }}>
                🗓 Битва прогнозистов · Дедлайн: <strong style={{ color: "rgba(240,237,230,.5)" }}>11 июня 2026</strong>, старт первого матча ЧМ
              </div>
            )}

            {/* ПРОГРЕСС */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "14px 18px", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 600, color: allReady ? "#86EFAC" : "#F0EDE6" }}>
                  {allReady ? "✅ Прогноз готов к отправке" : "📝 Заполняется..."}
                </span>
                {!isSubmitted && !isPending && (
                  <button className="sb" onClick={save} disabled={saving}>{saving ? "Сохраняю..." : "Сохранить черновик"}</button>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 10 }}>
                {[["Групповой этап", filledGroupCount, 72], ["Плей-офф", filledPlayoffCount, 32], ["Бонусы", filledBonusCount, BONUS_QS.length]].map(([label, filled, total]) => (
                  <div key={label} style={{ textAlign: "center", background: "rgba(255,255,255,.04)", borderRadius: 6, padding: "8px 4px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: filled >= total ? "#86EFAC" : "#F59E0B" }}>
                      {filled}<span style={{ fontSize: 11, color: "rgba(240,237,230,.3)", fontFamily: "Barlow Condensed,sans-serif", fontWeight: 400 }}>/{total}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginTop: 2 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", lineHeight: 1.5 }}>
                Заполнить прогноз можно бесплатно. Оплата нужна только для отправки прогноза в турнир, попадания в таблицу лидеров и участия в призовом фонде.
              </div>
            </div>

            {/* СЕГОДНЯ ИГРАЮТ */}
            {todayMatches.length > 0 && (
              <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>⚽ Матчи дня (МСК)</div>
                {todayMatches.map((m) => {
                  const pred = scores?.[m.id];
                  const h = pred?.h !== undefined && pred.h !== "" ? parseInt(pred.h, 10) : NaN;
                  const a = pred?.a !== undefined && pred.a !== "" ? parseInt(pred.a, 10) : NaN;
                  const hasPred = !isNaN(h) && !isNaN(a);
                  // Определяем исход прогноза
                  const outcome = hasPred
                    ? (h > a ? `победа ${m.home}` : h < a ? `победа ${m.away}` : "ничья")
                    : null;
                  return (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13, flexWrap: "wrap" }}>
                      <span style={{ color: "#FDE68A", fontFamily: "Oswald,sans-serif", fontSize: 12, flexShrink: 0 }}>{m.timeMsk}</span>
                      <span style={{ color: "rgba(240,237,230,.4)", fontSize: 10, flexShrink: 0 }}>Гр.{m.group}</span>
                      <span style={{ color: "#F0EDE6", flex: 1, minWidth: 100 }}>{m.home} — {m.away}</span>
                      {hasPred ? (
                        <span style={{ fontSize: 11, color: "#86EFAC", background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>
                          Вы поставили: {h}:{a} · {outcome}
                        </span>
                      ) : (
                        <button
                          onClick={() => document.getElementById(`group-${m.group}`)?.scrollIntoView({ behavior: "smooth" })}
                          style={{ fontSize: 10, color: "rgba(240,237,230,.35)", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 4, padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap" }}>
                          Прогноз ↓
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ЯКОРНАЯ НАВИГАЦИЯ */}
            <div className="anchor-bar">
              {ALL_GROUPS.map((g) => {
                const done = groupCompleteness[g]?.complete;
                return (
                  <button key={g} className={`anch-btn${done ? " done" : ""}`}
                    onClick={() => document.getElementById(`group-${g}`)?.scrollIntoView({ behavior: "smooth" })}>
                    {g}{done ? " ✓" : ""}
                  </button>
                );
              })}
              <button className="anch-btn" onClick={() => document.getElementById("third-ranking")?.scrollIntoView({ behavior: "smooth" })}>3-и</button>
              <button className="anch-btn" onClick={() => document.getElementById("playoff-section")?.scrollIntoView({ behavior: "smooth" })}>1/16→</button>
              <button className="anch-btn" onClick={() => document.getElementById("bonus-section")?.scrollIntoView({ behavior: "smooth" })}>❓</button>
              <button className="anch-btn" style={{ background: "rgba(185,28,28,.2)", borderColor: "rgba(185,28,28,.35)", color: "#FCA5A5" }}
                onClick={() => document.getElementById("submit-section")?.scrollIntoView({ behavior: "smooth" })}>Отправить↓</button>
            </div>

            {/* ═══════ БЛОК 1: ГРУППОВОЙ ЭТАП ═══════ */}
            <div className="section-hdr">
              <span className="section-hdr-bar" style={{ background: "#B91C1C" }} />
              Групповой этап
              <span style={{ fontSize: 12, fontFamily: "Barlow Condensed,sans-serif", fontWeight: 400, color: "rgba(240,237,230,.35)", textTransform: "none", letterSpacing: 0 }}>72 матча</span>
            </div>

            {ALL_GROUPS.map((g) => {
              const tbl = allTables[g] || [];
              const thirdRow = tbl[2];
              const thirdRank = thirdRanking.findIndex((x) => x.group === g);
              const thirdQ = qualifiedThirds.has(g);
              const filledInGroup = groupCompleteness[g]?.filled || 0;
              const allFilledInGroup = filledInGroup === 6;

              return (
                <div key={g} id={`group-${g}`} style={{ marginBottom: 28 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <div style={{ background: "rgba(185,28,28,.2)", border: "1px solid rgba(185,28,28,.35)", borderRadius: 5, padding: "3px 10px", fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#FCA5A5" }}>Группа {g}</div>
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)" }}>{GROUPS[g].join(" · ")}</div>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: filledInGroup === 6 ? "#86EFAC" : "rgba(240,237,230,.3)" }}>{filledInGroup}/6{filledInGroup === 6 ? " ✓" : ""}</span>
                  </div>

                  <div className="group-grid">
                    {/* МАТЧИ */}
                    <div className="panel" style={{ margin: 0 }}>
                      {GROUP_MATCHES[g].map((m, i) => {
                        const s = scores[m.id] || {};
                        const hw = s.h !== "" && s.h !== undefined && s.a !== "" && s.a !== undefined && +s.h > +s.a;
                        const aw = s.h !== "" && s.h !== undefined && s.a !== "" && s.a !== undefined && +s.a > +s.h;
                        const locked = isSubmitted || isPending || !tournamentOpen;
                        return (
                          <div key={m.id} className="mr" style={{ padding: "7px 10px" }}>
                            <span style={{ fontSize: 9, color: "rgba(240,237,230,.2)", width: 12, flexShrink: 0 }}>{i + 1}</span>
                            <div style={{ flex: 1, fontSize: 12, fontWeight: 500, minWidth: 0, overflow: "hidden" }}>
                              <span style={{ color: hw ? "#86EFAC" : "#F0EDE6", fontWeight: hw ? 600 : 400 }}>{m.home}</span>
                              <span style={{ color: "rgba(240,237,230,.2)", margin: "0 2px", fontSize: 10 }}>–</span>
                              <span style={{ color: aw ? "#86EFAC" : "rgba(240,237,230,.65)", fontWeight: aw ? 600 : 400 }}>{m.away}</span>
                            </div>
                            {locked
                              ? <div style={{ fontSize: 12, fontFamily: "Oswald,sans-serif", color: "rgba(240,237,230,.4)" }}>
                                {s.h !== "" && s.h !== undefined ? `${s.h}:${s.a}` : <span style={{ fontSize: 10 }}>🔒</span>}
                              </div>
                              : <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                                <input className="sin" type="number" inputMode="numeric" min="0" max="20" placeholder="–" value={s.h ?? ""} onChange={(e) => setScore(m.id, "h", e.target.value)} style={{ width: 34, height: 36 }} />
                                <span className="ssep">:</span>
                                <input className="sin" type="number" inputMode="numeric" min="0" max="20" placeholder="–" value={s.a ?? ""} onChange={(e) => setScore(m.id, "a", e.target.value)} style={{ width: 34, height: 36 }} />
                              </div>
                            }
                          </div>
                        );
                      })}
                    </div>

                    {/* ТАБЛИЦА ГРУППЫ */}
                    <div>
                      <div className="panel" style={{ margin: 0 }}>
                        <div className="ph" style={{ padding: "8px 10px" }}>
                          <span className="pt" style={{ fontSize: 11 }}>Таблица Гр.{g}</span>
                          <span className="tag tg" style={{ fontSize: 8 }}>⚡ живая</span>
                        </div>
                        <div style={{ overflowX: "auto" }}>
                          <table className="tbl" style={{ minWidth: 260 }}>
                            <thead>
                              <tr><th>#</th><th>Команда</th><th>И</th><th>О</th><th>±</th><th>Г</th><th>Статус</th></tr>
                            </thead>
                            <tbody>
                              {tbl.map((row, i) => {
                                const isT = i === 2; const tQ = isT && thirdQ;
                                const bg = i < 2 ? "rgba(22,163,74,.04)" : isT && row.played > 0 ? (tQ ? "rgba(22,163,74,.06)" : "rgba(185,28,28,.05)") : "transparent";
                                const st = row.played === 0 ? <span style={{ fontSize: 9, color: "rgba(240,237,230,.2)" }}>–</span>
                                  : i < 2 ? <span className="third-ok" style={{ fontSize: 9 }}>✓ 1/16</span>
                                    : isT ? (tQ ? <span className="third-ok" style={{ fontSize: 9 }}>{thirdRank + 1}-е ✓</span> : <span className="third-no" style={{ fontSize: 9 }}>{thirdRank + 1}-е ✗</span>)
                                      : <span className="third-no" style={{ fontSize: 9 }}>✗</span>;
                                return (
                                  <tr key={row.team} style={{ background: bg }}>
                                    <td><span className="pos" style={{ background: i < 2 ? "rgba(22,163,74,.3)" : isT && tQ ? "rgba(22,163,74,.2)" : isT ? "rgba(185,28,28,.2)" : "rgba(255,255,255,.04)", color: i < 2 ? "#86EFAC" : isT && tQ ? "#86EFAC" : isT ? "#FCA5A5" : "rgba(240,237,230,.2)", fontSize: 10 }}>{i + 1}</span></td>
                                    <td style={{ fontSize: 12, color: "#F0EDE6", fontWeight: i < 2 ? 500 : 400 }}>{row.team}</td>
                                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{row.played}</td>
                                    <td style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, color: "#F59E0B" }}>{row.pts}</td>
                                    <td style={{ fontSize: 11, color: row.gd > 0 ? "#86EFAC" : row.gd < 0 ? "#FCA5A5" : "rgba(240,237,230,.4)" }}>{row.gd > 0 ? "+" : ""}{row.gd}</td>
                                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{row.gf}</td>
                                    <td>{st}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        {/* Статус 3-го места */}
                        {thirdRow && thirdRow.played > 0 && (
                          <div style={{ padding: "6px 10px", fontSize: 10, color: "rgba(240,237,230,.4)", borderTop: "1px solid rgba(255,255,255,.04)" }}>
                            3-е место · {thirdRow.team} — {thirdRank >= 0 ? `${thirdRank + 1}-е из 12` : "?"} {thirdQ ? <span style={{ color: "#86EFAC" }}>✓ проходит</span> : <span style={{ color: "#FCA5A5" }}>✗ вылетает</span>}
                            {!allFilledInGroup && <span style={{ color: "rgba(245,158,11,.6)" }}> · предварительно</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* ═══════ БЛОК 2: РЕЙТИНГ ТРЕТЬИХ МЕСТ ═══════ */}
            <div id="third-ranking" style={{ marginBottom: 28 }}>
              <div className="section-hdr">
                <span className="section-hdr-bar" style={{ background: "#F59E0B" }} />
                Рейтинг третьих мест
                <span style={{ fontSize: 12, fontFamily: "Barlow Condensed,sans-serif", fontWeight: 400, color: "rgba(240,237,230,.35)", textTransform: "none", letterSpacing: 0 }}>
                  проходят 8 из 12
                </span>
              </div>
              <div className="panel">
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ minWidth: 400 }}>
                    <thead>
                      <tr><th>#</th><th>Гр.</th><th>Команда</th><th>О</th><th>±</th><th>Г</th><th>FP</th><th>FIFA</th><th>Статус</th></tr>
                    </thead>
                    <tbody>
                      {thirdRanking.map((row, i) => {
                        const qualifies = i < 8;
                        const fp = calcFairPlay(row.team, discipline);
                        return (
                          <tr key={row.group} style={{ background: qualifies ? "rgba(22,163,74,.04)" : "rgba(185,28,28,.03)" }}>
                            <td><span className="pos" style={{ background: qualifies ? "rgba(22,163,74,.3)" : "rgba(185,28,28,.2)", color: qualifies ? "#86EFAC" : "#FCA5A5", fontSize: 10 }}>{i + 1}</span></td>
                            <td style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, color: "#F59E0B", fontWeight: 700 }}>{row.group}</td>
                            <td style={{ fontSize: 12, color: "#F0EDE6", fontWeight: qualifies ? 500 : 400 }}>{row.team}</td>
                            <td style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, color: "#F59E0B" }}>{row.pts}</td>
                            <td style={{ fontSize: 11, color: row.gd > 0 ? "#86EFAC" : row.gd < 0 ? "#FCA5A5" : "rgba(240,237,230,.4)" }}>{row.gd > 0 ? "+" : ""}{row.gd}</td>
                            <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{row.gf}</td>
                            <td style={{ fontSize: 11, color: fp < 0 ? "#FCA5A5" : "rgba(240,237,230,.4)" }}>{fp}</td>
                            <td style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>{getFifaRank(row.team) === 999 ? "?" : getFifaRank(row.team)}</td>
                            <td>{qualifies ? <span className="third-ok" style={{ fontSize: 9 }}>✓ проходит</span> : <span className="third-no" style={{ fontSize: 9 }}>✗ вылетает</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {thirdRanking.length < 12 && (
                  <div style={{ padding: "8px 14px", fontSize: 11, color: "rgba(240,237,230,.35)" }}>
                    Заполни матчи групп, чтобы увидеть полный рейтинг третьих мест.
                  </div>
                )}
              </div>
            </div>

            {/* ═══════ БЛОК 3: ПЛЕЙ-ОФФ ═══════ */}
            <div id="playoff-section" style={{ marginBottom: 8 }}>
              <div className="section-hdr">
                <span className="section-hdr-bar" style={{ background: "#60A5FA" }} />
                Плей-офф
                <span style={{ fontSize: 12, fontFamily: "Barlow Condensed,sans-serif", fontWeight: 400, color: "rgba(240,237,230,.35)", textTransform: "none", letterSpacing: 0 }}>32 матча</span>
              </div>

              {!allGroupsComplete && (
                <div style={{ background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 6, padding: "8px 14px", marginBottom: 14, fontSize: 12, color: "rgba(240,237,230,.55)" }}>
                  ⚠️ Сетка предварительная — заполни все 72 матча групп для точных пар.
                </div>
              )}

              {bracketErrors.length > 0 && (
                <div style={{ background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.3)", borderRadius: 6, padding: "10px 14px", marginBottom: 14 }}>
                  {bracketErrors.map((e, i) => (
                    <div key={i} style={{ fontSize: 11, color: "#FCA5A5", marginBottom: 3 }}>⚠ {e}</div>
                  ))}
                </div>
              )}

              {/* Навигация */}
              <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
                {[["po-r16", "1/16 (16)"], ["po-r8", "1/8 (8)"], ["po-qf", "1/4 (4)"], ["po-sf", "Полу + Финал"]].map(([id, l]) => (
                  <button key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })}
                    style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.6)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 4, cursor: "pointer" }}>{l}</button>
                ))}
              </div>

              <div id="po-r16" style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(240,237,230,.5)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>1/16 финала</div>
                <div className="po-grid">{R16.map((b) => <PlayoffCard key={b.id} bracket={b} isLocked={isSubmitted || isPending} />)}</div>
              </div>

              <div id="po-r8" style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(240,237,230,.5)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>1/8 финала</div>
                <div className="po-grid">{R8.map((b) => <PlayoffCard key={b.id} bracket={b} isLocked={isSubmitted || isPending} />)}</div>
              </div>

              <div id="po-qf" style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(240,237,230,.5)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>1/4 финала</div>
                <div className="po-grid">{QF.map((b) => <PlayoffCard key={b.id} bracket={b} isLocked={isSubmitted || isPending} />)}</div>
              </div>

              <div id="po-sf" style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "rgba(240,237,230,.5)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Полуфиналы · Матч за 3-е · Финал</div>
                <div className="po-grid">
                  {SF.map((b) => <PlayoffCard key={b.id} bracket={b} isLocked={isSubmitted || isPending} />)}
                  <PlayoffCard bracket={THIRD_MATCH} isLocked={isSubmitted || isPending} />
                  <PlayoffCard bracket={FINAL_MATCH} isLocked={isSubmitted || isPending} />
                </div>
              </div>

              <div style={{ padding: "10px 14px", background: "rgba(255,255,255,.025)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, fontSize: 11, color: "rgba(240,237,230,.4)", lineHeight: 1.7, marginBottom: 4 }}>
                <strong style={{ color: "#FDE68A" }}>Очки:</strong> 8 (точный счёт) · 5 (разница) · 3 (исход) · 1 (частично) · 0 (промах)<br />
                При ничье в матче на вылет выбери победителя по пенальти.
              </div>
            </div>

            {/* ═══════ БЛОК 4: БОНУСНЫЕ ВОПРОСЫ ═══════ */}
            <div id="bonus-section" style={{ marginBottom: 8, paddingTop: 8 }}>
              <div className="section-hdr">
                <span className="section-hdr-bar" style={{ background: "#86EFAC" }} />
                Бонусные вопросы
                <span style={{ fontSize: 12, fontFamily: "Barlow Condensed,sans-serif", fontWeight: 400, color: "rgba(240,237,230,.35)", textTransform: "none", letterSpacing: 0 }}>{filledBonusCount}/{BONUS_QS.length} отвечено</span>
              </div>
              {BONUS_QS.map((q, i) => {
                const ans = bonus[q.id];
                const locked = isSubmitted || isPending;
                // Считаем заполненность по типу
                let done = false;
                if (q.answerType === "player_multi") done = Array.isArray(ans) && ans.filter(Boolean).length >= q.count;
                else if (q.answerType === "score") done = typeof ans === "string" ? ans.includes(":") : !!(ans?.h !== undefined && ans?.h !== "");
                else if (q.answerType === "number") done = ans !== "" && ans !== null && ans !== undefined && String(ans).trim() !== "";
                else done = !!ans;

                // Отображение текущего ответа
                const displayAns = () => {
                  if (!ans) return null;
                  if (q.answerType === "player_multi") return Array.isArray(ans) ? ans.filter(Boolean).join(", ") : null;
                  if (q.answerType === "score") return typeof ans === "string" ? ans : (ans?.h !== undefined ? `${ans.h}:${ans.a}` : null);
                  return String(ans);
                };

                return (
                  <div key={q.id} className={`qcard${done ? " done" : ""}`} style={{ pointerEvents: locked ? "none" : "auto", opacity: locked && !done ? 0.6 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
                      <div style={{ display: "flex", gap: 7, alignItems: "flex-start", flex: 1 }}>
                        <span style={{ fontSize: 10, color: "rgba(240,237,230,.25)", minWidth: 20, marginTop: 2 }}>#{i+1}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#F0EDE6" }}>{q.text}</div>
                          {q.help && <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginTop: 2 }}>{q.help}</div>}
                          {q.answerType === "player_multi" && (
                            <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginTop: 2 }}>
                              Выбрано: {Array.isArray(ans) ? ans.filter(Boolean).join(", ") || "–" : "–"} ({(Array.isArray(ans) ? ans.filter(Boolean).length : 0)}/{q.count})
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F59E0B" }}>
                          {q.pts_breakdown || q.pts}
                        </span>
                        <span style={{ fontSize: 9, color: "rgba(240,237,230,.3)" }}>оч.</span>
                        {done && <span style={{ color: "#16A34A", fontSize: 13 }}>✓</span>}
                      </div>
                    </div>

                    {/* Отображение ответа в заблокированном состоянии */}
                    {locked && displayAns() && (
                      <div style={{ fontSize: 12, color: "#86EFAC", fontWeight: 500, marginTop: 4 }}>✓ {displayAns()}</div>
                    )}

                    {/* Интерактивная часть */}
                    {!locked && (
                      <>
                        {/* PLAYER или TEAM: популярные варианты + Другой */}
                        {(q.answerType === "player" || q.answerType === "team") && q.popularOptions && (
                          <div className="opts">
                            {q.popularOptions.map(o => (
                              <button key={o} className={`opt${ans === o ? " on" : ""}`}
                                onClick={() => setBonus(p => ({ ...p, [q.id]: ans === o ? null : o }))}>
                                {o}
                              </button>
                            ))}
                            <button className={`opt${ans && !q.popularOptions.includes(ans) ? " on" : ""}`}
                              onClick={() => setBonusPickerOpen({ qid: q.id, type: q.answerType, slotIdx: null, excludeNames: [] })}>
                              {q.answerType === "team" ? "Другая…" : "Другой…"}
                            </button>
                            {ans && !q.popularOptions.includes(ans) && (
                              <span style={{ fontSize: 11, color: "#FDE68A", padding: "4px 8px" }}>✎ {ans}</span>
                            )}
                          </div>
                        )}

                        {/* PLAYER_MULTI: count слотов */}
                        {q.answerType === "player_multi" && (
                          <div>
                            {Array.from({length: q.count}).map((_, si) => {
                              const curArr = Array.isArray(ans) ? ans : [];
                              const slotVal = curArr[si] || null;
                              return (
                                <div key={si} style={{ marginBottom: 6 }}>
                                  <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginBottom: 4 }}>Игрок {si+1}{slotVal ? `: ${slotVal}` : ""}</div>
                                  <div className="opts">
                                    {q.popularOptions.map(o => {
                                      const isInOther = curArr.some((v,vi) => v === o && vi !== si);
                                      if (isInOther) return null;
                                      return (
                                        <button key={o} className={`opt${slotVal === o ? " on" : ""}`}
                                          onClick={() => {
                                            const next = [...curArr];
                                            while (next.length < q.count) next.push(null);
                                            next[si] = slotVal === o ? null : o;
                                            setBonus(p => ({ ...p, [q.id]: next }));
                                          }}>
                                          {o}
                                        </button>
                                      );
                                    })}
                                    <button className="opt"
                                      onClick={() => setBonusPickerOpen({ qid: q.id, type: "player", slotIdx: si, excludeNames: (Array.isArray(ans) ? ans.filter((v,vi) => vi !== si && v) : []) })}>
                                      Другой…</button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* NUMBER */}
                        {q.answerType === "number" && (
                          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="number" min="0" max="99"
                              value={ans ?? ""}
                              onChange={e => setBonus(p => ({ ...p, [q.id]: e.target.value }))}
                              placeholder="0"
                              style={{ width: 80, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 6, color: "#F0EDE6", fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, textAlign: "center", padding: "6px 8px", outline: "none" }}
                            />
                          </div>
                        )}

                        {/* SCORE */}
                        {q.answerType === "score" && (
                          <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                            <input type="number" min="0" max="20"
                              value={typeof ans === "string" ? ans.split(":")[0] ?? "" : ans?.h ?? ""}
                              onChange={e => {
                                const other = typeof ans === "string" ? (ans.split(":")[1] ?? "") : (ans?.a ?? "");
                                setBonus(p => ({ ...p, [q.id]: `${e.target.value}:${other}` }));
                              }}
                              placeholder="0"
                              style={{ width: 52, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 6, color: "#F59E0B", fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, textAlign: "center", padding: "6px", outline: "none" }}
                            />
                            <span style={{ fontSize: 18, color: "rgba(240,237,230,.4)" }}>:</span>
                            <input type="number" min="0" max="20"
                              value={typeof ans === "string" ? ans.split(":")[1] ?? "" : ans?.a ?? ""}
                              onChange={e => {
                                const other = typeof ans === "string" ? (ans.split(":")[0] ?? "") : (ans?.h ?? "");
                                setBonus(p => ({ ...p, [q.id]: `${other}:${e.target.value}` }));
                              }}
                              placeholder="0"
                              style={{ width: 52, background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 6, color: "#F59E0B", fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, textAlign: "center", padding: "6px", outline: "none" }}
                            />
                            {typeof ans === "string" && ans.includes(":") && (
                              <span style={{ fontSize: 12, color: "#86EFAC" }}>✓ {ans}</span>
                            )}
                          </div>
                        )}

                        {/* Legacy opts (обратная совместимость) */}
                        {q.opts && !q.answerType && (
                          <div className="opts">
                            {q.opts.map(o => (
                              <button key={o} className={`opt${q.type === "multi4" ? " multi" : ""}${q.type === "multi4" ? (Array.isArray(ans) && ans.includes(o) ? " on" : "") : (ans === o ? " on" : "")}`}
                                onClick={() => {
                                  if (q.type === "multi4") setBonus(p => { const cur = Array.isArray(p[q.id]) ? p[q.id] : []; const has = cur.includes(o); if (has) return { ...p, [q.id]: cur.filter(x => x !== o) }; if (cur.length >= 4) return p; return { ...p, [q.id]: [...cur, o] }; });
                                  else setBonus(p => ({ ...p, [q.id]: o }));
                                }}>
                                {o}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Picker модалки для бонусных вопросов */}
            {bonusPickerOpen && bonusPickerOpen.type === "player" && (
              <PlayerSearchModal
                excludeNames={bonusPickerOpen.excludeNames || []}
                onSelect={name => {
                  const { qid, slotIdx } = bonusPickerOpen;
                  if (slotIdx !== null && slotIdx !== undefined) {
                    const q = BONUS_QS.find(x => x.id === qid);
                    setBonus(p => {
                      const cur = Array.isArray(p[qid]) ? [...p[qid]] : Array(q?.count || 3).fill(null);
                      while (cur.length < (q?.count || 3)) cur.push(null);
                      cur[slotIdx] = name;
                      return { ...p, [qid]: cur };
                    });
                  } else {
                    setBonus(p => ({ ...p, [qid]: name }));
                  }
                  setBonusPickerOpen(null);
                }}
                onClose={() => setBonusPickerOpen(null)}
              />
            )}
            {bonusPickerOpen && bonusPickerOpen.type === "team" && (
              <TeamPickerModal
                onSelect={name => { setBonus(p => ({ ...p, [bonusPickerOpen.qid]: name })); setBonusPickerOpen(null); }}
                onClose={() => setBonusPickerOpen(null)}
              />
            )}

            {/* ═══════ БЛОК 6: ФИНАЛЬНАЯ ОТПРАВКА ═══════ */}
            <div id="submit-section" style={{ marginTop: 24, background: "rgba(255,255,255,.035)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12, padding: "24px 20px", textAlign: "center" }}>
              {isSubmitted ? (
                <>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#86EFAC", marginBottom: 6 }}>Прогноз отправлен и зафиксирован 🔒</div>
                  <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)" }}>Твой прогноз участвует в таблице лидеров. Редактирование недоступно.</div>
                </>
              ) : isPending ? (
                <>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>⏳</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>Оплата ожидает подтверждения организатором</div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", lineHeight: 1.6 }}>После подтверждения прогноз будет зафиксирован в турнире.</div>
                </>
              ) : (
                <>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: allReady ? "#F0EDE6" : "rgba(240,237,230,.4)", marginBottom: 8 }}>
                    {allReady ? "Прогноз готов к отправке 🎯" : "Прогноз пока не готов"}
                  </div>
                  {!allReady && (
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", marginBottom: 12, textAlign: "left", background: "rgba(255,255,255,.04)", borderRadius: 6, padding: "10px 14px" }}>
                      Осталось заполнить:
                      {filledGroupCount < 72 && <div style={{ marginTop: 2 }}>· {72 - filledGroupCount} матчей группового этапа</div>}
                      {filledPlayoffCount < 32 && <div style={{ marginTop: 2 }}>· {32 - filledPlayoffCount} матчей плей-офф</div>}
                      {filledBonusCount < BONUS_QS.length && <div style={{ marginTop: 2 }}>· {BONUS_QS.length - filledBonusCount} бонусных вопросов</div>}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 16, lineHeight: 1.5 }}>
                    Заполнить прогноз можно бесплатно.<br />
                    После отправки прогноз изменить нельзя.
                  </div>
                  <button
                    className="bp"
                    style={{ padding: "13px 32px", fontSize: 15, opacity: allReady ? 1 : 0.5, cursor: allReady ? "pointer" : "default", width: "100%", maxWidth: 360 }}
                    onClick={async () => {
                      if (!allReady) return;
                      if (isGuest) {
                        setPendingPlanAfterAuth(PLANS[0]);
                        setShowAuth(true);
                        return;
                      }
                      await save();
                      setShowPayment(PLANS[0]);
                    }}>
                    Отправить прогноз в турнир
                  </button>
                  {!allReady && <div style={{ marginTop: 8, fontSize: 10, color: "rgba(240,237,230,.25)" }}>Заполни все разделы чтобы отправить</div>}
                </>
              )}
            </div>

            {/* КОМАНДНЫЙ ЗАЧЁТ */}
            {!isGuest && (
              <div className="main" style={{ marginTop: 8 }}>
                <PredictorTeamBlock
                  session={session}
                  profile={profile}
                  isPaid={isPaid}
                  showToast={showToast}
                />
              </div>
            )}

            {/* ЕЖЕДНЕВНЫЙ КВИЗ */}
            {!isGuest && (
              <div className="main" style={{ marginTop: 8 }}>
                <DailyQuizBlock session={session} showToast={showToast} />
              </div>
            )}

          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: КЛУБНЫЕ БИТВЫ ══════════ */}
        {tab === "clubs" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div className="main">

            {/* Суб-навигация */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,.07)", paddingBottom: 12 }}>
              {[
                ["home", "🏠 Главная"],
                ["myclub", "🏟 Мой клуб"],
                ["lineup", "📋 Состав"],
                ["cup", "⚔ Пары тура"],
                ["league", "📊 Таблица клубов"],
                ["shop", "🛒 Магазин"],
                ["howto", "📖 Как играть"],
              ].map(([key, label]) => (
                <button key={key} onClick={() => setClubsSubTab(key)}
                  style={{ background: clubsSubTab === key ? "rgba(29,78,216,.3)" : "rgba(255,255,255,.04)", border: clubsSubTab === key ? "1px solid rgba(29,78,216,.6)" : "1px solid rgba(255,255,255,.08)", color: clubsSubTab === key ? "#93C5FD" : "rgba(240,237,230,.5)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 5, cursor: "pointer" }}>
                  {label}
                </button>
              ))}
            </div>

            {/* ── ГЛАВНАЯ: 3 карточки тарифов ── */}
            {clubsSubTab === "home" && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
                  <div style={{ width: 48, height: 48, borderRadius: "50%", background: "linear-gradient(135deg, #B91C1C 0%, #15803d 100%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "3px solid rgba(245,158,11,.5)" }}>
                    <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#F59E0B" }}>FFC</span>
                  </div>
                  <div>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F0EDE6" }}>Football Fight Club</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", textTransform: "uppercase", letterSpacing: 1.5 }}>ЧМ 2026</div>
                  </div>
                </div>

                {/* 3 карточки */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
                  {/* Битва прогнозистов */}
                  <div className="mode-card champ" style={{ padding: "16px 14px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>🏆 Битва прогнозистов</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#F59E0B", fontFamily: "Oswald,sans-serif", marginBottom: 8 }}>500 ₽</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 10, lineHeight: 1.65 }}>
                      Прогнозы на матчи, плей-офф и бонусные вопросы. Общая таблица и командный зачёт.
                    </div>
                    {isPaid ? (
                      <div>
                        <div style={{ fontSize: 11, color: "#86EFAC", marginBottom: 8 }}>✓ Битва прогнозистов активна</div>
                        <button className="sb" style={{ width: "100%", fontSize: 11 }} onClick={() => setTab("predict")}>Перейти к прогнозам →</button>
                      </div>
                    ) : (
                      <button className="bp" style={{ width: "100%", padding: "8px", fontSize: 12 }}
                        onClick={() => { if (isGuest) { setShowAuth(true); return; } setShowPayment(PLANS[0]); }}>
                        Участвовать за 500 ₽
                      </button>
                    )}
                  </div>

                  {/* Битва клубов */}
                  <div className="mode-card clubs" style={{ padding: "16px 14px", borderLeft: "4px solid #16A34A" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>⚽ Битва клубов</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#86EFAC", background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.25)", borderRadius: 4, padding: "3px 8px", display: "inline-block", marginBottom: 8 }}>БЕСПЛАТНО</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 8, lineHeight: 1.65 }}>
                      Fantasy-режим: 1 тренер + 7 игроков, капитан, очки за реальные матчи ЧМ.
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 10 }}>
                      👥 Участников: <strong style={{ color: "#86EFAC" }}>{cupCount !== null ? cupCount : "…"}</strong>
                    </div>
                    <button className="bp" style={{ width: "100%", padding: "8px", fontSize: 12, background: "#15803d" }}
                      onClick={() => {
                        if (isGuest) { setShowAuth(true); return; }
                        if (!profile?.club_name) { setClubsSubTab("createclub"); }
                        else { setClubsSubTab("lineup"); }
                      }}>
                      {profile?.club_name ? "Выбрать состав" : "Создать клуб бесплатно"}
                    </button>
                  </div>

                  {/* Командный зачёт */}
                  <div className="mode-card" style={{ padding: "16px 14px", gridColumn: "1 / -1", background: "rgba(245,158,11,.04)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 10 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>🤝 Командный зачёт</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 10, lineHeight: 1.65 }}>
                      Часть Битве прогнозистов. Соберите команду от 2 человек — рейтинг по среднему баллу участников.
                    </div>
                    <button className="sb" style={{ fontSize: 12 }}
                      onClick={() => { setTab("predict"); }}>
                      {isPaid ? "Собрать команду →" : "Доступно участникам Битве прогнозистов"}
                    </button>
                  </div>
                </div>

                {/* Подсказка о командном зачёте */}
                <div style={{ fontSize: 11, color: "rgba(240,237,230,.3)", textAlign: "center", marginBottom: 16 }}>
                  Командный зачёт — в разделе «Битва прогнозистов»
                </div>

                {/* ПРАВИЛА И ОЧКИ БИТВЫ КЛУБОВ */}
                <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "16px 16px 8px", marginBottom: 8 }}>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#86EFAC", marginBottom: 12 }}>
                    ⚽ Правила Битвы клубов
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", lineHeight: 1.8, marginBottom: 10 }}>
                    Бесплатная fantasy-добавка. Каждый тур выбери состав из 8 человек:
                    <strong style={{ color: "#F0EDE6" }}> 1 тренер + 1 вратарь + 2 защитника + 2 полузащитника + 2 нападающих</strong>.
                    Капитан (только среди 7 футболистов) получает <strong style={{ color: "#FDE68A" }}>×1.5 очков</strong>.
                    Макс. 2 из одной сборной, макс. 1 звезда.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                    {[
                      { pos: "🧤 Вратарь", rows: ["+6 сухой матч","+8 пенальти отбит","+3 победа команды","+2 старт","−1 пропущенный","−1 жёлтая / −4 красная"] },
                      { pos: "🛡 Защитник", rows: ["+5 сухой матч","+8 гол · +5 ассист","+2 победа команды","+2 старт","−1 жёлтая / −4 красная"] },
                      { pos: "⚡ Полузащитник", rows: ["+6 гол · +5 ассист","+2 победа команды","+2 старт","−1 жёлтая / −4 красная"] },
                      { pos: "⚽ Нападающий", rows: ["+5 гол (+3 дубль, +6 хет)","+4 ассист","+2 старт","−3 незабитый пенальти","−1 жёлтая / −4 красная"] },
                      { pos: "🧑‍💼 Тренер", rows: ["+5 победа · +2 ничья","+2 если команда забила 3+","−2 красная в команде"] },
                      { pos: "🔄 Замены", rows: ["Первый тур — свободно","Со 2-го тура: 2 бесплатные","Смена капитана — бесплатно","Доп. замены — за F-Coins"] },
                    ].map(g => (
                      <div key={g.pos} style={{ background: "rgba(0,0,0,.15)", borderRadius: 7, padding: "10px 12px" }}>
                        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>{g.pos}</div>
                        {g.rows.map(r => (
                          <div key={r} style={{ fontSize: 11, color: r.startsWith("−") || r.startsWith("-") ? "#FCA5A5" : "rgba(240,237,230,.65)", marginBottom: 2 }}>{r}</div>
                        ))}
                      </div>
                    ))}
                  </div>
                  {activeRound && (
                    <div style={{ fontSize: 11, color: "#FDE68A", background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 6, padding: "8px 12px" }}>
                      {(() => {
                        const now = new Date();
                        const dl = activeRound.deadline ? new Date(activeRound.deadline) : null;
                        if (dl && now < dl) {
                          return `🟢 ${activeRound.name} открыт до ${dl.toLocaleString("ru", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" })} МСК`;
                        }
                        return `🔒 ${activeRound.name} закрыт. Ждите следующего тура.`;
                      })()}
                    </div>
                  )}
                </div>

                {/* Блок «Что делать дальше?» — если есть клуб */}
                {!isGuest && profile?.club_name && (
                  <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#93C5FD", marginBottom: 10 }}>📌 Что делать дальше?</div>
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", lineHeight: 2 }}>
                      <div>1. Дождись открытия тура</div>
                      <div>2. Выбери fantasy-состав: 1 тренер, 1 вратарь, 2 защитника, 2 полузащитника, 2 нападающих</div>
                      <div>3. Назначь капитана среди 7 игроков (×1.5 очков) — тренер капитаном не может быть</div>
                      <div>4. Следи за реальными матчами ЧМ и таблицей клубов</div>
                      <div>5. Получай очки и F-Coins за победы</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("lineup")}>📋 Перейти к составу</button>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("cup")}>⚔ Пары тура</button>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("league")}>📊 Таблица клубов</button>
                      {isAdmin && <button className="sb" style={{ fontSize: 11, color: "#FCA5A5" }} onClick={() => setTab("admin")}>⚙ Открыть AdminFFC</button>}
                    </div>
                  </div>
                )}

                {/* Блок для гостей */}
                {isGuest && (
                  <div style={{ textAlign: "center", padding: "20px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 10, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, color: "rgba(240,237,230,.4)", marginBottom: 10 }}>Войди чтобы создать клуб и участвовать в Битве клубов</div>
                    <button className="bp" style={{ padding: "9px 20px" }} onClick={() => setShowAuth(true)}>Войти</button>
                  </div>
                )}

                {/* Блок для админа — как запустить тур */}
                {isAdmin && (
                  <div style={{ background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.2)", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 700, color: "#FCA5A5", marginBottom: 8 }}>🔧 Как запустить тестовый тур</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", lineHeight: 1.9 }}>
                      <div>1. Админ → FFC → Игроки → Добавить демо-игроков или импорт CSV</div>
                      <div>2. Администратор → FFC → Туры → Создать тур</div>
                      <div>3. Поставить статус: <code style={{ background: "rgba(255,255,255,.08)", padding: "1px 5px", borderRadius: 2 }}>lineup_open</code></div>
                      <div>4. Указать дедлайн в будущем</div>
                      <div>5. Пользователи выбирают составы</div>
                      <div>6. Генерировать пары тура и таблицу клубов</div>
                      <div>7. Ввести статистику игроков</div>
                      <div>8. Пересчитать матчи</div>
                    </div>
                    <button className="sb" style={{ marginTop: 10, fontSize: 11, color: "#FCA5A5" }} onClick={() => setTab("admin")}>⚙ Открыть Админ → FFC</button>
                  </div>
                )}

                {/* F-Coins */}
                {!isGuest && (
                  <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 20 }}>🪙</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#FDE68A" }}>F-Coins</div>
                        <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>Нельзя вывести в деньги · тратишь на запасного, скаута, доп. замены</div>
                      </div>
                      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 24, fontWeight: 700, color: "#F59E0B" }}>{profile?.fcoins_balance || 0}</div>
                    </div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginTop: 8, lineHeight: 1.7 }}>
                      Как заработать: открой Битву прогнозистов (+500) · участвуй в активностях Football Fight Club · побеждай в Битве клубов (+50 за победу, +100 за раунд)
                    </div>
                    <button className="sb" style={{ marginTop: 8, fontSize: 11 }} onClick={() => { setClubsSubTab("shop"); loadFcoinsHistory(); }}>
                      История транзакций →
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── СОЗДАНИЕ КЛУБА ── */}
            {(clubsSubTab === "createclub" || (clubsSubTab === "myclub" && !profile?.club_name)) && (
              <div className="club-create-wrap">
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>Создай свой клуб</div>
                <div style={{ fontSize: 13, color: "rgba(240,237,230,.4)", marginBottom: 20, lineHeight: 1.5 }}>
                  Клуб — твоя команда в Битве клубов. Выбери название, город и цвет.
                </div>
                <input className="club-inp" placeholder="Название клуба (например: Sasha United)" maxLength={40}
                  value={clubForm.name} onChange={(e) => setClubForm((p) => ({ ...p, name: e.target.value }))} />
                <input className="club-inp" placeholder="Город клуба *" maxLength={30}
                  value={clubForm.city} onChange={(e) => setClubForm((p) => ({ ...p, city: e.target.value }))} />
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 8 }}>Цвет клуба:</div>
                <div className="color-row">
                  {["#B91C1C","#1d4ed8","#15803d","#b45309","#7e22ce","#0e7490","#be185d","#1f2937"].map((c) => (
                    <div key={c} className={`color-swatch${clubForm.color === c ? " on" : ""}`}
                      style={{ background: c }} onClick={() => setClubForm((p) => ({ ...p, color: c }))} />
                  ))}
                </div>
                {clubForm.name.trim() && (
                  <div style={{ background: clubForm.color, borderRadius: 8, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#fff" }}>
                      {clubForm.name.trim().split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#fff" }}>{clubForm.name}</div>
                      {clubForm.city && <div style={{ fontSize: 11, color: "rgba(255,255,255,.7)" }}>{clubForm.city}</div>}
                    </div>
                  </div>
                )}
                <button className="bp" style={{ width: "100%", padding: "12px", opacity: clubForm.name.trim() ? 1 : 0.4 }}
                  disabled={!clubForm.name.trim() || clubSaving} onClick={saveClub}>
                  {clubSaving ? "Создаю..." : "Создать клуб →"}
                </button>
              </div>
            )}

            {/* ── МОЙ КЛУБ ── */}
            {clubsSubTab === "myclub" && profile?.club_name && (
              <div>
                <div style={{ background: profile.club_color || "#B91C1C", borderRadius: 12, padding: "24px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ width: 60, height: 60, borderRadius: "50%", background: "rgba(0,0,0,.3)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
                    {profile.club_name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 24, fontWeight: 700, color: "#fff" }}>{profile.club_name}</div>
                    {profile.club_city && <div style={{ fontSize: 13, color: "rgba(255,255,255,.7)" }}>📍 {profile.club_city}</div>}
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)", marginTop: 4 }}>🪙 {profile.fcoins_balance || 0} F-Coins</div>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { label: "⚔ Пары тура", desc: "Матчи Битвы клубов по турам", btn: "Смотреть", action: () => setClubsSubTab("cup") },
                    { label: "📊 Таблица клубов", desc: "Турнирная таблица Битвы клубов", btn: "Открыть", action: () => setClubsSubTab("league") },
                  ].map((item) => (
                    <div key={item.label} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "16px 14px" }}>
                      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>{item.label}</div>
                      <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", marginBottom: 12 }}>{item.desc}</div>
                      <button className="sb" onClick={item.action} style={{ width: "100%", fontSize: 12 }}>{item.btn}</button>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14 }}>
                  <button onClick={() => { setClubForm({ name: profile.club_name, city: profile.club_city || "", color: profile.club_color || "#B91C1C" }); setClubsSubTab("createclub"); }}
                    style={{ background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.4)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, padding: "6px 12px", borderRadius: 4, cursor: "pointer" }}>
                    ✏️ Редактировать клуб
                  </button>
                </div>
              </div>
            )}

            {/* ── СОСТАВ НА ТУР ── */}
            {clubsSubTab === "lineup" && (
              <ErrorBoundary isAdmin={isAdmin}>
              <FfcLineupView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
                setTab={setTab}
                activeRoundError={activeRoundError}
                allRounds={allRounds}
              />
              </ErrorBoundary>
            )}

            {/* ── КУБОК FFC ── */}
            {clubsSubTab === "cup" && (
              <ErrorBoundary isAdmin={isAdmin}>
              <FfcCupView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
                onJoin={() => loadEntryCounters()}
              />
              </ErrorBoundary>
            )}

            {/* ── ЛИГА FFC ── */}
            {clubsSubTab === "league" && (
              <ErrorBoundary isAdmin={isAdmin}>
              <FfcLeagueView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
                accessLevel={accessLevel}
                hasLeagueAccess={hasLeagueAccess}
                onJoin={() => loadEntryCounters()}
              />
              </ErrorBoundary>
            )}

            {/* ── МАГАЗИН F-COINS ── */}
            {clubsSubTab === "shop" && (
              <FfcShopView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                onProfileUpdated={(newBalance) => {
                  setProfile(p => p ? { ...p, fcoins_balance: newBalance } : p);
                }}
                onClubUpdated={(update) => {
                  setProfile(p => p ? { ...p, ...update } : p);
                }}
              />
            )}

            {/* ── КАК ИГРАТЬ ── */}
            {clubsSubTab === "howto" && (
              <div style={{ maxWidth: 540 }}>
                {[
                  { title: "A. Битва прогнозистов — 500 ₽", icon: "🏆", items: [
                    "Участвуй за 500 ₽.",
                    "Делай прогнозы на групповой этап — все матчи.",
                    "Делай прогнозы на плей-офф и финал.",
                    "Отвечай на 30 бонусных вопросов.",
                    "Соревнуйся в общей таблице прогнозистов.",
                    "Собери команду и участвуй в командном зачёте.",
                    "Очки за матч: 1 — голы одной команды (исход другой) · 2 — угадал исход · 3 — исход + голы одной команды · 5 — исход + разница · 8 — точный счёт · +1 бонус за разгром (разница 3+) · +1 за голевой матч (5+ голов).",
                  ]},
                  { title: "B. Битва клубов — бесплатно", icon: "⚽", items: [
                    "Создай клуб — бесплатно.",
                    "Выбери fantasy-состав: 1 тренер, 1 вратарь, 2 защитника, 2 полузащитника, 2 нападающих.",
                    "Назначь капитана среди 7 игроков — он получает ×1.5 очков. Тренер не может быть капитаном.",
                    "Лимиты: максимум 2 игрока из одной сборной, максимум 1 звезда.",
                    "Первый состав — свободный. Со второго тура — 2 бесплатные замены.",
                    "Дополнительная замена — за F-Coins в магазине.",
                    "Смена капитана бесплатна и не считается заменой.",
                    "ВРАТАРЬ: +2 старт · +6 сухой матч · +3 победа команды · +8 пенальти отбит · −1 каждый пропущенный · −1 жёлтая · −4 красная.",
                    "ЗАЩИТНИК: +2 старт · +5 сухой матч · +8 гол · +5 ассист · +2 победа · −1 жёлтая · −4 красная.",
                    "ПОЛУЗАЩИТНИК: +2 старт · +6 гол · +5 ассист · +2 победа · −1 жёлтая · −4 красная.",
                    "НАПАДАЮЩИЙ: +2 старт · +5 гол (+3 дубль, +6 хет-трик) · +4 ассист · −3 незабитый пенальти · −1 жёлтая · −4 красная.",
                    "ТРЕНЕР: +5 победа · +2 ничья · +2 если команда забила 3+ · −2 за красную в команде.",
                  ]},
                  { title: "C. Командный зачёт", icon: "🤝", items: [
                    "Команда от 2 человек. Доступно участникам Битве прогнозистов.",
                    "Рейтинг по среднему баллу участников в Битве прогнозистов.",
                    "Создай команду и поделись кодом с друзьями.",
                    "Вступить можно до старта турнира (дедлайн 11 июня).",
                  ]},
                  { title: "D. F-Coins", icon: "🪙", items: [
                    "Внутриигровая валюта. Нельзя вывести в деньги.",
                    "Получай за участие в Битве прогнозистов (+500), победы в Битве клубов (+50), проход раундов (+100).",
                    "Трать на: запасного (500 🪙), доп. замену (300 🪙), скаута (300 🪙), скрытие состава (200 🪙).",
                  ]},
                  { title: "E. Важно", icon: "⚠️", items: [
                    "Приложение не гарантирует выход выбранного игрока на поле.",
                    "Участники сами следят за травмами, дисквалификациями, ротацией и новостями сборных.",
                    "is_active у игрока означает «доступен в пуле», а не «точно сыграет».",
                  ]},
                ].map((section) => (
                  <div key={section.title} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 10 }}>
                      {section.icon} {section.title}
                    </div>
                    {section.items.map((item, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 12, color: "rgba(240,237,230,.6)", lineHeight: 1.5 }}>
                        <span style={{ color: "#F59E0B", flexShrink: 0 }}>{i + 1}.</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: ТАБЛИЦА ЛИДЕРОВ ══════════ */}
        {tab === "leaders" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div className="main">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Таблица лидеров</span>
              <button className="sb" onClick={loadLeaderboard}>Обновить</button>
            </div>

            {todayMatches.length > 0 && (
              <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>⚽ Матчи дня (МСК)</div>
                {todayMatches.map((m) => {
                  const pred = scores?.[m.id];
                  const h = pred?.h !== undefined && pred.h !== "" ? parseInt(pred.h, 10) : NaN;
                  const a = pred?.a !== undefined && pred.a !== "" ? parseInt(pred.a, 10) : NaN;
                  const hasPred = !isNaN(h) && !isNaN(a);
                  const outcome = hasPred
                    ? (h > a ? `победа ${m.home}` : h < a ? `победа ${m.away}` : "ничья")
                    : null;
                  return (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13, flexWrap: "wrap" }}>
                      <span style={{ color: "#FDE68A", fontFamily: "Oswald,sans-serif", fontSize: 12, flexShrink: 0 }}>{m.timeMsk}</span>
                      <span style={{ color: "rgba(240,237,230,.4)", fontSize: 10 }}>Гр.{m.group}</span>
                      <span style={{ color: "#F0EDE6", flex: 1 }}>{m.home} — {m.away}</span>
                      {hasPred ? (
                        <span style={{ fontSize: 11, color: "#86EFAC", background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 4, padding: "2px 7px" }}>
                          Вы поставили: {h}:{a} · {outcome}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: "rgba(240,237,230,.3)" }}>Прогноз не сделан</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!isSubmitted && !isPending && (
              <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "20px", marginBottom: 14, textAlign: "center" }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>📋</div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 600, color: "rgba(240,237,230,.6)", marginBottom: 6 }}>Твой прогноз пока не отправлен</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 14, lineHeight: 1.5 }}>Заполни прогноз и нажми «Отправить прогноз», чтобы попасть в таблицу лидеров и участвовать в призовом фонде.</div>
                <button className="bp" style={{ padding: "9px 20px", fontSize: 13 }} onClick={() => setTab("predict")}>Перейти к отправке прогноза →</button>
              </div>
            )}

            <div className="panel">
              <div className="ph"><span className="pt">Общий зачёт</span><span className="tag ty">{leaderboard.length} участников</span></div>
              {leaderboard.length === 0 && (
                <div style={{ padding: "32px", textAlign: "center" }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🏆</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, color: "rgba(240,237,230,.35)", marginBottom: 6 }}>Турнир начнётся 11 июня 2026</div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.3)" }}>Официальная таблица считается только по подтвержденным результатам администратора.</div>
                </div>
              )}
              {leaderboard.map((p, i) => {
                const [bg, fg] = avc(p.name || "X");
                const isMe = !isGuest && p.id === session?.user?.id;
                return (
                  <div key={p.id} className="lr" style={{ background: isMe ? "rgba(245,158,11,.05)" : "", borderLeft: isMe ? "3px solid rgba(245,158,11,.4)" : "3px solid transparent" }}>
                    <span className="rk" style={{ color: i === 0 ? "#F59E0B" : i === 1 ? "#C0C0C0" : i === 2 ? "#CD7F32" : "rgba(240,237,230,.2)" }}>{i + 1}</span>
                    <div className="av" style={{ width: 32, height: 32, background: bg, color: fg }}>{ini(p.name || "?")}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}{isMe && <span style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginLeft: 5 }}>(ты)</span>}</div>
                      <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)" }}>Матчи: {p.match_points} · Бонусы: {p.bonus_points}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span className="pp" style={{ fontSize: 21 }}>{p.total_points}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: АДМИНКА ══════════ */}
        {tab === "admin" && isAdmin && (
          <div className="main">
            <ErrorBoundary isAdmin={true}>
            <AdminPanel
              session={session}
              showToast={showToast}
              discipline={discipline}
              setDiscipline={setDiscipline}
              onLeaderboardRecalc={(lb) => setLeaderboard(lb)}
              predictionsLocked={predictionsLocked}
              predictionsPublic={predictionsPublic}
              onToggleLocked={(v) => setPredictionsLocked(v)}
              onTogglePublic={(v) => setPredictionsPublic(v)}
              onRoundCreated={loadActiveRound}
              onRejectPayment={(uid) => {
                // Сбрасываем predStatus если отклонили оплату текущего юзера
                if (session?.user?.id === uid) {
                  setPredStatus("draft");
                  localStorage.removeItem(`ffc_pred_status_${uid}`);
                }
              }}
            />
            </ErrorBoundary>

            {/* DEBUG БЛОК: ПРОВЕРКА СЕТКИ */}
            <div className="debug-panel" style={{ marginTop: 20 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 10 }}>🔍 Проверка сетки (debug)</div>
              <div style={{ marginBottom: 8, fontSize: 11, color: "rgba(240,237,230,.5)" }}>
                Ключ третьих мест: <strong style={{ color: "#F0EDE6" }}>{getThirdPlaceKey(thirdRanking) || "—"}</strong><br />
                Mapping найден: <strong style={{ color: getThirdPlaceMapping(thirdRanking) ? "#86EFAC" : "#FCA5A5" }}>{getThirdPlaceMapping(thirdRanking) ? "✓ да" : "✗ нет"}</strong>
              </div>
              {ALL_GROUPS.map((g) => {
                const tbl = allTables[g] || [];
                return (
                  <div key={g} style={{ fontSize: 10, color: "rgba(240,237,230,.45)", marginBottom: 2 }}>
                    <strong style={{ color: "#FDE68A" }}>Гр.{g}:</strong> {tbl.map((r, i) => `${i + 1}. ${r.team}`).join(" · ")}
                  </div>
                );
              })}
              {(() => {
                const mapping = getThirdPlaceMapping(thirdRanking);
                if (!mapping) return <div style={{ fontSize: 10, color: "#FCA5A5", marginTop: 6 }}>Mapping не найден — сетка третьих мест предварительная.</div>;
                return (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 10, color: "rgba(240,237,230,.5)", marginBottom: 4 }}>Распределение 3-х мест:</div>
                    {Object.entries(mapping).map(([mid, slot]) => {
                      const groupId = slot[1];
                      const tbl = allTables[groupId];
                      const row = tbl && tbl[2];
                      return (
                        <div key={mid} style={{ fontSize: 10, color: "rgba(240,237,230,.45)" }}>
                          {mid}: {slot} → <strong style={{ color: "#F0EDE6" }}>{row ? row.team : "—"}</strong>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              {bracketErrors.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 10, color: "#FCA5A5", fontWeight: 600, marginBottom: 4 }}>Ошибки сетки:</div>
                  {bracketErrors.map((e, i) => <div key={i} style={{ fontSize: 10, color: "#FCA5A5" }}>⚠ {e}</div>)}
                </div>
              )}
              {bracketErrors.length === 0 && allGroupsComplete && (
                <div style={{ marginTop: 6, fontSize: 10, color: "#86EFAC" }}>✓ Ошибок сетки не обнаружено</div>
              )}
            </div>
          </div>
        )}

        {/* МОДАЛКИ */}
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} onAuth={handleAuth} />}
        {showPaywall && <PaywallModal onClose={() => setShowPaywall(false)} onSelectPlan={(plan) => { setShowPaywall(false); if (isGuest) { setPendingPlanAfterAuth(plan); setShowAuth(true); } else { setShowPayment(plan); } }} />}
        {showPayment && <PaymentModal plan={showPayment} onClose={() => setShowPayment(null)} onSubmit={async (plan, comment) => { await submitPayment(plan, comment); }} />}
        {showDraftModal && pendingSession && (
          <DraftModal
            onTransfer={async () => { setShowDraftModal(false); await finishAuth(pendingSession, true); }}
            onKeep={async () => { setShowDraftModal(false); await finishAuth(pendingSession, false); }}
          />
        )}
        {toast && <div className="toast">{toast}</div>}
      </div>
      )} {/* end !isGuest */}
    </>
  );
}
