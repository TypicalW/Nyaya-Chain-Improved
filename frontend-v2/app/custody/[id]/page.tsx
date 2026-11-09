"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, CircleDot, Clock3, FileUp, FileWarning, GitBranch, Link2, Loader2, Mail, SearchCheck, ShieldCheck } from "lucide-react"
import { DashboardLayout } from "@/components/dashboard-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getCustodyDetails, verifyEvidence, type CustodyDetails, type CustodyEvent } from "@/lib/api"

const eventAppearance: Record<string, { icon: typeof CircleDot; tone: string }> = {
  FIR_REGISTERED: { icon: CircleDot, tone: "bg-primary text-primary-foreground" },
  AI_ANALYSIS_COMPLETED: { icon: Bot, tone: "bg-chart-5/20 text-chart-5" },
  AI_ANALYSIS_FALLBACK: { icon: Bot, tone: "bg-warning/15 text-warning" },
  REGISTRATION_EMAIL_SENT: { icon: Mail, tone: "bg-success/15 text-success" },
  REGISTRATION_EMAIL_FAILED: { icon: Mail, tone: "bg-destructive/15 text-destructive" },
  CASE_STATUS_CHANGED: { icon: Clock3, tone: "bg-accent/15 text-accent" },
  EVIDENCE_UPLOADED: { icon: FileUp, tone: "bg-primary/15 text-primary" },
  BLOCKCHAIN_REGISTERED: { icon: Link2, tone: "bg-success/15 text-success" },
  BLOCKCHAIN_REGISTRATION_PENDING: { icon: Clock3, tone: "bg-warning/15 text-warning" },
  EVIDENCE_VERIFIED: { icon: SearchCheck, tone: "bg-success/15 text-success" },
  EVIDENCE_TAMPERED: { icon: AlertTriangle, tone: "bg-destructive/15 text-destructive" },
  EVIDENCE_MISSING: { icon: FileWarning, tone: "bg-destructive/15 text-destructive" },
}

function formatDate(value: string) { return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)) }
function displaySource(event: CustodyEvent) { return event.type.startsWith("AI_") ? "Legal analysis service" : event.source }
function shortHash(value: unknown) { return typeof value === "string" && value.length > 16 ? `${value.slice(0, 10)}…${value.slice(-6)}` : String(value ?? "—") }

export default function CustodyDetailPage() {
  const params = useParams<{ id: string }>()
  const [details, setDetails] = useState<CustodyDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [isVerifyingAll, setIsVerifyingAll] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try { setDetails(await getCustodyDetails(params.id)) }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to load custody trail.") }
    finally { setLoading(false) }
  }
  useEffect(() => { if (params.id) void load() }, [params.id])
  async function verifyAllEvidence() {
    if (!details?.evidence.length) return
    setIsVerifyingAll(true)
    setError(null)
    try {
      await Promise.all(details.evidence.map((item) => verifyEvidence(item.id)))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to verify all evidence.")
    } finally {
      setIsVerifyingAll(false)
    }
  }
  const summary = useMemo(() => {
    const evidence = details?.evidence ?? []
    return { total: evidence.length, verified: evidence.filter((item) => item.verificationStatus === "Verified").length, alerts: evidence.filter((item) => item.verificationStatus === "Tampered" || item.verificationStatus === "Missing").length }
  }, [details])

  if (loading) return <DashboardLayout><div className="flex justify-center py-24"><Loader2 className="size-7 animate-spin text-accent" /></div></DashboardLayout>
  if (error || !details) return <DashboardLayout><div className="mx-auto max-w-4xl rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">{error ?? "Custody record not found."}</div></DashboardLayout>
  const { fir, evidence, events } = details
  const attention = summary.alerts > 0

  return <DashboardLayout><div className="mx-auto max-w-6xl space-y-6">
    <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between"><div><Link href="/custody" className="text-sm text-muted-foreground hover:text-foreground">Chain of Custody</Link><div className="mt-2 flex items-center gap-2"><GitBranch className="size-5 text-accent" /><p className="font-mono text-sm text-muted-foreground">{fir.firNumber}</p></div><h1 className="mt-1 text-3xl font-bold tracking-tight">{fir.complainantName}</h1><p className="mt-1 text-muted-foreground">Chronological, append-only audit record</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void verifyAllEvidence()} disabled={isVerifyingAll || evidence.length === 0}>{isVerifyingAll ? <><Loader2 className="mr-2 size-4 animate-spin" />Checking integrity</> : <><SearchCheck className="mr-2 size-4" />Verify all evidence</>}</Button><Button variant="outline" onClick={() => void load()} disabled={isVerifyingAll}>Refresh trail</Button></div></div>

    {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

    <Card className={`glass border ${attention ? "border-destructive/30" : "border-success/20"}`}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3">{attention ? <AlertTriangle className="size-6 text-destructive" /> : <ShieldCheck className="size-6 text-success" />}<div><p className="font-semibold">{attention ? "Integrity review required" : "No integrity issues detected"}</p><p className="text-sm text-muted-foreground">{attention ? `${summary.alerts} evidence item${summary.alerts === 1 ? "" : "s"} is tampered or unavailable.` : "All currently flagged evidence is available and verified."}</p></div></div><Badge variant="outline">{events.length} recorded events</Badge></CardContent></Card>

    <div className="grid gap-4 sm:grid-cols-3"><Metric label="Evidence files" value={summary.total} /><Metric label="Verified" value={summary.verified} tone="text-success" /><Metric label="Integrity alerts" value={summary.alerts} tone={attention ? "text-destructive" : ""} /></div>

    <Card className="glass"><CardHeader><CardTitle>Custody activity</CardTitle><CardDescription>Recorded actions over the last seven calendar days.</CardDescription></CardHeader><CardContent><ActivityChart events={events} /></CardContent></Card>

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <Card className="glass"><CardHeader><CardTitle>Custody timeline</CardTitle><CardDescription>Events are ordered from registration through the latest recorded action.</CardDescription></CardHeader><CardContent><div className="relative ml-3 border-l border-border/70 pl-7">{events.length === 0 ? <p className="py-8 text-sm text-muted-foreground">No custody events have been recorded yet.</p> : events.map((event) => <TimelineEvent key={event.id} event={event} expanded={expanded === event.id} onToggle={() => setExpanded(expanded === event.id ? null : event.id)} />)}</div></CardContent></Card>
      <div className="space-y-6"><Card className="glass"><CardHeader><CardTitle>Evidence integrity</CardTitle><CardDescription>Latest state for every associated file.</CardDescription></CardHeader><CardContent className="space-y-3">{evidence.length === 0 ? <p className="text-sm text-muted-foreground">No evidence uploaded.</p> : evidence.map((item) => { const bad = item.verificationStatus === "Tampered" || item.verificationStatus === "Missing"; return <div key={item.id} className={`rounded-lg border p-3 ${bad ? "border-destructive/30 bg-destructive/5" : "border-border/50 bg-muted/20"}`}><div className="flex items-start justify-between gap-2"><p className="min-w-0 truncate text-sm font-medium">{item.fileName}</p><Badge variant="outline" className={bad ? "border-destructive/20 bg-destructive/10 text-destructive" : item.verificationStatus === "Verified" ? "border-success/20 bg-success/10 text-success" : "border-warning/20 bg-warning/10 text-warning"}>{item.verificationStatus}</Badge></div><p className="mt-2 font-mono text-xs text-muted-foreground">{shortHash(item.fileHash)}</p><p className="mt-1 text-xs text-muted-foreground">{item.blockchainTxHash ? "Anchored on-chain" : "Blockchain registration pending"}</p></div> })}</CardContent></Card>
        <Card className="glass"><CardHeader><CardTitle>Audit scope</CardTitle></CardHeader><CardContent className="space-y-2 text-sm text-muted-foreground"><p>Recorded since: {formatDate(fir.createdAt)}</p><p>Case status: {fir.status}</p><p>Historical entries are labelled as such in their source metadata.</p></CardContent></Card></div>
    </div>
  </div></DashboardLayout>
}

function Metric({ label, value, tone = "" }: { label: string; value: number; tone?: string }) { return <Card className="glass"><CardContent className="p-5"><p className="text-sm text-muted-foreground">{label}</p><p className={`mt-2 text-3xl font-semibold tabular-nums ${tone}`}>{value}</p></CardContent></Card> }

function TimelineEvent({ event, expanded, onToggle }: { event: CustodyEvent; expanded: boolean; onToggle: () => void }) {
  const appearance = eventAppearance[event.type] ?? { icon: CircleDot, tone: "bg-muted text-muted-foreground" }
  const Icon = appearance.icon
  const metadata = Object.entries(event.metadata ?? {}).filter(([key]) => !["historical"].includes(key))
  return <article className="relative pb-7 last:pb-0"><div className={`absolute -left-[43px] top-0 flex size-8 items-center justify-center rounded-full ring-4 ring-card ${appearance.tone}`}><Icon className="size-4" /></div><button type="button" className="w-full text-left" onClick={onToggle}><div className="flex items-start justify-between gap-3"><div><p className="font-medium">{event.summary}</p><p className="mt-1 text-xs text-muted-foreground">{formatDate(event.occurredAt)} · {displaySource(event)} · {event.actorLabel}</p></div><ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} /></div></button>{expanded && <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs"><p className="mb-2 text-muted-foreground">Technical record</p>{metadata.length ? <dl className="grid gap-2 sm:grid-cols-2">{metadata.map(([key, value]) => <div key={key}><dt className="capitalize text-muted-foreground">{key.replace(/([A-Z])/g, " $1")}</dt><dd className="mt-0.5 break-all font-mono text-foreground">{shortHash(value)}</dd></div>)}</dl> : <p className="text-muted-foreground">No additional metadata recorded.</p>}</div>}</article>
}

function ActivityChart({ events }: { events: CustodyEvent[] }) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    return { key: date.toDateString(), label: new Intl.DateTimeFormat("en-IN", { weekday: "short" }).format(date), count: 0 }
  })
  const indexed = new Map(days.map((day) => [day.key, day]))
  events.forEach((event) => {
    const day = indexed.get(new Date(event.occurredAt).toDateString())
    if (day) day.count += 1
  })
  const maximum = Math.max(1, ...days.map((day) => day.count))
  return <div className="flex h-28 items-end justify-between gap-3">{days.map((day) => <div key={day.key} className="flex h-full flex-1 flex-col items-center justify-end gap-2"><span className="text-xs tabular-nums text-muted-foreground">{day.count || ""}</span><div className="w-full max-w-10 rounded-t bg-accent/80 transition-all" style={{ height: `${Math.max(day.count ? 18 : 4, (day.count / maximum) * 72)}px` }} /><span className="text-xs text-muted-foreground">{day.label}</span></div>)}</div>
}
