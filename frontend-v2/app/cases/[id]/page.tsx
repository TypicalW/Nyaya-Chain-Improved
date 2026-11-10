"use client"

import { useEffect, useRef, useState } from "react"
import { useParams } from "next/navigation"
import { DashboardLayout } from "@/components/dashboard-layout"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { BlockchainDemoButton } from "@/components/BlockchainDemoButton"
import { VerifyOnChainButton } from "@/components/VerifyOnChainButton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getFir,
  uploadEvidence,
  verifyEvidence,
  registerEvidence,
  updateFirStatus,
  FIR_STATUSES,
  type FirDetails,
  type FirStatus,
} from "@/lib/api"
import { formatConfidence } from "@/lib/utils"
import {
  Loader2,
  Upload,
  Hash,
  Link2,
  Eye,
  FileImage,
  FileVideo,
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  FileWarning,
} from "lucide-react"


function FileIcon({ type }: { type: string }) {
  if (type.startsWith("image/")) return <FileImage className="h-6 w-6 text-blue-400" />
  if (type.startsWith("video/")) return <FileVideo className="h-6 w-6 text-purple-400" />
  return <FileText className="h-6 w-6 text-accent" />
}

export default function CaseDetailPage() {
  const params = useParams<{ id: string }>()
  const firId = params.id

  const [details, setDetails] = useState<FirDetails | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [busyEvidenceId, setBusyEvidenceId] = useState<string | null>(null)
  const [verifyResult, setVerifyResult] = useState<{
    id: string
    verified: boolean
    status: string
    message?: string
  } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  async function load() {
    setError(null)
    try {
      const result = await getFir(firId)
      setDetails(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this case.")
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firId])

  async function handleStatusChange(status: FirStatus) {
    setIsUpdatingStatus(true)
    try {
      await updateFirStatus(firId, status)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update status.")
    } finally {
      setIsUpdatingStatus(false)
    }
  }

  async function handleUpload() {
    if (!selectedFile) return
    setIsUploading(true)
    setUploadError(null)
    try {
      await uploadEvidence(selectedFile, firId)
      setSelectedFile(null)
      await load()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Evidence upload failed.")
    } finally {
      setIsUploading(false)
    }
  }

  async function handleVerify(id: string) {
    setBusyEvidenceId(id)
    setVerifyResult(null)
    try {
      const result = await verifyEvidence(id)
      setVerifyResult({
        id,
        verified: result.verification.verified,
        status: result.verification.status,
        message: result.verification.verificationError,
      })
      await load()
    } catch (err) {
      setVerifyResult({
        id,
        verified: false,
        status: "Verification Error",
        message: err instanceof Error ? err.message : "Verification failed.",
      })
      await load()
    } finally {
      setBusyEvidenceId(null)
    }
  }

  async function handleRegister(id: string) {
    setBusyEvidenceId(id)
    try {
      await registerEvidence(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Blockchain registration failed.")
    } finally {
      setBusyEvidenceId(null)
    }
  }

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      </DashboardLayout>
    )
  }

  if (error && !details) {
    return (
      <DashboardLayout>
        <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-4">
          {error}
        </div>
      </DashboardLayout>
    )
  }

  if (!details) return null

  const { fir, evidence } = details

  return (
    <DashboardLayout>
      <div className="space-y-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm text-muted-foreground font-mono">{fir.firNumber}</p>
            <h1 className="text-3xl font-bold tracking-tight">{fir.complainantName}</h1>
            <p className="text-muted-foreground">
              {fir.location} &middot; Incident on {fir.incidentDate}
            </p>
          </div>

          <Select
            value={fir.status}
            onValueChange={(value) => void handleStatusChange(value as FirStatus)}
            disabled={isUpdatingStatus}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIR_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            {error}
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="glass lg:col-span-2">
            <CardHeader>
              <CardTitle>Report Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p className="whitespace-pre-wrap text-muted-foreground">{fir.description}</p>
              <div className="grid sm:grid-cols-2 gap-3 pt-2 border-t border-border">
                <div>
                  <p className="text-xs text-muted-foreground">Complainant email</p>
                  <p>{fir.complainantEmail}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Filed on</p>
                  <p>{new Date(fir.createdAt).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Confirmation email</p>
                  <p>{fir.emailSentAt ? new Date(fir.emailSentAt).toLocaleString() : "Not sent"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="glass">
            <CardHeader>
              <CardTitle>AI Legal Analysis</CardTitle>
              <CardDescription>Suggestions only &mdash; verify with a legal professional.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              {fir.legalAnalysis ? (
                <>
                  <p className="text-muted-foreground">{fir.legalAnalysis.summary}</p>
                  {fir.legalAnalysis.recommendations.map((rec, i) => (
                    <div key={i} className="rounded-lg border border-border/50 p-3 bg-muted/30">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="font-medium">
                          {rec.law} &middot; {rec.section}
                        </span>
                        <Badge variant="outline">{formatConfidence(rec.confidence)}%</Badge>
                      </div>
                      <p className="text-muted-foreground text-xs">{rec.title}</p>
                    </div>
                  ))}
                </>
              ) : (
                <p className="text-muted-foreground">No analysis available for this FIR.</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Evidence upload */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Upload className="h-5 w-5 text-accent" />
              Upload Evidence
            </CardTitle>
            <CardDescription>
              Files are SHA-256 hashed, stored in Supabase Storage, and anchored on the Sepolia
              blockchain. Max 25MB.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) {
                  if (file.size > 25 * 1024 * 1024) {
                    setUploadError("File must be 25MB or smaller.")
                    return
                  }
                  setUploadError(null)
                  setSelectedFile(file)
                }
              }}
            />
            <div
              onClick={() => !isUploading && fileInputRef.current?.click()}
              className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-accent/50 hover:bg-muted/30 transition-colors"
            >
              {selectedFile ? (
                <p className="text-sm">{selectedFile.name}</p>
              ) : (
                <p className="text-sm text-muted-foreground">Click to choose a file</p>
              )}
            </div>
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
            {selectedFile && (
              <Button onClick={() => void handleUpload()} disabled={isUploading}>
                {isUploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  "Upload Evidence"
                )}
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Evidence list */}
        <Card className="glass">
          <CardHeader>
            <CardTitle>Evidence ({evidence.length})</CardTitle>
          </CardHeader>
          <CardContent>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No evidence uploaded yet.
              </p>
            ) : (
              <div className="space-y-3">
                {evidence.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-4 p-4 rounded-lg bg-muted/30 border border-border/50"
                  >
                    <FileIcon type={item.fileType} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{item.fileName}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Hash className="h-3 w-3 text-muted-foreground shrink-0" />
                        <code className="text-xs text-muted-foreground font-mono truncate max-w-[260px]">
                          {item.fileHash}
                        </code>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(item.uploadedAt).toLocaleString()}
                      </p>
                    </div>

                    <Badge
                      variant="outline"
                      className={
                        item.verificationStatus === "Verified"
                          ? "bg-success/10 text-success border-success/20"
                          : item.verificationStatus === "Tampered" || item.verificationStatus === "Missing"
                            ? "bg-destructive/10 text-destructive border-destructive/20"
                            : "bg-warning/10 text-warning border-warning/20"
                      }
                    >
                      {item.verificationStatus === "Verified" && <CheckCircle2 className="h-3 w-3 mr-1" />}
                      {item.verificationStatus === "Tampered" && <XCircle className="h-3 w-3 mr-1" />}
                      {item.verificationStatus === "Missing" && <FileWarning className="h-3 w-3 mr-1" />}
                      {item.verificationStatus === "Pending" && <Clock className="h-3 w-3 mr-1" />}
                      Integrity: {item.verificationStatus}
                    </Badge>

                    <Badge
                      variant="outline"
                      className={
                        item.blockchainTxHash
                          ? "bg-success/10 text-success border-success/20"
                          : "bg-warning/10 text-warning border-warning/20"
                      }
                    >
                      {item.blockchainTxHash ? "On-chain" : "Not on-chain"}
                    </Badge>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Verify evidence integrity"
                        onClick={() => void handleVerify(item.id)}
                        disabled={busyEvidenceId === item.id}
                      >
                        {busyEvidenceId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Retry blockchain registration"
                        onClick={() => void handleRegister(item.id)}
                        disabled={!!item.blockchainTxHash || busyEvidenceId === item.id}
                      >
                        <Link2 className="h-4 w-4" />
                      </Button>
                    </div>

                    {verifyResult?.id === item.id && (
                      <p
                        className={`w-full text-xs ${verifyResult.verified ? "text-success" : verifyResult.status === "Pending" || verifyResult.status === "Verification Error" ? "text-warning" : "text-destructive"}`}
                      >
                        {verifyResult.verified
                          ? "Verified: file hash and blockchain record both match."
                          : verifyResult.status === "Missing"
                            ? "Missing: the original file is unavailable in Supabase Storage."
                            : verifyResult.status === "Tampered"
                              ? "Tampered: the current file hash does not match the original hash."
                              : verifyResult.status === "Verification Error"
                                ? `Verification Error: ${verifyResult.message ?? "The last known integrity status is unchanged."}`
                                : `Verification pending: ${verifyResult.message ?? "blockchain registration is incomplete."}`}
                      </p>
                    )}

                    <div className="grid w-full gap-3 border-t border-border/50 pt-4 sm:grid-cols-2">
                      <BlockchainDemoButton fileHash={item.fileHash} firNumber={fir.firNumber} />
                      <VerifyOnChainButton
                        evidenceId={item.id}
                        onComplete={(result: { verified: boolean; status: string; verificationError?: string } | undefined) => {
                          if (result) setVerifyResult({
                            id: item.id,
                            verified: result.verified,
                            status: result.status,
                            message: result.verificationError,
                          })
                          return load()
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  )
}
