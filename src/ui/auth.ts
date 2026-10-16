import crypto from "node:crypto";
import type http from "node:http";

/**
 * Einfacher Passwortschutz für den öffentlichen Betrieb: ein gemeinsames Passwort (APP_PASSWORD),
 * signiertes Cookie (HttpOnly, SameSite=Lax), Sperre nach zu vielen Fehlversuchen.
 */
export interface Auth {
  enabled: boolean;
  isAuthed(req: http.IncomingMessage): boolean;
  login(req: http.IncomingMessage, password: string): { ok: true; cookie: string } | { ok: false; locked: boolean };
  logoutCookie(req: http.IncomingMessage): string;
  sameOrigin(req: http.IncomingMessage): boolean;
}

const COOKIE = "autocut_session";
const DAYS = 30;
const MAX_FAILS = 10;
const LOCK_MS = 15 * 60 * 1000;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest();

export function createAuth(password: string | undefined): Auth {
  const enabled = !!password;
  const key = sha(`autocut-session:${password ?? ""}`);
  const sign = (payload: string) => crypto.createHmac("sha256", key).update(payload).digest("hex");
  const fails = new Map<string, { n: number; until: number }>();

  const ip = (req: http.IncomingMessage) => (String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || req.socket.remoteAddress || "?");
  const secure = (req: http.IncomingMessage) => (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");
  const cookieOf = (req: http.IncomingMessage) => {
    const m = String(req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]!) : null;
  };

  return {
    enabled,
    isAuthed(req) {
      if (!enabled) return true;
      const c = cookieOf(req);
      if (!c) return false;
      const [exp, sig] = c.split(".");
      if (!exp || !sig || Number(exp) < Date.now()) return false;
      const expect = sign(exp);
      return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    },
    login(req, pw) {
      const k = ip(req);
      const f = fails.get(k);
      if (f && f.until > Date.now()) return { ok: false, locked: true };
      const good = enabled && crypto.timingSafeEqual(sha(pw), sha(password!));
      if (!good) {
        const n = (f && f.until <= Date.now() && f.n < MAX_FAILS ? f.n : 0) + 1;
        fails.set(k, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        return { ok: false, locked: n >= MAX_FAILS };
      }
      fails.delete(k);
      const exp = String(Date.now() + DAYS * 864e5);
      return { ok: true, cookie: `${COOKIE}=${encodeURIComponent(`${exp}.${sign(exp)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DAYS * 86400}${secure(req)}` };
    },
    logoutCookie(req) {
      return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure(req)}`;
    },
    /** Schutz gegen fremde Webseiten: bei Origin-Header muss er zum Host passen */
    sameOrigin(req) {
      const o = req.headers.origin;
      if (!o) return true;
      try {
        return new URL(String(o)).host === req.headers.host;
      } catch {
        return false;
      }
    },
  };
}

export const loginPage = (error?: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>autocut – Anmelden</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e3e1db;--gold:#fab926;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--panel:#1f1f1d;--ink:#f1efe9;--muted:#a09e97;--line:#323230;--bad:#ff8a80}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px;width:min(360px,90vw)}
h1{font-size:20px;margin:0 0 4px;display:flex;gap:10px;align-items:center}h1 span{width:12px;height:12px;border-radius:50%;background:var(--gold);display:inline-block}
p{color:var(--muted);margin:0 0 16px;font-size:14px}input{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:11px;border-radius:8px;border:0;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}.e{color:var(--bad);font-size:14px;margin-top:10px}
</style></head><body><form method="post" action="/login"><h1><span></span>autocut</h1><p>Bitte Passwort eingeben.</p>
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="Passwort"><button>Anmelden</button>${error ? `<div class="e">${error}</div>` : ""}</form></body></html>`;
