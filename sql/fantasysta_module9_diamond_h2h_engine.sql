-- ============================================================================
-- FANTASYСТА — Модуль 9. Движок микробаттлов 1x1 и пересчёта тура (Бриллиантовая лига)
--
-- ⚠️ Важное отличие от существующей схемы: team_pools (Модуль 2) — ОДИН общий
-- пул из 5 клубов на всю команду (используется Общей лигой). Этот модуль вводит
-- ПАРАЛЛЕЛЬНУЮ механику для Бриллиантовой лиги — у каждого из 1-3 участников
-- команды свой ЛИЧНЫЙ пул (user_lineups), и командный матч решается через
-- 3 дуэли 1х1 между игроками на зеркальных ролях (captain/player_1/player_2).
-- Экрана для заполнения user_lineups и назначения role_in_team пока нет —
-- это бэкенд-движок по ТЗ, UI будет отдельным модулем.
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модуля 2 (нужны clubs/gameweeks/teams/
-- team_members/club_results/is_fantasysta_admin()).
-- ============================================================================

-- ============================================================================
-- ШАГ 1. Схема
-- ============================================================================

-- 1.1 Фиксированная роль участника в команде — задаёт, кто с кем дерётся 1х1.
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS role_in_team TEXT;
ALTER TABLE public.team_members DROP CONSTRAINT IF EXISTS team_members_role_in_team_check;
ALTER TABLE public.team_members ADD CONSTRAINT team_members_role_in_team_check
  CHECK (role_in_team IS NULL OR role_in_team IN ('captain', 'player_1', 'player_2'));
-- Не может быть двух "captain" (или двух "player_1") в одной команде —
-- иначе движок дуэлей возьмёт случайного через LIMIT 1.
CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_role_per_team
  ON public.team_members (team_id, role_in_team) WHERE role_in_team IS NOT NULL;

-- 1.2 Личный состав участника на тур — 5 строк (по клубу) на игрока на тур,
-- ровно у одной из них is_club_captain = true.
CREATE TABLE IF NOT EXISTS public.user_lineups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      UUID NOT NULL REFERENCES public.fantasysta_profiles(id) ON DELETE CASCADE,
  gameweek_id     INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  club_id         UUID NOT NULL REFERENCES public.clubs(id),
  is_club_captain BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_lineups_profile_gameweek_club_uniq
  ON public.user_lineups (profile_id, gameweek_id, club_id);
-- Ровно один клуб-капитан на игрока на тур.
CREATE UNIQUE INDEX IF NOT EXISTS user_lineups_one_captain_per_user_gw
  ON public.user_lineups (profile_id, gameweek_id) WHERE is_club_captain;

-- 1.3 Календарь командных матчей Бриллиантовой лиги.
CREATE TABLE IF NOT EXISTS public.fixtures (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gameweek_number   INTEGER NOT NULL REFERENCES public.gameweeks(id),
  home_team_id      UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  away_team_id      UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  home_score        NUMERIC(3,1),
  away_score        NUMERIC(3,1),
  status            TEXT NOT NULL DEFAULT 'scheduled',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.fixtures DROP CONSTRAINT IF EXISTS fixtures_status_check;
ALTER TABLE public.fixtures ADD CONSTRAINT fixtures_status_check
  CHECK (status IN ('scheduled', 'finished'));

-- 1.4 Турнирная таблица Бриллиантовой лиги — кумулятивная, одна строка на команду.
CREATE TABLE IF NOT EXISTS public.league_table (
  team_id        UUID PRIMARY KEY REFERENCES public.teams(id) ON DELETE CASCADE,
  played         INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  draws          INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  points         INTEGER NOT NULL DEFAULT 0,
  goals_for      NUMERIC(6,1) NOT NULL DEFAULT 0,
  goals_against  NUMERIC(6,1) NOT NULL DEFAULT 0
);


-- ============================================================================
-- ШАГ 2. Очки одного игрока за тур (сумма по его 5 клубам, капитан x2)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.calc_user_lineup_points(p_profile_id UUID, p_gameweek_id INTEGER)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(
    COALESCE(cr.total_points, 0) * (CASE WHEN ul.is_club_captain THEN 2 ELSE 1 END)
  ), 0)
  FROM public.user_lineups ul
  LEFT JOIN public.club_results cr
    ON cr.club_id = ul.club_id AND cr.gameweek_id = ul.gameweek_id
  WHERE ul.profile_id = p_profile_id AND ul.gameweek_id = p_gameweek_id;
$$;


-- ============================================================================
-- ШАГ 3. Пересчёт тура: микробаттлы 1х1 по ролям → home_score/away_score
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recalc_diamond_gameweek(p_gameweek_number INTEGER)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fx           RECORD;
  role         TEXT;
  home_profile UUID;
  away_profile UUID;
  home_pts     NUMERIC;
  away_pts     NUMERIC;
  home_duel    NUMERIC;
  away_duel    NUMERIC;
  total_home   NUMERIC;
  total_away   NUMERIC;
BEGIN
  IF NOT public.is_fantasysta_admin() THEN
    RAISE EXCEPTION 'Только администратор может пересчитывать тур Бриллиантовой лиги';
  END IF;

  FOR fx IN
    SELECT * FROM public.fixtures
    WHERE gameweek_number = p_gameweek_number AND status = 'scheduled'
  LOOP
    total_home := 0;
    total_away := 0;

    FOREACH role IN ARRAY ARRAY['captain', 'player_1', 'player_2']
    LOOP
      SELECT tm.profile_id INTO home_profile
      FROM public.team_members tm
      WHERE tm.team_id = fx.home_team_id AND tm.role_in_team = role
      LIMIT 1;

      SELECT tm.profile_id INTO away_profile
      FROM public.team_members tm
      WHERE tm.team_id = fx.away_team_id AND tm.role_in_team = role
      LIMIT 1;

      -- Защита от пустых слотов (команда из 2 человек) — 0 очков за отсутствующего.
      home_pts := CASE WHEN home_profile IS NULL THEN 0
                       ELSE public.calc_user_lineup_points(home_profile, p_gameweek_number) END;
      away_pts := CASE WHEN away_profile IS NULL THEN 0
                       ELSE public.calc_user_lineup_points(away_profile, p_gameweek_number) END;

      IF home_pts > away_pts THEN
        home_duel := 1; away_duel := 0;
      ELSIF home_pts < away_pts THEN
        home_duel := 0; away_duel := 1;
      ELSE
        home_duel := 0.5; away_duel := 0.5;
      END IF;

      total_home := total_home + home_duel;
      total_away := total_away + away_duel;
    END LOOP;

    UPDATE public.fixtures
    SET home_score = total_home, away_score = total_away, status = 'finished'
    WHERE id = fx.id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recalc_diamond_gameweek(INTEGER) TO authenticated;


-- ============================================================================
-- ШАГ 4. Триггер: при переходе fixtures.status → 'finished' обновляем league_table
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_league_table_from_fixture()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  home_league_pts INTEGER;
  away_league_pts INTEGER;
BEGIN
  INSERT INTO public.league_table (team_id) VALUES (NEW.home_team_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.league_table (team_id) VALUES (NEW.away_team_id) ON CONFLICT DO NOTHING;

  IF NEW.home_score > NEW.away_score THEN
    home_league_pts := 3; away_league_pts := 0;
  ELSIF NEW.home_score < NEW.away_score THEN
    home_league_pts := 0; away_league_pts := 3;
  ELSE
    home_league_pts := 1; away_league_pts := 1;
  END IF;

  UPDATE public.league_table SET
    played        = played + 1,
    wins          = wins + (CASE WHEN NEW.home_score > NEW.away_score THEN 1 ELSE 0 END),
    draws         = draws + (CASE WHEN NEW.home_score = NEW.away_score THEN 1 ELSE 0 END),
    losses        = losses + (CASE WHEN NEW.home_score < NEW.away_score THEN 1 ELSE 0 END),
    points        = points + home_league_pts,
    goals_for     = goals_for + NEW.home_score,
    goals_against = goals_against + NEW.away_score
  WHERE team_id = NEW.home_team_id;

  UPDATE public.league_table SET
    played        = played + 1,
    wins          = wins + (CASE WHEN NEW.away_score > NEW.home_score THEN 1 ELSE 0 END),
    draws         = draws + (CASE WHEN NEW.away_score = NEW.home_score THEN 1 ELSE 0 END),
    losses        = losses + (CASE WHEN NEW.away_score < NEW.home_score THEN 1 ELSE 0 END),
    points        = points + away_league_pts,
    goals_for     = goals_for + NEW.away_score,
    goals_against = goals_against + NEW.home_score
  WHERE team_id = NEW.away_team_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_league_table_from_fixture ON public.fixtures;
CREATE TRIGGER trg_update_league_table_from_fixture
  AFTER UPDATE ON public.fixtures
  FOR EACH ROW
  WHEN (NEW.status = 'finished' AND OLD.status IS DISTINCT FROM 'finished')
  EXECUTE FUNCTION public.update_league_table_from_fixture();


-- ============================================================================
-- ШАГ 5. RLS
-- ============================================================================

ALTER TABLE public.user_lineups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixtures     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.league_table ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_lineups_authenticated_select ON public.user_lineups;
CREATE POLICY user_lineups_authenticated_select ON public.user_lineups
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS user_lineups_self_write ON public.user_lineups;
CREATE POLICY user_lineups_self_write ON public.user_lineups
  FOR ALL TO authenticated
  USING (profile_id = auth.uid()) WITH CHECK (profile_id = auth.uid());

DROP POLICY IF EXISTS fixtures_authenticated_select ON public.fixtures;
CREATE POLICY fixtures_authenticated_select ON public.fixtures
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS fixtures_admin_write ON public.fixtures;
CREATE POLICY fixtures_admin_write ON public.fixtures
  FOR INSERT TO authenticated WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS fixtures_admin_update ON public.fixtures;
CREATE POLICY fixtures_admin_update ON public.fixtures
  FOR UPDATE TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());

DROP POLICY IF EXISTS league_table_authenticated_select ON public.league_table;
CREATE POLICY league_table_authenticated_select ON public.league_table
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.user_lineups, public.fixtures, public.league_table TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.user_lineups TO authenticated;
GRANT INSERT, UPDATE ON public.fixtures TO authenticated;

NOTIFY pgrst, 'reload schema';
