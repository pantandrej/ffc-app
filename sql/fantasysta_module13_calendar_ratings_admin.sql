-- ============================================================================
-- FANTASYСТА — Модуль 13. Календарь тура, рейтинги игроков, популярность клубов
-- ============================================================================

-- ============================================================================
-- ШАГ 1. Даты тура (понедельник–воскресенье), задаёт админ
-- ============================================================================
ALTER TABLE public.gameweeks ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE public.gameweeks ADD COLUMN IF NOT EXISTS ends_on DATE;

-- ============================================================================
-- ШАГ 2. Календарь реальных матчей всех 5 чемпионатов на тур
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.club_fixtures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gameweek_id   INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  league        TEXT NOT NULL,
  home_club_id  UUID NOT NULL REFERENCES public.clubs(id),
  away_club_id  UUID NOT NULL REFERENCES public.clubs(id),
  kickoff_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (home_club_id <> away_club_id)
);
CREATE INDEX IF NOT EXISTS club_fixtures_gameweek_idx ON public.club_fixtures (gameweek_id);

ALTER TABLE public.club_fixtures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS club_fixtures_authenticated_select ON public.club_fixtures;
CREATE POLICY club_fixtures_authenticated_select ON public.club_fixtures
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS club_fixtures_admin_insert ON public.club_fixtures;
CREATE POLICY club_fixtures_admin_insert ON public.club_fixtures
  FOR INSERT TO authenticated WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS club_fixtures_admin_update ON public.club_fixtures;
CREATE POLICY club_fixtures_admin_update ON public.club_fixtures
  FOR UPDATE TO authenticated USING (public.is_fantasysta_admin()) WITH CHECK (public.is_fantasysta_admin());
DROP POLICY IF EXISTS club_fixtures_admin_delete ON public.club_fixtures;
CREATE POLICY club_fixtures_admin_delete ON public.club_fixtures
  FOR DELETE TO authenticated USING (public.is_fantasysta_admin());

GRANT SELECT ON public.club_fixtures TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.club_fixtures TO authenticated;
-- gameweeks.starts_on/ends_on редактируются той же admin-политикой, что и
-- остальные поля gameweeks (Модуль 2, gameweeks_admin_update) — ничего менять не нужно.


-- ============================================================================
-- ШАГ 3. Персональные результаты дуэлей 1×1 (для будущего рейтинга побед) —
-- recalc_diamond_gameweek теперь заодно сохраняет, кто с кем дрался и с каким
-- исходом, а не только суммарный счёт матча команд.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.duel_results (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id           UUID NOT NULL REFERENCES public.fixtures(id) ON DELETE CASCADE,
  gameweek_id          INTEGER NOT NULL REFERENCES public.gameweeks(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL,
  profile_id           UUID NOT NULL REFERENCES public.fantasysta_profiles(id) ON DELETE CASCADE,
  opponent_profile_id  UUID REFERENCES public.fantasysta_profiles(id),
  points_scored        NUMERIC NOT NULL,
  duel_score           NUMERIC NOT NULL, -- 1 / 0.5 / 0
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS duel_results_fixture_role_profile_uniq
  ON public.duel_results (fixture_id, role, profile_id);

ALTER TABLE public.duel_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS duel_results_authenticated_select ON public.duel_results;
CREATE POLICY duel_results_authenticated_select ON public.duel_results
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.duel_results TO authenticated;

-- Рейтинг побед: матчей/побед/% по каждому игроку (пусто, пока Бриллиантовая
-- лига не запущена и дуэли не считались).
CREATE OR REPLACE VIEW public.leaderboard_wins AS
SELECT
  dr.profile_id,
  fp.username,
  COUNT(*)::INTEGER AS matches,
  COUNT(*) FILTER (WHERE dr.duel_score = 1)::INTEGER AS wins,
  ROUND(100.0 * COUNT(*) FILTER (WHERE dr.duel_score = 1) / COUNT(*), 1) AS win_pct
FROM public.duel_results dr
JOIN public.fantasysta_profiles fp ON fp.id = dr.profile_id
GROUP BY dr.profile_id, fp.username;

GRANT SELECT ON public.leaderboard_wins TO authenticated;

-- Пересчёт тура теперь дополнительно пишет по одной строке в duel_results на
-- каждого РЕАЛЬНОГО участника дуэли (пустые слоты — не пишем, рейтинговать некого).
CREATE OR REPLACE FUNCTION public.recalc_diamond_gameweek(p_gameweek_number INTEGER)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fx           RECORD;
  v_role       TEXT;
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

    FOREACH v_role IN ARRAY ARRAY['captain', 'player_1', 'player_2']
    LOOP
      SELECT tm.profile_id INTO home_profile
      FROM public.team_members tm
      WHERE tm.team_id = fx.home_team_id AND tm.role_in_team = v_role
      LIMIT 1;

      SELECT tm.profile_id INTO away_profile
      FROM public.team_members tm
      WHERE tm.team_id = fx.away_team_id AND tm.role_in_team = v_role
      LIMIT 1;

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

      IF home_profile IS NOT NULL THEN
        INSERT INTO public.duel_results (fixture_id, gameweek_id, role, profile_id, opponent_profile_id, points_scored, duel_score)
        VALUES (fx.id, p_gameweek_number, v_role, home_profile, away_profile, home_pts, home_duel)
        ON CONFLICT (fixture_id, role, profile_id) DO UPDATE SET
          opponent_profile_id = EXCLUDED.opponent_profile_id,
          points_scored = EXCLUDED.points_scored,
          duel_score = EXCLUDED.duel_score;
      END IF;
      IF away_profile IS NOT NULL THEN
        INSERT INTO public.duel_results (fixture_id, gameweek_id, role, profile_id, opponent_profile_id, points_scored, duel_score)
        VALUES (fx.id, p_gameweek_number, v_role, away_profile, home_profile, away_pts, away_duel)
        ON CONFLICT (fixture_id, role, profile_id) DO UPDATE SET
          opponent_profile_id = EXCLUDED.opponent_profile_id,
          points_scored = EXCLUDED.points_scored,
          duel_score = EXCLUDED.duel_score;
      END IF;
    END LOOP;

    UPDATE public.fixtures
    SET home_score = total_home, away_score = total_away, status = 'finished'
    WHERE id = fx.id;
  END LOOP;
END;
$$;


-- ============================================================================
-- ШАГ 4. Популярность клубов — сколько раз клуб выбран в user_lineups
-- (админский разрез: сколько раз клуб выбран в конкретном туре или за всё время)
-- ============================================================================
CREATE OR REPLACE VIEW public.club_pick_popularity AS
SELECT
  ul.gameweek_id,
  c.id AS club_id,
  c.name AS club_name,
  c.league,
  COUNT(*)::INTEGER AS times_picked
FROM public.user_lineups ul
JOIN public.clubs c ON c.id = ul.club_id
GROUP BY ul.gameweek_id, c.id, c.name, c.league;

GRANT SELECT ON public.club_pick_popularity TO authenticated;

NOTIFY pgrst, 'reload schema';
