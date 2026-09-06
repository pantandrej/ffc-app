-- ============================================================================
-- FANTASYСТА — Модуль 32. Личный зачёт по турам (для таблицы с колонками)
-- Та же логика, что и leaderboard_solo (модуль 21), но без агрегации по
-- турам — по одной строке на (профиль, тур), чтобы фронт мог показать
-- очки за каждый тур отдельной колонкой, а не только сумму.
-- ============================================================================

CREATE OR REPLACE VIEW public.leaderboard_solo_by_tour AS
SELECT DISTINCT
  ul.profile_id,
  ul.gameweek_id,
  fp.username,
  public.calc_user_lineup_points(ul.profile_id, ul.gameweek_id) AS points
FROM public.user_lineups ul
JOIN public.fantasysta_profiles fp ON fp.id = ul.profile_id;

GRANT SELECT ON public.leaderboard_solo_by_tour TO authenticated;

NOTIFY pgrst, 'reload schema';
