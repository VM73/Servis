// Supabase Edge Function „kucharka“ – přepis receptů z fotek pomocí AI
// Akce: POST ?akce=prepis  { recept_id }  → strukturovaný recept (JSON)
//       GET  ?akce=stav                    → kontrola, že funkce běží
// Secrets: AI_PROVIDER (claude | openai), ANTHROPIC_API_KEY, OPENAI_API_KEY, volitelně AI_MODEL
// Verify JWT: vypnuto – přihlášení se ověřuje níže v kódu.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const VERZE = "2";
const KURZ_USD_CZK = 23;

// Ceny za 1M tokenů v USD (vstup, výstup) – 10/2026
const CENY: Record<string, [number, number]> = {
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-5-5": [4, 20],
  "gpt-6.1-sol": [2, 10],
  "gpt-6-luna": [0.1, 0.5],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function odpoved(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------- JSON schéma výsledku (společné pro Claude i OpenAI) ----------
const nullStr = { type: ["string", "null"] };
const nullNum = { type: ["number", "null"] };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nazev", "porce", "skupiny", "postup", "poznamky", "nejista", "upozorneni", "navrh"],
  properties: {
    nazev: { type: "string", description: "Název receptu tak, jak je napsán, s velkým písmenem jen na začátku." },
    porce: { ...nullStr, description: "Počet porcí / množství (např. „1 plech“), jen pokud je v receptu." },
    skupiny: {
      type: "array",
      description: "Skupiny surovin (Těsto, Náplň, Navrch…). Bez skupin = jedna skupina s nazev null.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nazev", "suroviny"],
        properties: {
          nazev: nullStr,
          suroviny: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["mnozstvi", "cislo", "jednotka", "surovina", "gramy"],
              properties: {
                mnozstvi: { type: "string", description: "Původní zápis množství, např. „50 dkg“, „½ lžičky“, „trochu“." },
                cislo: { ...nullNum, description: "Číselná hodnota množství (50, 0.5), jinak null." },
                jednotka: { ...nullStr, description: "Jednotka v původním tvaru (dkg, g, l, lžíce…)." },
                surovina: { type: "string", description: "Surovina v původním tvaru, zkratky rozepsané (hl. → hladké)." },
                gramy: { ...nullNum, description: "Přepočet na gramy jen u hmotnostních jednotek (dkg, kg, g), jinak null." },
              },
            },
          },
        },
      },
    },
    postup: { type: "array", items: { type: "string" }, description: "Kroky postupu věrně podle originálu." },
    poznamky: { ...nullStr, description: "Poznámky na okraji nebo doporučení z kuchařky." },
    nejista: { type: "array", items: { type: "string" }, description: "Slova, která nešla spolehlivě přečíst (přesně jak jsou v přepisu)." },
    upozorneni: { type: "array", items: { type: "string" }, description: "Chybějící údaje: teplota, doba, postup končí uprostřed apod." },
    navrh: {
      type: "object",
      additionalProperties: false,
      required: ["kategorie", "podkategorie", "autor", "stitky"],
      properties: {
        kategorie: { ...nullStr, description: "Hlavní kategorie ze seznamu." },
        podkategorie: { ...nullStr, description: "Podkategorie ze seznamu, nebo nový krátký název." },
        autor: { ...nullStr, description: "Od koho recept je, pokud to plyne z textu (např. „od Štěchů“ → „Štěchovi“)." },
        stitky: { type: "array", items: { type: "string" }, description: "0–3 krátké štítky (Vánoce, rychlé…)." },
      },
    },
  },
};

function instrukce(kategorie: string, osoby: string) {
  return `Jsi pomocník rodinné kuchařky. Na fotkách jsou stránky jednoho ručně psaného receptu (česky).
Pokud je stránek víc, jde o jeden recept pokračující přes stránky – spoj ho.

Pravidla:
- Přepisuj věrně. Zachovej původní jednotky (dkg, lžíce, „půl malé lžičky“) i reálie (Hera, Iva).
- Rozepiš zkratky (hl. → hladké, pol. → polohrubé, pr. do pečiva → prášku do pečiva) a značky „-"-“ / „-,,-“ (totéž co o řádek výš).
- Nic si nedomýšlej: nedoplňuj teplotu, dobu ani kroky, které v receptu nejsou. Chybějící údaje uveď v „upozorneni“.
- Slova, která nejdou spolehlivě přečíst, přepiš nejlepším odhadem a uveď je v „nejista“.
- Ignoruj tištěné obrázky a dekorace na papíře.
- Kategorii a podkategorii vybírej z tohoto seznamu (podkategorii můžeš navrhnout novou):
${kategorie}
- Známé osoby (autoři receptů): ${osoby || "zatím žádné"}. Pokud text uvádí jinou osobu nebo rodinu, navrhni ji.`;
}

async function zavolejClaude(model: string, obrazky: string[], prompt: string) {
  const content: unknown[] = obrazky.map((data) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data },
  }));
  content.push({ type: "text", text: "Přepiš tento recept." });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: prompt,
      // Strukturovaný výstup: JSON přesně podle schématu (bez vynuceného nástroje)
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude ${r.status}: ${JSON.stringify(j.error ?? j)}`);
  if (j.stop_reason === "max_tokens") throw new Error("Claude: odpověď byla příliš dlouhá a useknutá");
  if (j.stop_reason === "refusal") throw new Error("Claude odmítl odpovědět");
  const text = (j.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  let data;
  try {
    data = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    throw new Error("Claude nevrátil platný JSON: " + text.slice(0, 200));
  }
  return { data, vstup: j.usage?.input_tokens ?? 0, vystup: j.usage?.output_tokens ?? 0 };
}

async function zavolejOpenAI(model: string, obrazky: string[], prompt: string) {
  const content: unknown[] = obrazky.map((data) => ({
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${data}` },
  }));
  content.push({ type: "text", text: "Přepiš tento recept." });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY") ?? ""}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content },
      ],
      response_format: { type: "json_schema", json_schema: { name: "recept", strict: true, schema: SCHEMA } },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${JSON.stringify(j.error ?? j)}`);
  return {
    data: JSON.parse(j.choices[0].message.content),
    vstup: j.usage?.prompt_tokens ?? 0,
    vystup: j.usage?.completion_tokens ?? 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const akce = new URL(req.url).searchParams.get("akce") ?? "";
  const provider = (Deno.env.get("AI_PROVIDER") ?? "claude").toLowerCase();

  if (akce === "stav") return odpoved({ ok: true, verze: VERZE, provider });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Ověření přihlášeného člena rodiny
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u, error: chybaUzivatele } = await admin.auth.getUser(jwt);
  if (chybaUzivatele || !u?.user) return odpoved({ chyba: "Nepřihlášen" }, 401);
  const { data: clen } = await admin.from("clenove").select("jmeno").eq("user_id", u.user.id).maybeSingle();
  if (!clen) return odpoved({ chyba: "Účet není členem kuchařky" }, 403);

  if (akce !== "prepis" || req.method !== "POST") return odpoved({ chyba: "Neznámá akce" }, 400);

  try {
    const { recept_id } = await req.json();
    if (!recept_id) return odpoved({ chyba: "Chybí recept_id" }, 400);

    const { data: stranky } = await admin.from("stranky").select("cesta").eq("recept_id", recept_id).order("poradi");
    if (!stranky?.length) return odpoved({ chyba: "Recept nemá žádné stránky" }, 400);

    const obrazky: string[] = [];
    for (const s of stranky) {
      const { data: soubor, error } = await admin.storage.from("stranky").download(s.cesta);
      if (error || !soubor) throw new Error(`Nelze načíst stránku ${s.cesta}`);
      obrazky.push(encodeBase64(new Uint8Array(await soubor.arrayBuffer())));
    }

    const { data: kat } = await admin.from("kategorie").select("id, nazev, rodic_id").order("poradi");
    const hlavni = (kat ?? []).filter((k) => !k.rodic_id);
    const seznamKat = hlavni
      .map((h) => `${h.nazev}: ${(kat ?? []).filter((k) => k.rodic_id === h.id).map((k) => k.nazev).join(", ")}`)
      .join("\n");
    const { data: osoby } = await admin.from("osoby").select("jmeno").order("jmeno");
    const prompt = instrukce(seznamKat, (osoby ?? []).map((o) => o.jmeno).join(", "));

    const model = Deno.env.get("AI_MODEL") ?? (provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5");
    const v = provider === "openai"
      ? await zavolejOpenAI(model, obrazky, prompt)
      : await zavolejClaude(model, obrazky, prompt);

    const [cIn, cOut] = CENY[model] ?? [2, 10];
    const cenaKc = Math.round(((v.vstup * cIn + v.vystup * cOut) / 1e6) * KURZ_USD_CZK * 100) / 100;

    return odpoved({ recept: v.data, model, tokeny: { vstup: v.vstup, vystup: v.vystup }, cena_kc: cenaKc });
  } catch (e) {
    console.error(e);
    return odpoved({ chyba: String((e as Error).message ?? e) }, 500);
  }
});
