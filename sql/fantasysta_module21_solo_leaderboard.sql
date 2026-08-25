-- ============================================================================
-- FANTASYСТА — Модуль 21. Личный зачёт «Все против всех» (Бесплатная квалификация)
--
-- Раньше "Общая лига" была командной: очки = среднее по команде, и человек
-- без команды вообще не попадал в таблицу лидеров (leaderboard_personal
-- INNER JOIN'ился через team_members). Это и был барьер "обязательной
-- команды", который решили снести на время квалификации.
--
-- user_lineups и так уже полностью личные (profile_id/gameweek_id/club_id/
-- is_club_captain, без team_id) — здесь ничего менять не нужно.
--
-- Новая таблица лидеров считает очки НАПРЯМУЮ по user_lineups, без всякой
-- зависимости от команд — сумма calc_user_lineup_points() по всем турам,
-- где у человека был сохранён сет.
-- ============================================================================

CREATE OR REPLACE VIEW public.leaderboard_solo AS
SELECT
  gw.profile_id,
  fp.username,
  COUNT(*)::integer AS gameweeks_played,
  SUM(public.calc_user_lineup_points(gw.profile_id, gw.gameweek_id)) AS total_points
FROM (SELECT DISTINCT profile_id, gameweek_id FROM public.user_lineups) gw
JOIN public.fantasysta_profiles fp ON fp.id = gw.profile_id
GROUP BY gw.profile_id, fp.username;

GRANT SELECT ON public.leaderboard_solo TO authenticated;

NOTIFY pgrst, 'reload schema';
