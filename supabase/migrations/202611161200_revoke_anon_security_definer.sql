-- 2026-11-16: odebrat nepřihlášeným (anon) právo volat SECURITY DEFINER funkce přes /rest/v1/rpc
-- Důvod: advisor 0028 „Public Can Execute SECURITY DEFINER Function“ (týdenní kontrola).
-- STAV: spuštěno 2026-11-16 přes konektor Supabase (migrace revoke_anon_security_definer), ověřeno.
-- Všechny RLS politiky v projektu jsou jen "to authenticated", appky volají RPC až po přihlášení
-- (Servis: nastav_muj_token, prejmenuj_technika; Edge Function klima: klima_smi s JWT uživatele).
-- Nemění: kalibrace.upozorneni_data (záměrně anon, chráněno tokenem), funkce SECURITY INVOKER.

begin;

-- 1) Pomocné funkce pro RLS a appky: přihlášení dál smí, anon a PUBLIC ne
revoke execute on function public.je_clen()               from public, anon;
revoke execute on function public.je_spravce()            from public, anon;
revoke execute on function public.klima_smi()             from public, anon;
revoke execute on function public.kucharka_smi()          from public, anon;
revoke execute on function public.moje_jmeno()            from public, anon;
revoke execute on function public.moje_role()             from public, anon;
revoke execute on function public.nastav_muj_token(text)  from public, anon;

-- 2) Triggerové funkce: přes RPC je nemá volat nikdo (trigger se spouští bez kontroly EXECUTE)
revoke execute on function public.novy_uzivatel()         from public, anon, authenticated;
revoke execute on function public.recepty_hledani()       from public, anon, authenticated;
revoke execute on function public.suroviny_obnov_recept() from public, anon, authenticated;
-- pojistka pro registraci (trigger na auth.users běží pod supabase_auth_admin)
grant execute on function public.novy_uzivatel() to supabase_auth_admin;

commit;

-- Ověření po spuštění (SQL Editor):
-- select proname, proacl from pg_proc where pronamespace = 'public'::regnamespace and prosecdef order by 1;
-- Test v appkách: přihlášení + nový záznam (Servis, Android i iPhone), Klima: diktát a uložení postupu,
-- Kuchařka: přihlášení a seznam receptů, uživatel jen s 'klima' nevidí zaznamy, registrace nového účtu
-- (založí se řádek v profily).
-- Návrat (kdyby něco přestalo fungovat):
-- grant execute on function public.je_clen(), public.je_spravce(), public.klima_smi(), public.kucharka_smi(),
--   public.moje_jmeno(), public.moje_role(), public.nastav_muj_token(text), public.novy_uzivatel(),
--   public.recepty_hledani(), public.suroviny_obnov_recept() to public;
