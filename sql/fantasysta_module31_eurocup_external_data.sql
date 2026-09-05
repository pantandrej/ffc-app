-- ============================================================================
-- FANTASYСТА — Модуль 31. Еврокубковые матчи с внешним соперником — данные
-- Дополняет модуль 29: раньше в ЛЧ/ЛЕ заносились только матчи, где ОБА клуба
-- из наших 96 (6+1); теперь, когда club_fixtures это позволяет (модуль 30),
-- добавляем все остальные матчи 1 тура ЛЧ и ЛЕ, где хотя бы ОДИН из наших
-- клубов играет — соперник (Брюгге, Фейеноорд, Бенфика и т.п.) не наш клуб,
-- пишется как opponent_name. Источник: sports.ru.
-- ============================================================================

WITH fx(league, our_name, our_league, is_home, opponent_name, kickoff_at) AS (
  VALUES
    -- UCL matchday 1 (Sept 8-10)
    ('UCL','Астон Вилла','EPL',false,'Брюгге','2026-09-08 16:45:00+00'::timestamptz),
    ('UCL','Манчестер Сити','EPL',false,'Порту','2026-09-08 19:00:00+00'),
    ('UCL','Штутгарт','Bundesliga',true,'Викинг','2026-09-09 16:45:00+00'),
    ('UCL','Барселона','LaLiga',true,'Фейеноорд','2026-09-09 16:45:00+00'),
    ('UCL','Пари Сен-Жермен','Ligue1',true,'Слован Братислава','2026-09-09 19:00:00+00'),
    ('UCL','Рома','SerieA',false,'Фенербахче','2026-09-10 16:45:00+00'),
    ('UCL','Бавария','Bundesliga',true,'Буде-Глимт','2026-09-10 19:00:00+00'),
    ('UCL','Манчестер Юнайтед','EPL',true,'Сабах','2026-09-10 19:00:00+00'),
    ('UCL','Ланс','Ligue1',false,'Славия Прага','2026-09-10 19:00:00+00'),
    -- UEL matchday 1 (Sept 16-17)
    ('UEL','Сельта','LaLiga',false,'Омония','2026-09-16 16:45:00+00'),
    ('UEL','АС Милан','SerieA',true,'Бенфика','2026-09-16 19:00:00+00'),
    ('UEL','Олимпик Лион','Ligue1',false,'Андерлехт','2026-09-16 19:00:00+00'),
    ('UEL','Байер 04','Bundesliga',true,'Целе','2026-09-16 19:00:00+00'),
    ('UEL','Ренн','Ligue1',false,'Штурм','2026-09-16 19:00:00+00'),
    ('UEL','Сандерленд','EPL',true,'АЗ Алкмар','2026-09-16 19:00:00+00'),
    ('UEL','Хоффенхайм','Bundesliga',false,'ОФИ','2026-09-17 16:45:00+00'),
    ('UEL','Олимпик Марсель','Ligue1',false,'Бешикташ','2026-09-17 19:00:00+00'),
    ('UEL','Ювентус','SerieA',true,'НЕК','2026-09-17 19:00:00+00'),
    ('UEL','Кристал Пэлас','EPL',true,'Лех','2026-09-17 19:00:00+00')
)
INSERT INTO public.club_fixtures (league, home_club_id, away_club_id, home_opponent_name, away_opponent_name, kickoff_at)
SELECT
  fx.league,
  CASE WHEN fx.is_home THEN c.id ELSE NULL END,
  CASE WHEN fx.is_home THEN NULL ELSE c.id END,
  CASE WHEN fx.is_home THEN NULL ELSE fx.opponent_name END,
  CASE WHEN fx.is_home THEN fx.opponent_name ELSE NULL END,
  fx.kickoff_at
FROM fx
JOIN public.clubs c ON c.name = fx.our_name AND c.league = fx.our_league;
