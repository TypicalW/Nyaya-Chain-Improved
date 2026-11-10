export type LegalRecommendation = {
  law: string;
  section: string;
  title: string;
  rationale: string;
  confidence: number;
};

export type LegalAnalysis = {
  summary: string;
  recommendations: LegalRecommendation[];
  victimActions: string[];
  disclaimer: string;
};

export type FirInput = {
  complainantName: string;
  complainantEmail: string;
  incidentDate: string;
  location: string;
  description: string;
};

export type FirSummary = {
  id: string;
  firNumber: string;
  complainantName: string;
  incidentDate: string;
  status: FirStatus;
  createdAt: string;
};

export const FIR_STATUSES = [
  "Registered",
  "Under Review",
  "Investigation Open",
  "Evidence Pending",
  "Charge Sheet Filed",
  "Closed",
] as const;

export type FirStatus = (typeof FIR_STATUSES)[number];

// Requests stay same-origin in the browser and Next.js proxies /api/* to the backend.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error ?? "Something went wrong. Please try again.");
  return body as T;
}

export function analyzeFir(
  input: Pick<FirInput, "description" | "location" | "incidentDate">,
) {
  return request<LegalAnalysis>("/api/firs/analyze", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function submitFir(input: FirInput) {
  return request<{
    fir: {
      id: string;
      firNumber: string;
    };
    analysis: LegalAnalysis;
    emailSent: boolean;
    aiAvailable: boolean;
  }>("/api/firs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type Evidence = {
  id: string;
  firId: string;
  fileName: string;
  fileType: string;
  storagePath: string;
  fileHash: string;
  blockchainTxHash: string | null;
  verificationStatus: string;
  uploadedAt: string;
};

export type FirDetails = {
  fir: {
    id: string;
    firNumber: string;
    complainantName: string;
    complainantEmail: string;
    incidentDate: string;
    location: string;
    description: string;
    status: FirStatus;
    legalAnalysis: LegalAnalysis | null;
    emailSentAt: string | null;
    createdAt: string;
  };
  evidence: Evidence[];
};

export async function uploadEvidence(
  file: File,
  firId: string,
): Promise<{ evidence: Evidence }> {
  const formData = new FormData();

  formData.append("file", file);
  formData.append("firId", firId);

  const response = await fetch(`${apiUrl}/api/evidence`, {
    method: "POST",
    body: formData,
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error ?? "Evidence upload failed.");
  }

  return body;
}

export function getEvidenceForFir(firId: string) {
  return request<{
    fir: {
      id: string;
      firNumber: string;
    };
    evidence: Evidence[];
  }>(`/api/evidence/fir/${firId}`, {
    method: "GET",
  });
}

export function verifyEvidence(id: string) {
  return request<{
    verification: {
      evidenceId: string;
      firId: string;
      firNumber: string;
      originalHash: string;
      currentHash: string | null;
      fileHashMatches: boolean | null;

      blockchain: {
        exists: boolean;
        firNumber: string | null;
        firNumberMatches: boolean;
        timestamp: string | null;
        uploadedBy: string | null;
        transactionHash: string | null;
      };
      
      verified: boolean;
      status: "Verified" | "Tampered" | "Missing" | "Pending" | "Verification Error";
      verificationError?: string;
    };
  }>(`/api/evidence/${id}/verify`, {
    method: "GET",
  });
}

export function registerEvidence(id: string) {
  return request(`/api/evidence/${id}/register`, {
    method: "POST",
  });
}

export function getFir(id: string) {
  return request<FirDetails>(`/api/firs/${id}`, {
    method: "GET",
  });
}

export function getRecentFirs() {
  return request<{ firs: FirSummary[] }>("/api/firs?limit=8", {
    method: "GET",
  });
}
export function getFirs(limit = 50) {
  return request<{ firs: FirSummary[] }>(`/api/firs?limit=${limit}`, {
    method: "GET",
  });
}

export function updateFirStatus(id: string, status: FirStatus) {
  return request<{ fir: FirSummary }>(`/api/firs/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export type CustodyEvent = {
  id: string;
  evidenceId: string | null;
  type: string;
  source: string;
  actorLabel: string;
  summary: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
};

export type CustodyCase = {
  id: string;
  firNumber: string;
  complainantName: string;
  status: FirStatus;
  createdAt: string;
  evidence: { total: number; verified: number; tampered: number; missing: number };
  eventCount: number;
  latestEvent: { type: string; summary: string; occurredAt: string } | null;
};

export type CustodyDetails = {
  fir: Pick<FirSummary, "id" | "firNumber" | "complainantName" | "status" | "createdAt">;
  evidence: Array<Pick<Evidence, "id" | "fileName" | "fileType" | "fileHash" | "blockchainTxHash" | "verificationStatus" | "uploadedAt">>;
  events: CustodyEvent[];
};

export function getCustodyCases(limit = 50) {
  return request<{ cases: CustodyCase[] }>(`/api/custody/cases?limit=${limit}`, { method: "GET" });
}

export function getCustodyDetails(id: string) {
  return request<CustodyDetails>(`/api/custody/firs/${id}`, { method: "GET" });
}
