// =============================================================
// Servisní záznamy – Edge Function "servis" (Supabase)
//
// Přijímá hlasový diktát ze zkratky na iPhonu.
//   POST .../functions/v1/servis?akce=zaznam      → nový záznam (servis nebo montáž
//                                                  pozná AI z diktátu)
//   POST .../functions/v1/servis?akce=zaznam&typ=montaz → vždy montáž
//   POST .../functions/v1/servis?akce=zaznam&typ=servis → vždy servis
//   POST .../functions/v1/servis?akce=prepis&pole=text|hodiny|km
//        → přepis krátké nahrávky z appky (mikrofon u pole); místo tokenu zkratky
//          se ověřuje přihlášení v appce (Authorization: Bearer <JWT>)
//   POST .../functions/v1/servis?akce=cesta-zpet  → doplní zpáteční cestu (hodiny
//                                                  a/nebo km) k poslednímu záznamu
// Kdo diktuje:
//   x-zkratka-token: <osobní token technika>  (vytvoří si ho v appce: Nastavení → Můj účet)
//   x-zkratka-token: <SHORTCUT_TOKEN>         (původní společný token → účet OWNER_USER_ID)
//   nebo Authorization: Bearer <JWT>          (diktování přímo z appky)
// Tělo: buď hotový text jako JSON {"text": "..."} (akce Diktovat text v iPhonu),
//       nebo nahrávka (m4a) – přímo jako soubor, nebo formulář s polem "audio".
// Odpověď: krátký text, který zkratka přečte nahlas.
//
// Secrets (Edge Functions → Secrets):
//   OPENAI_API_KEY; volitelně SHORTCUT_TOKEN + OWNER_USER_ID (původní zkratka)
//   volitelně TRANSCRIBE_MODEL, STRUCT_MODEL
// =============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SHORTCUT_TOKEN = Deno.env.get("SHORTCUT_TOKEN") ?? "";
const OWNER_USER_ID = Deno.env.get("OWNER_USER_ID") ?? "";
const TRANSCRIBE_MODEL = Deno.env.get("TRANSCRIBE_MODEL") ?? "gpt-4o-transcribe";
const STRUCT_MODEL = Deno.env.get("STRUCT_MODEL") ?? "gpt-5-mini";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Nápověda pro přepis – odborné výrazy, které má poznat správně
const SLOVNIK =
  "Servis klimatizací a vzduchotechniky. Daikin, Mitsubishi Electric, Toshiba, " +
  "Panasonic, LG, Samsung, Fujitsu, Gree, Midea, Hisense, Sinclair. Venkovní " +
  "jednotka, vnitřní jednotka, nástěnná, kazetová, kanálová, VRV, VRF, multisplit, " +
  "rekuperace, chladivo R32, R410A, R407C, R134a, kondenzátor, kompresor, " +
  "expanzní ventil, čtyřcestný ventil, výparník, kondenzační vana, čerpadlo " +
  "kondenzátu, filtr, chybový kód.";

type Typ = "servis" | "montaz";

// Jeden den práce – u vícedenní akce jich je víc, každý s vlastními hodinami a km
type Den = {
  datum: string;
  prace_hod: number | null;
  cesta_tam_hod: number | null;
  cesta_zpet_hod: number | null;
  cesta_km: number | null;
  technici?: string[];   // technici právě tohoto dne (u vícedenní práce se mohou lišit)
  // technici, kteří ten den pracovali jinou dobu než prace_hod (AI vrací pole, ukládá se objekt)
  hodiny_technici?: { jmeno: string; hodiny: number | null }[] | Record<string, number> | null;
};

type Uctovani = "cn" | "smlouva" | null;

type Zaznam = {
  typ: Typ;
  uctovani: Uctovani;
  akce: string | null;
  misto: string | null;
  zakaznik: string | null;
  zarizeni: string | null;
  predmet: string | null;
  servisni_ukony: string | null;
  technici: string[];
  material: string | null;
  nahradni_dily: string | null;
  dny: Den[];
};

const TXT = { type: ["string", "null"] };
const NUM = { type: ["number", "null"] };
// schéma se skládá podle aktuálního seznamu techniků (AI smí vybrat jen z nich)
function schemaZaznam(jmena: string[]) {
  const poleTechniku = {
    type: "array",
    items: jmena.length ? { type: "string", enum: jmena } : { type: "string" },
  };
  const dny = SCHEMA_ZAZNAM.properties.dny;
  const hodinyTechniku = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { jmeno: poleTechniku.items, hodiny: NUM },
      required: ["jmeno", "hodiny"],
    },
  };
  return {
    ...SCHEMA_ZAZNAM,
    properties: {
      ...SCHEMA_ZAZNAM.properties,
      technici: poleTechniku,
      dny: {
        ...dny,
        items: {
          ...dny.items,
          properties: { ...dny.items.properties, technici: poleTechniku, hodiny_technici: hodinyTechniku },
          required: [...dny.items.required, "technici", "hodiny_technici"],
        },
      },
    },
    required: [...SCHEMA_ZAZNAM.required, "technici"],
  };
}

type Technik = { jmeno: string; ja: boolean };

// společný seznam techniků firmy; „já“ = technik propojený s účtem, který diktuje
async function nactiTechniky(userId: string): Promise<Technik[]> {
  const { data, error } = await supabase
    .from("technici").select("jmeno, ucet")
    .eq("aktivni", true)
    .order("jmeno");
  if (error) { log("technici nenačteni", error.message); return []; }
  return ((data ?? []) as { jmeno: string; ucet: string | null }[]).map((t) => ({ jmeno: t.jmeno, ja: t.ucet === userId }));
}

async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// aktivní účet podle ID (null = neexistuje / neschválený)
async function aktivniUcet(id: string | undefined | null): Promise<string | null> {
  if (!id) return null;
  const { data, error } = await supabase.from("profily").select("id").eq("id", id).eq("aktivni", true).maybeSingle();
  if (error) log("profil nenačten", error.message);
  return data?.id ?? null;
}

// přihlášení z appky (JWT)
async function uzivatelZJwt(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.split(".").length !== 3) return null;
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error) { log("ověření přihlášení selhalo", error.message); return null; }
  return await aktivniUcet(data.user?.id);
}

// token Siri zkratky – osobní (hash v profilu), nebo původní společný
async function uzivatelZTokenu(req: Request): Promise<string | null> {
  const token = (req.headers.get("x-zkratka-token") ?? "").trim();
  if (token.length < 20) return null;
  if (SHORTCUT_TOKEN && token === SHORTCUT_TOKEN) return await aktivniUcet(OWNER_USER_ID);
  const { data, error } = await supabase.from("profily").select("id")
    .eq("token_hash", await sha256(token)).eq("aktivni", true).maybeSingle();
  if (error) log("token – chyba čtení", error.message);
  return data?.id ?? null;
}

const SCHEMA_ZAZNAM = {
  type: "object",
  additionalProperties: false,
  properties: {
    typ: { type: "string", enum: ["servis", "montaz"] },
    uctovani: { type: ["string", "null"], enum: ["cn", "smlouva", null] },
    akce: TXT,
    misto: TXT,
    zakaznik: TXT,
    zarizeni: TXT,
    predmet: TXT,
    servisni_ukony: TXT,
    material: TXT,
    nahradni_dily: TXT,
    dny: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          datum: { type: "string", description: "YYYY-MM-DD" },
          prace_hod: NUM,
          cesta_tam_hod: NUM,
          cesta_zpet_hod: NUM,
          cesta_km: NUM,
        },
        required: ["datum", "prace_hod", "cesta_tam_hod", "cesta_zpet_hod", "cesta_km"],
      },
    },
  },
  required: [
    "typ", "uctovani", "akce", "misto", "zakaznik", "zarizeni", "predmet", "servisni_ukony", "material", "nahradni_dily", "dny",
  ],
};

// ---------- pomocné funkce ----------

function log(krok: string, data?: unknown) {
  console.log(`[servis] ${krok}`, data === undefined ? "" : JSON.stringify(data));
}

// appka běží na jiné doméně (github.io) → odpovědi musí povolit CORS
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey, x-zkratka-token",
};

function odpoved(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function odpovedJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function dnesPraha(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

function zaokrouhli(h: number | null | undefined): number | null {
  if (h === null || h === undefined || !Number.isFinite(h) || h < 0) return null;
  return Math.round(h * 100) / 100;
}

function platneDatum(d: string | null | undefined): boolean {
  return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
}

function cesky(h: number): string {
  return String(h).replace(".", ",");
}

function typAudia(nazev: string, typ: string) {
  const n = nazev.toLowerCase();
  const t = typ.toLowerCase();
  if (n.endsWith(".mp3") || t.includes("mpeg")) return { pripona: "mp3", typ: "audio/mpeg" };
  if (n.endsWith(".wav") || t.includes("wav")) return { pripona: "wav", typ: "audio/wav" };
  if (n.endsWith(".webm") || t.includes("webm")) return { pripona: "webm", typ: "audio/webm" };
  return { pripona: "m4a", typ: "audio/mp4" }; // výchozí formát iPhonu
}

async function nactiAudio(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const soubor = form.get("audio") ?? [...form.values()].find((v) => v instanceof File);
    if (!(soubor instanceof File)) throw new Error("Ve formuláři chybí soubor s nahrávkou.");
    return {
      data: new Uint8Array(await soubor.arrayBuffer()),
      ...typAudia(soubor.name, soubor.type),
    };
  }
  return { data: new Uint8Array(await req.arrayBuffer()), ...typAudia("", ct) };
}

// Vstup je buď hotový text (JSON {"text": "..."} nebo text/plain),
// nebo zvuková nahrávka.
async function nactiVstup(req: Request): Promise<
  { text: string } | { audio: { data: Uint8Array; pripona: string; typ: string } }
> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = await req.json().catch(() => ({}));
    return { text: String(j?.text ?? "").trim() };
  }
  if (ct.includes("text/plain")) return { text: (await req.text()).trim() };
  return { audio: await nactiAudio(req) };
}

// ---------- OpenAI ----------

async function prepis(audio: Uint8Array, pripona: string, typ: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type: typ }), `diktat.${pripona}`);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("language", "cs");
  form.append("prompt", SLOVNIK);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const telo = await r.text();
  if (!r.ok) throw new Error(`Přepis selhal (${r.status}): ${telo.slice(0, 300)}`);
  return (JSON.parse(telo).text ?? "").trim();
}

async function strukturuj<T>(system: string, text: string, nazev: string, schema: object): Promise<T> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: STRUCT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: nazev, strict: true, schema },
      },
    }),
  });
  const telo = await r.text();
  if (!r.ok) throw new Error(`Strukturování selhalo (${r.status}): ${telo.slice(0, 300)}`);
  const obsah = JSON.parse(telo).choices?.[0]?.message?.content;
  if (!obsah) throw new Error("AI nevrátila žádný obsah.");
  return JSON.parse(obsah) as T;
}

function promptZaznam(dnes: string, vynucenyTyp: Typ | null, technici: Technik[]): string {
  const ja = technici.find((t) => t.ja)?.jmeno;
  const pravidloTechnici = technici.length
    ? `- technici: kdo na zásahu pracoval – vyber POUZE ze seznamu: ${technici.map((t) => t.jmeno).join("; ")}.
  Technici jsou často zmínění jen křestním jménem, příjmením nebo přezdívkou ("s Pavlem", "Honza",
  "Dvořák") – přiřaď je k celému jménu ze seznamu (Honza = Jan, Pepa = Josef, Míra = Miroslav…).
  ${ja ? `Diktuje ${ja}: "byl jsem", "dělal jsem", "jeli jsme" = ${ja} je mezi techniky.` : ""}
  Pokud jméno nejde jednoznačně přiřadit, nevybírej ho.
  "technici" na nejvyšší úrovni = všichni, kdo na zásahu byli. V každém dni ("dny[].technici") uveď,
  kdo pracoval právě ten den ("v pondělí jsem byl s Pavlem, v úterý s Honzou"). Když se dny
  nerozlišují, dej do každého dne stejné techniky jako na nejvyšší úrovni.
  "dny[].hodiny_technici": jen technici, kteří ten den pracovali JINOU dobu než ostatní
  ("Pavel byl jen čtyři hodiny", "Honza přijel až odpoledne, měl tři hodiny") – jméno a jeho hodiny.
  prace_hod je pak doba ostatních (celé party). Když všichni pracovali stejně, prázdný seznam.`
    : `- technici: prázdný seznam.`;
  const pravidloTyp = vynucenyTyp
    ? `- typ: vždy "${vynucenyTyp}".`
    : `- typ: "montaz", pokud jde o montáž / instalaci nového zařízení (slova jako montáž, montovali,
  instalace, osazení, natažení potrubí, zakázka, akce, stavba). Jinak "servis" (servis, oprava,
  revize, čištění, porucha, kontrola úniku).`;
  const denTydne = new Date(dnes + "T12:00:00").toLocaleDateString("cs-CZ", { weekday: "long" });
  return `Jsi asistent technika klimatizací a vzduchotechniky.
Z přepisu hlasového diktátu vytáhni údaje o servisním zásahu nebo o montáži.
Dnes je ${denTydne} ${dnes}.

Pravidla:
${pravidloTyp}
- uctovani: "cn", pokud technik řekne, že se účtuje dle cenové nabídky ("dle CN", "podle nabídky",
  "dle cenovky", "nabídková cena"); "smlouva", pokud dle smlouvy ("dle smlouvy", "servisní smlouva",
  "smluvní servis", "paušál"); jinak null (účtuje se hodinově dle skutečnosti).
  U "cn" a "smlouva" hodiny ani km často nezazní – pak null, nic nedopočítávej.
- akce: jen u montáže – název akce/zakázky, jak ho technik řekne (např. "RD Novák Strakonice",
  "kancelář Kovo – VRV"). U servisu null.
- misto: obec, adresa nebo objekt.
- zakaznik: jméno osoby nebo název firmy.
- zarizeni: výrobce, typ, model, sériové číslo – co zazní.
- predmet: stručně a věcně – u servisu závada a co bylo provedeno, u montáže co se udělalo.
- servisni_ukony: provedené úkony (u servisu i montáže) jako stručný výčet oddělený čárkou, např.
  "pájení, vakuování, tlaková zkouška dusíkem, PC diagnostika, zprovoznění VZT, zprovoznění TČ,
  revize PPK, revize TČ, revize VZT, revize chladicího zařízení, kontrola těsnosti, čištění výparníku,
  doplnění chladiva". Piš s malým počátečním písmenem (kromě zkratek). Pokud žádný úkon nezazní, null.
- material: spotřební materiál (chladivo, filtry, izolace, spojovací materiál, čisticí prostředky…) včetně množství.
- nahradni_dily: vyměněné díly (kondenzátor, deska, ventilátor, motor, senzor, ventil…) včetně parametrů.
- dny: seznam pracovních dnů, každý den jedna položka, seřazené od nejstaršího.
  - Jednodenní práce = jedna položka. Datum dnes, pokud technik neřekne jinak ("včera" = předchozí den).
  - Každé datum smí být v "dny" jen JEDNOU – i když technici pracovali různě dlouho. Nikdy nerozděluj
    jeden den na víc položek podle techniků; rozdílné hodiny patří do "hodiny_technici" toho dne.
  - "Od pondělí do středy" = tři položky (pondělí, úterý, středa). Dny v týdnu ber v tomto nebo
    minulém týdnu tak, aby nebyly v budoucnu. Víkendy zahrň jen, když je technik zmíní.
  - Hodiny a km přiřaď ke konkrétním dnům podle diktátu ("v pondělí osm hodin, v úterý šest").
    "Každý den 96 km" nebo "osm hodin denně" = stejná hodnota u každého dne.
    "Celkem 20 hodin za tři dny" bez rozpisu = rozděl rovnoměrně.
  - datum: YYYY-MM-DD.
  - prace_hod, cesta_tam_hod, cesta_zpet_hod: v hodinách jako desetinné číslo
    (40 minut = 0.67, hodina a půl = 1.5, od deseti do půl jedné = 2.5).
    "Cesta" bez upřesnění znamená cestu tam. "Cesta tam a zpět hodina" = 0.5 tam a 0.5 zpět.
  - cesta_km: ujeté kilometry za ten den (tam i zpět).
    "120 km tam a zpět" = 120. "60 km tam" nebo "je to 60 kilometrů" (jedna cesta) = 120.
    "Najeto 85 km" = 85.
  - U montáže čas cesty v hodinách obvykle nezazní – pak cesta_tam_hod a cesta_zpet_hod = null.
${pravidloTechnici}
- Co v diktátu nezazní, vrať jako null. Nic si nevymýšlej.
- Oprav zjevné chyby přepisu u názvů výrobců, chladiv a dílů. Piš česky.`;
}

function chybejici(z: Zaznam, d: Den): string[] {
  const chybi: string[] = [];
  const hodinove = !z.uctovani;   // u CN a smlouvy nejsou hodiny povinné
  if (z.typ === "montaz") {
    if (!z.akce) chybi.push("název akce");
    if (hodinove && d.prace_hod === null) chybi.push("hodiny práce");
    if (hodinove && d.cesta_km === null) chybi.push("kilometry");
  } else {
    if (!z.zakaznik) chybi.push("zákazník");
    if (!z.misto) chybi.push("místo");
    if (hodinove && d.prace_hod === null) chybi.push("pracovní hodiny");
  }
  return chybi;
}

function hlaseni(z: Zaznam | null): string {
  if (!z) return "Přepis jsem uložil, ale nepodařilo se ho rozdělit do polí. Zkontroluj ho v aplikaci.";
  const chybi = [...new Set(z.dny.flatMap((d) => chybejici(z, d)))];
  const konec = chybi.length ? ` Chybí ${chybi.join(", ")}.` : "";
  const hod = z.dny.reduce((s, d) => s + (d.prace_hod ?? 0), 0);
  const km = z.dny.reduce((s, d) => s + (d.cesta_km ?? 0), 0);
  const dny = (z.dny.length > 1 ? `, ${z.dny.length} dny` : "")
    + (z.uctovani === "cn" ? ", dle cenové nabídky" : z.uctovani === "smlouva" ? ", dle smlouvy" : "");
  const clh = clovekohodiny(z);
  const ruzne = z.dny.some((d) => d.hodiny_technici && !Array.isArray(d.hodiny_technici));
  const cisla = [
    hod ? `${cesky(Math.round(hod * 100) / 100)} hodin` : "",
    ruzne ? `celkem ${cesky(Math.round(clh * 100) / 100)} člověkohodin` : "",
    km ? `${cesky(Math.round(km * 10) / 10)} kilometrů` : "",
  ].filter(Boolean).join(", ");
  // technici se ohlásí příjmením, jen když jich je víc (parťák)
  const kdo = z.technici.length > 1
    ? `, technici ${z.technici.map((j) => j.trim().split(/\s+/).slice(-1)[0]).join(" a ")}` : "";
  if (z.typ === "montaz") {
    const co = [z.akce, z.zarizeni].filter(Boolean).join(", ");
    return `Montáž uložena${co ? ": " + co : ""}${dny}${cisla ? ", " + cisla : ""}${kdo}.` + konec;
  }
  const co = [z.zakaznik, z.misto, z.zarizeni].filter(Boolean).join(", ");
  return `Uloženo${co ? ": " + co : ""}${dny}${cisla ? ", " + cisla : ""}${kdo}.` + konec;
}

function cistyDen(d: Den, dnes: string): Den {
  const km = d.cesta_km;
  return {
    datum: platneDatum(d.datum) ? d.datum : dnes,
    prace_hod: zaokrouhli(d.prace_hod),
    cesta_tam_hod: zaokrouhli(d.cesta_tam_hod),
    cesta_zpet_hod: zaokrouhli(d.cesta_zpet_hod),
    cesta_km: km === null || !Number.isFinite(km) || km < 0 ? null : Math.round(km * 10) / 10,
    technici: Array.isArray(d.technici) ? d.technici : [],
    hodiny_technici: d.hodiny_technici ?? null,
  };
}

// pole [{jmeno, hodiny}] od AI → {"jméno": hodiny} jen pro techniky dne s jinou dobou než prace_hod
function hodinyDne(d: Den): Record<string, number> | null {
  const vstup = Array.isArray(d.hodiny_technici) ? d.hodiny_technici : [];
  const out: Record<string, number> = {};
  for (const { jmeno, hodiny } of vstup) {
    const h = zaokrouhli(hodiny);
    if (h !== null && (d.technici ?? []).includes(jmeno)) out[jmeno] = h;
  }
  if (d.prace_hod === null && Object.keys(out).length) d.prace_hod = Math.max(...Object.values(out));
  for (const [j, h] of Object.entries(out)) if (h === d.prace_hod) delete out[j];
  return Object.keys(out).length ? out : null;
}

// pojistka: AI občas rozdělí jeden den na víc položek (po technicích) → sloučit podle data
function slucDny(dny: Den[]): Den[] {
  const podleData = new Map<string, Den[]>();
  for (const d of dny) (podleData.get(d.datum) ?? podleData.set(d.datum, []).get(d.datum)!).push(d);
  const out: Den[] = [];
  for (const [datum, skupina] of podleData) {
    if (skupina.length === 1) { out.push(skupina[0]); continue; }
    // hodiny každého technika: jeho údaj v hodiny_technici, jinak hodiny jeho položky
    const hodiny = new Map<string, number | null>();
    for (const d of skupina) {
      const ind = Array.isArray(d.hodiny_technici) ? d.hodiny_technici : [];
      for (const j of d.technici ?? []) {
        const h = ind.find((x) => x.jmeno === j)?.hodiny ?? d.prace_hod;
        const pred = hodiny.get(j);
        hodiny.set(j, pred == null ? h : h == null ? pred : Math.max(pred, h));
      }
    }
    const max = (vals: (number | null)[]) => {
      const v = vals.filter((x): x is number => x !== null);
      return v.length ? Math.max(...v) : null;
    };
    const prace = max([...skupina.map((d) => d.prace_hod), ...hodiny.values()]);
    out.push({
      datum,
      prace_hod: prace,
      cesta_tam_hod: max(skupina.map((d) => d.cesta_tam_hod)),
      cesta_zpet_hod: max(skupina.map((d) => d.cesta_zpet_hod)),
      cesta_km: max(skupina.map((d) => d.cesta_km)),   // jedno auto – km se nesčítají
      technici: [...hodiny.keys()],
      hodiny_technici: [...hodiny].filter(([, h]) => h !== null && h !== prace).map(([jmeno, h]) => ({ jmeno, hodiny: h })),
    });
    log("sloučeny položky dne", { datum, pocet: skupina.length });
  }
  return out.sort((a, b) => a.datum.localeCompare(b.datum));
}

// člověkohodiny za všechny dny
function clovekohodiny(z: Zaznam): number {
  return z.dny.reduce((s, d) => {
    const ind = (d.hodiny_technici ?? {}) as Record<string, number>;
    const t = d.technici ?? [];
    return s + (t.length ? t.reduce((a, j) => a + (ind[j] ?? d.prace_hod ?? 0), 0) : (d.prace_hod ?? 0));
  }, 0);
}

// ---------- akce ----------

async function novyZaznam(req: Request, userId: string): Promise<Response> {
  const typParam = new URL(req.url).searchParams.get("typ");
  const vynucenyTyp: Typ | null = typParam === "montaz" || typParam === "servis" ? typParam : null;
  const vstup = await nactiVstup(req);
  const id = crypto.randomUUID();
  let audioCesta: string | null = null;
  let text: string;

  if ("text" in vstup) {
    // Diktát už přepsaný v iPhonu (akce Diktovat text)
    text = vstup.text;
    log("text přijat", text);
    if (text.length < 5) return odpoved("Diktát je prázdný, nic jsem neuložil.", 400);
  } else {
    const { data, pripona, typ } = vstup.audio;
    log("nahrávka přijata", { bajty: data.length, typ });
    if (data.length < 1000) return odpoved("Nahrávka je prázdná, nic jsem neuložil.", 400);

    // 1) Nejdřív uložit nahrávku, ať se diktát nikdy neztratí
    audioCesta = `${userId}/${id}.${pripona}`;
    const up = await supabase.storage.from("nahravky").upload(audioCesta, data, { contentType: typ });
    if (up.error) {
      log("uložení nahrávky selhalo", up.error.message);
      audioCesta = null;
    }

    // 2) Přepis
    try {
      text = await prepis(data, pripona, typ);
      log("přepis", text);
    } catch (e) {
      log("přepis selhal", String(e));
      const { error } = await supabase.from("zaznamy").insert({
        id, user_id: userId, audio_cesta: audioCesta, ke_kontrole: true,
        typ: vynucenyTyp ?? "servis",
      });
      if (error) throw new Error(`Uložení do databáze selhalo: ${error.message}`);
      return odpoved("Nahrávku jsem uložil, ale přepis se nepovedl. Doplň záznam v aplikaci.");
    }
  }

  // 3) Rozdělení do polí
  const dnes = dnesPraha();
  let z: Zaznam | null = null;
  try {
    const technici = await nactiTechniky(userId);
    z = await strukturuj<Zaznam>(promptZaznam(dnes, vynucenyTyp, technici), text, "servisni_zaznam", schemaZaznam(technici.map((t) => t.jmeno)));
    if (vynucenyTyp) z.typ = vynucenyTyp;
    if (z.typ !== "montaz") z.akce = null;
    z.dny = (z.dny ?? []).slice(0, 31).map((d) => cistyDen(d, dnes)).sort((a, b) => a.datum.localeCompare(b.datum));
    if (!z.dny.length) z.dny = [cistyDen({ datum: dnes } as Den, dnes)];
    // jen platná jména ze seznamu; když nikdo nezazněl, je to ten, kdo diktuje
    const platna = new Set(technici.map((t) => t.jmeno));
    z.technici = [...new Set((z.technici ?? []).filter((j) => platna.has(j)))];
    for (const d of z.dny) d.technici = [...new Set((d.technici ?? []).filter((j) => platna.has(j)))];
    const ja = technici.find((t) => t.ja)?.jmeno;
    if (!z.technici.length) z.technici = [...new Set(z.dny.flatMap((d) => d.technici ?? []))];
    if (!z.technici.length && ja) z.technici = [ja];
    for (const d of z.dny) if (!d.technici?.length) d.technici = [...z.technici];
    z.dny = slucDny(z.dny);
    for (const d of z.dny) d.hodiny_technici = hodinyDne(d);
    log("struktura", z);
  } catch (e) {
    log("strukturování selhalo", String(e));
    z = null;
  }

  // 4) Uložení – jeden záznam za každý den
  let radky: Record<string, unknown>[];
  if (!z) {
    radky = [{
      id, user_id: userId, prepis: text, audio_cesta: audioCesta,
      ke_kontrole: true, datum_zasahu: dnes, typ: vynucenyTyp ?? "servis",
    }];
  } else {
    const zz = z;
    const skupina = zz.dny.length > 1 ? crypto.randomUUID() : null;
    radky = zz.dny.map((d, i) => ({
      id: i === 0 ? id : crypto.randomUUID(),
      user_id: userId,
      skupina,
      typ: zz.typ,
      uctovani: zz.uctovani === "cn" || zz.uctovani === "smlouva" ? zz.uctovani : null,
      technici: d.technici?.length ? d.technici : zz.technici,
      hodiny_technici: d.hodiny_technici && !Array.isArray(d.hodiny_technici) ? d.hodiny_technici : null,
      akce: zz.akce,
      misto: zz.misto,
      zakaznik: zz.zakaznik,
      zarizeni: zz.zarizeni,
      predmet: zz.predmet,
      servisni_ukony: i === 0 ? zz.servisni_ukony : null,
      // materiál a díly jen u prvního dne, aby se v přehledech nesčítaly vícekrát
      material: i === 0 ? zz.material : null,
      nahradni_dily: i === 0 ? zz.nahradni_dily : null,
      datum_zasahu: d.datum,
      prace_hod: d.prace_hod,
      cesta_tam_hod: d.cesta_tam_hod,
      cesta_zpet_hod: d.cesta_zpet_hod,
      cesta_km: d.cesta_km,
      prepis: text,
      audio_cesta: i === 0 ? audioCesta : null,
      ke_kontrole: chybejici(zz, d).length > 0,
    }));
  }
  const { error } = await supabase.from("zaznamy").insert(radky);
  if (error) throw new Error(`Uložení do databáze selhalo: ${error.message}`);
  log("uloženo záznamů", { pocet: radky.length, ids: radky.map((r) => r.id) });

  return odpoved(hlaseni(z));
}

// Přepis jednoho pole z appky. U hodin a km se výsledek převede na číslo.
async function prepisPole(req: Request): Promise<Response> {
  const pole = new URL(req.url).searchParams.get("pole") ?? "text";
  const { data, pripona, typ } = await nactiAudio(req);
  log("přepis pole – nahrávka", { pole, bajty: data.length, typ });
  if (data.length < 500) return odpovedJson({ chyba: "Nahrávka je prázdná." }, 400);

  const text = (await prepis(data, pripona, typ)).replace(/\s+/g, " ").trim().replace(/[.!?]$/, "");
  log("přepis pole – text", text);
  if (!text) return odpovedJson({ text: "", hodnota: null });

  if (pole === "hodiny" || pole === "km") {
    const { hodnota } = await strukturuj<{ hodnota: number | null }>(
      pole === "hodiny"
        ? "Převeď údaj o čase na hodiny jako desetinné číslo (40 minut = 0.67, hodina a půl = 1.5, " +
          "dvě a čtvrt = 2.25, od osmi do půl čtvrté = 7.5). Pokud čas nezazní, vrať null."
        : "Převeď údaj o vzdálenosti na kilometry jako číslo, jak zaznělo (sto dvacet = 120, " +
          "devadesát šest kilometrů = 96). Pokud nezazní, vrať null.",
      text,
      "hodnota_pole",
      {
        type: "object",
        additionalProperties: false,
        properties: { hodnota: NUM },
        required: ["hodnota"],
      },
    );
    const h = hodnota === null || !Number.isFinite(hodnota) || hodnota < 0 ? null : Math.round(hodnota * 100) / 100;
    log("přepis pole – číslo", h);
    return odpovedJson({ text, hodnota: h });
  }
  return odpovedJson({ text, hodnota: null });
}

async function cestaZpet(req: Request, userId: string): Promise<Response> {
  const vstup = await nactiVstup(req);
  const text = "text" in vstup
    ? vstup.text
    : await prepis(vstup.audio.data, vstup.audio.pripona, vstup.audio.typ);
  log("cesta zpět – text", text);

  const { hodiny, km } = await strukturuj<{ hodiny: number | null; km: number | null }>(
    "Z věty o zpáteční cestě urči: hodiny = délka cesty v hodinách jako desetinné číslo " +
      "(50 minut = 0.83, hodina a čtvrt = 1.25); km = ujeté kilometry zpáteční cesty. " +
      "Co nezazní, vrať jako null.",
    text,
    "cesta_zpet",
    {
      type: "object",
      additionalProperties: false,
      properties: { hodiny: NUM, km: NUM },
      required: ["hodiny", "km"],
    },
  );
  const h = zaokrouhli(hodiny);
  const k = km === null || !Number.isFinite(km) || km < 0 ? null : Math.round(km * 10) / 10;
  if (h === null && k === null) return odpoved("Nerozuměl jsem délce cesty, zkus to prosím znovu.");

  const { data: posledni, error } = await supabase
    .from("zaznamy")
    .select("id, typ, akce, zakaznik, misto, cesta_km")
    .eq("user_id", userId)
    .order("vytvoreno", { ascending: false })
    .order("datum_zasahu", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Čtení z databáze selhalo: ${error.message}`);
  if (!posledni) return odpoved("Nenašel jsem žádný záznam, ke kterému cestu přidat.");

  // km zpáteční cesty se přičtou k už uloženým km (cesta tam)
  const zmena: Record<string, number> = {};
  if (h !== null) zmena.cesta_zpet_hod = h;
  if (k !== null) zmena.cesta_km = Math.round(((Number(posledni.cesta_km) || 0) + k) * 10) / 10;
  const upd = await supabase.from("zaznamy").update(zmena).eq("id", posledni.id);
  if (upd.error) throw new Error(`Uložení selhalo: ${upd.error.message}`);
  log("cesta zpět uložena", { id: posledni.id, ...zmena });

  const kde = posledni.typ === "montaz"
    ? (posledni.akce ?? "")
    : [posledni.zakaznik, posledni.misto].filter(Boolean).join(", ");
  const co = [
    h !== null ? `${cesky(h)} hodiny` : "",
    k !== null ? `${cesky(k)} kilometrů` : "",
  ].filter(Boolean).join(", ");
  return odpoved(`Zpáteční cesta ${co} uložena${kde ? " k záznamu " + kde : ""}.`);
}

// ---------- vstupní bod ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return odpoved("Použij metodu POST.", 405);

  if (!OPENAI_API_KEY) {
    log("chybí nastavení OPENAI_API_KEY");
    return odpoved("Funkce není nastavená, chybí klíč OpenAI.", 500);
  }

  const akce = new URL(req.url).searchParams.get("akce") ?? "zaznam";
  log("požadavek", { akce });

  // mikrofon v appce – ověření přihlášením, ne tokenem zkratky
  if (akce === "prepis") {
    try {
      if (!(await uzivatelZJwt(req))) return odpovedJson({ chyba: "Nejsi přihlášený nebo účet není schválený." }, 401);
      return await prepisPole(req);
    } catch (e) {
      log("CHYBA přepisu", String(e));
      return odpovedJson({ chyba: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  const userId = (await uzivatelZTokenu(req)) ?? (await uzivatelZJwt(req));
  if (!userId) {
    log("odmítnuto – neplatný token nebo neschválený účet");
    return odpoved("Neplatný přístupový token.", 401);
  }
  log("uživatel", userId);

  try {
    if (akce === "cesta-zpet") return await cestaZpet(req, userId);
    return await novyZaznam(req, userId);
  } catch (e) {
    log("CHYBA", String(e));
    return odpoved(`Chyba: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
