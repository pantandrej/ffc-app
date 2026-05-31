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

// Для VK OAuth (через Edge Function):
// Edge Function: https://gcuxixbldjrztnqsdqcs.supabase.co/functions/v1/vk-auth
// VK App → Авторизация → Redirect URI:
//   https://gcuxixbldjrztnqsdqcs.supabase.co/functions/v1/vk-auth
// Секреты VK_APP_ID и VK_SECRET уже добавлены в Supabase Secrets.
const VK_APP_ID = "54614369";
const VK_FUNCTION_URL = "https://gcuxixbldjrztnqsdqcs.supabase.co/functions/v1/vk-auth";

const supa = (path, opts = {}) => {
  const { token, headers: extraHeaders, prefer, ...fetchOpts } = opts;
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...fetchOpts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token || SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || (extraHeaders?.Prefer) || "return=representation",
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
const TOURNAMENT_DEADLINE = new Date("2026-06-11T21:00:00+03:00");
const isBefore = (dt) => new Date() < new Date(dt);
const isOpen = () => isBefore(TOURNAMENT_DEADLINE);

// ── ТАРИФЫ ──
// Активные тарифы для новых покупок
const PLANS = [
  { id: "prognostista", label: "Полный ЧМ",  price: 500, desc: "Все прогнозы ЧМ-2026 от группового этапа до финала. Матчи дня, таблица, очки.", access: ACCESS.PROGNOSTISTA },
  { id: "ffc_add",      label: "Лига FFC",   price: 300, desc: "Платная регулярная лига Клубных битв. Каждый тур — матч против соперника.",    access: ACCESS.FULL },
];
// Legacy тарифы — только для обработки старых заявок в админке
const LEGACY_PLANS = [
  { id: "friend", label: "С другом (legacy)", price: 800 },
  { id: "full",   label: "Полный ЧМ+Лига (legacy)", price: 800 },
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
    "ДР Конго": 88, "Кюрасао": 98,
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
function calcPts(ph, pa, rh, ra) {
  if (ph === "" || pa === "" || ph == null || pa == null || rh == null || ra == null) return null;
  ph = +ph; pa = +pa; rh = +rh; ra = +ra;
  if (ph === rh && pa === ra) return 8;
  if (ph - pa === rh - ra) return 5;
  if (Math.sign(ph - pa) === Math.sign(rh - ra)) return 3;
  if (ph === rh || pa === ra) return 1;
  return 0;
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
const BONUS_QS = [
  { id: "q1", pts: 8, text: "Лучший бомбардир (1-е место)", opts: ["Килиан Мбаппе", "Эрлинг Хаавланд", "Виниций Жр.", "Лаутаро Мартинес", "Джуд Беллингем", "Гарри Кейн", "Педри", "Другой"] },
  { id: "q2", pts: 5, text: "Лучший бомбардир (2-е место)", opts: ["Килиан Мбаппе", "Эрлинг Хаавланд", "Виниций Жр.", "Лаутаро Мартинес", "Джуд Беллингем", "Гарри Кейн", "Педри", "Другой"] },
  { id: "q3", pts: 3, text: "Лучший бомбардир (3-е место)", opts: ["Килиан Мбаппе", "Эрлинг Хаавланд", "Виниций Жр.", "Лаутаро Мартинес", "Джуд Беллингем", "Гарри Кейн", "Педри", "Другой"] },
  { id: "q4", pts: 8, text: "Лучший игрок турнира (Золотой мяч)", opts: ["Килиан Мбаппе", "Эрлинг Хаавланд", "Виниций Жр.", "Педри", "Джуд Беллингем", "Лаутаро Мартинес", "Лионель Месси", "Другой"] },
  { id: "q5", pts: 5, text: "Лучший ассистент турнира", opts: ["Килиан Мбаппе", "Педри", "Джуд Беллингем", "Кевин Де Брюйне", "Лука Модрич", "Бернарду Силва", "Другой"] },
  { id: "q6", pts: 3, text: "Команда с наименьшим числом пропущенных голов", opts: ["Бразилия", "Испания", "Франция", "Аргентина", "Германия", "Англия", "Португалия", "Другая"] },
  { id: "q7", pts: 3, text: "Команда с наибольшим числом пропущенных голов", opts: ["Кюрасао", "Гаити", "Кабо-Верде", "ДР Конго", "Иордания", "Другая"] },
  { id: "q8", pts: 3, text: "Команда с наибольшим числом забитых голов", opts: ["Бразилия", "Испания", "Франция", "Аргентина", "Германия", "Англия", "Другая"] },
  { id: "q9", pts: 3, text: "Команда, выигравшая все 3 матча в группе", opts: ["Бразилия", "Испания", "Франция", "Аргентина", "Германия", "Нидерланды", "Другая", "Таких не будет"] },
  { id: "q10", pts: 3, text: "Команда, не набравшая ни одного очка", opts: ["Кюрасао", "Гаити", "Кабо-Верде", "ДР Конго", "Иордания", "Другая"] },
  { id: "q11", pts: 5, text: "Игрок, оформивший хет-трик", opts: ["Килиан Мбаппе", "Эрлинг Хаавланд", "Лаутаро Мартинес", "Виниций Жр.", "Гарри Кейн", "Другой", "Хет-трика не будет"] },
  { id: "q12", pts: 5, text: "Число голов лучшего бомбардира", opts: ["5", "6", "7", "8", "9", "10+"] },
  { id: "q13", pts: 5, text: "Максимум голов в одном матче", opts: ["5", "6", "7", "8", "9+"] },
  { id: "q14", pts: 3, text: "Счёт финального матча (≥ : ≤)", opts: ["1:0", "1:1", "2:0", "2:1", "2:2", "3:0", "3:1", "3:2", "Другой"] },
  { id: "q15", pts: 3, text: "Из каких 4 групп выйдут третьи места?", opts: ALL_GROUPS, type: "multi4" },
  { id: "q16", pts: 15, text: "Чемпион мира 2026", opts: ["Франция", "Бразилия", "Испания", "Аргентина", "Германия", "Португалия", "Англия", "Нидерланды", "Другой"] },
  { id: "q17", pts: 12, text: "Финалист (2-е место)", opts: ["Франция", "Бразилия", "Испания", "Аргентина", "Германия", "Португалия", "Англия", "Нидерланды", "Другой"] },
  { id: "q18", pts: 8, text: "Команда, занявшая 3-е место", opts: ["Германия", "Нидерланды", "Португалия", "Бразилия", "Франция", "Испания", "Аргентина", "Другая"] },
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

  async function signInWithVK() {
    setSocialBusy("vk");
    // VK не всегда принимает supabase.co как redirect_uri.
    // Используем ffc-app.vercel.app/vk-callback как redirect —
    // он добавлен в VK как доверенный домен, и оттуда перенаправим в Edge Function.
    const VK_REDIRECT = "https://ffc-app.vercel.app/vk-callback";
    const vkOAuthUrl =
      "https://oauth.vk.com/authorize" +
      "?client_id=" + VK_APP_ID +
      "&display=page" +
      "&redirect_uri=" + encodeURIComponent(VK_REDIRECT) +
      "&scope=email" +
      "&response_type=code" +
      "&v=5.131";
    window.location.href = vkOAuthUrl;
  }

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
  // Показываем только Полный ЧМ и Лигу FFC (без 800₽ пакета)
  const visiblePlans = PLANS.filter(p => p.id === "prognostista" || p.id === "ffc_add");
  return (
    <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && onClose()}>
      <div className="paywall-modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#F59E0B", marginBottom: 4 }}>Участие в турнире</div>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)" }}>Заполнить прогноз можно бесплатно. Оплата нужна только для отправки в турнир.</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer", flexShrink: 0 }}>×</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          {visiblePlans.map((p) => (
            <div key={p.id} className="plan-card" onClick={() => onSelectPlan(p)}>
              <div className="plan-name">{p.label}</div>
              <div className="price">{p.price} ₽</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginTop: 4 }}>{p.desc}</div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "rgba(240,237,230,.25)", textAlign: "center", marginBottom: 8 }}>
          Максимальный доступ: Полный ЧМ + Лига FFC = 800 ₽
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

function FfcLineupView({ session, profile, showToast, activeRound, isAdmin }) {
  const [players, setPlayers] = useState([]);
  const [lineup, setLineup] = useState(null);           // состав текущего тура (рабочая копия)
  const [savedLineup, setSavedLineup] = useState(null); // сохранённый в БД состав текущего тура
  const [prevLineup, setPrevLineup] = useState(null);   // состав предыдущего тура
  const [allPlayersMap, setAllPlayersMap] = useState({}); // все игроки включая неактивных
  const [posFilter, setPosFilter] = useState("all");
  const [teamFilter, setTeamFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [starsOnly, setStarsOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasBench, setHasBench] = useState(false);
  const [extraTransfers, setExtraTransfers] = useState(0); // купленные extra_transfer на тур
  const [autoCarryMsg, setAutoCarryMsg] = useState(false); // показать баннер о переносе
  const [statsMap, setStatsMap] = useState({});
  const token = session?.access_token;
  const uid = session?.user?.id;

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
    // Загружаем ВСЕ активные игроки для выбора
    const r = await supa("ffc_players?is_active=eq.true&select=*&order=national_team.asc,name.asc", { token });
    const activePlayers = r.ok ? await r.json() : [];
    setPlayers(activePlayers);

    // Загружаем также всех для allPlayersMap (включая неактивных — чтобы показывать имена)
    const ra = await supa("ffc_players?select=*", { token });
    if (ra.ok) {
      const all = await ra.json();
      setAllPlayersMap(Object.fromEntries(all.map(p => [p.id, p])));
    }
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
      // Есть сохранённый состав — загружаем как рабочую копию
      setLineup({ ...currentSaved });
      setAutoCarryMsg(false);
    } else {
      // Нет состава в текущем туре — ищем предыдущий
      const pr = await supa(
        `ffc_lineups?user_id=eq.${uid}&select=*&order=created_at.desc&limit=1`,
        { token }
      );
      const prevArr = pr.ok ? await pr.json() : [];
      // Берём только если это другой тур
      const prev = prevArr[0] && prevArr[0].round_id !== activeRound.id ? prevArr[0] : null;
      setPrevLineup(prev);
      if (prev) {
        // Авто-перенос предыдущего состава
        setLineup({ ...prev, id: undefined, round_id: activeRound.id });
        setAutoCarryMsg(true);
      } else {
        setLineup({ round_id: activeRound.id });
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

  const isPastDeadline = activeRound && new Date() > new Date(activeRound.deadline);
  const canEdit = activeRound && activeRound.status === "lineup_open" && !isPastDeadline;

  // Разрешённое количество замен
  const allowedTransfers = prevLineup ? 1 + extraTransfers : Infinity;
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
    if (savedLineup?.id) {
      const res = await supa(`ffc_lineups?id=eq.${savedLineup.id}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify(payload),
      });
      ok = res.ok;
      if (!ok) { const err = await res.text(); console.error("saveLineup PATCH error:", err); }
      if (ok) setSavedLineup(prev => ({ ...prev, ...payload })); // сохраняем id
    } else {
      const res = await supa("ffc_lineups", {
        method: "POST", token,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });
      ok = res.ok;
      if (ok) {
        const created = await res.json();
        setSavedLineup(created[0] || payload); // created[0] содержит id
      } else {
        const err = await res.text();
        console.error("saveLineup POST error:", err);
      }
    }

    setSaving(false);
    if (ok) {
      setAutoCarryMsg(false);
      showToast("✓ Состав сохранён");
    } else {
      showToast("⚠ Не удалось сохранить состав. Проверь SQL-миграции tier/captain_player_id.");
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
      <div style={{ padding: "32px 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📋</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, color: "#F0EDE6", marginBottom: 8 }}>Нет открытого тура</div>
          {isAdmin ? (
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)", lineHeight: 1.8, background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 8, padding: "14px 16px", textAlign: "left" }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 8 }}>🔧 Чтобы протестировать составы:</div>
              <div>1. Открой <strong>Игроки</strong> → Добавь демо-игроков</div>
              <div>2. Открой <strong>Туры</strong> → Создай тур со статусом <code style={{ background: "rgba(255,255,255,.08)", padding: "1px 4px", borderRadius: 3 }}>lineup_open</code></div>
              <div>3. Укажи дедлайн в будущем</div>
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
      <div style={{ textAlign: "center", padding: "40px 20px" }}>
        <div style={{ fontSize: 32, marginBottom: 10 }}>👤</div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, color: "#F0EDE6", marginBottom: 8 }}>Игроки ещё не добавлены</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", lineHeight: 1.6 }}>
          Администратору нужно открыть <strong style={{ color: "#FDE68A" }}>Админ → FFC → Игроки</strong> и добавить игроков.
        </div>
      </div>
    );
  }

  const scoreResult = savedLineup && Object.keys(statsMap).length > 0
    ? calculateLineupScore(savedLineup, statsMap, allPlayersMap)
    : null;

  return (
    <div>
      {/* Заголовок тура */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6" }}>📋 Состав на тур</span>
        <span style={{ fontSize: 12, color: "#FDE68A", background: "rgba(245,158,11,.1)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 4, padding: "2px 8px" }}>{activeRound.name}</span>
        <span style={{ fontSize: 11, color: activeRound.status === "lineup_open" ? "#86EFAC" : "#FCA5A5" }}>
          {activeRound.status === "lineup_open" ? "🟢 Открыт" : activeRound.status === "locked" ? "🔒 Закрыт" : activeRound.status === "scoring" ? "⚡ Подсчёт" : "✅ Завершён"}
        </span>
      </div>

      {/* Баннер авто-переноса */}
      {autoCarryMsg && canEdit && (
        <div style={{ background: "rgba(29,78,216,.08)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
          🔄 Мы перенесли состав прошлого тура. Перед дедлайном можно сделать <strong>1 бесплатную замену</strong>.
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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {ROLES.map((role) => {
          const selectedId = lineup?.[role.key];
          const player = selectedId ? (allPlayersMap[selectedId] || null) : null;
          const isCaptain = selectedId && selectedId === lineup?.captain_player_id;
          const isInactive = player && !player.is_active;
          return (
            <div key={role.key} style={{ background: player ? "rgba(29,78,216,.1)" : "rgba(255,255,255,.04)", border: `1px solid ${isCaptain ? "rgba(245,158,11,.5)" : player ? "rgba(29,78,216,.3)" : "rgba(255,255,255,.08)"}`, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>{role.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 2 }}>{role.label}</div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#F0EDE6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {player ? (
                    <span>{player.tier === "star" ? "⭐ " : ""}{player.name}{isCaptain ? " 🏅" : ""}</span>
                  ) : <span style={{ color: "rgba(240,237,230,.3)" }}>Не выбран</span>}
                </div>
                {player && (
                  <div style={{ fontSize: 10, color: isInactive ? "#FCA5A5" : "rgba(240,237,230,.4)" }}>
                    {player.national_team}{isInactive ? " · ⚠ Неактивен" : ""}
                  </div>
                )}
              </div>
              {scoreResult?.scores[selectedId] && (
                <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: isCaptain ? "#FDE68A" : "#93C5FD" }}>
                  {scoreResult.scores[selectedId].pts}
                </span>
              )}
              {canEdit && player && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {!isCaptain && (
                    <button onClick={() => setLineup(l => ({ ...l, captain_player_id: selectedId }))} title="Капитан"
                      style={{ background: "rgba(245,158,11,.15)", border: "1px solid rgba(245,158,11,.3)", color: "#FDE68A", cursor: "pointer", fontSize: 9, padding: "2px 4px", borderRadius: 3 }}>🏅</button>
                  )}
                  <button onClick={() => setLineup(l => ({ ...l, [role.key]: null, captain_player_id: l.captain_player_id === selectedId ? null : l.captain_player_id }))}
                    style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.3)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
                </div>
              )}
            </div>
          );
        })}

        {/* Запасной */}
        {hasBench && (
          <div style={{ background: lineup?.bench_player_id ? "rgba(245,158,11,.1)" : "rgba(255,255,255,.04)", border: `1px solid ${lineup?.bench_player_id ? "rgba(245,158,11,.3)" : "rgba(255,255,255,.08)"}`, borderRadius: 8, padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>🪑</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginBottom: 2 }}>Запасной <span style={{ color: "rgba(240,237,230,.25)" }}>(5 лучших из 6)</span></div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#F0EDE6", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {lineup?.bench_player_id ? (allPlayersMap[lineup.bench_player_id]?.name || "?") : <span style={{ color: "rgba(240,237,230,.3)" }}>Не выбран</span>}
              </div>
              {lineup?.bench_player_id && !allPlayersMap[lineup.bench_player_id]?.is_active && (
                <div style={{ fontSize: 10, color: "#FCA5A5" }}>⚠ Неактивен в пуле</div>
              )}
            </div>
            {canEdit && lineup?.bench_player_id && (
              <button onClick={() => setLineup(l => ({ ...l, bench_player_id: null }))}
                style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.3)", cursor: "pointer", fontSize: 14, padding: 0 }}>×</button>
            )}
          </div>
        )}
      </div>

      {/* Статус капитана */}
      {canEdit && (
        <div style={{ fontSize: 11, marginBottom: 10, padding: "6px 10px", background: "rgba(245,158,11,.05)", borderRadius: 5, border: "1px solid rgba(245,158,11,.1)" }}>
          {lineup?.captain_player_id && allPlayersMap[lineup.captain_player_id]
            ? <span style={{ color: "#FDE68A" }}>🏅 Капитан: <strong>{allPlayersMap[lineup.captain_player_id].name}</strong> — ×1.5 очков</span>
            : <span style={{ color: "#FCA5A5" }}>⚠ Капитан не выбран — нажми 🏅 рядом с игроком</span>}
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
          <div style={{ display: "flex", gap: 5, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            {[["all","Все"],["coach","Тренеры"],["goalkeeper","Вратари"],["defender","Защитники"],["midfielder","Полузащ."],["forward","Нападающие"]].map(([v,l]) => (
              <button key={v} onClick={() => setPosFilter(v)}
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

          <div style={{ maxHeight: 360, overflowY: "auto", display: "grid", gap: 3 }}>
            {filteredPlayers.length === 0 && (
              <div style={{ fontSize:12, color:"rgba(240,237,230,.3)", padding:16, textAlign:"center" }}>Нет игроков по фильтру</div>
            )}
            {filteredPlayers.map((p) => {
              const roleForPos = ROLES.find(r => r.pos === p.position);
              const isSelected = roleForPos && lineup?.[roleForPos.key] === p.id;
              const isBenchSel = lineup?.bench_player_id === p.id;
              const isCaptain = lineup?.captain_player_id === p.id;
              return (
                <div key={p.id} style={{ display:"flex", alignItems:"center", gap:8, background: isSelected||isBenchSel ? "rgba(29,78,216,.1)" : "rgba(255,255,255,.03)", border:`1px solid ${isSelected||isBenchSel ? "rgba(29,78,216,.25)" : "rgba(255,255,255,.05)"}`, borderRadius:6, padding:"7px 10px" }}>
                  <span style={{ fontSize:13 }}>{roleForPos?.emoji||"👤"}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:"#F0EDE6" }}>
                      {p.tier==="star" ? "⭐ " : ""}{p.name}{isCaptain ? " 🏅" : ""}
                    </div>
                    <div style={{ fontSize:9, color:"rgba(240,237,230,.4)" }}>{p.national_team} · {p.position}{p.tier==="star" ? " · Звезда" : ""}</div>
                  </div>
                  {isSelected ? (
                    <div style={{ display:"flex", gap:4, alignItems:"center" }}>
                      <span style={{ fontSize:10, color:"#86EFAC" }}>✓</span>
                      {!isCaptain && (
                        <button onClick={() => setLineup(l => ({ ...l, captain_player_id: p.id }))}
                          style={{ background:"rgba(245,158,11,.15)", border:"1px solid rgba(245,158,11,.3)", color:"#FDE68A", fontSize:10, padding:"2px 5px", borderRadius:3, cursor:"pointer" }}>🏅</button>
                      )}
                      {isCaptain && <span style={{ fontSize:10, color:"#FDE68A" }}>Кап.</span>}
                    </div>
                  ) : (
                    <div style={{ display:"flex", gap:3 }}>
                      {roleForPos && (
                        <button className="sb" style={{ fontSize:10, padding:"3px 8px" }}
                          onClick={() => setLineup(l => ({ ...l, [roleForPos.key]: p.id }))}>
                          Выбрать
                        </button>
                      )}
                      {hasBench && !isBenchSel && (
                        <button onClick={() => setLineup(l => ({ ...l, bench_player_id: p.id }))}
                          style={{ background:"rgba(245,158,11,.1)", border:"1px solid rgba(245,158,11,.2)", color:"#FDE68A", fontFamily:"Barlow Condensed,sans-serif", fontSize:10, fontWeight:600, padding:"3px 6px", borderRadius:4, cursor:"pointer" }}>🪑</button>
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

function FfcCupView({ session, profile, showToast, activeRound, isAdmin }) {
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
    showToast("✓ Ты вступил в Кубок FFC!");
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
    showToast(`✓ Пары Кубка сгенерированы: ${pairs.length} матчей`);
  }

  const myFixture = fixtures.find(f => f.user_a_id === uid || f.user_b_id === uid);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>🏆 Кубок FFC</span>
        <span style={{ fontSize: 12, color: "rgba(240,237,230,.4)" }}>{entries.filter(e => e.status === "active").length} участников</span>
      </div>

      <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 8 }}>Вознаграждение</div>
        <div style={{ fontSize: 13, color: "#FDE68A" }}>🪙 +50 F-Coins за победу в матче</div>
        <div style={{ fontSize: 13, color: "#FDE68A" }}>🪙 +100 F-Coins за проход раунда</div>
      </div>

      {!myEntry && session && (
        <button className="bp" style={{ width: "100%", marginBottom: 16 }} onClick={joinCup} disabled={loading}>
          {loading ? "..." : "🏆 Вступить в Кубок FFC (бесплатно)"}
        </button>
      )}
      {myEntry && (
        <div style={{ background: myEntry.status === "active" ? "rgba(22,163,74,.08)" : "rgba(185,28,28,.08)", border: `1px solid ${myEntry.status === "active" ? "rgba(22,163,74,.2)" : "rgba(185,28,28,.2)"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13 }}>
          {myEntry.status === "active" ? "✅ Ты участвуешь в Кубке FFC" : myEntry.status === "eliminated" ? "❌ Ты выбыл" : "🏆 Победитель"}
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

function FfcLeagueView({ session, profile, showToast, activeRound, isAdmin, accessLevel, hasLeagueAccess }) {
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
    if (!hasLeagueAccess) { showToast("Лига FFC доступна за 300 ₽. Открой в разделе Клубных битв."); return; }
    setLoading(true);
    await supa("ffc_league_entries", {
      method: "POST", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ user_id: uid, league_name: "FFC Лига 2026", points: 0, wins: 0, draws: 0, losses: 0, goals_for: 0, goals_against: 0 }),
    });
    await loadEntries();
    setLoading(false);
    showToast("✓ Ты вступил в Лигу FFC!");
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>🥇 Лига FFC</span>
        <span style={{ fontSize: 12, color: "rgba(240,237,230,.4)" }}>{entries.length} участников</span>
      </div>

      {!hasLeagueAccess && (
        <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 10, padding: "20px", marginBottom: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>🥇 Лига FFC</div>
          <div style={{ fontSize: 13, color: "rgba(240,237,230,.6)", lineHeight: 1.7, marginBottom: 16 }}>
            Платный регулярный турнир Клубных битв. Каждый тур — матч против соперника, очки в таблице, F-Coins за победы.
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#F59E0B", fontFamily: "Oswald,sans-serif", marginBottom: 12 }}>300 ₽</div>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 12 }}>
            Можно купить отдельно — без Полного ЧМ.
          </div>
          {session ? (
            <button className="bp" style={{ width: "100%", padding: "10px", fontSize: 13 }}
              onClick={() => showToast("Перейди в раздел оплаты для тарифа «Лига FFC»")}>
              Открыть Лигу FFC — 300 ₽
            </button>
          ) : (
            <button className="bp" style={{ width: "100%", padding: "10px", fontSize: 13 }}
              onClick={() => showToast("Войди в аккаунт чтобы купить доступ")}>
              Войти и купить — 300 ₽
            </button>
          )}
        </div>
      )}

      {hasLeagueAccess && !myEntry && (
        <button className="bp" style={{ width: "100%", marginBottom: 16 }} onClick={joinLeague} disabled={loading}>
          {loading ? "..." : "🥇 Вступить в Лигу FFC"}
        </button>
      )}
      {myEntry && (
        <div style={{ background: "rgba(22,163,74,.08)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: "#86EFAC" }}>✅ Ты в Лиге FFC</div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginTop: 4 }}>Очки: {myEntry.points} · И/В/Н/П: {myEntry.wins + myEntry.draws + myEntry.losses}/{myEntry.wins}/{myEntry.draws}/{myEntry.losses}</div>
        </div>
      )}

      {/* Таблица лиги */}
      <div className="panel">
        <div className="ph"><span className="pt">Таблица Лиги FFC</span></div>
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
    { id: "bench_player",    icon: "🪑", name: "Скамейка запасных",     price: 500, desc: "Добавь 6-го игрока на тур (в зачёт 5 лучших)", needsRound: true },
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
  const [newRound, setNewRound] = useState({ name: "", deadline: "", status: "upcoming" });
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
    const res = await supa("ffc_rounds", {
      method: "POST", token,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(newRound),
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
            <input className="inp" placeholder="Название тура (например: Тур 1 — Группы)" value={newRound.name} onChange={e => setNewRound(p => ({ ...p, name: e.target.value }))} style={{ marginBottom: 8 }} />
            <input className="inp" type="datetime-local" value={newRound.deadline} onChange={e => setNewRound(p => ({ ...p, deadline: e.target.value }))} style={{ marginBottom: 8 }} />
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
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 8 }}>Кубок FFC ({cupEntries.length})</div>
          {cupEntries.map((e) => (
            <div key={e.id} className="mr">
              <div style={{ flex: 1, fontSize: 12 }}>{e.profiles?.name || e.user_id?.slice(0, 8)}</div>
              <span style={{ fontSize: 11, color: e.status === "active" ? "#86EFAC" : "#FCA5A5" }}>{e.status}</span>
            </div>
          ))}
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", margin: "16px 0 8px" }}>Лига FFC ({leagueEntries.length})</div>
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
function AdminPanel({ session, showToast, discipline, setDiscipline, onLeaderboardRecalc, onToggleLocked, onTogglePublic, predictionsLocked, predictionsPublic, onRejectPayment }) {
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
      // Лига FFC — независимый доступ, не требует Полного ЧМ
      fcoinsAmount = 300;
      // level не меняем через access_level — ставим ffc_league_access отдельно ниже
    }

    await supa(`payment_requests?id=eq.${pid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "confirmed", ...(friendSlotNote ? { comment: friendSlotNote } : {}) }),
    });

    // Обновляем профиль: Лига FFC — отдельное поле, Полный ЧМ — access_level
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
  async function recalcLeaderboard() {
    const confirmedResults = Object.entries(officialResults)
      .filter(([, r]) => r.status === "confirmed")
      .reduce((acc, [mid, r]) => { acc[mid] = r; return acc; }, {});

    if (Object.keys(confirmedResults).length === 0) {
      showToast("Нет подтверждённых результатов для пересчёта");
      return;
    }

    // Загружаем все predictions
    const pr = await supa("predictions?select=*", { token });
    if (!pr.ok) { showToast("Ошибка загрузки прогнозов"); return; }
    const allPredictions = await pr.json();

    // Загружаем профили для имён
    const usersResp = await supa("profiles?select=id,name,prediction_status&order=created_at.asc", { token });
    const userProfiles = usersResp.ok ? await usersResp.json() : [];
    const profileMap = Object.fromEntries(userProfiles.map((u) => [u.id, u]));

    // Группируем predictions по user_id
    const byUser = {};
    allPredictions.forEach((p) => {
      if (!byUser[p.user_id]) byUser[p.user_id] = {};
      byUser[p.user_id][p.match_id] = { h: p.home_score, a: p.away_score };
    });

    // Считаем очки только для submitted пользователей
    const newLeaderboard = Object.entries(byUser)
      .filter(([uid]) => profileMap[uid]?.prediction_status === "submitted")
      .map(([uid, preds]) => {
        let total = 0;
        Object.entries(confirmedResults).forEach(([mid, official]) => {
          const pred = preds[mid];
          if (!pred) return;
          const p = calcPts(pred.h, pred.a, official.home_score, official.away_score);
          if (p !== null) total += p;
        });
        return {
          id: uid,
          name: profileMap[uid]?.name || uid.slice(0, 8),
          total_points: total,
          match_points: total,
          bonus_points: 0,
        };
      })
      .sort((a, b) => b.total_points - a.total_points);

    // Обновляем leaderboard в App через callback
    if (onLeaderboardRecalc) onLeaderboardRecalc(newLeaderboard);

    // Upsert в Supabase leaderboard — теперь таблица лидеров обновится для всех после refresh
    // Таблица leaderboard: id (user_id), name, total_points, match_points, bonus_points
    const lbRows = newLeaderboard.map((row) => ({
      id: row.id,
      name: row.name,
      total_points: row.total_points,
      match_points: row.match_points,
      bonus_points: row.bonus_points,
    }));
    if (lbRows.length) {
      await supa("leaderboard", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(lbRows),
      });
    }
    showToast(`✓ Лидерборд пересчитан и сохранён: ${newLeaderboard.length} участников`);
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
  const planLabel = { prognostista: "Полный ЧМ 500₽", ffc_add: "Лига FFC 300₽", friend: "С другом 800₽ (legacy)", full: "Полный ЧМ+Лига 800₽ (legacy)" };
  const accessLabel = { [ACCESS.DEMO]: "Черновик", [ACCESS.PROGNOSTISTA]: "Прогнозиста", [ACCESS.FULL]: "Полный", [ACCESS.ADMIN]: "Админ" };
  const accessBadge = { [ACCESS.DEMO]: "badge-demo", [ACCESS.PROGNOSTISTA]: "badge-paid", [ACCESS.FULL]: "badge-full", [ACCESS.ADMIN]: "badge-admin" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Админка</span>
        <span className="tag tr">Только для организатора</span>
      </div>
      <div className="tabs">
        {[["payments", "Заявки"], ["users", "Участники"], ["results", "Результаты"], ["fairplay", "Fair Play"], ["ffc", "⚽ FFC"], ["settings", "Настройки"]].map(([k, l]) => (
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
        <AdminFfcPanel session={session} showToast={showToast} onRoundCreated={loadActiveRound} />
      )}

      {/* НАСТРОЙКИ */}
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
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState("predict");

  // Прогнозы пользователя
  const [scores, setScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_scores") || "{}"); } catch { return {}; } });
  const [pScores, setPScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_scores") || "{}"); } catch { return {}; } });
  const [pPens, setPPens] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_pens") || "{}"); } catch { return {}; } });
  const [bonus, setBonus] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_bonus") || "{}"); } catch { return {}; } });

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

  // ── Клубные битвы + F-Coins ──
  const [clubsSubTab, setClubsSubTab] = useState("home"); // "home"|"myclub"|"cup"|"league"|"shop"
  const [clubForm, setClubForm] = useState({ name: "", city: "", color: "#B91C1C" });
  const [clubSaving, setClubSaving] = useState(false);
  const [fcoinsHistory, setFcoinsHistory] = useState([]);
  // ── FFC ──
  const [activeRound, setActiveRound] = useState(null);
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
  // Лига FFC — независимый доступ через ffc_league_access или legacy ACCESS.FULL
  const hasLeagueAccess = profile?.ffc_league_access === true || accessLevel === ACCESS.FULL || isAdmin;

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
    // -1. Обработка /vk-callback — VK вернул code сюда, пересылаем в Edge Function
    if (window.location.pathname === "/vk-callback") {
      const qp = new URLSearchParams(window.location.search);
      const code = qp.get("code");
      const vkError = qp.get("error");
      if (vkError) {
        window.history.replaceState(null, "", "/");
        setToast("VK отказал в доступе: " + (qp.get("error_description") || vkError));
        return;
      }
      if (code) {
        // Чистим URL и перенаправляем в Edge Function с правильным redirect_uri
        window.history.replaceState(null, "", "/");
        const VK_REDIRECT = encodeURIComponent("https://ffc-app.vercel.app/vk-callback");
        const edgeUrl = `${VK_FUNCTION_URL}?code=${code}&redirect_uri=${VK_REDIRECT}`;
        window.location.href = edgeUrl;
        return;
      }
    }
    const hash = window.location.hash;
    if (hash && hash.includes("vk_access_token=")) {
      const params = new URLSearchParams(hash.replace("#", ""));
      const vkToken = params.get("vk_access_token");
      const vkRefresh = params.get("vk_refresh_token");
      if (vkToken) {
        // Очищаем hash из URL чтобы не светить токен
        window.history.replaceState(null, "", window.location.pathname);
        // Получаем пользователя по токену
        supabaseClient.auth.getUser(vkToken).then(({ data }) => {
          if (data?.user) {
            afterSuccessfulAuth({ access_token: vkToken, user: data.user });
          }
        });
        return; // не делаем остальные проверки
      }
    }

    // Проверить query — VK может вернуть ошибку в ?vk_error=
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

  async function loadActiveRound() {
    // A. Ищем lineup_open
    const r1 = await supa("ffc_rounds?status=eq.lineup_open&order=created_at.desc&limit=1");
    console.log("loadActiveRound [lineup_open] status:", r1.status);
    if (r1.ok) {
      const d1 = await r1.json();
      console.log("loadActiveRound [lineup_open] result:", d1);
      if (d1[0]) { setActiveRound(d1[0]); return; }
    } else {
      console.error("loadActiveRound [lineup_open] error:", r1.status);
    }

    // B. Ищем любой активный тур
    const r2 = await supa("ffc_rounds?status=in.(lineup_open,locked,scoring)&order=created_at.desc&limit=1");
    console.log("loadActiveRound [active_statuses] status:", r2.status);
    if (r2.ok) {
      const d2 = await r2.json();
      console.log("loadActiveRound [active_statuses] result:", d2);
      if (d2[0]) { setActiveRound(d2[0]); return; }
    } else {
      console.error("loadActiveRound [active_statuses] error:", r2.status);
    }

    // C. Берём последние 10 и выбираем на клиенте
    const r3 = await supa("ffc_rounds?order=created_at.desc&limit=10");
    console.log("loadActiveRound [latest_fallback] status:", r3.status);
    if (r3.ok) {
      const d3 = await r3.json();
      console.log("loadActiveRound [latest_fallback] all rounds:", d3);
      const picked = d3.find(r => r.status === "lineup_open" || r.status === "locked" || r.status === "scoring") || null;
      console.log("loadActiveRound picked:", picked);
      setActiveRound(picked);
    } else {
      console.error("loadActiveRound [latest_fallback] error:", r3.status);
      setActiveRound(null);
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
      <div className="app">
        {/* HEADER */}
        <header className="hdr">
          <div className="hdr-in">
            <div className="logo">
              <div style={{ width: 38, height: 38, borderRadius: "50%", background: "linear-gradient(135deg, #B91C1C 0%, #15803d 100%)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "2px solid rgba(245,158,11,.5)", boxShadow: "0 2px 8px rgba(0,0,0,.4)" }}>
                <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 700, color: "#F59E0B", letterSpacing: 0.5 }}>FFC</span>
              </div>
              <div><div className="la">Football Fight Club</div><div className="lb">ЧМ 2026 · Прогнозы</div></div>
            </div>
            <nav className="nav">
              <button className={`nb${tab === "predict" ? " on" : ""}`} onClick={() => setTab("predict")}>
                {isSubmitted ? "✅ Полный ЧМ" : "Полный ЧМ"}
              </button>
              <button className={`nb${tab === "clubs" ? " on" : ""}`} onClick={() => { setTab("clubs"); setClubsSubTab("home"); }}>⚽ Клубные битвы</button>
              <button className={`nb${tab === "leaders" ? " on" : ""}`} onClick={() => setTab("leaders")}>Таблица</button>
              {isAdmin && <button className={`nb${tab === "admin" ? " on" : ""}`} style={{ color: "#FCA5A5" }} onClick={() => setTab("admin")}>⚙ Админ</button>}
            </nav>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {!isGuest && profile && (
                <>
                  {/* F-Coins баланс */}
                  {profile.fcoins_balance != null && (
                    <div className="fcoins-badge" title="F-Coins — внутриигровая валюта FFC">
                      🪙 {profile.fcoins_balance}
                    </div>
                  )}
                  <div className="av" style={{ width: 28, height: 28, ...(() => { const [bg, fg] = avc(profile.name || "X"); return { background: bg, color: fg }; })() }}>{ini(profile.name || "?")}</div>
                  <span style={{ fontSize: 12, color: "rgba(240,237,230,.6)", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile.club_name || profile.name}</span>
                  <span className={`access-badge ${isAdmin ? "badge-admin" : isPaid ? "badge-paid" : "badge-demo"}`}>
                    {isAdmin ? "Админ" : isPaid ? "Участник" : "Черновик"}
                  </span>
                  <button onClick={async () => {
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
                  }} style={{ background: "transparent", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.35)", fontSize: 11, padding: "3px 7px", borderRadius: 4, cursor: "pointer", fontFamily: "Barlow Condensed,sans-serif" }}>Выйти</button>
                </>
              )}
              {isGuest && <button className="bp" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setShowAuth(true)}>Войти</button>}
            </div>
          </div>
        </header>

        {/* ══════════ ЛЕНДИНГ ДЛЯ ГОСТЕЙ ══════════ */}
        {isGuest && tab === "predict" && (
          <div style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px 120px" }}>
            {/* Hero */}
            <div style={{ textAlign: "center", padding: "48px 16px 36px" }}>
              <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 72, height: 72, borderRadius: "50%", background: "linear-gradient(135deg, #B91C1C 0%, #15803d 100%)", border: "3px solid rgba(245,158,11,.6)", marginBottom: 20 }}>
                <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>FFC</span>
              </div>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 28, fontWeight: 700, color: "#F0EDE6", lineHeight: 1.2, marginBottom: 12 }}>
                Футбольные прогнозы<br />и клубные битвы на ЧМ 2026
              </div>
              <div style={{ fontSize: 14, color: "rgba(240,237,230,.5)", lineHeight: 1.7, marginBottom: 28, maxWidth: 480, margin: "0 auto 28px" }}>
                Собери клуб, делай прогнозы, играй в Кубке FFC и Лиге FFC, зарабатывай F-Coins и соревнуйся с друзьями.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="bp" style={{ padding: "12px 24px", fontSize: 14 }}
                  onClick={() => { setShowAuth(true); }}>
                  Купить Полный ЧМ — 500 ₽
                </button>
                <button className="sb" style={{ padding: "12px 24px", fontSize: 14 }}
                  onClick={() => { setShowAuth(true); }}>
                  Создать клуб бесплатно
                </button>
                <button onClick={() => setShowAuth(true)} style={{ padding: "12px 24px", fontSize: 14, background: "transparent", border: "1px solid rgba(255,255,255,.15)", color: "rgba(240,237,230,.6)", fontFamily: "Barlow Condensed,sans-serif", fontWeight: 600, borderRadius: 6, cursor: "pointer" }}>
                  Войти
                </button>
              </div>
            </div>

            {/* Как это работает */}
            <div style={{ marginBottom: 32 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 2, textAlign: "center", marginBottom: 20 }}>Как это работает</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { n: "1", t: "Купи Полный ЧМ или создай клуб", icon: "🚀" },
                  { n: "2", t: "Делай прогнозы на матчи ЧМ-2026", icon: "📋" },
                  { n: "3", t: "Собери fantasy-состав и назначь капитана", icon: "⚽" },
                  { n: "4", t: "Играй, набирай очки и зарабатывай F-Coins", icon: "🪙" },
                ].map((s) => (
                  <div key={s.n} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "16px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 24, color: "#F59E0B", fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>{s.n}</span>
                    <div>
                      <span style={{ fontSize: 18 }}>{s.icon}</span>
                      <div style={{ fontSize: 13, color: "rgba(240,237,230,.7)", lineHeight: 1.5, marginTop: 4 }}>{s.t}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Карточки тарифов */}
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 2, textAlign: "center", marginBottom: 16 }}>Режимы и тарифы</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 32 }}>
              {[
                { icon: "📋", name: "Полный ЧМ", price: "500 ₽", desc: "Прогнозы на все матчи ЧМ от группы до финала, матчи дня, таблица.", color: "#B91C1C" },
                { icon: "🏆", name: "Кубок FFC", price: "Бесплатно", desc: "Создай клуб и играй в турнире на вылет. Проиграл — вышел.", color: "#15803d" },
                { icon: "🥇", name: "Лига FFC", price: "300 ₽", desc: "Регулярный турнир. Каждый тур — матч против соперника.", color: "#1d4ed8" },
              ].map((c) => (
                <div key={c.name} style={{ background: "rgba(255,255,255,.03)", border: `1px solid rgba(255,255,255,.08)`, borderTop: `3px solid ${c.color}`, borderRadius: 10, padding: "16px 14px" }}>
                  <div style={{ fontSize: 22, marginBottom: 6 }}>{c.icon}</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>{c.name}</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F59E0B", marginBottom: 8 }}>{c.price}</div>
                  <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", lineHeight: 1.6 }}>{c.desc}</div>
                </div>
              ))}
            </div>

            {/* Что можно делать */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "18px 20px", marginBottom: 20 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 12 }}>🎮 Что можно делать в приложении</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  "📅 Смотреть матчи дня",
                  "📝 Видеть свои прогнозы на сегодня",
                  "⚽ Заполнять fantasy-состав",
                  "🔄 Делать 1 бесплатную замену за тур",
                  "🪙 Покупать доп. замену за F-Coins",
                  "📊 Следить за таблицей и сеткой",
                ].map((f) => (
                  <div key={f} style={{ fontSize: 12, color: "rgba(240,237,230,.6)", padding: "6px 0" }}>{f}</div>
                ))}
              </div>
            </div>

            {/* FAQ */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "18px 20px", marginBottom: 24 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 14 }}>❓ Частые вопросы</div>
              {[
                { q: "Как начисляются очки?", a: "За правильный прогноз на победителя или счёт матча. Капитан fantasy-состава получает ×1.5 очков." },
                { q: "Что такое F-Coins?", a: "Внутриигровая валюта. Нельзя вывести в деньги. Тратится на запасного (500), доп. замену (300) и скаута (300)." },
                { q: "Как работают замены?", a: "Первый состав собирается свободно. С каждого следующего тура — 1 бесплатная замена. Дополнительная замена стоит 300 F-Coins." },
                { q: "Нужно ли следить за составами сборных?", a: "Да. Мы не гарантируем выход выбранного игрока на поле. Участники сами отслеживают травмы, дисквалификации и ротацию." },
              ].map((faq) => (
                <div key={faq.q} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid rgba(255,255,255,.05)" }}>
                  <div style={{ fontFamily: "Barlow Condensed,sans-serif", fontSize: 13, fontWeight: 600, color: "#FDE68A", marginBottom: 4 }}>{faq.q}</div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.6 }}>{faq.a}</div>
                </div>
              ))}
            </div>

            <div style={{ textAlign: "center" }}>
              <button className="bp" style={{ padding: "14px 36px", fontSize: 15 }} onClick={() => setShowAuth(true)}>
                Начать → Войти или зарегистрироваться
              </button>
            </div>
          </div>
        )}

        {/* ══════════ ВКЛАДКА: ОТПРАВИТЬ ПРОГНОЗ ══════════ */}
        {!isGuest && tab === "predict" && (
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
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FCA5A5" }}>🔒 Приём прогнозов закрыт</div>
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
                const multi = q.type === "multi4";
                const ans = bonus[q.id];
                const done = multi ? (Array.isArray(ans) && ans.length === 4) : !!ans;
                const locked = isSubmitted || isPending;
                return (
                  <div key={q.id} className={`qcard${done ? " done" : ""}`} style={{ pointerEvents: locked ? "none" : "auto", opacity: locked && !done ? 0.6 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ display: "flex", gap: 7, alignItems: "flex-start", flex: 1 }}>
                        <span style={{ fontSize: 10, color: "rgba(240,237,230,.25)", minWidth: 18, marginTop: 2 }}>#{i + 1}</span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: "#F0EDE6" }}>{q.text}</div>
                          {multi && <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginTop: 2 }}>Выбери 4 группы · {(Array.isArray(ans) ? ans : []).join(", ") || "–"}</div>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F59E0B" }}>{q.pts}</span>
                        <span style={{ fontSize: 9, color: "rgba(240,237,230,.3)" }}>оч.</span>
                        {done && <span style={{ color: "#16A34A", fontSize: 13 }}>✓</span>}
                      </div>
                    </div>
                    {!locked && (
                      <div className="opts">
                        {q.opts.map((o) => (
                          <button key={o} className={`opt${multi ? " multi" : ""} ${multi ? (Array.isArray(ans) && ans.includes(o) ? " on" : "") : (ans === o ? " on" : "")}`}
                            onClick={() => {
                              if (multi) setBonus((p) => { const cur = Array.isArray(p[q.id]) ? p[q.id] : []; const has = cur.includes(o); if (has) return { ...p, [q.id]: cur.filter((x) => x !== o) }; if (cur.length >= 4) return p; return { ...p, [q.id]: [...cur, o] }; });
                              else setBonus((p) => ({ ...p, [q.id]: o }));
                            }}>{o}</button>
                        ))}
                      </div>
                    )}
                    {locked && ans && <div style={{ marginTop: 6, fontSize: 12, color: "#86EFAC", fontWeight: 500 }}>✓ {Array.isArray(ans) ? ans.join(", ") : ans}</div>}
                  </div>
                );
              })}
            </div>

            {/* Блок "Мои результаты" — будет реализован в следующей версии */}

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

          </div>
        )}

        {/* ══════════ ВКЛАДКА: КЛУБНЫЕ БИТВЫ ══════════ */}
        {tab === "clubs" && (
          <div className="main">

            {/* Суб-навигация */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,.07)", paddingBottom: 12 }}>
              {[
                ["home", "🏠 Главная"],
                ["myclub", "🏟 Мой клуб"],
                ["lineup", "📋 Состав"],
                ["cup", "🏆 Кубок FFC"],
                ["league", "🥇 Лига FFC"],
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
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
                  {/* Полный ЧМ */}
                  <div className="mode-card champ" style={{ padding: "16px 14px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>📋 Полный ЧМ</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#F59E0B", fontFamily: "Oswald,sans-serif", marginBottom: 8 }}>500 ₽</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 12, lineHeight: 1.6 }}>
                      Прогнозы на все матчи ЧМ-2026, матчи дня, таблица прогнозистов.
                    </div>
                    {isPaid ? (
                      <div>
                        <div style={{ fontSize: 11, color: "#86EFAC", marginBottom: 8 }}>✓ Полный ЧМ активен</div>
                        <button className="sb" style={{ width: "100%", fontSize: 11 }} onClick={() => setTab("predict")}>Перейти к прогнозам →</button>
                      </div>
                    ) : (
                      <button className="bp" style={{ width: "100%", padding: "8px", fontSize: 12 }}
                        onClick={() => { if (isGuest) { setShowAuth(true); return; } setShowPayment(PLANS[0]); }}>
                        Купить — 500 ₽
                      </button>
                    )}
                  </div>

                  {/* Кубок FFC */}
                  <div className="mode-card clubs" style={{ padding: "16px 14px", borderLeft: "4px solid #16A34A" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>🏆 Кубок FFC</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#86EFAC", background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.25)", borderRadius: 4, padding: "3px 8px", display: "inline-block", marginBottom: 8 }}>БЕСПЛАТНО</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 12, lineHeight: 1.6 }}>
                      Создай клуб и играй в турнире на вылет. Проиграл — вышел.
                    </div>
                    <button className="bp" style={{ width: "100%", padding: "8px", fontSize: 12, background: "#15803d" }}
                      onClick={() => {
                        if (isGuest) { setShowAuth(true); return; }
                        if (!profile?.club_name) { setClubsSubTab("createclub"); }
                        else { setClubsSubTab("cup"); }
                      }}>
                      {profile?.club_name ? "Играть бесплатно" : "Создать клуб"}
                    </button>
                  </div>

                  {/* Лига FFC */}
                  <div className="mode-card clubs" style={{ padding: "16px 14px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>🥇 Лига FFC</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: "#F59E0B", fontFamily: "Oswald,sans-serif", marginBottom: 8 }}>300 ₽</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.5)", marginBottom: 12, lineHeight: 1.6 }}>
                      Регулярный турнир. Каждый тур — матч против соперника, очки в таблице.
                    </div>
                    {(hasLeagueAccess) ? (
                      <div>
                        <div style={{ fontSize: 11, color: "#86EFAC", marginBottom: 8 }}>✓ Лига FFC активна</div>
                        <button className="sb" style={{ width: "100%", fontSize: 11 }} onClick={() => setClubsSubTab("league")}>Открыть Лигу →</button>
                      </div>
                    ) : (
                      <button className="bp" style={{ width: "100%", padding: "8px", fontSize: 12, background: "#1d4ed8" }}
                        onClick={() => { if (isGuest) { setShowAuth(true); return; } setShowPayment(PLANS[1]); }}>
                        Открыть — 300 ₽
                      </button>
                    )}
                  </div>
                </div>

                {/* Максимальный доступ подсказка */}
                <div style={{ fontSize: 11, color: "rgba(240,237,230,.25)", textAlign: "center", marginBottom: 20 }}>
                  Максимальный доступ: Полный ЧМ + Лига FFC = 800 ₽
                </div>

                {/* Блок «Что делать дальше?» — если есть клуб */}
                {!isGuest && profile?.club_name && (
                  <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#93C5FD", marginBottom: 10 }}>📌 Что делать дальше?</div>
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", lineHeight: 2 }}>
                      <div>1. Дождись открытия тура</div>
                      <div>2. Выбери fantasy-состав: тренер, вратарь, защитник, полузащитник, нападающий</div>
                      <div>3. Назначь капитана (×1.5 очков)</div>
                      <div>4. Вступи в Кубок FFC (бесплатно) или в Лигу FFC</div>
                      <div>5. Следи за реальными матчами ЧМ</div>
                      <div>6. Получай очки и F-Coins за победы</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("lineup")}>📋 Перейти к составу</button>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("cup")}>🏆 Вступить в Кубок</button>
                      <button className="sb" style={{ fontSize: 11 }} onClick={() => setClubsSubTab("league")}>🥇 Открыть Лигу</button>
                      {isAdmin && <button className="sb" style={{ fontSize: 11, color: "#FCA5A5" }} onClick={() => setTab("admin")}>⚙ Открыть AdminFFC</button>}
                    </div>
                  </div>
                )}

                {/* Блок для гостей */}
                {isGuest && (
                  <div style={{ textAlign: "center", padding: "20px", background: "rgba(255,255,255,.02)", border: "1px solid rgba(255,255,255,.06)", borderRadius: 10, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, color: "rgba(240,237,230,.4)", marginBottom: 10 }}>Войди чтобы создать клуб и участвовать в Клубных битвах</div>
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
                      <div>6. Генерировать пары Кубка/Лиги</div>
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
                      Как заработать: купи Полный ЧМ (+500) · пригласи друга (+300–600) · побеждай в Кубке FFC (+50 за победу, +100 за раунд)
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
                  Клуб — твоя команда в Клубных битвах. Выбери название, город и цвет.
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
                    { label: "🏆 Кубок FFC", desc: "Бесплатный турнир на вылет", btn: "Участвовать", action: () => setClubsSubTab("cup") },
                    { label: "🥇 Лига FFC", desc: "Платный регулярный турнир за 300 ₽", btn: "Открыть", action: () => setClubsSubTab("league") },
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
              <FfcLineupView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
              />
            )}

            {/* ── КУБОК FFC ── */}
            {clubsSubTab === "cup" && (
              <FfcCupView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
              />
            )}

            {/* ── ЛИГА FFC ── */}
            {clubsSubTab === "league" && (
              <FfcLeagueView
                session={session}
                profile={profile}
                showToast={showToast}
                activeRound={activeRound}
                isAdmin={isAdmin}
                accessLevel={accessLevel}
                hasLeagueAccess={hasLeagueAccess}
              />
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
                  { title: "A. Полный ЧМ — 500 ₽", icon: "📋", items: [
                    "Купи доступ за 500 ₽.",
                    "Делай прогнозы на матчи ЧМ-2026.",
                    "Смотри матчи дня и свои прогнозы на сегодня.",
                    "Получай очки за правильные прогнозы.",
                    "Поднимайся в общей таблице прогнозистов.",
                  ]},
                  { title: "B. Клубные битвы", icon: "⚽", items: [
                    "Создай клуб — бесплатно.",
                    "Выбери fantasy-состав: тренер, вратарь, защитник, полузащитник, нападающий.",
                    "Назначь капитана — он получает ×1.5 очков.",
                    "Лимиты: максимум 2 игрока из одной сборной, максимум 1 звезда.",
                    "Первый состав — свободный. Со второго тура — 1 бесплатная замена.",
                    "Дополнительная замена — 300 F-Coins в магазине.",
                    "Смена капитана бесплатна и не считается заменой.",
                  ]},
                  { title: "C. Кубок FFC — бесплатно", icon: "🏆", items: [
                    "Бесплатный турнир на вылет.",
                    "Каждый тур — матч против другого участника.",
                    "Проиграл матч — вылетел.",
                    "Победитель проходит дальше.",
                    "За победы и проход раундов начисляются F-Coins.",
                  ]},
                  { title: "D. Лига FFC — 300 ₽", icon: "🥇", items: [
                    "Платный регулярный турнир.",
                    "Каждый тур — матч против соперника.",
                    "Победа = 3 очка, ничья = 1 очко, поражение = 0.",
                    "Таблица Лиги обновляется автоматически.",
                  ]},
                  { title: "E. F-Coins", icon: "🪙", items: [
                    "Внутриигровая валюта. Нельзя вывести в деньги.",
                    "Получай за оплату Полного ЧМ (+500), победы в Кубке (+50), проход раундов (+100).",
                    "Трать на: запасного (500 🪙), доп. замену (300 🪙), скаута (300 🪙), скрытие состава (200 🪙).",
                  ]},
                  { title: "F. Важно", icon: "⚠️", items: [
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
        )}

        {/* ══════════ ВКЛАДКА: ТАБЛИЦА ЛИДЕРОВ ══════════ */}
        {tab === "leaders" && (
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
        )}

        {/* ══════════ ВКЛАДКА: АДМИНКА ══════════ */}
        {tab === "admin" && isAdmin && (
          <div className="main">
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
              onRejectPayment={(uid) => {
                // Сбрасываем predStatus если отклонили оплату текущего юзера
                if (session?.user?.id === uid) {
                  setPredStatus("draft");
                  localStorage.removeItem(`ffc_pred_status_${uid}`);
                }
              }}
            />

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
    </>
  );
}
