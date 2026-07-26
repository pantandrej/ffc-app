-- ============================================================================
-- FANTASYСТА — Модуль 4. Таблица «Общая лига» (личный зачёт, сумма очков)
-- Очки хранятся в team_results (за команду), а таблица — личная: каждому
-- участнику команды показывается общая сумма очков ЕГО команды за все туры.
-- Если в команде 2-3 человека — у них у всех одинаковая сумма, это ожидаемо
-- (правило игры: очки командные, зачёт — по людям).
-- Выполнять в Supabase SQL Editor ПОСЛЕ Модулей 2 и 3.
-- ============================================================================

CREATE OR REPLACE VIEW public.leaderboard_personal AS
SELECT
  fp.id       AS profile_id,
  fp.username,
  t.id        AS team_id,
  t.name      AS team_name,
  COALESCE(SUM(tr.points), 0) AS total_points
FROM public.fantasysta_profiles fp
JOIN public.team_members tm ON tm.profile_id = fp.id
JOIN public.teams t ON t.id = tm.team_id
LEFT JOIN public.team_results tr ON tr.team_id = t.id
GROUP BY fp.id, fp.username, t.id, t.name;

GRANT SELECT ON public.leaderboard_personal TO authenticated;

NOTIFY pgrst, 'reload schema';
