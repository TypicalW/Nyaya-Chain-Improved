"use client"

import Link from "next/link"
import { Logo } from "@/components/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Brain, ShieldCheck, Hash, FolderOpen, ArrowRight, FileText } from "lucide-react"

const features = [
  {
    icon: Brain,
    title: "AI-Assisted FIR Analysis",
    description:
      "When a report is filed, the legal analysis service reviews the narrative and suggests relevant BNS sections, with legacy IPC references where useful. It's informational only -- every suggestion is flagged for review by a qualified legal professional.",
  },
  {
    icon: Hash,
    title: "SHA-256 Evidence Hashing",
    description:
      "Every uploaded file is hashed with SHA-256 the moment it's received, so any later change to the file can be detected by comparing hashes.",
  },
  {
    icon: ShieldCheck,
    title: "Sepolia Blockchain Anchoring",
    description:
      "Each evidence hash is written to a smart contract on the Sepolia testnet, alongside the FIR number and a timestamp -- an independent, tamper-evident record outside the database.",
  },
  {
    icon: FileText,
    title: "Evidence Verification",
    description:
      "At any time, evidence can be re-hashed and compared against both the original database record and the on-chain record, returning a Verified or Tampered result.",
  },
]

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 glass-dark">
        <div className="max-w-6xl mx-auto px-6 py-5 flex items-center justify-between">
          <Logo size="md" />
          <div className="flex items-center gap-3">
            <Link href="/cases">
              <Button variant="ghost">View Cases</Button>
            </Link>
            <Link href="/report">
              <Button>File a Report</Button>
            </Link>
          </div>
        </div>
      </header>

      <section className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6">
          FIR Intake with AI Analysis and Blockchain-Verified Evidence
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
          File a First Information Report, get an AI-assisted read on applicable law, and attach
          digital evidence that's hashed and anchored on-chain so tampering can be detected later.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link href="/report">
            <Button size="lg" className="gap-2">
              File a Report <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
          <Link href="/cases">
            <Button size="lg" variant="outline">
              Browse Cases
            </Button>
          </Link>
        </div>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="grid md:grid-cols-2 gap-6">
          {features.map((feature) => (
            <Card key={feature.title} className="glass">
              <CardHeader>
                <div className="h-12 w-12 rounded-lg bg-accent/10 flex items-center justify-center mb-2">
                  <feature.icon className="h-6 w-6 text-accent" />
                </div>
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription className="text-sm leading-relaxed">
                  {feature.description}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>

        <Card className="glass mt-6">
          <CardContent className="pt-6 text-sm text-muted-foreground leading-relaxed">
            Nyaya-Chain does not currently have user accounts or role-based access -- anyone with
            the link can file reports, upload evidence, and change a case's status. Treat this as a
            working prototype, not a production system for real investigations.
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
