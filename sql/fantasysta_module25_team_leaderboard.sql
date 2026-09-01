-- ============================================================================
-- FANTASYСТА — Модуль 25. Общая командная таблица
-- team_results уже считается (среднее очков участников команды за тур,
-- см. module 12), но нигде не отображается. Строим сводную таблицу — сумма
-- очков команды по всем сыгранным турам, как и в leaderboard_solo для личных
-- очков. Только команды хотя бы с одним участником (пустые не показываем).
-- ============================================================================

CREATE OR REPLACE VIEW public.leaderboard_teams AS
SELECT
  t.id AS team_id,
  t.name AS team_name,
  COALESCE(SUM(tr.points), 0) AS total_points,
  COUNT(tr.gameweek_id) AS gameweeks_played
FROM public.teams t
LEFT JOIN public.team_results tr ON tr.team_id = t.id
WHERE EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.team_id = t.id)
GROUP BY t.id, t.name
ORDER BY total_points DESC;

NOTIFY pgrst, 'reload schema';
