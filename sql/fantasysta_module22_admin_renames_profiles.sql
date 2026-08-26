-- ============================================================================
-- FANTASYСТА — Модуль 22. Админ может переименовать ЛЮБОЙ профиль
-- Нужно, чтобы вручную привязать VK-аккаунты (username вида "vk123456") к
-- реальному имени человека прямо в админке, без прямых SQL-запросов.
-- ============================================================================

DROP POLICY IF EXISTS fantasysta_profiles_admin_update ON public.fantasysta_profiles;
CREATE POLICY fantasysta_profiles_admin_update ON public.fantasysta_profiles
  FOR UPDATE TO authenticated
  USING (public.is_fantasysta_admin())
  WITH CHECK (public.is_fantasysta_admin());

NOTIFY pgrst, 'reload schema';
