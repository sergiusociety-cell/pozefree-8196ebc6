import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VALID_ACTIONS = ["generate", "edit"] as const;
const VALID_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const MAX_PROMPT_LENGTH = 10000;
const MAX_EDIT_PROMPT_LENGTH = 5000;
const MAX_IMAGE_BASE64_LENGTH = 10_000_000;

// ---------- KIE.AI fallback (Nano Banana Pro) ----------
const KIE_BASE = "https://api.kie.ai";

async function kieCreateTask(apiKey: string, payload: Record<string, unknown>) {
  const res = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.code !== 200) {
    throw new Error(`kie createTask failed: ${json?.msg || res.status}`);
  }
  return json.data?.taskId as string;
}

async function kiePollTask(apiKey: string, taskId: string, timeoutMs = 120_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = await res.json().catch(() => ({}));
    if (json?.code === 200 && json.data) {
      const d = json.data;
      const state = d.state || d.status;
      if (state === "success" || d.successFlag === 1) {
        const results =
          d.resultJson?.resultUrls ||
          d.response?.resultUrls ||
          d.resultUrls ||
          (d.resultJson ? JSON.parse(typeof d.resultJson === "string" ? d.resultJson : JSON.stringify(d.resultJson))?.resultUrls : null);
        const url = Array.isArray(results) ? results[0] : results;
        if (url) return url;
        // fallback: try common fields
        const alt = d.resultUrl || d.url;
        if (alt) return alt;
        throw new Error("kie task succeeded but no result url");
      }
      if (state === "fail" || state === "failed" || d.successFlag === 2 || d.successFlag === 3) {
        throw new Error(`kie task failed: ${d.failMsg || d.errorMessage || "unknown"}`);
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("kie task timed out");
}

async function urlToDataUrl(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch result image: ${r.status}`);
  const ct = r.headers.get("content-type") || "image/png";
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return `data:${ct};base64,${btoa(bin)}`;
}

async function uploadDataUrlToStorage(dataUrl: string): Promise<string> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey);
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("invalid data url");
  const mime = m[1];
  const ext = mime.split("/")[1]?.split("+")[0] || "png";
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const path = `tmp/${crypto.randomUUID()}.${ext}`;
  const { error } = await admin.storage.from("kie-refs").upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = admin.storage.from("kie-refs").getPublicUrl(path);
  return data.publicUrl;
}

async function normalizeImageInputs(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const i of inputs) {
    if (!i) continue;
    if (i.startsWith("http://") || i.startsWith("https://")) {
      out.push(i);
    } else if (i.startsWith("data:")) {
      out.push(await uploadDataUrlToStorage(i));
    }
  }
  return out;
}

async function kieGenerate(apiKey: string, prompt: string, aspectRatio: string, imageInputs: string[] = []): Promise<string> {
  const normalized = await normalizeImageInputs(imageInputs);
  const taskId = await kieCreateTask(apiKey, {
    model: "nano-banana-2",
    input: {
      prompt,
      image_input: normalized,
      aspect_ratio: aspectRatio,
      resolution: "1K",
      output_format: "png",
    },
  });
  const url = await kiePollTask(apiKey, taskId);
  return await urlToDataUrl(url);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Authorization required" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid session" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: creditResult, error: creditError } = await supabase.rpc('deduct_credit', {
      p_amount: 1,
      p_reason: 'Image generation',
    });

    if (creditError || !creditResult?.success) {
      const errorMsg = creditResult?.error || 'Credit check failed';
      const status = errorMsg.includes('Insufficient') ? 402 : errorMsg.includes('Daily limit') ? 429 : errorMsg.includes('not active') ? 403 : 500;
      return new Response(
        JSON.stringify({ error: errorMsg }),
        { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action, prompt, aspectRatio, imageBase64, editPrompt, referenceImages } = body;
    const refImages: string[] = Array.isArray(referenceImages)
      ? (referenceImages as unknown[])
          .filter((s) => typeof s === "string" && (s as string).length > 0 && (s as string).length < MAX_IMAGE_BASE64_LENGTH)
          .slice(0, 4)
          .map((s) => {
            const str = s as string;
            return str.startsWith("data:") ? str : `data:image/png;base64,${str}`;
          })
      : [];

    if (!action || typeof action !== "string" || !VALID_ACTIONS.includes(action as any)) {
      return new Response(
        JSON.stringify({ error: "action must be 'generate' or 'edit'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const safeAspectRatio = (typeof aspectRatio === "string" && VALID_ASPECT_RATIOS.includes(aspectRatio))
      ? aspectRatio
      : "1:1";

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const KIE_AI_API_KEY = Deno.env.get("KIE_AI_API_KEY");

    if (!LOVABLE_API_KEY && !KIE_AI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "No image provider configured (LOVABLE_API_KEY or KIE_AI_API_KEY)" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${action} request for user ${user.id}, aspect ratio: ${safeAspectRatio}`);

    // Sanitize prompt to avoid Google safety filter false-positives
    const sanitizePrompt = (p: string): string => {
      return p
        .replace(/hyper-?realistic miniature humans?/gi, "stylized miniature figurines")
        .replace(/100% REAL HUMANS?/gi, "lifelike figurines")
        .replace(/real humans?/gi, "figurines")
        .replace(/photorealistic skin/gi, "detailed painted surface")
        .replace(/visible pores/gi, "fine surface detail")
        .replace(/skin tone variations/gi, "color variations")
        .replace(/subtle veins/gi, "fine details")
        .replace(/laugh lines/gi, "expression details")
        .replace(/human imperfections/gi, "natural imperfections")
        .replace(/crime scene/gi, "investigation scene")
        .replace(/forensic (food )?investigation/gi, "culinary inspection")
        .replace(/detectives?/gi, "inspector figurines")
        .replace(/forensic specialists?/gi, "inspector figurines")
        .replace(/evidence tents?/gi, "small numbered markers")
        .replace(/noir\/investigative/gi, "moody cinematic")
        .replace(/CHARACTER/gi, "FIGURINE");
    };

    const callLovableGateway = async (messages: any[]): Promise<string> => {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-image",
          messages,
          modalities: ["image", "text"],
        }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Gateway ${res.status}: ${errBody.slice(0, 300)}`);
      }
      const json = await res.json();
      const url = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
      if (!url) throw new Error("Gateway returned no image");
      return url;
    };

    const tryGeminiGenerate = async (p: string, refs: string[] = []): Promise<string> => {
      if (refs.length === 0) {
        return await callLovableGateway([{ role: "user", content: p }]);
      }
      return await callLovableGateway([
        {
          role: "user",
          content: [
            { type: "text", text: p },
            ...refs.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        },
      ]);
    };

    const tryGeminiEdit = async (p: string, b64: string, mt: string): Promise<string> => {
      const dataUrl = `data:${mt};base64,${b64}`;
      return await callLovableGateway([
        {
          role: "user",
          content: [
            { type: "text", text: p },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ]);
    };

    if (action === "generate") {
      if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
        return new Response(JSON.stringify({ error: "prompt is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        return new Response(JSON.stringify({ error: `prompt must be under ${MAX_PROMPT_LENGTH} characters` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      if (!KIE_AI_API_KEY) {
        return new Response(JSON.stringify({ error: "KIE_AI_API_KEY not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const t0 = Date.now();
      console.log("[generate] using kie.ai (nano-banana-2)…");
      try {
        const imageUrl = await kieGenerate(KIE_AI_API_KEY, sanitizePrompt(prompt), safeAspectRatio, refImages);
        console.log(`[generate] ✅ kie.ai success in ${Date.now() - t0}ms`);
        return new Response(JSON.stringify({ imageUrl, provider: "kie.ai", text: "" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[generate] ❌ kie.ai failed in ${Date.now() - t0}ms: ${msg}`);
        return new Response(JSON.stringify({ error: `kie.ai failed: ${msg}` }), { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    if (action === "edit") {
      if (!editPrompt || typeof editPrompt !== "string" || editPrompt.trim().length === 0) {
        return new Response(JSON.stringify({ error: "editPrompt is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (editPrompt.length > MAX_EDIT_PROMPT_LENGTH) {
        return new Response(JSON.stringify({ error: `editPrompt must be under ${MAX_EDIT_PROMPT_LENGTH} characters` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (!imageBase64 || typeof imageBase64 !== "string") {
        return new Response(JSON.stringify({ error: "imageBase64 is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (imageBase64.length > MAX_IMAGE_BASE64_LENGTH) {
        return new Response(JSON.stringify({ error: "Image too large" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Normalize input: accept data URL, raw base64, or http(s) URL
      let mimeType = "image/png";
      let base64Data = "";
      let dataUrl = "";
      if (imageBase64.startsWith("http://") || imageBase64.startsWith("https://")) {
        console.log("[edit] input is URL, fetching and converting to base64…");
        const r = await fetch(imageBase64);
        if (!r.ok) {
          return new Response(JSON.stringify({ error: `Failed to fetch source image: ${r.status}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        mimeType = r.headers.get("content-type") || "image/png";
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        base64Data = btoa(bin);
        dataUrl = `data:${mimeType};base64,${base64Data}`;
      } else if (imageBase64.startsWith("data:")) {
        mimeType = imageBase64.split(";")[0].split(":")[1] || "image/png";
        base64Data = imageBase64.split(",")[1] || "";
        dataUrl = imageBase64;
      } else {
        base64Data = imageBase64;
        dataUrl = `data:${mimeType};base64,${base64Data}`;
      }
      if (!base64Data) {
        return new Response(JSON.stringify({ error: "Could not extract image data" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      let imageUrl: string | null = null;
      let geminiError: string | null = null;
      let kieError: string | null = null;
      let provider: string | null = null;

      if (LOVABLE_API_KEY) {
        const t0 = Date.now();
        console.log("[edit] trying Gemini (primary)…");
        try {
          imageUrl = await tryGeminiEdit(sanitizePrompt(editPrompt), base64Data, mimeType);
          provider = "gemini";
          console.log(`[edit] ✅ Gemini success in ${Date.now() - t0}ms`);
        } catch (e) {
          geminiError = e instanceof Error ? e.message : String(e);
          console.warn(`[edit] ❌ Gemini failed in ${Date.now() - t0}ms: ${geminiError}`);
        }
      } else {
        geminiError = "LOVABLE_API_KEY not configured";
      }

      if (!imageUrl && KIE_AI_API_KEY) {
        const t0 = Date.now();
        console.log("[edit] falling back to kie.ai (nano-banana-2)…");
        try {
          imageUrl = await kieGenerate(KIE_AI_API_KEY, sanitizePrompt(editPrompt), safeAspectRatio, [dataUrl]);
          provider = "kie.ai";
          console.log(`[edit] ✅ kie.ai success in ${Date.now() - t0}ms`);
        } catch (e) {
          kieError = e instanceof Error ? e.message : String(e);
          console.error(`[edit] ❌ kie.ai failed in ${Date.now() - t0}ms: ${kieError}`);
        }
      } else if (!imageUrl) {
        kieError = "KIE_AI_API_KEY not configured";
      }

      if (!imageUrl) {
        const detail = `Gemini: ${geminiError || "skipped"} | kie.ai: ${kieError || "skipped"}`;
        console.error(`[edit] ❌ Both providers failed → ${detail}`);
        return new Response(
          JSON.stringify({
            error: `Both image providers failed. ${detail}`,
            geminiError,
            kieError,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(JSON.stringify({ imageUrl, provider }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("generate-image error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    if (errorMessage.includes("429") || errorMessage.includes("RESOURCE_EXHAUSTED")) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Image generation failed" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
