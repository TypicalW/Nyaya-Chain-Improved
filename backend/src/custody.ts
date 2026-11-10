import { Router } from "express"
import { createClient } from "@supabase/supabase-js"
import { z } from "zod"

const env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
}).parse(process.env)

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

type DerivedEvent = {
  id: string
  evidence_id: string | null
  event_type: string
  source: string
  actor_label: string
  summary: string
  metadata: Record<string, unknown>
  occurred_at: string
  recorded_at: string
}

function derivedEvents(fir: { id: string; fir_number: string; created_at: string; status?: string; email_sent_at?: string | null }, evidence: Array<{ id: string; fir_id?: string; file_name: string; file_hash: string; blockchain_tx_hash: string | null; verification_status: string; uploaded_at: string }>): DerivedEvent[] {
  const events: DerivedEvent[] = [{
    id: `derived-fir-${fir.id}`,
    evidence_id: null,
    event_type: "FIR_REGISTERED",
    source: "Historical record",
    actor_label: "System",
    summary: "FIR registered",
    metadata: { firNumber: fir.fir_number, historical: true },
    occurred_at: fir.created_at,
    recorded_at: fir.created_at,
  }]
  if (fir.email_sent_at) events.push({
    id: `derived-email-${fir.id}`,
    evidence_id: null,
    event_type: "REGISTRATION_EMAIL_SENT",
    source: "Historical record",
    actor_label: "Email service",
    summary: "Registration confirmation email sent",
    metadata: { historical: true },
    occurred_at: fir.email_sent_at,
    recorded_at: fir.email_sent_at,
  })
  evidence.forEach((item) => {
    events.push({
      id: `derived-upload-${item.id}`,
      evidence_id: item.id,
      event_type: "EVIDENCE_UPLOADED",
      source: "Historical record",
      actor_label: "System",
      summary: `Evidence uploaded: ${item.file_name}`,
      metadata: { fileName: item.file_name, fileHash: item.file_hash, historical: true },
      occurred_at: item.uploaded_at,
      recorded_at: item.uploaded_at,
    })
    if (item.blockchain_tx_hash) events.push({
      id: `derived-chain-${item.id}`,
      evidence_id: item.id,
      event_type: "BLOCKCHAIN_REGISTERED",
      source: "Historical record",
      actor_label: "Blockchain",
      summary: `Evidence anchored on blockchain: ${item.file_name}`,
      metadata: { fileName: item.file_name, transactionHash: item.blockchain_tx_hash, historical: true },
      occurred_at: item.uploaded_at,
      recorded_at: item.uploaded_at,
    })
  })
  return events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.recorded_at.localeCompare(b.recorded_at) || a.id.localeCompare(b.id))
}

export type CustodyEventInput = {
  firId: string
  evidenceId?: string | null
  eventType: string
  source?: string
  actorLabel?: string
  summary: string
  metadata?: Record<string, unknown>
  occurredAt?: string
}

export async function recordCustodyEvent(event: CustodyEventInput) {
  const { error } = await supabase.from("custody_events").insert({
    fir_id: event.firId,
    evidence_id: event.evidenceId ?? null,
    event_type: event.eventType,
    source: event.source ?? "System",
    actor_label: event.actorLabel ?? "System",
    summary: event.summary,
    metadata: event.metadata ?? {},
    occurred_at: event.occurredAt ?? new Date().toISOString(),
  })

  if (error) throw new Error(`Custody event could not be recorded: ${error.message}`)
}

const integrityEventTypes = ["EVIDENCE_VERIFIED", "EVIDENCE_TAMPERED", "EVIDENCE_MISSING", "EVIDENCE_RECOVERED"]

export async function recordIntegrityTransition(event: CustodyEventInput) {
  if (!event.evidenceId) throw new Error("Integrity transition requires an evidence ID.")
  const { data: latest, error } = await supabase.from("custody_events")
    .select("event_type")
    .eq("evidence_id", event.evidenceId)
    .in("event_type", integrityEventTypes)
    .order("occurred_at", { ascending: false })
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Previous integrity events could not be checked: ${error.message}`)
  if (latest?.event_type === event.eventType) return
  await recordCustodyEvent(event)
}

const custodyRouter = Router()

custodyRouter.get("/cases", async (request, response) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100)
    const [{ data: firs, error: firError }, { data: evidence, error: evidenceError }] = await Promise.all([
      supabase.from("firs").select("id, fir_number, complainant_name, status, email_sent_at, created_at").order("created_at", { ascending: false }).limit(limit),
      supabase.from("evidence").select("id, fir_id, file_name, file_hash, blockchain_tx_hash, verification_status, uploaded_at"),
    ])
    if (firError || evidenceError) throw new Error(firError?.message ?? evidenceError?.message)
    const { data: events, error: eventError } = await supabase.from("custody_events").select("fir_id, event_type, summary, occurred_at, recorded_at, id").order("occurred_at", { ascending: false }).order("recorded_at", { ascending: false }).order("id", { ascending: false })

    const evidenceByFir = new Map<string, { total: number; verified: number; tampered: number; missing: number }>()
    for (const item of evidence ?? []) {
      const value = evidenceByFir.get(item.fir_id) ?? { total: 0, verified: 0, tampered: 0, missing: 0 }
      value.total += 1
      if (item.verification_status === "Verified") value.verified += 1
      if (item.verification_status === "Tampered") value.tampered += 1
      if (item.verification_status === "Missing") value.missing += 1
      evidenceByFir.set(item.fir_id, value)
    }
    const latestByFir = new Map<string, { type: string; summary: string; occurredAt: string }>()
    const countByFir = new Map<string, number>()
    for (const event of events ?? []) {
      countByFir.set(event.fir_id, (countByFir.get(event.fir_id) ?? 0) + 1)
      if (!latestByFir.has(event.fir_id)) latestByFir.set(event.fir_id, { type: event.event_type, summary: event.summary, occurredAt: event.occurred_at })
    }

    const hasLedger = !eventError
    response.json({ custodyLedgerAvailable: hasLedger, cases: (firs ?? []).map((fir) => {
      const items = (evidence ?? []).filter((item) => item.fir_id === fir.id)
      const fallback = hasLedger ? [] : derivedEvents(fir, items)
      const latestLedger = latestByFir.get(fir.id)
      const latestFallback = fallback.at(-1)
      return {
        id: fir.id,
        firNumber: fir.fir_number,
        complainantName: fir.complainant_name,
        status: fir.status,
        createdAt: fir.created_at,
        evidence: evidenceByFir.get(fir.id) ?? { total: 0, verified: 0, tampered: 0, missing: 0 },
        eventCount: countByFir.get(fir.id) ?? fallback.length,
        latestEvent: latestLedger ?? (latestFallback ? { type: latestFallback.event_type, summary: latestFallback.summary, occurredAt: latestFallback.occurred_at } : null),
      }
    }) })
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Unable to load chain of custody cases." })
  }
})

custodyRouter.get("/firs/:id", async (request, response) => {
  try {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const [{ data: fir, error: firError }, { data: evidence, error: evidenceError }] = await Promise.all([
      supabase.from("firs").select("id, fir_number, complainant_name, status, email_sent_at, created_at").eq("id", id).single(),
      supabase.from("evidence").select("id, file_name, file_type, file_hash, blockchain_tx_hash, verification_status, uploaded_at").eq("fir_id", id).order("uploaded_at", { ascending: true }),
    ])
    if (firError || !fir) return response.status(404).json({ error: "FIR not found." })
    if (evidenceError) throw new Error(evidenceError.message)
    const { data: events, error: eventError } = await supabase.from("custody_events").select("id, evidence_id, event_type, source, actor_label, summary, metadata, occurred_at, recorded_at").eq("fir_id", id).order("occurred_at", { ascending: true }).order("recorded_at", { ascending: true }).order("id", { ascending: true })
    const evidenceItems = evidence ?? []
    const actualEvents = events ?? []
    const inferredEvents = derivedEvents(fir, evidenceItems)
    const custodyEvents = eventError
      ? inferredEvents
      : [...actualEvents, ...inferredEvents.filter((item) => !actualEvents.some((event) => event.event_type === item.event_type && event.evidence_id === item.evidence_id))]
          .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at) || left.recorded_at.localeCompare(right.recorded_at) || left.id.localeCompare(right.id))
    response.json({
      fir: { id: fir.id, firNumber: fir.fir_number, complainantName: fir.complainant_name, status: fir.status, createdAt: fir.created_at },
      evidence: evidenceItems.map((item) => ({ id: item.id, fileName: item.file_name, fileType: item.file_type, fileHash: item.file_hash, blockchainTxHash: item.blockchain_tx_hash, verificationStatus: item.verification_status, uploadedAt: item.uploaded_at })),
      custodyLedgerAvailable: !eventError,
      events: custodyEvents.map((event) => ({ id: event.id, evidenceId: event.evidence_id, type: event.event_type, source: event.source, actorLabel: event.actor_label, summary: event.summary, metadata: event.metadata, occurredAt: event.occurred_at, recordedAt: event.recorded_at })),
    })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Unable to load chain of custody." })
  }
})

export default custodyRouter
