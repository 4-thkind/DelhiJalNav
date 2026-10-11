/**
 * Every user-facing string for the route/report flow, English and Hindi, in one
 * table. Hindi needs review by a fluent speaker before recording (brief 13.3).
 */
import type { HazardStateName, ObservationKind } from "./contracts.ts";

export type Lang = "en" | "hi";

const STRINGS = {
  tagline: { en: "Recent water reports. Better route decisions.", hi: "ताज़ा जलभराव रिपोर्ट। बेहतर रास्ते का फ़ैसला।" },
  compare: { en: "Compare routes", hi: "रास्ते तुलना करें" },
  report: { en: "Report conditions", hi: "स्थिति बताएं" },
  camera: { en: "Camera calibration", hi: "कैमरा कैलिब्रेशन" },
  startRide: { en: "Start ride", hi: "राइड शुरू करें" },
  preview: { en: "Preview route", hi: "रास्ता देखें" },
  why: { en: "Why this route?", hi: "यह रास्ता क्यों?" },
  coverage: { en: "Pilot coverage: selected corridor", hi: "पायलट कवरेज: चुना हुआ रास्ता" },
  geometryPending: { en: "Road geometry not yet human-reviewed", hi: "सड़क का नक्शा अभी जाँचा नहीं गया" },
  take: { en: "Suggested", hi: "सुझाया गया" },
  avoid: { en: "Avoided", hi: "टाला गया" },
  available: { en: "Also possible", hi: "यह भी संभव" },
  noAlternative: {
    en: "No supported alternative found. Conditions need checking before travel.",
    hi: "कोई समर्थित वैकल्पिक रास्ता नहीं मिला। निकलने से पहले स्थिति जाँचें।",
  },
  noReports: {
    en: "No current waterlogging reports on the assessed segments.",
    hi: "जाँचे गए हिस्सों पर अभी जलभराव की कोई रिपोर्ट नहीं है।",
  },
  notSafetyClaim: {
    en: "This is not a safety guarantee. Roads outside the assessed underpass are not checked.",
    hi: "यह सुरक्षा की गारंटी नहीं है। जाँचे गए अंडरपास के बाहर की सड़कें नहीं देखी गईं।",
  },
  extra: { en: "Detour adds", hi: "चक्कर में ज़्यादा" },
  staleWarning: {
    en: "Earlier reports have aged out and nobody has confirmed the road is clear. Still avoiding it.",
    hi: "पुरानी रिपोर्ट की समय-सीमा खत्म हो गई है, पर रास्ता साफ़ होने की पुष्टि नहीं हुई। अब भी इससे बचें।",
  },
  savedRoute: { en: "Saved route - not current. Reconnect to recheck.", hi: "सहेजा रास्ता - ताज़ा नहीं। दोबारा जाँचने के लिए कनेक्ट करें।" },
  outdated: { en: "Outdated - recalculation failed", hi: "पुराना - दोबारा गणना नहीं हो पाई" },
  newReport: { en: "New report received", hi: "नई रिपोर्ट मिली" },
  recalculated: { en: "Route recalculated", hi: "रास्ता दोबारा तय किया गया" },
  offline: { en: "Offline · last synced", hi: "ऑफ़लाइन · आख़िरी सिंक" },
  neverSynced: { en: "never", hi: "कभी नहीं" },
  providerDown: { en: "Route comparison is unavailable right now.", hi: "अभी रास्तों की तुलना उपलब्ध नहीं है।" },
  outside: { en: "Outside the pilot corridor.", hi: "पायलट क्षेत्र से बाहर।" },
  queued: { en: "Queued reports", hi: "कतार में रिपोर्ट" },
  alertPhrase: {
    en: "Waterlogging has been reported ahead. Stop and check another route.",
    hi: "आगे जलभराव की रिपोर्ट है। रुक कर दूसरा रास्ता देखें।",
  },
  play: { en: "Play advisory", hi: "सलाह सुनें" },
  reviewTitle: { en: "We understood", hi: "हमने समझा" },
  submit: { en: "Submit report", hi: "रिपोर्ट भेजें" },
  edit: { en: "Edit", hi: "बदलें" },
  next: { en: "Review", hi: "जाँचें" },
  back: { en: "Back", hi: "वापस" },
  minutesAgo: { en: "min ago", hi: "मिनट पहले" },
  justNow: { en: "just now", hi: "अभी" },
  sources: { en: "distinct sources", hi: "अलग स्रोत" },
  startNav: { en: "Preview route", hi: "रास्ता देखें" },
  stopNav: { en: "End preview", hi: "प्रीव्यू बंद" },
  share: { en: "Share trip", hi: "यात्रा साझा करें" },
  sos: { en: "SOS", hi: "SOS" },
  keepOriginal: { en: "Keep original route", hi: "पुराना रास्ता रखें" },
  acceptBypass: { en: "Accept bypass", hi: "बाईपास लें" },
  rerouteNotice: { en: "REROUTE NOTICE", hi: "रास्ता बदला" },
  bypassed: { en: "bypassed", hi: "टाला गया" },
  keptWarning: {
    en: "You chose the original route through reported water. Depth is unverified. Do not enter water.",
    hi: "आपने रिपोर्ट किए पानी वाला पुराना रास्ता चुना। गहराई अपुष्ट है। पानी में न जाएं।",
  },
  tapHint: { en: "Tap the map to set a destination", hi: "मंज़िल चुनने के लिए नक्शे पर टैप करें" },
  tapStartHint: { en: "Tap the map to set the start", hi: "शुरुआत चुनने के लिए नक्शे पर टैप करें" },
  setStart: { en: "Set start on map", hi: "नक्शे पर शुरुआत" },
  myLocation: { en: "Use my location", hi: "मेरी लोकेशन" },
  presetRoute: { en: "Preset route", hi: "तय रास्ता" },
  recenter: { en: "Re-center", hi: "बीच में लाएं" },
  simulated: { en: "Simulated drive · demo", hi: "सिम्युलेटेड ड्राइव · डेमो" },
  savdhaan: {
    en: "Caution! Waterlogging reported at Minto Bridge. Taking the flyover bypass.",
    hi: "सावधान! मिंटो ब्रिज पर जलभराव की रिपोर्ट है। फ्लाईओवर बाईपास ले रहे हैं।",
  },
  autofill: { en: "Auto-fill from text", hi: "टेक्स्ट से भरें" },
  speak: { en: "Speak", hi: "बोलें" },
  depth: { en: "Water depth (your estimate)", hi: "पानी की गहराई (आपका अंदाज़ा)" },
  stalled: { en: "Stalled vehicles seen", hi: "फंसे वाहन दिखे" },
  rainContext: { en: "Rain (model)", hi: "बारिश (मॉडल)" },
  rainAdvisory: {
    en: "Heavy rain forecast near the corridor. No reports yet - conditions may change. Rain alone never closes a road here.",
    hi: "इलाके में भारी बारिश का पूर्वानुमान। अभी कोई रिपोर्ट नहीं - हालात बदल सकते हैं। सिर्फ़ बारिश से रास्ता बंद नहीं माना जाता।",
  },
  cameraAvoid: { en: "Avoiding water your camera flagged - only for you, for 20 min.", hi: "आपके कैमरे ने जो पानी देखा उससे बचाव - सिर्फ़ आपके लिए, 20 मिनट।" },
  clear: { en: "Clear", hi: "हटाएं" },
  demoWater: { en: "Demo: camera sees water at the underpass", hi: "डेमो: कैमरे को अंडरपास पर पानी दिखा" },
  layoutAuto: { en: "Auto", hi: "ऑटो" },
  layoutPhone: { en: "Phone", hi: "फ़ोन" },
  layoutCar: { en: "Car", hi: "कार" },
} as const;

export const VEHICLE_LABEL: Record<string, Record<Lang, string>> = {
  two_wheeler: { en: "Two-wheeler", hi: "दोपहिया" },
  auto: { en: "Auto", hi: "ऑटो" },
  car: { en: "Car", hi: "कार" },
  suv: { en: "SUV", hi: "SUV" },
  ev: { en: "EV", hi: "EV" },
};

/** Shown when a restriction is active. No vehicle is cleared through reported water. */
export const VEHICLE_BADGE: Record<string, Record<Lang, string>> = {
  two_wheeler: { en: "Underpass bypass active for two-wheelers", hi: "दोपहिया के लिए अंडरपास बाईपास" },
  auto: { en: "Auto-safe corridor: underpass avoided", hi: "ऑटो के लिए अंडरपास टाला गया" },
  car: { en: "Avoiding reported water at the underpass", hi: "अंडरपास के पानी से बचाव" },
  suv: {
    en: "High clearance does not override reports - depth is unverified, underpass still avoided",
    hi: "ऊँची गाड़ी भी नहीं - गहराई अपुष्ट है, अंडरपास टाला गया",
  },
  ev: { en: "EV battery protection: underpass avoided", hi: "EV बैटरी सुरक्षा: अंडरपास टाला गया" },
};

export const DEPTH_LABEL: Record<string, Record<Lang, string>> = {
  ankle: { en: "Ankle (<15 cm)", hi: "टखने तक (<15 cm)" },
  knee: { en: "Knee (15–30 cm)", hi: "घुटने तक (15–30 cm)" },
  waist: { en: "Waist (30–45 cm)", hi: "कमर तक (30–45 cm)" },
  submerged: { en: "Submerged (>45 cm)", hi: "डूबा हुआ (>45 cm)" },
};

export type Key = keyof typeof STRINGS;

export const STATE_LABEL: Record<HazardStateName, Record<Lang, string>> = {
  UNKNOWN: { en: "No current reports", hi: "कोई ताज़ा रिपोर्ट नहीं" },
  REPORTED: { en: "Reported", hi: "रिपोर्ट हुई" },
  CORROBORATED: { en: "Corroborated", hi: "पुष्टि (कई स्रोत)" },
  CONFLICTED: { en: "Conflicting reports", hi: "विरोधी रिपोर्ट" },
  STALE: { en: "Stale - unresolved", hi: "पुरानी - अनसुलझी" },
  RECENTLY_CLEAR_REPORTED: { en: "Recently reported clear", hi: "हाल में साफ़ बताया गया" },
};

export const STATE_EXPLAIN: Record<HazardStateName, Record<Lang, string>> = {
  UNKNOWN: { en: "No adequate recent evidence. Unknown is not the same as dry.", hi: "पर्याप्त ताज़ा जानकारी नहीं। अनजान का मतलब सूखा नहीं।" },
  REPORTED: { en: "One fresh report of water or blockage. Avoided as a precaution.", hi: "पानी या रुकावट की एक ताज़ा रिपोर्ट। सावधानी के लिए टाला गया।" },
  CORROBORATED: { en: "Two or more separate contributors agree. This is agreement, not physical verification.", hi: "दो या ज़्यादा अलग लोग सहमत हैं। यह सहमति है, भौतिक पुष्टि नहीं।" },
  CONFLICTED: { en: "Newer reports disagree. Still avoided until a reviewer checks.", hi: "नई रिपोर्ट में असहमति है। समीक्षा तक टाला गया।" },
  STALE: { en: "Water was reported earlier; no recent reports either way. Not treated as clear.", hi: "पहले पानी बताया गया था; अब कोई ताज़ा रिपोर्ट नहीं। साफ़ नहीं माना गया।" },
  RECENTLY_CLEAR_REPORTED: { en: "A community reviewer accepted two newer no-water reports. Not official clearance.", hi: "समुदाय समीक्षक ने दो नई 'पानी नहीं' रिपोर्ट मानी। यह आधिकारिक मंज़ूरी नहीं।" },
};

export const KIND_LABEL: Record<ObservationKind, Record<Lang, string>> = {
  WATER_OBSERVED: { en: "Water on the road", hi: "सड़क पर पानी" },
  ROAD_BLOCKED_REPORTED: { en: "Road blocked", hi: "रास्ता बंद" },
  NO_WATER_OBSERVED: { en: "No water seen", hi: "पानी नहीं दिखा" },
  UNSURE: { en: "Not sure", hi: "पक्का नहीं" },
};

export const REASON_LABEL: Record<string, Record<Lang, string>> = {
  CROSSES_RESTRICTED_HOTSPOT: { en: "passes through the affected underpass", hi: "प्रभावित अंडरपास से गुज़रता है" },
  AMBIGUOUS_ROAD_LEVEL: { en: "road level at the crossing is unverified", hi: "क्रॉसिंग पर सड़क का स्तर अपुष्ट" },
  RIDER_CAMERA_WATER: { en: "your camera flagged possible water here", hi: "आपके कैमरे ने यहाँ पानी देखा" },
};

let lang: Lang = "en";
try {
  if (localStorage.getItem("dillijalnav.lang") === "hi") lang = "hi";
} catch {
  /* storage blocked: default English */
}

export const getLang = (): Lang => lang;

export function setLang(next: Lang): void {
  lang = next;
  document.documentElement.lang = next;
  try {
    localStorage.setItem("dillijalnav.lang", next);
  } catch {
    /* not fatal */
  }
}

export const t = (key: Key): string => STRINGS[key][lang];
export const pick = (table: Record<string, Record<Lang, string>>, key: string): string => table[key]?.[lang] ?? key;

/** "3 min ago" from an ISO time and the server-relative now. */
export function age(isoTime: string | null, nowMs: number): string {
  if (!isoTime) return "—";
  const minutes = Math.floor((nowMs - Date.parse(isoTime)) / 60_000);
  return minutes < 1 ? t("justNow") : `${minutes} ${t("minutesAgo")}`;
}

/**
 * Spoken ride alerts, English and Hindi (Devanagari for the voice, Hinglish
 * phonetic kept for review). `{name}` / `{m}` are filled in by alertText.
 * Camera water is always "possible": the cue is a heuristic, never a claim.
 */
export const ALERTS = {
  WATER_AHEAD: {
    en: { text: "Possible water ahead - slow down", spoken: "Caution. Possible water ahead. Slow down." },
    hi: { text: "आगे पानी हो सकता है - धीरे चलें", spoken: "सावधान! आगे पानी हो सकता है। धीरे चलें।", phonetic: "Savdhaan! Aage paani ho sakta hai. Dheere chalein." },
  },
  WATER_REROUTE: {
    en: { text: "Possible water ahead - finding a way around", spoken: "Caution. Possible water ahead. Finding a route around it." },
    hi: { text: "आगे पानी हो सकता है - नया रास्ता", spoken: "सावधान! आगे पानी हो सकता है। नया रास्ता चुना जा रहा है।", phonetic: "Savdhaan! Aage paani ho sakta hai. Naya raasta chuna ja raha hai." },
  },
  DEEP_POTHOLE: {
    en: { text: "Deep pothole in your lane", spoken: "Caution. Deep pothole ahead in your lane. Slow down." },
    hi: { text: "आपकी लेन में गहरा गड्ढा", spoken: "सावधान! आगे आपकी लेन में गहरा गड्ढा है। गति धीमी करें।", phonetic: "Savdhaan! Aage gehra gaddha hai. Speed dheemi karein." },
  },
  POTHOLE: {
    en: { text: "Pothole ahead", spoken: "Pothole ahead, {m} metres." },
    hi: { text: "आगे गड्ढा", spoken: "आगे गड्ढा, {m} मीटर।", phonetic: "Aage gaddha, {m} meter." },
  },
  HOTSPOT_REPORTED: {
    en: { text: "Water reported at {name}", spoken: "Caution. Waterlogging reported at {name}. Do not enter water." },
    hi: { text: "{name} पर पानी की रिपोर्ट", spoken: "सावधान! {name} पर जलभराव की रिपोर्ट है। पानी में न जाएं।", phonetic: "Savdhaan! {name} par jalbharaav ki report hai." },
  },
  ROUTE_UPDATED: {
    en: { text: "Route updated", spoken: "Route updated." },
    hi: { text: "रास्ता बदला गया", spoken: "रास्ता बदला गया।", phonetic: "Raasta badla gaya." },
  },
  RIDE_CAMERA: {
    en: { text: "Camera mode", spoken: "Ride started. Watching the road." },
    hi: { text: "कैमरा मोड", spoken: "राइड शुरू। कैमरा सड़क देख रहा है।", phonetic: "Ride shuru. Camera sadak dekh raha hai." },
  },
  RIDE_POCKET: {
    en: { text: "Pocket mode - camera off, voice guidance on", spoken: "Pocket mode. Camera off. Voice guidance on." },
    hi: { text: "पॉकेट मोड - कैमरा बंद, आवाज़ से रास्ता", spoken: "पॉकेट मोड। कैमरा बंद। आवाज़ से रास्ता बताया जाएगा।", phonetic: "Pocket mode. Camera band." },
  },
  ARRIVED: {
    en: { text: "You have arrived", spoken: "You have arrived." },
    hi: { text: "आप पहुँच गए", spoken: "आप मंज़िल पर पहुँच गए।", phonetic: "Aap manzil par pahunch gaye." },
  },
} as const;

export type AlertKey = keyof typeof ALERTS;

export function alertText(key: AlertKey, vars: Record<string, string | number> = {}): { text: string; spoken: string; voiceLang: string } {
  const a = ALERTS[key][lang];
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  return { text: fill(a.text), spoken: fill(a.spoken), voiceLang: lang === "hi" ? "hi-IN" : "en-IN" };
}
