// FFC App v6 — Football Fight Club / Прогнозиста ЧМ-2026
// Меню: ТОЛЬКО "Отправить прогноз" | "Таблица лидеров" | "Админ" (для admin)
// Вкладки groups/playoff/questions/table/thirds/ffc/plans УДАЛЕНЫ.
// Плей-офф, бонусы, третьи места — секции внутри "Отправить прогноз".
import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://gcuxixbldjrztnqsdqcs.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdjdXhpeGJsZGpyenRucXNkcWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4MDU1ODMsImV4cCI6MjA5NTM4MTU4M30.f6LGTZyW1qDyZ0urE0atzABmyAjQ9p8gAkinyu7j5h8";

// ── Флаг блокировки прогнозов после дедлайна ──
// true  → форма скрыта, показывается публичная таблица
// false → форма доступна как раньше
const PREDICTIONS_LOCKED = true;
// Гостевой режим по ссылке: ?guest=ffc2026 — открывает форму прогнозов даже после дедлайна
const GUEST_FORM_OPEN = false;

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

function isJwtExpired(token, skewSeconds = 30) {
  try {
    if (!token || typeof token !== "string" || token.split(".").length !== 3) return true;
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!payload?.exp) return false;
    return payload.exp <= Math.floor(Date.now() / 1000) + skewSeconds;
  } catch {
    return true;
  }
}

async function makeRestRequest(path, opts = {}, authToken = SUPABASE_KEY) {
  const { headers: extraHeaders, prefer, token, ...fetchOpts } = opts;
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
}

const supa = async (path, opts = {}) => {
  const { token } = opts;
  const looksLikeJwt = typeof token === "string" && token.split(".").length === 3;

  // Важно: если нам передали пользовательский JWT, но он истёк, НЕ подменяем его anon key.
  // Иначе RLS вернёт пустые данные без явной ошибки, и админка/драфт снова покажут нули.
  let authToken = SUPABASE_KEY;
  if (looksLikeJwt) {
    if (!isJwtExpired(token)) {
      authToken = token;
    } else {
      const fresh = await getFreshToken().catch(() => null);
      if (fresh && !isJwtExpired(fresh)) authToken = fresh;
    }
  }

  let resp = await makeRestRequest(path, opts, authToken);

  // Страховка: если любой DB-запрос получил JWT expired, обновляем токен и пробуем один раз заново.
  // Это особенно важно для админки, которая часто открыта долго.
  if (resp.status === 401) {
    const body = await resp.clone().text().catch(() => "");
    if (/JWT expired|invalid jwt|PGRST303/i.test(body)) {
      const fresh = await getFreshToken().catch(() => null);
      if (fresh && !isJwtExpired(fresh)) {
        resp = await makeRestRequest(path, opts, fresh);
      }
    }
  }

  return resp;
};

// Получить свежий Supabase access_token.
// Принимает опциональный onSessionRestored(sessObj) для обновления React state.
// НЕ возвращает anon key — только настоящий пользовательский JWT.
async function getFreshToken(onSessionRestored) {
  // 1. supabaseClient.auth.getSession() — самый надёжный способ
  //    supabase-js умеет автоматически обновлять токен через refresh_token
  try {
    const { data } = await supabaseClient.auth.getSession();
    if (data?.session?.access_token && !isJwtExpired(data.session.access_token)) {
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
        if (restored?.session?.access_token && !isJwtExpired(restored.session.access_token)) {
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
      if (t && typeof t === "string" && t.split(".").length === 3 && !isJwtExpired(t)) return t;
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

// ── СТРАХОВКА ДЛЯ АДМИНА ──
// Иногда profile.access_level/is_admin слетает в DEMO после правок профиля/RLS.
// Эти идентификаторы дают доступ к админке на клиенте, не трогая данные турнира.
const ADMIN_IDENTIFIERS = [
  "mozgokvest",
  "mozgokvest.intop",
  "panteleewintop",
];
function normalizeAdminId(v) {
  return String(v || "").trim().toLowerCase();
}
function isProjectAdmin(profile, session) {
  if (!profile && !session?.user) return false;
  if (profile?.is_admin === true) return true;
  if (profile?.access_level === ACCESS.ADMIN) return true;
  const candidates = [
    profile?.email,
    profile?.name,
    profile?.display_name,
    session?.user?.email,
    session?.user?.user_metadata?.email,
    session?.user?.user_metadata?.name,
    session?.user?.user_metadata?.full_name,
  ].map(normalizeAdminId).filter(Boolean);
  return candidates.some((v) => {
    const beforeAt = v.split("@")[0];
    return ADMIN_IDENTIFIERS.some((id) => v === id || beforeAt === id || v.includes(id));
  });
}

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
  phone: "8 911 823-15-76",
  bank: "Сбер / Т-Банк",
  name: "Андрей П.",
  comment: "FFC ЧМ-2026 + ваше имя",
  support: "https://vk.com/panteleewintop",
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
// Порядок команд и матчей приведён к официальному календарю ЧМ-2026.
// id групповых матчей теперь соответствует номеру матча FIFA: m1...m72.
const GROUPS = {
  A: ["Мексика", "ЮАР", "Корея", "Чехия"],
  B: ["Канада", "Босния", "Катар", "Швейцария"],
  C: ["Бразилия", "Марокко", "Гаити", "Шотландия"],
  D: ["США", "Парагвай", "Австралия", "Турция"],
  E: ["Германия", "Кюрасао", "Кот-д'Ивуар", "Эквадор"],
  F: ["Нидерланды", "Япония", "Швеция", "Тунис"],
  G: ["Бельгия", "Египет", "Иран", "Нов.Зеландия"],
  H: ["Испания", "Кабо-Верде", "Сауд.Аравия", "Уругвай"],
  I: ["Франция", "Сенегал", "Ирак", "Норвегия"],
  J: ["Аргентина", "Алжир", "Австрия", "Иордания"],
  K: ["Португалия", "ДР Конго", "Узбекистан", "Колумбия"],
  L: ["Англия", "Хорватия", "Гана", "Панама"],
};
const ALL_GROUPS = Object.keys(GROUPS);

// ── РАСПИСАНИЕ МАТЧЕЙ (kickoff_at в UTC) ──
const mkGroupMatch = (match_no, group, home, away, kickoff_at, date_label = "") => ({
  id: `m${match_no}`,
  match_no,
  group,
  home,
  away,
  kickoff_at,
  date_label,
});

const GROUP_MATCHES = {
  A: [
    mkGroupMatch(1, "A", "Мексика", "ЮАР", "2026-06-11T19:00:00Z", "11 июня"),
    mkGroupMatch(2, "A", "Корея", "Чехия", "2026-06-12T02:00:00Z", "11 июня"),
    mkGroupMatch(25, "A", "Чехия", "ЮАР", "2026-06-18T16:00:00Z", "18 июня"),
    mkGroupMatch(28, "A", "Мексика", "Корея", "2026-06-19T01:00:00Z", "18 июня"),
    mkGroupMatch(53, "A", "Чехия", "Мексика", "2026-06-25T01:00:00Z", "24 июня"),
    mkGroupMatch(54, "A", "ЮАР", "Корея", "2026-06-25T01:00:00Z", "24 июня"),
  ],
  B: [
    mkGroupMatch(3, "B", "Канада", "Босния", "2026-06-12T19:00:00Z", "12 июня"),
    mkGroupMatch(8, "B", "Катар", "Швейцария", "2026-06-13T19:00:00Z", "13 июня"),
    mkGroupMatch(26, "B", "Швейцария", "Босния", "2026-06-18T19:00:00Z", "18 июня"),
    mkGroupMatch(27, "B", "Канада", "Катар", "2026-06-18T22:00:00Z", "18 июня"),
    mkGroupMatch(51, "B", "Швейцария", "Канада", "2026-06-24T19:00:00Z", "24 июня"),
    mkGroupMatch(52, "B", "Босния", "Катар", "2026-06-24T19:00:00Z", "24 июня"),
  ],
  C: [
    mkGroupMatch(7, "C", "Бразилия", "Марокко", "2026-06-13T22:00:00Z", "13 июня"),
    mkGroupMatch(5, "C", "Гаити", "Шотландия", "2026-06-14T01:00:00Z", "13 июня"),
    mkGroupMatch(30, "C", "Шотландия", "Марокко", "2026-06-19T22:00:00Z", "19 июня"),
    mkGroupMatch(29, "C", "Бразилия", "Гаити", "2026-06-20T01:00:00Z", "19 июня"),
    mkGroupMatch(49, "C", "Шотландия", "Бразилия", "2026-06-24T22:00:00Z", "24 июня"),
    mkGroupMatch(50, "C", "Марокко", "Гаити", "2026-06-24T22:00:00Z", "24 июня"),
  ],
  D: [
    mkGroupMatch(4, "D", "США", "Парагвай", "2026-06-13T01:00:00Z", "12 июня"),
    mkGroupMatch(6, "D", "Австралия", "Турция", "2026-06-14T04:00:00Z", "13 июня"),
    mkGroupMatch(32, "D", "США", "Австралия", "2026-06-19T19:00:00Z", "19 июня"),
    mkGroupMatch(31, "D", "Турция", "Парагвай", "2026-06-20T04:00:00Z", "19 июня"),
    mkGroupMatch(59, "D", "Турция", "США", "2026-06-26T02:00:00Z", "25 июня"),
    mkGroupMatch(60, "D", "Парагвай", "Австралия", "2026-06-26T02:00:00Z", "25 июня"),
  ],
  E: [
    mkGroupMatch(10, "E", "Германия", "Кюрасао", "2026-06-14T17:00:00Z", "14 июня"),
    mkGroupMatch(9, "E", "Кот-д'Ивуар", "Эквадор", "2026-06-14T23:00:00Z", "14 июня"),
    mkGroupMatch(33, "E", "Германия", "Кот-д'Ивуар", "2026-06-20T20:00:00Z", "20 июня"),
    mkGroupMatch(34, "E", "Эквадор", "Кюрасао", "2026-06-21T00:00:00Z", "20 июня"),
    mkGroupMatch(55, "E", "Кюрасао", "Кот-д'Ивуар", "2026-06-25T20:00:00Z", "25 июня"),
    mkGroupMatch(56, "E", "Эквадор", "Германия", "2026-06-25T20:00:00Z", "25 июня"),
  ],
  F: [
    mkGroupMatch(11, "F", "Нидерланды", "Япония", "2026-06-14T20:00:00Z", "14 июня"),
    mkGroupMatch(12, "F", "Швеция", "Тунис", "2026-06-15T02:00:00Z", "14 июня"),
    mkGroupMatch(35, "F", "Нидерланды", "Швеция", "2026-06-20T17:00:00Z", "20 июня"),
    mkGroupMatch(36, "F", "Тунис", "Япония", "2026-06-21T04:00:00Z", "20 июня"),
    mkGroupMatch(57, "F", "Япония", "Швеция", "2026-06-25T23:00:00Z", "25 июня"),
    mkGroupMatch(58, "F", "Тунис", "Нидерланды", "2026-06-25T23:00:00Z", "25 июня"),
  ],
  G: [
    mkGroupMatch(16, "G", "Бельгия", "Египет", "2026-06-15T19:00:00Z", "15 июня"),
    mkGroupMatch(15, "G", "Иран", "Нов.Зеландия", "2026-06-16T01:00:00Z", "15 июня"),
    mkGroupMatch(39, "G", "Бельгия", "Иран", "2026-06-21T19:00:00Z", "21 июня"),
    mkGroupMatch(40, "G", "Нов.Зеландия", "Египет", "2026-06-22T01:00:00Z", "21 июня"),
    mkGroupMatch(63, "G", "Египет", "Иран", "2026-06-27T03:00:00Z", "26 июня"),
    mkGroupMatch(64, "G", "Нов.Зеландия", "Бельгия", "2026-06-27T03:00:00Z", "26 июня"),
  ],
  H: [
    mkGroupMatch(14, "H", "Испания", "Кабо-Верде", "2026-06-15T16:00:00Z", "15 июня"),
    mkGroupMatch(13, "H", "Сауд.Аравия", "Уругвай", "2026-06-15T22:00:00Z", "15 июня"),
    mkGroupMatch(38, "H", "Испания", "Сауд.Аравия", "2026-06-21T16:00:00Z", "21 июня"),
    mkGroupMatch(37, "H", "Уругвай", "Кабо-Верде", "2026-06-21T22:00:00Z", "21 июня"),
    mkGroupMatch(65, "H", "Кабо-Верде", "Сауд.Аравия", "2026-06-27T00:00:00Z", "26 июня"),
    mkGroupMatch(66, "H", "Уругвай", "Испания", "2026-06-27T01:00:00Z", "26 июня"),
  ],
  I: [
    mkGroupMatch(17, "I", "Франция", "Сенегал", "2026-06-16T19:00:00Z", "16 июня"),
    mkGroupMatch(18, "I", "Ирак", "Норвегия", "2026-06-16T22:00:00Z", "16 июня"),
    mkGroupMatch(42, "I", "Франция", "Ирак", "2026-06-22T21:00:00Z", "22 июня"),
    mkGroupMatch(41, "I", "Норвегия", "Сенегал", "2026-06-23T00:00:00Z", "22 июня"),
    mkGroupMatch(61, "I", "Норвегия", "Франция", "2026-06-26T19:00:00Z", "26 июня"),
    mkGroupMatch(62, "I", "Сенегал", "Ирак", "2026-06-26T19:00:00Z", "26 июня"),
  ],
  J: [
    mkGroupMatch(19, "J", "Аргентина", "Алжир", "2026-06-17T01:00:00Z", "16 июня"),
    mkGroupMatch(20, "J", "Австрия", "Иордания", "2026-06-17T04:00:00Z", "16 июня"),
    mkGroupMatch(43, "J", "Аргентина", "Австрия", "2026-06-22T17:00:00Z", "22 июня"),
    mkGroupMatch(44, "J", "Иордания", "Алжир", "2026-06-23T03:00:00Z", "22 июня"),
    mkGroupMatch(69, "J", "Алжир", "Австрия", "2026-06-28T02:00:00Z", "27 июня"),
    mkGroupMatch(70, "J", "Иордания", "Аргентина", "2026-06-28T02:00:00Z", "27 июня"),
  ],
  K: [
    mkGroupMatch(23, "K", "Португалия", "ДР Конго", "2026-06-17T17:00:00Z", "17 июня"),
    mkGroupMatch(24, "K", "Узбекистан", "Колумбия", "2026-06-18T02:00:00Z", "17 июня"),
    mkGroupMatch(47, "K", "Португалия", "Узбекистан", "2026-06-23T17:00:00Z", "23 июня"),
    mkGroupMatch(48, "K", "Колумбия", "ДР Конго", "2026-06-24T02:00:00Z", "23 июня"),
    mkGroupMatch(71, "K", "Колумбия", "Португалия", "2026-06-27T23:30:00Z", "27 июня"),
    mkGroupMatch(72, "K", "ДР Конго", "Узбекистан", "2026-06-27T23:30:00Z", "27 июня"),
  ],
  L: [
    mkGroupMatch(21, "L", "Англия", "Хорватия", "2026-06-17T20:00:00Z", "17 июня"),
    mkGroupMatch(22, "L", "Гана", "Панама", "2026-06-17T23:00:00Z", "17 июня"),
    mkGroupMatch(45, "L", "Англия", "Гана", "2026-06-23T20:00:00Z", "23 июня"),
    mkGroupMatch(46, "L", "Панама", "Хорватия", "2026-06-23T23:00:00Z", "23 июня"),
    mkGroupMatch(67, "L", "Панама", "Англия", "2026-06-27T21:00:00Z", "27 июня"),
    mkGroupMatch(68, "L", "Хорватия", "Гана", "2026-06-27T21:00:00Z", "27 июня"),
  ],
};

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
    // 7. Fair Play: меньше штрафных очков — выше.
    const fpA = calcFairPlay(a.team, discipline);
    const fpB = calcFairPlay(b.team, discipline);
    if (fpB !== fpA) return fpB - fpA;
    // 8. Рейтинг FIFA: более высокая команда выше.
    const rankA = getFifaRank(a.team);
    const rankB = getFifaRank(b.team);
    if (rankA !== rankB) return rankA - rankB;
    // 9. Последний fallback — алфавит, чтобы порядок был стабильным.
    return a.team.localeCompare(b.team, "ru");
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
      // При равенстве третьих мест: Fair Play, затем рейтинг FIFA, затем алфавит/группа.
      const fpA = calcFairPlay(a.team, discipline);
      const fpB = calcFairPlay(b.team, discipline);
      if (fpB !== fpA) return fpB - fpA;
      const rankA = getFifaRank(a.team);
      const rankB = getFifaRank(b.team);
      if (rankA !== rankB) return rankA - rankB;
      const byTeam = a.team.localeCompare(b.team, "ru");
      if (byTeam !== 0) return byTeam;
      return a.group.localeCompare(b.group, "ru");
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

// ── getDisplayName — единая логика отображения имени участника ──
// Приоритет: display_name → name → email до @
function getDisplayName(profile) {
  if (!profile) return "Игрок";
  if (profile.display_name && profile.display_name.trim()) return profile.display_name.trim();
  if (profile.name && profile.name.trim() && !profile.name.includes("@")) return profile.name.trim();
  if (profile.email) return profile.email.split("@")[0];
  return "Игрок";
}
const AVC = [
  ["rgba(185,28,28,.2)", "#FCA5A5"], ["rgba(22,163,74,.2)", "#86EFAC"],
  ["rgba(245,158,11,.18)", "#FDE68A"], ["rgba(96,165,250,.18)", "#BFDBFE"],
  ["rgba(167,139,250,.18)", "#DDD6FE"], ["rgba(251,146,60,.18)", "#FED7AA"],
];
function avc(n) { return AVC[(n || "X").charCodeAt(0) % AVC.length]; }

// ── БОНУСНЫЕ ВОПРОСЫ ──
// Рекомендованные имена для быстрых кнопок — ищутся в tournament_players
// Если имени нет в базе, кнопка не показывается
const POPULAR_TEAMS = ["Аргентина","Франция","Бразилия","Англия","Испания","Германия","Португалия"];
const POPULAR_WEAK  = ["Гаити","Кюрасао","Кабо-Верде","Иордания","Узбекистан","Новая Зеландия","ЮАР"];

const BONUS_QS = [
  { id:"top_scorers",     answerType:"player_multi", count:3, pts:8, pts_breakdown:"8/5/3",
    text:"Топ-3 бомбардира чемпионата",
    filterType:"all",
    recommendedNames:["Kylian Mbappe","Lionel Messi","Vinicius Jr","Cristiano Ronaldo","Эрлинг Холанд","Harry Kane","Lautaro Martinez","Mohamed Salah","Alexander Isak","Jude Bellingham","Patrik Schick"],
    help:"Выбери 3 игроков. Порядок не имеет значения. Очки: 8 за 1-е место, 5 за 2-е, 3 за 3-е." },
  { id:"mvp",             answerType:"player",  pts:8,
    text:"Лучший игрок турнира (MVP)",
    filterType:"all",
    recommendedNames:["Kylian Mbappe","Lionel Messi","Vinicius Jr","Jude Bellingham","Pedri","Lautaro Martinez","Kevin De Bruyne","Jamal Musiala","Cristiano Ronaldo","Harry Kane","Эрлинг Холанд"] },
  { id:"top_assistant",   answerType:"player",  pts:5,
    text:"Лучший ассистент (больше всех голевых пасов)",
    filterType:"all",
    recommendedNames:["Lionel Messi","Kevin De Bruyne","Bruno Fernandes","Jude Bellingham","Pedri","Vinicius Jr","Jamal Musiala","Kylian Mbappe","Granit Xhaka","Federico Valverde","Hakan Calhanoglu"] },
  { id:"best_young_player", answerType:"player", pts:5,
    text:"Лучший молодой игрок турнира",
    filterType:"young",
    recommendedNames:["Lamine Yamal","Kenan Yildiz","Arda Guler","Pau Cubarsi","Gavi","Warren Zaire-Emery","Estevao","Obed Vargas","Endrick","Alejandro Garnacho","Kobbie Mainoo"],
    help:"Выбери игрока, которому было 21 год или меньше на 1 января 2026 года." },
  { id:"goalkeeper_least_goals_conceded", answerType:"goalkeeper", pts:5,
    text:"Вратарь, который сыграет и пропустит меньше всех",
    filterType:"goalkeeper",
    recommendedNames:["Emiliano Martinez","Gregor Kobel","Mike Maignan","Diogo Costa","Unai Simon","Alisson","Ederson","Andre Onana","Jan Sommer","Ronwen Williams","Yann Sommer","Guillermo Ochoa"],
    help:"Выбери только из вратарей заявок ЧМ-2026." },
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
  { id:"player_scores_header",       answerType:"player",pts:3,
    text:"Игрок, который забьёт гол головой",
    filterType:"all",
    recommendedNames:["Эрлинг Холанд","Harry Kane","Virgil van Dijk","Marquinhos","Endrick","Lautaro Martinez","Josko Gvardiol","Alphonso Davies","Kim Min-jae","John Stones"] },
  { id:"player_scores_as_sub",       answerType:"player",pts:3,
    text:"Игрок, который забьёт, выйдя на замену",
    filterType:"all",
    recommendedNames:["Kylian Mbappe","Endrick","Alexander Isak","Yoane Wissa","Patrik Schick","Mehdi Taremi","Miguel Almiron","Salem Al-Dawsari","Richard Rios","Vinicius Jr"] },
  { id:"player_scores_free_kick",    answerType:"player",pts:3,
    text:"Игрок, который забьёт со штрафного",
    filterType:"all",
    recommendedNames:["Lionel Messi","Cristiano Ronaldo","Hakan Calhanoglu","Mohamed Salah","Kevin De Bruyne","Granit Xhaka","Federico Valverde","Jude Bellingham"] },
  { id:"goalkeeper_saves_penalty",   answerType:"player",pts:3,
    text:"Вратарь, который отразит пенальти",
    filterType:"goalkeeper",
    recommendedNames:["Emiliano Martinez","Gregor Kobel","Diogo Costa","Unai Simon","Alisson","Ronwen Williams","Guillermo Ochoa","Jordan Pickford"] },
  { id:"player_misses_penalty",      answerType:"player",pts:3,
    text:"Игрок, который не забьёт пенальти",
    filterType:"all",
    recommendedNames:["Kylian Mbappe","Cristiano Ronaldo","Lionel Messi","Mehdi Taremi","Hakan Calhanoglu","Harry Kane","Эрлинг Холанд","Mohamed Salah"] },
  { id:"player_scores_own_goal",     answerType:"player",pts:5,
    text:"Игрок, который забьёт в свои ворота",
    filterType:"all",
    recommendedNames:["Virgil van Dijk","John Stones","Marquinhos","Kim Min-jae","Sead Kolasinac","Josko Gvardiol","Alphonso Davies","Kalidou Koulibaly"] },
  { id:"player_gets_yellow_card",    answerType:"player",pts:3,
    text:"Игрок, который получит жёлтую карточку",
    filterType:"all",
    recommendedNames:["Granit Xhaka","Jude Bellingham","Moises Caicedo","Hakan Calhanoglu","Federico Valverde","Salem Al-Dawsari","Jackson Irvine","Sead Kolasinac"] },
  { id:"player_sent_off",            answerType:"player",pts:5,
    text:"Игрок, который будет удалён",
    filterType:"all",
    recommendedNames:["Granit Xhaka","Jude Bellingham","Moises Caicedo","Sead Kolasinac","Hakan Calhanoglu","Salem Al-Dawsari","Chris Richards","Kalidou Koulibaly"] },
  { id:"player_scores_hat_trick",    answerType:"player",pts:5,
    text:"Игрок, который сделает хет-трик",
    filterType:"all",
    recommendedNames:["Kylian Mbappe","Эрлинг Холанд","Cristiano Ronaldo","Lionel Messi","Endrick","Mohamed Salah","Harry Kane","Vinicius Jr","Lautaro Martinez"] },
  { id:"top_scorer_goal_count",      answerType:"number",pts:3, text:"Число голов, забитых лучшим бомбардиром" },
  { id:"max_goals_in_one_match",     answerType:"number",pts:3, text:"Максимальное количество голов в 1 матче", help:"Голы в серии пенальти не считаются." },
  { id:"final_match_score",          answerType:"score", pts:3, text:"Счёт финального матча", placeholder:"например, 2:1" },
];

// ── Хук: загрузка популярных кнопок из tournament_players ──
// Грузим один раз для всей формы бонусных вопросов
// ── Нормализация имени для сравнения ──
// Убираем спецсимволы, приводим к lowercase, удаляем пробелы
// Работает и для латиницы (Kylian Mbappe) и для кириллицы (Килиан Мбаппе)
function normalizeName(s) {
  return (s || "").toLowerCase()
    .replace(/[^a-zа-яёéàüäöçñ0-9]/gi, "") // убираем спецсимволы
    .trim();
}

// Матчит имя из priorityNames с игроком в базе
// Проверяем: оригинальное имя и русский перевод
function matchPlayerByName(rec, poolIndex) {
  const rn = normalizeName(rec);
  const rru = normalizeName(displayPlayerName(rec));
  const keys = [rn, rru].filter(Boolean);
  if (!keys.length || keys.every(k => k.length < 2)) return null;

  // 1. Точное совпадение: проверяем и оригинальное имя, и русский перевод priorityNames
  let found = poolIndex.find(({ n, nru }) => keys.some(k => n === k || nru === k));
  if (found) return found.p;

  // 2. Мягкое совпадение без fallback по алфавиту
  found = poolIndex.find(({ n, nru }) => keys.some(k =>
    k.length >= 4 && (
      (n.length >= 4 && (n.includes(k) || k.includes(n))) ||
      (nru.length >= 4 && (nru.includes(k) || k.includes(nru)))
    )
  ));
  if (found) return found.p;

  return null;
}



// Критичные игроки, которые должны быть доступны в бонусных вопросах даже если импорт Wiki/БД их не подтянул.
// Важно: это не ломает импорт из tournament_players, а только добавляет безопасный fallback для UI/выбора.
const CRITICAL_TOURNAMENT_PLAYER_FALLBACKS = [
  {
    id: "manual-erling-haaland",
    name: "Эрлинг Холанд",
    national_team: "Норвегия",
    position: "forward",
    is_goalkeeper: false,
    is_young_player: false,
    is_active: true,
    source: "critical_fallback"
  },
  // Молодые звёзды — часто запрашиваются в бонусных вопросах
  {
    id: "manual-endrick",
    name: "Эндрик",
    national_team: "Бразилия",
    position: "forward",
    is_goalkeeper: false,
    is_young_player: true,
    is_active: true,
    source: "critical_fallback"
  },
  {
    id: "manual-estevao",
    name: "Estevao",
    national_team: "Бразилия",
    position: "forward",
    is_goalkeeper: false,
    is_young_player: true,
    is_active: true,
    source: "critical_fallback"
  },
  {
    id: "manual-lamine-yamal",
    name: "Lamine Yamal",
    national_team: "Испания",
    position: "forward",
    is_goalkeeper: false,
    is_young_player: true,
    is_active: true,
    source: "critical_fallback"
  },
  {
    id: "manual-alejandro-garnacho",
    name: "Alejandro Garnacho",
    national_team: "Аргентина",
    position: "forward",
    is_goalkeeper: false,
    is_young_player: true,
    is_active: true,
    source: "critical_fallback"
  },
];

function isSameFootballerName(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function withCriticalTournamentPlayers(players = []) {
  const arr = Array.isArray(players) ? [...players] : [];
  for (const fp of CRITICAL_TOURNAMENT_PLAYER_FALLBACKS) {
    // Строим алиасы для каждого fallback-игрока
    const aliases = [fp.name, displayPlayerName(fp.name)];
    // Специальные алиасы для Холанда
    if (fp.id === "manual-erling-haaland") {
      aliases.push("Эрлинг Холанд", "Эрлинг Хааланд", "Haaland", "Хааланд", "Холанд", "Erling Haaland");
    }
    // Алиасы для Эндрика
    if (fp.id === "manual-endrick") {
      aliases.push("Endrick Felipe", "Эндрик", "Endrick");
    }
    // Алиасы для Эстевао
    if (fp.id === "manual-estevao") {
      aliases.push("Estevão", "Estevao", "Эстевао", "Эстевон");
    }
    const exists = arr.some(p => aliases.some(alias =>
      isSameFootballerName(p.name, alias) || isSameFootballerName(displayPlayerName(p.name), alias)
    ));
    if (!exists) arr.unshift(fp);
  }
  return arr;
}

// Загружает ВСЕХ игроков tournament_players страницами.
// Важно: PostgREST/Supabase часто режет ответ на 1000 строк, поэтому limit=5000 не гарантирует 5000 строк.
async function fetchAllTournamentPlayersFromDb(filterType = "all") {
  const pageSize = 1000;
  const baseSelect = "tournament_players?select=id,name,national_team,position,is_goalkeeper,is_young_player&is_active=eq.true&order=name.asc";
  const extraFilter =
    filterType === "young" ? "&is_young_player=eq.true" :
    filterType === "goalkeeper" ? "&is_goalkeeper=eq.true" :
    "";
  const url = baseSelect + extraFilter;
  const rows = [];

  for (let from = 0; from < 10000; from += pageSize) {
    const to = from + pageSize - 1;
    const r = await supa(url, { headers: { Range: `${from}-${to}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const chunk = await r.json();
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }

  const fixed = withCriticalTournamentPlayers(rows);
  if (filterType === "young") return fixed.filter(p => p.is_young_player);
  if (filterType === "goalkeeper") return fixed.filter(p => p.is_goalkeeper);
  return fixed;
}

function useBonusPlayerOptions() {
  const [allPlayers, setAllPlayers] = React.useState(null); // null = loading
  const [loadError, setLoadError] = React.useState(false);
  const [selectionStats, setSelectionStats] = React.useState({}); // name → count

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAllTournamentPlayersFromDb("all");
        if (!cancelled) setAllPlayers(data || []);
      } catch (e) {
        console.warn("useBonusPlayerOptions:", e);
        if (!cancelled) { setAllPlayers([]); setLoadError(true); }
      }
      // Загружаем статистику выборов (безопасно — если нет таблицы, просто {}))
      try {
        const rs = await supa("bonus_predictions?select=answer_value&limit=5000");
        if (rs.ok) {
          const rows = await rs.json();
          const counts = {};
          (rows || []).forEach(r => {
            if (r.answer_value && typeof r.answer_value === "string") {
              counts[r.answer_value] = (counts[r.answer_value] || 0) + 1;
            }
          });
          if (!cancelled) setSelectionStats(counts);
        }
      } catch {} // таблица может не существовать — тихо игнорируем
    })();
    return () => { cancelled = true; };
  }, []);

  // Для конкретного вопроса вернуть до 10 кнопок — СТРОГО из tournament_players
  function getOptions(q) {
    if (!allPlayers) return { options: [], loading: true, empty: false };
    const isPlayerType = ["player","player_multi","goalkeeper"].includes(q.answerType);
    if (!isPlayerType) return { options: q.popularOptions || [], loading: false, empty: false };

    // Фильтрация по типу
    let pool = allPlayers;
    if (q.filterType === "young")      pool = allPlayers.filter(p => p.is_young_player);
    if (q.filterType === "goalkeeper") pool = allPlayers.filter(p => p.is_goalkeeper);

    if (pool.length === 0) return { options: [], loading: false, empty: true };

    // Строим индекс: оригинальное имя + русский перевод (через displayPlayerName)
    const poolIndex = pool.map(p => ({
      p,
      n: normalizeName(p.name),
      nru: normalizeName(displayPlayerName(p.name)),
    }));

    // Проходим по priorityNames строго: только совпавшие добавляем
    const recs = q.recommendedNames || [];
    const matched = [];
    const matchedIds = new Set();

    for (const rec of recs) {
      const found = matchPlayerByName(rec, poolIndex);
      if (found && !matchedIds.has(found.id)) {
        matched.push(found);
        matchedIds.add(found.id);
      }
      if (matched.length >= 10) break;
    }

    // НЕТ алфавитного fallback — лучше меньше кнопок, чем нерелевантные
    // Если очень мало совпадений (0-1), попробуем добрать по selection_count
    if (matched.length < 4 && Object.keys(selectionStats).length > 0) {
      const byPopularity = pool
        .filter(p => !matchedIds.has(p.id) && (selectionStats[p.name] || 0) > 0)
        .sort((a, b) => (selectionStats[b.name] || 0) - (selectionStats[a.name] || 0));
      for (const p of byPopularity) {
        if (!matchedIds.has(p.id)) {
          matched.push(p);
          matchedIds.add(p.id);
        }
        if (matched.length >= 8) break;
      }
    }

    return {
      options: matched.slice(0, 10).map(p => p.name),
      optionsWithStats: matched.slice(0, 10).map(p => ({
        name: p.name,
        displayName: displayPlayerName(p.name),
        selectionCount: selectionStats[p.name] || 0,
      })),
      loading: false,
      empty: allPlayers.length === 0 || pool.length === 0,
    };
  }

  return { getOptions, loading: allPlayers === null, loadError };
}

// ── CSS ──
const S = `
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&family=Barlow+Condensed:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0A1208;font-size:clamp(15px,1vw,18px)}
.app{font-family:'Barlow Condensed',sans-serif;background:#0A1208;min-height:100vh;color:#F0EDE6;font-size:clamp(15px,1vw,18px)}
.hdr{background:#060E05;border-bottom:3px solid #B91C1C;position:sticky;top:0;z-index:50}
.hdr-in{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:8px 16px;flex-wrap:wrap}
.logo{display:flex;align-items:center;gap:10px;flex-shrink:0;cursor:default}
.la{font-family:'Oswald',sans-serif;font-size:clamp(15px,.95vw,19px);font-weight:700;color:#F59E0B;letter-spacing:1px}
.lb{font-size:clamp(9px,.6vw,11px);color:rgba(240,237,230,.35);letter-spacing:1.5px}
.nav{display:flex;gap:2px;flex:1;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.nav::-webkit-scrollbar{display:none}
.nb{background:transparent;border:none;color:rgba(240,237,230,.45);font-family:'Barlow Condensed',sans-serif;font-size:clamp(13px,.95vw,18px);font-weight:600;text-transform:uppercase;letter-spacing:.5px;padding:clamp(5px,.4vw,8px) clamp(8px,.7vw,14px);border-radius:4px;cursor:pointer;transition:.15s}
.nb:hover{color:#F0EDE6;background:rgba(255,255,255,.05)}
.nb.on{color:#F59E0B;border-bottom:2px solid #F59E0B}
.main{max-width:1100px;margin:0 auto;padding:clamp(16px,1.5vw,28px) 16px 120px}
.panel{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-radius:10px;overflow:hidden;margin-bottom:14px}
.ph{background:rgba(255,255,255,.04);border-bottom:1px solid rgba(255,255,255,.07);padding:clamp(9px,.7vw,14px) clamp(12px,1vw,18px);display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.pt{font-family:'Oswald',sans-serif;font-size:clamp(11px,.85vw,15px);font-weight:600;text-transform:uppercase;letter-spacing:1px;color:rgba(240,237,230,.55)}
.tag{font-size:clamp(9px,.65vw,11px);font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:3px;white-space:nowrap}
.tg{color:#86EFAC;background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.25)}
.tr{color:#FCA5A5;background:rgba(185,28,28,.15);border:1px solid rgba(185,28,28,.3)}
.ty{color:#FDE68A;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25)}
.mr{padding:clamp(8px,.6vw,12px) clamp(12px,1vw,16px);border-bottom:1px solid rgba(255,255,255,.04);display:flex;align-items:center;gap:8px;transition:.15s}
.mr:hover{background:rgba(255,255,255,.02)}
.mr:last-child{border-bottom:none}
.sin{width:clamp(28px,2vw,36px);height:clamp(26px,1.8vw,32px);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:4px;color:#F59E0B;font-family:'Oswald',sans-serif;font-size:clamp(14px,.9vw,17px);font-weight:600;text-align:center;outline:none;transition:.15s}
.sin:focus{border-color:#B91C1C;background:rgba(185,28,28,.1)}
.ssep{color:rgba(240,237,230,.2);font-size:clamp(12px,.85vw,15px)}
.tbl{width:100%;border-collapse:collapse;font-size:clamp(12px,.8vw,15px)}
.tbl th{font-size:clamp(9px,.65vw,11px);text-transform:uppercase;letter-spacing:.5px;color:rgba(240,237,230,.3);font-weight:600;padding:5px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,.06)}
.tbl td{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.04)}
.tbl tr:last-child td{border-bottom:none}
.pos{display:inline-block;width:16px;height:16px;border-radius:50%;font-size:10px;font-weight:700;text-align:center;line-height:16px}
.bp{background:#B91C1C;color:#fff;border:none;font-family:'Oswald',sans-serif;font-size:clamp(13px,.95vw,17px);font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:clamp(9px,.7vw,13px) clamp(18px,1.4vw,26px);border-radius:4px;cursor:pointer;transition:.15s}
.bp:hover{background:#DC2626}
.bp:disabled{opacity:.4;cursor:default}
.sb{background:#14532D;color:#fff;border:none;font-family:'Oswald',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:clamp(6px,.45vw,9px) clamp(11px,.85vw,16px);border-radius:4px;cursor:pointer;transition:.15s}
.sb:hover{background:#16A34A}
.inp{width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:6px;color:#F0EDE6;font-family:'Barlow Condensed',sans-serif;font-size:clamp(14px,.95vw,17px);padding:clamp(9px,.7vw,13px) clamp(10px,.8vw,14px);outline:none;margin-bottom:8px;transition:.15s}
.inp:focus{border-color:#B91C1C}
.inp::placeholder{color:rgba(240,237,230,.25)}
.err{background:rgba(185,28,28,.15);border:1px solid rgba(185,28,28,.35);border-radius:5px;padding:7px 12px;font-size:clamp(12px,.8vw,15px);color:#FCA5A5;margin-bottom:8px}
.ok{background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.3);border-radius:5px;padding:7px 12px;font-size:clamp(12px,.8vw,15px);color:#86EFAC;margin-bottom:8px}
.toast{position:fixed;bottom:20px;right:20px;background:#14532D;color:#fff;font-family:'Oswald',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;letter-spacing:1px;padding:9px 18px;border-radius:6px;text-transform:uppercase;z-index:999;animation:su .2s ease}
@keyframes su{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
.qcard{background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.07);border-left:3px solid rgba(255,255,255,.06);border-radius:8px;padding:clamp(10px,.8vw,16px);margin-bottom:8px}
.qcard.done{border-left-color:#16A34A}
.opts{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.opt{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.65);font-family:'Barlow Condensed',sans-serif;font-size:clamp(12px,.85vw,15px);padding:clamp(4px,.35vw,7px) clamp(9px,.7vw,13px);border-radius:4px;cursor:pointer;transition:.15s}
.opt:hover{background:rgba(255,255,255,.09)}
.opt.on{background:rgba(185,28,28,.2);border-color:#B91C1C;color:#F0EDE6}
.opt.multi.on{background:rgba(22,163,74,.15);border-color:#16A34A;color:#F0EDE6}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto}
.modal{background:#0D1A0F;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 24px;max-width:400px;width:100%;margin:auto}
.pm{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:clamp(9px,.7vw,13px) clamp(11px,.85vw,15px);margin-bottom:8px}
.pmt{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pmt-team{flex:1;font-size:clamp(12px,.85vw,15px);font-weight:500;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.07);text-align:center}
.pmt-team.win{background:rgba(22,163,74,.15);border-color:rgba(22,163,74,.35);color:#86EFAC;font-weight:600}
.pmt-team.tbd{color:rgba(240,237,230,.35);font-size:clamp(9px,.65vw,11px);line-height:1.2;padding:4px 6px}
.pen-btn{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.5);font-size:clamp(10px,.75vw,13px);font-family:'Barlow Condensed',sans-serif;padding:3px 8px;border-radius:3px;cursor:pointer;transition:.15s}
.pen-btn.on{background:rgba(245,158,11,.2);border-color:#F59E0B;color:#FDE68A;font-weight:600}
.lr{padding:clamp(8px,.6vw,12px) clamp(12px,1vw,16px);border-bottom:1px solid rgba(255,255,255,.04);display:flex;align-items:center;gap:10px;transition:.15s}
.lr:hover{background:rgba(255,255,255,.02)}
.lr:last-child{border-bottom:none}
.rk{font-family:'Oswald',sans-serif;font-size:clamp(15px,1.1vw,20px);font-weight:700;width:24px;text-align:center;flex-shrink:0}
.av{border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Oswald',sans-serif;font-size:clamp(10px,.7vw,13px);font-weight:700;flex-shrink:0}
.pp{font-family:'Oswald',sans-serif;font-size:clamp(17px,1.2vw,22px);font-weight:700;color:#F59E0B}
.third-ok{font-size:clamp(9px,.65vw,11px);font-weight:700;color:#86EFAC;background:rgba(22,163,74,.12);border:1px solid rgba(22,163,74,.3);padding:1px 6px;border-radius:3px;white-space:nowrap}
.third-no{font-size:clamp(9px,.65vw,11px);font-weight:700;color:#FCA5A5;background:rgba(185,28,28,.12);border:1px solid rgba(185,28,28,.3);padding:1px 6px;border-radius:3px;white-space:nowrap}
.paywall-modal{background:#0D1A0F;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:28px 24px;max-width:480px;width:100%;margin:auto}
.plan-card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px;cursor:pointer;transition:.15s;position:relative}
.plan-card:hover{border-color:rgba(245,158,11,.4);background:rgba(255,255,255,.06)}
.plan-card.featured{border-color:#B91C1C;background:rgba(185,28,28,.08)}
.plan-card .price{font-family:'Oswald',sans-serif;font-size:clamp(22px,1.6vw,30px);font-weight:700;color:#F59E0B}
.plan-card .plan-name{font-family:'Oswald',sans-serif;font-size:clamp(13px,.95vw,16px);font-weight:600;color:#F0EDE6;margin-bottom:4px}
.admin-table{width:100%;border-collapse:collapse;font-size:clamp(12px,.85vw,15px)}
.admin-table th{font-size:clamp(9px,.65vw,12px);text-transform:uppercase;color:rgba(240,237,230,.3);padding:clamp(5px,.4vw,8px) clamp(8px,.6vw,12px);text-align:left;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
.admin-table td{padding:clamp(6px,.5vw,10px) clamp(8px,.6vw,12px);border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
.admin-table tr:last-child td{border-bottom:none}
.mini-btn{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.7);font-family:'Barlow Condensed',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;padding:clamp(3px,.3vw,6px) clamp(7px,.55vw,11px);border-radius:3px;cursor:pointer;transition:.15s;white-space:nowrap}
.mini-btn:hover{background:rgba(255,255,255,.12)}
.mini-btn.green{background:rgba(22,163,74,.2);border-color:rgba(22,163,74,.4);color:#86EFAC}
.mini-btn.red{background:rgba(185,28,28,.2);border-color:rgba(185,28,28,.4);color:#FCA5A5}
.tabs{display:flex;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:6px;padding:3px;margin-bottom:14px;flex-wrap:wrap;gap:2px}
.tab{flex:1;min-width:34px;background:transparent;border:none;color:rgba(240,237,230,.4);font-family:'Barlow Condensed',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;text-transform:uppercase;padding:clamp(5px,.4vw,8px) 3px;border-radius:4px;cursor:pointer;transition:.15s}
.tab.on{background:#B91C1C;color:#fff}
.anchor-bar{display:flex;gap:3px;flex-wrap:wrap;position:sticky;top:52px;z-index:40;background:#0A1208;padding:6px 0 6px;margin-bottom:10px}
.anch-btn{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:rgba(240,237,230,.6);font-family:'Oswald',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;padding:clamp(3px,.3vw,6px) clamp(8px,.6vw,12px);border-radius:4px;cursor:pointer;transition:.15s;min-width:32px;text-align:center}
.anch-btn.done{background:rgba(22,163,74,.2);border-color:rgba(22,163,74,.3);color:#86EFAC}
.section-hdr{font-family:'Oswald',sans-serif;font-size:clamp(16px,1.2vw,22px);font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(240,237,230,.7);margin-bottom:14px;display:flex;align-items:center;gap:10px}
.section-hdr-bar{width:3px;height:20px;border-radius:2px;display:inline-block;flex-shrink:0}
.group-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-bottom:24px}
.po-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.access-badge{font-size:clamp(9px,.65vw,11px);font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 8px;border-radius:10px}
.badge-demo{background:rgba(255,255,255,.07);color:rgba(240,237,230,.45);border:1px solid rgba(255,255,255,.1)}
.badge-paid{background:rgba(22,163,74,.15);color:#86EFAC;border:1px solid rgba(22,163,74,.3)}
.badge-full{background:rgba(245,158,11,.15);color:#FDE68A;border:1px solid rgba(245,158,11,.3)}
.badge-admin{background:rgba(185,28,28,.2);color:#FCA5A5;border:1px solid rgba(185,28,28,.35)}
.debug-panel{background:rgba(245,158,11,.04);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:14px;margin-bottom:14px;font-size:clamp(11px,.75vw,13px)}
@media(max-width:680px){.group-grid,.po-grid{grid-template-columns:1fr}}
@media(max-width:600px){.anch-btn{padding:3px 6px!important;font-size:11px!important;min-width:26px!important}.sin{width:34px!important;height:36px!important}.nb{font-size:12px!important;padding:5px 7px!important}}
@media(max-width:700px){
  html,body{max-width:100%;overflow-x:hidden}
  .app{max-width:100%;overflow-x:hidden}
  .hdr-in{max-width:100%;padding:8px 10px;gap:8px;flex-direction:column;align-items:stretch;flex-wrap:nowrap}
  .logo{width:100%;justify-content:center;min-width:0}
  .la{font-size:18px!important;line-height:1.1;text-align:center}
  .lb{font-size:10px!important;text-align:center}
  /* мобильное меню "шашечками", без уезжания вправо */
  .nav{width:100%;flex:0 0 auto;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:4px 0 2px;overflow:visible!important;justify-content:stretch}
  .nb{width:100%;min-width:0;flex:initial;font-size:12px!important;padding:8px 6px!important;white-space:normal;text-align:center;line-height:1.15;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.025)}
  .nb.on{background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.35);border-bottom:2px solid #F59E0B}
  .hdr-in>div:last-child{align-self:stretch;justify-content:center;max-width:100%;overflow:hidden}
  .main{max-width:100%;padding:14px 10px 100px;overflow-x:hidden}
  .tabs{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;overflow:visible;scrollbar-width:none}
  .tab{min-width:0;white-space:normal;padding:8px 6px!important;line-height:1.15}
  .anchor-bar{overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none}
  .anch-btn{flex:0 0 auto;white-space:nowrap}
}

.auth-divider{display:flex;align-items:center;gap:10px;margin:14px 0;color:rgba(240,237,230,.25);font-size:clamp(10px,.7vw,12px)}.auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.08)}
.google-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#fff;border:none;border-radius:6px;color:#1f1f1f;font-family:'Barlow Condensed',sans-serif;font-size:clamp(13px,.9vw,16px);font-weight:600;padding:clamp(10px,.75vw,14px) 16px;cursor:pointer;transition:.15s;margin-bottom:8px}
.google-btn:hover{background:#f0f0f0;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.vk-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:10px;background:#0077FF;border:none;border-radius:6px;color:#fff;font-family:'Barlow Condensed',sans-serif;font-size:clamp(13px,.9vw,16px);font-weight:600;padding:clamp(10px,.75vw,14px) 16px;cursor:pointer;transition:.15s;margin-bottom:4px}
.vk-btn:hover{background:#0060d0}
.vk-btn:disabled{background:#334;cursor:default;opacity:.5}
.auth-hint{font-size:clamp(9px,.65vw,11px);color:rgba(240,237,230,.25);text-align:center;margin-bottom:10px;line-height:1.4}
.fcoins-badge{display:flex;align-items:center;gap:4px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.25);border-radius:12px;padding:2px 8px;font-family:'Oswald',sans-serif;font-size:clamp(11px,.8vw,14px);font-weight:600;color:#FDE68A;cursor:default;white-space:nowrap}
.mode-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:24px 20px;cursor:pointer;transition:.2s;position:relative;overflow:hidden}
.mode-card:hover{border-color:rgba(245,158,11,.35);background:rgba(255,255,255,.05)}
.mode-card.champ{border-left:4px solid #B91C1C}
.mode-card.clubs{border-left:4px solid #1d4ed8}
@media(min-width:900px){
/* Body base — умеренный рост */
body,.app{font-size:17px}
/* Навигация — читаемая, не гигантская */
.nb{font-size:16px!important;padding:7px 14px!important;letter-spacing:.04em}
.la{font-size:22px!important}
/* Главные CTA-кнопки */
.bp{font-size:17px!important;padding:13px 24px!important}
.sb{font-size:14px!important;padding:9px 16px!important}
/* Опции бонусных вопросов — умеренные */
.opt{font-size:16px!important;padding:6px 13px!important}
/* Инпуты */
.inp{font-size:17px!important;padding:12px 14px!important}
/* Вкладки */
.tab{font-size:13px!important}
/* Мелкие кнопки */
.mini-btn{font-size:13px!important;padding:5px 11px!important}
/* Заголовки блоков */
.section-hdr{font-size:22px!important}
/* Таблицы — читаемые */
.admin-table{font-size:14px!important}
.admin-table th{font-size:12px!important}
/* Матчи / команды в прогнозах — крупнее */
.pmt-team{font-size:18px!important;padding:7px 10px!important}
.sin{width:38px!important;height:34px!important;font-size:18px!important}
.tbl{font-size:15px!important}
.tbl td,.tbl th{padding:8px 12px!important}
}
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

// ── AUTH MODAL: Google + email/password ──
// ── DisplayNameModal — выбор отображаемого имени участника ──
function DisplayNameModal({ profile, session, onSave, onSkip }) {
  const [name, setName] = React.useState(
    (profile?.display_name && !profile.display_name.includes("@")) ? profile.display_name : ""
  );
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState("");
  const token = session?.access_token;
  const uid = session?.user?.id;

  const VALID = /^[a-zA-Zа-яА-ЯёЁ0-9\s\-_]{2,40}$/u;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) { setErr("Минимум 2 символа"); return; }
    if (trimmed.length > 40) { setErr("Максимум 40 символов"); return; }
    if (!VALID.test(trimmed)) { setErr("Только буквы, цифры, пробелы, дефис и _"); return; }
    setSaving(true);
    try {
      const r = await supa(`profiles?id=eq.${uid}`, {
        method: "PATCH", token,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ display_name: trimmed }),
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        console.error("[DisplayNameModal] PATCH error:", r.status, errText);
        setErr(`Ошибка сохранения (${r.status}). Проверьте RLS политики Supabase.`);
        setSaving(false);
        return;
      }
      const saved = await r.json().catch(() => null);
      const savedName = saved?.[0]?.display_name || trimmed;
      console.log("[DisplayNameModal] Saved display_name:", savedName);
      onSave(savedName);
    } catch (e) {
      console.error("[DisplayNameModal] Exception:", e);
      setErr("Ошибка сохранения, попробуйте ещё раз");
    }
    setSaving(false);
  }

  return (
    <div className="modal-bg">
      <div className="modal" style={{ maxWidth: 380 }}>
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✏️</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B" }}>
            Как подписать вашу форму?
          </div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", marginTop: 6, lineHeight: 1.5 }}>
            Это имя будет видно в таблицах, прогнозах и Битве клубов.<br/>
            Email нигде публично не показывается.
          </div>
        </div>

        {err && <div className="err">{err}</div>}

        <input
          className="inp"
          placeholder="Например: Алексей, Команда Петровых, Mozgokvest"
          value={name}
          onChange={e => { setName(e.target.value); setErr(""); }}
          maxLength={40}
          autoFocus
          onKeyDown={e => e.key === "Enter" && handleSave()}
        />
        <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginBottom: 12 }}>
          {name.trim().length}/40 символов · кириллица, латиница, цифры, пробел, дефис, _
        </div>

        <button className="bp" style={{ width: "100%", marginBottom: 8 }} disabled={saving} onClick={handleSave}>
          {saving ? "Сохраняю…" : "Сохранить имя →"}
        </button>
        <button onClick={onSkip}
          style={{ width: "100%", background: "transparent", border: "none", color: "rgba(240,237,230,.3)", fontSize: 12, cursor: "pointer", padding: "6px" }}>
          Пропустить (можно изменить позже в профиле)
        </button>
      </div>
    </div>
  );
}

function AuthModal({ onClose, onAuth }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [socialBusy, setSocialBusy] = useState(null); // "google" | null

  const cleanEmail = () => email.trim().toLowerCase();

  function validateBase() {
    const emailClean = cleanEmail();
    if (!emailClean || !emailClean.includes("@") || !emailClean.includes(".")) {
      setErr("Введи корректный email, например: name@mail.ru");
      return null;
    }
    if (!password || password.length < 6) {
      setErr("Пароль должен быть минимум 6 символов");
      return null;
    }
    if (mode === "register" && password !== password2) {
      setErr("Пароли не совпадают");
      return null;
    }
    return emailClean;
  }

  function authErrorText(message = "") {
    const msg = String(message || "");
    const low = msg.toLowerCase();
    if (low.includes("signup") && low.includes("disabled")) return "Регистрация по email сейчас выключена в Supabase. Включите: Authentication → Providers → Email → Enable email provider = ON.";
    if (low.includes("email") && low.includes("disabled")) return "Email-вход сейчас выключен в Supabase. Включите: Authentication → Providers → Email → Enable email provider = ON.";
    if (low.includes("email not confirmed") || low.includes("not confirmed")) return "Supabase всё ещё требует подтверждение почты. Отключите Confirm email или используйте Google.";
    if (low.includes("invalid login") || low.includes("invalid credentials")) return "Неверный email или пароль. Если аккаунт ещё не создан — нажми «Зарегистрироваться».";
    if (low.includes("already registered") || low.includes("user already")) return "Такой email уже зарегистрирован. Нажми «Войти» и введи пароль.";
    if (low.includes("password")) return "Проверь пароль: минимум 6 символов.";
    if (low.includes("email")) return "Проверь email или попробуй войти через Google.";
    if (low.includes("rate") || low.includes("too many") || low.includes("429")) return "Слишком много попыток. Подождите 1–2 минуты и попробуйте снова.";
    return msg || "Не удалось войти. Попробуй ещё раз или войди через Google.";
  }

  async function handlePasswordAuth() {
    setErr("");
    setInfo("");
    const emailClean = validateBase();
    if (!emailClean) return;

    setBusy(true);
    try {
      if (mode === "register") {
        const { data, error } = await supabaseClient.auth.signUp({
          email: emailClean,
          password,
          options: {
            data: name.trim() ? { name: name.trim() } : undefined,
          },
        });
        if (error) {
          setErr(authErrorText(error.message));
          return;
        }
        if (data?.session?.access_token) {
          onAuth(data.session);
          return;
        }
        setErr("Регистрация создана, но Supabase всё ещё требует подтверждение email. В Supabase отключите Confirm email: Authentication → Providers → Email → Confirm email = OFF.");
        return;
      }

      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: emailClean,
        password,
      });
      if (error) {
        setErr(authErrorText(error.message));
        return;
      }
      if (data?.session?.access_token) {
        onAuth(data.session);
      } else {
        setErr("Не удалось получить сессию. Попробуй ещё раз или войди через Google.");
      }
    } catch (e) {
      console.error("[Auth] Password auth error:", e);
      setErr("Ошибка входа. Попробуй ещё раз или войди через Google.");
    } finally {
      setBusy(false);
    }
  }

  async function signInWithGoogle() {
    setErr("");
    setInfo("");
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

  const isRegister = mode === "register";
  const isAnySocialBusy = socialBusy !== null;

  return (
    <div className="modal-bg" onClick={(e) => e.target.className === "modal-bg" && onClose()}>
      <div className="modal">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 19, fontWeight: 700, color: "#F59E0B" }}>
            {isRegister ? "Создать аккаунт" : "Войти в турнир"}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>

        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        {info && <div className="ok" style={{ marginBottom: 10 }}>{info}</div>}

        {/* Google */}
        <button className="google-btn" disabled={busy || isAnySocialBusy} onClick={signInWithGoogle}
          style={{ marginBottom: 14, opacity: busy ? 0.7 : 1 }}>
          <svg width="18" height="18" viewBox="0 0 48 48">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          {socialBusy === "google" ? "Перехожу..." : "Войти через Google"}
        </button>

        {/* Разделитель */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.1)" }} />
          <span style={{ fontSize: 11, color: "rgba(240,237,230,.3)", whiteSpace: "nowrap" }}>или через email</span>
          <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,.1)" }} />
        </div>

        {/* Email + пароль */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {isRegister && (
            <input
              className="inp"
              placeholder="Имя (необязательно)"
              value={name}
              onChange={e => { setName(e.target.value); setErr(""); }}
              style={{ marginBottom: 0 }}
              autoComplete="name"
            />
          )}
          <input
            className="inp"
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => { setEmail(e.target.value); setErr(""); }}
            style={{ marginBottom: 0 }}
            autoComplete="email"
            onKeyDown={e => e.key === "Enter" && handlePasswordAuth()}
          />
          <input
            className="inp"
            type="password"
            placeholder="Пароль (минимум 6 символов)"
            value={password}
            onChange={e => { setPassword(e.target.value); setErr(""); }}
            style={{ marginBottom: 0 }}
            autoComplete={isRegister ? "new-password" : "current-password"}
            onKeyDown={e => e.key === "Enter" && handlePasswordAuth()}
          />
          {isRegister && (
            <input
              className="inp"
              type="password"
              placeholder="Повторите пароль"
              value={password2}
              onChange={e => { setPassword2(e.target.value); setErr(""); }}
              style={{ marginBottom: 0 }}
              autoComplete="new-password"
              onKeyDown={e => e.key === "Enter" && handlePasswordAuth()}
            />
          )}

          <button
            className="bp"
            disabled={busy || isAnySocialBusy}
            onClick={handlePasswordAuth}
            style={{ width: "100%", padding: "11px", fontSize: 14, marginTop: 2 }}>
            {busy ? "Подождите..." : isRegister ? "Создать аккаунт" : "Войти"}
          </button>
        </div>

        {/* Переключатель */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
          <button
            onClick={() => { setMode(isRegister ? "login" : "register"); setErr(""); setInfo(""); }}
            style={{ background: "transparent", border: "none", color: "#93C5FD", fontSize: 12, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
            {isRegister ? "Уже есть аккаунт? Войти" : "Нет аккаунта? Зарегистрироваться"}
          </button>
          <button
            onClick={() => setInfo("Если не получается войти — напишите организатору: vk.com/panteleewintop")}
            style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.3)", fontSize: 11, cursor: "pointer", padding: 0 }}>
            Забыли пароль?
          </button>
        </div>

        <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginTop: 12, lineHeight: 1.5, borderTop: "1px solid rgba(255,255,255,.05)", paddingTop: 10 }}>
          Войти можно через Google или по email + паролю. Код на почту не нужен.
        </div>
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
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)" }}>Отличные прогнозы! Чтобы они попали в таблицу — оплатите участие.</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 20, cursor: "pointer", flexShrink: 0 }}>×</button>
        </div>
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>🏆 Битва прогнозистов</div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F59E0B", marginBottom: 10 }}>500 ₽</div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.7, marginBottom: 14 }}>
            Ваши прогнозы готовы — осталось только оплатить. Приз победителю турнира — <strong style={{ color: "#FDE68A" }}>5 000 ₽</strong>.
          </div>
          {["🏆 Приз победителю — 5 000 ₽", "📋 Прогнозы на все матчи", "❓ Бонусные вопросы", "📊 Общая таблица прогнозистов", "🤝 Командный зачёт"].map(f => (
            <div key={f} style={{ fontSize: 12, color: "rgba(240,237,230,.6)", marginBottom: 4, display: "flex", gap: 6 }}>
              <span style={{ color: "#15803d" }}>✓</span>{f}
            </div>
          ))}
          <button className="bp" style={{ width: "100%", padding: "10px", fontSize: 14, marginTop: 14 }}
            onClick={() => onSelectPlan(PLANS[0])}>
            Участвовать →
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
          ✅ Прогнозы заполнены! Переведите 500 ₽ — и ваш прогноз попадёт в турнир. Приз победителю — 5 000 ₽.
        </div>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F59E0B", marginBottom: 4 }}>{plan.price} ₽</div>
        <div style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 14, margin: "12px 0" }}>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>Как оплатить</div>
          <div style={{ fontSize: 14, color: "#F0EDE6", lineHeight: 1.7, marginBottom: 10 }}>
            Переведите <strong style={{ color: "#F59E0B" }}>500 ₽</strong> на карту, привязанную к номеру телефона:<br/>
            <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#FDE68A", letterSpacing: 2 }}>8 911 823-15-76</span>
          </div>
          {[["Банк", PAYMENT_INFO.bank], ["Получатель", PAYMENT_INFO.name], ["Комментарий", PAYMENT_INFO.comment]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,.05)", fontSize: 12 }}>
              <span style={{ color: "rgba(240,237,230,.4)" }}>{k}</span>
              <span style={{ color: "#F0EDE6", fontWeight: 500 }}>{v}</span>
            </div>
          ))}
          <div style={{ marginTop: 10, fontSize: 12, color: "rgba(240,237,230,.45)", lineHeight: 1.5 }}>
            После перевода отправьте подтверждение/скрин в поддержку:<br/>
            <a href={PAYMENT_INFO.support} target="_blank" rel="noopener noreferrer" style={{ color: "#93C5FD" }}>{PAYMENT_INFO.support}</a>
          </div>
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

  async function ensureFfcProfileRow() {
    if (!session?.user?.id || !token) return false;
    try {
      const meta = session.user.user_metadata || {};
      const fallbackName =
        (profile?.display_name && !String(profile.display_name).includes("@") ? profile.display_name : "") ||
        (profile?.name && !String(profile.name).includes("@") ? profile.name : "") ||
        meta.full_name || meta.name || (session.user.email || "").split("@")[0] || "Игрок";
      const payload = {
        id: session.user.id,
        email: session.user.email || profile?.email || null,
        name: fallbackName,
        display_name: fallbackName,
        prediction_status: profile?.prediction_status || "draft",
        access_level: profile?.access_level || "demo",
      };
      const res = await supa("profiles?on_conflict=id", {
        method: "POST",
        token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("ensureFfcProfileRow failed", res.status, text);
        showToast(`⚠ Не удалось подготовить профиль для сохранения состава: ${text.slice(0, 160)}`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn("ensureFfcProfileRow exception", e);
      showToast(`⚠ Не удалось подготовить профиль для сохранения состава: ${e?.message || e}`);
      return false;
    }
  }

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
      // 1. Пробуем загрузить pool текущего тура
      let poolPlayers = null;
      if (activeRound?.id && activeRound.id !== "local-round-1") {
        try {
          const poolRes = await supa(
            `ffc_round_player_pool?round_id=eq.${activeRound.id}&is_available=eq.true&select=player_id,display_priority,ffc_players(*)&order=display_priority.asc`,
            { token }
          );
          if (poolRes.ok) {
            const poolData = await poolRes.json();
            if (poolData && poolData.length > 0) {
              poolPlayers = poolData
                .filter(row => row.ffc_players)
                .map(row => ({ ...row.ffc_players, _display_priority: row.display_priority }));
            }
          }
        } catch {}
      }

      if (poolPlayers && poolPlayers.length > 0) {
        // Используем pool тура
        console.log(`FFC round pool loaded: ${poolPlayers.length} players for round ${activeRound.id}`);
        setPlayers(poolPlayers);
        setPlayersLoadError(null);
      } else {
        // 2. Fallback: ffc_players where is_available=true, limit 72
        const r = await supa("ffc_players?select=*&is_active=eq.true&is_available=eq.true&order=display_priority.asc,national_team.asc,name.asc&limit=72");
        if (!r.ok) {
          // 3. Последний fallback без is_available фильтра
          const r2 = await supa("ffc_players?select=*&is_active=eq.true&order=national_team.asc,name.asc&limit=5000");
          if (!r2.ok) {
            const text = await r2.text().catch(() => "");
            setPlayersLoadError(`HTTP ${r2.status}: ${text.slice(0, 200)}`);
            setPlayers([]);
          } else {
            const rows = await r2.json();
            setPlayers(rows || []);
            setPlayersLoadError(null);
          }
        } else {
          const rows = await r.json();
          console.log("FFC players fallback loaded:", rows.length);
          setPlayers(rows || []);
          setPlayersLoadError(null);
        }
      }
    } catch (e) {
      console.error("Load FFC players exception:", e);
      setPlayersLoadError(String(e?.message || e));
      setPlayers([]);
    }

    // allPlayersMap — для отображения текущих составов
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

    // Капитан — только из полевых игроков, не тренер
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
      return `Вы сделали ${changesCount} замен, доступно ${allowedTransfers}. Обратитесь в поддержку.`;
    }

    return null;
  }

  async function saveLineup() {
    if (!canEdit) { showToast("Состав нельзя изменить — тур закрыт"); return; }
    const error = validateLineup();
    if (error) { showToast("⚠ " + error); return; }

    setSaving(true);
    const profileOk = await ensureFfcProfileRow();
    if (!profileOk) { setSaving(false); return; }

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
      lineup_status:     "submitted",
      lineup_source:     savedLineup?.lineup_source || "manual",
      submitted_at:      savedLineup?.submitted_at || new Date().toISOString(),
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
      const res = await supa("ffc_lineups?on_conflict=user_id,round_id", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
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
      try {
        await supa("ffc_cup_entries", {
          method: "POST", token,
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: uid, round_id: activeRound.id, status: "lineup_submitted" }),
        });
      } catch (e) { console.warn("ffc_cup_entries marker skipped", e); }
      setAutoCarryMsg(false);
      showToast("✓ Состав сохранён и отмечен как отправленный");
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
          F-Coins не тратятся на игровые преимущества.
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
            <span style={{ color: "#FCA5A5" }}>· Лимит бесплатных замен превышен</span>
          )}
        </div>
      )}

      {/* Правила */}
      <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 11, color: "rgba(240,237,230,.55)", lineHeight: 1.7 }}>
        <strong style={{ color: "#93C5FD" }}>Состав:</strong> 1 тренер + 1 вратарь + 4 защитника + 4 полузащитника + 2 нападающих · капитан из 11 футболистов (не тренер) — ×1.5 очков<br />
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
                Запасной
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
    const r = await supa("ffc_cup_entries?select=*,profiles(id,name,display_name,club_name,email)", { token });
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
      showToast(`⚡ Нечётное число — ${getDisplayName(bye.profiles) || "участник"} проходит автоматически (bye)`);
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
                <div style={{ fontSize: 13 }}>{getDisplayName(e.profiles) || e.user_id?.slice(0, 8)}</div>
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
    const r = await supa("ffc_league_entries?select=*,profiles(id,name,display_name,club_name,email)&order=points.desc,goals_for.desc", { token });
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
                        <div style={{ fontSize: 13, fontWeight: isMe ? 700 : 400 }}>{getDisplayName(e.profiles) || e.user_id?.slice(0, 8)}</div>
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
  return (
    <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.18)", borderRadius: 12, padding: "20px 18px" }}>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#FDE68A", marginBottom: 8 }}>🪙 F-Coins</div>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 30, fontWeight: 800, color: "#F59E0B", marginBottom: 12 }}>
        {profile?.fcoins_balance || 0} F-Coins
      </div>
      <div style={{ fontSize: 14, color: "rgba(240,237,230,.65)", lineHeight: 1.7, marginBottom: 14 }}>
        F-Coins сейчас нельзя тратить. Это показатель активности и тай-брейкер при равенстве очков в Битве клубов и рейтингах.
      </div>
      <div style={{ background: "rgba(0,0,0,.18)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "12px 14px", fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.7 }}>
        Получай F-Coins за ежедневный квиз и приглашённых друзей. Магазин, скамейка, скаут, дополнительные замены, скрытие состава и кастомизация за F-Coins отключены, чтобы не давать игровых преимуществ.
      </div>
      <button className="bp" style={{ marginTop: 14, background: "#16A34A" }} onClick={() => showToast?.("Открой вкладку ⚽ Квиз в верхнем меню")}>
        ⚽ Заработать F-Coins в квизе
      </button>
    </div>
  );
}

// ── Словарь русских имён для игроков драфта ──
const DRAFT_NAME_RU = {
  "Lionel Scaloni":"Лионель Скалони","Didier Deschamps":"Дидье Дешам","Julian Nagelsmann":"Юлиан Нагельсман",
  "Luis de la Fuente":"Луис де ла Фуэнте","Marcelo Bielsa":"Марсело Бьелса","Guillermo Ochoa":"Гильермо Очоа",
  "Ronwen Williams":"Ронвен Уильямс","Mat Ryan":"Мэт Райан","Gregor Kobel":"Грегор Кобель",
  "Emiliano Martinez":"Эмилиано Мартинес","Achraf Hakimi":"Ашраф Хакими","Virgil van Dijk":"Вирджил ван Дейк",
  "Kalidou Koulibaly":"Калиду Кулибали","Josko Gvardiol":"Йошко Гвардиол","Wilfried Singo":"Вильфрид Синго",
  "Kim Min-jae":"Ким Мин Джэ","Marquinhos":"Маркиньос","John Stones":"Джон Стоунз",
  "Alphonso Davies":"Альфонсо Дэвис","Nuno Mendes":"Нуну Мендеш","Liberato Cacace":"Либерато Какаче",
  "Stopira":"Стопира","Michael Amir Murillo":"Майкл Амир Мурильо","Abdukodir Khusanov":"Абдукодир Хусанов",
  "Jurien Gaari":"Юриен Гаари","Sead Kolasinac":"Сеад Колашинац","Lucas Mendes":"Лукас Мендеш",
  "Chris Richards":"Крис Ричардс","Andy Robertson":"Энди Робертсон","Antonee Robinson":"Энтони Робинсон",
  "Jude Bellingham":"Джуд Беллингем","Pedri":"Педри","Federico Valverde":"Федерико Вальверде",
  "Kevin De Bruyne":"Кевин Де Брёйне","Jamal Musiala":"Джамал Мусиала","Granit Xhaka":"Гранит Джака",
  "Hakan Calhanoglu":"Хакан Чалханоглу","Moises Caicedo":"Мойсес Кайседо","Takefusa Kubo":"Такефуса Кубо",
  "Mohammed Kudus":"Мохаммед Кудус","Zidane Iqbal":"Зидан Икбал","Noor Al-Rawabdeh":"Нур Аль-Равабдех",
  "Jean-Ricner Bellegarde":"Жан-Рикнер Белльгард","Aissa Laidouni":"Айсса Лайдуни","Jackson Irvine":"Джексон Ирвайн",
  "Miguel Almiron":"Мигель Альмирон","Ismael Bennacer":"Исмаэль Беннасер","Marcel Sabitzer":"Марсель Забитцер",
  "Richard Rios":"Ричард Риос","Salem Al-Dawsari":"Салем Аль-Давсари","Kylian Mbappe":"Килиан Мбаппе",
  "Эрлинг Холанд":"Эрлинг Холанд","Эрлинг Хааланд":"Эрлинг Холанд","Erling Haaland":"Эрлинг Холанд","Lionel Messi":"Лионель Месси","Vinicius Jr":"Винисиус Жуниор",
  "Cristiano Ronaldo":"Криштиану Роналду","Mohamed Salah":"Мохамед Салах","Alexander Isak":"Александер Исак",
  "Mehdi Taremi":"Мехди Тареми","Yoane Wissa":"Йоан Висса","Patrik Schick":"Патрик Шик",
  // Бонусные вопросы — дополнительные имена
  "Harry Kane":"Гарри Кейн","Lautaro Martinez":"Лаутаро Мартинес",
  "Bruno Fernandes":"Бруну Фернандеш","Antoine Griezmann":"Антуан Гризманн",
  "Bernardo Silva":"Бернарду Силва","Lamine Yamal":"Ламин Ямаль","Endrick":"Эндрик",
  "Kenan Yildiz":"Кенан Йылдыз","Arda Guler":"Арда Гюлер","Warren Zaire-Emery":"Уоррен Заир-Эмери",
  "Estevao":"Эстевао","Alejandro Garnacho":"Алехандро Гарначо","Kobbie Mainoo":"Коби Майну",
  "Pau Cubarsi":"Пау Кубарси","Gavi":"Гави","Alisson":"Алисон","Mike Maignan":"Майк Меньян",
  "Gianluigi Donnarumma":"Джанлуиджи Доннарумма","Thibaut Courtois":"Тибо Куртуа",
  "Unai Simon":"Унаи Симон","Jordan Pickford":"Джордан Пикфорд","Jan Sommer":"Ян Зоммер",
  "Manuel Neuer":"Мануэль Нойер","Romelu Lukaku":"Ромелу Лукаку",
  "Olivier Giroud":"Оливье Жиру","Raphael Varane":"Рафаэль Варан","Sergio Ramos":"Серхио Рамос",
  "Memphis Depay":"Мемфис Депай",
};
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
      supa("ffc_players?select=*&order=name.asc&limit=5000", { token }),
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


// ── ADMIN FORECAST TABLE ──
// Таблица по образцу Excel: групповой турнир / плей-офф / вопросы / результаты.
// В неё попадают только одобренные организатором участники, а результаты можно заносить прямо здесь.
// ══════════════════════════════════════════════════════════════════
// ПУБЛИЧНАЯ ТАБЛИЦА ПРОГНОЗОВ
// Показывается всем когда PREDICTIONS_LOCKED = true
// Матчи × участники, локальный симулятор счёта
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// БЛОК ПУБЛИЧНЫХ СОСТАВОВ — Битва клубов, 1-й тур
// Read-only, без email, только имя + позиции + капитан
// ══════════════════════════════════════════════════════════════════
function PublicLineupsBlock() {
  const [lineups, setLineups] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  // Fallback-словарь опций (те же данные что в ADMIN_FFC_FALLBACK_DRAFT_CSV)
  const FALLBACK_OPTIONS = React.useMemo(() => {
    const rows = [
      // coach
      ["coach","Тренер",1,"Lionel Scaloni","Аргентина"],
      ["coach","Тренер",2,"Didier Deschamps","Франция"],
      ["coach","Тренер",3,"Julian Nagelsmann","Германия"],
      ["coach","Тренер",4,"Luis de la Fuente","Испания"],
      ["coach","Тренер",5,"Marcelo Bielsa","Уругвай"],
      // goalkeeper
      ["goalkeeper","Вратарь",1,"Guillermo Ochoa","Мексика"],
      ["goalkeeper","Вратарь",2,"Ronwen Williams","ЮАР"],
      ["goalkeeper","Вратарь",3,"Mat Ryan","Австралия"],
      ["goalkeeper","Вратарь",4,"Gregor Kobel","Швейцария"],
      ["goalkeeper","Вратарь",5,"Emiliano Martinez","Аргентина"],
      // defender1
      ["defender1","Защитник 1",1,"Achraf Hakimi","Марокко"],
      ["defender1","Защитник 1",2,"Virgil van Dijk","Нидерланды"],
      ["defender1","Защитник 1",3,"Kalidou Koulibaly","Сенегал"],
      ["defender1","Защитник 1",4,"Josko Gvardiol","Хорватия"],
      ["defender1","Защитник 1",5,"Wilfried Singo","Кот-д'Ивуар"],
      // defender2
      ["defender2","Защитник 2",1,"Kim Min-jae","Республика Корея"],
      ["defender2","Защитник 2",2,"Marquinhos","Бразилия"],
      ["defender2","Защитник 2",3,"John Stones","Англия"],
      ["defender2","Защитник 2",4,"Alphonso Davies","Канада"],
      ["defender2","Защитник 2",5,"Nuno Mendes","Португалия"],
      // defender3
      ["defender3","Защитник из андердогов",1,"Liberato Cacace","Новая Зеландия"],
      ["defender3","Защитник из андердогов",2,"Stopira","Кабо-Верде"],
      ["defender3","Защитник из андердогов",3,"Michael Amir Murillo","Панама"],
      ["defender3","Защитник из андердогов",4,"Abdukodir Khusanov","Узбекистан"],
      ["defender3","Защитник из андердогов",5,"Jurien Gaari","Кюрасао"],
      // defender4
      ["defender4","Защитник 4",1,"Sead Kolasinac","Босния и Герцеговина"],
      ["defender4","Защитник 4",2,"Lucas Mendes","Катар"],
      ["defender4","Защитник 4",3,"Chris Richards","США"],
      ["defender4","Защитник 4",4,"Andy Robertson","Шотландия"],
      ["defender4","Защитник 4",5,"Antonee Robinson","США"],
      // midfielder1
      ["midfielder1","Полузащитник 1",1,"Jude Bellingham","Англия"],
      ["midfielder1","Полузащитник 1",2,"Pedri","Испания"],
      ["midfielder1","Полузащитник 1",3,"Federico Valverde","Уругвай"],
      ["midfielder1","Полузащитник 1",4,"Kevin De Bruyne","Бельгия"],
      ["midfielder1","Полузащитник 1",5,"Jamal Musiala","Германия"],
      // midfielder2
      ["midfielder2","Полузащитник 2",1,"Granit Xhaka","Швейцария"],
      ["midfielder2","Полузащитник 2",2,"Hakan Calhanoglu","Турция"],
      ["midfielder2","Полузащитник 2",3,"Moises Caicedo","Эквадор"],
      ["midfielder2","Полузащитник 2",4,"Takefusa Kubo","Япония"],
      ["midfielder2","Полузащитник 2",5,"Mohammed Kudus","Гана"],
      // midfielder3
      ["midfielder3","Полузащитник из андердогов",1,"Zidane Iqbal","Ирак"],
      ["midfielder3","Полузащитник из андердогов",2,"Noor Al-Rawabdeh","Иордания"],
      ["midfielder3","Полузащитник из андердогов",3,"Jean-Ricner Bellegarde","Гаити"],
      ["midfielder3","Полузащитник из андердогов",4,"Aissa Laidouni","Тунис"],
      ["midfielder3","Полузащитник из андердогов",5,"Jackson Irvine","Австралия"],
      // midfielder4
      ["midfielder4","Полузащитник 4",1,"Miguel Almiron","Парагвай"],
      ["midfielder4","Полузащитник 4",2,"Ismael Bennacer","Алжир"],
      ["midfielder4","Полузащитник 4",3,"Marcel Sabitzer","Австрия"],
      ["midfielder4","Полузащитник 4",4,"Richard Rios","Колумбия"],
      ["midfielder4","Полузащитник 4",5,"Salem Al-Dawsari","Саудовская Аравия"],
      // forward1
      ["forward1","Нападающий 1",1,"Kylian Mbappe","Франция"],
      ["forward1","Нападающий 1",2,"Эрлинг Холанд","Норвегия"],
      ["forward1","Нападающий 1",3,"Lionel Messi","Аргентина"],
      ["forward1","Нападающий 1",4,"Vinicius Jr","Бразилия"],
      ["forward1","Нападающий 1",5,"Cristiano Ronaldo","Португалия"],
      // forward2
      ["forward2","Нападающий 2",1,"Mohamed Salah","Египет"],
      ["forward2","Нападающий 2",2,"Alexander Isak","Швеция"],
      ["forward2","Нападающий 2",3,"Mehdi Taremi","Иран"],
      ["forward2","Нападающий 2",4,"Yoane Wissa","ДР Конго"],
      ["forward2","Нападающий 2",5,"Patrik Schick","Чехия"],
    ];
    // uuid по той же схеме: slotOrder*100 + optionNo
    const slotOrderMap = { coach:1, goalkeeper:2, defender1:3, defender2:4, defender3:5, defender4:6, midfielder1:7, midfielder2:8, midfielder3:9, midfielder4:10, forward1:11, forward2:12 };
    const map = {}; // optionId → {slot_key, slot_label, player_name, national_team}
    rows.forEach(([slotKey, slotLabel, optionNo, playerName, natTeam]) => {
      const slotOrder = slotOrderMap[slotKey] || 99;
      const tail = String(slotOrder * 100 + optionNo).padStart(12, "0");
      const id = `00000000-0000-4000-8000-${tail}`;
      map[id] = { slot_key: slotKey, slot_label: slotLabel, player_name: playerName, national_team: natTeam };
    });
    return map;
  }, []);

  // Порядок слотов для отображения
  const SLOT_ORDER = ["coach","goalkeeper","defender1","defender2","defender3","defender4","midfielder1","midfielder2","midfielder3","midfielder4","forward1","forward2"];
  const SLOT_LABELS = { coach:"Тренер", goalkeeper:"Вратарь", defender1:"Защитник 1", defender2:"Защитник 2", defender3:"Защитник из андердогов", defender4:"Защитник 4", midfielder1:"Полузащитник 1", midfielder2:"Полузащитник 2", midfielder3:"Полузащитник из андердогов", midfielder4:"Полузащитник 4", forward1:"Нападающий 1", forward2:"Нападающий 2" };

  React.useEffect(() => { loadLineups(); }, []);

  async function loadLineups() {
    setLoading(true);
    try {
      const PAGE = 1000;
      async function fetchAnon(path) {
        const rows = [];
        for (let page = 0; page < 20; page++) {
          const sep = path.includes("?") ? "&" : "?";
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${page * PAGE}`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          if (!r.ok) break;
          const chunk = await r.json().catch(() => []);
          const arr = Array.isArray(chunk) ? chunk : [];
          rows.push(...arr);
          if (arr.length < PAGE) break;
        }
        return rows;
      }

      // Получаем 1-й тур: минимальный sort_order или round_no, иначе самый ранний created_at
      let roundFilter = "";
      try {
        const roundsResp = await fetch(
          `${SUPABASE_URL}/rest/v1/ffc_rounds?select=id,round_no,sort_order,created_at&order=sort_order.asc.nullslast,round_no.asc.nullslast,created_at.asc&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        if (roundsResp.ok) {
          const rounds = await roundsResp.json().catch(() => []);
          if (Array.isArray(rounds) && rounds[0]?.id) {
            roundFilter = `round_id=eq.${rounds[0].id}&`;
          }
        }
      } catch {}
      // roundFilter = "" означает fallback: грузим все lineups без фильтра

      const lineupPath = `ffc_lineups?${roundFilter}select=id,user_id,lineup_status,submitted_at,draft_answers,captain_option_id,coach_id,goalkeeper_id,defender_id,defender2_id,midfielder_id,midfielder2_id,forward_id,forward2_id,bench_player_id,captain_player_id&order=submitted_at.desc.nullslast,created_at.desc`;

      const [lineupRows, profileRows, draftOptionRows, ffc_player_rows] = await Promise.all([
        fetchAnon(lineupPath),
        fetchAnon("profiles?select=id,name,display_name&order=name.asc"),
        fetchAnon("ffc_round_draft_options?select=id,slot_key,player_name,national_team&limit=5000").catch(() => []),
        fetchAnon("ffc_players?select=id,name,national_team,position&limit=5000").catch(() => []),
      ]);

      // maps для расшифровки
      const profileMap = {};
      profileRows.forEach(p => { if (p.id) profileMap[p.id] = p; if (p.user_id) profileMap[p.user_id] = p; });

      const draftOptMap = {}; // id → {slot_key, player_name, national_team}
      draftOptionRows.forEach(o => { if (o.id) draftOptMap[o.id] = o; });

      const ffc_player_map = {}; // id → {name, national_team, position}
      ffc_player_rows.forEach(p => { if (p.id) ffc_player_map[p.id] = p; });

      // Дедупликация по user_id: берём лучший состав (submitted > draft, не пустой)
      const byUser = {};
      lineupRows.forEach(l => {
        if (!l.user_id) return;
        const hasDraft = l.draft_answers && JSON.stringify(l.draft_answers) !== "{}" && l.draft_answers !== null;
        const hasClassic = !!(l.coach_id || l.goalkeeper_id);
        if (!hasDraft && !hasClassic) return; // пустой — пропускаем
        const existing = byUser[l.user_id];
        if (!existing) { byUser[l.user_id] = { ...l, _hasDraft: hasDraft }; return; }
        const existingSubmitted = existing.lineup_status === "submitted" || existing.submitted_at;
        const thisSubmitted = l.lineup_status === "submitted" || l.submitted_at;
        if (!existingSubmitted && thisSubmitted) byUser[l.user_id] = { ...l, _hasDraft: hasDraft };
      });

      // Расшифровка игрока по id (опция → ffc_players → fallback)
      function resolvePlayer(optionId) {
        if (!optionId) return null;
        const sid = String(optionId);
        if (draftOptMap[sid]) return { name: draftOptMap[sid].player_name, team: draftOptMap[sid].national_team, slot_key: draftOptMap[sid].slot_key };
        if (FALLBACK_OPTIONS[sid]) return { name: FALLBACK_OPTIONS[sid].player_name, team: FALLBACK_OPTIONS[sid].national_team, slot_key: FALLBACK_OPTIONS[sid].slot_key };
        if (ffc_player_map[sid]) return { name: ffc_player_map[sid].name, team: ffc_player_map[sid].national_team, slot_key: null };
        return { name: `[${sid.slice(0, 8)}…]`, team: "?", slot_key: null };
      }

      // Строим карточки
      const cards = Object.values(byUser).map(l => {
        const profile = profileMap[l.user_id] || {};
        const name = profile.display_name || profile.name || String(l.user_id).slice(0, 8);
        const isSubmitted = l.lineup_status === "submitted" || !!l.submitted_at;

        // Пробуем draft_answers (новый формат)
        let slots = []; // [{slot_key, slot_label, player_name, national_team, isCaptain}]
        let captainName = null;
        try {
          const raw = typeof l.draft_answers === "string" ? JSON.parse(l.draft_answers) : l.draft_answers;
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            // Формат: {slot_key: optionId} или {slot_key: {option_id, ...}}
            const slotEntries = Object.entries(raw);
            if (slotEntries.length > 0) {
              SLOT_ORDER.forEach(slotKey => {
                const val = raw[slotKey];
                if (!val) return;
                const optionId = typeof val === "object" ? (val.option_id || val.id || val.optionId) : String(val);
                const resolved = resolvePlayer(optionId);
                const label = SLOT_LABELS[slotKey] || slotKey;
                const isCaptain = optionId && optionId === l.captain_option_id;
                slots.push({ slot_key: slotKey, label, player_name: resolved?.name || optionId, national_team: resolved?.team || "", isCaptain });
                if (isCaptain) captainName = resolved?.name || optionId;
              });
            }
          }
        } catch {}

        // Fallback: classic format (coach_id, goalkeeper_id, ...)
        if (slots.length === 0) {
          const CLASSIC_ROLES = [
            ["coach_id", "coach", "Тренер"],
            ["goalkeeper_id", "goalkeeper", "Вратарь"],
            ["defender_id", "defender1", "Защитник 1"],
            ["defender2_id", "defender2", "Защитник 2"],
            ["midfielder_id", "midfielder1", "Полузащитник 1"],
            ["midfielder2_id", "midfielder2", "Полузащитник 2"],
            ["forward_id", "forward1", "Нападающий 1"],
            ["forward2_id", "forward2", "Нападающий 2"],
            ["bench_player_id", "bench", "Запасной"],
          ];
          CLASSIC_ROLES.forEach(([field, slotKey, label]) => {
            const pid = l[field];
            if (!pid) return;
            const resolved = resolvePlayer(pid) || ffc_player_map[pid] || { name: `[${String(pid).slice(0,8)}]`, team: "" };
            const isCaptain = pid === l.captain_player_id;
            slots.push({ slot_key: slotKey, label, player_name: resolved.name, national_team: resolved.national_team || resolved.team || "", isCaptain });
            if (isCaptain) captainName = resolved.name;
          });
        }

        return { user_id: l.user_id, name, isSubmitted, slots, captainName, submittedAt: l.submitted_at };
      }).filter(c => c.slots.length > 0);

      // Сортировка: сначала submitted
      cards.sort((a, b) => (b.isSubmitted ? 1 : 0) - (a.isSubmitted ? 1 : 0) || a.name.localeCompare(b.name));
      setLineups(cards);
    } catch (e) {
      console.error("PublicLineupsBlock error", e);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ padding: "20px", color: "rgba(240,237,230,.4)", fontSize: 13, textAlign: "center" }}>Загружаю составы…</div>;
  if (lineups.length === 0) {
    return (
      <div style={{ padding: 18, border: "1px solid rgba(245,158,11,.25)", borderRadius: 10, background: "rgba(245,158,11,.06)", color: "#FDE68A", fontSize: 13 }}>
        Составы пока не найдены или недоступны для публичного просмотра.
      </div>
    );
  }

  const orderedSlots = (slots = []) => {
    const rank = Object.fromEntries(SLOT_ORDER.map((k, i) => [k, i]));
    return [...slots].sort((a, b) => (rank[a.slot_key] ?? 99) - (rank[b.slot_key] ?? 99));
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 800, color: "#FDE68A", marginBottom: 12, textTransform: "uppercase" }}>
        📋 Все составы — 1-й тур ({lineups.length})
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(520px, 1fr))", gap: 14 }}>
        {lineups.map((card, idx) => (
          <div key={card.user_id || idx} style={{ background: "rgba(255,255,255,.03)", border: `1px solid ${card.isSubmitted ? "rgba(22,163,74,.32)" : "rgba(245,158,11,.22)"}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", background: "rgba(0,0,0,.18)", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
              <div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 800, color: "#F0EDE6" }}>
                  {idx + 1}. {card.name}
                </div>
                {card.captainName && (
                  <div style={{ fontSize: 11, color: "#FDE68A", marginTop: 2 }}>★ Капитан: {card.captainName}</div>
                )}
              </div>
              <span style={{ fontSize: 10, color: card.isSubmitted ? "#86EFAC" : "#FDE68A", background: card.isSubmitted ? "rgba(22,163,74,.15)" : "rgba(245,158,11,.12)", border: `1px solid ${card.isSubmitted ? "rgba(22,163,74,.3)" : "rgba(245,158,11,.25)"}`, borderRadius: 4, padding: "3px 8px", whiteSpace: "nowrap" }}>
                {card.isSubmitted ? "✓ отправлен" : "черновик"}
              </span>
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 500 }}>
                <thead>
                  <tr style={{ background: "rgba(22,163,74,.08)" }}>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 10, color: "rgba(240,237,230,.45)", textTransform: "uppercase", width: 135 }}>Позиция</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 10, color: "rgba(240,237,230,.45)", textTransform: "uppercase" }}>Игрок / тренер</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontSize: 10, color: "rgba(240,237,230,.45)", textTransform: "uppercase", width: 120 }}>Сборная</th>
                    <th style={{ textAlign: "center", padding: "8px 10px", fontSize: 10, color: "rgba(240,237,230,.45)", textTransform: "uppercase", width: 64 }}>Очки</th>
                  </tr>
                </thead>
                <tbody>
                  {orderedSlots(card.slots).map((slot, i) => (
                    <tr key={`${card.user_id || idx}-${slot.slot_key || i}`} style={{ borderTop: "1px solid rgba(255,255,255,.05)" }}>
                      <td style={{ padding: "7px 10px", fontSize: 11, color: "rgba(240,237,230,.48)", whiteSpace: "nowrap" }}>{slot.label}</td>
                      <td style={{ padding: "7px 10px", fontSize: 13, color: slot.isCaptain ? "#FDE68A" : "#F0EDE6", fontWeight: slot.isCaptain ? 800 : 600 }}>
                        {slot.isCaptain ? "★ " : ""}{slot.player_name}
                      </td>
                      <td style={{ padding: "7px 10px", fontSize: 11, color: "rgba(240,237,230,.56)" }}>{slot.national_team || "—"}</td>
                      <td style={{ padding: "7px 10px", textAlign: "center" }}>
                        <span style={{ display: "inline-block", minWidth: 34, padding: "2px 6px", borderRadius: 5, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "#F59E0B", fontFamily: "Oswald,sans-serif", fontWeight: 800 }}>
                          —
                        </span>
                      </td>
                    </tr>
                  ))}
                  {orderedSlots(card.slots).length < 12 && Array.from({ length: 12 - orderedSlots(card.slots).length }).map((_, i) => (
                    <tr key={`empty-${card.user_id || idx}-${i}`} style={{ borderTop: "1px solid rgba(255,255,255,.04)", opacity: .45 }}>
                      <td style={{ padding: "7px 10px", fontSize: 11, color: "rgba(240,237,230,.35)" }}>—</td>
                      <td style={{ padding: "7px 10px", fontSize: 13, color: "rgba(240,237,230,.35)" }}>не выбрано</td>
                      <td style={{ padding: "7px 10px", fontSize: 11, color: "rgba(240,237,230,.35)" }}>—</td>
                      <td style={{ padding: "7px 10px", textAlign: "center", color: "rgba(240,237,230,.35)" }}>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicForecastTable({ showToast, onLeaderboardReady }) {
  const [loading, setLoading] = React.useState(true);
  const [participants, setParticipants] = React.useState([]);
  const [predByUser, setPredByUser] = React.useState({});
  const [bonusByUser, setBonusByUser] = React.useState({});
  const [officialResultsMap, setOfficialResultsMap] = React.useState({});
  const [bonusOfficialMap, setBonusOfficialMap] = React.useState({});
  const [simScores, setSimScores] = React.useState({}); // локальный симулятор { mid: {h,a} }
  const [tableSection, setTableSection] = React.useState("groups"); // groups | playoff | questions | leaderboard
  const [debugInfo, setDebugInfo] = React.useState(null);

  const allGroupMatches = React.useMemo(() => ALL_GROUPS.flatMap(g => GROUP_MATCHES[g].map(m => ({ ...m, stage: `Группа ${g}` }))), []);
  const allPlayoffMatches = React.useMemo(() => {
    const rows = [
      ...R16.map(m => ({ ...m, stage: "1/16" })),
      ...R8.map(m => ({ ...m, stage: "1/8" })),
      ...QF.map(m => ({ ...m, stage: "1/4" })),
      ...SF.map(m => ({ ...m, stage: "1/2" })),
      { ...THIRD_MATCH, stage: "За 3-е место" },
      { ...FINAL_MATCH, stage: "Финал" },
    ];
    return rows.some(m => m.id === "m104") ? rows : [...rows, { ...FINAL_MATCH, stage: "Финал" }];
  }, []);

  // ── нормализация match_id ──
  const matchIdAliasMap = React.useMemo(() => {
    const map = {};
    ALL_GROUPS.forEach(g => {
      (GROUP_MATCHES[g] || []).forEach((m, idx) => {
        const aliases = [m.id, String(m.match_no), `№${m.match_no}`, `${g}${idx+1}`, `${g}-${idx+1}`];
        aliases.forEach(a => { if (a) map[String(a).toLowerCase()] = m.id; });
      });
    });
    [R16, R8, QF, SF, [THIRD_MATCH, FINAL_MATCH]].flat().forEach((m, idx) => {
      const n = String(m.id || "").replace(/^m/i, "");
      [m.id, n, `№${n}`, m.label, `po${idx+1}`].forEach(a => { if (a) map[String(a).toLowerCase()] = m.id; });
    });
    return map;
  }, []);
  function normMid(raw) {
    if (!raw && raw !== 0) return "";
    const lower = String(raw).trim().toLowerCase();
    if (matchIdAliasMap[lower]) return matchIdAliasMap[lower];
    const n = lower.match(/^(?:m|match[_\s-]?)?(\d{1,3})$/);
    if (n) return matchIdAliasMap[n[1]] || `m${n[1]}`;
    return String(raw).trim();
  }
  function isPlayoffMid(mid) { return !ALL_GROUP_MATCH_IDS.has(normMid(mid)); }

  // ── Загрузка данных без токена (публичная) ──
  React.useEffect(() => { loadPublicData(); }, []);

  async function loadPublicData() {
    setLoading(true);
    try {
      const PAGE = 1000;
      async function fetchAllAnon(path) {
        const rows = [];
        for (let page = 0; page < 50; page++) {
          const sep = path.includes("?") ? "&" : "?";
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${page * PAGE}`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          if (!r.ok) {
            const errText = await r.text().catch(() => "");
            throw Object.assign(new Error(`${r.status} ${errText.slice(0, 120)}`), { status: r.status, path });
          }
          const chunk = await r.json().catch(() => []);
          const arr = Array.isArray(chunk) ? chunk : [];
          rows.push(...arr);
          if (arr.length < PAGE) break;
        }
        return rows;
      }

      // profiles грузим отдельно — ловим ошибку RLS, не роняем весь запрос
      async function fetchProfilesSafe() {
        try {
          // email не запрашиваем публично
          return { rows: await fetchAllAnon("profiles?select=id,name,display_name&order=name.asc"), error: null };
        } catch (e) {
          return { rows: [], error: e?.message || String(e) };
        }
      }

      // predictions: сначала пробуем забрать также команды плей-офф, если эти поля есть.
      // Если в базе нет home_team/away_team, откатываемся к старому select и пары ниже считаем из сетки участника.
      async function fetchPredictionsSafe() {
        try {
          return await fetchAllAnon("predictions?select=user_id,match_id,home_score,away_score,predicted_winner,home_team,away_team");
        } catch (e) {
          return await fetchAllAnon("predictions?select=user_id,match_id,home_score,away_score,predicted_winner");
        }
      }

      // official_results грузим отдельно — перехватываем ошибку RLS
      const officialEndpoint = `${SUPABASE_URL}/rest/v1/official_results?select=match_id,home_score,away_score,penalty_winner,status`;
      async function fetchOfficialSafe() {
        try {
          const r = await fetch(`${officialEndpoint}&limit=1000`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          if (!r.ok) {
            const errText = await r.text().catch(() => "");
            return { rows: [], error: `HTTP ${r.status}: ${errText.slice(0, 150)}`, status: r.status, url: officialEndpoint };
          }
          const data = await r.json().catch(() => []);
          const rows = Array.isArray(data) ? data : [];
          return { rows, error: null, status: 200, url: officialEndpoint };
        } catch (e) {
          return { rows: [], error: e?.message || String(e), status: null, url: officialEndpoint };
        }
      }

      const [profilesResult, predRows, bonusRows, officialResult, bonusOfficialRows] = await Promise.all([
        fetchProfilesSafe(),
        fetchPredictionsSafe(),
        fetchAllAnon("bonus_answers?select=user_id,question_id,answer"),
        fetchOfficialSafe(),
        fetchAllAnon("bonus_official_answers?select=question_id,answer,points").catch(() => []),
      ]);

      const officialRows = officialResult.rows;
      const officialError = officialResult.error;
      const officialUrl = officialResult.url;
      const officialStatus = officialResult.status;

      const profileRows = profilesResult.rows;
      const profileError = profilesResult.error;

      const profById = {};
      // profiles.id == predictions.user_id — это один и тот же auth UUID
      profileRows.forEach(p => { if (p.id) profById[p.id] = p; });

      // прогнозы по user_id → match_id → {h,a,pen}
      const pbu = {};
      predRows.forEach(r => {
        if (!r.user_id || r.match_id === undefined || r.match_id === null) return;
        const mid = normMid(r.match_id);
        if (!pbu[r.user_id]) pbu[r.user_id] = {};
        pbu[r.user_id][mid] = { h: r.home_score, a: r.away_score, pen: r.predicted_winner, ph: r.home_team, pa: r.away_team };
      });
      setPredByUser(pbu);

      // бонусы
      const bbu = {};
      bonusRows.forEach(r => {
        if (!r.user_id || !r.question_id) return;
        if (!bbu[r.user_id]) bbu[r.user_id] = {};
        let ans = r.answer;
        try { if (typeof ans === "string") ans = JSON.parse(ans); } catch {}
        bbu[r.user_id][String(r.question_id)] = ans;
      });
      setBonusByUser(bbu);

      // официальные результаты
      const orm = {};
      officialRows.forEach(r => {
        if (!r.match_id) return;
        const mid = normMid(r.match_id);
        const h = r.home_score ?? r.h ?? null;
        const a = r.away_score ?? r.a ?? null;
        if (h === null || a === null) return;
        orm[mid] = { h, a, pen: r.penalty_winner || r.pen || null, status: r.status };
      });
      setOfficialResultsMap(orm);

      // официальные ответы на бонусы
      const bom = {};
      bonusOfficialRows.forEach(r => { if (r.question_id) bom[String(r.question_id)] = r; });
      setBonusOfficialMap(bom);

      // ── СТРОИМ СПИСОК УЧАСТНИКОВ ──
      const allGroupMatchIdsLocal = new Set(
        ALL_GROUPS.flatMap(g => (GROUP_MATCHES[g] || []).map(m => String(m.id)))
      );
      const predCountByUser = {};
      Object.entries(pbu).forEach(([uid, matchMap]) => {
        let group = 0, playoff = 0;
        Object.keys(matchMap).forEach(rawMid => {
          const p = matchMap[rawMid];
          if (!p || p.h === null || p.h === undefined || p.a === null || p.a === undefined) return;
          if (allGroupMatchIdsLocal.has(normMid(rawMid))) group++; else playoff++;
        });
        predCountByUser[uid] = { group, playoff, total: group + playoff };
      });
      const bonusCountByUser = {};
      Object.entries(bbu).forEach(([uid, qMap]) => { bonusCountByUser[uid] = Object.keys(qMap).length; });

      const getCountsForProfile = (p) => {
        // profiles.id == predictions.user_id (оба — auth UUID)
        const uid = String(p.id || "");
        const pc = predCountByUser[uid];
        return {
          group: pc?.group || 0,
          playoff: pc?.playoff || 0,
          bonus: bonusCountByUser[uid] || 0,
        };
      };

      // Если profiles не загрузились (RLS) — строим синтетические профили из prediction user_id
      let workingProfiles = profileRows;
      if (profileRows.length === 0 && Object.keys(pbu).length > 0) {
        workingProfiles = Object.keys(pbu).map(uid => ({
          id: uid,
          user_id: uid,
          name: null,
          display_name: null,
          _synthetic: true,
        }));
      }

      // Фильтр полных участников (72г + 32по + 31б)
      const fullParticipants = workingProfiles.filter(p => {
        const { group, playoff, bonus } = getCountsForProfile(p);
        return group >= 72 && playoff >= 32 && bonus >= 31;
      });

      // Fallback: все у кого есть хоть один прогноз
      const hasPreds = workingProfiles.filter(p => {
        const uid = String(p.id || "");
        return Object.keys(pbu[uid] || {}).length > 0;
      });

      const parts = fullParticipants.length > 0 ? fullParticipants : hasPreds;

      setDebugInfo({
        profiles: profileRows.length,
        profileError,
        synthProfiles: workingProfiles.filter(p => p._synthetic).length,
        predsRows: predRows.length,
        bonusRows: bonusRows.length,
        officialRows: officialRows.length,
        officialError,
        officialUrl,
        officialStatus,
        officialSample: officialRows.slice(0, 3).map(r => `${r.match_id}:${r.home_score}-${r.away_score}`),
        predByUserKeys: Object.keys(pbu).length,
        fullParticipants: fullParticipants.length,
        hasPreds: hasPreds.length,
        usingFallback: fullParticipants.length === 0,
        usingSync: profileRows.length === 0 && Object.keys(pbu).length > 0,
        sampleCounts: workingProfiles.slice(0, 3).map(p => ({ name: p.display_name || p.name || String(p.id || "").slice(0, 8), ...getCountsForProfile(p) })),
      });

      setParticipants(parts);
    } catch (e) {
      console.error("PublicForecastTable load error", e);
      if (showToast) showToast("Ошибка загрузки таблицы: " + (e?.message || ""));
    } finally {
      setLoading(false);
    }
  }

  // ── helpers ──
  function uName(u) {
    if (u.display_name) return u.display_name;
    if (u.name) return u.name;
    if (u._synthetic) return `Участник ${String(u.id || "").slice(0, 6)}`;
    return String(u.id || "").slice(0, 8);
  }
  function predScore(u, mid) {
    const nm = normMid(mid);
    // u.id == auth UUID == predictions.user_id
    const uid = String(u.id || "");
    const val = predByUser?.[uid]?.[nm];
    if (val !== undefined && val !== null) return val;
    // fallback: если синтетический профиль, id уже равен predictions.user_id
    return null;
  }
  function officialScore(mid) {
    const r = officialResultsMap[normMid(mid)];
    if (!r) return null;
    if (r.h === null || r.h === undefined || r.a === null || r.a === undefined) return null;
    return r;
  }

  function matchPoints(u, mid) {
    const p = predScore(u, mid);
    const off = officialScore(mid);
    const sim = simScores[normMid(mid)];
    // Официальный результат приоритетен; симулятор — если оба числа введены
    const result = (off !== null) ? off
                 : (sim?.h !== "" && sim?.h !== undefined && sim?.a !== "" && sim?.a !== undefined && sim.h !== null && sim.a !== null)
                   ? { h: Number(sim.h), a: Number(sim.a) }
                 : null;
    if (!p || result === null) return null;
    if (p.h === undefined || p.h === null || p.a === undefined || p.a === null) return null;
    return calculateMatchPredictionPoints(p.h, p.a, result.h, result.a) ?? null;
  }

  function teamNameForPublicTable(info) {
    return info?.team || "—";
  }

  function scoreMapsForPublicParticipant(u) {
    const uid = String(u?.id || "");
    const rows = predByUser?.[uid] || {};
    const groupScores = {};
    const playoffScores = {};
    const playoffPens = {};

    Object.entries(rows).forEach(([rawMid, val]) => {
      const mid = normMid(rawMid);
      if (!mid || !val) return;
      const row = { h: val.h, a: val.a };
      if (ALL_GROUP_MATCH_IDS.has(mid)) {
        groupScores[mid] = row;
      } else {
        playoffScores[mid] = row;
        if (val.pen) playoffPens[mid] = String(val.pen);
      }
    });

    return { groupScores, playoffScores, playoffPens };
  }

  function publicPlayoffTeamsForUser(u, matchId) {
    const { groupScores, playoffScores, playoffPens } = scoreMapsForPublicParticipant(u);
    const tables = {};
    ALL_GROUPS.forEach(g => { tables[g] = calcGroupTable(g, groupScores || {}, {}); });
    const thirds = getThirdRanking(tables, {});
    const bracketList = allPlayoffMatches;

    function resolveFromBracket(bracket, side) {
      if (!bracket) return { team: "?", tbd: true };
      const winner = getWinner(bracket.id, playoffScores || {}, playoffPens || {});
      if (!winner) return { team: `Поб.${bracket.label || bracket.id}`, tbd: true };
      const teams = resolveBracketTeams(bracket);
      if (side === "loser") return winner === "home" ? teams.away : teams.home;
      return winner === "home" ? teams.home : teams.away;
    }

    function resolveBracketTeams(bracket) {
      if (!bracket) return { home: { team: "?", tbd: true }, away: { team: "?", tbd: true } };

      // 1/16: слоты вроде 2A, 3ABCDF и т.п. считаются по групповой таблице именно этого участника
      if (bracket.home_key) {
        return {
          home: resolveKey(bracket.home_key, tables, thirds, bracket.id),
          away: resolveKey(bracket.away_key, tables, thirds, bracket.id),
        };
      }

      // 1/8 и дальше: берём победителей предыдущих матчей из сетки именно этого участника
      const homeFrom = String(bracket.home_from || "");
      const awayFrom = String(bracket.away_from || "");
      const hId = homeFrom.replace("_loser", "");
      const aId = awayFrom.replace("_loser", "");

      return {
        home: resolveFromBracket(bracketList.find(b => normMid(b.id) === normMid(hId)), homeFrom.includes("_loser") ? "loser" : "win"),
        away: resolveFromBracket(bracketList.find(b => normMid(b.id) === normMid(aId)), awayFrom.includes("_loser") ? "loser" : "win"),
      };
    }

    return resolveBracketTeams(bracketList.find(b => normMid(b.id) === normMid(matchId)));
  }

  function formatPublicPlayoffPair(u, mid, p, m) {
    // Если пары сохранены прямо в predictions — используем их.
    if (p?.ph && p?.pa) return `${p.ph} — ${p.pa}`;

    const teams = publicPlayoffTeamsForUser(u, mid);
    const home = teamNameForPublicTable(teams?.home);
    const away = teamNameForPublicTable(teams?.away);

    if (home !== "—" || away !== "—") return `${home} — ${away}`;

    return `${m?.home_key || m?.home_from || m?.home || "?"} — ${m?.away_key || m?.away_from || m?.away || "?"}`;
  }

  function userTotals(u) {
    let group = 0, playoff = 0, bonus = 0, exact = 0, outcome = 0;
    [...allGroupMatches, ...allPlayoffMatches].forEach(m => {
      const pts = matchPoints(u, m.id);
      if (pts === null) return;
      if (ALL_GROUP_MATCH_IDS.has(normMid(m.id))) group += pts; else playoff += pts;
      if (pts >= 8) exact++;
      if (pts >= 2) outcome++;
    });
    BONUS_QS.forEach(q => {
      const uid = String(u.id || "");
      const ans = bonusByUser[uid]?.[String(q.id)];
      const bom = bonusOfficialMap[String(q.id)];
      if (ans === undefined || !bom?.answer) return;
      const ansStr = Array.isArray(ans) ? ans.map(String) : [String(ans)];
      const offStr = Array.isArray(bom.answer) ? bom.answer.map(String) : [String(bom.answer)];
      const match = ansStr.some(a => offStr.includes(a));
      if (match) bonus += Number(bom.points) || 0;
    });
    return { group, playoff, bonus, total: group + playoff + bonus, exact, outcome };
  }

  const leaderboard = React.useMemo(() => {
    if (loading || participants.length === 0) return [];
    const lb = participants.map(u => ({ u, ...userTotals(u) })).sort((a, b) => b.total - a.total || b.exact - a.exact);
    if (onLeaderboardReady) setTimeout(() => onLeaderboardReady(lb), 0);
    return lb;
  }, [loading, participants, officialResultsMap, simScores, bonusOfficialMap, predByUser, bonusByUser]);

  function simInput(mid, side, val) {
    const nm = normMid(mid);
    setSimScores(prev => ({ ...prev, [nm]: { ...(prev[nm] || {}), [side]: val === "" ? "" : Number(val) } }));
  }

  function renderScore(u, mid, slotPair) {
    const p = predScore(u, mid);
    if (!p || p.h === undefined || p.h === null || p.a === undefined || p.a === null) return <span style={{ color: "rgba(240,237,230,.2)" }}>—</span>;
    const pts = matchPoints(u, mid);
    const ptsColor = pts === null ? "rgba(240,237,230,.25)" : pts >= 8 ? "#86EFAC" : pts >= 5 ? "#FDE68A" : pts >= 2 ? "#F59E0B" : pts === 1 ? "rgba(240,237,230,.4)" : "rgba(252,165,165,.7)";
    const isPlayoff = isPlayoffMid(mid);
    const isDraw = Number(p.h) === Number(p.a);
    const penWinner = isPlayoff && isDraw && p.pen ? String(p.pen) : null;
    return (
      <div style={{ textAlign: "center", lineHeight: 1.2 }}>
        {slotPair && (
          <div style={{ fontSize: 10, color: "#86EFAC", marginBottom: 3, letterSpacing: 0.1, fontWeight: 700, whiteSpace: "normal", lineHeight: 1.15 }}>
            {slotPair}
          </div>
        )}
        <span style={{ color: "#F0EDE6", fontWeight: 800, fontSize: 13 }}>{p.h}:{p.a}</span>
        {penWinner && (
          <div style={{ fontSize: 9, color: "rgba(147,197,253,.7)", fontWeight: 600, marginTop: 1 }}>
            пен: {penWinner}
          </div>
        )}
        {pts !== null && <div style={{ fontSize: 10, color: ptsColor, fontWeight: 700 }}>{pts > 0 ? `+${pts}` : "0"}</div>}
      </div>
    );
  }

  function renderMatchTable(matches) {
    // Ширины sticky-колонок для расчёта left
    const stickyWidths = [80, 48, 110, 110, 80, 112]; // стадия, №, хозяева, гости, результат, симулятор
    const stickyLeft = stickyWidths.reduce((acc, w, i) => { acc.push(i === 0 ? 0 : acc[i-1] + stickyWidths[i-1]); return acc; }, []);
    const stickyTh = (i, extra = {}) => ({
      padding: "8px 6px", textAlign: "left", fontSize: 11, color: "rgba(240,237,230,.55)", fontWeight: 700,
      whiteSpace: "nowrap", position: "sticky", top: 0, left: stickyLeft[i], background: "#0A1F0A",
      zIndex: 3, boxShadow: i === 5 ? "2px 0 6px rgba(0,0,0,.4)" : "none", minWidth: stickyWidths[i],
      ...extra
    });
    const stickyTd = (i, fs = 12, color = "#F0EDE6", fw = 400) => ({
      padding: "4px 6px", fontSize: fs, color, fontWeight: fw, whiteSpace: "nowrap",
      verticalAlign: "middle", position: "sticky", left: stickyLeft[i],
      background: "#0A1F0A", zIndex: 1, boxShadow: i === 5 ? "2px 0 4px rgba(0,0,0,.3)" : "none",
    });

    return (
      <div style={{ overflowX: "auto", fontSize: 12, position: "relative" }}>
        <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: Math.max(760, 550 + participants.length * (matches.some(mm => isPlayoffMid(mm.id)) ? 150 : 100)) }}>
          <thead>
            <tr style={{ background: "#0A1F0A", borderBottom: "2px solid rgba(245,158,11,.25)" }}>
              <th style={stickyTh(0)}>Стадия</th>
              <th style={stickyTh(1)}>№</th>
              <th style={stickyTh(2)}>Хозяева</th>
              <th style={stickyTh(3)}>Гости</th>
              <th style={stickyTh(4, { color: "#86EFAC" })}>Счёт</th>
              <th style={stickyTh(5, { color: "#93C5FD", fontSize: 10 })}>Симулятор ✎</th>
              {participants.map(u => {
                // считаем итого по матчам этой секции для шапки
                const tot = matches.reduce((s, m) => {
                  const pts = matchPoints(u, m.id);
                  return s + (pts !== null ? pts : 0);
                }, 0);
                const totalAll = [...allGroupMatches, ...allPlayoffMatches].reduce((s, m) => {
                  const pts = matchPoints(u, m.id);
                  return s + (pts !== null ? pts : 0);
                }, 0);
                return (
                  <th key={u.id} style={{ ...thS, minWidth: matches.some(mm => isPlayoffMid(mm.id)) ? 140 : 90, fontSize: 11, fontWeight: 700, color: "#FDE68A", textAlign: "center" }}>
                    <div>{uName(u)}</div>
                    <div style={{ fontSize: 13, fontFamily: "Oswald,sans-serif", color: "#F59E0B" }}>{totalAll}</div>
                    <div style={{ fontSize: 9, color: "rgba(240,237,230,.3)", fontWeight: 400 }}>раздел: {tot}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {matches.map((m, ri) => {
              const off = officialScore(m.id);
              const nm = normMid(m.id);
              const sim = simScores[nm] || {};
              const hasOfficial = off !== null && off.h !== null && off.h !== undefined && off.a !== null && off.a !== undefined;
              return (
                <tr key={m.id} style={{ background: ri % 2 === 0 ? "rgba(255,255,255,.015)" : "transparent", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                  <td style={stickyTd(0, 11, "#FDE68A")}>{m.stage}</td>
                  <td style={stickyTd(1, 11, "rgba(240,237,230,.4)")}>{m.match_no ? `№${m.match_no}` : m.label || m.id}</td>
                  <td style={stickyTd(2, 12, "#F0EDE6", 600)}>{m.home || m.home_key || "—"}</td>
                  <td style={stickyTd(3, 12, "#F0EDE6", 600)}>{m.away || m.away_key || "—"}</td>
                  <td style={{ ...stickyTd(4, 14, hasOfficial ? "#86EFAC" : "#FDE68A"), fontFamily: "Oswald,sans-serif", textAlign: "center", fontWeight: 700 }}>
                    {hasOfficial ? `${off.h}:${off.a}${off.pen ? ` (${off.pen})` : ""}` : "—"}
                  </td>
                  <td style={stickyTd(5, 12, "#93C5FD")}>
                    {hasOfficial
                      ? <span style={{ fontSize: 10, color: "rgba(240,237,230,.3)", fontStyle: "italic" }}>✓</span>
                      : <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                          <input type="number" min="0" max="20" value={sim.h ?? ""} onChange={e => simInput(m.id, "h", e.target.value)} style={simInputS} placeholder="—" />
                          <span style={{ color: "rgba(240,237,230,.4)", fontSize: 11 }}>:</span>
                          <input type="number" min="0" max="20" value={sim.a ?? ""} onChange={e => simInput(m.id, "a", e.target.value)} style={simInputS} placeholder="—" />
                        </div>
                    }
                  </td>
                  {participants.map(u => {
                    const isPlayoff = isPlayoffMid(m.id);
                    const p = predScore(u, m.id);
                    // Пара команд: берём из прогноза если есть, иначе слоты матча
                    let pairLabel = null;
                    if (isPlayoff && p) {
                      pairLabel = formatPublicPlayoffPair(u, m.id, p, m);
                    }
                    return (
                    <td key={u.id} style={{ padding: "4px 6px", textAlign: "center", verticalAlign: "middle" }}>
                      {renderScore(u, m.id, pairLabel)}
                    </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  // стили
  const thS = { padding: "8px 10px", textAlign: "left", fontSize: 11, color: "rgba(240,237,230,.55)", fontWeight: 700, whiteSpace: "nowrap", position: "sticky", top: 0, background: "#0A1F0A", zIndex: 2 };
  const tdS = (fs = 12, color = "#F0EDE6", fw = 400) => ({ padding: "4px 8px", fontSize: fs, color, fontWeight: fw, whiteSpace: "nowrap", verticalAlign: "middle" });
  const simInputS = { width: 32, height: 24, background: "rgba(147,197,253,.1)", border: "1px solid rgba(147,197,253,.3)", borderRadius: 4, color: "#93C5FD", textAlign: "center", fontSize: 12 };

  if (loading) return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(240,237,230,.4)" }}>
      <div style={{ fontSize: 28, marginBottom: 12 }}>⏳</div>
      <div>Загружаю прогнозы участников…</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "14px 12px 80px" }}>

      {/* ЗАГОЛОВОК */}
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 26, fontWeight: 700, color: "#FDE68A", letterSpacing: 1 }}>
          📊 Прогнозы участников
        </div>
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginTop: 4 }}>
          ЧМ 2026 · Битва прогнозистов · Дедлайн прошёл, прогнозы закрыты
        </div>
      </div>

      {/* ЛИДЕРБОРД */}
      <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 10, padding: "14px 16px", marginBottom: 18 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 10 }}>🏆 Рейтинг участников</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,.08)" }}>
                {["#", "Участник", "Группы", "Плей-офф", "Бонусы", "Итого", "Точных", "Исходов"].map(h => (
                  <th key={h} style={{ padding: "6px 10px", fontSize: 11, color: "rgba(240,237,230,.45)", fontWeight: 700, textAlign: h === "Участник" ? "left" : "center", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leaderboard.map(({ u, group, playoff, bonus, total, exact, outcome }, i) => (
                <tr key={u.id} style={{ borderBottom: "1px solid rgba(255,255,255,.04)", background: i === 0 ? "rgba(245,158,11,.06)" : i < 3 ? "rgba(255,255,255,.015)" : "transparent" }}>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 13, fontWeight: 800, color: i === 0 ? "#FDE68A" : i === 1 ? "#D1D5DB" : i === 2 ? "#F59E0B" : "rgba(240,237,230,.4)" }}>{i+1}</td>
                  <td style={{ padding: "6px 10px", fontSize: 13, fontWeight: 600, color: "#F0EDE6" }}>{uName(u)}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 13, color: "#86EFAC", fontWeight: 700 }}>{group}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 13, color: "#93C5FD", fontWeight: 700 }}>{playoff}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 13, color: "#FDE68A", fontWeight: 700 }}>{bonus}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 15, fontFamily: "Oswald,sans-serif", fontWeight: 800, color: i === 0 ? "#F59E0B" : "#F0EDE6" }}>{total}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 12, color: "rgba(134,239,172,.8)" }}>{exact}</td>
                  <td style={{ padding: "6px 10px", textAlign: "center", fontSize: 12, color: "rgba(240,237,230,.5)" }}>{outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* СИМУЛЯТОР ПОДСКАЗКА */}
      <div style={{ background: "rgba(147,197,253,.06)", border: "1px solid rgba(147,197,253,.2)", borderRadius: 8, padding: "9px 14px", marginBottom: 14, fontSize: 11, color: "rgba(147,197,253,.8)", display: "flex", alignItems: "center", gap: 8 }}>
        <span>✎</span>
        <span><strong>Симулятор:</strong> введи счёт матча в синих полях, чтобы посмотреть как пересчитаются очки. Данные не сохраняются — только в твоём браузере.</span>
        {Object.keys(simScores).length > 0 && (
          <button onClick={() => setSimScores({})} style={{ marginLeft: "auto", background: "rgba(147,197,253,.15)", border: "1px solid rgba(147,197,253,.3)", color: "#93C5FD", borderRadius: 4, padding: "3px 8px", fontSize: 10, cursor: "pointer" }}>
            Сбросить симулятор
          </button>
        )}
      </div>

      {/* ДИАГНОСТИКА — видна если участники не загрузились */}
      {debugInfo && participants.length === 0 && (
        <div style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.2)", borderRadius: 8, padding: "12px 16px", marginBottom: 14, fontSize: 11 }}>
          <div style={{ fontWeight: 700, color: "#FCA5A5", marginBottom: 6 }}>⚠ Участники не найдены. Диагностика:</div>
          <div style={{ color: "rgba(240,237,230,.6)", lineHeight: 1.8 }}>
            Профилей: {debugInfo.profiles} · Строк predictions: {debugInfo.predsRows} · Строк bonus_answers: {debugInfo.bonusRows}<br/>
            {debugInfo.profileError && <span style={{ color: "#FCA5A5" }}>⚠ Ошибка profiles: {debugInfo.profileError}<br/></span>}
            Уникальных user_id в predictions: {debugInfo.predByUserKeys}<br/>
            Полных участников (72г+32по+31б): {debugInfo.fullParticipants}<br/>
            Хоть с одним прогнозом: {debugInfo.hasPreds}<br/>
            {debugInfo.sampleCounts?.map((s, i) => <span key={i} style={{ marginRight: 12 }}>{s.name}: г{s.group}/пo{s.playoff}/б{s.bonus}</span>)}
          </div>
        </div>
      )}
      {/* Диагностика official_results — показываем если 0 строк или ошибка */}
      {debugInfo && (debugInfo.officialError || debugInfo.officialRows === 0) && (
        <div style={{ background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 8, padding: "10px 14px", marginBottom: 10, fontSize: 11 }}>
          <div style={{ color: "#FDE68A", fontWeight: 700, marginBottom: 4 }}>
            {debugInfo.officialError
              ? `⚠ official_results ошибка (HTTP ${debugInfo.officialStatus || "?"}): ${debugInfo.officialError}`
              : `ℹ official_results: 0 строк — счёт ещё не введён или RLS не разрешает SELECT anon`}
          </div>
          <div style={{ color: "rgba(240,237,230,.4)", fontSize: 10, marginBottom: 4, wordBreak: "break-all" }}>
            URL: {debugInfo.officialUrl}
          </div>
          {debugInfo.officialRows > 0 && (
            <div style={{ color: "rgba(240,237,230,.5)", marginBottom: 4 }}>
              Загружено {debugInfo.officialRows}: {debugInfo.officialSample?.join(", ")}
            </div>
          )}
          <details style={{ marginTop: 6 }}>
            <summary style={{ cursor: "pointer", color: "rgba(240,237,230,.45)", fontSize: 10 }}>
              SQL: разрешить чтение official_results публично (anon)
            </summary>
            <pre style={{ fontSize: 10, color: "rgba(240,237,230,.55)", background: "rgba(0,0,0,.3)", padding: 8, borderRadius: 4, marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.official_results TO anon, authenticated;
ALTER TABLE public.official_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "official_results_public_select" ON public.official_results;
CREATE POLICY "official_results_public_select"
  ON public.official_results
  FOR SELECT TO anon, authenticated
  USING (true);
DROP POLICY IF EXISTS "official_results_admin_write" ON public.official_results;
CREATE POLICY "official_results_admin_write"
  ON public.official_results
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);`}</pre>
          </details>
        </div>
      )}
      {/* Если официальные результаты есть — показываем сколько */}
      {debugInfo && debugInfo.officialRows > 0 && !debugInfo.officialError && participants.length > 0 && (
        <div style={{ background: "rgba(134,239,172,.05)", border: "1px solid rgba(134,239,172,.15)", borderRadius: 6, padding: "5px 12px", marginBottom: 8, fontSize: 10, color: "rgba(134,239,172,.7)" }}>
          ✓ Официальных результатов: {debugInfo.officialRows} · первые: {debugInfo.officialSample?.join(", ")}
        </div>
      )}
      {debugInfo && participants.length > 0 && debugInfo.usingFallback && (
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 6, padding: "6px 12px", marginBottom: 10, fontSize: 10, color: "rgba(245,158,11,.7)" }}>
          ℹ Показаны все участники с прогнозами (полный фильтр 72г+32по+31б не прошёл никто)
          {debugInfo.usingSync && <span> · профили из predictions (RLS блокирует profiles)</span>}
        </div>
      )}
      {debugInfo && participants.length > 0 && !debugInfo.usingFallback && debugInfo.usingSync && (
        <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 6, padding: "6px 12px", marginBottom: 10, fontSize: 10, color: "rgba(245,158,11,.7)" }}>
          ℹ Имена участников недоступны (RLS блокирует profiles) — отображаются ID. Добавь политику: SELECT на profiles для anon.
        </div>
      )}

      {/* СЕКЦИИ */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {[["groups", "Групповой этап"], ["playoff", "Плей-офф"], ["questions", "Бонусные вопросы"]].map(([k, l]) => (
          <button key={k} className={`tab${tableSection === k ? " on" : ""}`} style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setTableSection(k)}>{l}</button>
        ))}
        <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={loadPublicData}>↻ Обновить</button>
      </div>

      {/* ГРУППОВОЙ */}
      {tableSection === "groups" && renderMatchTable(allGroupMatches)}

      {/* ПЛЕЙ-ОФФ */}
      {tableSection === "playoff" && renderMatchTable(allPlayoffMatches)}

      {/* БОНУСНЫЕ ВОПРОСЫ */}
      {tableSection === "questions" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", minWidth: Math.max(600, 420 + participants.length * 120), width: "100%" }}>
            <thead>
              <tr style={{ background: "rgba(245,158,11,.08)", borderBottom: "2px solid rgba(245,158,11,.25)" }}>
                <th style={thS}>№</th>
                <th style={{ ...thS, minWidth: 260 }}>Вопрос</th>
                <th style={{ ...thS, color: "#86EFAC" }}>Официальный ответ</th>
                {participants.map(u => (
                  <th key={u.id} style={{ ...thS, minWidth: 110, fontSize: 11, fontWeight: 700, color: "#FDE68A", textAlign: "center" }}>{uName(u)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BONUS_QS.map((q, ri) => {
                const bom = bonusOfficialMap[String(q.id)];
                const offAns = bom?.answer;
                const offStr = offAns !== undefined && offAns !== null
                  ? (Array.isArray(offAns) ? offAns.join(", ") : String(offAns))
                  : "—";
                return (
                  <tr key={q.id} style={{ background: ri % 2 === 0 ? "rgba(255,255,255,.015)" : "transparent", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                    <td style={tdS(11, "rgba(240,237,230,.4)")}>{ri+1}</td>
                    <td style={{ ...tdS(12, "#F0EDE6"), maxWidth: 280, whiteSpace: "normal", lineHeight: 1.4 }}>{q.text}</td>
                    <td style={{ ...tdS(12, "#86EFAC"), textAlign: "center", fontWeight: 700 }}>{offStr}</td>
                    {participants.map(u => {
                      const ans = bonusByUser[String(u.id || "")]?.[String(q.id)];
                      if (ans === undefined || ans === null) return <td key={u.id} style={{ ...tdS(), textAlign: "center", color: "rgba(240,237,230,.2)" }}>—</td>;
                      const ansStr = Array.isArray(ans) ? ans.join(", ") : String(ans);
                      const correct = bom?.answer !== undefined
                        ? (Array.isArray(bom.answer) ? bom.answer.map(String) : [String(bom.answer)]).includes(String(ans))
                        : null;
                      return (
                        <td key={u.id} style={{ padding: "4px 6px", textAlign: "center" }}>
                          <span style={{ fontSize: 12, color: correct === true ? "#86EFAC" : correct === false ? "#FCA5A5" : "#F0EDE6", fontWeight: correct ? 700 : 400 }}>
                            {ansStr}
                          </span>
                          {correct !== null && (
                            <div style={{ fontSize: 10, color: correct ? "#86EFAC" : "#FCA5A5" }}>{correct ? `+${bom.points || q.pts}` : "0"}</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
function AdminForecastTable({ session, showToast }) {
  const [tableTab, setTableTab] = React.useState("groups");
  const [loading, setLoading] = React.useState(true);
  const [participants, setParticipants] = React.useState([]);
  const [predByUser, setPredByUser] = React.useState({});
  const [bonusByUser, setBonusByUser] = React.useState({});
  const [officialResultsMap, setOfficialResultsMap] = React.useState({});
  const [bonusOfficialMap, setBonusOfficialMap] = React.useState({});
  const [resultDrafts, setResultDrafts] = React.useState({});
  const [bonusDrafts, setBonusDrafts] = React.useState({});
  const [loadInfo, setLoadInfo] = React.useState(null);
  const token = session?.access_token;

  const allGroupMatches = React.useMemo(() => ALL_GROUPS.flatMap(g => GROUP_MATCHES[g].map(m => ({ ...m, stage: `Группа ${g}` }))), []);
  const allPlayoffMatches = React.useMemo(() => {
    const rows = [
      ...R16.map(m => ({ ...m, stage: "1/16" })),
      ...R8.map(m => ({ ...m, stage: "1/8" })),
      ...QF.map(m => ({ ...m, stage: "1/4" })),
      ...SF.map(m => ({ ...m, stage: "1/2" })),
      { ...THIRD_MATCH, stage: "За 3-е место" },
      { ...FINAL_MATCH, stage: "Финал" },
    ];
    // Защита от старых сборок/мерджей: финал должен всегда быть последней строкой вкладки плей-офф.
    return rows.some(m => m.id === "m104") ? rows : [...rows, { ...FINAL_MATCH, stage: "Финал" }];
  }, []);

  const matchIdAliasMap = React.useMemo(() => {
    const map = {};
    ALL_GROUPS.forEach(g => {
      (GROUP_MATCHES[g] || []).forEach((m, idx) => {
        const aliases = [m.id, String(m.match_no), `№${m.match_no}`, `${g}${idx + 1}`, `${g}-${idx + 1}`, `g${g}${idx + 1}`, `group_${g}_${idx + 1}`];
        aliases.forEach(a => { if (a) map[String(a).toLowerCase()] = m.id; });
      });
    });
    [R16, R8, QF, SF, [THIRD_MATCH, FINAL_MATCH]].flat().forEach((m, idx) => {
      const n = String(m.id || "").replace(/^m/i, "");
      const aliases = [m.id, n, `№${n}`, m.label, `po${idx + 1}`, `playoff_${idx + 1}`];
      aliases.forEach(a => { if (a) map[String(a).toLowerCase()] = m.id; });
    });
    return map;
  }, []);

  React.useEffect(() => { loadTableData(); }, []);

  function safeParseAnswer(v) {
    if (v === null || v === undefined) return "";
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return v; }
  }

  function formatAnswer(v) {
    if (v === null || v === undefined || v === "") return "—";
    if (Array.isArray(v)) return v.filter(Boolean).join(", ") || "—";
    if (typeof v === "object") {
      if (v.h !== undefined && v.a !== undefined) return `${v.h}:${v.a}`;
      return JSON.stringify(v);
    }
    return String(v);
  }

  function displayUserName(u) {
    return getDisplayName(u) || u.email || String(u.id || u.user_id || "").slice(0, 8);
  }

  function normalizeMatchId(raw) {
    if (raw === null || raw === undefined) return "";
    const v = String(raw).trim();
    if (!v) return "";
    const lower = v.toLowerCase();
    if (matchIdAliasMap[lower]) return matchIdAliasMap[lower];
    const n = lower.match(/^(?:m|match[_\s-]?|матч[_\s№-]*|#)?(\d{1,3})$/);
    if (n) return matchIdAliasMap[n[1]] || `m${n[1]}`;
    return v;
  }

  function normalizeQuestionId(raw) {
    if (raw === null || raw === undefined) return "";
    return String(raw).trim();
  }

  function rowUserKeys(r) {
    return [r?.user_id, r?.profile_id, r?.owner_id, r?.auth_user_id, r?.uid, r?.email, r?.user_email]
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "")
      .map(v => String(v).trim());
  }

  function participantKeys(u) {
    return [u?.id, u?.user_id, u?.profile_id, u?.email]
      .filter(v => v !== null && v !== undefined && String(v).trim() !== "")
      .map(v => String(v).trim());
  }


  function parseMaybeJson(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "object") return v;
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return null; }
  }

  function firstExisting(row, keys) {
    for (const k of keys) {
      if (row && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    }
    return null;
  }

  function addLegacyScoresToMaps(row, userKeys, pMap, bMap) {
    if (!row || !userKeys?.length) return 0;
    let imported = 0;
    const groupObj = parseMaybeJson(firstExisting(row, [
      "scores", "group_scores", "groupScores", "group_predictions", "groupPredictions",
      "match_predictions", "matchPredictions", "predictions_json", "predictionsJson", "predictions"
    ]));
    const playoffObj = parseMaybeJson(firstExisting(row, [
      "p_scores", "pScores", "playoff_scores", "playoffScores", "playoff_predictions", "playoffPredictions"
    ]));
    const pensObj = parseMaybeJson(firstExisting(row, ["p_pens", "pPens", "playoff_pens", "playoffPens", "penalties", "penalty_winners"]));
    const bonusObj = parseMaybeJson(firstExisting(row, ["bonus", "bonus_answers", "bonusAnswers", "bonus_json", "bonusJson"]));

    const addScore = (midRaw, val, penVal) => {
      const mid = normalizeMatchId(midRaw);
      if (!mid || val === null || val === undefined) return;
      let h = val?.h ?? val?.home_score ?? val?.home ?? val?.score1 ?? val?.team1 ?? val?.[0];
      let a = val?.a ?? val?.away_score ?? val?.away ?? val?.score2 ?? val?.team2 ?? val?.[1];
      if ((h === undefined || a === undefined) && typeof val === "string") {
        const m = val.match(/(\d+)\s*[:\-]\s*(\d+)/);
        if (m) { h = m[1]; a = m[2]; }
      }
      if (h === undefined || h === "" || a === undefined || a === "") return;
      userKeys.forEach(uid => {
        if (!pMap[uid]) pMap[uid] = {};
        if (!pMap[uid][mid]) { pMap[uid][mid] = { h, a, pen: penVal || val?.pen || val?.penalty_winner || val?.penaltyWinner || null }; imported += 1; }
      });
    };

    if (Array.isArray(groupObj)) {
      groupObj.forEach(x => addScore(x?.match_id ?? x?.id ?? x?.match ?? x?.game_id, x));
    } else if (groupObj && typeof groupObj === "object") {
      Object.entries(groupObj).forEach(([mid, val]) => addScore(mid, val));
    }
    if (Array.isArray(playoffObj)) {
      playoffObj.forEach(x => addScore(x?.match_id ?? x?.id ?? x?.match ?? x?.game_id, x, pensObj?.[x?.match_id ?? x?.id]));
    } else if (playoffObj && typeof playoffObj === "object") {
      Object.entries(playoffObj).forEach(([mid, val]) => addScore(mid, val, pensObj?.[mid]));
    }

    if (bonusObj && typeof bonusObj === "object") {
      Object.entries(bonusObj).forEach(([qidRaw, val]) => {
        const qid = normalizeQuestionId(qidRaw);
        if (!qid) return;
        userKeys.forEach(uid => {
          if (!bMap[uid]) bMap[uid] = {};
          if (bMap[uid][qid] === undefined) { bMap[uid][qid] = safeParseAnswer(val); imported += 1; }
        });
      });
    }
    return imported;
  }

  function isApprovedParticipant(u, statusMap) {
    const st = statusMap[u.id] || {};
    return st.is_approved === true || st.status === "approved" || u.is_paid === true ||
      [ACCESS.PROGNOSTISTA, ACCESS.FULL, ACCESS.ADMIN].includes(u.access_level) ||
      u.prediction_status === "submitted";
  }

  function appendRestParams(path, params) {
    return `${path}${path.includes("?") ? "&" : "?"}${params}`;
  }

  async function fetchAllRows(path, authToken, pageSize = 1000, maxPages = 50) {
    const rows = [];
    let lastResponse = null;
    for (let page = 0; page < maxPages; page += 1) {
      const offset = page * pageSize;
      const pagedPath = appendRestParams(path, `limit=${pageSize}&offset=${offset}`);
      const res = await supa(pagedPath, { token: authToken });
      lastResponse = res;
      if (!res.ok) return { ok: false, response: res, data: rows };
      const chunk = await res.json().catch(() => []);
      const arr = Array.isArray(chunk) ? chunk : [];
      rows.push(...arr);
      if (arr.length < pageSize) return { ok: true, response: res, data: rows };
    }
    return { ok: true, response: lastResponse, data: rows, truncated: true };
  }

  async function loadTableData() {
    setLoading(true);
    setLoadInfo(null);
    const freshToken = await getFreshToken(() => {}).catch(() => null);
    const authToken = freshToken || token;

    // Важно: PostgREST/Supabase обычно отдаёт максимум 1000 строк за запрос.
    // Когда прогнозов стало больше 1000, часть пользователей в админской таблице
    // превращалась в прочерки, хотя SQL показывал, что данные в predictions есть.
    // Поэтому все большие таблицы грузим постранично.
    const [profilesR, statusesR, predsR, bonusR, officialR, bonusOfficialR, paymentsR] = await Promise.all([
      fetchAllRows("profiles?select=*&order=created_at.asc", authToken),
      fetchAllRows("participant_status?select=*", authToken),
      fetchAllRows("predictions?select=*", authToken),
      fetchAllRows("bonus_answers?select=*", authToken),
      fetchAllRows("official_results?select=*", authToken),
      fetchAllRows("bonus_official_answers?select=*", authToken),
      fetchAllRows("payment_requests?select=*", authToken),
    ]);

    const profiles = profilesR.ok ? profilesR.data : [];
    const statuses = statusesR.ok ? statusesR.data : [];
    const predictions = predsR.ok ? predsR.data : [];
    const bonus = bonusR.ok ? bonusR.data : [];
    const official = officialR.ok ? officialR.data : [];
    const bonusOfficial = bonusOfficialR.ok ? bonusOfficialR.data : [];
    const payments = paymentsR.ok ? paymentsR.data : [];

    async function responseText(result) {
      return result?.response ? await result.response.text().catch(() => "") : "";
    }

    setLoadInfo({
      profiles: Array.isArray(profiles) ? profiles.length : 0,
      statuses: Array.isArray(statuses) ? statuses.length : 0,
      predictions: Array.isArray(predictions) ? predictions.length : 0,
      bonus: Array.isArray(bonus) ? bonus.length : 0,
      official: Array.isArray(official) ? official.length : 0,
      bonusOfficial: Array.isArray(bonusOfficial) ? bonusOfficial.length : 0,
      payments: Array.isArray(payments) ? payments.length : 0,
      legacyImported: 0,
      predictionError: predsR.ok ? "" : `${predsR.response?.status || ""} ${await responseText(predsR)}`.slice(0, 220),
      bonusError: bonusR.ok ? "" : `${bonusR.response?.status || ""} ${await responseText(bonusR)}`.slice(0, 220),
    });

    const statusMap = {};
    (statuses || []).forEach(r => { if (r?.user_id) statusMap[r.user_id] = r; });

    const profileMap = {};
    (profiles || []).forEach(u => { if (u?.id) profileMap[String(u.id)] = u; });

    const forecastUserIds = new Set();
    (predictions || []).forEach(r => rowUserKeys(r).forEach(k => forecastUserIds.add(k)));
    (bonus || []).forEach(r => rowUserKeys(r).forEach(k => forecastUserIds.add(k)));
    [...new Set([...forecastUserIds, ...Object.keys(statusMap)].filter(Boolean))].forEach(uid => {
      if (!profileMap[uid]) profileMap[uid] = { id: uid, email: "", name: "", display_name: "", has_forecast_only: true };
    });

    const approved = Object.values(profileMap)
      .filter(u => isApprovedParticipant(u, statusMap) || participantKeys(u).some(k => forecastUserIds.has(k)))
      .sort((a, b) => displayUserName(a).localeCompare(displayUserName(b), "ru"));
    setParticipants(approved);

    const pMap = {};
    (predictions || []).forEach(r => {
      const mid = normalizeMatchId(r?.match_id ?? r?.match ?? r?.game_id ?? r?.fixture_id);
      if (!mid) return;
      rowUserKeys(r).forEach(uid => {
        if (!pMap[uid]) pMap[uid] = {};
        pMap[uid][mid] = { h: r.home_score ?? r.home ?? r.h, a: r.away_score ?? r.away ?? r.a, pen: r.penalty_winner || r.penaltyWinner || null };
      });
    });

    const bMap = {};
    (bonus || []).forEach(r => {
      const qid = normalizeQuestionId(r?.question_id ?? r?.qid);
      if (!qid) return;
      rowUserKeys(r).forEach(uid => {
        if (!bMap[uid]) bMap[uid] = {};
        bMap[uid][qid] = safeParseAnswer(r.answer);
      });
    });

    // Совместимость со старыми сохранениями: раньше прогнозы могли лежать JSON-объектами
    // внутри profiles / participant_status / payment_requests, а не отдельными строками predictions.
    let legacyImported = 0;
    (profiles || []).forEach(u => legacyImported += addLegacyScoresToMaps(u, participantKeys(u), pMap, bMap));
    (statuses || []).forEach(st => {
      const u = profileMap[String(st?.user_id || "")] || { id: st?.user_id };
      legacyImported += addLegacyScoresToMaps(st, participantKeys(u), pMap, bMap);
    });
    (payments || []).forEach(pay => {
      const u = profileMap[String(pay?.user_id || "")] || { id: pay?.user_id, email: pay?.email };
      legacyImported += addLegacyScoresToMaps(pay, participantKeys(u), pMap, bMap);
    });
    if (legacyImported) setLoadInfo(info => info ? ({ ...info, legacyImported }) : info);

    setPredByUser(pMap);
    setBonusByUser(bMap);

    const oMap = {};
    const drafts = {};
    (official || []).forEach(r => {
      if (!r?.match_id) return;
      oMap[r.match_id] = r;
      drafts[r.match_id] = { h: r.home_score ?? "", a: r.away_score ?? "", pen: r.penalty_winner || "" };
    });
    setOfficialResultsMap(oMap);
    setResultDrafts(drafts);

    const boMap = {};
    const bd = {};
    (bonusOfficial || []).forEach(r => {
      if (!r?.question_id) return;
      boMap[r.question_id] = r;
      bd[r.question_id] = formatAnswer(r.answer).replace(/^—$/, "");
    });
    setBonusOfficialMap(boMap);
    setBonusDrafts(bd);
    setLoading(false);
  }

  function officialFor(mid) {
    return officialResultsMap[mid] || {};
  }

  function officialScore(mid) {
    const r = officialFor(mid);
    if (r.home_score === undefined || r.home_score === null || r.away_score === undefined || r.away_score === null) return null;
    return { h: r.home_score, a: r.away_score, pen: r.penalty_winner || null, status: r.status };
  }


  function removeUserFromLocalForecastTable(user, keys) {
    const keySet = new Set((keys || participantKeys(user)).map(String));
    setParticipants(prev => prev.filter(u => !participantKeys(u).some(k => keySet.has(String(k)))));
    setPredByUser(prev => {
      const next = { ...(prev || {}) };
      keySet.forEach(k => { delete next[k]; });
      return next;
    });
    setBonusByUser(prev => {
      const next = { ...(prev || {}) };
      keySet.forEach(k => { delete next[k]; });
      return next;
    });
    setLoadInfo(info => info ? ({
      ...info,
      predictions: Math.max(0, (info.predictions || 0) - 1),
      bonus: Math.max(0, (info.bonus || 0) - 1),
    }) : info);
  }

  async function deleteForecastParticipant(user) {
    const name = displayUserName(user);
    const keys = [...new Set(participantKeys(user).map(k => String(k).trim()).filter(Boolean))];
    if (!keys.length) { showToast("Не нашёл id пользователя для удаления"); return; }
    const ok = window.confirm(`Удалить «${name}» прямо из таблицы прогнозов?\n\nБудут удалены его строки predictions, bonus_answers, статус участия и заявки оплаты в таблицах приложения. Аккаунт Supabase Auth не удаляется.`);
    if (!ok) return;
    const ok2 = window.confirm("Точно удалить прогнозы этого пользователя? Это действие нельзя отменить без бэкапа.");
    if (!ok2) return;

    const freshToken = await getFreshToken(() => {}).catch(() => null);
    const authToken = freshToken || token;
    const failed = [];

    // Основной путь удаления — RPC-функция в Supabase.
    // Обычный REST DELETE часто упирается в RLS/FK и поэтому выполняется только частично.
    // SQL для создания функции см. в админском блоке ниже / ответе с файлом App_78.
    let rpcDeleted = false;
    try {
      const rpcBody = {
        p_user_key: String(keys[0] || user?.id || ""),
        p_user_email: String(user?.email || user?.user_email || ""),
      };
      const r = await supa("rpc/admin_delete_app_user_data", {
        method: "POST",
        token: authToken,
        body: JSON.stringify(rpcBody),
        headers: { Prefer: "return=representation" },
      });
      if (r.ok) {
        rpcDeleted = true;
      } else {
        const text = await r.text().catch(() => "");
        failed.push(`rpc/admin_delete_app_user_data: ${r.status} ${text.slice(0, 220)}`);
      }
    } catch (e) {
      failed.push(`rpc/admin_delete_app_user_data: ${e?.message || e}`);
    }

    // Запасной путь оставлен для старых баз/локальных таблиц.
    const deletePath = async (label, path) => {
      try {
        const r = await supa(path, { method: "DELETE", token: authToken, headers: { Prefer: "return=minimal" } });
        if (!r.ok && r.status !== 404) {
          const text = await r.text().catch(() => "");
          if (!/does not exist|column .* does not exist|relation .* does not exist/i.test(text)) failed.push(`${label}: ${r.status} ${text.slice(0, 140)}`);
        }
      } catch (e) {
        failed.push(`${label}: ${e?.message || e}`);
      }
    };

    if (!rpcDeleted) {
      for (const raw of keys) {
        const k = encodeURIComponent(raw);
        await deletePath("predictions.user_id", `predictions?user_id=eq.${k}`);
        await deletePath("bonus_answers.user_id", `bonus_answers?user_id=eq.${k}`);
        await deletePath("participant_status.user_id", `participant_status?user_id=eq.${k}`);
        await deletePath("payment_requests.user_id", `payment_requests?user_id=eq.${k}`);
        await deletePath("payment_requests.user_email", `payment_requests?user_email=eq.${k}`);
        await deletePath("predictor_team_members.user_id", `predictor_team_members?user_id=eq.${k}`);
        await deletePath("ffc_lineups.user_id", `ffc_lineups?user_id=eq.${k}`);
        await deletePath("ffc_cup_entries.user_id", `ffc_cup_entries?user_id=eq.${k}`);
        await deletePath("ffc_league_entries.user_id", `ffc_league_entries?user_id=eq.${k}`);
        await deletePath("daily_text_quiz_attempts.user_id", `daily_text_quiz_attempts?user_id=eq.${k}`);
        await deletePath("fcoin_transactions.user_id", `fcoin_transactions?user_id=eq.${k}`);
        await deletePath("leaderboard.user_id", `leaderboard?user_id=eq.${k}`);
        await deletePath("leaderboard.id", `leaderboard?id=eq.${k}`);
        await deletePath("profiles.id", `profiles?id=eq.${k}`);
        await deletePath("profiles.email", `profiles?email=eq.${k}`);
      }
    }

    removeUserFromLocalForecastTable(user, keys);
    if (rpcDeleted) {
      showToast(`✓ «${name}» удалён из таблицы прогнозов`);
    } else if (failed.length) {
      console.warn("delete forecast participant partial failures", failed);
      showToast(`Удаление частично выполнено. Ошибок: ${failed.length}. Нужно создать RPC-функцию удаления.`);
    } else {
      showToast(`✓ «${name}» удалён из таблицы прогнозов`);
    }
    await loadTableData();
  }

  function renderParticipantHeader(u) {
    return (
      <th key={u.id || u.user_id || u.email} style={{ minWidth: 130 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{displayUserName(u)}</span>
          <button
            type="button"
            title="Удалить пользователя и его прогнозы из таблиц приложения"
            onClick={(e) => { e.stopPropagation(); deleteForecastParticipant(u); }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: "1px solid rgba(239,68,68,.55)",
              background: "rgba(127,29,29,.45)",
              color: "#FCA5A5",
              fontWeight: 900,
              cursor: "pointer",
              lineHeight: "18px",
            }}
          >×</button>
        </div>
      </th>
    );
  }

  function predScore(userOrUid, mid) {
    const keys = typeof userOrUid === "object" ? participantKeys(userOrUid) : [String(userOrUid || "")];
    const normalizedMid = normalizeMatchId(mid);
    for (const k of keys) {
      const p = predByUser?.[k]?.[normalizedMid] || predByUser?.[k]?.[mid];
      if (p) return p;
    }
    return null;
  }

  function userBonusAnswer(userOrUid, qid) {
    const keys = typeof userOrUid === "object" ? participantKeys(userOrUid) : [String(userOrUid || "")];
    const normalizedQid = normalizeQuestionId(qid);
    for (const k of keys) {
      const ans = bonusByUser?.[k]?.[normalizedQid];
      if (ans !== undefined) return ans;
    }
    return undefined;
  }

  function scoreCell(userOrUid, mid) {
    const p = predScore(userOrUid, mid);
    const o = officialScore(mid);
    if (!p || !o || o.status !== "confirmed") return "";

    // В плей-офф счёт засчитывается только если у прогнозиста совпала вся пара матча.
    // Например, прогноз 2:1 на слот 1/8 не должен получать очки, если в этот слот
    // у человека вышли другие команды.
    if (isPlayoffMatchId(mid)) {
      const predTeams = userPlayoffTeams(userOrUid, mid);
      const officialTeams = officialPlayoffTeams(mid);
      if (!samePlayoffPair(predTeams, officialTeams)) return 0;
    }

    const pts = calculateMatchPredictionPoints(p.h, p.a, o.h, o.a);
    return pts ?? "";
  }

  function formatScore(s) {
    if (!s || s.h === undefined || s.h === null || s.a === undefined || s.a === null) return "—";
    return `${s.h}:${s.a}${s.pen ? `, пен. ${s.pen}` : ""}`;
  }

  function isPlayoffMatchId(mid) {
    return !ALL_GROUP_MATCH_IDS.has(normalizeMatchId(mid));
  }

  function scoreMapsForUser(userOrUid) {
    const keys = typeof userOrUid === "object" ? participantKeys(userOrUid) : [String(userOrUid || "")];
    const groupScores = {};
    const playoffScores = {};
    const playoffPens = {};
    keys.forEach(k => {
      const rows = predByUser?.[k] || {};
      Object.entries(rows).forEach(([rawMid, val]) => {
        const mid = normalizeMatchId(rawMid);
        if (!mid || !val) return;
        const row = { h: val.h, a: val.a };
        if (ALL_GROUP_MATCH_IDS.has(mid)) groupScores[mid] = row;
        else {
          playoffScores[mid] = row;
          if (val.pen) playoffPens[mid] = String(val.pen);
        }
      });
    });
    return { groupScores, playoffScores, playoffPens };
  }

  function officialScoreMaps() {
    const groupScores = {};
    const playoffScores = {};
    const playoffPens = {};
    Object.entries(officialResultsMap || {}).forEach(([rawMid, val]) => {
      const mid = normalizeMatchId(rawMid);
      if (!mid || !val || val.status !== "confirmed") return;
      if (val.home_score === undefined || val.home_score === null || val.away_score === undefined || val.away_score === null) return;
      const row = { h: val.home_score, a: val.away_score };
      if (ALL_GROUP_MATCH_IDS.has(mid)) groupScores[mid] = row;
      else {
        playoffScores[mid] = row;
        if (val.penalty_winner) playoffPens[mid] = String(val.penalty_winner);
      }
    });
    return { groupScores, playoffScores, playoffPens };
  }

  function allTablesFromScores(groupScores) {
    const tables = {};
    ALL_GROUPS.forEach(g => { tables[g] = calcGroupTable(g, groupScores || {}, {}); });
    return tables;
  }

  function playoffTeamsForMatch(matchId, groupScores, playoffScores, playoffPens) {
    const tables = allTablesFromScores(groupScores);
    const thirds = getThirdRanking(tables, {});
    const bracketList = allPlayoffMatches;

    function resolveFromBracket(bracket, side) {
      if (!bracket) return { team: "?", tbd: true };
      const winner = getWinner(bracket.id, playoffScores || {}, playoffPens || {});
      if (!winner) return { team: `Поб.${bracket.label || bracket.id}`, tbd: true };
      const teams = resolveBracketTeams(bracket);
      if (side === "loser") return winner === "home" ? teams.away : teams.home;
      return winner === "home" ? teams.home : teams.away;
    }

    function resolveBracketTeams(bracket) {
      if (!bracket) return { home: { team: "?", tbd: true }, away: { team: "?", tbd: true } };
      if (bracket.home_key) {
        return {
          home: resolveKey(bracket.home_key, tables, thirds, bracket.id),
          away: resolveKey(bracket.away_key, tables, thirds, bracket.id),
        };
      }
      const homeFrom = String(bracket.home_from || "");
      const awayFrom = String(bracket.away_from || "");
      const hId = homeFrom.replace("_loser", "");
      const aId = awayFrom.replace("_loser", "");
      return {
        home: resolveFromBracket(bracketList.find(b => b.id === hId), homeFrom.includes("_loser") ? "loser" : "win"),
        away: resolveFromBracket(bracketList.find(b => b.id === aId), awayFrom.includes("_loser") ? "loser" : "win"),
      };
    }

    return resolveBracketTeams(bracketList.find(b => b.id === normalizeMatchId(matchId)));
  }

  function teamName(info) {
    return info?.team || "—";
  }

  function samePlayoffPair(predTeams, officialTeams) {
    if (!predTeams || !officialTeams) return false;
    if (predTeams.home?.tbd || predTeams.away?.tbd || officialTeams.home?.tbd || officialTeams.away?.tbd) return false;
    return teamName(predTeams.home) === teamName(officialTeams.home) && teamName(predTeams.away) === teamName(officialTeams.away);
  }

  function userPlayoffTeams(userOrUid, mid) {
    const maps = scoreMapsForUser(userOrUid);
    return playoffTeamsForMatch(mid, maps.groupScores, maps.playoffScores, maps.playoffPens);
  }

  function officialPlayoffTeams(mid) {
    const maps = officialScoreMaps();
    return playoffTeamsForMatch(mid, maps.groupScores, maps.playoffScores, maps.playoffPens);
  }

  function formatTeamPair(teams, fallbackHome = "—", fallbackAway = "—") {
    if (!teams) return `${fallbackHome} — ${fallbackAway}`;
    return `${teamName(teams.home)} — ${teamName(teams.away)}`;
  }

  async function saveResult(matchId, status = "confirmed") {
    const d = resultDrafts[matchId] || {};
    if (d.h === "" || d.h === undefined || d.a === "" || d.a === undefined) { showToast("Введи счёт"); return; }
    const row = { match_id: matchId, home_score: +d.h, away_score: +d.a, penalty_winner: d.pen || null, status, source: "admin_table", updated_at: new Date().toISOString() };
    const r = await supa("official_results", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    if (!r.ok) { showToast("Ошибка сохранения результата"); return; }
    setOfficialResultsMap(m => ({ ...m, [matchId]: row }));
    showToast(status === "confirmed" ? "✓ Результат подтверждён" : "✓ Черновик результата сохранён");
  }

  function parseBonusInput(q, rawVal) {
    const v = String(rawVal ?? "").trim();
    if (q.answerType === "player_multi") return v.split(",").map(x => x.trim()).filter(Boolean);
    if (q.answerType === "number") return Number(v) || 0;
    return v;
  }

  async function saveBonusOfficial(qid, status = "confirmed") {
    const q = BONUS_QS.find(x => x.id === qid);
    const answer = parseBonusInput(q || {}, bonusDrafts[qid] || "");
    const row = { question_id: qid, answer, status, updated_at: new Date().toISOString() };
    const r = await supa("bonus_official_answers", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    if (!r.ok) { showToast("Ошибка сохранения ответа"); return; }
    setBonusOfficialMap(m => ({ ...m, [qid]: row }));
    showToast(status === "confirmed" ? "✓ Ответ подтверждён" : "✓ Черновик ответа сохранён");
  }

  function bonusPoints(q, userAnswer, officialRow) {
    if (!officialRow || officialRow.status !== "confirmed" || userAnswer === undefined || userAnswer === null || userAnswer === "") return "";
    const officialAns = officialRow.answer;
    if (q.id === "top_scorers") {
      const offArr = Array.isArray(officialAns) ? officialAns : [];
      const userArr = Array.isArray(userAnswer) ? userAnswer.filter(Boolean) : [];
      const rankPts = [q.pts, 5, 3];
      return offArr.reduce((sum, name, idx) => sum + (userArr.some(u => String(u).toLowerCase().trim() === String(name).toLowerCase().trim()) ? (rankPts[idx] || 0) : 0), 0);
    }
    if (q.answerType === "score") {
      const norm = v => typeof v === "string" ? v.trim() : formatAnswer(v).trim();
      return norm(userAnswer) === norm(officialAns) ? q.pts : 0;
    }
    if (q.answerType === "number") return String(userAnswer).trim() === String(officialAns).trim() ? q.pts : 0;
    return String(userAnswer || "").toLowerCase().trim() === String(officialAns || "").toLowerCase().trim() ? q.pts : 0;
  }

  function participantTotals(user) {
    let group = 0, playoff = 0, bonus = 0;
    allGroupMatches.forEach(m => { const v = scoreCell(user, m.id); if (v !== "") group += Number(v) || 0; });
    allPlayoffMatches.forEach(m => { const v = scoreCell(user, m.id); if (v !== "") playoff += Number(v) || 0; });
    BONUS_QS.forEach(q => { const v = bonusPoints(q, userBonusAnswer(user, q.id), bonusOfficialMap[q.id]); if (v !== "") bonus += Number(v) || 0; });
    return { group, playoff, bonus, total: group + playoff + bonus };
  }

  function renderMatchRows(matches) {
    const hasPlayoff = matches.some(m => isPlayoffMatchId(m.id));
    const participantColWidth = hasPlayoff ? 190 : 125;
    return (
      <div style={{ overflowX: "auto" }}>
        <table className="admin-table" style={{ minWidth: Math.max(980, 430 + participants.length * participantColWidth) }}>
          <thead>
            <tr>
              <th>Стадия</th><th>Матч</th><th>Команда 1</th><th>Команда 2</th><th>Результат</th><th>Ввод результата</th>
              {participants.map(renderParticipantHeader)}
            </tr>
          </thead>
          <tbody>
            {matches.map(m => {
              const off = officialScore(m.id);
              const draft = resultDrafts[m.id] || {};
              const isPlayoff = isPlayoffMatchId(m.id);
              const slotHome = m.home || m.home_key || m.home_from || "—";
              const slotAway = m.away || m.away_key || m.away_from || "—";
              const officialTeams = isPlayoff ? officialPlayoffTeams(m.id) : null;
              const home = isPlayoff ? teamName(officialTeams?.home) : slotHome;
              const away = isPlayoff ? teamName(officialTeams?.away) : slotAway;
              const slotsLabel = isPlayoff ? `${slotHome} — ${slotAway}` : "";
              return (
                <tr key={m.id}>
                  <td style={{ fontSize: 11, color: "#FDE68A", whiteSpace: "nowrap" }}>{m.stage}</td>
                  <td style={{ fontSize: 11, color: "rgba(240,237,230,.45)", whiteSpace: "nowrap" }}>{m.match_no ? `№${m.match_no}` : m.label || m.id}</td>
                  <td style={{ color: "#F0EDE6", fontWeight: 600 }}>
                    {home}
                    {isPlayoff && slotsLabel && <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", fontWeight: 400 }}>{slotHome}</div>}
                  </td>
                  <td>
                    {away}
                    {isPlayoff && slotsLabel && <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>{slotAway}</div>}
                  </td>
                  <td style={{ fontFamily: "Oswald,sans-serif", color: off?.status === "confirmed" ? "#86EFAC" : "#FDE68A", whiteSpace: "nowrap" }}>{formatScore(off)}</td>
                  <td style={{ minWidth: 190 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                      <input type="number" min="0" max="20" value={draft.h ?? ""} onChange={e => setResultDrafts(p => ({ ...p, [m.id]: { ...p[m.id], h: e.target.value } }))} style={{ width: 34, height: 24, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center" }} />
                      <span>:</span>
                      <input type="number" min="0" max="20" value={draft.a ?? ""} onChange={e => setResultDrafts(p => ({ ...p, [m.id]: { ...p[m.id], a: e.target.value } }))} style={{ width: 34, height: 24, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center" }} />
                      <input value={draft.pen ?? ""} onChange={e => setResultDrafts(p => ({ ...p, [m.id]: { ...p[m.id], pen: e.target.value } }))} placeholder="пен." title="Победитель по пенальти, если нужен" style={{ width: 54, height: 24, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 10, padding: "0 4px" }} />
                      <button className="mini-btn" onClick={() => saveResult(m.id, "draft")}>Черн.</button>
                      <button className="mini-btn green" onClick={() => saveResult(m.id, "confirmed")}>OK</button>
                    </div>
                  </td>
                  {participants.map(u => {
                    const ps = predScore(u, m.id);
                    const scoreText = formatScore(ps);
                    const hasPrediction = scoreText !== "—";
                    const pts = scoreCell(u, m.id);
                    const pTeams = isPlayoff && hasPrediction ? userPlayoffTeams(u, m.id) : null;
                    const pairOk = isPlayoff && hasPrediction && off?.status === "confirmed" ? samePlayoffPair(pTeams, officialTeams) : true;
                    return (
                      <td key={u.id} style={{ whiteSpace: "nowrap", minWidth: hasPlayoff ? 180 : undefined }}>
                        {isPlayoff && hasPrediction && (
                          <div style={{ fontSize: 11, color: pairOk ? "rgba(134,239,172,.85)" : "rgba(252,165,165,.75)", marginBottom: 3, lineHeight: 1.2 }}>
                            {formatTeamPair(pTeams, slotHome, slotAway)}
                          </div>
                        )}
                        <span style={{ color: "#F0EDE6", fontWeight: 600 }}>{scoreText}</span>
                        {pts !== "" && <span style={{ color: pts > 0 ? "#F59E0B" : "rgba(240,237,230,.35)", marginLeft: 6 }}>+{pts}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderQuestions() {
    return (
      <div style={{ overflowX: "auto" }}>
        <table className="admin-table" style={{ minWidth: Math.max(980, 520 + participants.length * 140) }}>
          <thead><tr><th>№</th><th>Вопрос</th><th>Очки</th><th>Официальный ответ</th><th>Ввод ответа</th>{participants.map(renderParticipantHeader)}</tr></thead>
          <tbody>
            {BONUS_QS.map((q, idx) => {
              const official = bonusOfficialMap[q.id];
              return (
                <tr key={q.id}>
                  <td>{idx + 1}</td>
                  <td style={{ minWidth: 260, color: "#F0EDE6", fontWeight: 600 }}>{q.text}</td>
                  <td style={{ color: "#F59E0B", fontWeight: 700 }}>{q.pts}</td>
                  <td style={{ color: official?.status === "confirmed" ? "#86EFAC" : "#FDE68A", minWidth: 130 }}>{formatAnswer(official?.answer)}</td>
                  <td style={{ minWidth: 260 }}>
                    <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                      <input value={bonusDrafts[q.id] ?? ""} onChange={e => setBonusDrafts(p => ({ ...p, [q.id]: e.target.value }))} placeholder={q.answerType === "player_multi" ? "Игрок1, Игрок2, Игрок3" : q.answerType === "score" ? "2:1" : "Ответ"} style={{ width: 165, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 11, padding: "5px 7px" }} />
                      <button className="mini-btn" onClick={() => saveBonusOfficial(q.id, "draft")}>Черн.</button>
                      <button className="mini-btn green" onClick={() => saveBonusOfficial(q.id, "confirmed")}>OK</button>
                    </div>
                  </td>
                  {participants.map(u => {
                    const ans = userBonusAnswer(u, q.id);
                    const pts = bonusPoints(q, ans, official);
                    return <td key={u.id} style={{ minWidth: 130 }}><span>{formatAnswer(ans)}</span>{pts !== "" && <span style={{ color: "#F59E0B", marginLeft: 6 }}>+{pts}</span>}</td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderResults() {
    const rows = participants.map(u => ({ user: u, ...participantTotals(u) })).sort((a, b) => b.total - a.total || b.group - a.group);
    return (
      <div className="panel">
        <div className="ph"><span className="pt">Итоговая таблица</span><span className="tag tg">{rows.length} участников</span></div>
        <table className="admin-table">
          <thead><tr><th>Место</th><th>Прогнозист</th><th>Групповой</th><th>Плей-офф</th><th>Вопросы</th><th>Всего</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={r.user.id}><td style={{ fontFamily: "Oswald,sans-serif", color: "#FDE68A" }}>{i + 1}</td><td style={{ color: "#F0EDE6", fontWeight: 700 }}>{displayUserName(r.user)}</td><td>{r.group}</td><td>{r.playoff}</td><td>{r.bonus}</td><td style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, color: "#F59E0B", fontWeight: 700 }}>{r.total}</td></tr>)}</tbody>
        </table>
      </div>
    );
  }

  if (loading) return <div className="panel" style={{ padding: 18, color: "rgba(240,237,230,.55)", fontSize: 13 }}>Загружаю таблицу прогнозов…</div>;

  return (
    <div>
      <div className="panel" style={{ padding: 12, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, color: "#FDE68A", fontWeight: 700 }}>Таблица прогнозов</div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.45)", marginTop: 3 }}>По образцу Excel: участники берутся из одобренных в админке, результаты можно вводить прямо в строках матчей и вопросов.</div>
            {loadInfo && <div style={{ fontSize: 11, color: (loadInfo.predictions > 0 || loadInfo.bonus > 0) ? "rgba(134,239,172,.85)" : "#FCA5A5", marginTop: 6 }}>Загружено из БД: прогнозов матчей — {loadInfo.predictions}, ответов на вопросы — {loadInfo.bonus}{loadInfo.legacyImported ? `, найдено старых прогнозов в профилях/заявках — ${loadInfo.legacyImported}` : ""}. {loadInfo.predictionError ? `Ошибка predictions: ${loadInfo.predictionError}` : ""} {loadInfo.bonusError ? `Ошибка bonus_answers: ${loadInfo.bonusError}` : ""}</div>}
            {loadInfo && loadInfo.predictions === 0 && loadInfo.bonus === 0 && <details style={{ marginTop: 8 }}><summary style={{ fontSize: 11, color: "#FDE68A", cursor: "pointer" }}>Если прогнозы точно есть, выполни SQL для доступа админки к прогнозам</summary><pre style={{ fontSize: 10, color: "rgba(240,237,230,.65)", background: "rgba(0,0,0,.35)", padding: 10, borderRadius: 6, overflow: "auto", marginTop: 8 }}>{`ALTER TABLE public.predictions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "predictions_admin_read_all" ON public.predictions;
CREATE POLICY "predictions_admin_read_all"
ON public.predictions FOR SELECT TO authenticated
USING (true);
GRANT SELECT ON public.predictions TO authenticated;

ALTER TABLE public.bonus_answers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bonus_answers_admin_read_all" ON public.bonus_answers;
CREATE POLICY "bonus_answers_admin_read_all"
ON public.bonus_answers FOR SELECT TO authenticated
USING (true);
GRANT SELECT ON public.bonus_answers TO authenticated;`}</pre></details>}
          </div>
          <button className="sb" onClick={loadTableData}>Обновить</button>
        </div>
      </div>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {[["groups", "Групповой турнир"], ["playoff", "Плей-офф"], ["questions", "Вопросы"], ["summary", "Результаты"]].map(([k, l]) => <button key={k} className={`tab${tableTab === k ? " on" : ""}`} onClick={() => setTableTab(k)}>{l}</button>)}
      </div>
      {tableTab === "groups" && renderMatchRows(allGroupMatches)}
      {tableTab === "playoff" && renderMatchRows(allPlayoffMatches)}
      {tableTab === "questions" && renderQuestions()}
      {tableTab === "summary" && renderResults()}
    </div>
  );
}

// ── ADMIN PANEL ──

// ══════════════════════════════════════════════════════════════════
// НОВАЯ УПРОЩЁННАЯ АДМИНКА — 4 вкладки после дедлайна
// ══════════════════════════════════════════════════════════════════

// ── Вкладка 1: Матчи (ввод официальных результатов) ──────────────
function AdminMatchesPanel({ session, showToast }) {
  const token = session?.access_token;
  const [officialMap, setOfficialMap] = React.useState({});
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [section, setSection] = React.useState("groups");

  const allGroupMatches = React.useMemo(() => ALL_GROUPS.flatMap(g => GROUP_MATCHES[g].map(m => ({ ...m, stage: `Группа ${g}` }))), []);
  const allPlayoffMatches = React.useMemo(() => [
    ...R16.map(m => ({ ...m, stage: "1/16" })),
    ...R8.map(m => ({ ...m, stage: "1/8" })),
    ...QF.map(m => ({ ...m, stage: "1/4" })),
    ...SF.map(m => ({ ...m, stage: "1/2" })),
    { ...THIRD_MATCH, stage: "За 3-е место" },
    { ...FINAL_MATCH, stage: "Финал" },
  ], []);

  React.useEffect(() => { loadOfficial(); }, []);

  async function loadOfficial() {
    setLoading(true);
    const r = await supa("official_results?select=*", { token });
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(row => {
        if (row.match_id) map[String(row.match_id)] = row;
      });
      setOfficialMap(map);
      // предзаполнить драфты существующими значениями
      const d = {};
      Object.entries(map).forEach(([mid, row]) => {
        d[mid] = { h: row.home_score ?? "", a: row.away_score ?? "", pen: row.penalty_winner ?? "" };
      });
      setDrafts(d);
    } else {
      showToast("official_results недоступна — нужен SQL ниже");
    }
    setLoading(false);
  }

  function setDraft(mid, field, val) {
    setDrafts(p => ({ ...p, [mid]: { ...(p[mid] || {}), [field]: val } }));
  }

  async function save(mid, status = "confirmed") {
    const d = drafts[mid] || {};
    if (d.h === "" || d.h === undefined || d.a === "" || d.a === undefined) { showToast("Введи счёт"); return; }
    setSaving(p => ({ ...p, [mid]: true }));
    // Нормализуем match_id → строго "m1", "m2", ... "m104"
    const normalizedMid = String(mid).trim().replace(/^[^0-9]*(\d+)$/, (_, n) => `m${n}`);
    const row = { match_id: normalizedMid, home_score: Number(d.h), away_score: Number(d.a), penalty_winner: d.pen || null, status, source: "admin", updated_at: new Date().toISOString() };
    const r = await supa("official_results", { method: "POST", token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    if (r.ok) {
      setOfficialMap(p => ({ ...p, [mid]: row }));
      showToast(status === "confirmed" ? "✓ Сохранено" : "✓ Черновик");
    } else {
      const txt = await r.response?.text().catch(() => "");
      showToast("Ошибка: " + txt.slice(0, 80));
    }
    setSaving(p => ({ ...p, [mid]: false }));
  }

  async function clearResult(mid) {
    if (!window.confirm("Удалить официальный результат этого матча?")) return;
    await supa(`official_results?match_id=eq.${mid}`, { method: "DELETE", token, headers: { Prefer: "return=minimal" } });
    setOfficialMap(p => { const n = { ...p }; delete n[mid]; return n; });
    showToast("Результат удалён");
  }

  const confirmed = Object.values(officialMap).filter(r => r.status === "confirmed").length;
  const matches = section === "groups" ? allGroupMatches : allPlayoffMatches;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A" }}>🏟 Официальные результаты</span>
        <span className="tag tg">{confirmed} подтверждено</span>
        <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={loadOfficial}>↻ Обновить</button>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["groups","Групповой этап"],["playoff","Плей-офф"]].map(([k,l]) => (
          <button key={k} className={`tab${section===k?" on":""}`} style={{ fontSize: 12 }} onClick={() => setSection(k)}>{l}</button>
        ))}
      </div>
      {loading && <div style={{ padding: 20, color: "rgba(240,237,230,.4)", fontSize: 13 }}>Загружаю…</div>}
      {!loading && (
        <div style={{ overflowX: "auto" }}>
          <table className="admin-table">
            <thead><tr><th>Стадия</th><th>№</th><th>Хозяева</th><th>Гости</th><th>Текущий счёт</th><th style={{ minWidth: 240 }}>Ввод</th><th></th></tr></thead>
            <tbody>
              {matches.map(m => {
                const off = officialMap[m.id];
                const d = drafts[m.id] || {};
                const isPlayoff = !ALL_GROUP_MATCH_IDS.has(m.id);
                const isDraw = d.h !== "" && d.a !== "" && d.h !== undefined && d.a !== undefined && Number(d.h) === Number(d.a);
                const sv = saving[m.id];
                return (
                  <tr key={m.id}>
                    <td style={{ fontSize: 11, color: "#FDE68A", whiteSpace: "nowrap" }}>{m.stage}</td>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>{m.match_no ? `№${m.match_no}` : m.label || m.id}</td>
                    <td style={{ fontWeight: 600, color: "#F0EDE6" }}>{m.home || m.home_key || "—"}</td>
                    <td style={{ fontWeight: 600, color: "#F0EDE6" }}>{m.away || m.away_key || "—"}</td>
                    <td style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, color: off?.status === "confirmed" ? "#86EFAC" : off ? "#FDE68A" : "rgba(240,237,230,.3)", whiteSpace: "nowrap" }}>
                      {off ? `${off.home_score}:${off.away_score}${off.penalty_winner ? ` (пен: ${off.penalty_winner})` : ""}` : "—"}
                      {off?.status === "confirmed" && <span style={{ fontSize: 9, marginLeft: 4, color: "#86EFAC" }}>✓</span>}
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        <input type="number" min="0" max="30" value={d.h ?? ""} onChange={e => setDraft(m.id, "h", e.target.value)} style={{ width: 36, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center", fontSize: 13 }} placeholder="—" />
                        <span style={{ color: "rgba(240,237,230,.4)" }}>:</span>
                        <input type="number" min="0" max="30" value={d.a ?? ""} onChange={e => setDraft(m.id, "a", e.target.value)} style={{ width: 36, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center", fontSize: 13 }} placeholder="—" />
                        {(isPlayoff && isDraw) && (
                          <input value={d.pen ?? ""} onChange={e => setDraft(m.id, "pen", e.target.value)} placeholder="победитель пен." style={{ width: 110, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(245,158,11,.3)", borderRadius: 4, color: "#FDE68A", fontSize: 10, padding: "0 5px" }} />
                        )}
                        <button className="mini-btn" disabled={sv} onClick={() => save(m.id, "draft")} style={{ opacity: sv ? 0.5 : 1 }}>Черн.</button>
                        <button className="mini-btn green" disabled={sv} onClick={() => save(m.id, "confirmed")} style={{ opacity: sv ? 0.5 : 1 }}>{sv ? "…" : "✓ OK"}</button>
                        {off && <button className="mini-btn red" onClick={() => clearResult(m.id)} style={{ fontSize: 9, opacity: 0.6 }}>×</button>}
                      </div>
                    </td>
                    <td style={{ fontSize: 10, color: off?.status === "confirmed" ? "#86EFAC" : "rgba(240,237,230,.2)" }}>{off?.status === "confirmed" ? "✓" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <details style={{ marginTop: 20 }}>
        <summary style={{ cursor: "pointer", fontSize: 11, color: "rgba(240,237,230,.35)" }}>SQL: создать таблицу official_results (если нет)</summary>
        <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`CREATE TABLE IF NOT EXISTS public.official_results (
  match_id TEXT PRIMARY KEY,
  home_score INTEGER,
  away_score INTEGER,
  penalty_winner TEXT,
  status TEXT DEFAULT 'draft',
  source TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.official_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY "or_select" ON public.official_results FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "or_insert" ON public.official_results FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "or_update" ON public.official_results FOR UPDATE TO authenticated USING (true);`}</pre>
      </details>
    </div>
  );
}

// ── Вкладка 2: Бонусы (ввод официальных ответов) ─────────────────
function AdminBonusPanel({ session, showToast }) {
  const token = session?.access_token;
  const [bonusMap, setBonusMap] = React.useState({});
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [sqlMissing, setSqlMissing] = React.useState(false);

  React.useEffect(() => { loadBonus(); }, []);

  async function loadBonus() {
    setLoading(true);
    const r = await supa("bonus_official_answers?select=*", { token });
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(row => { if (row.question_id) map[String(row.question_id)] = row; });
      setBonusMap(map);
      const d = {};
      Object.entries(map).forEach(([qid, row]) => {
        const ans = row.answer;
        d[qid] = Array.isArray(ans) ? ans.join(", ") : String(ans ?? "");
      });
      setDrafts(d);
    } else {
      const txt = await r.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
    }
    setLoading(false);
  }

  async function save(qid, status = "confirmed") {
    const q = BONUS_QS.find(x => String(x.id) === String(qid));
    const raw = drafts[qid] ?? "";
    let answer;
    if (q?.answerType === "player_multi") answer = raw.split(",").map(x => x.trim()).filter(Boolean);
    else if (q?.answerType === "number") answer = Number(raw) || 0;
    else answer = raw.trim();
    setSaving(p => ({ ...p, [qid]: true }));
    const row = { question_id: String(qid), answer, points: q?.pts ?? 0, status, updated_at: new Date().toISOString() };
    const r = await supa("bonus_official_answers", { method: "POST", token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    if (r.ok) {
      setBonusMap(p => ({ ...p, [qid]: row }));
      showToast(status === "confirmed" ? "✓ Ответ сохранён" : "✓ Черновик");
    } else {
      const txt = await r.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
      showToast("Ошибка сохранения: " + txt.slice(0, 80));
    }
    setSaving(p => ({ ...p, [qid]: false }));
  }

  const confirmed = Object.values(bonusMap).filter(r => r.status === "confirmed").length;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A" }}>🧠 Официальные ответы на бонусы</span>
        <span className="tag tg">{confirmed}/{BONUS_QS.length} подтверждено</span>
        <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={loadBonus}>↻ Обновить</button>
      </div>
      {loading && <div style={{ padding: 20, color: "rgba(240,237,230,.4)", fontSize: 13 }}>Загружаю…</div>}
      {!loading && (
        <div style={{ overflowX: "auto" }}>
          <table className="admin-table">
            <thead><tr><th>№</th><th style={{ minWidth: 260 }}>Вопрос</th><th>Тип</th><th>Очки</th><th>Текущий ответ</th><th style={{ minWidth: 280 }}>Ввод ответа</th><th></th></tr></thead>
            <tbody>
              {BONUS_QS.map((q, i) => {
                const off = bonusMap[String(q.id)];
                const d = drafts[String(q.id)] ?? "";
                const sv = saving[String(q.id)];
                const offStr = off?.answer !== undefined ? (Array.isArray(off.answer) ? off.answer.join(", ") : String(off.answer)) : "—";
                const placeholder = q.answerType === "player_multi" ? "Игрок 1, Игрок 2, ..." : q.answerType === "number" ? "Число" : q.answerType === "score" ? "2:1" : "Ответ";
                return (
                  <tr key={q.id}>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>{i + 1}</td>
                    <td style={{ fontSize: 12, color: "#F0EDE6", maxWidth: 280, whiteSpace: "normal", lineHeight: 1.4 }}>{q.text}</td>
                    <td style={{ fontSize: 10, color: "rgba(240,237,230,.4)", whiteSpace: "nowrap" }}>{q.answerType || "text"}</td>
                    <td style={{ fontFamily: "Oswald,sans-serif", color: "#F59E0B", fontWeight: 700 }}>{q.pts}</td>
                    <td style={{ fontSize: 11, color: off?.status === "confirmed" ? "#86EFAC" : "#FDE68A", fontWeight: off ? 600 : 400, whiteSpace: "nowrap" }}>
                      {offStr}{off?.status === "confirmed" && <span style={{ marginLeft: 4, fontSize: 9 }}>✓</span>}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={d}
                          onChange={e => setDrafts(p => ({ ...p, [String(q.id)]: e.target.value }))}
                          placeholder={placeholder}
                          style={{ flex: 1, minWidth: 140, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 12, padding: "0 8px" }}
                        />
                        <button className="mini-btn" disabled={sv} onClick={() => save(q.id, "draft")} style={{ opacity: sv ? 0.5 : 1 }}>Черн.</button>
                        <button className="mini-btn green" disabled={sv} onClick={() => save(q.id, "confirmed")} style={{ opacity: sv ? 0.5 : 1 }}>{sv ? "…" : "✓ OK"}</button>
                      </div>
                    </td>
                    <td style={{ fontSize: 10, color: off?.status === "confirmed" ? "#86EFAC" : "rgba(240,237,230,.2)" }}>{off?.status === "confirmed" ? "✓" : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sqlMissing && (
        <div style={{ marginTop: 16, background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#FCA5A5", marginBottom: 8 }}>⚠ Таблица bonus_official_answers не найдена. Выполни SQL:</div>
          <pre style={{ fontSize: 10, color: "rgba(240,237,230,.6)", background: "rgba(0,0,0,.3)", padding: 10, borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`CREATE TABLE IF NOT EXISTS public.bonus_official_answers (
  question_id TEXT PRIMARY KEY,
  answer JSONB,
  points INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.bonus_official_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "boa_select" ON public.bonus_official_answers FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "boa_insert" ON public.bonus_official_answers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "boa_update" ON public.bonus_official_answers FOR UPDATE TO authenticated USING (true);`}</pre>
        </div>
      )}
    </div>
  );
}

// ── Вкладка 3: Плей-офф пары ──────────────────────────────────────
function AdminPlayoffPairsPanel({ session, showToast }) {
  const token = session?.access_token;
  const [pairs, setPairs] = React.useState({});
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [sqlMissing, setSqlMissing] = React.useState(false);

  const allPlayoffMatches = React.useMemo(() => [
    ...R16.map(m => ({ ...m, stage: "1/16" })),
    ...R8.map(m => ({ ...m, stage: "1/8" })),
    ...QF.map(m => ({ ...m, stage: "1/4" })),
    ...SF.map(m => ({ ...m, stage: "1/2" })),
    { ...THIRD_MATCH, stage: "За 3-е место" },
    { ...FINAL_MATCH, stage: "Финал" },
  ], []);

  React.useEffect(() => { loadPairs(); }, []);

  async function loadPairs() {
    setLoading(true);
    const r = await supa("playoff_official_pairs?select=*", { token });
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(row => { if (row.match_id) map[String(row.match_id)] = row; });
      setPairs(map);
      const d = {};
      Object.entries(map).forEach(([mid, row]) => { d[mid] = { home: row.home_team ?? "", away: row.away_team ?? "" }; });
      setDrafts(d);
    } else {
      const txt = await r.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
    }
    setLoading(false);
  }

  function setDraft(mid, field, val) {
    setDrafts(p => ({ ...p, [mid]: { ...(p[mid] || {}), [field]: val } }));
  }

  async function save(mid) {
    const d = drafts[mid] || {};
    if (!d.home?.trim() || !d.away?.trim()) { showToast("Введи обе команды"); return; }
    setSaving(p => ({ ...p, [mid]: true }));
    const row = { match_id: mid, home_team: d.home.trim(), away_team: d.away.trim(), updated_at: new Date().toISOString() };
    const r = await supa("playoff_official_pairs", { method: "POST", token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    if (r.ok) {
      setPairs(p => ({ ...p, [mid]: row }));
      showToast("✓ Пара сохранена");
    } else {
      const txt = await r.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
      showToast("Ошибка: " + txt.slice(0, 80));
    }
    setSaving(p => ({ ...p, [mid]: false }));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A" }}>⚔ Реальные пары плей-офф</span>
        <span className="tag ty">{Object.keys(pairs).length}/{allPlayoffMatches.length} заполнено</span>
        <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={loadPairs}>↻ Обновить</button>
      </div>
      <div style={{ fontSize: 12, color: "rgba(147,197,253,.7)", background: "rgba(147,197,253,.06)", border: "1px solid rgba(147,197,253,.18)", borderRadius: 6, padding: "8px 12px", marginBottom: 12 }}>
        Зафиксированные здесь пары используются для проверки: очки за счёт в плей-офф начисляются только если пара участника совпала с реальной. Match_id не меняется. Прогнозы участников не трогаются.
      </div>
      {loading && <div style={{ padding: 20, color: "rgba(240,237,230,.4)", fontSize: 13 }}>Загружаю…</div>}
      {!loading && !sqlMissing && (
        <div style={{ overflowX: "auto" }}>
          <table className="admin-table">
            <thead><tr><th>Стадия</th><th>Match ID</th><th>Слот хозяев</th><th>Слот гостей</th><th style={{ color: "#86EFAC" }}>Реальная пара</th><th style={{ minWidth: 320 }}>Ввод команд</th></tr></thead>
            <tbody>
              {allPlayoffMatches.map(m => {
                const saved = pairs[m.id];
                const d = drafts[m.id] || {};
                const sv = saving[m.id];
                return (
                  <tr key={m.id}>
                    <td style={{ fontSize: 11, color: "#FDE68A", whiteSpace: "nowrap" }}>{m.stage}</td>
                    <td style={{ fontSize: 10, color: "rgba(240,237,230,.4)", fontFamily: "monospace" }}>{m.id}</td>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{m.home || m.home_from || "—"}</td>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{m.away || m.away_from || "—"}</td>
                    <td style={{ fontWeight: 700, color: saved ? "#86EFAC" : "rgba(240,237,230,.25)" }}>{saved ? `${saved.home_team} — ${saved.away_team}` : "не задана"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                        <input value={d.home ?? ""} onChange={e => setDraft(m.id, "home", e.target.value)} placeholder="Команда хозяев" style={{ width: 120, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 11, padding: "0 6px" }} />
                        <span style={{ color: "rgba(240,237,230,.3)", fontSize: 11 }}>—</span>
                        <input value={d.away ?? ""} onChange={e => setDraft(m.id, "away", e.target.value)} placeholder="Команда гостей" style={{ width: 120, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 11, padding: "0 6px" }} />
                        <button className="mini-btn green" disabled={sv} onClick={() => save(m.id)} style={{ opacity: sv ? 0.5 : 1 }}>{sv ? "…" : "✓ Сохранить"}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(sqlMissing || true) && (
        <details style={{ marginTop: 20 }}>
          <summary style={{ cursor: "pointer", fontSize: 11, color: "rgba(240,237,230,.35)" }}>SQL: создать таблицу playoff_official_pairs (если нет)</summary>
          <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`CREATE TABLE IF NOT EXISTS public.playoff_official_pairs (
  match_id TEXT PRIMARY KEY,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.playoff_official_pairs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pop_select" ON public.playoff_official_pairs FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "pop_insert" ON public.playoff_official_pairs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "pop_update" ON public.playoff_official_pairs FOR UPDATE TO authenticated USING (true);`}</pre>
        </details>
      )}
    </div>
  );
}

// ── Вкладка 4: Битва клубов — очки игроков ───────────────────────
function AdminFfcScoresPanel({ session, showToast }) {
  const token = session?.access_token;
  const [players, setPlayers] = React.useState([]);
  const [scores, setScores] = React.useState({});
  const [drafts, setDrafts] = React.useState({});
  const [saving, setSaving] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [sqlMissing, setSqlMissing] = React.useState(false);
  const [roundId, setRoundId] = React.useState(null);
  const [lineupCards, setLineupCards] = React.useState([]);

  React.useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    // 1. Получаем 1-й тур
    let rid = null;
    const roundsR = await supa("ffc_rounds?select=id,round_no,sort_order,name&order=sort_order.asc.nullslast,round_no.asc.nullslast,created_at.asc&limit=1", { token });
    if (roundsR.ok) {
      const rounds = await roundsR.json().catch(() => []);
      rid = Array.isArray(rounds) && rounds[0]?.id ? rounds[0].id : null;
    }
    setRoundId(rid);

    // 2. Игроки тура
    let playerRows = [];
    if (rid) {
      const poolR = await supa(`ffc_round_draft_options?select=id,slot_key,player_name,national_team,position&round_id=eq.${rid}&order=slot_key.asc,option_no.asc&limit=1000`, { token });
      if (poolR.ok) playerRows = await poolR.json().catch(() => []);
    }
    if (!playerRows.length) {
      const pfR = await supa("ffc_players?select=id,name,national_team,position&is_active=eq.true&order=position.asc,name.asc&limit=500", { token });
      if (pfR.ok) playerRows = (await pfR.json().catch(() => [])).map(p => ({ id: p.id, player_name: p.name, national_team: p.national_team, position: p.position }));
    }
    setPlayers(playerRows);

    // 3. Существующие очки
    const scTable = rid ? `ffc_round_player_scores?round_id=eq.${rid}&select=*` : "ffc_round_player_scores?select=*&limit=500";
    const scR = await supa(scTable, { token });
    if (scR.ok) {
      const rows = await scR.json().catch(() => []);
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(r => { if (r.player_id || r.option_id) map[String(r.player_id || r.option_id)] = r; });
      setScores(map);
      const d = {};
      Object.entries(map).forEach(([pid, row]) => { d[pid] = String(row.points ?? ""); });
      setDrafts(d);
    } else {
      const txt = await scR.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
    }

    // 4. Составы участников для суммирования
    if (rid) {
      const linR = await supa(`ffc_lineups?round_id=eq.${rid}&select=id,user_id,lineup_status,draft_answers,captain_option_id&order=created_at.desc`, { token });
      const profR = await supa("profiles?select=id,user_id,name,display_name", { token });
      if (linR.ok && profR.ok) {
        const lins = await linR.json().catch(() => []);
        const profs = await profR.json().catch(() => []);
        const pm = {};
        profs.forEach(p => { if (p.id) pm[p.id] = p; if (p.user_id) pm[p.user_id] = p; });
        setLineupCards(lins.map(l => ({ ...l, _name: pm[l.user_id]?.display_name || pm[l.user_id]?.name || String(l.user_id || "").slice(0, 8) })));
      }
    }
    setLoading(false);
  }

  async function save(playerId) {
    const pts = Number(drafts[playerId] ?? 0);
    setSaving(p => ({ ...p, [playerId]: true }));
    const row = { player_id: playerId, round_id: roundId, points: pts, updated_at: new Date().toISOString() };
    const r = await supa("ffc_round_player_scores", { method: "POST", token, headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    if (r.ok) {
      setScores(p => ({ ...p, [playerId]: row }));
      showToast("✓ Очки сохранены");
    } else {
      const txt = await r.response?.text().catch(() => "");
      if (txt.includes("does not exist")) setSqlMissing(true);
      showToast("Ошибка: " + txt.slice(0, 80));
    }
    setSaving(p => ({ ...p, [playerId]: false }));
  }

  // Сумма очков состава участника
  function lineupTotal(lineup) {
    try {
      const raw = typeof lineup.draft_answers === "string" ? JSON.parse(lineup.draft_answers) : (lineup.draft_answers || {});
      return Object.values(raw).reduce((sum, val) => {
        const optId = typeof val === "object" ? (val.option_id || val.id || val.optionId) : String(val);
        const pts = scores[String(optId)]?.points;
        return sum + (pts !== undefined && pts !== null ? Number(pts) : 0);
      }, 0);
    } catch { return 0; }
  }

  const filledCount = Object.values(scores).filter(r => r.points !== undefined && r.points !== null).length;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A" }}>⚽ Очки игроков — 1-й тур Битвы клубов</span>
        {roundId && <span className="tag ty">round: {String(roundId).slice(0, 8)}…</span>}
        <span className="tag">{filledCount}/{players.length} заполнено</span>
        <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={loadAll}>↻ Обновить</button>
      </div>

      {loading && <div style={{ padding: 20, color: "rgba(240,237,230,.4)", fontSize: 13 }}>Загружаю…</div>}

      {!loading && !sqlMissing && players.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: 20 }}>
          <table className="admin-table">
            <thead><tr><th>Игрок</th><th>Сборная</th><th>Позиция</th><th>Текущие очки</th><th style={{ minWidth: 160 }}>Ввод очков</th></tr></thead>
            <tbody>
              {players.map(p => {
                const pid = String(p.id);
                const sv = saving[pid];
                const cur = scores[pid];
                return (
                  <tr key={pid}>
                    <td style={{ fontWeight: 600, color: "#F0EDE6" }}>{p.player_name || p.name}</td>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.55)" }}>{p.national_team || "—"}</td>
                    <td style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>{p.position || "—"}</td>
                    <td style={{ fontFamily: "Oswald,sans-serif", fontWeight: 700, color: cur?.points !== undefined ? "#86EFAC" : "rgba(240,237,230,.25)" }}>{cur?.points !== undefined ? cur.points : "—"}</td>
                    <td>
                      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                        <input type="number" min="0" max="50" value={drafts[pid] ?? ""} onChange={e => setDrafts(d => ({ ...d, [pid]: e.target.value }))} style={{ width: 60, height: 26, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", textAlign: "center", fontSize: 13 }} placeholder="0" />
                        <button className="mini-btn green" disabled={sv} onClick={() => save(pid)} style={{ opacity: sv ? 0.5 : 1 }}>{sv ? "…" : "✓ OK"}</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && lineupCards.length > 0 && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#FDE68A", marginBottom: 10 }}>📊 Итоги составов участников</div>
          <table className="admin-table">
            <thead><tr><th>Участник</th><th>Статус состава</th><th>Сумма очков</th></tr></thead>
            <tbody>
              {[...lineupCards]
                .sort((a, b) => lineupTotal(b) - lineupTotal(a))
                .map((l, i) => (
                  <tr key={l.id || i}>
                    <td style={{ fontWeight: 600, color: "#F0EDE6" }}>{l._name}</td>
                    <td style={{ fontSize: 11, color: l.lineup_status === "submitted" ? "#86EFAC" : "#FDE68A" }}>{l.lineup_status || "draft"}</td>
                    <td style={{ fontFamily: "Oswald,sans-serif", fontWeight: 800, fontSize: 15, color: "#F59E0B" }}>{lineupTotal(l)}</td>
                  </tr>
                ))
              }
            </tbody>
          </table>
        </div>
      )}

      {sqlMissing && (
        <div style={{ marginTop: 16, background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.3)", borderRadius: 8, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#FCA5A5", marginBottom: 8 }}>⚠ Таблица ffc_round_player_scores не найдена. Выполни SQL:</div>
          <pre style={{ fontSize: 10, color: "rgba(240,237,230,.6)", background: "rgba(0,0,0,.3)", padding: 10, borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`CREATE TABLE IF NOT EXISTS public.ffc_round_player_scores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  round_id UUID REFERENCES public.ffc_rounds(id),
  player_id TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by UUID,
  UNIQUE(round_id, player_id)
);
ALTER TABLE public.ffc_round_player_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rps_select" ON public.ffc_round_player_scores FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "rps_insert" ON public.ffc_round_player_scores FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "rps_update" ON public.ffc_round_player_scores FOR UPDATE TO authenticated USING (true);`}</pre>
        </div>
      )}
      {!sqlMissing && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 11, color: "rgba(240,237,230,.3)" }}>SQL: создать ffc_round_player_scores (если нет)</summary>
          <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 10, borderRadius: 4, marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{`CREATE TABLE IF NOT EXISTS public.ffc_round_player_scores (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  round_id UUID REFERENCES public.ffc_rounds(id),
  player_id TEXT NOT NULL,
  points INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(round_id, player_id)
);`}</pre>
        </details>
      )}
    </div>
  );
}

function AdminPanel({ session, setSession, showToast, discipline, setDiscipline, onLeaderboardRecalc, onToggleLocked, onTogglePublic, predictionsLocked, predictionsPublic, onRejectPayment, onRoundCreated }) {
  const [adminTab, setAdminTab] = useState("admin_matches");
  const [users, setUsers] = useState([]);
  const [payments, setPayments] = useState([]);
  const [predictorTeamByUser, setPredictorTeamByUser] = useState({});
  const [adminUserStats, setAdminUserStats] = useState({});
  const [adminLineupPreview, setAdminLineupPreview] = useState(null);
  useEffect(() => {
    if (adminTab === "payments" || adminTab === "voronka") setAdminTab("admin_matches");
  }, [adminTab]);
  const [officialResults, setOfficialResults] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ffc_official_results") || "{}"); } catch { return {}; }
  });
  // predictionsLocked и predictionsPublic теперь приходят из App через props
  const [resultInputs, setResultInputs] = useState({});
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState(null);
  const [disciplineInputs, setDisciplineInputs] = useState({});
  const token = session?.access_token;

  async function getAdminToken() {
    const fresh = await getFreshToken(setSession).catch(() => null);
    if (fresh && !isJwtExpired(fresh)) return fresh;
    if (session?.access_token && !isJwtExpired(session.access_token)) return session.access_token;
    if (token && !isJwtExpired(token)) return token;
    return null;
  }

  useEffect(() => { loadUsers(); loadPayments(); loadPredictorTeams(); loadAdminUserStats(); loadUnifiedParticipants(); }, []);

  async function loadUsers() {
    const freshToken = await getAdminToken();
    const r = await supa("profiles?select=*&order=created_at.asc", { token: freshToken });
    if (r.ok) { const d = await r.json(); setUsers(d); }
  }
  async function loadPayments() {
    const freshToken = await getAdminToken();
    const r = await supa("payment_requests?select=*&order=created_at.desc", { token: freshToken });
    if (r.ok) { const d = await r.json(); setPayments(d); }
  }

  async function loadPredictorTeams() {
    const freshToken = await getAdminToken();
    const [mr, tr] = await Promise.all([
      supa("predictor_team_members?select=id,user_id,team_id", { token: freshToken }),
      supa("predictor_teams?select=id,name,code", { token: freshToken }),
    ]);
    if (!mr.ok || !tr.ok) {
      const mt = await mr.text().catch(() => "");
      const tt = await tr.text().catch(() => "");
      console.warn("admin predictor teams load failed", mr.status, mt, tr.status, tt);
      setPredictorTeamByUser({});
      return;
    }
    const members = await mr.json().catch(() => []);
    const teams = await tr.json().catch(() => []);
    const teamById = {};
    (Array.isArray(teams) ? teams : []).forEach(t => { if (t?.id) teamById[t.id] = t; });
    const map = {};
    (Array.isArray(members) ? members : []).forEach(row => {
      if (!row?.user_id) return;
      const team = teamById[row.team_id] || {};
      map[row.user_id] = { id: row.team_id || team.id || null, name: team.name || "", code: team.code || "" };
    });
    setPredictorTeamByUser(map);
  }

  async function loadAdminUserStats() {
    const freshToken = await getAdminToken();
    const empty = [];
    async function getRows(resp, label) {
      if (!resp?.ok) {
        const text = await resp?.text?.().catch(() => "");
        console.warn("admin user stats load failed", label, resp?.status, text);
        return empty;
      }
      const data = await resp.json().catch(() => empty);
      return Array.isArray(data) ? data : empty;
    }

    const lineupSelect = [
      "id", "user_id", "round_id", "lineup_status", "submitted_at", "created_at", "updated_at",
      "draft_answers", "captain_option_id",
      "coach_id", "goalkeeper_id", "defender_id", "defender2_id",
      "midfielder_id", "midfielder2_id", "forward_id", "forward2_id",
      "bench_player_id", "captain_player_id", "lineup_source"
    ].join(",");

    const [quizR, lineupsR, cupR, leagueR, playersR, draftSlotsR, draftOptionsR] = await Promise.all([
      supa("daily_text_quiz_attempts?select=user_id", { token: freshToken }),
      supa(`ffc_lineups?select=${lineupSelect}&order=updated_at.desc.nullslast,created_at.desc`, { token: freshToken }),
      supa("ffc_cup_entries?select=user_id,status,created_at", { token: freshToken }),
      supa("ffc_league_entries?select=user_id", { token: freshToken }),
      supa("ffc_players?select=id,name,national_team,position&limit=5000", { token: freshToken }),
      supa("ffc_round_draft_slots?select=id,round_id,slot_key,slot_label,slot_order,position", { token: freshToken }),
      supa("ffc_round_draft_options?select=id,round_id,slot_key,option_no,player_name,national_team,position,tag", { token: freshToken }),
    ]);

    const [quizRows, lineupRows, cupRows, leagueRows, playerRows, draftSlotRows, draftOptionRows] = await Promise.all([
      getRows(quizR, "daily_text_quiz_attempts"),
      getRows(lineupsR, "ffc_lineups"),
      getRows(cupR, "ffc_cup_entries"),
      getRows(leagueR, "ffc_league_entries"),
      getRows(playersR, "ffc_players"),
      getRows(draftSlotsR, "ffc_round_draft_slots"),
      getRows(draftOptionsR, "ffc_round_draft_options"),
    ]);

    const playerMap = {};
    playerRows.forEach(p => { if (p?.id) playerMap[p.id] = p; });
    const draftOptionsById = {};
    draftOptionRows.forEach(o => { if (o?.id) draftOptionsById[o.id] = o; });
    const draftSlotsByRound = {};
    draftSlotRows.forEach(sl => {
      const rid = sl?.round_id || "__no_round__";
      if (!draftSlotsByRound[rid]) draftSlotsByRound[rid] = [];
      draftSlotsByRound[rid].push(sl);
    });
    Object.values(draftSlotsByRound).forEach(arr => arr.sort((a, b) => (a.slot_order || 0) - (b.slot_order || 0)));

    // Fallback-драфт: если пользователь сохранял состав из встроенного драфта,
    // в БД ffc_round_draft_options может не быть вариантов. Тогда админка
    // всё равно должна показывать имена, а не пустые тире/UUID.
    const ADMIN_FFC_FALLBACK_ROUND_ID = "00000000-0000-4000-8000-000000000001";
    const ADMIN_FFC_FALLBACK_DRAFT_CSV = `round_no,slot_key,slot_label,slot_order,position,option_no,player_name,national_team,tag,is_recommended
1,coach,Тренер,1,coach,1,Lionel Scaloni,Аргентина,Надёжный,true
1,coach,Тренер,1,coach,2,Didier Deschamps,Франция,Опыт,false
1,coach,Тренер,1,coach,3,Julian Nagelsmann,Германия,Форма,false
1,coach,Тренер,1,coach,4,Luis de la Fuente,Испания,Система,false
1,coach,Тренер,1,coach,5,Marcelo Bielsa,Уругвай,Риск,false
1,goalkeeper,Вратарь,2,goalkeeper,1,Guillermo Ochoa,Мексика,Опыт,false
1,goalkeeper,Вратарь,2,goalkeeper,2,Ronwen Williams,ЮАР,Сейвы,false
1,goalkeeper,Вратарь,2,goalkeeper,3,Mat Ryan,Австралия,Надёжный,false
1,goalkeeper,Вратарь,2,goalkeeper,4,Gregor Kobel,Швейцария,Звезда,false
1,goalkeeper,Вратарь,2,goalkeeper,5,Emiliano Martinez,Аргентина,Звезда,true
1,defender1,Защитник 1,3,defender,1,Achraf Hakimi,Марокко,Звезда,true
1,defender1,Защитник 1,3,defender,2,Virgil van Dijk,Нидерланды,Надёжный,false
1,defender1,Защитник 1,3,defender,3,Kalidou Koulibaly,Сенегал,Опыт,false
1,defender1,Защитник 1,3,defender,4,Josko Gvardiol,Хорватия,Форма,false
1,defender1,Защитник 1,3,defender,5,Wilfried Singo,Кот-д'Ивуар,Скрытый вариант,false
1,defender2,Защитник 2,4,defender,1,Kim Min-jae,Республика Корея,Надёжный,false
1,defender2,Защитник 2,4,defender,2,Marquinhos,Бразилия,Опыт,false
1,defender2,Защитник 2,4,defender,3,John Stones,Англия,Надёжный,false
1,defender2,Защитник 2,4,defender,4,Alphonso Davies,Канада,Атака,true
1,defender2,Защитник 2,4,defender,5,Nuno Mendes,Португалия,Форма,false
1,defender3,Защитник из андердогов,5,defender,1,Liberato Cacace,Новая Зеландия,Андердог,false
1,defender3,Защитник из андердогов,5,defender,2,Stopira,Кабо-Верде,Андердог,false
1,defender3,Защитник из андердогов,5,defender,3,Michael Amir Murillo,Панама,Андердог,true
1,defender3,Защитник из андердогов,5,defender,4,Abdukodir Khusanov,Узбекистан,Андердог,false
1,defender3,Защитник из андердогов,5,defender,5,Jurien Gaari,Кюрасао,Андердог,false
1,defender4,Защитник 4,6,defender,1,Sead Kolasinac,Босния и Герцеговина,Опыт,false
1,defender4,Защитник 4,6,defender,2,Lucas Mendes,Катар,Надёжный,false
1,defender4,Защитник 4,6,defender,3,Chris Richards,США,Риск,false
1,defender4,Защитник 4,6,defender,4,Andy Robertson,Шотландия,Атака,true
1,defender4,Защитник 4,6,defender,5,Antonee Robinson,США,Форма,false
1,midfielder1,Полузащитник 1,7,midfielder,1,Jude Bellingham,Англия,Звезда,true
1,midfielder1,Полузащитник 1,7,midfielder,2,Pedri,Испания,Контроль,false
1,midfielder1,Полузащитник 1,7,midfielder,3,Federico Valverde,Уругвай,Мотор,false
1,midfielder1,Полузащитник 1,7,midfielder,4,Kevin De Bruyne,Бельгия,Ассистент,false
1,midfielder1,Полузащитник 1,7,midfielder,5,Jamal Musiala,Германия,Дриблинг,false
1,midfielder2,Полузащитник 2,8,midfielder,1,Granit Xhaka,Швейцария,Надёжный,false
1,midfielder2,Полузащитник 2,8,midfielder,2,Hakan Calhanoglu,Турция,Пенальтист,true
1,midfielder2,Полузащитник 2,8,midfielder,3,Moises Caicedo,Эквадор,Отбор,false
1,midfielder2,Полузащитник 2,8,midfielder,4,Takefusa Kubo,Япония,Риск,false
1,midfielder2,Полузащитник 2,8,midfielder,5,Mohammed Kudus,Гана,Скрытый вариант,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,1,Zidane Iqbal,Ирак,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,2,Noor Al-Rawabdeh,Иордания,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,3,Jean-Ricner Bellegarde,Гаити,Андердог,true
1,midfielder3,Полузащитник из андердогов,9,midfielder,4,Aissa Laidouni,Тунис,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,5,Jackson Irvine,Австралия,Андердог,false
1,midfielder4,Полузащитник 4,10,midfielder,1,Miguel Almiron,Парагвай,Форма,false
1,midfielder4,Полузащитник 4,10,midfielder,2,Ismael Bennacer,Алжир,Контроль,false
1,midfielder4,Полузащитник 4,10,midfielder,3,Marcel Sabitzer,Австрия,Удар,false
1,midfielder4,Полузащитник 4,10,midfielder,4,Richard Rios,Колумбия,Мотор,false
1,midfielder4,Полузащитник 4,10,midfielder,5,Salem Al-Dawsari,Саудовская Аравия,Риск,true
1,forward1,Нападающий 1,11,forward,1,Kylian Mbappe,Франция,Звезда,true
1,forward1,Нападающий 1,11,forward,2,Эрлинг Холанд,Норвегия,Гол,false
1,forward1,Нападающий 1,11,forward,3,Lionel Messi,Аргентина,Магия,false
1,forward1,Нападающий 1,11,forward,4,Vinicius Jr,Бразилия,Дриблинг,false
1,forward1,Нападающий 1,11,forward,5,Cristiano Ronaldo,Португалия,Опыт,false
1,forward2,Нападающий 2,12,forward,1,Mohamed Salah,Египет,Звезда,true
1,forward2,Нападающий 2,12,forward,2,Alexander Isak,Швеция,Форма,false
1,forward2,Нападающий 2,12,forward,3,Mehdi Taremi,Иран,Пенальтист,false
1,forward2,Нападающий 2,12,forward,4,Yoane Wissa,ДР Конго,Скрытый вариант,false
1,forward2,Нападающий 2,12,forward,5,Patrik Schick,Чехия,Гол,false`;
    function adminFallbackOptionUuid(slotOrder, optionNo) {
      const tail = String((Number(slotOrder) || 0) * 100 + (Number(optionNo) || 0)).padStart(12, "0");
      return `00000000-0000-4000-8000-${tail}`;
    }
    try {
      const lines = ADMIN_FFC_FALLBACK_DRAFT_CSV.trim().split(/\r?\n/).filter(Boolean);
      const header = lines.shift().split(",").map(x => x.trim());
      const fallbackSlots = new Map();
      lines.forEach(line => {
        const parts = line.split(",").map(x => x.trim());
        const row = {};
        header.forEach((h, i) => row[h] = parts[i] || "");
        const slotOrder = Number(row.slot_order || 999);
        const optionNo = Number(row.option_no || 0);
        const optionId = adminFallbackOptionUuid(slotOrder, optionNo);
        if (!fallbackSlots.has(row.slot_key)) {
          fallbackSlots.set(row.slot_key, {
            id: `fallback-slot-${row.slot_key}`,
            round_id: ADMIN_FFC_FALLBACK_ROUND_ID,
            slot_key: row.slot_key,
            slot_label: row.slot_label,
            slot_order: slotOrder,
            position: row.position,
          });
        }
        if (!draftOptionsById[optionId]) {
          draftOptionsById[optionId] = {
            id: optionId,
            round_id: ADMIN_FFC_FALLBACK_ROUND_ID,
            slot_key: row.slot_key,
            option_no: optionNo,
            player_name: row.player_name,
            national_team: row.national_team,
            position: row.position,
            tag: row.tag,
          };
        }
      });
      if (!draftSlotsByRound[ADMIN_FFC_FALLBACK_ROUND_ID]) {
        draftSlotsByRound[ADMIN_FFC_FALLBACK_ROUND_ID] = Array.from(fallbackSlots.values()).sort((a, b) => (a.slot_order || 999) - (b.slot_order || 999));
      }
    } catch (e) {
      console.warn("admin fallback draft parse failed", e);
    }
    const slotDefs = [
      ["coach_id", "Тренер"], ["goalkeeper_id", "Вратарь"],
      ["defender_id", "Защитник 1"], ["defender2_id", "Защитник 2"],
      ["midfielder_id", "Полузащитник 1"], ["midfielder2_id", "Полузащитник 2"],
      ["forward_id", "Нападающий 1"], ["forward2_id", "Нападающий 2"],
      ["bench_player_id", "Запасной"],
    ];
    const parseJsonishObject = (value) => {
      if (!value) return null;
      if (typeof value === "object") return value;
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed || trimmed === "null") return null;
        try {
          const parsed = JSON.parse(trimmed);
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
      return null;
    };
    const getDraftAnswerId = (raw) => {
      if (!raw) return null;
      if (typeof raw === "string") return raw;
      if (typeof raw === "object") return raw.option_id || raw.optionId || raw.id || raw.value || raw.uuid || null;
      return String(raw);
    };
    const getDraftAnswerInfo = (raw) => {
      if (!raw || typeof raw !== "object") return {};
      return {
        player_name: raw.player_name || raw.name || raw.player || raw.playerName || "",
        national_team: raw.national_team || raw.team || raw.country || raw.nationalTeam || "",
        position: raw.position || "",
        slot_label: raw.slot_label || raw.slotLabel || "",
        slot_order: raw.slot_order || raw.slotOrder || 0,
        tag: raw.tag || "",
      };
    };
    const isCompleteClassicLineup = (l) => !!(l?.coach_id && l?.goalkeeper_id && l?.defender_id && l?.defender2_id && l?.midfielder_id && l?.midfielder2_id && l?.forward_id && l?.forward2_id && l?.captain_player_id);
    const isCompleteDraftLineup = (l) => {
      const answers = parseJsonishObject(l?.draft_answers);
      if (!answers) return false;
      const answered = Object.values(answers).filter(v => !!getDraftAnswerId(v)).length;
      const roundSlots = draftSlotsByRound[l.round_id] || [];
      const required = roundSlots.length || Math.max(1, Object.keys(answers).length);
      return answered >= required && !!l.captain_option_id;
    };
    const enrichLineup = (l) => {
      if (!l) return null;
      const answers = parseJsonishObject(l.draft_answers);
      if (answers && Object.keys(answers).length) {
        const defaultDraftSlotMeta = {
          coach: { slot_label: "Тренер", slot_order: 1, position: "coach" },
          goalkeeper: { slot_label: "Вратарь", slot_order: 2, position: "goalkeeper" },
          defender1: { slot_label: "Защитник 1", slot_order: 3, position: "defender" },
          defender2: { slot_label: "Защитник 2", slot_order: 4, position: "defender" },
          defender3: { slot_label: "Защитник из андердогов", slot_order: 5, position: "defender" },
          defender4: { slot_label: "Защитник 4", slot_order: 6, position: "defender" },
          midfielder1: { slot_label: "Полузащитник 1", slot_order: 7, position: "midfielder" },
          midfielder2: { slot_label: "Полузащитник 2", slot_order: 8, position: "midfielder" },
          midfielder3: { slot_label: "Полузащитник из андердогов", slot_order: 9, position: "midfielder" },
          midfielder4: { slot_label: "Полузащитник 4", slot_order: 10, position: "midfielder" },
          forward1: { slot_label: "Нападающий 1", slot_order: 11, position: "forward" },
          forward2: { slot_label: "Нападающий 2", slot_order: 12, position: "forward" },
        };
        const roundSlots = (draftSlotsByRound[l.round_id] && draftSlotsByRound[l.round_id].length ? draftSlotsByRound[l.round_id] : Object.keys(answers).map((key, idx) => ({ slot_key: key, ...(defaultDraftSlotMeta[key] || { slot_label: key, slot_order: idx + 1 }) }))).sort((a,b)=>(a.slot_order||999)-(b.slot_order||999));
        const slots = roundSlots.map(sl => {
          const rawAnswer = answers[sl.slot_key];
          const optionId = getDraftAnswerId(rawAnswer);
          const savedInfo = getDraftAnswerInfo(rawAnswer);
          const opt = optionId ? draftOptionsById[optionId] : null;
          return {
            key: sl.slot_key,
            label: savedInfo.slot_label || sl.slot_label || sl.slot_key,
            playerId: optionId,
            name: opt?.player_name || savedInfo.player_name || (optionId ? `ID варианта: ${String(optionId).slice(0, 8)}…` : "—"),
            team: opt?.national_team || savedInfo.national_team || "",
            position: opt?.position || savedInfo.position || sl.position || "",
            isCaptain: !!optionId && optionId === l.captain_option_id,
            tag: opt?.tag || savedInfo.tag || "",
            playerFoundInDb: !!(opt?.player_name || savedInfo.player_name),
          };
        });
        const hasAnyPlayer = slots.some(s => s.playerId);
        return { ...l, slots, isComplete: isCompleteDraftLineup(l), isDraftFormat: true, hasAnyPlayer };
      }

      const slots = slotDefs.map(([key, label]) => {
        const pid = l[key];
        const pl = pid ? playerMap[pid] : null;
        // Диагностика: если pid есть, но игрок не найден в playerMap — показываем UUID
        const name = pl?.name
          || (pid ? `⚠ UUID ${String(pid).slice(0, 8)}… (не найден в ffc_players)` : "—");
        return {
          key, label,
          playerId: pid || null,
          name,
          team: pl?.national_team || "",
          position: pl?.position || "",
          isCaptain: pid && pid === l.captain_player_id,
          playerFoundInDb: !!pl,
        };
      });
      const hasAnyPlayer = slots.some(s => s.playerId);
      const allUUIDsUnresolved = hasAnyPlayer && slots.filter(s => s.playerId).every(s => !s.playerFoundInDb);
      return {
        ...l, slots,
        isComplete: isCompleteClassicLineup(l),
        isDraftFormat: false,
        hasAnyPlayer,
        allUUIDsUnresolved, // флаг: все UUID есть, но ни один не найден в playerMap
      };
    };

    const map = {};
    const ensure = (uid) => {
      if (!uid) return null;
      if (!map[uid]) map[uid] = { quizCount: 0, lineupCount: 0, lineupSubmitted: 0, lineupDraft: 0, cupEntry: false, leagueEntry: false, latestLineup: null };
      return map[uid];
    };
    quizRows.forEach(r => { const st = ensure(r?.user_id); if (st) st.quizCount += 1; });
    lineupRows.forEach(r => {
      const st = ensure(r?.user_id); if (!st) return;
      const full = enrichLineup(r);
      st.lineupCount += 1;
      // Состав считается отправленным только если реально есть выбранные игроки
      const hasPlayers = full?.isComplete || full?.hasAnyPlayer;
      if ((r?.lineup_status === "submitted" || r?.submitted_at) && hasPlayers) st.lineupSubmitted += 1;
      else if (r?.lineup_status === "submitted" || r?.submitted_at) st.lineupDraft += 1; // есть запись, но игроки пустые
      else st.lineupDraft += 1;
      // Для просмотра выбираем не просто последнюю строку, а последнюю непустую.
      // Иначе админка могла открыть строку со статусом submitted, но без состава.
      if (!st.latestLineup || (!st.latestLineup.hasAnyPlayer && full?.hasAnyPlayer)) st.latestLineup = full;
    });
    cupRows.forEach(r => { const st = ensure(r?.user_id); if (st) st.cupEntry = true; });
    leagueRows.forEach(r => { const st = ensure(r?.user_id); if (st) st.leagueEntry = true; });
    setAdminUserStats(map);
  }

  function openAdminLineupPreview(user) {
    const st = adminUserStats?.[user.id];
    if (!st?.latestLineup) { showToast("Состав БК не найден"); return; }
    setAdminLineupPreview({ user, lineup: st.latestLineup });
  }

  function adminTeamLabel(userId) {
    const t = predictorTeamByUser?.[userId];
    if (!t?.name) return "—";
    return t.code ? `${t.name} · ${t.code}` : t.name;
  }

  async function confirmPayment(pid, uid, plan) {
    // Продажи: подтверждаем оплату главного турнира. F-Coins НЕ начисляются покупателю за саму оплату.
    // F-Coins остаются очками активности: квиз + рефералка. За оплатившего друга пригласителю +100 F-Coins.
    const payCheck = await supa(`payment_requests?id=eq.${pid}&select=status`, { token });
    if (payCheck.ok) {
      const pd = await payCheck.json();
      if (pd[0]?.status === "confirmed") {
        showToast("⚠ Оплата уже подтверждена.");
        return;
      }
    }

    let level = ACCESS.PROGNOSTISTA;
    let note = "";
    let friendSlotNote = null;

    if (plan === "prognostista") {
      level = ACCESS.PROGNOSTISTA;
    } else if (plan === "full") {
      // legacy — даём полный доступ и лигу, но без F-Coins за покупку
      level = ACCESS.FULL;
    } else if (plan === "friend") {
      level = ACCESS.PROGNOSTISTA;
      friendSlotNote = "friend_pack:1_of_2";
      note = "Пакет на 2 участия — активировано 1 из 2. Активируй второго участника вручную.";
    } else if (plan === "ffc_add") {
      // legacy-доступ к FFC: отдельный флаг, без F-Coins за покупку
    }

    const confirmedAt = new Date().toISOString();

    await supa(`payment_requests?id=eq.${pid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "confirmed", confirmed_at: confirmedAt, ...(friendSlotNote ? { comment: friendSlotNote } : {}) }),
    });

    const profilePatch = plan === "ffc_add"
      ? { ffc_league_access: true }
      : { access_level: level, is_paid: true, prediction_status: "submitted" };

    await supa(`profiles?id=eq.${uid}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify(profilePatch),
    });

    // Обновляем статус участника, чтобы админка сразу видела оплаченных/одобренных
    try {
      await supa("participant_status", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: uid,
          status: "approved",
          has_started_predictions: true,
          has_submitted_predictions: true,
          has_paid: true,
          is_approved: true,
          paid_at: confirmedAt,
          approved_at: confirmedAt,
          updated_at: confirmedAt,
        }),
      });
    } catch (e) {
      console.warn("participant_status confirm sync skipped", e);
    }

    // Реферальный бонус: +100 F-Coins пригласившему, только один раз за оплатившего друга
    try {
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
            const refBonus = 100;
            await supa("fcoin_transactions", {
              method: "POST", token, headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ user_id: referrerId, amount: refBonus, type: "earn", reason: "Реферальный бонус: друг оплатил турнир", related_user_id: uid }),
            });
            const refProf = await supa(`profiles?id=eq.${referrerId}&select=fcoins_balance`, { token });
            if (refProf.ok) {
              const refCur = (await refProf.json())[0]?.fcoins_balance || 0;
              await supa(`profiles?id=eq.${referrerId}`, {
                method: "PATCH", token, headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ fcoins_balance: refCur + refBonus }),
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn("referral bonus skipped", e);
    }

    await loadUsers();
    await loadPayments();
    await loadPredictorTeams();
    showToast("✓ Оплата подтверждена" + (note ? ` · ${note}` : ""));
  }

  async function rejectPayment(pid, uid) {
    await supa(`payment_requests?id=eq.${pid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "rejected" }) });
    // Возвращаем prediction_status в draft в БД
    if (uid) {
      await supa(`profiles?id=eq.${uid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ prediction_status: "draft" }) });
    }
    await loadPayments();
    await loadPredictorTeams();
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


  async function deleteUserAndData(user) {
    if (!user?.id) return;
    if (session?.user?.id && user.id === session.user.id) {
      showToast("Нельзя удалить текущего админ-пользователя из этой кнопки");
      return;
    }
    const name = getDisplayName(user) || user.email || user.id;
    const ok = window.confirm(`Удалить пользователя «${name}» и все его прогнозы/заявки из базы приложения?\n\nЭто не удалит аккаунт из auth.users Supabase, но уберёт его из админки и таблиц приложения.`);
    if (!ok) return;
    const ok2 = window.confirm("Точно удалить? Действие нельзя отменить без бэкапа.");
    if (!ok2) return;

    const uid = encodeURIComponent(user.id);
    const deletions = [
      ["predictions", `predictions?user_id=eq.${uid}`],
      ["bonus_answers", `bonus_answers?user_id=eq.${uid}`],
      ["participant_status", `participant_status?user_id=eq.${uid}`],
      ["payment_requests", `payment_requests?user_id=eq.${uid}`],
      ["predictor_team_members", `predictor_team_members?user_id=eq.${uid}`],
      ["ffc_lineups", `ffc_lineups?user_id=eq.${uid}`],
      ["ffc_cup_entries", `ffc_cup_entries?user_id=eq.${uid}`],
      ["ffc_league_entries", `ffc_league_entries?user_id=eq.${uid}`],
      ["daily_text_quiz_attempts", `daily_text_quiz_attempts?user_id=eq.${uid}`],
      ["fcoin_transactions", `fcoin_transactions?user_id=eq.${uid}`],
      ["leaderboard by user_id", `leaderboard?user_id=eq.${uid}`],
      ["leaderboard by id", `leaderboard?id=eq.${uid}`],
      ["profiles", `profiles?id=eq.${uid}`],
    ];

    const failed = [];
    for (const [label, path] of deletions) {
      try {
        const r = await supa(path, { method: "DELETE", token, headers: { Prefer: "return=minimal" } });
        if (!r.ok && r.status !== 404) {
          const text = await r.text().catch(() => "");
          // Игнорируем ошибки про отсутствующую колонку/таблицу для вспомогательных таблиц,
          // потому что в разных версиях приложения часть таблиц могла не существовать.
          if (!/does not exist|column .* does not exist|relation .* does not exist/i.test(text)) {
            failed.push(`${label}: ${r.status} ${text.slice(0, 120)}`);
          }
        }
      } catch (e) {
        failed.push(`${label}: ${e?.message || e}`);
      }
    }

    await loadPayments();
    await loadUsers();
    if (failed.length) {
      console.warn("delete user partial failures", failed);
      showToast(`Удаление частично выполнено. Ошибок: ${failed.length}. Смотри консоль.`);
    } else {
      showToast(`✓ Пользователь «${name}» удалён из таблиц приложения`);
    }
  }
  // ── UNIFIED PARTICIPANTS STATE ──
  const [uniLoading, setUniLoading] = useState(false);
  const [uniFilter, setUniFilter] = useState("all");
  const [uniRows, setUniRows] = useState([]);
  const [lineupModal, setLineupModal] = useState(null); // { user, lineup }

  async function loadUnifiedParticipants() {
    setUniLoading(true);
    try {
      const freshToken = await getAdminToken();
      const fetchAll = async (path) => {
        const rows = [];
        const PAGE = 1000;
        for (let page = 0; page < 50; page++) {
          const sep = path.includes("?") ? "&" : "?";
          const r = await supa(`${path}${sep}limit=${PAGE}&offset=${page * PAGE}`, { token: freshToken });
          if (!r.ok) break;
          const chunk = await r.json().catch(() => []);
          const arr = Array.isArray(chunk) ? chunk : [];
          rows.push(...arr);
          if (arr.length < PAGE) break;
        }
        return rows;
      };

      const [profileRows, statusRows, payRows, predRows, bonusRows, lineupRows, quizRows, teamMemberRows, teamRows] = await Promise.all([
        fetchAll("profiles?select=*&order=created_at.asc"),
        fetchAll("participant_status?select=*"),
        fetchAll("payment_requests?select=*&order=created_at.desc"),
        fetchAll("predictions?select=user_id,match_id"),
        fetchAll("bonus_answers?select=user_id,question_id"),
        fetchAll("ffc_lineups?select=id,user_id,lineup_status,submitted_at,updated_at,created_at,draft_answers,captain_option_id&order=updated_at.desc.nullslast,created_at.desc"),
        fetchAll("daily_text_quiz_attempts?select=user_id"),
        fetchAll("predictor_team_members?select=user_id,team_id").catch(() => []),
        fetchAll("predictor_teams?select=id,name,code").catch(() => []),
      ]);

      // Build lookup maps
      const profileMap = {}; // id → profile
      profileRows.forEach(u => { if (u?.id) profileMap[u.id] = u; });

      const statusMap = {}; // user_id → status row
      statusRows.forEach(r => { if (r?.user_id) statusMap[r.user_id] = r; });

      // payment: user_id/email → latest row + best comment
      const payByUser = {};
      const payByEmail = {};
      payRows.forEach(p => {
        const key = p.user_id;
        if (key) {
          if (!payByUser[key] || (p.created_at > (payByUser[key].created_at || ""))) payByUser[key] = p;
          const prev = payByUser[key];
          if (!prev._comment && p.comment) payByUser[key]._comment = p.comment;
        }
        if (p.user_email) {
          if (!payByEmail[p.user_email] || (p.created_at > (payByEmail[p.user_email].created_at || ""))) payByEmail[p.user_email] = p;
        }
      });

      // predictions count by user_id — group vs playoff
      const predCount = {}; // uid → { group, playoff, total }
      predRows.forEach(r => {
        if (!r?.user_id) return;
        if (!predCount[r.user_id]) predCount[r.user_id] = { group: 0, playoff: 0 };
        const mid = String(r.match_id || "");
        if (ALL_GROUP_MATCH_IDS.has(mid)) predCount[r.user_id].group++;
        else predCount[r.user_id].playoff++;
      });

      // bonus count by user_id
      const bonusCount = {};
      bonusRows.forEach(r => { if (r?.user_id) bonusCount[r.user_id] = (bonusCount[r.user_id] || 0) + 1; });

      // quiz count by user_id
      const quizCountMap = {};
      quizRows.forEach(r => { if (r?.user_id) quizCountMap[r.user_id] = (quizCountMap[r.user_id] || 0) + 1; });

      // lineup by user_id: best non-empty lineup
      const lineupMap = {};
      lineupRows.forEach(r => {
        if (!r?.user_id) return;
        const hasDraft = r.draft_answers && JSON.stringify(r.draft_answers) !== "{}";
        const existing = lineupMap[r.user_id];
        if (!existing) { lineupMap[r.user_id] = { ...r, _hasDraft: hasDraft }; return; }
        if (!existing._hasDraft && hasDraft) lineupMap[r.user_id] = { ...r, _hasDraft: hasDraft };
      });

      // team by user_id
      const teamById = {};
      teamRows.forEach(t => { if (t?.id) teamById[t.id] = t; });
      const teamByUser = {};
      teamMemberRows.forEach(m => { if (m?.user_id) teamByUser[m.user_id] = teamById[m.team_id] || {}; });

      // Collect all user IDs: from profiles + from payments (email only)
      const allUsers = [];
      const seenEmails = new Set();
      const seenIds = new Set();

      profileRows.forEach(u => {
        seenIds.add(u.id);
        if (u.email) seenEmails.add(u.email.toLowerCase());
        allUsers.push({ _type: "profile", ...u });
      });

      // Add payment-only rows (email without profile)
      payRows.forEach(p => {
        if (!p.user_id || !profileMap[p.user_id]) {
          const email = (p.user_email || "").toLowerCase();
          if (email && !seenEmails.has(email)) {
            seenEmails.add(email);
            allUsers.push({ _type: "payment_only", id: null, email: p.user_email, name: p.user_email, display_name: null, _payRow: p });
          }
        }
      });

      // Detect duplicate emails
      const emailCount = {};
      allUsers.forEach(u => { if (u.email) emailCount[u.email.toLowerCase()] = (emailCount[u.email.toLowerCase()] || 0) + 1; });

      const rows = allUsers.map(u => {
        const uid = u.id;
        const pay = uid ? payByUser[uid] : u._payRow;
        const payConfirmed = pay?.status === "confirmed";
        const payPending = pay?.status === "pending";
        const pCount = uid ? (predCount[uid] || { group: 0, playoff: 0 }) : { group: 0, playoff: 0 };
        const pTotal = pCount.group + pCount.playoff;
        const bCount = uid ? (bonusCount[uid] || 0) : 0;
        const quizCnt = uid ? (quizCountMap[uid] || 0) : 0;
        const lineup = uid ? lineupMap[uid] : null;
        const lineupHasDraft = lineup?._hasDraft;
        const lineupSubmitted = lineupHasDraft && (lineup?.lineup_status === "submitted" || lineup?.submitted_at);
        const team = uid ? (teamByUser[uid] || null) : null;
        const st = uid ? (statusMap[uid] || {}) : {};
        const isPaid = payConfirmed || u.is_paid === true || [ACCESS.PROGNOSTISTA, ACCESS.FULL, ACCESS.ADMIN].includes(u.access_level);
        const isDupe = (u.email && emailCount[u.email.toLowerCase()] > 1);

        // Overall status
        const predOk = pTotal >= 104 && pCount.group >= 72 && pCount.playoff >= 32;
        const bonusOk = bCount >= 31;
        let overallStatus = "new";
        if (isPaid && predOk && bonusOk) overallStatus = "ok";
        else if (isPaid || pTotal > 0 || bCount > 0) overallStatus = pTotal > 0 ? (predOk ? "done" : "filling") : "paid_no_pred";
        if (!isPaid && pTotal === 0 && bCount === 0) overallStatus = "new";

        return { u, uid, pay, payConfirmed, payPending, isPaid, pCount, pTotal, bCount, quizCnt, lineup, lineupHasDraft, lineupSubmitted, team, st, predOk, bonusOk, overallStatus, isDupe, isDraftType: u._type === "payment_only" };
      });

      setUniRows(rows);
    } catch (e) {
      console.error("loadUnifiedParticipants failed", e);
      showToast("Ошибка загрузки участников: " + (e?.message || ""));
    } finally {
      setUniLoading(false);
    }
  }

  function uniFilteredRows() {
    return uniRows.filter(r => {
      switch (uniFilter) {
        case "all": return true;
        case "new": return r.overallStatus === "new";
        case "filling": return r.pTotal > 0 && !r.predOk;
        case "full_pred": return r.predOk;
        case "incomplete": return r.pTotal > 0 && !r.predOk;
        case "paid": return r.isPaid;
        case "pending": return r.payPending && !r.payConfirmed;
        case "approved": return r.isPaid;
        case "has_lineup": return !!r.lineup;
        case "no_lineup": return !r.lineup;
        default: return true;
      }
    });
  }

  const planLabel = { prognostista: "Битва прогнозистов 500₽", ffc_add: "Архивный тариф", friend: "Архивный тариф", full: "Архивный тариф" };
  const accessLabel = { [ACCESS.DEMO]: "Черновик", [ACCESS.PROGNOSTISTA]: "Прогнозиста", [ACCESS.FULL]: "Полный", [ACCESS.ADMIN]: "Админ" };
  const accessBadge = { [ACCESS.DEMO]: "badge-demo", [ACCESS.PROGNOSTISTA]: "badge-paid", [ACCESS.FULL]: "badge-full", [ACCESS.ADMIN]: "badge-admin" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(18px,1.4vw,24px)", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>Админка</span>
        <span className="tag tr">Только для организатора</span>
      </div>
      <div className="tabs">
        {[["admin_matches", "🏟 Матчи"], ["admin_bonus", "🧠 Бонусы"], ["admin_playoff_pairs", "⚔ Плей-офф пары"], ["admin_ffc_scores", "⚽ Битва клубов"]].map(([k, l]) => (
          <button key={k} className={`tab${adminTab === k ? " on" : ""}`} style={{ minWidth: 100 }} onClick={() => setAdminTab(k)}>{l}</button>
        ))}
      </div>

      {adminTab === "admin_matches" && <AdminMatchesPanel session={session} showToast={showToast} />}
      {adminTab === "admin_bonus" && <AdminBonusPanel session={session} showToast={showToast} />}
      {adminTab === "admin_playoff_pairs" && <AdminPlayoffPairsPanel session={session} showToast={showToast} />}
      {adminTab === "admin_ffc_scores" && <AdminFfcScoresPanel session={session} showToast={showToast} />}

      {/* ── СТАРЫЕ ВКЛАДКИ СКРЫТЫ — код сохранён но не рендерится ── */}
      {false && <>

      {/* ЗАЯВКИ */}
      {adminTab === "payments" && (
        <div className="panel">
          <div className="ph"><span className="pt">Заявки на оплату</span><span className="tag ty">{payments.filter((p) => p.status === "pending").length} ожидают</span></div>
          {payments.length === 0 && <div style={{ padding: "24px", textAlign: "center", fontSize: 13, color: "rgba(240,237,230,.3)" }}>Заявок пока нет</div>}
          <table className="admin-table">
            <thead><tr><th>Участник</th><th>Команда</th><th>Тариф</th><th>Сумма</th><th>Комментарий</th><th>Дата</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontSize: 12, color: "#F0EDE6" }}>{p.user_email || p.user_id?.slice(0, 8)}</td>
                  <td style={{ fontSize: 11, color: predictorTeamByUser?.[p.user_id]?.name ? "#FDE68A" : "rgba(240,237,230,.35)", fontWeight: predictorTeamByUser?.[p.user_id]?.name ? 700 : 400 }}>{adminTeamLabel(p.user_id)}</td>
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

      {/* ТАБЛИЦА ПРОГНОЗОВ */}
      {adminTab === "forecast_table" && (
        <AdminForecastTable session={session} showToast={showToast} />
      )}

      {/* БИТВА КЛУБОВ */}
      {adminTab === "club_battle" && (
        <AdminClubBattlePanel session={session} showToast={showToast} />
      )}

      {/* ═══════════ УЧАСТНИКИ — ГЛАВНАЯ ВКЛАДКА ═══════════ */}
      {adminTab === "users" && (() => {
        const filtered = uniFilteredRows();
        // stat cards
        const total = uniRows.length;
        const started = uniRows.filter(r => r.pTotal > 0).length;
        const fullPred = uniRows.filter(r => r.predOk).length;
        const partialPred = uniRows.filter(r => r.pTotal > 0 && !r.predOk).length;
        const paidCnt = uniRows.filter(r => r.isPaid).length;
        const lineupCnt = uniRows.filter(r => r.lineupSubmitted).length;
        const quizCnt = uniRows.filter(r => r.quizCnt > 0).length;

        const FILTERS = [
          ["all", `Все (${total})`],
          ["new", "Новые"],
          ["filling", "Заполняют"],
          ["full_pred", `Заполнили прогноз (${fullPred})`],
          ["incomplete", `Неполные (${partialPred})`],
          ["paid", `Оплатили (${paidCnt})`],
          ["pending", "Ждут оплату"],
          ["approved", "Одобрены"],
          ["has_lineup", "Состав БК есть"],
          ["no_lineup", "Состав БК нет"],
        ];

        return (
          <div>
            {/* Stat cards */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              {[
                ["👤", "Зарегистрировались", total],
                ["✏️", "Начали прогноз", started],
                ["✅", "Полный прогноз", fullPred],
                ["⚠️", "Неполный", partialPred],
                ["💰", "Оплатили", paidCnt],
                ["🏆", "Одобрены", paidCnt],
                ["⚽", "Состав БК", lineupCnt],
                ["🧠", "Квиз", quizCnt],
              ].map(([icon, label, val]) => (
                <div key={label} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "8px 14px", minWidth: 90 }}>
                  <div style={{ fontSize: 18 }}>{icon}</div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#F59E0B", lineHeight: 1 }}>{val}</div>
                  <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", marginTop: 2 }}>{label}</div>
                </div>
              ))}
            </div>

            {/* Filters + reload */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
              {FILTERS.map(([k, l]) => (
                <button key={k} className={`tab${uniFilter === k ? " on" : ""}`} style={{ fontSize: 11, padding: "4px 10px", minWidth: "auto" }} onClick={() => setUniFilter(k)}>{l}</button>
              ))}
              <button className="sb" style={{ marginLeft: "auto", fontSize: 11 }} onClick={() => loadUnifiedParticipants()}>
                {uniLoading ? "Загружаю…" : "↻ Обновить"}
              </button>
            </div>

            {uniLoading && <div style={{ padding: "20px", color: "rgba(240,237,230,.4)", fontSize: 13 }}>Загружаю участников…</div>}
            {!uniLoading && filtered.length === 0 && <div style={{ padding: "20px", color: "rgba(240,237,230,.4)", fontSize: 13, textAlign: "center" }}>Нет участников по выбранному фильтру</div>}

            {!uniLoading && filtered.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table className="admin-table" style={{ minWidth: 1100 }}>
                  <thead>
                    <tr>
                      <th style={{ minWidth: 140 }}>Имя</th>
                      <th style={{ minWidth: 160 }}>Email</th>
                      <th>Команда</th>
                      <th>Оплата</th>
                      <th style={{ minWidth: 120 }}>Комментарий</th>
                      <th>Прогноз</th>
                      <th>Вопросы</th>
                      <th>Состав БК</th>
                      <th>Квизы</th>
                      <th>Статус</th>
                      <th style={{ minWidth: 200 }}>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row, idx) => {
                      const { u, uid, pay, payConfirmed, payPending, isPaid, pCount, pTotal, bCount, quizCnt: qCnt, lineup, lineupHasDraft, lineupSubmitted, team, predOk, bonusOk, overallStatus, isDupe } = row;
                      const name = u.display_name || u.name || u.email || String(uid || "").slice(0, 8);
                      const predColor = predOk ? "#86EFAC" : pTotal > 0 ? "#FDE68A" : "rgba(240,237,230,.35)";
                      const bonusColor = bonusOk ? "#86EFAC" : bCount > 0 ? "#FDE68A" : "rgba(240,237,230,.35)";
                      const statusColor = overallStatus === "ok" ? "#86EFAC" : overallStatus === "done" ? "#FDE68A" : overallStatus === "filling" ? "#93C5FD" : "rgba(240,237,230,.4)";
                      const statusLabel = overallStatus === "ok" ? "✓ OK" : overallStatus === "done" ? "✓ прогноз" : overallStatus === "filling" ? "заполняет" : overallStatus === "paid_no_pred" ? "оплачен" : "черновик";
                      const lineupColor = lineupSubmitted ? "#86EFAC" : lineupHasDraft ? "#FDE68A" : "rgba(240,237,230,.35)";
                      const lineupLabel = lineupSubmitted ? "✓ отправлен" : lineupHasDraft ? "черновик ⚠" : lineup ? "пустой ⚠" : "—";

                      return (
                        <tr key={uid || `email-${idx}`} style={{ background: isDupe ? "rgba(239,68,68,.06)" : "" }}>
                          {/* Имя */}
                          <td style={{ fontWeight: 600, color: "#F0EDE6", fontSize: 13 }}>
                            {name}{isDupe && <span style={{ fontSize: 9, color: "#FCA5A5", marginLeft: 4 }}>дубль ⚠</span>}
                          </td>
                          {/* Email */}
                          <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{u.email || "—"}</td>
                          {/* Команда */}
                          <td style={{ fontSize: 11, color: team?.name ? "#FDE68A" : "rgba(240,237,230,.3)" }}>
                            {team?.name ? `${team.name}${team.code ? ` · ${team.code}` : ""}` : "—"}
                          </td>
                          {/* Оплата */}
                          <td>
                            {payConfirmed
                              ? <span style={{ color: "#86EFAC", fontWeight: 700, fontSize: 12 }}>✓ 500₽</span>
                              : payPending
                                ? <span style={{ color: "#FDE68A", fontSize: 12 }}>ожидает</span>
                                : <span style={{ color: "rgba(240,237,230,.3)", fontSize: 12 }}>—</span>}
                          </td>
                          {/* Комментарий */}
                          <td style={{ fontSize: 10, color: "rgba(240,237,230,.5)", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {pay?.comment || pay?._comment || "—"}
                          </td>
                          {/* Прогноз */}
                          <td style={{ color: predColor, fontSize: 12, fontWeight: 700 }}>
                            <div>{pTotal}/104 {predOk ? "✓" : pTotal > 0 ? "⚠" : ""}</div>
                            {pTotal > 0 && <div style={{ fontSize: 9, color: "rgba(240,237,230,.4)", fontWeight: 400 }}>Г {pCount.group}/72 · ПО {pCount.playoff}/32</div>}
                          </td>
                          {/* Вопросы */}
                          <td style={{ color: bonusColor, fontSize: 12, fontWeight: 700 }}>{bCount}/31 {bonusOk ? "✓" : ""}</td>
                          {/* Состав БК */}
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <span style={{ color: lineupColor, fontSize: 12 }}>{lineupLabel}</span>
                              {lineup && (
                                <button className="mini-btn" style={{ fontSize: 10, color: "#93C5FD", borderColor: "rgba(147,197,253,.35)" }} onClick={() => setLineupModal({ user: u, lineup })}>Состав</button>
                              )}
                            </div>
                          </td>
                          {/* Квизы */}
                          <td style={{ color: qCnt > 0 ? "#86EFAC" : "rgba(240,237,230,.3)", fontWeight: 700, fontSize: 13 }}>{qCnt || "—"}</td>
                          {/* Статус */}
                          <td><span style={{ fontSize: 12, fontWeight: 700, color: statusColor }}>{statusLabel}</span></td>
                          {/* Действия */}
                          <td>
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                              {!isPaid && uid && (
                                <button className="mini-btn green" title="Подтвердить 500₽ и выдать доступ" onClick={async () => {
                                  // Подтвердить через существующий payment request или напрямую
                                  if (pay && pay.status === "pending") {
                                    await confirmPayment(pay.id, uid, pay.plan || "prognostista");
                                  } else {
                                    await supa(`profiles?id=eq.${uid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ access_level: ACCESS.PROGNOSTISTA, is_paid: true, prediction_status: "submitted" }) });
                                    showToast("✓ 500₽ подтверждено");
                                  }
                                  await loadUnifiedParticipants();
                                }}>500₽ ✓</button>
                              )}
                              {uid && (
                                <button className="mini-btn red" title="Сбросить до черновика" onClick={async () => {
                                  await supa(`profiles?id=eq.${uid}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ access_level: ACCESS.DEMO, is_paid: false, prediction_status: "draft" }) });
                                  await loadUnifiedParticipants();
                                  showToast("Сброс");
                                }}>Сброс</button>
                              )}
                              {uid && (
                                <button className="mini-btn red" style={{ borderColor: "rgba(239,68,68,.55)", background: "rgba(127,29,29,.55)", color: "#FCA5A5" }} onClick={() => deleteUserAndData(u).then(() => loadUnifiedParticipants())}>Удалить</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Lineup modal */}
            {lineupModal && (() => {
              const { user, lineup } = lineupModal;
              const name = user.display_name || user.name || user.email || "—";
              let players = [];
              try {
                const raw = typeof lineup.draft_answers === "string" ? JSON.parse(lineup.draft_answers) : lineup.draft_answers;
                if (raw && typeof raw === "object") {
                  const defaultMeta = {
                    coach: "Тренер", goalkeeper: "Вратарь",
                    defender1: "Защитник 1", defender2: "Защитник 2", defender3: "Защитник 3", defender4: "Защитник 4",
                    midfielder1: "Полузащитник 1", midfielder2: "Полузащитник 2", midfielder3: "Полузащитник 3", midfielder4: "Полузащитник 4",
                    forward1: "Нападающий 1", forward2: "Нападающий 2",
                  };
                  players = Object.entries(raw).map(([slot, val]) => {
                    const info = val && typeof val === "object" ? val : {};
                    const optId = info.option_id || info.optionId || info.id || (typeof val === "string" ? val : null);
                    const playerName = info.player_name || info.name || (optId ? `Вариант ${String(optId).slice(0, 8)}` : "—");
                    const team = info.national_team || info.team || "";
                    const isCaptain = optId && optId === lineup.captain_option_id;
                    return { slot, label: defaultMeta[slot] || slot, playerName, team, isCaptain };
                  }).sort((a, b) => {
                    const order = ["coach","goalkeeper","defender1","defender2","defender3","defender4","midfielder1","midfielder2","midfielder3","midfielder4","forward1","forward2"];
                    return (order.indexOf(a.slot) + 1 || 99) - (order.indexOf(b.slot) + 1 || 99);
                  });
                }
              } catch {}
              const hasPlayers = players.some(p => p.playerName && p.playerName !== "—");

              return (
                <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }} onClick={() => setLineupModal(null)}>
                  <div style={{ width: "min(680px,96vw)", maxHeight: "88vh", overflow: "auto", background: "#071407", border: "1px solid rgba(134,239,172,.25)", borderRadius: 12 }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
                      <div>
                        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#FDE68A" }}>Состав БК</div>
                        <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginTop: 2 }}>{name} · {user.email || ""}</div>
                      </div>
                      <button className="mini-btn red" onClick={() => setLineupModal(null)}>Закрыть</button>
                    </div>
                    <div style={{ padding: 16 }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 11 }}>
                        <span className={`tag ${lineupModal.lineup.lineup_status === "submitted" ? "tg" : "ty"}`}>{lineupModal.lineup.lineup_status || "черновик"}</span>
                        {lineup.submitted_at && <span className="tag">отправлен: {new Date(lineup.submitted_at).toLocaleString("ru")}</span>}
                        {lineup.updated_at && <span className="tag">обновлён: {new Date(lineup.updated_at).toLocaleString("ru")}</span>}
                      </div>
                      {hasPlayers ? (
                        <table className="admin-table">
                          <thead><tr><th>Позиция</th><th>Игрок</th><th>Сборная</th><th>Капитан</th></tr></thead>
                          <tbody>{players.map(p => (
                            <tr key={p.slot}>
                              <td style={{ fontSize: 11, color: "rgba(240,237,230,.55)" }}>{p.label}</td>
                              <td style={{ fontWeight: 700, color: "#F0EDE6" }}>{p.playerName}</td>
                              <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{p.team || "—"}</td>
                              <td style={{ color: p.isCaptain ? "#FDE68A" : "rgba(240,237,230,.25)", fontWeight: 800 }}>{p.isCaptain ? "★" : "—"}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      ) : (
                        <div>
                          <div style={{ color: "#FDE68A", fontSize: 12, marginBottom: 8 }}>⚠ Состав не распознан. Сырой JSON:</div>
                          <pre style={{ fontSize: 10, color: "rgba(240,237,230,.6)", background: "rgba(0,0,0,.3)", padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 200, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify({ id: lineup.id, lineup_status: lineup.lineup_status, submitted_at: lineup.submitted_at, draft_answers: lineup.draft_answers, captain_option_id: lineup.captain_option_id }, null, 2)}</pre>
                        </div>
                      )}
                      <div style={{ marginTop: 10, fontSize: 10, color: "rgba(240,237,230,.3)" }}>ID состава: {lineup.id || "—"}</div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })()}

      {adminLineupPreview && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }} onClick={() => setAdminLineupPreview(null)}>
          <div style={{ width: "min(760px, 96vw)", maxHeight: "88vh", overflow: "auto", background: "#071407", border: "1px solid rgba(134,239,172,.25)", borderRadius: 12, boxShadow: "0 18px 60px rgba(0,0,0,.45)" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
              <div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 800, color: "#FDE68A" }}>Состав Битвы клубов</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", marginTop: 3 }}>
                  {getDisplayName(adminLineupPreview.user) || "—"} · {adminLineupPreview.user.email || ""}
                </div>
              </div>
              <button className="mini-btn red" onClick={() => setAdminLineupPreview(null)}>Закрыть</button>
            </div>
            <div style={{ padding: 16 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 11 }}>
                <span className="tag tg">{adminLineupPreview.lineup.isComplete ? "✓ полный состав" : adminLineupPreview.lineup.isDraftFormat ? "неполный драфт" : "черновик"}</span>
                {adminLineupPreview.lineup.isDraftFormat && <span className="tag">формат: драфт БК</span>}
                {adminLineupPreview.lineup.submitted_at && <span className="tag">отправлен: {new Date(adminLineupPreview.lineup.submitted_at).toLocaleString("ru")}</span>}
                {adminLineupPreview.lineup.updated_at && <span className="tag">обновлён: {new Date(adminLineupPreview.lineup.updated_at).toLocaleString("ru")}</span>}
              </div>

              {/* Диагностика: состав есть, но игроки не найдены */}
              {adminLineupPreview.lineup.allUUIDsUnresolved && (
                <div style={{ background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.3)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#FCA5A5" }}>
                  ⚠ Строка состава есть, UUID игроков сохранены, но не найдены в таблице ffc_players. Возможные причины:
                  <ul style={{ marginTop: 6, paddingLeft: 18, lineHeight: 1.8 }}>
                    <li>В ffc_players другие UUID чем в ffc_lineups (разные таблицы игроков)</li>
                    <li>ffc_players загружается с лимитом и нужный игрок за пределами первых 5000</li>
                    <li>Состав сохранён из tournament_players, а смотрим в ffc_players</li>
                  </ul>
                </div>
              )}
              {!adminLineupPreview.lineup.hasAnyPlayer && (
                <div style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 12, color: "#FDE68A" }}>
                  ⚠ Строка состава есть (ID: {adminLineupPreview.lineup.id}), но данные состава пустые или в неизвестном формате.
                  Сырой JSON:
                  <pre style={{ marginTop: 8, fontSize: 10, color: "rgba(240,237,230,.6)", background: "rgba(0,0,0,.3)", padding: 10, borderRadius: 6, overflow: "auto", maxHeight: 200, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                    {JSON.stringify({
                      id: adminLineupPreview.lineup.id,
                      lineup_status: adminLineupPreview.lineup.lineup_status,
                      submitted_at: adminLineupPreview.lineup.submitted_at,
                      coach_id: adminLineupPreview.lineup.coach_id,
                      goalkeeper_id: adminLineupPreview.lineup.goalkeeper_id,
                      defender_id: adminLineupPreview.lineup.defender_id,
                      defender2_id: adminLineupPreview.lineup.defender2_id,
                      midfielder_id: adminLineupPreview.lineup.midfielder_id,
                      midfielder2_id: adminLineupPreview.lineup.midfielder2_id,
                      forward_id: adminLineupPreview.lineup.forward_id,
                      forward2_id: adminLineupPreview.lineup.forward2_id,
                      captain_player_id: adminLineupPreview.lineup.captain_player_id,
                      bench_player_id: adminLineupPreview.lineup.bench_player_id,
                      draft_answers: adminLineupPreview.lineup.draft_answers,
                    }, null, 2)}
                  </pre>
                </div>
              )}

              <table className="admin-table">
                <thead><tr><th>Позиция</th><th>Игрок</th><th>Сборная</th><th>Капитан</th></tr></thead>
                <tbody>
                  {(adminLineupPreview.lineup.slots || []).map(slot => (
                    <tr key={slot.key}>
                      <td style={{ fontSize: 11, color: "rgba(240,237,230,.55)" }}>{slot.label}</td>
                      <td style={{ fontSize: 13, color: slot.playerId ? (slot.playerFoundInDb === false ? "#FCA5A5" : "#F0EDE6") : "rgba(240,237,230,.35)", fontWeight: 700 }}>{slot.name}{slot.tag ? <span style={{ marginLeft: 6, color: "rgba(253,230,138,.75)", fontSize: 10 }}>· {slot.tag}</span> : null}</td>
                      <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{slot.team || "—"}</td>
                      <td style={{ fontSize: 13, color: slot.isCaptain ? "#FDE68A" : "rgba(240,237,230,.25)", fontWeight: 800 }}>{slot.isCaptain ? "★" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 10, fontSize: 10, color: "rgba(240,237,230,.35)" }}>ID состава: {adminLineupPreview.lineup.id || "—"}</div>
            </div>
          </div>
        </div>
      )}

      {/* ВОРОНКА УЧАСТНИКОВ */}
      {adminTab === "voronka" && (
        <AdminParticipantsPanel session={session} setSession={setSession} showToast={showToast} />
      )}

      {/* ИГРОКИ */}
      {adminTab === "players" && (
        <AdminPlayersPanel session={session} showToast={showToast} />
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
      </> /* конец скрытых старых вкладок */ }
    </div>
  );
}

// ── ГЛАВНЫЙ КОМПОНЕНТ ──
// ── FOOTBALL DAILY QUESTION BANK (300 вопросов) ──
// TODO: Позже вынести проверку ответов на сервер/Supabase RPC, чтобы correct_answer не уходил на клиент до завершения.

function AdminParticipantsPanel({ session, setSession, showToast }) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState("all");
  const [adminError, setAdminError] = React.useState("");
  const [editingNameUserId, setEditingNameUserId] = React.useState(null);
  const [editingNameValue, setEditingNameValue] = React.useState("");
  const [editingTeamId, setEditingTeamId] = React.useState(null);
  const [editingTeamValue, setEditingTeamValue] = React.useState("");
  const [editingUserTeamId, setEditingUserTeamId] = React.useState(null);
  const [editingUserTeamValue, setEditingUserTeamValue] = React.useState("");
  const [adminPredictorTeams, setAdminPredictorTeams] = React.useState([]);
  const token = session?.access_token;

  async function getAdminToken() {
    const fresh = await getFreshToken(setSession).catch((e) => {
      console.warn("AdminParticipantsPanel token refresh failed", e);
      return null;
    });
    if (fresh && !isJwtExpired(fresh)) return fresh;
    if (session?.access_token && !isJwtExpired(session.access_token)) return session.access_token;
    if (token && !isJwtExpired(token)) return token;
    return null;
  }

  React.useEffect(() => { load(); }, []);

  async function safeJson(resp, label) {
    if (!resp || !resp.ok) {
      const text = resp ? await resp.text().catch(() => "") : "no response";
      console.warn(`[AdminParticipantsPanel] ${label} failed`, resp?.status, text);
      return { data: [], error: `${label}: ${resp?.status || "ERR"} ${text}` };
    }
    return { data: await resp.json().catch(() => []), error: "" };
  }

  async function load() {
    setLoading(true);
    setAdminError("");
    try {
      // ВАЖНО: админка не должна зависеть только от participant_status.
      // Пользователь мог уже сохранить прогнозы в predictions/bonus_answers, но participant_status ещё не создался.
      const freshToken = await getAdminToken();
      const [pr0, sr0, pred0, bonus0, pay0, lineups0, cup0, league0, quiz0, predictorTeamMembers0, predictorTeams0] = await Promise.all([
        supa("profiles?select=*&order=created_at.asc", { token: freshToken }),
        supa("participant_status?select=*", { token: freshToken }),
        supa("predictions?select=user_id,created_at", { token: freshToken }),
        supa("bonus_answers?select=user_id,created_at", { token: freshToken }),
        supa("payment_requests?select=user_id,status,created_at,amount,comment", { token: freshToken }),
        supa("ffc_lineups?select=user_id,created_at", { token: freshToken }),
        supa("ffc_cup_entries?select=user_id,status,created_at", { token: freshToken }),
        supa("ffc_league_entries?select=user_id", { token: freshToken }),
        supa("daily_text_quiz_attempts?select=user_id", { token: freshToken }),
        supa("predictor_team_members?select=id,user_id,team_id", { token: freshToken }),
        supa("predictor_teams?select=id,name,code", { token: freshToken }),
      ]);

      const pr = await safeJson(pr0, "profiles");
      const sr = await safeJson(sr0, "participant_status");
      const pred = await safeJson(pred0, "predictions");
      const bonus = await safeJson(bonus0, "bonus_answers");
      const pay = await safeJson(pay0, "payment_requests");
      const lineups = await safeJson(lineups0, "ffc_lineups");
      const cup = await safeJson(cup0, "ffc_cup_entries");
      const league = await safeJson(league0, "ffc_league_entries");
      const quiz = await safeJson(quiz0, "daily_text_quiz_attempts");
      const predictorTeamMembersResp = await safeJson(predictorTeamMembers0, "predictor_team_members");
      const predictorTeamsResp = await safeJson(predictorTeams0, "predictor_teams");

      const profiles = Array.isArray(pr.data) ? pr.data : [];
      const statuses = Array.isArray(sr.data) ? sr.data : [];
      const predictions = Array.isArray(pred.data) ? pred.data : [];
      const bonusAnswers = Array.isArray(bonus.data) ? bonus.data : [];
      const payments = Array.isArray(pay.data) ? pay.data : [];
      const ffcLineups = Array.isArray(lineups.data) ? lineups.data : [];
      const cupEntries = Array.isArray(cup.data) ? cup.data : [];
      const leagueEntries = Array.isArray(league.data) ? league.data : [];
      const quizAttempts = Array.isArray(quiz.data) ? quiz.data : [];
      const predictorTeamMembers = Array.isArray(predictorTeamMembersResp.data) ? predictorTeamMembersResp.data : [];
      const predictorTeams = Array.isArray(predictorTeamsResp.data) ? predictorTeamsResp.data : [];
      setAdminPredictorTeams([...predictorTeams].sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), "ru")));

      const statusMap = {};
      statuses.forEach(s => { if (s?.user_id) statusMap[s.user_id] = s; });

      const predCount = {};
      const predFirstAt = {};
      predictions.forEach(r => {
        if (!r?.user_id) return;
        predCount[r.user_id] = (predCount[r.user_id] || 0) + 1;
        if (!predFirstAt[r.user_id]) predFirstAt[r.user_id] = r.created_at;
      });

      const bonusCount = {};
      bonusAnswers.forEach(r => {
        if (!r?.user_id) return;
        bonusCount[r.user_id] = (bonusCount[r.user_id] || 0) + 1;
      });

      const paymentMap = {};
      payments.forEach(r => {
        if (!r?.user_id) return;
        paymentMap[r.user_id] = r;
      });

      const clubLineupCount = {};
      const clubEntryMap = {};
      ffcLineups.forEach(r => {
        if (!r?.user_id) return;
        clubLineupCount[r.user_id] = (clubLineupCount[r.user_id] || 0) + 1;
      });
      [...cupEntries, ...leagueEntries].forEach(r => {
        if (!r?.user_id) return;
        clubEntryMap[r.user_id] = r;
      });

      const quizCount = {};
      quizAttempts.forEach(r => {
        if (!r?.user_id) return;
        quizCount[r.user_id] = (quizCount[r.user_id] || 0) + 1;
      });

      const predictorTeamById = {};
      predictorTeams.forEach(t => { if (t?.id) predictorTeamById[t.id] = t; });
      const predictorTeamMap = {};
      predictorTeamMembers.forEach(r => {
        if (!r?.user_id) return;
        const team = predictorTeamById[r.team_id] || {};
        predictorTeamMap[r.user_id] = {
          member_id: r.id || null,
          team_id: r.team_id || team.id || null,
          name: team.name || "",
          code: team.code || "",
        };
      });

      const map = {};
      profiles.forEach(p => { if (p?.id) map[p.id] = { ...p }; });
      // Если profiles по RLS не отдал всех, всё равно покажем пользователей из активности по user_id.
      [...new Set([
        ...Object.keys(predCount), ...Object.keys(bonusCount), ...Object.keys(paymentMap), ...Object.keys(statusMap),
        ...Object.keys(clubLineupCount), ...Object.keys(clubEntryMap), ...Object.keys(quizCount), ...Object.keys(predictorTeamMap),
      ])].forEach(uid => {
        if (!map[uid]) map[uid] = {
          id: uid, email: "", name: "", display_name: "",
          created_at: predFirstAt[uid] || paymentMap[uid]?.created_at || clubEntryMap[uid]?.created_at || statusMap[uid]?.registered_at || null
        };
      });

      const merged = Object.values(map).map(p => {
        const ps = statusMap[p.id] || null;
        const pc = predCount[p.id] || 0;
        const bc = bonusCount[p.id] || 0;
        const payReq = paymentMap[p.id] || null;
        const inferredStarted = pc > 0 || bc > 0 || !!ps?.has_started_predictions;
        const inferredSubmitted = !!ps?.has_submitted_predictions || p.prediction_status === "submitted" || p.prediction_status === "payment_pending" || pc >= 72 || !!payReq;
        const inferredPaid = !!ps?.has_paid || !!p.is_paid || ["paid", "approved"].includes(payReq?.status);
        const inferredStatus = ps?.status || (ps?.is_approved ? "approved" : inferredPaid ? "paid" : payReq ? "payment_pending" : inferredSubmitted ? "submitted" : inferredStarted ? "filling" : "registered");
        const club_team_filled = (clubLineupCount[p.id] || 0) > 0 || !!clubEntryMap[p.id];
        return {
          ...p, ps,
          pred_count: pc, bonus_count: bc,
          club_lineup_count: clubLineupCount[p.id] || 0,
          club_entry: clubEntryMap[p.id] || null,
          club_team_filled,
          predictor_team: predictorTeamMap[p.id] || null,
          predictor_team_name: predictorTeamMap[p.id]?.name || "",
          predictor_team_code: predictorTeamMap[p.id]?.code || "",
          quiz_count: quizCount[p.id] || 0,
          payment_request: payReq, inferredStarted, inferredSubmitted, inferredPaid, inferredStatus
        };
      });

      setRows(merged.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)));
      const errors = [pr.error, sr.error, pred.error, bonus.error, pay.error, lineups.error, cup.error, league.error, quiz.error, predictorTeamMembersResp.error, predictorTeamsResp.error].filter(Boolean);
      if (errors.length) setAdminError(errors.join(" | "));
    } catch (e) {
      console.warn("AdminParticipantsPanel load exception:", e);
      setAdminError(String(e?.message || e));
    }
    setLoading(false);
  }

  async function patchStatus(userId, patch) {
    const resp = await supa("participant_status", {
      method: "POST", token,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: userId, ...patch, updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("participant_status upsert failed", resp.status, text);
      showToast(`Не удалось обновить статус (${resp.status})`);
    }
    await load();
  }

  async function updateParticipantDisplayName(userId, rawName) {
    const trimmed = String(rawName || "").trim().replace(/\s+/g, " ");
    if (!userId) return;
    if (trimmed.length < 2) {
      showToast("Имя формы: минимум 2 символа");
      return;
    }
    if (trimmed.length > 40) {
      showToast("Имя формы: максимум 40 символов");
      return;
    }

    const freshToken = await getAdminToken();
    if (!freshToken) {
      showToast("Сессия истекла. Выйди и войди снова.");
      return;
    }

    const resp = await supa(`profiles?id=eq.${userId}`, {
      method: "PATCH",
      token: freshToken,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ display_name: trimmed, name: trimmed }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("admin update display_name failed", resp.status, text);
      showToast(`Не удалось изменить имя (${resp.status}). Проверь UPDATE policy для profiles.`);
      return;
    }

    setRows(prev => prev.map(r => r.id === userId ? { ...r, display_name: trimmed, name: trimmed } : r));
    setEditingNameUserId(null);
    setEditingNameValue("");
    showToast("Имя формы изменено");
    await load();
  }

  async function updatePredictorTeamName(teamId, rawName) {
    const trimmed = String(rawName || "").trim().replace(/\s+/g, " ");
    if (!teamId) return;
    if (trimmed.length < 2) {
      showToast("Название команды: минимум 2 символа");
      return;
    }
    if (trimmed.length > 40) {
      showToast("Название команды: максимум 40 символов");
      return;
    }

    const freshToken = await getAdminToken();
    if (!freshToken) {
      showToast("Сессия истекла. Выйди и войди снова.");
      return;
    }

    const resp = await supa(`predictor_teams?id=eq.${teamId}`, {
      method: "PATCH",
      token: freshToken,
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ name: trimmed }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("admin update predictor team name failed", resp.status, text);
      showToast(`Не удалось изменить название команды (${resp.status}). Проверь UPDATE policy для predictor_teams.`);
      return;
    }

    setRows(prev => prev.map(r => r.predictor_team?.team_id === teamId
      ? { ...r, predictor_team: { ...r.predictor_team, name: trimmed }, predictor_team_name: trimmed }
      : r
    ));
    setEditingTeamId(null);
    setEditingTeamValue("");
    showToast("Название команды изменено");
    await load();
  }


  function makeAdminTeamCode() {
    return Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(2, 8).padEnd(6, "X");
  }

  async function assignPredictorTeamToUser(userId, rawName) {
    const trimmed = String(rawName || "").trim().replace(/\s+/g, " ");
    if (!userId) return;
    if (trimmed.length < 2) {
      showToast("Команда: минимум 2 символа");
      return;
    }
    if (trimmed.length > 40) {
      showToast("Команда: максимум 40 символов");
      return;
    }

    const freshToken = await getAdminToken();
    if (!freshToken) {
      showToast("Сессия истекла. Выйди и войди снова.");
      return;
    }

    let team = adminPredictorTeams.find(t => String(t?.name || "").trim().toLowerCase() === trimmed.toLowerCase());

    if (!team?.id) {
      const createResp = await supa("predictor_teams", {
        method: "POST",
        token: freshToken,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ name: trimmed, code: makeAdminTeamCode(), owner_id: userId }),
      });
      if (!createResp.ok) {
        const text = await createResp.text().catch(() => "");
        console.warn("admin create predictor team failed", createResp.status, text);
        showToast(`Не удалось создать команду (${createResp.status}). Проверь INSERT policy для predictor_teams.`);
        return;
      }
      const created = await createResp.json().catch(() => []);
      team = Array.isArray(created) ? created[0] : created;
    }

    if (!team?.id) {
      showToast("Команда не создана: Supabase не вернул id");
      return;
    }

    const current = rows.find(r => r.id === userId)?.predictor_team;
    let memberResp;
    if (current?.member_id || current?.team_id) {
      memberResp = await supa(`predictor_team_members?user_id=eq.${userId}`, {
        method: "PATCH",
        token: freshToken,
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ team_id: team.id }),
      });
    } else {
      memberResp = await supa("predictor_team_members", {
        method: "POST",
        token: freshToken,
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ team_id: team.id, user_id: userId }),
      });
    }

    if (!memberResp.ok) {
      const text = await memberResp.text().catch(() => "");
      console.warn("admin assign predictor team failed", memberResp.status, text);
      showToast(`Не удалось прописать команду (${memberResp.status}). Проверь INSERT/UPDATE policy для predictor_team_members.`);
      return;
    }

    setEditingUserTeamId(null);
    setEditingUserTeamValue("");
    showToast("Команда прописана участнику");
    await load();
  }

  async function approveWithPayment(userId) {
    const now = new Date().toISOString();
    // 1. Обновить participant_status: paid + approved за один upsert
    await patchStatus(userId, {
      has_paid: true,
      is_approved: true,
      status: "approved",
      paid_at: now,
      approved_at: now,
    });

    // 2. Обновить profiles.prediction_status → approved (чтобы isPaid стал true в UI)
    try {
      await supa(`profiles?id=eq.${userId}`, {
        method: "PATCH", token, headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ prediction_status: "approved" }),
      });
    } catch (e) { console.warn("profiles prediction_status sync skipped", e); }

    // 3. Реферальный бонус: +100 F-Coins пригласившему, только один раз
    try {
      const refResp = await supa(`profiles?id=eq.${userId}&select=referred_by`, { token });
      if (refResp.ok) {
        const referrerId = (await refResp.json())[0]?.referred_by;
        if (referrerId && referrerId !== userId) {
          const dupRef = await supa(
            `fcoin_transactions?user_id=eq.${referrerId}&related_user_id=eq.${userId}&type=eq.earn&reason=like.Реферальный бонус*&select=id&limit=1`,
            { token }
          );
          const alreadyRef = dupRef.ok && (await dupRef.json()).length > 0;
          if (!alreadyRef) {
            await supa("fcoin_transactions", {
              method: "POST", token, headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ user_id: referrerId, amount: 100, type: "earn", reason: "Реферальный бонус: друг оплатил турнир", related_user_id: userId }),
            });
            const refProf = await supa(`profiles?id=eq.${referrerId}&select=fcoins_balance`, { token });
            if (refProf.ok) {
              const refCur = (await refProf.json())[0]?.fcoins_balance || 0;
              await supa(`profiles?id=eq.${referrerId}`, {
                method: "PATCH", token, headers: { Prefer: "return=minimal" },
                body: JSON.stringify({ fcoins_balance: refCur + 100 }),
              });
            }
            showToast("✅ Одобрено · +100 F-Coins реферреру начислены");
          } else {
            showToast("✅ Одобрено · реферрер уже получал бонус");
          }
        } else {
          showToast("✅ Одобрено и оплата подтверждена");
        }
      } else {
        showToast("✅ Одобрено и оплата подтверждена");
      }
    } catch (e) {
      console.warn("referral bonus skipped", e);
      showToast("✅ Одобрено и оплата подтверждена");
    }
  }

  async function reject(userId) {
    await patchStatus(userId, { status: "rejected" });
    showToast("Отклонён");
  }

  const total = rows.length;
  const started = rows.filter(r => r.inferredStarted).length;
  const submitted = rows.filter(r => r.inferredSubmitted).length;
  const pendingPay = rows.filter(r => r.inferredStatus === "payment_pending").length;
  const paid = rows.filter(r => r.inferredPaid).length;
  const approved = rows.filter(r => r.ps?.is_approved || r.inferredStatus === "approved").length;

  const kpiCards = [
    ["Зарегистрировались", total, "#93C5FD"],
    ["Начали прогнозы", started, "#FDE68A"],
    ["Заполнили", submitted, "#FCD34D"],
    ["Ожидают оплату", pendingPay, "#FCA5A5"],
    ["Оплатили", paid, "#86EFAC"],
    ["Одобрены", approved, "#6EE7B7"],
  ];

  const STATUS_LABELS = {
    registered: "Зарегистрирован", filling: "Заполняет", submitted: "Отправил",
    payment_pending: "Ожидает оплату", paid: "Оплатил", approved: "✓ Одобрен", rejected: "✗ Отклонён",
  };

  const filtered = filter === "all" ? rows : rows.filter(r => r.inferredStatus === filter);

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "rgba(240,237,230,.4)" }}>Загрузка…</div>;

  return (
    <div>
      {adminError && (
        <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, border: "1px solid rgba(252,165,165,.25)", background: "rgba(127,29,29,.12)", color: "#FCA5A5", fontSize: 11, lineHeight: 1.5 }}>
          ⚠ Часть админских данных не прочиталась. Проверь RLS/таблицы. Подробности в Console.<br />
          <span style={{ opacity: .7 }}>{adminError.slice(0, 500)}</span>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
        {kpiCards.map(([label, val, color]) => (
          <div key={label} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "10px 12px" }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 24, fontWeight: 700, color }}>{val}</div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.45)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {[["all", "Все"], ["registered", "Новые"], ["filling", "Заполняют"], ["submitted", "Заполнили"], ["payment_pending", "Ждут оплату"], ["paid", "Оплатили"], ["approved", "Одобрены"], ["rejected", "Отклонены"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 4, border: `1px solid ${filter===k?"rgba(245,158,11,.6)":"rgba(255,255,255,.1)"}`, background: filter===k?"rgba(245,158,11,.1)":"transparent", color: filter===k?"#FDE68A":"rgba(240,237,230,.5)", cursor: "pointer" }}>
            {l}
          </button>
        ))}
        <button onClick={load} style={{ marginLeft: "auto", fontSize: 11, padding: "4px 10px", borderRadius: 4, border: "1px solid rgba(255,255,255,.1)", background: "transparent", color: "rgba(240,237,230,.5)", cursor: "pointer" }}>↻ Обновить</button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Имя формы</th>
              <th>Email</th>
              <th>Команда прогнозистов</th>
              <th>Заполнен прогноз</th>
              <th>Состав клуба</th>
              <th>Пройдено квизов</th>
              <th>Оплатил</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(u => {
              const st = u.inferredStatus || "registered";
              const isApproved = !!u.ps?.is_approved || st === "approved";
              const yes = <span style={{ color: "#86EFAC", fontWeight: 700 }}>✓ Да</span>;
              const no = <span style={{ color: "rgba(240,237,230,.28)" }}>—</span>;
              return (
                <tr key={u.id}>
                  <td style={{ fontSize: 13, fontWeight: 500, color: "#F0EDE6", minWidth: 220 }}>
                    {editingNameUserId === u.id ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={editingNameValue}
                          onChange={e => setEditingNameValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter") updateParticipantDisplayName(u.id, editingNameValue);
                            if (e.key === "Escape") { setEditingNameUserId(null); setEditingNameValue(""); }
                          }}
                          autoFocus
                          placeholder="Имя формы"
                          style={{ width: 180, padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.06)", color: "#F0EDE6", fontSize: 13 }}
                        />
                        <button className="mini-btn green" onClick={() => updateParticipantDisplayName(u.id, editingNameValue)}>✓</button>
                        <button className="mini-btn" onClick={() => { setEditingNameUserId(null); setEditingNameValue(""); }}>Отмена</button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span>{getDisplayName(u) || u.id?.slice(0, 8) || "—"}</span>
                        <button
                          className="mini-btn"
                          title="Исправить имя формы"
                          onClick={() => { setEditingNameUserId(u.id); setEditingNameValue(getDisplayName(u) || ""); }}
                        >✏️</button>
                      </div>
                    )}
                  </td>
                  <td style={{ fontSize: 11, color: "rgba(240,237,230,.5)" }}>{u.email || "—"}</td>
                  <td style={{ fontSize: 11, color: u.predictor_team_name ? "#FDE68A" : "rgba(240,237,230,.42)", fontWeight: u.predictor_team_name ? 700 : 400, minWidth: 260 }}>
                    {editingUserTeamId === u.id ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          value={editingUserTeamValue}
                          onChange={e => setEditingUserTeamValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === "Enter") assignPredictorTeamToUser(u.id, editingUserTeamValue);
                            if (e.key === "Escape") { setEditingUserTeamId(null); setEditingUserTeamValue(""); }
                          }}
                          autoFocus
                          list="admin-predictor-teams-list"
                          placeholder="Название команды"
                          style={{ width: 190, padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.06)", color: "#F0EDE6", fontSize: 12 }}
                        />
                        <button className="mini-btn green" onClick={() => assignPredictorTeamToUser(u.id, editingUserTeamValue)}>✓</button>
                        <button className="mini-btn" onClick={() => { setEditingUserTeamId(null); setEditingUserTeamValue(""); }}>Отмена</button>
                        <datalist id="admin-predictor-teams-list">
                          {adminPredictorTeams.map(t => <option key={t.id} value={t.name || ""} />)}
                        </datalist>
                      </div>
                    ) : u.predictor_team?.team_id ? (
                      editingTeamId === u.predictor_team.team_id ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <input
                            value={editingTeamValue}
                            onChange={e => setEditingTeamValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") updatePredictorTeamName(u.predictor_team.team_id, editingTeamValue);
                              if (e.key === "Escape") { setEditingTeamId(null); setEditingTeamValue(""); }
                            }}
                            autoFocus
                            placeholder="Название команды"
                            style={{ width: 170, padding: "7px 9px", borderRadius: 6, border: "1px solid rgba(255,255,255,.18)", background: "rgba(255,255,255,.06)", color: "#F0EDE6", fontSize: 12 }}
                          />
                          <button className="mini-btn green" onClick={() => updatePredictorTeamName(u.predictor_team.team_id, editingTeamValue)}>✓</button>
                          <button className="mini-btn" onClick={() => { setEditingTeamId(null); setEditingTeamValue(""); }}>Отмена</button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span>{u.predictor_team_name || "Команда без названия"}{u.predictor_team_code ? <span style={{ color: "rgba(240,237,230,.38)", fontWeight: 500 }}> · {u.predictor_team_code}</span> : null}</span>
                          <button
                            className="mini-btn"
                            title="Исправить название команды"
                            onClick={() => { setEditingTeamId(u.predictor_team.team_id); setEditingTeamValue(u.predictor_team_name || ""); }}
                          >✏️</button>
                          <button
                            className="mini-btn"
                            title="Прописать участника в другую команду"
                            onClick={() => { setEditingUserTeamId(u.id); setEditingUserTeamValue(u.predictor_team_name || ""); }}
                          >👥</button>
                        </div>
                      )
                    ) : (
                      <button
                        className="mini-btn green"
                        title="Прописать команду участнику"
                        onClick={() => { setEditingUserTeamId(u.id); setEditingUserTeamValue(""); }}
                      >+ команда</button>
                    )}
                  </td>
                  <td style={{ fontSize: 11, textAlign: "center" }}>{u.inferredSubmitted ? yes : u.inferredStarted ? <span style={{ color: "#FDE68A" }}>заполняет</span> : no}</td>
                  <td style={{ fontSize: 11, textAlign: "center" }}>{u.club_team_filled ? yes : no}</td>
                  <td style={{ fontSize: 12, textAlign: "center", color: "#F0EDE6", fontWeight: 700 }}>{u.quiz_count || 0}</td>
                  <td style={{ fontSize: 11, textAlign: "center" }}>{u.inferredPaid ? yes : u.payment_request ? <span style={{ color: "#FCA5A5" }}>ждёт</span> : no}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {!isApproved && (
                        <button className="mini-btn green" onClick={() => approveWithPayment(u.id)}>
                          ✅ Одобрить оплату
                        </button>
                      )}
                      {isApproved && (
                        <span style={{ fontSize: 11, color: "#6EE7B7", fontWeight: 700 }}>✓ Одобрено</span>
                      )}
                      {st !== "rejected" && (
                        <button className="mini-btn red" onClick={() => reject(u.id)}>✗</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: "center", padding: "24px", color: "rgba(240,237,230,.3)", fontSize: 13 }}>Нет участников. Если прогнозы точно есть — выполни SQL ниже для RLS и нажми “Обновить”.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <details style={{ marginTop: 16 }}>
        <summary style={{ fontSize: 11, color: "rgba(240,237,230,.4)", cursor: "pointer" }}>SQL для админки заявок</summary>
        <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, overflow: "auto", marginTop: 8 }}>{`CREATE TABLE IF NOT EXISTS public.participant_status (
  user_id UUID PRIMARY KEY,
  status TEXT DEFAULT 'registered',
  has_started_predictions BOOLEAN DEFAULT false,
  has_submitted_predictions BOOLEAN DEFAULT false,
  has_paid BOOLEAN DEFAULT false,
  is_approved BOOLEAN DEFAULT false,
  payment_note TEXT,
  admin_note TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.participant_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ps_all" ON public.participant_status;
CREATE POLICY "ps_all" ON public.participant_status FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public.participant_status TO authenticated;
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
DROP POLICY IF EXISTS "profiles_admin_update_names" ON public.profiles;
CREATE POLICY "profiles_admin_update_names" ON public.profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON public.predictions TO authenticated;
GRANT SELECT ON public.bonus_answers TO authenticated;
GRANT SELECT ON public.payment_requests TO authenticated;
GRANT SELECT ON public.ffc_lineups TO authenticated;
GRANT SELECT ON public.ffc_cup_entries TO authenticated;
GRANT SELECT ON public.ffc_league_entries TO authenticated;
GRANT SELECT ON public.daily_text_quiz_attempts TO authenticated;`}</pre>
      </details>
    </div>
  );
}

// ── AdminPlayersPanel — загрузка двух баз игроков + пул тура + Wikipedia ──
function AdminPlayersPanel({ session, showToast }) {
  const [playersTab, setPlayersTab] = React.useState("tournament");
  const [csvText, setCsvText] = React.useState("");
  const [preview, setPreview] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  // Wikipedia import
  const [wikiHtml, setWikiHtml] = React.useState("");
  const [wikiResult, setWikiResult] = React.useState(null);
  const [wikiImporting, setWikiImporting] = React.useState(false);
  // Round pool
  const [rounds, setRounds] = React.useState([]);
  const [selectedRound, setSelectedRound] = React.useState("");
  const token = session?.access_token;

  React.useEffect(() => {
    if (playersTab === "pool") {
      supa("ffc_rounds?select=id,name,round_no&order=round_no.asc", { token })
        .then(r => r.ok ? r.json() : [])
        .then(d => setRounds(d || []));
    }
  }, [playersTab]);

  // ── Wikipedia parser ──
  function parseWikipediaSquadsHtml(html) {
    const TOURNAMENT_START = new Date("2026-06-11");
    const posMap = { "ВР": "goalkeeper", "ЗЩ": "defender", "ПЗ": "midfielder", "НП": "forward",
                     "GK": "goalkeeper", "DF": "defender", "MF": "midfielder", "FW": "forward",
                     "1": "goalkeeper", "2": "defender", "3": "midfielder", "4": "forward" };
    const players = [];
    const errors = [];

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      // Найти все h3 (заголовки сборных) и следующие таблицы
      const headings = doc.querySelectorAll("h2, h3, h4");
      let currentTeam = null;

      headings.forEach(h => {
        const text = h.textContent.replace(/\[.*?\]/g, "").trim();
        // Пропускаем служебные заголовки
        if (text.length < 2 || text.match(/содержание|примечани|ссылки|навигация/i)) return;
        currentTeam = text;

        // Ищем следующую таблицу после заголовка
        let el = h.nextElementSibling;
        while (el && el.tagName !== "TABLE" && el.tagName !== "H2" && el.tagName !== "H3") {
          el = el.nextElementSibling;
        }
        if (!el || el.tagName !== "TABLE") return;

        const rows = el.querySelectorAll("tr");
        rows.forEach(row => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 3) return;

          try {
            const cellTexts = Array.from(cells).map(c => c.textContent.replace(/\[.*?\]/g, "").trim());
            // Ищем номер (позицию), имя, клуб, дату рождения
            let pos = "", name = "", club = "", birthStr = "";

            // Типичная структура: №, позиция, имя, клуб, дата рождения, возраст
            // Пробуем несколько вариантов структуры
            if (cellTexts.length >= 4) {
              const posRaw = cellTexts[0] || cellTexts[1] || "";
              pos = posMap[posRaw.toUpperCase()] || posMap[posRaw] || "unknown";
              name = cellTexts[1] || cellTexts[2] || "";
              // Убираем пометки типа (К) капитан
              name = name.replace(/\s*\(К\)\s*/i, "").trim();
              club = cellTexts[cellTexts.length - 2] || "";
              birthStr = cellTexts[cellTexts.length - 1] || "";
            }

            if (!name || name.length < 2) return;

            // Парсим дату рождения
            let birthDate = null;
            let age = null;
            // Форматы: "1 января 1999 (25 лет)" или "1999-01-01" или "01.01.1999"
            const dateMatch = birthStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/) ||
                              birthStr.match(/(\d{4})-(\d{2})-(\d{2})/);
            const MONTHS = { "января":0,"февраля":1,"марта":2,"апреля":3,"мая":4,"июня":5,"июля":6,"августа":7,"сентября":8,"октября":9,"ноября":10,"декабря":11 };

            if (dateMatch) {
              if (dateMatch[0].includes("-")) {
                birthDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`);
              } else {
                const monthNum = MONTHS[dateMatch[2].toLowerCase()];
                if (monthNum !== undefined) {
                  birthDate = new Date(parseInt(dateMatch[3]), monthNum, parseInt(dateMatch[1]));
                }
              }
            }
            if (birthDate && !isNaN(birthDate)) {
              const ms = TOURNAMENT_START - birthDate;
              age = Math.floor(ms / (1000 * 60 * 60 * 24 * 365.25));
            }

            players.push({
              name,
              national_team: currentTeam,
              club,
              position: pos,
              birth_date: birthDate && !isNaN(birthDate) ? birthDate.toISOString().slice(0, 10) : null,
              age_at_tournament_start: age,
              is_goalkeeper: pos === "goalkeeper",
              is_young_player: age !== null && age <= 21,
              is_active: true,
              source: "wikipedia_2026_squads",
              source_url: "https://ru.wikipedia.org/wiki/Чемпионат_мира_по_футболу_2026_(составы)",
              wiki_updated_at: new Date().toISOString(),
            });
          } catch (e) { errors.push(`Ошибка строки: ${e.message}`); }
        });
      });
    } catch (e) { errors.push(`Критическая ошибка парсинга: ${e.message}`); }

    return { players, errors };
  }

  async function handleWikiImport() {
    if (!wikiHtml.trim()) { showToast("Вставьте HTML страницы"); return; }
    setWikiImporting(true);
    const { players, errors } = parseWikipediaSquadsHtml(wikiHtml);
    setWikiResult({ parsed: players.length, goalkeepers: players.filter(p=>p.is_goalkeeper).length, young: players.filter(p=>p.is_young_player).length, errors, players, added: 0, updated: 0 });

    if (!players.length) { setWikiImporting(false); return; }

    let added = 0, updated = 0, errs = 0;
    for (const p of players) {
      try {
        const existing = await supa(
          `tournament_players?name=eq.${encodeURIComponent(p.name)}&national_team=eq.${encodeURIComponent(p.national_team || "")}&select=id&limit=1`,
          { token }
        );
        const existData = existing.ok ? await existing.json() : [];
        if (existData.length) {
          await supa(`tournament_players?id=eq.${existData[0].id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(p) });
          updated++;
        } else {
          await supa("tournament_players", { method: "POST", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(p) });
          added++;
        }
      } catch { errs++; }
    }
    setWikiResult(prev => ({ ...prev, added, updated, saveErrors: errs }));
    setWikiImporting(false);
    showToast(`✓ Игроки ЧМ: добавлено ${added}, обновлено ${updated}${errs ? `, ошибок ${errs}` : ""}`);
  }

  // ── Round Pool CSV import ──
  function parsePoolCSV(text) {
    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], errors: ["Файл пуст"] };
    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const errors = [];
    const rows = lines.slice(1).map((line, i) => {
      const vals = line.split(",").map(v => v.trim());
      const obj = {};
      header.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
      if (!obj.name) errors.push(`Строка ${i+2}: нет имени`);
      return obj;
    });
    return { rows, errors };
  }

  async function handlePoolImport() {
    if (!selectedRound) { showToast("Выберите тур"); return; }
    if (!preview || !preview.rows.length) return;
    setImporting(true);
    let added = 0, updated = 0, errs = 0;

    for (const row of preview.rows) {
      try {
        // 1. Найти или создать ffc_player
        const existing = await supa(
          `ffc_players?name=eq.${encodeURIComponent(row.name)}&select=id&limit=1`, { token }
        );
        const existData = existing.ok ? await existing.json() : [];
        let playerId;
        const playerBody = {
          name: row.name,
          national_team: row.national_team || null,
          position: row.position || null,
          is_active: true,
          is_available: true,
          display_priority: parseInt(row.display_priority) || 100,
        };
        if (existData.length) {
          await supa(`ffc_players?id=eq.${existData[0].id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(playerBody) });
          playerId = existData[0].id;
          updated++;
        } else {
          const cr = await supa("ffc_players", { method: "POST", token, headers: { Prefer: "return=representation" }, body: JSON.stringify(playerBody) });
          if (cr.ok) { const cd = await cr.json(); playerId = cd[0]?.id; added++; }
        }
        // 2. Добавить в pool тура
        if (playerId) {
          await supa("ffc_round_player_pool", {
            method: "POST", token,
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ round_id: selectedRound, player_id: playerId, is_available: true, display_priority: parseInt(row.display_priority) || 100 }),
          });
        }
      } catch { errs++; }
    }
    setImporting(false); setPreview(null); setCsvText("");
    showToast(`✓ Пул тура: добавлено ${added}, обновлено ${updated}${errs ? `, ошибок ${errs}` : ""}`);
  }

  function parseCSV(text, columns) {
    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], errors: ["Файл пуст"] };
    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const errors = [];
    const rows = lines.slice(1).map((line, i) => {
      const vals = line.split(",").map(v => v.trim());
      const obj = {};
      header.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
      const missing = columns.filter(c => c.required && !obj[c.key]);
      if (missing.length) errors.push(`Строка ${i+2}: нет ${missing.map(c=>c.key).join(", ")}`);
      return obj;
    });
    return { rows, errors };
  }

  function handlePreview() {
    if (playersTab === "tournament") {
      const { rows, errors } = parseCSV(csvText, [{ key: "name", required: true }, { key: "country" }, { key: "club" }, { key: "position" }]);
      setPreview({ rows, errors, cols: ["name", "country", "club", "position"] });
    } else if (playersTab === "clubs") {
      const { rows, errors } = parseCSV(csvText, [{ key: "name", required: true }]);
      setPreview({ rows, errors, cols: ["name", "national_team", "position", "club", "tier", "display_priority"] });
    } else if (playersTab === "pool") {
      const { rows, errors } = parsePoolCSV(csvText);
      setPreview({ rows, errors, cols: ["name", "national_team", "position", "display_priority"] });
    }
  }

  async function handleImport() {
    if (playersTab === "pool") { handlePoolImport(); return; }
    if (!preview || !preview.rows.length) return;
    setImporting(true);
    let added = 0, updated = 0, errs = 0;
    const table = playersTab === "tournament" ? "tournament_players" : "ffc_players";
    const nameField = playersTab === "tournament" ? "country" : "national_team";

    for (const row of preview.rows) {
      try {
        const nameVal = row.name;
        const countryVal = row[nameField] || row.country || row.national_team || "";
        const existing = await supa(
          `${table}?name=eq.${encodeURIComponent(nameVal)}&select=id&limit=1`, { token }
        );
        const existData = existing.ok ? await existing.json() : [];
        const body = { name: nameVal, club: row.club || null, position: row.position || null };
        if (playersTab === "tournament") { body.country = countryVal; }
        else { body.national_team = countryVal; body.is_active = true; body.is_available = true; if (row.display_priority) body.display_priority = parseInt(row.display_priority) || 100; }

        if (existData.length) {
          await supa(`${table}?id=eq.${existData[0].id}`, { method: "PATCH", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
          updated++;
        } else {
          await supa(table, { method: "POST", token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
          added++;
        }
      } catch { errs++; }
    }
    setImporting(false); setPreview(null); setCsvText("");
    showToast(`✓ Добавлено: ${added} · Обновлено: ${updated}${errs ? ` · Ошибок: ${errs}` : ""}`);
  }

  const tabLabels = { tournament: "Игроки турнира", clubs: "Игроки Битвы клубов", pool: "Пул тура", wiki: "📥 Импорт Вики" };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
        {Object.entries(tabLabels).map(([k, l]) => (
          <button key={k} onClick={() => { setPlayersTab(k); setPreview(null); setCsvText(""); }}
            style={{ fontSize: 12, padding: "6px 14px", borderRadius: 4, border: `1px solid ${playersTab===k?"rgba(245,158,11,.5)":"rgba(255,255,255,.1)"}`, background: playersTab===k?"rgba(245,158,11,.08)":"transparent", color: playersTab===k?"#FDE68A":"rgba(240,237,230,.5)", cursor: "pointer" }}>
            {l}
          </button>
        ))}
      </div>

      {/* Wikipedia import */}
      {playersTab === "wiki" && (
        <div className="panel">
          <div className="ph"><span className="pt">Импорт составов ЧМ-2026 из Википедии</span></div>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginBottom: 12, lineHeight: 1.6 }}>
              Из-за CORS браузер не может напрямую скачать страницу Вики. Сделайте так:<br/>
              1. Откройте <a href="https://ru.wikipedia.org/wiki/%D0%A7%D0%B5%D0%BC%D0%BF%D0%B8%D0%BE%D0%BD%D0%B0%D1%82_%D0%BC%D0%B8%D1%80%D0%B0_%D0%BF%D0%BE_%D1%84%D1%83%D1%82%D0%B1%D0%BE%D0%BB%D1%83_2026_(%D1%81%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D1%8B)" target="_blank" rel="noopener noreferrer" style={{ color: "#93C5FD" }}>страницу составов</a><br/>
              2. Нажмите Ctrl+U (просмотр кода), выделите всё (Ctrl+A), скопируйте (Ctrl+C)<br/>
              3. Вставьте HTML сюда:
            </div>
            <textarea
              value={wikiHtml} onChange={e => setWikiHtml(e.target.value)}
              placeholder="Вставьте HTML страницы Вики сюда…"
              style={{ width: "100%", height: 120, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: 8, outline: "none", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <button className="sb" style={{ fontSize: 12 }} onClick={() => {
                if (!wikiHtml.trim()) { showToast("Вставьте HTML"); return; }
                const { players, errors } = parseWikipediaSquadsHtml(wikiHtml);
                setWikiResult({ parsed: players.length, goalkeepers: players.filter(p=>p.is_goalkeeper).length, young: players.filter(p=>p.is_young_player).length, errors, players, added: 0, updated: 0 });
              }}>Предпросмотр</button>
              <button className="mini-btn green" style={{ fontSize: 12, padding: "6px 14px" }} onClick={handleWikiImport} disabled={wikiImporting || !wikiHtml.trim()}>
                {wikiImporting ? "Импорт…" : "✓ Импортировать в tournament_players"}
              </button>
            </div>

            {wikiResult && (
              <div style={{ marginTop: 12, background: "rgba(0,0,0,.2)", borderRadius: 8, padding: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 10 }}>
                  {[["Найдено игроков", wikiResult.parsed, "#93C5FD"], ["Вратарей", wikiResult.goalkeepers, "#FDE68A"], ["До 21 года", wikiResult.young, "#86EFAC"]].map(([l, v, c]) => (
                    <div key={l} style={{ textAlign: "center" }}>
                      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, color: c }}>{v}</div>
                      <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)" }}>{l}</div>
                    </div>
                  ))}
                </div>
                {wikiResult.added > 0 && <div style={{ fontSize: 11, color: "#86EFAC" }}>✓ Добавлено: {wikiResult.added} · Обновлено: {wikiResult.updated}</div>}
                {wikiResult.errors.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {wikiResult.errors.slice(0, 5).map((e, i) => <div key={i} style={{ fontSize: 10, color: "#FCA5A5" }}>⚠ {e}</div>)}
                    {wikiResult.errors.length > 5 && <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)" }}>…и ещё {wikiResult.errors.length - 5} ошибок</div>}
                  </div>
                )}
                {wikiResult.players.length > 0 && (
                  <div style={{ marginTop: 8, overflowX: "auto" }}>
                    <table className="admin-table">
                      <thead><tr><th>Имя</th><th>Сборная</th><th>Позиция</th><th>Клуб</th><th>Возраст</th></tr></thead>
                      <tbody>
                        {wikiResult.players.slice(0, 15).map((p, i) => (
                          <tr key={i}>
                            <td style={{ fontSize: 11 }}>{p.name}</td>
                            <td style={{ fontSize: 10, color: "rgba(240,237,230,.5)" }}>{p.national_team}</td>
                            <td style={{ fontSize: 10 }}>{p.position}</td>
                            <td style={{ fontSize: 10, color: "rgba(240,237,230,.5)" }}>{p.club}</td>
                            <td style={{ fontSize: 10, color: p.is_young_player ? "#86EFAC" : "rgba(240,237,230,.5)" }}>{p.age_at_tournament_start ?? "—"}{p.is_young_player ? " 🟢" : ""}</td>
                          </tr>
                        ))}
                        {wikiResult.players.length > 15 && <tr><td colSpan={5} style={{ fontSize: 10, color: "rgba(240,237,230,.3)", textAlign: "center" }}>…и ещё {wikiResult.players.length - 15}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 11, color: "rgba(240,237,230,.4)", cursor: "pointer" }}>SQL для tournament_players</summary>
              <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, overflow: "auto", marginTop: 8 }}>{`ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS national_team TEXT;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS age_at_tournament_start INTEGER;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'wikipedia_2026_squads';
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS wiki_updated_at TIMESTAMPTZ;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS is_goalkeeper BOOLEAN DEFAULT false;
ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS is_young_player BOOLEAN DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tournament_players_name_team ON public.tournament_players(name, national_team);`}</pre>
            </details>
          </div>
        </div>
      )}

      {/* Round Pool import */}
      {playersTab === "pool" && (
        <div className="panel">
          <div className="ph"><span className="pt">Пул игроков тура (Битва клубов)</span></div>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginBottom: 10 }}>
              Загрузите список игроков для тура. Пользователи увидят только этих игроков при выборе состава.<br/>
              <span style={{ color: "#FDE68A" }}>Рекомендуется 50–72 игрока.</span>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 6 }}>Тур:</div>
              <select value={selectedRound} onChange={e => setSelectedRound(e.target.value)}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 12, padding: "6px 10px", outline: "none", width: "100%" }}>
                <option value="">— выберите тур —</option>
                {rounds.map(r => <option key={r.id} value={r.id}>{r.name || `Тур ${r.round_no}`}</option>)}
              </select>
            </div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginBottom: 8 }}>
              Формат CSV: <code style={{ color: "#FDE68A" }}>name,national_team,position,display_priority</code>
            </div>
            <textarea
              value={csvText} onChange={e => setCsvText(e.target.value)}
              placeholder="name,national_team,position,display_priority&#10;Мбаппе,Франция,forward,1&#10;Холанд,Норвегия,forward,2"
              style={{ width: "100%", height: 120, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: 8, outline: "none", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="sb" style={{ fontSize: 12 }} onClick={handlePreview} disabled={!csvText.trim()}>Предпросмотр</button>
              {preview && !preview.errors.length && (
                <button className="mini-btn green" style={{ fontSize: 12, padding: "6px 14px" }} onClick={handlePoolImport} disabled={importing || !selectedRound}>
                  {importing ? "Импорт…" : `✓ Загрузить ${preview.rows.length} игроков в пул`}
                </button>
              )}
            </div>
            {preview && (
              <div style={{ marginTop: 10 }}>
                {preview.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: "#FCA5A5" }}>⚠ {e}</div>)}
                {!preview.errors.length && (
                  <table className="admin-table" style={{ marginTop: 8 }}>
                    <thead><tr>{preview.cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 10).map((r, i) => <tr key={i}>{preview.cols.map(c => <td key={c} style={{ fontSize: 11 }}>{r[c] || "—"}</td>)}</tr>)}
                      {preview.rows.length > 10 && <tr><td colSpan={preview.cols.length} style={{ fontSize: 10, textAlign: "center", color: "rgba(240,237,230,.3)" }}>…ещё {preview.rows.length - 10}</td></tr>}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tournament / Club players CSV */}
      {(playersTab === "tournament" || playersTab === "clubs") && (
        <div className="panel">
          <div className="ph"><span className="pt">{tabLabels[playersTab]}</span></div>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginBottom: 10 }}>
              {playersTab === "tournament"
                ? "Справочник всех игроков турнира. Используется для бонусных вопросов."
                : "Пул игроков для Битвы клубов. Рекомендуется до 120 игроков."}
            </div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginBottom: 8 }}>
              CSV: <code style={{ color: "#FDE68A" }}>{playersTab === "tournament" ? "name,country,club,position" : "name,national_team,club,position,tier,is_star,display_priority"}</code>
            </div>
            <textarea
              value={csvText} onChange={e => setCsvText(e.target.value)}
              placeholder={playersTab === "tournament" ? "name,country,club,position\nМесси,Аргентина,Интер Майами,forward" : "name,national_team,club,position\nМбаппе,Франция,Реал Мадрид,forward"}
              style={{ width: "100%", height: 120, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: 8, outline: "none", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="sb" style={{ fontSize: 12 }} onClick={handlePreview} disabled={!csvText.trim()}>Предпросмотр</button>
              {preview && !preview.errors.length && (
                <button className="mini-btn green" style={{ fontSize: 12, padding: "6px 14px" }} onClick={handleImport} disabled={importing}>
                  {importing ? "Импорт…" : `✓ Импортировать ${preview.rows.length} строк`}
                </button>
              )}
            </div>
            {preview && (
              <div style={{ marginTop: 10 }}>
                {preview.errors.slice(0, 5).map((e, i) => <div key={i} style={{ fontSize: 11, color: "#FCA5A5" }}>⚠ {e}</div>)}
                {!preview.errors.length && (
                  <table className="admin-table" style={{ marginTop: 8 }}>
                    <thead><tr>{preview.cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>
                      {preview.rows.slice(0, 10).map((r, i) => <tr key={i}>{preview.cols.map(c => <td key={c} style={{ fontSize: 11 }}>{r[c] || "—"}</td>)}</tr>)}
                      {preview.rows.length > 10 && <tr><td colSpan={preview.cols.length} style={{ fontSize: 10, textAlign: "center", color: "rgba(240,237,230,.3)" }}>…ещё {preview.rows.length - 10}</td></tr>}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Словарь русских имён для игроков драфта ──

function displayPlayerName(name) {
  const raw = String(name || "").trim();
  const compact = raw.toLowerCase().replace(/[^a-zа-яё]/gi, "");

  // Единый публичный вариант имени: только «Эрлинг Холанд».
  // Варианты Haaland / Хааланд остаются только как алиасы для поиска и матчинга,
  // но пользователю нигде не показываются.
  if (compact.includes("haaland") || compact.includes("хааланд") || compact.includes("холанд")) {
    return "Эрлинг Холанд";
  }

  return DRAFT_NAME_RU[raw] || raw;
}

// ── FfcDraftView — MVP-драфт тура 12×5 (тренер + 11 игроков + капитан) ──
function FfcDraftView({ session, showToast, activeRound, setSession }) {
  const [slots, setSlots] = React.useState([]); // ffc_round_draft_slots
  const [options, setOptions] = React.useState({}); // { slot_key: [option, ...] }
  const [draftAnswers, setDraftAnswers] = React.useState({}); // { slot_key: option_id }
  const [captainOptionId, setCaptainOptionId] = React.useState(null);
  const [step, setStep] = React.useState(0); // 0..8 (0-7 = slots, 8 = captain)
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [lineupStatus, setLineupStatus] = React.useState(null); // null | 'draft' | 'submitted'
  const [submittedAt, setSubmittedAt] = React.useState(null);
  const [matchInfo, setMatchInfo] = React.useState(null); // {opponent_name} or null
  const [noDraft, setNoDraft] = React.useState(false);
  const [loadError, setLoadError] = React.useState(null);
  const [effectiveRoundId, setEffectiveRoundId] = React.useState(null);
  const token = session?.access_token;
  const uid = session?.user?.id;

  const DEADLINE = new Date("2026-06-11T19:00:00Z");
  const isPastDeadline = new Date() > DEADLINE;

  async function ensureFfcProfileRowForSession(authToken) {
    const user = session?.user;
    if (!user?.id || !authToken) return false;
    try {
      const meta = user.user_metadata || {};
      const displayName =
        meta.display_name ||
        meta.full_name ||
        meta.name ||
        (user.email || "").split("@")[0] ||
        "Игрок";

      const payload = {
        id: user.id,
        email: user.email || null,
        name: displayName,
        display_name: displayName,
      };

      const res = await supa("profiles?on_conflict=id", {
        method: "POST",
        token: authToken,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("ensureFfcProfileRowForSession failed", res.status, text);
        return false;
      }
      return true;
    } catch (e) {
      console.warn("ensureFfcProfileRowForSession exception", e);
      return false;
    }
  }

  const FIXED_ROUND_ID = "00000000-0000-4000-8000-000000000001";
  const DEFAULT_SLOT_META = {
    coach: { slot_label: "Тренер", slot_order: 1, position: "coach" },
    goalkeeper: { slot_label: "Вратарь", slot_order: 2, position: "goalkeeper" },
    defender1: { slot_label: "Защитник 1", slot_order: 3, position: "defender" },
    defender2: { slot_label: "Защитник 2", slot_order: 4, position: "defender" },
    defender3: { slot_label: "Защитник из андердогов", slot_order: 5, position: "defender" },
    defender4: { slot_label: "Защитник 4", slot_order: 6, position: "defender" },
    midfielder1: { slot_label: "Полузащитник 1", slot_order: 7, position: "midfielder" },
    midfielder2: { slot_label: "Полузащитник 2", slot_order: 8, position: "midfielder" },
    midfielder3: { slot_label: "Полузащитник из андердогов", slot_order: 9, position: "midfielder" },
    midfielder4: { slot_label: "Полузащитник 4", slot_order: 10, position: "midfielder" },
    forward1: { slot_label: "Нападающий 1", slot_order: 11, position: "forward" },
    forward2: { slot_label: "Нападающий 2", slot_order: 12, position: "forward" },
  };

  const FALLBACK_DRAFT_CSV = `round_no,slot_key,slot_label,slot_order,position,option_no,player_name,national_team,tag,is_recommended
1,coach,Тренер,1,coach,1,Lionel Scaloni,Аргентина,Надёжный,true
1,coach,Тренер,1,coach,2,Didier Deschamps,Франция,Опыт,false
1,coach,Тренер,1,coach,3,Julian Nagelsmann,Германия,Форма,false
1,coach,Тренер,1,coach,4,Luis de la Fuente,Испания,Система,false
1,coach,Тренер,1,coach,5,Marcelo Bielsa,Уругвай,Риск,false
1,goalkeeper,Вратарь,2,goalkeeper,1,Guillermo Ochoa,Мексика,Опыт,false
1,goalkeeper,Вратарь,2,goalkeeper,2,Ronwen Williams,ЮАР,Сейвы,false
1,goalkeeper,Вратарь,2,goalkeeper,3,Mat Ryan,Австралия,Надёжный,false
1,goalkeeper,Вратарь,2,goalkeeper,4,Gregor Kobel,Швейцария,Звезда,false
1,goalkeeper,Вратарь,2,goalkeeper,5,Emiliano Martinez,Аргентина,Звезда,true
1,defender1,Защитник 1,3,defender,1,Achraf Hakimi,Марокко,Звезда,true
1,defender1,Защитник 1,3,defender,2,Virgil van Dijk,Нидерланды,Надёжный,false
1,defender1,Защитник 1,3,defender,3,Kalidou Koulibaly,Сенегал,Опыт,false
1,defender1,Защитник 1,3,defender,4,Josko Gvardiol,Хорватия,Форма,false
1,defender1,Защитник 1,3,defender,5,Wilfried Singo,Кот-д'Ивуар,Скрытый вариант,false
1,defender2,Защитник 2,4,defender,1,Kim Min-jae,Республика Корея,Надёжный,false
1,defender2,Защитник 2,4,defender,2,Marquinhos,Бразилия,Опыт,false
1,defender2,Защитник 2,4,defender,3,John Stones,Англия,Надёжный,false
1,defender2,Защитник 2,4,defender,4,Alphonso Davies,Канада,Атака,true
1,defender2,Защитник 2,4,defender,5,Nuno Mendes,Португалия,Форма,false
1,defender3,Защитник из андердогов,5,defender,1,Liberato Cacace,Новая Зеландия,Андердог,false
1,defender3,Защитник из андердогов,5,defender,2,Stopira,Кабо-Верде,Андердог,false
1,defender3,Защитник из андердогов,5,defender,3,Michael Amir Murillo,Панама,Андердог,true
1,defender3,Защитник из андердогов,5,defender,4,Abdukodir Khusanov,Узбекистан,Андердог,false
1,defender3,Защитник из андердогов,5,defender,5,Jurien Gaari,Кюрасао,Андердог,false
1,defender4,Защитник 4,6,defender,1,Sead Kolasinac,Босния и Герцеговина,Опыт,false
1,defender4,Защитник 4,6,defender,2,Lucas Mendes,Катар,Надёжный,false
1,defender4,Защитник 4,6,defender,3,Chris Richards,США,Риск,false
1,defender4,Защитник 4,6,defender,4,Andy Robertson,Шотландия,Атака,true
1,defender4,Защитник 4,6,defender,5,Antonee Robinson,США,Форма,false
1,midfielder1,Полузащитник 1,7,midfielder,1,Jude Bellingham,Англия,Звезда,true
1,midfielder1,Полузащитник 1,7,midfielder,2,Pedri,Испания,Контроль,false
1,midfielder1,Полузащитник 1,7,midfielder,3,Federico Valverde,Уругвай,Мотор,false
1,midfielder1,Полузащитник 1,7,midfielder,4,Kevin De Bruyne,Бельгия,Ассистент,false
1,midfielder1,Полузащитник 1,7,midfielder,5,Jamal Musiala,Германия,Дриблинг,false
1,midfielder2,Полузащитник 2,8,midfielder,1,Granit Xhaka,Швейцария,Надёжный,false
1,midfielder2,Полузащитник 2,8,midfielder,2,Hakan Calhanoglu,Турция,Пенальтист,true
1,midfielder2,Полузащитник 2,8,midfielder,3,Moises Caicedo,Эквадор,Отбор,false
1,midfielder2,Полузащитник 2,8,midfielder,4,Takefusa Kubo,Япония,Риск,false
1,midfielder2,Полузащитник 2,8,midfielder,5,Mohammed Kudus,Гана,Скрытый вариант,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,1,Zidane Iqbal,Ирак,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,2,Noor Al-Rawabdeh,Иордания,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,3,Jean-Ricner Bellegarde,Гаити,Андердог,true
1,midfielder3,Полузащитник из андердогов,9,midfielder,4,Aissa Laidouni,Тунис,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,5,Jackson Irvine,Австралия,Андердог,false
1,midfielder4,Полузащитник 4,10,midfielder,1,Miguel Almiron,Парагвай,Форма,false
1,midfielder4,Полузащитник 4,10,midfielder,2,Ismael Bennacer,Алжир,Контроль,false
1,midfielder4,Полузащитник 4,10,midfielder,3,Marcel Sabitzer,Австрия,Удар,false
1,midfielder4,Полузащитник 4,10,midfielder,4,Richard Rios,Колумбия,Мотор,false
1,midfielder4,Полузащитник 4,10,midfielder,5,Salem Al-Dawsari,Саудовская Аравия,Риск,true
1,forward1,Нападающий 1,11,forward,1,Kylian Mbappe,Франция,Звезда,true
1,forward1,Нападающий 1,11,forward,2,Эрлинг Холанд,Норвегия,Гол,false
1,forward1,Нападающий 1,11,forward,3,Lionel Messi,Аргентина,Магия,false
1,forward1,Нападающий 1,11,forward,4,Vinicius Jr,Бразилия,Дриблинг,false
1,forward1,Нападающий 1,11,forward,5,Cristiano Ronaldo,Португалия,Опыт,false
1,forward2,Нападающий 2,12,forward,1,Mohamed Salah,Египет,Звезда,true
1,forward2,Нападающий 2,12,forward,2,Alexander Isak,Швеция,Форма,false
1,forward2,Нападающий 2,12,forward,3,Mehdi Taremi,Иран,Пенальтист,false
1,forward2,Нападающий 2,12,forward,4,Yoane Wissa,ДР Конго,Скрытый вариант,false
1,forward2,Нападающий 2,12,forward,5,Patrik Schick,Чехия,Гол,false`;

  function fallbackOptionUuid(slotOrder, optionNo) {
    const tail = String((Number(slotOrder) || 0) * 100 + (Number(optionNo) || 0)).padStart(12, "0");
    return `00000000-0000-4000-8000-${tail}`;
  }

  function parseFallbackDraftCsv(roundId = FIXED_ROUND_ID) {
    const lines = FALLBACK_DRAFT_CSV.trim().split(/\r?\n/).filter(Boolean);
    const header = lines.shift().split(",").map(x => x.trim());
    const rows = lines.map(line => {
      const parts = line.split(",").map(x => x.trim());
      const obj = {};
      header.forEach((h, i) => obj[h] = parts[i] || "");
      return obj;
    });
    const slotMap = new Map();
    const optionsData = rows.map(r => {
      const slotOrder = Number(r.slot_order || 999);
      const optionNo = Number(r.option_no || 0);
      if (!slotMap.has(r.slot_key)) {
        slotMap.set(r.slot_key, {
          id: `fallback-slot-${r.slot_key}`,
          round_id: roundId,
          slot_key: r.slot_key,
          slot_label: r.slot_label,
          slot_order: slotOrder,
          position: r.position,
        });
      }
      return {
        id: fallbackOptionUuid(slotOrder, optionNo),
        round_id: roundId,
        slot_key: r.slot_key,
        option_no: optionNo,
        player_name: r.player_name,
        national_team: r.national_team,
        position: r.position,
        tag: r.tag,
        is_recommended: String(r.is_recommended).toLowerCase() === "true",
        display_priority: optionNo,
      };
    });
    const slotsData = Array.from(slotMap.values()).sort((a, b) => (a.slot_order || 999) - (b.slot_order || 999));
    return { slotsData, optionsData };
  }


  React.useEffect(() => { load(); }, [activeRound?.id, uid]);

  async function fetchDraftForRound(roundId) {
    const sr = await supa(`ffc_round_draft_slots?round_id=eq.${roundId}&select=*&order=slot_order.asc`, { token });
    const slotsData = sr.ok ? await sr.json() : [];
    if (!sr.ok) console.warn("draft slots load failed", sr.status, await sr.text().catch(() => ""));

    const or = await supa(`ffc_round_draft_options?round_id=eq.${roundId}&select=*&order=slot_key.asc,option_no.asc`, { token });
    const optionsData = or.ok ? await or.json() : [];
    if (!or.ok) console.warn("draft options load failed", or.status, await or.text().catch(() => ""));

    return { slotsData, optionsData };
  }

  function buildSlotsFromOptions(roundId, optionsData) {
    const keys = [...new Set(optionsData.map(o => o.slot_key).filter(Boolean))];
    return keys.map(k => ({
      id: `local-slot-${k}`,
      round_id: roundId,
      slot_key: k,
      slot_label: DEFAULT_SLOT_META[k]?.slot_label || k,
      slot_order: DEFAULT_SLOT_META[k]?.slot_order || 999,
      position: DEFAULT_SLOT_META[k]?.position || optionsData.find(o => o.slot_key === k)?.position || "player",
    })).sort((a, b) => (a.slot_order || 999) - (b.slot_order || 999));
  }

  async function load() {
    setLoading(true);
    setNoDraft(false);
    setLoadError(null);
    try {
      let roundId = activeRound?.id || FIXED_ROUND_ID;
      console.log("FfcDraftView load start", { activeRoundId: activeRound?.id, roundId });

      let { slotsData, optionsData } = await fetchDraftForRound(roundId);

      // Часто админка грузит драфт на другой round_id. Не висим — ищем любой тур, где есть options.
      if (!optionsData.length) {
        const anyRes = await supa("ffc_round_draft_options?select=round_id&limit=1", { token });
        const anyRows = anyRes.ok ? await anyRes.json() : [];
        const anyRoundId = anyRows?.[0]?.round_id;
        if (anyRoundId && anyRoundId !== roundId) {
          console.warn("FfcDraftView: active round has no draft, trying existing draft round", { roundId, anyRoundId });
          roundId = anyRoundId;
          ({ slotsData, optionsData } = await fetchDraftForRound(roundId));
        }
      }

      // Последний страховочный fallback: если база/round_id/RLS опять не отдали драфт,
      // показываем стандартный Тур 1 из зашитого CSV, чтобы пользователь не видел "готовится".
      if (!optionsData.length) {
        console.warn("FfcDraftView: no DB draft visible, using built-in fallback draft");
        roundId = FIXED_ROUND_ID;
        ({ slotsData, optionsData } = parseFallbackDraftCsv(roundId));
      }

      // Если options есть, а slots не записались — восстанавливаем 12 слотов локально.
      if (!slotsData.length && optionsData.length) {
        console.warn("FfcDraftView: slots missing, building local slots from options");
        slotsData = buildSlotsFromOptions(roundId, optionsData);
      }

      console.log("FfcDraftView draft counts", { roundId, slots: slotsData.length, options: optionsData.length });

      if (!slotsData.length || !optionsData.length) {
        setSlots([]);
        setOptions({});
        setNoDraft(true);
        return;
      }

      setEffectiveRoundId(roundId);
      setSlots(slotsData);
      const optMap = {};
      optionsData.forEach(o => {
        if (!optMap[o.slot_key]) optMap[o.slot_key] = [];
        optMap[o.slot_key].push(o);
      });
      Object.keys(optMap).forEach(k => optMap[k].sort((a, b) => (a.option_no || 0) - (b.option_no || 0)));
      setOptions(optMap);
      setNoDraft(false);

      try {
        const lr = await supa(`ffc_lineups?round_id=eq.${roundId}&user_id=eq.${uid}&select=*&limit=1`, { token });
        if (lr.ok) {
          const ld = await lr.json();
          if (ld[0]) {
            const ln = ld[0];
            setLineupStatus(ln.lineup_status || null);
            setSubmittedAt(ln.submitted_at || null);
            if (ln.draft_answers) {
              let loadedAnswers = ln.draft_answers;
              if (typeof loadedAnswers === "string") {
                try { loadedAnswers = JSON.parse(loadedAnswers); } catch { loadedAnswers = {}; }
              }
              const normalizedAnswers = {};
              Object.entries(loadedAnswers || {}).forEach(([slotKey, value]) => {
                normalizedAnswers[slotKey] = (value && typeof value === "object")
                  ? (value.option_id || value.optionId || value.id || value.value || "")
                  : value;
              });
              setDraftAnswers(normalizedAnswers);
            }
            if (ln.captain_option_id) setCaptainOptionId(ln.captain_option_id);
          }
        } else {
          console.warn("lineup load failed", lr.status, await lr.text().catch(() => ""));
        }
      } catch (e) { console.warn("lineup load exception", e); }

      if (activeRound?.pairing_status === "paired") {
        try {
          const mr = await supa(`ffc_club_matches?round_id=eq.${roundId}&or=(player_a.eq.${uid},player_b.eq.${uid})&select=*&limit=1`, { token });
          if (mr.ok) {
            const md = await mr.json();
            if (md[0]) setMatchInfo(md[0]);
          }
        } catch (e) { console.warn("match load exception", e); }
      }
    } catch (e) {
      console.warn("FfcDraftView load:", e);
      setLoadError(e?.message || String(e));
      // Не показываем пользователю «Драфт готовится», если БД/RLS/round_id не отдали варианты.
      // Вместо этого всегда показываем встроенный драфт тура, чтобы состав можно было отправить.
      try {
        const roundId = activeRound?.id || FIXED_ROUND_ID;
        const fallback = parseFallbackDraftCsv(roundId);
        setEffectiveRoundId(roundId);
        setSlots(fallback.slotsData);
        const optMap = {};
        fallback.optionsData.forEach(o => {
          if (!optMap[o.slot_key]) optMap[o.slot_key] = [];
          optMap[o.slot_key].push(o);
        });
        Object.keys(optMap).forEach(k => optMap[k].sort((a, b) => (a.option_no || 0) - (b.option_no || 0)));
        setOptions(optMap);
        setNoDraft(false);
      } catch (fallbackError) {
        console.warn("FfcDraftView fallback failed:", fallbackError);
        setNoDraft(true);
      }
    } finally {
      setLoading(false);
    }
  }

  async function saveLineup(status) {
    setSaving(true);
    try {
      const freshToken = await getFreshToken(setSession).catch(() => null);
      const authToken = freshToken || token;
      if (!uid || !authToken || isJwtExpired(authToken)) {
        showToast("Сессия истекла. Выйди и войди заново.");
        return;
      }

      // Перед сохранением состава восстанавливаем profiles, иначе FK в ffc_lineups не даст записать состав.
      await ensureFfcProfileRowForSession(authToken);

      const roundId = effectiveRoundId || activeRound?.id || FIXED_ROUND_ID;

      // ВАЖНО: сохраняем не только UUID выбранного варианта, но и человеческие данные игрока.
      // Раньше админка могла видеть строку ffc_lineups, но не могла восстановить имена,
      // если ffc_round_draft_options не читалась / была пустая / round_id отличался.
      const enrichedDraftAnswers = {};
      slots.forEach((slot) => {
        const optionId = draftAnswers?.[slot.slot_key];
        if (!optionId) return;
        const opt = (options?.[slot.slot_key] || []).find((o) => o.id === optionId) || {};
        enrichedDraftAnswers[slot.slot_key] = {
          option_id: optionId,
          slot_key: slot.slot_key,
          slot_label: slot.slot_label || slot.slot_key,
          slot_order: slot.slot_order || 0,
          position: opt.position || slot.position || "",
          player_name: opt.player_name || opt.name || "",
          national_team: opt.national_team || opt.team || "",
          tag: opt.tag || "",
        };
      });

      if (status === "submitted") {
        const selectedCount = Object.keys(enrichedDraftAnswers).length;
        if (!selectedCount || selectedCount < slots.length || !captainOptionId) {
          showToast(`Не отправлено: выбрано ${selectedCount}/${slots.length}, капитан ${captainOptionId ? "есть" : "не выбран"}`);
          return;
        }
      }

      const body = {
        user_id: uid,
        round_id: roundId,
        draft_answers: enrichedDraftAnswers,
        captain_option_id: captainOptionId,
        lineup_status: status,
        lineup_source: "draft_v2_enriched",
        updated_at: new Date().toISOString(),
        ...(status === "submitted" ? { submitted_at: new Date().toISOString() } : {}),
      };

      // Надёжнее, чем upsert: сначала ищем существующий состав, потом PATCH или POST.
      // Так не зависим от уникального индекса и меньше ловим "ошибка сохранения".
      const existingR = await supa(`ffc_lineups?round_id=eq.${roundId}&user_id=eq.${uid}&select=id&limit=1`, { token: authToken });
      let existingId = null;
      if (existingR.ok) {
        const existing = await existingR.json().catch(() => []);
        existingId = existing?.[0]?.id || null;
      } else {
        console.warn("saveLineup existing lookup failed", existingR.status, await existingR.text().catch(() => ""));
      }

      const r = existingId
        ? await supa(`ffc_lineups?id=eq.${existingId}`, {
            method: "PATCH",
            token: authToken,
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(body),
          })
        : await supa("ffc_lineups", {
            method: "POST",
            token: authToken,
            headers: { Prefer: "return=representation" },
            body: JSON.stringify(body),
          });

      if (r.ok) {
        await r.json().catch(() => null);
        setLineupStatus(status);
        if (status === "submitted") setSubmittedAt(new Date().toISOString());

        // Дополнительный маркер участия: нужен, чтобы админка и «Участники» видели, что состав БК отправлен,
        // даже если таблица ffc_lineups позже читается с ограничениями.
        if (status === "submitted") {
          try {
            await supa("ffc_cup_entries", {
              method: "POST",
              token: authToken,
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ user_id: uid, round_id: roundId, status: "lineup_submitted" }),
            });
          } catch (e) { console.warn("ffc_cup_entries marker skipped", e); }
        }

        showToast(status === "submitted" ? "✓ Состав отправлен и сохранён в таблицу!" : "✓ Черновик сохранён");
      } else {
        const text = await r.text().catch(() => "");
        console.warn("saveLineup failed", r.status, text);
        if (r.status === 401 || /JWT expired|invalid jwt|PGRST303/i.test(text)) {
          showToast("Сессия истекла. Выйди и войди заново.");
        } else if (r.status === 42501 || /row-level security/i.test(text)) {
          showToast("Ошибка сохранения: RLS не даёт сохранить состав");
        } else if (r.status === 400 && /updated_at|schema cache|column/i.test(text)) {
          showToast("Ошибка сохранения: проверь колонки ffc_lineups");
        } else {
          showToast(`Ошибка сохранения (${r.status})`);
        }
      }
    } catch (e) {
      console.warn("saveLineup exception", e);
      showToast("Ошибка сохранения: " + (e?.message || String(e)));
    } finally {
      setSaving(false);
    }
  }

  // Validation
  const allSlotsAnswered = slots.every(s => draftAnswers[s.slot_key]);
  const nonCoachAnswered = slots.filter(s => s.position !== "coach" && draftAnswers[s.slot_key]);
  const canSetCaptain = nonCoachAnswered.length > 0;
  const captainCandidates = nonCoachAnswered.map(s => (options[s.slot_key] || []).find(o => o.id === draftAnswers[s.slot_key])).filter(Boolean);

  if (loading) return <div style={{ padding: 32, textAlign: "center", color: "rgba(240,237,230,.4)" }}>Загрузка драфта…</div>;

  if (noDraft) return (
    <div style={{ padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 28, marginBottom: 12 }}>⚽</div>
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>Драфт тура ещё готовится</div>
      <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", lineHeight: 1.6 }}>
        Список игроков для выбора появится ближе к началу тура.<br/>Следите за обновлениями.
      </div>
    </div>
  );

  // Read-only result view if submitted and past deadline
  if (lineupStatus === "submitted" && isPastDeadline) {
    return (
      <div>
        <div style={{ background: "rgba(22,163,74,.08)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 10, padding: "16px 18px", marginBottom: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#86EFAC", marginBottom: 4 }}>✓ Состав отправлен</div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)" }}>{submittedAt ? `Отправлен: ${new Date(submittedAt).toLocaleString("ru")}` : ""}</div>
        </div>
        {matchInfo ? (
          <div style={{ background: "rgba(29,78,216,.08)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, color: "#93C5FD", marginBottom: 6 }}>⚔ Пары сформированы</div>
            <div style={{ fontSize: 13, color: "#F0EDE6" }}>
              {matchInfo.is_bye ? "Свободная победа (bye)" : `Соперник: ${matchInfo.opponent_name || "определяется"}`}
            </div>
          </div>
        ) : (
          <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: 16, marginBottom: 16, textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)" }}>Соперник назначается после жеребьёвки</div>
          </div>
        )}
        <DraftSummary slots={slots} options={options} draftAnswers={draftAnswers} captainOptionId={captainOptionId} readonly />
      </div>
    );
  }

  const totalSteps = slots.length + 1; // +1 for captain
  const currentSlot = step < slots.length ? slots[step] : null;
  const currentOptions = currentSlot ? (options[currentSlot.slot_key] || []) : [];
  const isCaptainStep = step === slots.length;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(20px,1.5vw,28px)", fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>
          ⚽ Битва клубов — Драфт тура
        </div>
        <div style={{ fontSize: "clamp(14px,.95vw,17px)", color: "rgba(240,237,230,.45)", lineHeight: 1.5 }}>
          Собери тренера и 11 игроков из 60 вариантов. По 5 кандидатов на каждый из 12 слотов. Это не сложный fantasy-менеджер — только короткий список тура.
        </div>
      </div>

      {/* Deadline banner */}
      {!isPastDeadline && (
        <div style={{ background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.2)", borderRadius: 8, padding: "clamp(8px,.6vw,12px) clamp(14px,1vw,20px)", marginBottom: 14, fontSize: "clamp(13px,.9vw,16px)", color: "#FDE68A" }}>
          ⏰ Отправь состав до 11 июня 22:00 МСК · После дедлайна — жеребьёвка пар
        </div>
      )}

      {lineupStatus === "submitted" && (
        <div style={{ background: "rgba(22,163,74,.08)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 8, padding: "clamp(8px,.6vw,12px) clamp(14px,1vw,20px)", marginBottom: 14, fontSize: "clamp(13px,.9vw,16px)", color: "#86EFAC" }}>
          ✓ Состав отправлен{submittedAt ? ` · ${new Date(submittedAt).toLocaleDateString("ru")}` : ""} · Соперник будет назначен после дедлайна
        </div>
      )}
      {lineupStatus === "draft" && (
        <div style={{ background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.15)", borderRadius: 8, padding: "clamp(8px,.6vw,12px) clamp(14px,1vw,20px)", marginBottom: 14, fontSize: "clamp(13px,.9vw,16px)", color: "#FDE68A" }}>
          📋 Черновик сохранён · Не забудь нажать «Отправить состав»
        </div>
      )}

      {/* Progress bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap" }}>
        {slots.map((s, i) => {
          const done = !!draftAnswers[s.slot_key];
          const active = step === i;
          return (
            <button key={s.slot_key} onClick={() => { if (!isPastDeadline) setStep(i); }}
              style={{ fontSize: "clamp(11px,.75vw,14px)", padding: "clamp(4px,.3vw,7px) clamp(8px,.6vw,12px)", borderRadius: 4, border: `1px solid ${active ? "rgba(29,78,216,.7)" : done ? "rgba(22,163,74,.4)" : "rgba(255,255,255,.1)"}`, background: active ? "rgba(29,78,216,.2)" : done ? "rgba(22,163,74,.08)" : "transparent", color: active ? "#93C5FD" : done ? "#86EFAC" : "rgba(240,237,230,.4)", cursor: isPastDeadline ? "default" : "pointer" }}>
              {done ? "✓" : `${i+1}`} {s.slot_label}
            </button>
          );
        })}
        <button onClick={() => { if (!isPastDeadline) setStep(slots.length); }}
          style={{ fontSize: "clamp(11px,.75vw,14px)", padding: "clamp(4px,.3vw,7px) clamp(8px,.6vw,12px)", borderRadius: 4, border: `1px solid ${isCaptainStep ? "rgba(245,158,11,.7)" : captainOptionId ? "rgba(245,158,11,.35)" : "rgba(255,255,255,.1)"}`, background: isCaptainStep ? "rgba(245,158,11,.15)" : captainOptionId ? "rgba(245,158,11,.05)" : "transparent", color: isCaptainStep ? "#FDE68A" : captainOptionId ? "#FDE68A" : "rgba(240,237,230,.4)", cursor: isPastDeadline ? "default" : "pointer" }}>
          {captainOptionId ? "✓" : "🏅"} Капитан
        </button>
      </div>

      {/* Current step */}
      {!isCaptainStep && currentSlot && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(16px,1.2vw,20px)", fontWeight: 700, color: "#F0EDE6", marginBottom: 12 }}>
            Шаг {step + 1} из {slots.length}: {currentSlot.slot_label}
          </div>
          {/* 5 карточек в ряд на desktop, адаптивно на мобиле */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
            {currentOptions.map(opt => {
              const selected = draftAnswers[currentSlot.slot_key] === opt.id;
              return (
                <button key={opt.id} onClick={() => { if (!isPastDeadline) setDraftAnswers(a => ({ ...a, [currentSlot.slot_key]: opt.id })); }}
                  style={{ background: selected ? "rgba(29,78,216,.22)" : "rgba(255,255,255,.04)", border: `2px solid ${selected ? "rgba(59,130,246,.75)" : "rgba(255,255,255,.1)"}`, borderRadius: 10, padding: "14px 10px", cursor: isPastDeadline ? "default" : "pointer", textAlign: "center", transition: "all .12s", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minHeight: 90 }}>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(15px,1vw,19px)", fontWeight: 700, color: selected ? "#93C5FD" : "#F0EDE6", lineHeight: 1.2 }}>
                    {displayPlayerName(opt.player_name)}
                  </div>
                  <div style={{ fontSize: "clamp(11px,.75vw,14px)", color: "rgba(240,237,230,.5)", lineHeight: 1.3 }}>
                    {opt.national_team}
                  </div>
                  {selected && <span style={{ fontSize: 11, color: "#93C5FD", marginTop: 2 }}>✓</span>}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {step > 0 && <button className="sb" onClick={() => setStep(s => s - 1)}>← Назад</button>}
            <button className="bp" style={{ flex: 1 }} disabled={!draftAnswers[currentSlot.slot_key]} onClick={() => setStep(s => s + 1)}>
              {step < slots.length - 1 ? "Далее →" : "Выбрать капитана →"}
            </button>
          </div>
        </div>
      )}

      {/* Captain step */}
      {isCaptainStep && (
        <div>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(17px,1.3vw,22px)", fontWeight: 700, color: "#FDE68A", marginBottom: 4 }}>🏅 Выбор капитана</div>
          <div style={{ fontSize: "clamp(13px,.9vw,16px)", color: "rgba(240,237,230,.45)", marginBottom: 12 }}>Капитан получает ×1.5 очков. Тренер не может быть капитаном.</div>
          {captainCandidates.length === 0 && <div style={{ fontSize: 13, color: "#FCA5A5" }}>Сначала выбери всех игроков</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 16 }}>
            {captainCandidates.map(opt => {
              const selected = captainOptionId === opt.id;
              return (
                <button key={opt.id} onClick={() => { if (!isPastDeadline) setCaptainOptionId(selected ? null : opt.id); }}
                  style={{ background: selected ? "rgba(245,158,11,.18)" : "rgba(255,255,255,.04)", border: `2px solid ${selected ? "rgba(245,158,11,.7)" : "rgba(255,255,255,.1)"}`, borderRadius: 10, padding: "14px 10px", cursor: isPastDeadline ? "default" : "pointer", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minHeight: 80 }}>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(15px,1vw,19px)", fontWeight: 700, color: selected ? "#FDE68A" : "#F0EDE6", lineHeight: 1.2 }}>{displayPlayerName(opt.player_name)}</div>
                  <div style={{ fontSize: "clamp(11px,.75vw,14px)", color: "rgba(240,237,230,.5)" }}>{opt.national_team}</div>
                  {selected && <span style={{ fontSize: 11, color: "#FDE68A" }}>🏅 ×1.5</span>}
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="sb" onClick={() => setStep(slots.length - 1)}>← Назад</button>
          </div>
        </div>
      )}

      {/* Summary + Save buttons */}
      {allSlotsAnswered && (
        <div style={{ marginTop: 20, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: 16 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(16px,1.1vw,20px)", fontWeight: 600, color: "#F0EDE6", marginBottom: 10 }}>Твой состав</div>
          <DraftSummary slots={slots} options={options} draftAnswers={draftAnswers} captainOptionId={captainOptionId} />
          {!isPastDeadline && (
            <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
              <button className="sb" disabled={saving} onClick={() => saveLineup("draft")}>
                {saving ? "…" : "Сохранить черновик"}
              </button>
              <button
                style={{ flex: 2, background: "#16A34A", color: "#fff", border: "none", fontFamily: "Oswald,sans-serif", fontSize: "clamp(15px,1.1vw,19px)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "clamp(11px,.85vw,15px) clamp(18px,1.4vw,28px)", borderRadius: 4, cursor: (saving || !captainOptionId || !allSlotsAnswered) ? "not-allowed" : "pointer", opacity: (saving || !captainOptionId || !allSlotsAnswered) ? 0.5 : 1, transition: ".15s" }}
                disabled={saving || !captainOptionId || !allSlotsAnswered}
                title={!allSlotsAnswered ? "Выбери все 12 позиций и капитана" : !captainOptionId ? "Выбери капитана" : ""}
                onClick={() => saveLineup("submitted")}>
                {saving ? "Сохраняю…" : "🚀 Отправить состав"}
              </button>
            </div>
          )}
          {isPastDeadline && <div style={{ marginTop: 10, fontSize: 12, color: "#FCA5A5" }}>Дедлайн истёк. Состав нельзя изменить.</div>}
        </div>
      )}
    </div>
  );
}

// Вспомогательный компонент — сводка состава
// ── FootballFieldSummary — состав на футбольном поле ──
function DraftSummary({ slots, options, draftAnswers, captainOptionId, readonly }) {
  // Группируем слоты по позиции для схемы поля
  const byPos = {};
  slots.forEach(s => {
    const pos = s.position;
    if (!byPos[pos]) byPos[pos] = [];
    const optId = draftAnswers[s.slot_key];
    const opt = (options[s.slot_key] || []).find(o => o.id === optId);
    byPos[pos].push({ slot: s, opt, isCaptain: captainOptionId === optId && pos !== "coach" });
  });

  const rows = [
    { label: "Нападающие", positions: ["forward"] },
    { label: "Полузащитники", positions: ["midfielder"] },
    { label: "Защитники", positions: ["defender"] },
    { label: "Вратарь", positions: ["goalkeeper"] },
  ];

  const PlayerChip = ({ opt, isCaptain, slotLabel }) => (
    <div style={{
      background: opt ? "rgba(22,163,74,.18)" : "rgba(255,255,255,.04)",
      border: `1.5px solid ${opt ? (isCaptain ? "#FDE68A" : "rgba(22,163,74,.5)") : "rgba(255,255,255,.12)"}`,
      borderRadius: 8, padding: "6px 10px", minWidth: 90, maxWidth: 130,
      textAlign: "center", position: "relative", flex: "0 0 auto",
    }}>
      {isCaptain && (
        <div style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", fontSize: 13 }}>🏅</div>
      )}
      <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(12px,.85vw,15px)", fontWeight: 700, color: opt ? "#F0EDE6" : "rgba(240,237,230,.25)", lineHeight: 1.2, marginTop: isCaptain ? 4 : 0 }}>
        {opt ? displayPlayerName(opt.player_name) : slotLabel}
      </div>
      {opt && (
        <div style={{ fontSize: "clamp(9px,.65vw,11px)", color: "rgba(240,237,230,.45)", marginTop: 2 }}>{opt.national_team}</div>
      )}
      {isCaptain && <div style={{ fontSize: 9, color: "#FDE68A", marginTop: 2 }}>×1.5</div>}
    </div>
  );

  const coach = (byPos["coach"] || [])[0];

  return (
    <div style={{ background: "linear-gradient(180deg,#1a4a1a 0%,#166016 40%,#1a4a1a 100%)", borderRadius: 12, padding: "16px 12px", position: "relative", overflow: "hidden" }}>
      {/* Поле — разметка */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        <div style={{ position: "absolute", top: "50%", left: "10%", right: "10%", height: 1, background: "rgba(255,255,255,.15)" }} />
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 70, height: 70, borderRadius: "50%", border: "1px solid rgba(255,255,255,.15)" }} />
      </div>

      {/* Схема 4-4-2 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "relative" }}>
        {rows.map(({ label, positions }) => {
          const players = positions.flatMap(pos => (byPos[pos] || []));
          if (!players.length) return null;
          return (
            <div key={label}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,.4)", textAlign: "center", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
                {players.map(({ slot, opt, isCaptain }) => (
                  <PlayerChip key={slot.slot_key} opt={opt} isCaptain={isCaptain} slotLabel={slot.slot_label} />
                ))}
              </div>
            </div>
          );
        })}

        {/* Тренер */}
        {coach && (
          <div style={{ borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: 10 }}>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,.4)", textAlign: "center", marginBottom: 6, letterSpacing: 1, textTransform: "uppercase" }}>Тренер</div>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <PlayerChip opt={coach.opt} isCaptain={false} slotLabel="Тренер" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AdminClubBattlePanel — управление Битвой клубов ──
function AdminClubBattlePanel({ session, showToast }) {
  const [subTab, setSubTab] = React.useState("draft");
  const [rounds, setRounds] = React.useState([]);
  const [selectedRound, setSelectedRound] = React.useState("");
  const [csvText, setCsvText] = React.useState("");
  const [preview, setPreview] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  const [lineups, setLineups] = React.useState([]);
  const [profiles, setProfiles] = React.useState([]);
  const [matches, setMatches] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const token = session?.access_token;

  const VALID_SLOTS = [
    "coach","goalkeeper",
    "defender1","defender2","defender3","defender4",
    "midfielder1","midfielder2","midfielder3","midfielder4",
    "forward1","forward2"
  ];

  const DEFAULT_DRAFT_CSV = `round_no,slot_key,slot_label,slot_order,position,option_no,player_name,national_team,tag,is_recommended
1,coach,Тренер,1,coach,1,Lionel Scaloni,Аргентина,Надёжный,true
1,coach,Тренер,1,coach,2,Didier Deschamps,Франция,Опыт,false
1,coach,Тренер,1,coach,3,Julian Nagelsmann,Германия,Форма,false
1,coach,Тренер,1,coach,4,Luis de la Fuente,Испания,Система,false
1,coach,Тренер,1,coach,5,Marcelo Bielsa,Уругвай,Риск,false
1,goalkeeper,Вратарь,2,goalkeeper,1,Guillermo Ochoa,Мексика,Опыт,false
1,goalkeeper,Вратарь,2,goalkeeper,2,Ronwen Williams,ЮАР,Сейвы,false
1,goalkeeper,Вратарь,2,goalkeeper,3,Mat Ryan,Австралия,Надёжный,false
1,goalkeeper,Вратарь,2,goalkeeper,4,Gregor Kobel,Швейцария,Звезда,false
1,goalkeeper,Вратарь,2,goalkeeper,5,Emiliano Martinez,Аргентина,Звезда,true
1,defender1,Защитник 1,3,defender,1,Achraf Hakimi,Марокко,Звезда,true
1,defender1,Защитник 1,3,defender,2,Virgil van Dijk,Нидерланды,Надёжный,false
1,defender1,Защитник 1,3,defender,3,Kalidou Koulibaly,Сенегал,Опыт,false
1,defender1,Защитник 1,3,defender,4,Josko Gvardiol,Хорватия,Форма,false
1,defender1,Защитник 1,3,defender,5,Wilfried Singo,Кот-д'Ивуар,Скрытый вариант,false
1,defender2,Защитник 2,4,defender,1,Kim Min-jae,Республика Корея,Надёжный,false
1,defender2,Защитник 2,4,defender,2,Marquinhos,Бразилия,Опыт,false
1,defender2,Защитник 2,4,defender,3,John Stones,Англия,Надёжный,false
1,defender2,Защитник 2,4,defender,4,Alphonso Davies,Канада,Атака,true
1,defender2,Защитник 2,4,defender,5,Nuno Mendes,Португалия,Форма,false
1,defender3,Защитник из андердогов,5,defender,1,Liberato Cacace,Новая Зеландия,Андердог,false
1,defender3,Защитник из андердогов,5,defender,2,Stopira,Кабо-Верде,Андердог,false
1,defender3,Защитник из андердогов,5,defender,3,Michael Amir Murillo,Панама,Андердог,true
1,defender3,Защитник из андердогов,5,defender,4,Abdukodir Khusanov,Узбекистан,Андердог,false
1,defender3,Защитник из андердогов,5,defender,5,Jurien Gaari,Кюрасао,Андердог,false
1,defender4,Защитник 4,6,defender,1,Sead Kolasinac,Босния и Герцеговина,Опыт,false
1,defender4,Защитник 4,6,defender,2,Lucas Mendes,Катар,Надёжный,false
1,defender4,Защитник 4,6,defender,3,Chris Richards,США,Риск,false
1,defender4,Защитник 4,6,defender,4,Andy Robertson,Шотландия,Атака,true
1,defender4,Защитник 4,6,defender,5,Antonee Robinson,США,Форма,false
1,midfielder1,Полузащитник 1,7,midfielder,1,Jude Bellingham,Англия,Звезда,true
1,midfielder1,Полузащитник 1,7,midfielder,2,Pedri,Испания,Контроль,false
1,midfielder1,Полузащитник 1,7,midfielder,3,Federico Valverde,Уругвай,Мотор,false
1,midfielder1,Полузащитник 1,7,midfielder,4,Kevin De Bruyne,Бельгия,Ассистент,false
1,midfielder1,Полузащитник 1,7,midfielder,5,Jamal Musiala,Германия,Дриблинг,false
1,midfielder2,Полузащитник 2,8,midfielder,1,Granit Xhaka,Швейцария,Надёжный,false
1,midfielder2,Полузащитник 2,8,midfielder,2,Hakan Calhanoglu,Турция,Пенальтист,true
1,midfielder2,Полузащитник 2,8,midfielder,3,Moises Caicedo,Эквадор,Отбор,false
1,midfielder2,Полузащитник 2,8,midfielder,4,Takefusa Kubo,Япония,Риск,false
1,midfielder2,Полузащитник 2,8,midfielder,5,Mohammed Kudus,Гана,Скрытый вариант,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,1,Zidane Iqbal,Ирак,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,2,Noor Al-Rawabdeh,Иордания,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,3,Jean-Ricner Bellegarde,Гаити,Андердог,true
1,midfielder3,Полузащитник из андердогов,9,midfielder,4,Aissa Laidouni,Тунис,Андердог,false
1,midfielder3,Полузащитник из андердогов,9,midfielder,5,Jackson Irvine,Австралия,Андердог,false
1,midfielder4,Полузащитник 4,10,midfielder,1,Miguel Almiron,Парагвай,Форма,false
1,midfielder4,Полузащитник 4,10,midfielder,2,Ismael Bennacer,Алжир,Контроль,false
1,midfielder4,Полузащитник 4,10,midfielder,3,Marcel Sabitzer,Австрия,Удар,false
1,midfielder4,Полузащитник 4,10,midfielder,4,Richard Rios,Колумбия,Мотор,false
1,midfielder4,Полузащитник 4,10,midfielder,5,Salem Al-Dawsari,Саудовская Аравия,Риск,true
1,forward1,Нападающий 1,11,forward,1,Kylian Mbappe,Франция,Звезда,true
1,forward1,Нападающий 1,11,forward,2,Эрлинг Холанд,Норвегия,Гол,false
1,forward1,Нападающий 1,11,forward,3,Lionel Messi,Аргентина,Магия,false
1,forward1,Нападающий 1,11,forward,4,Vinicius Jr,Бразилия,Дриблинг,false
1,forward1,Нападающий 1,11,forward,5,Cristiano Ronaldo,Португалия,Опыт,false
1,forward2,Нападающий 2,12,forward,1,Mohamed Salah,Египет,Звезда,true
1,forward2,Нападающий 2,12,forward,2,Alexander Isak,Швеция,Форма,false
1,forward2,Нападающий 2,12,forward,3,Mehdi Taremi,Иран,Пенальтист,false
1,forward2,Нападающий 2,12,forward,4,Yoane Wissa,ДР Конго,Скрытый вариант,false
1,forward2,Нападающий 2,12,forward,5,Patrik Schick,Чехия,Гол,false`;

  React.useEffect(() => {
    supa("ffc_rounds?select=id,name,round_no,pairing_status&order=round_no.asc", { token })
      .then(r => r.ok ? r.json() : []).then(d => { setRounds(d || []); if (d?.[0]) setSelectedRound(d[0].id); });
  }, []);

  React.useEffect(() => {
    if (selectedRound && subTab === "monitor") loadMonitor();
  }, [selectedRound, subTab]);

  async function loadMonitor() {
    setLoading(true);
    try {
      const [lr, pr, mr] = await Promise.all([
        supa(`ffc_lineups?round_id=eq.${selectedRound}&select=*`, { token }),
        supa("profiles?select=id,name,email", { token }),
        supa(`ffc_club_matches?round_id=eq.${selectedRound}&select=*`, { token }),
      ]);
      setLineups(lr.ok ? await lr.json() : []);
      setProfiles(pr.ok ? await pr.json() : []);
      setMatches(mr.ok ? await mr.json() : []);
    } catch {}
    setLoading(false);
  }

  function parseCSV(text) {
    const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], errors: ["Файл пуст"] };
    const header = lines[0].split(",").map(h => h.trim().toLowerCase());
    const errors = [];
    const rows = lines.slice(1).map((line, i) => {
      const vals = line.split(",").map(v => v.trim());
      const obj = {};
      header.forEach((h, idx) => { obj[h] = vals[idx] || ""; });
      if (!obj.slot_key) errors.push(`Строка ${i+2}: нет slot_key`);
      if (!obj.player_name) errors.push(`Строка ${i+2}: нет player_name`);
      return obj;
    });

    // Validation
    const slotGroups = {};
    rows.forEach(r => { if (!slotGroups[r.slot_key]) slotGroups[r.slot_key] = []; slotGroups[r.slot_key].push(r); });
    const foundSlots = Object.keys(slotGroups);
    const missingSlots = VALID_SLOTS.filter(s => !foundSlots.includes(s));
    const extraSlots = foundSlots.filter(s => !VALID_SLOTS.includes(s));
    if (missingSlots.length) errors.push(`Отсутствуют слоты: ${missingSlots.join(", ")}`);
    if (extraSlots.length) errors.push(`Неизвестные слоты: ${extraSlots.join(", ")}`);
    foundSlots.forEach(sk => {
      if (slotGroups[sk].length !== 5) errors.push(`Слот ${sk}: ${slotGroups[sk].length} вариантов, нужно 5`);
    });
    if (rows.length !== 60) errors.push(`Всего строк: ${rows.length}, нужно 60 (12 слотов × 5 вариантов)`);

    return { rows, errors, slotGroups };
  }

  function handlePreview() {
    if (!selectedRound) { showToast("Выберите тур"); return; }
    const result = parseCSV(csvText);
    setPreview(result);
  }

  async function handleImport() {
    if (!preview || !selectedRound) return;
    if (preview.errors.length) { showToast("Исправьте ошибки"); return; }
    setImporting(true);
    let ok = 0, errs = 0;
    const { slotGroups } = preview;

    for (const [slotKey, slotRows] of Object.entries(slotGroups)) {
      const firstRow = slotRows[0];
      // Upsert slot
      try {
        await supa("ffc_round_draft_slots", {
          method: "POST", token,
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            round_id: selectedRound,
            slot_key: slotKey,
            slot_label: firstRow.slot_label || slotKey,
            slot_order: parseInt(firstRow.slot_order) || (VALID_SLOTS.indexOf(slotKey) + 1),
            position: firstRow.position || slotKey,
          }),
        });
      } catch {}

      // Upsert options
      for (const [idx, row] of slotRows.entries()) {
        try {
          await supa("ffc_round_draft_options", {
            method: "POST", token,
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              round_id: selectedRound,
              slot_key: slotKey,
              option_no: parseInt(row.option_no) || (idx + 1),
              player_name: row.player_name,
              national_team: row.national_team || null,
              position: row.position || slotKey,
              tag: row.tag || null,
              is_recommended: row.is_recommended === "true" || row.is_recommended === "1",
              display_priority: parseInt(row.display_priority) || (idx + 1) * 10,
            }),
          });
          ok++;
        } catch { errs++; }
      }
    }
    setImporting(false); setPreview(null); setCsvText("");
    showToast(`✓ Драфт загружен: ${ok} вариантов${errs ? `, ошибок ${errs}` : ""}`);
  }

  async function generateAutoLineup(roundId, userId) {
    try {
      const sr = await supa(`ffc_round_draft_slots?round_id=eq.${roundId}&order=slot_order.asc`, { token });
      const or = await supa(`ffc_round_draft_options?round_id=eq.${roundId}&order=slot_key.asc,option_no.asc`, { token });
      if (!sr.ok || !or.ok) return false;
      const slotsD = await sr.json();
      const optsD = await or.json();
      const optMap = {};
      optsD.forEach(o => { if (!optMap[o.slot_key]) optMap[o.slot_key] = []; optMap[o.slot_key].push(o); });

      const answers = {};
      let captainId = null;
      for (const s of slotsD) {
        const pool = optMap[s.slot_key] || [];
        const rec = pool.find(o => o.is_recommended) || pool[0];
        if (rec) { answers[s.slot_key] = rec.id; }
      }
      // Captain: recommended forward or midfielder
      const nonCoach = slotsD.filter(s => s.position !== "coach");
      for (const s of nonCoach) {
        const opt = (optMap[s.slot_key] || []).find(o => o.id === answers[s.slot_key]);
        if (opt && (opt.position === "forward" || opt.position === "midfielder")) {
          if (!captainId || opt.is_recommended) captainId = opt.id;
        }
      }
      await supa("ffc_lineups", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id: userId, round_id: roundId, draft_answers: answers, captain_option_id: captainId, lineup_status: "submitted", lineup_source: "auto", submitted_at: new Date().toISOString() }),
      });
      return true;
    } catch { return false; }
  }

  async function generateAllAutoLineups() {
    if (!selectedRound) return;
    // Get all approved/paid users
    const pr = await supa("participant_status?is_approved=eq.true&select=user_id", { token });
    const approved = pr.ok ? await pr.json() : [];
    const approvedIds = new Set(approved.map(r => r.user_id));

    // Get existing lineups
    const lr = await supa(`ffc_lineups?round_id=eq.${selectedRound}&select=user_id`, { token });
    const hasLineup = lr.ok ? new Set((await lr.json()).map(r => r.user_id)) : new Set();

    const missing = [...approvedIds].filter(id => !hasLineup.has(id));
    let done = 0;
    for (const uid of missing) { if (await generateAutoLineup(selectedRound, uid)) done++; }
    showToast(`✓ Автосоставы созданы: ${done}`);
    loadMonitor();
  }

  async function generatePairs() {
    if (!selectedRound) return;
    if (!window.confirm("Сформировать пары? Это действие нельзя отменить без переформирования.")) return;

    // Get all submitted lineups
    const lr = await supa(`ffc_lineups?round_id=eq.${selectedRound}&lineup_status=eq.submitted&select=user_id`, { token });
    if (!lr.ok) { showToast("Ошибка загрузки составов"); return; }
    const lineupUsers = await lr.json();
    let uids = lineupUsers.map(r => r.user_id);

    // Shuffle
    for (let i = uids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [uids[i], uids[j]] = [uids[j], uids[i]];
    }

    // Create pairs
    let created = 0;
    for (let i = 0; i < uids.length; i += 2) {
      const playerA = uids[i];
      const playerB = uids[i + 1] || null;
      try {
        await supa("ffc_club_matches", {
          method: "POST", token,
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ round_id: selectedRound, player_a: playerA, player_b: playerB, is_bye: !playerB, status: "pending" }),
        });
        created++;
      } catch {}
    }

    // Update round pairing_status
    await supa(`ffc_rounds?id=eq.${selectedRound}`, {
      method: "PATCH", token, headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ pairing_status: "paired", paired_at: new Date().toISOString() }),
    });

    showToast(`✓ Пары сформированы: ${created} матчей`);
    loadMonitor();
  }

  const profileMap = Object.fromEntries(profiles.map(p => [p.id, p]));
  const lineupMap = Object.fromEntries(lineups.map(l => [l.user_id, l]));
  const submittedCount = lineups.filter(l => l.lineup_status === "submitted").length;
  const autoCount = lineups.filter(l => l.lineup_source === "auto").length;

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[["draft", "📋 Драфт тура 12×5"], ["monitor", "📊 Составы/Пары"]].map(([k, l]) => (
          <button key={k} onClick={() => setSubTab(k)}
            style={{ fontSize: 12, padding: "6px 14px", borderRadius: 4, border: `1px solid ${subTab===k?"rgba(245,158,11,.5)":"rgba(255,255,255,.1)"}`, background: subTab===k?"rgba(245,158,11,.08)":"transparent", color: subTab===k?"#FDE68A":"rgba(240,237,230,.5)", cursor: "pointer" }}>
            {l}
          </button>
        ))}
      </div>

      {subTab === "draft" && (
        <div className="panel">
          <div className="ph"><span className="pt">Загрузка драфта тура (12 позиций × 5 вариантов = 60 строк)</span></div>
          <div style={{ padding: "14px 16px" }}>
            <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.15)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#93C5FD", lineHeight: 1.6 }}>
              💡 Рекомендуемый баланс: не только звёзды. Добавь игроков фаворитов, средних сборных и андердогов. Слоты defender3 и midfielder3 специально отданы под андердогов.
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", marginBottom: 6 }}>Тур:</div>
              <select value={selectedRound} onChange={e => setSelectedRound(e.target.value)}
                style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 12, padding: "6px 10px", outline: "none", width: "100%", maxWidth: 360 }}>
                <option value="">— выберите тур —</option>
                {rounds.map(r => <option key={r.id} value={r.id}>{r.name || `Тур ${r.round_no}`}</option>)}
              </select>
            </div>

            <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginBottom: 8 }}>
              CSV: <code style={{ color: "#FDE68A" }}>round_no,slot_key,slot_label,slot_order,position,option_no,player_name,national_team,tag,is_recommended</code>
            </div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginBottom: 8 }}>
              slot_key: coach | goalkeeper | defender1 | defender2 | defender3 | defender4 | midfielder1 | midfielder2 | midfielder3 | midfielder4 | forward1 | forward2<br/>
              Всего должно быть ровно 60 строк (12 слотов × 5 вариантов каждый). CSV должен содержать 60 строк: 12 слотов × 5 вариантов.
            </div>
            <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
              placeholder={"round_no,slot_key,slot_label,slot_order,position,option_no,player_name,national_team,tag,is_recommended\n1,coach,Тренер,1,coach,1,Лионель Скалони,Аргентина,Надёжный,true\n1,goalkeeper,Вратарь,2,goalkeeper,1,Эмилиано Мартинес,Аргентина,Надёжный,true"}
              style={{ width: "100%", height: 140, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontFamily: "monospace", fontSize: 11, padding: 8, outline: "none", resize: "vertical", boxSizing: "border-box" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="sb" style={{ fontSize: 12 }} onClick={handlePreview} disabled={!csvText.trim() || !selectedRound}>Предпросмотр</button>
              <button className="sb" style={{ fontSize: 11, color: "#FDE68A", borderColor: "rgba(245,158,11,.3)" }} onClick={() => setCsvText(DEFAULT_DRAFT_CSV)}>📋 Шаблон Тур 1</button>
              {preview && !preview.errors.length && (
                <button className="mini-btn green" style={{ fontSize: 12, padding: "6px 14px" }} onClick={handleImport} disabled={importing}>
                  {importing ? "Импорт…" : `✓ Загрузить ${preview.rows.length} строк`}
                </button>
              )}
            </div>

            {preview && (
              <div style={{ marginTop: 12 }}>
                {preview.errors.map((e, i) => <div key={i} style={{ fontSize: 11, color: "#FCA5A5", marginBottom: 4 }}>⚠ {e}</div>)}
                {!preview.errors.length && (
                  <div>
                    <div style={{ fontSize: 11, color: "#86EFAC", marginBottom: 8 }}>✓ Валидация пройдена: {preview.rows.length} строк, {Object.keys(preview.slotGroups || {}).length} слотов (нужно 12)</div>
                    <table className="admin-table">
                      <thead><tr><th>slot_key</th><th>Вариант</th><th>Игрок</th><th>Сборная</th><th>Тег</th><th>Рек.</th></tr></thead>
                      <tbody>
                        {preview.rows.slice(0, 12).map((r, i) => (
                          <tr key={i}>
                            <td style={{ fontSize: 10 }}>{r.slot_key}</td>
                            <td style={{ fontSize: 10 }}>{r.option_no}</td>
                            <td style={{ fontSize: 11 }}>{r.player_name}</td>
                            <td style={{ fontSize: 10 }}>{r.national_team}</td>
                            <td style={{ fontSize: 10 }}>{r.tag}</td>
                            <td style={{ fontSize: 10, color: r.is_recommended === "true" ? "#86EFAC" : "rgba(240,237,230,.3)" }}>{r.is_recommended === "true" ? "✓" : ""}</td>
                          </tr>
                        ))}
                        {preview.rows.length > 12 && <tr><td colSpan={6} style={{ fontSize: 10, textAlign: "center", color: "rgba(240,237,230,.3)" }}>…и ещё {preview.rows.length - 12}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "monitor" && (
        <div>
          {/* KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 14 }}>
            {[
              ["Составов отправлено", submittedCount, "#86EFAC"],
              ["Автосоставов", autoCount, "#FDE68A"],
              ["Матчей создано", matches.length, "#93C5FD"],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: c }}>{v}</div>
                <div style={{ fontSize: 10, color: "rgba(240,237,230,.45)" }}>{l}</div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            <select value={selectedRound} onChange={e => { setSelectedRound(e.target.value); }}
              style={{ background: "rgba(255,255,255,.07)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, color: "#F0EDE6", fontSize: 12, padding: "6px 10px", outline: "none" }}>
              {rounds.map(r => <option key={r.id} value={r.id}>{r.name || `Тур ${r.round_no}`}</option>)}
            </select>
            <button className="sb" style={{ fontSize: 11 }} onClick={loadMonitor}>↻ Обновить</button>
            <button className="mini-btn" style={{ fontSize: 11, color: "#FDE68A", borderColor: "rgba(245,158,11,.3)" }} onClick={generateAllAutoLineups}>🤖 Автосоставы</button>
            <button className="mini-btn green" style={{ fontSize: 11 }} onClick={generatePairs}>⚔ Сформировать пары</button>
          </div>

          {loading ? <div style={{ padding: 24, textAlign: "center", color: "rgba(240,237,230,.4)" }}>Загрузка…</div> : (
            <table className="admin-table">
              <thead><tr><th>Участник</th><th>Email</th><th>Статус</th><th>Источник</th><th>Отправлен</th></tr></thead>
              <tbody>
                {profiles.map(p => {
                  const ln = lineupMap[p.id];
                  return (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12 }}>{p.name || "—"}</td>
                      <td style={{ fontSize: 11, color: "rgba(240,237,230,.4)" }}>{p.email}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 600, color: ln?.lineup_status === "submitted" ? "#86EFAC" : ln?.lineup_status === "draft" ? "#FDE68A" : "rgba(240,237,230,.3)" }}>
                          {ln?.lineup_status === "submitted" ? "✓ Отправлен" : ln?.lineup_status === "draft" ? "📋 Черновик" : "—"}
                        </span>
                      </td>
                      <td style={{ fontSize: 10, color: ln?.lineup_source === "auto" ? "#FDE68A" : "rgba(240,237,230,.4)" }}>
                        {ln?.lineup_source || "—"}
                      </td>
                      <td style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>
                        {ln?.submitted_at ? new Date(ln.submitted_at).toLocaleDateString("ru") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <details style={{ marginTop: 16 }}>
            <summary style={{ fontSize: 11, color: "rgba(240,237,230,.4)", cursor: "pointer" }}>SQL для таблиц Битвы клубов</summary>
            <pre style={{ fontSize: 10, color: "rgba(240,237,230,.5)", background: "rgba(0,0,0,.3)", padding: 12, borderRadius: 6, overflow: "auto", marginTop: 8 }}>{`CREATE TABLE IF NOT EXISTS public.ffc_round_draft_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES public.ffc_rounds(id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL, slot_label TEXT NOT NULL,
  slot_order INTEGER NOT NULL, position TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, slot_key)
);
CREATE TABLE IF NOT EXISTS public.ffc_round_draft_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES public.ffc_rounds(id) ON DELETE CASCADE,
  slot_key TEXT NOT NULL, option_no INTEGER NOT NULL,
  player_name TEXT NOT NULL, national_team TEXT, position TEXT,
  tag TEXT, is_recommended BOOLEAN DEFAULT false, display_priority INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(round_id, slot_key, option_no)
);
ALTER TABLE public.ffc_lineups ADD COLUMN IF NOT EXISTS draft_answers JSONB;
ALTER TABLE public.ffc_lineups ADD COLUMN IF NOT EXISTS captain_option_id UUID;
ALTER TABLE public.ffc_lineups ADD COLUMN IF NOT EXISTS lineup_status TEXT DEFAULT 'draft';
ALTER TABLE public.ffc_lineups ADD COLUMN IF NOT EXISTS lineup_source TEXT DEFAULT 'manual';
ALTER TABLE public.ffc_lineups ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ffc_lineups_user_round ON public.ffc_lineups(user_id, round_id);
CREATE TABLE IF NOT EXISTS public.ffc_club_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES public.ffc_rounds(id) ON DELETE CASCADE,
  player_a UUID NOT NULL, player_b UUID,
  lineup_a_id UUID, lineup_b_id UUID,
  score_a NUMERIC DEFAULT 0, score_b NUMERIC DEFAULT 0,
  result TEXT, status TEXT DEFAULT 'pending',
  is_bye BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE public.ffc_rounds ADD COLUMN IF NOT EXISTS pairing_status TEXT DEFAULT 'not_paired';
ALTER TABLE public.ffc_rounds ADD COLUMN IF NOT EXISTS paired_at TIMESTAMPTZ;
-- RLS
ALTER TABLE public.ffc_round_draft_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ffc_round_draft_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ffc_club_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "draft_slots_all" ON public.ffc_round_draft_slots FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "draft_options_all" ON public.ffc_round_draft_options FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "club_matches_all" ON public.ffc_club_matches FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ffc_round_draft_slots TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ffc_round_draft_options TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.ffc_club_matches TO authenticated;`}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

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
const FOOTBALL_DAILY_QUESTION_BANK = [{"id":"fb_001","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: каталонский клуб, связанный с Ла Масией и сине-гранатовыми цветами.","options":["Реал Мадрид","Барселона"],"correct_answer":"Барселона","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_002","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: аргентинский №10, легенда Барселоны, чемпион мира-2022.","options":["Криштиану Роналду","Лионель Месси"],"correct_answer":"Лионель Месси","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_003","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: норвежский нападающий, мощный бомбардир Манчестер Сити.","options":["Лионель Месси","Эрлинг Холанд"],"correct_answer":"Эрлинг Холанд","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_004","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: мадридский клуб в белой форме, рекордсмен Лиги чемпионов.","options":["Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_005","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Что получает игрок за вторую жёлтую карточку в одном матче?","options":["Красную карточку","Устное предупреждение"],"correct_answer":"Красную карточку","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_006","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется четыре гола одного игрока в матче?","options":["Хет-трик","Покер"],"correct_answer":"Покер","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_007","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: испанский дирижёр полузащиты Барселоны и сборной Испании.","options":["Лионель Месси","Хави"],"correct_answer":"Хави","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_008","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: туринская Старая синьора.","options":["Реал Мадрид","Ювентус"],"correct_answer":"Ювентус","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_009","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Можно ли забить гол прямо с углового удара?","options":["Да","Нет"],"correct_answer":"Да","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_010","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2006 году?","options":["Италия","Аргентина"],"correct_answer":"Италия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_011","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: амстердамский клуб с сильной академией.","options":["Реал Мадрид","Аякс"],"correct_answer":"Аякс","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_012","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: египетский вингер, звезда Ливерпуля.","options":["Лионель Месси","Мохамед Салах"],"correct_answer":"Мохамед Салах","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_013","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: главный парижский клуб, играет на Парк де Пренс.","options":["ПСЖ","Реал Мадрид"],"correct_answer":"ПСЖ","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_014","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: португальская суперзвезда, играл за МЮ, Реал и Ювентус.","options":["Криштиану Роналду","Лионель Месси"],"correct_answer":"Криштиану Роналду","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_015","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что такое аренда игрока?","options":["Временный переход в другой клуб","Покупка навсегда"],"correct_answer":"Временный переход в другой клуб","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_016","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2022 году?","options":["Аргентина","Бразилия"],"correct_answer":"Аргентина","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_017","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что такое трансфер в футболе?","options":["Замена во время матча","Переход игрока в другой клуб"],"correct_answer":"Переход игрока в другой клуб","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_018","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что означает clean sheet в футболе?","options":["Матч без карточек","Матч без пропущенных голов"],"correct_answer":"Матч без пропущенных голов","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_019","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: уругвайский форвард, играл за Аякс, Ливерпуль и Барселону.","options":["Лионель Месси","Луис Суарес"],"correct_answer":"Луис Суарес","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_020","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: французский форвард, много лет был важным игроком Реала.","options":["Лионель Месси","Карим Бензема"],"correct_answer":"Карим Бензема","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_021","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: хорватский полузащитник, обладатель Золотого мяча-2018.","options":["Лионель Месси","Лука Модрич"],"correct_answer":"Лука Модрич","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_022","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: клуб с Энфилдом и гимном You’ll Never Walk Alone.","options":["Ливерпуль","Реал Мадрид"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_023","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: немецкий клуб с Жёлтой стеной.","options":["Реал Мадрид","Боруссия Дортмунд"],"correct_answer":"Боруссия Дортмунд","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_024","category":"Клубы и страны","question_type":"Клуб → страна","options_count":2,"question":"В какой стране играет клуб Марсель?","options":["Франция","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_025","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: южнокорейский форвард, капитан Тоттенхэма.","options":["Сон Хын Мин","Лионель Месси"],"correct_answer":"Сон Хын Мин","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_026","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: испанский полузащитник, забил победный гол в финале ЧМ-2010.","options":["Андрес Иньеста","Лионель Месси"],"correct_answer":"Андрес Иньеста","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_027","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется три гола одного игрока в матче?","options":["Хет-трик","Дубль"],"correct_answer":"Хет-трик","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_028","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется положение вне игры?","options":["Офсайд","Фол"],"correct_answer":"Офсайд","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_029","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: ивуарийский форвард, герой финала ЛЧ-2012 для Челси.","options":["Лионель Месси","Дидье Дрогба"],"correct_answer":"Дидье Дрогба","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_030","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2010 году?","options":["Аргентина","Испания"],"correct_answer":"Испания","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_031","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Что означает ассист?","options":["Удар в створ","Голевая передача"],"correct_answer":"Голевая передача","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_032","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: французский форвард, чемпион мира-2018, известен скоростью.","options":["Лионель Месси","Килиан Мбаппе"],"correct_answer":"Килиан Мбаппе","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_033","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: бельгийский плеймейкер, ключевой игрок Манчестер Сити.","options":["Кевин Де Брёйне","Лионель Месси"],"correct_answer":"Кевин Де Брёйне","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_034","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: польский бомбардир, звезда Боруссии, Баварии и Барселоны.","options":["Лионель Месси","Роберт Левандовский"],"correct_answer":"Роберт Левандовский","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_035","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: португальский клуб со стадионом Драгау.","options":["Реал Мадрид","Порту"],"correct_answer":"Порту","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_036","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: шведский нападающий, играл за Аякс, Интер, Барселону, Милан и ПСЖ.","options":["Лионель Месси","Златан Ибрагимович"],"correct_answer":"Златан Ибрагимович","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_037","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: нерадзурри, один из двух больших клубов Сан-Сиро.","options":["Интер","Реал Мадрид"],"correct_answer":"Интер","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_038","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Какой удар выполняется из угла поля?","options":["Угловой","Пенальти"],"correct_answer":"Угловой","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_039","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Что происходит, если мяч полностью пересёк боковую линию?","options":["Пенальти","Вбрасывание аута"],"correct_answer":"Вбрасывание аута","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_040","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется система видеопомощи арбитрам?","options":["GPS","VAR"],"correct_answer":"VAR","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_041","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Как называется удар с 11-метровой отметки?","options":["Пенальти","Угловой"],"correct_answer":"Пенальти","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_042","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: шотландский клуб, участник дерби Олд Фирм.","options":["Реал Мадрид","Селтик"],"correct_answer":"Селтик","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_043","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: лиссабонский клуб, играет на Да Луж.","options":["Реал Мадрид","Бенфика"],"correct_answer":"Бенфика","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_044","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: бразилец, перешёл из Сантоса в Барселону, затем в ПСЖ.","options":["Лионель Месси","Неймар"],"correct_answer":"Неймар","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_045","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1994 году?","options":["Бразилия","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_046","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1990 году?","options":["Аргентина","Германия"],"correct_answer":"Германия","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_047","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: россонери, один из двух больших клубов Сан-Сиро.","options":["Милан","Реал Мадрид"],"correct_answer":"Милан","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_048","category":"Термины","question_type":"Правила/термины","options_count":2,"question":"Как называется матч между принципиальными соперниками из одного города или региона?","options":["Финал","Дерби"],"correct_answer":"Дерби","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_049","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: итальянский реджиста, мастер длинных передач и штрафных.","options":["Андреа Пирло","Лионель Месси"],"correct_answer":"Андреа Пирло","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_050","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: мюнхенский гранд, играет на Альянц Арене.","options":["Бавария","Реал Мадрид"],"correct_answer":"Бавария","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_051","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: нидерландский центральный защитник, лидер обороны Ливерпуля.","options":["Лионель Месси","Вирджил ван Дейк"],"correct_answer":"Вирджил ван Дейк","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_052","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1998 году?","options":["Аргентина","Франция"],"correct_answer":"Франция","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_053","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2014 году?","options":["Аргентина","Германия"],"correct_answer":"Германия","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_054","category":"Правила","question_type":"Правила/термины","options_count":2,"question":"Сколько игроков одной команды обычно находится на поле в футболе?","options":["11","10"],"correct_answer":"11","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_055","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 1986 году?","options":["Бразилия","Аргентина"],"correct_answer":"Аргентина","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_056","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: английский нападающий, много лет был лидером Тоттенхэма.","options":["Лионель Месси","Гарри Кейн"],"correct_answer":"Гарри Кейн","correct_key":"2","difficulty":"easy","media_required":false},{"id":"fb_057","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":2,"question":"Угадай клуб по подсказке: английский клуб с прозвищем Красные дьяволы.","options":["Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_058","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2002 году?","options":["Бразилия","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_059","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":2,"question":"Кто стал чемпионом мира по футболу в 2018 году?","options":["Франция","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_060","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":2,"question":"Угадай футболиста по подсказке: сенегальский вингер, выигрывал ЛЧ с Ливерпулем.","options":["Садио Мане","Лионель Месси"],"correct_answer":"Садио Мане","correct_key":"1","difficulty":"easy","media_required":false},{"id":"fb_061","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: камерунский форвард, выигрывал ЛЧ с Барселоной и Интером.","options":["Лионель Месси","Криштиану Роналду","Самуэль Это’О"],"correct_answer":"Самуэль Это’О","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_062","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Палмейрас?","options":["Бразилия","Франция","Аргентина"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_063","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: немецкий атакующий игрок, символ Баварии.","options":["Томас Мюллер","Лионель Месси","Криштиану Роналду"],"correct_answer":"Томас Мюллер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_064","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: итальянский вратарь, чемпион мира-2006.","options":["Джанлуиджи Буффон","Криштиану Роналду","Лионель Месси"],"correct_answer":"Джанлуиджи Буффон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_065","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Фенербахче?","options":["Аргентина","Бразилия","Турция"],"correct_answer":"Турция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_066","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: французский плеймейкер, забил два гола в финале ЧМ-1998.","options":["Лионель Месси","Зинедин Зидан","Криштиану Роналду"],"correct_answer":"Зинедин Зидан","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_067","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2011 году?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_068","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: бразильский волшебник мяча, звезда Барселоны и Милана.","options":["Лионель Месси","Роналдиньо","Криштиану Роналду"],"correct_answer":"Роналдиньо","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_069","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Камп Ноу”?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_070","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":3,"question":"Угадай клуб по подсказке: шотландский клуб, соперник Селтика в Олд Фирм.","options":["Барселона","Рейнджерс","Реал Мадрид"],"correct_answer":"Рейнджерс","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_071","category":"Угадай по подсказке","question_type":"Подсказка → клуб","options_count":3,"question":"Угадай клуб по подсказке: нерадзурри, один из двух больших клубов Сан-Сиро.","options":["Реал Мадрид","Интер","Барселона"],"correct_answer":"Интер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_072","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Аль-Наср?","options":["Аргентина","Саудовская Аравия","Бразилия"],"correct_answer":"Саудовская Аравия","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_073","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: немецкий вратарь, чемпион мира-2014 и мастер игры ногами.","options":["Лионель Месси","Мануэль Нойер","Криштиану Роналду"],"correct_answer":"Мануэль Нойер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_074","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: американский атакующий игрок, выступал в АПЛ.","options":["Клинт Демпси","Лионель Месси","Криштиану Роналду"],"correct_answer":"Клинт Демпси","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_075","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: итальянский защитник, символ Милана.","options":["Криштиану Роналду","Паоло Мальдини","Лионель Месси"],"correct_answer":"Паоло Мальдини","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_076","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Аль-Хиляль?","options":["Аргентина","Бразилия","Саудовская Аравия"],"correct_answer":"Саудовская Аравия","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_077","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: бразильский форвард, чемпион мира-2002, известен как Феномен.","options":["Криштиану Роналду","Лионель Месси","Роналдо Назарио"],"correct_answer":"Роналдо Назарио","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_078","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2010 году?","options":["Интер","Реал Мадрид","Барселона"],"correct_answer":"Интер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_079","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сан-Сиро”?","options":["Реал Мадрид","Милан и Интер","Барселона"],"correct_answer":"Милан и Интер","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_080","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: нидерландский нападающий, автор великого гола в финале Евро-1988.","options":["Марко ван Бастен","Криштиану Роналду","Лионель Месси"],"correct_answer":"Марко ван Бастен","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_081","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Шахтёр Донецк?","options":["Аргентина","Украина","Бразилия"],"correct_answer":"Украина","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_082","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2017 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_083","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Бока Хуниорс?","options":["Бразилия","Аргентина","Франция"],"correct_answer":"Аргентина","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_084","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Альянц Арена”?","options":["Бавария","Реал Мадрид","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_085","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Динамо Киев?","options":["Украина","Аргентина","Бразилия"],"correct_answer":"Украина","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_086","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2024 году?","options":["Манчестер Юнайтед","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_087","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Эмирейтс”?","options":["Арсенал","Реал Мадрид","Барселона"],"correct_answer":"Арсенал","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_088","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Ривер Плейт?","options":["Франция","Бразилия","Аргентина"],"correct_answer":"Аргентина","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_089","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Энфилд”?","options":["Барселона","Ливерпуль","Реал Мадрид"],"correct_answer":"Ливерпуль","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_090","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Олимпиакос?","options":["Греция","Бразилия","Аргентина"],"correct_answer":"Греция","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_091","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2015 году?","options":["Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Барселона","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_092","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: французский форвард, легенда Арсенала.","options":["Лионель Месси","Тьерри Анри","Криштиану Роналду"],"correct_answer":"Тьерри Анри","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_093","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2014 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_094","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: турецкий нападающий, легенда Галатасарая и сборной Турции.","options":["Хакан Шюкюр","Лионель Месси","Криштиану Роналду"],"correct_answer":"Хакан Шюкюр","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_095","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сантьяго Бернабеу”?","options":["Реал Мадрид","Барселона","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_096","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: мексиканский защитник, играл за Барселону.","options":["Лионель Месси","Рафаэль Маркес","Криштиану Роналду"],"correct_answer":"Рафаэль Маркес","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_097","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: либерийский нападающий, обладатель Золотого мяча-1995.","options":["Лионель Месси","Криштиану Роналду","Джордж Веа"],"correct_answer":"Джордж Веа","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_098","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2012 году?","options":["Реал Мадрид","Челси","Барселона"],"correct_answer":"Челси","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_099","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: испанский вратарь, капитан чемпионов мира-2010.","options":["Икер Касильяс","Лионель Месси","Криштиану Роналду"],"correct_answer":"Икер Касильяс","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_100","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: хорватский форвард, лучший бомбардир ЧМ-1998.","options":["Давор Шукер","Криштиану Роналду","Лионель Месси"],"correct_answer":"Давор Шукер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_101","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: корейский полузащитник, выигрывал АПЛ с Манчестер Юнайтед.","options":["Пак Чи Сон","Криштиану Роналду","Лионель Месси"],"correct_answer":"Пак Чи Сон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_102","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Лос-Анджелес Гэлакси?","options":["США","Аргентина","Бразилия"],"correct_answer":"США","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_103","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2023 году?","options":["Барселона","Манчестер Сити","Реал Мадрид"],"correct_answer":"Манчестер Сити","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_104","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2018 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_105","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Галатасарай?","options":["Аргентина","Бразилия","Турция"],"correct_answer":"Турция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_106","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Стэмфорд Бридж”?","options":["Барселона","Реал Мадрид","Челси"],"correct_answer":"Челси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_107","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Панатинаикос?","options":["Бразилия","Аргентина","Греция"],"correct_answer":"Греция","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_108","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2016 году?","options":["Манчестер Юнайтед","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_109","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":3,"question":"Какую сборную представлял Предраг Миятович?","options":["Бразилия","Аргентина","Черногория"],"correct_answer":"Черногория","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_110","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Сигнал Идуна Парк”?","options":["Боруссия Дортмунд","Барселона","Реал Мадрид"],"correct_answer":"Боруссия Дортмунд","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_111","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2013 году?","options":["Бавария","Реал Мадрид","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_112","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: японский фланговый защитник, играл за Интер.","options":["Криштиану Роналду","Юто Нагатомо","Лионель Месси"],"correct_answer":"Юто Нагатомо","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_113","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Парк де Пренс”?","options":["Реал Мадрид","Барселона","ПСЖ"],"correct_answer":"ПСЖ","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_114","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":3,"question":"Угадай футболиста по подсказке: английский полузащитник, знаменит штрафными и передачами.","options":["Дэвид Бекхэм","Лионель Месси","Криштиану Роналду"],"correct_answer":"Дэвид Бекхэм","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_115","category":"Стадионы","question_type":"Стадион → клуб","options_count":3,"question":"С каким клубом связан стадион “Олд Траффорд”?","options":["Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_116","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2022 году?","options":["Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_117","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2019 году?","options":["Реал Мадрид","Ливерпуль","Барселона"],"correct_answer":"Ливерпуль","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_118","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2021 году?","options":["Барселона","Реал Мадрид","Челси"],"correct_answer":"Челси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_119","category":"Клубы и страны","question_type":"Клуб → страна","options_count":3,"question":"К какой стране относится клуб Фламенго?","options":["Аргентина","Франция","Бразилия"],"correct_answer":"Бразилия","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_120","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":3,"question":"Кто выиграл Лигу чемпионов УЕФА в 2020 году?","options":["Реал Мадрид","Бавария","Барселона"],"correct_answer":"Бавария","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_121","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2018 году?","options":["Карим Бензема","Криштиану Роналду","Лука Модрич","Лионель Месси"],"correct_answer":"Лука Модрич","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_122","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2010 году?","options":["Карим Бензема","Лука Модрич","Лионель Месси","Криштиану Роналду"],"correct_answer":"Лионель Месси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_123","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2002 года?","options":["США","Франция","Япония и Южная Корея","Германия"],"correct_answer":"Япония и Южная Корея","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_124","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Петр Чех?","options":["защитник","вратарь","нападающий","полузащитник"],"correct_answer":"вратарь","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_125","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “канонирами”?","options":["Арсенал","Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Арсенал","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_126","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: польский бомбардир, звезда Боруссии, Баварии и Барселоны.","options":["Криштиану Роналду","Роберт Левандовский","Неймар","Лионель Месси"],"correct_answer":"Роберт Левандовский","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_127","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2007 году?","options":["Криштиану Роналду","Кака","Лука Модрич","Лионель Месси"],"correct_answer":"Кака","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_128","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский полузащитник, забил победный гол в финале ЧМ-2010.","options":["Криштиану Роналду","Андрес Иньеста","Лионель Месси","Неймар"],"correct_answer":"Андрес Иньеста","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_129","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “нерадзурри”?","options":["Интер","Барселона","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Интер","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_130","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский вратарь, капитан чемпионов мира-2010.","options":["Криштиану Роналду","Икер Касильяс","Лионель Месси","Неймар"],"correct_answer":"Икер Касильяс","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_131","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2005 году?","options":["Роналдиньо","Лионель Месси","Криштиану Роналду","Лука Модрич"],"correct_answer":"Роналдиньо","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_132","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: испанский дирижёр полузащиты Барселоны и сборной Испании.","options":["Криштиану Роналду","Неймар","Хави","Лионель Месси"],"correct_answer":"Хави","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_133","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “россонери”?","options":["Реал Мадрид","Милан","Манчестер Юнайтед","Барселона"],"correct_answer":"Милан","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_134","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2022 году?","options":["Криштиану Роналду","Карим Бензема","Лука Модрич","Лионель Месси"],"correct_answer":"Карим Бензема","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_135","category":"Прозвища","question_type":"Прозвище → клуб","options_count":4,"question":"Какой клуб называют “сливочными”?","options":["Реал Мадрид","Манчестер Сити","Манчестер Юнайтед","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_136","category":"Культура","question_type":"Фанатская культура","options_count":4,"question":"Какой клуб связан с фразой “You’ll Never Walk Alone”?","options":["Ливерпуль","Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_137","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2023 году?","options":["Карим Бензема","Криштиану Роналду","Лука Модрич","Лионель Месси"],"correct_answer":"Лионель Месси","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_138","category":"Тренеры","question_type":"Тренерский факт","options_count":4,"question":"Кто из тренеров выиграл Лигу чемпионов три раза подряд с Реалом?","options":["Зинедин Зидан","Жозе Моуринью","Пеп Гвардиола","Карло Анчелотти"],"correct_answer":"Зинедин Зидан","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_139","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Лев Яшин?","options":["полузащитник","защитник","вратарь","нападающий"],"correct_answer":"вратарь","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_140","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2013 году?","options":["Лионель Месси","Лука Модрич","Карим Бензема","Криштиану Роналду"],"correct_answer":"Криштиану Роналду","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_141","category":"Тренеры","question_type":"Тренерский факт","options_count":4,"question":"Кто тренировал Манчестер Юнайтед во время эпохи многих титулов АПЛ?","options":["Жозе Моуринью","Алекс Фергюсон","Арсен Венгер","Пеп Гвардиола"],"correct_answer":"Алекс Фергюсон","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_142","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский вратарь, чемпион мира-2006.","options":["Джанлуиджи Буффон","Неймар","Лионель Месси","Криштиану Роналду"],"correct_answer":"Джанлуиджи Буффон","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_143","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2009 году?","options":["Лука Модрич","Криштиану Роналду","Лионель Месси","Карим Бензема"],"correct_answer":"Лионель Месси","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_144","category":"Рекорды клубов","question_type":"Рекорд","options_count":4,"question":"Какой клуб выиграл АПЛ без поражений в сезоне 2003/04?","options":["Реал Мадрид","Манчестер Юнайтед","Барселона","Арсенал"],"correct_answer":"Арсенал","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_145","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2014 года?","options":["Бразилия","Германия","Франция","США"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_146","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Алан Ширер?","options":["вратарь","защитник","полузащитник","нападающий"],"correct_answer":"нападающий","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_147","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский защитник, символ Милана.","options":["Криштиану Роналду","Неймар","Паоло Мальдини","Лионель Месси"],"correct_answer":"Паоло Мальдини","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_148","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":4,"question":"Какая сборная выиграла ЧМ-2010?","options":["Нидерланды","Бразилия","Испания","Германия"],"correct_answer":"Испания","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_149","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2008 году?","options":["Лука Модрич","Карим Бензема","Лионель Месси","Криштиану Роналду"],"correct_answer":"Криштиану Роналду","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_150","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: бразильский форвард, чемпион мира-2002, известен как Феномен.","options":["Лионель Месси","Криштиану Роналду","Неймар","Роналдо Назарио"],"correct_answer":"Роналдо Назарио","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_151","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Марсело?","options":["защитник","вратарь","полузащитник","нападающий"],"correct_answer":"защитник","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_152","category":"Евро","question_type":"Победитель Евро","options_count":4,"question":"Какая сборная выиграла Евро-2004?","options":["Франция","Португалия","Испания","Греция"],"correct_answer":"Греция","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_153","category":"Термины","question_type":"Термин","options_count":4,"question":"Что означает “финт”?","options":["Только вратарский сейв","Технический обманный приём","Удар от ворот","Вид карточки"],"correct_answer":"Технический обманный приём","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_154","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Франц Беккенбауэр?","options":["полузащитник","защитник","нападающий","вратарь"],"correct_answer":"защитник","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_155","category":"Тактика","question_type":"Тактический термин","options_count":4,"question":"Что такое “прессинг”?","options":["Жеребьёвка групп","Давление на соперника без мяча","Удар с угла поля","Перерыв между таймами"],"correct_answer":"Давление на соперника без мяча","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_156","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: бельгийский плеймейкер, ключевой игрок Манчестер Сити.","options":["Криштиану Роналду","Кевин Де Брёйне","Лионель Месси","Неймар"],"correct_answer":"Кевин Де Брёйне","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_157","category":"Тактика","question_type":"Тактический термин","options_count":4,"question":"Что такое “ложная девятка”?","options":["Нападающий, который часто уходит вглубь поля","Защитник на линии ворот","Второй судья","Запасной вратарь"],"correct_answer":"Нападающий, который часто уходит вглубь поля","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_158","category":"Золотой мяч","question_type":"Индивидуальная награда","options_count":4,"question":"Кто получил “Золотой мяч” в 2006 году?","options":["Лука Модрич","Фабио Каннаваро","Криштиану Роналду","Лионель Месси"],"correct_answer":"Фабио Каннаваро","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_159","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Габриэль Батистута?","options":["нападающий","вратарь","полузащитник","защитник"],"correct_answer":"нападающий","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_160","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2006 года?","options":["Германия","Бразилия","США","Франция"],"correct_answer":"Германия","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_161","category":"Тактика","question_type":"Роль игрока","options_count":4,"question":"Что обычно делает опорный полузащитник?","options":["Помогает обороне и начинает атаки","Только подаёт угловые","Только стоит в воротах","Всегда играет последнего защитника"],"correct_answer":"Помогает обороне и начинает атаки","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_162","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: хорватский полузащитник, обладатель Золотого мяча-2018.","options":["Лука Модрич","Лионель Месси","Неймар","Криштиану Роналду"],"correct_answer":"Лука Модрич","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_163","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: немецкий вратарь, чемпион мира-2014 и мастер игры ногами.","options":["Неймар","Лионель Месси","Мануэль Нойер","Криштиану Роналду"],"correct_answer":"Мануэль Нойер","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_164","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2010 года?","options":["Германия","Франция","США","ЮАР"],"correct_answer":"ЮАР","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_165","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2022 года?","options":["Германия","Франция","Катар","США"],"correct_answer":"Катар","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_166","category":"Амплуа","question_type":"Роль игрока","options_count":4,"question":"Что такое “вингер”?","options":["Центральный защитник","Вратарская перчатка","Главный арбитр","Фланговый атакующий игрок"],"correct_answer":"Фланговый атакующий игрок","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_167","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2018 года?","options":["Германия","США","Франция","Россия"],"correct_answer":"Россия","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_168","category":"Термины","question_type":"Термин","options_count":4,"question":"Как называется гол, забитый своей команде?","options":["Сейв","Автогол","Ассист","Дубль"],"correct_answer":"Автогол","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_169","category":"Турниры и термины","question_type":"Термин","options_count":4,"question":"Что означает формат “плей-офф”?","options":["Турнир без финала","Круговая группа","Только товарищеские матчи","Раунд на выбывание"],"correct_answer":"Раунд на выбывание","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_170","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 2026 года?","options":["США, Канада и Мексика","США","Германия","Франция"],"correct_answer":"США, Канада и Мексика","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_171","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Серхио Рамос?","options":["полузащитник","нападающий","вратарь","защитник"],"correct_answer":"защитник","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_172","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 1994 года?","options":["Бразилия","Германия","США","Франция"],"correct_answer":"США","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_173","category":"Термины","question_type":"Термин","options_count":4,"question":"Как называется серия без пропущенных мячей у вратаря/команды?","options":["Хет-трик","Сухая серия","Покер","Трансферная сага"],"correct_answer":"Сухая серия","correct_key":"2","difficulty":"medium","media_required":false},{"id":"fb_174","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Какой турнир выигрывают клубы Южной Америки?","options":["Кубок Либертадорес","Лига Европы","Кубок Азии","Лига чемпионов"],"correct_answer":"Кубок Либертадорес","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_175","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Какой турнир проводят для сборных Южной Америки?","options":["Евро","Кубок Азии","Копа Америка","Золотой кубок КОНКАКАФ"],"correct_answer":"Копа Америка","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_176","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: итальянский реджиста, мастер длинных передач и штрафных.","options":["Криштиану Роналду","Неймар","Андреа Пирло","Лионель Месси"],"correct_answer":"Андреа Пирло","correct_key":"3","difficulty":"medium","media_required":false},{"id":"fb_177","category":"Амплуа","question_type":"Амплуа","options_count":4,"question":"На какой позиции больше всего известен Фабио Каннаваро?","options":["защитник","полузащитник","вратарь","нападающий"],"correct_answer":"защитник","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_178","category":"Турниры","question_type":"Турнир","options_count":4,"question":"Как называется главный турнир сборных Европы?","options":["Евро","Кубок Азии","Лига чемпионов","Копа Америка"],"correct_answer":"Евро","correct_key":"1","difficulty":"medium","media_required":false},{"id":"fb_179","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":4,"question":"Угадай футболиста по подсказке: французский форвард, легенда Арсенала.","options":["Лионель Месси","Криштиану Роналду","Неймар","Тьерри Анри"],"correct_answer":"Тьерри Анри","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_180","category":"Чемпионаты мира","question_type":"Хозяин ЧМ","options_count":4,"question":"Где проходил чемпионат мира 1998 года?","options":["США","Германия","Бразилия","Франция"],"correct_answer":"Франция","correct_key":"4","difficulty":"medium","media_required":false},{"id":"fb_181","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: уругвайский форвард, играл за Аякс, Ливерпуль и Барселону.","options":["Луис Суарес","Неймар","Криштиану Роналду","Лионель Месси","Килиан Мбаппе"],"correct_answer":"Луис Суарес","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_182","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Камп Ноу” связан с кем?","options":["Барселона","Ливерпуль","Манчестер Сити","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Барселона","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_183","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Да Луж” связан с кем?","options":["Реал Мадрид","Бенфика","Манчестер Сити","Барселона","Манчестер Юнайтед"],"correct_answer":"Бенфика","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_184","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: хорватский форвард, лучший бомбардир ЧМ-1998.","options":["Килиан Мбаппе","Давор Шукер","Неймар","Криштиану Роналду","Лионель Месси"],"correct_answer":"Давор Шукер","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_185","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Сливочные”?","options":["Реал Мадрид","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Реал Мадрид","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_186","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: южнокорейский форвард, капитан Тоттенхэма.","options":["Сон Хын Мин","Килиан Мбаппе","Неймар","Криштиану Роналду","Лионель Месси"],"correct_answer":"Сон Хын Мин","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_187","category":"Угадай по подсказке","question_type":"Подсказка → игрок","options_count":5,"question":"Угадай футболиста по подсказке: бразилец, перешёл из Сантоса в Барселону, затем в ПСЖ.","options":["Килиан Мбаппе","Криштиану Роналду","Неймар","Лионель Месси","Лука Модрич"],"correct_answer":"Неймар","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_188","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сантьяго Бернабеу” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Ливерпуль","Реал Мадрид","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_189","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Олд Траффорд” связан с кем?","options":["Реал Мадрид","Ливерпуль","Манчестер Юнайтед","Барселона","Манчестер Сити"],"correct_answer":"Манчестер Юнайтед","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_190","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Икер Касильяс.","options":["Аргентина","Бразилия","Германия","Испания","Франция"],"correct_answer":"Испания","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_191","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роналдиньо.","options":["Бразилия","Франция","Германия","Аргентина","Испания"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_192","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роберт Левандовский.","options":["Польша","Франция","Бразилия","Аргентина","Германия"],"correct_answer":"Польша","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_193","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Тьерри Анри.","options":["Франция","Аргентина","Германия","Испания","Бразилия"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_194","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Лука Модрич.","options":["Аргентина","Хорватия","Бразилия","Германия","Франция"],"correct_answer":"Хорватия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_195","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Энфилд” связан с кем?","options":["Ливерпуль","Реал Мадрид","Барселона","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Ливерпуль","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_196","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Самуэль Это’О.","options":["Аргентина","Бразилия","Камерун","Франция","Германия"],"correct_answer":"Камерун","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_197","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сан-Сиро” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Барселона","Милан и Интер","Реал Мадрид"],"correct_answer":"Милан и Интер","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_198","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Карим Бензема.","options":["Аргентина","Франция","Испания","Германия","Бразилия"],"correct_answer":"Франция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_199","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Джанлуиджи Буффон.","options":["Италия","Аргентина","Бразилия","Германия","Франция"],"correct_answer":"Италия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_200","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Хави.","options":["Германия","Аргентина","Испания","Франция","Бразилия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_201","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Эрлинг Холанд.","options":["Норвегия","Аргентина","Франция","Бразилия","Германия"],"correct_answer":"Норвегия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_202","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Кевин Де Брёйне.","options":["Бельгия","Франция","Германия","Аргентина","Бразилия"],"correct_answer":"Бельгия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_203","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Стэмфорд Бридж” связан с кем?","options":["Манчестер Сити","Челси","Барселона","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Челси","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_204","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Клинт Демпси.","options":["Германия","Франция","Бразилия","Аргентина","США"],"correct_answer":"США","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_205","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Олимпико” связан с кем?","options":["Манчестер Юнайтед","Манчестер Сити","Реал Мадрид","Рома и Лацио","Барселона"],"correct_answer":"Рома и Лацио","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_206","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Килиан Мбаппе.","options":["Германия","Бразилия","Аргентина","Испания","Франция"],"correct_answer":"Франция","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_207","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Зинедин Зидан.","options":["Франция","Бразилия","Испания","Германия","Аргентина"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_208","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Хакан Шюкюр.","options":["Аргентина","Германия","Бразилия","Турция","Франция"],"correct_answer":"Турция","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_209","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Марко ван Бастен.","options":["Франция","Аргентина","Бразилия","Германия","Нидерланды"],"correct_answer":"Нидерланды","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_210","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Йохан Кройф Арена” связан с кем?","options":["Манчестер Сити","Аякс","Барселона","Реал Мадрид","Манчестер Юнайтед"],"correct_answer":"Аякс","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_211","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Криштиану Роналду.","options":["Германия","Бразилия","Франция","Аргентина","Португалия"],"correct_answer":"Португалия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_212","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Андрес Иньеста.","options":["Испания","Франция","Германия","Бразилия","Аргентина"],"correct_answer":"Испания","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_213","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Жозе Алваладе” связан с кем?","options":["Спортинг","Барселона","Манчестер Сити","Манчестер Юнайтед","Реал Мадрид"],"correct_answer":"Спортинг","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_214","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Вирджил ван Дейк.","options":["Нидерланды","Германия","Бразилия","Франция","Аргентина"],"correct_answer":"Нидерланды","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_215","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Златан Ибрагимович.","options":["Германия","Швеция","Франция","Аргентина","Бразилия"],"correct_answer":"Швеция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_216","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Роналдо Назарио.","options":["Бразилия","Испания","Франция","Аргентина","Германия"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_217","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Паоло Мальдини.","options":["Бразилия","Франция","Германия","Италия","Аргентина"],"correct_answer":"Италия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_218","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Юто Нагатомо.","options":["Бразилия","Аргентина","Германия","Франция","Япония"],"correct_answer":"Япония","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_219","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Предраг Миятович.","options":["Германия","Черногория","Франция","Бразилия","Аргентина"],"correct_answer":"Черногория","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_220","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Альянц Арена” связан с кем?","options":["Манчестер Юнайтед","Барселона","Бавария","Реал Мадрид","Манчестер Сити"],"correct_answer":"Бавария","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_221","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Сигнал Идуна Парк” связан с кем?","options":["Барселона","Реал Мадрид","Боруссия Дортмунд","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Боруссия Дортмунд","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_222","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Пак Чи Сон.","options":["Бразилия","Франция","Южная Корея","Аргентина","Германия"],"correct_answer":"Южная Корея","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_223","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Драгау” связан с кем?","options":["Реал Мадрид","Манчестер Сити","Барселона","Манчестер Юнайтед","Порту"],"correct_answer":"Порту","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_224","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Садио Мане.","options":["Германия","Сенегал","Франция","Аргентина","Бразилия"],"correct_answer":"Сенегал","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_225","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Парк де Пренс” связан с кем?","options":["ПСЖ","Реал Мадрид","Барселона","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"ПСЖ","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_226","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Старая синьора”?","options":["Барселона","Реал Мадрид","Ювентус","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"Ювентус","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_227","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Гарри Кейн.","options":["Бразилия","Англия","Аргентина","Франция","Германия"],"correct_answer":"Англия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_228","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Андреа Пирло.","options":["Франция","Аргентина","Бразилия","Германия","Италия"],"correct_answer":"Италия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_229","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Джордж Веа.","options":["Бразилия","Франция","Либерия","Аргентина","Германия"],"correct_answer":"Либерия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_230","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Мануэль Нойер.","options":["Бразилия","Испания","Германия","Франция","Аргентина"],"correct_answer":"Германия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_231","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Эмирейтс” связан с кем?","options":["Манчестер Сити","Реал Мадрид","Арсенал","Барселона","Манчестер Юнайтед"],"correct_answer":"Арсенал","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_232","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Дэвид Бекхэм.","options":["Франция","Англия","Бразилия","Аргентина","Германия"],"correct_answer":"Англия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_233","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Дидье Дрогба.","options":["Бразилия","Кот-д’Ивуар","Франция","Германия","Аргентина"],"correct_answer":"Кот-д’Ивуар","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_234","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Лионель Месси.","options":["Аргентина","Франция","Испания","Бразилия","Германия"],"correct_answer":"Аргентина","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_235","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Мохамед Салах.","options":["Франция","Бразилия","Египет","Аргентина","Германия"],"correct_answer":"Египет","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_236","category":"Стадионы","question_type":"Стадион → клуб","options_count":5,"question":"Домашняя арена/стадион “Этихад” связан с кем?","options":["Манчестер Сити","Ливерпуль","Манчестер Юнайтед","Барселона","Реал Мадрид"],"correct_answer":"Манчестер Сити","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_237","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Сине-гранатовые”?","options":["Ливерпуль","Манчестер Юнайтед","Манчестер Сити","Барселона","Реал Мадрид"],"correct_answer":"Барселона","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_238","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Рафаэль Маркес.","options":["Аргентина","Бразилия","Германия","Франция","Мексика"],"correct_answer":"Мексика","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_239","category":"Игроки и сборные","question_type":"Игрок → сборная","options_count":5,"question":"Выбери сборную, за которую выступал Томас Мюллер.","options":["Франция","Бразилия","Испания","Аргентина","Германия"],"correct_answer":"Германия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_240","category":"Прозвища","question_type":"Прозвище","options_count":5,"question":"Какую команду или сборную называют “Красные дьяволы”?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Манчестер Сити","Реал Мадрид"],"correct_answer":"Манчестер Юнайтед","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_241","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Миланское дерби”.","options":["Ливерпуль и Эвертон","Милан и Интер","Манчестер Юнайтед и Манчестер Сити","Реал Мадрид и Барселона","Арсенал и Тоттенхэм","Рома и Лацио"],"correct_answer":"Милан и Интер","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_242","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2006 года.","options":["Испания","Франция","Германия","Бразилия","Аргентина","Италия"],"correct_answer":"Италия","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_243","category":"Правила","question_type":"Ситуация","options_count":6,"question":"В финале после 120 минут счёт равный. Что обычно происходит дальше?","options":["Жеребьёвка","Победа хозяев","Золотой гол автоматически","Серия пенальти","Дополнительная группа","Переигровка через неделю"],"correct_answer":"Серия пенальти","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_244","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2022 года.","options":["Франция","Германия","Испания","Аргентина","Бразилия","Италия"],"correct_answer":"Аргентина","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_245","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2013?","options":["Бавария","Манчестер Юнайтед","Ливерпуль","Реал Мадрид","Манчестер Сити","Барселона"],"correct_answer":"Бавария","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_246","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2020?","options":["Испания","Италия","Бразилия","Германия","Аргентина","Франция"],"correct_answer":"Италия","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_247","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2021?","options":["Барселона","Манчестер Юнайтед","Челси","Ливерпуль","Манчестер Сити","Реал Мадрид"],"correct_answer":"Челси","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_248","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2008?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Реал Мадрид","Челси","Манчестер Сити"],"correct_answer":"Манчестер Юнайтед","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_249","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2010 года.","options":["Италия","Франция","Испания","Бразилия","Аргентина","Германия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_250","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2002 года.","options":["Бразилия","Франция","Испания","Италия","Аргентина","Германия"],"correct_answer":"Бразилия","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_251","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Вратарь не пропустил ни одного гола за матч. Как это называют?","options":["Дерби","Трансфер","Требл","Сухой матч","Покер","Хет-трик"],"correct_answer":"Сухой матч","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_252","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2019?","options":["Реал Мадрид","Челси","Барселона","Ливерпуль","Манчестер Юнайтед","Манчестер Сити"],"correct_answer":"Ливерпуль","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_253","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Игрок отдал пас, после которого партнёр сразу забил гол. Что записывают игроку?","options":["Офсайд","Сейв","Аут","Автогол","Ассист","Пенальти"],"correct_answer":"Ассист","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_254","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-1992?","options":["Франция","Дания","Германия","Бразилия","Испания","Аргентина"],"correct_answer":"Дания","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_255","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1986 года.","options":["Бразилия","Германия","Аргентина","Испания","Франция","Италия"],"correct_answer":"Аргентина","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_256","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2009?","options":["Манчестер Юнайтед","Барселона","Манчестер Сити","Реал Мадрид","Ливерпуль","Челси"],"correct_answer":"Барселона","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_257","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2014?","options":["Манчестер Юнайтед","Манчестер Сити","Реал Мадрид","Барселона","Челси","Ливерпуль"],"correct_answer":"Реал Мадрид","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_258","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2011?","options":["Манчестер Юнайтед","Ливерпуль","Барселона","Манчестер Сити","Реал Мадрид","Челси"],"correct_answer":"Барселона","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_259","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Римское дерби”.","options":["Реал Мадрид и Барселона","Милан и Интер","Арсенал и Тоттенхэм","Ливерпуль и Эвертон","Манчестер Юнайтед и Манчестер Сити","Рома и Лацио"],"correct_answer":"Рома и Лацио","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_260","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2022?","options":["Манчестер Юнайтед","Манчестер Сити","Челси","Реал Мадрид","Ливерпуль","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_261","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2015?","options":["Манчестер Сити","Барселона","Реал Мадрид","Манчестер Юнайтед","Ливерпуль","Челси"],"correct_answer":"Барселона","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_262","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2005?","options":["Челси","Манчестер Сити","Манчестер Юнайтед","Барселона","Реал Мадрид","Ливерпуль"],"correct_answer":"Ливерпуль","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_263","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Манчестерское дерби”.","options":["Реал Мадрид и Барселона","Арсенал и Тоттенхэм","Рома и Лацио","Манчестер Юнайтед и Манчестер Сити","Милан и Интер","Ливерпуль и Эвертон"],"correct_answer":"Манчестер Юнайтед и Манчестер Сити","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_264","category":"Правила","question_type":"Ситуация","options_count":6,"question":"Игрок находится ближе к воротам соперника, чем мяч и предпоследний защитник в момент передачи. О чём речь?","options":["Аут","Голевой удар","Офсайд","Дроп-бол","Угловой","Пенальти"],"correct_answer":"Офсайд","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_265","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1978 года.","options":["Бразилия","Испания","Германия","Италия","Аргентина","Франция"],"correct_answer":"Аргентина","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_266","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Эль-Класико”.","options":["Милан и Интер","Арсенал и Тоттенхэм","Реал Мадрид и Барселона","Рома и Лацио","Манчестер Юнайтед и Манчестер Сити","Ливерпуль и Эвертон"],"correct_answer":"Реал Мадрид и Барселона","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_267","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Форвард забил 2 гола в одном матче. Как это называют?","options":["Ассист","Клиншит","Сухарь","Дубль","Покер","Хет-трик"],"correct_answer":"Дубль","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_268","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-1996?","options":["Италия","Франция","Аргентина","Германия","Бразилия","Испания"],"correct_answer":"Германия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_269","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1930 года.","options":["Уругвай","Франция","Бразилия","Аргентина","Испания","Германия"],"correct_answer":"Уругвай","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_270","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2007?","options":["Барселона","Манчестер Сити","Ливерпуль","Реал Мадрид","Манчестер Юнайтед","Милан"],"correct_answer":"Милан","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_271","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Команда проигрывала 0:2, но выиграла 3:2. Как называют такой поворот?","options":["Камбэк","Офсайд","Дубль","Сухой матч","Ротация","Трансфер"],"correct_answer":"Камбэк","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_272","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2020?","options":["Реал Мадрид","Бавария","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Бавария","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_273","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2014 года.","options":["Франция","Испания","Бразилия","Аргентина","Италия","Германия"],"correct_answer":"Германия","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_274","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2018?","options":["Ливерпуль","Реал Мадрид","Манчестер Юнайтед","Барселона","Челси","Манчестер Сити"],"correct_answer":"Реал Мадрид","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_275","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2017?","options":["Ливерпуль","Манчестер Юнайтед","Барселона","Челси","Манчестер Сити","Реал Мадрид"],"correct_answer":"Реал Мадрид","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_276","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2010?","options":["Манчестер Сити","Манчестер Юнайтед","Ливерпуль","Барселона","Реал Мадрид","Интер"],"correct_answer":"Интер","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_277","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1958 года.","options":["Испания","Франция","Бразилия","Германия","Аргентина","Италия"],"correct_answer":"Бразилия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_278","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Защитник случайно отправил мяч в свои ворота. Как называется такой гол?","options":["Сухарь","Офсайд","Требл","Дубль","Автогол","Ассист"],"correct_answer":"Автогол","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_279","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2024?","options":["Манчестер Сити","Ливерпуль","Челси","Реал Мадрид","Манчестер Юнайтед","Барселона"],"correct_answer":"Реал Мадрид","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_280","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1994 года.","options":["Аргентина","Германия","Испания","Бразилия","Франция","Италия"],"correct_answer":"Бразилия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_281","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2008?","options":["Германия","Франция","Испания","Аргентина","Бразилия","Италия"],"correct_answer":"Испания","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_282","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1982 года.","options":["Франция","Бразилия","Испания","Италия","Германия","Аргентина"],"correct_answer":"Италия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_283","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1998 года.","options":["Франция","Италия","Испания","Аргентина","Бразилия","Германия"],"correct_answer":"Франция","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_284","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2012?","options":["Манчестер Юнайтед","Ливерпуль","Челси","Реал Мадрид","Манчестер Сити","Барселона"],"correct_answer":"Челси","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_285","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2004?","options":["Франция","Германия","Аргентина","Греция","Испания","Бразилия"],"correct_answer":"Греция","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_286","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2000?","options":["Италия","Франция","Бразилия","Аргентина","Испания","Германия"],"correct_answer":"Франция","correct_key":"2","difficulty":"hard","media_required":false},{"id":"fb_287","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 2018 года.","options":["Италия","Бразилия","Испания","Германия","Франция","Аргентина"],"correct_answer":"Франция","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_288","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2016?","options":["Бразилия","Франция","Аргентина","Португалия","Испания","Германия"],"correct_answer":"Португалия","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_289","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1966 года.","options":["Аргентина","Испания","Англия","Германия","Франция","Бразилия"],"correct_answer":"Англия","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_290","category":"Термины","question_type":"Ситуация","options_count":6,"question":"Команда выиграла национальный чемпионат, национальный кубок и Лигу чемпионов за один сезон. Как это называют?","options":["Плей-мейкер","Золотой гол","Требл","Покер","Дубль","Сухарь"],"correct_answer":"Требл","correct_key":"3","difficulty":"hard","media_required":false},{"id":"fb_291","category":"Чемпионаты мира","question_type":"Победитель ЧМ","options_count":6,"question":"Определи чемпиона мира 1990 года.","options":["Аргентина","Испания","Италия","Бразилия","Германия","Франция"],"correct_answer":"Германия","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_292","category":"Ситуации","question_type":"Ситуация","options_count":6,"question":"Вратарь отбил удар, мяч не покинул поле и нападающий добил его в ворота. Что засчитывают?","options":["Всегда офсайд","Угловой без гола","Свободный удар защите","Гол, если не было нарушения","Автоматический пенальти","Жёлтую карточку вратарю"],"correct_answer":"Гол, если не было нарушения","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_293","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Мерсисайдское дерби”.","options":["Ливерпуль и Эвертон","Милан и Интер","Арсенал и Тоттенхэм","Реал Мадрид и Барселона","Манчестер Юнайтед и Манчестер Сити","Рома и Лацио"],"correct_answer":"Ливерпуль и Эвертон","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_294","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2023?","options":["Ливерпуль","Барселона","Челси","Реал Мадрид","Манчестер Сити","Манчестер Юнайтед"],"correct_answer":"Манчестер Сити","correct_key":"5","difficulty":"hard","media_required":false},{"id":"fb_295","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2024?","options":["Испания","Германия","Аргентина","Италия","Бразилия","Франция"],"correct_answer":"Испания","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_296","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2006?","options":["Реал Мадрид","Челси","Манчестер Сити","Барселона","Манчестер Юнайтед","Ливерпуль"],"correct_answer":"Барселона","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_297","category":"Турниры","question_type":"Ситуация","options_count":6,"question":"Команда забила больше голов за два матча плей-офф, чем соперник. Что это обычно значит?","options":["Она проходит дальше","Играется третий матч","Матч отменяется","Она получает один бонусный гол","Победителя выбирает капитан","Проходит команда с меньшим рейтингом"],"correct_answer":"Она проходит дальше","correct_key":"1","difficulty":"hard","media_required":false},{"id":"fb_298","category":"Евро","question_type":"Победитель Евро","options_count":6,"question":"Какая сборная выиграла Евро-2012?","options":["Франция","Италия","Бразилия","Испания","Германия","Аргентина"],"correct_answer":"Испания","correct_key":"4","difficulty":"hard","media_required":false},{"id":"fb_299","category":"Дерби","question_type":"Дерби","options_count":6,"question":"Выбери правильную пару для дерби “Северолондонское дерби”.","options":["Манчестер Юнайтед и Манчестер Сити","Рома и Лацио","Ливерпуль и Эвертон","Милан и Интер","Реал Мадрид и Барселона","Арсенал и Тоттенхэм"],"correct_answer":"Арсенал и Тоттенхэм","correct_key":"6","difficulty":"hard","media_required":false},{"id":"fb_300","category":"Лига чемпионов","question_type":"Победитель ЛЧ","options_count":6,"question":"Какой клуб был победителем ЛЧ-2016?","options":["Манчестер Юнайтед","Ливерпуль","Манчестер Сити","Барселона","Челси","Реал Мадрид"],"correct_answer":"Реал Мадрид","correct_key":"6","difficulty":"hard","media_required":false}];

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
    const fcoinsEarned = Math.min(correct * 2 + bonus, 25);
    setScore(correct);
    setNeurons(fcoinsEarned);

    // Сохранить попытку в Supabase и начислить F-Coins
    const freshToken = await getFreshToken().catch(() => null);
    const authToken = freshToken || token;
    if (uid && authToken && !isJwtExpired(authToken)) {
      try {
        const body = {
          user_id: uid,
          quiz_date: dateMsk,
          mode: "football_bank",
          question_ids: questions.map(q => q.id),
          answers,
          score: correct,
          neurons_earned: fcoinsEarned,
          fcoins_earned: fcoinsEarned,
        };
        const r = await supa("daily_text_quiz_attempts", {
          method: "POST", token: authToken,
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          const saved = await r.json().catch(() => null);
          const savedRow = Array.isArray(saved) ? saved[0] : saved;
          if (savedRow) setAttempt(savedRow);

          // Начисляем только если попытка действительно новая.
          // При дубле за день unique index + ignore-duplicates вернёт пустой массив.
          if (savedRow && fcoinsEarned > 0) {
            try {
              const profR = await supa(`profiles?id=eq.${uid}&select=fcoins_balance`, { token: authToken });
              const profD = profR.ok ? await profR.json() : [];
              const curBal = Number(profD[0]?.fcoins_balance || 0);
              const nextBal = curBal + Number(fcoinsEarned || 0);
              const patchR = await supa(`profiles?id=eq.${uid}`, {
                method: "PATCH", token: authToken, headers: { Prefer: "return=representation" },
                body: JSON.stringify({ fcoins_balance: nextBal }),
              });
              if (patchR.ok) {
                const upd = await patchR.json().catch(() => null);
                if (Array.isArray(upd) && upd[0]) {
                  try { window.dispatchEvent(new CustomEvent("ffc-profile-patch", { detail: upd[0] })); } catch {}
                }
              } else {
                console.warn("DailyQuizBlock: profile fcoins PATCH failed", patchR.status, await patchR.text().catch(() => ""));
              }

              // История не должна ломать баланс: пробуем разные варианты схемы таблицы.
              const txBodies = [
                { user_id: uid, amount: fcoinsEarned, type: "quiz", reason: `Ежедневный квиз ${dateMsk}` },
                { user_id: uid, amount: fcoinsEarned, type: "quiz", description: `Ежедневный квиз ${dateMsk}`, reference_id: dateMsk },
                { user_id: uid, amount: fcoinsEarned, type: "earn", reason: `Ежедневный квиз ${dateMsk}` },
              ];
              for (const txBody of txBodies) {
                const txR = await supa("fcoin_transactions", {
                  method: "POST", token: authToken, headers: { Prefer: "return=minimal" },
                  body: JSON.stringify(txBody),
                });
                if (txR.ok) break;
              }
            } catch (e) { console.warn("DailyQuizBlock: F-Coins award failed", e); }
          }
          showToast(`⚽ Квиз завершён! +${fcoinsEarned} F-Coins`);
        } else {
          const text = await r.text().catch(() => "");
          console.warn("DailyQuizBlock: attempt save failed", r.status, text);
          showToast(`⚽ Квиз завершён! Результат: ${correct}/${totalQ}`);
        }
      } catch (e) {
        console.warn("DailyQuizBlock: save attempt failed", e);
        showToast(`⚽ Результат: ${correct}/${totalQ}`);
      }
    } else {
      showToast(`⚽ Результат: ${correct}/${totalQ} (войди, чтобы сохранить F-Coins)`);
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
              Играй каждый день — зарабатывай F-Coins. Тай-брейкер при равенстве очков в Битве клубов. До 25 в день.
            </div>
            <button
              className="bp"
              style={{ fontSize: 13, padding: "9px 18px" }}
              onClick={() => { if (isGuest) { showToast("Войди, чтобы сохранить F-Coins"); } setStarted(true); }}
            >
              Играть сегодня →
            </button>
            {isGuest && (
              <div style={{ fontSize: 10, color: "rgba(240,237,230,.3)", marginTop: 6 }}>
                F-Coins начисляются только авторизованным игрокам
              </div>
            )}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#FDE68A" }}>max 25 🪙</div>
            <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>F-Coins</div>
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
          {score === totalQ ? "🎉 Идеально! +5 бонусных F-Coins" : score >= 7 ? "Отличный результат!" : score >= 5 ? "Неплохо!" : "Попробуй завтра!"}
        </div>
        <div style={{ fontSize: 13, color: "#86EFAC", fontWeight: 600, marginBottom: 4 }}>
          +{neurons} F-Coins начислено
        </div>
        <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)" }}>Следующий квиз завтра</div>
      </div>
    );
  }

  // ── Прохождение квиза ──
  const curQ = questions[current];

  if (!curQ) {
    return (
      <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.18)", borderRadius: 12, padding: "18px", marginBottom: 16 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>Квиз временно не загрузился</div>
        <div style={{ fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.5 }}>Обновите страницу. Если ошибка повторится, значит банк вопросов не подключился в сборке.</div>
      </div>
    );
  }

  return (
    <div style={{ background: "rgba(29,78,216,.06)", border: "1px solid rgba(29,78,216,.18)", borderRadius: 12, padding: "16px 18px", marginBottom: 16 }}>
      {/* Заголовок */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>⚽</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 14, fontWeight: 700, color: "#93C5FD" }}>Ежедневный футбольный квиз</div>
          <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)" }}>10 вопросов · за F-Coins</div>
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
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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

  async function getTeamToken() {
    const fresh = await getFreshToken().catch(() => null);
    return fresh || token;
  }

  function parseDbErrorText(txt) {
    try {
      const j = JSON.parse(txt);
      return j?.message || txt;
    } catch {
      return txt || "";
    }
  }

  function isRlsError(txt, status) {
    return status === 401 || status === 403 || /row-level security|violates row-level security|42501|permission denied/i.test(txt || "");
  }

  useEffect(() => { if (session) load(); }, [session]);

  async function load() {
    if (!uid) { setLoaded(true); return; }
    setLoaded(false); setError(null);
    const authToken = await getTeamToken();
    try {
      const mr = await supa(`predictor_team_members?user_id=eq.${uid}&select=*,predictor_teams(*)`, { token: authToken });
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
        const memr = await supa(`predictor_team_members?team_id=eq.${mdata[0].team_id}&select=*,profiles(id,name,display_name,club_name,email)`, { token: authToken });
        if (memr.ok) setMembers(await memr.json());
      } else {
        setMyTeam(null); setMembers([]);
      }
      const tr = await supa("predictor_team_members?select=team_id,predictor_teams(id,name,code),profiles(id,name,display_name,club_name,email)", { token: authToken });
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
    const name = teamName.trim();
    if (!session || !uid) { showToast("Сначала войди в аккаунт"); return; }
    if (!name) { showToast("Введи название команды"); return; }
    if (name.length < 2 || name.length > 40) { showToast("Название команды: 2–40 символов"); return; }
    setLoading(true);
    const authToken = await getTeamToken();
    const code = generateCode();
    const res = await supa("predictor_teams", {
      method: "POST", token: authToken,
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ name, code, owner_id: uid }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const msg = parseDbErrorText(txt);
      if (isRlsError(txt, res.status)) {
        showToast("Не удалось создать команду: RLS/права Supabase. Выполни SQL для predictor_teams ниже.");
        setError("TEAM_RLS");
      } else {
        showToast("Не удалось создать команду: " + msg.slice(0, 120));
        setError(msg.slice(0, 240));
      }
      setLoading(false); return;
    }
    const [team] = await res.json();
    // Автовступление создателя в команду. Если членство уже есть — PostgREST merge по PK/unique.
    const mem = await supa("predictor_team_members", {
      method: "POST", token: authToken,
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ team_id: team.id, user_id: uid }),
    });
    if (!mem.ok) {
      const txt = await mem.text().catch(() => "");
      if (isRlsError(txt, mem.status)) {
        showToast("Команда создана, но не удалось добавить тебя в неё: RLS на predictor_team_members.");
        setError("TEAM_RLS");
      } else {
        showToast("Команда создана, но вступление не сохранилось: " + parseDbErrorText(txt).slice(0, 100));
      }
    }
    setTeamName(""); setLoading(false);
    await load();
    showToast("✓ Команда создана! Код: " + code);
  }

  async function joinTeam() {
    const code = joinCode.trim().toUpperCase();
    if (!code) { showToast("Введи код команды"); return; }
    setLoading(true);
    try {
      const authToken = await getTeamToken();
      const tr = await supa(`predictor_teams?code=eq.${code}&select=id,name`, { token: authToken });
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
        method: "POST", token: authToken,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
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
    const authToken = await getTeamToken();
    await supa(`predictor_team_members?user_id=eq.${uid}`, {
      method: "DELETE", token: authToken, headers: { Prefer: "return=minimal" },
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
          Участвовать
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

      {(error === "SQL_NOT_SETUP" || error === "TEAM_RLS") && (
        <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", padding: "10px 14px", background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.18)", borderRadius: 8, marginBottom: 12 }}>
          🔧 Командный зачёт требует SQL/RLS в Supabase. Таблицы есть, но INSERT сейчас запрещён политикой Row-Level Security.
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", color: "#FDE68A" }}>SQL для predictor_teams / predictor_team_members</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 10, marginTop: 8, color: "rgba(240,237,230,.55)" }}>{`CREATE TABLE IF NOT EXISTS public.predictor_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.predictor_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES public.predictor_teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id),
  UNIQUE(team_id, user_id)
);

ALTER TABLE public.predictor_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.predictor_team_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "predictor_teams_select" ON public.predictor_teams;
DROP POLICY IF EXISTS "predictor_teams_insert_own" ON public.predictor_teams;
DROP POLICY IF EXISTS "predictor_teams_update_own" ON public.predictor_teams;
DROP POLICY IF EXISTS "predictor_teams_delete_own" ON public.predictor_teams;
DROP POLICY IF EXISTS "predictor_team_members_select" ON public.predictor_team_members;
DROP POLICY IF EXISTS "predictor_team_members_insert_self" ON public.predictor_team_members;
DROP POLICY IF EXISTS "predictor_team_members_delete_self" ON public.predictor_team_members;

CREATE POLICY "predictor_teams_select"
ON public.predictor_teams FOR SELECT TO authenticated USING (true);

CREATE POLICY "predictor_teams_insert_own"
ON public.predictor_teams FOR INSERT TO authenticated
WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "predictor_teams_update_own"
ON public.predictor_teams FOR UPDATE TO authenticated
USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);

CREATE POLICY "predictor_teams_delete_own"
ON public.predictor_teams FOR DELETE TO authenticated
USING (auth.uid() = owner_id);

CREATE POLICY "predictor_team_members_select"
ON public.predictor_team_members FOR SELECT TO authenticated USING (true);

CREATE POLICY "predictor_team_members_insert_self"
ON public.predictor_team_members FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "predictor_team_members_delete_self"
ON public.predictor_team_members FOR DELETE TO authenticated
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "predictor_team_members_admin_update" ON public.predictor_team_members;
CREATE POLICY "predictor_team_members_admin_update"
ON public.predictor_team_members FOR UPDATE TO authenticated
USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.predictor_teams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.predictor_team_members TO authenticated;`}</pre>
          </details>
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
              {getDisplayName(m.profiles) || m.user_id?.slice(0, 8)}
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

// ── PlayerSearchModal — универсальный поиск игроков ──
// source: "tournament_players" | "ffc_players"
// filterType: "all" | "young" | "goalkeeper"
function PlayerSearchModal({ onSelect, onClose, excludeNames = [], source = "tournament_players", filterType = "all", popularOptions = [] }) {
  const [query, setQuery] = React.useState("");
  const [allPlayers, setAllPlayers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [dbEmpty, setDbEmpty] = React.useState(false);
  const [manualName, setManualName] = React.useState("");
  const [showCount, setShowCount] = React.useState(5000);

  React.useEffect(() => {
    (async () => {
      try {
        if (source === "tournament_players") {
          const filtered = await fetchAllTournamentPlayersFromDb(filterType);
          setAllPlayers(filtered);
          setDbEmpty(!filtered || filtered.length === 0);
        } else {
          const r = await supa(`${source}?select=id,name,national_team,position,is_goalkeeper,is_young_player&is_active=eq.true&order=name.asc&limit=5000`);
          if (r.ok) {
            const data = await r.json();
            setAllPlayers(data || []);
            setDbEmpty(!data || data.length === 0);
          } else { setDbEmpty(true); }
        }
      } catch { setDbEmpty(true); }
      setLoading(false);
    })();
  }, [source, filterType]);

  const filterLabel = filterType === "young" ? "молодые (≤21 на 01.01.2026)" : filterType === "goalkeeper" ? "вратари" : "все игроки";
  const total = allPlayers.length;

  const available = allPlayers.filter(p => !excludeNames.includes(p.name));

  // Popular matched in DB — using global normalizeName + partial match
  const popularInDb = popularOptions.map(name => {
    const rn = normalizeName(name);
    const rru = normalizeName(displayPlayerName(name));
    const keys = [rn, rru].filter(Boolean);
    return available.find(p => {
      const pn = normalizeName(p.name);
      const pnru = normalizeName(displayPlayerName(p.name));
      return keys.some(k => pn === k || pnru === k ||
        (k.length >= 4 && (pn.includes(k) || k.includes(pn) || pnru.includes(k) || k.includes(pnru))));
    });
  }).filter(Boolean);
  const popularIds = new Set(popularInDb.map(p => p.id));

  const q = query.trim().toLowerCase();
  const browseable = available.filter(p => !popularIds.has(p.id));
  const searched = q.length > 0
    ? available.filter(p =>
        p.name.toLowerCase().includes(q) ||
        displayPlayerName(p.name).toLowerCase().includes(q) ||
        (p.national_team || "").toLowerCase().includes(q) ||
        (p.position || "").toLowerCase().includes(q)
      )
    : browseable;

  const displayed = q.length > 0
    ? searched.slice(0, 500)
    : searched; // показываем всех без limit

  const PlayerRow = ({ p }) => (
    <div key={p.id}
      onClick={() => { onSelect(p.name); onClose(); }}
      style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,.05)", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", borderRadius: 4 }}
      onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,.07)"}
      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
      <span style={{ fontSize: "clamp(14px,.95vw,18px)", color: "#F0EDE6", fontWeight: 500 }}>
        {displayPlayerName(p.name)}
        {p.name !== displayPlayerName(p.name) && <span style={{ fontSize: "clamp(10px,.7vw,12px)", color: "rgba(240,237,230,.28)", marginLeft: 6 }}>{p.name}</span>}
      </span>
      <span style={{ fontSize: "clamp(11px,.75vw,13px)", color: "rgba(240,237,230,.4)", marginLeft: 8, textAlign: "right", flexShrink: 0 }}>
        {p.national_team}{p.position ? ` · ${p.position}` : ""}
      </span>
    </div>
  );

  return (
    <div className="modal-bg" onClick={e => e.target.className === "modal-bg" && onClose()}>
      <div style={{ background: "#0D2416", border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 20, width: "min(540px, 96vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(17px,1.3vw,22px)", fontWeight: 700, color: "#F0EDE6" }}>Выбрать игрока</div>
            <div style={{ fontSize: "clamp(11px,.75vw,13px)", color: "rgba(240,237,230,.35)", marginTop: 2 }}>
              {loading ? "Загрузка…" : dbEmpty ? "База не загружена — введите имя вручную ниже" : `В базе: ${total} игроков (${filterType === "young" ? "молодые ≤21 на 01.01.2026" : filterType === "goalkeeper" ? "вратари" : "все активные"}). Поиск или прокрутка.`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.4)", fontSize: 24, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {/* Search */}
        <input autoFocus className="inp"
          placeholder="Поиск по имени, сборной, позиции…"
          value={query} onChange={e => { setQuery(e.target.value); setShowCount(5000); }}
          style={{ marginBottom: 0 }} />

        {/* List */}
        <div style={{ overflowY: "auto", flex: 1, maxHeight: "52vh" }}>
          {loading && <div style={{ fontSize: 14, color: "rgba(240,237,230,.4)", padding: 12 }}>Загрузка…</div>}
          {!loading && dbEmpty && (
            <div style={{ fontSize: 14, color: "#FCA5A5", padding: 12, lineHeight: 1.6 }}>
              ⚠ База не загружена — введите вручную ниже.
            </div>
          )}
          {/* Search results */}
          {q.length > 0 && (
            searched.length === 0
              ? <div style={{ fontSize: 13, color: "rgba(240,237,230,.4)", padding: 12 }}>Нет результатов для «{query}»</div>
              : displayed.map(p => <PlayerRow key={p.id} p={p} />)
          )}
          {/* Empty query: Popular + All */}
          {!q && !loading && !dbEmpty && (
            <>
              {popularInDb.length > 0 && (<>
                <div style={{ fontSize: "clamp(10px,.7vw,12px)", color: "rgba(240,237,230,.35)", padding: "8px 12px 4px", textTransform: "uppercase", letterSpacing: 1 }}>Популярные кандидаты</div>
                {popularInDb.map(p => <PlayerRow key={p.id} p={p} />)}
                <div style={{ height: 1, background: "rgba(255,255,255,.08)", margin: "8px 0" }} />
              </>)}
              <div style={{ fontSize: "clamp(10px,.7vw,12px)", color: "rgba(240,237,230,.35)", padding: "4px 12px 4px", textTransform: "uppercase", letterSpacing: 1 }}>Все игроки ({available.length})</div>
              {displayed.map(p => <PlayerRow key={p.id} p={p} />)}
            </>
          )}
          {/* Show more */}
          {!q && showCount < browseable.length && (
            <button onClick={() => setShowCount(c => c + 100)}
              style={{ width: "100%", background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)", color: "rgba(240,237,230,.6)", fontFamily: "Barlow Condensed,sans-serif", fontSize: 14, padding: "10px", borderRadius: 6, cursor: "pointer", margin: "8px 0" }}>
              Показать ещё {Math.min(100, browseable.length - showCount)} из {browseable.length - showCount} →
            </button>
          )}
        </div>

        {/* Manual input */}
        <div style={{ borderTop: "1px solid rgba(255,255,255,.07)", paddingTop: 10 }}>
          <div style={{ fontSize: "clamp(11px,.75vw,13px)", color: "rgba(240,237,230,.4)", marginBottom: 6 }}>Или введите вручную:</div>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="inp" placeholder="Имя игрока" value={manualName}
              onChange={e => setManualName(e.target.value)}
              style={{ flex: 1, marginBottom: 0, fontSize: "clamp(13px,.9vw,16px)" }}
              onKeyDown={e => { if (e.key === "Enter" && manualName.trim()) { onSelect(manualName.trim()); onClose(); } }} />
            <button className="bp" style={{ padding: "8px 16px", fontSize: "clamp(13px,.9vw,16px)" }}
              onClick={() => { if (manualName.trim()) { onSelect(manualName.trim()); onClose(); } }}>OK</button>
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
  // ── Таймер обратного отсчёта до дедлайна ──
  const DEADLINE = new Date("2026-06-11T19:00:00Z"); // 22:00 МСК = 19:00 UTC
  const [timeLeft, setTimeLeft] = React.useState(() => Math.max(0, DEADLINE - Date.now()));
  React.useEffect(() => {
    const t = setInterval(() => setTimeLeft(Math.max(0, DEADLINE - Date.now())), 1000);
    return () => clearInterval(t);
  }, []);
  const days    = Math.floor(timeLeft / 86400000);
  const hours   = Math.floor((timeLeft % 86400000) / 3600000);
  const minutes = Math.floor((timeLeft % 3600000) / 60000);
  const seconds = Math.floor((timeLeft % 60000) / 1000);
  const expired = timeLeft === 0;

  // ── Счётчик участников из Supabase ──
  // На лендинге показываем минимум 15 участников, чтобы блок не выглядел пустым на старте.
  const MIN_VISIBLE_PARTICIPANTS = 15;
  const [count, setCount] = React.useState(null);
  const visibleCount = Math.max(count || 0, MIN_VISIBLE_PARTICIPANTS);
  React.useEffect(() => {
    supa("profiles?select=id&prediction_status=neq.draft&limit=1", {}, "HEAD")
      .then(r => {
        const n = r.headers?.get("Content-Range")?.split("/")?.[1];
        if (n && n !== "*") setCount(parseInt(n));
        else supa("profiles?select=id,prediction_status").then(async r2 => {
          if (r2.ok) { const d = await r2.json(); setCount(d.filter(p => p.prediction_status !== "draft").length || d.length); }
        });
      }).catch(() => {});
  }, []);

  const S = {
    page: { minHeight: "100vh", background: "#0B1E12", color: "#F0EDE6", fontFamily: "Barlow Condensed, sans-serif" },
    hdr:  { background: "rgba(0,0,0,.6)", borderBottom: "1px solid rgba(245,158,11,.2)", backdropFilter: "blur(10px)", position: "sticky", top: 0, zIndex: 100 },
    hdrIn: { maxWidth: 900, margin: "0 auto", padding: "0 16px", display: "flex", alignItems: "center", gap: 12, height: 52 },
    section: { maxWidth: 860, margin: "0 auto", padding: "56px 16px" },
    label: { fontFamily: "Oswald, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: "#F59E0B", marginBottom: 14, textAlign: "center" },
    h2: { fontFamily: "Oswald, sans-serif", fontSize: 26, fontWeight: 700, color: "#F0EDE6", textAlign: "center", marginBottom: 10 },
    card: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 12, padding: "20px 18px" },
    divider: { border: "none", borderTop: "1px solid rgba(255,255,255,.06)", margin: 0 },
  };

  const scrollTo = id => document.getElementById("land-" + id)?.scrollIntoView({ behavior: "smooth" });

  const TimerBox = ({ val, label }) => (
    <div style={{ textAlign: "center", minWidth: 56 }}>
      <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 36, fontWeight: 700, color: "#FDE68A", lineHeight: 1 }}>{String(val).padStart(2, "0")}</div>
      <div style={{ fontSize: 10, color: "rgba(240,237,230,.4)", textTransform: "uppercase", letterSpacing: 1, marginTop: 3 }}>{label}</div>
    </div>
  );

  return (
    <div style={S.page}>

      {/* ── HEADER ── */}
      <header style={S.hdr}>
        <div style={S.hdrIn}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <Logo size="xs" />
            <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6" }}>Football Fight Club</span>
          </div>
          <nav style={{ display: "flex", gap: 2, flex: 1, justifyContent: "center", overflowX: "auto" }}>
            {[["pay","💳 Участвовать"],["howto","Как играть"],["faq","FAQ"],["contacts","Контакты"]].map(([id, label]) => (
              <button key={id} onClick={() => scrollTo(id)}
                style={{ background: "transparent", border: "none", color: "rgba(240,237,230,.55)", fontSize: 12, fontWeight: 600, fontFamily: "Barlow Condensed,sans-serif", padding: "5px 10px", borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap" }}>
                {label}
              </button>
            ))}
          </nav>
          <button className="bp" style={{ padding: "7px 16px", fontSize: 13, flexShrink: 0 }} onClick={onLogin}>Войти →</button>
        </div>
      </header>

      {/* ── HERO ── */}
      <section style={{ background: "linear-gradient(180deg, rgba(185,28,28,.12) 0%, transparent 100%)", padding: "72px 16px 56px", textAlign: "center" }}>
        <Logo size="xl" style={{ margin: "0 auto 24px" }} />

        {/* Срочность сверху */}
        {!expired && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(185,28,28,.2)", border: "1px solid rgba(185,28,28,.4)", borderRadius: 20, padding: "6px 16px", marginBottom: 20, fontSize: 12, color: "#FCA5A5", fontWeight: 600 }}>
            🔴 Регистрация закрывается 11 июня в 22:00 МСК
          </div>
        )}

        <h1 style={{ fontFamily: "Oswald, sans-serif", fontSize: "clamp(30px, 5vw, 52px)", fontWeight: 700, color: "#F0EDE6", lineHeight: 1.08, marginBottom: 14, letterSpacing: 0.5 }}>
          Угадай победителя<br />
          <span style={{ color: "#F59E0B" }}>Чемпионата мира 2026</span><br />
          и обойди всех
        </h1>
        <p style={{ fontSize: 17, color: "rgba(240,237,230,.6)", lineHeight: 1.7, maxWidth: 520, margin: "0 auto 28px" }}>
          104 матча. Бонусные вопросы. Командный зачёт. Приз победителю — 5 000 ₽. Один турнир на весь ЧМ — от первого свистка до финала.
        </p>

        {/* Главная кнопка */}
        <div style={{ marginBottom: 20 }}>
          <button onClick={onLogin}
            style={{ background: "linear-gradient(135deg, #B91C1C 0%, #DC2626 100%)", color: "#fff", border: "none", fontFamily: "Oswald, sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "18px 48px", borderRadius: 6, cursor: "pointer", boxShadow: "0 4px 24px rgba(185,28,28,.4)", transition: "transform .12s" }}
            onMouseEnter={e => e.currentTarget.style.transform = "scale(1.03)"}
            onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}>
            Участвовать
          </button>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginTop: 8 }}>
            Меньше цены кофе в кофейне · оплата переводом на карту
          </div>
        </div>

        {/* Социальное доказательство */}
        {visibleCount > 0 && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.25)", borderRadius: 20, padding: "7px 18px", marginBottom: 32, fontSize: 13, color: "#86EFAC", fontWeight: 600 }}>
            ✅ Уже {visibleCount} участник{visibleCount % 10 === 1 && visibleCount % 100 !== 11 ? "" : visibleCount % 10 >= 2 && visibleCount % 10 <= 4 && (visibleCount % 100 < 10 || visibleCount % 100 >= 20) ? "а" : "ов"} зарегистрировались
          </div>
        )}

        {/* Таймер */}
        {!expired ? (
          <div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 12 }}>До закрытия регистрации</div>
            <div style={{ display: "flex", justifyContent: "center", gap: 8, alignItems: "center" }}>
              <TimerBox val={days} label="дней" />
              <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 32, color: "#F59E0B", marginBottom: 14 }}>:</span>
              <TimerBox val={hours} label="часов" />
              <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 32, color: "#F59E0B", marginBottom: 14 }}>:</span>
              <TimerBox val={minutes} label="минут" />
              <span style={{ fontFamily: "Oswald, sans-serif", fontSize: 32, color: "#F59E0B", marginBottom: 14 }}>:</span>
              <TimerBox val={seconds} label="секунд" />
            </div>
            <div style={{ fontSize: 11, color: "rgba(240,237,230,.25)", marginTop: 10 }}>
              Кто не успеет до дедлайна — не попадёт в таблицу турнира
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 14, color: "#FCA5A5" }}>Регистрация закрыта. Следи за результатами в таблице.</div>
        )}
      </section>

      <hr style={S.divider} />

      {/* ── ЧТО ТЫ ПОЛУЧАЕШЬ ── */}
      <section id="land-howto" style={S.section}>
        <div style={S.label}>Что входит в 500 ₽</div>
        <h2 style={S.h2}>Один взнос — весь турнир</h2>
        <div style={{ background: "linear-gradient(135deg, rgba(245,158,11,.15) 0%, rgba(185,28,28,.1) 100%)", border: "2px solid rgba(245,158,11,.35)", borderRadius: 12, padding: "18px 22px", marginBottom: 16, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 36, fontWeight: 700, color: "#F59E0B" }}>🏆</div>
          <div>
            <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 20, fontWeight: 700, color: "#FDE68A" }}>Приз победителю — 5 000 ₽</div>
            <div style={{ fontSize: 13, color: "rgba(240,237,230,.55)", marginTop: 3 }}>Лучший прогнозист ЧМ-2026 забирает приз. Таблица публичная — всё честно.</div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24 }}>
          {[
            { icon: "📋", title: "104 матча групп + плей-офф", desc: "Прогнозируй каждый матч ЧМ — от группы до финала. Точный счёт даёт максимум очков." },
            { icon: "❓", title: "30 бонусных вопросов", desc: "Лучший бомбардир, MVP, молодой игрок — до 8 очков за вопрос. Отвечаешь до старта." },
            { icon: "🏆", title: "Общая таблица", desc: "Соревнуешься со всеми участниками. Видишь свою позицию в реальном времени." },
            { icon: "🤝", title: "Командный зачёт", desc: "Создай команду с друзьями от 2 человек. Рейтинг по среднему баллу." },
          ].map(c => (
            <div key={c.title} style={{ ...S.card, background: "rgba(185,28,28,.06)", border: "1px solid rgba(185,28,28,.18)" }}>
              <div style={{ fontSize: 26, marginBottom: 8 }}>{c.icon}</div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 6 }}>{c.title}</div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.55 }}>{c.desc}</div>
            </div>
          ))}
        </div>

        {/* Бесплатная добавка */}
        <div style={{ background: "rgba(22,163,74,.07)", border: "1px solid rgba(22,163,74,.2)", borderRadius: 12, padding: "16px 20px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 28 }}>🆓</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 700, color: "#86EFAC", marginBottom: 4 }}>Битва клубов — бесплатно для всех</div>
            <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)" }}>
              Дуэльный драфт тура: выбери тренера + 11 игроков из 60 вариантов. Пары 1 на 1 после дедлайна.
            </div>
          </div>
          <button onClick={onLogin} style={{ background: "rgba(22,163,74,.2)", border: "1px solid rgba(22,163,74,.4)", color: "#86EFAC", fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 600, padding: "8px 16px", borderRadius: 4, cursor: "pointer" }}>
            Попробовать бесплатно →
          </button>
        </div>
      </section>

      <hr style={S.divider} />

      {/* ── КАК ОПЛАТИТЬ ── */}
      <section id="land-pay" style={S.section}>
        <div style={S.label}>Участие — 500 ₽</div>
        <h2 style={S.h2}>3 шага до старта</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 560, margin: "0 auto 32px" }}>
          {[
            { n: "1", icon: "👤", title: "Зарегистрируйся", desc: "Создай аккаунт через почту или Google. Займёт 30 секунд." },
            { n: "2", icon: "💳", title: "Переведи 500 ₽", desc: "Перевод на карту по номеру 8 911 823-15-76 (Сбер / Т-Банк). Отправь скрин в поддержку. Победитель получает 5 000 ₽." },
            { n: "3", icon: "📋", title: "Заполни прогнозы", desc: "До 11 июня 22:00 МСК. После — прогнозы закрываются и начинается турнир." },
          ].map(s => (
            <div key={s.n} style={{ display: "flex", gap: 16, alignItems: "flex-start", background: "rgba(245,158,11,.04)", border: "1px solid rgba(245,158,11,.12)", borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 32, fontWeight: 700, color: "#F59E0B", lineHeight: 1, flexShrink: 0, width: 32, textAlign: "center" }}>{s.n}</div>
              <div>
                <div style={{ fontSize: 22, marginBottom: 4 }}>{s.icon}</div>
                <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 700, color: "#F0EDE6", marginBottom: 3 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.55)", lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Большая CTA */}
        <div style={{ textAlign: "center" }}>
          <button onClick={onLogin}
            style={{ background: "linear-gradient(135deg, #B91C1C 0%, #DC2626 100%)", color: "#fff", border: "none", fontFamily: "Oswald, sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "16px 44px", borderRadius: 6, cursor: "pointer", boxShadow: "0 4px 20px rgba(185,28,28,.35)", marginBottom: 10 }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.9"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}>
            Зарегистрироваться и участвовать
          </button>
          <div style={{ fontSize: 11, color: "rgba(240,237,230,.3)", marginTop: 6 }}>
            Поддержка: <a href="https://vk.com/panteleewintop" target="_blank" rel="noopener noreferrer" style={{ color: "#93C5FD" }}>vk.com/panteleewintop</a>
          </div>
        </div>
      </section>

      <hr style={S.divider} />

      {/* ── F-COINS ── */}
      <section id="land-fcoins" style={S.section}>
        <div style={S.label}>F-Coins</div>
        <h2 style={S.h2}>Активность = преимущество</h2>
        <p style={{ fontSize: 14, color: "rgba(240,237,230,.55)", textAlign: "center", maxWidth: 520, margin: "0 auto 24px", lineHeight: 1.7 }}>
          F-Coins — очки активности. При равенстве основных очков побеждает тот, у кого больше F-Coins. Зарабатывай каждый день.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {[
            ["📅", "Ежедневный квиз", "до 25 🪙 в день"],
            ["👥", "Пригласи друга", "+100 🪙 за оплату"],
            ["⚔️", "Победа в Битве клубов", "+50 🪙 за победу"],
          ].map(([icon, t, v]) => (
            <div key={t} style={{ ...S.card, textAlign: "center", background: "rgba(245,158,11,.04)", border: "1px solid rgba(245,158,11,.1)" }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>{icon}</div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", marginBottom: 6, lineHeight: 1.4 }}>{t}</div>
              <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 15, fontWeight: 700, color: "#F59E0B" }}>{v}</div>
            </div>
          ))}
        </div>
      </section>

      <hr style={S.divider} />

      {/* ── FAQ — ответы на возражения ── */}
      <section id="land-faq" style={S.section}>
        <div style={S.label}>Вопросы и ответы</div>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          {[
            { q: "Какой приз у победителя?", a: "Победитель Битвы прогнозистов получает 5 000 ₽. Деньги переводятся на карту. Таблица публичная — результат проверяется всеми участниками." },
            { q: "«500 ₽ — это много»", a: "Меньше чашки кофе в любой кофейне. Зато удовольствие на весь ЧМ-2026 — больше месяца активного турнира, каждый матч становится интереснее." },
            { q: "«Я никогда не участвовал в таких турнирах»", a: "Всё просто: угадываешь счёт матчей. Чем точнее — тем больше очков. Никаких специальных знаний не нужно, нужно просто любить футбол." },
            { q: "«Вдруг я проиграю?»", a: "Турнир идёт весь ЧМ. Ошибся в группе — наверстаешь в плей-офф. Бонусные вопросы, командный зачёт и Битва клубов дают много дополнительных шансов." },
            { q: "«Как убедиться, что всё честно?»", a: "Вся таблица публичная. Прогнозы проверяются по официальным результатам ФИФА. Поддержка в VK отвечает на любые вопросы." },
            { q: "«Мои друзья не участвуют — скучно одному»", a: "Пригласи друзей — они получат ту же регистрацию и доступ. Можно создать общую команду в командном зачёте. А ещё +100 F-Coins тебе за каждого оплатившего друга." },
            { q: "Как оплатить?", a: "Переведи 500 ₽ на карту по номеру 8 911 823-15-76 (Сбер / Т-Банк) и отправь скрин в поддержку: vk.com/panteleewintop. Доступ открывается в течение дня." },
            { q: "Можно сыграть бесплатно?", a: "Да — Битва клубов полностью бесплатная. Выбери 12 игроков из драфта тура и сражайся 1 на 1 с другим участником." },
          ].map((f, i, arr) => (
            <div key={f.q} style={{ padding: "16px 0", borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,.06)" : "none" }}>
              <div style={{ fontFamily: "Barlow Condensed, sans-serif", fontSize: 15, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>{f.q}</div>
              <div style={{ fontSize: 13, color: "rgba(240,237,230,.55)", lineHeight: 1.7 }}>{f.a}</div>
            </div>
          ))}
        </div>
      </section>

      <hr style={S.divider} />

      {/* ── КОНТАКТЫ ── */}
      <section id="land-contacts" style={{ ...S.section, paddingTop: 32, paddingBottom: 32 }}>
        <div style={S.label}>Сообщество и поддержка</div>
        <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
          <a href="https://t.me/ffc_cup" target="_blank" rel="noopener noreferrer"
            style={{ flex: 1, minWidth: 200, display: "flex", alignItems: "center", gap: 10, background: "rgba(29,78,216,.1)", border: "1px solid rgba(29,78,216,.25)", borderRadius: 10, padding: "14px 18px", color: "#93C5FD", textDecoration: "none", fontFamily: "Barlow Condensed,sans-serif", fontSize: 15, fontWeight: 600 }}>
            <span style={{ fontSize: 22 }}>✈️</span>
            <div>
              <div>Telegram-сообщество</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 400 }}>t.me/ffc_cup · новости, результаты</div>
            </div>
          </a>
          <a href="https://vk.com/panteleewintop" target="_blank" rel="noopener noreferrer"
            style={{ flex: 1, minWidth: 200, display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "14px 18px", color: "#F0EDE6", textDecoration: "none", fontFamily: "Barlow Condensed,sans-serif", fontSize: 15, fontWeight: 600 }}>
            <span style={{ fontSize: 22 }}>💬</span>
            <div>
              <div>Поддержка</div>
              <div style={{ fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 400 }}>vk.com/panteleewintop · вопросы, оплата</div>
            </div>
          </a>
        </div>
      </section>

      {/* ── ФИНАЛЬНЫЙ CTA ── */}
      <section style={{ padding: "0 16px 80px" }}>
        <div style={{ maxWidth: 700, margin: "0 auto", background: "linear-gradient(135deg, rgba(185,28,28,.18) 0%, rgba(21,128,61,.18) 100%)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 16, padding: "40px 28px", textAlign: "center" }}>
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: "clamp(22px, 3vw, 32px)", fontWeight: 700, color: "#F0EDE6", marginBottom: 10 }}>
            Успей до дедлайна
          </div>
          {!expired && (
            <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 22, color: "#FDE68A", marginBottom: 8, fontWeight: 700 }}>
              {days}д {hours}ч {minutes}м
            </div>
          )}
          <div style={{ fontFamily: "Oswald, sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>Приз победителю — 5 000 ₽</div>
          <div style={{ fontSize: 14, color: "rgba(240,237,230,.5)", marginBottom: 8 }}>
            11 июня 22:00 МСК — прогнозы закрываются
          </div>
          <div style={{ fontSize: 12, color: "rgba(240,237,230,.35)", marginBottom: 24 }}>
            Кто не успеет — не попадёт в турнирную таблицу
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={onLogin}
              style={{ background: "linear-gradient(135deg, #B91C1C, #DC2626)", color: "#fff", border: "none", fontFamily: "Oswald, sans-serif", fontSize: 17, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "15px 36px", borderRadius: 6, cursor: "pointer", boxShadow: "0 4px 20px rgba(185,28,28,.4)" }}>
              Участвовать
            </button>
            <button onClick={onLogin}
              style={{ background: "rgba(22,163,74,.15)", color: "#86EFAC", border: "1px solid rgba(22,163,74,.35)", fontFamily: "Oswald, sans-serif", fontSize: 14, fontWeight: 600, padding: "15px 28px", borderRadius: 6, cursor: "pointer" }}>
              Битва клубов бесплатно
            </button>
          </div>
          <div style={{ fontSize: 10, color: "rgba(240,237,230,.25)", marginTop: 14 }}>
            Пригласи друга → он оплатил → тебе +100 F-Coins · <a href="https://t.me/ffc_cup" target="_blank" rel="noopener noreferrer" style={{ color: "rgba(147,197,253,.5)" }}>t.me/ffc_cup</a>
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
function ProfileMenu({ profile, isAdmin, isPaid, onNavigate, onLogout, onChangeName }) {
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

  const [bg, fg] = avc(getDisplayName(profile));
  const displayName = getDisplayName(profile);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      {/* Кнопка профиля */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 7, background: open ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 10px 5px 6px", cursor: "pointer", transition: "background 0.15s" }}
      >
        {/* Аватар */}
        <div style={{ width: 28, height: 28, borderRadius: "50%", background: bg, color: fg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Oswald,sans-serif", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
          {ini(getDisplayName(profile))}
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
            ["👤 Мой профиль", "profile"],
            ["🪙 F-Coins / рефералка", "fcoins"],
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

          {/* Имя формы меняется внизу формы прогнозов перед отправкой, не в меню профиля */}

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

// ══════════════════════════════════════════════════════════════════
// КОМАНДНЫЙ ЗАЧЁТ — алиасы, составы, публичная таблица
// ══════════════════════════════════════════════════════════════════

// Явная карта алиасов: rosterName → список возможных display_name/name в profiles
const TEAM_MEMBER_ALIASES = {
  "Eugene Fadeev":          ["Eugene Fadeev", "Евгений Фадеев"],
  "АнтонВоробей":           ["АнтонВоробей", "Антон Воробей"],
  "Antosha046":             ["Antosha046", "Антон Цуканов"],

  "Пантелеев":              ["Андрей Пантелеев", "Пантелеев"],
  "Пантелеева":             ["Таня Пантелеева", "Татьяна Пантелеева", "Пантелеева"],
  "Валерия GP":              ["Валерия GP", "Валерий GP", "Валерий П"],
  "Xenia Ge":                ["Xenia Ge", "Ксения Ge", "Ксения П"],
  "Иван Cl":                 ["Иван Cl", "Ваня Cl", "Ваня П", "Иван П"],

  "Ключкина":               ["Надежда Ключкина", "Ключкина"],
  "Альберт":                ["Альберт"],

  "Александра Капитанеску": ["Александра Капитанеску"],
  "Терентьев":              ["Александр Терентьев", "Терентьев"],

  "Илья Крикун":            ["Илья Крикун"],
  "Аманатов":               ["Аманатов Юрий", "Юрий Аманатов", "Аманатов"],
  "Никита":                 ["Никита Крикун", "Никита"],
  "Nikita":                 ["Nikita"],

  "Анищенко":               ["Aleksandr Anishchenko", "Александр Анищенко", "Анищенко"],
  "Боев":                   ["Боев", "БОЕВ"],

  "Zizu":                   ["ZiZu", "Zizu", "zizu"],
  "Kirill \"Mr_J\" GJ":    ["Kirill \"Mr_J\" GJ", "Kirill Mr_J GJ", "Mr_J", "MRj", "MrJ"],

  "Паздников":              ["pazdnikov.dmitriy", "Дмитрий Паздников", "Паздников"],
  "Дубровин":               ["Андрей Дубровин", "Дубровин"],
  "Elena Pavlovna":         ["Elena Pavlovna", "Елена Павловна"],

  "Белюков":                ["Белюков Константин", "Константин Белюков", "Белюков"],
  "Марина":                 ["Марина"],

  "Антонио Голубев":        ["Антонио Голубев"],
  "Сергей Журавлев":        ["Сергей Журавлев", "Сергей Журавлёв"],

  "Руслан":                 ["Руслан"],
  "Роман":                  ["Роман", "Роман Р"],
};

const PREDICTOR_TEAMS_ROSTERS = [
  { name: "Parkovaya City",         members: ["Eugene Fadeev", "АнтонВоробей", "Antosha046"] },
  { name: "Атомные отруби",       members: ["Пантелеев", "Пантелеева"] },
  { name: "Crazy girls and boys",   members: ["Ключкина", "Альберт"] },
  { name: "Верните Саутгейта",      members: ["Александра Капитанеску", "Терентьев"] },
  { name: "Геленджик",              members: ["Илья Крикун", "Аманатов", "Nikita"] },
  { name: "Грузинские псы",         members: ["Анищенко", "Боев"] },
  { name: "Псовские грузины",       members: ["Zizu", "Kirill \"Mr_J\" GJ"] },
  { name: "Indigo Team",            members: ["Паздников", "Дубровин", "Elena Pavlovna"] },
  { name: "Спорт в конце тоннеля",  members: ["Белюков", "Марина"] },
  { name: "Город Калинин",          members: ["Антонио Голубев", "Сергей Журавлев"] },
  { name: "Команда R",              members: ["Руслан", "Роман"] },
];

function normalizePersonName(str) {
  return String(str || "").toLowerCase().trim()
    .replace(/ё/g, "е").replace(/[^a-zа-яA-ZА-Я0-9\s.]/g, "").replace(/\s+/g, " ");
}

// Строгое сопоставление по алиасам — только aliases[rosterName], без fuzzy
// Возвращает participant из leaderboard или null
function findParticipantByRosterName(rosterName, leaderboard, usedIds) {
  const aliases = TEAM_MEMBER_ALIASES[rosterName];
  if (!aliases || aliases.length === 0) return null;
  const normAliases = aliases.map(a => normalizePersonName(a));

  let bestMatch = null;
  let bestScore = 0;

  for (const { u, total, exact, group, playoff, bonus } of leaderboard) {
    const id = String(u.id || "");
    if (usedIds.has(id)) continue; // уже занят в этой команде
    const pName = normalizePersonName(u.display_name || u.name || "");

    for (const normAlias of normAliases) {
      if (!normAlias) continue;
      let score = 0;
      // Точное совпадение — максимальный приоритет
      if (pName === normAlias) { score = 100; }
      // Participant содержит alias (alias длиннее 4 символов)
      else if (normAlias.length > 4 && pName.includes(normAlias)) { score = 50; }
      // Alias содержит participant (participant длиннее 4 символов) — только если очень короткое имя
      else if (pName.length > 4 && normAlias.includes(pName) && pName.length >= normAlias.length - 3) { score = 30; }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { u, total, exact, group, playoff, bonus };
      }
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function PublicTeamStandings({ leaderboard: externalLeaderboard }) {
  // Собственная загрузка если leaderboard не передан извне (пользователь открыл вкладку напрямую)
  const [internalLeaderboard, setInternalLeaderboard] = React.useState(null);
  const [loadingOwn, setLoadingOwn] = React.useState(false);

  const leaderboard = (externalLeaderboard && externalLeaderboard.length > 0)
    ? externalLeaderboard
    : (internalLeaderboard || []);

  React.useEffect(() => {
    if (externalLeaderboard && externalLeaderboard.length > 0) return; // уже есть
    if (internalLeaderboard !== null) return; // уже загрузили
    loadOwn();
  }, [externalLeaderboard]);

  async function loadOwn() {
    setLoadingOwn(true);
    try {
      const PAGE = 1000;
      async function fetchA(path) {
        const rows = [];
        for (let pg = 0; pg < 50; pg++) {
          const sep = path.includes("?") ? "&" : "?";
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${pg * PAGE}`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
          });
          if (!r.ok) break;
          const chunk = await r.json().catch(() => []);
          const arr = Array.isArray(chunk) ? chunk : [];
          rows.push(...arr);
          if (arr.length < PAGE) break;
        }
        return rows;
      }

      const [profileRows, predRows, bonusRows, officialRows, bonusOfficialRows] = await Promise.all([
        (async () => { try { return await fetchA("profiles?select=id,name,display_name&order=name.asc"); } catch { return []; } })(),
        fetchA("predictions?select=user_id,match_id,home_score,away_score"),
        fetchA("bonus_answers?select=user_id,question_id"),
        fetchA("official_results?select=match_id,home_score,away_score,status").catch(() => []),
        fetchA("bonus_official_answers?select=question_id,points").catch(() => []),
      ]);

      // Считаем прогнозы
      const allGroupIds = new Set(ALL_GROUPS.flatMap(g => (GROUP_MATCHES[g] || []).map(m => String(m.id))));
      function nm(raw) { if (!raw && raw !== 0) return ""; const s = String(raw).trim().toLowerCase(); return s.match(/^m?\d+$/) ? `m${s.replace(/^m/, "")}` : s; }

      const predCount = {};
      predRows.forEach(r => {
        if (!r.user_id || r.match_id == null) return;
        if (!predCount[r.user_id]) predCount[r.user_id] = { group: 0, playoff: 0 };
        if (r.home_score == null || r.away_score == null) return;
        if (allGroupIds.has(nm(r.match_id))) predCount[r.user_id].group++;
        else predCount[r.user_id].playoff++;
      });
      const bonusCount = {};
      bonusRows.forEach(r => { if (r.user_id) bonusCount[r.user_id] = (bonusCount[r.user_id] || 0) + 1; });

      // Официальные очки (упрощённо: просто подтверждённые матчи для сортировки)
      const officialMap = {};
      officialRows.forEach(r => { if (r.match_id && r.home_score != null) officialMap[nm(r.match_id)] = { h: r.home_score, a: r.away_score }; });
      const bonusOfficialMap = {};
      bonusOfficialRows.forEach(r => { if (r.question_id) bonusOfficialMap[String(r.question_id)] = r; });

      // Строим синтетические профили если profiles пустые
      let workingProfiles = profileRows.length > 0 ? profileRows
        : Object.keys(predCount).map(uid => ({ id: uid, name: null, display_name: null, _synthetic: true }));

      // Фильтр полных участников
      const fullParts = workingProfiles.filter(p => {
        const pc = predCount[String(p.id)] || { group: 0, playoff: 0 };
        const bc = bonusCount[String(p.id)] || 0;
        return pc.group >= 72 && pc.playoff >= 32 && bc >= 31;
      });
      const parts = fullParts.length > 0 ? fullParts
        : workingProfiles.filter(p => Object.keys({ ...(predCount[String(p.id)] ? { x: 1 } : {}) }).length > 0);

      // Считаем очки просто как сумму правильных исходов (грубое приближение для сортировки)
      // Используем calculateMatchPredictionPoints если доступна
      const lb = parts.map(u => {
        const uid = String(u.id);
        const pc = predCount[uid] || { group: 0, playoff: 0 };
        const bc = bonusCount[uid] || 0;
        // Грубая оценка: group * средний балл, но лучше просто total = group + playoff
        const total = pc.group + pc.playoff + bc;
        return { u: { ...u, _uid: uid }, total, group: pc.group, playoff: pc.playoff, bonus: bc, exact: 0 };
      }).sort((a, b) => b.total - a.total);

      setInternalLeaderboard(lb);
    } catch (e) {
      console.error("PublicTeamStandings loadOwn error", e);
      setInternalLeaderboard([]);
    } finally {
      setLoadingOwn(false);
    }
  }

  if (loadingOwn) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "rgba(240,237,230,.4)", fontSize: 13 }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>⏳</div>
        <div>Загружаю данные командного зачёта…</div>
      </div>
    );
  }

  if (leaderboard.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "40px 20px", color: "rgba(240,237,230,.4)", fontSize: 13 }}>
        <div>Данные рейтинга загружаются…</div>
        <button className="sb" style={{ marginTop: 12, fontSize: 11 }} onClick={loadOwn}>↻ Загрузить</button>
      </div>
    );
  }

  // Строим карту participantId → запись leaderboard
  const lbById = {};
  leaderboard.forEach(row => { const id = String(row.u?.id || row.u?._uid || ""); if (id) lbById[id] = row; });

  // Для каждой команды находим участников через алиасы, без дублей
  const teamRows = PREDICTOR_TEAMS_ROSTERS.map(team => {
    const usedIds = new Set();
    const found = team.members.map(rosterName => {
      const match = findParticipantByRosterName(rosterName, leaderboard, usedIds);
      if (match) usedIds.add(String(match.u?.id || match.u?._uid || ""));
      return { rosterName, match }; // match = {u, total, group, playoff, bonus, exact} | null
    });

    const withScores = found.filter(f => f.match !== null)
      .sort((a, b) => (b.match.total || 0) - (a.match.total || 0));
    const top2 = withScores.slice(0, 2);
    const rest = withScores.slice(2);
    const notFound = found.filter(f => f.match === null);

    const teamScore = top2.reduce((s, f) => s + (f.match.total || 0), 0);
    const best1 = top2[0]?.match?.total || 0;
    const best2 = top2[1]?.match?.total || 0;

    return { team, top2, rest, notFound, teamScore, best1, best2, isComplete: top2.length >= 2 };
  }).sort((a, b) => b.teamScore - a.teamScore || b.best1 - a.best1 || b.best2 - a.best2 || a.team.name.localeCompare(b.team.name, "ru"));

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "14px 12px 60px" }}>
      {/* Заголовок */}
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#FDE68A", letterSpacing: 1 }}>
          🤝 Командный зачёт
        </div>
        <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginTop: 3 }}>
          В зачёт идут 2 лучших результата
        </div>
      </div>

      {/* Компактная таблица */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid rgba(245,158,11,.25)" }}>
            <th style={{ width: 28, padding: "6px 8px", fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 700, textAlign: "center" }}>#</th>
            <th style={{ padding: "6px 8px", fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 700, textAlign: "left" }}>Команда</th>
            <th style={{ padding: "6px 8px", fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 700, textAlign: "left" }}>В зачёте (топ-2)</th>
            <th style={{ padding: "6px 8px", fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 700, textAlign: "left", whiteSpace: "nowrap" }}>Остальные</th>
            <th style={{ width: 48, padding: "6px 8px", fontSize: 11, color: "rgba(240,237,230,.4)", fontWeight: 700, textAlign: "right" }}>Очки</th>
          </tr>
        </thead>
        <tbody>
          {teamRows.map(({ team, top2, rest, notFound, teamScore, isComplete }, i) => {
            const medalColor = i === 0 ? "#F59E0B" : i === 1 ? "#D1D5DB" : i === 2 ? "#CD7F32" : "rgba(240,237,230,.3)";
            const rowBg = i === 0 ? "rgba(245,158,11,.06)" : i % 2 === 0 ? "rgba(255,255,255,.015)" : "transparent";
            return (
              <tr key={team.name} style={{ background: rowBg, borderBottom: "1px solid rgba(255,255,255,.05)" }}>
                {/* Место */}
                <td style={{ padding: "8px 8px", textAlign: "center", fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 800, color: medalColor }}>
                  {i + 1}
                </td>
                {/* Название */}
                <td style={{ padding: "8px 8px", fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 700, color: "#F0EDE6", whiteSpace: "nowrap" }}>
                  {team.name}
                  {!isComplete && top2.length === 1 && <span style={{ fontSize: 9, color: "#FDE68A", marginLeft: 4 }}>⚠</span>}
                  {top2.length === 0 && <span style={{ fontSize: 9, color: "#FCA5A5", marginLeft: 4 }}>—</span>}
                </td>
                {/* Топ-2 */}
                <td style={{ padding: "8px 8px" }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {top2.map((f, j) => {
                      const n = f.match.u.display_name || f.match.u.name || String(f.match.u.id || "").slice(0, 8);
                      return (
                        <span key={j} style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                          <span style={{ color: "#86EFAC", fontWeight: 700 }}>{n}</span>
                          <span style={{ color: "#F59E0B", fontFamily: "Oswald,sans-serif", fontWeight: 800, marginLeft: 4 }}>{f.match.total}</span>
                        </span>
                      );
                    })}
                    {top2.length === 0 && <span style={{ fontSize: 11, color: "rgba(240,237,230,.25)" }}>—</span>}
                  </div>
                </td>
                {/* Остальные + не найдены */}
                <td style={{ padding: "8px 8px" }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    {rest.map((f, j) => {
                      const n = f.match.u.display_name || f.match.u.name || String(f.match.u.id || "").slice(0, 8);
                      return (
                        <span key={j} style={{ fontSize: 11, color: "rgba(240,237,230,.5)", whiteSpace: "nowrap" }}>
                          {n} <span style={{ color: "rgba(240,237,230,.7)" }}>{f.match.total}</span>
                        </span>
                      );
                    })}
                    {notFound.map((f, j) => (
                      <span key={j} style={{ fontSize: 10, color: "rgba(240,237,230,.2)", whiteSpace: "nowrap" }}>
                        {f.rosterName}
                      </span>
                    ))}
                  </div>
                </td>
                {/* Очки команды */}
                <td style={{ padding: "8px 8px", textAlign: "right", fontFamily: "Oswald,sans-serif", fontSize: i < 3 ? 20 : 17, fontWeight: 800,
                  color: i === 0 ? "#F59E0B" : i === 1 ? "#D1D5DB" : "#F0EDE6" }}>
                  {teamScore}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: 10, fontSize: 10, color: "rgba(240,237,230,.18)", textAlign: "center" }}>
        Результаты обновляются по мере ввода официальных счётов
      </div>
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
  const [formDisplayName, setFormDisplayName] = useState(() => {
    try { return localStorage.getItem("ffc_guest_display_name") || ""; } catch { return ""; }
  });
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameError, setDisplayNameError] = useState("");
  const [tab, setTab] = useState("predict");

  // Прогнозы пользователя
  const [scores, setScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_scores") || "{}"); } catch { return {}; } });
  const [pScores, setPScores] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_scores") || "{}"); } catch { return {}; } });
  const [pPens, setPPens] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_playoff_pens") || "{}"); } catch { return {}; } });
  const [bonus, setBonus] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_guest_bonus") || "{}"); } catch { return {}; } });
  const [bonusPickerOpen, setBonusPickerOpen] = useState(null); // {qid, type, slotIdx, excludeNames}
  const { getOptions: getBonusOptions, loading: bonusOptionsLoading, loadError: bonusOptionsError } = useBonusPlayerOptions();

  // Дисциплина (Fair Play)
  const [discipline, setDiscipline] = useState(() => { try { return JSON.parse(localStorage.getItem("ffc_discipline") || "{}"); } catch { return {}; } });

  // Официальные результаты (для симуляции и админки)
  // officialResults управляется в AdminPanel напрямую через localStorage

  // Личные результаты участника для симуляции
  // userSim и simMode — будут реализованы в следующей версии

  const [leaderboard, setLeaderboard] = useState([]);
  const [publicLeaderboard, setPublicLeaderboard] = useState([]); // из PublicForecastTable для CommandnyZachet
  const [showAuth, setShowAuth] = useState(false);
  const [showDisplayNameModal, setShowDisplayNameModal] = useState(false);
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
  const tournamentOpen = (isOpen() && !predictionsLocked) || GUEST_FORM_OPEN;
  const isEditable = !isSubmitted && !isPending && tournamentOpen;
  const isGuest = !session;

  useEffect(() => {
    const handler = (e) => {
      if (e?.detail) setProfile((p) => p ? { ...p, ...e.detail } : e.detail);
    };
    window.addEventListener("ffc-profile-patch", handler);
    return () => window.removeEventListener("ffc-profile-patch", handler);
  }, []);

  const accessLevel = useMemo(() => {
    if (!profile) return ACCESS.DEMO;
    return profile.access_level || ACCESS.DEMO;
  }, [profile]);
  const isAdmin = isProjectAdmin(profile, session);
  const isPaid = [ACCESS.PROGNOSTISTA, ACCESS.FULL, ACCESS.ADMIN].includes(accessLevel);
  // Битва клубов бесплатны — hasLeagueAccess true для всех авторизованных
  const hasLeagueAccess = !!session;
  const formDisplayNameTrimmed = (formDisplayName || "").trim();
  const formDisplayNameValid = !validateFormDisplayName(formDisplayNameTrimmed);

  // Синк localStorage
  useEffect(() => { localStorage.setItem("ffc_guest_scores", JSON.stringify(scores)); }, [scores]);
  useEffect(() => { localStorage.setItem("ffc_guest_playoff_scores", JSON.stringify(pScores)); }, [pScores]);
  useEffect(() => { localStorage.setItem("ffc_guest_playoff_pens", JSON.stringify(pPens)); }, [pPens]);
  useEffect(() => { localStorage.setItem("ffc_guest_bonus", JSON.stringify(bonus)); }, [bonus]);
  useEffect(() => {
    if (isGuest) localStorage.setItem("ffc_guest_display_name", formDisplayName || "");
  }, [formDisplayName, isGuest]);
  // predStatus хранится только для авторизованных (user-specific), гость всегда draft
  useEffect(() => {
    if (session?.user?.id) {
      localStorage.setItem(`ffc_pred_status_${session.user.id}`, predStatus);
    }
  }, [predStatus, session]);

  // Имя формы редактируется внизу формы прогнозов, перед отправкой.
  // В правом верхнем углу больше не заставляем пользователя выбирать имя.
  useEffect(() => {
    if (profile?.id) {
      const savedName = profile?.display_name && !profile.display_name.includes("@") ? profile.display_name.trim() : "";
      setFormDisplayName(savedName || localStorage.getItem("ffc_guest_display_name") || "");
    }
    setDisplayNameError("");
  }, [profile?.id, profile?.display_name]);
  // ffc_user_result_simulation sync — будет добавлен при реализации симуляции

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(""), 2800); };

  // ── ЕДИНЫЙ ОБРАБОТЧИК ПОСЛЕ УСПЕШНОГО ВХОДА ──
  // Используется для входа по email/password, Google и VK — не дублируем логику
  const afterSuccessfulAuth = useCallback(async (rawSess) => {
    // rawSess может быть объектом { access_token, refresh_token, user, ... } или объектом Session из supabase-js
    // или объектом Session из supabase-js (OAuth Google)
    const token = rawSess.access_token;
    const refreshToken = rawSess.refresh_token || null;
    const user = rawSess.user || rawSess;
    if (!token || !user?.id) return;

    const sessObj = { access_token: token, refresh_token: refreshToken, user };
    const guestDisplayName = (localStorage.getItem("ffc_guest_display_name") || "").trim();
    const guestDisplayNameOk = guestDisplayName && !validateFormDisplayName(guestDisplayName);
    if (guestDisplayNameOk) setFormDisplayName(guestDisplayName);
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
      const rawName = meta.full_name || meta.name || "";
      const emailName = (user.email || "").split("@")[0];
      const newProf = {
        id: user.id,
        email: user.email || null,
        name: rawName || emailName || "Игрок",
        display_name: guestDisplayNameOk ? guestDisplayName : (rawName && !rawName.includes("@") ? rawName : null), // null → имя вводится внизу формы
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
    if (guestDisplayNameOk && prof && (!prof.display_name || String(prof.display_name).includes("@"))) {
      try {
        await supa(`profiles?id=eq.${user.id}`, {
          method: "PATCH", token,
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ display_name: guestDisplayName }),
        });
        prof = { ...prof, display_name: guestDisplayName };
      } catch (e) {
        console.warn("guest display_name transfer skipped", e);
      }
    }
    setProfile(prof);
    const dbStatus = prof.prediction_status;
    const localStatus = localStorage.getItem(`ffc_pred_status_${user.id}`);
    setPredStatus(dbStatus || localStatus || "draft");

    // Перенести guest draft если есть и прогноз ещё не submitted.
    // Важно: если человек нажал «Отправить прогноз» гостем, после входа НЕ показываем оплату,
    // пока прогноз реально не записан в predictions/bonus_answers. Раньше из-за этого можно было
    // получить оплату/одобрение без сохранённых прогнозов.
    const guestScores = localStorage.getItem("ffc_guest_scores");
    let hasDraft = false;
    try { hasDraft = guestScores && Object.keys(JSON.parse(guestScores)).length > 0; } catch { }
    let canOpenPendingPayment = !!pendingPlanAfterAuth;
    if (hasDraft && prof.prediction_status !== "submitted") {
      if (pendingPlanAfterAuth) {
        const saved = await syncDB(sessObj);
        canOpenPendingPayment = saved?.ok !== false;
        if (canOpenPendingPayment) {
          await loadMyData(sessObj);
          showToast("✓ Прогноз перенесён в аккаунт и сохранён");
        } else {
          showToast(saved?.message || "Не удалось сохранить прогноз. Оплату пока не открываю.");
        }
      } else {
        setPendingSession(sessObj);
        setShowDraftModal(true);
      }
    } else {
      await loadMyData(sessObj);
      showToast("✓ Вход выполнен!");
      // Имя формы теперь вводится внизу формы прогнозов перед отправкой,
      // поэтому не показываем отдельную модалку сразу после входа.
    }

    await loadLeaderboard();
    setShowAuth(false);

    // Если до входа нажимали "Отправить прогноз" — открыть оплату только после успешного сохранения.
    if (pendingPlanAfterAuth && canOpenPendingPayment) {
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

    // 2. Подхватить OAuth-сессию после редиректа с Google.
    // Важно: не пропускаем обработку, если в localStorage уже лежит старая/битая ffc_session.
    // Иначе Google возвращает на сайт, но пользователь остаётся "как гость".
    function shouldApplySupabaseSession(supabaseSession) {
      if (!supabaseSession?.access_token || !supabaseSession?.user?.id) return false;
      try {
        const stored = JSON.parse(localStorage.getItem("ffc_session") || "null");
        return !stored?.access_token || stored.access_token !== supabaseSession.access_token || stored?.user?.id !== supabaseSession.user.id;
      } catch {
        return true;
      }
    }

    supabaseClient.auth.getSession().then(({ data }) => {
      if (shouldApplySupabaseSession(data?.session)) {
        afterSuccessfulAuth(data.session);
      }
    });

    // 3. Слушать SIGNED_IN (возврат после Google OAuth)
    const { data: sub } = supabaseClient.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_IN" && shouldApplySupabaseSession(s)) {
        afterSuccessfulAuth(s);
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
    const LOCAL_ROUND = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Тур 1 — старт турнира",
      round_no: 1,
      status: "lineup_open",
      opens_at: "2026-06-01T00:00:00Z",
      deadline: "2026-06-11T19:00:00Z",
      is_local_fallback: true,
    };

    try {
      const res = await supa("ffc_rounds?select=*&order=round_no.asc,created_at.desc&limit=20",
        session?.access_token ? { token: session.access_token } : {}
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn("loadActiveRound: HTTP error, using local fallback.", res.status, text.slice(0, 100));
        setActiveRound(LOCAL_ROUND);
        setActiveRoundError(null);
        setAllRounds([LOCAL_ROUND]);
        return;
      }

      const rounds = await res.json();
      const now = new Date();

      // 1) По датам: opens_at <= now < deadline
      const byDates = rounds.find(r => {
        const opens = r.opens_at ? new Date(r.opens_at) : null;
        const dl = r.deadline ? new Date(r.deadline) : null;
        return opens && dl && opens <= now && now < dl;
      });
      // 2) lineup_open + дедлайн ещё не прошёл
      const byStatusOpen = rounds.find(r => r.status === "lineup_open" && r.deadline && now < new Date(r.deadline));
      // 3) любой lineup_open
      const byStatus = rounds.find(r => r.status === "lineup_open");
      // 4) round_no === 1
      const byRound1 = rounds.find(r => r.round_no === 1);
      // 5) любой первый
      const fallback = rounds[0] || null;

      const picked = byDates || byStatusOpen || byStatus || byRound1 || fallback || LOCAL_ROUND;

      if (!fallback) {
        console.warn("loadActiveRound: no rounds in DB, using local fallback.");
      }

      console.log("loadActiveRound picked:", picked.name, picked.status, picked.is_local_fallback ? "(LOCAL)" : "");
      setAllRounds(rounds.length ? rounds : [LOCAL_ROUND]);
      setActiveRound(picked);
      setActiveRoundError(null);
    } catch (e) {
      console.warn("loadActiveRound exception, using local fallback:", e);
      setActiveRound(LOCAL_ROUND);
      setActiveRoundError(null);
      setAllRounds([LOCAL_ROUND]);
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
    try {
      const token = await getFreshToken(setSession).catch(() => null);
      const authToken = token || session?.access_token;
      if (!authToken || isJwtExpired(authToken)) {
        showToast("Сессия истекла. Выйдите и войдите заново.");
        return;
      }

      const payload = {
        club_name:  clubForm.name.trim(),
        club_city:  clubForm.city.trim(),
        club_color: clubForm.color || "#B91C1C",
      };

      const res = await supa(`profiles?id=eq.${session.user.id}`, {
        method: "PATCH",
        token: authToken,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("saveClub PATCH failed:", res.status, text);
        if (res.status === 401 || /JWT expired|invalid jwt|PGRST303/i.test(text)) {
          showToast("Сессия истекла. Выйдите и войдите заново.");
        } else if (res.status === 42501 || /row-level security/i.test(text)) {
          showToast("Не удалось сохранить клуб: RLS не даёт обновить profile");
        } else if (res.status === 400 && /club_name|club_city|club_color|schema cache/i.test(text)) {
          showToast("Не удалось сохранить клуб: в profiles нет колонок club_name/club_city/club_color");
        } else {
          showToast(`Не удалось сохранить клуб (${res.status})`);
        }
        return;
      }

      let updatedProfile = null;
      try {
        const data = await res.json();
        updatedProfile = Array.isArray(data) ? data[0] : data;
      } catch {}

      setProfile((p) => ({ ...(p || {}), ...(updatedProfile || {}), ...payload }));
      showToast("✓ Клуб создан!");
      setClubsSubTab("myclub");
    } catch (e) {
      console.error("saveClub exception", e);
      showToast("Ошибка сохранения клуба: " + (e?.message || "попробуй ещё раз"));
    } finally {
      setClubSaving(false);
    }
  }
  async function handleAuth(sess) {
    await afterSuccessfulAuth(sess);
  }

  // finishAuth — вызывается из DraftModal (перенести или нет черновик)
  async function finishAuth(sess, transfer) {
    setSession(sess);
    await loadProfile(sess);
    let saved = { ok: true };
    if (transfer) { saved = await syncDB(sess); } else { await loadMyData(sess); }
    await loadLeaderboard();
    setPendingSession(null);
    showToast(transfer ? (saved?.ok === false ? (saved.message || "Не удалось перенести черновик") : "✓ Черновик перенесён в аккаунт!") : "✓ Вход выполнен!");
    if (pendingPlanAfterAuth && saved?.ok !== false) {
      setShowPayment(pendingPlanAfterAuth);
      setPendingPlanAfterAuth(null);
    }
  }

  function validateFormDisplayName(value = formDisplayName) {
    const trimmed = (value || "").trim();
    if (trimmed.length < 2) return "Укажите имя формы: минимум 2 символа";
    if (trimmed.length > 40) return "Имя формы: максимум 40 символов";
    if (!/^[a-zA-Zа-яА-ЯёЁ0-9\s\-_]{2,40}$/u.test(trimmed)) return "В имени можно использовать буквы, цифры, пробел, дефис и _";
    return "";
  }

  async function saveDisplayNameFromForm({ silent = false } = {}) {
    if (!session?.user?.id || !session?.access_token) return false;
    const trimmed = (formDisplayName || "").trim();
    const error = validateFormDisplayName(trimmed);
    if (error) {
      setDisplayNameError(error);
      if (!silent) showToast(error);
      return false;
    }

    const current = profile?.display_name && !profile.display_name.includes("@") ? profile.display_name.trim() : "";
    if (current === trimmed) {
      setDisplayNameError("");
      return true;
    }

    setDisplayNameSaving(true);
    setDisplayNameError("");
    try {
      // Берём свежий JWT: если токен протух, display_name не сохранялся,
      // и в админке вместо имени формы снова показывалась почта/старое имя Google.
      const freshToken = await getFreshToken(setSession);
      const authToken = freshToken || session.access_token;
      const r = await supa(`profiles?id=eq.${session.user.id}`, {
        method: "PATCH",
        token: authToken,
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ display_name: trimmed, name: trimmed }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error("saveDisplayNameFromForm PATCH failed", r.status, text);
        const msg = `Не удалось сохранить имя формы (${r.status}). Проверь SQL: profiles.display_name и UPDATE policy`;
        setDisplayNameError(msg);
        if (!silent) showToast(msg);
        setDisplayNameSaving(false);
        return false;
      }
      const d = await r.json().catch(() => null);
      const updated = Array.isArray(d) ? d[0] : null;
      setProfile(prev => ({ ...(prev || {}), ...(updated || {}), display_name: trimmed }));
      if (!silent) showToast(`✓ Имя сохранено: ${trimmed}`);
      setDisplayNameSaving(false);
      return true;
    } catch (e) {
      console.error("saveDisplayNameFromForm exception", e);
      const msg = "Ошибка сохранения имени формы";
      setDisplayNameError(msg);
      if (!silent) showToast(msg);
      setDisplayNameSaving(false);
      return false;
    }
  }

  async function submitPayment(plan, comment) {
    if (!session) return;
    // Перед созданием заявки на оплату ещё раз сохраняем прогноз в БД.
    // Это страховка от ситуации «человек оплатил/одобрен, а прогнозы остались только локально».
    const saved = await syncDB(session);
    if (saved?.ok === false) {
      showToast(saved?.message || "Не удалось сохранить прогноз. Заявку на оплату пока не создаю.");
      return;
    }
    const row = { user_id: session.user.id, user_email: session.user.email, plan: plan.id, amount: plan.price, comment, status: "pending" };
    await supa("payment_requests", { method: "POST", token: session.access_token, headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
    // Обновляем prediction_status в БД
    await supa(`profiles?id=eq.${session.user.id}`, { method: "PATCH", token: session.access_token, headers: { Prefer: "return=minimal" }, body: JSON.stringify({ prediction_status: "payment_pending" }) });
    try {
      await supa("participant_status", {
        method: "POST", token: session.access_token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          user_id: session.user.id,
          status: "payment_pending",
          has_started_predictions: true,
          has_submitted_predictions: true,
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (e) { console.warn("participant_status payment sync skipped", e); }
    setPredStatus("payment_pending");
  }

  async function ensureProfileRowForSession(sess, token, fallbackDisplayName) {
    const uid = sess?.user?.id;
    if (!uid || !token) return false;
    try {
      const meta = sess?.user?.user_metadata || {};
      const fallbackName =
        (fallbackDisplayName && !String(fallbackDisplayName).includes("@") ? fallbackDisplayName : "") ||
        (profile?.display_name && !String(profile.display_name).includes("@") ? profile.display_name : "") ||
        (profile?.name && !String(profile.name).includes("@") ? profile.name : "") ||
        meta.full_name || meta.name || (sess?.user?.email || "").split("@")[0] || "Игрок";
      const profPayload = {
        id: uid,
        email: sess?.user?.email || profile?.email || null,
        name: fallbackName,
        display_name: fallbackName,
        prediction_status: predStatus || profile?.prediction_status || "draft",
        access_level: profile?.access_level || ACCESS.DEMO,
      };
      const profRes = await supa("profiles?on_conflict=id", {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(profPayload),
      });
      if (!profRes.ok) {
        const text = await profRes.text().catch(() => "");
        console.warn("ensureProfileRowForSession failed", profRes.status, text);
        return false;
      }
      const data = await profRes.json().catch(() => null);
      const row = Array.isArray(data) ? data[0] : data;
      if (row) setProfile(prev => ({ ...(prev || {}), ...row }));
      return true;
    } catch (e) {
      console.warn("ensureProfileRowForSession exception", e);
      return false;
    }
  }

  async function syncDB(sess) {
    setSaving(true);
    const uid = sess?.user?.id;
    const freshToken = await getFreshToken(setSession).catch(() => null);
    const token = freshToken || sess?.access_token;

    if (!uid || !token || isJwtExpired(token)) {
      setSaving(false);
      return { ok: false, message: "Сессия истекла. Выйдите и войдите заново, потом нажмите сохранение ещё раз." };
    }

    // Перед записью прогнозов гарантируем наличие строки в profiles — иначе FK в predictions/bonus_answers не даст сохранить.
    await ensureProfileRowForSession(sess, token, formDisplayName);

    const writeErrors = [];
    async function upsertRows(path, rows, label) {
      if (!rows?.length) return true;
      const res = await supa(path, {
        method: "POST", token,
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
      if (res.ok) return true;
      const text = await res.text().catch(() => "");
      console.error(`syncDB ${label} failed`, res.status, text);
      writeErrors.push(`${label}: ${res.status} ${text.slice(0, 180)}`);
      return false;
    }

    async function verifyAndRetryPredictionRows(rows, label) {
      if (!rows?.length) return true;
      const ok = await upsertRows("predictions?on_conflict=user_id,match_id", rows, label);
      if (!ok) return false;

      // Страховка от «частично ушло / не все видно в админке»: сразу проверяем по БД,
      // какие match_id реально записались, и точечно досылаем отсутствующие строки.
      try {
        const ids = rows.map(r => r.match_id).filter(Boolean);
        const idList = ids.join(",");
        const check = await supa(`predictions?user_id=eq.${uid}&match_id=in.(${idList})&select=match_id`, { token });
        if (!check.ok) return ok;
        const saved = await check.json().catch(() => []);
        const savedIds = new Set((Array.isArray(saved) ? saved : []).map(r => r.match_id));
        const missing = rows.filter(r => !savedIds.has(r.match_id));
        if (missing.length) {
          console.warn(`syncDB ${label}: missing after bulk upsert`, missing.map(r => r.match_id));
          for (const row of missing) {
            await upsertRows("predictions?on_conflict=user_id,match_id", [row], `${label} ${row.match_id}`);
          }
        }
      } catch (e) {
        console.warn(`syncDB ${label}: verification skipped`, e);
      }
      return ok;
    }

    // Группы — строгий фильтр, только матчи из ALL_GROUP_MATCH_IDS
    const groupRows = Object.entries(scores)
      .filter(([mid, s]) =>
        ALL_GROUP_MATCH_IDS.has(mid) &&
        s.h !== "" && s.h !== undefined && s.h !== null &&
        s.a !== "" && s.a !== undefined && s.a !== null
      )
      .map(([mid, s]) => ({ user_id: uid, match_id: mid, home_score: +s.h, away_score: +s.a }));
    await verifyAndRetryPredictionRows(groupRows, "групповой этап");

    // Плей-офф — только валидные матчи, с penalty_winner
    const validPlayoffRows = allPlayoffBrackets
      .filter((b) => isPlayoffMatchValid(b))
      .map((b) => {
        const s = pScores[b.id];
        const isDraw = +s.h === +s.a;
        const penaltyWinner = isDraw ? (pPens[b.id] || null) : null;
        return { user_id: uid, match_id: b.id, home_score: +s.h, away_score: +s.a, penalty_winner: penaltyWinner };
      });
    await verifyAndRetryPredictionRows(validPlayoffRows, "плей-офф");

    // Бонусы
    const brows = Object.entries(bonus).map(([qid, ans]) => ({ user_id: uid, question_id: qid, answer: JSON.stringify(ans) }));
    await upsertRows("bonus_answers?on_conflict=user_id,question_id", brows, "вопросы");

    // Админка должна видеть, что пользователь начал/заполнил прогноз.
    // Если таблицы participant_status нет или RLS не пускает — не ломаем сохранение прогнозов.
    try {
      const hasStarted = groupRows.length > 0 || validPlayoffRows.length > 0 || brows.length > 0;
      const hasSubmitted = !!allReady;
      if (hasStarted) {
        const ps = await supa("participant_status?on_conflict=user_id", {
          method: "POST", token,
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            user_id: uid,
            status: hasSubmitted ? "submitted" : "filling",
            has_started_predictions: true,
            has_submitted_predictions: hasSubmitted,
            started_at: new Date().toISOString(),
            submitted_at: hasSubmitted ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!ps.ok) {
          const text = await ps.text().catch(() => "");
          console.warn("participant_status sync failed", ps.status, text);
        }
      }
    } catch (e) {
      console.warn("participant_status sync skipped", e);
    }

    setSaving(false);
    const totalRows = groupRows.length + validPlayoffRows.length + brows.length;
    if (writeErrors.length) {
      return { ok: false, message: `Не удалось сохранить прогноз в БД: ${writeErrors[0]}` };
    }
    return { ok: true, saved: totalRows, group: groupRows.length, playoff: validPlayoffRows.length, bonus: brows.length };
  }

  async function save() {
    localStorage.setItem("ffc_guest_updated_at", new Date().toISOString());
    if (isGuest) { showToast("✓ Черновик сохранён на этом устройстве"); return { ok: true, local: true }; }
    const saved = await syncDB(session);
    if (saved?.ok === false) {
      showToast(saved.message || "Не удалось сохранить прогноз в БД");
      return saved;
    }
    await loadLeaderboard();
    showToast(`✓ Черновик сохранён в БД (${saved?.group || 0} матчей групп, ${saved?.playoff || 0} плей-офф, ${saved?.bonus || 0} вопросов)`);
    return saved;
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
      {/* ══ ОСНОВНОЕ ПРИЛОЖЕНИЕ ══ */}
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
                {PREDICTIONS_LOCKED ? "📊 Таблица" : (isSubmitted ? "✅ Прогнозы" : "⚽ Прогнозы")}
              </button>
              <button className={`nb${tab === "team" ? " on" : ""}`} onClick={() => setTab("team")}>🤝 Команды</button>
              <button className={`nb${tab === "clubs" ? " on" : ""}`} onClick={() => { setTab("clubs"); setClubsSubTab("home"); }}>🏟 Битва клубов</button>
              {!isGuest && <button className={`nb${tab === "quiz" ? " on" : ""}`} onClick={() => setTab("quiz")}>📅 Квиз</button>}
              <button className={`nb${tab === "howto" ? " on" : ""}`} onClick={() => setTab("howto")}>📖 Как играть</button>
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
                  onChangeName={() => setShowDisplayNameModal(true)}
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
        {isGuest && tab !== "predict" && tab !== "leaderboard" && tab !== "team" && (
          <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 12px 120px" }}>

            {/* ── HERO ── */}
            <div style={{ textAlign: "center", padding: "52px 16px 40px" }}>
              <Logo size="xl" style={{ margin: "0 auto 24px" }} />
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 32, fontWeight: 700, color: "#F0EDE6", lineHeight: 1.15, marginBottom: 14, letterSpacing: 0.5 }}>
                Футбольные прогнозы<br />и клубные битвы на ЧМ 2026
              </div>
              <div style={{ fontSize: 15, color: "rgba(240,237,230,.55)", lineHeight: 1.75, marginBottom: 32, maxWidth: 520, margin: "0 auto 32px" }}>
                Делай прогнозы на матчи, играй в Битве клубов (дуэльный драфт), зарабатывай F-Coins и соревнуйся с друзьями.
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="bp" style={{ padding: "13px 28px", fontSize: 14 }} onClick={() => setTab("predict")}>
                  Заполнить прогноз без регистрации
                </button>
                <button className="sb" style={{ padding: "13px 28px", fontSize: 14 }} onClick={() => setShowAuth(true)}>
                  Войти / зарегистрироваться
                </button>
              </div>
            </div>

            {/* ── КАК ЭТО РАБОТАЕТ ── */}
            <div style={{ marginBottom: 36 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F59E0B", textTransform: "uppercase", letterSpacing: 2.5, textAlign: "center", marginBottom: 20 }}>Как это работает</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {[
                  { n: "1", icon: "📋", t: "Заполни прогноз без регистрации" },
                  { n: "2", icon: "🛒", t: "Участвуй в Битве прогнозистов или создай клуб бесплатно" },
                  { n: "3", icon: "📋", t: "Делай прогнозы и участвуй в Битве клубов" },
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
                { icon: "⚽", name: "Битва клубов", price: "Бесплатно", desc: "Дуэльный драфт тура: тренер + 11 игроков из 60 вариантов. Пары формируются после дедлайна.", color: "#15803d" },
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
                Дуэльный драфт тура: собери <strong style={{ color: "#FDE68A" }}>тренера + 11 игроков</strong> из одинакового для всех списка 60 вариантов (12 позиций × 5 кандидатов). Назначь капитана — он получает ×1.5. После дедлайна формируются пары 1 на 1.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  "тренер + вратарь + 4 защитника + 4 полузащитника + 2 нападающих",
                  "по 5 кандидатов на каждый слот",
                  "капитан получает ×1.5 очков",
                  "тренер не может быть капитаном",
                  "состав до дедлайна 11 июня 22:00 МСК",
                  "соперник назначается после жеребьёвки",
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
                F-Coins — очки активности. Их нельзя вывести в деньги и сейчас нельзя тратить: они используются как тай-брейкер при равенстве очков.
              </div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginTop: 10 }}>
                Как заработать: оплата Полного ЧМ (+500) · победы в Кубке FFC (+50) · проход раундов (+100)
              </div>
            </div>

            {/* ── FAQ ── */}
            <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "20px", marginBottom: 28 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 16 }}>❓ Частые вопросы</div>
              {[
                { q: "Как начисляются очки в Битве прогнозистов?", a: "Групповой матч: 8 — точный счёт; +1 к точному счёту за разгром 3+ и ещё +1 за матч с 5+ голами; 5 — угадан исход и разница; 3 — исход + голы одной команды; 2 — исход; 1 — голы одной команды при другом исходе; 0 — промах. В плей-офф очки за матч умножаются: 1/8 ×1, 1/4 ×2, полуфинал/матч за 3-е/финал ×3." },
                { q: "Что такое F-Coins?", a: "F-Coins — очки активности. Зарабатываешь за ежедневный квиз и участие в играх. Нельзя вывести в деньги. Используются как тай-брейкер: при равенстве основных очков побеждает тот, у кого больше F-Coins." },
                { q: "Можно ли играть бесплатно?", a: "Да. Бесплатно доступна Битва клубов — дуэльный драфт тура: тренер + 11 игроков из 60 вариантов." },
                { q: "Что такое Командный зачёт?", a: "Команда от 2 человек. Рейтинг по среднему баллу участников в Битве прогнозистов. Доступно участникам Битве прогнозистов." },
                { q: "Как работает Битва клубов?", a: "Все участники получают одинаковый драфт: 12 позиций × 5 вариантов = 60 кандидатов. Выбери тренера и 11 игроков, назначь капитана (×1.5). После дедлайна пары формируются 1 на 1." },
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

        {/* ══════════ ВКЛАДКА: ПРОГНОЗЫ / ПУБЛИЧНАЯ ТАБЛИЦА ══════════ */}
        {tab === "predict" && PREDICTIONS_LOCKED && (
          <PublicForecastTable showToast={showToast} onLeaderboardReady={setPublicLeaderboard} />
        )}
        {tab === "predict" && !PREDICTIONS_LOCKED && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div style={{ maxWidth: 900, margin: "0 auto", padding: "14px 12px 140px" }}>

            {/* ── ГОСТЕВОЙ БАННЕР ── */}
            {isGuest && (
              <div style={{ background: "linear-gradient(135deg, rgba(185,28,28,.18), rgba(245,158,11,.10))", border: "1px solid rgba(245,158,11,.35)", borderRadius: 12, padding: "16px 20px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A", marginBottom: 4 }}>
                    📝 Ты заполняешь прогноз без аккаунта
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.6)", lineHeight: 1.5 }}>
                    Прогноз сохраняется только в этом браузере. Войди или зарегистрируйся — и мы перенесём его в аккаунт автоматически.
                  </div>
                </div>
                <button className="bp" style={{ padding: "10px 22px", fontSize: 13, flexShrink: 0 }} onClick={() => setShowAuth(true)}>
                  Войти и сохранить →
                </button>
              </div>
            )}

            {/* СТАТУС */}
            {isSubmitted && (
              <div style={{ background: "rgba(22,163,74,.1)", border: "1px solid rgba(22,163,74,.3)", borderRadius: 10, padding: "16px 20px", marginBottom: 16, textAlign: "center" }}>
                <div style={{ fontSize: 24, marginBottom: 4 }}>✅</div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 700, color: "#86EFAC", marginBottom: 4 }}>Прогноз отмечен как отправленный ✅</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)" }}>Для финальной сверки нажми ниже «Отправить прогноз ещё раз» с этого же устройства.</div>
              </div>
            )}
            {isPending && (
              <div style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A", marginBottom: 4 }}>⏳ Оплата ожидает подтверждения организатором</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", lineHeight: 1.5 }}>После подтверждения прогноз будет зафиксирован. Обычно в течение нескольких часов.</div>
              </div>
            )}
            {!isGuest && (isSubmitted || isPending) && (
              <div style={{ background: "rgba(245,158,11,.10)", border: "1px solid rgba(245,158,11,.35)", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 800, color: "#FDE68A", marginBottom: 6 }}>🔁 Проверка сохранения прогноза</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.60)", lineHeight: 1.45, marginBottom: 10 }}>
                  Мы обновили сохранение прогнозов. Нажми кнопку ниже с того же устройства и браузера, где заполнял форму: данные будут ещё раз отправлены в таблицу.
                </div>
                <button
                  className="sb"
                  onClick={async () => {
                    const saved = await syncDB(session);
                    if (saved?.ok === false) {
                      showToast(saved.message || "Не удалось отправить прогноз в БД");
                      return;
                    }
                    await loadMyData(session);
                    showToast(`✓ Прогноз повторно отправлен в БД (${saved?.group || 0} матчей групп, ${saved?.playoff || 0} плей-офф, ${saved?.bonus || 0} вопросов)`);
                  }}
                  disabled={saving}
                  style={{ marginRight: 8 }}
                >
                  {saving ? "Отправляю…" : "Отправить прогноз ещё раз"}
                </button>
                <button
                  className="sb"
                  onClick={async () => {
                    const payload = {
                      display_name: localStorage.getItem("ffc_guest_display_name") || "",
                      scores: JSON.parse(localStorage.getItem("ffc_guest_scores") || "{}"),
                      playoff_scores: JSON.parse(localStorage.getItem("ffc_guest_playoff_scores") || "{}"),
                      playoff_pens: JSON.parse(localStorage.getItem("ffc_guest_playoff_pens") || "{}"),
                      bonus: JSON.parse(localStorage.getItem("ffc_guest_bonus") || "{}"),
                      user_id: session?.user?.id || null,
                      email: session?.user?.email || null,
                      exported_at: new Date().toISOString(),
                    };
                    const text = JSON.stringify(payload, null, 2);
                    try { await navigator.clipboard.writeText(text); showToast("✓ Копия прогноза скопирована"); }
                    catch { console.log(text); showToast("Не смог скопировать автоматически — данные выведены в консоль"); }
                  }}
                  disabled={saving}
                >
                  Скопировать прогноз
                </button>
              </div>
            )}
            {!tournamentOpen && !GUEST_FORM_OPEN && (
              <div style={{ background: "rgba(185,28,28,.1)", border: "1px solid rgba(185,28,28,.3)", borderRadius: 10, padding: "14px 18px", marginBottom: 16, textAlign: "center" }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FCA5A5" }}>🔒 Дедлайн прошёл. Прогнозы закрыты.</div>
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginTop: 4 }}>Битва прогнозистов · Дедлайн: 11 июня 2026</div>
              </div>
            )}
            {GUEST_FORM_OPEN && !tournamentOpen && (
              <div style={{ background: "rgba(245,158,11,.07)", border: "1px solid rgba(245,158,11,.25)", borderRadius: 10, padding: "10px 18px", marginBottom: 12, textAlign: "center", fontSize: 12, color: "#FDE68A" }}>
                ⚡ Специальный доступ — заполни прогноз и нажми «Отправить прогноз в турнир»
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
                Заполните прогнозы и нажмите «Отправить прогноз в турнир». Участие: 500 ₽ · Приз победителю: 5 000 ₽.
              </div>
            </div>

            {/* КАК НАЧИСЛЯЮТСЯ БАЛЛЫ */}
            <div style={{ background: "linear-gradient(135deg, rgba(245,158,11,.10), rgba(255,255,255,.025))", border: "1px solid rgba(245,158,11,.28)", borderRadius: 12, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 18, fontWeight: 800, color: "#FDE68A", textTransform: "uppercase", letterSpacing: 1 }}>
                  🧮 Как начисляются баллы
                </div>
                <button onClick={() => setTab("howto")} style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", color: "rgba(240,237,230,.75)", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}>
                  Полные правила →
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 8, marginBottom: 10 }}>
                {[
                  ["8", "точный счёт"],
                  ["5", "исход + разница"],
                  ["3", "исход + голы одной команды"],
                  ["2", "угадан исход"],
                  ["1", "голы одной команды, исход другой"],
                  ["+1/+1", "точный счёт: разгром 3+ / 5+ голов"],
                ].map(([pts, text]) => (
                  <div key={pts + text} style={{ background: "rgba(0,0,0,.18)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: "9px 10px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 900, color: "#F59E0B", lineHeight: 1 }}>{pts}</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.58)", marginTop: 3, lineHeight: 1.25 }}>{text}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.58)", lineHeight: 1.55 }}>
                Примеры: точные <strong style={{ color: "#FDE68A" }}>4:1 = 10</strong>, <strong style={{ color: "#FDE68A" }}>3:2 = 9</strong>, <strong style={{ color: "#FDE68A" }}>3:0 = 9</strong>. В плей-офф очки за матч умножаются: 1/8 ×1, 1/4 ×2, полуфинал/матч за 3-е/финал ×3. Бонусные вопросы дают очки, указанные на карточке вопроса.
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
                            <span style={{ fontSize: 9, color: "rgba(240,237,230,.24)", width: 28, flexShrink: 0 }}>№{m.match_no || i + 1}</span>
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

                // Динамические опции из tournament_players (для player-типов)
                const isPlayerType = ["player","player_multi","goalkeeper"].includes(q.answerType);
                const dynOpts = isPlayerType ? getBonusOptions(q) : null;
                const popularOptions = isPlayerType
                  ? (dynOpts?.options || [])
                  : (q.popularOptions || []);
                const optionsWithStats = isPlayerType ? (dynOpts?.optionsWithStats || []) : null;
                const optionsLoading = isPlayerType && (bonusOptionsLoading || dynOpts?.loading);
                const optionsEmpty = isPlayerType && dynOpts?.empty;

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
                          <div style={{ fontSize: "clamp(15px,1vw,18px)", fontWeight: 600, color: "#F0EDE6" }}>{q.text}</div>
                          {q.help && <div style={{ fontSize: "clamp(12px,.8vw,14px)", color: "rgba(240,237,230,.35)", marginTop: 2 }}>{q.help}</div>}
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

                    {/* База игроков не загружена — предупреждение */}
                    {!locked && isPlayerType && optionsEmpty && (
                      <div style={{ fontSize: 11, color: "rgba(240,237,230,.35)", marginTop: 4, fontStyle: "italic" }}>
                        ⚠ База игроков ЧМ ещё не загружена в Supabase. Введите имя вручную →
                      </div>
                    )}

                    {/* Интерактивная часть */}
                    {!locked && (
                      <>
                        {/* PLAYER / GOALKEEPER: кнопки из tournament_players + Другой */}
                        {(q.answerType === "player" || q.answerType === "goalkeeper" || q.answerType === "team") && (
                          <div className="opts">
                            {optionsLoading && isPlayerType && (
                              <span style={{ fontSize: 11, color: "rgba(240,237,230,.3)", padding: "4px 0" }}>Загружаю игроков…</span>
                            )}
                            {/* player-тип: используем optionsWithStats для отображения displayName + счётчика */}
                            {isPlayerType && (optionsWithStats || []).map(({ name, displayName, selectionCount }) => (
                              <button key={name} className={`opt${ans === name ? " on" : ""}`}
                                onClick={() => setBonus(p => ({ ...p, [q.id]: ans === name ? null : name }))}>
                                <div>{displayName || name}</div>
                                {selectionCount > 0 && (
                                  <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginTop: 1 }}>{selectionCount} выборов</div>
                                )}
                              </button>
                            ))}
                            {/* team-тип: старые popularOptions */}
                            {!isPlayerType && (q.popularOptions || []).map(o => (
                              <button key={o} className={`opt${ans === o ? " on" : ""}`}
                                onClick={() => setBonus(p => ({ ...p, [q.id]: ans === o ? null : o }))}>
                                {o}
                              </button>
                            ))}
                            <button className={`opt${ans && !popularOptions.includes(ans) ? " on" : ""}`}
                              onClick={() => setBonusPickerOpen({ qid: q.id, type: q.answerType === "goalkeeper" ? "player" : q.answerType, filterType: q.filterType || "all", popularOptions: popularOptions, slotIdx: null, excludeNames: [] })}>
                              {q.answerType === "team" ? "Другая…" : "Другой…"}
                            </button>
                            {ans && !popularOptions.includes(ans) && (
                              <span style={{ fontSize: 11, color: "#FDE68A", padding: "4px 8px" }}>✎ {displayPlayerName(ans)}</span>
                            )}
                          </div>
                        )}

                        {/* PLAYER_MULTI: count слотов, каждый с кнопками из tournament_players */}
                        {q.answerType === "player_multi" && (
                          <div>
                            {Array.from({length: q.count}).map((_, si) => {
                              const curArr = Array.isArray(ans) ? ans : [];
                              const slotVal = curArr[si] || null;
                              return (
                                <div key={si} style={{ marginBottom: 6 }}>
                                  <div style={{ fontSize: 10, color: "rgba(240,237,230,.35)", marginBottom: 4 }}>Игрок {si+1}{slotVal ? `: ${displayPlayerName(slotVal)}` : ""}</div>
                                  <div className="opts">
                                    {optionsLoading && si === 0 && (
                                      <span style={{ fontSize: 11, color: "rgba(240,237,230,.3)", padding: "4px 0" }}>Загружаю…</span>
                                    )}
                            {(optionsWithStats || []).map(({ name, displayName }) => {
                                      const isInOther = curArr.some((v,vi) => v === name && vi !== si);
                                      if (isInOther) return null;
                                      return (
                                        <button key={name} className={`opt${slotVal === name ? " on" : ""}`}
                                          onClick={() => {
                                            const next = [...curArr];
                                            while (next.length < q.count) next.push(null);
                                            next[si] = slotVal === name ? null : name;
                                            setBonus(p => ({ ...p, [q.id]: next }));
                                          }}>
                                          {displayName || name}
                                        </button>
                                      );
                                    })}
                                    <button className="opt"
                                      onClick={() => setBonusPickerOpen({ qid: q.id, type: "player", filterType: q.filterType || "all", popularOptions: popularOptions, slotIdx: si, excludeNames: (Array.isArray(ans) ? ans.filter((v,vi) => vi !== si && v) : []) })}>
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
            {bonusPickerOpen && (bonusPickerOpen.type === "player" || bonusPickerOpen.type === "goalkeeper") && (
              <PlayerSearchModal
                source="tournament_players"
                filterType={bonusPickerOpen.filterType || "all"}
                popularOptions={bonusPickerOpen.popularOptions || []}
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
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 20, fontWeight: 700, color: "#86EFAC", marginBottom: 6 }}>Прогноз отмечен как отправленный ✅</div>
                  <div style={{ fontSize: 13, color: "rgba(240,237,230,.5)" }}>Для финальной сверки нажми ниже «Отправить прогноз ещё раз» с этого же устройства.</div>
                  {formDisplayNameTrimmed && <div style={{ marginTop: 8, fontSize: 12, color: "rgba(240,237,230,.45)" }}>Форма подписана как: <strong style={{ color: "#F0EDE6" }}>{formDisplayNameTrimmed}</strong></div>}
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
                  <div style={{ margin: "14px auto 16px", maxWidth: 520, textAlign: "left", background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.18)", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 16, fontWeight: 700, color: "#FDE68A", marginBottom: 6 }}>✏️ Как подписать вашу форму?</div>
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", lineHeight: 1.45, marginBottom: 10 }}>
                      Это имя увидят в таблицах и результатах. Email публично не показывается.
                    </div>
                    <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
                      <input
                        className="inp"
                        value={formDisplayName}
                        onChange={e => { setFormDisplayName(e.target.value); setDisplayNameError(""); }}
                        placeholder="Например: Андрей П., Mozgokvest, Семья Ивановых"
                        maxLength={40}
                        style={{ flex: "1 1 260px" }}
                      />
                      <button
                        className="mini-btn"
                        disabled={displayNameSaving}
                        onClick={async () => { await saveDisplayNameFromForm(); }}
                        style={{ flex: "0 0 auto", padding: "10px 16px", borderColor: "rgba(134,239,172,.35)", color: "#86EFAC" }}
                      >
                        {displayNameSaving ? "Сохраняю..." : "Сохранить имя"}
                      </button>
                    </div>
                    {displayNameError && <div style={{ marginTop: 8, fontSize: 12, color: "#FCA5A5" }}>⚠ {displayNameError}</div>}
                    {formDisplayNameValid && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "#86EFAC" }}>
                        ✓ Имя введено: <strong>{formDisplayNameTrimmed}</strong>. Сохранится при отправке
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 16, lineHeight: 1.5 }}>
                    Прогнозы сохранены! После нажатия «Отправить» — состав зафиксируется и начнётся оформление оплаты.<br />
                    После отправки прогноз изменить нельзя.
                  </div>
                  <button
                    className="bp"
                    style={{ padding: "13px 32px", fontSize: 15, opacity: allReady && formDisplayNameValid ? 1 : 0.5, cursor: allReady && formDisplayNameValid ? "pointer" : "default", width: "100%", maxWidth: 360 }}
                    onClick={async () => {
                      if (!allReady) return;
                      if (!formDisplayNameValid) {
                        const msg = validateFormDisplayName(formDisplayName);
                        setDisplayNameError(msg);
                        showToast(msg);
                        return;
                      }
                      if (isGuest) {
                        localStorage.setItem("ffc_guest_display_name", formDisplayNameTrimmed);
                        setPendingPlanAfterAuth(PLANS[0]);
                        setShowAuth(true);
                        return;
                      }
                      const nameSaved = await saveDisplayNameFromForm({ silent: true });
                      if (!nameSaved) return;
                      await save();
                      setShowPayment(PLANS[0]);
                    }}>
                    Отправить прогноз в турнир
                  </button>
                  {(!allReady || !formDisplayNameValid) && <div style={{ marginTop: 8, fontSize: 10, color: "rgba(240,237,230,.25)" }}>Заполни все разделы и имя формы, чтобы отправить</div>}
                </>
              )}
            </div>

            {/* ТИЗЕР: ЕЖЕДНЕВНЫЙ КВИЗ */}
            {!isGuest && (
              <div className="main" style={{ marginTop: 8 }}>
                <button
                  onClick={() => setTab("quiz")}
                  style={{ width: "100%", background: "rgba(29,78,216,.07)", border: "1px solid rgba(29,78,216,.2)", borderRadius: 10, padding: "12px 16px", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span style={{ fontSize: 22 }}>⚽</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 13, fontWeight: 700, color: "#93C5FD" }}>Ежедневный футбольный квиз</div>
                    <div style={{ fontSize: 11, color: "rgba(240,237,230,.45)", marginTop: 2 }}>10 вопросов · до 25 F-Coins · каждый день</div>
                  </div>
                  <span style={{ fontSize: 11, color: "#93C5FD", flexShrink: 0 }}>Играть →</span>
                </button>
              </div>
            )}

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

          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: ЕЖЕДНЕВНЫЙ КВИЗ ══════════ */}
        {tab === "quiz" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div className="main">
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#F0EDE6", marginBottom: 4 }}>📅 Ежедневный футбольный квиз</div>
              <div style={{ fontSize: 12, color: "rgba(240,237,230,.45)", lineHeight: 1.5 }}>
                Каждый день 10 новых вопросов о футболе. Зарабатывай F-Coins — бесплатно.
              </div>
            </div>
            <DailyQuizBlock session={session} showToast={showToast} />
          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: КОМАНДНЫЙ ЗАЧЁТ ══════════ */}
        {tab === "team" && (
          <ErrorBoundary isAdmin={isAdmin}>
            <PublicTeamStandings leaderboard={publicLeaderboard} />
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: КАК ИГРАТЬ ══════════ */}
        {tab === "howto" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div className="main">
            <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 24, fontWeight: 700, color: "#F0EDE6", marginBottom: 20 }}>📖 Как играть</div>
            {[
              { title: "A. Битва прогнозистов — платно (500 ₽)", icon: "🏆", items: [
                "Главный турнир. Делаешь прогнозы на все матчи ЧМ-2026: кто победит, с каким счётом.",
                "Баллы за матч: 8 — точный счёт; 5 — исход + разница; 3 — исход + голы одной команды; 2 — исход; 1 — голы одной команды при другом исходе; 0 — промах.",
                "Бонусы к точному счёту: +1 за разгром с разницей 3+ и +1 за матч с 5+ голами. Например, 4:1 = 10, 3:2 = 9, 3:0 = 9.",
                "Плей-офф: очки за матч умножаются — 1/8 ×1, 1/4 ×2, полуфинал/матч за 3-е/финал ×3.",
                "Бонусные вопросы: лучший бомбардир, MVP, молодой игрок и т.д. — очки указаны на карточке вопроса.",
                "Общая таблица прогнозистов. Командный зачёт.",
                "Участие: 500 ₽ переводом на карту по номеру 8 911 823-15-76 (Сбер / Т-Банк).",
                "После оплаты отправьте скрин в поддержку: vk.com/panteleewintop",
              ]},
              { title: "B. Битва клубов — бесплатно", icon: "⚽", items: [
                "Дуэльный драфт тура. Все участники получают одинаковый список: 12 слотов по 5 вариантов = 60 кандидатов.",
                "Выбери тренера + 11 игроков: вратарь, 4 защитника, 4 полузащитника, 2 нападающих.",
                "Назначь капитана из полевых игроков — он получает ×1.5 очков. Тренер не может быть капитаном.",
                "Состав нужно отправить до дедлайна: 11 июня 22:00 МСК.",
                "После дедлайна формируются пары 1 на 1. Кто набрал больше очков — побеждает.",
                "При ничьей по очкам победитель определяется по количеству F-Coins (тай-брейкер).",
                "ВРАТАРЬ: +2 старт · +6 сухой матч · +3 победа · +8 пенальти отбит · −1 каждый пропущенный.",
                "ЗАЩИТНИК: +2 старт · +5 сухой матч · +8 гол · +5 ассист · +2 победа · −1 жёлтая.",
                "ПОЛУЗАЩИТНИК: +2 старт · +6 гол · +5 ассист · +2 победа · −1 жёлтая.",
                "НАПАДАЮЩИЙ: +2 старт · +5 гол · +4 ассист · −3 незабитый пенальти · −1 жёлтая.",
                "ТРЕНЕР: +5 победа · +2 ничья · +2 если команда забила 3+ · −2 за красную.",
              ]},
              { title: "C. Ежедневный квиз", icon: "📅", items: [
                "Каждый день 10 вопросов о футболе. Бесплатно.",
                "За каждый правильный ответ +2 F-Coins, за 10/10 +5 бонусных. Максимум 25 F-Coins в день.",
                "Пройти можно один раз в день по МСК.",
                "F-Coins используются как тай-брейкер при равенстве очков.",
              ]},
              { title: "D. F-Coins — очки активности", icon: "🪙", items: [
                "F-Coins — очки активности. Их нельзя вывести в деньги и сейчас нельзя тратить.",
                "Зарабатываются: ежедневный квиз (до 25/день) · приглашённый друг оплатил (+100 F-Coins).",
                "При равенстве основных очков выше тот, у кого больше F-Coins (тай-брейкер).",
                "В Битве клубов: при ничьей 1 на 1 победитель определяется по F-Coins.",
                "В будущем — косметические бонусы: бейдж, рамка профиля, титул.",
              ]},
              { title: "E. Рефералка", icon: "👥", items: [
                "У каждого пользователя есть реферальная ссылка. Найти её можно в разделе F-Coins.",
                "Поделитесь ссылкой с другом.",
                "Если друг зарегистрируется и оплатит главный турнир — вы получите +100 F-Coins.",
                "Награда начисляется один раз за каждого оплатившего друга.",
              ]},
              { title: "F. Оплата", icon: "💳", items: [
                "Участие в главном турнире (Битва прогнозистов): 500 ₽.",
                "Перевод на карту, привязанную к номеру: 8 911 823-15-76",
                "Банк: Сбер или Т-Банк.",
                "После перевода отправьте подтверждение/скрин в поддержку: vk.com/panteleewintop",
                "Битва клубов — бесплатная для всех пользователей.",
              ]},
              { title: "G. Сообщество и поддержка", icon: "💬", items: [
                "Telegram-сообщество: t.me/ffc_cup",
                "По всем вопросам: vk.com/panteleewintop",
                "Для входа используйте Google или email + пароль. Если не получается войти — напишите в поддержку.",
              ]},
            ].map((section, si) => (
              <div key={si} style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#F0EDE6", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{section.icon}</span>{section.title}
                </div>
                {section.items.map((item, ii) => (
                  <div key={ii} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: "clamp(13px,.9vw,16px)", color: "rgba(240,237,230,.65)", lineHeight: 1.55 }}>
                    <span style={{ color: "#F59E0B", flexShrink: 0 }}>›</span>
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          </ErrorBoundary>
        )}

        {/* ══════════ ВКЛАДКА: КЛУБНЫЕ БИТВЫ ══════════ */}
        {tab === "clubs" && (
          <ErrorBoundary isAdmin={isAdmin}>
          <div className="main">

            {/* Битва клубов: после дедлайна показываем только публичные составы */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20, overflowX: "auto", borderBottom: "1px solid rgba(255,255,255,.07)", paddingBottom: 12, scrollbarWidth: "none" }}>
              <button
                onClick={() => setClubsSubTab("home")}
                style={{ background: "rgba(29,78,216,.3)", border: "1px solid rgba(29,78,216,.6)", color: "#93C5FD", fontFamily: "Barlow Condensed,sans-serif", fontSize: 12, fontWeight: 700, padding: "6px 12px", borderRadius: 5, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
              >
                📋 Все составы
              </button>
            </div>

            {/* ── ВСЕ СОСТАВЫ БИТВЫ КЛУБОВ ── */}
            {clubsSubTab === "home" && (
              <div>
                <div style={{ textAlign: "center", marginBottom: 18 }}>
                  <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(24px,3vw,42px)", fontWeight: 800, color: "#FDE68A", textTransform: "uppercase", letterSpacing: ".03em" }}>
                    ⚽ Битва клубов · Все составы
                  </div>
                  <div style={{ color: "rgba(240,237,230,.45)", fontSize: 13, marginTop: 6 }}>
                    Опубликованные составы участников 1-го тура: тренер + 11 позиций. Очки по каждому игроку можно будет проставить отдельно.
                  </div>
                </div>
                <PublicLineupsBlock />
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
              <FfcDraftView
                session={session}
                showToast={showToast}
                activeRound={activeRound}
                setSession={setSession}
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
              <div style={{ padding: "32px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: "clamp(18px,1.4vw,24px)", fontWeight: 700, color: "#F0EDE6", marginBottom: 8 }}>
                  Таблица клубов
                </div>
                <div style={{ fontSize: "clamp(13px,.9vw,16px)", color: "rgba(240,237,230,.45)", lineHeight: 1.6, maxWidth: 400, margin: "0 auto" }}>
                  Таблица появится после старта турнира и первых результатов матчей.<br/>
                  Пока отправь состав в «Составе» — ты уже будешь в таблице после жеребьёвки пар.
                </div>
                <button className="sb" style={{ marginTop: 16 }} onClick={() => setClubsSubTab("lineup")}>
                  → Перейти к составу
                </button>
              </div>
            )}

            {/* ── F-COINS: ТОЛЬКО ПОКАЗАТЕЛЬ АКТИВНОСТИ, НЕ МАГАЗИН ── */}
            {clubsSubTab === "shop" && (
              <div style={{ background: "rgba(245,158,11,.06)", border: "1px solid rgba(245,158,11,.18)", borderRadius: 12, padding: "20px 18px" }}>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 22, fontWeight: 700, color: "#FDE68A", marginBottom: 8 }}>🪙 F-Coins</div>
                <div style={{ fontSize: 14, color: "rgba(240,237,230,.65)", lineHeight: 1.6, marginBottom: 12 }}>
                  F-Coins сейчас нельзя тратить. Это показатель активности и тай-брейкер при равенстве очков в Битве клубов и рейтингах.
                </div>
                <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 28, fontWeight: 800, color: "#F59E0B", marginBottom: 12 }}>
                  {profile?.fcoins_balance || 0} F-Coins
                </div>
                <div style={{ fontSize: 13, color: "rgba(240,237,230,.45)", lineHeight: 1.7 }}>
                  Получай F-Coins за ежедневный квиз и приглашённых друзей. Магазин, скамейка, скаут, замены и скрытие состава отключены, чтобы не давать игровых преимуществ.
                </div>
                {session?.user?.id && (
                  <div style={{ marginTop: 14, background: "rgba(147,197,253,.06)", border: "1px solid rgba(147,197,253,.18)", borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontFamily: "Oswald,sans-serif", fontSize: 15, fontWeight: 700, color: "#BFDBFE", marginBottom: 6 }}>🔗 Реферальная ссылка</div>
                    <div style={{ fontSize: 12, color: "rgba(240,237,230,.5)", marginBottom: 8 }}>Друг оплатил главный турнир → тебе +100 F-Coins</div>
                    <input readOnly value={`${window.location.origin}/?ref=${profile?.referral_code || session.user.id}`} onFocus={(e) => e.target.select()} style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,.25)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 6, padding: "9px 10px", color: "#F0EDE6", fontSize: 12 }} />
                    <button className="sb" style={{ marginTop: 8, fontSize: 11 }} onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/?ref=${profile?.referral_code || session.user.id}`); showToast("✓ Реферальная ссылка скопирована"); }}>
                      Скопировать ссылку
                    </button>
                  </div>
                )}
                <button className="bp" style={{ marginTop: 14, background: "#16A34A" }} onClick={() => setTab("quiz")}>
                  ⚽ Играть в квиз
                </button>
              </div>
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
                    "Битва клубов — дуэльный драфт тура. Не нужно выбирать из сотен игроков.",
                    "Все участники получают одинаковый драфт: 12 слотов по 5 вариантов = 60 кандидатов.",
                    "Выбери тренера + 11 игроков: вратарь, 4 защитника, 4 полузащитника, 2 нападающих.",
                    "Назначь капитана из полевых игроков — он получает ×1.5 очков. Тренер не может быть капитаном.",
                    "Состав нужно отправить до дедлайна: 11 июня 22:00 МСК.",
                    "После дедлайна формируются пары 1 на 1. Кто набрал больше очков — побеждает.",
                    "Соперник назначается только после жеребьёвки. До тех пор — просто отправь состав.",
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
                    "F-Coins — очки активности. Их нельзя вывести в деньги и сейчас нельзя тратить.",
                    "Получай F-Coins за ежедневный квиз и приглашённых друзей.",
                    "При равенстве очков F-Coins используются как тай-брейкер. Магазина игровых преимуществ нет.",
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
                      <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: "clamp(13px,.9vw,16px)", color: "rgba(240,237,230,.6)", lineHeight: 1.5 }}>
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
                <div style={{ fontSize: 12, color: "rgba(240,237,230,.4)", marginBottom: 14, lineHeight: 1.5 }}>Прогнозы готовы — нажмите «Отправить», чтобы попасть в таблицу и побороться за приз 5 000 ₽.</div>
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
              setSession={setSession}
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

        {showDisplayNameModal && session && (
          <DisplayNameModal
            profile={profile}
            session={session}
            onSave={async (newName) => {
              setShowDisplayNameModal(false);
              // Обновить локальный state немедленно
              setProfile(p => ({ ...p, display_name: newName, name: newName }));
              showToast(`✓ Имя сохранено. Форма будет подписана как: ${newName}`);
              // Перечитать профиль из Supabase для гарантии синхронизации
              if (session?.access_token && session?.user?.id) {
                try {
                  const pr = await supa(`profiles?id=eq.${session.user.id}&select=*`, { token: session.access_token });
                  if (pr.ok) {
                    const d = await pr.json();
                    if (d[0]) setProfile(d[0]);
                  }
                } catch {}
              }
            }}
            onSkip={() => setShowDisplayNameModal(false)}
          />
        )}
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
