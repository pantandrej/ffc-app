-- ============================================================================
-- FANTASYСТА — Модуль 2. Полная архитектура БД + Seed 96 клубов (сезон 2026/2027)
-- Vite (React) + Supabase (PostgreSQL) + Tailwind
--
-- ⚠️ ВАЖНО ПРО КОЛЛИЗИЮ С profiles ⚠️
-- В этом Supabase-проекте уже живёт таблица public.profiles от старого
-- ЧМ-прогнозиста (id, name, display_name, email, prediction_status, role...)
-- с реальными пользователями всего турнира. Она НЕСОВМЕСТИМА со схемой
-- profiles(id, username, avatar_url), которую просило исходное ТЗ — поэтому
-- вместо profiles здесь заведена ОТДЕЛЬНАЯ таблица fantasysta_profiles,
-- никак не пересекающаяся со старой системой. Обе таблицы ссылаются на
-- auth.users(id) независимо друг от друга.
--
-- Скрипт идемпотентен — можно запускать повторно (IF NOT EXISTS / DROP ... IF EXISTS).
-- Выполнять целиком в Supabase SQL Editor.
-- ============================================================================


-- ============================================================================
-- ШАГ 1. ENUM'ы и справочники (clubs, gameweeks)
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'club_tier') THEN
    CREATE TYPE club_tier AS ENUM ('Tier 1', 'Tier 2', 'Tier 3', 'Tier 4');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'league_type') THEN
    CREATE TYPE league_type AS ENUM ('free', 'superleague');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gameweek_status') THEN
    CREATE TYPE gameweek_status AS ENUM ('upcoming', 'active', 'completed');
  END IF;
END $$;

-- Справочник реальных клубов. price заполняется триггером (Шаг 4.1), не руками.
CREATE TABLE IF NOT EXISTS public.clubs (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name     TEXT NOT NULL UNIQUE,
  league   TEXT NOT NULL,                 -- 'EPL' | 'LaLiga' | 'SerieA' | 'Bundesliga' | 'Ligue1'
  tier     club_tier NOT NULL,
  price    BIGINT NOT NULL DEFAULT 0,
  logo_url TEXT
);

-- Апгрейд с Модуля 1 (там price был integer с CHECK вместо триггера) — безопасно,
-- если Модуль 1 не запускался, эти команды просто ничего не найдут и промолчат.
ALTER TABLE public.clubs ALTER COLUMN price TYPE BIGINT;
ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_price_matches_tier;

-- Игровые туры. id — номер тура (1, 2, 3...), выставляется вручную админом.
CREATE TABLE IF NOT EXISTS public.gameweeks (
  id                INTEGER PRIMARY KEY,
  status            gameweek_status NOT NULL DEFAULT 'upcoming',
  transfer_deadline TIMESTAMPTZ NOT NULL,
  started_at        TIMESTAMPTZ,
  is_eurocup_week   BOOLEAN NOT NULL DEFAULT false
);

-- Апгрейд с Модуля 1 (там status был text + CHECK) — если колонка уже text, переводим в enum.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gameweeks'
      AND column_name = 'status' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.gameweeks ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.gameweeks ALTER COLUMN status TYPE gameweek_status USING status::gameweek_status;
    ALTER TABLE public.gameweeks ALTER COLUMN status SET DEFAULT 'upcoming';
  END IF;
END $$;


-- ============================================================================
-- ШАГ 2. Пользователи, команды и участники
-- ============================================================================

-- Профили именно фэнтези-игроков — отдельно от profiles старого прогнозиста (см. шапку файла).
CREATE TABLE IF NOT EXISTS public.fantasysta_profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username   TEXT NOT NULL UNIQUE,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Фэнтези-команды (слоты). Оплата — 1000 ₽/мес или 2000 ₽/сезон, за слот, а не за игрока.
CREATE TABLE IF NOT EXISTS public.teams (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE,
  league             league_type NOT NULL DEFAULT 'free',
  is_paid            BOOLEAN NOT NULL DEFAULT false,
  subscription_until TIMESTAMPTZ,
  created_by         UUID REFERENCES public.fantasysta_profiles(id)
);

-- Состав команды — от 1 до 3 человек. Верхнюю границу (3) контролирует триггер ниже.
CREATE TABLE IF NOT EXISTS public.team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES public.fantasysta_profiles(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS team_members_team_profile_uniq
  ON public.team_members (team_id, profile_id);


-- ============================================================================
-- ШАГ 3. Пулы клубов, трансферы и результаты
-- ============================================================================

-- Пул из 5 клубов команды на конкретный тур.
CREATE TABLE IF NOT EXISTS public.team_pools (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  gameweek_id     INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  club_ids        UUID[] NOT NULL,
  captain_club_id UUID NOT NULL,
  bank_balance    BIGINT NOT NULL DEFAULT 100000000,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_pools_team_gameweek_uniq
  ON public.team_pools (team_id, gameweek_id);

-- Лог трансферов — используется триггером ниже, чтобы считать лимит замен за тур.
CREATE TABLE IF NOT EXISTS public.transfers_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  gameweek_id  INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  club_out_id  UUID REFERENCES public.clubs(id),
  club_in_id   UUID REFERENCES public.clubs(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Результаты реальных клубов за тур (то же самое, что было в Модуле 1).
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
CREATE UNIQUE INDEX IF NOT EXISTS club_results_gameweek_club_uniq
  ON public.club_results (gameweek_id, club_id);

-- Итоговые очки фэнтези-команд за тур. Заполняется автоматически (Шаг 4.6), руками не трогаем.
CREATE TABLE IF NOT EXISTS public.team_results (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  gameweek_id INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  points      NUMERIC(5,2) NOT NULL DEFAULT 0.00
);
CREATE UNIQUE INDEX IF NOT EXISTS team_results_team_gameweek_uniq
  ON public.team_results (team_id, gameweek_id);


-- ============================================================================
-- ШАГ 4. Триггеры бизнес-логики (PL/pgSQL)
-- ============================================================================

-- 4.1 Автозаполнение цены клуба по тиру.
CREATE OR REPLACE FUNCTION public.set_club_price()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.price := CASE NEW.tier
    WHEN 'Tier 1' THEN 35000000
    WHEN 'Tier 2' THEN 25000000
    WHEN 'Tier 3' THEN 15000000
    WHEN 'Tier 4' THEN 10000000
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_club_price ON public.clubs;
CREATE TRIGGER trg_set_club_price
  BEFORE INSERT OR UPDATE ON public.clubs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_club_price();

-- 4.2 Очки реального клуба за тур: победа=3, ничья=1, гол=1 (за каждый), сухой матч=2.
CREATE OR REPLACE FUNCTION public.calculate_club_result_points()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

-- 4.3 Жёсткая валидация пула: ровно 5 клубов, капитан внутри пула, бюджет ≤ 100 млн.
--     Заодно запрещаем повторы клуба в одном пуле (иначе можно купить один
--     дешёвый клуб пять раз) — этого явно не было в ТЗ, но без этой проверки
--     правило "5 РАЗНЫХ реальных клубов" по факту не работает.
CREATE OR REPLACE FUNCTION public.validate_team_pool()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  total_cost BIGINT;
BEGIN
  IF cardinality(NEW.club_ids) <> 5 THEN
    RAISE EXCEPTION 'Пул команды должен содержать ровно 5 клубов, передано: %', cardinality(NEW.club_ids);
  END IF;

  IF cardinality(NEW.club_ids) <> (SELECT COUNT(DISTINCT x) FROM unnest(NEW.club_ids) AS x) THEN
    RAISE EXCEPTION 'В пуле не может быть повторяющихся клубов';
  END IF;

  IF NOT (NEW.captain_club_id = ANY (NEW.club_ids)) THEN
    RAISE EXCEPTION 'Клуб-капитан должен входить в состав пула (club_ids)';
  END IF;

  SELECT COALESCE(SUM(price), 0) INTO total_cost
  FROM public.clubs
  WHERE id = ANY (NEW.club_ids);

  NEW.bank_balance := 100000000 - total_cost;

  IF NEW.bank_balance < 0 THEN
    RAISE EXCEPTION 'Бюджет превышен: стоимость пула % € больше лимита 100 000 000 €', total_cost;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_team_pool ON public.team_pools;
CREATE TRIGGER trg_validate_team_pool
  BEFORE INSERT OR UPDATE ON public.team_pools
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_team_pool();

-- 4.4 Лимит на строго 1 бесплатную замену за тур.
CREATE OR REPLACE FUNCTION public.enforce_one_transfer_per_gameweek()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count
  FROM public.transfers_log
  WHERE team_id = NEW.team_id AND gameweek_id = NEW.gameweek_id;

  IF existing_count >= 1 THEN
    RAISE EXCEPTION 'Разрешена только 1 бесплатная замена за тур!';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_one_transfer_per_gameweek ON public.transfers_log;
CREATE TRIGGER trg_enforce_one_transfer_per_gameweek
  BEFORE INSERT ON public.transfers_log
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_one_transfer_per_gameweek();

-- 4.5 Лимит на состав команды: от 1 до 3 человек. Этого триггера не было в
--     списке из 5 обязательных, но правило "1–3 человека" — часть игровых
--     правил, а без проверки в БД в команду можно было бы набрать сколько угодно.
CREATE OR REPLACE FUNCTION public.enforce_team_member_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  member_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO member_count
  FROM public.team_members
  WHERE team_id = NEW.team_id;

  IF member_count >= 3 THEN
    RAISE EXCEPTION 'В команде не может быть больше 3 человек';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_team_member_limit ON public.team_members;
CREATE TRIGGER trg_enforce_team_member_limit
  BEFORE INSERT ON public.team_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_team_member_limit();

-- 4.6 Автопересчёт очков фэнтези-команд при изменении результата реального клуба.
--     Находит все пулы этого тура, где встречается изменившийся клуб, и для
--     каждого пересчитывает сумму по всем пяти клубам (капитан — очки х2),
--     затем делает UPSERT в team_results.
CREATE OR REPLACE FUNCTION public.recalc_team_results_for_club()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  pool       RECORD;
  member_id  UUID;
  member_pts INTEGER;
  total_pts  NUMERIC(5,2);
BEGIN
  FOR pool IN
    SELECT * FROM public.team_pools
    WHERE gameweek_id = NEW.gameweek_id
      AND NEW.club_id = ANY (club_ids)
  LOOP
    total_pts := 0;

    FOR member_id IN SELECT unnest(pool.club_ids)
    LOOP
      SELECT COALESCE(total_points, 0) INTO member_pts
      FROM public.club_results
      WHERE gameweek_id = pool.gameweek_id AND club_id = member_id;

      member_pts := COALESCE(member_pts, 0);
      IF member_id = pool.captain_club_id THEN
        member_pts := member_pts * 2;
      END IF;

      total_pts := total_pts + member_pts;
    END LOOP;

    INSERT INTO public.team_results (team_id, gameweek_id, points)
    VALUES (pool.team_id, pool.gameweek_id, total_pts)
    ON CONFLICT (team_id, gameweek_id)
    DO UPDATE SET points = EXCLUDED.points;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_team_results_for_club ON public.club_results;
CREATE TRIGGER trg_recalc_team_results_for_club
  AFTER INSERT OR UPDATE ON public.club_results
  FOR EACH ROW
  EXECUTE FUNCTION public.recalc_team_results_for_club();


-- ============================================================================
-- ШАГ 5. Row Level Security (RLS)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_fantasysta_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'email' = 'mysliklub@gmail.com';
$$;

ALTER TABLE public.clubs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gameweeks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fantasysta_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_pools          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transfers_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_results        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_results        ENABLE ROW LEVEL SECURITY;

-- 5.1 Автосоздание fantasysta_profiles при регистрации юзера в auth.users.
--     Название триггера уникальное (…_fantasysta), чтобы не столкнуться с уже
--     существующим триггером старого прогнозиста на той же auth.users, если
--     он есть — Postgres спокойно выполнит оба независимых триггера.
--     На случай коллизии username (два email с одинаковой частью до @) —
--     подставляем короткий суффикс от uuid вместо падения регистрации целиком.
CREATE OR REPLACE FUNCTION public.handle_new_fantasysta_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  base_username TEXT := split_part(NEW.email, '@', 1);
BEGIN
  INSERT INTO public.fantasysta_profiles (id, username)
  VALUES (NEW.id, base_username);
  RETURN NEW;
EXCEPTION WHEN unique_violation THEN
  INSERT INTO public.fantasysta_profiles (id, username)
  VALUES (NEW.id, base_username || '_' || substr(NEW.id::text, 1, 6));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_fantasysta ON auth.users;
CREATE TRIGGER on_auth_user_created_fantasysta
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_fantasysta_user();

-- 5.2 Чтение справочников и командных данных — авторизованным пользователям.
DROP POLICY IF EXISTS clubs_authenticated_select ON public.clubs;
CREATE POLICY clubs_authenticated_select ON public.clubs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS gameweeks_authenticated_select ON public.gameweeks;
CREATE POLICY gameweeks_authenticated_select ON public.gameweeks
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS fantasysta_profiles_authenticated_select ON public.fantasysta_profiles;
CREATE POLICY fantasysta_profiles_authenticated_select ON public.fantasysta_profiles
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS teams_authenticated_select ON public.teams;
CREATE POLICY teams_authenticated_select ON public.teams
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS team_members_authenticated_select ON public.team_members;
CREATE POLICY team_members_authenticated_select ON public.team_members
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS club_results_authenticated_select ON public.club_results;
CREATE POLICY club_results_authenticated_select ON public.club_results
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS team_results_authenticated_select ON public.team_results;
CREATE POLICY team_results_authenticated_select ON public.team_results
  FOR SELECT TO authenticated USING (true);

-- team_pools/transfers_log в ТЗ не было в списке SELECT-политик, но без чтения
-- своего же пула экран трансферов не сможет ничего показать — даём читать
-- участникам конкретной команды (не всем подряд, в отличие от таблиц выше).
DROP POLICY IF EXISTS team_pools_member_select ON public.team_pools;
CREATE POLICY team_pools_member_select ON public.team_pools
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = team_pools.team_id AND tm.profile_id = auth.uid()
  ));

DROP POLICY IF EXISTS transfers_log_member_select ON public.transfers_log;
CREATE POLICY transfers_log_member_select ON public.transfers_log
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = transfers_log.team_id AND tm.profile_id = auth.uid()
  ));

-- 5.3 Модификация team_pools/transfers_log — только участник команды.
DROP POLICY IF EXISTS team_pools_member_insert ON public.team_pools;
CREATE POLICY team_pools_member_insert ON public.team_pools
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = team_pools.team_id AND tm.profile_id = auth.uid()
  ));

DROP POLICY IF EXISTS team_pools_member_update ON public.team_pools;
CREATE POLICY team_pools_member_update ON public.team_pools
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = team_pools.team_id AND tm.profile_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = team_pools.team_id AND tm.profile_id = auth.uid()
  ));

DROP POLICY IF EXISTS team_pools_member_delete ON public.team_pools;
CREATE POLICY team_pools_member_delete ON public.team_pools
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = team_pools.team_id AND tm.profile_id = auth.uid()
  ));

DROP POLICY IF EXISTS transfers_log_member_insert ON public.transfers_log;
CREATE POLICY transfers_log_member_insert ON public.transfers_log
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = transfers_log.team_id AND tm.profile_id = auth.uid()
  ));

-- 5.4 Админка: только clubs / gameweeks / club_results, только по email.
DROP POLICY IF EXISTS clubs_admin_insert ON public.clubs;
CREATE POLICY clubs_admin_insert ON public.clubs
  FOR INSERT TO authenticated WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS clubs_admin_update ON public.clubs;
CREATE POLICY clubs_admin_update ON public.clubs
  FOR UPDATE TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS clubs_admin_delete ON public.clubs;
CREATE POLICY clubs_admin_delete ON public.clubs
  FOR DELETE TO authenticated USING (public.is_fantasysta_admin());

DROP POLICY IF EXISTS gameweeks_admin_insert ON public.gameweeks;
CREATE POLICY gameweeks_admin_insert ON public.gameweeks
  FOR INSERT TO authenticated WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS gameweeks_admin_update ON public.gameweeks;
CREATE POLICY gameweeks_admin_update ON public.gameweeks
  FOR UPDATE TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS gameweeks_admin_delete ON public.gameweeks;
CREATE POLICY gameweeks_admin_delete ON public.gameweeks
  FOR DELETE TO authenticated USING (public.is_fantasysta_admin());

DROP POLICY IF EXISTS club_results_admin_insert ON public.club_results;
CREATE POLICY club_results_admin_insert ON public.club_results
  FOR INSERT TO authenticated WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS club_results_admin_update ON public.club_results;
CREATE POLICY club_results_admin_update ON public.club_results
  FOR UPDATE TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS club_results_admin_delete ON public.club_results;
CREATE POLICY club_results_admin_delete ON public.club_results
  FOR DELETE TO authenticated USING (public.is_fantasysta_admin());

-- 5.5 Пользователь может редактировать только свой собственный fantasysta-профиль.
--     (Не было явно в ТЗ, но иначе username/avatar_url невозможно ни разу изменить.)
DROP POLICY IF EXISTS fantasysta_profiles_self_update ON public.fantasysta_profiles;
CREATE POLICY fantasysta_profiles_self_update ON public.fantasysta_profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- 5.6 Fallback-инсерт своего профиля (ensureProfile() в useFantasystaAuth.js) —
--     нужен для аккаунтов, созданных ДО появления триггера handle_new_fantasysta_user
--     (тогда профиль не создаётся автоматически при регистрации).
DROP POLICY IF EXISTS fantasysta_profiles_self_insert ON public.fantasysta_profiles;
CREATE POLICY fantasysta_profiles_self_insert ON public.fantasysta_profiles
  FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

-- ⚠️ В этом ТЗ НЕТ политик INSERT/UPDATE/DELETE для teams и team_members —
-- то есть создать команду или вступить в неё через обычный ключ anon/authenticated
-- сейчас невозможно, это будет отдельный модуль (скорее всего вместе с оплатой).
-- Сейчас строки в teams/team_members можно добавлять только через service_role
-- (серверный ключ), который RLS не проверяет вообще.

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.clubs, public.gameweeks, public.fantasysta_profiles,
  public.teams, public.team_members, public.club_results, public.team_results
  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.team_pools, public.transfers_log TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.clubs, public.gameweeks, public.club_results TO authenticated;
GRANT UPDATE ON public.fantasysta_profiles TO authenticated;


-- ============================================================================
-- ШАГ 6. SEED — 96 клубов сезона 2026/2027, откалиброванные по тирам
-- ============================================================================
-- price НЕ указываем — его вычисляет триггер trg_set_club_price из tier.
-- ON CONFLICT (name) DO UPDATE — безопасно перезаписывает лигу/тир, если
-- имя клуба уже существовало (например, из тестового seed'а Модуля 1).

INSERT INTO public.clubs (name, league, tier) VALUES
  -- АНГЛИЯ (EPL) — 20 клубов
  ('Манчестер Сити',      'EPL', 'Tier 1'),
  ('Арсенал',             'EPL', 'Tier 1'),
  ('Ливерпуль',           'EPL', 'Tier 1'),
  ('Челси',               'EPL', 'Tier 2'),
  ('Астон Вилла',         'EPL', 'Tier 2'),
  ('Ньюкасл Юнайтед',     'EPL', 'Tier 2'),
  ('Манчестер Юнайтед',   'EPL', 'Tier 2'),
  ('Тоттенхэм',           'EPL', 'Tier 2'),
  ('Брайтон',             'EPL', 'Tier 3'),
  ('Вест Хэм',            'EPL', 'Tier 3'),
  ('Кристал Пэлас',       'EPL', 'Tier 3'),
  ('Эвертон',             'EPL', 'Tier 3'),
  ('Борнмут',             'EPL', 'Tier 3'),
  ('Брентфорд',           'EPL', 'Tier 3'),
  ('Фулхэм',              'EPL', 'Tier 4'),
  ('Ноттингем Форест',    'EPL', 'Tier 4'),
  ('Ипсвич Таун',         'EPL', 'Tier 4'),
  ('Ковентри Сити',       'EPL', 'Tier 4'),
  ('Сандерленд',          'EPL', 'Tier 4'),
  ('Халл Сити',           'EPL', 'Tier 4'),

  -- ИСПАНИЯ (LaLiga) — 20 клубов
  ('Реал Мадрид',            'LaLiga', 'Tier 1'),
  ('Барселона',              'LaLiga', 'Tier 1'),
  ('Атлетико Мадрид',        'LaLiga', 'Tier 1'),
  ('Жирона',                 'LaLiga', 'Tier 2'),
  ('Реал Сосьедад',          'LaLiga', 'Tier 2'),
  ('Вильярреал',             'LaLiga', 'Tier 2'),
  ('Атлетик Бильбао',        'LaLiga', 'Tier 2'),
  ('Реал Бетис',             'LaLiga', 'Tier 2'),
  ('Севилья',                'LaLiga', 'Tier 3'),
  ('Валенсия',               'LaLiga', 'Tier 3'),
  ('Осасуна',                'LaLiga', 'Tier 3'),
  ('Хетафе',                 'LaLiga', 'Tier 3'),
  ('Сельта',                 'LaLiga', 'Tier 3'),
  ('Райо Вальекано',         'LaLiga', 'Tier 3'),
  ('Мальорка',               'LaLiga', 'Tier 3'),
  ('Алавес',                 'LaLiga', 'Tier 4'),
  ('Лас-Пальмас',            'LaLiga', 'Tier 4'),
  ('Расинг Сантандер',       'LaLiga', 'Tier 4'),
  ('Депортиво Ла-Корунья',   'LaLiga', 'Tier 4'),
  ('Малага',                 'LaLiga', 'Tier 4'),

  -- ИТАЛИЯ (SerieA) — 20 клубов
  ('Интер',            'SerieA', 'Tier 1'),
  ('Наполи',           'SerieA', 'Tier 1'),
  ('Комо',             'SerieA', 'Tier 2'),
  ('Ювентус',          'SerieA', 'Tier 2'),
  ('АС Милан',         'SerieA', 'Tier 2'),
  ('Аталанта',         'SerieA', 'Tier 2'),
  ('Болонья',          'SerieA', 'Tier 2'),
  ('Рома',             'SerieA', 'Tier 3'),
  ('Фиорентина',       'SerieA', 'Tier 3'),
  ('Торино',           'SerieA', 'Tier 3'),
  ('Монца',            'SerieA', 'Tier 3'),
  ('Дженоа',           'SerieA', 'Tier 3'),
  ('Парма',            'SerieA', 'Tier 3'),
  ('Удинезе',          'SerieA', 'Tier 3'),
  ('Сассуоло',         'SerieA', 'Tier 3'),
  ('Кальяри',          'SerieA', 'Tier 4'),
  ('Лечче',            'SerieA', 'Tier 4'),
  ('Венеция',          'SerieA', 'Tier 4'),
  ('Фрозиноне',        'SerieA', 'Tier 4'),
  ('Эмполи',           'SerieA', 'Tier 4'),

  -- ГЕРМАНИЯ (Bundesliga) — 18 клубов
  ('Бавария',                    'Bundesliga', 'Tier 1'),
  ('Байер 04',                   'Bundesliga', 'Tier 2'),
  ('РБ Лейпциг',                 'Bundesliga', 'Tier 2'),
  ('Боруссия Дортмунд',          'Bundesliga', 'Tier 2'),
  ('Штутгарт',                   'Bundesliga', 'Tier 2'),
  ('Айнтрахт Франкфурт',         'Bundesliga', 'Tier 2'),
  ('Фрайбург',                   'Bundesliga', 'Tier 3'),
  ('Хоффенхайм',                 'Bundesliga', 'Tier 3'),
  ('Аугсбург',                   'Bundesliga', 'Tier 3'),
  ('Вердер',                     'Bundesliga', 'Tier 3'),
  ('Майнц 05',                   'Bundesliga', 'Tier 3'),
  ('Боруссия Мёнхенгладбах',     'Bundesliga', 'Tier 3'),
  ('Унион Берлин',               'Bundesliga', 'Tier 4'),
  ('Гамбург',                    'Bundesliga', 'Tier 4'),
  ('Кёльн',                      'Bundesliga', 'Tier 4'),
  ('Шальке 04',                  'Bundesliga', 'Tier 4'),
  ('Падерборн 07',               'Bundesliga', 'Tier 4'),
  ('Эльферсберг',                'Bundesliga', 'Tier 4'),

  -- ФРАНЦИЯ (Ligue1) — 18 клубов
  ('Пари Сен-Жермен',   'Ligue1', 'Tier 1'),
  ('Монако',            'Ligue1', 'Tier 2'),
  ('Олимпик Марсель',   'Ligue1', 'Tier 2'),
  ('Лилль',             'Ligue1', 'Tier 2'),
  ('Олимпик Лион',      'Ligue1', 'Tier 2'),
  ('Ланс',              'Ligue1', 'Tier 2'),
  ('Ницца',             'Ligue1', 'Tier 2'),
  ('Ренн',              'Ligue1', 'Tier 3'),
  ('Брест',             'Ligue1', 'Tier 3'),
  ('Реймс',             'Ligue1', 'Tier 3'),
  ('Страсбур',          'Ligue1', 'Tier 3'),
  ('Тулуза',            'Ligue1', 'Tier 3'),
  ('Гавр',              'Ligue1', 'Tier 4'),
  ('Осер',              'Ligue1', 'Tier 4'),
  ('Анже',              'Ligue1', 'Tier 4'),
  ('Сент-Этьен',        'Ligue1', 'Tier 4'),
  ('Ле-Ман',            'Ligue1', 'Tier 4'),
  ('Труа',              'Ligue1', 'Tier 4')
ON CONFLICT (name) DO UPDATE SET
  league = EXCLUDED.league,
  tier   = EXCLUDED.tier;

-- Проверка после запуска (должно вернуть 96 строк и корректные суммы по тирам):
-- SELECT tier, COUNT(*), array_agg(DISTINCT price) FROM public.clubs GROUP BY tier ORDER BY tier;

NOTIFY pgrst, 'reload schema';
