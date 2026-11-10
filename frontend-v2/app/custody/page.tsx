"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { AlertTriangle, CheckCircle2, Clock3, FileWarning, GitBranch, Loader2, Search, ShieldCheck } from "lucide-react"
import { DashboardLayout } from "@/components/dashboard-layout"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { getCustodyCases, type CustodyCase } from "@/lib/api"

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))
}

function integrity(caseItem: CustodyCase) {
  if (caseItem.evidence.tampered > 0 || caseItem.evidence.missing > 0) return { label: "Attention required", icon: AlertTriangle, className: "text-destructive bg-destructive/10 border-destructive/20" }
  if (caseItem.evidence.total > 0 && caseItem.evidence.verified === caseItem.evidence.total) return { label: "All evidence verified", icon: ShieldCheck, className: "text-success bg-success/10 border-success/20" }
  return { label: caseItem.evidence.total ? "Verification pending" : "No evidence", icon: Clock3, className: "text-warning bg-warning/10 border-warning/20" }
}

export default function CustodyPage() {
  const [cases, setCases] = useState<CustodyCase[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try { setCases((await getCustodyCases()).cases) }
    catch (err) { setError(err instanceof Error ? err.message : "Unable to load chain of custody.") }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  const filtered = useMemo(() => cases.filter((item) => `${item.firNumber} ${item.complainantName}`.toLowerCase().includes(query.toLowerCase())), [cases, query])
  const attention = cases.filter((item) => item.evidence.tampered > 0 || item.evidence.missing > 0).length

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="flex items-center gap-2"><GitBranch className="size-5 text-accent" /><h1 className="text-3xl font-bold tracking-tight">Chain of Custody</h1></div>
            <p className="mt-1 text-muted-foreground">Trace every recorded action from FIR registration to evidence integrity review.</p>
          </div>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Summary icon={GitBranch} label="Tracked cases" value={cases.length} detail="Cases with custody records" />
          <Summary icon={ShieldCheck} label="Verified evidence" value={cases.reduce((sum, item) => sum + item.evidence.verified, 0)} detail="Current verified state" />
          <Summary icon={FileWarning} label="Integrity alerts" value={attention} detail="Cases needing review" alert={attention > 0} />
        </div>

        <Card className="glass">
          <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div><CardTitle>Case audit records</CardTitle><CardDescription>Open a case to review its complete chronological event trail.</CardDescription></div>
            <div className="relative w-full sm:w-72"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search FIR or complainant" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          </CardHeader>
          <CardContent>
            {error && <p className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
            {loading ? <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-accent" /></div> : filtered.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">No custody records match this search.</p> : <div className="space-y-3">
              {filtered.map((item) => {
                const state = integrity(item)
                const StateIcon = state.icon
                return <Link key={item.id} href={`/custody/${item.id}`} className="group grid gap-4 rounded-lg border border-border/50 bg-muted/20 p-4 transition-colors hover:border-accent/40 hover:bg-muted/40 md:grid-cols-[1.3fr_1fr_auto] md:items-center">
                  <div><p className="font-mono text-sm font-semibold">{item.firNumber}</p><p className="mt-1 text-sm text-muted-foreground">{item.complainantName} <span className="mx-1">·</span> {item.status}</p></div>
                  <div className="text-sm"><p className="text-muted-foreground">{item.latestEvent?.summary ?? "No recorded activity yet"}</p><p className="mt-1 text-xs text-muted-foreground">{item.latestEvent ? formatTime(item.latestEvent.occurredAt) : formatTime(item.createdAt)} · {item.eventCount} events</p></div>
                  <div className="flex items-center gap-2"><Badge variant="outline" className={state.className}><StateIcon className="mr-1 size-3" />{state.label}</Badge><span className="text-xs text-muted-foreground">{item.evidence.total} files</span></div>
                </Link>
              })}
            </div>}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}

function Summary({ icon: Icon, label, value, detail, alert = false }: { icon: typeof GitBranch; label: string; value: number; detail: string; alert?: boolean }) {
  return <Card className="glass"><CardContent className="flex items-start justify-between p-5"><div><p className="text-sm text-muted-foreground">{label}</p><p className={`mt-2 text-3xl font-semibold tabular-nums ${alert ? "text-destructive" : ""}`}>{value}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></div><div className={`flex size-10 items-center justify-center rounded-lg ${alert ? "bg-destructive/10 text-destructive" : "bg-accent/10 text-accent"}`}><Icon className="size-5" /></div></CardContent></Card>
}
