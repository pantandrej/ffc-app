-- ============================================================================
-- FANTASYСТА — Модуль 12. Единый источник данных для пула клубов (user_lineups)
--
-- До этого момента было ДВЕ параллельные механики набора клубов:
--   team_pools   — один общий пул на всю команду (Общая лига)
--   user_lineups — личный пул на каждого участника (задел под Бриллиантовую лигу)
-- Это путало пользователей интерфейсом (две вкладки на одно и то же) и просило
-- собирать состав дважды. Начиная с этого модуля — user_lineups становится
-- ЕДИНСТВЕННЫМ источником данных о пуле клубов:
--   • Общая лига: очки команды за тур = СРЕДНЕЕ по calc_user_lineup_points()
--     всех её участников (а не одно общее значение из team_pools).
--   • Будущая Бриллиантовая лига: те же самые user_lineups идут в дуэли 1×1
--     (recalc_diamond_gameweek уже читает именно user_lineups — без изменений).
--
-- team_pools/transfers_log НЕ удаляются (не хотим необратимо ронять таблицы),
-- но с этого момента ничего в них не пишет и не читает.
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модуля 9.
-- ============================================================================

-- 12.1 Пересчёт team_results теперь усредняет user_lineups всех участников
-- команды, а не читает team_pools. Та же самая функция/триггер, что и раньше
-- (на club_results) — просто другая реализация внутри.
CREATE OR REPLACE FUNCTION public.recalc_team_results_for_club()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  affected_team RECORD;
  member        RECORD;
  total_pts     NUMERIC;
  member_count  INTEGER;
BEGIN
  FOR affected_team IN
    SELECT DISTINCT tm.team_id
    FROM public.user_lineups ul
    JOIN public.team_members tm ON tm.profile_id = ul.profile_id
    WHERE ul.club_id = NEW.club_id AND ul.gameweek_id = NEW.gameweek_id
  LOOP
    total_pts := 0;
    member_count := 0;
    FOR member IN SELECT profile_id FROM public.team_members WHERE team_id = affected_team.team_id
    LOOP
      total_pts := total_pts + public.calc_user_lineup_points(member.profile_id, NEW.gameweek_id);
      member_count := member_count + 1;
    END LOOP;

    IF member_count > 0 THEN
      INSERT INTO public.team_results (team_id, gameweek_id, points)
      VALUES (affected_team.team_id, NEW.gameweek_id, total_pts / member_count)
      ON CONFLICT (team_id, gameweek_id) DO UPDATE SET points = EXCLUDED.points;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;
-- Триггер trg_recalc_team_results_for_club на club_results уже существует
-- (Модуль 2) и использует эту же функцию — пересоздавать не нужно.

-- 12.2 Пересчёт сразу при сохранении/изменении личного пула игрока — чтобы
-- «Общая лига» отражала свежий состав, не дожидаясь следующего матча.
CREATE OR REPLACE FUNCTION public.recalc_team_results_for_user_lineup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_team_id    UUID;
  member       RECORD;
  total_pts    NUMERIC;
  member_count INTEGER;
BEGIN
  SELECT team_id INTO v_team_id FROM public.team_members WHERE profile_id = NEW.profile_id LIMIT 1;
  IF v_team_id IS NULL THEN RETURN NEW; END IF;

  total_pts := 0;
  member_count := 0;
  FOR member IN SELECT profile_id FROM public.team_members WHERE team_id = v_team_id
  LOOP
    total_pts := total_pts + public.calc_user_lineup_points(member.profile_id, NEW.gameweek_id);
    member_count := member_count + 1;
  END LOOP;

  IF member_count > 0 THEN
    INSERT INTO public.team_results (team_id, gameweek_id, points)
    VALUES (v_team_id, NEW.gameweek_id, total_pts / member_count)
    ON CONFLICT (team_id, gameweek_id) DO UPDATE SET points = EXCLUDED.points;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalc_team_results_for_user_lineup ON public.user_lineups;
CREATE TRIGGER trg_recalc_team_results_for_user_lineup
  AFTER INSERT OR UPDATE ON public.user_lineups
  FOR EACH ROW
  EXECUTE FUNCTION public.recalc_team_results_for_user_lineup();

NOTIFY pgrst, 'reload schema';
