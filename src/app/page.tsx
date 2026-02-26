"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ─── Types ───────────────────────────────────────────────────────────
type Phase = "inhale" | "hold-full" | "exhale" | "hold-empty";
type SessionState = "idle" | "config" | "running" | "paused" | "complete" | "stats";

interface PhaseConfig {
  label: string;
  sublabel: string;
  type: Phase;
}

interface SessionRecord {
  date: string;
  duration: number; // seconds
  reps: number;
  boxTime: number;
}

// ─── Constants ───────────────────────────────────────────────────────
const PHASES: PhaseConfig[] = [
  { label: "IN", sublabel: "HALE", type: "inhale" },
  { label: "HOLD", sublabel: "FULL", type: "hold-full" },
  { label: "EX", sublabel: "HALE", type: "exhale" },
  { label: "HOLD", sublabel: "EMPTY", type: "hold-empty" },
];

const BOX_OPTIONS = [3, 4, 5, 6, 7, 8];
const REP_OPTIONS = [3, 5, 8, 10, 15, 20];

const STORAGE_KEY = "box-sessions";

// ─── Haptics ─────────────────────────────────────────────────────────
function vibrate(pattern: number | number[]) {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

// ─── Stats helpers ───────────────────────────────────────────────────
function loadSessions(): SessionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveSessions(records: SessionRecord[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function getWeekStart(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.toISOString().split("T")[0];
}

function formatMinutes(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Audio Engine ────────────────────────────────────────────────────
class AudioEngine {
  private ctx: AudioContext | null = null;

  private getCtx(): AudioContext {
    if (!this.ctx) {
      const C = window.AudioContext || (window as any).webkitAudioContext;
      this.ctx = new C();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  playTransition(phase: Phase) {
    try {
      const ctx = this.getCtx();
      const now = ctx.currentTime;

      if (phase === "inhale") {
        // Rising tone — warm sine sweep
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(120, now);
        osc.frequency.exponentialRampToValueAtTime(240, now + 0.4);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.6);
      } else if (phase === "exhale") {
        // Falling tone
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.4);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.6);
      } else {
        // Soft click for holds
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(180, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
      }
    } catch {}
  }

  playTick() {
    try {
      const ctx = this.getCtx();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.02, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    } catch {}
  }

  playSuccess() {
    try {
      const ctx = this.getCtx();
      const now = ctx.currentTime;
      // Ascending arpeggio
      [260, 330, 390, 520].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, now + i * 0.12);
        gain.gain.setValueAtTime(0, now + i * 0.12);
        gain.gain.linearRampToValueAtTime(0.1, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.5);
      });
    } catch {}
  }

  unlock() {
    try {
      this.getCtx();
    } catch {}
  }
}

// ─── Component ───────────────────────────────────────────────────────
export default function BoxApp() {
  const [state, setState] = useState<SessionState>("idle");
  const [boxTime, setBoxTime] = useState(4);
  const [reps, setReps] = useState(5);
  const [muted, setMuted] = useState(false);
  const [currentPhase, setCurrentPhase] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [currentRep, setCurrentRep] = useState(0);
  const [fillHeight, setFillHeight] = useState(0);
  const [fillTransition, setFillTransition] = useState("none");
  const [strokeOffset, setStrokeOffset] = useState(400);
  const [strokeTransition, setStrokeTransition] = useState("none");
  const [successParticles, setSuccessParticles] = useState(false);

  const audioRef = useRef<AudioEngine | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);
  const mutedRef = useRef(false);
  const phaseRef = useRef(0);
  const repRef = useRef(0);
  const sessionStartRef = useRef(0);

  useEffect(() => {
    audioRef.current = new AudioEngine();
  }, []);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  // ─── Session Engine ──────────────────────────────────────────────
  const clearTimers = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }, []);

  const runPhase = useCallback(() => {
    if (!runningRef.current) return;

    const phase = PHASES[phaseRef.current];
    setCurrentPhase(phaseRef.current);
    setCountdown(boxTime);

    // Audio + haptics
    if (!mutedRef.current) audioRef.current?.playTransition(phase.type);
    vibrate(phase.type === "inhale" || phase.type === "exhale" ? [30] : [10, 30, 10]);

    // Trace line — one side per phase, resets each rep
    const phaseIdx = phaseRef.current;
    if (phaseIdx === 0) {
      // New rep: reset instantly, then animate first side
      setStrokeTransition("none");
      setStrokeOffset(400);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setStrokeTransition(`stroke-dashoffset ${boxTime}s linear`);
          setStrokeOffset(300);
        });
      });
    } else {
      setStrokeTransition(`stroke-dashoffset ${boxTime}s linear`);
      setStrokeOffset(400 - (phaseIdx + 1) * 100);
    }

    // Fill animation
    if (phase.type === "inhale") {
      setFillTransition(`height ${boxTime}s linear`);
      setTimeout(() => setFillHeight(100), 20);
    } else if (phase.type === "exhale") {
      setFillTransition(`height ${boxTime}s linear`);
      setTimeout(() => setFillHeight(0), 20);
    }

    // Countdown ticker
    let remaining = boxTime;
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        setCountdown(remaining);
        if (!mutedRef.current) audioRef.current?.playTick();
        vibrate(5);
      }
    }, 1000);

    // Next phase
    timerRef.current = setTimeout(() => {
      if (!runningRef.current) return;
      clearInterval(countdownRef.current!);

      const nextPhaseIdx = (phaseRef.current + 1) % 4;
      // If we just finished hold-empty, that's one rep
      if (phaseRef.current === 3) {
        repRef.current++;
        setCurrentRep(repRef.current);

        if (repRef.current >= reps) {
          // Session complete
          runningRef.current = false;
          const duration = Math.round((Date.now() - sessionStartRef.current) / 1000);
          const record: SessionRecord = {
            date: new Date().toISOString(),
            duration,
            reps,
            boxTime,
          };
          const sessions = loadSessions();
          sessions.push(record);
          saveSessions(sessions);

          if (!mutedRef.current) audioRef.current?.playSuccess();
          vibrate([50, 100, 50, 100, 200]);
          setSuccessParticles(true);
          setState("complete");
          return;
        }
      }

      phaseRef.current = nextPhaseIdx;
      runPhase();
    }, boxTime * 1000);
  }, [boxTime, reps, clearTimers]);

  const startSession = useCallback(() => {
    audioRef.current?.unlock();
    runningRef.current = true;
    phaseRef.current = 0;
    repRef.current = 0;
    setCurrentRep(0);
    setCurrentPhase(0);
    setFillHeight(0);
    setFillTransition("none");
    setStrokeOffset(400);
    setStrokeTransition("none");
    sessionStartRef.current = Date.now();
    setState("running");
    setTimeout(() => runPhase(), 50);
  }, [runPhase]);

  const pauseSession = useCallback(() => {
    runningRef.current = false;
    clearTimers();
    setState("paused");
    vibrate(20);
  }, [clearTimers]);

  const resumeSession = useCallback(() => {
    runningRef.current = true;
    setState("running");
    runPhase();
  }, [runPhase]);

  const resetSession = useCallback(() => {
    runningRef.current = false;
    clearTimers();
    setFillHeight(0);
    setFillTransition("none");
    setStrokeOffset(400);
    setStrokeTransition("none");
    setSuccessParticles(false);
    setState("idle");
  }, [clearTimers]);

  useEffect(() => {
    return () => clearTimers();
  }, [clearTimers]);

  // ─── Stats ───────────────────────────────────────────────────────
  const sessions = loadSessions();
  const weekStart = getWeekStart();
  const weekSessions = sessions.filter((s) => s.date >= weekStart);
  const totalTime = sessions.reduce((a, s) => a + s.duration, 0);
  const weekTime = weekSessions.reduce((a, s) => a + s.duration, 0);
  const totalSessions = sessions.length;
  const weekSessionCount = weekSessions.length;
  const totalReps = sessions.reduce((a, s) => a + s.reps, 0);
  const weekReps = weekSessions.reduce((a, s) => a + s.reps, 0);

  // ─── Render ──────────────────────────────────────────────────────

  // Success screen
  if (state === "complete") {
    const lastSession = sessions[sessions.length - 1];
    return (
      <div
        style={{
          height: "100dvh",
          width: "100vw",
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Burst rings */}
        {successParticles && (
          <>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  width: 120,
                  height: 120,
                  borderRadius: "50%",
                  border: "2px solid var(--accent)",
                  animation: `success-burst 1.5s ease-out ${i * 0.2}s forwards`,
                }}
              />
            ))}
          </>
        )}

        <div
          style={{
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.2em",
            color: "var(--accent)",
            textTransform: "uppercase",
            marginBottom: 8,
            animation: "fade-in 0.5s ease-out",
          }}
        >
          SESSION COMPLETE
        </div>

        <div
          style={{
            fontSize: 64,
            fontWeight: 900,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            animation: "fade-in 0.5s ease-out 0.1s both",
          }}
        >
          {formatMinutes(lastSession?.duration || 0)}
        </div>

        <div
          style={{
            fontSize: 11,
            color: "var(--muted)",
            marginTop: 8,
            fontWeight: 600,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            animation: "fade-in 0.5s ease-out 0.2s both",
          }}
        >
          {lastSession?.reps} REPS / {lastSession?.boxTime}s BOX
        </div>

        {/* Mini stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 1,
            marginTop: 48,
            width: "80%",
            maxWidth: 320,
            animation: "fade-in 0.5s ease-out 0.3s both",
          }}
        >
          {[
            { label: "THIS WEEK", value: formatMinutes(weekTime) },
            { label: "ALL TIME", value: formatMinutes(totalTime) },
            { label: "WEEK SESSIONS", value: String(weekSessionCount) },
            { label: "TOTAL SESSIONS", value: String(totalSessions) },
          ].map((item) => (
            <div
              key={item.label}
              style={{
                background: "var(--surface)",
                padding: "16px 12px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 800 }}>{item.value}</div>
              <div
                style={{
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: "0.15em",
                  color: "var(--muted)",
                  marginTop: 4,
                }}
              >
                {item.label}
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={resetSession}
          style={{
            marginTop: 48,
            background: "var(--accent)",
            color: "var(--bg)",
            border: "none",
            padding: "16px 48px",
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            cursor: "pointer",
            animation: "fade-in 0.5s ease-out 0.4s both",
          }}
        >
          DONE
        </button>
      </div>
    );
  }

  // Stats screen
  if (state === "stats") {
    return (
      <div
        style={{
          height: "100dvh",
          width: "100vw",
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button
            onClick={() => setState("idle")}
            style={{
              background: "none",
              border: "none",
              color: "var(--fg)",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.1em",
              cursor: "pointer",
            }}
          >
            &larr; BACK
          </button>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.2em",
              color: "var(--muted)",
            }}
          >
            STATS
          </div>
          <div style={{ width: 60 }} />
        </div>

        {/* Stats grid */}
        <div style={{ padding: 20 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.2em",
              color: "var(--accent)",
              marginBottom: 12,
            }}
          >
            THIS WEEK
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 1,
              marginBottom: 32,
            }}
          >
            {[
              { label: "TIME", value: formatMinutes(weekTime) },
              { label: "SESSIONS", value: String(weekSessionCount) },
              { label: "REPS", value: String(weekReps) },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  background: "var(--surface)",
                  padding: "20px 12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 28, fontWeight: 900 }}>{item.value}</div>
                <div
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    letterSpacing: "0.15em",
                    color: "var(--muted)",
                    marginTop: 4,
                  }}
                >
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.2em",
              color: "var(--muted)",
              marginBottom: 12,
            }}
          >
            ALL TIME
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 1,
              marginBottom: 32,
            }}
          >
            {[
              { label: "TIME", value: formatMinutes(totalTime) },
              { label: "SESSIONS", value: String(totalSessions) },
              { label: "REPS", value: String(totalReps) },
            ].map((item) => (
              <div
                key={item.label}
                style={{
                  background: "var(--surface)",
                  padding: "20px 12px",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: 28, fontWeight: 900 }}>{item.value}</div>
                <div
                  style={{
                    fontSize: 8,
                    fontWeight: 700,
                    letterSpacing: "0.15em",
                    color: "var(--muted)",
                    marginTop: 4,
                  }}
                >
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          {/* Recent sessions */}
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.2em",
              color: "var(--muted)",
              marginBottom: 12,
            }}
          >
            RECENT
          </div>
          {sessions.length === 0 ? (
            <div
              style={{
                color: "var(--muted)",
                fontSize: 12,
                padding: 20,
                textAlign: "center",
              }}
            >
              No sessions yet. Start breathing.
            </div>
          ) : (
            [...sessions]
              .reverse()
              .slice(0, 20)
              .map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "12px 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700 }}>
                      {new Date(s.date).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                      <span style={{ color: "var(--muted)", marginLeft: 8 }}>
                        {new Date(s.date).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontWeight: 700 }}>{formatMinutes(s.duration)}</span>
                    <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 10 }}>
                      {s.reps}x{s.boxTime}s
                    </span>
                  </div>
                </div>
              ))
          )}
        </div>
      </div>
    );
  }

  // Config screen
  if (state === "config") {
    const totalSeconds = boxTime * 4 * reps;
    return (
      <div
        style={{
          height: "100dvh",
          width: "100vw",
          background: "var(--bg)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button
            onClick={() => setState("idle")}
            style={{
              background: "none",
              border: "none",
              color: "var(--fg)",
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.1em",
              cursor: "pointer",
            }}
          >
            &larr; BACK
          </button>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.2em",
              color: "var(--muted)",
            }}
          >
            CONFIG
          </div>
          <div style={{ width: 60 }} />
        </div>

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "0 20px",
            gap: 48,
          }}
        >
          {/* Box time selector */}
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.2em",
                color: "var(--accent)",
                marginBottom: 16,
              }}
            >
              BOX TIME
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {BOX_OPTIONS.map((t) => (
                <button
                  key={t}
                  onClick={() => setBoxTime(t)}
                  style={{
                    flex: 1,
                    height: 56,
                    background: t === boxTime ? "var(--fg)" : "var(--surface)",
                    color: t === boxTime ? "var(--bg)" : "var(--muted)",
                    border: "none",
                    fontSize: 18,
                    fontWeight: 800,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {t}
                  <span style={{ fontSize: 10, fontWeight: 600 }}>s</span>
                </button>
              ))}
            </div>
          </div>

          {/* Reps selector */}
          <div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: "0.2em",
                color: "var(--accent)",
                marginBottom: 16,
              }}
            >
              REPS
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {REP_OPTIONS.map((r) => (
                <button
                  key={r}
                  onClick={() => setReps(r)}
                  style={{
                    flex: 1,
                    height: 56,
                    background: r === reps ? "var(--fg)" : "var(--surface)",
                    color: r === reps ? "var(--bg)" : "var(--muted)",
                    border: "none",
                    fontSize: 18,
                    fontWeight: 800,
                    cursor: "pointer",
                    transition: "all 0.15s",
                  }}
                >
                  {r}
                  <span style={{ fontSize: 10, fontWeight: 600 }}>x</span>
                </button>
              ))}
            </div>
          </div>

          {/* Duration preview */}
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: 36,
                fontWeight: 900,
                letterSpacing: "-0.02em",
              }}
            >
              {formatMinutes(totalSeconds)}
            </div>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.15em",
                color: "var(--muted)",
                marginTop: 4,
              }}
            >
              TOTAL DURATION
            </div>
          </div>
        </div>

        <div style={{ padding: 20 }}>
          <button
            onClick={() => setState("idle")}
            style={{
              width: "100%",
              height: 56,
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            SAVE
          </button>
        </div>
      </div>
    );
  }

  // Running / Paused / Idle — main breathe screen
  const phase = PHASES[currentPhase];
  const isActive = state === "running";
  const isPaused = state === "paused";
  const totalSeconds = boxTime * 4 * reps;
  const progress = state === "idle" ? 0 : ((currentRep * 4 + currentPhase) / (reps * 4)) * 100;

  return (
    <div
      style={{
        height: "100dvh",
        width: "100vw",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
        userSelect: "none",
      }}
    >
      {/* Top bar — progress + phase pips */}
      <div style={{ position: "relative", zIndex: 30 }}>
        {/* Progress bar */}
        <div
          style={{
            height: 2,
            background: "var(--border)",
            width: "100%",
          }}
        >
          <div
            style={{
              height: "100%",
              background: "var(--accent)",
              width: `${progress}%`,
              transition: "width 0.3s",
            }}
          />
        </div>

        {/* Phase pips */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 3,
            padding: "14px 0 10px",
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                width: 32,
                height: 3,
                background:
                  isActive && currentPhase === i
                    ? "var(--accent)"
                    : isActive
                    ? "var(--border)"
                    : "var(--border)",
                transition: "background 0.2s",
              }}
            />
          ))}
        </div>

        {/* Rep counter */}
        {(isActive || isPaused) && (
          <div
            style={{
              textAlign: "center",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.2em",
              color: "var(--muted)",
            }}
          >
            {currentRep + 1} / {reps}
          </div>
        )}
      </div>

      {/* Center area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {/* Breathing box — background geometry */}
        <div
          style={{
            position: "absolute",
            width: "75vw",
            height: "75vw",
            maxWidth: 360,
            maxHeight: 360,
          }}
        >
          {/* Static border */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              border: "1px solid var(--border)",
              opacity: isActive ? 0.6 : 0.3,
              transition: "opacity 0.5s",
              overflow: "hidden",
            }}
          >
            {/* Fill */}
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                width: "100%",
                background: "var(--accent)",
                opacity: 0.06,
                height: `${fillHeight}%`,
                transition: fillTransition,
              }}
            />
          </div>

          {/* Trace line SVG — draws one side per phase */}
          <svg
            viewBox="0 0 100 100"
            fill="none"
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: -1,
              width: "calc(100% + 2px)",
              height: "calc(100% + 2px)",
              opacity: isActive || isPaused ? 1 : 0,
              transition: "opacity 0.4s",
              overflow: "visible",
            }}
          >
            <path
              d="M 0 100 L 0 0 L 100 0 L 100 100 L 0 100"
              stroke="var(--accent)"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
              strokeLinecap="square"
              strokeDasharray="400"
              strokeDashoffset={strokeOffset}
              style={{ transition: strokeTransition }}
            />
          </svg>
        </div>

        {/* Pulse ring on phase change */}
        {isActive && (
          <div
            key={`ring-${currentPhase}-${currentRep}`}
            style={{
              position: "absolute",
              width: 120,
              height: 120,
              borderRadius: "50%",
              border: "1px solid var(--accent)",
              animation: "pulse-ring 1s ease-out forwards",
            }}
          />
        )}

        {/* Main text */}
        {state === "idle" ? (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "clamp(56px, 16vw, 96px)",
                fontWeight: 900,
                lineHeight: 0.9,
                letterSpacing: "-0.04em",
              }}
            >
              BOX
            </div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.3em",
                color: "var(--muted)",
                marginTop: 12,
              }}
            >
              BREATHE
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted)",
                marginTop: 24,
                fontWeight: 500,
                letterSpacing: "0.05em",
              }}
            >
              {boxTime}s &middot; {reps} reps &middot; {formatMinutes(totalSeconds)}
            </div>
          </div>
        ) : isPaused ? (
          <div style={{ textAlign: "center" }}>
            <div
              style={{
                fontSize: "clamp(40px, 12vw, 72px)",
                fontWeight: 900,
                lineHeight: 0.9,
                letterSpacing: "-0.03em",
                color: "var(--muted)",
              }}
            >
              PAUSED
            </div>
          </div>
        ) : (
          <div style={{ textAlign: "center" }}>
            {/* Phase label */}
            <div
              key={`phase-${currentPhase}-${currentRep}`}
              style={{
                fontSize: "clamp(48px, 14vw, 84px)",
                fontWeight: 900,
                lineHeight: 0.85,
                letterSpacing: "-0.04em",
                animation: "fade-in 0.2s ease-out",
              }}
            >
              <div>{phase.label}</div>
              <div
                style={{
                  fontSize: "0.45em",
                  fontWeight: 700,
                  letterSpacing: "0.15em",
                  color: "var(--accent)",
                  marginTop: 4,
                }}
              >
                {phase.sublabel}
              </div>
            </div>

            {/* Countdown number */}
            <div
              key={`count-${countdown}-${currentPhase}`}
              style={{
                fontSize: 32,
                fontWeight: 300,
                color: "var(--muted)",
                marginTop: 32,
                fontVariantNumeric: "tabular-nums",
                animation: "count-pop 0.3s ease-out",
              }}
            >
              {countdown}
            </div>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div
        style={{
          padding: "0 16px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          position: "relative",
          zIndex: 20,
        }}
      >
        {/* Main row */}
        <div style={{ display: "flex", gap: 2 }}>
          {/* Settings / Stats */}
          {!isActive && !isPaused && (
            <button
              onClick={() => setState("config")}
              style={{
                width: 56,
                height: 56,
                background: "var(--surface)",
                color: "var(--fg)",
                border: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: 18,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </button>
          )}

          {/* Main action */}
          <button
            onClick={() => {
              if (state === "idle") startSession();
              else if (isActive) pauseSession();
              else if (isPaused) resumeSession();
            }}
            style={{
              flex: 1,
              height: 56,
              background: isActive ? "var(--surface)" : "var(--accent)",
              color: isActive ? "var(--fg)" : "var(--bg)",
              border: "none",
              fontSize: 13,
              fontWeight: 800,
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              cursor: "pointer",
              animation: isActive ? "glow-pulse 4s ease-in-out infinite" : "none",
              transition: "background 0.2s",
            }}
          >
            {state === "idle" ? "START" : isActive ? "PAUSE" : "RESUME"}
          </button>

          {/* Mute */}
          {(isActive || isPaused) && (
            <button
              onClick={() => setMuted(!muted)}
              style={{
                width: 56,
                height: 56,
                background: "var(--surface)",
                color: muted ? "var(--muted)" : "var(--fg)",
                border: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                transition: "color 0.2s",
              }}
            >
              {muted ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              )}
            </button>
          )}

          {/* Stats button (idle only) */}
          {!isActive && !isPaused && (
            <button
              onClick={() => setState("stats")}
              style={{
                width: 56,
                height: 56,
                background: "var(--surface)",
                color: "var(--fg)",
                border: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </button>
          )}

          {/* Reset (paused only) */}
          {isPaused && (
            <button
              onClick={resetSession}
              style={{
                width: 56,
                height: 56,
                background: "var(--surface)",
                color: "var(--accent)",
                border: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: "0.1em",
              }}
            >
              END
            </button>
          )}
        </div>
      </div>

      {/* Bottom marquee */}
      <div
        style={{
          overflow: "hidden",
          whiteSpace: "nowrap",
          borderTop: "1px solid var(--border)",
          padding: "6px 0",
          position: "relative",
          zIndex: 20,
        }}
      >
        <div
          style={{
            display: "inline-block",
            animation: "marquee 20s linear infinite",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.15em",
            color: "var(--muted)",
            textTransform: "uppercase",
          }}
        >
          FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot;&nbsp;
          FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot; FOCUS &middot; BREATHE &middot; HOLD &middot; RELEASE &middot;&nbsp;
        </div>
      </div>
    </div>
  );
}
