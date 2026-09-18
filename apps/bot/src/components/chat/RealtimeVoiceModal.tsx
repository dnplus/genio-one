import { useEffect, useRef, useState, type RefObject } from "react"
import { Mic, MicOff, PhoneOff, X } from "lucide-react"
import type { CodexClient } from "../../lib/codex-client"
import type { BotInstance } from "../../bots-storage"
import { BloubAvatar } from "../../avatar/bloub-avatar"
import "./RealtimeVoiceModal.css"

export type VoiceSessionStatus =
  | "idle"
  | "requesting_mic"
  | "connecting"
  | "connected"
  | "speaking"
  | "listening"
  | "error"
  | "closed"

export interface TranscriptItem {
  id: string
  role: "user" | "bot"
  text: string
}

export interface RealtimeVoiceModalProps {
  isOpen: boolean
  onClose: () => void
  activeBot: BotInstance
  threadId: string
  clientRef: RefObject<CodexClient | null>
  demo?: boolean
}

export function RealtimeVoiceModal({
  isOpen,
  onClose,
  activeBot,
  threadId,
  clientRef,
  demo = false,
}: RealtimeVoiceModalProps) {
  const [status, setStatus] = useState<VoiceSessionStatus>("idle")
  const [errorText, setErrorText] = useState("")
  const [isMuted, setIsMuted] = useState(false)
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([])
  const [visualizerBars, setVisualizerBars] = useState<number[]>([12, 16, 24, 18, 14, 20, 16, 12])

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const demoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unbindListenerRef = useRef<(() => void) | null>(null)
  const generationRef = useRef(0)

  function cleanupMedia() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (demoTimerRef.current) {
      clearTimeout(demoTimerRef.current)
      demoTimerRef.current = null
    }
    if (unbindListenerRef.current) {
      unbindListenerRef.current()
      unbindListenerRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      void audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    analyserRef.current = null

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null
      remoteAudioRef.current = null
    }
  }

  function handleHangUp() {
    generationRef.current++
    const client = clientRef.current
    if (!demo && client && status !== "idle" && status !== "closed") {
      void client.requestRaw("thread/realtime/stop", { threadId }).catch(() => {})
    }
    cleanupMedia()
    setStatus("closed")
    onClose()
  }

  function toggleMute() {
    if (mediaStreamRef.current) {
      const audioTrack = mediaStreamRef.current.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = isMuted
        setIsMuted(!isMuted)
      }
    } else {
      setIsMuted(!isMuted)
    }
  }

  function startVisualizer(stream: MediaStream) {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      audioContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)
      analyserRef.current = analyser

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const updateVisualizer = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(dataArray)
        const bars: number[] = []
        const step = Math.floor(dataArray.length / 8) || 1
        for (let i = 0; i < 8; i++) {
          const val = dataArray[i * step] ?? 0
          bars.push(Math.max(10, Math.min(64, Math.round((val / 255) * 60) + 8)))
        }
        setVisualizerBars(bars)
        animationFrameRef.current = requestAnimationFrame(updateVisualizer)
      }
      updateVisualizer()
    } catch (e) { console.warn("startVisualizer failed", e) }
  }

  useEffect(() => {
    if (!isOpen) {
      cleanupMedia()
      setStatus("idle")
      setErrorText("")
      return
    }

    const currentGeneration = ++generationRef.current
    setStatus("requesting_mic")
    setErrorText("")
    setTranscripts([])

    async function initSession() {
      try {
        let stream: MediaStream | null = null
        if (navigator.mediaDevices?.getUserMedia) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch (micErr) {
            if (!demo) {
              throw new Error("無法取得麥克風權限，請確認瀏覽器設定後重試。")
            }
          }
        }

        if (currentGeneration !== generationRef.current) {
          stream?.getTracks().forEach((t) => t.stop())
          return
        }

        if (stream) {
          mediaStreamRef.current = stream
          startVisualizer(stream)
        }

        if (demo) {
          setStatus("connecting")
          demoTimerRef.current = setTimeout(() => {
            if (currentGeneration !== generationRef.current) return
            setStatus("connected")
            setTranscripts([{
              id: "demo-greeting",
              role: "bot",
              text: `你好！我是 ${activeBot.name}。我們已經建立即時語音連線，請對著麥克風說話。`,
            }])
          }, 1200)
          return
        }

        const client = clientRef.current
        if (!client) throw new Error("Codex 連線尚未就緒")

        setStatus("connecting")

        const pc = new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        })
        peerConnectionRef.current = pc

        if (stream) {
          stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream!))
        }

        pc.createDataChannel("oai-events")

        pc.ontrack = (event) => {
          if (!remoteAudioRef.current) {
            const audio = new Audio()
            audio.autoplay = true
            remoteAudioRef.current = audio
          }
          remoteAudioRef.current.srcObject = event.streams[0]
          void remoteAudioRef.current.play().catch(() => {})
        }

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        const unbindMessage = client.onMessage((msg: Record<string, any>) => {
          if (currentGeneration !== generationRef.current) return
          if (msg.method === "thread/realtime/sdp" && msg.params?.sdp) {
            const answerSdp = msg.params.sdp
            void pc.setRemoteDescription({ type: "answer", sdp: answerSdp }).then(() => {
              setStatus("connected")
            }).catch(() => {
              setStatus("error")
              setErrorText("WebRTC SDP 協商失敗")
            })
          }
          if (msg.method === "thread/realtime/started") {
            setStatus("connected")
          }
          if (msg.method === "thread/realtime/transcript/delta" || msg.method === "thread/realtime/item/transcript/delta") {
            const delta = msg.params?.delta || msg.params?.text || ""
            if (delta) {
              setTranscripts((current) => {
                const last = current[current.length - 1]
                if (last && last.role === "bot") {
                  return [...current.slice(0, -1), { ...last, text: `${last.text}${delta}` }]
                }
                return [...current, { id: `bot-${Date.now()}`, role: "bot", text: delta }]
              })
            }
          }
          if (msg.method === "thread/realtime/outputAudio/delta") {
            setStatus("speaking")
          }
          if (msg.method === "thread/realtime/error") {
            setStatus("error")
            setErrorText(typeof msg.params?.message === "string" ? msg.params.message : "語音連線發生錯誤")
          }
          if (msg.method === "thread/realtime/closed") {
            setStatus("closed")
          }
        })
        unbindListenerRef.current = unbindMessage

        await client.requestRaw("thread/realtime/start", {
          threadId,
          outputModality: "audio",
          transport: {
            type: "webrtc",
            sdp: offer.sdp,
          },
        })
      } catch (err) {
        if (currentGeneration === generationRef.current) {
          setStatus("error")
          setErrorText(err instanceof Error ? err.message : "無法建立即時語音連線")
        }
      }
    }

    void initSession()

    return () => {
      cleanupMedia()
    }
  }, [isOpen, demo, threadId, activeBot.id])

  if (!isOpen) return null

  const isSpeaking = status === "speaking"
  const isConnected = status === "connected" || status === "speaking" || status === "listening"

  return (
    <div className="voice-modal-backdrop" role="dialog" aria-modal="true" aria-label="即時語音通話">
      <div className="voice-modal-card">
        <button
          type="button"
          className="voice-modal-close-btn"
          onClick={handleHangUp}
          aria-label="關閉語音視窗"
        >
          <X size={18} />
        </button>

        <div className="voice-header">
          <BloubAvatar
            value={activeBot.avatar}
            label={activeBot.name}
            state={isSpeaking ? "thinking" : isConnected ? "idle" : "sleep"}
          />
          <h2 className="voice-title">{activeBot.name}</h2>
          <div
            className={`voice-badge ${
              isConnected ? "is-connected" : ""
            } ${isSpeaking ? "is-speaking" : ""} ${status === "error" ? "is-error" : ""}`}
          >
            <span className="voice-badge-dot" />
            <span>
              {status === "requesting_mic"
                ? "正在取得麥克風…"
                : status === "connecting"
                ? "連線中…"
                : status === "speaking"
                ? "AI 正在說話…"
                : status === "listening"
                ? "正在聆聽…"
                : isConnected
                ? "通話中 (WebRTC)"
                : status === "error"
                ? "連線異常"
                : status === "closed"
                ? "已結束"
                : "準備中…"}
            </span>
          </div>
        </div>

        <div className="voice-visualizer-container" aria-hidden="true">
          {visualizerBars.map((height, i) => (
            <div
              key={i}
              className={`voice-bar ${isSpeaking ? "speaking" : ""}`}
              style={{ height: `${height}px` }}
            />
          ))}
        </div>

        <div className="voice-transcript-box">
          {transcripts.length === 0 ? (
            <div className="voice-transcript-empty">
              {isConnected ? "開始說話即可進行即時對話…" : "等待連線中…"}
            </div>
          ) : (
            transcripts.map((item) => (
              <div key={item.id} className="voice-transcript-item">
                <span className={`voice-transcript-role ${item.role}`}>
                  {item.role === "user" ? "你: " : `${activeBot.name}: `}
                </span>
                <span>{item.text}</span>
              </div>
            ))
          )}
        </div>

        {errorText && <div className="voice-error-text">{errorText}</div>}

        <div className="voice-controls">
          <button
            type="button"
            className={`voice-control-btn ${isMuted ? "is-muted" : ""}`}
            onClick={toggleMute}
            aria-label={isMuted ? "解除靜音" : "靜音麥克風"}
            title={isMuted ? "解除靜音" : "靜音麥克風"}
          >
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
          </button>

          <button
            type="button"
            className="voice-control-btn end-call"
            onClick={handleHangUp}
            aria-label="結束通話"
            title="結束即時語音通話"
          >
            <PhoneOff size={24} />
          </button>
        </div>
      </div>
    </div>
  )
}
