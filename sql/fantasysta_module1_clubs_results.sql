-- ============================================================================
-- FANTASYСТА — Модуль 1. Справочники и админка результатов
-- Vite (React) + Supabase + Tailwind
-- Выполнять целиком в Supabase SQL Editor. Скрипт идемпотентен (можно
-- запускать повторно): использует IF NOT EXISTS / DROP ... IF EXISTS.
-- ============================================================================


-- ============================================================================
-- ШАГ 1. ТАБЛИЦЫ И ТИПЫ ДАННЫХ
-- ============================================================================

-- Тир стоимости клуба. Цена жёстко привязана к тиру (см. CHECK на clubs.price).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'club_tier') THEN
    CREATE TYPE club_tier AS ENUM ('Tier 1', 'Tier 2', 'Tier 3', 'Tier 4');
  END IF;
END $$;

-- Справочник реальных клубов.
CREATE TABLE IF NOT EXISTS public.clubs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  league     TEXT NOT NULL,               -- EPL, LaLiga, SerieA, Bundesliga, Ligue1
  tier       club_tier NOT NULL,
  price      INTEGER NOT NULL,
  logo_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Цена жёстко определяется тиром — никакое другое значение не пройдёт.
  CONSTRAINT clubs_price_matches_tier CHECK (
    (tier = 'Tier 1' AND price = 35000000) OR
    (tier = 'Tier 2' AND price = 25000000) OR
    (tier = 'Tier 3' AND price = 15000000) OR
    (tier = 'Tier 4' AND price = 10000000)
  )
);

-- Игровые туры. id — это номер тура (1, 2, 3...), выставляется вручную админом.
CREATE TABLE IF NOT EXISTS public.gameweeks (
  id                INTEGER PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'upcoming'
                     CHECK (status IN ('upcoming', 'active', 'completed')),
  transfer_deadline TIMESTAMPTZ NOT NULL,
  started_at        TIMESTAMPTZ,
  is_eurocup_week   BOOLEAN NOT NULL DEFAULT false
);

-- Результаты клубов по турам. total_points считается триггером (см. Шаг 2).
CREATE TABLE IF NOT EXISTS public.club_results (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gameweek_id   INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  club_id       UUID NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  is_win        BOOLEAN NOT NULL DEFAULT false,
  is_draw       BOOLEAN NOT NULL DEFAULT false,
  goals_scored  INTEGER NOT NULL DEFAULT 0,
  clean_sheet   BOOLEAN NOT NULL DEFAULT false,
  total_points  INTEGER NOT NULL DEFAULT 0
);

-- Один клуб — не больше одной записи результата на тур.
CREATE UNIQUE INDEX IF NOT EXISTS club_results_gameweek_club_uniq
  ON public.club_results (gameweek_id, club_id);


-- ============================================================================
-- ШАГ 2. АВТОМАТИЧЕСКИЙ ПЕРЕСЧЁТ ОЧКОВ (PL/pgSQL ТРИГГЕР)
-- ============================================================================
-- Правила: победа = 3, ничья = 1, гол = 1 (за каждый), сухой матч = 2.

CREATE OR REPLACE FUNCTION public.calculate_club_result_points()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.total_points :=
      (CASE WHEN NEW.is_win THEN 3 ELSE 0 END)
    + (CASE WHEN NEW.is_draw THEN 1 ELSE 0 END)
    + (COALESCE(NEW.goals_scored, 0) * 1)
    + (CASE WHEN NEW.clean_sheet THEN 2 ELSE 0 END);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_calculate_club_result_points ON public.club_results;
CREATE TRIGGER trg_calculate_club_result_points
  BEFORE INSERT OR UPDATE ON public.club_results
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_club_result_points();


-- ============================================================================
-- ШАГ 3. БЕЗОПАСНОСТЬ И ROW LEVEL SECURITY (RLS)
-- ============================================================================
-- ⚠️ ЗАМЕНИ 'YOUR_EMAIL@example.com' НА СВОЙ РЕАЛЬНЫЙ EMAIL АДМИНА ⚠️

ALTER TABLE public.clubs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gameweeks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_results ENABLE ROW LEVEL SECURITY;

-- Чтение справочников открыто всем — и авторизованным, и анонимам.
DROP POLICY IF EXISTS clubs_public_select ON public.clubs;
CREATE POLICY clubs_public_select ON public.clubs
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS gameweeks_public_select ON public.gameweeks;
CREATE POLICY gameweeks_public_select ON public.gameweeks
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS club_results_public_select ON public.club_results;
CREATE POLICY club_results_public_select ON public.club_results
  FOR SELECT TO public USING (true);

-- Изменение данных — только админ (по email из JWT).
DROP POLICY IF EXISTS clubs_admin_insert ON public.clubs;
CREATE POLICY clubs_admin_insert ON public.clubs
  FOR INSERT TO authenticated
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS clubs_admin_update ON public.clubs;
CREATE POLICY clubs_admin_update ON public.clubs
  FOR UPDATE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS clubs_admin_delete ON public.clubs;
CREATE POLICY clubs_admin_delete ON public.clubs
  FOR DELETE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS gameweeks_admin_insert ON public.gameweeks;
CREATE POLICY gameweeks_admin_insert ON public.gameweeks
  FOR INSERT TO authenticated
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS gameweeks_admin_update ON public.gameweeks;
CREATE POLICY gameweeks_admin_update ON public.gameweeks
  FOR UPDATE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS gameweeks_admin_delete ON public.gameweeks;
CREATE POLICY gameweeks_admin_delete ON public.gameweeks
  FOR DELETE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS club_results_admin_insert ON public.club_results;
CREATE POLICY club_results_admin_insert ON public.club_results
  FOR INSERT TO authenticated
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS club_results_admin_update ON public.club_results;
CREATE POLICY club_results_admin_update ON public.club_results
  FOR UPDATE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com')
  WITH CHECK (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

DROP POLICY IF EXISTS club_results_admin_delete ON public.club_results;
CREATE POLICY club_results_admin_delete ON public.club_results
  FOR DELETE TO authenticated
  USING (auth.jwt() ->> 'email' = 'YOUR_EMAIL@example.com');

GRANT SELECT ON public.clubs, public.gameweeks, public.club_results TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.clubs, public.gameweeks, public.club_results TO authenticated;


-- ============================================================================
-- ШАГ 4. ТЕСТОВЫЕ ДАННЫЕ (SEED)
-- ============================================================================

-- 4 клуба — по одному на каждый тир, с ценой, жёстко соответствующей тиру.
INSERT INTO public.clubs (name, league, tier, price) VALUES
  ('Реал Мадрид',      'LaLiga',     'Tier 1', 35000000),
  ('Ливерпуль',        'EPL',        'Tier 2', 25000000),
  ('Ювентус',          'SerieA',     'Tier 3', 15000000),
  ('Байер Леверкузен', 'Bundesliga', 'Tier 4', 10000000)
ON CONFLICT (name) DO NOTHING;

-- Тур №1, дедлайн трансферов — через 7 дней от момента запуска скрипта.
INSERT INTO public.gameweeks (id, status, transfer_deadline, is_eurocup_week) VALUES
  (1, 'upcoming', now() + interval '7 days', false)
ON CONFLICT (id) DO NOTHING;

-- Проверка триггера: победа 2:0 на сухих воротах у Реала в 1-м туре.
-- Ожидаемый total_points = 3 (победа) + 2 (голы) + 2 (сухой матч) = 7.
INSERT INTO public.club_results (gameweek_id, club_id, is_win, is_draw, goals_scored, clean_sheet)
SELECT 1, id, true, false, 2, true
FROM public.clubs
WHERE name = 'Реал Мадрид'
ON CONFLICT (gameweek_id, club_id) DO NOTHING;

-- Быстрая проверка (должно вернуть total_points = 7):
-- SELECT c.name, r.total_points FROM public.club_results r
-- JOIN public.clubs c ON c.id = r.club_id WHERE r.gameweek_id = 1;

NOTIFY pgrst, 'reload schema';
