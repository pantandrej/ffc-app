-- ============================================================================
-- FANTASYСТА — Модуль 14. Исправление состава Ла Лиги под реальный сезон 2026/27
-- Источник: календарь championat.com — в реальном составе есть Эспаньол,
-- Леванте, Эльче, которых не было в исходном списке 96 клубов (были Жирона,
-- Мальорка, Лас-Пальмас). Переименовываем по тем же тирам, чтобы не сбить цены.
-- На момент миграции ни один игрок не выбирал старые названия — просто UPDATE.
-- ============================================================================

UPDATE public.clubs SET name = 'Эспаньол', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/867nzz1681703222.png' WHERE name = 'Жирона';
UPDATE public.clubs SET name = 'Эльче', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/e4vaw51655594332.png' WHERE name = 'Мальорка';
UPDATE public.clubs SET name = 'Леванте', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/xwtxsx1473503739.png' WHERE name = 'Лас-Пальмас';

NOTIFY pgrst, 'reload schema';
