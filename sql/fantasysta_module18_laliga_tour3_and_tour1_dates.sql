-- ============================================================================
-- FANTASYСТА — Модуль 18. Запуск тура №1 (28-30 августа 2026)
-- Тур LaLiga идёт со сдвигом относительно остальных лиг — тур 1 в базе
-- заканчивался до 28 августа, пришлось отдельно догрузить их тур 3
-- (championat.com), чтобы в окне тура №1 у нас был хотя бы один матч LaLiga.
-- ============================================================================

UPDATE public.gameweeks SET starts_on = '2026-08-28', ends_on = '2026-08-30', status = 'active' WHERE id = 1;

INSERT INTO public.club_fixtures (league, home_club_id, away_club_id, kickoff_at) VALUES
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Расинг Сантандер'), (SELECT id FROM public.clubs WHERE name='Эльче'), '2026-08-28 20:00:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Алавес'), (SELECT id FROM public.clubs WHERE name='Вильярреал'), '2026-08-28 22:30:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Леванте'), (SELECT id FROM public.clubs WHERE name='Реал Бетис'), '2026-08-29 18:00:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Реал Сосьедад'), (SELECT id FROM public.clubs WHERE name='Эспаньол'), '2026-08-29 20:00:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Севилья'), (SELECT id FROM public.clubs WHERE name='Атлетико Мадрид'), '2026-08-29 22:30:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Реал Мадрид'), (SELECT id FROM public.clubs WHERE name='Малага'), '2026-08-30 18:00:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Депортиво Ла-Корунья'), (SELECT id FROM public.clubs WHERE name='Валенсия'), '2026-08-30 20:30:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Сельта'), (SELECT id FROM public.clubs WHERE name='Атлетик Бильбао'), '2026-08-30 22:30:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Осасуна'), (SELECT id FROM public.clubs WHERE name='Хетафе'), '2026-08-31 20:30:00+03'),
  ('LaLiga', (SELECT id FROM public.clubs WHERE name='Барселона'), (SELECT id FROM public.clubs WHERE name='Райо Вальекано'), '2026-08-31 22:30:00+03');
