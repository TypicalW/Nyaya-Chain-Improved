"use client"

import { useState } from "react"
import { verifyEvidence } from "@/lib/api"

const cardStyle = {
  border: "1px solid #4f46e5",
  borderRadius: "6px",
  padding: "16px",
  background: "rgba(79, 70, 229, 0.08)",
}

const statusMessage = {
  Verified: "Verified: file hash and blockchain record both match.",
  Tampered: "Tampered: the current file hash does not match the original hash.",
  Missing: "Missing: the original file is unavailable in Supabase Storage.",
  Pending: "Verification is pending because storage or blockchain verification could not be completed.",
  "Verification Error": "Verification could not be completed. The last known integrity status is unchanged.",
}

export function VerifyOnChainButton({ evidenceId, onComplete }) {
  const [status, setStatus] = useState("idle")
  const [message, setMessage] = useState("")

  async function verifyOnChain() {
    setStatus("loading")
    setMessage("")

    try {
      const result = await verifyEvidence(evidenceId)
      const outcome = result.verification.status
      setStatus(outcome)
      setMessage(result.verification.verificationError || statusMessage[outcome])
      await onComplete?.(result.verification)
    } catch (err) {
      setMessage(`Verification Error: ${err instanceof Error ? err.message : "Unable to verify this evidence."}`)
      setStatus("Verification Error")
      await onComplete?.()
    }
  }

  const tone = status === "Verified" ? "#86efac" : status === "Pending" ? "#fcd34d" : "#fca5a5"

  return (
    <div style={cardStyle}>
      <button
        type="button"
        onClick={verifyOnChain}
        disabled={status === "loading"}
        style={{
          border: "1px solid #4f46e5",
          borderRadius: "4px",
          padding: "9px 13px",
          color: "#c7d2fe",
          background: "transparent",
          cursor: status === "loading" ? "wait" : "pointer",
          fontWeight: 600,
        }}
      >
        {status === "loading" ? "Verifying evidence..." : "Verify on Blockchain"}
      </button>
      {status !== "idle" && status !== "loading" && <p role="status" style={{ margin: "10px 0 0", fontSize: "14px", color: tone }}>{message}</p>}
    </div>
  )
}
