# Servisní záznamy

Mobilní PWA pro HVAC techniky: záznamy ze servisních výjezdů a montáží, i hlasem (Siri / mikrofon), s fotkami, výkazem hodin a km.

## Zadání
- Kdo: technici firmy, každý vlastní účet; admin = Vladan. Vladan na iPhonu, ostatní technici na Androidu.
- Kde běží: GitHub Pages https://vm73.github.io/Servis/ + Supabase (sdílený projekt, viz níže) + OpenAI přes Edge Function.
- Hotovo když: záznam jde vytvořit z iPhonu (Siri zkratka i formulář) a z Androidu, je vidět všem technikům a adminovi, export do Excelu/textu funguje.

## Stack a nasazení
- Jeden soubor `index.html` (HTML + CSS + JS), `sw.js` (cache `servis-vN`), `manifest.webmanifest`, ikony `icon-180.png`, `icon-512.png`.
- Supabase JS z cdn.jsdelivr.net, Publishable key v `index.html`. **Nikdy** secret / service_role klíč do appky ani do repa.
- Edge Function `servis` (OpenAI): `?akce=prepis&pole=…` přepis nahrávky a rozdělení textu do polí. Klíč OpenAI jen v Supabase Secrets.
- Nasazení: soubory do kořene repa → GitHub Pages. Při každé změně zvýšit číslo verze v `index.html` **i** `CACHE` v `sw.js`.

## Sdílený Supabase projekt
- Projekt `pqehuuamgecmdmrdhmza` sdílí 3 appky: Servis, Klima postupy (repo VM73/Klima), Kuchařka.
- Přístup podle appky: `profily.aplikace` (pole hodnot `servis` / `klima` / `kucharka`). RLS každé tabulky musí kontrolovat svou appku, ne jen `aktivni`.
- Tabulky této appky: `zaznamy`, `technici`, `profily`; Storage `fotky`, `nahravky`. RPC: `nastav_muj_token`, `prejmenuj_technika`.

## Data
- Typ záznamu: servis / montáž. Montáž = jeden záznam na den; vícedenní akce se zadá rozsahem od–do, hodiny po dnech zvlášť.
- Pole: místo, zákazník, zařízení, úkony (rychlé volby: pájení, vakuování, revize PPK/TČ/VZT/chladicího zařízení…), materiál, náhradní díly, hodiny (sdílené technici), cesta tam / zpět (hodiny zvlášť), km (podle auta), fotky.
- Fakturace: „dle CN“ nebo „dle smlouvy“ = bez hodin, km, materiálu a dílů; oprava = hodiny + díly + materiál.
- Technici s celým jménem.

## Pravidla
- Nejjednodušší řešení, měnit jen to, co úkol vyžaduje (chirurgické změny, cílené záměny v `index.html`, ne přepis souboru).
- UI česky, iOS vzhled, použitelné od 320 px, Android i iPhone.
- Diagnostika: `?debug=1` zapne podrobný výpis (přihlášení, chyby), číslo verze viditelné v Nastavení.
- České názvy akcí ve Zkratkách iOS neodhadovat: neověřený název označit a vyžádat screenshot.
- PowerShell příkazy přesně, s `try/catch`, který vypíše status i tělo chyby.

## Testy
- Playwright: iPhone 13, Pixel 7, šířky 320 / 390 px; po každé změně celá sada.
- SQL a RLS ověřit i druhým (neadmin) uživatelem a uživatelem, který má jen `klima`.

## Stav
- Verze 29 (poslední: „přidat den i v bloku Montáž“).
- Plánováno: propojení s plánovačem výjezdů (záznam ↔ naplánovaný termín), servisní list předvyplněný z plánu, podpis zákazníka, bez cen na místě.

## Supabase v repu
- `supabase/schema.sql` + `supabase/functions/{servis,klima,kucharka}/` – snímek celého sdíleného projektu (2026-11-14), postup změn v `supabase/README.md`.
- Změny DB jen novou migrací v `supabase/migrations/`, funkce nejdřív v repu, pak nasadit.

## Otevřené otázky
- Edge Function `servis` (akce `zaznam`, `cesta-zpet`) pouští každý aktivní účet – nekontroluje `'servis' = any(aplikace)`. Uživatel jen s `klima` by přes JWT mohl vložit servisní záznam (funkce zapisuje service_role, mimo RLS). Akci `prepis` používá i Klima – tam je to záměr.
- Edge Function `klima` ověřuje jen přihlášení (ne `aktivni` ani `klima`) – každý registrovaný účet může volat OpenAI.
- Kuchařka používá vlastní tabulku `clenove` (`je_clen()`), funkce `kucharka_smi()` podle `profily.aplikace` se zatím nikde nepoužívá – rozhodnout, který systém platí.
- README je prázdné – doplnit odkaz na appku a popis.

## Neměnit
- Strukturu tabulek a RLS bez SQL migrace a otestování druhým uživatelem.
- Publishable key a URL Supabase (sdílí je i Klima a Kuchařka).
