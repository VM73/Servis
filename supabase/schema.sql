-- =====================================================================
-- Supabase projekt "servisní záznamy" (ref pqehuuamgecmdmrdhmza)
-- Sdílený projekt: Servisní záznamy, Klima postupy, Kuchařka.
-- Snímek schématu stažený 2026-11-14 (jen čtení, nic nebylo změněno).
-- Slouží jako záloha a zdroj pravdy; změny dělat novou migrací
-- v supabase/migrations/ a tento soubor pak obnovit.
-- Neobsahuje data ani klíče.
-- =====================================================================

-- ---------- Rozšíření ----------
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- =====================================================================
-- SERVIS (servisní záznamy)
-- =====================================================================
create table public.profily (
  id uuid not null,
  email text,
  role text not null default 'technik'::text,
  aktivni boolean not null default false,
  token_hash text,
  vytvoreno timestamp with time zone not null default now(),
  aplikace text[] not null default '{}'::text[]
);
alter table public.profily add constraint profily_pkey PRIMARY KEY (id);
alter table public.profily add constraint profily_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.profily add constraint profily_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'kancelar'::text, 'technik'::text])));
alter table public.profily add constraint profily_token_hash_key UNIQUE (token_hash);

create table public.technici (
  id uuid not null default gen_random_uuid(),
  user_id uuid default auth.uid(),
  jmeno text not null,
  ja boolean not null default false,
  aktivni boolean not null default true,
  vytvoreno timestamp with time zone not null default now(),
  ucet uuid
);
alter table public.technici add constraint technici_pkey PRIMARY KEY (id);
alter table public.technici add constraint technici_ucet_fkey FOREIGN KEY (ucet) REFERENCES profily(id) ON DELETE SET NULL;
alter table public.technici add constraint technici_ucet_key UNIQUE (ucet);
alter table public.technici add constraint technici_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX technici_jmeno_firma ON public.technici USING btree (lower(jmeno));

create table public.zaznamy (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  vytvoreno timestamp with time zone not null default now(),
  upraveno timestamp with time zone not null default now(),
  datum_zasahu date not null default CURRENT_DATE,
  misto text,
  zakaznik text,
  zarizeni text,
  predmet text,
  material text,
  nahradni_dily text,
  prace_hod numeric(5,2),
  cesta_tam_hod numeric(5,2),
  cesta_zpet_hod numeric(5,2),
  prepis text,
  audio_cesta text,
  fotky text[] not null default '{}'::text[],
  ke_kontrole boolean not null default false,
  hledani text,
  typ text not null default 'servis'::text,
  akce text,
  cesta_km numeric(7,1),
  skupina uuid,
  servisni_ukony text,
  uctovani text,
  technici text[] not null default '{}'::text[],
  hodiny_technici jsonb
);
alter table public.zaznamy add constraint zaznamy_pkey PRIMARY KEY (id);
alter table public.zaznamy add constraint zaznamy_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.zaznamy add constraint zaznamy_cesta_km_check CHECK ((cesta_km >= (0)::numeric));
alter table public.zaznamy add constraint zaznamy_cesta_tam_hod_check CHECK ((cesta_tam_hod >= (0)::numeric));
alter table public.zaznamy add constraint zaznamy_cesta_zpet_hod_check CHECK ((cesta_zpet_hod >= (0)::numeric));
alter table public.zaznamy add constraint zaznamy_prace_hod_check CHECK ((prace_hod >= (0)::numeric));
alter table public.zaznamy add constraint zaznamy_hodiny_technici_objekt CHECK (((hodiny_technici IS NULL) OR (jsonb_typeof(hodiny_technici) = 'object'::text)));
alter table public.zaznamy add constraint zaznamy_typ_check CHECK ((typ = ANY (ARRAY['servis'::text, 'montaz'::text])));
alter table public.zaznamy add constraint zaznamy_uctovani_check CHECK (((uctovani IS NULL) OR (uctovani = ANY (ARRAY['cn'::text, 'smlouva'::text]))));
CREATE INDEX zaznamy_hledani_trgm ON public.zaznamy USING gin (hledani gin_trgm_ops);
CREATE INDEX zaznamy_skupina ON public.zaznamy USING btree (skupina) WHERE (skupina IS NOT NULL);
CREATE INDEX zaznamy_technici ON public.zaznamy USING gin (technici);
CREATE INDEX zaznamy_typ_datum ON public.zaznamy USING btree (user_id, typ, datum_zasahu DESC);
CREATE INDEX zaznamy_uzivatel_datum ON public.zaznamy USING btree (user_id, datum_zasahu DESC);

-- =====================================================================
-- KLIMA POSTUPY
-- =====================================================================
create table public.klima_vyrobci (
  id text not null default (gen_random_uuid())::text,
  nazev text not null,
  vytvoreno timestamp with time zone not null default now()
);
alter table public.klima_vyrobci add constraint klima_vyrobci_pkey PRIMARY KEY (id);

create table public.klima_postupy (
  id text not null default (gen_random_uuid())::text,
  vyrobce_id text not null,
  nazev text not null,
  kroky text[] not null default '{}'::text[],
  upozorneni text not null default ''::text,
  upraveno timestamp with time zone not null default now(),
  upravil uuid default auth.uid()
);
alter table public.klima_postupy add constraint klima_postupy_pkey PRIMARY KEY (id);
alter table public.klima_postupy add constraint klima_postupy_vyrobce_id_fkey FOREIGN KEY (vyrobce_id) REFERENCES klima_vyrobci(id) ON DELETE RESTRICT;
CREATE INDEX klima_postupy_vyrobce ON public.klima_postupy USING btree (vyrobce_id);

-- =====================================================================
-- KUCHAŘKA
-- =====================================================================
create table public.clenove (
  user_id uuid not null,
  jmeno text not null,
  role text not null default 'clen'::text,
  vytvoreno timestamp with time zone not null default now()
);
alter table public.clenove add constraint clenove_pkey PRIMARY KEY (user_id);
alter table public.clenove add constraint clenove_role_check CHECK ((role = ANY (ARRAY['spravce'::text, 'clen'::text])));
alter table public.clenove add constraint clenove_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

create table public.osoby (
  id uuid not null default gen_random_uuid(),
  jmeno text not null,
  vztah text,
  vytvoreno timestamp with time zone not null default now()
);
alter table public.osoby add constraint osoby_pkey PRIMARY KEY (id);
alter table public.osoby add constraint osoby_jmeno_key UNIQUE (jmeno);

create table public.zdroje (
  id uuid not null default gen_random_uuid(),
  nazev text not null,
  vytvoreno timestamp with time zone not null default now()
);
alter table public.zdroje add constraint zdroje_pkey PRIMARY KEY (id);
alter table public.zdroje add constraint zdroje_nazev_key UNIQUE (nazev);

create table public.kategorie (
  id uuid not null default gen_random_uuid(),
  nazev text not null,
  rodic_id uuid,
  poradi integer not null default 0
);
alter table public.kategorie add constraint kategorie_pkey PRIMARY KEY (id);
alter table public.kategorie add constraint kategorie_rodic_id_fkey FOREIGN KEY (rodic_id) REFERENCES kategorie(id) ON DELETE CASCADE;
alter table public.kategorie add constraint kategorie_rodic_id_nazev_key UNIQUE NULLS NOT DISTINCT (rodic_id, nazev);

create table public.recepty (
  id uuid not null default gen_random_uuid(),
  nazev text not null default 'Nový recept'::text,
  kategorie_id uuid,
  autor_id uuid,
  poslal_id uuid,
  zdroj_id uuid,
  porce text,
  postup jsonb not null default '[]'::jsonb,
  poznamky text,
  upozorneni jsonb not null default '[]'::jsonb,
  nejista jsonb not null default '[]'::jsonb,
  nakup jsonb,
  navrh jsonb,
  stitky text[] not null default '{}'::text[],
  stav text not null default 'ke_kontrole'::text,
  ai_model text,
  ai_cena_kc numeric,
  pridal uuid default auth.uid(),
  vytvoreno timestamp with time zone not null default now(),
  upraveno timestamp with time zone not null default now(),
  hledani text
);
alter table public.recepty add constraint recepty_pkey PRIMARY KEY (id);
alter table public.recepty add constraint recepty_autor_id_fkey FOREIGN KEY (autor_id) REFERENCES osoby(id) ON DELETE SET NULL;
alter table public.recepty add constraint recepty_kategorie_id_fkey FOREIGN KEY (kategorie_id) REFERENCES kategorie(id) ON DELETE SET NULL;
alter table public.recepty add constraint recepty_poslal_id_fkey FOREIGN KEY (poslal_id) REFERENCES osoby(id) ON DELETE SET NULL;
alter table public.recepty add constraint recepty_pridal_fkey FOREIGN KEY (pridal) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.recepty add constraint recepty_stav_check CHECK ((stav = ANY (ARRAY['ke_kontrole'::text, 'hotovo'::text])));
alter table public.recepty add constraint recepty_zdroj_id_fkey FOREIGN KEY (zdroj_id) REFERENCES zdroje(id) ON DELETE SET NULL;
CREATE INDEX recepty_autor_idx ON public.recepty USING btree (autor_id);
CREATE INDEX recepty_kategorie_idx ON public.recepty USING btree (kategorie_id);

create table public.suroviny (
  id uuid not null default gen_random_uuid(),
  recept_id uuid not null,
  skupina text,
  poradi integer not null default 0,
  mnozstvi text,
  cislo numeric,
  jednotka text,
  surovina text not null,
  gramy numeric
);
alter table public.suroviny add constraint suroviny_pkey PRIMARY KEY (id);
alter table public.suroviny add constraint suroviny_recept_id_fkey FOREIGN KEY (recept_id) REFERENCES recepty(id) ON DELETE CASCADE;
CREATE INDEX suroviny_recept_idx ON public.suroviny USING btree (recept_id, poradi);

create table public.stranky (
  id uuid not null default gen_random_uuid(),
  recept_id uuid not null,
  poradi integer not null default 0,
  cesta text not null,
  vytvoreno timestamp with time zone not null default now()
);
alter table public.stranky add constraint stranky_pkey PRIMARY KEY (id);
alter table public.stranky add constraint stranky_recept_id_fkey FOREIGN KEY (recept_id) REFERENCES recepty(id) ON DELETE CASCADE;
CREATE INDEX stranky_recept_idx ON public.stranky USING btree (recept_id, poradi);

create table public.fotky_pokrmu (
  id uuid not null default gen_random_uuid(),
  recept_id uuid not null,
  cesta text not null,
  poradi integer not null default 0,
  pridal uuid default auth.uid(),
  vytvoreno timestamp with time zone not null default now()
);
alter table public.fotky_pokrmu add constraint fotky_pokrmu_pkey PRIMARY KEY (id);
alter table public.fotky_pokrmu add constraint fotky_pokrmu_pridal_fkey FOREIGN KEY (pridal) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.fotky_pokrmu add constraint fotky_pokrmu_recept_id_fkey FOREIGN KEY (recept_id) REFERENCES recepty(id) ON DELETE CASCADE;
CREATE INDEX fotky_recept_idx ON public.fotky_pokrmu USING btree (recept_id, poradi);

-- =====================================================================
-- FUNKCE
-- =====================================================================
-- Přístup Servis: role z profilu, jen aktivní a s 'servis' v aplikace
CREATE OR REPLACE FUNCTION public.moje_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select role from public.profily
  where id = (select auth.uid()) and aktivni and 'servis' = any(aplikace);
$function$
;

CREATE OR REPLACE FUNCTION public.moje_jmeno()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jmeno from public.technici where ucet = (select auth.uid()) limit 1;
$function$
;

-- Přístup Klima: aktivní a s 'klima' v aplikace
CREATE OR REPLACE FUNCTION public.klima_smi()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profily
    where id = (select auth.uid()) and aktivni and 'klima' = any(aplikace));
$function$
;

-- Přístup Kuchařka podle profily.aplikace (pozn.: politiky Kuchařky zatím používají je_clen/je_spravce)
CREATE OR REPLACE FUNCTION public.kucharka_smi()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profily
    where id = (select auth.uid()) and aktivni and 'kucharka' = any(aplikace));
$function$
;

CREATE OR REPLACE FUNCTION public.je_clen()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.clenove where user_id = auth.uid());
$function$
;

CREATE OR REPLACE FUNCTION public.je_spravce()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.clenove where user_id = auth.uid() and role = 'spravce');
$function$
;

CREATE OR REPLACE FUNCTION public.nastav_muj_token(hash text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.profily set token_hash = hash
   where id = (select auth.uid()) and aktivni;
$function$
;

CREATE OR REPLACE FUNCTION public.prejmenuj_technika(stare text, nove text)
 RETURNS integer
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  with u as (
    update public.zaznamy
       set technici = array_replace(technici, stare, nove),
           hodiny_technici = case when hodiny_technici ? stare
             then (hodiny_technici - stare) || jsonb_build_object(nove, hodiny_technici -> stare)
             else hodiny_technici end
     where stare = any(technici) and public.moje_role() = 'admin'
    returning 1
  )
  select count(*)::integer from u;
$function$
;

CREATE OR REPLACE FUNCTION public.novy_uzivatel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.profily (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.zaznamy_pred_ulozenim()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.upraveno := now();
  new.hledani  := lower(extensions.unaccent(concat_ws(' ',
                    new.akce, new.misto, new.zakaznik, new.zarizeni, new.predmet,
                    new.servisni_ukony, new.material, new.nahradni_dily,
                    array_to_string(new.technici, ' '), new.prepis)));
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.hledej_recepty(dotaz text)
 RETURNS SETOF recepty
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  select * from public.recepty
  where hledani like '%' || lower(unaccent(dotaz)) || '%'
  order by nazev;
$function$
;

CREATE OR REPLACE FUNCTION public.recepty_hledani()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  new.upraveno := now();
  new.hledani := lower(unaccent(
       coalesce(new.nazev, '') || ' ' ||
       coalesce(new.poznamky, '') || ' ' ||
       coalesce((select string_agg(value, ' ') from jsonb_array_elements_text(new.postup)), '') || ' ' ||
       array_to_string(new.stitky, ' ') || ' ' ||
       coalesce((select string_agg(s.surovina, ' ') from public.suroviny s where s.recept_id = new.id), '')
  ));
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.suroviny_obnov_recept()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.recepty set upraveno = now() where id = coalesce(new.recept_id, old.recept_id);
  return null;
end $function$
;

-- =====================================================================
-- TRIGGERY
-- =====================================================================
CREATE TRIGGER novy_uzivatel AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION novy_uzivatel();
CREATE TRIGGER zaznamy_pred_ulozenim BEFORE INSERT OR UPDATE ON public.zaznamy FOR EACH ROW EXECUTE FUNCTION zaznamy_pred_ulozenim();
CREATE TRIGGER recepty_hledani_trg BEFORE INSERT OR UPDATE ON public.recepty FOR EACH ROW EXECUTE FUNCTION recepty_hledani();
CREATE TRIGGER suroviny_obnov_trg AFTER INSERT OR DELETE OR UPDATE ON public.suroviny FOR EACH ROW EXECUTE FUNCTION suroviny_obnov_recept();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.profily enable row level security;
alter table public.technici enable row level security;
alter table public.zaznamy enable row level security;
alter table public.klima_vyrobci enable row level security;
alter table public.klima_postupy enable row level security;
alter table public.clenove enable row level security;
alter table public.osoby enable row level security;
alter table public.zdroje enable row level security;
alter table public.kategorie enable row level security;
alter table public.recepty enable row level security;
alter table public.suroviny enable row level security;
alter table public.stranky enable row level security;
alter table public.fotky_pokrmu enable row level security;

-- ---------- Servis ----------
create policy "profily - cteni" on public.profily as PERMISSIVE for SELECT to authenticated
  using (((id = ( SELECT auth.uid() AS uid)) OR (moje_role() IS NOT NULL)));
create policy "profily - sprava" on public.profily as PERMISSIVE for UPDATE to authenticated
  using ((moje_role() = 'admin'::text))
  with check ((moje_role() = 'admin'::text));

create policy "technici - cteni" on public.technici as PERMISSIVE for SELECT to authenticated
  using ((moje_role() IS NOT NULL));
create policy "technici - sprava" on public.technici as PERMISSIVE for ALL to authenticated
  using ((moje_role() = 'admin'::text))
  with check ((moje_role() = 'admin'::text));

create policy "firma - cteni" on public.zaznamy as PERMISSIVE for SELECT to authenticated
  using ((moje_role() IS NOT NULL));
create policy "firma - vlozeni" on public.zaznamy as PERMISSIVE for INSERT to authenticated
  with check (((user_id = ( SELECT auth.uid() AS uid)) AND (moje_role() IS NOT NULL)));
create policy "firma - uprava" on public.zaznamy as PERMISSIVE for UPDATE to authenticated
  using (((user_id = ( SELECT auth.uid() AS uid)) OR (moje_role() = ANY (ARRAY['admin'::text, 'kancelar'::text])) OR ((moje_role() IS NOT NULL) AND (moje_jmeno() = ANY (technici)))))
  with check ((moje_role() IS NOT NULL));
create policy "firma - mazani" on public.zaznamy as PERMISSIVE for DELETE to authenticated
  using (((user_id = ( SELECT auth.uid() AS uid)) OR (moje_role() = 'admin'::text) OR ((moje_role() IS NOT NULL) AND (moje_jmeno() = ANY (technici)))));

-- ---------- Klima ----------
create policy klima_vyrobci_vse on public.klima_vyrobci as PERMISSIVE for ALL to authenticated
  using (klima_smi())
  with check (klima_smi());
create policy klima_postupy_vse on public.klima_postupy as PERMISSIVE for ALL to authenticated
  using (klima_smi())
  with check (klima_smi());

-- ---------- Kuchařka ----------
create policy "clen cte cleny" on public.clenove as PERMISSIVE for SELECT to authenticated
  using (je_clen());
create policy "spravce spravuje cleny" on public.clenove as PERMISSIVE for ALL to authenticated
  using (je_spravce())
  with check (je_spravce());

-- stejná čtveřice politik pro osoby, zdroje, kategorie, recepty, suroviny, stranky, fotky_pokrmu
create policy "clen cte" on public.osoby as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.osoby as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.osoby as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.osoby as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.zdroje as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.zdroje as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.zdroje as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.zdroje as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.kategorie as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.kategorie as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.kategorie as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.kategorie as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.recepty as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.recepty as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.recepty as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.recepty as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.suroviny as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.suroviny as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.suroviny as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.suroviny as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.stranky as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.stranky as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.stranky as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.stranky as PERMISSIVE for DELETE to authenticated using (je_spravce());

create policy "clen cte" on public.fotky_pokrmu as PERMISSIVE for SELECT to authenticated using (je_clen());
create policy "clen pridava" on public.fotky_pokrmu as PERMISSIVE for INSERT to authenticated with check (je_clen());
create policy "clen upravuje" on public.fotky_pokrmu as PERMISSIVE for UPDATE to authenticated using (je_clen()) with check (je_clen());
create policy "spravce maze" on public.fotky_pokrmu as PERMISSIVE for DELETE to authenticated using (je_spravce());

-- =====================================================================
-- STORAGE
-- =====================================================================
insert into storage.buckets (id, name, public) values ('fotky', 'fotky', false);
insert into storage.buckets (id, name, public) values ('nahravky', 'nahravky', false);
insert into storage.buckets (id, name, public) values ('pokrmy', 'pokrmy', false);
insert into storage.buckets (id, name, public) values ('stranky', 'stranky', false);

-- Servis: soubory ve složce <user_id>/…
create policy "servis - cteni souboru" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = ANY (ARRAY['nahravky'::text, 'fotky'::text])) AND (moje_role() IS NOT NULL)));
create policy "servis - nahrani souboru" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = ANY (ARRAY['nahravky'::text, 'fotky'::text])) AND (moje_role() IS NOT NULL) AND ((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text)));
create policy "servis - mazani souboru" on storage.objects as PERMISSIVE for DELETE to authenticated
  using (((bucket_id = ANY (ARRAY['nahravky'::text, 'fotky'::text])) AND (((storage.foldername(name))[1] = (( SELECT auth.uid() AS uid))::text) OR (moje_role() = 'admin'::text))));

-- Kuchařka
create policy "kucharka cte" on storage.objects as PERMISSIVE for SELECT to authenticated
  using (((bucket_id = ANY (ARRAY['stranky'::text, 'pokrmy'::text])) AND je_clen()));
create policy "kucharka nahrava" on storage.objects as PERMISSIVE for INSERT to authenticated
  with check (((bucket_id = ANY (ARRAY['stranky'::text, 'pokrmy'::text])) AND je_clen()));
create policy "kucharka upravuje" on storage.objects as PERMISSIVE for UPDATE to authenticated
  using (((bucket_id = ANY (ARRAY['stranky'::text, 'pokrmy'::text])) AND je_clen()));
create policy "kucharka maze" on storage.objects as PERMISSIVE for DELETE to authenticated
  using (((bucket_id = ANY (ARRAY['stranky'::text, 'pokrmy'::text])) AND je_clen()));
