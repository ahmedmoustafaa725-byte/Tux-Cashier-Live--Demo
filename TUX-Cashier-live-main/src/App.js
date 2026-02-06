import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";
import {
  getFirestore,
  serverTimestamp,
  Timestamp,
  collection,
  addDoc,
  updateDoc,
  getDoc,
  setDoc,
  getDocs,
  onSnapshot,
  query,
  orderBy,
  where,
  doc as fsDoc,
  writeBatch,
  runTransaction, // <-- atomic counter
} from "firebase/firestore";

export const toIso = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Timestamp) return v.toDate().toISOString();
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
};

function toMillis(value) {
  if (!value) return undefined;
  if (value instanceof Date) return value.getTime();
  if (value instanceof Timestamp) return value.toMillis();
  const parsed = new Date(value);
  return Number.isNaN(+parsed) ? undefined : parsed.getTime();
}

const FIRESTORE_SENTINEL_KEY = "_methodName";
export function sanitizeForFirestore(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number(value);
  }
  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => sanitizeForFirestore(item))
      .filter((item) => item !== undefined);
    return cleaned;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Timestamp) return value;
  if (typeof value === "object") {
    if (value && typeof value[FIRESTORE_SENTINEL_KEY] === "string") return value;
    const out = {};
    for (const [key, inner] of Object.entries(value || {})) {
      const cleaned = sanitizeForFirestore(inner);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

const PAYMENT_METHOD_ALIASES = [
  { test: /(cash|cod|on[-\s]?delivery)/i, label: "Cash" },
  { test: /(insta\s*pay|instapay|bank\s*transfer|transfer|iban|wallet|vodafone|aman|meeza|valu)/i, label: "Instapay" },
  { test: /(card|visa|master|mada|credit|debit|pos)/i, label: "Card" },
  { test: /fawry/i, label: "Fawry" },
  { test: /wallet/i, label: "Wallet" },
];

function normalizePaymentMethodName(method) {
  if (method == null) return "";
  const raw = String(method || "").trim();
  if (!raw) return "";
  for (const { test, label } of PAYMENT_METHOD_ALIASES) {
    if (test.test(raw)) return label;
  }
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseNumericAmount(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const match = value.match(/-?\d+(?:[.,]\d+)?/g);
    if (!match) return null;
    for (const fragment of match) {
      const normalized = Number(fragment.replace(/,/g, ""));
      if (Number.isFinite(normalized)) return normalized;
    }
    return null;
  }
  return null;
}

function addPaymentPart(parts, method, amount, options = {}) {
  const { explicit = false } = options || {};
  const label = normalizePaymentMethodName(method);
  const numeric = parseNumericAmount(amount);
  if (!label || numeric == null) return null;
  const fixed = Number(numeric.toFixed(2));
  if (!fixed && fixed !== 0) return null;
  const existing = parts.find((p) => p.method === label);
  if (existing) {
    if (explicit) {
      if (existing.__explicit) {
        existing.amount = Number((Number(existing.amount || 0) + fixed).toFixed(2));
      } else {
        existing.amount = fixed;
        existing.__explicit = true;
      }
    } else {
      if (existing.__explicit) return existing.method;
      existing.amount = Number((Number(existing.amount || 0) + fixed).toFixed(2));
    }
    return existing.method;
  }
  const entry = { method: label, amount: fixed };
  if (explicit) entry.__explicit = true;
  parts.push(entry);
  return label;
}

function extractPaymentPartsFromSource(source = {}, total, fallbackMethod) {
  const parts = [];
  const structuralKeyPattern =
    /^(amount|value|total|price|qty|quantity|payment|due|method|type|name|label|title|mode|note|notes)$/i;

  const considerEntry = (methodLike, amountLike, options = {}) => {
    addPaymentPart(parts, methodLike, amountLike, options);
  };



  const compositeMethodPattern =
    /^(cash|insta\s*pay|instapay|card|visa|master|mada|meeza|wallet|fawry|valu|bank|transfer|vodafone|aman|pos|credit|debit)[_\s-]?(amount|value|total|price|paid|payment|due)$/i;
  const compositeAmountPattern =
    /^(amount|value|total|price|paid|payment|due)[_\s-]?(cash|insta\s*pay|instapay|card|visa|master|mada|meeza|wallet|fawry|valu|bank|transfer|vodafone|aman|pos|credit|debit)$/i;

 const considerPrimitiveEntry = (key, value, options = {}) => {
    if (value == null) return;
    const rawKey = String(key || "");
    const lowerKey = rawKey.toLowerCase();
    const compositeMethodMatch = rawKey.match(compositeMethodPattern);
    if (compositeMethodMatch) {
      considerEntry(compositeMethodMatch[1], value, options);
      return;
    }
    const compositeAmountMatch = rawKey.match(compositeAmountPattern);
    if (compositeAmountMatch) {
      considerEntry(compositeAmountMatch[2], value, options);
      return;
    }
    const normalizedKey = normalizePaymentMethodName(key);
    if (!normalizedKey) {
      if (typeof value === "string") considerString(value, options);
      return;
    }
    const lowerNormalized = normalizedKey.toLowerCase();
    const isStructural =
      structuralKeyPattern.test(lowerNormalized) ||
      (!/(cash|insta|card|visa|master|wallet|fawry|valu|bank|transfer)/i.test(lowerKey) &&
        /(amount|value|total|price|qty|quantity|payment|due)/i.test(lowerKey));
    if (isStructural) {
      if (typeof value === "string") considerString(value, options);
      return;
    }
    considerEntry(normalizedKey, value, options);
  };

  const considerMethodAmountPairs = (entries = [], options = {}) => {
    if (!entries.length) return;
    const methodMap = new Map();
    const amountMap = new Map();
    for (const [key, rawValue] of entries) {
      if (rawValue == null) continue;
      if (typeof rawValue === "object" && !Array.isArray(rawValue)) continue;
      const keyStr = String(key || "");
      const lowerKey = keyStr.toLowerCase();
      const methodMatch = lowerKey.match(/(method|paymethod|paymentmethod|paymenttype|paytype|type|mode|channel|option|choice)(?:[_\s-]*([a-z0-9]+))$/i);
      if (methodMatch && methodMatch[2]) {
        methodMap.set(methodMatch[2].toLowerCase(), rawValue);
        continue;
      }
      const amountMatch = lowerKey.match(/(amount|value|total|price|paid|paymentamount|amountdue|portion|part)(?:[_\s-]*([a-z0-9]+))$/i);
      if (amountMatch && amountMatch[2]) {
        amountMap.set(amountMatch[2].toLowerCase(), rawValue);
      }
    }
    if (!methodMap.size || !amountMap.size) return;
  for (const [suffix, methodValue] of methodMap.entries()) {
      const amountValue = amountMap.get(suffix);
      if (amountValue == null) continue;
      considerEntry(methodValue, amountValue, options);
    }
  };

  const considerObject = (value, options = {}) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const entries = Object.entries(value);
    considerMethodAmountPairs(entries, options);
    for (const [key, val] of entries) {
      const lowerKey = String(key || "").toLowerCase();
      const childExplicit =
        options.explicit ||
        lowerKey === "paymentbreakdown" ||
        lowerKey === "paymentdetails" ||
        lowerKey === "paymentinfo" ||
        lowerKey === "paymentamounts" ||
        lowerKey === "payments" ||
        lowerKey === "splitpayment" ||
        lowerKey === "splitpayments" ||
        lowerKey === "paymentoptions" ||
        lowerKey === "paymentselections" ||
        lowerKey === "paymentallocation" ||
        lowerKey === "paymentparts";
      const childOptions = childExplicit ? { ...options, explicit: true } : options;
      if (Array.isArray(val)) {
        considerArray(val, childOptions);
        continue;
      }
      if (val && typeof val === "object") {
        const candidateMethod =
          val.method ??
          val.type ??
          val.name ??
          val.label ??
          val.title ??
          key;
        const candidateAmount =
          val.amount ??
          val.value ??
          val.total ??
          val.price ??
          val.qty ??
          val.quantity ??
           val.paymentAmount ??
          val.amountDue;
        const numeric = parseNumericAmount(candidateAmount);
        const methodNormalized = normalizePaymentMethodName(candidateMethod);
        if (methodNormalized && numeric != null) {
          addPaymentPart(parts, methodNormalized, numeric, childOptions);
        }
        considerObject(val, childOptions);
      } else {
        if (typeof val === "string") considerString(val, childOptions);
        considerPrimitiveEntry(key, val, childOptions);
      }
    }
  };

  const considerArray = (value, options = {}) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (Array.isArray(item)) {
        considerArray(item, options);
      } else if (item && typeof item === "object") {
        const candidateMethod =
          item.method ??
          item.type ??
          item.name ??
          item.label ??
          item.title ??
          item.mode ??
          item.paymentMethod ??
          item.paymentType;
        const candidateAmount =
          item.amount ??
          item.value ??
          item.total ??
          item.price ??
          item.qty ??
          item.quantity ??
          item.paymentAmount ??
  item.amountDue;
        const numeric = parseNumericAmount(candidateAmount);
        const methodNormalized = normalizePaymentMethodName(candidateMethod);
        if (methodNormalized && numeric != null) {
          addPaymentPart(parts, methodNormalized, numeric, options);
        }
        considerObject(item, options);
      } else if (typeof item === "string") {
        considerString(item, options);
      }
    }
  };

  const considerString = (value, options = {}) => {
    if (typeof value !== "string") return;
    const pattern = /(cash|insta\s*pay|instapay|card|visa|master(?:\s*card)?|mada|meeza|wallet|fawry|valu|bank\s*transfer|transfer|vodafone(?:\s*cash)?|aman)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/gi;
    let match;
    while ((match = pattern.exec(value))) {
      considerEntry(match[1], match[2], options);
    }
  };

  const sources = [
    source?.paymentParts,
    source?.payment?.parts,
    source?.payment?.breakdown,
    source?.paymentBreakdown,
    source?.paymentDetails?.parts,
    source?.paymentDetails?.breakdown,
    source?.paymentDetails,
    source?.paymentInfo,
    source?.paymentAmounts,
    source?.payments,
    source?.splitPayment,
    source?.splitPayments,
    source?.paymentOptions,
    source?.paymentSelections,
    source?.paymentAllocation,
 ];

  for (const candidate of sources) {
    const options = { explicit: true };
    considerArray(candidate, options);
    considerObject(candidate, options);
  }

  const directFields = {
    Cash: [
      source?.cash,
      source?.cashAmount,
      source?.cashToPay,
      source?.cashPayment,
      source?.cashPaid,
      source?.cashValue,
      source?.cashDue,
      source?.cashPart,
      source?.paymentCash,
      source?.paymentCashAmount,
    ],
    Instapay: [
      source?.instapay,
      source?.instaPay,
      source?.instapayAmount,
      source?.instaPayAmount,
      source?.bank,
      source?.bankAmount,
      source?.bankTransfer,
      source?.bankTransferAmount,
      source?.transfer,
      source?.transferAmount,
      source?.onlinePayment,
      source?.onlineAmount,
      source?.digitalPayment,
      source?.digitalAmount,
    ],
    Card: [
      source?.card,
      source?.cardAmount,
      source?.cardPayment,
      source?.cardPaid,
      source?.visa,
      source?.visaAmount,
      source?.mastercard,
      source?.mastercardAmount,
      source?.credit,
      source?.creditAmount,
      source?.pos,
      source?.posAmount,
    ],
  };

  for (const [method, values] of Object.entries(directFields)) {
    for (const value of values) considerEntry(method, value);
  }

  const stringSources = [
    source?.payment,
    source?.paymentMethod,
    source?.paymentType,
    source?.paymentNote,
    source?.paymentNotes,
    source?.paymentDescription,
    source?.paymentText,
    source?.note,
    source?.notes,
  ];
  for (const text of stringSources) considerString(text);

  const fallbackLabel =
    fallbackMethod ||
    source?.payment ||
    source?.paymentMethod ||
    source?.paymentType ||
    (source?.paidOnline ? "Online" : "");

 if (!parts.length) {
    const fallbackAmount = parseNumericAmount(total);
    if (fallbackAmount != null) {
      addPaymentPart(parts, fallbackLabel || "Online", fallbackAmount);
    }
  } else {
    const totalAmount = parseNumericAmount(total);
    if (totalAmount != null) {
      const sum = parts.reduce((acc, cur) => acc + Number(cur.amount || 0), 0);
      const diff = Number((totalAmount - sum).toFixed(2));
      if (diff > 0.01 && parts.length) {
        parts[0].amount = Number((Number(parts[0].amount || 0) + diff).toFixed(2));
      } else if (diff < -0.01 && parts.length) {
        let remaining = Number(totalAmount.toFixed(2));
        for (const part of parts) {
          const current = Number(part.amount || 0);
          if (!(remaining > 0)) {
            part.amount = 0;
            continue;
          }
          const capped = Math.min(current, remaining);
          part.amount = Number(Math.max(0, capped).toFixed(2));
          remaining = Number((remaining - part.amount).toFixed(2));
        }
        if (remaining < -0.01) {
          const last = parts[parts.length - 1];
          last.amount = Number((Number(last.amount || 0) + remaining).toFixed(2));
        }
      }
    }
  }

  return parts
    .map((p) => ({ method: p.method, amount: Number(p.amount.toFixed(2)) }))
    .filter((p) => Math.abs(p.amount) > 0.009);
}
function summarizePaymentParts(parts = [], fallbackMethod = "Online") {
  if (Array.isArray(parts) && parts.length) {
    if (parts.length === 1) return parts[0].method;
    const label = parts.map((p) => p.method).join(" + ");
    return label || fallbackMethod;
  }
  return normalizePaymentMethodName(fallbackMethod) || fallbackMethod || "Online";
}
const firebaseConfig = {
  apiKey: process.env.REACT_APP_CASHIER_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_CASHIER_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_CASHIER_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_CASHIER_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_CASHIER_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_CASHIER_FIREBASE_APP_ID,
};

const onlineFirebaseConfig = {
  apiKey: process.env.REACT_APP_MENU_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_MENU_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_MENU_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_MENU_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_MENU_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_MENU_FIREBASE_APP_ID,
  measurementId: process.env.REACT_APP_MENU_FIREBASE_MEASUREMENT_ID,
};

const ONLINE_FIREBASE_APP_NAME = process.env.REACT_APP_ONLINE_FIREBASE_APP_NAME;

// For EmailJS
const EMAILJS_SERVICE_ID = process.env.REACT_APP_EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.REACT_APP_EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.REACT_APP_EMAILJS_PUBLIC_KEY;


async function sendEmailJsEmail(templateParams = {}) {
  const fetchFn =
    typeof fetch === "function"
      ? fetch
      : typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : null;
  if (!fetchFn) {
    throw new Error("Fetch API unavailable for EmailJS request");
  }

  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
    const missingKeys = [];
    if (!EMAILJS_SERVICE_ID) missingKeys.push("REACT_APP_EMAILJS_SERVICE_ID");
    if (!EMAILJS_TEMPLATE_ID) missingKeys.push("REACT_APP_EMAILJS_TEMPLATE_ID");
    if (!EMAILJS_PUBLIC_KEY) missingKeys.push("REACT_APP_EMAILJS_PUBLIC_KEY");
    const message =
      "Online-order confirmation emails cannot be sent until EmailJS credentials are configured. " +
      (missingKeys.length ? `Missing: ${missingKeys.join(", ")}.` : "");
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
    } else {
      console.warn(message);
    }
    console.error("EmailJS credentials missing", {
      missingKeys,
      templateParams,
    });
    return;
  }

  const response = await fetchFn("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      template_params: templateParams,
    }),
  });

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch (err) {
      errorBody = "";
    }
    throw new Error(
      `EmailJS request failed with status ${response.status}${errorBody ? `: ${errorBody}` : ""}`
    );
  }
}

function ensureFirebase() {
  const theApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
  const auth = getAuth(theApp);
  const db = getFirestore(theApp);
  return { auth, db };
}

function ensureOnlineFirebase() {
  if (!onlineFirebaseConfig?.projectId) return null;
  try {
    return getApp(ONLINE_FIREBASE_APP_NAME);
  } catch (err) {
    try {
      return initializeApp(onlineFirebaseConfig, ONLINE_FIREBASE_APP_NAME);
    } catch (initErr) {
      console.error("Failed to initialize online orders Firebase app", initErr);
      return null;
    }
  }
}
function getOnlineServices() {
  const app = ensureOnlineFirebase();
  if (!app) return { onlineAuth: null, onlineDb: null };
  return {
    onlineAuth: getAuth(app),
    onlineDb: getFirestore(app),
  };
}


const SHOP_ID = "tux";
// In your React POS app code (App.js)

const ONLINE_ORDER_COLLECTIONS = [
  {
    name: "pos/onlineOrders",
    source: "menu", // This correctly uses the 'tux-menu' Firebase project
    path: ["shops", SHOP_ID, "onlineOrders"], // This is the path we are writing to
    constraints: [where("shopId", "==", SHOP_ID)], // This filter remains correct
  },
];
const LS_KEY = "tux_pos_local_state_v1";
function loadLocal() {

  try { 
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); 
  }
  catch { return {}; }
}
function saveLocalPartial(patch) {
  try {
    const cur = loadLocal();
    localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch {}
}
function formatDateDDMMYY(date) {
  if (!date) return "";
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${day}/${month}/${year}`;
}

function getSundayWeekYearAndNumber(date) {
  const d = new Date(date);
  if (Number.isNaN(+d)) return null;
  const { year, week } = getSundayWeekInfo(d, true) || {};
  if (!year || !week) return null;
  return { year, week };
}

function formatSundayWeekInputValue(date) {
  const info = getSundayWeekYearAndNumber(date);
  if (!info) return "";
  return `${info.year}-W${String(info.week).padStart(2, '0')}`;
}

function toDateInputValue(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  if (Number.isNaN(+d)) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getSundayStart(date) {
  const d = new Date(date);
  if (Number.isNaN(+d)) return "";
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  sunday.setHours(0, 0, 0, 0);
  return toDateInputValue(sunday);
}


function getWeekRangeFromInput(weekStr) {
  if (!weekStr) return null;
  const [yearPart, weekPart] = weekStr.split('-W');
  const year = Number(yearPart);
  const week = Number(weekPart);
  if (!year || !week) return null;

  const weekStart = getSundayStartOfWeek(year, week);
  if (!weekStart) return null;
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  return [weekStart, weekEnd];
}

function multiplyUses(uses = {}, factor = 1) {
  const out = {};
  for (const key of Object.keys(uses || {})) {
    out[key] = Number(uses[key] || 0) * factor;
  }
  return out;
}

function getSundayStartDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(+d)) return null;
  const sunday = new Date(d);
  sunday.setDate(d.getDate() - d.getDay());
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}



function getSundayWeekInfo(value, useStartYear = false) {
  const target = value instanceof Date ? new Date(value) : new Date(value || new Date());
  if (Number.isNaN(+target)) {
    const fallback = new Date();
    fallback.setHours(0, 0, 0, 0);
    return { year: fallback.getFullYear(), week: 1, start: fallback };
  }

  const sunday = getSundayStartDate(target);
  if (!sunday) {
    const fallback = new Date();
    fallback.setHours(0, 0, 0, 0);
    return { year: fallback.getFullYear(), week: 1, start: fallback };
  }

  const base = new Date(sunday.getFullYear(), 0, 1);
  base.setDate(base.getDate() - base.getDay());
  base.setHours(0, 0, 0, 0);

  const diffDays = Math.floor((sunday - base) / 86400000);
  const week = Math.floor(diffDays / 7) + 1;

  const year = useStartYear ? sunday.getFullYear() : target.getFullYear();
  return { year, week, start: sunday };
}

function getSundayStartOfWeek(year, week) {
  const y = Number(year);
  const w = Number(week);
  if (!Number.isFinite(y) || !Number.isFinite(w) || w < 1) return null;

  const base = new Date(y, 0, 1);
  base.setDate(base.getDate() - base.getDay());
  base.setHours(0, 0, 0, 0);

  const start = new Date(base);
  start.setDate(base.getDate() + (Math.min(53, Math.max(1, Math.floor(w))) - 1) * 7);
  return start;
}


function SundayWeekPicker({ selectedSunday, onSelect, dark = false, btnBorder = "#ccc" }) {
  const containerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [hoveredWeek, setHoveredWeek] = useState(null);

  const selectedInfo = useMemo(() => {
    if (!selectedSunday) return null;
    return getSundayWeekInfo(selectedSunday, true);
  }, [selectedSunday]);

  const selectedStart = useMemo(() => {
    if (!selectedInfo?.start) return null;
    const d = new Date(selectedInfo.start);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [selectedInfo]);

  const selectedStartTime = selectedStart ? selectedStart.getTime() : null;

  const [viewMonth, setViewMonth] = useState(() => {
    const base = selectedStart || new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
const [onlineFbUser, setOnlineFbUser] = useState(null);

useEffect(() => {
  const { onlineAuth } = getOnlineServices();
  if (!onlineAuth) return;

  // Keep session observed
  const unsub = onAuthStateChanged(onlineAuth, (u) => {
    setOnlineFbUser(u || null);
    if (u) console.log("✅ tux-menu anonymous user:", u.uid);
  });

  // Ensure we are signed in anonymously
  signInAnonymously(onlineAuth).catch((err) => {
    console.error("❌ Anonymous sign-in to tux-menu failed:", err);
  });

  return () => unsub();
}, []);
function getDbForSource(source) {
  if (source === "menu") {
    const { onlineDb } = getOnlineServices();
    return onlineDb;        // tux-menu Firestore
  }
  const { db } = ensureFirebase();
  return db;                // primary POS Firestore
}

// Example when wiring listeners:
ONLINE_ORDER_COLLECTIONS.forEach((def) => {
  const dbForThis = getDbForSource(def.source);
  if (!dbForThis) return;

  // (Optional) gate menu listeners until anonymous auth is ready
  if (def.source === "menu" && !onlineFbUser) return;

  const colRef = collection(dbForThis, ...def.path);
  const q = query(colRef, orderBy("createdAt", "desc"));
  onSnapshot(q, (snap) => {
    // merge/dedupe as you already do
  });
});

  useEffect(() => {
    if (!selectedStart) return;
    setViewMonth((prev) => {
      if (
        prev &&
        prev.getFullYear() === selectedStart.getFullYear() &&
        prev.getMonth() === selectedStart.getMonth()
      )
        return prev;
      return new Date(selectedStart.getFullYear(), selectedStart.getMonth(), 1);
    });
  }, [selectedStart, selectedStartTime]);
  useEffect(() => {
    if (!open) return;
    const handleClickAway = (event) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target)) setOpen(false);
    };
    const handleEscape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickAway);
    document.addEventListener("touchstart", handleClickAway);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickAway);
      document.removeEventListener("touchstart", handleClickAway);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setHoveredWeek(null);
  }, [open]);

  const weeks = useMemo(() => {
    if (!viewMonth) return [];
    const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    firstOfMonth.setHours(0, 0, 0, 0);
    const calendarStart = new Date(firstOfMonth);
    calendarStart.setDate(calendarStart.getDate() - calendarStart.getDay());
    calendarStart.setHours(0, 0, 0, 0);

    const rows = [];
    for (let w = 0; w < 6; w += 1) {
      const weekStart = new Date(calendarStart);
      weekStart.setDate(calendarStart.getDate() + w * 7);
      weekStart.setHours(0, 0, 0, 0);
      const days = [];
      for (let d = 0; d < 7; d += 1) {
        const day = new Date(weekStart);
        day.setDate(weekStart.getDate() + d);
        day.setHours(0, 0, 0, 0);
        days.push(day);
      }
      rows.push({ weekStart, days });
    }
    return rows;
  }, [viewMonth]);

  const monthLabel = useMemo(() => {
    if (!viewMonth) return "";
    return viewMonth.toLocaleString(undefined, {
      month: "long",
      year: "numeric",
    });
  }, [viewMonth]);

  const selectedLabel = useMemo(() => {
    if (!selectedInfo?.week || !selectedStart) return "Select week";
    const end = new Date(selectedStart);
    end.setDate(selectedStart.getDate() + 6);
    return `Week ${String(selectedInfo.week).padStart(2, "0")} • ${formatDateDDMMYY(
      selectedStart
    )} → ${formatDateDDMMYY(end)}`;
  }, [selectedInfo, selectedStart]);

  const openPicker = () => {
    if (!open) {
      setViewMonth((prev) => {
        const base = selectedStart || new Date();
        const month = new Date(base.getFullYear(), base.getMonth(), 1);
        if (
          prev &&
          prev.getFullYear() === month.getFullYear() &&
          prev.getMonth() === month.getMonth()
        )
          return prev;
        return month;
      });
    }
    setOpen((prev) => !prev);
  };

  const handleSelect = (weekStart) => {
    setOpen(false);
    if (onSelect) {
      const normalized = new Date(weekStart);
      normalized.setHours(0, 0, 0, 0);
      onSelect(normalized);
    }
  };

  const goMonth = (delta) => {
    setViewMonth((prev) => {
      const base = prev || new Date();
      return new Date(base.getFullYear(), base.getMonth() + delta, 1);
    });
  };

  const weekButtonBaseStyle = {
    display: "grid",
    gridTemplateColumns: "52px repeat(7, 32px)",
    gap: 4,
    alignItems: "center",
    padding: "4px 6px",
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    background: "transparent",
    color: dark ? "#f2f2f2" : "#111",
    fontSize: 12,
    fontWeight: 600,
    textAlign: "center",
  };

  const dayLabels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={openPicker}
        style={{
          padding: "6px 12px",
          borderRadius: 6,
          border: `1px solid ${btnBorder}`,
          background: dark ? "#2c2c2c" : "#fff",
          color: dark ? "#f1f1f1" : "#000",
          cursor: "pointer",
          minWidth: 220,
          textAlign: "left",
          fontWeight: 600,
        }}
      >
        {selectedLabel}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 1000,
            borderRadius: 10,
            border: `1px solid ${btnBorder}`,
            background: dark ? "#1c1c1c" : "#fff",
            color: dark ? "#f1f1f1" : "#000",
            boxShadow: dark
              ? "0 12px 24px rgba(0,0,0,0.45)"
              : "0 12px 24px rgba(0,0,0,0.18)",
            padding: 12,
            minWidth: 340,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
              gap: 8,
            }}
          >
            <button
              type="button"
              onClick={() => goMonth(-1)}
              style={{
                border: `1px solid ${btnBorder}`,
                borderRadius: 6,
                padding: "4px 8px",
                cursor: "pointer",
                background: dark ? "#2c2c2c" : "#f1f1f1",
                color: dark ? "#f1f1f1" : "#000",
                fontWeight: 700,
              }}
            >
              ‹
            </button>
            <div style={{ fontWeight: 700 }}>{monthLabel}</div>
            <button
              type="button"
              onClick={() => goMonth(1)}
              style={{
                border: `1px solid ${btnBorder}`,
                borderRadius: 6,
                padding: "4px 8px",
                cursor: "pointer",
                background: dark ? "#2c2c2c" : "#f1f1f1",
                color: dark ? "#f1f1f1" : "#000",
                fontWeight: 700,
              }}
            >
              ›
            </button>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "52px repeat(7, 32px)",
              gap: 4,
              fontSize: 11,
              fontWeight: 700,
              textAlign: "center",
              marginBottom: 4,
            }}
          >
            <div style={{ opacity: 0.7 }}>Week</div>
            {dayLabels.map((d) => (
              <div key={d} style={{ opacity: 0.7 }}>
                {d}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            {weeks.map(({ weekStart, days }) => {
              const weekInfo = getSundayWeekInfo(weekStart, true);
              const weekNumber = weekInfo?.week || 0;
              const key = weekStart.getTime();
              const isSelected = selectedStart && key === selectedStartTime;
              const isHovered = hoveredWeek === key;
              const background = isSelected
                ? dark
                  ? "rgba(25, 118, 210, 0.35)"
                  : "rgba(25, 118, 210, 0.2)"
                : isHovered
                ? dark
                  ? "rgba(255,255,255,0.08)"
                  : "rgba(0,0,0,0.05)"
                : "transparent";
              const borderColor = isSelected ? "#1976d2" : "transparent";
              return (
                <button
                  key={key}
                  type="button"
                  onMouseEnter={() => setHoveredWeek(key)}
                  onMouseLeave={() => setHoveredWeek(null)}
                  onClick={() => handleSelect(weekStart)}
                  style={{
                    ...weekButtonBaseStyle,
                    background,
                    border: `1px solid ${borderColor}`,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{String(weekNumber).padStart(2, "0")}</div>
                  {days.map((day) => {
                    const outside = day.getMonth() !== viewMonth.getMonth();
                    return (
                      <div
                        key={day.getTime()}
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          opacity: outside ? 0.35 : 1,
                        }}
                      >
                        {String(day.getDate()).padStart(2, "0")}
                      </div>
                    );
                  })}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}


function MarginLineChart({ data, dark }) {
  const width = 720;
  const height = 260;
  const padding = { top: 24, right: 32, bottom: 44, left: 72 };

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 12, fontStyle: "italic", opacity: 0.8 }}>
        Not enough data to display the margin chart.
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => a.ts - b.ts);
  const xValues = sorted.map((row) => row.ts);
  const yValues = sorted.map((row) => row.net);

  const xMin = xValues[0];
  const xMax = xValues[xValues.length - 1];
  let yMin = Math.min(...yValues);
  let yMax = Math.max(...yValues);
  if (yMin === yMax) {
    const adjust = Math.abs(yMin) || 1;
    yMin -= adjust;
    yMax += adjust;
  }

  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;

  const points = sorted.map((row) => {
    const x = padding.left + ((row.ts - xMin) / xSpan) * innerWidth;
    const y = padding.top + (1 - (row.net - yMin) / ySpan) * innerHeight;
    return { ...row, x, y };
  });

  const pathD = points
    .map((point, idx) => `${idx === 0 ? "M" : "L"}${point.x} ${point.y}`)
    .join(" ");

  const axisColor = dark ? "#8fa58f" : "#b0bec5";
  const gridColor = dark ? "#1f2b1f" : "#e0e0e0";
  const lineColor = "#2e7d32";
  const textColor = dark ? "#ffffff" : "#102027";

  const yTicks = 4;
  const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => yMin + (ySpan / yTicks) * i);

  const xTickCount = Math.min(points.length, 6);
  const xTickIndexes = xTickCount > 1
    ? Array.from({ length: xTickCount }, (_, i) =>
        Math.round((points.length - 1) * (i / (xTickCount - 1))))
    : [0];

  const formatAmount = (value) =>
    `E£${Number(value).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })}`;

  const formatDateLabel = (ts) =>
    new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height }}
      role="img"
      aria-label="Margin over time"
    >
      {/* grid */}
      {yTickValues.map((value, idx) => {
        const y = padding.top + (1 - (value - yMin) / ySpan) * innerHeight;
        return (
          <line
            key={`grid-${idx}`}
            x1={padding.left}
            x2={width - padding.right}
            y1={y}
            y2={y}
            stroke={gridColor}
            strokeWidth={idx === 0 || idx === yTicks ? 1.5 : 1}
          />
        );
      })}

      {/* axes */}
      <line
        x1={padding.left}
        y1={height - padding.bottom}
        x2={width - padding.right}
        y2={height - padding.bottom}
        stroke={axisColor}
        strokeWidth={1.5}
      />
      <line
        x1={padding.left}
        y1={padding.top}
        x2={padding.left}
        y2={height - padding.bottom}
        stroke={axisColor}
        strokeWidth={1.5}
      />

      {/* axis labels */}
      {yTickValues.map((value, idx) => {
        const y = padding.top + (1 - (value - yMin) / ySpan) * innerHeight;
        return (
          <text
            key={`ylabel-${idx}`}
            x={padding.left - 8}
            y={y + 4}
            textAnchor="end"
            fontSize={12}
            fill={textColor}
          >
            {formatAmount(value)}
          </text>
        );
      })}

      {xTickIndexes.map((idx, i) => {
        const point = points[idx];
        return (
          <text
            key={`xlabel-${i}`}
            x={point.x}
            y={height - padding.bottom + 24}
            textAnchor="middle"
            fontSize={12}
            fill={textColor}
          >
            {formatDateLabel(point.ts)}
          </text>
        );
      })}

      {/* line */}
      <path
        d={pathD}
        fill="none"
        stroke={lineColor}
        strokeWidth={3}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* points */}
      {points.map((point, idx) => (
        <g key={`pt-${idx}`}>
          <circle cx={point.x} cy={point.y} r={4} fill={lineColor} />
          <title>
            {`${formatDateLabel(point.ts)} — ${formatAmount(point.net)}`}
          </title>
        </g>
      ))}
    </svg>
  );
}
export function packStateForCloud(state) {
   const {
    menu,
    extraList,
    orders,
    inventory,
    nextOrderNo,
    workerProfiles,
    workerSessions,
    dark,
    workers,
    paymentMethods,
    inventoryLocked,
    inventorySnapshot,
    inventoryLockedAt,
    adminPins,
    orderTypes,
    defaultDeliveryFee,
    expenses,
     dayMeta,
    bankTx,
    reconHistory,
    realtimeOrders,
    utilityBills,
    laborProfile,
    equipmentList,
    onlineOrdersRaw,
    onlineOrderStatus,
    lastSeenOnlineOrderTs,
  } = state;
  const purchases = Array.isArray(state.purchases)
    ? state.purchases.map((p) => ({
        ...p,
        date: toIso(p.date),
      }))
    : [];
  const purchaseCategories = Array.isArray(state.purchaseCategories)
    ? state.purchaseCategories
    : [];
  const customers = Array.isArray(state.customers)
    ? state.customers.map((c) => ({
        ...c,
        lastOrderAt: toIso(c.lastOrderAt),
        firstOrderAt: toIso(c.firstOrderAt),
        updatedAt: toIso(c.updatedAt),
      }))
    : [];
  const deliveryZones = Array.isArray(state.deliveryZones)
    ? state.deliveryZones
    : [];
  const payload = {
 workerProfiles,
    workerSessions: (workerSessions || []).map((session) => ({
      ...session,
      signInAt: toIso(session.signInAt),
      signOutAt: toIso(session.signOutAt),
    })),
    realtimeOrders: typeof realtimeOrders === "boolean" ? realtimeOrders : undefined,
    version: 1,
    updatedAt: serverTimestamp(),
    menu,
    extras: extraList,
    orders: (orders || []).map((o) => ({
      ...o,
      date: toIso(o.date),
      restockedAt: toIso(o.restockedAt),
    })),
    inventory,
    nextOrderNo,
    dark,
    workers,
    paymentMethods,
    inventoryLocked,
    inventorySnapshot,
    inventoryLockedAt: toIso(inventoryLockedAt),
    adminPins,
    orderTypes,
    defaultDeliveryFee,
    expenses: (expenses || []).map((e) => ({
      ...e,
      date: toIso(e.date),
    })),
    purchases,
    purchaseCategories,
    customers,
    deliveryZones,
    dayMeta: dayMeta
      ? {
          ...dayMeta,
          startedAt: toIso(dayMeta.startedAt),
          endedAt: toIso(dayMeta.endedAt),
          lastReportAt: toIso(dayMeta.lastReportAt),
          resetAt: toIso(dayMeta.resetAt),
          reconciledAt: toIso(dayMeta.reconciledAt),
          shiftChanges: Array.isArray(dayMeta.shiftChanges)
            ? dayMeta.shiftChanges.map((c) => ({
                ...c,
                at: toIso(c?.at),
              }))
            : [],
        }
      : {},
   bankTx: (bankTx || []).map((t) => ({
      ...t,
      date: toIso(t.date),
    })),
   reconHistory: (reconHistory || []).map((r) => ({
      ...r,
      at: toIso(r.at),
    })),
    utilityBills,
    laborProfile,
    equipmentList,
    onlineOrders: Array.isArray(onlineOrdersRaw)
      ? onlineOrdersRaw.map((order) => ({
          ...order,
          date: toIso(order.date),
          createdAt: toIso(order.createdAt),
          restockedAt: toIso(order.restockedAt),
          whatsappSentAt: toIso(order.whatsappSentAt),
        }))
      : [],
    onlineOrderStatus:
      onlineOrderStatus && typeof onlineOrderStatus === "object"
        ? Object.fromEntries(
            Object.entries(onlineOrderStatus).map(([key, value]) => [
              key,
              value && typeof value === "object"
                ? {
                    ...value,
                    lastUpdateAt:
                      value.lastUpdateAt != null
                        ? Number(value.lastUpdateAt)
                        : undefined,
                    lastSeenAt:
                      value.lastSeenAt != null
                        ? Number(value.lastSeenAt)
                        : undefined,
                  }
                : value,
            ])
          )
        : {},
    lastSeenOnlineOrderTs: Number.isFinite(Number(lastSeenOnlineOrderTs))
      ? Number(lastSeenOnlineOrderTs)
      : undefined,
  };
  return sanitizeForFirestore(payload);
}

function computeCostBreakdown(def, invMap, ctx = {}) {
  const round2 = (v) => Number((Number.isFinite(v) ? v : 0).toFixed(2));
  const uses = def?.uses || {};
  let ingredientCost = 0;
  for (const k of Object.keys(uses)) {
    const need = Number(uses[k] || 0);
    const cost = Number(invMap[k]?.costPerUnit || 0);
    ingredientCost += need * cost;
  }
  const prepMinutes = Number(def?.prepMinutes || 0);
  const laborCost = prepMinutes > 0 ? prepMinutes * (ctx.laborCostPerMinute || 0) : 0;
  let electricityCost = 0;
  let gasCost = 0;
  let waterCost = 0;
  const equipmentMinutes = def?.equipmentMinutes || {};
  for (const eqId of Object.keys(equipmentMinutes)) {
    const minutes = Number(equipmentMinutes[eqId] || 0);
    if (!(minutes > 0)) continue;
    const eq = ctx.equipmentById?.[eqId];
    if (!eq) continue;
    const electricKw = Number(eq.electricKw || 0);
    const gasPerHour = Number(eq.gasM3PerHour || 0);
    const waterPerMin = Number(eq.waterLPerMin || 0);
    if (electricKw > 0 && (ctx.utilityRates?.electricity || 0) > 0) {
      const kwh = electricKw * (minutes / 60);
      electricityCost += kwh * (ctx.utilityRates.electricity || 0);
    }
    if (gasPerHour > 0 && (ctx.utilityRates?.gas || 0) > 0) {
      const m3 = gasPerHour * (minutes / 60);
      gasCost += m3 * (ctx.utilityRates.gas || 0);
    }
    if (waterPerMin > 0 && (ctx.utilityRates?.water || 0) > 0) {
      const liters = waterPerMin * minutes;
      waterCost += liters * (ctx.utilityRates.water || 0);
    }
  }
  const total = ingredientCost + laborCost + electricityCost + gasCost + waterCost;
  return {
    ingredients: round2(ingredientCost),
    labor: round2(laborCost),
    electricity: round2(electricityCost),
    gas: round2(gasCost),
    water: round2(waterCost),
    total: round2(total),
  };
}

function computeCOGSForItemDef(def, invMap, ctx) {
  return computeCostBreakdown(def, invMap, ctx).total;
}
export function unpackStateFromCloud(data, fallbackDayMeta = {}) {
  const out = {};
if (Array.isArray(data.orders)) {
    out.orders = data.orders.map((o) => ({
      ...o,
      date: o.date ? new Date(o.date) : new Date(),
      restockedAt: o.restockedAt ? new Date(o.restockedAt) : undefined,
      whatsappSentAt: o.whatsappSentAt ? new Date(o.whatsappSentAt) : null,
    }));
  }
 if (Array.isArray(data.expenses)) {
    out.expenses = data.expenses.map((e) => ({
      ...e,
      date: e.date ? new Date(e.date) : new Date(),
    }));
  }
  if (Array.isArray(data.purchases)) {
    out.purchases = data.purchases.map((p) => ({
      ...p,
      date: p.date ? new Date(p.date) : new Date(),
    }));
  }
  if (Array.isArray(data.purchaseCategories)) out.purchaseCategories = data.purchaseCategories;
  if (Array.isArray(data.customers)) out.customers = data.customers;
  if (Array.isArray(data.deliveryZones)) out.deliveryZones = data.deliveryZones;
  if (Array.isArray(data.bankTx)) {
    out.bankTx = data.bankTx.map((t) => ({
      ...t,
      date: t.date ? new Date(t.date) : new Date(),
    }));
  }
  if (data.inventoryLockedAt) out.inventoryLockedAt = new Date(data.inventoryLockedAt);
  if (data.dayMeta) {
    out.dayMeta = {
      startedBy: data.dayMeta.startedBy || "",
      currentWorker: data.dayMeta.currentWorker || "",
      startedAt: data.dayMeta.startedAt ? new Date(data.dayMeta.startedAt) : null,
      endedAt: data.dayMeta.endedAt ? new Date(data.dayMeta.endedAt) : null,
        reconciledAt: data.dayMeta.reconciledAt ? new Date(data.dayMeta.reconciledAt) : null,
      endedBy: data.dayMeta.endedBy || "",
      lastReportAt: data.dayMeta.lastReportAt ? new Date(data.dayMeta.lastReportAt) : null,
      resetBy: data.dayMeta.resetBy || "",
      resetAt: data.dayMeta.resetAt ? new Date(data.dayMeta.resetAt) : null,
      shiftChanges: Array.isArray(data.dayMeta.shiftChanges)
        ? data.dayMeta.shiftChanges.map((c) => ({
            ...c,
            at: c.at ? new Date(c.at) : null,
          }))
        : [],
    };
  } else {
    out.dayMeta = fallbackDayMeta;
  }
   if (Array.isArray(data.reconHistory)) {
  out.reconHistory = data.reconHistory.map(r => ({
    ...r, at: r.at ? new Date(r.at) : new Date()
  }));
}
  if (data.menu) out.menu = data.menu;
  if (data.extras) out.extraList = data.extras;
  if (data.inventory) out.inventory = data.inventory;
  if (typeof data.nextOrderNo === "number") out.nextOrderNo = data.nextOrderNo;
  if (typeof data.dark === "boolean") out.dark = data.dark;
  if (Array.isArray(data.workers)) out.workers = data.workers;
  if (Array.isArray(data.paymentMethods)) out.paymentMethods = data.paymentMethods;
  if (typeof data.inventoryLocked === "boolean") out.inventoryLocked = data.inventoryLocked;
  if (Array.isArray(data.inventorySnapshot)) out.inventorySnapshot = data.inventorySnapshot;
  if (data.adminPins) out.adminPins = data.adminPins;
  if (Array.isArray(data.orderTypes)) out.orderTypes = data.orderTypes;
if (typeof data.defaultDeliveryFee === "number")
    out.defaultDeliveryFee = data.defaultDeliveryFee;
  if (Array.isArray(data.workerProfiles)) out.workerProfiles = data.workerProfiles;
if (Array.isArray(data.workerSessions)) {
    out.workerSessions = data.workerSessions.map((s) => ({
      ...s,
      signInAt: s.signInAt ? new Date(s.signInAt) : null,
      signOutAt: s.signOutAt ? new Date(s.signOutAt) : null,
    }));
  }
  if (typeof data.realtimeOrders === "boolean") out.realtimeOrders = data.realtimeOrders;
 if (data.utilityBills) out.utilityBills = data.utilityBills;
  if (data.laborProfile) out.laborProfile = data.laborProfile;
  if (Array.isArray(data.equipmentList)) out.equipmentList = data.equipmentList;
 if (Array.isArray(data.onlineOrders)) {
    out.onlineOrdersRaw = data.onlineOrders.map((order) => {
      const safeOrder = order && typeof order === "object" ? order : {};
      const rawSource =
        safeOrder.raw && typeof safeOrder.raw === "object" ? safeOrder.raw : {};
      const recomputeSource = { ...rawSource, ...safeOrder };
      delete recomputeSource.paymentParts;

      const totalCandidate =
        recomputeSource.total ??
        safeOrder.total ??
        rawSource.total ??
        rawSource.amount ??
        rawSource.orderTotal ??
        rawSource.cartTotal;

      const fallbackPaymentMethod =
        safeOrder.payment ||
        safeOrder.paymentMethod ||
        safeOrder.paymentType ||
        rawSource.payment ||
        rawSource.paymentMethod ||
        rawSource.paymentType ||
        (rawSource.paidOnline || safeOrder.paidOnline ? "Online" : undefined);

      const recomputedParts = extractPaymentPartsFromSource(
        recomputeSource,
        totalCandidate,
        fallbackPaymentMethod
      );
      const recomputedLabel = summarizePaymentParts(
        recomputedParts,
        fallbackPaymentMethod
      );

      return {
        ...safeOrder,
        payment: String(recomputedLabel || safeOrder.payment || ""),
        paymentParts: recomputedParts,
        date: safeOrder.date ? new Date(safeOrder.date) : undefined,
        createdAt: safeOrder.createdAt ? new Date(safeOrder.createdAt) : null,
        restockedAt: safeOrder.restockedAt
          ? new Date(safeOrder.restockedAt)
          : undefined,
        whatsappSentAt: safeOrder.whatsappSentAt
          ? new Date(safeOrder.whatsappSentAt)
          : null,
      };
    });
  }
  if (data.onlineOrderStatus && typeof data.onlineOrderStatus === "object") {
    const status = {};
    for (const [key, value] of Object.entries(data.onlineOrderStatus)) {
      if (!key) continue;
      status[key] = value && typeof value === "object" ? { ...value } : value;
    }
    out.onlineOrderStatus = status;
  }
  if (data.lastSeenOnlineOrderTs != null) {
    const numeric = Number(data.lastSeenOnlineOrderTs);
    if (Number.isFinite(numeric)) out.lastSeenOnlineOrderTs = numeric;
  }
  return out;
}

function normalizeOrderForCloud(order) {
  const normalized = enrichOrderWithChannel(order);
  return sanitizeForFirestore({
    orderNo: normalized.orderNo,
    worker: normalized.worker,
    payment: normalized.payment,
    paymentParts: Array.isArray(normalized.paymentParts)
      ? normalized.paymentParts.map((p) => ({ method: p.method, amount: Number(p.amount || 0) }))
      : [],
    orderType: normalized.orderType,
    deliveryFee: normalized.deliveryFee,
   deliveryName: normalized.deliveryName || "",
    deliveryPhone: normalized.deliveryPhone || "",
    deliveryEmail: normalized.deliveryEmail || "",
    deliveryAddress: normalized.deliveryAddress || "",
    deliveryZoneId: normalized.deliveryZoneId || "",
    deliveryZoneName: normalized.deliveryZoneName || "",
    notifyViaWhatsapp: !!normalized.notifyViaWhatsapp,
    whatsappSentAt: toIso(normalized.whatsappSentAt),
    total: normalized.total,
    itemsTotal: normalized.itemsTotal,
    cashReceived: normalized.cashReceived ?? null,
    changeDue: normalized.changeDue ?? null,
    done: !!normalized.done,
    voided: !!normalized.voided,
    voidReason: normalized.voidReason || "",
    note: normalized.note || "",
    date: toIso(normalized.date) || new Date().toISOString(),
    restockedAt: toIso(normalized.restockedAt),
    cart: normalized.cart || [],
    idemKey: normalized.idemKey || "",
    source: normalized.source || "",
    onlineOrderId: normalized.onlineOrderId || "",
    onlineOrderKey: normalized.onlineOrderKey || "",
    onlineSourceCollection: normalized.onlineSourceCollection || "",
    onlineSourceDocId: normalized.onlineSourceDocId || "",
    channel: normalized.channel || "",
    channelOrderNo: normalized.channelOrderNo || "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}
function orderFromCloudDoc(id, d) {
  const asDate = (v) =>
    v instanceof Timestamp ? v.toDate() : v ? new Date(v) : new Date();
  const order = {
    cloudId: id,

    orderNo: d.orderNo,
    worker: d.worker,
    payment: d.payment,
    paymentParts: Array.isArray(d.paymentParts)
      ? d.paymentParts.map((p) => ({ method: p.method, amount: Number(p.amount || 0) }))
      : [],
    orderType: d.orderType,
    deliveryFee: Number(d.deliveryFee || 0),
      deliveryName: d.deliveryName || "",
    deliveryPhone: d.deliveryPhone || "",
    deliveryEmail: d.deliveryEmail || "",
    deliveryAddress: d.deliveryAddress || "",
    deliveryZoneId: d.deliveryZoneId || "",
    deliveryZoneName: d.deliveryZoneName || "",
    notifyViaWhatsapp: !!d.notifyViaWhatsapp,
    whatsappSentAt: d.whatsappSentAt ? asDate(d.whatsappSentAt) : null,
    total: Number(d.total || 0),
    itemsTotal: Number(d.itemsTotal || 0),
    cashReceived: d.cashReceived != null ? Number(d.cashReceived) : null,
  changeDue: d.changeDue != null ? Number(d.changeDue) : null,
    done: !!d.done,
    voided: !!d.voided,
    voidReason: d.voidReason || "",
    note: d.note || "",
    date: asDate(d.date || d.createdAt),
    restockedAt: d.restockedAt ? asDate(d.restockedAt) : undefined,
    cart: Array.isArray(d.cart) ? d.cart : [],
     idemKey: d.idemKey || "",
    source: d.source || "",
    onlineOrderId: d.onlineOrderId || "",
 onlineOrderKey: d.onlineOrderKey || "",
    onlineSourceCollection: d.onlineSourceCollection || "",
    onlineSourceDocId: d.onlineSourceDocId || "",
  };
  return enrichOrderWithChannel(order);
}

function ensureOnlineOrderNo(rawNo, fallbackId, createdAtMs) {
  const extractDigits = (value) => {
    if (value == null) return "";
    const matches = String(value)
      .toUpperCase()
      .match(/\d+/g);
    if (!matches) return "";
    const combined = matches.join("");
    const trimmed = combined.replace(/^0+/, "");
    return trimmed || "0";
  };

  const fromRaw = extractDigits(rawNo);
  if (fromRaw) return `O${fromRaw}`;

  const fromIdDigits = extractDigits(fallbackId);
  if (fromIdDigits) return `O${fromIdDigits}`;

  const sanitizedId = String(fallbackId || "").replace(/[^a-z0-9]/gi, "");
  if (sanitizedId) {
    const parsed = parseInt(sanitizedId.slice(-10), 36);
    if (Number.isFinite(parsed) && parsed > 0) {
      return `O${String(parsed)}`;
    }
  }

  const ts = Number(createdAtMs || Date.now());
  if (Number.isFinite(ts) && ts > 0) {
    const suffix = String(Math.floor(ts)).slice(-6) || "0";
    const trimmed = suffix.replace(/^0+/, "");
    return `O${trimmed || suffix || "0"}`;
  }

 const fallback = Math.floor(Math.random() * 900000) + 100000;
  return `O${fallback}`;
}

function formatOnsiteChannelOrderNo(orderNo) {
  const numeric = Number(orderNo);
  if (Number.isFinite(numeric) && numeric > 0) {
    const safe = Math.floor(numeric);
    return `POS-${String(safe).padStart(4, "0")}`;
  }
  const sanitized = String(orderNo || "")
    .replace(/[^a-z0-9]/gi, "")
    .toUpperCase();
  return sanitized ? `POS-${sanitized}` : "POS-0000";
}

function formatOnlineChannelOrderNo(orderNo, fallbackId, createdAtMs) {
  const normalized = ensureOnlineOrderNo(orderNo, fallbackId, createdAtMs);
  const digits = String(normalized || "")
    .replace(/^O+/i, "")
    .replace(/[^0-9]/g, "");
  const trimmed = digits ? digits.slice(-6) : "";
  const padded = (trimmed || "0").padStart(4, "0");
  return `ON-${padded}`;
}

function deriveOrderChannel(order) {
  if (!order) return "onsite";
  const raw = String(order.channel || order.source || "")
    .toLowerCase()
    .trim();
  if (raw === "online") return "online";
  if (raw === "onsite") return "onsite";
  if (order.onlineOrderId || order.onlineOrderKey) return "online";
  return "onsite";
}

function enrichOrderWithChannel(order) {
  if (!order) return order;
  const channel = deriveOrderChannel(order);
  let channelOrderNo = order.channelOrderNo;
  if (channel === "onsite") {
    const baseNo = order.orderNo != null ? order.orderNo : channelOrderNo;
    channelOrderNo = formatOnsiteChannelOrderNo(baseNo);
  } else {
    const createdAtMs =
      Number(order.createdAtMs) ||
      toMillis(order.createdAt) ||
      toMillis(order.date);
    const fallbackId = order.onlineOrderId || order.onlineOrderKey || order.id;
    channelOrderNo =
      channelOrderNo || formatOnlineChannelOrderNo(order.orderNo, fallbackId, createdAtMs);
  }
  return { ...order, channel, channelOrderNo };
}

function onlineOrderFromDoc(id, data = {}) {
  const asDate = (value) => {
    if (!value) return null;
    if (value instanceof Timestamp) return value.toDate();
    if (value instanceof Date) return value;
    const parsed = new Date(value);
    return Number.isNaN(+parsed) ? null : parsed;
  };
  const asNumber = (value, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  const normalizeExtras = (list) => {
    if (!Array.isArray(list)) return [];
    return list.map((extra, idx) => ({
      id:
        extra?.id ||
        extra?.extraId ||
        extra?.optionId ||
        extra?.uid ||
        `extra-${idx}`,
      name: String(extra?.name || extra?.title || extra?.label || "Extra"),
      price: asNumber(extra?.price ?? extra?.amount ?? extra?.cost ?? 0),
    }));
  };
  const normalizeCart = (list) => {
    if (!Array.isArray(list)) return [];
    return list.map((item, idx) => {
      const qty = asNumber(
        item?.qty ?? item?.quantity ?? item?.count ?? item?.amount ?? 1,
        1
      ) || 1;
      const price = asNumber(
        item?.price ?? item?.unitPrice ?? item?.amountPerUnit ?? item?.amount ?? 0,
        0
      );
      const extrasSource =
        item?.extras || item?.options || item?.addOns || item?.addons || [];
      return {
        id:
          item?.id ||
          item?.menuItemId ||
          item?.itemId ||
          item?.uid ||
          `item-${idx}`,
        name: String(item?.name || item?.title || item?.label || `Item ${idx + 1}`),
        qty,
        price,
        extras: normalizeExtras(extrasSource),
      };
    });
  };

  const createdAt =
    asDate(
      data?.createdAt ||
        data?.placedAt ||
        data?.date ||
        data?.submittedAt ||
        data?.timestamp
    ) || new Date();
  const createdAtMs = createdAt.getTime();
  const rawCart = Array.isArray(data?.cart)
    ? data.cart
    : Array.isArray(data?.items)
    ? data.items
    : [];
  const cart = normalizeCart(rawCart);
  const deliveryInfo = data?.delivery || {};
  const deliveryFee = asNumber(
    data?.deliveryFee ??
      deliveryInfo?.fee ??
      deliveryInfo?.fees ??
      deliveryInfo?.price ??
      0,
    0
  );
  const itemsTotal = asNumber(
    data?.itemsTotal ??
      data?.itemsSubtotal ??
      data?.subTotal ??
      data?.subtotal ??
      data?.productsTotal ??
      data?.cartTotal ??
      0,
    0
  );
  const total = (() => {
    const rawTotal = asNumber(
      data?.total ??
        data?.grandTotal ??
        data?.amount ??
        data?.orderTotal ??
        data?.cartTotal ??
        0,
      0
    );
    if (rawTotal) return rawTotal;
    if (itemsTotal || deliveryFee) return itemsTotal + deliveryFee;
    const itemsSum = cart.reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1),
      0
    );
    const extrasSum = cart.reduce(
      (sum, item) =>
        sum +
        (Array.isArray(item.extras)
          ? item.extras.reduce(
              (inner, ex) => inner + Number(ex.price || 0) * Number(item.qty || 1),
              0
            )
          : 0),
      0
    );
    return Number(itemsSum + extrasSum + deliveryFee);
  })();
  const orderType =
    data?.orderType ||
    data?.fulfillmentType ||
    data?.fulfillment ||
    (deliveryFee > 0 || data?.deliveryAddress || deliveryInfo?.address
      ? "Delivery"
      : "Pickup");
 const orderNo =
    data?.orderNo ||
    data?.orderNumber ||
    data?.ticket ||
    data?.shortId ||
    data?.displayId ||
    data?.reference ||
    null;
   const payment =
    data?.payment ||
    data?.paymentMethod ||
    data?.paymentType ||
    (data?.paidOnline ? "Online" : "Unspecified");
  const paymentParts = extractPaymentPartsFromSource(data, total, payment);
  const paymentLabel = summarizePaymentParts(paymentParts, payment);
  const customerName =
    data?.customerName ||
    data?.name ||
    data?.customer?.name ||
    deliveryInfo?.name ||
    "";
  const customerPhone =
    data?.customerPhone ||
    data?.phone ||
    data?.customer?.phone ||
    deliveryInfo?.phone ||
    "";
  const customerEmail =
    pickFirstTruthyKey(
      data?.customerEmail,
      data?.email,
      data?.contactEmail,
      data?.customer?.email,
      data?.customer?.emailAddress,
      data?.customer?.email_address,
      data?.customer?.contactEmail,
      data?.customer?.contact?.email,
      data?.customer?.contact?.emailAddress,
      data?.customer?.contact?.email_address,
      deliveryInfo?.email,
      deliveryInfo?.emailAddress,
      deliveryInfo?.email_address,
      data?.contact?.email,
      data?.contact?.emailAddress,
      data?.contact?.email_address
    ) || "";
  const customerAddress =
    data?.deliveryAddress ||
    data?.address ||
    deliveryInfo?.address ||
    "";
 const normalizedOrderNo = ensureOnlineOrderNo(orderNo, id, createdAtMs);
  const channelOrderNo = formatOnlineChannelOrderNo(
    normalizedOrderNo,
    id,
    createdAtMs
  );

 const deliveryZoneId =
    pickFirstTruthyKey(
      data?.deliveryZoneId,
      deliveryInfo?.zoneId,
      deliveryInfo?.zone?.id,
      deliveryInfo?.zone?.slug,
      deliveryInfo?.zone?.code
    ) || "";

  return {
    id,
    orderNo: normalizedOrderNo,
    worker: data?.handledBy || data?.worker || "Online Order",
    payment: String(paymentLabel || payment || "Unspecified"),
    paymentParts,
    orderType,
    deliveryFee,
    deliveryName: customerName,
    deliveryPhone: customerPhone,
    deliveryEmail: customerEmail,
    deliveryAddress: customerAddress,
    deliveryZoneId,
    notifyViaWhatsapp: false,
    whatsappSentAt: null,
    total,
    itemsTotal: itemsTotal || total - deliveryFee,
    cashReceived: null,
    changeDue: null,
    done: false,
    voided: false,
    voidReason: "",
    note: data?.note || data?.notes || data?.specialInstructions || "",
    date: createdAt,
    restockedAt: undefined,
    cart,
    idemKey: data?.idemKey || "",
    createdAt,
    createdAtMs,
    status: data?.status || data?.orderStatus || data?.state || "new",
    source: "online",
    channel: "online",
    channelOrderNo,
    raw: data,
  };
}

const normalizeNameKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

function normalizeOnlineOrderType(type, availableTypes = []) {
  const normalized = normalizeNameKey(type);
  const options = availableTypes.map((t) => [normalizeNameKey(t), t]);
  for (const [key, original] of options) {
    if (key && key === normalized) return original;
  }
  if (normalized === "pickup" || normalized === "takeaway" || normalized === "takeout") {
    const takeAway = availableTypes.find((t) => /take[- ]?away/i.test(String(t)));
    if (takeAway) return takeAway;
  }
  if (normalized === "delivery") {
    const delivery = availableTypes.find((t) => /delivery/i.test(String(t)));
    if (delivery) return delivery;
  }
  if (normalized === "dinein" || normalized === "dining" || normalized === "dine") {
    const dine = availableTypes.find((t) => /dine/i.test(String(t)));
    if (dine) return dine;
  }
  return availableTypes[0] || String(type || "Take-Away");
}

function buildCartWithUsesFromOnline(order, menu = [], extras = []) {
  if (!order || !Array.isArray(order.cart)) return [];
  const menuById = new Map();
  const menuByName = new Map();
  for (const item of menu || []) {
    if (!item) continue;
    const idKey = String(item.id);
    if (idKey) menuById.set(idKey, item);
    const nameKey = normalizeNameKey(item.name);
    if (nameKey) menuByName.set(nameKey, item);
  }
  const extraById = new Map();
  const extraByName = new Map();
  for (const extra of extras || []) {
    if (!extra) continue;
    const idKey = String(extra.id);
    if (idKey) extraById.set(idKey, extra);
    const nameKey = normalizeNameKey(extra.name);
    if (nameKey) extraByName.set(nameKey, extra);
  }

  const toQty = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 1;
  };
  const toPrice = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  };

  return (order.cart || []).map((line, idx) => {
    const qty = toQty(line?.qty ?? line?.quantity ?? 1);
    const price = toPrice(line?.price ?? line?.unitPrice ?? 0);
    const idKey = line?.id != null ? String(line.id) : line?.menuItemId != null ? String(line.menuItemId) : "";
    const nameKey = normalizeNameKey(line?.name || line?.title || line?.label);
    const matchedMenu = (idKey && menuById.get(idKey)) || (nameKey && menuByName.get(nameKey)) || null;
    const unitUses = { ...(matchedMenu?.uses || {}) };

    const normalizedExtras = Array.isArray(line?.extras)
      ? line.extras.map((extra, exIdx) => {
          const exIdKey = extra?.id != null ? String(extra.id) : extra?.extraId != null ? String(extra.extraId) : "";
          const exNameKey = normalizeNameKey(extra?.name || extra?.title || extra?.label);
          const matchedExtra =
            (exIdKey && extraById.get(exIdKey)) || (exNameKey && extraByName.get(exNameKey)) || null;
          const extraUses = matchedExtra?.uses || {};
          for (const key of Object.keys(extraUses)) {
            unitUses[key] = (unitUses[key] || 0) + Number(extraUses[key] || 0);
          }
          return {
            id: extra?.id || extra?.extraId || extra?.optionId || extra?.uid || `extra-${idx}-${exIdx}`,
            name: extra?.name || extra?.title || extra?.label || "Extra",
            price: toPrice(extra?.price ?? extra?.amount ?? extra?.cost ?? 0),
          };
        })
      : [];

    return {
      id: line?.id || line?.menuItemId || line?.itemId || line?.uid || `item-${idx}`,
      name: line?.name || line?.title || line?.label || `Item ${idx + 1}`,
      qty,
      price,
      extras: normalizedExtras,
      uses: multiplyUses(unitUses, qty),
    };
  });
}

function computeInventoryRequirement(cartWithUses = []) {
  const required = {};
  for (const line of cartWithUses || []) {
    const uses = line?.uses || {};
    for (const key of Object.keys(uses)) {
      required[key] = (required[key] || 0) + Number(uses[key] || 0);
    }
  }
  return required;
}

function pickFirstTruthyKey(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return null;
}

function getOnlineOrderDedupeKey(order) {
  if (!order) return "";
  const raw = order.raw || {};
  const key =
    pickFirstTruthyKey(
      order.idemKey,
      raw.idemKey,
      raw.idempotencyKey,
      raw.idempotency_key,
      raw.cartId,
      order.orderNo,
      raw.orderNo,
      raw.orderNumber,
      raw.ticket,
      raw.shortId,
      raw.displayId
    ) ||
    [order.sourceCollection || "default", order.id || "", order.sourceDocId || ""]
      .filter(Boolean)
      .join(":");
  return key;
}
function dedupeOrders(list) {
  const byNo = new Map();
  for (const o of list || []) {
    const prev = byNo.get(o.orderNo);
    if (!prev || +new Date(o.date) > +new Date(prev.date)) byNo.set(o.orderNo, o);
  }
  return Array.from(byNo.values()).sort(
    (a, b) => +new Date(b.date) - +new Date(a.date)
  );
}
const BASE_MENU = [
  {
    id: 1,
    name: "Single Smashed Patty",
    price: 95,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 2,
    name: "Double Smashed Patty",
    price: 140,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 3,
    name: "Triple Smashed Patty",
    price: 160,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 4,
    name: "Tux Quatro Smashed Patty",
    price: 190,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 14,
    name: "TUXIFY Single",
    price: 120,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 15,
    name: "TUXIFY Double",
    price: 160,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 16,
    name: "TUXIFY Triple",
    price: 200,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 17,
    name: "TUXIFY Quatro",
    price: 240,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 5,
    name: "Classic Fries",
    price: 25,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 6,
    name: "Cheese Fries",
    price: 40,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 7,
    name: "Chili Fries",
    price: 50,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 8,
    name: "Tux Fries",
    price: 75,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 9,
    name: "Doppy Fries",
    price: 95,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 10,
    name: "Classic Hawawshi",
    price: 80,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 11,
    name: "Tux Hawawshi",
    price: 100,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 12,
    name: "Soda",
    price: 20,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 13,
    name: "Water",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
];
const BASE_EXTRAS = [
  {
    id: 101,
    name: "Extra Smashed Patty",
    price: 40,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 102,
    name: "Bacon",
    price: 20,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 103,
    name: "Cheese",
    price: 15,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 104,
    name: "Ranch",
    price: 15,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 105,
    name: "Mushroom",
    price: 15,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 106,
    name: "Caramelized Onion",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 107,
    name: "Jalapeno",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 108,
    name: "Tux Sauce",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 109,
    name: "Extra Bun",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 110,
    name: "Pickle",
    price: 5,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 111,
    name: "BBQ / Ketchup / Sweet Chili / Hot Sauce",
    price: 5,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 112,
    name: "Mozzarella Cheese",
    price: 20,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
  {
    id: 113,
    name: "Tux Hawawshi Sauce",
    price: 10,
    uses: {},
    targetMarginPctOverride: null,
    prepMinutes: 0,
    equipmentMinutes: {},
  },
];
const DEFAULT_INVENTORY = [
  { id: "meat",   name: "Meat",   unit: "g",     qty: 0, costPerUnit: 0, minQty: 0 },
  { id: "cheese", name: "Cheese", unit: "slices",qty: 0, costPerUnit: 0, minQty: 0 },
];
const DEFAULT_UTILITY_BILLS = {
  electricity: { amount: 0, units: 0 },
  gas: { amount: 0, units: 0 },
  water: { amount: 0, units: 0 },
};
const DEFAULT_LABOR_PROFILE = { payout: 0, productiveHours: 0 };
const BASE_EQUIPMENT = [];
const BASE_WORKERS = ["Hassan","Andiel", "Warda", "Ahmed", "Hazem",];
const DEFAULT_PAYMENT_METHODS = ["Cash", "Card", "Instapay"];
const DEFAULT_ORDER_TYPES = ["Take-Away", "Dine-in", "Delivery"];
const DEFAULT_DELIVERY_FEE = 20;
const UTILITY_UNIT_LABELS = {
  electricity: { amount: "Bill amount (E£)", units: "Usage on bill (kWh)", per: "E£ / kWh" },
  gas: { amount: "Bill amount (E£)", units: "Usage on bill (m³)", per: "E£ / m³" },
  water: { amount: "Bill amount (E£)", units: "Usage on bill (L)", per: "E£ / L" },
};
function normalizeUtilityBills(raw = {}) {
  const safe = (v = {}) => ({
    amount: Number(v.amount || 0),
    units: Number(v.units || 0),
  });
  return {
    electricity: safe(raw.electricity),
    gas: safe(raw.gas),
    water: safe(raw.water),
  };
}
function normalizeLaborProfile(raw = {}) {
  return {
    payout: Number(raw.payout || 0),
    productiveHours: Number(raw.productiveHours || 0),
  };
}
function normalizeEquipmentList(raw = []) {
  if (!Array.isArray(raw) || !raw.length) return [...BASE_EQUIPMENT];
  return raw.map((eq, idx) => ({
    id: eq?.id || `eq_${idx + 1}`,
    name: eq?.name || "",
    electricKw: Number(eq?.electricKw || 0),
    gasM3PerHour: Number(eq?.gasM3PerHour || 0),
    waterLPerMin: Number(eq?.waterLPerMin || 0),
  }));
}
const BASE_WORKER_PROFILES = [
  { id: "w_hassan", name: "Hassan", pin: "1234", rate: 41.67, isActive: false },
  { id: "w_andiel", name: "Andiel", pin: "2345", rate: 31.67, isActive: false },
  { id: "w_warda",  name: "Warda",  pin: "3456", rate: 18.33, isActive: false },
];
const DEFAULT_ZONES = [
  { id: "zone-a", name: "Zone A (Nearby)", fee: 20 },
  { id: "zone-b", name: "Zone B (Medium)", fee: 30 },
  { id: "zone-c", name: "Zone C (Far)", fee: 40 },
];
function normalizePurchaseCategories(arr = []) {
  return (arr || []).map((c, i) => {
    if (typeof c === "string") {
      const nm = c;
      return {
        id: `cat_${i + 1}`,
        name: nm,
        unit: inferUnitFromCategoryName(nm), 
      };
    }
    const nm = c.name || String(c.id || `Cat ${i + 1}`);
    return {
      id: c.id || `cat_${i + 1}`,
      name: nm,
      unit: c.unit || inferUnitFromCategoryName(nm),
    };
  });
}
const PURCHASE_UNITS = ["kg", "g", "L", "ml", "piece", "pack", "dozen", "bottle", "can", "bag", "box", "carton", "slice", "block","paper","kWh","cubic meter"];
const UNIT_MAP = {
  kg: { base: "g",  factor: 1000 },
  g:  { base: "g",  factor: 1 },
  l:  { base: "ml", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  piece:  { base: "piece",  factor: 1 },
  pieces: { base: "piece",  factor: 1 },
  slice:  { base: "slice",  factor: 1 },
  slices: { base: "slice",  factor: 1 },
  pack:   { base: "pack",   factor: 1 },
  bottle: { base: "bottle", factor: 1 },
  can:    { base: "can",    factor: 1 },
  bag:    { base: "bag",    factor: 1 },
  box:    { base: "box",    factor: 1 },
  carton: { base: "carton", factor: 1 },
  dozen:  { base: "piece",  factor: 12 }, // 1 dozen = 12 pieces
  pcs:   { base: "piece",  factor: 1 },
  pc:    { base: "piece",  factor: 1 },
  unit:  { base: "piece",  factor: 1 },
};
function unitPriceToInventoryCost(purchaseUnitPrice, purchaseUnit, invUnit) {
  const qtyInInvUnits = convertToInventoryUnit(1, purchaseUnit, invUnit);
  if (!qtyInInvUnits || !isFinite(qtyInInvUnits) || qtyInInvUnits <= 0) return null;
  return purchaseUnitPrice / qtyInInvUnits; // E£ per inventory unit
}
function convertToInventoryUnit(qty, purchaseUnit, invUnit) {
  const p = UNIT_MAP[String(purchaseUnit || "").toLowerCase()];
  const i = UNIT_MAP[String(invUnit || "").toLowerCase()];
  if (!p || !i) return null;
  if (p.base !== i.base) return null; // incompatible (e.g., kg → ml)
  const inBase = Number(qty || 0) * p.factor;
  return inBase / i.factor;           // in inventory units
}
function getLatestPurchaseForInv(inventoryItem, purchases, purchaseCategories) {
  let best = null;
  const invName = String(inventoryItem?.name || "").toLowerCase();

  for (const p of purchases || []) {
    const when = p?.date instanceof Date ? p.date : new Date(p?.date);
    if (p.ingredientId && p.ingredientId === inventoryItem.id) {
      if (!best || when > best._when) best = { ...p, _when: when };
      continue;
    }
    if (!p.ingredientId) {
      const catName = (purchaseCategories.find(c => c.id === p.categoryId)?.name || "").toLowerCase();
      if (catName && catName === invName) {
        if (!best || when > best._when) best = { ...p, _when: when };
      }
    }
  }
  return best;
}
const getNextMenuId = (menu = []) =>
  (menu.reduce((m, it) => Math.max(m, Number(it?.id ?? 0)), 0) || 0) + 1;

function sumPaymentsByMethod(orders = []) {
  const totals = {};
  for (const order of orders || []) {
    if (order?.voided) continue;
    if (order && Object.prototype.hasOwnProperty.call(order, "done") && order.done === false) {
      continue;
    }

    const rawDelivery = Number(order?.deliveryFee || 0);
    const deliveryFee = Number.isFinite(rawDelivery) && rawDelivery > 0 ? rawDelivery : 0;
    const baseItemsTotal =
      order?.itemsTotal != null
        ? Number(order.itemsTotal || 0)
        : Number(order?.total || 0) - deliveryFee;
    const itemsOnly = Number.isFinite(baseItemsTotal) ? Math.max(0, baseItemsTotal) : 0;

    if (!itemsOnly) continue;

    if (Array.isArray(order.paymentParts) && order.paymentParts.length) {
      const parts = order.paymentParts.map((part) => ({
        method: String(part?.method || "Unknown"),
        amount: Number(part?.amount || 0),
      }));
      const sumParts = parts.reduce((sum, part) => sum + (Number.isFinite(part.amount) ? part.amount : 0), 0);

      if (sumParts <= 0) {
        const evenShare = Number((itemsOnly / parts.length).toFixed(2));
        let remaining = itemsOnly;
        parts.forEach((part, idx) => {
          const allocation = idx === parts.length - 1 ? remaining : Math.min(remaining, evenShare);
          totals[part.method] = (totals[part.method] || 0) + allocation;
          remaining = Math.max(0, remaining - allocation);
        });
      } else {
        let remaining = itemsOnly;
        parts.forEach((part, idx) => {
          const proportion = part.amount / sumParts;
          let allocation = Number((itemsOnly * proportion).toFixed(2));
          if (allocation > remaining || idx === parts.length - 1) {
            allocation = remaining;
          }
          totals[part.method] = (totals[part.method] || 0) + allocation;
          remaining = Math.max(0, Number((remaining - allocation).toFixed(2)));
        });
      }
    } else {
      const key = String(order?.payment || "Unknown");
      totals[key] = (totals[key] || 0) + itemsOnly;
    }
  }
  return totals;
}
const DEFAULT_INV_UNIT_BY_CATNAME = {
  buns: "piece",
  meat: "g",
  cheese: "slice",
  veg: "g",
  vegetables: "g",
  sauces: "ml",
  drinks: "bottle",
  packaging: "piece",
};
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || `inv_${Date.now()}`;
const ensureInvIdUnique = (id, list) => {
  const ids = new Set((list || []).map(it => it.id));
  let candidate = id, n = 1;
  while (ids.has(candidate)) {
    candidate = `${id}-${++n}`;
  }
  return candidate;
};
const inferUnitFromCategoryName = (name) =>
  DEFAULT_INV_UNIT_BY_CATNAME[String(name || "").toLowerCase()] || "piece";
function findInventoryIdForPurchase(row, inventory, purchaseCategories) {
  if (row.ingredientId) return row.ingredientId;
  const catName = (purchaseCategories.find(c => c.id === row.categoryId)?.name || "").toLowerCase();
  const byCat = inventory.find(it => it.name.toLowerCase() === catName);
  if (byCat) return byCat.id;
  const itemName = String(row.itemName || "").toLowerCase();
  const byItem = inventory.find(it => it.name.toLowerCase() === itemName);
  return byItem ? byItem.id : null;
}
const DEFAULT_ADMIN_PINS = {
  1: "1111",
  2: "2222",
  3: "3333",
  4: "4444",
  5: "5555",
  6: "6666",
};
const UTILITY_TYPES = [
  { name: "Electricity", note: "Electricity Bill" },
  { name: "Water", note: "Water Bill" },
  { name: "Internet", note: "Internet Bill" },
  { name: "Gas", note: "Gas Bill" }
];
const norm = (v) => String(v ?? "").trim();
const isExpenseVoidEligible = (t) => {
  const k = norm(t).toLowerCase();
  return !!k && k !== "take-away" && k !== "take away" && k !== "dine-in" && k !== "dine in";
};
async function purgeOrdersInCloud(db, ordersColRef, startDate, endDate) {
  try {
    const startTs = Timestamp.fromDate(startDate);
    const endTs = Timestamp.fromDate(endDate);
    const qy = query(
      ordersColRef,
      where("createdAt", ">=", startTs),
      where("createdAt", "<=", endTs)
    );
    const ss = await getDocs(qy);
    if (ss.empty) return 0;

    const docs = ss.docs;
    let removed = 0;
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const d of chunk) batch.delete(d.ref);
      await batch.commit();
      removed += chunk.length;
    }
    return removed;
  } catch (e) {
    console.warn("purgeOrdersInCloud failed:", e);
    return 0;
  }
}
async function allocateOrderNoAtomic(db, counterDocRef) {
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterDocRef);
    const current = snap.exists() ? Number(snap.data().lastOrderNo || 0) : 0;
    const n = current + 1;
    tx.set(
      counterDocRef,
      { lastOrderNo: n, updatedAt: serverTimestamp() },
      { merge: true }
    );
    return n;
  });
  return next;
}
function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = String(dt.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}
function fmtDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const time = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${fmtDate(dt)} ${time}`;
}
// --- Helpers for Inventory Usage ---
function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d){ const x=new Date(d); x.setHours(23,59,59,999); return x; }

// Week range: always Sunday → Saturday
function getWeekRange(anchorIsoDate) {
  const d = anchorIsoDate ? new Date(anchorIsoDate) : new Date();
  const start = new Date(d);
  // 0 = Sunday
  const dow = start.getDay(); // 0..6
  start.setDate(start.getDate() - dow);      // back to Sunday
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);          // Saturday
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function getMonthRange(yyyymm){
  const [Y,M]=yyyymm.split("-").map(Number);
  const start=startOfDay(new Date(Y,M-1,1));
  const end=endOfDay(new Date(Y,M,0));
  return {start,end};
}

// Unit conversions (extend to your needs)
const UNIT_CONV={
  g:{g:1,kg:1/1000}, kg:{g:1000,kg:1},
  ml:{ml:1,l:1/1000}, l:{ml:1000,l:1},
  pcs:{pcs:1,piece:1,pc:1}, piece:{pcs:1,piece:1,pc:1}, pc:{pcs:1,piece:1,pc:1},
};
function convertUnit(qty, fromUnit, toUnit){
  const f=String(fromUnit||"").toLowerCase(); const t=String(toUnit||"").toLowerCase();
  if(f===t||!f||!t) return Number(qty||0);
  const row=UNIT_CONV[f]; if(row&&row[t]!=null) return Number(qty||0)*row[t];
  return Number(qty||0); // unknown => 1:1
}
function mapById(arr){ const m=new Map(); (arr||[]).forEach(it=>m.set(it.id,it)); return m; }
function findDefByLine(line, defs){
  if(line?.id!=null){ const byId=defs.find(d=>d.id===line.id); if(byId) return byId; }
  if(line?.name){ const nm=String(line.name).toLowerCase(); const byName=defs.find(d=>String(d.name).toLowerCase()===nm); if(byName) return byName; }
  return null;
}

function buildReceiptHTML(order, widthMm = 80) {
  const m = Math.max(0, Math.min(4, 4)); // padding mm
  const currency = (v) => `E£${Number(v || 0).toFixed(2)}`;
  const dt = new Date(order.date);
  const orderDateStr = fmtDate(dt);
  const orderTimeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const itemsSubtotal =
    order.itemsTotal != null
      ? Number(order.itemsTotal || 0)
      : (order.cart || []).reduce((sum, line) => {
          const base = Number(line.price || 0);
          const extrasSum = (line.extras || []).reduce(
            (s, e) => s + Number(e.price || 0),
            0
          );
          const q = Number(line.qty || 1);
          return sum + (base + extrasSum) * q;
        }, 0);

  const deliveryFee =
    order.orderType === "Delivery"
      ? Math.max(0, Number(order.deliveryFee || 0))
      : 0;

  const grandTotal =
    order.total != null ? Number(order.total || 0) : itemsSubtotal + deliveryFee;
  const paymentBreakdownHtml =
  Array.isArray(order.paymentParts) && order.paymentParts.length
    ? order.paymentParts
        .map(
          (pp) => `
      <div class="row"><div>${escHtml(pp.method)}</div><div>${currency(pp.amount)}</div></div>
    `
        )
        .join("")
    : "";
 const rowsHtml = (order.cart || [])
    .map((ci) => {
      const q = Number(ci.qty || 1);
      const base = `
        <div class="tr">
          <div class="td c-item">${escHtml(ci.name)}</div>
          <div class="td c-qty">${q}</div>
          <div class="td c-price">${currency(ci.price)}</div>
          <div class="td c-total">${currency(ci.price * q)}</div>
        </div>
      `;
      const extras = (ci.extras || [])
        .map(
          (ex) => `
          <div class="tr">
            <div class="td c-item extra">+ ${escHtml(ex.name)}</div>
            <div class="td c-qty">${q}</div>
            <div class="td c-price">${currency(ex.price)}</div>
            <div class="td c-total">${currency(ex.price * q)}</div>
          </div>
        `
        )
        .join("");
      return base + extras;
    })
    .join("");

  const noteBlock =
    order.note && String(order.note).trim()
      ? `
    <div class="note">
      <div class="label">Order Note</div>
      <div class="body">${escHtml(String(order.note).trim())}</div>
    </div>
  `
      : "";
const deliveryInfoBlock =
  order.orderType === "Delivery"
    ? `
  <div class="cust">
    <div class="meta"><strong>Customer:</strong> ${escHtml(order.deliveryName || "")}</div>
    <div class="meta"><strong>Phone:</strong> ${escHtml(order.deliveryPhone || "")}</div>
    <div class="meta"><strong>Address:</strong> ${escHtml(order.deliveryAddress || "")}</div>
  </div>
`
    : "";
const cashBlock = (() => {
  if (order.cashReceived == null) return "";
  return `
    <div class="row"><div>Cash Received</div><div>${currency(order.cashReceived)}</div></div>
    <div class="row"><div>Change</div><div>${currency(order.changeDue || 0)}</div></div>
  `;
})();
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Receipt</title>
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .receipt {
    width: ${widthMm}mm;
    padding: ${m}mm ${m}mm ${m/2}mm ${m}mm;
    font: 11pt/1.35 "Segoe UI", Arial, sans-serif;
    color: #000;
    background: #fff;
  }

  .brand img {
    display: block;
    margin: 0 auto 1mm;
    width: 100%;
    max-width: calc((${widthMm}mm - ${m*2}mm) * .68);
    height: auto;
    object-fit: contain;
  }

  .title { font-weight: 700; text-align: center; font-size: 13pt; margin: 1mm 0 .5mm; }
  .meta.address { text-align: center; font-size: 9pt; opacity: .9; }
  .meta { text-align: left; font-size: 9pt; opacity: .9; }

  .sep { border-top: 1px dashed #000; margin: 2mm 0; }

  .note{
    margin: 1mm 0 2mm;
    padding: 1.5mm;
    border: 1px dashed rgba(0,0,0,.6);
    border-radius: 4px;
    background: #fff;
  }
  .note .label{ font-weight:700; font-size:9pt; margin-bottom:1mm; }
  .note .body{ font-size:10pt; white-space: pre-wrap; }
  .table { display:grid; grid-auto-rows:auto; row-gap:1mm; }
  .thead, .tr {
    display:grid;
    grid-template-columns: 5fr 1fr 2fr 2.5fr; /* Item | Qty | Price | Total */
    column-gap: 2mm; align-items: end;
  }
  .thead {
    font-weight: 700; font-size: 10pt;
    border-bottom: 1px dashed #000; padding-bottom: 1mm;
  }
  .tr { border-bottom: 1px dashed rgba(0,0,0,.6); padding-bottom: 1mm; }
  .c-qty, .c-price, .c-total { text-align: right; }
  .c-item { word-break: break-word; }
  .extra { font-size: 10pt; opacity: .9; }
  .totals { display: grid; gap: 1mm; margin-top: 1mm; }
  .totals .row { display: flex; justify-content: space-between; gap: 4mm; font-weight: 600; }
  .total { font-size: 13pt; font-weight: 900; }

  .footer { margin-top: 2mm; }
  .thanks { text-align: center; font-size: 9pt; margin-bottom: 6mm; white-space: pre-line; }
  .logos { display: flex; justify-content: space-between; align-items: center; gap: 3mm; }
  .logos img { display: block; object-fit: contain; height: auto; }
  .logos img.menu { width: calc((${widthMm}mm - ${m*2}mm) * .42); }
  .logos img.delivery { width: calc((${widthMm}mm - ${m*2}mm) * .52); }
  @media screen { body { background:#f6f6f6; } .receipt { box-shadow: 0 0 6px rgba(0,0,0,.12); margin: 8px auto; } }
  @media print { .receipt { box-shadow:none; } }
</style>
</head>
<body>
  <div class="receipt">
    <div class="brand"><img src="/tuxlogo.jpg" alt="TUX logo"></div>
   <div class="title">TUX — Burger Truck</div>
    <div class="meta address">El-Saada St – Zahraa El-Maadi</div>
    <!-- Order meta -->
    <div class="meta">Order No: <strong>#${escHtml(order.orderNo)}</strong></div>
    <div class="meta">Order Date: <strong>${escHtml(orderDateStr)}</strong> • Time: <strong>${escHtml(orderTimeStr)}</strong></div>
    <div class="meta">Worker: ${escHtml(order.worker)} • Payment: ${escHtml(order.payment)} • Type: ${escHtml(order.orderType || "")}</div>
    ${noteBlock}
    ${deliveryInfoBlock}
    <div class="sep"></div>
    <div class="table">
      <div class="thead">
        <div class="th c-item">Item</div>
        <div class="th c-qty">Qty</div>
        <div class="th c-price">Price</div>
        <div class="th c-total">Total</div>
      </div>
      ${rowsHtml}
    </div>
    <div class="sep"></div>
    <div class="totals">
  <div class="row"><div>Items Subtotal</div><div>${currency(itemsSubtotal)}</div></div>
  ${deliveryFee > 0 ? `<div class="row"><div>Delivery Fee</div><div>${currency(deliveryFee)}</div></div>` : ``}
  <div class="row total"><div>TOTAL</div><div>${currency(grandTotal)}</div></div>
  ${paymentBreakdownHtml ? `<div class="row"><div style="font-weight:700">Paid by</div><div></div></div>` : ``}
  ${paymentBreakdownHtml}
  ${cashBlock}
</div>
    <div class="footer">
      <div class="thanks">Thank you for choosing TUX
See you soon</div>
      <div class="logos">
        <img class="menu" src="/menu-qr.jpg" alt="Menu QR">
        <img class="delivery" src="/delivery-logo.jpg" alt="Delivery">
      </div>
    </div>
  </div>
</body>
</html>
`;
}
function printReceiptHTML(order, widthMm = 80, copy = "Customer", images) {
  const html = buildReceiptHTML(order, widthMm, copy, images);
  const ifr = document.createElement("iframe");
  Object.assign(ifr.style, { position:"fixed", right:0, bottom:0, width:0, height:0, border:0 });
  let htmlWritten = false;
  ifr.addEventListener("load", () => {
    if (!htmlWritten) return;
    try {
      const w = ifr.contentWindow;
      if (!w) return;
      requestAnimationFrame(() => {
        w.focus();
        w.print();
        const cleanup = () => { try { ifr.remove(); } catch {} };
        w.addEventListener("afterprint", cleanup, { once: true });
        setTimeout(cleanup, 8000);
      });
    } catch {}
  });
  document.body.appendChild(ifr);
  const doc = ifr.contentDocument || ifr.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  htmlWritten = true;
  setTimeout(() => { try { if (document.body.contains(ifr)) ifr.remove(); } catch {} }, 12000);
}
const normalizePhone = (s) => {
  let digits = String(s || "").replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("20")) {
    return digits.slice(0, 12);
  }
  if (digits.startsWith("2") && digits.length > 11) {
    return digits.slice(0, 12);
  }
  return digits.slice(0, 11);
};
const extractLocalPhoneDigits = (raw) => {
  const digits = normalizePhone(raw);
  if (!digits) return "";
  if (digits.startsWith("20")) return digits.slice(2, 12);
  if (digits.startsWith("0")) return digits.slice(1, 11);
  return digits.slice(0, 10);
};
const toCanonicalLocalPhone = (raw) => {
  const local = extractLocalPhoneDigits(raw);
  if (!local) return "";
  return `0${local}`.slice(0, 11);
};
const formatPhoneForDisplay = (raw) => {
  const digits = normalizePhone(raw);
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length >= 2) {
    return `+20${digits.slice(1)}`;
  }
  if (digits.startsWith("20")) return `+${digits}`;
  if (digits.startsWith("2")) return `+${digits}`;
  return `+20${digits}`;
};
const formatPhoneForWhatsapp = (raw) => {
  let digits = normalizePhone(raw);
  if (!digits) return "";
  if (digits.startsWith("0") && digits.length > 1) {
    digits = `2${digits}`;
  } else if (!digits.startsWith("20")) {
    digits = `20${digits}`;
  }
  return digits.replace(/^\+/, "");
};
const hasWhatsappNumberLength = (raw) => /^20\d{10}$/.test(formatPhoneForWhatsapp(raw));
const openWhatsappNotification = (order, phoneDigits) => {
  const waNumber = formatPhoneForWhatsapp(phoneDigits);
  if (!waNumber) return;
  const name = order?.deliveryName?.trim() || "customer";
  const orderLabel = order?.orderNo ? ` #${order.orderNo}` : "";
  const typeKey = normalizeNameKey(order?.orderType);
  const isDelivery = typeKey === "delivery";
  const message = isDelivery
    ? `Hello ${name}, your order${orderLabel} is out for delivery.`
    : `Hello ${name}, your order${orderLabel} is ready for pickup.`;
  const encodedMessage = encodeURIComponent(message);
  const appUrl = `whatsapp://send?phone=${waNumber}&text=${encodedMessage}`;
  const fallbackUrl = `https://wa.me/${waNumber}?text=${encodedMessage}`;

  if (typeof window === "undefined") return;

  const openFallback = () => {
    if (window?.open) {
      window.open(fallbackUrl, "_blank", "noopener");
    }
  };

  let fallbackTimer = null;
  const cancelFallback = () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("blur", cancelFallback);
      window.removeEventListener("pagehide", cancelFallback);
    }
  };

  try {
    if (typeof document !== "undefined" && document.body) {
      const anchor = document.createElement("a");
      anchor.href = appUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      fallbackTimer = setTimeout(openFallback, 1500);
      window.addEventListener("blur", cancelFallback, { once: true });
      window.addEventListener("pagehide", cancelFallback, { once: true });
      return;
    }
  } catch (err) {
    cancelFallback();
  }

  openFallback();
};
const upsertCustomer = (list, rec) => {
  const phone = normalizePhone(rec.phone);
  const existing = (list || []).find((c) => normalizePhone(c.phone) === phone) || {};
  const without = (list || []).filter((c) => normalizePhone(c.phone) !== phone);
  return [{ ...existing, ...rec, phone }, ...without];
};
const parseDateMaybe = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const d = new Date(value);
  return Number.isNaN(+d) ? null : d;
};
function dedupeCustomers(list = []) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const p = normalizePhone(c.phone);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({
      ...c,
      phone: p,
      lastOrderAt: parseDateMaybe(c.lastOrderAt),
      firstOrderAt: parseDateMaybe(c.firstOrderAt),
      updatedAt: parseDateMaybe(c.updatedAt),
    });
  }
  return out;
}
const calculateCustomerLifetimeSpend = (phone, orders = []) => {
  const target = normalizePhone(phone);
  if (!target) return 0;
  const total = (orders || []).reduce((sum, order) => {
    if (!order || order.voided) return sum;
    const orderPhone = normalizePhone(order.deliveryPhone);
    if (!orderPhone || orderPhone !== target) return sum;
    const amount = Number(order.total || 0);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  return Number(total.toFixed(2));
};
const categorizeCustomerActivity = (contact = {}, now = new Date()) => {
  const last = parseDateMaybe(contact.lastOrderAt || contact.lastOrderDate);
  const count = Number(contact.orderCount || contact.ordersCount || 0);
  if (!count) {
    return last ? "dormant" : "new";
  }
  if (!last) return "dormant";
  const diffDays = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  if (count <= 1) {
    return diffDays <= 30 ? "new" : "dormant";
  }
  if (diffDays <= 45) return "regular";
  if (count >= 4 && diffDays <= 90) return "regular";
  return "dormant";
};
const buildCustomerContactRows = (
  contacts = [],
  liveOrders = [],
  historicalOrders = [],
  deliveryZones = []
) => {
  const zoneMap = new Map((deliveryZones || []).map((z) => [z.id, z]));
  const allOrders = [...(historicalOrders || []), ...(liveOrders || [])];
  return (contacts || [])
    .map((contact, idx) => {
      const phone = normalizePhone(contact.phone);
      const ordersForContact = allOrders.filter(
        (order) => normalizePhone(order?.deliveryPhone) === phone && !order?.voided
      );
      const latestOrder = ordersForContact.reduce(
        (acc, order) => {
          const when = parseDateMaybe(order?.date);
          if (!when) return acc;
          if (!acc || when > acc.when) return { when, order };
          return acc;
        },
        null
      );
      const firstOrder = ordersForContact.reduce(
        (acc, order) => {
          const when = parseDateMaybe(order?.date);
          if (!when) return acc;
          if (!acc || when < acc) return when;
          return acc;
        },
        parseDateMaybe(contact.firstOrderAt)
      );
      const totalSpend =
        contact.totalSpend != null
          ? Number(contact.totalSpend || 0)
          : calculateCustomerLifetimeSpend(phone, allOrders);
      const orderCount =
        contact.orderCount != null
          ? Number(contact.orderCount || 0)
          : ordersForContact.length;
      const lastOrderAt =
        parseDateMaybe(contact.lastOrderAt) || latestOrder?.when || null;
      const zoneId = contact.zoneId || latestOrder?.order?.deliveryZoneId || "";
      const zoneName = zoneId ? zoneMap.get(zoneId)?.name || zoneId : "";
      const tags = Array.isArray(contact.tags) ? contact.tags.map(String) : [];
      const activity = categorizeCustomerActivity(
        { ...contact, orderCount, lastOrderAt },
        new Date()
      );
      if (activity) {
        const label = activity.charAt(0).toUpperCase() + activity.slice(1);
        if (!tags.includes(label)) tags.push(label);
      }
      return {
        id: phone || contact.id || `contact_${idx}`,
        displayName:
          contact.name || latestOrder?.order?.deliveryName || "Unknown customer",
        phone,
        address: contact.address || latestOrder?.order?.deliveryAddress || "",
        zoneId,
        zoneName,
        tags,
        lastOrderAt,
        lastOrderTotal:
          latestOrder?.order?.total != null
            ? Number(latestOrder.order.total || 0)
            : contact.lastOrderTotal != null
            ? Number(contact.lastOrderTotal || 0)
            : 0,
        lastOrderNo:
          latestOrder?.order?.orderNo ?? contact.lastOrderNo ?? null,
        totalSpend: Number(totalSpend.toFixed(2)),
        orderCount,
        firstOrderAt: firstOrder,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.totalSpend - a.totalSpend || (b.lastOrderAt || 0) - (a.lastOrderAt || 0));
};
const searchCustomersByQuery = (rows = [], query = "") => {
  const q = String(query || "").trim();
  if (!q) return rows;
  const lowered = q.toLowerCase();
  const digits = q.replace(/\D/g, "");
  return rows.filter((row) => {
    const haystacks = [row.displayName, row.address, row.zoneName]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());
    const tagMatch = (row.tags || [])
      .map((t) => String(t).toLowerCase())
      .some((t) => t.includes(lowered));
    const phoneMatch = digits
      ? String(row.phone || "").includes(digits)
      : String(row.phone || "").includes(lowered);
    const textMatch = haystacks.some((text) => text.includes(lowered));
    return phoneMatch || textMatch || tagMatch;
  });
};
const isExpenseLocked = (e) =>
  !!(e?.locked || e?.source === "order_return" || e?.orderNo != null);
const isBankLocked = (t) =>
  !!(
    t?.locked ||
    t?.source === "auto_day_margin" ||
    (t?.type === "init" && /Auto Init from day margin/i.test(t?.note || ""))
  );
export default function App() {
  const [activeTab, setActiveTab] = useState("orders");
const [adminSubTab, setAdminSubTab] = useState("inventory"); 
  const [dark, setDark] = useState(false);
  const [workers, setWorkers] = useState(BASE_WORKERS);
  
const [newWorker, setNewWorker] = useState("");
const [paymentMethods, setPaymentMethods] = useState(DEFAULT_PAYMENT_METHODS);
const [newPayment, setNewPayment] = useState("");
const [targetMarginPct, setTargetMarginPct] = useState(() => {
  const l = loadLocal();
  const v = Number(l?.targetMarginPct);
  return isFinite(v) ? v : 0.5; // default 50% like your screenshot
});
const [utilityBills, setUtilityBills] = useState(() => {
  const l = loadLocal();
  return normalizeUtilityBills(l?.utilityBills || DEFAULT_UTILITY_BILLS);
});
const [laborProfile, setLaborProfile] = useState(() => {
  const l = loadLocal();
  return normalizeLaborProfile(l?.laborProfile || DEFAULT_LABOR_PROFILE);
});
const [equipmentList, setEquipmentList] = useState(() => {
  const l = loadLocal();
  const raw = Array.isArray(l?.equipmentList) ? l.equipmentList : BASE_EQUIPMENT;
  return normalizeEquipmentList(raw);
});
const [showLowMarginOnly, setShowLowMarginOnly] = useState(() => {
  const l = loadLocal();
  return Boolean(l?.showLowMarginOnly);
});
const [cogsTypeFilter, setCogsTypeFilter] = useState("all");
const [cogsSearch, setCogsSearch] = useState("");
const [cogsSort, setCogsSort] = useState({ key: "margin", dir: "asc" });
const [inlinePriceDrafts, setInlinePriceDrafts] = useState({});
  const [historicalOrders, setHistoricalOrders] = useState(() => {
  const l = loadLocal();
  const raw = Array.isArray(l.historicalOrders) ? l.historicalOrders : [];
  return raw.map((order) => {
    const converted = {
      ...order,
      date: order?.date ? new Date(order.date) : order?.date,
      restockedAt: order?.restockedAt ? new Date(order.restockedAt) : order?.restockedAt,
    };
    return enrichOrderWithChannel(converted);
  });
});
const [historicalExpenses, setHistoricalExpenses] = useState(() => {
  const l = loadLocal();
  return l.historicalExpenses || [];
});
const [historicalPurchases, setHistoricalPurchases] = useState(() => {
  const l = loadLocal();
  return l.historicalPurchases || [];
});
const [reportFilter, setReportFilter] = useState("shift");
const [reportDay, setReportDay] = useState(() => new Date().toISOString().slice(0, 10));
const [reportMonth, setReportMonth] = useState(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
});
const [marginChartFilter, setMarginChartFilter] = useState("week");
const [marginChartWeek, setMarginChartWeek] = useState(() =>
  getSundayWeekInfo(new Date()).week
);
const [marginChartWeekYear, setMarginChartWeekYear] = useState(() =>
  getSundayWeekInfo(new Date()).year
);
const [marginChartMonthSelection, setMarginChartMonthSelection] = useState(() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
});
const [marginChartYearSelection, setMarginChartYearSelection] = useState(() =>
  new Date().getFullYear()
);
  const [bankFilter, setBankFilter] = useState("day");
const [bankDay, setBankDay] = useState(new Date().toISOString().slice(0, 10));
const [bankMonth, setBankMonth] = useState(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
});
const [newItemName, setNewItemName] = useState("");
const [newItemPrice, setNewItemPrice] = useState(0);
const [newItemColor, setNewItemColor] = useState("#ffffff");
  const addMenuFromForm = () => {
  const name = String(newItemName || "").trim();
  if (!name) return alert("Name required.");
  const id = getNextMenuId(menu);
setMenu((arr) => [
    ...arr,
    {
      id,
      name,
      price: Math.max(0, Number(newItemPrice || 0)),
      uses: {},
      color: newItemColor || "#ffffff",
      prepMinutes: 0,
      equipmentMinutes: {},
    },
  ]);
  setNewItemName("");
  setNewItemPrice(0);
  setNewItemColor("#ffffff");
};
const [inventory, setInventory] = useState(DEFAULT_INVENTORY);
const [inventoryLocked, setInventoryLocked] = useState(false);
const [inventorySnapshot, setInventorySnapshot] = useState([]);
const [inventoryLockedAt, setInventoryLockedAt] = useState(null);
const [showLowStock, setShowLowStock] = useState(false);
const [purchaseCategories, setPurchaseCategories] = useState(() =>
  normalizePurchaseCategories(loadLocal().purchaseCategories || [])
);
const [purchases, setPurchases] = useState([]);
const [purchaseFilter, setPurchaseFilter] = useState("day");
const [purchaseCatFilterId, setPurchaseCatFilterId] = useState("");
const [purchaseDay, setPurchaseDay] = useState(
  new Date().toISOString().slice(0, 10)
);
const [purchaseMonth, setPurchaseMonth] = useState(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
});
const [showAllCats, setShowAllCats] = useState(true);
const [newPurchase, setNewPurchase] = useState({
  categoryId: "",
  itemName: "",
  unit: "piece",
  qty: 1,
  unitPrice: "",
  date: new Date().toISOString().slice(0, 10),
  ingredientId: "",
});
const lowStockItems = useMemo(() => {
  return (inventory || []).filter(it => {
    const min = Number(it.minQty || 0);
    if (min <= 0) return false; // threshold not set
    return Number(it.qty || 0) <= min; // at or below threshold
  });
}, [inventory]);
const inventoryReportRows = useMemo(() => {
  if (!inventorySnapshot || inventorySnapshot.length === 0) return [];
  const snapMap = {};
  for (const s of inventorySnapshot) snapMap[s.id] = s;
  return inventory.map((it) => {
    const s = snapMap[it.id];
    const start = s ? s.qtyAtLock : 0;
    const now = it.qty;
    const used = Math.max(0, start - now);
    return { name: it.name, unit: it.unit, start, now, used };
  });
}, [inventory, inventorySnapshot]);
const reorderSuggestions = useMemo(() => {
  if (!Array.isArray(inventory) || !inventory.length) return [];

  const msPerDay = 24 * 60 * 60 * 1000;
  const now = new Date();
  const lockDate =
    inventoryLockedAt instanceof Date
      ? inventoryLockedAt
      : inventoryLockedAt
      ? new Date(inventoryLockedAt)
      : null;
  const windowDays = lockDate ? Math.max(1, (now - lockDate) / msPerDay) : 7;
  const windowStart = lockDate
    ? lockDate
    : new Date(now.getTime() - windowDays * msPerDay);

  const invById = new Map((inventory || []).map((it) => [it.id, it]));
  const snapshotById = new Map(
    (inventorySnapshot || []).map((s) => [s.id, s])
  );
  const reportByName = new Map(
    (inventoryReportRows || []).map((row) => [row.name, row])
  );

  const purchaseTotals = new Map();
  const lastPurchaseAt = new Map();
  const allPurchases = [...(historicalPurchases || []), ...(purchases || [])];
  for (const p of allPurchases) {
    const inv = p?.ingredientId ? invById.get(p.ingredientId) : null;
    if (!inv) continue;
    const when = p?.date instanceof Date ? p.date : p?.date ? new Date(p.date) : null;
    if (!when || Number.isNaN(+when) || when < windowStart) continue;
    const qtyConv = convertToInventoryUnit(
      Number(p.qty || 0),
      p.unit,
      inv.unit
    );
    const qty = qtyConv != null ? Number(qtyConv) : Number(p.qty || 0);
    if (!Number.isFinite(qty)) continue;
    purchaseTotals.set(inv.id, (purchaseTotals.get(inv.id) || 0) + qty);
    const prev = lastPurchaseAt.get(inv.id);
    if (!prev || when > prev) lastPurchaseAt.set(inv.id, when);
  }

  const suggestions = [];
  const targetDays = 7;

  for (const item of inventory || []) {
    const min = Number(item?.minQty || 0);
    if (!(min > 0)) continue;

    const currentQty = Number(item?.qty || 0);
    const snap = snapshotById.get(item.id);
    const reportRow = reportByName.get(item.name);
    const startQty = snap && snap.qtyAtLock != null ? Number(snap.qtyAtLock) : null;
    const usedSinceLock =
      reportRow && reportRow.used != null
        ? Number(reportRow.used || 0)
        : startQty != null
        ? Math.max(0, Number(startQty) - currentQty)
        : 0;
    const usagePerDay = usedSinceLock > 0 ? usedSinceLock / windowDays : 0;
    const baselineUsage = usagePerDay > 0 ? usagePerDay : min / targetDays;
    const desiredStock = baselineUsage * targetDays;
    const recentPurchases = Number(purchaseTotals.get(item.id) || 0);
    const recommendedRaw = desiredStock - currentQty - recentPurchases;
    const recommendedQty = recommendedRaw > 0 ? recommendedRaw : 0;
    const daysRemaining = baselineUsage > 0 ? currentQty / baselineUsage : null;

    const reasonParts = [];
    if (usagePerDay > 0)
      reasonParts.push(`≈${usagePerDay.toFixed(2)} ${item.unit || ""}/day used`);
    else reasonParts.push("usage based on min threshold");
    reasonParts.push(`target ${targetDays}-day stock`);
    if (recentPurchases > 0)
      reasonParts.push(
        `${recentPurchases.toFixed(1)} ${item.unit || ""} bought recently`
      );
    if (daysRemaining != null)
      reasonParts.push(`${daysRemaining.toFixed(1)}d on hand`);
    if (lastPurchaseAt.has(item.id))
      reasonParts.push(
        `last buy ${formatDateDDMMYY(lastPurchaseAt.get(item.id))}`
      );

    suggestions.push({
      id: item.id,
      name: item.name,
      unit: item.unit,
      currentQty,
      minQty: min,
      usagePerDay,
      baselineUsage,
      daysRemaining,
      recentPurchases,
      recommendedQty,
      rationale: reasonParts.join(" · "),
    });
  }

  suggestions.sort((a, b) => b.recommendedQty - a.recommendedQty);
  return suggestions;
}, [
  inventory,
  inventorySnapshot,
  inventoryLockedAt,
  inventoryReportRows,
  purchases,
  historicalPurchases,
]);
const reorderSuggestionById = useMemo(() => {
  const map = new Map();
  for (const s of reorderSuggestions) map.set(s.id, s);
  return map;
}, [reorderSuggestions]);
const lowStockCount = lowStockItems.length;
const [dayMeta, setDayMeta] = useState({
  startedBy: "",
  currentWorker: "",
  startedAt: null,
  endedAt: null,
  endedBy: "",
  lastReportAt: null,
  resetBy: "",
  resetAt: null,
  shiftChanges: [],
});
const [workerProfiles, setWorkerProfiles] = useState(BASE_WORKER_PROFILES);
const [showAddWorker, setShowAddWorker] = useState(false);
  const [usageFilter, setUsageFilter] = useState(() => {
  const l = loadLocal();
  return l?.usageFilter || "week";
});
const [usageWeekDate, setUsageWeekDate] = useState(() => {
  const l = loadLocal();
  return l?.usageWeekDate || new Date().toISOString().slice(0, 10);
});
const [usageMonth, setUsageMonth] = useState(() => {
  const l = loadLocal();
  return l?.usageMonth || new Date().toISOString().slice(0, 7);
});
const resetUsageViewAdmin = () => {
  const okAdmin = !!promptAdminAndPin();
  if (!okAdmin) return;

  // Reset historical data
  setHistoricalOrders([]);
  setHistoricalExpenses([]);
  setHistoricalPurchases([]);
  
  // Save empty arrays to localStorage
  saveLocalPartial({
    historicalOrders: [],
    historicalExpenses: [],
    historicalPurchases: []
  });
  
  // Reset the Usage tab view back to default
  setUsageFilter("week");
  setUsageWeekDate(new Date().toISOString().slice(0, 10));
  setUsageMonth(new Date().toISOString().slice(0, 7));

  alert("Inventory Usage data has been reset.");
};

const [newWName, setNewWName] = useState("");
const [newWPin, setNewWPin] = useState("");
const [newWRate, setNewWRate] = useState("");
const [workerSessions, setWorkerSessions] = useState([]);
const workerSessionsRef = useRef(workerSessions);
useEffect(() => {
  workerSessionsRef.current = workerSessions;
}, [workerSessions]);const [workerLogFilter, setWorkerLogFilter] = useState("month"); // 'day' | 'week' | 'month'
const [workerLogDay, setWorkerLogDay] = useState(() => new Date().toISOString().slice(0,10));
const [workerLogWeekStart, setWorkerLogWeekStart] = useState(() => getSundayStart(new Date()));
const [workerLogMonth, setWorkerLogMonth] = useState(() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
});
const workerWeekInfo = useMemo(
  () => getSundayWeekInfo(workerLogWeekStart, true),
  [workerLogWeekStart]
);
const [signInPin, setSignInPin] = useState("");
const [signOutPin, setSignOutPin] = useState("");
const activeWorkers = useMemo(() => {
  const open = (workerSessions || []).filter(s => !s.signOutAt);
  const names = [...new Set(open.map(s => s.name))];
  return names;
}, [workerSessions]);
const [orders, setOrders] = useState([]);
const [onlineFbUser, setOnlineFbUser] = useState(null);const [orderBoardFilter, setOrderBoardFilter] = useState(() => {
  const l = loadLocal();
  return l?.orderBoardFilter === "online" ? "online" : "onsite";
});
const [lastSeenOnlineOrderTs, setLastSeenOnlineOrderTs] = useState(() => {
  const l = loadLocal();
  const v = Number(l?.lastSeenOnlineOrderTs);
  return Number.isFinite(v) ? v : 0;
});
const [onlineViewCutoff, setOnlineViewCutoff] = useState(() => {
  const l = loadLocal();
  const v = Number(l?.lastSeenOnlineOrderTs);
  return Number.isFinite(v) ? v : 0;
});
const [onlineOrdersRaw, setOnlineOrdersRaw] = useState([]);
const onlineOrderSourcesRef = useRef({});const [bankTx, setBankTx] = useState([]);
const [onlineOrderStatus, setOnlineOrderStatus] = useState(() => {
  const raw = loadLocal()?.onlineOrderStatus;
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue;
    out[key] = { ...value };
  }
  return out;
});
const [reconCounts, setReconCounts] = useState({});
const handleReconCountChange = useCallback((method, rawValue) => {
  setReconCounts((rc) => {
    const next = { ...rc };
    const value = rawValue == null ? "" : String(rawValue);
    if (
      value === "" ||
      value === "-" ||
      value === "." ||
      value === "-." ||
      Number.isNaN(Number(value))
    ) {
      delete next[method];
    } else {
      next[method] = Number(value);
    }
    return next;
  });
}, []);const [reconSavedBy, setReconSavedBy] = useState("");
const [reconHistory, setReconHistory] = useState([]);
const accountedOnlineOrders = useMemo(() => {
  const seen = new Set();
  for (const ord of orders || []) {
    if (!ord) continue;
    if (ord.onlineOrderKey) seen.add(ord.onlineOrderKey);
    if (ord.onlineOrderId) seen.add(`id:${ord.onlineOrderId}`);
    if (ord.onlineSourceCollection && ord.onlineSourceDocId) {
      seen.add(`${ord.onlineSourceCollection}/${ord.onlineSourceDocId}`);
    }
  }

  const startMs = dayMeta?.startedAt ? new Date(dayMeta.startedAt).getTime() : null;
  const endMs = dayMeta?.endedAt ? new Date(dayMeta.endedAt).getTime() : null;
  const shouldSkipStatus = (status) => {
    const key = normalizeNameKey(status);
    if (!key) return false;
    return (
      key.includes("cancel") ||
      key.includes("void") ||
      key.includes("reject") ||
      key.includes("fail") ||
      key.includes("refund") ||
      key.includes("return")
    );
  };

  const eligible = [];
  for (const ord of onlineOrdersRaw || []) {
    if (!ord) continue;
    if (shouldSkipStatus(ord.status)) continue;
    const ts = Number(ord.createdAtMs || (ord.createdAt ? +new Date(ord.createdAt) : NaN));
    if (startMs && (!Number.isFinite(ts) || ts < startMs)) continue;
    if (endMs && (!Number.isFinite(ts) || ts > endMs)) continue;

    const candidates = [
      getOnlineOrderDedupeKey(ord),
      ord.id ? `id:${ord.id}` : null,
      ord.sourceCollection && ord.sourceDocId
        ? `${ord.sourceCollection}/${ord.sourceDocId}`
        : null,
    ].filter(Boolean);
    if (candidates.some((key) => seen.has(key))) continue;

    const total = Number(ord.total || 0);
    if (!Number.isFinite(total) || total <= 0) continue;

    eligible.push(ord);
  }

  return eligible;
}, [onlineOrdersRaw, orders, dayMeta]);
const rawInflowByMethod = useMemo(() => {
 
  return sumPaymentsByMethod(orders);
}, [orders]);
const expectedByMethod = useMemo(() => {
  const out = {};
  for (const m of paymentMethods || []) {
    const raw = Number(rawInflowByMethod[m] || 0);
    out[m] = raw;
  }
  return out;
}, [paymentMethods, rawInflowByMethod]);
const varianceByMethod = useMemo(() => {
  const out = {};
  for (const m of paymentMethods || []) {
    const actual = Number(reconCounts[m] || 0);
    const expected = Number(expectedByMethod[m] || 0);
    out[m] = Number((actual - expected).toFixed(2));
  }
  return out;
}, [paymentMethods, reconCounts, expectedByMethod]);
const allTimeVarianceByMethod = useMemo(() => {
  const out = {};
  for (const m of paymentMethods || []) out[m] = 0;
  for (const r of reconHistory || []) {
    const bd = r?.breakdown || {};
    for (const k of Object.keys(bd)) {
      const v = Number(bd[k]?.variance || 0);
      out[k] = Number(((out[k] || 0) + v).toFixed(2));
    }
  }
  return out;
}, [reconHistory, paymentMethods]);
const allTimeVarianceTotal = useMemo(
  () => Object.values(allTimeVarianceByMethod).reduce((s, v) => s + Number(v || 0), 0),
  [allTimeVarianceByMethod]
);
const resetAllReconciliations = () => {
  const okAdmin = !!promptAdminAndPin();
  if (!okAdmin) return;
  if (!window.confirm("Reset ALL saved reconciliations and variance totals? This cannot be undone.")) return;
  setReconHistory([]);
  alert("All reconciliations cleared.");
};
const totalVariance = useMemo(
  () => Object.values(varianceByMethod).reduce((s, v) => s + Number(v || 0), 0),
  [varianceByMethod]
);
const hasMeaningfulActualCounts = useMemo(
  () =>
    (paymentMethods || []).every((m) => {
      const raw = reconCounts[m];
      if (raw == null || raw === "") return false;
      const numeric = Number(raw);
      return Number.isFinite(numeric) && numeric !== 0;
    }),
  [paymentMethods, reconCounts]
);
const saveReconciliation = () => {
  if (!dayMeta.startedAt) return alert("Start a shift first.");
  const who = String(reconSavedBy || dayMeta.currentWorker || "").trim();
  if (!who) return alert("Select or type who saved it (Saved by).");
  const missingActualMethods = (paymentMethods || []).filter(
    (m) => !Object.prototype.hasOwnProperty.call(reconCounts, m)
  );
  if (missingActualMethods.length) {
    return alert("Enter the counted amount for each payment method before saving.");
  }
if (!hasMeaningfulActualCounts) {
    return alert("Enter a non-zero counted amount for each payment method before saving.");
  }
  const breakdown = {};
  for (const m of paymentMethods || []) {
    const expected = Number(expectedByMethod[m] || 0);
    const actual = Number(reconCounts[m] || 0);
    breakdown[m] = {
      expected: Number(expected.toFixed(2)),
      actual: Number(actual.toFixed(2)),
      variance: Number((actual - expected).toFixed(2)),
    };
  }
  const rec = {
    id: `rec_${Date.now()}`,
    savedBy: who,
    at: new Date(),
    breakdown,
    totalVariance: Number(totalVariance.toFixed(2)),
  };
  setReconHistory(arr => [rec, ...arr]);
  setDayMeta(d => ({ ...d, reconciledAt: new Date() }));
  alert("Reconciliation saved ✅");
};
  const [menu, setMenu] = useState(BASE_MENU);
  const [extraList, setExtraList] = useState(BASE_EXTRAS);
  const [orderTypes, setOrderTypes] = useState(DEFAULT_ORDER_TYPES);
  const [defaultDeliveryFee, setDefaultDeliveryFee] = useState(DEFAULT_DELIVERY_FEE);
  const [selectedBurger, setSelectedBurger] = useState(null);
  const [selectedExtras, setSelectedExtras] = useState([]);
  const [selectedQty, setSelectedQty] = useState(1);
  const [cart, setCart] = useState([]);
  const [newCategoryUnit, setNewCategoryUnit] = useState("piece");
  const [worker, setWorker] = useState("");
  const [payment, setPayment] = useState("");
const [splitPay, setSplitPay] = useState(false);
const [payA, setPayA] = useState("");
const [payB, setPayB] = useState("");
const [amtA, setAmtA] = useState(0);
const [amtB, setAmtB] = useState(0);
const [cashReceivedSplit, setCashReceivedSplit] = useState(0);
const [newOrderType, setNewOrderType] = useState("");
const [orderNote, setOrderNote] = useState("");
const [orderType, setOrderType] = useState(orderTypes[0] || "Take-Away");
const [deliveryFee, setDeliveryFee] = useState(0);
const [deliveryName, setDeliveryName] = useState("");
const [deliveryPhone, setDeliveryPhone] = useState("");
const [deliveryAddress, setDeliveryAddress] = useState("");
const [deliveryZoneId, setDeliveryZoneId] = useState("");
const [customerName, setCustomerName] = useState("");
const [customerPhone, setCustomerPhone] = useState("");
const [syncWhatsappReady, setSyncWhatsappReady] = useState(false);            
const [customers, setCustomers] = useState([]);                         
const [deliveryZones, setDeliveryZones] = useState(DEFAULT_ZONES);
const [customerSearch, setCustomerSearch] = useState("");
const [newZoneName, setNewZoneName] = useState("");
const [newZoneFee, setNewZoneFee] = useState(0);
const addZone = () => {
  const nm = String(newZoneName || "").trim();
  if (!nm) return alert("Enter a zone name.");
  const fee = Math.max(0, Number(newZoneFee || 0));
  const id = ensureInvIdUnique(slug(nm), deliveryZones);
  setDeliveryZones((z) => [...z, { id, name: nm, fee }]);
  setNewZoneName("");
  setNewZoneFee(0);
};
const removeZone = (id) => {
  const z = deliveryZones.find((d) => d.id === id);
  if (!z) return;
  if (!window.confirm(`Delete "${z.name}"?`)) return;
  setDeliveryZones((list) => list.filter((d) => d.id !== id));
  // if the current order had this zone selected, clear it
  setDeliveryZoneId((prev) => (prev === id ? "" : prev));
};

const [newCategoryName, setNewCategoryName] = useState("");
const [cashReceived, setCashReceived] = useState(0);
const [newInvName, setNewInvName] = useState("");
const [newInvUnit, setNewInvUnit] = useState("");
const [newInvQty, setNewInvQty] = useState(0);
  const [adminPins, setAdminPins] = useState({ ...DEFAULT_ADMIN_PINS });
const verifyAdminPin = (n) => {
  const expected = norm(adminPins[n] || "");
  if (!expected) {
    alert(`Admin ${n} has no PIN set; add it in Settings → Admin PINs.`);
    return false;
  }
  const entered = window.prompt(`Enter PIN for Admin ${n}:`, "");
  if (entered == null) return false;
  return norm(entered) === expected;
};
const lockAdminPin = (n) => {
  setUnlockedPins((u) => ({ ...u, [n]: false }));
};
const unlockAdminPin = (n) => {
  if (!verifyAdminPin(n)) return;
  setUnlockedPins((u) => ({ ...u, [n]: true }));
};
  const [unlockedPins, setUnlockedPins] = useState({}); 
  const [nextOrderNo, setNextOrderNo] = useState(1);
  const [expenses, setExpenses] = useState([]);
const lastLockedRef = useRef([]);
useEffect(() => {
  const lockedNow = (expenses || []).filter(isExpenseLocked);
  const missing = lastLockedRef.current.filter(
    prev => !lockedNow.some(cur => cur.id === prev.id)
  );
  if (missing.length) {
    setExpenses(arr => [...missing, ...arr]);
  }
  lastLockedRef.current = lockedNow;
}, [expenses]);
const [bankForm, setBankForm] = useState({
    type: "deposit",
    amount: 0,
    worker: "",
    note: "",
  });
const lastLockedBankRef = useRef([]);
const skipLockedBankReinsertRef = useRef(false);
useEffect(() => {
  if (skipLockedBankReinsertRef.current) {
    skipLockedBankReinsertRef.current = false;
    lastLockedBankRef.current = (bankTx || []).filter(isBankLocked);
    return;
  }

  const lockedNow = (bankTx || []).filter(isBankLocked);
  const missing = lastLockedBankRef.current.filter(
    prev => !lockedNow.some(cur => cur.id === prev.id)
  );
  if (missing.length) {
    setBankTx(arr => [...missing, ...arr]);
  }
  lastLockedBankRef.current = lockedNow;
}, [bankTx]);
  const [newExpName, setNewExpName] = useState("");
  const [newExpUnit, setNewExpUnit] = useState("pcs");
  const [newExpQty, setNewExpQty] = useState(1);
  const [newExpUnitPrice, setNewExpUnitPrice] = useState(0);
  const [newExpNote, setNewExpNote] = useState("");
const [adminUnlocked, setAdminUnlocked] = useState(false);
const removeBankTx = (id) => {
  setBankTx(arr => {
    const row = arr.find(t => t.id === id);
    if (!row) return arr;
    
    // Prevent removal of payout, purchase, and negative margin transactions
    if (row.locked || row.source?.includes('auto_day')) {
      alert("This transaction is locked and cannot be removed.");
      return arr;
    }
    
    return arr.filter(t => t.id !== id);
  });
};
  const sortBy = "date-desc";
  const [newExtraName, setNewExtraName] = useState("");
  const [newExtraPrice, setNewExtraPrice] = useState(0);
  const [localHydrated, setLocalHydrated] = useState(false);
const [lastLocalEditAt, setLastLocalEditAt] = useState(0);
  /* --------------------------- FIREBASE STATE --------------------------- */
  const [fbReady, setFbReady] = useState(false);
  const [fbUser, setFbUser] = useState(null);
  const [cloudEnabled, setCloudEnabled] = useState(true);
  const [realtimeOrders, setRealtimeOrders] = useState(true);
  const [cloudStatus, setCloudStatus] = useState({
    lastSaveAt: null,
    lastLoadAt: null,
    error: null,
  });
  const [hydrated, setHydrated] = useState(false);
  const [lastAppliedCloudAt, setLastAppliedCloudAt] = useState(0);
  // Prevent our own cloud writes from boomeranging back
const clientIdRef = useRef(`cli_${Math.random().toString(36).slice(2)}`);
const writeSeqRef = useRef(0);
  // Printing preferences (kept)
  const [autoPrintOnCheckout, setAutoPrintOnCheckout] = useState(true);
  const [preferredPaperWidthMm, setPreferredPaperWidthMm] = useState(80);
  useEffect(() => {
  if (!dayMeta.startedAt) {
    setReconCounts({}); setReconSavedBy("");
    return;
  }
  const init = {};
  for (const m of paymentMethods || []) init[m] = 0;
  setReconCounts((prev) => ({ ...init, ...prev }));
}, [dayMeta.startedAt, paymentMethods]);
  useEffect(() => {
    try {
      const { auth } = ensureFirebase();
      setFbReady(true);
      const unsub = onAuthStateChanged(auth, async (u) => {
        if (!u) {
          try {
            await signInAnonymously(auth);
          } catch (e) {
            setCloudStatus((s) => ({ ...s, error: String(e) }));
          }
        } else {
          setFbUser(u);
        }
      });
      return () => unsub();
    } catch (e) {
      setCloudStatus((s) => ({ ...s, error: String(e) }));
    }
  }, []);
  useEffect(() => {
  if (purchaseFilter === "day") {
    setNewPurchase(p => ({ ...p, date: purchaseDay }));
  }
}, [purchaseFilter, purchaseDay]);
useEffect(() => {
  if (!localHydrated && !hydrated) return;
  setPurchaseCategories(list =>
    list.map(c => {
      const inv = inventory.find(
        it => it.name.toLowerCase() === String(c.name || "").toLowerCase()
      );
      return inv ? { ...c, unit: inv.unit } : c;
    })
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [inventory, localHydrated, hydrated]);

  useEffect(() => {
 if (!Array.isArray(purchaseCategories)) return;
  if (!localHydrated && !hydrated) return;
  setInventory((prev) => {
    let changed = false;
    let out = [...prev];
    for (const c of purchaseCategories) {
      const catName = String(c?.name || "").trim();
      if (!catName) continue;
      const exists = out.some(
        (it) => it.name.toLowerCase() === catName.toLowerCase()
      );
      if (!exists) {
        const idBase = slug(catName);
        const id = ensureInvIdUnique(idBase, out);
        out.push({
          id,
          name: catName,
          unit: c.unit || inferUnitFromCategoryName(catName),
          qty: 0,
          costPerUnit: 0,
           minQty: 0,
        });
        changed = true;
      }
    }
    return changed ? out : prev;
  });
}, [purchaseCategories, localHydrated, hydrated]);
useEffect(() => {
  if (!newPurchase.categoryId || newPurchase.ingredientId) return;
  const cat = purchaseCategories.find(c => c.id === newPurchase.categoryId);
  if (!cat) return;
  const match = inventory.find(it => it.name.toLowerCase() === String(cat.name || "").toLowerCase());
  if (match) {
    setNewPurchase(p => ({ ...p, ingredientId: match.id })); 
  }
}, [newPurchase.categoryId, newPurchase.ingredientId, purchaseCategories, inventory]);
  const [localDateTime, setLocalDateTime] = useState(() => {
  const now = new Date();
  return `${fmtDate(now)} ${now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
     second: "2-digit", 
    hour12: true,        
  })}`;
});
useEffect(() => {
  if (!newPurchase?.categoryId) return;
  const cat = purchaseCategories.find(c => c.id === newPurchase.categoryId);
  if (!cat) return;
  const invMatch = inventory.find(
    it => it.name.toLowerCase() === String(cat.name || "").toLowerCase()
  );
  setNewPurchase(p => ({
    ...p,
    unit: invMatch?.unit || cat.unit || p.unit || "piece",
    ingredientId: invMatch?.id || p.ingredientId || "",
  }));
}, [newPurchase.categoryId, purchaseCategories, inventory]);
useEffect(() => {
  const id = setInterval(() => {
    const now = new Date();
    setLocalDateTime(
      `${fmtDate(now)} ${now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })}`
    );
  }, 1000);
  return () => clearInterval(id);
}, []);

  /*hydrate from local*/
useEffect(() => {
  if (localHydrated) return;
  const l = loadLocal();
  if (l.menu) setMenu(l.menu);
  if (l.extraList) setExtraList(l.extraList);
  if (l.workers) setWorkers(l.workers);
 if (l.paymentMethods) setPaymentMethods(l.paymentMethods);
  if (l.orderTypes) setOrderTypes(l.orderTypes);
  if (typeof l.defaultDeliveryFee === "number") setDefaultDeliveryFee(l.defaultDeliveryFee);
  if (l.inventory) setInventory(l.inventory);
  if (l.utilityBills) setUtilityBills(normalizeUtilityBills(l.utilityBills));
  if (l.laborProfile) setLaborProfile(normalizeLaborProfile(l.laborProfile));
  if (Array.isArray(l.equipmentList)) setEquipmentList(normalizeEquipmentList(l.equipmentList));
  if (l.adminPins) setAdminPins((prev) => ({ ...prev, ...l.adminPins }));
  if (typeof l.dark === "boolean") setDark(l.dark);
  if (Array.isArray(l.workerProfiles)) setWorkerProfiles(l.workerProfiles);
  if (Array.isArray(l.workerSessions)) {
    setWorkerSessions(l.workerSessions.map(s => ({
      ...s,
      signInAt: s.signInAt ? new Date(s.signInAt) : null,
      signOutAt: s.signOutAt ? new Date(s.signOutAt) : null,
    })));
  }
  if (Array.isArray(l.reconHistory)) {
  setReconHistory(l.reconHistory.map(r => ({ ...r, at: r.at ? new Date(r.at) : new Date() })));
}
if (l.reconCounts && typeof l.reconCounts === "object") setReconCounts(l.reconCounts);
if (typeof l.reconSavedBy === "string") setReconSavedBy(l.reconSavedBy);
 if (Array.isArray(l.expenses)) {
   setExpenses(l.expenses.map(e => ({ ...e, date: e.date ? new Date(e.date) : new Date() })));
 }
   if (Array.isArray(l.purchaseCategories)) setPurchaseCategories(normalizePurchaseCategories(l.purchaseCategories)); // ⬅️ NEW
if (Array.isArray(l.purchases)) setPurchases(
  l.purchases.map(p => ({ ...p, date: p.date ? new Date(p.date) : new Date() }))
); 
if (typeof l.purchaseFilter === "string") setPurchaseFilter(l.purchaseFilter); 
if (Array.isArray(l.customers)) setCustomers(dedupeCustomers(l.customers));
if (Array.isArray(l.deliveryZones)) setDeliveryZones(l.deliveryZones); 
   if (Array.isArray(l.bankTx)) {
   setBankTx(l.bankTx.map(t => ({ ...t, date: t.date ? new Date(t.date) : new Date() })));
}
  if (l.dayMeta) {
   setDayMeta({
     ...l.dayMeta,
     startedAt: l.dayMeta.startedAt ? new Date(l.dayMeta.startedAt) : null,
     endedAt: l.dayMeta.endedAt ? new Date(l.dayMeta.endedAt) : null,
     lastReportAt: l.dayMeta.lastReportAt ? new Date(l.dayMeta.lastReportAt) : null,
     resetAt: l.dayMeta.resetAt ? new Date(l.dayMeta.resetAt) : null,
     shiftChanges: Array.isArray(l.dayMeta.shiftChanges)
       ? l.dayMeta.shiftChanges.map(c => ({ ...c, at: c.at ? new Date(c.at) : null }))
       : [],
   });
 }
  if (typeof l.inventoryLocked === "boolean") setInventoryLocked(l.inventoryLocked);
  if (Array.isArray(l.inventorySnapshot)) setInventorySnapshot(l.inventorySnapshot);
  if (l.inventoryLockedAt) setInventoryLockedAt(new Date(l.inventoryLockedAt));
  if (typeof l.autoPrintOnCheckout === "boolean") setAutoPrintOnCheckout(l.autoPrintOnCheckout);
  if (typeof l.preferredPaperWidthMm === "number") setPreferredPaperWidthMm(l.preferredPaperWidthMm);
  if (typeof l.cloudEnabled === "boolean") setCloudEnabled(l.cloudEnabled);
  if (typeof l.realtimeOrders === "boolean") setRealtimeOrders(l.realtimeOrders);
if (typeof l.nextOrderNo === "number") setNextOrderNo(l.nextOrderNo);
  if (Array.isArray(l.orders)) {
    setOrders(
      l.orders.map((o) =>
        enrichOrderWithChannel({
          ...o,
          date: o.date ? new Date(o.date) : new Date(),
          restockedAt: o.restockedAt ? new Date(o.restockedAt) : undefined,
        })
      )
    );
  }
  setLocalHydrated(true);
}, [localHydrated]);
useEffect(() => { saveLocalPartial({ menu }); }, [menu]);
  useEffect(() => {
saveLocalPartial({
  purchases: purchases.map(p => ({ ...p, date: toIso(p.date) }))
});
}, [purchases]);
  useEffect(() => { saveLocalPartial({ workerProfiles }); }, [workerProfiles]);

useEffect(() => {
  saveLocalPartial({
    workerSessions: (workerSessions || []).map(s => ({
      ...s,
      signInAt: toIso(s.signInAt),
      signOutAt: toIso(s.signOutAt),
    }))
  });
}, [workerSessions]);
  
  useEffect(() => { saveLocalPartial({ adminSubTab }); }, [adminSubTab]);
useEffect(() => {
  const l = loadLocal();
  if (typeof l.adminSubTab === "string") setAdminSubTab(l.adminSubTab);
}, []); 
useEffect(() => { saveLocalPartial({ reconHistory }); }, [reconHistory]);
useEffect(() => { saveLocalPartial({ reconCounts }); }, [reconCounts]);
useEffect(() => { saveLocalPartial({ reconSavedBy }); }, [reconSavedBy]);
useEffect(() => { saveLocalPartial({ purchaseCategories }); }, [purchaseCategories]); // ⬅️ NEW
useEffect(() => { saveLocalPartial({ purchaseFilter }); }, [purchaseFilter]);  
useEffect(() => {
  saveLocalPartial({ usageFilter, usageWeekDate, usageMonth });
}, [usageFilter, usageWeekDate, usageMonth]);
useEffect(() => { saveLocalPartial({ customers }); }, [customers]);                  // ⬅️ NEW
useEffect(() => { saveLocalPartial({ deliveryZones }); }, [deliveryZones]);          // ⬅️ NEW
useEffect(() => { saveLocalPartial({ extraList }); }, [extraList]);
useEffect(() => { saveLocalPartial({ workers }); }, [workers]);
useEffect(() => { saveLocalPartial({ paymentMethods }); }, [paymentMethods]);
useEffect(() => { saveLocalPartial({ orderTypes }); }, [orderTypes]);
useEffect(() => { saveLocalPartial({ defaultDeliveryFee }); }, [defaultDeliveryFee]);
useEffect(() => { saveLocalPartial({ utilityBills }); }, [utilityBills]);
useEffect(() => { saveLocalPartial({ laborProfile }); }, [laborProfile]);
useEffect(() => { saveLocalPartial({ equipmentList }); }, [equipmentList]);
useEffect(() => { saveLocalPartial({ inventory }); }, [inventory]);
useEffect(() => { saveLocalPartial({ adminPins }); }, [adminPins]);
useEffect(() => { saveLocalPartial({ dark }); }, [dark]);
useEffect(() => { saveLocalPartial({ targetMarginPct }); }, [targetMarginPct]);
useEffect(() => { saveLocalPartial({ showLowMarginOnly }); }, [showLowMarginOnly]);
useEffect(() => {
  if (orderType !== "Delivery") return;
  const p = String(deliveryPhone || "").trim();
  if (p.length !== 11) return;
  const found = customers.find((c) => c.phone === p);
  if (!found) return;
  setDeliveryName((v) => v || found.name || "");
  setDeliveryAddress((v) => v || found.address || "");
  if (found.zoneId) {
    setDeliveryZoneId((v) => v || found.zoneId);
    const z = deliveryZones.find((z) => z.id === found.zoneId);
    if (z) setDeliveryFee(Number(z.fee || 0));
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [orderType, deliveryPhone, customers, deliveryZones]);
useEffect(() => {
  if (!newPurchase.categoryId && purchaseCategories.length) {
    setNewPurchase(p => ({ ...p, categoryId: purchaseCategories[0].id }));
  }
}, [newPurchase.categoryId, purchaseCategories]);
useEffect(() => { saveLocalPartial({ expenses }); }, [expenses]);
useEffect(() => { saveLocalPartial({ bankTx }); }, [bankTx]);
useEffect(() => { saveLocalPartial({ dayMeta }); }, [dayMeta]);
useEffect(() => { saveLocalPartial({ inventoryLocked }); }, [inventoryLocked]);
useEffect(() => { saveLocalPartial({ inventorySnapshot }); }, [inventorySnapshot]);
useEffect(() => { saveLocalPartial({ inventoryLockedAt }); }, [inventoryLockedAt]);
useEffect(() => { saveLocalPartial({ autoPrintOnCheckout }); }, [autoPrintOnCheckout]);
useEffect(() => { saveLocalPartial({ preferredPaperWidthMm }); }, [preferredPaperWidthMm]);
useEffect(() => { saveLocalPartial({ cloudEnabled }); }, [cloudEnabled]);
useEffect(() => { saveLocalPartial({ realtimeOrders }); }, [realtimeOrders]);
useEffect(() => { saveLocalPartial({ nextOrderNo }); }, [nextOrderNo]);
useEffect(() => {
  if (!realtimeOrders) saveLocalPartial({ orders });
}, [orders, realtimeOrders]);

useEffect(() => {
  setLastLocalEditAt(Date.now());
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [
  menu, extraList, workers, paymentMethods, orderTypes, defaultDeliveryFee,
 inventory, adminPins, dark,
  expenses, bankTx, dayMeta, inventoryLocked, inventorySnapshot, inventoryLockedAt,
  autoPrintOnCheckout, preferredPaperWidthMm, cloudEnabled, realtimeOrders, nextOrderNo,
   purchases, purchaseCategories, customers, deliveryZones, purchaseFilter, purchaseDay, purchaseMonth,workerProfiles,
 workerSessions,
  utilityBills, laborProfile, equipmentList,
]);
useEffect(() => {
  if (!orderTypes.includes(orderType)) {
    const def = orderTypes[0] || "";
    setOrderType(def);
    setDeliveryFee(def === "Delivery" ? (deliveryFee || defaultDeliveryFee) : 0);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [orderTypes]);
const [cogsKey, setCogsKey] = useState("");
useEffect(() => {
  if (!cogsKey) {
    if (menu.length) setCogsKey(`m-${menu[0].id}`);
    else if (extraList.length) setCogsKey(`e-${extraList[0].id}`);
  }
}, [cogsKey, menu, extraList]);
const [syncCostsFromPurchases, setSyncCostsFromPurchases] = useState(() => {
  const l = loadLocal();
  return typeof l?.syncCostsFromPurchases === "boolean" ? l.syncCostsFromPurchases : true;
});
useEffect(() => { saveLocalPartial({ syncCostsFromPurchases }); }, [syncCostsFromPurchases]);
useEffect(() => {
  if (!purchases?.length || !syncCostsFromPurchases) return;
  setInventory(current => {
    let changed = false;
    const next = current.map(it => {
      const last = getLatestPurchaseForInv(it, purchases, purchaseCategories);
      if (!last) return it;
      const cpu = unitPriceToInventoryCost(last.unitPrice, last.unit, it.unit);
      if (cpu == null) return it;
      const v = Number(cpu.toFixed(4));
      if (Number(it.costPerUnit || 0) === v) return it;
      changed = true;
      return { ...it, costPerUnit: v };
    });
    return changed ? next : current;
  });
}, [purchases, purchaseCategories, syncCostsFromPurchases]);
const db = useMemo(() => (fbReady ? ensureFirebase().db : null), [fbReady]);
  const onlineFirebaseApp = useMemo(
    () => (fbReady ? ensureOnlineFirebase() : null),
    [fbReady]
  );
  const onlineDb = useMemo(() => {
    if (!onlineFirebaseApp) return null;
    try {
      return getFirestore(onlineFirebaseApp);
    } catch (err) {
      console.error("Failed to access online orders Firestore", err);
      return null;
    }
  }, [onlineFirebaseApp]);
  useEffect(() => {
    if (!onlineFirebaseApp) {
      setOnlineFbUser(null);
      return undefined;
    }
    const auth = getAuth(onlineFirebaseApp);
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!active) return;
      if (user) {
        setOnlineFbUser(user);
      } else {
        try {
          await signInAnonymously(auth);
        } catch (err) {
          console.error("Failed to sign in to online orders Firebase auth", err);
        }
      }
    });
    return () => {
      active = false;
      setOnlineFbUser(null);
      unsubscribe();
    };
  }, [onlineFirebaseApp]);
  const stateDocRef = useMemo(
    () => (db ? fsDoc(db, "shops", SHOP_ID, "state", "pos") : null),
    [db]
  );
  const ordersColRef = useMemo(
    () => (db ? collection(db, "shops", SHOP_ID, "orders") : null),
    [db]
  );
  
const onlineOrderCollections = useMemo(() => {
    if (!db && !onlineDb) return [];
    return ONLINE_ORDER_COLLECTIONS.flatMap(
      ({ name, source, path, constraints = [] }) => {
        const targetDb = source === "menu" ? onlineDb : db;
        if (!targetDb) return [];
        try {
          const baseRef = collection(targetDb, ...path);
          const ref = constraints.length ? query(baseRef, ...constraints) : baseRef;
          return [{ name, source, ref, pathSegments: [...path] }];
        } catch (err) {
          console.error(`Failed to build online order ref for ${name}`, err);
          return [];
        }
      }
    );
  }, [db, onlineDb]);

  
  const counterDocRef = useMemo(
    () => (db ? fsDoc(db, "shops", SHOP_ID, "state", "counters") : null),
    [db]
  );
  useEffect(() => {
    if (!counterDocRef || !fbUser) return;
    const unsub = onSnapshot(counterDocRef, (snap) => {
      const last = snap.exists() ? Number(snap.data().lastOrderNo || 0) : 0;
      setNextOrderNo(last + 1);
    });
    return () => unsub();
  }, [counterDocRef, fbUser]);
  useEffect(() => {
    if (!stateDocRef || !fbUser || hydrated) return;
    (async () => {
      try {
        const snap = await getDoc(stateDocRef);
        if (snap.exists()) {
          const data = snap.data() || {};
          const unpacked = unpackStateFromCloud(data, dayMeta);
          if (!realtimeOrders && unpacked.orders) setOrders(unpacked.orders);
          if (unpacked.menu) setMenu(unpacked.menu);
          if (unpacked.reconHistory) setReconHistory(unpacked.reconHistory);
          if (unpacked.extraList) setExtraList(unpacked.extraList);
          if (unpacked.inventory) setInventory(unpacked.inventory);
          if (unpacked.utilityBills) setUtilityBills(normalizeUtilityBills(unpacked.utilityBills));
          if (unpacked.laborProfile) setLaborProfile(normalizeLaborProfile(unpacked.laborProfile));
          if (unpacked.equipmentList) setEquipmentList(normalizeEquipmentList(unpacked.equipmentList));
          if (unpacked.nextOrderNo != null) setNextOrderNo(unpacked.nextOrderNo);
          if (unpacked.dark != null) setDark(unpacked.dark);
          if (unpacked.workers) setWorkers(unpacked.workers);
          if (unpacked.paymentMethods) setPaymentMethods(unpacked.paymentMethods);
          if (unpacked.customers) setCustomers(dedupeCustomers(unpacked.customers));
          if (unpacked.inventoryLocked != null)
            setInventoryLocked(unpacked.inventoryLocked);
          if (unpacked.inventorySnapshot)
            setInventorySnapshot(unpacked.inventorySnapshot);
          if (unpacked.inventoryLockedAt != null)
            setInventoryLockedAt(unpacked.inventoryLockedAt);
          if (unpacked.adminPins)
            setAdminPins({ ...DEFAULT_ADMIN_PINS, ...unpacked.adminPins });
          if (unpacked.orderTypes) setOrderTypes(unpacked.orderTypes);
          if (unpacked.defaultDeliveryFee != null)
            setDefaultDeliveryFee(unpacked.defaultDeliveryFee);
          if (unpacked.expenses) setExpenses(unpacked.expenses);
          if (unpacked.dayMeta) setDayMeta(unpacked.dayMeta);
          if (unpacked.bankTx) setBankTx(unpacked.bankTx);
          if (unpacked.onlineOrdersRaw)
            setOnlineOrdersRaw(unpacked.onlineOrdersRaw);
          if (unpacked.onlineOrderStatus)
            setOnlineOrderStatus(unpacked.onlineOrderStatus);
          if (unpacked.lastSeenOnlineOrderTs != null)
            setLastSeenOnlineOrderTs(unpacked.lastSeenOnlineOrderTs);
          if (unpacked.workerProfiles) setWorkerProfiles(unpacked.workerProfiles);
        if (unpacked.workerSessions) setWorkerSessions(unpacked.workerSessions);
           if (unpacked.purchases) setPurchases(unpacked.purchases);
       if (unpacked.purchaseCategories) {
   setPurchaseCategories(normalizePurchaseCategories(unpacked.purchaseCategories));
}
        if (unpacked.deliveryZones) setDeliveryZones(unpacked.deliveryZones);
          setCloudStatus((s) => ({ ...s, lastLoadAt: new Date(), error: null }));
        }
      } catch (e) {
        console.warn("Initial cloud load failed:", e);
        setCloudStatus((s) => ({ ...s, error: String(e) }));
      } finally {
        setHydrated(true);
      }
    })();
  }, [stateDocRef, fbUser, hydrated, dayMeta, realtimeOrders]);
  useEffect(() => {
  if (!cloudEnabled || !stateDocRef || !fbUser) return;
  const unsub = onSnapshot(stateDocRef, (snap) => {
    try {
      if (!snap.exists()) return;
      if (snap.metadata.hasPendingWrites) return; 
      const data = snap.data() || {};
      if (data.writerId === clientIdRef.current) {
        const seq = Number(data.writeSeq || 0);
        if (seq && seq <= writeSeqRef.current) return; 
        writeSeqRef.current = Math.max(writeSeqRef.current, seq);
      }
      const ts =
        data.updatedAt instanceof Timestamp
          ? data.updatedAt.toMillis()
          : (data.updatedAt ? new Date(data.updatedAt).getTime() : 0);
      if (ts && ts <= (lastAppliedCloudAt || 0)) return;
if (ts && lastLocalEditAt && ts < lastLocalEditAt) return;
      const unpacked = unpackStateFromCloud(data, dayMeta);
      if (unpacked.menu) setMenu(unpacked.menu);
      if (unpacked.reconHistory) setReconHistory(unpacked.reconHistory);
      if (unpacked.extraList) setExtraList(unpacked.extraList);
      if (unpacked.inventory) setInventory(unpacked.inventory);
      if (typeof unpacked.nextOrderNo === "number") setNextOrderNo(unpacked.nextOrderNo);
      if (typeof unpacked.dark === "boolean") setDark(unpacked.dark);
      if (unpacked.workers) setWorkers(unpacked.workers);
      if (unpacked.paymentMethods) setPaymentMethods(unpacked.paymentMethods);
      if (typeof unpacked.inventoryLocked === "boolean") setInventoryLocked(unpacked.inventoryLocked);
      if (unpacked.inventorySnapshot) setInventorySnapshot(unpacked.inventorySnapshot);
      if (unpacked.inventoryLockedAt != null) setInventoryLockedAt(unpacked.inventoryLockedAt);
      if (unpacked.adminPins) setAdminPins({ ...DEFAULT_ADMIN_PINS, ...unpacked.adminPins });
      if (unpacked.orderTypes) setOrderTypes(unpacked.orderTypes);
      if (unpacked.defaultDeliveryFee != null) setDefaultDeliveryFee(unpacked.defaultDeliveryFee);
      if (unpacked.expenses) setExpenses(unpacked.expenses);

      const appliedAt = ts || Date.now();
      setLastAppliedCloudAt(appliedAt);
      setCloudStatus((s) => ({ ...s, lastLoadAt: new Date(), error: null }));

    } catch (e) {
      console.warn("Realtime state apply failed:", e);
    }
  });

  return () => unsub();
}, [cloudEnabled, stateDocRef, fbUser, dayMeta, lastAppliedCloudAt, lastLocalEditAt]);
  // Manual pull
  const loadFromCloud = async () => {
    if (!stateDocRef || !fbUser) return alert("Firebase not ready.");
    try {
      const snap = await getDoc(stateDocRef);
      if (!snap.exists()) return alert("No cloud state yet to load.");
      const data = snap.data() || {};
      const unpacked = unpackStateFromCloud(data, dayMeta);
      if (!realtimeOrders && unpacked.orders) setOrders(unpacked.orders);
      if (unpacked.menu) setMenu(unpacked.menu);
if (unpacked.workerProfiles) setWorkerProfiles(unpacked.workerProfiles);
if (unpacked.workerSessions) setWorkerSessions(unpacked.workerSessions);
      if (unpacked.extraList) setExtraList(unpacked.extraList);
      if (unpacked.inventory) setInventory(unpacked.inventory);
      if (unpacked.nextOrderNo != null) setNextOrderNo(unpacked.nextOrderNo);
      if (unpacked.dark != null) setDark(unpacked.dark);
      if (unpacked.workers) setWorkers(unpacked.workers);
      if (unpacked.paymentMethods) setPaymentMethods(unpacked.paymentMethods);
      if (unpacked.inventoryLocked != null)
        setInventoryLocked(unpacked.inventoryLocked);
      if (unpacked.inventorySnapshot)
        setInventorySnapshot(unpacked.inventorySnapshot);
      if (unpacked.inventoryLockedAt != null)
        setInventoryLockedAt(unpacked.inventoryLockedAt);
      if (unpacked.adminPins)
        setAdminPins({ ...DEFAULT_ADMIN_PINS, ...unpacked.adminPins });
      if (unpacked.orderTypes) setOrderTypes(unpacked.orderTypes);
      if (unpacked.defaultDeliveryFee != null)
        setDefaultDeliveryFee(unpacked.defaultDeliveryFee);
      if (unpacked.expenses) setExpenses(unpacked.expenses);
      if (unpacked.dayMeta) setDayMeta(unpacked.dayMeta);
       if (unpacked.bankTx) setBankTx(unpacked.bankTx);
      if (unpacked.customers) setCustomers(dedupeCustomers(unpacked.customers));

       if (unpacked.purchases) setPurchases(unpacked.purchases);
   if (unpacked.purchaseCategories) {
   setPurchaseCategories(normalizePurchaseCategories(unpacked.purchaseCategories));
 }
    if (unpacked.deliveryZones) setDeliveryZones(unpacked.deliveryZones);
      if (unpacked.onlineOrdersRaw)
        setOnlineOrdersRaw(unpacked.onlineOrdersRaw);
      if (unpacked.onlineOrderStatus)
        setOnlineOrderStatus(unpacked.onlineOrderStatus);
      if (unpacked.lastSeenOnlineOrderTs != null)
        setLastSeenOnlineOrderTs(unpacked.lastSeenOnlineOrderTs);
      setCloudStatus((s) => ({ ...s, lastLoadAt: new Date(), error: null }));
      alert("Loaded from cloud ✔");
    } catch (e) {
      setCloudStatus((s) => ({ ...s, error: String(e) }));
      alert("Cloud load failed: " + e);
    }
  };
 const saveToCloudNow = async () => {
  if (!stateDocRef || !fbUser) return alert("Firebase not ready.");
  try {
    const bodyBase = packStateForCloud({
      menu,
      extraList,
      orders: realtimeOrders ? [] : orders,
      inventory,
      nextOrderNo,
       reconHistory,
        workerProfiles,
 workerSessions,
      dark,
      workers,
      paymentMethods,
      inventoryLocked,
      inventorySnapshot,
      inventoryLockedAt,
      adminPins,
      orderTypes,
      defaultDeliveryFee,
      expenses,
      purchases,
      purchaseCategories,
     customers,
      deliveryZones,
      dayMeta,
      utilityBills,
      laborProfile,
      equipmentList,
      bankTx,
      realtimeOrders,
      onlineOrdersRaw,
      onlineOrderStatus,
      lastSeenOnlineOrderTs,
    });
    writeSeqRef.current += 1;
    const body = {
      ...bodyBase,
      writerId: clientIdRef.current,
      writeSeq: writeSeqRef.current,
      clientTime: Date.now(),
    };
    await setDoc(stateDocRef, body, { merge: true });
    const now = Date.now();
   setLastLocalEditAt(now);
    setLastAppliedCloudAt(now);
    setCloudStatus((s) => ({ ...s, lastSaveAt: new Date(), error: null }));

    alert("Synced to cloud ✔");
  } catch (e) {
    alert("Sync failed: " + e);
  }
};
useEffect(() => {
  if (!cloudEnabled || !stateDocRef || !fbUser || !hydrated) return undefined;

  let cancelled = false;

  (async () => {
    try {
 const bodyBase = packStateForCloud({
        menu,
        extraList,
        orders: realtimeOrders ? [] : orders,
        inventory,
        nextOrderNo,
        dark,
        workers,
        paymentMethods,
        inventoryLocked,
        inventorySnapshot,
        inventoryLockedAt,
        adminPins,
        orderTypes,
        defaultDeliveryFee,
        expenses,
        purchases,
        purchaseCategories,
        customers,
        deliveryZones,
        utilityBills,
        laborProfile,
        equipmentList,
          workerProfiles,
         workerSessions,
        dayMeta,
        bankTx,
         realtimeOrders,
         reconHistory,
        onlineOrdersRaw,
        onlineOrderStatus,
        lastSeenOnlineOrderTs,
      });
      writeSeqRef.current += 1;
      const body = {
        ...bodyBase,
        writerId: clientIdRef.current,
        writeSeq: writeSeqRef.current,
        clientTime: Date.now(),
      };

      await setDoc(stateDocRef, body, { merge: true });
      if (cancelled) return;
      const now = Date.now();
      setLastAppliedCloudAt(now);
      setCloudStatus((s) => ({ ...s, lastSaveAt: new Date(), error: null }));
    } catch (e) {
      if (!cancelled) {
        setCloudStatus((s) => ({ ...s, error: String(e) }));
      }
    }
  })();

  return () => {
    cancelled = true;
  };
}, [
  cloudEnabled,
  stateDocRef,
  fbUser,
  hydrated,
  menu,
  workerProfiles,
  workerSessions,
  extraList,
  orders,
  inventory,
  nextOrderNo,
  dark,
  workers,
  paymentMethods,
  inventoryLocked,
  inventorySnapshot,
  inventoryLockedAt,
  adminPins,
  orderTypes,
  defaultDeliveryFee,
  expenses,
  purchases,
  purchaseCategories,
  customers,
  deliveryZones,
  utilityBills,
  laborProfile,
  equipmentList,
  dayMeta,
  bankTx,
 realtimeOrders,
  reconHistory,
  onlineOrdersRaw,
  onlineOrderStatus,
  lastSeenOnlineOrderTs,
]);
  const startedAtMs = dayMeta?.startedAt
    ? new Date(dayMeta.startedAt).getTime()
    : null;
  const endedAtMs = dayMeta?.endedAt
    ? new Date(dayMeta.endedAt).getTime()
    : null;
  useEffect(() => {
    if (!realtimeOrders || !ordersColRef || !fbUser) return;
    if (!startedAtMs) {
      setOrders([]);
      return;
    }
    const startTs = Timestamp.fromMillis(startedAtMs);
    const constraints = [where("createdAt", ">=", startTs), orderBy("createdAt", "desc")];
    if (endedAtMs)
      constraints.unshift(where("createdAt", "<=", Timestamp.fromMillis(endedAtMs)));
    const qy = query(ordersColRef, ...constraints);
    const unsub = onSnapshot(qy, (snap) => {
      const arr = [];
      snap.forEach((d) => arr.push(orderFromCloudDoc(d.id, d.data())));
      setOrders(dedupeOrders(arr).map(enrichOrderWithChannel));
    });
   return () => unsub();
  }, [realtimeOrders, ordersColRef, fbUser, startedAtMs, endedAtMs]);
const recomputeOnlineOrders = useCallback(() => {
    const sources = onlineOrderSourcesRef.current || {};
    const merged = Object.values(sources).flat();
    const deduped = new Map();
    for (const order of merged) {
      if (!order) continue;
      const key = getOnlineOrderDedupeKey(order);
      const prev = deduped.get(key);
      if (
        !prev ||
        Number(order?.createdAtMs || 0) >= Number(prev?.createdAtMs || 0)
      ) {
        deduped.set(key, order);
      }
    }
    const next = Array.from(deduped.values()).sort(
      (a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)
    );
     setOnlineOrdersRaw(next);
  }, []);
  const updateOnlineOrderDoc = useCallback(
    async (onlineOrder, patch) => {
      if (!onlineOrder || !patch) return;
      const segments = Array.isArray(onlineOrder.sourcePathSegments)
        ? [...onlineOrder.sourcePathSegments]
        : [];
      const docId = onlineOrder.sourceDocId || onlineOrder.id;
      if (!segments.length || !docId) return;
      const origin = onlineOrder.sourceOrigin || onlineOrder.sourceCollection || "";
      const targetDb = origin === "menu" ? onlineDb : db;
      if (!targetDb) return;
      try {
        const ref = fsDoc(targetDb, ...segments, docId);
        const body = { ...patch };
        if (body.updatedAt === undefined) body.updatedAt = serverTimestamp();
        await updateDoc(ref, sanitizeForFirestore(body));
      } catch (err) {
        console.error("Failed to update online order doc", err);
      }
    },
    [db, onlineDb]
  );
 useEffect(() => {
    const requiresOnlineAuth = onlineOrderCollections.some(
      (col) => col.source === "menu"
    );
    if (
      !fbUser ||
      onlineOrderCollections.length === 0 ||
      (requiresOnlineAuth && !onlineFbUser)
    ) {
      onlineOrderSourcesRef.current = {};
      setOnlineOrdersRaw([]);
      return undefined;
    }

    let active = true;
const unsubscribers = onlineOrderCollections.map(({ name, ref, pathSegments, source }) =>
      onSnapshot(
        ref,
        (snap) => {
          if (!active) return;
          const arr = [];
          snap.forEach((doc) => {
            try {
              const parsed = onlineOrderFromDoc(doc.id, doc.data());
              arr.push({
                ...parsed,
                id: parsed?.id || doc.id,
                sourceCollection: name,
                sourceDocId: doc.id,
                sourcePathSegments: Array.isArray(pathSegments) ? [...pathSegments] : [],
                sourceOrigin: source,
              });
            } catch (err) {
              console.error(
                "Failed to parse online order",
                `${name}/${doc.id}`,
                err
              );
            }
          });
          onlineOrderSourcesRef.current = {
            ...onlineOrderSourcesRef.current,
            [name]: arr,
          };
          recomputeOnlineOrders();
        },
        (error) => {
          console.error(`Online orders listener error [${name}]`, error);
        }
      )
    );

    return () => {
      active = false;
      unsubscribers.forEach((fn) => {
        try {
          if (typeof fn === "function") fn();
        } catch (err) {
          console.error("Error cleaning up online order listener", err);
        }
      });
      onlineOrderSourcesRef.current = {};
      setOnlineOrdersRaw([]);
    };
  }, [onlineOrderCollections, fbUser, onlineFbUser, recomputeOnlineOrders]);
const onlineOrders = useMemo(() => {
    const filtered = onlineOrdersRaw.filter((order) => {
      const ts = Number(order?.createdAtMs || 0);
      if (startedAtMs && ts < startedAtMs) return false;
      if (endedAtMs && ts > endedAtMs) return false;
      return true;
    });
    filtered.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

    const total = filtered.length;
    return filtered.map((order, index) => ({
      ...order,
      displayOrderNo: `O${total - index}`,
    }));
  }, [onlineOrdersRaw, startedAtMs, endedAtMs]);
  const posOrdersByOnlineKey = useMemo(() => {
    const map = new Map();
    for (const ord of orders || []) {
      if (!ord) continue;
      if (ord.onlineOrderKey) map.set(ord.onlineOrderKey, ord);
      if (ord.onlineOrderId) map.set(`id:${ord.onlineOrderId}`, ord);
      if (ord.onlineSourceCollection && ord.onlineSourceDocId) {
        map.set(`${ord.onlineSourceCollection}/${ord.onlineSourceDocId}`, ord);
      }
    }
    return map;
  }, [orders]);
  const findPosOrderForOnline = useCallback(
    (onlineOrder) => {
      if (!onlineOrder) return null;
      const key = getOnlineOrderDedupeKey(onlineOrder);
      if (key && posOrdersByOnlineKey.get(key)) return posOrdersByOnlineKey.get(key);
      const idKey = onlineOrder.id ? `id:${onlineOrder.id}` : null;
      if (idKey && posOrdersByOnlineKey.get(idKey)) return posOrdersByOnlineKey.get(idKey);
      const docKey =
        onlineOrder.sourceCollection && onlineOrder.sourceDocId
          ? `${onlineOrder.sourceCollection}/${onlineOrder.sourceDocId}`
          : null;
      if (docKey && posOrdersByOnlineKey.get(docKey)) return posOrdersByOnlineKey.get(docKey);
      return null;
    },
    [posOrdersByOnlineKey]
  );
 const newOnlineOrderCount = useMemo(
  () =>
    onlineOrders.filter(
      (order) => Number(order?.createdAtMs || 0) > Number(lastSeenOnlineOrderTs || 0)
    ).length,
  [onlineOrders, lastSeenOnlineOrderTs]
);
const onlineAlertInitializedRef = useRef(false);
const lastAlertedOnlineOrderTsRef = useRef(0);
useEffect(() => {
  if (!Array.isArray(onlineOrders) || onlineOrders.length === 0) return;
  const latestTs = onlineOrders.reduce((max, order) => {
    const ts = Number(order?.createdAtMs || 0);
    return Number.isFinite(ts) && ts > max ? ts : max;
  }, 0);
  if (!latestTs) return;
  if (!onlineAlertInitializedRef.current) {
    onlineAlertInitializedRef.current = true;
    lastAlertedOnlineOrderTsRef.current = latestTs;
    return;
  }
  const prevTs = Number(lastAlertedOnlineOrderTsRef.current || 0);
 if (latestTs <= prevTs) return;
  lastAlertedOnlineOrderTsRef.current = latestTs;
}, [onlineOrders]);
  
  useEffect(() => {
    saveLocalPartial({ orderBoardFilter });
  }, [orderBoardFilter]);
  
  useEffect(() => {
    saveLocalPartial({ lastSeenOnlineOrderTs });
  }, [lastSeenOnlineOrderTs]);
  
 useEffect(() => {
    saveLocalPartial({ lastSeenOnlineOrderTs });
  }, [lastSeenOnlineOrderTs]);
  
  useEffect(() => {
    saveLocalPartial({ onlineOrderStatus });
  }, [onlineOrderStatus]);
  useEffect(() => {
    if (orderBoardFilter === "online") {
      setOnlineViewCutoff(lastSeenOnlineOrderTs);
      const latest = onlineOrders.reduce(
        (max, order) => Math.max(max, Number(order?.createdAtMs || 0)),
        0
      );
      if (latest > Number(lastSeenOnlineOrderTs || 0)) {
        setLastSeenOnlineOrderTs(latest);
      }
    } else {
      setOnlineViewCutoff(lastSeenOnlineOrderTs);
    }
  }, [orderBoardFilter, onlineOrders, lastSeenOnlineOrderTs]);
  useEffect(() => {
    setOnlineOrderStatus((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const ord of orders || []) {
        if (!ord || ord.source !== "online") continue;
        const candidates = [
          ord.onlineOrderKey,
          ord.onlineOrderId ? `id:${ord.onlineOrderId}` : null,
          ord.onlineSourceCollection && ord.onlineSourceDocId
            ? `${ord.onlineSourceCollection}/${ord.onlineSourceDocId}`
            : null,
        ].filter(Boolean);
        if (!candidates.length) continue;
        const state = ord.voided ? "voided" : ord.done ? "done" : "imported";
        for (const key of candidates) {
          const existing = next[key] || {};
          let entryChanged = false;
          const entry = { ...existing };
          if (entry.state !== state) {
            entry.state = state;
            entryChanged = true;
          }
          if (entry.posOrderNo !== ord.orderNo) {
            entry.posOrderNo = ord.orderNo;
            entryChanged = true;
          }
          const cloudId = ord.cloudId || null;
          if ((entry.cloudId || null) !== cloudId) {
            entry.cloudId = cloudId;
            entryChanged = true;
          }
          if (
            ord.onlineSourceCollection &&
            entry.sourceCollection !== ord.onlineSourceCollection
          ) {
            entry.sourceCollection = ord.onlineSourceCollection;
            entryChanged = true;
          }
          if (
            ord.onlineSourceDocId &&
            entry.sourceDocId !== ord.onlineSourceDocId
          ) {
            entry.sourceDocId = ord.onlineSourceDocId;
            entryChanged = true;
          }
          if (entryChanged) {
            entry.lastUpdateAt = Date.now();
            next[key] = entry;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [orders]);
  /* --------------------------- APP LOGIC --------------------------- */
  const toggleExtra = (extra) => {
    setSelectedExtras((prev) =>
      prev.find((e) => e.id === extra.id)
        ? prev.filter((e) => e.id !== extra.id)
        : [...prev, extra]
    );
  };

const invById = useMemo(() => {
  const map = {};
  for (const item of inventory) map[item.id] = item;
  return map;
}, [inventory]);
const equipmentById = useMemo(() => {
  const map = {};
  for (const eq of equipmentList || []) {
    if (!eq?.id) continue;
    map[eq.id] = eq;
  }
  return map;
}, [equipmentList]);
const utilityRates = useMemo(() => {
  const safeRate = (bill = {}) => {
    const amount = Number(bill.amount || 0);
    const units = Number(bill.units || 0);
    if (!amount || !units) return 0;
    return amount / units;
  };
  return {
    electricity: safeRate(utilityBills?.electricity),
    gas: safeRate(utilityBills?.gas),
    water: safeRate(utilityBills?.water),
  };
}, [utilityBills]);
const laborCostPerMinute = useMemo(() => {
  const payout = Number(laborProfile?.payout || 0);
  const hours = Number(laborProfile?.productiveHours || 0);
  if (!payout || !hours) return 0;
  const minutes = hours * 60;
  if (!minutes) return 0;
  return payout / minutes;
}, [laborProfile]);
const cogsCostContext = useMemo(
  () => ({ utilityRates, laborCostPerMinute, equipmentById }),
  [utilityRates, laborCostPerMinute, equipmentById]
);
const cogsMarginData = useMemo(() => {
  const rows = [
    ...menu.map((d) => ({ ...d, _k: `m-${d.id}`, _type: "menu" })),
    ...extraList.map((d) => ({ ...d, _k: `e-${d.id}`, _type: "extra" })),
  ].map((def) => {
    const price = Number(def.price || 0);
    const breakdown = computeCostBreakdown(def, invById, cogsCostContext);
    const cogs = breakdown.total;
    const marginPct = price > 0 ? ((price - cogs) / price) * 100 : 0;
    const override = def.targetMarginPctOverride;
    const rowTargetPct = Number(((override ?? targetMarginPct) * 100).toFixed(2));
    const marginGap = rowTargetPct - marginPct;
    const usesEntries = Object.entries(def.uses || {});
    const hasMissingCosts =
      usesEntries.length > 0 &&
      usesEntries.some(([invId]) => !Number(invById[invId]?.costPerUnit));
    return {
      ...def,
 _price: price,
      _cogs: cogs,
      _marginPct: marginPct,
      _targetMarginPct: rowTargetPct,
      _marginGap: marginGap,
      _hasMissingCosts: hasMissingCosts,
      _costBreakdown: breakdown,
    };
  });
  const threshold = targetMarginPct * 100;
  const below = rows.filter((row) => row._marginPct + 0.0001 < row._targetMarginPct);
  const missingCostKeys = rows.filter((row) => row._hasMissingCosts).map((row) => row._k);
  return { all: rows, below, threshold, missingCostKeys };
}, [menu, extraList, invById, targetMarginPct, cogsCostContext]);
const filteredCogsRows = useMemo(() => {
  let rows = showLowMarginOnly ? cogsMarginData.below : cogsMarginData.all;
  if (cogsTypeFilter === "menu") rows = rows.filter((row) => row._type === "menu");
  if (cogsTypeFilter === "extra") rows = rows.filter((row) => row._type === "extra");
  const q = String(cogsSearch || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter((row) => String(row.name || "").toLowerCase().includes(q));
  }
  return rows;
}, [showLowMarginOnly, cogsMarginData, cogsTypeFilter, cogsSearch]);
const sortedCogsRows = useMemo(() => {
  const rows = [...filteredCogsRows];
  const dir = cogsSort.dir === "desc" ? -1 : 1;
  rows.sort((a, b) => {
    const safeCompare = (va, vb) => (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    switch (cogsSort.key) {
      case "name":
        return safeCompare(String(a.name || "").toLowerCase(), String(b.name || "").toLowerCase());
      case "price":
        return safeCompare(a._price, b._price);
      case "cogs":
        return safeCompare(a._cogs, b._cogs);
      case "gap":
        return safeCompare(a._marginGap, b._marginGap);
      case "margin":
      default:
        return safeCompare(a._marginPct, b._marginPct);
    }
  });
  return rows;
}, [filteredCogsRows, cogsSort]);
const lowMarginCount = cogsMarginData.below.length;
const totalMarginRows = cogsMarginData.all.length;
const { cogsSummaryMetrics, revenueAtRisk } = useMemo(() => {
  if (!filteredCogsRows.length) return { cogsSummaryMetrics: [], revenueAtRisk: 0 };
  const avgMargin =
    filteredCogsRows.reduce((sum, row) => sum + Number(row._marginPct || 0), 0) /
    filteredCogsRows.length;
  const belowRows = filteredCogsRows.filter((row) => row._marginGap > 0);
  const revenueAtRisk = belowRows.reduce((sum, row) => sum + Number(row._price || 0), 0);
  const missingCount = filteredCogsRows.filter((row) => row._hasMissingCosts).length;
  const metrics = [
    { label: "Average margin", value: `${avgMargin.toFixed(1)}%` },
    {
      label: "Low-margin items",
      value: `${belowRows.length}`,
      hint: belowRows.length ? `Revenue at risk: E£${revenueAtRisk.toFixed(2)}` : undefined,
    },
    {
      label: "Missing ingredient costs",
      value: `${missingCount}`,
    },
  ];
  return { cogsSummaryMetrics: metrics, revenueAtRisk };
}, [filteredCogsRows]);
const missingCostRows = useMemo(
  () => cogsMarginData.all.filter((row) => row._hasMissingCosts),
  [cogsMarginData]
);
const marginSummary = totalMarginRows
  ? ((showLowMarginOnly
      ? `Showing ${sortedCogsRows.length} item${sortedCogsRows.length === 1 ? "" : "s"} below the target margin.`
      : `${lowMarginCount} of ${totalMarginRows} item${totalMarginRows === 1 ? "" : "s"} are below the target margin.`) +
      (revenueAtRisk > 0 ? ` Low-margin revenue at risk: E£${revenueAtRisk.toFixed(2)}.` : ""))
  : "No menu or extra items available yet.";
const handleApplyTargetMarginToLowItems = () => {
  const rows = cogsMarginData.below || [];
  if (!rows.length) return;
  const menuUpdates = [];
  const extraUpdates = [];
  for (const row of rows) {
    const safeTarget = Math.min(
      row.targetMarginPctOverride ?? targetMarginPct,
      0.95
    );
    const suggested = safeTarget >= 1
      ? row._price
      : Math.max(0, Math.round(row._cogs / (1 - safeTarget)));
    if (!Number.isFinite(suggested)) continue;
    if (Math.abs(suggested - Number(row._price || 0)) < 0.001) continue;
    if (row._type === "extra") {
      extraUpdates.push({ id: row.id, price: suggested });
    } else {
      menuUpdates.push({ id: row.id, price: suggested });
    }
  }
  const menuCount = menuUpdates.length;
  const extraCount = extraUpdates.length;
  if (!menuCount && !extraCount) {
    alert("All below-target items already match their suggested prices.");
    return;
  }
  const total = menuCount + extraCount;
  const confirmMsg =
    `Apply target-margin pricing to ${total} item${total === 1 ? "" : "s"}?\n` +
    (menuCount ? `• Menu: ${menuCount}\n` : "") +
    (extraCount ? `• Extras: ${extraCount}` : "");
  if (!window.confirm(confirmMsg.trim())) return;
  if (menuCount) {
    setMenu((arr) =>
      arr.map((it) => {
        const upd = menuUpdates.find((u) => u.id === it.id);
        return upd ? { ...it, price: upd.price } : it;
      })
    );
  }
  if (extraCount) {
    setExtraList((arr) =>
      arr.map((it) => {
        const upd = extraUpdates.find((u) => u.id === it.id);
        return upd ? { ...it, price: upd.price } : it;
      })
    );
  }
  alert(`Updated ${total} item${total === 1 ? "" : "s"} to the target margin.`);
};
const handleExportCogsCsv = () => {
  const rows = sortedCogsRows;
  if (!rows.length) {
    alert("No COGS data to export.");
    return;
  }
  const header = ["Item", "Type", "COGS", "Price", "Margin %", "Target %", "Gap to Target"];
  const body = rows.map((row) => [
    row.name,
    row._type,
    Number(row._cogs || 0).toFixed(2),
    Number(row._price || 0).toFixed(2),
    Number(row._marginPct || 0).toFixed(2),
    Number(row._targetMarginPct || 0).toFixed(2),
    Number(row._marginGap || 0).toFixed(2),
  ]);
  const lines = [header, ...body]
    .map((cols) =>
      cols
        .map((col) => {
          const text = String(col ?? "");
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",")
    )
    .join("\n");
  const blob = new Blob([lines], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const name = `tux_cogs_${showLowMarginOnly ? "below-target" : "all"}_${stamp}.csv`;
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
const updateRowPrice = (row, newPrice, { confirm = false } = {}) => {
  if (!row) return;
  const sanitized = Math.max(0, Number(newPrice || 0));
  if (!Number.isFinite(sanitized)) return;
  const current = Number(row._price ?? row.price ?? 0);
  if (Math.abs(sanitized - current) < 0.001) return;
  const [kind, idStr] = String(row._k || "").split("-");
  const id = Number(idStr);
  if (!id) return;
  const label = row.name || "item";
  if (confirm && !window.confirm(`Set "${label}" price to E£${sanitized.toFixed(2)}?`)) return;
  if (kind === "e") {
    setExtraList((arr) =>
      arr.map((it) => (it.id === id ? { ...it, price: sanitized } : it))
    );
  } else {
    setMenu((arr) =>
      arr.map((it) => (it.id === id ? { ...it, price: sanitized } : it))
    );
  }
};
const handleInlinePriceCommit = (row, value) => {
  updateRowPrice(row, value);
  setInlinePriceDrafts((prev) => {
    const next = { ...prev };
    delete next[row._k];
    return next;
  });
};
const handleUtilityBillChange = (type, field, value) => {
  setUtilityBills((prev) => {
    const current = normalizeUtilityBills(prev);
    const nextSection = {
      ...current[type],
      [field]: Number(value || 0),
    };
    return { ...current, [type]: nextSection };
  });
};
const addEquipment = () => {
  const id = `eq_${Date.now()}`;
  setEquipmentList((list) => [
    ...list,
    { id, name: "", electricKw: 0, gasM3PerHour: 0, waterLPerMin: 0 },
  ]);
};
const updateEquipmentField = (id, field, value) => {
  setEquipmentList((list) =>
    list.map((eq) =>
      eq.id === id
        ? {
            ...eq,
            [field]: field === "name" ? value : Number(value || 0),
          }
        : eq
    )
  );
};
const applyToCatalogItem = (kind, itemId, updater) => {
  if (kind === "menu") {
    setMenu((items) => items.map((it) => (it.id === itemId ? updater(it) : it)));
  } else {
    setExtraList((items) => items.map((it) => (it.id === itemId ? updater(it) : it)));
  }
};
const removeEquipment = (id) => {
  setEquipmentList((list) => list.filter((eq) => eq.id !== id));
  setMenu((items) =>
    items.map((it) => {
      if (!it.equipmentMinutes || !(id in it.equipmentMinutes)) return it;
      const next = { ...it.equipmentMinutes };
      delete next[id];
      return { ...it, equipmentMinutes: next };
    })
  );
  setExtraList((items) =>
    items.map((it) => {
      if (!it.equipmentMinutes || !(id in it.equipmentMinutes)) return it;
      const next = { ...it.equipmentMinutes };
      delete next[id];
      return { ...it, equipmentMinutes: next };
    })
  );
};
const updatePrepMinutesForItem = (kind, itemId, minutes) => {
  const value = Math.max(0, Number(minutes || 0));
  applyToCatalogItem(kind, itemId, (item) => ({ ...item, prepMinutes: value }));
};
const updateEquipmentMinutesForItem = (kind, itemId, equipmentId, minutes) => {
  const value = Math.max(0, Number(minutes || 0));
  applyToCatalogItem(kind, itemId, (item) => {
    const next = { ...(item.equipmentMinutes || {}) };
    if (!value) delete next[equipmentId];
    else next[equipmentId] = value;
    return { ...item, equipmentMinutes: next };
  });
};
const renderPrepTable = (kind, list, emptyLabel) => {
  if (!list.length) {
    return <div style={{ fontSize: 12, opacity: 0.7 }}>{emptyLabel}</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Item</th>
            <th style={{ textAlign: "right", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Prep min</th>
            {equipmentList.map((eq) => (
              <th
                key={eq.id}
                style={{ textAlign: "right", padding: 6, borderBottom: `1px solid ${cardBorder}` }}
              >
                {eq.name || "Equipment"} (min)
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((item) => (
            <tr key={item.id}>
              <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}` }}>{item.name}</td>
              <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={Number(item.prepMinutes || 0)}
                  onChange={(e) => updatePrepMinutesForItem(kind, item.id, e.target.value)}
                  style={{ width: 80, textAlign: "right" }}
                />
              </td>
              {equipmentList.map((eq) => (
                <td
                  key={`${item.id}-${eq.id}`}
                  style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}
                >
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={Number((item.equipmentMinutes || {})[eq.id] || 0)}
                    onChange={(e) => updateEquipmentMinutesForItem(kind, item.id, eq.id, e.target.value)}
                    style={{ width: 80, textAlign: "right" }}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
const selectedCogsRow = useMemo(
  () => cogsMarginData.all.find((row) => row._k === cogsKey) || null,
  [cogsMarginData, cogsKey]
);
const marginTrend = useMemo(() => {
  if (!selectedCogsRow) return [];
  const id = selectedCogsRow.id;
  const type = selectedCogsRow._type;
  if (!id) return [];
  const unitCogs = computeCOGSForItemDef(selectedCogsRow, invById, cogsCostContext);
  const map = new Map();
  for (const order of orders || []) {
    const lines = order?.cart || [];
    if (!Array.isArray(lines) || !lines.length) continue;
    const date = order?.date instanceof Date ? order.date : new Date(order?.date);
    if (!date || Number.isNaN(+date)) continue;
    const dayKey = date.toISOString().slice(0, 10);
    let revenue = 0;
    let cogs = 0;
    if (type === "menu") {
      for (const line of lines) {
        if (Number(line?.id) !== id) continue;
        const qty = Math.max(1, Number(line?.qty || 1));
        const price = Number(line?.price || 0);
        revenue += price * qty;
        cogs += unitCogs * qty;
      }
    } else {
      for (const line of lines) {
        const qty = Math.max(1, Number(line?.qty || 1));
        for (const extra of line?.extras || []) {
          if (Number(extra?.id) !== id) continue;
          const extraQty = Math.max(1, Number(extra?.qty || 1));
          const price = Number(extra?.price || 0);
          const units = qty * extraQty;
          revenue += price * units;
          cogs += unitCogs * units;
        }
      }
    }
    if (!revenue && !cogs) continue;
    const bucket = map.get(dayKey) || { revenue: 0, cogs: 0 };
    bucket.revenue += revenue;
    bucket.cogs += cogs;
    map.set(dayKey, bucket);
  }
  return Array.from(map.entries())
    .map(([day, bucket]) => {
      const marginPct = bucket.revenue > 0 ? ((bucket.revenue - bucket.cogs) / bucket.revenue) * 100 : 0;
      return {
        day,
        marginPct,
        revenue: bucket.revenue,
        cogs: bucket.cogs,
      };
    })
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-10);
}, [selectedCogsRow, orders, invById, cogsCostContext]);

   function isWithin(d, start, end) {
  const t = +new Date(d);
  return t >= +start && t <= +end;
}
const sumPurchases = (rows = []) =>
  rows.reduce((s, p) => s + Number(p.qty || 0) * Number(p.unitPrice || 0), 0);
  
function getPeriodRange(kind, dayMeta, dayStr, monthStr, weekStr) {
  if (kind === "shift") {
    const now = new Date();
    const start = dayMeta?.startedAt ? new Date(dayMeta.startedAt) : now;
    const end = dayMeta?.endedAt ? new Date(dayMeta.endedAt) : now;
    return [start, end];
  }
  if (kind === "day" && dayStr) {
    const d = new Date(`${dayStr}T00:00:00`);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const end   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return [start, end];
  }

 if (kind === "week" && weekStr) {
    if (weekStr.includes('-W')) {
      const range = getWeekRangeFromInput(weekStr);
      if (range) return range;
    } else {
      const start = new Date(`${weekStr}T00:00:00`);
      if (!Number.isNaN(+start)) {
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        end.setHours(23, 59, 59, 999);
        return [start, end];
      }
    }
  }

  if (kind === "month" && monthStr) {
    const [y, m] = monthStr.split("-").map(Number);
    const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
    const end   = new Date(y, m, 0, 23, 59, 59, 999); // last day of month
    return [start, end];
  }
  if (kind === "day") {
    const now = new Date();
    const start = dayMeta?.startedAt ? new Date(dayMeta.startedAt) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const end = dayMeta?.endedAt ? new Date(dayMeta.endedAt) : now;
    return [start, end];
  }
   if (kind === "week") {
    const now = new Date();
    const sundayStr = getSundayStart(now);
    if (sundayStr) {
      const start = new Date(`${sundayStr}T00:00:00`);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return [start, end];
    }
    const range = getWeekRangeFromInput(formatSundayWeekInputValue(now));
    if (range) return range;
  }
  if (kind === "month") {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = now;
    return [start, end];
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
  const end   = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  return [start, end];
}
// === Worker helpers ===
const normPin = (p) => String(p || "").trim();
const findWorkerByPin = (pin) => {
  const p = normPin(pin);
  if (!p) return null;
  return (workerProfiles || []).find(w => normPin(w.pin) === p);
};
const addWorkerProfile = () => {
  const name = String(newWName || "").trim();
  const pin  = String(newWPin || "").trim();
  const rate = Number(newWRate || 0);
  if (!name) return alert("Enter worker name.");
  if (!pin || !/^\d{3,6}$/.test(pin)) return alert("Enter PIN (3–6 digits).");
  if ((workerProfiles || []).some(w => String(w.pin) === pin)) {
    return alert("This PIN is already used by another worker.");
  }
  if ((workerProfiles || []).some(w => w.name.toLowerCase() === name.toLowerCase())) {
    return alert("This name already exists.");
  }
  const base = `w_${slug(name)}`;
  const ids = new Set((workerProfiles || []).map(w => w.id));
  let id = base, n = 1;
  while (ids.has(id)) id = `${base}_${++n}`;
  const rec = { id, name, pin, rate: isFinite(rate) ? rate : 0, isActive: false };
  setWorkerProfiles(list => [rec, ...list]);
  setWorkers(list => (list.includes(name) ? list : [...list, name]));
  setShowAddWorker(false);
  setNewWName(""); setNewWPin(""); setNewWRate("");
};
const startDayIfNeeded = (starterName) => {
  if (dayMeta.startedAt) return;
  setDayMeta({
    startedBy: starterName || "",
    currentWorker: starterName || "",
    startedAt: new Date(),
    endedAt: null,
    endedBy: "",
    lastReportAt: null,
    resetBy: "",
    resetAt: null,
    shiftChanges: [],
  });
  if (!inventoryLocked && inventory.length) {
    if (window.confirm("Lock current Inventory as Start-of-Day snapshot?")) {
      lockInventoryForDay();
    }
  }
};
const signInByPin = (pin) => {
  const prof = findWorkerByPin(pin);
  if (!prof) return alert("Invalid PIN.");
  startDayIfNeeded(prof.name);
  const open = (workerSessions || []).find(s => !s.signOutAt && s.name === prof.name);
  if (open) {
    alert(`${prof.name} is already on duty.`);
    return;
  }
  const sess = {
    id: `ws_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: prof.name,
    pin: prof.pin,
    signInAt: new Date(),
    signOutAt: null,
  };
  setWorkerSessions(arr => [sess, ...arr]);
  setDayMeta(d => ({ ...d, currentWorker: prof.name }));
};
const signOutByPin = (pin) => {
  const prof = findWorkerByPin(pin);
  if (!prof) return alert("Invalid PIN.");

  const open = (workerSessions || []).filter(s => !s.signOutAt);
  if (open.length <= 1) {
    alert("Cannot sign out the only on-duty worker. Please End the Day.");
    return;
  }
  const idx = (workerSessions || []).findIndex(s => !s.signOutAt && s.name === prof.name);
  if (idx < 0) {
    alert(`${prof.name} is not currently on duty.`);
    return;
  }
  setWorkerSessions(list => {
    const copy = [...list];
    copy[idx] = { ...copy[idx], signOutAt: new Date() };
    return copy;
  });
  const stillOpenNames = open.map(s => s.name).filter(n => n !== prof.name);
  if (stillOpenNames.length) {
    setDayMeta(d => ({ ...d, currentWorker: stillOpenNames[0] }));
  } else {
    setDayMeta(d => ({ ...d, currentWorker: "" }));
  }
};
const closeOpenSessionsAt = useCallback(
  (endTime) => {
    const endStamp = endTime instanceof Date ? endTime : new Date(endTime || Date.now());
    const current = Array.isArray(workerSessionsRef.current)
      ? workerSessionsRef.current
      : [];
    const next = current.map((session) =>
      session && !session.signOutAt ? { ...session, signOutAt: endStamp } : session
    );
    setWorkerSessions(next);
    saveLocalPartial({
      workerSessions: next.map((session) => ({
        ...session,
        signInAt: toIso(session?.signInAt),
        signOutAt: toIso(session?.signOutAt),
      })),
    });
    setLastLocalEditAt(Date.now());
    return next;
  },
  [setLastLocalEditAt]
);
const resetWorkerLog = () => {
  const okAdmin = !!promptAdminAndPin();
  if (!okAdmin) return;
  if (!window.confirm("Delete ALL worker sessions from the Worker Log? This cannot be undone.")) return;
  setWorkerSessions([]);
  alert("Worker Log cleared ");
};
const sumHoursForWorker = (name, sessions, start, end) => {
  const rows = (sessions || []).filter(s => s.name === name);
  let hours = 0;
  const now = new Date();
  const periodStart = start instanceof Date ? start : new Date(start || now);
  const periodEnd   = end   instanceof Date ? end   : new Date(end   || now);
  for (const s of rows) {
    const a = s.signInAt instanceof Date ? s.signInAt : new Date(s.signInAt);
    const b = s.signOutAt
      ? (s.signOutAt instanceof Date ? s.signOutAt : new Date(s.signOutAt))
      : now;
    const toCap = new Date(Math.min(+b, +periodEnd, +now));
    const from  = new Date(Math.max(+a, +periodStart));
    if (toCap > from) hours += (toCap - from) / (1000 * 60 * 60);
  }
  return Number(hours.toFixed(2));
};
  // Hours for a single session, clipped to [start,end] and "now" if still open
const hoursForSession = (s, start, end) => {
  if (!s) return 0;
  const now = new Date();
  const a = s.signInAt instanceof Date ? s.signInAt : new Date(s.signInAt);
  const b = s.signOutAt
    ? (s.signOutAt instanceof Date ? s.signOutAt : new Date(s.signOutAt))
    : now;

  const periodStart = start instanceof Date ? start : new Date(start || now);
  const periodEnd   = end   instanceof Date ? end   : new Date(end   || now);

  const toCap = new Date(Math.min(+b, +periodEnd, +now));
  const from  = new Date(Math.max(+a, +periodStart));
  if (toCap <= from) return 0;

  return Number(((toCap - from) / (1000 * 60 * 60)).toFixed(2));
};

const [wStart, wEnd] = useMemo(() => {
  return getPeriodRange(workerLogFilter, dayMeta, workerLogDay, workerLogMonth, workerLogWeekStart);
}, [workerLogFilter, workerLogDay, workerLogMonth, workerLogWeekStart, dayMeta]);
const workerNamesKnown = useMemo(() => {
  const set = new Set((workerProfiles || []).map(p => p.name));
  for (const s of workerSessions || []) set.add(s.name);
  return Array.from(set);
}, [workerProfiles, workerSessions]);
const workerMonthlyStats = useMemo(() => {
  const rows = [];
  for (const nm of workerNamesKnown) {
    const hrs = sumHoursForWorker(nm, workerSessions, wStart, wEnd);
    const prof = (workerProfiles || []).find(p => p.name === nm);
    const rate = prof ? Number(prof.rate || 0) : 0;
    const pay  = Number((hrs * rate).toFixed(2));
    rows.push({ name: nm, hours: hrs, rate, pay });
  }
  return rows.sort((a,b) => a.name.localeCompare(b.name));
}, [workerNamesKnown, workerSessions, workerProfiles, wStart, wEnd]);
  // Quick lookup: name -> hourly rate
const rateByName = useMemo(() => {
  const m = {};
  for (const p of workerProfiles || []) m[p.name] = Number(p.rate || 0);
  return m;
}, [workerProfiles]);

// Sessions restricted to the selected Worker Log period (day/month)
const sessionsForPeriod = useMemo(() => {
  const now = new Date();
  return (workerSessions || [])
    .filter((s) => {
      const a = s.signInAt instanceof Date ? s.signInAt : new Date(s.signInAt);
      const b = s.signOutAt
        ? (s.signOutAt instanceof Date ? s.signOutAt : new Date(s.signOutAt))
        : now;
      return b >= wStart && a <= wEnd; // overlaps period
    })
    .sort((a, b) => +new Date(b.signInAt) - +new Date(a.signInAt));
}, [workerSessions, wStart, wEnd]);


const workerMonthlyTotalPay = useMemo(
  () => workerMonthlyStats.reduce((s, r) => s + Number(r.pay || 0), 0),
  [workerMonthlyStats]
);
  const promptAdminAndPin = () => {
    const adminStr = window.prompt("Enter Admin number (1 to 6):", "1");
    if (!adminStr) return null;
    const n = Number(adminStr);
    if (![1, 2, 3, 4, 5, 6].includes(n)) {
      alert("Please enter a number from 1 to 6.");
      return null;
    }


    const entered = window.prompt(`Enter PIN for Admin ${n}:`, "");
    if (entered == null) return null;

    const expected = norm(adminPins[n]);
    const attempt = norm(entered);
    if (!expected) {
      alert(
        `Admin ${n} has no PIN set; set a PIN in Edit → Admin PINs.`
      );
      return null;
    }
    if (attempt !== expected) {
      alert("Invalid PIN.");
      return null;
    }
    return n;
  };

  const resetAllCustomerContacts = () => {
    const adminNum = promptAdminAndPin();
    if (!adminNum) return;
    if (
      !window.confirm(
        `Admin ${adminNum}: Delete ALL customer contacts? This cannot be undone.`
      )
    )
      return;
    setCustomers([]);
    saveLocalPartial({ customers: [] });
    alert("All customer contacts cleared.");
  };

  const lockInventoryForDay = () => {
    if (inventoryLocked) return;
    if (inventory.length === 0) return alert("Add at least one inventory item first.");
    if (
      !window.confirm(
        "Lock current inventory as Start-of-Day? You won't be able to edit until End the Day or admin unlock."
      )
    )
      return;

    const snap = inventory.map((it) => ({
      id: it.id,
      name: it.name,
      unit: it.unit,
      qtyAtLock: it.qty,
    }));
    setInventorySnapshot(snap);
    setInventoryLocked(true);
    setInventoryLockedAt(new Date());
  };

  const unlockInventoryWithPin = () => {
    if (!inventoryLocked) return alert("Inventory is already unlocked.");
    const adminNum = promptAdminAndPin();
    if (!adminNum) return;
    if (!window.confirm(`Admin ${adminNum}: Unlock inventory for editing? Snapshot will be kept.`))
      return;
    setInventoryLocked(false);
    alert("Inventory unlocked for editing.");
  };


const endDay = async () => {
    if (!dayMeta.startedAt) return alert("Start a shift first.");

    const who = window.prompt("Enter your name to END THE DAY:", "");
    const endBy = norm(who);
    if (!endBy) return alert("Name is required.");

    const pendingOrders = orders.filter((order) => order && !order.done && !order.voided);
    if (pendingOrders.length > 0) {
      const pendingList = pendingOrders
        .map((order) =>
          order?.orderNo != null
            ? `#${order.orderNo}`
            : order?.channelOrderNo
            ? order.channelOrderNo
            : order?.id
            ? String(order.id)
            : "an order"
        )
        .join(", ");
      alert(
        `You must mark all orders as Done or Cancelled before ending the day. Pending orders: ${pendingList}.`
      );
      return;
    }

    if (!dayMeta.reconciledAt || !dayMeta.startedAt || dayMeta.reconciledAt < dayMeta.startedAt) {
      alert("You must save a Cash Drawer Reconciliation before ending the day. Go to the Reconcile tab.");
      return;
    }

    const endTime = new Date();
    const metaForReport = { ...dayMeta, endedAt: endTime, endedBy: endBy };
    generatePDF(false, metaForReport);

    if (cloudEnabled && ordersColRef && fbUser && db) {
      try {
        const start = dayMeta.startedAt
          ? new Date(dayMeta.startedAt)
          : orders.length
          ? new Date(Math.min(...orders.map((o) => +o.date)))
          : endTime;
        await purgeOrdersInCloud(db, ordersColRef, start, endTime);
      } catch (e) {
        console.warn("Cloud purge on endDay failed:", e);
      }
      try {
        if (counterDocRef) {
          await setDoc(counterDocRef, { lastOrderNo: 0, updatedAt: serverTimestamp() }, { merge: true });
        }
      } catch (e) {
        console.warn("Counter reset failed:", e);
      }
    }

    const validOrders = orders.filter((o) => !o.voided);
    const revenueExclDelivery = validOrders.reduce(
      (sum, order) =>
        sum + Number(order.itemsTotal != null ? order.itemsTotal : order.total - (order.deliveryFee || 0)),
      0
    );
    const expensesTotal = expenses.reduce((sum, expense) => sum + Number((expense.qty || 0) * (expense.unitPrice || 0)), 0);
    const margin = revenueExclDelivery - expensesTotal;

    const txs = [];
    if (margin > 0) {
      txs.push({
        id: `tx_${Date.now()}`,
        type: "init",
        amount: margin,
        worker: endBy,
        note: "Auto Init from day margin",
        date: new Date(),
        locked: true,
        source: "auto_day_margin",
      });
    } else if (margin < 0) {
      txs.push({
        id: `tx_${Date.now() + 1}`,
        type: "adjustDown",
        amount: Math.abs(margin),
        worker: endBy,
        note: "Auto Adjust Down (negative margin)",
        date: new Date(),
        locked: true,
        source: "auto_day_negative_margin",
      });
    }
    const updatedBankTx = txs.length ? [...txs, ...bankTx] : bankTx;
    if (txs.length) setBankTx((arr) => [...txs, ...arr]);

    lastLockedRef.current = [];

    const newHistoricalOrders = [...historicalOrders, ...orders];
    const newHistoricalExpenses = [...historicalExpenses, ...expenses];
    const newHistoricalPurchases = [...historicalPurchases, ...purchases];
    setHistoricalOrders(newHistoricalOrders);
    setHistoricalExpenses(newHistoricalExpenses);
    setHistoricalPurchases(newHistoricalPurchases);
    saveLocalPartial({
      historicalOrders: newHistoricalOrders,
      historicalExpenses: newHistoricalExpenses,
      historicalPurchases: newHistoricalPurchases,
    });

      const clearedExpenses = [];
    const clearedOrders = [];
    setExpenses(clearedExpenses);
    const closedSessions = closeOpenSessionsAt(endTime) || [];
    setOrders(clearedOrders);
    setNextOrderNo(1);

    const resetMeta = {
      startedBy: "",
      currentWorker: "",
      startedAt: null,
      endedAt: null,
      endedBy: "",
      lastReportAt: null,
      resetBy: "",
      resetAt: null,
      shiftChanges: [],
    };
    setDayMeta(resetMeta);
    saveLocalPartial({ dayMeta: resetMeta });
    setLastLocalEditAt(Date.now());

    setReconCounts({});
    setReconSavedBy("");

    if (cloudEnabled && stateDocRef && fbUser) {
      try {
        const bodyBase = packStateForCloud({
          menu,
          extraList,
          orders: realtimeOrders ? [] : clearedOrders,
          inventory,
          nextOrderNo: 1,
          workerProfiles,
          workerSessions: closedSessions,
          dark,
          workers,
          paymentMethods,
          inventoryLocked,
          inventorySnapshot,
          inventoryLockedAt,
          adminPins,
          orderTypes,
          defaultDeliveryFee,
          expenses: clearedExpenses,
          purchases,
          purchaseCategories,
          customers,
          deliveryZones,
          dayMeta: resetMeta,
          utilityBills,
          laborProfile,
          equipmentList,
          bankTx: updatedBankTx,
          realtimeOrders,
          reconHistory,
          onlineOrdersRaw,
          onlineOrderStatus,
          lastSeenOnlineOrderTs,
        });
        writeSeqRef.current += 1;
        const body = {
          ...bodyBase,
          writerId: clientIdRef.current,
          writeSeq: writeSeqRef.current,
          clientTime: Date.now(),
        };
        await setDoc(stateDocRef, body, { merge: true });
        const now = Date.now();
        setLastAppliedCloudAt(now);
        setCloudStatus((s) => ({ ...s, lastSaveAt: new Date(now), error: null }));
      } catch (err) {
        console.warn("Immediate cloud sync after endDay failed", err);
      }
    }

    alert(`Day ended by ${endBy}. Report downloaded and day reset ✅`);
  };
  const [isCheckingOut, setIsCheckingOut] = useState(false);
const multiplyUses = (uses = {}, factor = 1) => {
  const out = {};
  for (const k of Object.keys(uses)) out[k] = Number(uses[k] || 0) * factor;
  return out;
};
  const addToCart = () => {
    if (!selectedBurger) return alert("Select a burger/item first.");
    const qty = Math.max(1, Number(selectedQty || 1));
    const uses = {};
    const prodUses = selectedBurger.uses || {};
    for (const k of Object.keys(prodUses))
      uses[k] = (uses[k] || 0) + (prodUses[k] || 0) * qty;
    for (const ex of selectedExtras) {
      const exUses = ex.uses || {};
      for (const k of Object.keys(exUses))
        uses[k] = (uses[k] || 0) + (exUses[k] || 0) * qty;
    }
    const line = {
      ...selectedBurger,
      extras: [...selectedExtras],
      price: selectedBurger.price,
      qty,
      uses,
    };
    setCart((c) => [...c, line]);
    setSelectedBurger(null);
    setSelectedExtras([]);
    setSelectedQty(1);
  };
  const removeFromCart = (i) =>
    setCart((c) => c.filter((_, idx) => idx !== i));
 const changeQty = (i, delta) =>
  setCart((c) =>
    c.map((line, idx) => {
      if (idx !== i) return line;
      const oldQty = Math.max(1, Number(line.qty || 1));
      const newQty = Math.max(1, oldQty + delta);
      if (newQty === oldQty) return line;
      return {
        ...line,
        qty: newQty,
        uses: multiplyUses(line.uses || {}, newQty / oldQty),
      };
    })
  );

 const setQty = (i, v) =>
  setCart((c) =>
    c.map((line, idx) => {
      if (idx !== i) return line;
      const oldQty = Math.max(1, Number(line.qty || 1));
      const newQty = Math.max(1, Number(v || 1));
      if (newQty === oldQty) return line;
      return {
        ...line,
        qty: newQty,
        uses: multiplyUses(line.uses || {}, newQty / oldQty),
      };
    })
  );
const recordCustomerFromOrder = (order) => {
  if (!order) return;
  const phone = normalizePhone(order.deliveryPhone);
  if (!phone) return;
  const allOrders = [
    ...(historicalOrders || []),
    ...(orders || []),
    order,
  ];
  const related = allOrders.filter(
    (o) => normalizePhone(o?.deliveryPhone) === phone && !o?.voided
  );
  if (!related.length) return;
  const summary = related.reduce(
    (acc, cur) => {
      const total = Number(cur.total || 0);
      const when = parseDateMaybe(cur.date);
      if (Number.isFinite(total)) acc.total += total;
      acc.count += 1;
      if (when) {
        if (!acc.latest || when > acc.latest.when) {
          acc.latest = { when, order: cur };
        }
        if (!acc.earliest || when < acc.earliest) {
          acc.earliest = when;
        }
      }
      return acc;
    },
    { total: 0, count: 0, latest: null, earliest: null }
  );
  setCustomers((prev) => {
    const existing = prev.find((c) => normalizePhone(c.phone) === phone) || {};
    const updated = {
      ...existing,
      phone,
      name: order.deliveryName || existing.name || "",
      address: order.deliveryAddress || existing.address || "",
      zoneId: order.deliveryZoneId || existing.zoneId || "",
      lastOrderAt: summary.latest ? summary.latest.when : existing.lastOrderAt,
      lastOrderNo:
        (summary.latest && summary.latest.order?.orderNo) || existing.lastOrderNo || null,
      lastOrderTotal:
        summary.latest && summary.latest.order
          ? Number(summary.latest.order.total || 0)
          : existing.lastOrderTotal || Number(order.total || 0),
      orderCount: summary.count,
      totalSpend: Number(summary.total.toFixed(2)),
      firstOrderAt: summary.earliest || existing.firstOrderAt || order.date,
      updatedAt: new Date(),
    };
    return upsertCustomer(prev, updated);
  });
};
const checkout = async () => {
  if (isCheckingOut) return;
  setIsCheckingOut(true);
  try {
    if (!dayMeta.startedAt || dayMeta.endedAt)
      return alert("Start a shift first (Shift → Start Shift).");
    if (cart.length === 0) return alert("Cart is empty.");
    if (!worker) return alert("Select worker.");
    if (!orderType) return alert("Select order type.");
    if (!splitPay && !payment) return alert("Select payment.");
  if (orderType === "Delivery") {
    const n = String(deliveryName || "").trim();
    const p = normalizePhone(deliveryPhone);
    const a = String(deliveryAddress || "").trim();
    if (!n || !/^\d{11}$/.test(p) || !a) {
        return alert("Please enter customer name, phone number (10 digits after +20), and address for Delivery.");
    }
  }
  const orderCustomerName =
    orderType === "Delivery"
      ? String(deliveryName || "").trim()
      : String(customerName || "").trim();
  const orderCustomerPhone =
    orderType === "Delivery"
      ? normalizePhone(deliveryPhone)
      : normalizePhone(customerPhone);
    const cartWithUses = cart.map((line) => {
      const baseItem = menu.find((m) => m.id === line.id);
      const unitUses = { ...(baseItem?.uses || {}) };

      for (const ex of line.extras || []) {
        const exDef = extraList.find((e) => e.id === ex.id) || ex;
        const exUses = exDef.uses || {};
        for (const k of Object.keys(exUses)) {
          unitUses[k] = (unitUses[k] || 0) + Number(exUses[k] || 0);
        }
      }

      const qty = Math.max(1, Number(line.qty || 1));
      return { ...line, uses: multiplyUses(unitUses, qty) };
    });
    const required = {};
    for (const line of cartWithUses) {
      for (const k of Object.keys(line.uses || {})) {
        required[k] = (required[k] || 0) + Number(line.uses[k] || 0);
      }
    }
    for (const k of Object.keys(required)) {
      const invItem = invById[k];
      if (!invItem) continue;
      if ((invItem.qty || 0) < required[k]) {
        return alert(
          `Not enough ${invItem.name} in stock. Need ${required[k]} ${invItem.unit}, have ${invItem.qty} ${invItem.unit}.`
        );
      }
    }
    setInventory((inv) =>
      inv.map((it) => {
        const need = Number(required[it.id] || 0);
        return need ? { ...it, qty: it.qty - need } : it;
      })
    );

    const itemsTotal = cartWithUses.reduce((s, b) => {
      const ex = (b.extras || []).reduce((t, e) => t + Number(e.price || 0), 0);
      return s + (Number(b.price || 0) + ex) * Number(b.qty || 1);
    }, 0);
    const delFee =
      orderType === "Delivery" ? Math.max(0, Number(deliveryFee || 0)) : 0;
    const total = itemsTotal + delFee;
    let paymentLabel = payment;
    let paymentParts = [];
    if (splitPay) {
      if (!payA || !payB) return alert("Choose two payment methods.");
      if (payA === payB) return alert("Choose two different methods for split.");
      const a = Math.max(0, Number(amtA || 0));
      const b = Math.max(0, Number(amtB || 0));
      const sum = Number((a + b).toFixed(2));
      if (sum !== Number(total.toFixed(2))) {
        return alert(`Split amounts must equal total (E£${total.toFixed(2)}).`);
      }
    paymentParts = [
        { method: payA, amount: a },
        { method: payB, amount: b },
      ];
      paymentLabel = summarizePaymentParts(paymentParts, paymentLabel);
    } else {
      paymentParts = [{ method: payment || "Unknown", amount: total }];
      paymentLabel = summarizePaymentParts(paymentParts, paymentLabel);
    }
    let cashVal = null;
    let changeDue = null;
    if (splitPay) {
      const cashPart = paymentParts.find((p) => p.method === "Cash");
      if (cashPart) {
        cashVal = Number(cashReceivedSplit || 0);
        changeDue = Math.max(0, cashVal - Number(cashPart.amount || 0));
      }
    } else if (payment === "Cash") {
      cashVal = Number(cashReceived || 0);
      changeDue = Math.max(0, cashVal - total);
    }
    let optimisticNo = nextOrderNo;

  const hasWhatsappPhone = hasWhatsappNumberLength(orderCustomerPhone);
    const shouldWhatsapp =
      orderType === "Delivery"
        ? hasWhatsappPhone
        : hasWhatsappPhone && !!syncWhatsappReady;
    let order = enrichOrderWithChannel({
      orderNo: optimisticNo,
      date: new Date(),
      worker,
      payment: paymentLabel,
      paymentParts,
      orderType,
      deliveryFee: delFee,
      deliveryName: orderCustomerName,
      deliveryPhone: orderCustomerPhone,
      deliveryAddress: orderType === "Delivery" ? String(deliveryAddress || "").trim() : "",
      deliveryZoneId: orderType === "Delivery" ? deliveryZoneId || "" : "",
      notifyViaWhatsapp: shouldWhatsapp,
      whatsappSentAt: null,
      total,
      itemsTotal,
      cashReceived: cashVal,
      changeDue,
      cart: cartWithUses,
      done: false,
      voided: false,
      restockedAt: undefined,
      note: orderNote.trim(),
      idemKey: `idk_${fbUser ? fbUser.uid : "anon"}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}`,
      source: "onsite",
    });
    recordCustomerFromOrder(order);
    setNextOrderNo(optimisticNo + 1);
    let allocatedNo = optimisticNo;
    if (cloudEnabled && counterDocRef && fbUser && db) {
      try {
      allocatedNo = await allocateOrderNoAtomic(db, counterDocRef);
        if (allocatedNo !== optimisticNo) {
          order = {
            ...order,
            orderNo: allocatedNo,
            channelOrderNo: formatOnsiteChannelOrderNo(allocatedNo),
          };
          setNextOrderNo(allocatedNo + 1);
        }
      } catch (e) {
        console.warn("Atomic order number allocation failed, using optimistic number.", e);
      }
    }
    if (!realtimeOrders) setOrders((o) => [order, ...o]);
    if (cloudEnabled && ordersColRef && fbUser) {
      try {
        const ref = await addDoc(ordersColRef, normalizeOrderForCloud(order));
        if (!realtimeOrders) {
          setOrders((prev) =>
            prev.map((oo) =>
              oo.orderNo === order.orderNo ? { ...oo, cloudId: ref.id } : oo
            )
          );
        }
      } catch (e) {
        console.warn("Cloud order write failed:", e);
      }
    }
    setCart([]);
    setWorker("");
    setPayment("");
    setOrderNote("");
    const defaultType = orderTypes[0] || "Take-Away";
    setOrderType(defaultType);
    setDeliveryFee(defaultType === "Delivery" ? defaultDeliveryFee : 0);
  setCashReceived(0);
    setDeliveryName("");
    setDeliveryPhone("");
    setDeliveryAddress("");
    setDeliveryZoneId("");
    setCustomerName("");
    setCustomerPhone("");
    setSyncWhatsappReady(false); 
    setSplitPay(false);
    setPayA(""); setPayB("");
    setAmtA(0); setAmtB(0);
    setCashReceivedSplit(0);
 } finally {
    setIsCheckingOut(false);
  }
};
const integrateOnlineOrder = async (onlineOrder) => {
  if (!onlineOrder) return null;
  if (!dayMeta.startedAt || dayMeta.endedAt) {
    alert("Start a shift first (Shift → Start Shift) before processing online orders.");
    return null;
  }
  const existing = findPosOrderForOnline(onlineOrder);
  if (existing) return existing;

  const cartWithUses = buildCartWithUsesFromOnline(onlineOrder, menu, extraList);
  const required = computeInventoryRequirement(cartWithUses);
  for (const invId of Object.keys(required)) {
    const invItem = invById[invId];
    if (!invItem) continue;
    if ((invItem.qty || 0) < required[invId]) {
      alert(
        `Not enough ${invItem.name} in stock. Need ${required[invId]} ${invItem.unit}, have ${invItem.qty} ${invItem.unit}.`
      );
      return null;
    }
  }

  const key = getOnlineOrderDedupeKey(onlineOrder);
  setOnlineOrderStatus((prev) => {
    const entry = { ...(prev[key] || {}) };
    entry.state = "importing";
    entry.sourceCollection = onlineOrder.sourceCollection || entry.sourceCollection || null;
    entry.sourceDocId = onlineOrder.sourceDocId || entry.sourceDocId || null;
    entry.lastUpdateAt = Date.now();
    return { ...prev, [key]: entry };
  });

  setInventory((inv) =>
    inv.map((item) => {
      const need = Number(required[item.id] || 0);
      if (!need) return item;
      const nextQty = Number(item.qty || 0) - need;
      return { ...item, qty: Number(nextQty.toFixed(4)) };
    })
  );

  const deliveryFee = Number(onlineOrder.deliveryFee || 0);
  const computedItemsTotal = cartWithUses.reduce((sum, line) => {
    const extrasSum = (line.extras || []).reduce(
      (inner, ex) => inner + Number(ex.price || 0),
      0
    );
    return (
      sum +
      (Number(line.price || 0) + extrasSum) * Math.max(1, Number(line.qty || 1))
    );
  }, 0);
  const providedItemsTotal = Number(onlineOrder.itemsTotal || 0);
  const itemsTotal = Number.isFinite(providedItemsTotal) && providedItemsTotal > 0
    ? providedItemsTotal
    : Number(computedItemsTotal.toFixed(2));
  let total = Number(onlineOrder.total || 0);
  if (!Number.isFinite(total) || total <= 0) {
    total = Number((itemsTotal + deliveryFee).toFixed(2));
  }

  let optimisticNo = nextOrderNo;
  let orderNo = optimisticNo;
  setNextOrderNo(optimisticNo + 1);
  if (cloudEnabled && counterDocRef && fbUser && db) {
    try {
      const allocated = await allocateOrderNoAtomic(db, counterDocRef);
      orderNo = allocated;
      if (allocated !== optimisticNo) {
        setNextOrderNo(allocated + 1);
      }
    } catch (err) {
      console.warn("Atomic order number allocation failed for online order.", err);
    }
  }

 const normalizedType = normalizeOnlineOrderType(onlineOrder.orderType, orderTypes);
  const paymentSource = {
    ...(onlineOrder.raw || {}),
    ...(onlineOrder.paymentParts && onlineOrder.paymentParts.length
      ? { paymentParts: onlineOrder.paymentParts }
      : onlineOrder.raw?.paymentParts && onlineOrder.raw.paymentParts.length
      ? { paymentParts: onlineOrder.raw.paymentParts }
      : {}),
    payment: onlineOrder.payment || (onlineOrder.raw && onlineOrder.raw.payment),
    paymentMethod:
      onlineOrder.paymentMethod || (onlineOrder.raw && onlineOrder.raw.paymentMethod),
    paymentType:
      onlineOrder.paymentType || (onlineOrder.raw && onlineOrder.raw.paymentType),
  };

  const explicitPaymentParts = Array.isArray(paymentSource.paymentParts)
    ? paymentSource.paymentParts
    : [];

  const normalizedExplicitParts = explicitPaymentParts
    .map((part) => {
      if (!part || typeof part !== "object") return null;
      const methodCandidate =
        part.method ||
        part.type ||
        part.name ||
        part.label ||
        part.title ||
        part.mode ||
        part.paymentMethod ||
        part.paymentType;
      const normalizedMethod = normalizePaymentMethodName(methodCandidate);
      if (!normalizedMethod) return null;
      const amountCandidate =
        part.amount ??
        part.value ??
        part.total ??
        part.price ??
        part.qty ??
        part.quantity ??
        part.paymentAmount ??
        part.amountDue;
      const numeric = parseNumericAmount(amountCandidate);
      if (numeric == null) return null;
      return {
        method: normalizedMethod,
        amount: Number(Number(numeric).toFixed(2)),
      };
    })
    .filter(Boolean);

  const normalizedPaymentParts =
    normalizedExplicitParts.length > 0
      ? normalizedExplicitParts
      : extractPaymentPartsFromSource(
          paymentSource,
          total,
          paymentSource.payment
        );

  const paymentLabel = summarizePaymentParts(
    normalizedPaymentParts,
    paymentSource.payment || "Online"
  );
  const paymentParts =
    normalizedPaymentParts.length > 0
      ? normalizedPaymentParts.map((part) => ({
          method: part.method,
          amount: Number(Number(part.amount || 0).toFixed(2)),
        }))
      : [{ method: paymentLabel, amount: total }];
  const phoneDigits = normalizePhone(
    onlineOrder.deliveryPhone || onlineOrder.customerPhone
  );
  const shouldWhatsapp = hasWhatsappNumberLength(phoneDigits);

const onlineFallbackId =
    onlineOrder.id ||
    onlineOrder.onlineOrderId ||
    onlineOrder.onlineOrderKey ||
    onlineOrder.sourceDocId ||
    key;
  const channelRef =
    onlineOrder.channelOrderNo ||
    formatOnlineChannelOrderNo(onlineOrder.orderNo, onlineFallbackId, onlineOrder.createdAtMs);

 const onlineDeliveryZoneId = pickFirstTruthyKey(
    onlineOrder.deliveryZoneId,
    onlineOrder.deliveryZone,
    onlineOrder.delivery_zone,
    onlineOrder.zone,
    onlineOrder.raw?.deliveryZoneId,
    onlineOrder.raw?.deliveryZone,
    onlineOrder.raw?.delivery?.zoneId,
    onlineOrder.raw?.delivery?.zone?.id,
    onlineOrder.raw?.delivery?.zone?.slug,
    onlineOrder.raw?.delivery?.zone?.code
  );

  const onlineDeliveryZoneName = pickFirstTruthyKey(
    onlineOrder.deliveryZoneName,
    onlineOrder.deliveryZoneLabel,
    onlineOrder.deliveryZone,
    onlineOrder.delivery_zone,
    onlineOrder.zone,
    onlineOrder.raw?.delivery?.zoneName,
    onlineOrder.raw?.delivery?.zone?.name,
    onlineOrder.raw?.delivery?.zone?.title,
    onlineOrder.raw?.delivery?.area
  );

  const normalizedDeliveryZoneId = pickFirstTruthyKey(
    onlineDeliveryZoneId,
    onlineDeliveryZoneName
  );

  let posOrder = enrichOrderWithChannel({
    orderNo,
    date: new Date(),
    worker: dayMeta.currentWorker || "Online",
    payment: paymentLabel,
    paymentParts,
    orderType: normalizedType,
    deliveryFee: Math.max(0, deliveryFee),
    deliveryName: onlineOrder.deliveryName || "",
    deliveryPhone: phoneDigits,
    deliveryEmail: onlineOrder.deliveryEmail || "",
    deliveryAddress: onlineOrder.deliveryAddress || "",
  deliveryZoneId: normalizedDeliveryZoneId || "",
    deliveryZoneName: onlineDeliveryZoneName || "",
    notifyViaWhatsapp: shouldWhatsapp,
    whatsappSentAt: null,
    total,
    itemsTotal,
    cashReceived: null,
    changeDue: null,
    cart: cartWithUses,
    done: false,
    voided: false,
    restockedAt: undefined,
    note: onlineOrder.note || "",
    idemKey:
      onlineOrder.idemKey ||
      `online_${onlineOrder.id || onlineOrder.orderNo || key || Date.now()}`,
    source: "online",
    channel: "online",
    channelOrderNo: channelRef,
    onlineOrderId: onlineOrder.id || "",
    onlineOrderKey: key,
    onlineSourceCollection: onlineOrder.sourceCollection || "",
    onlineSourceDocId: onlineOrder.sourceDocId || "",
  });

 recordCustomerFromOrder(posOrder);

  const pickFirstEmailFromArray = (maybeArray) => {
    if (!Array.isArray(maybeArray)) return null;
    for (const entry of maybeArray) {
      if (entry == null) continue;
      if (typeof entry === "string") {
        const trimmed = String(entry).trim();
        if (trimmed) return trimmed;
        continue;
      }
      if (typeof entry === "object") {
        const candidate = pickFirstTruthyKey(
          entry.email,
          entry.emailAddress,
          entry.email_address,
          entry.contactEmail,
          entry.contact_email,
          entry.contact?.email,
          entry.contact?.emailAddress,
          entry.contact?.email_address,
          entry.value
        );
        if (candidate) return candidate;
      }
    }
    return null;
  };

  const customerEmailListCandidate =
    pickFirstEmailFromArray(onlineOrder.raw?.customer?.emails) ||
    pickFirstEmailFromArray(onlineOrder.raw?.customer?.emailList) ||
    pickFirstEmailFromArray(onlineOrder.raw?.customer?.email_list) ||
    pickFirstEmailFromArray(onlineOrder.raw?.emails) ||
    pickFirstEmailFromArray(onlineOrder.raw?.emailList) ||
    pickFirstEmailFromArray(onlineOrder.raw?.email_list);

  const contactEmailListCandidate =
    pickFirstEmailFromArray(onlineOrder.raw?.customer?.contacts) ||
    pickFirstEmailFromArray(onlineOrder.raw?.contacts) ||
    pickFirstEmailFromArray(onlineOrder.raw?.contactList) ||
    pickFirstEmailFromArray(onlineOrder.raw?.contact_list) ||
    pickFirstEmailFromArray(onlineOrder.raw?.delivery?.contacts) ||
    pickFirstEmailFromArray(onlineOrder.raw?.delivery?.contactList) ||
    pickFirstEmailFromArray(onlineOrder.raw?.delivery?.contact_list);

  const targetEmail = pickFirstTruthyKey(
    posOrder.deliveryEmail,
    onlineOrder.deliveryEmail,
    onlineOrder.raw?.deliveryEmail,
    onlineOrder.raw?.delivery?.email,
    onlineOrder.raw?.delivery?.emailAddress,
    onlineOrder.raw?.delivery?.email_address,
    onlineOrder.raw?.delivery?.contactEmail,
    onlineOrder.raw?.delivery?.contact?.email,
    onlineOrder.raw?.delivery?.contact?.emailAddress,
    onlineOrder.raw?.delivery?.contact?.email_address,
    onlineOrder.raw?.delivery?.customer?.email,
    onlineOrder.raw?.delivery?.customer?.contactEmail,
    onlineOrder.raw?.delivery?.customer?.contact?.email,
    onlineOrder.raw?.customerEmail,
    onlineOrder.raw?.customer?.email,
    onlineOrder.raw?.customer?.emailAddress,
    onlineOrder.raw?.customer?.email_address,
    onlineOrder.raw?.customer?.contactEmail,
    onlineOrder.raw?.customer?.contact?.email,
    onlineOrder.raw?.customer?.contact?.emailAddress,
    onlineOrder.raw?.customer?.contact?.email_address,
    onlineOrder.raw?.customerDetails?.email,
    onlineOrder.raw?.customer_details?.email,
    onlineOrder.raw?.customerInfo?.email,
    onlineOrder.raw?.customer_info?.email,
    onlineOrder.raw?.customerInfo?.contactEmail,
    onlineOrder.raw?.customer_info?.contactEmail,
    onlineOrder.raw?.customerInfo?.contact?.email,
    onlineOrder.raw?.customer_info?.contact?.email,
    onlineOrder.raw?.email,
    onlineOrder.raw?.contactEmail,
    onlineOrder.raw?.contact?.email,
    onlineOrder.raw?.contact?.emailAddress,
    onlineOrder.raw?.contact?.email_address,
    onlineOrder.raw?.user?.email,
    onlineOrder.raw?.user?.emailAddress,
    onlineOrder.raw?.user?.email_address,
    onlineOrder.raw?.user?.contactEmail,
    onlineOrder.raw?.user?.contact?.email,
    customerEmailListCandidate,
    contactEmailListCandidate
  );

  if (targetEmail) {
    const formatMoney = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return "0.00";
      return num.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    };

    const orderDetailsList = (posOrder.cart || []).map((line) => {
      if (!line) return null;
      const qty = Math.max(1, Number(line.qty || 1));
      const unitPrice = formatMoney(line.price || 0);
      const base = `${qty} × ${line.name || "Item"} (${unitPrice})`;
      const extras = Array.isArray(line.extras)
        ? line.extras
            .filter(Boolean)
            .map((ex) => {
              const exPriceValue = Number(ex?.price);
              const hasPrice = Number.isFinite(exPriceValue) && exPriceValue !== 0;
              const exPrice = hasPrice ? formatMoney(exPriceValue) : "";
              return `  + ${ex?.name || "Extra"}${exPrice ? ` (${exPrice})` : ""}`;
            })
            .join("\n")
        : "";
      return extras ? `${base}\n${extras}` : base;
    });
    const orderDetails = orderDetailsList.filter(Boolean).join("\n") || "No items";

    const instructions =
      pickFirstTruthyKey(
        posOrder.note,
        onlineOrder.note,
        onlineOrder.raw?.note,
        onlineOrder.raw?.notes,
        onlineOrder.raw?.specialInstructions
      ) || "";

    const placedAtSource =
      onlineOrder.createdAt ||
      (onlineOrder.createdAtMs ? new Date(onlineOrder.createdAtMs) : null) ||
      posOrder.date ||
      new Date();
    const placedAtDate =
      placedAtSource instanceof Date
        ? placedAtSource
        : new Date(placedAtSource || Date.now());
    const placedAt = Number.isNaN(+placedAtDate)
      ? new Date().toLocaleString()
      : placedAtDate.toLocaleString();

    const templateParams = {
      to_email: targetEmail,
      to_name:
        pickFirstTruthyKey(
          posOrder.deliveryName,
          onlineOrder.deliveryName,
          onlineOrder.raw?.customer?.name,
          onlineOrder.raw?.customerName
        ) || "Customer",
      order_no: String(posOrder.orderNo),
      order_details: orderDetails,
      fulfillment:
        pickFirstTruthyKey(
          posOrder.orderType,
          onlineOrder.orderType,
          onlineOrder.raw?.fulfillmentType,
          onlineOrder.raw?.fulfillment
        ) || "",
      payment_method:
        pickFirstTruthyKey(
          posOrder.payment,
          onlineOrder.payment,
          onlineOrder.raw?.paymentMethod,
          onlineOrder.raw?.paymentType
        ) || "",
      delivery_zone:
        pickFirstTruthyKey(
          onlineOrder.raw?.deliveryZone,
          onlineOrder.raw?.delivery?.zone,
          onlineOrder.raw?.delivery?.zoneName,
          onlineOrder.raw?.delivery?.area,
          onlineOrder.deliveryZoneId
        ) || "",
      delivery_fee: formatMoney(posOrder.deliveryFee),
      address:
        pickFirstTruthyKey(
          posOrder.deliveryAddress,
          onlineOrder.deliveryAddress,
          onlineOrder.raw?.deliveryAddress,
          onlineOrder.raw?.address,
          onlineOrder.raw?.delivery?.address
        ) || "",
      phone:
        pickFirstTruthyKey(
          posOrder.deliveryPhone,
          onlineOrder.deliveryPhone,
          onlineOrder.raw?.customerPhone,
          onlineOrder.raw?.phone,
          onlineOrder.raw?.customer?.phone,
          onlineOrder.raw?.delivery?.phone
        ) || "",
      instructions,
      order_subtotal: formatMoney(posOrder.itemsTotal),
      order_total: formatMoney(posOrder.total),
      placed_at: placedAt,
    };

    try {
      await sendEmailJsEmail(templateParams);
    } catch (err) {
      console.warn("Unable to send online order confirmation email", err);
    }
  }

  if (!realtimeOrders) setOrders((o) => [posOrder, ...o]);
  if (cloudEnabled && ordersColRef && fbUser) {
    try {
      const ref = await addDoc(ordersColRef, normalizeOrderForCloud(posOrder));
      posOrder.cloudId = ref.id;
      if (!realtimeOrders) {
        setOrders((prev) =>
          prev.map((ord) =>
            ord.orderNo === posOrder.orderNo ? { ...ord, cloudId: ref.id } : ord
          )
        );
      }
    } catch (err) {
      console.warn("Cloud write failed for online order integration:", err);
    }
  }

  setOnlineOrderStatus((prev) => {
    const entry = { ...(prev[key] || {}) };
    entry.state = "imported";
    entry.posOrderNo = posOrder.orderNo;
    entry.sourceCollection = onlineOrder.sourceCollection || entry.sourceCollection || null;
    entry.sourceDocId = onlineOrder.sourceDocId || entry.sourceDocId || null;
    entry.lastUpdateAt = Date.now();
    return { ...prev, [key]: entry };
  });

  try {
    await updateOnlineOrderDoc(onlineOrder, {
      status: "accepted",
      posOrderNo: posOrder.orderNo,
      posIntegratedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Failed to update online order status in source", err);
  }

  return posOrder;
};
const markOrderDone = async (orderNo) => {
const ord = orders.find((o) => o.orderNo === orderNo);
  const phoneDigits = ord ? normalizePhone(ord.deliveryPhone) : "";
 const shouldNotify =
    ord &&
    ord.notifyViaWhatsapp &&
    !ord.whatsappSentAt &&
    hasWhatsappNumberLength(phoneDigits);
  let notifiedAt = null;
  if (shouldNotify) {
    notifiedAt = new Date();
    openWhatsappNotification(ord, phoneDigits);
  }
  // If not live, update locally
  if (!realtimeOrders) {
    setOrders((o) =>
      o.map((ordr) =>
        ordr.orderNo !== orderNo || ordr.done
          ? ordr
          : { ...ordr, done: true, whatsappSentAt: notifiedAt || ordr.whatsappSentAt || null }
      )
    );
  }

  try {
    if (!cloudEnabled || !ordersColRef || !fbUser) return;
    let targetId = orders.find((o) => o.orderNo === orderNo)?.cloudId;
    if (!targetId) {
      const ss = await getDocs(query(ordersColRef, where("orderNo", "==", orderNo)));
      if (!ss.empty) targetId = ss.docs[0].id;
   }
    if (targetId) {
      const payload = {
        done: true,
        updatedAt: serverTimestamp(),
      };
      if (notifiedAt) {
        payload.whatsappSentAt = toIso(notifiedAt);
      }
      await updateDoc(fsDoc(db, "shops", SHOP_ID, "orders", targetId), payload);
    }
  } catch (e) {
    console.warn("Cloud update (done) failed:", e);
   }
};
const markOnlineOrderDone = async (onlineOrder) => {
  const posOrder = findPosOrderForOnline(onlineOrder) || (await integrateOnlineOrder(onlineOrder));
  if (!posOrder) return;
  await markOrderDone(posOrder.orderNo);
  try {
    await updateOnlineOrderDoc(onlineOrder, {
      status: "completed",
      posCompletedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Failed to update online order to completed", err);
  }
};
const printOnlineOrder = (onlineOrder) => {
  const posOrder = findPosOrderForOnline(onlineOrder);
  if (!posOrder) {
    alert("Make the online order in POS before printing.");
    return;
  }
  printReceiptHTML(posOrder, Number(preferredPaperWidthMm) || 80, "Customer");
};
const voidOnlineOrderAndRestock = async (onlineOrder) => {
  const posOrder = findPosOrderForOnline(onlineOrder);
  if (!posOrder) {
    alert("Make the online order in POS before cancelling.");
    return;
  }
  await voidOrderAndRestock(posOrder.orderNo);
  try {
    await updateOnlineOrderDoc(onlineOrder, {
      status: "cancelled",
      posCancelledAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Failed to update online order cancel status", err);
  }
};
const voidOnlineOrderToExpense = async (onlineOrder) => {
  const posOrder = findPosOrderForOnline(onlineOrder);
  if (!posOrder) {
    alert("Make the online order in POS before returning it.");
    return;
  }
  await voidOrderToExpense(posOrder.orderNo);
  try {
    await updateOnlineOrderDoc(onlineOrder, {
      status: "cancelled",
      posCancelledAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn("Failed to update online order return status", err);
  }
};
const voidOrderAndRestock = async (orderNo) => {
  const ord = orders.find((o) => o.orderNo === orderNo);
  if (!ord) return;
  if (ord.done) return alert("This order is DONE and cannot be cancelled.");
  if (ord.voided) return alert("This order is already cancelled/returned.");

  const reasonRaw = window.prompt(
    `Reason for CANCEL (restock) — order #${orderNo}:`,
    ""
  );
  const reason = String(reasonRaw || "").trim();
  if (!reason) return alert("A reason is required.");
  if (!window.confirm(`Cancel order #${orderNo} and restock inventory?`)) return;
  const giveBack = {};
  for (const line of ord.cart) {
    const uses = line.uses || {};
    for (const k of Object.keys(uses)) {
      giveBack[k] = (giveBack[k] || 0) + (uses[k] || 0);
    }
  }
  setInventory((inv) =>
    inv.map((it) => {
      const back = giveBack[it.id] || 0;
      return back ? { ...it, qty: it.qty + back } : it;
    })
  );

  const when = new Date();
  if (!realtimeOrders) {
    setOrders((o) =>
      o.map((x) =>
        x.orderNo === orderNo
          ? { ...x, voided: true, restockedAt: when, voidReason: reason }
          : x
      )
    );
  }

  try {
    if (!cloudEnabled || !ordersColRef || !fbUser) return;
    let targetId = ord.cloudId;
    if (!targetId) {
      const ss = await getDocs(query(ordersColRef, where("orderNo", "==", orderNo)));
      if (!ss.empty) targetId = ss.docs[0].id;
    }
    if (targetId) {
      await updateDoc(fsDoc(db, "shops", SHOP_ID, "orders", targetId), {
        voided: true,
        voidReason: reason,
        restockedAt: toIso(when),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (e) {
    console.warn("Cloud update (cancel/restock) failed:", e);
  }
};
const voidOrderToExpense = async (orderNo) => {
  const ord = orders.find((o) => o.orderNo === orderNo);
  if (!ord) return;
  if (ord.done) return alert("This order is DONE and cannot be voided.");
  if (ord.voided) return alert("This order is already voided.");
  if (!isExpenseVoidEligible(ord.orderType)) {
    return alert("This action is only for non Dine-in / Take-Away orders.");
  }
  const reasonRaw = window.prompt(
    `Reason for RETURN (no restock) — order #${orderNo}:`,
    ""
  );
  const reason = String(reasonRaw || "").trim();
  if (!reason) return alert("A reason is required.");

  const itemsOnly = ord.itemsTotal != null
    ? Number(ord.itemsTotal || 0)
    : Math.max(0, Number(ord.total || 0) - Number(ord.deliveryFee || 0));

  const ok = window.confirm(
    `Void order #${orderNo} WITHOUT restock and add expense for wasted items (E£${itemsOnly.toFixed(2)})?`
  );
  if (!ok) return;
  const expRow = {
    id: `exp_ret_${orderNo}_${Date.now()}`,
    name: `Returned order #${orderNo} — ${ord.orderType || "-"}`,
    unit: "order",
    qty: 1,
    unitPrice: itemsOnly,
    note: reason,
    date: new Date(),
    locked: true,
    source: "order_return",
    orderNo,
  };
  setExpenses((arr) => [expRow, ...arr]);
  if (!realtimeOrders) {
    setOrders((o) =>
      o.map((x) =>
        x.orderNo === orderNo
          ? { ...x, voided: true, restockedAt: undefined, voidReason: reason }
          : x
      )
    );
  }

  try {
    if (cloudEnabled && ordersColRef && fbUser) {
      let targetId = ord.cloudId;
      if (!targetId) {
        const ss = await getDocs(query(ordersColRef, where("orderNo", "==", orderNo)));
        if (!ss.empty) targetId = ss.docs[0].id;
      }
      if (targetId) {
        await updateDoc(fsDoc(db, "shops", SHOP_ID, "orders", targetId), {
          voided: true,
          voidReason: reason,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (e) {
    console.warn("Cloud update (void→expense) failed:", e);
  }
};





  // --------------------------- REPORT TOTALS ---------------------------
 const getSortedOrders = () => {
    const arr = [...orders];
    if (sortBy === "date-desc") arr.sort((a, b) => b.date - a.date);
    if (sortBy === "date-asc") arr.sort((a, b) => a.date - b.date);
    if (sortBy === "worker") arr.sort((a, b) => a.worker.localeCompare(b.worker));
    if (sortBy === "payment") arr.sort((a, b) => a.payment.localeCompare(b.payment));
    return arr;
  };

  const [reportStart, reportEnd] = useMemo(() => {
    const [start, end] = getPeriodRange(reportFilter, dayMeta, reportDay, reportMonth, undefined);
    return [start, end];
  }, [reportFilter, reportDay, reportMonth, dayMeta]);


  const resetReports = () => {
    const adminNum = promptAdminAndPin();
    if (!adminNum) return;
    if (
      !window.confirm(
        `Admin ${adminNum}: Reset ALL locally saved report data and filters? This cannot be undone.`
      )
    ) {
      return;
    }

    const now = new Date();
    const isoDay = now.toISOString().slice(0, 10);
    const isoMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    setReportFilter("shift");
    setReportDay(isoDay);
    setReportMonth(isoMonth);
    setMarginChartFilter("week");

    const { week: defaultWeek } = getSundayWeekInfo(now);
    setMarginChartWeek(defaultWeek);
    setMarginChartWeekYear(now.getFullYear());
    setMarginChartMonthSelection(isoMonth);
    setMarginChartYearSelection(now.getFullYear());

    setHistoricalOrders([]);
    setHistoricalExpenses([]);
    setHistoricalPurchases([]);
    saveLocalPartial({
      historicalOrders: [],
      historicalExpenses: [],
      historicalPurchases: [],
    });

    alert("Report history and filters have been reset.");
  };

const computeProfitBuckets = useCallback(
    (rangeStart, rangeEnd) => {
      if (!rangeStart || !rangeEnd) return [];
      const startMs = +rangeStart;
      const endMs = +rangeEnd;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];

      const start = new Date(startMs);
      const end = new Date(endMs);

      const toDate = (value) => {
        if (!value) return null;
        if (value instanceof Date) return value;
        const d = new Date(value);
        return Number.isNaN(+d) ? null : d;
      };

      const shiftStart = dayMeta?.startedAt ? new Date(dayMeta.startedAt) : null;
      const shiftEndRaw = dayMeta?.endedAt ? new Date(dayMeta.endedAt) : null;
      const now = new Date();
      const shiftEnd = shiftEndRaw || now;
      const includeHistorical =
        !shiftStart || start < shiftStart || end > shiftEnd;

      const mergeRows = (liveRows = [], historicalRows = []) =>
        includeHistorical
          ? [...(historicalRows || []), ...(liveRows || [])]
          : liveRows || [];

      const map = new Map();
      const ensureBucket = (dateObj) => {
        const dayStart = new Date(
          dateObj.getFullYear(),
          dateObj.getMonth(),
          dateObj.getDate(),
          0,
          0,
          0,
          0
        );
        const key = dayStart.getTime();
        if (!map.has(key)) {
          const dd = String(dayStart.getDate()).padStart(2, "0");
          const mm = String(dayStart.getMonth() + 1).padStart(2, "0");
          const yyyy = dayStart.getFullYear();
          map.set(key, {
            ts: key,
            date: `${dd}-${mm}-${yyyy}`,
            revenue: 0,
            purchasesCost: 0,
            expenseCost: 0,
          });
        }
        return map.get(key);
      };

      const inRange = (d) => d >= start && d <= end;

      // FIX: This calculation should only use processed orders from the main `orders` state
      // and historical orders, NOT pending online orders.
      const allOrders = mergeRows(orders, historicalOrders);
      
      for (const order of allOrders) {
        if (!order || order.voided) continue;
        const when = toDate(order.date);
        if (!when || !inRange(when)) continue;
        const itemsOnly = Number(
          order.itemsTotal != null
            ? order.itemsTotal
            : (order.total || 0) - (order.deliveryFee || 0)
        );
        if (!Number.isFinite(itemsOnly)) continue;
        const bucket = ensureBucket(when);
        bucket.revenue += itemsOnly;
      }

      for (const purchase of mergeRows(purchases, historicalPurchases)) {
        const when = toDate(purchase?.date);
        if (!when || !inRange(when)) continue;
        const qty = Number(purchase?.qty || 0);
        const price = Number(purchase?.unitPrice || 0);
        const amount = qty * price;
        if (!Number.isFinite(amount)) continue;
        const bucket = ensureBucket(when);
        bucket.purchasesCost += amount;
      }

      for (const expense of mergeRows(expenses, historicalExpenses)) {
        const when = toDate(expense?.date);
        if (!when || !inRange(when)) continue;
        const qty = Number(expense?.qty || 0);
        const price = Number(expense?.unitPrice || 0);
        const amount = qty * price;
        if (!Number.isFinite(amount)) continue;
        const bucket = ensureBucket(when);
        bucket.expenseCost += amount;
      }

      return Array.from(map.values())
        .sort((a, b) => a.ts - b.ts)
        .map((bucket) => {
          const net = bucket.revenue - bucket.purchasesCost - bucket.expenseCost;
          const marginPct = bucket.revenue
            ? (net / bucket.revenue) * 100
            : 0;
          return {
            date: bucket.date,
            ts: bucket.ts,
            revenue: Number(bucket.revenue.toFixed(2)),
            purchasesCost: Number(bucket.purchasesCost.toFixed(2)),
            expenseCost: Number(bucket.expenseCost.toFixed(2)),
            net: Number(net.toFixed(2)),
            marginPct: Number(marginPct.toFixed(2)),
          };
        });
    },
 [
      orders,
      purchases,
      expenses,
      historicalOrders,
      historicalPurchases,
      historicalExpenses,
      dayMeta,
    ]
  );

  const profitTimeline = useMemo(
    () => computeProfitBuckets(reportStart, reportEnd),
    [computeProfitBuckets, reportStart, reportEnd]
  );

  const reportOrders = useMemo(() => {
    if (!reportStart || !reportEnd) return [];
    const startMs = +reportStart;
    const endMs = +reportEnd;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];

    const start = new Date(startMs);
    const end = new Date(endMs);

    const toDate = (value) => {
      if (!value) return null;
      if (value instanceof Date) return value;
      const d = new Date(value);
      return Number.isNaN(+d) ? null : d;
    };

    const shiftStart = dayMeta?.startedAt ? new Date(dayMeta.startedAt) : null;
    const shiftEndRaw = dayMeta?.endedAt ? new Date(dayMeta.endedAt) : null;
    const now = new Date();
    const shiftEnd = shiftEndRaw || now;
    const includeHistorical =
      !shiftStart || start < shiftStart || end > shiftEnd;

  const sourceOrders = includeHistorical
      ? [...(historicalOrders || []), ...(orders || [])]
      : orders || [];

    const onsite = sourceOrders.filter((order) => {
      if (!order || order.voided) return false;
      const when = toDate(order.date);
      return when && when >= start && when <= end;
    });

    const online = accountedOnlineOrders.filter((order) => {
      if (!order) return false;
      const when = toDate(order.date);
      return when && when >= start && when <= end;
    });

 return [...onsite, ...online].map(enrichOrderWithChannel);
  }, [
    orders,
    historicalOrders,
    accountedOnlineOrders,
    reportStart,
    reportEnd,
    dayMeta,
  ]);

  const reportOrdersDetailed = useMemo(() => {
    const toMs = (value) => {
      const ms = toMillis(value);
      return Number.isFinite(ms) ? ms : 0;
    };
    return [...reportOrders]
      .map(enrichOrderWithChannel)
      .sort((a, b) => toMs(b.date) - toMs(a.date));
  }, [reportOrders]);

const totals = useMemo(() => {
    const makeEmptyMaps = () => {
      const byPay = {};
      for (const method of paymentMethods) byPay[method] = 0;
      const byType = {};
      for (const type of orderTypes) byType[type] = 0;
      return { byPay, byType };
    };

    if (!reportStart || !reportEnd) {
      const { byPay, byType } = makeEmptyMaps();
      return {
        revenueTotal: 0,
        deliveryFeesTotal: 0,
        expensesTotal: 0,
        purchasesTotal: 0,
        margin: 0,
        byPay,
        byType,
      };
    }

    const startMs = +reportStart;
    const endMs = +reportEnd;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      const { byPay, byType } = makeEmptyMaps();
      return {
        revenueTotal: 0,
        deliveryFeesTotal: 0,
        expensesTotal: 0,
        purchasesTotal: 0,
        margin: 0,
        byPay,
        byType,
      };
    }

    const start = new Date(startMs);
    const end = new Date(endMs);

    const toDate = (value) => {
      if (!value) return null;
      if (value instanceof Date) return value;
      const d = new Date(value);
      return Number.isNaN(+d) ? null : d;
    };

    const shiftStart = dayMeta?.startedAt ? new Date(dayMeta.startedAt) : null;
    const shiftEndRaw = dayMeta?.endedAt ? new Date(dayMeta.endedAt) : null;
    const now = new Date();
    const shiftEnd = shiftEndRaw || now;
    const includeHistorical =
      !shiftStart || start < shiftStart || end > shiftEnd;

    const mergeRows = (liveRows = [], historicalRows = []) =>
      includeHistorical
        ? [...(historicalRows || []), ...(liveRows || [])]
        : liveRows || [];

    // FIX: This calculation should only use processed orders.
    // By removing `accountedOnlineOrders`, the totals will be accurate
    // for reconciliation and shift reports.
    const filteredOrders = mergeRows(orders, historicalOrders).filter((order) => {
      if (!order || order.voided) return false;
      const when = toDate(order.date);
      return when && when >= start && when <= end;
    });

    const revenueTotal = filteredOrders.reduce(
      (sum, order) =>
        sum +
        Number(
          order.itemsTotal != null
            ? order.itemsTotal
            : (order.total || 0) - (order.deliveryFee || 0)
        ),
      0
    );

    const deliveryFeesTotal = filteredOrders.reduce(
      (sum, order) => sum + Number(order.deliveryFee || 0),
      0
    );

    const { byPay, byType } = makeEmptyMaps();

    for (const order of filteredOrders) {
      const itemsOnly = Number(
        order.itemsTotal != null
          ? order.itemsTotal
          : (order.total || 0) - (order.deliveryFee || 0)
      );

      if (Array.isArray(order.paymentParts) && order.paymentParts.length) {
        const sumParts =
          order.paymentParts.reduce(
            (sum, part) => sum + Number(part.amount || 0),
            0
          ) || order.total || itemsOnly;
        for (const part of order.paymentParts) {
          const method = part.method || "Unknown";
          const share = sumParts ? Number(part.amount || 0) / sumParts : 0;
          if (byPay[method] == null) byPay[method] = 0;
          byPay[method] += itemsOnly * share;
        }
      } else {
        const method = order.payment || "Unknown";
        if (byPay[method] == null) byPay[method] = 0;
        byPay[method] += itemsOnly;
      }

      const typeKey = order.orderType || "";
      if (byType[typeKey] == null) byType[typeKey] = 0;
      byType[typeKey] += itemsOnly;
    }

    const filteredPurchases = mergeRows(
      purchases,
      historicalPurchases
    ).filter((purchase) => {
      const when = toDate(purchase?.date);
      return when && when >= start && when <= end;
    });

    const purchasesTotal = filteredPurchases.reduce(
      (sum, purchase) =>
        sum + Number(purchase?.qty || 0) * Number(purchase?.unitPrice || 0),
      0
    );

    const filteredExpenses = mergeRows(
      expenses,
      historicalExpenses
    ).filter((expense) => {
      const when = toDate(expense?.date);
      return when && when >= start && when <= end;
    });

    const expensesTotal = filteredExpenses.reduce(
      (sum, expense) =>
        sum + Number(expense?.qty || 0) * Number(expense?.unitPrice || 0),
      0
    );

    const margin = revenueTotal - purchasesTotal - expensesTotal;

    return {
      revenueTotal,
      deliveryFeesTotal,
      expensesTotal,
      purchasesTotal,
      margin,
      byPay,
      byType,
    };
  }, [
    reportStart,
    reportEnd,
    orders,
    historicalOrders,
    purchases,
    historicalPurchases,
    expenses,
    historicalExpenses,
    paymentMethods,
    orderTypes,
    dayMeta,
  ]);


  const salesStats = useMemo(() => {
    const itemMap = new Map();
    const extraMap = new Map();
    const add = (map, id, name, count, revenue) => {
      const prev = map.get(id) || { id, name, count: 0, revenue: 0 };
      prev.count += count;
      prev.revenue += revenue;
      map.set(id, prev);
    };
    for (const o of reportOrders) {
      if (o.voided) continue;
      for (const line of o.cart || []) {
        const q = Number(line.qty || 1);
        const base = Number(line.price || 0);
        add(itemMap, line.id, line.name, q, base * q);
        for (const ex of line.extras || [])
          add(extraMap, ex.id, ex.name, q, Number(ex.price || 0) * q);
      }
    }
    const items = Array.from(itemMap.values()).sort(
      (a, b) => b.count - a.count || b.revenue - a.revenue
    );
    const extras = Array.from(extraMap.values()).sort(
      (a, b) => b.count - a.count || b.revenue - a.revenue
    );
    return { items, extras };
  }, [reportOrders]);

 const marginChartRange = useMemo(() => {
    const now = new Date();
    const todayEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      23,
      59,
      59,
      999
    );

    let start;
    let end;

    if (marginChartFilter === "year") {
      const year = Number(marginChartYearSelection) || now.getFullYear();
      start = new Date(year, 0, 1, 0, 0, 0, 0);
      end = new Date(year, 11, 31, 23, 59, 59, 999);
    } else if (marginChartFilter === "month") {
      const parts = (marginChartMonthSelection || "").split("-");
      const year = Number(parts[0]) || now.getFullYear();
      const monthIndex = Number(parts[1]) ? Number(parts[1]) - 1 : now.getMonth();
      start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
      end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    } else {
      const weekStart =
        getSundayStartOfWeek(marginChartWeekYear, marginChartWeek) ||
        getSundayStartDate(now) ||
        new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      start = new Date(weekStart);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    }

    if (!start || !end || Number.isNaN(+start) || Number.isNaN(+end)) {
      const fallbackStart = getSundayStartDate(now) || now;
      start = new Date(fallbackStart);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
    }

    if (end > todayEnd && start <= todayEnd) end = todayEnd;

    return { start, end };
  }, [
    marginChartFilter,
    marginChartWeek,
    marginChartWeekYear,
    marginChartMonthSelection,
    marginChartYearSelection,
  ]);

  const marginChartData = useMemo(
    () => computeProfitBuckets(marginChartRange.start, marginChartRange.end),
    [computeProfitBuckets, marginChartRange]
  );
const filteredBankTx = useMemo(() => {
  const [start, end] = getPeriodRange(bankFilter, dayMeta, bankDay, bankMonth, undefined);
  return bankTx.filter(t => {
    const d = t.date instanceof Date ? t.date : new Date(t.date);
    return d >= start && d <= end;
  });
}, [bankTx, bankFilter, bankDay, bankMonth, dayMeta]);

const [pStart, pEnd] = useMemo(
  () => getPeriodRange(purchaseFilter, dayMeta, purchaseDay, purchaseMonth, undefined),
  [purchaseFilter, dayMeta, purchaseDay, purchaseMonth]
);
const filteredPurchases = useMemo(() => {
 const withinPeriod = (purchases || []).filter((p) => {
    const d = p?.date instanceof Date ? p.date : new Date(p?.date);
    return isWithin(d, pStart, pEnd);
  });
  return purchaseCatFilterId
    ? withinPeriod.filter((p) => p.categoryId === purchaseCatFilterId)
    : withinPeriod;
}, [purchases, pStart, pEnd, purchaseCatFilterId]);
const customerRows = useMemo(
  () => buildCustomerContactRows(customers, orders, historicalOrders, deliveryZones),
  [customers, orders, historicalOrders, deliveryZones]
);
const filteredCustomerRows = useMemo(
  () => searchCustomersByQuery(customerRows, customerSearch),
  [customerRows, customerSearch]
);
const customerZoneSummary = useMemo(() => {
  const map = new Map();
  for (const row of customerRows) {
    const key = row.zoneName || "Unassigned";
    const prev = map.get(key) || { zoneName: key, count: 0, totalSpend: 0 };
    prev.count += 1;
    prev.totalSpend += Number(row.totalSpend || 0);
    map.set(key, prev);
  }
  return Array.from(map.values()).sort(
    (a, b) => b.totalSpend - a.totalSpend || b.count - a.count
  );
}, [customerRows]);
const topSpenders = useMemo(
  () => customerRows.slice(0, 5),
  [customerRows]
);
const vipPhones = useMemo(
  () =>
    new Set(
      topSpenders
        .map((row) => normalizePhone(row.phone))
        .filter(Boolean)
    ),
  [topSpenders]
);
const isVipDeliveryCustomer = useMemo(() => {
  if (orderType !== "Delivery") return false;
  const normalized = normalizePhone(deliveryPhone);
  if (!normalized) return false;
  return vipPhones.has(normalized);
}, [orderType, deliveryPhone, vipPhones]);
const totalContactSpend = useMemo(
  () => customerRows.reduce((sum, row) => sum + Number(row.totalSpend || 0), 0),
  [customerRows]
);
const totalTrackedOrders = useMemo(
  () => customerRows.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
  [customerRows]
);
  const byCategory = useMemo(() => {
  const m = new Map();
  for (const p of filteredPurchases) {
    const key = p.categoryId || "";
    const arr = m.get(key) || [];
    arr.push(p);
    m.set(key, arr);
  }
  for (const arr of m.values()) {
    arr.sort((a, b) => +new Date(a.date) - +new Date(b.date));
  }
  return m;
}, [filteredPurchases]);
const categoriesForGrid = useMemo(() => {
  if (showAllCats) return purchaseCategories;
  const used = new Set(filteredPurchases.map(p => p.categoryId));
  return purchaseCategories.filter(c => used.has(c.id));
}, [showAllCats, filteredPurchases, purchaseCategories]);
const totalPurchasesInPeriod = useMemo(
  () => sumPurchases(filteredPurchases),
  [filteredPurchases]
);
const catTotals = useMemo(() => {
  const m = new Map();
  for (const p of filteredPurchases) {
    const amt = Number(p.qty || 0) * Number(p.unitPrice || 0);
    m.set(p.categoryId || "", (m.get(p.categoryId || "") || 0) + amt);
  }
  return m;
}, [filteredPurchases]);
function inferInvUnitFromPurchaseUnit(u) {
  const m = UNIT_MAP[String(u || "").toLowerCase()];
  return m ? m.base : "piece";
}

const handleAddPurchase = () => {
  const { categoryId, itemName, unit, qty, unitPrice, date, ingredientId } = newPurchase;
  const nameStr = String(itemName || "").trim();
  if (!categoryId || !nameStr) {
    alert("Choose a category and enter an item name.");
    return;
  }
  let targetInvId =
    ingredientId ||
    findInventoryIdForPurchase(
      { categoryId, itemName: nameStr, ingredientId },
      inventory,
      purchaseCategories
    );

  let nextInventory = [...inventory];
  if (!targetInvId) {
    const catName =
      purchaseCategories.find((c) => c.id === categoryId)?.name ||
      nameStr ||
      "Item";
    const invUnit = inferInvUnitFromPurchaseUnit(unit);
    const id = ensureInvIdUnique(slug(catName), nextInventory);
    nextInventory.push({ id, name: catName, unit: invUnit, qty: 0, costPerUnit: 0, minQty: 0 });
    targetInvId = id;
  }
  const invItem = nextInventory.find((it) => it.id === targetInvId);
  const delta = convertToInventoryUnit(qty, unit, invItem?.unit);
  if (delta != null) {
    nextInventory = nextInventory.map((it) =>
      it.id === targetInvId ? { ...it, qty: Number(it.qty || 0) + Number(delta) } : it
    );
  } else if (invItem && Number(invItem.qty || 0) === 0) {
    const newUnit = inferInvUnitFromPurchaseUnit(unit);
    nextInventory = nextInventory.map((it) =>
      it.id === targetInvId ? { ...it, unit: newUnit } : it
    );
    const delta2 = convertToInventoryUnit(qty, unit, newUnit) || 0;
    nextInventory = nextInventory.map((it) =>
      it.id === targetInvId ? { ...it, qty: Number(it.qty || 0) + delta2 } : it
    );
  } else {
    alert(
      `Purchase saved, but units incompatible (${unit} vs ${invItem?.unit}). Update the inventory unit first.`
    );
  }
const targetItem = nextInventory.find(it => it.id === targetInvId);
if (targetItem) {
  const cpu = unitPriceToInventoryCost(Number(unitPrice || 0), unit, targetItem.unit);
  if (cpu != null) {
    nextInventory = nextInventory.map(it =>
      it.id === targetInvId ? { ...it, costPerUnit: Number(cpu.toFixed(4)) } : it
    );
  }
}
  setInventory(nextInventory);
  const row = {
    id: `p_${Date.now()}`,
    categoryId,
    itemName: nameStr,
    unit: String(unit || "piece").toLowerCase(),
    qty: Math.max(0, Number(qty || 0)),
    unitPrice: Math.max(0, Number(unitPrice || 0)),
    date: date ? new Date(date) : new Date(),
    ingredientId: targetInvId,
    invId: newPurchase.invId || "",
  };
  setPurchases((arr) => [row, ...arr]);
  setNewPurchase({
    categoryId: "",
    itemName: "",
    unit: "piece",
    qty: 1,
    unitPrice: 0,
    date: new Date().toISOString().slice(0, 10),
    ingredientId: "",
    invId: "",
  });
};
  const addPurchaseCategory = () => {
  const nm = String(newCategoryName || "").trim();
  if (!nm) return alert("Enter category name");
  const id = ensureInvIdUnique(slug(nm), purchaseCategories); // reuse your helpers
  setPurchaseCategories(list => [
    ...list,
    { id, name: nm, unit: newCategoryUnit || inferUnitFromCategoryName(nm) },
  ]);
  setNewCategoryName("");
  setNewCategoryUnit("piece");
};
const resetAllPurchases = () => {
  const okAdmin = !!promptAdminAndPin();
  if (!okAdmin) return;
  if (!window.confirm("Reset ALL purchases (cannot be undone)?")) return;
  setPurchases([]);
  setPurchaseCatFilterId("");
};
const removePurchaseCategory = (catId) => {
  const cat = purchaseCategories.find(c => c.id === catId);
  const name = cat?.name || "(unknown)";
  if (!window.confirm(`Delete category "${name}" and ALL its purchases? This cannot be undone.`)) return;
  setPurchaseCategories(list => list.filter(c => c.id !== catId));
  setPurchases(list => list.filter(p => p.categoryId !== catId));
  setPurchaseCatFilterId(prev => (prev === catId ? "" : prev));
  setNewPurchase(p => (p.categoryId === catId ? { ...p, categoryId: "" } : p));
};

  // --- Expenses: protected delete (prevents removal of returned-order expenses)
const removeExpense = (id) => {
  setExpenses((arr) => {
    const row = arr.find((e) => e.id === id);
    if (!row) return arr;
    if (isExpenseLocked(row)) {
      alert("This expense is linked to a returned order and cannot be removed.");
      return arr; // block deletion
    }
    return arr.filter((e) => e.id !== id);
  });
};

 



  // --------------------------- PDF: REPORT ---------------------------
  const generatePDF = (silent = false, metaOverride = null) => {
    try {
      const m = metaOverride || dayMeta;
      const doc = new jsPDF();
      doc.text("TUX — Shift Report", 14, 12);

      const startedStr = m.startedAt ? fmtDateTime(m.startedAt) : "—";
const endedStr   = m.endedAt   ? fmtDateTime(m.endedAt)   : "—";

      

      autoTable(doc, {
        head: [["Start By", "Start At", "Current Worker", "End At"]],
        body: [[m.startedBy || "—", startedStr, m.currentWorker || "—", endedStr]],
        startY: 18,
        theme: "grid",
      });


      let y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 28;
      doc.text("Shift Timeline", 14, y);
      const timelineRows = [];
      timelineRows.push(["Started", startedStr, m.startedBy || "—"]);
      (m.shiftChanges || []).forEach((c, i) => {
        const when = c?.at ? fmtDateTime(c.at) : "—";
        timelineRows.push([`Changed #${i + 1}`, when, `${c.from || "?"} → ${c.to || "?"}`]);
      });
      timelineRows.push(["Day Ended", endedStr, m.endedBy || "—"]);
      autoTable(doc, {
        head: [["Event", "When", "Actor(s)"]],
        body: timelineRows,
        startY: y + 4,
        theme: "grid",
        styles: { fontSize: 10 },
      });

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 28;
      doc.text("Orders", 14, y);
      autoTable(doc, {
   head: [["#", "Date", "Worker", "Payment", "Type", "Delivery (E£)", "Total (E£)", "Status", "Reason"]],
   body: getSortedOrders().map((o) => [
  o.orderNo,
  fmtDateTime(o.date),
  o.worker,
  o.payment,
  o.orderType || "",
  (o.deliveryFee || 0).toFixed(2),
  o.total.toFixed(2),
  o.voided ? (o.restockedAt ? "Cancelled" : "Returned") : (o.done ? "Done" : "Not done"),
  o.voided ? (o.voidReason || "") : "",
]),
   startY: y + 4,
   styles: { fontSize: 9 },
 });

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      doc.text("Totals (excluding canceled/returned)", 14, y);

     const totalsBody = [
        ["Revenue (Shift, excl. delivery)", totals.revenueTotal.toFixed(2)],
        ["Delivery Fees (not in revenue)", totals.deliveryFeesTotal.toFixed(2)],
        ["Purchases (Shift)", totals.purchasesTotal.toFixed(2)],
        ["Expenses (Shift)", totals.expensesTotal.toFixed(2)],
        [
          "Margin",
          totals.margin.toFixed(2),
        ],
      ];
      for (const p of Object.keys(totals.byPay))
        totalsBody.push([
          `By Payment — ${p} (items only)`,
          (totals.byPay[p] || 0).toFixed(2),
        ]);
      for (const t of Object.keys(totals.byType))
        totalsBody.push([
          `By Order Type — ${t} (items only)`,
          (totals.byType[t] || 0).toFixed(2),
        ]);

     autoTable(doc, {
        head: [["Metric", "Amount (E£)"]],
        body: totalsBody,
        startY: y + 4,
        theme: "grid",
        styles: { fontSize: 10 },
      });

      if (profitTimeline.length) {
        y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
        doc.text("Profit Timeline", 14, y);
        autoTable(doc, {
          head: [["Date", "Revenue", "Purchases", "Expenses", "Net", "Margin %"]],
          body: profitTimeline.map((row) => [
            row.date,
            row.revenue.toFixed(2),
            row.purchasesCost.toFixed(2),
            row.expenseCost.toFixed(2),
            row.net.toFixed(2),
            `${row.marginPct.toFixed(2)}%`,
          ]),
          startY: y + 4,
          theme: "grid",
          styles: { fontSize: 10 },
        });
      }

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      doc.text("Items — Times Ordered", 14, y);
      autoTable(doc, {
        head: [["Item", "Times", "Revenue (E£)"]],
        body: salesStats.items.map((r) => [r.name, String(r.count), r.revenue.toFixed(2)]),
        startY: y + 4,
        theme: "grid",
      });

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      doc.text("Extras — Times Ordered", 14, y);
      autoTable(doc, {
        head: [["Extra", "Times", "Revenue (E£)"]],
        body: salesStats.extras.map((r) => [r.name, String(r.count), r.revenue.toFixed(2)]),
        startY: y + 4,
        theme: "grid",
      });

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      doc.text("Inventory — Start vs Now", 14, y);

      if (!inventoryReportRows.length) {
        autoTable(doc, {
          head: [["Info"]],
          body: [["No inventory snapshot yet. Lock inventory to capture start-of-day."]],
          startY: y + 4,
          theme: "grid",
        });
      } else {
        autoTable(doc, {
          head: [["Item", "Unit", "Start Qty", "Current Qty", "Used"]],
          body: inventoryReportRows.map((r) => [
            r.name,
            r.unit,
            String(r.start),
            String(r.now),
            String(r.used),
          ]),
          startY: y + 4,
          theme: "grid",
        });
      }

      y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 40;
      doc.text("Expenses (Shift)", 14, y);
      autoTable(doc, {
        head: [["Name", "Unit", "Qty", "Unit Price (E£)", "Total (E£)", "Date", "Note"]],
        body: expenses.map((e) => [
          e.name,
          e.unit,
          String(e.qty),
          Number(e.unitPrice || 0).toFixed(2),
          (Number(e.qty || 0) * Number(e.unitPrice || 0)).toFixed(2),
          e.date ? fmtDateTime(e.date) : "",
          e.note || "",
        ]),
        startY: y + 4,
        theme: "grid",
        styles: { fontSize: 9 },
      });

      setDayMeta((d) => ({ ...d, lastReportAt: new Date() }));
      doc.save("tux_shift_report.pdf");
      if (!silent) alert("PDF downloaded.");
    } catch (err) {
      console.error(err);
      alert("Could not generate PDF. Try again (ensure pop-ups are allowed).");
    }
  };

  // ---------- helpers for Edit (reorder + consumption toggles) ----------
  const [openMenuConsId, setOpenMenuConsId] = useState(null);
  const [openExtraConsId, setOpenExtraConsId] = useState(null);
  const moveByIndex = (arr, idx, dir) => {
    const ni = idx + dir;
    if (ni < 0 || ni >= arr.length) return arr;
    const copy = [...arr];
    const [it] = copy.splice(idx, 1);
    copy.splice(ni, 0, it);
    return copy;
  };
  const moveMenuUp = (id) =>
    setMenu((arr) => {
      const idx = arr.findIndex((x) => x.id === id);
      if (idx < 0) return arr;
      return moveByIndex(arr, idx, -1);
    });
  const moveMenuDown = (id) =>
    setMenu((arr) => {
      const idx = arr.findIndex((x) => x.id === id);
      if (idx < 0) return arr;
      return moveByIndex(arr, idx, +1);
    });
  const moveExtraUp = (id) =>
    setExtraList((arr) => {
      const idx = arr.findIndex((x) => x.id === id);
      if (idx < 0) return arr;
      return moveByIndex(arr, idx, -1);
    });
  const moveExtraDown = (id) =>
    setExtraList((arr) => {
      const idx = arr.findIndex((x) => x.id === id);
      if (idx < 0) return arr;
      return moveByIndex(arr, idx, +1);
    });
  

  const cardBorder = dark ? "#555" : "#ddd";
  const softBg = dark ? "#1e1e1e" : "#f5f5f5";
  const btnBorder = "#ccc";
  const containerStyle = {
    maxWidth: 1024,
    margin: "0 auto",
    padding: 16,
    background: dark ? "#121212" : "white",
    color: dark ? "#eee" : "black",
    minHeight: "100vh",
    transition: "background 0.2s ease, color 0.2s ease",
  };

const handleTabClick = (key) => {
  if (key === "admin") {
    if (!adminUnlocked) {
      const ok = !!promptAdminAndPin(); // uses your existing Admin PINs (1..6)
      if (!ok) return;                  // stay on current tab if PIN fails/cancelled
      setAdminUnlocked(true);
    }
  }
  setActiveTab(key);
};

const handleAdminSubTabClick = (sub) => {
  setAdminSubTab(sub); // no PIN checks here anymore
};



  const bankBalance = useMemo(() => {
    return bankTx.reduce((sum, t) => {
      const a = Number(t.amount || 0);
      if (t.type === "deposit" || t.type === "init" || t.type === "adjustUp") return sum + a;
      if (t.type === "withdraw" || t.type === "adjustDown") return sum - a;
      return sum;
    }, 0);
  }, [bankTx]);
  // Money formatter for Purchases KPI & tables
const currency = (v) => `E£${Number(v || 0).toFixed(2)}`;

// Date -> YYYY-MM-DD for Purchases tables
// Date -> dd/mm/yy for Purchases tables
const prettyDate = (d) => fmtDate(d);


     // === ADD BELOW: Purchases PDF report =================================
const generatePurchasesPDF = () => {
  try {
    const doc = new jsPDF();
    const [start, end] = getPeriodRange(purchaseFilter, dayMeta, purchaseDay, purchaseMonth, undefined);
    const title = `TUX — Purchases Report (${purchaseFilter.toUpperCase()})`;
    doc.text(title, 14, 12);

    const periodStr =
      `${start.toLocaleDateString()} → ${end.toLocaleDateString()}`;

    // Build filtered rows just like the UI
    const within = (purchases || []).filter((p) => {
      const d = p?.date instanceof Date ? p.date : new Date(p?.date);
      return isWithin(d, start, end);
    });
    const rows = purchaseCatFilterId
      ? within.filter((p) => p.categoryId === purchaseCatFilterId)
      : within;

    const totalAll = rows.reduce(
      (s, p) => s + Number(p.qty || 0) * Number(p.unitPrice || 0),
      0
    );

    // Header table
    autoTable(doc, {
      head: [["Period", "Filter", "Total (E£)"]],
      body: [[periodStr,
        purchaseCatFilterId
          ? (purchaseCategories.find(c=>c.id===purchaseCatFilterId)?.name || "(unknown)")
          : "All categories",
        totalAll.toFixed(2)]],
      startY: 18,
      theme: "grid",
      styles: { fontSize: 10 },
    });

    // Category totals
    const catMap = new Map();
    for (const p of rows) {
      const amt = Number(p.qty || 0) * Number(p.unitPrice || 0);
      const k = p.categoryId || "";
      catMap.set(k, (catMap.get(k) || 0) + amt);
    }

    let y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : 30;
    doc.text("Totals by Category", 14, y);
    const catBody = Array.from(catMap.entries())
      .map(([cid, amt]) => [
        purchaseCategories.find(c=>c.id===cid)?.name || "(unknown)",
        amt.toFixed(2),
      ])
      .sort((a,b) => Number(b[1]) - Number(a[1])); // desc by E£

    autoTable(doc, {
      head: [["Category", "Amount (E£)"]],
      body: catBody.length ? catBody : [["(no data)", "0.00"]],
      startY: y + 4,
      theme: "grid",
      styles: { fontSize: 10 },
    });

    // Full line items
    y = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : y + 36;
    doc.text("Line Items", 14, y);

    const lineBody = rows
      .slice()
      .sort((a, b) => +new Date(a.date) - +new Date(b.date))
      .map((p) => {
        const catName = purchaseCategories.find(c => c.id === p.categoryId)?.name || "-";
        const total = Number(p.qty || 0) * Number(p.unitPrice || 0);
        const d = p?.date instanceof Date ? p.date : new Date(p?.date);
        return [
          d.toLocaleDateString(),
          catName,
          p.itemName || "",
          String(p.unit || ""),
          Number(p.qty || 0).toString(),
          Number(p.unitPrice || 0).toFixed(2),
          total.toFixed(2),
        ];
      });

    autoTable(doc, {
      head: [["Date", "Category", "Item", "Unit", "Qty", "Unit Price", "Total (E£)"]],
      body: lineBody.length ? lineBody : [["—","—","—","—","0","0.00","0.00"]],
      startY: y + 4,
      theme: "grid",
      styles: { fontSize: 9 },
    });

    doc.save("tux_purchases_report.pdf");
    alert("Purchases PDF downloaded.");
  } catch (e) {
    console.error(e);
    alert("Could not generate Purchases PDF. Ensure pop-ups are allowed.");
  }
};


  /* --------------------------- UI --------------------------- */

  return (
    <div style={containerStyle}>
   {/* Header */}
<div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    gap: 8,
    flexWrap: "wrap",
  }}
>
  <h1 style={{ margin: 0 }}>🍔 TUX — Burger Truck POS</h1>

  {/* Right side: date/time + theme toggle */}
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <div style={{ fontSize: 12 }}>{localDateTime}
</div>
      {/* Low-stock alert button */}
     <button
      onClick={() => setShowLowStock(s => !s)}
      title={lowStockCount ? `${lowStockCount} item(s) low in stock` : "No low-stock items"}
      style={{
        position: "relative",
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${btnBorder}`,
        background: lowStockCount ? "#ffebee" : (dark ? "#2c2c2c" : "#f1f1f1"),
        color: lowStockCount ? "#b71c1c" : (dark ? "#fff" : "#000"),
        cursor: "pointer",
        fontWeight: 700,
      }}
    >
     🔔 Low Stock
    {lowStockCount > 0 && (
  <span
    style={{
      position: "absolute",
      top: -4,
      right: -4,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      padding: "0 4px",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#d32f2f",
      color: "#fff",
      fontSize: 10,
      fontWeight: 800,
      lineHeight: 1,
      border: "1.5px solid white",
    }}
  >
    {lowStockCount > 99 ? "99+" : lowStockCount}
  </span>
)}

    </button>

    <button
      onClick={() => {
        handleTabClick("board");
        setOrderBoardFilter("online");
      }}
      title={
        newOnlineOrderCount
          ? `${newOnlineOrderCount} new online order${newOnlineOrderCount === 1 ? "" : "s"}`
          : "No new online orders"
      }
      style={{
        position: "relative",
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${btnBorder}`,
        background: newOnlineOrderCount
          ? (dark ? "#1e3a5f" : "#e3f2fd")
          : dark
          ? "#2c2c2c"
          : "#f1f1f1",
        color: newOnlineOrderCount ? (dark ? "#bbdefb" : "#0d47a1") : dark ? "#fff" : "#000",
        cursor: "pointer",
        fontWeight: 700,
      }}
    >
      🌐 Online Orders
      {newOnlineOrderCount > 0 && (
        <span
          style={{
            position: "absolute",
            top: -4,
            right: -4,
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            padding: "0 4px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#1565c0",
            color: "#fff",
            fontSize: 10,
            fontWeight: 800,
            lineHeight: 1,
            border: "1.5px solid white",
          }}
        >
          {newOnlineOrderCount > 99 ? "99+" : newOnlineOrderCount}
        </span>
      )}
    </button>

    <button
      onClick={() => setDark((d) => !d)}
      title={dark ? "Switch to Light" : "Switch to Dark"}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        border: `1px solid ${btnBorder}`,
        background: dark ? "#2c2c2c" : "#f1f1f1",
        color: dark ? "#fff" : "#000",
        cursor: "pointer",
      }}
    >
      {dark ? "☀ Light" : "🌙 Dark"}
    </button>
  </div>
</div>




      {/* Shift Control Bar */}
<div
  style={{
    padding: 10,
    borderRadius: 6,
    background: softBg,
    marginBottom: 10,
    display: "flex",
    gap: 8,
    alignItems: "center",
    flexWrap: "wrap",
  }}
>
  {!dayMeta.startedAt ? (
    <>
      <span><b>Shift not started.</b></span>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input
          type="password"
          placeholder="PIN"
          value={signInPin}
          onChange={(e) => setSignInPin(e.target.value)}
          style={{ padding:6, border:`1px solid ${btnBorder}`, borderRadius:6, width:140 }}
        />
        <button
          onClick={() => { signInByPin(signInPin); setSignInPin(""); }}
          style={{ background:"#2e7d32", color:"#fff", border:"none", borderRadius:6, padding:"6px 10px", cursor:"pointer" }}
        >
          Sign in
        </button>
      </div>
      <small style={{ opacity:.8 }}>First sign-in starts the shift automatically.</small>
    </>
  ) : (
    <>
      <span>
        Started by <b>{dayMeta.startedBy || "-"}</b> at <b>{fmtDate(dayMeta.startedAt)}</b>
      </span>

      <div style={{ marginLeft: 8 }}>
        <b>On duty:</b>{" "}
        {activeWorkers.length ? activeWorkers.join(", ") : "—"}
      </div>

      {/* Sign-in */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input
          type="password"
          placeholder="PIN to sign in"
          value={signInPin}
          onChange={(e) => setSignInPin(e.target.value)}
          style={{ padding:6, border:`1px solid ${btnBorder}`, borderRadius:6, width:140 }}
        />
        <button
          onClick={() => { signInByPin(signInPin); setSignInPin(""); }}
          style={{ background:"#1976d2", color:"#fff", border:"none", borderRadius:6, padding:"6px 10px", cursor:"pointer" }}
        >
          Sign in
        </button>
      </div>

      {/* Sign-out */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <input
          type="password"
          placeholder="PIN to sign out"
          value={signOutPin}
          onChange={(e) => setSignOutPin(e.target.value)}
          style={{ padding:6, border:`1px solid ${btnBorder}`, borderRadius:6, width:140 }}
        />
        <button
          onClick={() => { signOutByPin(signOutPin); setSignOutPin(""); }}
          style={{ background:"#455a64", color:"#fff", border:"none", borderRadius:6, padding:"6px 10px", cursor:"pointer" }}
        >
          Sign out
        </button>
      </div>

      <button
        onClick={endDay}
        style={{ background:"#e53935", color:"white", border:"none", borderRadius:6, padding:"6px 10px", cursor:"pointer" }}
      >
        End the Day (requires PDF)
      </button>
    </>
  )}
</div>

{/* Low-stock slide-down panel */}
{showLowStock && (
  <div
    style={{
      border: `1px solid ${cardBorder}`,
      borderRadius: 8,
      padding: 10,
      marginBottom: 10,
      background: softBg,
    }}
  >
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <h3 style={{ margin: 0 }}>Low Stock</h3>
      <span style={{ opacity: 0.7 }}>
        {lowStockCount ? `${lowStockCount} item(s)` : "No items are low in stock"}
      </span>
<div style={{ marginLeft: "auto" }}>
  <button
    onClick={() => setShowLowStock(false)}
    style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}` }}
  >
    Close
  </button>
  </div>

    </div>

    {lowStockCount > 0 && (
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
 <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Item</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Qty</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Unit</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Min</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Recommended Order</th>
            </tr>
          </thead>
          <tbody>
            {lowStockItems.map(it => {
              const suggestion = reorderSuggestionById.get(it.id);
              const recQty = suggestion ? Number(suggestion.recommendedQty || 0) : 0;
              return (
                <tr key={it.id}>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>{it.name}</td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                    {Number(it.qty || 0)}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>{it.unit}</td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                    {Number(it.minQty || 0)}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {suggestion ? (
                      <div>
                        <div style={{ fontWeight: 600 }}>
                          {recQty > 0
                            ? `${recQty.toFixed(1)} ${it.unit || ""}`
                            : "Monitor"}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {suggestion.rationale}
                        </div>
                      </div>
                    ) : (
                      <span style={{ opacity: 0.7 }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    )}
  </div>
)}

 {/* Tabs */}
<div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
  {[
    ["orders", "Orders"],
    ["board", "Orders Board"],
    ["expenses", "Expenses"],
    ["usage", "Inventory Usage"],
     ["reconcile","Reconcile"],
    ["admin", "Admin"], // <-- new consolidated tab
  ].map(([key, label]) => (
    <button
      key={key}
      onClick={() => handleTabClick(key)}
      style={{
        padding: "8px 12px",
        borderRadius: 6,
        border: `1px solid ${btnBorder}`,
        background: activeTab === key ? "#ffd54f" : dark ? "#333" : "#eee",
        color: dark ? "#fff" : "#000",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  ))}
</div>
{activeTab === "admin" && (
  <div style={{ display: "flex", gap: 8, margin: "0 0 12px", flexWrap: "wrap" }}>
    {[
      ["inventory", "Inventory"],
      ["purchases", "Purchases"],
      ["cogs", "COGS"],
      ["bank", "Bank"],
      ["workerlog", "Worker Log"],
      ["contacts", "Customer Contacts"],
      ["reports", "Reports"],
      ["edit", "Edit"],
      ["settings", "Settings"],
    ].map(([key, label]) => (
      <button
        key={key}
        onClick={() => handleAdminSubTabClick(key)}
        style={{
          padding: "6px 10px",
          borderRadius: 6,
          border: `1px solid ${btnBorder}`,
          background: adminSubTab === key ? "#fff59d" : (dark ? "#2c2c2c" : "#f1f1f1"),
          color: dark ? "#fff" : "#000",
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    ))}

    {/* push to the right */}
    <div style={{ marginLeft: "auto" }}>
      <button
        onClick={() => { setAdminUnlocked(false); setActiveTab("orders"); }} // optional: kick out of Admin
        style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}` }}
      >
        Lock Admin
      </button>
    </div>
  </div>
)}
{/* ───────────────────────────────── COGS TAB ───────────────────────────────── */}
{activeTab === "admin" && adminSubTab === "cogs" && (
  <div style={{ display: "grid", gap: 14 }}>

    {/* ── Target Margin Price Helper (Menu + Extras) ───────────────────── */}
    <div
      style={{
        border: `1px solid ${cardBorder}`,
        borderRadius: 12,
        padding: 16,
        background: dark ? "#151515" : "#fafafa",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Target Margin Price Helper</h3>

      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "1fr 1fr",
          alignItems: "start",
        }}
      >
        {/* Left: one select for both Menu and Extras + current stats */}
        <div>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>Menu item</div>
          <select
            value={cogsKey}
            onChange={(e) => setCogsKey(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${btnBorder}`,
              background: dark ? "#1f1f1f" : "#fff",
              color: dark ? "#eee" : "#000",
            }}
          >
           <optgroup label="Menu">
              {menu.map(def => {
                const cogs = computeCOGSForItemDef(def, invById, cogsCostContext);
                return (
                  <option key={`m-${def.id}`} value={`m-${def.id}`}>
                    {`${def.name} — COGS E£${cogs.toFixed(2)} • Price E£${Number(def.price||0).toFixed(2)}`}
                  </option>
                );
              })}
            </optgroup>␊
            <optgroup label="Extras">
              {extraList.map(def => {
                const cogs = computeCOGSForItemDef(def, invById, cogsCostContext);
                return (
                  <option key={`e-${def.id}`} value={`e-${def.id}`}>
                    {`${def.name} — COGS E£${cogs.toFixed(2)} • Price E£${Number(def.price||0).toFixed(2)}`}
                  </option>
                );
              })}
            </optgroup>
          </select>

          {/* Current stats for selection */}
          {selectedCogsRow && (() => {
            const price = Number(selectedCogsRow._price ?? selectedCogsRow.price ?? 0);
            const breakdown = selectedCogsRow._costBreakdown || computeCostBreakdown(selectedCogsRow, invById, cogsCostContext);
            const cogs = Number(selectedCogsRow._cogs ?? breakdown.total ?? computeCOGSForItemDef(selectedCogsRow, invById, cogsCostContext));
            const marginPct = selectedCogsRow._marginPct ?? (price > 0 ? ((price - cogs) / price) * 100 : 0);
            const targetPct = Number(selectedCogsRow._targetMarginPct || targetMarginPct * 100);
            const money = (v) => `E£${Number(v || 0).toFixed(2)}`;
            const ingredients = Object.entries(selectedCogsRow.uses || {}).map(([invId, qty]) => {
              const inv = invById[invId] || {};
              const unitCost = Number(inv.costPerUnit || 0);
              const quantity = Number(qty || 0);
              return {
                id: invId,
                name: inv.name || invId,
                quantity,
                unit: inv.unit || "",
                unitCost,
                totalCost: unitCost * quantity,
              };
            });
            const overheadRows = [
              { key: "labor", label: "Labor", value: breakdown.labor },
              { key: "electricity", label: "Electricity", value: breakdown.electricity },
              { key: "gas", label: "Gas", value: breakdown.gas },
              { key: "water", label: "Water", value: breakdown.water },
            ].filter((row) => row.value && Math.abs(row.value) > 0.001);
            const equipmentUsage = Object.entries(selectedCogsRow.equipmentMinutes || {})
              .map(([eqId, minutes]) => ({
                id: eqId,
                name: equipmentById[eqId]?.name || eqId,
                minutes: Number(minutes || 0),
              }))
              .filter((row) => row.minutes && Math.abs(row.minutes) > 0.001);
            const chartPoints = marginTrend;
            return (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 10,
                  background: dark ? "rgba(255,255,255,0.06)" : "#f0f0f0",
                  display: "grid",
                  gap: 12,
                }}
              >
                <div style={{ display: "grid", gap: 4 }}>
                  <div>Current price: <b>{money(price)}</b></div>
                  <div>COGS: <b>{money(cogs)}</b></div>
                  <div>Current margin: <b>{marginPct.toFixed(1)}%</b> (target {targetPct.toFixed(1)}%)</div>
               </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Ingredient cost breakdown</div>
                  {ingredients.length ? (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: "left", padding: 4, borderBottom: `1px solid ${cardBorder}` }}>Ingredient</th>
                            <th style={{ textAlign: "right", padding: 4, borderBottom: `1px solid ${cardBorder}` }}>Qty</th>
                            <th style={{ textAlign: "left", padding: 4, borderBottom: `1px solid ${cardBorder}` }}>Unit</th>
                            <th style={{ textAlign: "right", padding: 4, borderBottom: `1px solid ${cardBorder}` }}>Cost/unit</th>
                            <th style={{ textAlign: "right", padding: 4, borderBottom: `1px solid ${cardBorder}` }}>Total cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ingredients.map((ing) => (
                            <tr key={ing.id}>
                              <td style={{ padding: 4, borderBottom: `1px solid ${cardBorder}` }}>{ing.name}</td>
                              <td style={{ padding: 4, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>{ing.quantity.toFixed(2)}</td>
                              <td style={{ padding: 4, borderBottom: `1px solid ${cardBorder}` }}>{ing.unit}</td>
                              <td style={{ padding: 4, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>{money(ing.unitCost)}</td>
                              <td style={{ padding: 4, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>{money(ing.totalCost)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>No ingredients linked yet. Build the recipe in Inventory to see the breakdown.</div>
              )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Overhead per item</div>
                  {overheadRows.length ? (
                    <div style={{ display: "grid", gap: 4 }}>
                      {overheadRows.map((row) => (
                        <div
                          key={row.key}
                          style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
                        >
                          <span>{row.label}</span>
                          <span>{money(row.value)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>No labor or utility data yet.</div>
                  )}
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    Prep time: {Number(selectedCogsRow.prepMinutes || 0).toFixed(1)} min
                  </div>
                  {equipmentUsage.length > 0 && (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      <div style={{ opacity: 0.7 }}>Equipment minutes</div>
                      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                        {equipmentUsage.map((eq) => (
                          <li key={eq.id} style={{ listStyle: "disc" }}>
                            {eq.name}: {eq.minutes.toFixed(1)} min
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>Margin trend (last {chartPoints.length} day{chartPoints.length === 1 ? "" : "s"})</div>
                  {chartPoints.length ? (
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, minHeight: 120 }}>
                      {chartPoints.map((point) => {
                        const height = Math.max(4, Math.min(100, Math.round(Math.abs(point.marginPct))));
                        const barColor = point.marginPct + 0.0001 >= targetPct ? "#2e7d32" : "#c62828";
                        const label = (() => {
                          const d = new Date(point.day);
                          return Number.isNaN(+d)
                            ? point.day
                            : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
                        })();
                        return (
                          <div key={point.day} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                            <div style={{ height: 100, width: 18, display: "flex", alignItems: "flex-end" }}>
                              <div
                                style={{
                                  width: "100%",
                                  height: `${height}%`,
                                  background: barColor,
                                  borderRadius: 4,
                                }}
                                title={`${label}: ${point.marginPct.toFixed(1)}%`}
                              />
                            </div>
                            <div style={{ fontSize: 11 }}>{label}</div>
                            <div style={{ fontSize: 10, opacity: 0.7 }}>{point.marginPct.toFixed(0)}%</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, opacity: 0.7 }}>No orders yet for this item.</div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Right: margin slider + suggested price + apply */}
        <div>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>Target margin %</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 24px", gap: 12, alignItems: "center" }}>
            <input
              type="range"
              min={0}
              max={95}
              step={1}
              value={Math.round(targetMarginPct * 100)}
              onChange={(e) =>
                setTargetMarginPct(Math.max(0, Math.min(95, Number(e.target.value))) / 100)
              }
              style={{ width: "100%" }}
            />
            <input
              type="number"
              min={0}
              max={95}
              step={1}
              value={Math.round(targetMarginPct * 100)}
              onChange={(e) =>
                setTargetMarginPct(Math.max(0, Math.min(95, Number(e.target.value))) / 100)
              }
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#1f1f1f" : "#fff",
                color: dark ? "#eee" : "#000",
                textAlign: "center",
                fontWeight: 600,
              }}
            />
            <div style={{ opacity: 0.7, textAlign: "left" }}>%</div>
          </div>

               {selectedCogsRow && (() => {
const cogs = Number(
              selectedCogsRow._cogs ??
              computeCOGSForItemDef(selectedCogsRow, invById, cogsCostContext)
            );            const safeM = Math.min(selectedCogsRow.targetMarginPctOverride ?? targetMarginPct, 0.95);
            const suggested = safeM >= 1
              ? Number(selectedCogsRow._price || selectedCogsRow.price || 0)
              : Math.max(0, Math.round(cogs / (1 - safeM)));
            const targetLabel = Math.round((selectedCogsRow.targetMarginPctOverride ?? targetMarginPct) * 100);
            const money = (v) => `E£${Number(v || 0).toFixed(2)}`;
            return (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  borderRadius: 10,
                  background: dark ? "rgba(255,255,255,0.06)" : "#f0f0f0",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div>Suggested price (target {targetLabel}% margin): <b>{money(suggested)}</b></div>
                <button
                  onClick={() => updateRowPrice(selectedCogsRow, suggested, { confirm: true })}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "none",
                    background: "#2e7d32",
                    color: "#fff",
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  Apply to item
                </button>
              </div>
            );
          })()}
        </div>
     </div>

      {/* ── Overhead inputs for labor & utilities ─────────────────────── */}
      <div
        style={{
          marginTop: 18,
          border: `1px solid ${cardBorder}`,
          borderRadius: 12,
          padding: 16,
          background: dark ? "#151515" : "#fafafa",
          display: "grid",
          gap: 16,
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>COGS Overhead Builder</h3>
          <p style={{ margin: "6px 0 0", opacity: 0.75, fontSize: 13 }}>
            Enter your latest utility bills, labor productivity, and equipment usage to fold operational overhead into
            every menu item.
          </p>
        </div>

        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
          {[
            ["electricity", "Electricity"],
            ["gas", "Gas"],
            ["water", "Water"],
          ].map(([key, label]) => {
            const bill = utilityBills?.[key] || { amount: 0, units: 0 };
            const config = UTILITY_UNIT_LABELS[key];
            const rate = utilityRates?.[key] || 0;
            return (
              <div
                key={key}
                style={{
                  border: `1px solid ${cardBorder}`,
                  borderRadius: 10,
                  padding: 12,
                  background: dark ? "rgba(255,255,255,0.04)" : "#fff",
                  display: "grid",
                  gap: 8,
                }}
              >
                <div style={{ fontWeight: 600 }}>{label} bill</div>
                <label style={{ fontSize: 12, opacity: 0.75 }}>{config.amount}</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={Number(bill.amount || 0)}
                  onChange={(e) => handleUtilityBillChange(key, "amount", e.target.value)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: `1px solid ${btnBorder}`,
                    background: dark ? "#1f1f1f" : "#fff",
                    color: dark ? "#eee" : "#000",
                  }}
                />
                <label style={{ fontSize: 12, opacity: 0.75 }}>{config.units}</label>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={Number(bill.units || 0)}
                  onChange={(e) => handleUtilityBillChange(key, "units", e.target.value)}
                  style={{
                    padding: "6px 8px",
                    borderRadius: 8,
                    border: `1px solid ${btnBorder}`,
                    background: dark ? "#1f1f1f" : "#fff",
                    color: dark ? "#eee" : "#000",
                  }}
                />
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {rate > 0
                    ? `Cost rate: E£${rate.toFixed(4)} ${config.per}`
                    : "Add bill amount and usage to derive the rate."}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            border: `1px solid ${cardBorder}`,
            borderRadius: 10,
            padding: 12,
            background: dark ? "rgba(255,255,255,0.04)" : "#fff",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontWeight: 600 }}>Labor productivity</div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Total payout (E£)</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={Number(laborProfile?.payout || 0)}
                onChange={(e) =>
                  setLaborProfile((prev) => ({ ...prev, payout: Math.max(0, Number(e.target.value || 0)) }))
                }
                style={{
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: `1px solid ${btnBorder}`,
                  background: dark ? "#1f1f1f" : "#fff",
                  color: dark ? "#eee" : "#000",
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, opacity: 0.75 }}>Productive hours</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={Number(laborProfile?.productiveHours || 0)}
                onChange={(e) =>
                  setLaborProfile((prev) => ({
                    ...prev,
                    productiveHours: Math.max(0, Number(e.target.value || 0)),
                  }))
                }
                style={{
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: `1px solid ${btnBorder}`,
                  background: dark ? "#1f1f1f" : "#fff",
                  color: dark ? "#eee" : "#000",
                }}
              />
            </label>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            {laborCostPerMinute > 0
              ? `Derived labor cost: E£${(laborCostPerMinute * 60).toFixed(2)} per hour (E£${laborCostPerMinute.toFixed(
                  4
                )} per minute)`
              : "Enter payout and productive hours to derive a labor cost per minute."}
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${cardBorder}`, paddingTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <h4 style={{ margin: 0 }}>Equipment</h4>
            <button
              onClick={addEquipment}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#2c2c2c" : "#fff",
                color: dark ? "#fff" : "#000",
                cursor: "pointer",
              }}
            >
              + Add equipment
            </button>
          </div>
          {equipmentList.length ? (
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Name</th>
                    <th style={{ textAlign: "right", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Electric kW</th>
                    <th style={{ textAlign: "right", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Gas m³/hr</th>
                    <th style={{ textAlign: "right", padding: 6, borderBottom: `1px solid ${cardBorder}` }}>Water L/min</th>
                    <th style={{ padding: 6, borderBottom: `1px solid ${cardBorder}` }} />
                  </tr>
                </thead>
                <tbody>
                  {equipmentList.map((eq) => (
                    <tr key={eq.id}>
                      <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}` }}>
                        <input
                          type="text"
                          value={eq.name || ""}
                          onChange={(e) => updateEquipmentField(eq.id, "name", e.target.value)}
                          placeholder="Equipment name"
                          style={{
                            width: "100%",
                            padding: "6px 8px",
                            borderRadius: 6,
                            border: `1px solid ${btnBorder}`,
                            background: dark ? "#1f1f1f" : "#fff",
                            color: dark ? "#eee" : "#000",
                          }}
                        />
                      </td>
                      <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={Number(eq.electricKw || 0)}
                          onChange={(e) => updateEquipmentField(eq.id, "electricKw", e.target.value)}
                          style={{ width: 100, textAlign: "right" }}
                        />
                      </td>
                      <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={Number(eq.gasM3PerHour || 0)}
                          onChange={(e) => updateEquipmentField(eq.id, "gasM3PerHour", e.target.value)}
                          style={{ width: 100, textAlign: "right" }}
                        />
                      </td>
                      <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={Number(eq.waterLPerMin || 0)}
                          onChange={(e) => updateEquipmentField(eq.id, "waterLPerMin", e.target.value)}
                          style={{ width: 100, textAlign: "right" }}
                        />
                      </td>
                      <td style={{ padding: 6, borderBottom: `1px solid ${cardBorder}`, textAlign: "center" }}>
                        <button
                          onClick={() => removeEquipment(eq.id)}
                          style={{
                            padding: "4px 8px",
                            borderRadius: 6,
                            border: `1px solid ${btnBorder}`,
                            background: dark ? "#2c2c2c" : "#fff",
                            color: dark ? "#fff" : "#000",
                            cursor: "pointer",
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              Add equipment with their energy and water usage to allocate utility costs.
            </div>
          )}
        </div>

        <div style={{ borderTop: `1px solid ${cardBorder}`, paddingTop: 12 }}>
          <h4 style={{ margin: "0 0 6px" }}>Prep &amp; equipment minutes per item</h4>
          <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
            Minutes entered here multiply with the labor and utility rates above to build a fully-loaded COGS for each
            recipe.
          </p>
          <div style={{ display: "grid", gap: 16, marginTop: 12, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            <div>
              <h5 style={{ margin: "0 0 6px" }}>Menu</h5>
              {renderPrepTable("menu", menu, "No menu items yet.")}
            </div>
            <div>
              <h5 style={{ margin: "0 0 6px" }}>Extras</h5>
              {renderPrepTable("extra", extraList, "No extras yet.")}
            </div>
          </div>
        </div>
      </div>

      {/* Single items list (Menu + Extras) under helper */}
      <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
        {cogsSummaryMetrics.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {cogsSummaryMetrics.map((metric) => (
              <div
                key={metric.label}
                style={{
                  flex: "1 1 160px",
                  minWidth: 160,
                  border: `1px solid ${cardBorder}`,
                  borderRadius: 10,
                  padding: 12,
                  background: dark ? "rgba(255,255,255,0.04)" : "#fff",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.7 }}>{metric.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{metric.value}</div>
                {metric.hint && <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>{metric.hint}</div>}
              </div>
            ))}
          </div>
        )}

        {missingCostRows.length > 0 && (
          <div
            style={{
              border: `1px solid ${dark ? "rgba(255,193,7,0.4)" : "#ffecb3"}`,
              background: dark ? "rgba(255,193,7,0.1)" : "#fff8e1",
              color: dark ? "#ffecb3" : "#8d6e63",
              padding: 12,
              borderRadius: 10,
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div>
              ⚠️ {missingCostRows.length} item{missingCostRows.length === 1 ? "" : "s"} have ingredients without cost/unit values. Update inventory costs to unlock accurate margins.
            </div>
            <button
              onClick={() => {
                const el = document.getElementById("inventory-costs-section");
                if (el) el.scrollIntoView({ behavior: "smooth" });
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#2c2c2c" : "#fff",
                color: dark ? "#fff" : "#000",
                cursor: "pointer",
              }}
            >
              Go to Inventory Costs
            </button>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <div style={{ fontSize: 13, opacity: 0.75, flex: "1 1 240px", minWidth: 200 }}>{marginSummary}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={showLowMarginOnly}
                onChange={(e) => setShowLowMarginOnly(e.target.checked)}
              />
              Below target
            </label>
            <select
              value={cogsTypeFilter}
              onChange={(e) => setCogsTypeFilter(e.target.value)}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#1f1f1f" : "#fff",
                color: dark ? "#eee" : "#000",
              }}
            >
              <option value="all">All items</option>
              <option value="menu">Menu only</option>
              <option value="extra">Extras only</option>
            </select>
            <input
              type="search"
              value={cogsSearch}
              onChange={(e) => setCogsSearch(e.target.value)}
              placeholder="Search name"
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#1f1f1f" : "#fff",
                color: dark ? "#eee" : "#000",
                minWidth: 160,
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <select
                value={cogsSort.key}
                onChange={(e) => setCogsSort((prev) => ({ ...prev, key: e.target.value }))}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: `1px solid ${btnBorder}`,
                  background: dark ? "#1f1f1f" : "#fff",
                  color: dark ? "#eee" : "#000",
                }}
              >
                <option value="margin">Sort by margin</option>
                <option value="gap">Sort by gap</option>
                <option value="price">Sort by price</option>
                <option value="cogs">Sort by COGS</option>
                <option value="name">Sort by name</option>
              </select>
              <button
                onClick={() => setCogsSort((prev) => ({ ...prev, dir: prev.dir === "asc" ? "desc" : "asc" }))}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${btnBorder}`,
                  background: dark ? "#2c2c2c" : "#f1f1f1",
                  color: dark ? "#fff" : "#000",
                  cursor: "pointer",
                }}
                title="Toggle sort direction"
              >
                {cogsSort.dir === "asc" ? "↑" : "↓"}
              </button>
            </div>
            <button
              onClick={handleExportCogsCsv}
              style={{
                padding: "6px 10px",
                borderRadius: 8,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#2c2c2c" : "#f1f1f1",
                color: dark ? "#fff" : "#000",
                cursor: "pointer",
              }}
            >
              Export CSV
            </button>
            <button
              onClick={handleApplyTargetMarginToLowItems}
              disabled={!cogsMarginData.below.length}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: "none",
                background: cogsMarginData.below.length ? "#ef5350" : dark ? "#3a3a3a" : "#d0d0d0",
                color: cogsMarginData.below.length ? "#fff" : dark ? "#777" : "#777",
                cursor: cogsMarginData.below.length ? "pointer" : "not-allowed",
                fontWeight: 600,
              }}
            >
              Fix low-margin prices
            </button>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 10, borderBottom: `1px solid ${cardBorder}` }}>Item</th>
                <th style={{ textAlign: "right", padding: 10, borderBottom: `1px solid ${cardBorder}` }}>COGS</th>
                <th style={{ textAlign: "right", padding: 10, borderBottom: `1px solid ${cardBorder}` }}>Price</th>
                <th style={{ textAlign: "right", padding: 10, borderBottom: `1px solid ${cardBorder}` }}>Margin %</th>
                <th style={{ textAlign: "right", padding: 10, borderBottom: `1px solid ${cardBorder}` }}>Gap to Target</th>
              </tr>
            </thead>
            <tbody>
              {sortedCogsRows.map((def) => {
                const warn = def._marginPct + 0.0001 < def._targetMarginPct;
                const warnStyles = warn
                  ? {
                      background: dark ? "rgba(220,38,38,0.24)" : "rgba(220,38,38,0.12)",
                      color: dark ? "#ffb4ab" : "#b91c1c",
                      fontWeight: 600,
                    }
                  : {};
                const money = (v) => `E£${Number(v || 0).toFixed(2)}`;
                const baseCellStyle = { padding: 10, borderBottom: `1px solid ${cardBorder}` };
                const gap = Number(def._marginGap || 0);
                const gapStyles = gap > 0
                  ? { color: dark ? "#ffb4ab" : "#c62828", fontWeight: 600 }
                  : gap < 0
                  ? { color: dark ? "#a5d6a7" : "#2e7d32", fontWeight: 600 }
                  : {};
                const draft = inlinePriceDrafts[def._k];
                return (
                  <tr key={def._k}>
                    <td style={{ ...baseCellStyle, ...warnStyles }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span>{def.name}</span>
                        {def._hasMissingCosts && (
                          <span title="Some ingredients are missing cost/unit" style={{ fontSize: 14 }}>⚠️</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...baseCellStyle, textAlign: "right", ...warnStyles }}>{money(def._cogs)}</td>
                    <td style={{ ...baseCellStyle, textAlign: "right", ...warnStyles }}>
                      <input
                        type="number"
                        value={draft ?? def._price}
                        onChange={(e) =>
                          setInlinePriceDrafts((prev) => ({ ...prev, [def._k]: e.target.value }))
                        }
                        onBlur={(e) => handleInlinePriceCommit(def, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            handleInlinePriceCommit(def, e.currentTarget.value);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setInlinePriceDrafts((prev) => {
                              const next = { ...prev };
                              delete next[def._k];
                              return next;
                            });
                            e.currentTarget.value = def._price;
                          }
                        }}
                        style={{
                          width: 90,
                          padding: "4px 6px",
                          borderRadius: 6,
                          border: `1px solid ${btnBorder}`,
                          background: dark ? "#1f1f1f" : "#fff",
                          color: dark ? "#eee" : "#000",
                          textAlign: "right",
                        }}
                      />
                    </td>
                    <td style={{ ...baseCellStyle, textAlign: "right", ...warnStyles }}>{def._marginPct.toFixed(1)}%</td>
                    <td style={{ ...baseCellStyle, textAlign: "right", ...gapStyles }}>{gap.toFixed(1)} pts</td>
                  </tr>
                );
              })}
              {sortedCogsRows.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 12, textAlign: "center", opacity: 0.7 }}>
                    No items match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    {/* ── Inventory Costs (edit Cost/Unit, with auto-sync toggle) ───────── */}
    <div
      id="inventory-costs-section"
      style={{
        border: `1px solid ${cardBorder}`,
        borderRadius: 10,
        padding: 12,
        background: dark ? "#151515" : "#fafafa",
      }}
    >
      <h3 style={{ marginTop: 0 }}>Inventory Costs (E£ / unit)</h3>
      <p style={{ margin: "4px 0 12px", opacity: 0.8 }}>
        Set the cost per inventory unit and the Min Level.
      </p>

      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          type="checkbox"
          checked={syncCostsFromPurchases}
          onChange={(e) => setSyncCostsFromPurchases(e.target.checked)}
        />
        Auto-sync Cost/Unit from Purchases
      </label>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left",  padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Item</th>
              <th style={{ textAlign: "left",  padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Unit</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Min Level</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Cost / Unit (E£)</th>
            </tr>
          </thead>
          <tbody>
            {inventory.map((it) => (
              <tr key={it.id}>
                <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>{it.name}</td>
                <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>{it.unit}</td>

                <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={Number(it.minQty || 0)}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value || 0));
                      setInventory((arr) => arr.map(x => x.id === it.id ? { ...x, minQty: v } : x));
                    }}
                    style={{ width: 120, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, textAlign: "right" }}
                  />
                </td>

                <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={Number(it.costPerUnit || 0)}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value || 0));
                      setInventory((arr) => arr.map((x) => (x.id === it.id ? { ...x, costPerUnit: v } : x)));
                    }}
                    style={{ width: 120, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, textAlign: "right" }}
                  />
                </td>
              </tr>
            ))}
            {inventory.length === 0 && (
              <tr>
                <td colSpan={4} style={{ padding: 8, opacity: 0.7 }}>
                  No inventory yet. Add items in <b>Admin → Inventory</b>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>

  </div>
)}




      {/* ORDERS */}
      {activeTab === "orders" && (
        <div>
          <h2>Select item</h2>

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 300 }}>
              <h3>Burgers & Items</h3>
              {/* TILE GRID (small icon-like cards) */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 10,
                }}
              >
                {menu.map((item) => {
                  const isSel = selectedBurger?.id === item.id;
                  const bg = item.color || (dark ? "#1e1e1e" : "#ffffff");
                  return (
                    <button
                      key={item.id}
                      onClick={() => setSelectedBurger(item)}
                      style={{
                        textAlign: "left",
                        padding: 12,
                        border: isSel ? "2px solid #1976d2" : `1px solid ${btnBorder}`,
                        borderRadius: 10,
                        background: bg,
                        color: dark ? "#eee" : "#000",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{item.name}</div>
                      <div>E£{item.price}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 300 }}>
              <h3>Extras</h3>
              {/* TILE GRID (multi-select) */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 10,
                }}
              >
                {extraList.map((ex) => {
                  const checked = !!selectedExtras.find((e) => e.id === ex.id);
                  const bg = ex.color || (dark ? "#1e1e1e" : "#ffffff");
                  return (
                    <button
                      key={ex.id}
                      onClick={() => toggleExtra(ex)}
                      style={{
                        textAlign: "left",
                        padding: 12,
                        border: checked ? "2px solid #1976d2" : `1px solid ${btnBorder}`,
                        borderRadius: 10,
                        background: bg,
                        color: dark ? "#eee" : "#000",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{ex.name}</div>
                      <div>E£{ex.price}</div>
                    </button>
                  );
                })}
              </div>

              {/* Qty + Add */}
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <strong>Qty:</strong>
                <button
                  onClick={() => setSelectedQty((q) => Math.max(1, Number(q || 1) - 1))}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${btnBorder}` }}
                >
                  –
                </button>
                <input
                  type="number"
                  value={selectedQty}
                  onChange={(e) => setSelectedQty(Math.max(1, Number(e.target.value || 1)))}
                  style={{ width: 70, textAlign: "center" }}
                />
                <button
                  onClick={() => setSelectedQty((q) => Math.max(1, Number(q || 1) + 1))}
                  style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${btnBorder}` }}
                >
                  +
                </button>

                <button
                  onClick={addToCart}
                  style={{
                    marginLeft: "auto",
                    padding: "10px 14px",
                    borderRadius: 6,
                    border: "none",
                    background: "#42a5f5",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  Add to cart
                </button>
              </div>
            </div>
          </div>

          {/* Cart */}
          <h3 style={{ marginTop: 16 }}>Cart</h3>
          {cart.length === 0 && <p>No items yet.</p>}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {cart.map((it, idx) => {
              const extrasSum = (it.extras || []).reduce(
                (t, e) => t + Number(e.price || 0),
                0
              );
              const lineTotal =
                (Number(it.price || 0) + extrasSum) * Number(it.qty || 1);
              return (
                <li
                  key={idx}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    border: `1px solid ${cardBorder}`,
                    borderRadius: 6,
                    padding: 8,
                    marginBottom: 6,
                    background: dark ? "#1a1a1a" : "transparent",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <strong>{it.name}</strong> — E£{it.price}
                    {it.extras?.length > 0 && (
                      <ul style={{ margin: "4px 0 0 16px", color: dark ? "#bbb" : "#555" }}>
                        {it.extras.map((e) => (
                          <li key={e.id}>+ {e.name} (E£{e.price})</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Qty stepper in cart */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={() => changeQty(idx, -1)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: `1px solid ${btnBorder}`,
                      }}
                    >
                      –
                    </button>
                    <input
                      type="number"
                      value={it.qty || 1}
                      onChange={(e) => setQty(idx, e.target.value)}
                      style={{ width: 60, textAlign: "center" }}
                    />
                    <button
                      onClick={() => changeQty(idx, +1)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: `1px solid ${btnBorder}`,
                      }}
                    >
                      +
                    </button>
                  </div>

                  <div style={{ minWidth: 120, textAlign: "right" }}>
                    <div>
                      <small>Line total</small>
                    </div>
                    <div>
                      <b>E£{lineTotal.toFixed(2)}</b>
                    </div>
                  </div>

                  <button
                    onClick={() => removeFromCart(idx)}
                    style={{
                      background: "#ef5350",
                      color: "white",
                      border: "none",
                      borderRadius: 6,
                      padding: "6px 10px",
                      cursor: "pointer",
                    }}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Notes */}
          <div style={{ margin: "8px 0 12px" }}>
            <label>
              <strong>Order notes:</strong>{" "}
              <input
                type="text"
                value={orderNote}
                placeholder="e.g., no pickles, extra spicy"
                onChange={(e) => setOrderNote(e.target.value)}
                style={{
                  width: 420,
                  maxWidth: "90%",
                  padding: "6px 8px",
                  borderRadius: 6,
                  border: `1px solid ${btnBorder}`,
                  background: dark ? "#1e1e1e" : "white",
                  color: dark ? "#eee" : "#000",
                }}
              />
            </label>
          </div>

          {/* Selection groups & Checkout */}
          <div style={{ display: "grid", gap: 12 }}>
            {/* Button groups row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8,
              }}
            >
           {/* Worker group (only on-duty) */}
<div
  style={{
    border: `1px solid ${btnBorder}`,
    borderRadius: 8,
    padding: 8,
    background: dark ? "#191919" : "#fafafa",
  }}
>
  <div style={{ fontWeight: 700, marginBottom: 6 }}>Worker</div>
  {!activeWorkers.length ? (
    <div style={{ opacity:.8 }}>No one is on duty. Ask a worker to sign in (Shift bar).</div>
  ) : (
    <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
      {activeWorkers.map((w) => (
        <button
          key={w}
          onClick={() => setWorker(w)}
          style={{
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${btnBorder}`,
            background: worker === w ? "#c8e6c9" : "#fff",
            cursor: "pointer",
          }}
        >
          {w}
        </button>
      ))}
    </div>
  )}
</div>


              {/* Payment group */}
              <div
                style={{
                  border: `1px solid ${btnBorder}`,
                  borderRadius: 8,
                  padding: 8,
                  background: dark ? "#191919" : "#fafafa",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Payment</div>
<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
  {paymentMethods.map((p) => (
    <button
      key={p}
      onClick={() => { setPayment(p); setSplitPay(false); }}
      style={{
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${btnBorder}`,
        background: !splitPay && payment === p ? "#c8e6c9" : "#fff",
        cursor: "pointer",
      }}
    >
      {p}
    </button>
  ))}
</div>

{/* Split toggle */}
<div style={{ marginTop: 8 }}>
  <label>
    <input
      type="checkbox"
      checked={splitPay}
      onChange={(e) => {
        const on = e.target.checked;
        setSplitPay(on);
        if (on) setPayment(""); // ignore single payment when split
      }}
    />{" "}
    Split into two methods
  </label>
</div>

{/* Split UI */}
{splitPay && (
  <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
    <div>
      <div style={{ marginBottom: 4 }}><b>Method A</b></div>
      <select
        value={payA}
        onChange={(e) => setPayA(e.target.value)}
        style={{ width: "100%", padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
      >
        <option value="">Select method</option>
        {paymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <input
        type="number"
        placeholder="Amount"
        value={amtA}
        onChange={(e) => setAmtA(Number(e.target.value || 0))}
        style={{ width: "100%", marginTop: 6 }}
      />
    </div>
    <div>
      <div style={{ marginBottom: 4 }}><b>Method B</b></div>
      <select
        value={payB}
        onChange={(e) => setPayB(e.target.value)}
        style={{ width: "100%", padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
      >
        <option value="">Select method</option>
        {paymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      <input
        type="number"
        placeholder="Amount"
        value={amtB}
        onChange={(e) => setAmtB(Number(e.target.value || 0))}
        style={{ width: "100%", marginTop: 6 }}
      />
    </div>
  </div>
)}

{/* Cash inputs */}
{!splitPay && payment === "Cash" && (
  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <label>
      Cash received:&nbsp;
      <input
        type="number"
        value={cashReceived}
        onChange={(e) => setCashReceived(Number(e.target.value || 0))}
        style={{ width: 140 }}
      />
    </label>
    <small style={{ opacity: 0.8 }}>
      Change:{" "}
      <b>
        E£
        {(
          Math.max(
            0,
            Number(cashReceived || 0) -
              (cart.reduce((s, b) => {
                const ex = (b.extras || []).reduce((t, e) => t + Number(e.price || 0), 0);
                return s + (Number(b.price || 0) + ex) * Number(b.qty || 1);
              }, 0) + (orderType === "Delivery" ? Number(deliveryFee || 0) : 0))
          ) || 0
        ).toFixed(2)}
      </b>
    </small>
  </div>
)}

{splitPay && (payA === "Cash" || payB === "Cash") && (
  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <label>
      Cash received (for cash part):&nbsp;
      <input
        type="number"
        value={cashReceivedSplit}
        onChange={(e) => setCashReceivedSplit(Number(e.target.value || 0))}
        style={{ width: 180 }}
      />
    </label>
    <small style={{ opacity: 0.8 }}>
      Change on cash part:{" "}
      <b>
        E£
        {(() => {
          const cashAmt = (payA === "Cash" ? amtA : 0) + (payB === "Cash" ? amtB : 0);
          return Math.max(0, Number(cashReceivedSplit || 0) - Number(cashAmt || 0)).toFixed(2);
        })()}
      </b>
    </small>
  </div>
)}

              </div>

              {/* Order type group */}
              <div
                style={{
                  border: `1px solid ${btnBorder}`,
                  borderRadius: 8,
                  padding: 8,
                  background: dark ? "#191919" : "#fafafa",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Order Type</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {orderTypes.map((t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setOrderType(t);
                        setDeliveryFee(t === "Delivery" ? (deliveryFee || defaultDeliveryFee) : 0);
                      }}
                      style={{
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: `1px solid ${btnBorder}`,
                        background: orderType === t ? "#c8e6c9" : "#fff",
                        cursor: "pointer",
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>

               {orderType === "Delivery" && (
  <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
    <div>
      <label>
        Delivery fee:&nbsp;
        <input
          type="number"
          value={deliveryFee}
          onChange={(e) => setDeliveryFee(Number(e.target.value || 0))}
          style={{ width: 120 }}
        />
      </label>
      <small style={{ opacity: 0.75 }}>
        &nbsp;(Default: E£{Number(defaultDeliveryFee || 0).toFixed(2)})
      </small>
    </div>
    <div>  {/* Zone auto-sets fee */}                                    {/* ⬅️ NEW */}
  <label>
    Zone:&nbsp;
    <select
      value={deliveryZoneId}
      onChange={(e) => {
        const zid = e.target.value;
        setDeliveryZoneId(zid);
        const z = deliveryZones.find(z => z.id === zid);
        if (z) setDeliveryFee(Number(z.fee || 0));
      }}
      style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    >
      <option value="">Select zone</option>
      {deliveryZones.map(z => <option key={z.id} value={z.id}>{z.name} — E£{Number(z.fee||0).toFixed(2)}</option>)}
    </select>
  </label>
</div>


  {/* NEW: Customer details (only for Delivery) */}
    {isVipDeliveryCustomer && (
      <div
        style={{
          padding: "8px 10px",
          borderRadius: 6,
          border: `1px solid ${btnBorder}`,
          background: "#fff4d6",
          fontWeight: 700,
          color: "#8a5700",
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span role="img" aria-label="VIP">
          ⭐
        </span>
        VIP Customer
      </div>
    )}
    <input
      type="text"
      placeholder="Customer name"
      value={deliveryName}
      onChange={(e) => setDeliveryName(e.target.value)}
      style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    />
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <span style={{ opacity: 0.8, fontWeight: 600 }}>+20</span>
      <input
        type="tel"
        list="phone-saved"
        inputMode="numeric"
        placeholder="Phone Number (10 digits)"
        maxLength={10}
        value={extractLocalPhoneDigits(deliveryPhone)}
        onChange={(e) => setDeliveryPhone(toCanonicalLocalPhone(e.target.value))}
        onKeyDown={(e) => {
          const ctrl = e.ctrlKey || e.metaKey;
          const allowed = [
            "Backspace",
            "Delete",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Tab",
          ];
          if (allowed.includes(e.key) || ctrl) return;
          if (!/^\d$/.test(e.key)) e.preventDefault();
        }}
        style={{ flex: 1, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
      />
    </div>
    <input
      type="text"
      placeholder="Address"
      value={deliveryAddress}
      onChange={(e) => setDeliveryAddress(e.target.value)}
      style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    />
  </div>
)}

                {orderType !== "Delivery" && (
                  <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                    <input
                      type="text"
                      placeholder="Customer name (optional)"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
                    />
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <span style={{ opacity: 0.8, fontWeight: 600 }}>+20</span>
                      <input
                        type="tel"
                        inputMode="numeric"
                        placeholder="Customer phone (10 digits)"
                        maxLength={10}
                        value={extractLocalPhoneDigits(customerPhone)}
                        onChange={(e) => setCustomerPhone(toCanonicalLocalPhone(e.target.value))}
                        onKeyDown={(e) => {
                          const ctrl = e.ctrlKey || e.metaKey;
                          const allowed = [
                            "Backspace",
                            "Delete",
                            "ArrowLeft",
                            "ArrowRight",
                            "Home",
                            "End",
                            "Tab",
                          ];
                          if (allowed.includes(e.key) || ctrl) return;
                          if (!/^\d$/.test(e.key)) e.preventDefault();
                        }}
                        style={{ flex: 1, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
                      />
                    </div>
                    {hasWhatsappNumberLength(customerPhone) && (
                      <small style={{ opacity: 0.7 }}>
                        WhatsApp will use {formatPhoneForDisplay(customerPhone)} for updates.
                      </small>
                    )}
                    <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={syncWhatsappReady}
                        onChange={(e) => setSyncWhatsappReady(e.target.checked)}
                        disabled={!hasWhatsappNumberLength(customerPhone)}
                      />
                      <span>Send ready message via WhatsApp when order is done</span>
                    </label>
                  </div>
                )}

              </div>
            </div>

            {/* Totals + Checkout row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                justifyContent: "space-between",
                flexWrap: "wrap",
              }}
            >
              <div>
                <strong>Order Total (incl. delivery):</strong>{" "}
                E£
                {(
                  cart.reduce((s, b) => {
                    const ex = (b.extras || []).reduce(
                      (t, e) => t + Number(e.price || 0),
                      0
                    );
                    return (
                      s + (Number(b.price || 0) + ex) * Number(b.qty || 1)
                    );
                  }, 0) +
                  (orderType === "Delivery"
                    ? Number(deliveryFee || 0)
                    : 0)
                ).toFixed(2)}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  onClick={checkout}
                  disabled={isCheckingOut}
                  style={{
                    background: isCheckingOut ? "#9e9e9e" : "#43a047",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    padding: "10px 14px",
                    cursor: isCheckingOut ? "not-allowed" : "pointer",
                    minWidth: 140,
                  }}
                >
                  {isCheckingOut ? "Processing..." : "Checkout"}
                </button>
                <small>
                  Next order #: <b>{nextOrderNo}</b>
                </small>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ORDERS BOARD */}
     {activeTab === "board" && (
        <div>
          <h2>Orders Board {realtimeOrders ? "(Live)" : ""}</h2>
          <div
            style={{
              display: "flex",
              gap: 8,
              margin: "8px 0 16px",
              flexWrap: "wrap",
            }}
          >
            {[
              ["onsite", "On-site orders"],
              ["online", "Online orders"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setOrderBoardFilter(key)}
                style={{
                  position: "relative",
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: `1px solid ${btnBorder}`,
                  background:
                    orderBoardFilter === key
                      ? dark
                        ? "#5d4037"
                        : "#fff59d"
                      : dark
                      ? "#2c2c2c"
                      : "#f1f1f1",
                  color: dark ? "#fff" : "#000",
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                {label}
                {key === "online" && newOnlineOrderCount > 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -4,
                      right: -4,
                      minWidth: 16,
                      height: 16,
                      borderRadius: 8,
                      padding: "0 4px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "#1565c0",
                      color: "#fff",
                      fontSize: 10,
                      fontWeight: 800,
                      lineHeight: 1,
                      border: "1.5px solid white",
                    }}
                  >
                    {newOnlineOrderCount > 99 ? "99+" : newOnlineOrderCount}
                  </span>
                )}
              </button>
            ))}
          </div>
          {orderBoardFilter === "online" ? (
            <>
              {onlineOrders.length === 0 ? (
                <p>No online orders yet.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0 }}>
                   {onlineOrders.map((o) => {
                    const statusKey = getOnlineOrderDedupeKey(o);
                    const isNew =
                      Number(o?.createdAtMs || 0) > Number(onlineViewCutoff || 0);
                    const placedAt = o?.date || o?.createdAt || new Date();
                    const statusEntry = statusKey
                      ? onlineOrderStatus[statusKey] || {}
                      : {};
                    const posOrder = findPosOrderForOnline(o);
                    const isIntegrated = !!posOrder;
                    const isProcessing =
                      !isIntegrated &&
                      (statusEntry.state === "importing" || statusEntry.state === "imported");
                    const isDone = posOrder?.done;
                    const isVoided = posOrder?.voided;
          const rawDeliveryZone = pickFirstTruthyKey(
                      o.raw?.deliveryZone,
                      o.raw?.delivery?.zone,
                      o.raw?.delivery?.zoneName,
                      o.raw?.delivery?.zone?.name,
                      o.raw?.delivery?.zone?.title,
                      o.raw?.delivery?.area,
                      o.deliveryZoneName,
                      o.deliveryZone,
                      o.delivery_zone,
                      o.zone
                    );
                    const zoneMatchId = pickFirstTruthyKey(
                      o.deliveryZoneId,
                      o.deliveryZone,
                      o.raw?.delivery?.zoneId,
                      o.raw?.delivery?.zone?.id,
                      o.raw?.delivery?.zone?.slug,
                      o.raw?.delivery?.zone?.code
                    );
                    const matchedZone = deliveryZones.find((z) => z.id === zoneMatchId);
                    const displayZoneName = pickFirstTruthyKey(
                      matchedZone?.name,
                      rawDeliveryZone,
                      o.deliveryZoneName,
                      o.deliveryZoneLabel,
                      o.deliveryZone,
                      o.delivery_zone,
                      o.zone,
                      o.deliveryZoneId
                    );
                    const displayZoneId = pickFirstTruthyKey(
                      o.deliveryZoneId,
                      o.deliveryZone,
                      o.delivery_zone,
                      o.raw?.delivery?.zoneId,
                      o.raw?.delivery?.zone?.id,
                      o.raw?.delivery?.zone?.slug,
                      o.raw?.delivery?.zone?.code,
                      matchedZone?.id
                    );
                    const deliveryZoneDisplay = displayZoneName
                      ? displayZoneId && displayZoneId !== displayZoneName
                        ? `${displayZoneName} (${displayZoneId})`
                        : displayZoneName
                      : displayZoneId || "";
                    return (
                      <li
                        key={o.id}
                        style={{
                          border: `1px solid ${cardBorder}`,
                          borderRadius: 6,
                          padding: 10,
                          marginBottom: 8,
                          background: dark ? "#1f2a44" : "#e3f2fd",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                             <strong>
                              Online #{o.displayOrderNo || o.orderNo} — E£
                              {Number(o.total || 0).toFixed(2)}
                            </strong>
                            {isNew && (
                              <span
                                style={{
                                  background: "#ffeb3b",
                                  color: "#1a237e",
                                  borderRadius: 4,
                                  padding: "2px 6px",
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                              >
                                NEW
                              </span>
                            )}
                          </div>
                          <span>{fmtDateTime(placedAt)}</span>
                        </div>
                         <div style={{ color: dark ? "#bbd0ff" : "#1a237e", marginTop: 4 }}>
                          Payment: {o.payment || "—"} • Type: {o.orderType || "—"} • Status: {" "}
                          {String(o.status || "pending")}
                          {Number(o.deliveryFee || 0) > 0 && (
                            <> • Delivery: E£{Number(o.deliveryFee || 0).toFixed(2)}</>
                          )}
                          {deliveryZoneDisplay && <> • Zone: {deliveryZoneDisplay}</>}
                        </div>
                        {(o.deliveryName || o.deliveryPhone || o.deliveryAddress) && (
                          <div style={{ marginTop: 4, color: dark ? "#ddd" : "#555" }}>
                            Customer: {o.deliveryName || "—"}
                            {o.deliveryPhone
                              ? ` (${formatPhoneForDisplay(o.deliveryPhone)})`
                              : ""}
                            {o.deliveryAddress ? ` • ${o.deliveryAddress}` : ""}
                          </div>
                        )}
                        {Array.isArray(o.cart) && o.cart.length > 0 && (
                          <ul style={{ marginTop: 8, marginBottom: 8 }}>
                            {o.cart.map((ci, idx) => {
                              const qty = Number(ci?.qty || ci?.quantity || 0) || 1;
                              const priceEach = Number(ci?.price || 0);
                              return (
                                <li key={ci.id || idx} style={{ marginLeft: 12 }}>
                                  • {ci.name || `Item ${idx + 1}`} × {qty} — E£
                                  {priceEach.toFixed(2)} each
                                  {Array.isArray(ci.extras) && ci.extras.length > 0 && (
                                    <ul
                                      style={{
                                        margin: "2px 0 6px 18px",
                                        color: dark ? "#bbb" : "#555",
                                      }}
                                    >
                                      {ci.extras.map((ex, exIdx) => {
                                        const extraPrice = Number(ex?.price || 0);
                                        return (
                                          <li key={ex.id || exIdx}>
                                            + {ex.name || "Extra"} (E£{extraPrice.toFixed(2)}) × {qty}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      {o.note && (
                          <div
                            style={{
                              marginTop: 4,
                              padding: "6px 8px",
                              borderRadius: 6,
                              background: dark ? "#273043" : "#fffde7",
                              color: dark ? "#f3e5f5" : "#5d4037",
                            }}
                          >
                            <strong>Note:</strong> {o.note}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                          <button
                            onClick={() => integrateOnlineOrder(o)}
                            disabled={isIntegrated || isProcessing}
                            style={{
                              background: isIntegrated ? "#9e9e9e" : "#6d4c41",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor: isIntegrated || isProcessing ? "not-allowed" : "pointer",
                            }}
                          >
                            Make
                          </button>
                          <button
                            onClick={() => markOnlineOrderDone(o)}
                            disabled={!isIntegrated || isDone || isVoided}
                            style={{
                              background: !isIntegrated || isDone || isVoided ? "#9e9e9e" : "#43a047",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor:
                                !isIntegrated || isDone || isVoided ? "not-allowed" : "pointer",
                            }}
                          >
                            Mark DONE (locks)
                          </button>
                          <button
                            onClick={() => printOnlineOrder(o)}
                            disabled={!isIntegrated || isVoided}
                            style={{
                              background: !isIntegrated || isVoided ? "#039be588" : "#039be5",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor: !isIntegrated || isVoided ? "not-allowed" : "pointer",
                            }}
                          >
                            Print
                          </button>
                          <button
                            onClick={() => voidOnlineOrderAndRestock(o)}
                            disabled={!isIntegrated || isDone || isVoided}
                            style={{
                              background:
                                !isIntegrated || isDone || isVoided ? "#ef9a9a" : "#c62828",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor:
                                !isIntegrated || isDone || isVoided ? "not-allowed" : "pointer",
                            }}
                          >
                            Cancel (restock)
                          </button>
                          <button
                            onClick={() => voidOnlineOrderToExpense(o)}
                            disabled={
                              !isIntegrated ||
                              isDone ||
                              isVoided ||
                              !isExpenseVoidEligible(posOrder?.orderType)
                            }
                            style={{
                              background:
                                !isIntegrated ||
                                isDone ||
                                isVoided ||
                                !isExpenseVoidEligible(posOrder?.orderType)
                                  ? "#ffb74d"
                                  : "#fb8c00",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor:
                                !isIntegrated ||
                                isDone ||
                                isVoided ||
                                !isExpenseVoidEligible(posOrder?.orderType)
                                  ? "not-allowed"
                                  : "pointer",
                            }}
                          >
                            Returned
                          </button>
                        </div>
      {(isProcessing || (!isIntegrated && (statusEntry.state === "done" || statusEntry.state === "voided"))) && (
                          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
                            {isProcessing && "Processing… waiting for POS sync."}
                            {!isIntegrated && statusEntry.state === "done" && (
                              <>Completed in POS (order #{statusEntry.posOrderNo || "?"})</>
                            )}
                            {!isIntegrated && statusEntry.state === "voided" && (
                              <>Cancelled in POS (order #{statusEntry.posOrderNo || "?"})</>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <>
              {orders.length === 0 && <p>No orders yet.</p>}
              <ul style={{ listStyle: "none", padding: 0 }}>
 {orders.map((o) => {
                  const rawDeliveryZone = pickFirstTruthyKey(
                    o.deliveryZoneName,
                    o.deliveryZone,
                    o.delivery_zone,
                    o.zone,
                    o.raw?.deliveryZone,
                    o.raw?.delivery?.zone,
                    o.raw?.delivery?.zoneName,
                    o.raw?.delivery?.zone?.name,
                    o.raw?.delivery?.zone?.title,
                    o.raw?.delivery?.area
                  );
                  const zoneMatchId = pickFirstTruthyKey(
                    o.deliveryZoneId,
                    o.deliveryZone,
                    o.raw?.delivery?.zoneId,
                    o.raw?.delivery?.zone?.id,
                    o.raw?.delivery?.zone?.slug,
                    o.raw?.delivery?.zone?.code
                  );
                  const matchedZone = deliveryZones.find((z) => z.id === zoneMatchId);
                  const displayZoneName = pickFirstTruthyKey(
                    matchedZone?.name,
                    rawDeliveryZone,
                    o.deliveryZoneName,
                    o.deliveryZone,
                    o.delivery_zone,
                    o.zone,
                    o.deliveryZoneId
                  );
                  const displayZoneId = pickFirstTruthyKey(
                    o.deliveryZoneId,
                    o.deliveryZone,
                    o.delivery_zone,
                    o.raw?.delivery?.zoneId,
                    o.raw?.delivery?.zone?.id,
                    o.raw?.delivery?.zone?.slug,
                    o.raw?.delivery?.zone?.code,
                    matchedZone?.id
                  );
                  const deliveryZoneDisplay = displayZoneName
                    ? displayZoneId && displayZoneId !== displayZoneName
                      ? `${displayZoneName} (${displayZoneId})`
                      : displayZoneName
                    : displayZoneId || "";
                  return (
                    <li
                      key={`${o.cloudId || "local"}_${o.orderNo}`}
                      style={{
                        border: `1px solid ${cardBorder}`,
                        borderRadius: 6,
                        padding: 10,
                        marginBottom: 8,
                        background: o.voided
                          ? dark
                            ? "#4a2b2b"
                            : "#ffebee"
                          : o.done
                          ? dark
                            ? "#14331a"
                            : "#e8f5e9"
                          : dark
                          ? "#333018"
                          : "#fffde7",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <strong>
                          Order #{o.orderNo} — E£{o.total.toFixed(2)}{" "}
                          {o.cloudId ? "☁" : ""}
                        </strong>
                        <span>{fmtDate(o.date)}</span>
                      </div>
                      <div style={{ color: dark ? "#ccc" : "#555", marginTop: 4 }}>
                        Worker: {o.worker} • Payment: {o.payment}
                        {Array.isArray(o.paymentParts) && o.paymentParts.length ? (
                          <>
                            (
                            {o.paymentParts
                              .map(
                                (p) => `${p.method}: E£${Number(p.amount || 0).toFixed(2)}`
                              )
                              .join(" + ")}
                            )
                          </>
                        ) : null}
                        {" "}• Type: {o.orderType || "-"}
                        {o.orderType === "Delivery" && (
                          <> • Delivery: E£{Number(o.deliveryFee || 0).toFixed(2)}</>
                        )}
                        {o.orderType === "Delivery" && deliveryZoneDisplay && (
                          <> • Zone: {deliveryZoneDisplay}</>
                        )}
                        {(o.deliveryName || o.deliveryPhone || o.deliveryAddress) && (
                          <>
                            {" "}• Customer: {o.deliveryName || "—"}
                            {o.deliveryPhone
                              ? ` (${formatPhoneForDisplay(o.deliveryPhone)})`
                              : ""}
                            {o.deliveryAddress ? ` • ${o.deliveryAddress}` : ""}
                          </>
                        )}
                        {o.notifyViaWhatsapp && (
                          <>
                            {" "}• WhatsApp:{" "}
                            {o.whatsappSentAt
                              ? `Sent ${fmtDateTime(o.whatsappSentAt)}`
                              : "Pending"}
                          </>
                        )}
                        {o.payment === "Cash" && o.cashReceived != null && (
                          <> • Cash: E£{o.cashReceived.toFixed(2)} • Change: E£{(o.changeDue || 0).toFixed(2)}</>
                        )}
                        {" "}• Status:{" "}
                        <strong>
                          {o.voided
                            ? o.restockedAt
                              ? "Cancelled"
                              : "Returned"
                            : o.done
                            ? "Done"
                            : "Not done"}
                        </strong>
                        {o.voided && (
                          <>
                            {o.restockedAt && (
                              <span> • Cancelled at: {fmtDate(o.restockedAt)}</span>
                            )}
                            {o.voidReason && <span> • Reason: {o.voidReason}</span>}
                          </>
                        )}
                      </div>

                      <ul style={{ marginTop: 8, marginBottom: 8 }}>
                        {o.cart.map((ci, idx) => (
                          <li key={idx} style={{ marginLeft: 12 }}>
                            • {ci.name} × {ci.qty || 1} — E£{ci.price} each
                            {ci.extras?.length > 0 && (
                              <ul
                                style={{
                                  margin: "2px 0 6px 18px",
                                  color: dark ? "#bbb" : "#555",
                                }}
                              >
                                {ci.extras.map((ex) => (
                                  <li key={ex.id}>
                                    + {ex.name} (E£{ex.price}) × {ci.qty || 1}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        ))}
                      </ul>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {!o.done && !o.voided && (
                          <button
                            onClick={() => markOrderDone(o.orderNo)}
                            style={{
                              background: "#43a047",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor: "pointer",
                            }}
                          >
                            Mark DONE (locks)
                          </button>
                        )}
                        {o.done && (
                          <button
                            disabled
                            style={{
                              background: "#9e9e9e",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor: "not-allowed",
                            }}
                          >
                            DONE (locked)
                          </button>
                        )}

                        {/* Single Print button (removed all other print options) */}
                        <button
                          onClick={() =>
                            printReceiptHTML(o, Number(preferredPaperWidthMm) || 80, "Customer")
                          }
                          disabled={o.voided}
                          style={{
                            background: o.voided ? "#039be588" : "#039be5",
                            color: "white",
                            border: "none",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: "pointer",
                          }}
                        >
                          Print
                        </button>

                        <button
                          onClick={() => voidOrderAndRestock(o.orderNo)}
                          disabled={o.done || o.voided}
                          style={{
                            background: o.done || o.voided ? "#ef9a9a" : "#c62828",
                            color: "white",
                            border: "none",
                            borderRadius: 6,
                            padding: "6px 10px",
                            cursor: o.done || o.voided ? "not-allowed" : "pointer",
                          }}
                        >
                          Cancel (restock)
                        </button>

                        {!o.done && !o.voided && isExpenseVoidEligible(o.orderType) && (
                          <button
                            onClick={() => voidOrderToExpense(o.orderNo)}
                            style={{
                              background: "#fb8c00",
                              color: "white",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 10px",
                              cursor: "pointer",
                            }}
                          >
                            Returned
                          </button>
                        )}

                    </div>
                  </li>
                );
              })}
              </ul>
            </>
          )}
        </div>
      )}


      {/* INVENTORY */}
     {activeTab === "admin" && adminSubTab === "inventory" && (
        <div>
          <h2>Inventory</h2>

          <div
            style={{
              padding: 10,
              borderRadius: 6,
              background: inventoryLocked
                ? dark
                  ? "#2b3a2b"
                  : "#e8f5e9"
                : dark
                ? "#332d1e"
                : "#fffde7",
              marginBottom: 10,
            }}
          >
            {inventoryLocked ? (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <strong>Locked:</strong>
                <span>
                  Start-of-day captured{" "}
                  {inventoryLockedAt ? `at ${fmtDate(inventoryLockedAt)}` : "" }

                  . Editing disabled until <b>End the Day</b> or admin unlock.
                </span>
                <button
                  onClick={unlockInventoryWithPin}
                  style={{
                    background: "#8e24aa",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    padding: "6px 10px",
                    cursor: "pointer",
                  }}
                >
                  Unlock Inventory (Admin PIN)
                </button>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span>Set your quantities, then:</span>
                <button
                  onClick={lockInventoryForDay}
                  style={{
                    background: "#2e7d32",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    padding: "6px 10px",
                    cursor: "pointer",
                  }}
                >
                  Lock Inventory (start of day)
                </button>
              </div>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>
                    Item
                  </th>
                  <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>
                    Unit
                  </th>
                  <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>
                    Qty
                  </th>
                  <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {inventory.map((it) => (
                  <tr key={it.id}>
                    <td style={{ padding: 6 }}>{it.name}</td>
                    <td style={{ padding: 6 }}>{it.unit}</td>
                    <td style={{ padding: 6 }}>
                      <input
                        type="number"
                        value={it.qty}
                        disabled={inventoryLocked}
                        onChange={(e) => {
                          const v = Math.max(0, Number(e.target.value || 0));
                          setInventory((inv) =>
                            inv.map((x) =>
                              x.id === it.id ? { ...x, qty: v } : x
                            )
                          );
                        }}
                        style={{ width: 120 }}
                      />
                    </td>
                    <td style={{ padding: 6 }}>
                      <button
                        disabled={inventoryLocked}
                        onClick={() =>
                          setInventory((inv) => inv.filter((x) => x.id !== it.id))
                        }
                        style={{
                          background: inventoryLocked ? "#9e9e9e" : "#c62828",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: inventoryLocked ? "not-allowed" : "pointer",
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Add new inventory item */}
            {!inventoryLocked && (
              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="text"
                  placeholder="Item name"
                  value={newInvName}
                  onChange={(e) => setNewInvName(e.target.value)}
                  style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
                />
                <input
                  type="text"
                  placeholder="Unit (g, pcs...)"
                  value={newInvUnit}
                  onChange={(e) => setNewInvUnit(e.target.value)}
                  style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 120 }}
                />
                <input
                  type="number"
                  placeholder="Qty"
                  value={newInvQty}
                  onChange={(e) => setNewInvQty(Number(e.target.value || 0))}
                  style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 120 }}
                />
                <button
                  onClick={() => {
                    const name = String(newInvName || "").trim();
                    const unit = String(newInvUnit || "").trim() || "pcs";
                    const qty = Math.max(0, Number(newInvQty || 0));
                    if (!name) return alert("Name required.");
                    const id =
                            name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") ||
                             `inv_${Date.now()}`;
                    if (inventory.some((x) => x.id === id)) {
                      return alert("Item with same id exists, use a different name.");
                    }
                    setInventory((inv) => [...inv, { id, name, unit, qty }]);
                    setNewInvName("");
                    setNewInvUnit("");
                    setNewInvQty(0);
                  }}
                  style={{
                    background: "#1976d2",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 12px",
                    cursor: "pointer",
                  }}
                >
                  Add item
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* EXPENSES */}
      {activeTab === "expenses" && (
        <div>
          <h2>Expenses (Shift)</h2>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <input
              type="text"
              placeholder="Name"
              value={newExpName}
              onChange={(e) => setNewExpName(e.target.value)}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
            />
            <input
              type="text"
              placeholder="Unit"
              value={newExpUnit}
              onChange={(e) => setNewExpUnit(e.target.value)}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 120 }}
            />
            <input
              type="number"
              placeholder="Qty"
              value={newExpQty}
              onChange={(e) => setNewExpQty(Number(e.target.value || 0))}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 120 }}
            />
            <input
              type="number"
              placeholder="Unit Price (E£)"
              value={newExpUnitPrice}
              onChange={(e) => setNewExpUnitPrice(Number(e.target.value || 0))}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 160 }}
            />
            <input
              type="text"
              placeholder="Note"
              value={newExpNote}
              onChange={(e) => setNewExpNote(e.target.value)}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 220 }}
            />
            <button
              onClick={() => {
                const name = String(newExpName || "").trim();
                if (!name) return alert("Expense name required.");
                const row = {
                  id: `exp_${Date.now()}`,
                  name,
                  unit: newExpUnit || "pcs",
                  qty: Math.max(0, Number(newExpQty || 0)),
                  unitPrice: Math.max(0, Number(newExpUnitPrice || 0)),
                  note: newExpNote || "",
                  date: new Date(),
                };
                setExpenses((arr) => [row, ...arr]);
                setNewExpName("");
                setNewExpUnit("pcs");
                setNewExpQty(1);
                setNewExpUnitPrice(0);
                setNewExpNote("");
              }}
              style={{
                background: "#2e7d32",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                padding: "8px 12px",
                cursor: "pointer",
              }}
            >
              Add Expense
            </button>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Name</th>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Unit</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Qty</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Unit Price</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Total</th>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Date</th>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Note</th>
                <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id}>
                  <td style={{ padding: 6 }}>{e.name}</td>
                  <td style={{ padding: 6 }}>{e.unit}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>{e.qty}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>E£{Number(e.unitPrice || 0).toFixed(2)}</td>
                  <td style={{ padding: 6, textAlign: "right" }}>
                    E£{(Number(e.qty || 0) * Number(e.unitPrice || 0)).toFixed(2)}
                  </td>
                  <td style={{ padding: 6 }}>{e.date ? formatDateDDMMYY(e.date) : ""}</td>
                  <td style={{ padding: 6 }}>{e.note}</td>
                  <td style={{ padding: 6 }}>
                  <button
  onClick={() => {
    const locked = !!(e?.locked || e?.source === "order_return" || e?.orderNo != null);
    if (locked) {
      alert("This expense is linked to a returned order and cannot be removed.");
      return;
    }
    removeExpense(e.id);
  }}
  disabled={!!(e?.locked || e?.source === "order_return" || e?.orderNo != null)}
  title={
    (e?.locked || e?.source === "order_return" || e?.orderNo != null)
      ? "Linked to returned order — cannot remove"
      : "Remove"
  }
  style={{
    background: "#c62828",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 10px",
    cursor:
      (e?.locked || e?.source === "order_return" || e?.orderNo != null)
        ? "not-allowed"
        : "pointer",
  }}
>
  Remove
</button>

                  </td>
                </tr>
              ))}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 8, opacity: 0.8 }}>
                    No expenses yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

{/* ───────────────────────── INVENTORY USAGE (top-level) ───────────────────────── */}
{activeTab === "usage" && (
  <div style={{ display:"grid", gap:14 }}>
    <h2>Inventory Usage</h2>
 <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={resetUsageViewAdmin}
        style={{
          background: "#ef5350",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
          fontWeight: 700,
        }}
        title="Admin PIN required"
      >
        Reset Usage
      </button>
    </div>
    {/* Filter row */}
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
      <button
        onClick={() => setUsageFilter("week")}
        style={{ padding:"6px 10px", borderRadius:6, border:`1px solid ${btnBorder}`,
                 background: usageFilter==="week" ? "#ffd54f" : (dark ? "#2c2c2c" : "#f1f1f1"), cursor:"pointer" }}
      >WEEK</button>
      <button
        onClick={() => setUsageFilter("month")}
        style={{ padding:"6px 10px", borderRadius:6, border:`1px solid ${btnBorder}`,
                 background: usageFilter==="month" ? "#ffd54f" : (dark ? "#2c2c2c" : "#f1f1f1"), cursor:"pointer" }}
      >MONTH</button>

{usageFilter === "week" && (
  <>
    <label><b>Pick a day:</b></label>
    <input
      type="date"
      value={usageWeekDate}
      onChange={(e)=>setUsageWeekDate(e.target.value)}
      style={{ padding:6, borderRadius:6, border:`1px solid ${btnBorder}` }}
    />
    <small style={{ opacity:.75, marginLeft:8 }}>(Week starts Sunday)</small>
  </>
)}


      {usageFilter === "month" && (
        <>
          <label><b>Pick month:</b></label>
          <input
            type="month"
            value={usageMonth}
            onChange={(e)=>setUsageMonth(e.target.value)}
            style={{ padding:6, borderRadius:6, border:`1px solid ${btnBorder}` }}
          />
        </>
      )}

      <div style={{ marginLeft:"auto", opacity:.8 }}>
        {(() => {
          const {start,end} = usageFilter==="week"
            ? getWeekRange(usageWeekDate)
            : getMonthRange(usageMonth);
          return <>Period: {start.toLocaleDateString()} → {end.toLocaleDateString()}</>;
        })()}
      </div>
    </div>

    {/* Summary */}
    <div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:12, background: dark ? "#151515" : "#fafafa" }}>
      <h3 style={{ marginTop:0 }}>Summary (by inventory item)</h3>

{(() => {
  // 1) Period
  const { start, end } = (usageFilter === "week")
    ? getWeekRange(usageWeekDate)
    : getMonthRange(usageMonth);

  // 2) Helpers (local—won’t clash with your globals)
  const normalize = (s) => String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  const invById = new Map((inventory || []).map(it => [it.id, it]));
  const invByNorm = new Map((inventory || []).map(it => [normalize(it.name), it]));
  // NEW: categories index for matching via selected category
const cats =
  (typeof categoriesForGrid !== "undefined" && Array.isArray(categoriesForGrid))
    ? categoriesForGrid
    : [];
const catById = new Map(cats.map(c => [c.id, c]));

  const add = (map, key, qty) => map.set(key, Number(map.get(key) || 0) + Number(qty || 0));
  const safeDate = (d) => {
    if (!d) return null;
    if (Object.prototype.toString.call(d) === "[object Date]") return d;
    const s = String(d);
    // Avoid TZ drift on YYYY-MM-DD by anchoring to midnight local
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + "T00:00:00");
    return new Date(s);
  };
  const factor = (fromU, toU) => {
    const f = Number(convertUnit ? convertUnit(1, fromU, toU) : 0);
    if (!isFinite(f) || f <= 0) {
      const A = String(fromU || "").toLowerCase().trim();
      const B = String(toU || "").toLowerCase().trim();
      if (A && A === B) return 1; // identical units ⇒ 1:1
      return 0; // unknown conversion
    }
    return f;
  };
  const qtyToInv = (qty, fromU, invU) => {
    const f = factor(fromU, invU);
    return f > 0 ? Number(qty || 0) * f : 0;
  };
const matchInv = (row) => {
  if (!row) return null;

  // 0) explicit link on the row (kept working if you ever set it)
  if (row.invId && invById.get(row.invId)) return invById.get(row.invId);

  // 1) use the chosen Category FIRST (this makes itemName irrelevant)
  if (row.categoryId && catById.has(row.categoryId)) {
    const cat = catById.get(row.categoryId);

    // 1a) if category is explicitly linked to an inventory item
    if (cat && cat.invId && invById.get(cat.invId)) return invById.get(cat.invId);

    // 1b) otherwise, try by category name
    const byCatName = invByNorm.get(normalize(cat.name));
    if (byCatName) return byCatName;
  }

  // 2) fallback: try the typed itemName (unchanged behavior)
  const norm = normalize(row.itemName);
  if (invByNorm.get(norm)) return invByNorm.get(norm);

  // 3) final fallback: loose partial match
  return (inventory || []).find(it => {
    const a = normalize(it.name);
    return a.includes(norm) || norm.includes(a);
  }) || null;
};

  const money = (v) => `E£${Number(v || 0).toFixed(2)}`;

  // 3) ORDERS → Used (same as before)
  const menuById = mapById(menu || []);
  const exById   = mapById(extraList || []);
  const allOrders = [...historicalOrders, ...orders];
const ordersInPeriod = (allOrders || []).filter(o => {
    if (o?.voided) return false;
    const d = safeDate(o?.date);
    return d && d >= start && d <= end;
  });

  const used = new Map(); // invId -> qty used
  for (const o of ordersInPeriod) {
    for (const line of (o.cart || [])) {
      const lineQty = Number(line.qty || 1);

      // main item usage
      const defItem = findDefByLine(line, menu || []) || (line?.id != null ? menuById.get(line.id) : null);
      if (defItem?.uses) {
        for (const [invId, perUnit] of Object.entries(defItem.uses)) {
          add(used, invId, Number(perUnit || 0) * lineQty);
        }
      }
      // extras usage
      for (const ex of (line.extras || [])) {
        const defEx = findDefByLine(ex, extraList || []) || (ex?.id != null ? exById.get(ex.id) : null);
        if (defEx?.uses) {
          for (const [invId, perUnit] of Object.entries(defEx.uses)) {
            add(used, invId, Number(perUnit || 0) * lineQty);
          }
        }
      }
    }
  }

const allPurchases = [...historicalPurchases, ...purchases];
const purchasesInPeriod = (allPurchases || []).filter(p => {
    const d = safeDate(p?.date);
    return d && d >= start && d <= end;
  });

  const purchased = new Map();   // invId -> qty purchased in inventory units
  const accum = new Map();       // invId -> { qtyInv, costTotal } for avg cost
  for (const row of purchasesInPeriod) {
    const inv = matchInv(row);
    if (!inv) continue;
    const qInv = qtyToInv(Number(row.qty || 0), row.unit, inv.unit);
    if (!qInv) continue;

    // record purchased qty
    add(purchased, inv.id, qInv);

    // price per inventory unit = unitPrice / factor(1 unit purchase → inv unit)
    const f1 = factor(row.unit, inv.unit);
    const pricePerInv = f1 > 0 ? Number(row.unitPrice || 0) / f1 : 0;

    const prev = accum.get(inv.id) || { qtyInv: 0, costTotal: 0 };
    prev.qtyInv += qInv;
    prev.costTotal += qInv * pricePerInv;
    accum.set(inv.id, prev);
  }

  // avg cost map (period-weighted); fallback to inv.costPerUnit if no purchases
  const avgCost = new Map();
  for (const [invId, { qtyInv, costTotal }] of accum.entries()) {
    avgCost.set(invId, qtyInv > 0 ? costTotal / qtyInv : 0);
  }

  // 5) Build table rows
  const rows = (inventory || []).map(inv => {
    const usedQty      = Number(used.get(inv.id) || 0);
    const purchasedQty = Number(purchased.get(inv.id) || 0);
    const net          = purchasedQty - usedQty;
    const endQty       = Number(inv.qty || 0);
    const unitCost     = avgCost.has(inv.id)
      ? Number(avgCost.get(inv.id) || 0)
      : Number(inv.costPerUnit || 0);
    const usedCost     = usedQty * unitCost;
    return {
      id: inv.id,
      name: inv.name,
      unit: inv.unit,
      usedQty,
      purchasedQty,
      net,
      endQty,
      usedCost,
    };
  });

  const totalUsedQty    = rows.reduce((s, r) => s + Number(r.usedQty || 0), 0);
  const totalUsedCost   = rows.reduce((s, r) => s + Number(r.usedCost || 0), 0);
  const itemsTracked    = rows.filter(r => (r.usedQty > 0) || (r.purchasedQty > 0)).length;

  // 6) SVG Bar chart with axes/grid
  const maxY = Math.max(1, ...rows.map(r => Math.max(r.endQty, r.usedQty)));
  const margin = { top: 12, right: 18, bottom: 60, left: 46 };
  const barW = 28;
  const gap = 18;
  const innerW = rows.length * (barW * 2 + gap); // two bars per item
  const innerH = 220;
  const W = innerW + margin.left + margin.right;
  const H = innerH + margin.top + margin.bottom;
  const yScale = (v) => innerH - (v / maxY) * innerH;
  const ticks = 5;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => (i * maxY) / ticks);

  return (
    <>
      {/* KPI cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 10,
          marginTop: 4,
          marginBottom: 10,
        }}
      >
        <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${cardBorder}`, background: dark ? "#1e1e1e" : "#fff" }}>
          <div style={{ fontSize: 12, opacity: .8 }}>Total Used (mixed units)</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{Number(totalUsedQty).toFixed(2)}</div>
        </div>
        <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${cardBorder}`, background: dark ? "#1e1e1e" : "#fff" }}>
          <div style={{ fontSize: 12, opacity: .8 }}>Estimated Cost (avg/unit)</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{money(totalUsedCost)}</div>
        </div>
        <div style={{ padding: 12, borderRadius: 10, border: `1px solid ${cardBorder}`, background: dark ? "#1e1e1e" : "#fff" }}>
          <div style={{ fontSize: 12, opacity: .8 }}>Items Tracked</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{itemsTracked}</div>
        </div>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left",  padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Item</th>
              <th style={{ textAlign: "left",  padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Unit</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Used</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Purchased</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Net (P−U)</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>End Qty</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Used Cost (E£)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 8, opacity: .7 }}>No inventory items.</td></tr>
            ) : rows.map(r => (
              <tr key={r.id}>
                <td style={{ padding: 8 }}>{r.name}</td>
                <td style={{ padding: 8 }}>{r.unit}</td>
                <td style={{ padding: 8, textAlign: "right" }}>{Number(r.usedQty || 0).toFixed(2)}</td>
                <td style={{ padding: 8, textAlign: "right" }}>{Number(r.purchasedQty || 0).toFixed(2)}</td>
                <td style={{ padding: 8, textAlign: "right" }}>{Number(r.net || 0).toFixed(2)}</td>
                <td style={{ padding: 8, textAlign: "right" }}>{Number(r.endQty || 0).toFixed(2)}</td>
                <td style={{ padding: 8, textAlign: "right", fontWeight: 700 }}>{money(r.usedCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={6} style={{ padding: 8, textAlign: "right", fontWeight: 900 }}>Total Used Cost</td>
              <td style={{ padding: 8, textAlign: "right", fontWeight: 900 }}>{money(totalUsedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* SVG Grid Chart with axes */}
      <div
        style={{
          marginTop: 14,
          padding: 12,
          border: `1px solid ${cardBorder}`,
          borderRadius: 12,
          background: dark ? "#101010" : "#fff",
          overflowX: "auto",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>End Qty vs Used (with axes)</div>
        <svg width={W} height={H} role="img" aria-label="Inventory end vs used">
          {/* background */}
          <rect x="0" y="0" width={W} height={H} fill={dark ? "#101010" : "#ffffff"} />
          <g transform={`translate(${margin.left},${margin.top})`}>
            {/* Y grid + ticks */}
            {yTicks.map((t, i) => {
              const y = yScale(t);
              return (
                <g key={`grid-${i}`}>
                  <line
                    x1={0} y1={y} x2={innerW} y2={y}
                    stroke={dark ? "#333" : "#e5e5e5"}
                    strokeDasharray="4 4"
                  />
                  <text x={-8} y={y} textAnchor="end" dominantBaseline="middle" style={{ fontSize: 10, fill: dark ? "#bbb" : "#666" }}>
                    {Number(t).toFixed(0)}
                  </text>
                </g>
              );
            })}

            {/* X axis line */}
            <line x1={0} y1={innerH} x2={innerW} y2={innerH} stroke={dark ? "#555" : "#888"} />

            {/* Bars */}
            {rows.map((r, i) => {
              const groupX = i * (barW * 2 + gap);
              const endH = innerH - yScale(r.endQty);
              const usedH = innerH - yScale(r.usedQty);
              return (
                <g key={r.id} transform={`translate(${groupX},0)`}>
                 <rect
  x={0}
  y={yScale(r.endQty)}
  width={barW}
  height={endH}
  rx={4}
  fill={dark ? "#4caf50" : "#81c784"}
>
  <title>{`${r.name} — End Qty: ${Number(r.endQty || 0).toFixed(2)} ${r.unit}`}</title>
</rect>

<rect
  x={barW + 6}
  y={yScale(r.usedQty)}
  width={barW}
  height={usedH}
  rx={4}
  fill={dark ? "#039be5" : "#64b5f6"}
>
  <title>{`${r.name} — Used: ${Number(r.usedQty || 0).toFixed(2)} ${r.unit}`}</title>
</rect>

                  <text
                    x={barW / 2}
                    y={innerH + 14}
                    textAnchor="middle"
                    style={{ fontSize: 9, fill: dark ? "#bbb" : "#666" }}
                    transform={`translate(0,0)`}
                  >
                    {i + 1}
                  </text>
                </g>
              );
            })}

            {/* X labels index guide below axis */}
            {rows.map((r, i) => {
              const groupX = i * (barW * 2 + gap);
              return (
                <text
                  key={`lbl-${r.id}`}
                  x={groupX + barW}
                  y={innerH + 36}
                  textAnchor="middle"
                  style={{ fontSize: 9, fill: dark ? "#bbb" : "#666" }}
                >
                  {r.name}
                </text>
              );
            })}
          </g>

          {/* Axis titles */}
          <text
            x={margin.left / 2}
            y={margin.top - 4}
            textAnchor="middle"
            style={{ fontSize: 10, fill: dark ? "#bbb" : "#666" }}
          >
            Qty
          </text>
        </svg>

        {/* Legend */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: dark ? "#4caf50" : "#81c784", display: "inline-block" }} />
          <small>End Qty</small>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: dark ? "#039be5" : "#64b5f6", display: "inline-block", marginLeft: 12 }} />
          <small>Used</small>
        </div>
      </div>
    </>
  );
})()}


    </div>
  </div>
)}


{/* ───────────────────────── Customer Contacts TAB ───────────────────────── */}
{activeTab === "admin" && adminSubTab === "contacts" && (
  <div style={{ display: "grid", gap: 16 }}>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: 12,
      }}
    >
      <div
        style={{
          padding: 16,
          borderRadius: 12,
          border: `1px solid ${cardBorder}`,
          background: dark ? "#1f1f1f" : "#fff",
        }}
      >
        <div style={{ fontWeight: 600, opacity: 0.85 }}>Tracked Contacts</div>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
          {customerRows.length}
        </div>
        <div style={{ opacity: 0.75, marginTop: 4 }}>
          {totalTrackedOrders} total orders
        </div>
      </div>
      <div
        style={{
          padding: 16,
          borderRadius: 12,
          border: `1px solid ${cardBorder}`,
          background: dark ? "#1f1f1f" : "#fff",
        }}
      >
        <div style={{ fontWeight: 600, opacity: 0.85 }}>Lifetime Spend</div>
        <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
          {currency(totalContactSpend)}
        </div>
        <div style={{ opacity: 0.75, marginTop: 4 }}>
          Across all recorded delivery orders
        </div>
      </div>
      <div
        style={{
          padding: 16,
          borderRadius: 12,
          border: `1px solid ${cardBorder}`,
          background: dark ? "#1f1f1f" : "#fff",
        }}
      >
        <div style={{ fontWeight: 600, opacity: 0.85 }}>Top Contact</div>
        {topSpenders.length ? (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>
              {topSpenders[0].displayName}
            </div>
            <div style={{ opacity: 0.75 }}>
              {currency(topSpenders[0].totalSpend)} • {topSpenders[0].orderCount} order(s)
            </div>
            <div style={{ marginTop: 8, opacity: 0.65 }}>
              Zone: {topSpenders[0].zoneName || "—"}
            </div>
          </>
        ) : (
          <div style={{ opacity: 0.65, marginTop: 10 }}>No contacts yet.</div>
        )}
      </div>
      <div
        style={{
          padding: 16,
          borderRadius: 12,
          border: `1px solid ${cardBorder}`,
          background: dark ? "#1f1f1f" : "#fff",
        }}
      >
        <div style={{ fontWeight: 600, opacity: 0.85 }}>Top 5 Customers</div>
        {topSpenders.length ? (
          <ol style={{ margin: "8px 0 0", paddingLeft: 18, lineHeight: 1.5 }}>
            {topSpenders.map((row) => (
              <li key={row.id} style={{ marginBottom: 4 }}>
                <span style={{ fontWeight: 600 }}>{row.displayName}</span>{" "}
                <span style={{ opacity: 0.75 }}>{currency(row.totalSpend)}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div style={{ opacity: 0.65, marginTop: 10 }}>Waiting for first order.</div>
        )}
      </div>
    </div>

 <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
      }}
    >
      <input
        type="search"
        value={customerSearch}
        onChange={(e) => setCustomerSearch(e.target.value)}
        placeholder="Search by name, phone, address, or zone"
        style={{
          flex: "1 1 260px",
          minWidth: 200,
          padding: "8px 10px",
          borderRadius: 8,
          border: `1px solid ${btnBorder}`,
          background: dark ? "#111" : "#fff",
          color: dark ? "#eee" : "#000",
        }}
      />
      <div style={{ fontWeight: 600, opacity: 0.75 }}>
        Showing {filteredCustomerRows.length} contact(s)
      </div>
      <button
        onClick={resetAllCustomerContacts}
        title="Delete all saved customer contacts"
        style={{
          padding: "8px 12px",
          borderRadius: 8,
          border: `1px solid ${btnBorder}`,
          background: dark ? "#5c1f1f" : "#d32f2f",
          color: "#fff",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Delete All Contacts
      </button>
    </div>

    <div
      style={{
        border: `1px solid ${cardBorder}`,
        borderRadius: 12,
        background: dark ? "#1a1a1a" : "#fff",
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Contacts by Zone</div>
      {customerZoneSummary.length ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 320 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                  Zone
                </th>
                <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                  Contacts
                </th>
                <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                  Lifetime Spend
                </th>
              </tr>
            </thead>
            <tbody>
              {customerZoneSummary.map((row) => (
                <tr key={row.zoneName}>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.zoneName}
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: `1px solid ${cardBorder}` }}>
                    {row.count}
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: `1px solid ${cardBorder}` }}>
                    {currency(row.totalSpend)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ opacity: 0.7 }}>No contacts recorded yet.</div>
      )}
    </div>

    <div
      style={{
        border: `1px solid ${cardBorder}`,
        borderRadius: 12,
        background: dark ? "#1a1a1a" : "#fff",
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Customer Directory</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Name</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Phone</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Zone</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Tags</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Last Order</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Total Spend</th>
              <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Orders</th>
              <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Address</th>
            </tr>
          </thead>
          <tbody>
            {filteredCustomerRows.length ? (
              filteredCustomerRows.map((row) => (
                <tr key={row.id}>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    <div style={{ fontWeight: 600 }}>{row.displayName}</div>
                    {row.firstOrderAt && (
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        First order: {fmtDate(row.firstOrderAt)}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.phone || "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.zoneName || "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.tags && row.tags.length ? row.tags.join(", ") : "—"}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.lastOrderAt ? (
                      <div>
                        <div>{fmtDateTime(row.lastOrderAt)}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          {row.lastOrderNo ? `#${row.lastOrderNo}` : ""}{" "}
                          {currency(row.lastOrderTotal)}
                        </div>
                      </div>
                    ) : (
                      <span style={{ opacity: 0.6 }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: `1px solid ${cardBorder}` }}>
                    {currency(row.totalSpend)}
                  </td>
                  <td style={{ padding: 8, textAlign: "right", borderBottom: `1px solid ${cardBorder}` }}>
                    {row.orderCount}
                  </td>
                  <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
                    {row.address || "—"}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} style={{ padding: 16, textAlign: "center", opacity: 0.7 }}>
                  No contacts match the current search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  </div>
)}
{/* ───────────────────────── Reconcile TAB ───────────────────────── */}
{activeTab === "reconcile" && (
  <div style={{ display: "grid", gap: 14 }}>
    {/* Card: Cash Drawer */}
    <div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:16, background: dark ? "#151515" : "#fafafa" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <h3 style={{ margin:0 }}>Cash Drawer — Expected vs Actual</h3>
        {dayMeta.reconciledAt ? (
          <span style={{ marginLeft:8, fontSize:12, padding:"2px 8px", borderRadius:999, background:"#e8f5e9", color:"#1b5e20", border:"1px solid #a5d6a7" }}>
            Saved at {fmtDateTime(dayMeta.reconciledAt)}
          </span>
        ) : (
          <span style={{ marginLeft:8, fontSize:12, padding:"2px 8px", borderRadius:999, background:"#fff3e0", color:"#bf360c", border:"1px solid #ffcc80" }}>
            Not saved yet
          </span>
        )}
        <div style={{ marginLeft:"auto", fontSize:12, opacity:.8 }}>
          Shift: {dayMeta.startedAt ? fmtDateTime(dayMeta.startedAt) : "—"} → {dayMeta.endedAt ? fmtDateTime(dayMeta.endedAt) : "—"}
        </div>
      </div>

  

      {/* Methods table */}
      <div style={{ overflowX:"auto", marginTop:12 }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign:"left", padding:10, borderBottom:`1px solid ${cardBorder}` }}>Method</th>
              <th style={{ textAlign:"right", padding:10, borderBottom:`1px solid ${cardBorder}` }}>Raw Inflow</th>
              <th style={{ textAlign:"right", padding:10, borderBottom:`1px solid ${cardBorder}` }}>Expected</th>
              <th style={{ textAlign:"right", padding:10, borderBottom:`1px solid ${cardBorder}` }}>Actual / Counted</th>
              <th style={{ textAlign:"right", padding:10, borderBottom:`1px solid ${cardBorder}` }}>Variance</th>
            </tr>
          </thead>
          <tbody>
            {(paymentMethods || []).map((m) => {
              const raw = Number(rawInflowByMethod[m] || 0);
              const exp = Number(expectedByMethod[m] || 0);
              const act = Number(reconCounts[m] || 0);
              const varc = Number((act - exp).toFixed(2));
            
              return (
                <tr key={m}>
                  <td style={{ padding:10, borderBottom:`1px solid ${cardBorder}` }}>{m}</td>
                  <td style={{ padding:10, borderBottom:`1px solid ${cardBorder}`, textAlign:"right" }}>E£{raw.toFixed(2)}</td>
                  <td style={{ padding:10, borderBottom:`1px solid ${cardBorder}`, textAlign:"right" }}>E£{exp.toFixed(2)}</td>
                  <td style={{ padding:10, borderBottom:`1px solid ${cardBorder}`, textAlign:"right" }}>
              <input
                      type="number"
                      step="0.01"
                      value={reconCounts[m] ?? ""}
                      placeholder="0.00"
                      onChange={(e) => handleReconCountChange(m, e.target.value)}
                      style={{ width:120, padding:"6px 8px", borderRadius:8, border:`1px solid ${btnBorder}`, background:dark?"#1f1f1f":"#fff", color:dark?"#eee":"#000", textAlign:"right" }}
                    />
                  </td>
                  <td
                      style={{
                        padding: 10,
                        borderBottom: `1px solid ${cardBorder}`,
                        textAlign: "right",
                        fontWeight: 700,
                        color: varc > 0 ? "#1b5e20" : varc < 0 ? "#b71c1c" : (dark ? "#bbb" : "#666"),
                      }}
                    >
                      {varc > 0 ? "+" : ""}E£{varc.toFixed(2)}
                    </td>

                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    {/* KPIs bar */}
      <div style={{ padding:10, border:`1px solid ${cardBorder}`, borderRadius:10, background:dark?"#1d1d1d":"#fff", marginTop:10 }}>
        <div style={{ fontSize:12, opacity:.8 }}>Total Variance</div>
        <div
          style={{
            fontWeight:900,
            textAlign:"right",
            color: totalVariance > 0 ? "#1b5e20" : totalVariance < 0 ? "#b71c1c" : (dark ? "#bbb" : "#666")

          }}
        >
          {totalVariance >= 0 ? "+" : ""}E£{totalVariance.toFixed(2)}
        </div>
      </div>

      {/* Save bar */}
      <div style={{ marginTop:12, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
     <label style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span>Saved by</span>
                <select
                  value={reconSavedBy}
                  onChange={(e) => setReconSavedBy(e.target.value)}
                  style={{ width:220, padding:"8px 10px", borderRadius:8, border:`1px solid ${btnBorder}`, background:dark?"#1f1f1f":"#fff", color:dark?"#eee":"#000" }}
                >
                  <option value="">Select a worker…</option>
                      {[...new Set([...(workers || []), "Ahmed", "Hazem"])].map((w) => (
                        <option key={w} value={w}>{w}</option>
                      ))}
                    </select>
              </label>
 <button
          onClick={saveReconciliation}
          disabled={!hasMeaningfulActualCounts}
          style={{
            marginLeft: "auto",
            padding: "10px 16px",
            borderRadius: 12,
            border: "none",
            background: !hasMeaningfulActualCounts ? "#9e9e9e" : "#00966a",
            color: "#fff",
            fontWeight: 800,
            cursor: !hasMeaningfulActualCounts ? "not-allowed" : "pointer",
            opacity: !hasMeaningfulActualCounts ? 0.7 : 1,
          }}
        >
          Save Reconciliation
        </button>
      </div>
    </div>

    {/* All-time Variance summary (sums all saved reconciliations) */}
    <div
      style={{
        marginTop: 12,
        padding: 10,
        border: `1px solid ${cardBorder}`,
        borderRadius: 8,
        background: softBg,
      }}
    >
      <h4 style={{ margin: 0 }}>All-time Variance</h4>
  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
  {(paymentMethods || []).map((m) => {
    const v = Number(allTimeVarianceByMethod?.[m] || 0);
    return (
      <div
        key={m}
        style={{
          padding: 8,
          border: `1px solid ${cardBorder}`,
          borderRadius: 6,
          minWidth: 120,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.8 }}>{m}</div>
        <div
          style={{
            fontWeight: 700,
            color: v > 0 ? "#1b5e20" : v < 0 ? "#b71c1c" : (dark ? "#bbb" : "#666"),
          }}
        >
          {v > 0 ? "+" : ""}E£{v.toFixed(2)}
        </div>
      </div>
    );
  })}
</div>

     <div
  style={{
    marginTop: 8,
    fontWeight: 800,
    color:
      allTimeVarianceTotal > 0
        ? "#1b5e20"
        : allTimeVarianceTotal < 0
        ? "#b71c1c"
        : (dark ? "#bbb" : "#666"),
  }}
>
  Total: {allTimeVarianceTotal > 0 ? "+" : ""}E£{allTimeVarianceTotal.toFixed(2)}
</div>

      <div style={{ marginTop: 8 }}>
        <button
          onClick={resetAllReconciliations}
          style={{ padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}` }}
        >
          Reset all saved reconciliations
        </button>
      </div>
    </div>

    {/* History */}
    <div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:16, background: dark ? "#151515" : "#fafafa" }}>
      <h3 style={{ marginTop:0 }}>Reconciliation History</h3>
      {!reconHistory.length ? (
        <div style={{ opacity:.7 }}>No saved sessions yet.</div>
      ) : (
        <div style={{ display:"grid", gap:12 }}>
          {reconHistory.map(rec => (
            <div key={rec.id} style={{ border:`1px solid ${cardBorder}`, borderRadius:10, padding:12, background:dark?"#1d1d1d":"#fff" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <strong>Saved by:</strong> {rec.savedBy}
                <span style={{ marginLeft:8, opacity:.8 }}>{fmtDateTime(rec.at)}</span>
                <div style={{ marginLeft:"auto", fontWeight:900, color: rec.totalVariance > 0 ? "#1b5e20" : (rec.totalVariance < 0 ? "#b71c1c" : (dark ? "#aaa" : "#555")) }}>
                  Total: {rec.totalVariance >= 0 ? "+" : ""}E£{Number(rec.totalVariance || 0).toFixed(2)}
                </div>
              </div>
              <div style={{ overflowX:"auto", marginTop:8 }}>
                <table style={{ width:"100%", borderCollapse:"collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign:"left", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Method</th>
                      <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Expected</th>
                      <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Actual</th>
                      <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(rec.breakdown || {}).map((m) => {
                      const r = rec.breakdown[m] || {};
                      return (
                        <tr key={m}>
                          <td style={{ padding:8, borderBottom:`1px solid ${cardBorder}` }}>{m}</td>
                          <td style={{ padding:8, borderBottom:`1px solid ${cardBorder}`, textAlign:"right" }}>E£{Number(r.expected || 0).toFixed(2)}</td>
                          <td style={{ padding:8, borderBottom:`1px solid ${cardBorder}`, textAlign:"right" }}>E£{Number(r.actual || 0).toFixed(2)}</td>
                         <td
  style={{
    padding: 8,
    borderBottom: `1px solid ${cardBorder}`,
    textAlign: "right",
    fontWeight: 700,
    color:
      Number(r.variance || 0) > 0
        ? "#1b5e20"
        : Number(r.variance || 0) < 0
        ? "#b71c1c"
        : (dark ? "#bbb" : "#666"),
  }}
>
  {Number(r.variance || 0) > 0 ? "+" : ""}E£{Number(r.variance || 0).toFixed(2)}
</td>

                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
)}



       {/* Purchase Tab */}
{activeTab === "admin" && adminSubTab === "purchases" && (
  <div>
    <h2>Purchases</h2>

    {/* DAY / MONTH / YEAR buttons under title (right) */}
    <div style={{
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      margin: "6px 0 10px"
    }}>
      {["day","month","year"].map((k) => (
        <button
          key={k}
          onClick={() => setPurchaseFilter(k)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: `1px solid ${btnBorder}`,
            background: purchaseFilter === k ? "#ffd54f" : (dark ? "#2b2b2b" : "#f2f2f2"),
            fontWeight: 700,
            cursor: "pointer"
          }}
          aria-pressed={purchaseFilter === k}
        >
          {k.toUpperCase()}
        </button>
      ))}
{/* Time pickers for the chosen period */}
{purchaseFilter === "day" && (
  <div style={{ display:"flex", alignItems:"center", gap:8, marginLeft:8 }}>
    <label><b>Pick day:</b> </label>
    <input
      type="date"
      value={purchaseDay}
      onChange={(e) => { setPurchaseDay(e.target.value); setShowAllCats(false); }}
      style={{ padding:6, borderRadius:6, border:`1px solid ${btnBorder}` }}
    />
  </div>
)}

{purchaseFilter === "month" && (
  <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
    <label><b>Pick month:</b></label>
    <input
      type="month"
      value={purchaseMonth}
      onChange={(e) => { setPurchaseMonth(e.target.value); setShowAllCats(false); }}
      style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    />
  </div>
)}


<button
  onClick={() => { setPurchaseCatFilterId(""); setShowAllCats(true); }}
  title="Show purchases from all categories AND show all categories in the grid"
  style={{ padding:"6px 10px", borderRadius:8, border:`1px solid ${btnBorder}`, background: dark ? "#2b2b2b" : "#f2f2f2", fontWeight:700, cursor:"pointer" }}
>
  SHOW ALL
</button>

 <button
   onClick={resetAllPurchases}
   style={{ padding:"6px 10px", borderRadius:8, border:"none", background:"#c62828", color:"#fff", fontWeight:700, cursor:"pointer" }}
 >
   Reset Purchases
 </button>
     {/* === ADD: Purchases PDF === */}
<button
  onClick={generatePurchasesPDF}
  style={{ padding:"6px 10px", borderRadius:8, border:"none", background:"#7e57c2", color:"#fff", fontWeight:700, cursor:"pointer" }}
>
  Download Purchases PDF
</button>

    </div>

    {/* === KPI ROW (only Total Purchases now) ========================= */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          position: "relative",
          padding: 16,
          borderRadius: 12,
          background: dark ? "#1e1e1e" : "#fff",
          border: `1px solid ${cardBorder}`,
        }}
      >
        <div style={{ fontWeight: 600, opacity: 0.9 }}>Total Purchases</div>
        <div style={{ marginTop: 6, fontSize: 24, fontWeight: 800 }}>
          {currency(totalPurchasesInPeriod)}
        </div>
          {/* Period KPI (total purchases) */}
<div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:8 }}>
  <span><b>Total ({purchaseFilter}):</b></span>
  <span style={{ padding:"4px 8px", borderRadius:6, background: dark ? "#1e1e1e" : "#fff" }}>
    {currency(totalPurchasesInPeriod)}
  </span>
</div>

      </div>
    </div>


  {/* === CATEGORY TILES + ADD CATEGORY =============================== */}
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: 12,
        marginBottom: 14,
      }}
    >
     {categoriesForGrid.map((cat) => {
  const total = catTotals.get(cat.id) || 0;
  const active = purchaseCatFilterId === cat.id;
  return (
    <button
      key={cat.id}
      onClick={() =>
        setPurchaseCatFilterId((id) => (id === cat.id ? "" : cat.id))
      }
      style={{
        position: "relative",                  // ⬅️ add
        textAlign: "left",
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${cardBorder}`,
        background: active ? (dark ? "#222" : "#fff8e1") : (dark ? "#1e1e1e" : "#fff"),
        color: dark ? "#eee" : "#000",
        cursor: "pointer",
      }}
      title="Show category details below"
    >
      {/* tiny X in the top-right */}
      <span
        title={`Delete ${cat.name}`}
        aria-label={`Delete ${cat.name}`}
        onClick={(e) => {
          e.stopPropagation();   // don't toggle selection
          e.preventDefault();
          removePurchaseCategory(cat.id);
        }}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "50%",
          border: `1px solid ${btnBorder}`,
          background: dark ? "#2a2a2a" : "#fff",
          color: dark ? "#eee" : "#000",
          fontSize: 14,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "pointer",
          opacity: 0.9,
        }}
      >
        ×
      </span>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            border: `1px solid ${btnBorder}`,
            fontSize: 16,
          }}
        >
          📦
        </span>
        <div style={{ fontWeight: 700 }}>{cat.name}</div>
      </div>
      <div style={{ marginTop: 6, opacity: 0.8 }}>
        {currency(total)}
      </div>
    </button>
  );
})}


    {/* Add Category tile (inside the categories group) */}
<div
  style={{
    padding: 14,
    borderRadius: 12,
    border: `1px solid ${cardBorder}`,
    background: dark ? "#1a1a1a" : "#fff",
  }}
>
  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
    <span
      style={{
        display: "inline-flex",
        width: 28,
        height: 28,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 8,
        border: `1px solid ${btnBorder}`,
        fontWeight: 800,
      }}
    >
      +
    </span>
    <div style={{ fontWeight: 700 }}>Add Category</div>
  </div>

  <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
    <input
      type="text"
      placeholder="Category name"
      value={newCategoryName}
      onChange={(e) => setNewCategoryName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") addPurchaseCategory();
      }}
      style={{
        flex: 1,
        minWidth: 160,
        padding: 10,
        borderRadius: 10,
        border: `1px solid ${btnBorder}`,
        background: dark ? "#121212" : "#fff",
        color: dark ? "#eee" : "#000",
      }}
    />

    {/* NEW: unit select lives in the same row */}
    <select
      value={newCategoryUnit}
      onChange={(e) => setNewCategoryUnit(e.target.value)}
      style={{
        padding: 10,
        borderRadius: 10,
        border: `1px solid ${btnBorder}`,
        background: dark ? "#121212" : "#fff",
        color: dark ? "#eee" : "#000",
      }}
      title="Default unit for this category"
    >
      {PURCHASE_UNITS.map((u) => (
        <option key={u} value={u}>{u}</option>
      ))}
    </select>

    <button
      onClick={addPurchaseCategory}
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        border: "none",
        background: "#000",
        color: "#fff",
        cursor: "pointer",
      }}
    >
      Add
    </button>
  </div>
      </div>
    </div>

   

  {/* ── Add Purchase row (bordered) ───────────────────────────────── */}
<div
  style={{
    display: "flex",
    flexWrap: "wrap",
    gap: 8,
    alignItems: "center",
    marginBottom: 10,
    padding: 10,
    border: `1px solid ${btnBorder}`,   // ← border line
    borderRadius: 8,
    background: dark ? "#1b1b1b" : "#fafafa",
  }}
>
  {/* Category */}
<select
  value={newPurchase.categoryId}
  onChange={(e) => {
    const cid = e.target.value;
    const cat = (categoriesForGrid || []).find(c => c.id === cid);

    // Try to link a purchase to an inventory item via the chosen category.
    // 1) If your category objects already have cat.invId, use it.
    // 2) Otherwise, try matching category name to inventory name (normalized).
    const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    let linkInvId = "";
    if (cat) {
      if (cat.invId) {
        linkInvId = cat.invId;
      } else {
        const match = (inventory || []).find(it => normalize(it.name) === normalize(cat.name));
        if (match) linkInvId = match.id;
      }
    }

    setNewPurchase(p => ({ ...p, categoryId: cid, invId: linkInvId }));
  }}
  style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 180 }}
>
  <option value="">Select category</option>
  {categoriesForGrid.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
</select>



  {/* Item name */}
  <input
    type="text"
    placeholder="Item name"
    value={newPurchase.itemName}
    onChange={(e) => setNewPurchase(p => ({ ...p, itemName: e.target.value }))}
    style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 220 }}
  />

  {/* Unit dropdown */}
  <select
    value={newPurchase.unit}
    onChange={e => setNewPurchase(p => ({ ...p, unit: e.target.value }))}
    style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 140 }}
  >
    {PURCHASE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
  </select>

  {/* Qty */}
  <input
    type="number"
    placeholder="Qty"
    value={newPurchase.qty}
    onChange={(e) => setNewPurchase(p => ({ ...p, qty: Math.max(0, Number(e.target.value || 0)) }))}
    style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 120 }}
  />

  {/* Unit price */}
  <input
    type="number"
    placeholder="Unit Price (E£)"
    value={newPurchase.unitPrice}
    onChange={(e) => setNewPurchase(p => ({ ...p, unitPrice: Math.max(0, Number(e.target.value || 0)) }))}
    style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 160 }}
  />

  {/* Date */}
  <input
    type="date"
    value={newPurchase.date}
    onChange={(e) => setNewPurchase(p => ({ ...p, date: e.target.value }))}
    style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
  />

<button
  onClick={handleAddPurchase}
  style={{
    background: "#000",   // black button
    color: "#fff",        // white text
    border: "none",
    borderRadius: 6,
    padding: "8px 12px",
    cursor: "pointer",
    fontWeight: 700,
  }}
>
  Add Purchase
</button>

</div>



  

    {/* === DETAILS LIST ================================================= */}
    <div style={{ marginTop: 4 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>All Categories</div>

      {categoriesForGrid.map((cat) => {
        const rows = byCategory.get(cat.id) || [];
        const total = catTotals.get(cat.id) || 0;
        return (
          <div
            key={cat.id}
            style={{
              border: `1px solid ${cardBorder}`,
              borderRadius: 12,
              background: dark ? "#141414" : "#fff",
              marginBottom: 12,
              overflow: "hidden",
            }}
          >
            {/* Section header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 12px",
                background: dark ? "#1c1c1c" : "#fafafa",
                borderBottom: `1px solid ${cardBorder}`,
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  width: 24,
                  height: 24,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                  border: `1px solid ${btnBorder}`,
                  fontSize: 14,
                }}
              >
                📦
              </span>
              <div style={{ fontWeight: 700 }}>{cat.name}</div>
              <div style={{ opacity: 0.8 }}>• {currency(total)}</div>
            </div>

            {/* Table */}
            <div style={{ padding: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Date", "Item", "Unit", "Qty", "Unit Price", "Total"].map(
                      (h) => (
                        <th
                          key={h}
                          style={{
                            textAlign:
                              h === "Qty" || h === "Unit Price" || h === "Total"
                                ? "right"
                                : "left",
                            borderBottom: `1px solid ${cardBorder}`,
                            padding: 8,
                            fontWeight: 700,
                          }}
                        >
                          {h}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 8, opacity: 0.7 }}>
                        No purchases in this period.
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ padding: 8 }}>{prettyDate(r.date)}</td>
                        <td style={{ padding: 8 }}>{r.itemName || "-"}</td>
                        <td style={{ padding: 8 }}>{r.unit || "-"}</td>
                        <td style={{ padding: 8, textAlign: "right" }}>
                          {Number(r.qty || 0)}
                        </td>
                        <td style={{ padding: 8, textAlign: "right" }}>
                          {currency(r.unitPrice)}
                        </td>
                        <td style={{ padding: 8, textAlign: "right" }}>
                          {currency(Number(r.qty || 0) * Number(r.unitPrice || 0))}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  </div>
)}
    {activeTab === "admin" && adminSubTab === "bank" && (
  <div>
    <h2>Bank / Cashbox</h2>
    
    {/* Balance Display */}
    <div
      style={{
        marginBottom: 10,
        padding: 10,
        borderRadius: 6,
        background: dark ? "#1b2631" : "#e3f2fd",
        display: "flex",
        gap: 12,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <div>
        <strong>Current Balance:</strong> E£{bankBalance.toFixed(2)}
      </div>
      <div>
        <strong>Today's Balance:</strong> E£{filteredBankTx.reduce((sum, t) => {
          const a = Number(t.amount || 0);
          if (t.type === "deposit" || t.type === "init" || t.type === "adjustUp") return sum + a;
          if (t.type === "withdraw" || t.type === "adjustDown") return sum - a;
          return sum;
        }, 0).toFixed(2)}
      </div>
      
      {/* Filter Controls */}
      <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        <select
          value={bankFilter}
          onChange={(e) => setBankFilter(e.target.value)}
          style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
        >
          <option value="day">Day</option>
          <option value="month">Month</option>
          <option value="year">Year</option>
        </select>
        
        {bankFilter === "day" && (
          <input
            type="date"
            value={bankDay}
            onChange={(e) => setBankDay(e.target.value)}
            style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
          />
        )}
        
        {bankFilter === "month" && (
          <input
            type="month"
            value={bankMonth}
            onChange={(e) => setBankMonth(e.target.value)}
            style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
          />
        )}
      </div>
    </div>

    {/* Utility Buttons */}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
      {UTILITY_TYPES.map(utility => (
        <button
          key={utility.name}
          onClick={() => setBankForm({
            ...bankForm,
            type: "withdraw",
            note: utility.note,
            amount: 0
          })}
          style={{
            padding: "8px 12px",
            borderRadius: 6,
            border: `1px solid ${btnBorder}`,
            background: dark ? "#2c2c2c" : "#f1f1f1",
            cursor: "pointer"
          }}
        >
          {utility.name}
        </button>
      ))}
{/* Add this reset button */}
      <button
        onClick={() => {
          const okAdmin = !!promptAdminAndPin();
          if (!okAdmin) return;
          if (!window.confirm("Reset ALL bank transactions? This cannot be undone.")) return;
          skipLockedBankReinsertRef.current = true;
          lastLockedBankRef.current = [];
          setBankTx([]);
        }}
        style={{
          padding: "8px 12px",
          borderRadius: 6,
          border: `1px solid ${btnBorder}`,
          background: "#d32f2f",
          color: "white",
          cursor: "pointer"
        }}
      >
        Reset All Transactions
      </button>
    </div>

    {/* Add Transaction Form */}
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        marginBottom: 12,
      }}
    >
      <select
        value={bankForm.type}
        onChange={(e) => setBankForm((f) => ({ ...f, type: e.target.value }))}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
      >
        <option value="deposit">Deposit (+)</option>
        <option value="withdraw">Withdraw (-)</option>
        <option value="adjustUp">Adjust Up (+)</option>
        <option value="adjustDown">Adjust Down (-)</option>
        <option value="init">Init (set by margin)</option>
      </select>
      <input
        type="number"
        placeholder="Amount"
        value={bankForm.amount}
        onChange={(e) => setBankForm((f) => ({ ...f, amount: Number(e.target.value || 0) }))}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 160 }}
      />
      <input
        type="text"
        placeholder="Worker"
        list="bank-worker-list"
        value={bankForm.worker}
        onChange={(e) => setBankForm((f) => ({ ...f, worker: e.target.value }))}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 180 }}
      />
      <datalist id="bank-worker-list">
        {workers.map((w) => (
          <option key={w} value={w} />
        ))}
      </datalist>
      <input
        type="text"
        placeholder="Note"
        value={bankForm.note}
        onChange={(e) => setBankForm((f) => ({ ...f, note: e.target.value }))}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 240 }}
      />
      <button
        onClick={() => {
          const amt = Number(bankForm.amount || 0);
          if (!amt) return alert("Amount must be > 0.");
          const row = {
            id: `tx_${Date.now()}`,
            type: bankForm.type || "deposit",
            amount: Math.abs(amt),
            worker: bankForm.worker || "",
            note: bankForm.note || "",
            date: new Date(),
          };
          setBankTx((arr) => [row, ...arr]);
          setBankForm({ type: "deposit", amount: 0, worker: "", note: "" });
        }}
        style={{
          background: "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 12px",
          cursor: "pointer",
        }}
      >
        Add Entry
      </button>
    </div>

    {/* Transactions Table */}
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Type</th>
          <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Amount (E£)</th>
          <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Worker</th>
          <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Date</th>
          <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Note</th>
          <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {filteredBankTx.map((t) => {
          const isPositive = t.type === "deposit" || t.type === "init" || t.type === "adjustUp";
          const isLocked = t.locked;
          const amountColor = isPositive ? "#2e7d32" : "#c62828";
          
          return (
            <tr key={t.id}>
              <td style={{ padding: 6 }}>{t.type}</td>
              <td style={{ 
                padding: 6, 
                textAlign: "right",
                color: amountColor,
                fontWeight: "bold"
              }}>
                {isPositive ? "+" : "-"}E£{Number(t.amount || 0).toFixed(2)}
              </td>
              <td style={{ padding: 6 }}>{t.worker}</td>
              <td style={{ padding: 6 }}>{t.date ? formatDateDDMMYY(t.date) : ""}</td>
              <td style={{ padding: 6 }}>{t.note}</td>
              <td style={{ padding: 6 }}>
                <button
                  onClick={() => removeBankTx(t.id)}
                  disabled={isLocked}
                  title={isLocked ? "This transaction cannot be removed" : "Remove"}
                  style={{
                    background: "#c62828",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "6px 10px",
                    cursor: isLocked ? "not-allowed" : "pointer",
                    opacity: isLocked ? 0.6 : 1,
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          );
        })}
        {filteredBankTx.length === 0 && (
          <tr>
            <td colSpan={6} style={{ padding: 8, opacity: 0.8 }}>
              No bank entries for the selected period.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
)}
{/* ───────────────────────── WORKER LOG TAB ───────────────────────── */}
{activeTab === "admin" && adminSubTab === "workerlog" && (
  <div style={{ display:"grid", gap:14 }}>
    <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 10,
      flexWrap: "wrap",
    }}
  >
    <h3 style={{ margin: 0 }}>Worker Log</h3>

    <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
      <button
        onClick={() => closeOpenSessionsAt(new Date())}
        title="Close all currently open sessions at the current time"
        style={{
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid #ccc",
          background: "#f1f1f1",
          cursor: "pointer",
        }}
      >
        Close Open Sessions
      </button>
      <button
        onClick={resetWorkerLog}
        title="Delete ALL worker sessions (admin only)"
        style={{
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid #ccc",
          background: "#ffebee",
          color: "#b71c1c",
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Reset Worker Log
      </button>
    </div>
  </div>
    <h2>Worker Log</h2>
    {/* Filter row */}
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
     <button
        onClick={() => setWorkerLogFilter("day")}
        style={{
          padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}`,
          background: workerLogFilter === "day" ? "#ffd54f" : (dark ? "#2c2c2c" : "#f1f1f1"),
          cursor:"pointer"
        }}
      >DAY</button>
      <button
        onClick={() => setWorkerLogFilter("week")}
        style={{
          padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}`,
          background: workerLogFilter === "week" ? "#ffd54f" : (dark ? "#2c2c2c" : "#f1f1f1"),
          cursor:"pointer"
        }}
      >WEEK</button>
      <button
        onClick={() => setWorkerLogFilter("month")}
        style={{
          padding: "6px 10px", borderRadius: 6, border: `1px solid ${btnBorder}`,
          background: workerLogFilter === "month" ? "#ffd54f" : (dark ? "#2c2c2c" : "#f1f1f1"),
          cursor:"pointer"
        }}
      >MONTH</button>
      {workerLogFilter === "day" && (
        <>
          <label><b>Pick day:</b></label>
          <input
            type="date"
            value={workerLogDay}
            onChange={(e) => setWorkerLogDay(e.target.value)}
            style={{ padding:6, borderRadius:6, border:`1px solid ${btnBorder}` }}
          />
        </>
      )}
       {workerLogFilter === "month" && (
        <>
          <label><b>Pick month:</b></label>
          <input
            type="month"
            value={workerLogMonth}
            onChange={(e) => setWorkerLogMonth(e.target.value)}
            style={{ padding:6, borderRadius:6, border:`1px solid ${btnBorder}` }}
          />
        </>
      )}
 {workerLogFilter === "week" && (
        <>
          <label><b>Pick week:</b></label>
          <SundayWeekPicker
            selectedSunday={workerWeekInfo.start}
            onSelect={(weekStart) => {
              if (!weekStart) return;
              setWorkerLogWeekStart(toDateInputValue(weekStart));
            }}
            dark={dark}
            btnBorder={btnBorder}
          />
          {workerWeekInfo.start && (
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              (Starts: {formatDateDDMMYY(workerWeekInfo.start)})
            </span>
          )}
        </>
      )}
      <div style={{ marginLeft:"auto", opacity:.8 }}>
        Period: {formatDateDDMMYY(wStart)} → {formatDateDDMMYY(wEnd)}
      </div>
    </div>
{/* Sessions table */}
<div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:12, background: dark ? "#151515" : "#fafafa" }}>
  <h3 style={{ marginTop:0 }}>Sessions</h3>
  <div style={{ overflowX:"auto" }}>
    <table style={{ width:"100%", borderCollapse:"collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign:"left",  padding:8, borderBottom:`1px solid ${cardBorder}` }}>Date</th>
          <th style={{ textAlign:"left",  padding:8, borderBottom:`1px solid ${cardBorder}` }}>Worker</th>
          <th style={{ textAlign:"left",  padding:8, borderBottom:`1px solid ${cardBorder}` }}>Sign in</th>
          <th style={{ textAlign:"left",  padding:8, borderBottom:`1px solid ${cardBorder}` }}>Sign out</th>
          <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Hours</th>
          <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Est. Payout (E£)</th>
        </tr>
      </thead>
      <tbody>
        {sessionsForPeriod.map((s) => {
          const a = s.signInAt ? new Date(s.signInAt) : null;
          const b = s.signOutAt ? new Date(s.signOutAt) : null;
          // USE helper: hours for THIS session in [wStart,wEnd]
          const hrs = hoursForSession(s, wStart, wEnd);
          // USE helper: quick hourly rate lookup
          const rate = Number(rateByName[s.name] || 0);
          // live estimated payout
          const estPay = Number((hrs * rate).toFixed(2));
          return (
            <tr key={s.id}>
              <td style={{ padding:8 }}>{a ? formatDateDDMMYY(a) : "—"}</td>
              <td style={{ padding:8 }}>{s.name}</td>
              <td style={{ padding:8 }}>{a ? a.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "—"}</td>
              <td style={{ padding:8 }}>
                {b
                  ? b.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})
                  : (s.signOutAt ? "—" : "OPEN")}
              </td>
              <td style={{ padding:8, textAlign:"right" }}>{hrs.toFixed(2)}</td>
              <td style={{ padding:8, textAlign:"right", fontWeight:700 }}>E£{estPay.toFixed(2)}</td>
            </tr>
          );
        })}
        {sessionsForPeriod.length === 0 && (
          <tr><td colSpan={6} style={{ padding:8, opacity:.7 }}>No sessions yet.</td></tr>
        )}
      </tbody>
    </table>
  </div>
</div>
    {/* Totals per worker + rate editor */}
    <div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:12, background: dark ? "#151515" : "#fafafa" }}>
      <h3 style={{ marginTop:0 }}>Totals (by worker)</h3>
      <div style={{ overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign:"left",  padding:8, borderBottom:`1px solid ${cardBorder}` }}>Worker</th>
              <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Hours</th>
              <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Rate (E£/h)</th>
              <th style={{ textAlign:"right", padding:8, borderBottom:`1px solid ${cardBorder}` }}>Pay (E£)</th>
            </tr>
          </thead>
          <tbody>
            {workerMonthlyStats.map(r => {
              const prof = (workerProfiles || []).find(p => p.name === r.name);
              const rate = prof ? Number(prof.rate || 0) : 0;
              return (
                <tr key={r.name}>
                  <td style={{ padding:8 }}>{r.name}</td>
                  <td style={{ padding:8, textAlign:"right" }}>{r.hours.toFixed(2)}</td>
                  <td style={{ padding:8, textAlign:"right" }}>
                    <input
                      type="number"
                      step="0.01"
                      value={rate}
                      onChange={(e) => {
                        const v = Math.max(0, Number(e.target.value || 0));
                        setWorkerProfiles(list => list.map(p => p.name === r.name ? { ...p, rate: v } : p));
                      }}
                      style={{ width:120, padding:6, borderRadius:6, border:`1px solid ${btnBorder}`, textAlign:"right" }}
                    />
                  </td>
                  <td style={{ padding:8, textAlign:"right", fontWeight:700 }}>
                    E£{r.pay.toFixed(2)}
                  </td>
                </tr>
              );
            })}
            {!workerMonthlyStats.length && (
              <tr><td colSpan={4} style={{ padding:8, opacity:.7 }}>No data.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop:8, textAlign:"right", fontWeight:900 }}>
        Total payout: E£{workerMonthlyTotalPay.toFixed(2)}
      </div>
    </div>
    {/* PIN editor */}
    <div style={{ border:`1px solid ${cardBorder}`, borderRadius:12, padding:12, background: dark ? "#151515" : "#fafafa" }}>
      <h3 style={{ marginTop:0 }}>PINs</h3>
      <div style={{ display:"grid", gap:8 }}>
        {(workerProfiles || []).map(p => (
          <div key={p.id} style={{ display:"grid", gridTemplateColumns:"1fr 200px 120px", gap:8, alignItems:"center" }}>
            <div><b>{p.name}</b></div>
            <input
              type="password"
              value={p.pin || ""}
              onChange={(e) => {
                const v = String(e.target.value || "").trim();
                setWorkerProfiles(list => list.map(x => x.id === p.id ? { ...x, pin: v } : x));
              }}
              style={{ padding:6, border:`1px solid ${btnBorder}`, borderRadius:6 }}
              placeholder="PIN"
            />
            <div style={{ textAlign:"right", opacity:.7 }}>Rate: E£{Number(p.rate || 0).toFixed(2)}/h</div>
          </div>
        ))}
      </div>
          {/* ── Add Worker (inline) — place directly under "Current workers" list/table ── */}
<div style={{ marginTop: 8 }}>
  {!showAddWorker ? (
    <button
      onClick={() => setShowAddWorker(true)}
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        border: `1px solid ${btnBorder}`,
        background: dark ? "#2c2c2c" : "#f1f1f1",
        color: dark ? "#fff" : "#000",
        cursor: "pointer",
        fontWeight: 700,
      }}
      title="Add a new worker profile"
    >
      ＋ Add worker
    </button>
  ) : (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1.2fr 1fr 1fr auto",
        gap: 8,
        alignItems: "center",
        border: `1px solid ${cardBorder}`,
        borderRadius: 8,
        padding: 10,
        background: softBg,
        marginTop: 6,
      }}
    >
      <input
        placeholder="Name"
        value={newWName}
        onChange={(e) => setNewWName(e.target.value)}
        style={{ padding: 8, border: `1px solid ${btnBorder}`, borderRadius: 6 }}
      />
      <input
        placeholder="PIN (3–6 digits)"
        value={newWPin}
        onChange={(e) =>
          setNewWPin(e.target.value.replace(/\D/g, "").slice(0, 6))
        }
        style={{ padding: 8, border: `1px solid ${btnBorder}`, borderRadius: 6 }}
      />
      <input
        placeholder="Rate (E£/hr)"
        type="number"
        step="0.01"
        value={newWRate}
        onChange={(e) => setNewWRate(e.target.value)}
        style={{ padding: 8, border: `1px solid ${btnBorder}`, borderRadius: 6 }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={addWorkerProfile}
          style={{
            background: "#2e7d32",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "6px 10px",
            cursor: "pointer",
            fontWeight: 800,
          }}
        >
          Save
        </button>
        <button
          onClick={() => {
            setShowAddWorker(false);
            setNewWName("");
            setNewWPin("");
            setNewWRate("");
          }}
          style={{
            border: `1px solid ${btnBorder}`,
            borderRadius: 6,
            padding: "6px 10px",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )}
</div>

    </div>
  </div>
)}
      {/* REPORTS */}
      {activeTab === "admin" && adminSubTab === "reports" && (
        <div>
         <div style={{ marginBottom: '16px' }}>
      <button
        onClick={() => generatePDF(false)}
        style={{
          padding: '10px 16px',
          background: '#1976d2',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontWeight: 'bold'
        }}
      >
        Download Report PDF
       </button>
    </div>
          <h2>Reports</h2>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              alignItems: "center",
              margin: "12px 0",
              padding: 8,
              borderRadius: 8,
              border: `1px solid ${cardBorder}`,
              background: dark ? "#151515" : "#fafafa",
            }}
          >
            <button
              onClick={() => setReportFilter("shift")}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background:
                  reportFilter === "shift"
                    ? "#ffd54f"
                    : dark
                    ? "#2c2c2c"
                    : "#f1f1f1",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              SHIFT
            </button>
            <button
              onClick={() => setReportFilter("day")}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background:
                  reportFilter === "day"
                    ? "#ffd54f"
                    : dark
                    ? "#2c2c2c"
                    : "#f1f1f1",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              DAY
            </button>
            <button
              onClick={() => setReportFilter("month")}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background:
                  reportFilter === "month"
                    ? "#ffd54f"
                    : dark
                    ? "#2c2c2c"
                    : "#f1f1f1",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              MONTH
            </button>
            {reportFilter === "day" && (
              <>
                <label><b>Pick day:</b></label>
                <input
                  type="date"
                  value={reportDay}
                  onChange={(e) => setReportDay(e.target.value)}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    border: `1px solid ${btnBorder}`,
                  }}
                />
              </>
            )}
 {reportFilter === "month" && (
              <>
                <label><b>Pick month:</b></label>
                <input
                  type="month"
                  value={reportMonth}
                  onChange={(e) => setReportMonth(e.target.value)}
                  style={{
                    padding: 6,
                    borderRadius: 6,
                    border: `1px solid ${btnBorder}`,
                  }}
                />
              </>
            )}
            <button
              onClick={resetReports}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#2c2c2c" : "#f1f1f1",
                cursor: "pointer",
                fontWeight: 700,
              }}
            >
              Reset
            </button>
            <div style={{ marginLeft: "auto", opacity: 0.8 }}>
              {reportStart && reportEnd ? (
                <>
            Period: {reportStart.toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                  {" "}→ {" "}
                  {reportEnd.toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </>
              ) : (
                "Period unavailable"
              )}
            </div>
          </div>
          {/* Totals overview */}
          <>
 <div
              style={{
                marginBottom: 12,
                padding: 10,
                borderRadius: 6,
                background: dark ? "#f5f5f5" : "#e8f5e9",
                color: "#000",
                display: "flex",
                flexWrap: "wrap",
                gap: 16,
              }}
            >
             {[{
                label: "Revenue (items only):",
                value: totals.revenueTotal.toFixed(2),
              }, {
                label: "Delivery Fees:",
                value: totals.deliveryFeesTotal.toFixed(2),
              }, {
                label: "Purchases:",
                value: totals.purchasesTotal.toFixed(2),
              }, {
                label: "Expenses:",
                value: totals.expensesTotal.toFixed(2),
              }, {
                label: "Margin:",
                value: totals.margin.toFixed(2),
              }].map(({ label, value }) => (
             <div
                  key={label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: "#000" }}>{label}</span>
                  <span style={{ fontWeight: 700 }}>E£{value}</span>
                </div>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ margin: "16px 0 8px" }}>Orders in Period</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Date / Time</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Order Ref</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Channel</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>POS #</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Worker</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Payment</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Type</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Items (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Delivery (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Total (E£)</th>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportOrdersDetailed.map((order, idx) => {
                      const channelLabel = order.channel === "online" ? "Online" : "On-site";
                      const rawItemsOnly = Number(
                        order.itemsTotal != null
                          ? order.itemsTotal
                          : (order.total || 0) - (order.deliveryFee || 0)
                      );
                      const itemsOnly = Number.isFinite(rawItemsOnly) ? rawItemsOnly : 0;
                      const rawDelivery = Number(order.deliveryFee || 0);
                      const deliveryFeeValue = Number.isFinite(rawDelivery) ? rawDelivery : 0;
                      const rawTotal = Number(
                        order.total != null ? order.total : itemsOnly + deliveryFeeValue
                      );
                      const totalValue = Number.isFinite(rawTotal)
                        ? rawTotal
                        : itemsOnly + deliveryFeeValue;
                      const paymentDisplay = Array.isArray(order.paymentParts) && order.paymentParts.length
                        ? order.paymentParts
                            .map((part) => `${part.method}: E£${Number(part.amount || 0).toFixed(2)}`)
                            .join(" + ")
                        : order.payment || "—";
                      const posDisplay = Number.isFinite(Number(order.orderNo))
                        ? String(Math.floor(Number(order.orderNo)))
                        : "—";
                      const normalizeStatusText = (value) =>
                        String(value || "")
                          .replace(/[_-]+/g, " ")
                          .replace(/\b\w/g, (ch) => ch.toUpperCase());
                      const statusLabel = order.voided
                        ? order.restockedAt
                          ? "Cancelled"
                          : "Returned"
                        : order.done
                        ? "Done"
                        : order.channel === "online" && order.status
                        ? normalizeStatusText(order.status)
                        : "Pending";
                      const key =
                        order.channelOrderNo ||
                        `${order.orderNo || "order"}_${order.idemKey || order.onlineOrderKey || order.onlineOrderId || idx}`;
                      return (
                        <tr key={key}>
                          <td style={{ padding: 6 }}>{fmtDateTime(order.date)}</td>
                          <td style={{ padding: 6 }}>{order.channelOrderNo || formatOnsiteChannelOrderNo(order.orderNo)}</td>
                          <td style={{ padding: 6 }}>{channelLabel}</td>
                          <td style={{ padding: 6, textAlign: "right" }}>{posDisplay}</td>
                          <td style={{ padding: 6 }}>{order.worker || "—"}</td>
                          <td style={{ padding: 6 }}>{paymentDisplay}</td>
                          <td style={{ padding: 6 }}>{order.orderType || "—"}</td>
                          <td style={{ padding: 6, textAlign: "right" }}>{itemsOnly.toFixed(2)}</td>
                          <td style={{ padding: 6, textAlign: "right" }}>{deliveryFeeValue.toFixed(2)}</td>
                          <td style={{ padding: 6, textAlign: "right" }}>{totalValue.toFixed(2)}</td>
                          <td style={{ padding: 6 }}>{statusLabel}</td>
                        </tr>
                      );
                    })}
                    {reportOrdersDetailed.length === 0 && (
                      <tr>
                        <td colSpan={11} style={{ padding: 8, opacity: 0.8 }}>
                          No orders recorded for the selected period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <h3 style={{ margin: 0 }}>Margin Trend</h3>
                 <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  {[
                    ["week", "Week"],
                    ["month", "Month"],
                    ["year", "Year"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setMarginChartFilter(key)}
                      style={{
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: `1px solid ${btnBorder}`,
                        background:
                          marginChartFilter === key
                            ? "#ffd54f"
                            : dark
                            ? "#2c2c2c"
                            : "#f1f1f1",
                        cursor: "pointer",
                        fontWeight: 700,
                        textTransform: "uppercase",
                      }}
                    >
              {label}
                    </button>
                  ))}
 {marginChartFilter === "week" && (
                    <>
                      <label style={{ fontWeight: 600 }}>Pick week:</label>
                      <SundayWeekPicker
                        selectedSunday={marginChartRange.start}
                        onSelect={(weekStart) => {
                          if (!weekStart) return;
                          const info = getSundayWeekInfo(weekStart, true);
                          if (!info) return;
                          setMarginChartWeek(info.week);
                          setMarginChartWeekYear(info.year);
                        }}
                        dark={dark}
                        btnBorder={btnBorder}
                      />
                      {marginChartRange.start && (
                        <span style={{ fontSize: 12, opacity: 0.75 }}>
                          (Starts: {formatDateDDMMYY(marginChartRange.start)})
                        </span>
                      )}
                    </>
                  )}                 
{marginChartFilter === "month" && (
                    <>
                      <label style={{ fontWeight: 600 }}>Month:</label>
                      <input
                        type="month"
                        value={marginChartMonthSelection}
                        onChange={(e) =>
                          setMarginChartMonthSelection(e.target.value)
                        }
                        style={{
                          padding: 6,
                          borderRadius: 6,
                          border: `1px solid ${btnBorder}`,
                        }}
                      />
                    </>
                  )}
                  {marginChartFilter === "year" && (
                    <>
                      <label style={{ fontWeight: 600 }}>Year:</label>
                      <input
                        type="number"
                        value={marginChartYearSelection}
                        onChange={(e) =>
                          setMarginChartYearSelection(
                            Number(e.target.value) || new Date().getFullYear()
                          )
                        }
                        style={{
                          padding: 6,
                          borderRadius: 6,
                          border: `1px solid ${btnBorder}`,
                          width: 100,
                        }}
                      />
                    </>
                  )}
                </div>
                <div style={{ marginLeft: "auto", opacity: 0.8 }}>
                  {marginChartRange.start && marginChartRange.end ? (
                    <>
                      Period: {formatDateDDMMYY(marginChartRange.start)} → {" "}
                      {formatDateDDMMYY(marginChartRange.end)}
                    </>
                  ) : (
                    "Period unavailable"
                  )}
                </div>
              </div>
              <div
                style={{
                  border: `1px solid ${cardBorder}`,
                  borderRadius: 12,
                  padding: 12,
                  background: dark ? "#151515" : "#ffffff",
                }}
              >
                <MarginLineChart data={marginChartData} dark={dark} />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <h3 style={{ marginTop: 0 }}>Profit Timeline</h3>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Date</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Revenue (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Purchases (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Expenses (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Net (E£)</th>
                      <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profitTimeline.map((row) => (
                      <tr key={row.date}>
                        <td style={{ padding: 6 }}>{row.date}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{row.revenue.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{row.purchasesCost.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{row.expenseCost.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{row.net.toFixed(2)}</td>
                        <td style={{ padding: 6, textAlign: "right" }}>{row.marginPct.toFixed(2)}%</td>
                      </tr>
                    ))}
                    {!profitTimeline.length && (
                      <tr>
                        <td colSpan={6} style={{ padding: 8, opacity: 0.8 }}>
                          No data for the selected period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
          {/* Items summary (old style: name, unit price (avg), qty, total) */}
          <h3>Items Sold</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Item</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Qty</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Avg Price (E£)</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Total (E£)</th>
              </tr>
            </thead>
            <tbody>
              {salesStats.items.map((r) => {
                const avg = r.count ? r.revenue / r.count : 0;
                return (
                  <tr key={r.id}>
                    <td style={{ padding: 6 }}>{r.name}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{r.count}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{avg.toFixed(2)}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{r.revenue.toFixed(2)}</td>
                  </tr>
                );
              })}
       {salesStats.items.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 8, opacity: 0.8 }}>No items sold in this period.</td>
                </tr>
              )}
            </tbody>
          </table>
          {/* Extras summary */}
          <h3>Extras Sold</h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Extra</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Qty</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Avg Price (E£)</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Total (E£)</th>
              </tr>
            </thead>
            <tbody>
              {salesStats.extras.map((r) => {
                const avg = r.count ? r.revenue / r.count : 0;
                return (
                  <tr key={r.id}>
                    <td style={{ padding: 6 }}>{r.name}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{r.count}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{avg.toFixed(2)}</td>
                    <td style={{ padding: 6, textAlign: "right" }}>{r.revenue.toFixed(2)}</td>
                  </tr>
                );
              })}
             {salesStats.extras.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: 8, opacity: 0.8 }}>No extras sold in this period.</td>
                </tr>
              )}
            </tbody>
          </table>
                {/* Inventory — Start vs Now */}
<h3>Inventory — Start vs Now</h3>
{(!inventorySnapshot || inventorySnapshot.length === 0) ? (
  <p style={{ opacity: 0.8 }}>
    No inventory snapshot yet. Use <b>Inventory → Lock Inventory (start of day)</b> to capture start quantities.
  </p>
) : (
  <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 16 }}>
    <thead>
      <tr>
        <th style={{ textAlign: "left",  borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Item</th>
        <th style={{ textAlign: "left",  borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Unit</th>
        <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Start Qty</th>
        <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Current Qty</th>
        <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Used</th>
      </tr>
    </thead>
    <tbody>
      {inventoryReportRows.map((r) => (
        <tr key={r.name}>
          <td style={{ padding: 6 }}>{r.name}</td>
          <td style={{ padding: 6 }}>{r.unit}</td>
          <td style={{ padding: 6, textAlign: "right" }}>{r.start}</td>
          <td style={{ padding: 6, textAlign: "right" }}>{r.now}</td>
          <td style={{ padding: 6, textAlign: "right" }}>{r.used}</td>
        </tr>
      ))}
    </tbody>
  </table>
)}
        </div>
      )}
      {activeTab === "admin" && adminSubTab === "edit" && (
        <div>
          <h2>Edit</h2>
          {/* Items editor */}
          <h3>Menu Items</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Name</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Price (E£)</th>
                <th style={{ textAlign: "center", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Color</th>
                <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Arrange</th>
                <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {menu.map((it, idx) => (
                <React.Fragment key={it.id}>
                  <tr>
                    <td style={{ padding: 6 }}>
                      <input
                        type="text"
                        value={it.name}
                        onChange={(e) =>
                          setMenu((arr) => arr.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))
                        }
                        style={{ width: "100%", padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "right" }}>
                      <input
                        type="number"
                        value={it.price}
                        onChange={(e) =>
                          setMenu((arr) => arr.map((x) => (x.id === it.id ? { ...x, price: Number(e.target.value || 0) } : x)))
                        }
                        style={{ width: 120, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, textAlign: "right" }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "center" }}>
                      <input
                        type="color"
                        value={it.color || "#ffffff"}
                        onChange={(e) =>
                          setMenu((arr) => arr.map((x) => (x.id === it.id ? { ...x, color: e.target.value } : x)))
                        }
                        style={{ width: 40, height: 28, border: "none", background: "none" }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "center" }}>
                      <button onClick={() => moveMenuUp(it.id)} style={{ marginRight: 6 }}>↑</button>
                      <button onClick={() => moveMenuDown(it.id)}>↓</button>
                    </td>
                    <td style={{ padding: 6 }}>
                      <button
                        onClick={() => setOpenMenuConsId((v) => (v === it.id ? null : it.id))}
                        style={{
                          background: "#455a64",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: "pointer",
                          marginRight: 6,
                        }}
                      >
                        Edit Consumption
                      </button>
                      <button
                        onClick={() => setMenu((arr) => arr.filter((x) => x.id !== it.id))}
                        style={{
                          background: "#c62828",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: "pointer",
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  {openMenuConsId === it.id && (
                    <tr>
                      <td colSpan={5} style={{ padding: 6, background: dark ? "#151515" : "#fafafa" }}>
                       <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                              columnGap: 16,
                              rowGap: 14,
                            }}
                          >
                          {inventory.map((inv) => {
                            const cur = Number((it.uses || {})[inv.id] || 0);
                            return (
                              <label
                                key={inv.id}
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  alignItems: "center",
                                  padding: 6,
                                  borderRadius: 6,
                                  border: `1px solid ${btnBorder}`,
                                  background: dark ? "#1e1e1e" : "#fff",
                                }}
                              >
                                <span style={{ minWidth: 120 }}>{inv.name} ({inv.unit})</span>
                                <input
                                  type="number"
                                  value={cur}
                                  min={0}
                                  step="any"
                                  onChange={(e) => {
                                    const v = Math.max(0, Number(e.target.value || 0));
                                    setMenu((arr) =>
                                      arr.map((x) =>
                                        x.id === it.id
                                          ? {
                                              ...x,
                                              uses: v > 0
                                                ? { ...(x.uses || {}), [inv.id]: v }
                                                : Object.fromEntries(Object.entries(x.uses || {}).filter(([k]) => k !== inv.id)),
                                            }
                                          : x
                                      )
                                    );
                                  }}
                                  style={{ width: 120 }}
                                />
                              </label>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {menu.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 8, opacity: 0.8 }}>No items. Add some below.</td>
                </tr>
              )}
            </tbody>
                <tfoot>
  <tr>
    <td colSpan={5} style={{ padding: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="New item name"
          value={newItemName}
          onChange={(e) => setNewItemName(e.target.value)}
          style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 220 }}
        />
        <input
          type="number"
          placeholder="Price (E£)"
          value={newItemPrice}
          onChange={(e) => setNewItemPrice(Number(e.target.value || 0))}
          style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 160, textAlign: "right" }}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ opacity: 0.8 }}>Color</span>
          <input
            type="color"
            value={newItemColor}
            onChange={(e) => setNewItemColor(e.target.value)}
            style={{ width: 40, height: 28, border: "none", background: "none", cursor: "pointer" }}
          />
        </label>
        <button
          onClick={addMenuFromForm}
          style={{
            background: "#2e7d32",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            padding: "8px 12px",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          + Add Item
        </button>
      </div>
    </td>
  </tr>
</tfoot>
          </table>
          {/* Extras editor */}
          <h3>Extras</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Name</th>
                <th style={{ textAlign: "right", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Price (E£)</th>
                <th style={{ textAlign: "center", borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Color</th>
                <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Arrange</th>
                <th style={{ borderBottom: `1px solid ${cardBorder}`, padding: 6 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {extraList.map((ex, idx) => (
                <React.Fragment key={ex.id}>
                  <tr>
                    <td style={{ padding: 6 }}>
                      <input
                        type="text"
                        value={ex.name}
                        onChange={(e) =>
                          setExtraList((arr) => arr.map((x) => (x.id === ex.id ? { ...x, name: e.target.value } : x)))
                        }
                        style={{ width: "100%", padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "right" }}>
                      <input
                        type="number"
                        value={ex.price}
                        onChange={(e) =>
                          setExtraList((arr) => arr.map((x) => (x.id === ex.id ? { ...x, price: Number(e.target.value || 0) } : x)))
                        }
                        style={{ width: 120, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, textAlign: "right" }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "center" }}>
                      <input
                        type="color"
                        value={ex.color || "#ffffff"}
                        onChange={(e) =>
                          setExtraList((arr) => arr.map((x) => (x.id === ex.id ? { ...x, color: e.target.value } : x)))
                        }
                        style={{ width: 40, height: 28, border: "none", background: "none" }}
                      />
                    </td>
                    <td style={{ padding: 6, textAlign: "center" }}>
                      <button onClick={() => moveExtraUp(ex.id)} style={{ marginRight: 6 }}>↑</button>
                      <button onClick={() => moveExtraDown(ex.id)}>↓</button>
                    </td>
                    <td style={{ padding: 6 }}>
                      <button
                        onClick={() => setOpenExtraConsId((v) => (v === ex.id ? null : ex.id))}
                        style={{
                          background: "#455a64",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: "pointer",
                          marginRight: 6,
                        }}
                      >
                        Edit Consumption
                      </button>
                          
                      <button
                        onClick={() => setExtraList((arr) => arr.filter((x) => x.id !== ex.id))}
                        style={{
                          background: "#c62828",
                          color: "#fff",
                          border: "none",
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: "pointer",
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  {openExtraConsId === ex.id && (
  <tr>
    <td colSpan={5} style={{ padding: 6, background: dark ? "#151515" : "#fafafa" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          columnGap: 16,
          rowGap: 14,
        }}
      >
        {inventory.map((inv) => {
          const cur = Number((ex.uses || {})[inv.id] || 0);
          return (
            <label
              key={inv.id}
              style={{
                display: "flex",
                gap: 6,
                alignItems: "center",
                padding: 6,
                borderRadius: 6,
                border: `1px solid ${btnBorder}`,
                background: dark ? "#1e1e1e" : "#fff",
              }}
            >
              <span style={{ minWidth: 120 }}>
                {inv.name} ({inv.unit})
              </span>
              <input
                type="number"
                value={cur}
                min={0}
                step="any"
                onChange={(e) => {
                  const v = Math.max(0, Number(e.target.value || 0));
                  setExtraList((arr) =>
                    arr.map((x) =>
                      x.id === ex.id
                        ? {
                            ...x,
                            uses:
                              v > 0
                                ? { ...(x.uses || {}), [inv.id]: v }
                                : Object.fromEntries(
                                    Object.entries(x.uses || {}).filter(
                                      ([k]) => k !== inv.id
                                    )
                                  ),
                          }
                        : x
                    )
                  );
                }}
                style={{ width: 120 }}
              />
            </label>
          );
        })}
      </div>
    </td>
  </tr>
)}
                </React.Fragment>
              ))}
              {extraList.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 8, opacity: 0.8 }}>No extras. Add some below.</td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Add extra */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
            <input
              type="text"
              placeholder="New extra name"
              value={newExtraName}
              onChange={(e) => setNewExtraName(e.target.value)}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, minWidth: 220 }}
            />
            <input
              type="number"
              placeholder="Price (E£)"
              value={newExtraPrice}
              onChange={(e) => setNewExtraPrice(Number(e.target.value || 0))}
              style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, width: 160 }}
            />
            <button
  onClick={() => {
    const name = String(newExtraName || "").trim();
    if (!name) return alert("Name required.");
    const id = Date.now();
setExtraList((arr) => [
      ...arr,
      {
        id,
        name,
        price: Math.max(0, Number(newExtraPrice || 0)),
        uses: {},
        color: "#ffffff",
        prepMinutes: 0,
        equipmentMinutes: {},
      },
    ]);
    setNewExtraName("");
    setNewExtraPrice(0);
  }}
  style={{
    background: "#2e7d32",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "8px 12px",
    cursor: "pointer",
  }}
>
  Add Extra
</button>
<div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(260px, 1fr))",
    gap: 12,
    marginBottom: 16,
  }}
>
  {/* Workers */}
  <div
    style={{
      border: `1px solid ${btnBorder}`,
      borderRadius: 8,
      padding: 10,
      background: dark ? "#191919" : "#fafafa",
    }}
  >
    <div style={{ fontWeight: 700, marginBottom: 8 }}>Workers</div>

    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {workers.map((w, idx) => (
        <li
          key={`${w}-${idx}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: 6,
            border: `1px solid ${btnBorder}`,
            borderRadius: 6,
            background: dark ? "#1e1e1e" : "#fff",
            marginBottom: 6,
          }}
        >
          <span>{w}</span>
          <button
  onClick={() => {
    const workerName = workers[idx];
    setWorkers((arr) => arr.filter((x, i) => i !== idx));
    // Also remove from worker sessions and profiles
    setWorkerSessions((sessions) => 
      sessions.filter((s) => s.name !== workerName)
    );
    setWorkerProfiles((profiles) =>
      profiles.filter((p) => p.name !== workerName)
    );
  }}
  style={{
    background: "#c62828",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "4px 8px",
    cursor: "pointer",
  }}
>
  Remove
</button>
        </li>
      ))}
      {workers.length === 0 && (
        <li style={{ opacity: 0.8, padding: 6 }}>No workers yet.</li>
      )}
    </ul>

    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <input
        type="text"
        placeholder="New worker name"
        value={newWorker}
        onChange={(e) => setNewWorker(e.target.value)}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, flex: 1 }}
      />
      <button
        onClick={() => {
          const v = String(newWorker || "").trim();
          if (!v) return alert("Worker name required.");
          if (workers.some((x) => String(x).trim().toLowerCase() === v.toLowerCase()))
            return alert("Worker already exists.");
          setWorkers((arr) => [...arr, v]);
          setNewWorker("");
        }}
        style={{
          background: "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 12px",
          cursor: "pointer",
        }}
      >
        Add
      </button>
    </div>
  </div>

  {/* Payment Methods */}
  <div
    style={{
      border: `1px solid ${btnBorder}`,
      borderRadius: 8,
      padding: 10,
      background: dark ? "#191919" : "#fafafa",
    }}
  >
    <div style={{ fontWeight: 700, marginBottom: 8 }}>Payment Methods</div>

    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {paymentMethods.map((p, idx) => (
        <li
          key={`${p}-${idx}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: 6,
            border: `1px solid ${btnBorder}`,
            borderRadius: 6,
            background: dark ? "#1e1e1e" : "#fff",
            marginBottom: 6,
          }}
        >
          <span>{p}</span>
          <button
            onClick={() =>
              setPaymentMethods((arr) => arr.filter((x, i) => i !== idx))
            }
            style={{
              background: "#c62828",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        </li>
      ))}
      {paymentMethods.length === 0 && (
        <li style={{ opacity: 0.8, padding: 6 }}>No payment methods yet.</li>
      )}
    </ul>
    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <input
        type="text"
        placeholder="New payment method"
        value={newPayment}
        onChange={(e) => setNewPayment(e.target.value)}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, flex: 1 }}
      />
      <button
        onClick={() => {
          const v = String(newPayment || "").trim();
          if (!v) return alert("Payment method required.");
          if (paymentMethods.some((x) => String(x).trim().toLowerCase() === v.toLowerCase()))
            return alert("Payment method already exists.");
          setPaymentMethods((arr) => [...arr, v]);
          setNewPayment("");
        }}
        style={{
          background: "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 12px",
          cursor: "pointer",
        }}
      >
        Add
      </button>
    </div>
  </div>

  <div
    style={{
      border: `1px solid ${btnBorder}`,
      borderRadius: 8,
      padding: 10,
      background: dark ? "#191919" : "#fafafa",
    }}
  >
    <div style={{ fontWeight: 700, marginBottom: 8 }}>Order Types</div>
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {orderTypes.map((t, idx) => (
        <li
          key={`${t}-${idx}`}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: 6,
            border: `1px solid ${btnBorder}`,
            borderRadius: 6,
            background: dark ? "#1e1e1e" : "#fff",
            marginBottom: 6,
          }}
        >
          <span>{t}</span>
          <button
            onClick={() =>
              setOrderTypes((arr) => arr.filter((x, i) => i !== idx))
            }
            style={{
              background: "#c62828",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "4px 8px",
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        </li>
      ))}
      {orderTypes.length === 0 && (
        <li style={{ opacity: 0.8, padding: 6 }}>No order types yet.</li>
      )}
    </ul>
    <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
      <input
        type="text"
        placeholder="New order type"
        value={newOrderType}
        onChange={(e) => setNewOrderType(e.target.value)}
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, flex: 1 }}
      />
      <button
        onClick={() => {
          const v = String(newOrderType || "").trim();
          if (!v) return alert("Order type required.");
          if (orderTypes.some((x) => String(x).trim().toLowerCase() === v.toLowerCase()))
            return alert("Order type already exists.");
          setOrderTypes((arr) => [...arr, v]);
          setNewOrderType("");
        }}
        style={{
          background: "#1976d2",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "8px 12px",
          cursor: "pointer",
        }}
      >
        Add
      </button>
    </div>
  </div>
</div>
{/* ── Delivery Zones & Fees  */}
<div
  style={{
    border: `1px solid ${cardBorder}`,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    background: dark ? "#151515" : "#fafafa",
  }}
>
  <h3 style={{ marginTop: 0 }}>Delivery Zones & Fees</h3>
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
    <input
      type="text"
      placeholder="Zone name"
      value={newZoneName}
      onChange={(e) => setNewZoneName(e.target.value)}
      style={{ minWidth: 260, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    />
    <input
      type="number"
      placeholder="Fee (E£)"
      value={newZoneFee}
      onChange={(e) => setNewZoneFee(Number(e.target.value || 0))}
      style={{ width: 140, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
    />
    <button
      onClick={addZone}
      style={{ padding: "6px 10px", borderRadius: 6, border: "none", background: "#42a5f5", color: "#fff", cursor: "pointer" }}
    >
      Add zone
    </button>
  </div>
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Zone</th>
          <th style={{ textAlign: "right", padding: 8, borderBottom: `1px solid ${cardBorder}` }}>Fee (E£)</th>
          <th style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}></th>
        </tr>
      </thead>
      <tbody>
        {deliveryZones.map((z, idx) => (
          <tr key={z.id}>
            <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}` }}>
              <input
                type="text"
                value={z.name}
                onChange={(e) =>
                  setDeliveryZones((list) =>
                    list.map((it) => (it.id === z.id ? { ...it, name: e.target.value } : it))
                  )
                }
                style={{ width: "100%", padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
              />
            </td>
            <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, textAlign: "right" }}>
              <input
                type="number"
                value={Number(z.fee || 0)}
                onChange={(e) =>
                  setDeliveryZones((list) =>
                    list.map((it) =>
                      it.id === z.id ? { ...it, fee: Math.max(0, Number(e.target.value || 0)) } : it
                    )
                  )
                }
                style={{ width: 120, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}`, textAlign: "right" }}
              />
            </td>
            <td style={{ padding: 8, borderBottom: `1px solid ${cardBorder}`, whiteSpace: "nowrap" }}>
              {/* Optional reordering if you want (uses your existing moveByIndex) */}
              <button
                onClick={() => setDeliveryZones((arr) => moveByIndex(arr, idx, -1))}
                disabled={idx === 0}
                title="Move up"
                style={{ marginRight: 6 }}
              >
                ↑
              </button>
              <button
                onClick={() => setDeliveryZones((arr) => moveByIndex(arr, idx, +1))}
                disabled={idx === deliveryZones.length - 1}
                title="Move down"
                style={{ marginRight: 10 }}
              >
                ↓
              </button>

              <button
                onClick={() => removeZone(z.id)}
                style={{ background: "#ef5350", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}

        {deliveryZones.length === 0 && (
          <tr>
            <td colSpan={3} style={{ padding: 10, opacity: 0.7 }}>
              No zones yet. Add your first zone above.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  </div>
</div>
<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
  {[1,2,3,4,5,6].map((n) => {
    const isUnlocked = !!unlockedPins[n];
    return (
      <div key={n} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ minWidth: 80 }}>Admin {n}</span>
        <input
          type="password"
          value={isUnlocked ? (adminPins[n] || "") : ""}
          placeholder="••••"
          disabled={!isUnlocked}
          onChange={(e) => {
            // digits only, up to 6 chars
            const v = (e.target.value || "").replace(/\D/g, "").slice(0, 6);
            setAdminPins((p) => ({ ...p, [n]: v }));
          }}
          style={{ flex: 1, padding: 6, borderRadius: 6, border: `1px solid ${btnBorder}` }}
        />
        {isUnlocked ? (
          <button
            onClick={() => lockAdminPin(n)}
            style={{ background: "#6d4c41", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
          >
            Lock
          </button>
        ) : (
          <button
            onClick={() => unlockAdminPin(n)}
            style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}
          >
            Unlock
          </button>
        )}
      </div>
    );
  })}
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS */}
      {activeTab === "admin" && adminSubTab === "settings" && (
        <div>
          <h2>Settings</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
            <div style={{ padding: 10, borderRadius: 6, border: `1px solid ${cardBorder}` }}>
              <h4 style={{ marginTop: 0 }}>Printing</h4>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={autoPrintOnCheckout}
                  onChange={(e) => setAutoPrintOnCheckout(e.target.checked)}
                />
                Auto-print on Checkout
              </label>
              <div style={{ marginTop: 8 }}>
                <label>
                  Paper width (mm):&nbsp;
                  <input
                    type="number"
                    value={preferredPaperWidthMm}
                    onChange={(e) => setPreferredPaperWidthMm(Math.max(40, Number(e.target.value || 80)))}
                    style={{ width: 120 }}
                  />
                </label>
                <small style={{ display: "block", opacity: 0.75 }}>
                   Your current: {preferredPaperWidthMm} mm.
                </small>
              </div>
            </div>

            <div style={{ padding: 10, borderRadius: 6, border: `1px solid ${cardBorder}` }}>
              <h4 style={{ marginTop: 0 }}>Cloud</h4>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={cloudEnabled}
                  onChange={(e) => setCloudEnabled(e.target.checked)}
                />
                Enable cloud autosave (state)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                <input
                  type="checkbox"
                  checked={realtimeOrders}
                  onChange={(e) => setRealtimeOrders(e.target.checked)}
                />
                Live Orders Board (realtime)
              </label>
             <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
  <button onClick={saveToCloudNow} style={{ background: "#2e7d32", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>
    Sync to Cloud
  </button>
  <button onClick={loadFromCloud} style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, padding: "6px 10px" }}>
    Load from Cloud
  </button>
  <small style={{ opacity: 0.8 }}>
    Last save: {cloudStatus.lastSaveAt ? cloudStatus.lastSaveAt.toLocaleString() : "—"} • Last load: {cloudStatus.lastLoadAt ? cloudStatus.lastLoadAt.toLocaleString() : "—"}
  </small>
  {cloudStatus.error && (
    <small style={{ color: "#c62828" }}>Error: {String(cloudStatus.error)}</small>
  )}
</div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

