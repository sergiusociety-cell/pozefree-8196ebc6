import { PhotoStyle, ImageSize, PhotoQuality, MenuAnalysisResult, AspectRatio } from "../types";
import { supabase } from "@/integrations/supabase/client";

const getSupabaseUrl = () => (import.meta as any).env?.VITE_SUPABASE_URL;

const getAuthHeaders = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Authentication required. Please sign in.");
  return {
    Authorization: `Bearer ${session.access_token}`,
    "Content-Type": "application/json",
  };
};

const callEdgeFunction = async (functionName: string, body: Record<string, unknown>) => {
  const headers = await getAuthHeaders();
  const response = await fetch(`${getSupabaseUrl()}/functions/v1/${functionName}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `${functionName} failed`);
  }

  return response.json();
};

export const PREP_TEAM_PROMPT = `[PROTOCOL 3: PREP TEAM - HYPER-REALISTIC MINIATURE KITCHEN]
MANDATE: Add 3-5 hyper-realistic miniature humans (scale 1:12-1:20) actively preparing the dish.
ABSOLUTE REQUIREMENT: Characters MUST look like 100% REAL HUMANS with photorealistic skin and unique facial features. NO PLASTIC, NO CGI, and NO TOY-LIKE appearance.
CHARACTER DETAILS:
- 3-5 unique individuals with distinct ethnicities, facial hair, and ages (25-55).
- FACE REALISM: Visible pores, natural skin tone variations, subtle veins, laugh lines, and genuine human imperfections.
DYNAMIC ACTIONS & TOOLS:
- 1 Chef wiping hands on a linen apron mid-task.
- 1 Sous Chef whisking with visible wrist rotation in a scaled stainless steel bowl.
- 1 Prep Cook mid-chopping motion on a scaled wooden grain board.
- 1 Assistant sprinkling micro-spices with visible particles caught in the air.
INTEGRATION: Characters physically interact with ingredients.
ATMOSPHERE: Warm collaborative kitchen energy (3200-4500K).`;

export const DETECTION_SQUAD_PROMPT = `[PROTOCOL 4: DETECTION SQUAD - FORENSIC FOOD INVESTIGATION]
MANDATE: Add 3-5 hyper-realistic miniature detectives investigating the dish as a crime scene evidence.
ABSOLUTE REQUIREMENT: Characters MUST be real humans with unique faces and natural skin textures.
CHARACTER DETAILS:
- 1-2 Lead Detectives in trench coats, 2-3 Forensic Specialists in clinical lab gear.
DYNAMIC ACTIONS & FORENSIC TOOLS:
- Lead detective examining a garnish through a scaled magnifying glass.
- Specialist using precision metal tweezers to carefully lift a micro-ingredient.
- Assistant placing yellow numbered evidence tents around the dish ingredients.
ATMOSPHERE: Dramatic noir/investigative mood. Cool/neutral tones (4500-5500K).`;

export const generateDishImage = async (
  dishName: string,
  dishDescription: string,
  style: PhotoStyle,
  size: ImageSize,
  quality: PhotoQuality,
  aspectRatio: AspectRatio,
  logoBase64?: string | null,
  locationBase64?: string | null,
  referenceBase64?: string | null
): Promise<string> => {
  const referenceImages: string[] = [];
  const refLegend: string[] = [];
  let logoIndex = 0;
  if (logoBase64) {
    referenceImages.push(logoBase64);
    logoIndex = referenceImages.length;
    refLegend.push(`REFERENCE IMAGE #${logoIndex} = RESTAURANT LOGO (MANDATORY USE). You MUST integrate this exact logo into the final image — failure to include it is unacceptable. MICHELIN NAPKIN BRANDING PROTOCOL: render a crisp, freshly-pressed folded white linen napkin resting elegantly beside the plate (never under or on the food). On that napkin, place THIS EXACT logo from REFERENCE IMAGE #${logoIndex}, reproduced as a subtle single-tone embroidery or fine tone-on-tone print in muted charcoal-grey or warm ivory thread. Preserve the logo's exact shape, proportions, letters, symbols and orientation 1:1 — do NOT redraw, restyle, mirror, recolor with extra colors, translate, or invent any text. Size: roughly 25–35% of the napkin's visible area, centered on one folded panel. The napkin must have soft natural folds, visible fine linen weave, and gentle realistic shadow. Refined, understated, fine-dining presentation. Never overlay the logo on the food, plate, cutlery, or background.`);
  }
  if (locationBase64) {
    referenceImages.push(locationBase64);
    refLegend.push(`REFERENCE IMAGE #${referenceImages.length} = ENVIRONMENT/LOCATION. Use it as the background context, lighting mood and color palette inspiration.`);
  }
  if (referenceBase64) {
    referenceImages.push(referenceBase64);
    refLegend.push(`REFERENCE IMAGE #${referenceImages.length} = PLATING REFERENCE. Match this plating architecture exactly.`);
  }

  const logoCritical = logoBase64
    ? `\n  [CRITICAL — LOGO ON NAPKIN]: The final image MUST contain a folded white linen napkin beside the dish, with the exact logo from REFERENCE IMAGE #${logoIndex} subtly embroidered onto it in a single muted tone. This is non-negotiable.`
    : "";

  const masterPrompt = `[MICHELIN PRODUCTION PROTOCOL] - ${dishName.toUpperCase()}
  MANDATE: Create a 100% photorealistic commercial asset.
  STYLE: ${style}
  CONTEXT: ${dishDescription}
  COMPOSITION: Perfectly level horizon, 30% negative space, cinematic bokeh.${logoCritical}
  ${refLegend.join("\n  ")}`;

  const { imageUrl } = await callEdgeFunction("generate-image", {
    action: "generate",
    prompt: masterPrompt,
    aspectRatio,
    referenceImages,
  });

  if (!imageUrl) throw new Error("API failed to return image data.");
  return imageUrl;
};

export const parseMenuText = async (text: string): Promise<MenuAnalysisResult> => {
  return callEdgeFunction("gemini-parse-menu", { text });
};

export const editDishImage = async (currentImageBase64: string, editPrompt: string): Promise<string> => {
  const { imageUrl } = await callEdgeFunction("generate-image", {
    action: "edit",
    imageBase64: currentImageBase64,
    editPrompt: `MAGIC EDIT: ${editPrompt}. Hyper-realistic execution.`,
  });

  if (!imageUrl) throw new Error("Edit failed.");
  return imageUrl;
};

export const analyzeDishNutrition = async (imageBase64: string): Promise<string> => {
  const { text } = await callEdgeFunction("gemini-nutrition", { imageBase64 });
  return text || "";
};

export async function chatWithConcierge(
  message: string,
  history: any[],
  imageBase64?: string | null
): Promise<string> {
  const { text } = await callEdgeFunction("gemini-chat", {
    message,
    history: history.map((h: any) => ({ role: h.role, text: h.text })),
    imageBase64: imageBase64 || null,
  });
  return text || "";
}

export const speakText = async (text: string): Promise<ArrayBuffer> => {
  const { audioBase64 } = await callEdgeFunction("gemini-tts", { text });
  if (!audioBase64) throw new Error("TTS failed.");

  const binary = window.atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

// Live concierge via server-side edge function (no client-side API key needed)
export const sendLiveConciergeMessage = async (
  message: string,
  audioBase64?: string | null
): Promise<{ audioBase64: string; mimeType: string }> => {
  const result = await callEdgeFunction("gemini-live-session", {
    message,
    audioBase64: audioBase64 || null,
  });
  if (!result.audioBase64) throw new Error("Live session failed.");
  return result;
};
