-- ============================================================================
-- FANTASYСТА — Модуль 16. Ещё правки состава под реальный сезон 2026/27
-- Источник: championat.com. Найдено при сверке календарей туров 1-2:
--   АПЛ:     Вест Хэм    → Лидс Юнайтед
--   Серия А: Эмполи      → Лацио
--   Лига 1:  Реймс       → Лорьян
--            Сент-Этьен  → Пари (Paris FC — отдельный от ПСЖ клуб)
-- Ни один игрок не выбирал старые названия — просто UPDATE, тир/цена те же.
-- ============================================================================

UPDATE public.clubs SET name = 'Лидс Юнайтед', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/jcgrml1756649030.png' WHERE name = 'Вест Хэм';
UPDATE public.clubs SET name = 'Лацио', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/rwqyvs1448806608.png' WHERE name = 'Эмполи';
UPDATE public.clubs SET name = 'Лорьян', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/sxsttw1473504748.png' WHERE name = 'Реймс';
UPDATE public.clubs SET name = 'Пари', logo_url = 'https://r2.thesportsdb.com/images/media/team/badge/yuvtsy1447594254.png' WHERE name = 'Сент-Этьен';

NOTIFY pgrst, 'reload schema';
