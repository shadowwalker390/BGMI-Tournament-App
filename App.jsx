import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Shield, Target, Users, Trophy, Wallet, LogOut, Plus, X, Clock,
  MapPin, Crosshair, Radio, ChevronRight, User, Lock, Hash,
  Phone, Swords, Award, Settings, Check, Trash2, Edit3, Coins,
  TrendingUp, Calendar, AlertCircle
} from "lucide-react";
import { storageGet, storageSet, authRegister, authLogin, authLogout, authDeleteCurrentUser } from "./firebase";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const MAPS = ["Erangel", "Miramar", "Sanhok", "Vikendi"];
const PLACEMENT_POINTS = { 1: 10, 2: 6, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1 };
const START_WALLET = 500;

function todayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

// Fixed daily schedule — the same 14 matches run every day until the admin
// edits a specific day's slots (edits are stored per-date and override this
// template only for that date; every other/future day keeps using this).
// Every match, regardless of mode, has a fixed total capacity of 100
// players. maxTeams (the number of boxes/slots) is therefore derived from
// the mode's team size: Squad 25 boxes x4, Duo 50 boxes x2, Solo 100 boxes x1.
const TOTAL_PLAYER_CAP = 100;
const DAILY_SCHEDULE = [
  { time: "10:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 3000, tag: null },
  { time: "11:00", mode: "Duo", entryFee: 30, maxTeams: 50, prizePool: 1200, tag: null },
  { time: "12:00", mode: "Solo", entryFee: 40, maxTeams: 100, prizePool: 1600, tag: null },
  { time: "13:00", mode: "Solo", entryFee: 40, maxTeams: 100, prizePool: 1600, tag: null },
  { time: "14:00", mode: "Duo", entryFee: 30, maxTeams: 50, prizePool: 1200, tag: null },
  { time: "15:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 3000, tag: null },
  { time: "16:00", mode: "Duo", entryFee: 30, maxTeams: 50, prizePool: 1200, tag: null },
  { time: "17:00", mode: "Duo", entryFee: 30, maxTeams: 50, prizePool: 1200, tag: null },
  { time: "18:00", mode: "Solo", entryFee: 40, maxTeams: 100, prizePool: 1600, tag: null },
  { time: "19:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 3000, tag: null },
  { time: "20:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 3000, tag: null },
  { time: "21:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 3000, tag: null },
  { time: "22:00", mode: "Duo", entryFee: 30, maxTeams: 50, prizePool: 1200, tag: null },
  { time: "23:00", mode: "Squad", entryFee: 50, maxTeams: 25, prizePool: 5000, tag: null },
];

function defaultSlotsFor(dateStr) {
  const seed = dateStr.split("-").reduce((a, n) => a + parseInt(n, 10), 0);
  const map = (i) => MAPS[(seed + i) % MAPS.length];
  return DAILY_SCHEDULE.map((s, i) => ({
    id: `${dateStr}-${i + 1}`,
    mode: s.mode,
    map: map(i),
    time: s.time,
    maxTeams: s.maxTeams,
    entryFee: s.entryFee,
    prizePool: s.prizePool,
    bookedTeams: [],
    results: null,
    tag: s.tag,
    cancelled: false,
  }));
}

// Converts a 24-hour "HH:MM" time string (used internally for all date math)
// into a 12-hour display string like "6:00 PM".
function fmtTime12(time) {
  const [hStr, mStr] = time.split(":");
  let h = parseInt(hStr, 10);
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mStr} ${period}`;
}

// Team-based registration pricing: ₹{entryFee} per player registering alone,
// or ₹{entryFee * teamSize} to register a full team (Squad = 4, Duo = 2) in
// one go. Solo matches have a team size of 1 (flat entry fee, no grouping).
const SQUAD_SIZE = 4;
const TEAM_SIZE = { Squad: 4, Duo: 2, Solo: 1 };

function teamSizeFor(mode) {
  return TEAM_SIZE[mode] || 1;
}
function isTeamMode(mode) {
  return mode === "Squad" || mode === "Duo";
}
// Kept for any external callers expecting the old name.
function boxCapacityFor(mode) {
  return teamSizeFor(mode);
}

// Builds the numbered seat-map boxes for a slot: #1..maxTeams, each holding
// up to teamSizeFor(mode) players. Squad and Duo boxes can be partially
// filled by solo registrants (or claimed whole by one Full Squad/Full Duo
// registration); Solo boxes are all-or-nothing (booking a box fills it).
function buildBoxes(slot) {
  const cap = teamSizeFor(slot.mode);
  const boxes = Array.from({ length: slot.maxTeams }, (_, i) => ({ number: i + 1, registrations: [], cap }));
  slot.bookedTeams.forEach((b) => {
    const idx = (b.boxNumber || 1) - 1;
    if (boxes[idx]) boxes[idx].registrations.push(b);
  });
  boxes.forEach((b) => {
    b.occupied = b.registrations.reduce((s, r) => s + (r.regType === "full" ? cap : 1), 0);
    b.full = b.occupied >= b.cap;
  });
  return boxes;
}

function teamPlayerCount(slot) {
  const size = teamSizeFor(slot.mode);
  return slot.bookedTeams.reduce((sum, b) => sum + (b.regType === "full" ? size : 1), 0);
}


function slotDateTime(dateStr, time) {
  return new Date(`${dateStr}T${time}:00`);
}

// A match is "live" from its start time until either the next scheduled
// match of the day begins (nextTime), or — if it's the last match of the
// day — a fixed 90-minute grace window elapses. This means e.g. the 4PM
// match is automatically marked "done" the moment the 5PM match kicks off.
function slotStatus(dateStr, time, now, nextTime) {
  const start = slotDateTime(dateStr, time);
  const diffMs = start - now;
  if (diffMs > 0) {
    if (diffMs < 1000 * 60 * 60 * 3) return "soon";
    return "scheduled";
  }
  if (nextTime) {
    const nextStart = slotDateTime(dateStr, nextTime);
    return now >= nextStart ? "done" : "live";
  }
  if (diffMs < -1000 * 60 * 90) return "done";
  return "live";
}

function timeRemainingLabel(dateStr, time, now, status) {
  if (status === "done") return "COMPLETED";
  const start = slotDateTime(dateStr, time);
  const diffMs = start - now;
  if (diffMs <= 0) return "LIVE NOW";
  const mins = Math.floor(diffMs / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function ringProgress(dateStr, time, now) {
  const start = slotDateTime(dateStr, time);
  const windowMs = 1000 * 60 * 60 * 3;
  const diffMs = start - now;
  const pct = Math.max(0, Math.min(1, 1 - diffMs / windowMs));
  return pct;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const FONT_LINK = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Rajdhani:wght@500;600;700&family=JetBrains+Mono:wght@400;600&display=swap";

const COLORS = {
  bg: "#0A0F0A",
  bgGrid: "#0D130D",
  panel: "#121810",
  panel2: "#161F13",
  border: "#2A3324",
  borderBright: "#3D4A34",
  text: "#E7ECDE",
  textDim: "#8A9480",
  textFaint: "#5C6653",
  danger: "#FF4433",
  gold: "#FFB627",
  cyan: "#3ED6C4",
  lime: "#C6FF3D",
};

function GlobalStyle() {
  return (
    <style>{`
      @import url('${FONT_LINK}');
      * { box-sizing: border-box; }
      .bgmi-root {
        font-family: 'Rajdhani', sans-serif;
        background: ${COLORS.bg};
        background-image:
          linear-gradient(${COLORS.bgGrid} 1px, transparent 1px),
          linear-gradient(90deg, ${COLORS.bgGrid} 1px, transparent 1px);
        background-size: 28px 28px;
        color: ${COLORS.text};
        min-height: 100vh;
        width: 100%;
      }
      .bgmi-display { font-family: 'Chakra Petch', sans-serif; }
      .bgmi-mono { font-family: 'JetBrains Mono', monospace; }
      .bgmi-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
      .bgmi-scroll::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 3px; }
      @keyframes bgmi-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
      .bgmi-live-dot { animation: bgmi-pulse 1.4s ease-in-out infinite; }
      @keyframes bgmi-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .bgmi-fade-in { animation: bgmi-fade 0.35s ease both; }
      .bgmi-btn { transition: all 0.15s ease; cursor: pointer; }
      .bgmi-btn:active { transform: scale(0.97); }
      input.bgmi-input, select.bgmi-input {
        background: ${COLORS.bg};
        border: 1px solid ${COLORS.border};
        color: ${COLORS.text};
        font-family: 'Rajdhani', sans-serif;
        font-weight: 600;
        outline: none;
      }
      input.bgmi-input:focus, select.bgmi-input:focus {
        border-color: ${COLORS.cyan};
      }
      .bgmi-tab-underline {
        position: relative;
      }
      .bgmi-tab-underline.active::after {
        content: '';
        position: absolute;
        left: 0; right: 0; bottom: -1px;
        height: 2px;
        background: ${COLORS.cyan};
      }
    `}</style>
  );
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function Badge({ children, color = COLORS.textDim, bg = "transparent", border }) {
  return (
    <span
      className="bgmi-display"
      style={{
        fontSize: 11, letterSpacing: 1, fontWeight: 600, padding: "3px 8px",
        color, background: bg, border: border ? `1px solid ${border}` : "none",
        textTransform: "uppercase", borderRadius: 2, display: "inline-flex", alignItems: "center", gap: 4,
      }}
    >
      {children}
    </span>
  );
}

function DeployRing({ pct, status, size = 46 }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const color = status === "live" ? COLORS.lime : status === "soon" ? COLORS.gold : COLORS.cyan;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={COLORS.border} strokeWidth="3" fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="3" fill="none"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <Target size={16} color={color} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }} />
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, danger, style, type = "button" }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="bgmi-btn bgmi-display"
      style={{
        background: disabled ? COLORS.border : danger ? COLORS.danger : COLORS.cyan,
        color: disabled ? COLORS.textFaint : "#0A0F0A",
        border: "none", padding: "10px 16px", fontSize: 13, fontWeight: 700,
        letterSpacing: 0.5, textTransform: "uppercase", borderRadius: 2,
        cursor: disabled ? "not-allowed" : "pointer", ...style,
      }}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, style }) {
  return (
    <button
      onClick={onClick}
      className="bgmi-btn bgmi-display"
      style={{
        background: "transparent", color: COLORS.textDim, border: `1px solid ${COLORS.border}`,
        padding: "9px 14px", fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
        textTransform: "uppercase", borderRadius: 2, cursor: "pointer", ...style,
      }}
    >
      {children}
    </button>
  );
}

function Field({ icon: Icon, ...props }) {
  return (
    <div style={{ position: "relative" }}>
      <Icon size={16} color={COLORS.textFaint} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }} />
      <input
        className="bgmi-input"
        style={{ width: "100%", padding: "11px 12px 11px 34px", fontSize: 15, borderRadius: 2 }}
        {...props}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth Screen
// ---------------------------------------------------------------------------

function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [playerId, setPlayerId] = useState("");
  const [password, setPassword] = useState("");
  const [ign, setIgn] = useState("");
  const [bgmiUid, setBgmiUid] = useState("");
  const [mobile, setMobile] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    if (!playerId.trim() || !password.trim()) { setError("Player ID and password are required."); return; }
    setBusy(true);
    try {
      const key = playerId.trim().toLowerCase();

      if (mode === "register") {
        if (!ign.trim() || !bgmiUid.trim()) { setError("Fill in your IGN and BGMI UID."); return; }
        if (password.length < 6) { setError("Password must be at least 6 characters."); return; }

        // Firebase Auth enforces unique Player IDs (auth/email-already-in-use).
        // Passwords are hashed and stored by Firebase Auth, never in Firestore.
        await authRegister(key, password);

        // Firestore now requires a signed-in user, so the profile is read and
        // written only after the account exists.
        const users = (await storageGet("users", true)) || {};
        if (users[key]) {
          // A profile already exists for this Player ID (e.g. the admin's).
          // Remove the account we just created so it can't claim that profile.
          try { await authDeleteCurrentUser(); } catch (e) { await authLogout(); }
          setError("That Player ID is already taken.");
          return;
        }
        const newUser = {
          playerId: playerId.trim(), ign: ign.trim(), bgmiUid: bgmiUid.trim(),
          mobile: mobile.trim(), wallet: START_WALLET, isAdmin: false, kills: 0, wins: 0, matches: 0, points: 0,
        };
        users[key] = newUser;
        const ok = await storageSet("users", users, true);
        if (!ok) { setError("Account created but profile save failed. Please try logging in."); return; }
        onLogin(newUser);
      } else {
        try {
          await authLogin(key, password);
        } catch (authErr) {
          setError("Invalid Player ID or password.");
          return;
        }
        const users = (await storageGet("users", true)) || {};
        const u = users[key];
        if (!u) { await authLogout(); setError("No profile found for this account. Contact an admin."); return; }
        onLogin(u);
      }
    } catch (err) {
      console.error("Auth error:", err);
      const message =
        err && err.code === "auth/email-already-in-use" ? "That Player ID is already taken." :
        err && err.code === "auth/weak-password" ? "Password must be at least 6 characters." :
        "Something went wrong: " + (err && err.message ? err.message : String(err));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bgmi-root" style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <GlobalStyle />
      {/* Hero */}
      <div style={{ padding: "40px 24px 24px", textAlign: "center", position: "relative", overflow: "hidden" }}>
        <div style={{
          position: "absolute", top: -40, left: "50%", transform: "translateX(-50%)",
          width: 260, height: 260, borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.cyan}22 0%, transparent 70%)`,
        }} />
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <div style={{ border: `1px solid ${COLORS.borderBright}`, borderRadius: "50%", padding: 14, background: COLORS.panel }}>
              <Crosshair size={30} color={COLORS.cyan} />
            </div>
          </div>
          <div className="bgmi-display" style={{ fontSize: 30, fontWeight: 700, letterSpacing: 2 }}>
            OPERATION <span style={{ color: COLORS.cyan }}>ARENA</span>
          </div>
          <div className="bgmi-mono" style={{ fontSize: 12, color: COLORS.textDim, letterSpacing: 3, marginTop: 4 }}>
            BGMI TOURNAMENT COMMAND
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div style={{ flex: 1, padding: "0 20px 32px", display: "flex", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: 380 }}>
          <div style={{ display: "flex", borderBottom: `1px solid ${COLORS.border}`, marginBottom: 22 }}>
            {["login", "register"].map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(""); }}
                className={`bgmi-display bgmi-tab-underline ${mode === m ? "active" : ""}`}
                style={{
                  flex: 1, background: "none", border: "none", padding: "10px 0", cursor: "pointer",
                  color: mode === m ? COLORS.text : COLORS.textFaint, fontSize: 14, fontWeight: 700,
                  letterSpacing: 1, textTransform: "uppercase",
                }}
              >
                {m === "login" ? "Deploy (Login)" : "Enlist (Register)"}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field icon={User} placeholder="Player ID" value={playerId} onChange={(e) => setPlayerId(e.target.value)} autoCapitalize="none" />
            {mode === "register" && (
              <>
                <Field icon={Target} placeholder="In-Game Name (IGN)" value={ign} onChange={(e) => setIgn(e.target.value)} />
                <Field icon={Hash} placeholder="BGMI UID" value={bgmiUid} onChange={(e) => setBgmiUid(e.target.value)} inputMode="numeric" />
                <Field icon={Phone} placeholder="Mobile number (optional)" value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" />
              </>
            )}
            <Field icon={Lock} placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />

            {error && (
              <div style={{ display: "flex", gap: 6, alignItems: "flex-start", color: COLORS.danger, fontSize: 13, fontWeight: 600 }}>
                <AlertCircle size={15} style={{ marginTop: 1, flexShrink: 0 }} /> {error}
              </div>
            )}

            <PrimaryButton onClick={submit} disabled={busy} style={{ marginTop: 8, padding: "13px 16px", fontSize: 14 }}>
              {busy ? "Standby..." : mode === "login" ? "Drop In" : "Create Account"}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Slot Card
// ---------------------------------------------------------------------------

function SlotCard({ slot, dateStr, now, nextTime, user, onJoin, onViewPlayers, isAdmin, onEdit, onDelete, onCancelMatch, onResults, onRoster }) {
  const status = slot.cancelled ? "cancelled" : slotStatus(dateStr, slot.time, now, nextTime);
  const pct = ringProgress(dateStr, slot.time, now);
  const joined = slot.bookedTeams.some((t) => t.playerId === user.playerId);
  const teamMode = isTeamMode(slot.mode);
  const teamSize = teamSizeFor(slot.mode);
  const maxPlayers = slot.maxTeams * teamSize;
  const playersRegistered = teamPlayerCount(slot);
  const capMax = maxPlayers;
  const full = playersRegistered >= maxPlayers;
  const modeIcon = slot.mode === "Solo" ? User : slot.mode === "Duo" ? Users : Swords;
  const ModeIcon = modeIcon;

  return (
    <div
      className="bgmi-fade-in"
      style={{
        background: COLORS.panel, border: `1px solid ${status === "live" ? COLORS.lime + "55" : COLORS.border}`,
        borderRadius: 3, padding: 14, position: "relative", overflow: "hidden",
      }}
    >
      {slot.cancelled ? (
        <div style={{ position: "absolute", top: 0, right: 0 }}>
          <Badge color="#0A0F0A" bg={COLORS.danger}>Cancelled — Refunded</Badge>
        </div>
      ) : slot.tag && (
        <div style={{ position: "absolute", top: 0, right: 0 }}>
          <Badge color="#0A0F0A" bg={COLORS.gold}>{slot.tag}</Badge>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <DeployRing pct={pct} status={status} />
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ModeIcon size={14} color={COLORS.cyan} />
              <span className="bgmi-display" style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.5 }}>{slot.mode}</span>
              {status === "live" && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span className="bgmi-live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.lime }} />
                  <span className="bgmi-mono" style={{ fontSize: 10, color: COLORS.lime, fontWeight: 600 }}>LIVE</span>
                </span>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 2, color: COLORS.textDim, fontSize: 12 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}><MapPin size={11} />{slot.map}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 3 }}><Clock size={11} />{fmtTime12(slot.time)}</span>
            </div>
          </div>
        </div>
        <div className="bgmi-mono" style={{ textAlign: "right", fontSize: 11, color: COLORS.textDim, whiteSpace: "nowrap" }}>
          {timeRemainingLabel(dateStr, slot.time, now, status)}
        </div>
      </div>

      {/* capacity bar */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: COLORS.textDim, marginBottom: 3 }}>
          <span className="bgmi-mono">
            {teamMode ? `${playersRegistered}/${capMax} PLAYERS REGISTERED` : `${slot.bookedTeams.length}/${slot.maxTeams} PLAYERS REGISTERED`}
          </span>
          <span className="bgmi-mono" style={{ color: COLORS.gold, display: "flex", alignItems: "center", gap: 3 }}>
            <Trophy size={11} /> ₹{slot.prizePool}
          </span>
        </div>
        <div style={{ height: 4, background: COLORS.border, borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${Math.min(100, (playersRegistered / capMax) * 100)}%`, background: full ? COLORS.danger : COLORS.cyan }} />
        </div>
        {full && !slot.cancelled && (
          <div className="bgmi-display" style={{ color: COLORS.danger, fontSize: 12, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 5 }}>
            All Slots Booked
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, color: COLORS.gold, fontSize: 13 }}>
          <Coins size={13} />
          {teamMode ? (
            <span className="bgmi-mono" style={{ fontWeight: 600 }}>₹{slot.entryFee}/player · ₹{slot.entryFee * teamSize} {slot.mode === "Duo" ? "Duo" : `full ${slot.mode.toLowerCase()}`}</span>
          ) : (
            <>
              <span className="bgmi-mono" style={{ fontWeight: 600 }}>₹{slot.entryFee}</span>
              <span style={{ color: COLORS.textFaint, fontSize: 11 }}>entry</span>
            </>
          )}
        </div>

        {slot.cancelled ? (
          <Badge border={COLORS.danger + "66"} color={COLORS.danger}>Cancelled</Badge>
        ) : status === "done" ? (
          <Badge border={COLORS.border} color={COLORS.textFaint}>Completed</Badge>
        ) : joined ? (
          <Badge border={COLORS.lime + "55"} color={COLORS.lime}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><Check size={12} /> Registered — No Refund</span>
          </Badge>
        ) : status === "live" ? (
          <Badge bg={COLORS.lime + "22"} color={COLORS.lime} border={COLORS.lime + "66"}>Registration Closed</Badge>
        ) : full ? (
          <Badge bg={COLORS.danger + "22"} color={COLORS.danger} border={COLORS.danger}>All Slots Booked</Badge>
        ) : (
          <PrimaryButton onClick={() => onJoin(slot)}>Register</PrimaryButton>
        )}
      </div>

      <button
        onClick={() => onViewPlayers(slot)}
        className="bgmi-btn bgmi-mono"
        style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", padding: 0, marginTop: 10, color: COLORS.textDim, fontSize: 11, cursor: "pointer" }}
      >
        <Users size={12} /> View registered players ({playersRegistered})
      </button>

      {isAdmin && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: `1px dashed ${COLORS.border}`, flexWrap: "wrap" }}>
          <GhostButton onClick={() => onEdit(slot)} style={{ flex: 1 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><Edit3 size={12} /> Edit</span></GhostButton>
          {teamMode && (
            <GhostButton onClick={() => onRoster(slot)} style={{ flex: 1 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><Users size={12} /> Roster</span></GhostButton>
          )}
          <GhostButton onClick={() => onResults(slot)} style={{ flex: 1 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}><Award size={12} /> Results</span></GhostButton>
          {!slot.cancelled && slot.bookedTeams.length > 0 && (
            <GhostButton onClick={() => onCancelMatch(slot)} style={{ color: COLORS.danger, borderColor: COLORS.danger + "55" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}><AlertCircle size={12} /> Cancel & Refund</span>
            </GhostButton>
          )}
          {slot.bookedTeams.length === 0 && (
            <GhostButton onClick={() => onDelete(slot)} style={{ color: COLORS.danger, borderColor: COLORS.danger + "55" }}><Trash2 size={12} /></GhostButton>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Registered players for a single match — admin sees IGN + UID, players see
// IGN only.
// ---------------------------------------------------------------------------

function SlotPlayersModal({ slot, users, isAdmin, onClose }) {
  const entries = [];
  slot.bookedTeams.forEach((b) => {
    const acct = users[(b.playerId || "").toLowerCase()];
    entries.push({
      ign: b.ign,
      uid: (acct && acct.bgmiUid) || "—",
      teamName: b.teamName || null,
      role: b.regType === "full" ? "Captain" : null,
    });
    if (b.regType === "full" && Array.isArray(b.teammates)) {
      b.teammates.forEach((t) => {
        if (t.ign && t.ign.trim()) {
          entries.push({ ign: t.ign, uid: (t.uid && t.uid.trim()) || "—", teamName: b.teamName || null, role: "Teammate" });
        }
      });
    }
  });

  return (
    <Modal title={`${slot.mode} Players — ${fmtTime12(slot.time)}`} onClose={onClose}>
      <div className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textFaint, marginBottom: 12 }}>
        {entries.length} player{entries.length === 1 ? "" : "s"} registered
      </div>
      {entries.length === 0 ? (
        <div style={{ color: COLORS.textDim, fontSize: 13 }}>No players have registered for this match yet.</div>
      ) : (
        <div className="bgmi-scroll" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" }}>
          {entries.map((e, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", border: `1px solid ${COLORS.border}`, borderRadius: 2, padding: "9px 10px" }}>
              <div>
                <span className="bgmi-display" style={{ fontSize: 13, fontWeight: 700, color: COLORS.text }}>{e.ign}</span>
                {isAdmin && e.teamName && (
                  <span className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, marginLeft: 6 }}>· {e.teamName}</span>
                )}
                {isAdmin && e.role && (
                  <span className="bgmi-mono" style={{ fontSize: 10, color: COLORS.cyan, marginLeft: 6 }}>{e.role}</span>
                )}
              </div>
              {isAdmin && (
                <span className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textDim }}>UID: {e.uid}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Admin: Slot editor modal
// ---------------------------------------------------------------------------

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000cc", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div
        className="bgmi-fade-in bgmi-scroll"
        style={{ background: COLORS.panel2, border: `1px solid ${COLORS.border}`, borderBottom: "none", width: "100%", maxWidth: 460, maxHeight: "85vh", overflowY: "auto", borderRadius: "8px 8px 0 0", padding: 20 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="bgmi-display" style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.5 }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer" }}><X size={20} color={COLORS.textDim} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function SlotEditorModal({ slot, onSave, onClose }) {
  const [form, setForm] = useState(slot);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal title={slot.id.includes("new") ? "New Slot" : "Edit Slot"} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Mode</label>
        <select className="bgmi-input" style={{ padding: 10, borderRadius: 2 }} value={form.mode} onChange={(e) => set("mode", e.target.value)}>
          <option>Solo</option><option>Duo</option><option>Squad</option>
        </select>
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Map</label>
        <select className="bgmi-input" style={{ padding: 10, borderRadius: 2 }} value={form.map} onChange={(e) => set("map", e.target.value)}>
          {MAPS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Start time</label>
        <input className="bgmi-input" type="time" style={{ padding: 10, borderRadius: 2 }} value={form.time} onChange={(e) => set("time", e.target.value)} />
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Max squads/teams</label>
        <input className="bgmi-input" type="number" style={{ padding: 10, borderRadius: 2 }} value={form.maxTeams} onChange={(e) => set("maxTeams", parseInt(e.target.value) || 0)} />
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Entry fee (₹)</label>
        <input className="bgmi-input" type="number" style={{ padding: 10, borderRadius: 2 }} value={form.entryFee} onChange={(e) => set("entryFee", parseInt(e.target.value) || 0)} />
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Prize pool (₹)</label>
        <input className="bgmi-input" type="number" style={{ padding: 10, borderRadius: 2 }} value={form.prizePool} onChange={(e) => set("prizePool", parseInt(e.target.value) || 0)} />
        <label style={{ fontSize: 11, color: COLORS.textDim }}>Tag (optional, e.g. GRAND FINALE)</label>
        <input className="bgmi-input" style={{ padding: 10, borderRadius: 2 }} value={form.tag || ""} onChange={(e) => set("tag", e.target.value || null)} />
        <PrimaryButton onClick={() => onSave(form)} style={{ marginTop: 8, padding: 12 }}>Save Slot</PrimaryButton>
      </div>
    </Modal>
  );
}

function ResultsModal({ slot, onSubmit, onClose }) {
  const [rows, setRows] = useState(slot.bookedTeams.map((t) => ({ ...t, position: "", kills: 0 })));
  const setRow = (i, k, v) => setRows((r) => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row));
  return (
    <Modal title={`Match Results — ${slot.mode} ${fmtTime12(slot.time)}`} onClose={onClose}>
      {rows.length === 0 ? (
        <div style={{ color: COLORS.textDim, fontSize: 13 }}>No teams joined this slot.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((row, i) => (
            <div key={row.playerId} style={{ display: "flex", gap: 8, alignItems: "center", border: `1px solid ${COLORS.border}`, padding: 8, borderRadius: 2 }}>
              <div style={{ flex: 1 }}>
                <div className="bgmi-display" style={{ fontSize: 13, fontWeight: 700 }}>{row.teamName || row.ign}</div>
                <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint }}>{row.ign}</div>
              </div>
              <input className="bgmi-input" placeholder="Pos" type="number" style={{ width: 54, padding: 8, borderRadius: 2 }} value={row.position} onChange={(e) => setRow(i, "position", e.target.value)} />
              <input className="bgmi-input" placeholder="Kills" type="number" style={{ width: 60, padding: 8, borderRadius: 2 }} value={row.kills} onChange={(e) => setRow(i, "kills", parseInt(e.target.value) || 0)} />
            </div>
          ))}
          <PrimaryButton onClick={() => onSubmit(rows)} style={{ marginTop: 4, padding: 12 }}>Submit Results</PrimaryButton>
        </div>
      )}
    </Modal>
  );
}

function RosterModal({ slot, onGroup, onClose }) {
  const teamSize = teamSizeFor(slot.mode);
  const fullSquads = slot.bookedTeams.filter((b) => b.regType === "full");
  const grouped = {};
  const unassigned = [];
  slot.bookedTeams.filter((b) => b.regType === "solo").forEach((b) => {
    if (b.teamName) {
      grouped[b.teamName] = grouped[b.teamName] || [];
      grouped[b.teamName].push(b);
    } else {
      unassigned.push(b);
    }
  });

  const [selected, setSelected] = useState([]);
  const [groupName, setGroupName] = useState("");

  const toggle = (playerId) => setSelected((s) => s.includes(playerId) ? s.filter((id) => id !== playerId) : s.length < teamSize ? [...s, playerId] : s);

  const submitGroup = () => {
    if (!groupName.trim() || selected.length === 0) return;
    onGroup(selected, groupName.trim());
    setSelected([]);
    setGroupName("");
  };

  return (
    <Modal title={`${slot.mode} Roster — ${fmtTime12(slot.time)}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {fullSquads.length > 0 && (
          <div>
            <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", marginBottom: 6 }}>Full {slot.mode.toLowerCase()}s ({fullSquads.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {fullSquads.map((b) => (
                <div key={b.playerId} style={{ border: `1px solid ${COLORS.border}`, borderRadius: 2, padding: 8 }}>
                  <div className="bgmi-display" style={{ fontSize: 13, fontWeight: 700, color: COLORS.cyan }}>{b.teamName}</div>
                  <div className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>
                    {b.ign} (captain){b.teammates && b.teammates.map((t, i) => t.ign ? `, ${t.ign}` : "").join("")}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {Object.keys(grouped).length > 0 && (
          <div>
            <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", marginBottom: 6 }}>Admin-grouped {slot.mode.toLowerCase()}s ({Object.keys(grouped).length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {Object.entries(grouped).map(([name, members]) => (
                <div key={name} style={{ border: `1px solid ${COLORS.cyan}55`, borderRadius: 2, padding: 8 }}>
                  <div className="bgmi-display" style={{ fontSize: 13, fontWeight: 700, color: COLORS.cyan }}>{name} <span style={{ color: COLORS.textFaint, fontWeight: 500 }}>({members.length}/{teamSize})</span></div>
                  <div className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textDim, marginTop: 2 }}>{members.map((m) => m.ign).join(", ")}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase", marginBottom: 6 }}>
            Unassigned solo players ({unassigned.length})
          </div>
          {unassigned.length === 0 ? (
            <div style={{ color: COLORS.textDim, fontSize: 12 }}>None — every solo player has been grouped.</div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }} className="bgmi-scroll">
                {unassigned.map((b) => {
                  const isSel = selected.includes(b.playerId);
                  return (
                    <button
                      key={b.playerId}
                      onClick={() => toggle(b.playerId)}
                      className="bgmi-btn"
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left",
                        padding: "9px 10px", borderRadius: 2, cursor: "pointer",
                        background: isSel ? COLORS.cyan + "22" : "transparent",
                        border: `1px solid ${isSel ? COLORS.cyan : COLORS.border}`,
                      }}
                    >
                      <span className="bgmi-display" style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>{b.ign}</span>
                      {isSel && <Check size={14} color={COLORS.cyan} />}
                    </button>
                  );
                })}
              </div>
              <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 8 }}>{selected.length}/{teamSize} selected</div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input className="bgmi-input" placeholder={`${slot.mode} name`} style={{ flex: 1, padding: 10, borderRadius: 2 }} value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                <PrimaryButton onClick={submitGroup} disabled={selected.length === 0 || !groupName.trim()} style={{ padding: "10px 14px" }}>Group</PrimaryButton>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}


function JoinModal({ slot, user, onConfirm, onClose }) {
  const teamMode = isTeamMode(slot.mode);
  const teamSize = teamSizeFor(slot.mode);
  const neededTeammates = Math.max(0, teamSize - 1);
  const maxPlayers = slot.maxTeams * teamSize;
  const remaining = teamMode ? maxPlayers - teamPlayerCount(slot) : null;
  const [regType, setRegType] = useState("solo"); // 'solo' | 'full' — only relevant for Squad/Duo
  const [teamName, setTeamName] = useState("");
  const [teammates, setTeammates] = useState(Array.from({ length: neededTeammates }, () => ({ ign: "", uid: "" })));

  const requiresTeamName = teamMode && regType === "full";
  const fee = teamMode ? (regType === "full" ? slot.entryFee * teamSize : slot.entryFee) : slot.entryFee;
  const canAfford = user.wallet >= fee;
  const fullSquadReady = regType !== "full" || teammates.every((t) => t.ign.trim());
  const ready = (!requiresTeamName || teamName.trim()) && fullSquadReady && canAfford;

  const updateTeammate = (i, k, v) => setTeammates((arr) => arr.map((t, idx) => idx === i ? { ...t, [k]: v } : t));

  return (
    <Modal title={`Register — ${slot.mode} ${fmtTime12(slot.time)}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="bgmi-mono" style={{ fontSize: 12, color: COLORS.textDim, lineHeight: 1.7 }}>
          Map: <span style={{ color: COLORS.text }}>{slot.map}</span><br />
          Your wallet: <span style={{ color: canAfford ? COLORS.lime : COLORS.danger }}>₹{user.wallet}</span>
          {teamMode && <><br />Spots left: <span style={{ color: remaining <= 8 ? COLORS.danger : COLORS.text }}>{remaining}</span></>}
        </div>

        {teamMode && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setRegType("solo")}
              className="bgmi-btn bgmi-display"
              style={{ flex: 1, padding: 10, borderRadius: 2, fontSize: 12, fontWeight: 700, textTransform: "uppercase", cursor: "pointer",
                background: regType === "solo" ? COLORS.cyan : "transparent", color: regType === "solo" ? "#0A0F0A" : COLORS.textDim,
                border: `1px solid ${regType === "solo" ? COLORS.cyan : COLORS.border}` }}
            >
              Solo — ₹{slot.entryFee}
            </button>
            <button
              onClick={() => setRegType("full")}
              className="bgmi-btn bgmi-display"
              style={{ flex: 1, padding: 10, borderRadius: 2, fontSize: 12, fontWeight: 700, textTransform: "uppercase", cursor: "pointer",
                background: regType === "full" ? COLORS.cyan : "transparent", color: regType === "full" ? "#0A0F0A" : COLORS.textDim,
                border: `1px solid ${regType === "full" ? COLORS.cyan : COLORS.border}` }}
            >
              Full {slot.mode} — ₹{slot.entryFee * teamSize}
            </button>
          </div>
        )}
        {teamMode && regType === "solo" && (
          <div className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textFaint, lineHeight: 1.5 }}>
            Registering solo — the tournament admin will group you with other solo players into a {slot.mode.toLowerCase()} before the match.
          </div>
        )}

        {requiresTeamName && (
          <input className="bgmi-input" placeholder="Team name" style={{ padding: 10, borderRadius: 2 }} value={teamName} onChange={(e) => setTeamName(e.target.value)} />
        )}

        {teamMode && regType === "full" && neededTeammates > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase" }}>{neededTeammates} teammate{neededTeammates === 1 ? "" : "s"} (you're player 1)</div>
            {teammates.map((t, i) => (
              <div key={i} style={{ display: "flex", gap: 6 }}>
                <input className="bgmi-input" placeholder={`Teammate ${i + 2} IGN`} style={{ flex: 2, padding: 9, borderRadius: 2, fontSize: 13 }} value={t.ign} onChange={(e) => updateTeammate(i, "ign", e.target.value)} />
                <input className="bgmi-input" placeholder="UID" style={{ flex: 1, padding: 9, borderRadius: 2, fontSize: 13 }} value={t.uid} onChange={(e) => updateTeammate(i, "uid", e.target.value)} />
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, color: COLORS.danger, fontSize: 11, fontWeight: 600, lineHeight: 1.5 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          Entry fees are non-refundable once registered, unless the admin cancels this match.
        </div>

        {!canAfford ? (
          <div style={{ color: COLORS.danger, fontSize: 13, fontWeight: 600 }}>Insufficient balance. Top up your wallet first.</div>
        ) : (
          <PrimaryButton
            onClick={() => onConfirm({ teamName: requiresTeamName ? (teamName || slot.mode) : null, regType: teamMode ? regType : "solo", fee, teammates: teamMode && regType === "full" ? teammates : [] })}
            disabled={!ready}
            style={{ padding: 12 }}
          >
            Confirm Registration (₹{fee})
          </PrimaryButton>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function LeaderboardView({ users }) {
  const rows = Object.values(users)
    .filter((u) => !u.isAdmin)
    .map((u) => ({ ...u, points: u.points || 0 }))
    .sort((a, b) => b.points - a.points);

  const medalColor = (i) => i === 0 ? COLORS.gold : i === 1 ? "#C9CED4" : i === 2 ? "#C88A4A" : COLORS.textFaint;

  return (
    <div className="bgmi-fade-in" style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 16px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0" }}>
        <Trophy size={18} color={COLORS.gold} />
        <span className="bgmi-display" style={{ fontSize: 18, fontWeight: 700 }}>OVERALL STANDINGS</span>
      </div>
      {rows.length === 0 && <div style={{ color: COLORS.textDim, fontSize: 13 }}>No results submitted yet. Check back after matches conclude.</div>}
      {rows.map((u, i) => (
        <div key={u.playerId} style={{ display: "flex", alignItems: "center", gap: 12, background: COLORS.panel, border: `1px solid ${i < 3 ? medalColor(i) + "55" : COLORS.border}`, borderRadius: 3, padding: 12 }}>
          <div className="bgmi-display" style={{ width: 26, textAlign: "center", fontSize: 15, fontWeight: 700, color: medalColor(i) }}>
            {i + 1}
          </div>
          <div style={{ flex: 1 }}>
            <div className="bgmi-display" style={{ fontSize: 14, fontWeight: 700 }}>{u.ign}</div>
            <div className="bgmi-mono" style={{ fontSize: 11, color: COLORS.textFaint }}>{u.matches || 0} matches · {u.kills || 0} kills · {u.wins || 0} wins</div>
          </div>
          <div className="bgmi-mono" style={{ fontSize: 16, fontWeight: 700, color: COLORS.cyan }}>{u.points}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileView({ user, onLogout, onTopUp, onRenameIGN }) {
  const [editing, setEditing] = useState(false);
  const [newIgn, setNewIgn] = useState(user.ign);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startEdit = () => { setNewIgn(user.ign); setError(""); setEditing(true); };
  const cancelEdit = () => { setEditing(false); setError(""); };
  const save = async () => {
    const trimmed = newIgn.trim();
    if (!trimmed) { setError("IGN can't be empty."); return; }
    setBusy(true);
    const ok = await onRenameIGN(trimmed);
    setBusy(false);
    if (ok) setEditing(false); else setError("Could not save. Please try again.");
  };

  return (
    <div className="bgmi-fade-in" style={{ padding: "20px 16px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: 20, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: COLORS.panel2, border: `2px solid ${COLORS.cyan}`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 10px" }}>
          <Shield size={28} color={COLORS.cyan} />
        </div>

        {editing ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 260, margin: "0 auto" }}>
            <input
              className="bgmi-input" style={{ padding: 9, borderRadius: 2, textAlign: "center" }}
              value={newIgn} onChange={(e) => setNewIgn(e.target.value)} maxLength={24} autoFocus
            />
            {error && <div style={{ color: COLORS.danger, fontSize: 11 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <GhostButton onClick={cancelEdit} style={{ flex: 1 }}>Cancel</GhostButton>
              <PrimaryButton onClick={save} disabled={busy} style={{ flex: 1 }}>{busy ? "Saving..." : "Save"}</PrimaryButton>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
            <div className="bgmi-display" style={{ fontSize: 18, fontWeight: 700 }}>{user.ign}</div>
            <button onClick={startEdit} className="bgmi-btn" style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}>
              <Edit3 size={14} color={COLORS.textFaint} />
            </button>
          </div>
        )}

        <div className="bgmi-mono" style={{ fontSize: 12, color: COLORS.textFaint, marginTop: 2 }}>UID {user.bgmiUid} · @{user.playerId}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        {[["Matches", user.matches || 0], ["Kills", user.kills || 0], ["Wins", user.wins || 0]].map(([label, val]) => (
          <div key={label} style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 3, padding: "12px 8px", textAlign: "center" }}>
            <div className="bgmi-display" style={{ fontSize: 20, fontWeight: 700, color: COLORS.cyan }}>{val}</div>
            <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, textTransform: "uppercase" }}>{label}</div>
          </div>
        ))}
      </div>

      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 4, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Wallet size={18} color={COLORS.gold} />
            <span className="bgmi-display" style={{ fontSize: 14, fontWeight: 700 }}>WALLET</span>
          </div>
          <span className="bgmi-mono" style={{ fontSize: 18, fontWeight: 700, color: COLORS.gold }}>₹{user.wallet}</span>
        </div>
        <GhostButton onClick={() => onTopUp(500)} style={{ width: "100%", marginTop: 12 }}>+ Demo Top-up ₹500</GhostButton>
        {user.isAdmin && (
          <GhostButton
            onClick={() => onTopUp(50000)}
            style={{ width: "100%", marginTop: 8, borderColor: COLORS.gold + "66", color: COLORS.gold }}
          >
            + Admin Test Top-up ₹50,000
          </GhostButton>
        )}
        <div className="bgmi-mono" style={{ fontSize: 10, color: COLORS.textFaint, marginTop: 8, lineHeight: 1.5 }}>
          Simulated balance for this prototype — no real payment is processed.
        </div>
      </div>

      <GhostButton onClick={onLogout} style={{ borderColor: COLORS.danger + "55", color: COLORS.danger }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><LogOut size={14} /> Log Out</span>
      </GhostButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState("home");
  const [dateStr, setDateStr] = useState(todayStr(0));
  const [slots, setSlots] = useState([]);
  const [users, setUsers] = useState({});
  const [now, setNow] = useState(new Date());
  const [joinTarget, setJoinTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [resultsTarget, setResultsTarget] = useState(null);
  const [rosterTarget, setRosterTarget] = useState(null);
  const [playersTarget, setPlayersTarget] = useState(null);
  const [toast, setToast] = useState(null);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  // tick clock
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const loadSlots = useCallback(async (ds) => {
    let s = await storageGet(`slots:${ds}`, true);
    if (!s) {
      s = defaultSlotsFor(ds);
      await storageSet(`slots:${ds}`, s, true);
    }
    setSlots(s);
  }, []);

  useEffect(() => { if (user) loadSlots(dateStr); }, [dateStr, user, loadSlots]);

  const refreshUsers = async () => {
    const u = (await storageGet("users", true)) || {};
    setUsers(u);
    if (user) setUser(u[user.playerId.toLowerCase()] || user);
  };

  const saveSlots = async (next) => {
    setSlots(next);
    await storageSet(`slots:${dateStr}`, next, true);
  };

  const handleLogin = async (u) => {
    setUser(u);
    const all = (await storageGet("users", true)) || {};
    setUsers(all);
  };

  const handleJoinConfirm = async ({ teamName, regType, fee, teammates }) => {
    const slot = joinTarget;
    const key = user.playerId.toLowerCase();
    const allUsers = (await storageGet("users", true)) || {};
    const freshUser = allUsers[key];
    if (freshUser.wallet < fee) { flash("Insufficient balance."); setJoinTarget(null); return; }
    freshUser.wallet -= fee;
    allUsers[key] = freshUser;
    await storageSet("users", allUsers, true);
    setUsers(allUsers);
    setUser(freshUser);

    const nextSlots = slots.map((s) => s.id === slot.id
      ? { ...s, bookedTeams: [...s.bookedTeams, { playerId: user.playerId, ign: user.ign, teamName, regType, fee, teammates }] }
      : s);
    await saveSlots(nextSlots);
    setJoinTarget(null);
    flash(regType === "full" ? "Full squad registered — no refunds." : "Registered — no refunds.");
  };

  const handleCancelMatch = async (slot) => {
    const allUsers = (await storageGet("users", true)) || {};
    slot.bookedTeams.forEach((booking) => {
      const key = booking.playerId.toLowerCase();
      const u = allUsers[key];
      if (u) u.wallet += booking.fee;
    });
    await storageSet("users", allUsers, true);
    setUsers(allUsers);
    if (allUsers[user.playerId.toLowerCase()]) setUser(allUsers[user.playerId.toLowerCase()]);

    const nextSlots = slots.map((s) => s.id === slot.id ? { ...s, cancelled: true } : s);
    await saveSlots(nextSlots);
    flash("Match cancelled — all entry fees refunded.");
  };

  const handleGroupSolos = async (playerIds, groupName) => {
    const nextSlots = slots.map((s) => s.id !== rosterTarget.id ? s : {
      ...s,
      bookedTeams: s.bookedTeams.map((b) => playerIds.includes(b.playerId) ? { ...b, teamName: groupName } : b),
    });
    await saveSlots(nextSlots);
    setRosterTarget(nextSlots.find((s) => s.id === rosterTarget.id));
    flash(`Grouped ${playerIds.length} player${playerIds.length === 1 ? "" : "s"} into "${groupName}".`);
  };


  const handleTopUp = async (amount = 500) => {
    const key = user.playerId.toLowerCase();
    const allUsers = (await storageGet("users", true)) || {};
    allUsers[key].wallet += amount;
    await storageSet("users", allUsers, true);
    setUsers(allUsers);
    setUser(allUsers[key]);
    flash(`₹${amount} added (demo top-up).`);
  };

  const handleRenameIGN = async (newIgn) => {
    try {
      const key = user.playerId.toLowerCase();
      const allUsers = (await storageGet("users", true)) || {};
      if (!allUsers[key]) return false;
      allUsers[key] = { ...allUsers[key], ign: newIgn };
      const ok = await storageSet("users", allUsers, true);
      if (!ok) return false;
      setUsers(allUsers);
      setUser(allUsers[key]);
      flash("In-game name updated.");
      return true;
    } catch (err) {
      return false;
    }
  };

  const handleSaveSlot = async (form) => {
    const exists = slots.some((s) => s.id === form.id);
    const next = exists ? slots.map((s) => s.id === form.id ? form : s) : [...slots, { ...form, id: `${dateStr}-${Date.now()}` }];
    await saveSlots(next);
    setEditTarget(null);
    flash("Slot saved.");
  };

  const handleDeleteSlot = async (slot) => {
    await saveSlots(slots.filter((s) => s.id !== slot.id));
    flash("Slot removed.");
  };

  const handleSubmitResults = async (rows) => {
    const allUsers = (await storageGet("users", true)) || {};
    rows.forEach((row) => {
      const key = row.playerId.toLowerCase();
      const u = allUsers[key];
      if (!u) return;
      const pos = parseInt(row.position, 10) || 99;
      const pts = (PLACEMENT_POINTS[pos] || 0) + (row.kills || 0);
      u.points = (u.points || 0) + pts;
      u.kills = (u.kills || 0) + (row.kills || 0);
      u.matches = (u.matches || 0) + 1;
      if (pos === 1) u.wins = (u.wins || 0) + 1;
      allUsers[key] = u;
    });
    await storageSet("users", allUsers, true);
    setUsers(allUsers);
    const nextSlots = slots.map((s) => s.id === resultsTarget.id ? { ...s, results: rows } : s);
    await saveSlots(nextSlots);
    setResultsTarget(null);
    flash("Results submitted — leaderboard updated.");
  };

  if (!user) return <AuthScreen onLogin={handleLogin} />;

  const dateOptions = [0, 1].map((o) => todayStr(o));

  return (
    <div className="bgmi-root" style={{ paddingBottom: 76 }}>
      <GlobalStyle />

      {/* Top HUD bar */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: `${COLORS.bg}f2`, backdropFilter: "blur(4px)", borderBottom: `1px solid ${COLORS.border}`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Crosshair size={18} color={COLORS.cyan} />
          <span className="bgmi-display" style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.5 }}>ARENA</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div className="bgmi-mono" style={{ fontSize: 13, color: COLORS.gold, display: "flex", alignItems: "center", gap: 4 }}>
            <Coins size={13} /> {user.wallet}
          </div>
          {user.isAdmin && <Badge bg={COLORS.danger + "22"} color={COLORS.danger} border={COLORS.danger + "66"}>Admin</Badge>}
        </div>
      </div>

      {toast && (
        <div className="bgmi-fade-in bgmi-display" style={{ position: "fixed", top: 62, left: "50%", transform: "translateX(-50%)", background: COLORS.panel2, border: `1px solid ${COLORS.cyan}`, color: COLORS.text, padding: "8px 16px", borderRadius: 3, fontSize: 12, zIndex: 60 }}>
          {toast}
        </div>
      )}

      {tab === "home" && (
        <div>
          <div className="bgmi-scroll" style={{ display: "flex", gap: 8, padding: "14px 16px 6px", overflowX: "auto" }}>
            {dateOptions.map((d, i) => (
              <button
                key={d}
                onClick={() => setDateStr(d)}
                className="bgmi-btn bgmi-display"
                style={{
                  flexShrink: 0, padding: "8px 14px", borderRadius: 3, fontSize: 12, fontWeight: 700,
                  letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase",
                  background: dateStr === d ? COLORS.cyan : COLORS.panel,
                  color: dateStr === d ? "#0A0F0A" : COLORS.textDim,
                  border: `1px solid ${dateStr === d ? COLORS.cyan : COLORS.border}`,
                }}
              >
                {i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmtDateLabel(d)}
              </button>
            ))}
            {user.isAdmin && (
              <button
                onClick={() => setEditTarget({ id: `${dateStr}-new-${Date.now()}`, mode: "Squad", map: MAPS[0], time: "19:00", maxTeams: 25, entryFee: 50, prizePool: 2000, bookedTeams: [], results: null, tag: null, cancelled: false })}
                className="bgmi-btn"
                style={{ flexShrink: 0, padding: "8px 12px", borderRadius: 3, background: "transparent", border: `1px dashed ${COLORS.borderBright}`, color: COLORS.textDim, cursor: "pointer" }}
              >
                <Plus size={16} />
              </button>
            )}
          </div>

          <div style={{ padding: "10px 16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
            {slots.length === 0 && <div style={{ color: COLORS.textDim, fontSize: 13 }}>No slots scheduled for this day.</div>}
            {slots.slice().sort((a, b) => a.time.localeCompare(b.time)).map((slot, idx, sorted) => (
              <SlotCard
                key={slot.id} slot={slot} dateStr={dateStr} now={now} nextTime={sorted[idx + 1] ? sorted[idx + 1].time : null} user={user}
                onJoin={setJoinTarget}
                onViewPlayers={setPlayersTarget}
                isAdmin={user.isAdmin} onEdit={setEditTarget} onDelete={handleDeleteSlot}
                onCancelMatch={handleCancelMatch} onResults={setResultsTarget} onRoster={setRosterTarget}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "leaderboard" && <LeaderboardView users={users} />}
      {tab === "profile" && <ProfileView user={user} onLogout={() => { authLogout(); setUser(null); }} onTopUp={handleTopUp} onRenameIGN={handleRenameIGN} />}

      {/* Bottom nav */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: COLORS.panel, borderTop: `1px solid ${COLORS.border}`, display: "flex", padding: "8px 12px calc(8px + env(safe-area-inset-bottom))", zIndex: 20 }}>
        {[
          { key: "home", label: "Slots", icon: Target },
          { key: "leaderboard", label: "Ranks", icon: Trophy },
          { key: "profile", label: "Profile", icon: User },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="bgmi-btn bgmi-display"
            style={{
              flex: 1, background: "none", border: "none", cursor: "pointer",
              display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "4px 0",
              color: tab === key ? COLORS.cyan : COLORS.textFaint,
            }}
          >
            <Icon size={18} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>{label}</span>
          </button>
        ))}
      </div>

      {joinTarget && <JoinModal slot={joinTarget} user={user} onConfirm={handleJoinConfirm} onClose={() => setJoinTarget(null)} />}
      {editTarget && <SlotEditorModal slot={editTarget} onSave={handleSaveSlot} onClose={() => setEditTarget(null)} />}
      {resultsTarget && <ResultsModal slot={resultsTarget} onSubmit={handleSubmitResults} onClose={() => setResultsTarget(null)} />}
      {rosterTarget && <RosterModal slot={rosterTarget} onGroup={handleGroupSolos} onClose={() => setRosterTarget(null)} />}
      {playersTarget && <SlotPlayersModal slot={playersTarget} users={users} isAdmin={user.isAdmin} onClose={() => setPlayersTarget(null)} />}
    </div>
  );
}
