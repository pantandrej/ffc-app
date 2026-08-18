-- ============================================================================
-- FANTASYСТА — Модуль 19. Второй админ-аккаунт
-- Добавлен доступ администратора для vk3950760@fantasysta.app (тестовый VK-
-- аккаунт) в дополнение к mysliklub@gmail.com. Фронтенд использует тот же
-- список (src/AdminResults.jsx: ADMIN_EMAILS).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_fantasysta_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth.jwt() ->> 'email' IN ('mysliklub@gmail.com', 'vk3950760@fantasysta.app');
$$;
